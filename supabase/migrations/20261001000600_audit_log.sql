-- ===========================================================================
-- 20261001000600_audit_log
--
-- Append-only audit trail.
--
-- ## What it is for
--
-- Later phases record sensitive actions here: loan creation and edits, payment
-- entry and reversal, penalty application, settings changes, user management.
-- Phase 1 builds the table, the immutability guarantees and the single write
-- path. It does not emit events, because the actions that would be audited do
-- not exist yet.
--
-- ## Resisting tampering
--
-- Three independent controls, so defeating one is not enough:
--
--   1. Statement-level BEFORE triggers on UPDATE, DELETE and TRUNCATE that
--      raise an exception. These fire even for a statement matching zero rows,
--      so an attempt fails loudly rather than appearing to succeed.
--
--   2. Table privileges: UPDATE, DELETE and TRUNCATE are revoked from every
--      application role, including `service_role`. The privileged key cannot
--      quietly edit history.
--
--   3. RLS enabled with no policies, so `anon` and `authenticated` see
--      nothing at all.
--
-- A database superuser can still disable a trigger — no in-database design
-- prevents that, and claiming otherwise would be dishonest. What this does
-- prevent is every route the application, a compromised key, or a mistaken
-- `DELETE FROM` can take. Tamper-evidence beyond that (off-site shipping,
-- hash chaining) is noted as a Phase 2+ consideration in docs/SECURITY.md.
--
-- ## The actor is derived, never supplied
--
-- `public.record_audit_event()` reads the actor from the session via
-- `public.current_profile_id()` and `auth.uid()`. A caller cannot pass an
-- actor, so a client cannot attribute its own action to somebody else.
--
-- `actor_label` is a denormalised snapshot of the actor's name at the time of
-- the action. An audit record must stay readable even after the actor's
-- profile is renamed — the record says who did it *then*.
-- ===========================================================================

create table public.audit_log (
  -- bigint identity: cheap, strictly ordered, and no gap-free guarantee is
  -- implied (unlike a reference number, which people read).
  id bigint generated always as identity primary key,

  occurred_at timestamptz not null default pg_catalog.now(),

  -- The acting profile. NULL for system actions (migrations, scheduled jobs).
  actor_profile_id uuid references public.profiles (id) on delete restrict,

  -- The auth account behind the action, kept even if the profile link changes.
  actor_auth_user_id uuid,

  -- Snapshot of the actor's display name. NOT NULL so every record names an
  -- actor: 'system' for unattended actions.
  actor_label text not null,

  -- Dotted action name, e.g. 'loan.created', 'payment.reversed'.
  action text not null,

  -- The kind of record affected, e.g. 'loan', 'payment', 'business_settings'.
  entity_type text not null,

  -- Text rather than uuid: entities are keyed variously by uuid, bigint or a
  -- singleton id, and the audit trail must accept all of them.
  entity_id text,

  -- Before and after. Must never contain credentials; the write function
  -- documents the caller's obligation here.
  old_values jsonb,
  new_values jsonb,

  -- Additional context: the reason given for a reversal, a batch id.
  metadata jsonb,

  -- Request correlation, to tie an audit record to application logs.
  request_id text,

  -- Retained for security investigations. Personal data: see the retention
  -- note in docs/SECURITY.md.
  ip_address inet,
  user_agent text,

  constraint audit_log_actor_label_not_blank
    check (btrim(actor_label) <> ''),

  constraint audit_log_action_format
    check (action ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$'),

  constraint audit_log_entity_type_format
    check (entity_type ~ '^[a-z][a-z0-9_]*$'),

  constraint audit_log_entity_id_length
    check (entity_id is null or char_length(entity_id) between 1 and 200),

  constraint audit_log_user_agent_length
    check (user_agent is null or char_length(user_agent) <= 1000),

  -- jsonb values must be objects, not scalars or arrays, so queries over them
  -- have a predictable shape.
  constraint audit_log_old_values_is_object
    check (old_values is null or pg_catalog.jsonb_typeof(old_values) = 'object'),
  constraint audit_log_new_values_is_object
    check (new_values is null or pg_catalog.jsonb_typeof(new_values) = 'object'),
  constraint audit_log_metadata_is_object
    check (metadata is null or pg_catalog.jsonb_typeof(metadata) = 'object')
);

comment on table public.audit_log is
  'Append-only audit trail. UPDATE, DELETE and TRUNCATE are blocked by trigger and by privilege.';
comment on column public.audit_log.actor_label is
  'Snapshot of the actor name at the time of the action, so the record stays meaningful after a rename. "system" for unattended actions.';
comment on column public.audit_log.entity_id is
  'Text, not uuid: audited entities are keyed by uuid, bigint or a singleton id.';

-- "What happened recently" and "what happened to this record" are the two
-- queries an audit trail is actually used for.
create index audit_log_occurred_at_idx on public.audit_log (occurred_at desc);
create index audit_log_entity_idx on public.audit_log (entity_type, entity_id);
create index audit_log_actor_idx on public.audit_log (actor_profile_id, occurred_at desc);
create index audit_log_action_idx on public.audit_log (action, occurred_at desc);


-- --- Immutability ---------------------------------------------------------

create trigger audit_log_reject_update
  before update on public.audit_log
  for each statement
  execute function public.reject_mutation();

create trigger audit_log_reject_delete
  before delete on public.audit_log
  for each statement
  execute function public.reject_mutation();

create trigger audit_log_reject_truncate
  before truncate on public.audit_log
  for each statement
  execute function public.reject_mutation();


-- ---------------------------------------------------------------------------
-- The single write path
--
-- SECURITY DEFINER so later phases can audit an action without granting any
-- role direct INSERT on the table. The actor is taken from the session, so it
-- cannot be forged by the caller.
-- ---------------------------------------------------------------------------
create or replace function public.record_audit_event(
  p_action      text,
  p_entity_type text,
  p_entity_id   text default null,
  p_old_values  jsonb default null,
  p_new_values  jsonb default null,
  p_metadata    jsonb default null,
  p_request_id  text default null
)
returns bigint
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_profile_id   uuid;
  v_auth_user_id uuid;
  v_actor_label  text;
  v_id           bigint;
begin
  v_auth_user_id := auth.uid();
  v_profile_id := public.current_profile_id();

  if v_profile_id is not null then
    select p.full_name into v_actor_label
    from public.profiles p
    where p.id = v_profile_id;
  end if;

  -- An unattended action is attributed to 'system' rather than left blank, so
  -- every record names an actor.
  v_actor_label := coalesce(nullif(pg_catalog.btrim(v_actor_label), ''), 'system');

  insert into public.audit_log (
    actor_profile_id,
    actor_auth_user_id,
    actor_label,
    action,
    entity_type,
    entity_id,
    old_values,
    new_values,
    metadata,
    request_id
  )
  values (
    v_profile_id,
    v_auth_user_id,
    v_actor_label,
    p_action,
    p_entity_type,
    p_entity_id,
    p_old_values,
    p_new_values,
    p_metadata,
    p_request_id
  )
  returning id into v_id;

  return v_id;
end;
$$;

comment on function public.record_audit_event(text, text, text, jsonb, jsonb, jsonb, text) is
  'Sole write path into public.audit_log. The actor is derived from the session and cannot be supplied by the caller. Callers must not pass credentials, tokens or secrets in the jsonb arguments.';


-- --- Access control -------------------------------------------------------

alter table public.audit_log enable row level security;

-- No role may read the trail, and no role may alter it. Note that UPDATE,
-- DELETE and TRUNCATE are revoked from `service_role` too: the privileged key
-- exists for legitimate administration, and rewriting audit history is not
-- that. INSERT remains available to service_role for the Phase 2+ server-side
-- write path, alongside record_audit_event().
revoke all on table public.audit_log from anon, authenticated;
revoke update, delete, truncate on table public.audit_log from anon, authenticated, service_role;

-- EXECUTE revoked from the application roles for now: nothing in Phase 1
-- records an event. anon and authenticated are named explicitly because
-- Supabase grants EXECUTE to them via ALTER DEFAULT PRIVILEGES, which a
-- revoke from PUBLIC does not remove. service_role keeps it, for the
-- Phase 2+ server-side write path.
-- DEFERRED TO PHASE 2: grant EXECUTE to `authenticated` so Server Actions can
-- audit their own writes, and add a SELECT policy for owner_admin
-- (`public.user_has_at_least_role('owner_admin')`) so the trail is readable
-- in the UI by the one role entitled to see it.
revoke all on function public.record_audit_event(text, text, text, jsonb, jsonb, jsonb, text)
  from public, anon, authenticated;
