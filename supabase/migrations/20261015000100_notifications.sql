-- ===========================================================================
-- Phase 15.1 — notifications
--
-- Everything in this system is visible if somebody goes and looks at it. A
-- loan awaiting approval is on the loan register, a variance is on the
-- reconciliation screen, a reversal is in the payment register. What the
-- business does not have is anything that says *go and look* — so an
-- application submitted on Friday afternoon waits until somebody happens to
-- open the right tab.
--
-- ## One row per event, addressed to an audience
--
-- The obvious design is a row per recipient: fan out to every Manager when a
-- loan is submitted. It is the wrong one here, for two reasons. An event then
-- exists as N rows that can diverge, and a staff member who joins on Monday
-- gets no history of the weekend — which for operational alerts is exactly
-- backwards, because the thing still needs doing.
--
-- So a notification is recorded **once**, and it names the *capability* that
-- may see it. "A loan is awaiting approval" is addressed to whoever approves
-- loans, which is a role, not a person. Two optional narrowings handle the
-- rest: `audience_profile_id` for the handful of notifications that genuinely
-- belong to one person (your application was refused), and
-- `audience_branch_id` for anything a branch-scoped reader should not see.
--
-- Unread is therefore *per person*, which is what a bell needs, and lives in
-- `notification_reads`.
--
-- ## Raised by events, never by the passage of time
--
-- This is the rule that keeps the stream honest. A loan quietly becoming
-- thirty-one days late is not an event; it is a reading of the calendar, and
-- Phase 7 is explicit that delinquency is derived on every read so that no
-- column can go stale. A stored "this loan is overdue" notification would be
-- a second opinion with a timestamp on it — right on Tuesday, wrong on
-- Wednesday, and never corrected because nothing runs.
--
-- The overdue list and the aging register already answer "what is late", and
-- they are correct every time they are read. So notifications cover what
-- somebody *did* or what the database *did*: submitted, approved, refused,
-- disbursed, reversed, charged a penalty, took a promise, released a
-- guarantor, sold security, found a variance, drained a float, blacklisted a
-- borrower.
--
-- ## Append-only
--
-- A notification is a record that something happened, so it is append-only
-- the way `audit_log`, `client_remarks` and `loan_recovery_actions` are:
-- statement-level triggers refusing UPDATE and DELETE outright. Reading is
-- not a change to the notification — it is a separate row in a separate
-- table, which is also insert-only, because nothing un-happens and nobody
-- un-reads.
-- ===========================================================================

create table public.notifications (
  id uuid primary key default gen_random_uuid(),

  category text not null,
  severity text not null default 'info',

  -- One line, written for somebody glancing at a list. The body carries the
  -- detail, and is optional because several categories say everything they
  -- have to say in the title.
  title text not null,
  body text,

  -- Who may see it. The capability is required: a notification nobody is
  -- entitled to read is a leak waiting for a policy change, and one addressed
  -- to "everybody" would put a reversal in front of the counter staff.
  audience_permission text not null
    references public.permissions(key) on delete restrict,
  -- Optional narrowings. Null means "everybody with the capability".
  --
  -- `restrict` on both, and on every other reference this table holds, for
  -- the reason `client_remarks` records: SET NULL and CASCADE are both
  -- *mutations*, and this table refuses every UPDATE and every DELETE. A
  -- nulling reference would make deleting the referenced row fail with a
  -- confusing error about append-only tables instead of a clear one about the
  -- reference; a cascading one would fail the same way. Nothing in this
  -- application hard-deletes a profile or a branch — accounts are archived
  -- and branches are closed — so `restrict` costs nothing and says what it
  -- means.
  audience_profile_id uuid references public.profiles(id) on delete restrict,
  audience_branch_id uuid references public.branches(id) on delete restrict,

  -- What it is about, so the screen can link straight to it. `entity_type` is
  -- a closed list rather than free text because the link is built from it:
  -- an unrecognised type would render a dead control.
  entity_type text not null,
  entity_id uuid,

  actor_profile_id uuid references public.profiles(id) on delete restrict,
  -- The actor's name as it was. Keeps the stream readable after an account is
  -- archived, the same reason `client_remarks` and `loan_recovery_actions`
  -- carry one — and the reason `restrict` above is not a hardship.
  actor_label text not null default 'system',

  occurred_at timestamptz not null default pg_catalog.now(),

  -- What makes a notification raisable twice without being raised twice.
  --
  -- For an event it is the event: `loan:<id>:approved` can only happen once,
  -- so a replay is a no-op. For the few that are a *reading* taken at a
  -- moment — a float running low — the key carries the business date, which
  -- is how "tell me once a day, not once a payment" is expressed without any
  -- scheduler.
  dedupe_key text not null,

  constraint notifications_category_valid check (category in (
    'loan_awaiting_approval',
    'loan_awaiting_disbursement',
    'loan_decided',
    'loan_disbursed',
    'loan_cleared',
    'payment_reversed',
    'penalty_applied',
    'promise_recorded',
    'guarantor_released',
    'collateral_realised',
    'approval_pending',
    'reconciliation_variance',
    'low_float',
    'client_blacklisted'
  )),

  -- Three levels, not five. `info` is a thing that happened, `attention` is a
  -- thing somebody should do, `urgent` is a thing that is wrong. A fourth
  -- level would be a judgement nobody could apply consistently.
  constraint notifications_severity_valid
    check (severity in ('info', 'attention', 'urgent')),

  constraint notifications_entity_type_valid check (entity_type in (
    'loan', 'payment', 'client', 'guarantor', 'collateral',
    'transfer', 'expense', 'reconciliation', 'ledger_account'
  )),

  constraint notifications_title_length
    check (char_length(btrim(title)) between 3 and 200),
  constraint notifications_body_length
    check (body is null or char_length(btrim(body)) between 3 and 1000),
  constraint notifications_actor_label_not_blank
    check (btrim(actor_label) <> ''),
  constraint notifications_dedupe_key_length
    check (char_length(btrim(dedupe_key)) between 3 and 200),

  -- Raised once. The constraint, not the caller, is what makes every
  -- generation trigger safely re-runnable.
  constraint notifications_dedupe_unique unique (category, dedupe_key)
);

-- The bell's query: newest first, and the audience columns are the filter.
create index notifications_feed_idx
  on public.notifications (occurred_at desc, id desc);

create index notifications_audience_idx
  on public.notifications (audience_permission, occurred_at desc);

-- Partial, because the overwhelming majority of notifications are addressed
-- to a capability rather than to a person.
create index notifications_profile_idx
  on public.notifications (audience_profile_id, occurred_at desc)
  where audience_profile_id is not null;

create index notifications_entity_idx
  on public.notifications (entity_type, entity_id);

comment on table public.notifications is
  'Phase 15. One row per noteworthy event, addressed to the capability that may read it. Append-only. Raised by events only — never by the passage of time, because a stored opinion about what is late would go stale while the derived views never do.';
comment on column public.notifications.audience_permission is
  'The capability a reader must hold. Required: a notification nobody is entitled to read is a leak waiting for a policy change.';
comment on column public.notifications.dedupe_key is
  'What makes a generation trigger safely re-runnable. An event key for an event; a key carrying the business date for a reading taken at a moment, which is how "once a day" is expressed with no scheduler.';

create trigger notifications_no_update
  before update on public.notifications
  execute function public.reject_mutation();

create trigger notifications_no_delete
  before delete on public.notifications
  execute function public.reject_mutation();

-- ---------------------------------------------------------------------------
-- Read receipts
--
-- Separate, insert-only, and keyed by the pair. "Unread" is the absence of a
-- row, which means a notification raised before a staff member existed is
-- unread for them — correct, because the thing it is about still needs doing.
-- ---------------------------------------------------------------------------

create table public.notification_reads (
  -- `restrict` on both, for the same reason: this table refuses UPDATE and
  -- DELETE, so a cascade into it would surface as "notification_reads is
  -- append-only" rather than as the reference it actually is.
  notification_id uuid not null
    references public.notifications(id) on delete restrict,
  profile_id uuid not null references public.profiles(id) on delete restrict,
  read_at timestamptz not null default pg_catalog.now(),

  primary key (notification_id, profile_id)
);

create index notification_reads_profile_idx
  on public.notification_reads (profile_id, read_at desc);

comment on table public.notification_reads is
  'Phase 15. Who has read which notification. Insert-only: nothing un-happens and nobody un-reads, so there is no update and no delete.';

create trigger notification_reads_no_update
  before update on public.notification_reads
  execute function public.reject_mutation();

create trigger notification_reads_no_delete
  before delete on public.notification_reads
  execute function public.reject_mutation();

-- ---------------------------------------------------------------------------
-- Raising one
--
-- Every generation trigger goes through this, so the actor derivation, the
-- idempotency and the "do not fail the business transaction" rule are written
-- once rather than fourteen times.
-- ---------------------------------------------------------------------------

create or replace function public.raise_notification(
  p_category text,
  p_severity text,
  p_title text,
  p_body text,
  p_audience_permission text,
  p_entity_type text,
  p_entity_id uuid,
  p_dedupe_key text,
  p_audience_profile_id uuid default null,
  p_audience_branch_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  insert into public.notifications (
    category, severity, title, body,
    audience_permission, audience_profile_id, audience_branch_id,
    entity_type, entity_id,
    actor_profile_id, actor_label, dedupe_key
  )
  values (
    p_category, p_severity, pg_catalog.btrim(p_title),
    nullif(pg_catalog.btrim(coalesce(p_body, '')), ''),
    p_audience_permission, p_audience_profile_id, p_audience_branch_id,
    p_entity_type, p_entity_id,
    public.current_profile_id(), public.audit_actor_label(), p_dedupe_key
  )
  -- The whole point of the dedupe key. A trigger that fires twice for the
  -- same event — a retried transaction, a backfill, a second UPDATE touching
  -- the same row — raises one notification.
  on conflict (category, dedupe_key) do nothing
  returning id into v_id;

  return v_id;
end;
$$;

comment on function public.raise_notification(text, text, text, text, text, text, uuid, text, uuid, uuid) is
  'Phase 15. The one way a notification is created: derives the actor from the session and swallows a duplicate on the dedupe key, so every generation trigger is safely re-runnable.';

revoke all on function public.raise_notification(text, text, text, text, text, text, uuid, text, uuid, uuid)
  from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Marking them read
--
-- A function rather than a client-side insert, because the row the client
-- would have to supply is its own `profile_id` — and a client that can choose
-- whose read receipt it writes can mark somebody else's bell clear.
-- ---------------------------------------------------------------------------

create or replace function public.mark_notifications_read(p_ids uuid[] default null)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_profile uuid;
  v_count integer;
begin
  v_profile := public.current_profile_id();

  if v_profile is null then
    raise exception 'Only a signed-in user can mark a notification read.'
      using errcode = 'P0001';
  end if;

  -- Null means "everything I can currently see", which is what the "mark all
  -- read" control does. Passing ids marks exactly those, and an id the caller
  -- cannot see is silently skipped rather than refused: the honest answer to
  -- "mark this read" for something you cannot read is that there was nothing
  -- to mark.
  insert into public.notification_reads (notification_id, profile_id)
  select n.id, v_profile
    from public.notifications n
   where (p_ids is null or n.id = any (p_ids))
     and public.user_has_permission(n.audience_permission)
     and (n.audience_profile_id is null or n.audience_profile_id = v_profile)
     and (n.audience_branch_id is null or public.user_can_see_branch(n.audience_branch_id))
  on conflict (notification_id, profile_id) do nothing;

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

comment on function public.mark_notifications_read(uuid[]) is
  'Phase 15. Marks notifications read for the calling user. Null marks everything they can see. A caller cannot write somebody else''s read receipt, which is why this is a function and not an insert.';

revoke all on function public.mark_notifications_read(uuid[]) from public, anon;
grant execute on function public.mark_notifications_read(uuid[]) to authenticated;

-- ---------------------------------------------------------------------------
-- Capabilities
--
-- `notifications:view` gates the *surface*, not the rows. It grants nobody a
-- notification they could not already have read, because every row is behind
-- the capability of the thing it is about — a Secretary/Treasurer holding
-- this sees no reversal and no variance. It exists so the route has a
-- capability of its own rather than borrowing `dashboard:view`, which is the
-- defect Phases 3, 6 and 8 each found once.
-- ---------------------------------------------------------------------------

insert into public.permissions (key, description) values
  ('notifications:view', 'See the notification bell and the notifications page.')
on conflict (key) do nothing;

insert into public.role_permissions (role_key, permission_key) values
  ('secretary_treasurer', 'notifications:view'),
  ('manager', 'notifications:view'),
  ('owner_admin', 'notifications:view')
on conflict (role_key, permission_key) do nothing;

alter table public.notifications enable row level security;
alter table public.notification_reads enable row level security;

revoke all on table public.notifications from anon, authenticated;
-- SELECT only. `raise_notification` is the only writer and it runs as the
-- table owner, so no session has a write privilege to misuse.
grant select on table public.notifications to authenticated;

revoke all on table public.notification_reads from anon, authenticated;
-- The same: `mark_notifications_read` is the only writer.
grant select on table public.notification_reads to authenticated;

-- The three narrowings, in one policy. Each is independent and each is
-- optional, so a notification with none of them set is visible to everybody
-- holding its capability — which is the common case and the intended one.
create policy notifications_select_for_audience
  on public.notifications for select to authenticated
  using (
    public.user_has_permission('notifications:view')
    and public.user_has_permission(audience_permission)
    and (audience_profile_id is null
         or audience_profile_id = public.current_profile_id())
    and (audience_branch_id is null
         or public.user_can_see_branch(audience_branch_id))
  );

-- A read receipt is nobody else's business.
create policy notification_reads_select_own
  on public.notification_reads for select to authenticated
  using (profile_id = public.current_profile_id());

-- ---------------------------------------------------------------------------
-- The feed
--
-- One row per notification the caller may see, with whether *they* have read
-- it. `security_invoker`, so the policy above decides which rows come back.
-- ---------------------------------------------------------------------------

create view public.notification_feed with (security_invoker = true) as
select
  n.id,
  n.category,
  n.severity,
  n.title,
  n.body,
  n.entity_type,
  n.entity_id,
  n.actor_profile_id,
  n.actor_label,
  n.occurred_at,
  n.audience_permission,
  n.audience_profile_id,
  n.audience_branch_id,
  -- Addressed to me personally rather than to my role. Worth distinguishing
  -- on screen: "your application was refused" deserves more attention from
  -- the person it names than from the four others who can also see it.
  (n.audience_profile_id is not null) as is_personal,
  (r.profile_id is not null) as is_read,
  r.read_at
from public.notifications n
left join public.notification_reads r
       on r.notification_id = n.id
      and r.profile_id = public.current_profile_id();

comment on view public.notification_feed is
  'Phase 15. The notifications the caller may see, each with whether that caller has read it. Read state is per person, so one event reads as unread for one staff member and read for another.';

revoke all on public.notification_feed from anon, authenticated;
grant select on public.notification_feed to authenticated;

-- One row, for the bell. A count and the newest few would be two queries on
-- every page load; this is the count, and the page itself reads the feed.
create view public.notification_summary with (security_invoker = true) as
select
  pg_catalog.count(*)::integer as total,
  pg_catalog.count(*) filter (where not f.is_read)::integer as unread,
  pg_catalog.count(*) filter (where not f.is_read and f.severity = 'urgent')::integer
    as unread_urgent,
  pg_catalog.count(*) filter (where not f.is_read and f.severity = 'attention')::integer
    as unread_attention,
  pg_catalog.max(f.occurred_at) filter (where not f.is_read) as newest_unread_at
from public.notification_feed f;

comment on view public.notification_summary is
  'Phase 15. What the bell shows: how many the caller has not read, and how many of those are urgent. One row, always — zeroes rather than no row when there is nothing, so the caller never has to tell "no notifications" from "the query failed".';

revoke all on public.notification_summary from anon, authenticated;
grant select on public.notification_summary to authenticated;
