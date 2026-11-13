-- ===========================================================================
-- Phase 4E — registering, editing, suspending and closing an agent line
--
-- Decision OD-4: "Normal deactivation requires zero float, settled commission
-- and no pending obligations. Emergency suspension immediately stops new
-- activity while retaining balances, histories and authorized recovery
-- operations."
--
-- 20261115000200 gave a line the columns for all of that and the constraints
-- that keep them honest. What has never existed is a way for the Owner to
-- change any of it: `ensure_agency_float_account()` mints a line and the
-- identity columns were only ever writable by a direct UPDATE. These five
-- functions are the way, and they are the only way the application has.
--
-- ## Why closure asks a question rather than asserting a rule
--
-- `agency_agent_line_obligations()` returns the list of reasons a line cannot
-- be closed, and `close_agency_agent_line()` refuses with that list. Two
-- functions rather than one because the screen needs the same answer *before*
-- the Owner presses anything: "you cannot close this line" is not useful
-- unless it says what to do about it, and computing that in the client would
-- be a second implementation of the rule.
--
-- The five obligations, each of which is a thing that would be lost or
-- stranded by closing the line:
--
--   * float still held — it would be stranded in an account nothing can post
--     to. Move it with a transfer or sell it;
--   * commission still owed by the provider — closing the line does not stop
--     them owing it, and the receivable would have no line to attribute it to;
--   * commission owed back to the provider — the same, in the other
--     direction;
--   * transactions still in flight — a draft or one awaiting verification is
--     a customer's money in an undecided state;
--   * float trades still pending — somebody recorded a movement that a
--     verifier has not yet seen.
--
-- Suspension asks none of these, deliberately. It is the emergency stop, and
-- a control you cannot reach in an emergency is not one.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- 1. What stands in the way of closing a line
-- ---------------------------------------------------------------------------

create or replace function public.agency_agent_line_obligations(
  p_float_account_id uuid
)
returns text[]
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  f          record;
  v_reasons  text[] := array[]::text[];
  v_float    bigint;
  v_owed     bigint;
  v_back     bigint;
  v_inflight bigint;
  v_pending  bigint;
begin
  select a.id, a.ledger_account_id, a.provider_id, a.branch_id
    into f
  from public.agency_provider_float_accounts a
  where a.id = p_float_account_id;

  if f.id is null then
    raise exception 'No such agent line.' using errcode = 'P0001';
  end if;

  v_float := public.ledger_account_balance(f.ledger_account_id);
  if v_float <> 0 then
    v_reasons := v_reasons || pg_catalog.format(
      'it still holds %s shillings of float', v_float);
  end if;

  v_owed := public.agency_commission_outstanding_by_line(p_float_account_id);
  if v_owed <> 0 then
    v_reasons := v_reasons || pg_catalog.format(
      '%s shillings of commission are still owed to it', v_owed);
  end if;

  v_back := public.agency_commission_recovery_outstanding_by_line(p_float_account_id);
  if v_back <> 0 then
    v_reasons := v_reasons || pg_catalog.format(
      '%s shillings of commission are still owed back to the provider', v_back);
  end if;

  select count(*) into v_inflight
  from public.agency_transactions t
  where t.float_account_id = p_float_account_id
    and t.status in ('draft', 'awaiting_verification');
  if v_inflight > 0 then
    v_reasons := v_reasons || pg_catalog.format(
      '%s transaction(s) are still in flight', v_inflight);
  end if;

  select count(*) into v_pending
  from public.agency_float_trades tr
  where (tr.float_account_id = p_float_account_id
         or tr.counter_float_account_id = p_float_account_id)
    and tr.status = 'pending';
  if v_pending > 0 then
    v_reasons := v_reasons || pg_catalog.format(
      '%s float trade(s) are still pending', v_pending);
  end if;

  return v_reasons;
end;
$$;

comment on function public.agency_agent_line_obligations(uuid) is
  'Phase 4E, decision OD-4. The reasons an agent line cannot be closed yet: float still held, commission owed either way, transactions in flight, float trades pending. Empty means it can be closed. The screen reads this before offering the button, and close_agency_agent_line() refuses with the same list, so the rule has one implementation.';

revoke all on function public.agency_agent_line_obligations(uuid)
  from public, anon, authenticated;
grant execute on function public.agency_agent_line_obligations(uuid)
  to authenticated;


-- ---------------------------------------------------------------------------
-- 2. Registering a line
--
-- Wraps `ensure_agency_float_account()`, which already mints the `1320.*`
-- account and already requires `agency:providers`, and adds the identity in
-- the same transaction. Deliberately *not* idempotent, unlike the function it
-- wraps: `ensure` returning an existing line is right for a seed, and wrong
-- for an Owner filling in a registration form, who would be told a line was
-- created when their details were silently discarded.
-- ---------------------------------------------------------------------------

create or replace function public.register_agency_agent_line(
  p_provider_id uuid,
  p_branch_id   uuid,
  p_till_name   text,
  p_label       text default null,
  p_line_msisdn text default null,
  p_agent_code  text default null,
  p_opened_on   date default null,
  p_notes       text default null
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor uuid;
  v_till  text;
  v_id    uuid;
  pr      public.agency_service_providers;
begin
  if auth.uid() is not null
     and not (select public.user_has_permission('agency:providers')) then
    raise exception 'Not authorized to register an agent line.'
      using errcode = '42501';
  end if;

  v_actor := public.current_profile_id();
  v_till := nullif(pg_catalog.btrim(coalesce(p_till_name, '')), '');
  if v_till is null then
    raise exception 'An agent line needs a till name.' using errcode = 'P0001';
  end if;

  select * into pr from public.agency_service_providers where id = p_provider_id;
  if pr.id is null then
    raise exception 'No such agency provider.' using errcode = 'P0001';
  end if;

  if exists (
    select 1 from public.agency_provider_float_accounts a
     where a.provider_id = p_provider_id
       and a.branch_id = p_branch_id
       and a.till_name = v_till
  ) then
    raise exception
      '% already has a line called % at that branch. Edit it, or choose another till name.',
      pr.name, v_till
      using errcode = 'P0001';
  end if;

  v_id := public.ensure_agency_float_account(p_provider_id, p_branch_id, v_till);

  update public.agency_provider_float_accounts
     set label       = coalesce(nullif(pg_catalog.btrim(coalesce(p_label, '')), ''), ''),
         line_msisdn = nullif(pg_catalog.btrim(coalesce(p_line_msisdn, '')), ''),
         agent_code  = nullif(pg_catalog.btrim(coalesce(p_agent_code, '')), ''),
         opened_on   = coalesce(p_opened_on, public.business_date()),
         notes       = nullif(pg_catalog.btrim(coalesce(p_notes, '')), ''),
         updated_by  = v_actor,
         updated_at  = now()
   where id = v_id;

  return v_id;
end;
$$;

comment on function public.register_agency_agent_line(
  uuid, uuid, text, text, text, text, date, text) is
  'Phase 4E. Registers an agent line: mints its 1320 ledger account through ensure_agency_float_account() and records its identity in the same transaction. Owner-only, audited by the configuration trigger, and refuses a till name the provider already uses at that branch rather than silently returning the existing line.';

revoke all on function public.register_agency_agent_line(
  uuid, uuid, text, text, text, text, date, text)
  from public, anon, authenticated;
grant execute on function public.register_agency_agent_line(
  uuid, uuid, text, text, text, text, date, text)
  to authenticated;


-- ---------------------------------------------------------------------------
-- 3. Editing the identity
--
-- A NULL argument leaves a field alone, which is what makes a partial edit
-- possible. Clearing a field is therefore an explicit empty string, and the
-- immutability trigger from 20261115000200 refuses the four facts that are
-- not identity at all.
-- ---------------------------------------------------------------------------

create or replace function public.update_agency_agent_line(
  p_float_account_id uuid,
  p_label            text default null,
  p_line_msisdn      text default null,
  p_agent_code       text default null,
  p_notes            text default null
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor uuid;
  f       record;
begin
  if auth.uid() is not null
     and not (select public.user_has_permission('agency:providers')) then
    raise exception 'Not authorized to edit an agent line.' using errcode = '42501';
  end if;

  v_actor := public.current_profile_id();

  select a.id, a.branch_id, a.status into f
  from public.agency_provider_float_accounts a where a.id = p_float_account_id;

  if f.id is null or not public.user_can_see_branch(f.branch_id) then
    raise exception 'No such agent line.' using errcode = 'P0001';
  end if;

  if f.status = 'closed' then
    raise exception
      'That agent line is closed, so its details are history and are not edited.'
      using errcode = 'P0001';
  end if;

  update public.agency_provider_float_accounts
     set label       = coalesce(p_label, label),
         line_msisdn = coalesce(nullif(pg_catalog.btrim(coalesce(p_line_msisdn, '')), ''),
                                case when p_line_msisdn = '' then null else line_msisdn end),
         agent_code  = coalesce(nullif(pg_catalog.btrim(coalesce(p_agent_code, '')), ''),
                                case when p_agent_code = '' then null else agent_code end),
         notes       = coalesce(nullif(pg_catalog.btrim(coalesce(p_notes, '')), ''),
                                case when p_notes = '' then null else notes end),
         updated_by  = v_actor,
         updated_at  = now()
   where id = p_float_account_id;
end;
$$;

comment on function public.update_agency_agent_line(uuid, text, text, text, text) is
  'Phase 4E. Edits an agent line''s label, line number, provider agent code and notes. A NULL argument leaves the field alone; an empty string clears it. Owner-only. The till name, ledger account, provider and branch are refused by the immutability trigger, because the ledger account code encodes them.';

revoke all on function public.update_agency_agent_line(uuid, text, text, text, text)
  from public, anon, authenticated;
grant execute on function public.update_agency_agent_line(uuid, text, text, text, text)
  to authenticated;


-- ---------------------------------------------------------------------------
-- 4. Suspending, and lifting a suspension
--
-- No balance conditions in either direction. A suspension that could be
-- refused because the line holds float would be useless exactly when it is
-- needed, and lifting one is how a line comes back after a false alarm.
-- ---------------------------------------------------------------------------

create or replace function public.set_agency_agent_line_suspended(
  p_float_account_id uuid,
  p_suspended        boolean,
  p_reason           text
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor  uuid;
  f        record;
  v_reason text;
begin
  if auth.uid() is not null
     and not (select public.user_has_permission('agency:providers')) then
    raise exception 'Not authorized to suspend or reinstate an agent line.'
      using errcode = '42501';
  end if;

  v_actor := public.current_profile_id();

  select a.id, a.branch_id, a.status, a.till_name, a.label into f
  from public.agency_provider_float_accounts a where a.id = p_float_account_id;

  if f.id is null or not public.user_can_see_branch(f.branch_id) then
    raise exception 'No such agent line.' using errcode = 'P0001';
  end if;

  if f.status = 'closed' then
    raise exception
      'That agent line is closed. A closed line is not suspended or reinstated.'
      using errcode = 'P0001';
  end if;

  v_reason := nullif(pg_catalog.btrim(coalesce(p_reason, '')), '');
  if v_reason is null then
    raise exception
      'Suspending a line, and lifting a suspension, each need a reason.'
      using errcode = 'P0001';
  end if;

  if p_suspended and f.status = 'suspended' then
    raise exception '% is already suspended.',
      coalesce(nullif(f.label, ''), f.till_name) using errcode = 'P0001';
  end if;

  if not p_suspended and f.status = 'active' then
    raise exception '% is not suspended.',
      coalesce(nullif(f.label, ''), f.till_name) using errcode = 'P0001';
  end if;

  update public.agency_provider_float_accounts
     set status            = case when p_suspended then 'suspended' else 'active' end,
         is_active         = not p_suspended,
         status_reason     = case when p_suspended then v_reason else null end,
         status_changed_by = case when p_suspended then v_actor else null end,
         status_changed_at = case when p_suspended then now() else null end,
         updated_by        = v_actor,
         updated_at        = now()
   where id = p_float_account_id;

  -- The row cannot carry the reason a suspension was *lifted* — the columns
  -- are cleared when it is — so the audit log does.
  perform public.record_audit_event(
    case when p_suspended then 'agency_agent_line.suspended'
         else 'agency_agent_line.reinstated' end,
    'agency_agent_line',
    p_float_account_id::text,
    pg_catalog.jsonb_build_object('status', f.status),
    pg_catalog.jsonb_build_object(
      'status', case when p_suspended then 'suspended' else 'active' end,
      'reason', v_reason),
    null, null);
end;
$$;

comment on function public.set_agency_agent_line_suspended(uuid, boolean, text) is
  'Phase 4E, decision OD-4. Suspends an agent line, or lifts a suspension. Both need a reason, and the lifting reason goes to the audit log because the row''s own columns are cleared. No balance conditions in either direction: a suspension refused because the line holds float would be useless exactly when it is needed. Owner-only.';

revoke all on function public.set_agency_agent_line_suspended(uuid, boolean, text)
  from public, anon, authenticated;
grant execute on function public.set_agency_agent_line_suspended(uuid, boolean, text)
  to authenticated;


-- ---------------------------------------------------------------------------
-- 5. Closing a line, which is the orderly end
-- ---------------------------------------------------------------------------

create or replace function public.close_agency_agent_line(
  p_float_account_id uuid,
  p_reason           text,
  p_closed_on        date default null
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor    uuid;
  f          record;
  v_reason   text;
  v_blockers text[];
begin
  if auth.uid() is not null
     and not (select public.user_has_permission('agency:providers')) then
    raise exception 'Not authorized to close an agent line.' using errcode = '42501';
  end if;

  v_actor := public.current_profile_id();

  select a.id, a.branch_id, a.status, a.till_name, a.label, a.opened_on into f
  from public.agency_provider_float_accounts a where a.id = p_float_account_id
  for update;

  if f.id is null or not public.user_can_see_branch(f.branch_id) then
    raise exception 'No such agent line.' using errcode = 'P0001';
  end if;

  if f.status = 'closed' then
    raise exception '% is already closed.',
      coalesce(nullif(f.label, ''), f.till_name) using errcode = 'P0001';
  end if;

  v_reason := nullif(pg_catalog.btrim(coalesce(p_reason, '')), '');
  if v_reason is null then
    raise exception 'Closing a line needs a reason.' using errcode = 'P0001';
  end if;

  v_blockers := public.agency_agent_line_obligations(p_float_account_id);

  if pg_catalog.array_length(v_blockers, 1) > 0 then
    raise exception
      '% cannot be closed yet: %. Settle these first, or suspend the line instead.',
      coalesce(nullif(f.label, ''), f.till_name),
      pg_catalog.array_to_string(v_blockers, '; ')
      using errcode = 'P0001';
  end if;

  update public.agency_provider_float_accounts
     set status            = 'closed',
         is_active         = false,
         closed_on         = coalesce(p_closed_on, public.business_date()),
         status_reason     = v_reason,
         status_changed_by = v_actor,
         status_changed_at = now(),
         updated_by        = v_actor,
         updated_at        = now()
   where id = p_float_account_id;

  perform public.record_audit_event(
    'agency_agent_line.closed', 'agency_agent_line', p_float_account_id::text,
    pg_catalog.jsonb_build_object('status', f.status),
    pg_catalog.jsonb_build_object(
      'status', 'closed',
      'closed_on', coalesce(p_closed_on, public.business_date()),
      'reason', v_reason),
    null, null);
end;
$$;

comment on function public.close_agency_agent_line(uuid, text, date) is
  'Phase 4E, decision OD-4. Closes an agent line, refusing while it holds float, is owed commission, owes commission back, has transactions in flight or float trades pending — and naming every one of those in the refusal. Owner-only, with a reason. Suspension is the route when a line must stop at once and these cannot be settled first.';

revoke all on function public.close_agency_agent_line(uuid, text, date)
  from public, anon, authenticated;
grant execute on function public.close_agency_agent_line(uuid, text, date)
  to authenticated;
