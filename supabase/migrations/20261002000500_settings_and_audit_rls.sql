-- ===========================================================================
-- 20261002000500_settings_and_audit_rls
--
-- Access to settings and to the audit trail.
--
-- ## Settings
--
-- `settings:view` is held by every staff role, because a Secretary/Treasurer
-- quoting a loan needs to know the minimum amount and the interest rate.
-- `settings:update` is Owner-only: these rows decide the rate money is lent
-- at, and a Manager who could change them could change the business.
--
-- A client holds neither. Nothing in the portal needs the company's tax
-- number or the penalty rate.
--
-- ## Audit
--
-- Read access is Owner-only in this phase. The brief allows a Manager limited
-- read access "if needed", and nothing needs it yet — the trail currently
-- records user administration, which is exactly the Manager-excluded area. A
-- narrower grant is easy to widen later and impossible to un-leak now.
--
-- The append-only guarantees from Phase 1 are untouched: no UPDATE, DELETE or
-- TRUNCATE policy exists, and those privileges stay revoked from every role
-- including `service_role`.
--
-- ## reference_formats and reference_sequences
--
-- Deliberately left default-deny. Nothing in the application reads them from a
-- session: references are issued by `public.next_reference()`, which runs as
-- `service_role` on a trusted server path. Opening them would expose how many
-- clients and loans exist, which is commercially sensitive and bought nothing.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- company_settings
-- ---------------------------------------------------------------------------

grant select, update on table public.company_settings to authenticated;

create policy company_settings_select_with_permission
  on public.company_settings
  for select
  to authenticated
  using (public.user_has_permission('settings:view'));

create policy company_settings_update_with_permission
  on public.company_settings
  for update
  to authenticated
  using (public.user_has_permission('settings:update'))
  with check (public.user_has_permission('settings:update'));

comment on policy company_settings_select_with_permission on public.company_settings is
  'Staff read company identity. Clients hold no settings capability and see nothing.';
comment on policy company_settings_update_with_permission on public.company_settings is
  'Owner-only. The row carries the registration and tax details.';

-- No INSERT or DELETE: the row is a seeded singleton (CHECK (id = 1)).


-- ---------------------------------------------------------------------------
-- business_settings
-- ---------------------------------------------------------------------------

grant select, update on table public.business_settings to authenticated;

create policy business_settings_select_with_permission
  on public.business_settings
  for select
  to authenticated
  using (public.user_has_permission('settings:view'));

create policy business_settings_update_with_permission
  on public.business_settings
  for update
  to authenticated
  using (public.user_has_permission('settings:update'))
  with check (public.user_has_permission('settings:update'));

comment on policy business_settings_select_with_permission on public.business_settings is
  'Staff read the lending rules they quote to clients.';
comment on policy business_settings_update_with_permission on public.business_settings is
  'Owner-only. These columns decide the rate money is lent at.';


-- ---------------------------------------------------------------------------
-- repayment_frequencies
--
-- Phase 1 already opened SELECT on active rows to every signed-in user. Adding
-- the administrative writes here keeps cadence management with the rest of the
-- settings capability, ready for the settings screen in a later phase.
-- ---------------------------------------------------------------------------

grant insert, update on table public.repayment_frequencies to authenticated;

create policy repayment_frequencies_insert_with_permission
  on public.repayment_frequencies
  for insert
  to authenticated
  with check (public.user_has_permission('settings:update'));

create policy repayment_frequencies_update_with_permission
  on public.repayment_frequencies
  for update
  to authenticated
  using (public.user_has_permission('settings:update'))
  with check (public.user_has_permission('settings:update'));

-- No DELETE: a retired cadence is `is_active = false`, so loans that already
-- reference it keep a valid foreign key.


-- ---------------------------------------------------------------------------
-- audit_log
-- ---------------------------------------------------------------------------

grant select on table public.audit_log to authenticated;

create policy audit_log_select_with_permission
  on public.audit_log
  for select
  to authenticated
  using (public.user_has_permission('audit:view'));

comment on policy audit_log_select_with_permission on public.audit_log is
  'Owner-only read. No INSERT policy: writes go through SECURITY DEFINER paths so the actor cannot be forged.';

-- Deliberately absent, and re-asserted here so a future reader sees it was a
-- decision rather than an omission: no INSERT policy (writes are made by the
-- audit triggers and by record_security_event, both SECURITY DEFINER), and no
-- UPDATE, DELETE or TRUNCATE policy (the table is append-only).
revoke insert, update, delete, truncate on table public.audit_log
  from anon, authenticated;


-- ---------------------------------------------------------------------------
-- Security events that are not row changes
--
-- The audit triggers in the next migration cover everything that writes to a
-- table. Signing in, signing out and changing a password are not table writes,
-- so they need a path of their own.
--
-- The vocabulary is CLOSED. A caller may record that they signed in; they may
-- not invent `loan.approved`. Together with the actor being derived rather
-- than supplied, that means an authenticated user can write only true
-- statements about themselves.
-- ---------------------------------------------------------------------------
create or replace function public.record_security_event(
  p_action   text,
  p_metadata jsonb default null
)
returns bigint
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_profile_id  uuid;
  v_actor_label text;
  v_id          bigint;
begin
  if p_action not in (
    'auth.signed_in',
    'auth.signed_out',
    'auth.password_changed',
    'auth.sign_in_denied'
  ) then
    raise exception 'Unsupported security event: %', p_action
      using errcode = 'P0001';
  end if;

  v_profile_id := public.current_profile_id();

  if v_profile_id is not null then
    select p.full_name into v_actor_label
    from public.profiles p
    where p.id = v_profile_id;
  end if;

  insert into public.audit_log (
    actor_profile_id, actor_auth_user_id, actor_label,
    action, entity_type, entity_id, metadata
  )
  values (
    v_profile_id,
    auth.uid(),
    coalesce(nullif(pg_catalog.btrim(v_actor_label), ''), 'unknown'),
    p_action,
    'auth_session',
    v_profile_id::text,
    p_metadata
  )
  returning id into v_id;

  return v_id;
end;
$$;

comment on function public.record_security_event(text, jsonb) is
  'Records a sign-in, sign-out or password change. Closed action vocabulary; the actor is derived from the session and cannot be supplied.';

revoke all on function public.record_security_event(text, jsonb) from public, anon, authenticated;
grant execute on function public.record_security_event(text, jsonb) to authenticated;
