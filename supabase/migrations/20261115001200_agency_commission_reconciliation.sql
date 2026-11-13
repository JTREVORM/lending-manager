-- ===========================================================================
-- Phase 4E — reconciling what we recognised against what the provider says
--
-- This is the control that replaces the configured rate.
--
-- Before Phase 4E a provider's commission was computed from a rate, and the
-- rate was a cross-check: it said what the provider ought to have paid, and a
-- figure that differed needed the Owner's authorisation. Taking the rate away
-- for mobile money — which the approved decisions do, because the real figure
-- arrives in a confirmation message — removes that cross-check. Without
-- something in its place, a figure a cashier types is simply believed.
--
-- What replaces it is this: periodically, the provider's own statement is
-- compared with what we recognised, per agent line, over the provider's own
-- dates. A difference is a question to answer, not a number to adjust.
--
-- ## Decision OD-9, in three parts
--
-- "Use the provider's exact statement start and end dates in Africa/Kampala."
-- The period is two dates the officer copies off the statement, not a month
-- this schema picks. `business_date()` is Africa/Kampala by ADR-004 and the
-- dates are plain `date` values in that frame.
--
-- "Detect overlapping periods for the same line." Two statements that overlap
-- would double-count the transactions in the overlap, and the second
-- reconciliation would look like a discrepancy when it is an arithmetic
-- artefact. Overlap is refused.
--
-- "Preserve separate calendar-month reports." The statement period is what is
-- reconciled; the calendar month is what management reads. They are different
-- questions, so `agency_commission_monthly` answers the second one without
-- the first having to pretend to.
--
-- ## Decision OD-2, which is why there is no journal here at all
--
-- "Investigate discrepancies, allow audited transaction corrections or
-- Owner-authorized adjustments with independent verification. Reconciliation
-- never automatically posts financial changes."
--
-- So certification writes no journal line. Not a zero-value one, not a
-- rounding plug — nothing. The commission we recognised is already in the
-- books, transaction by transaction; if it is wrong, the transaction is
-- corrected or the Owner authorises an adjustment, each of which is its own
-- audited act with its own authority. A certification that quietly moved
-- 1310 would make the reconciliation the thing that decides income, and
-- nobody would ever look at the transactions again.
--
-- A certified reconciliation with a variance therefore stays visible: it
-- appears on the end-of-day exceptions view until the variance is zero.
-- "Certified" here means "two people have seen this difference", not
-- "resolved".
--
-- ## Why overlap is checked in the function and not by an EXCLUDE constraint
--
-- An EXCLUDE constraint over (float_account_id, daterange) would be the right
-- tool and needs `btree_gist`, which is not installed on the hosted project.
-- Installing an extension there is a production change, and this phase makes
-- none. So the check is a query, made sound by taking
-- `lock_agency_provider_balance()` first — the same lock every other agency
-- writer takes, which serialises two officers submitting for one provider at
-- one branch. The unique index below still catches an exact repeat.
-- ===========================================================================

create table if not exists public.agency_commission_reconciliations (
  id                           uuid primary key default gen_random_uuid(),
  provider_id                  uuid not null references public.agency_service_providers(id) on delete restrict,
  branch_id                    uuid not null references public.branches(id) on delete restrict,
  float_account_id             uuid not null references public.agency_provider_float_accounts(id) on delete restrict,

  period_start                 date not null,
  period_end                   date not null,

  -- What our books recognised for this line over the period, computed at
  -- submission and kept. A later reversal changes the live figure, and the
  -- snapshot is what the two officers actually compared.
  system_commission_earned     bigint not null,
  provider_reported_commission bigint not null,
  variance                     bigint not null,

  statement_ref                text not null,
  notes                        text,

  status                       text not null default 'open',
  created_by                   uuid not null references public.profiles(id) on delete restrict,
  reconciled_by                uuid references public.profiles(id) on delete restrict,
  reconciled_at                timestamptz,
  created_at                   timestamptz not null default now(),
  updated_at                   timestamptz not null default now(),

  constraint agency_commission_recon_status_valid
    check (status = any (array['open', 'certified'])),

  constraint agency_commission_recon_period_in_order
    check (period_end >= period_start),

  constraint agency_commission_recon_amounts_not_negative
    check (system_commission_earned >= 0 and provider_reported_commission >= 0),

  -- The variance is derived, and stored so a reader need not re-derive it.
  -- Positive means the provider says they paid more than we recognised.
  constraint agency_commission_recon_variance_agrees
    check (variance = provider_reported_commission - system_commission_earned),

  constraint agency_commission_recon_statement_ref_stated
    check (pg_catalog.btrim(statement_ref) = statement_ref
           and pg_catalog.length(statement_ref) between 3 and 80),

  -- The person who read the statement may not be the person who certifies it.
  constraint agency_commission_recon_maker_is_not_checker
    check (reconciled_by is null or reconciled_by <> created_by),

  constraint agency_commission_recon_open_is_clean
    check (status <> 'open'
           or (reconciled_by is null and reconciled_at is null)),

  constraint agency_commission_recon_certified_is_complete
    check (status <> 'certified'
           or (reconciled_by is not null and reconciled_at is not null))
);

comment on table public.agency_commission_reconciliations is
  'Phase 4E, decisions OD-9 and OD-2. One provider statement period for one agent line: what our books recognised, what the provider reported, and the difference. Carries no journal column because certification posts nothing — a real difference is corrected through the transaction or an authorised adjustment, never by the reconciliation itself.';
comment on column public.agency_commission_reconciliations.variance is
  'provider_reported_commission - system_commission_earned. Positive: the provider says they paid more than we recognised. Negative: we recognised more than they report paying.';
comment on column public.agency_commission_reconciliations.system_commission_earned is
  'What the books recognised for this line over the period, snapshotted at submission. The live figure can move afterwards — a reversal changes it — and this is what the two officers compared.';

create unique index if not exists agency_commission_recon_period_unique
  on public.agency_commission_reconciliations (float_account_id, period_start, period_end);

create unique index if not exists agency_commission_recon_statement_unique
  on public.agency_commission_reconciliations (float_account_id, statement_ref);

create index if not exists agency_commission_recon_open_idx
  on public.agency_commission_reconciliations (branch_id, status, period_end);

alter table public.agency_commission_reconciliations enable row level security;
revoke all on table public.agency_commission_reconciliations from anon, authenticated;
grant select on table public.agency_commission_reconciliations to authenticated;

drop policy if exists agency_commission_recon_read on public.agency_commission_reconciliations;
-- The branch rule restated inline, as 20261018000100 requires: the helper is
-- correlated and SECURITY DEFINER, so it cannot be hoisted and would run two
-- queries against `profiles` per row.
create policy agency_commission_recon_read
  on public.agency_commission_reconciliations for select
  to authenticated
  using ((select public.user_has_permission('agency:reports'))
         and (branch_id is null
              or (select public.current_user_branch_id()) is null
              or branch_id = (select public.current_user_branch_id())));

drop trigger if exists agency_commission_recon_no_delete on public.agency_commission_reconciliations;
create trigger agency_commission_recon_no_delete
  before delete on public.agency_commission_reconciliations
  for each row execute function public.reject_mutation();

drop trigger if exists agency_commission_recon_set_updated_at on public.agency_commission_reconciliations;
create trigger agency_commission_recon_set_updated_at
  before update on public.agency_commission_reconciliations
  for each row execute function public.set_updated_at();


-- ---------------------------------------------------------------------------
-- What the books recognised for one line over one period
--
-- Commission on transactions **dated** within the period that are posted and
-- not reversed. Dated, not posted-at: a transaction recorded on the 1st for
-- business done on the 31st belongs to the statement that covers the 31st,
-- which is the provider's view and the only one the comparison can use.
-- ---------------------------------------------------------------------------

create or replace function public.agency_commission_earned_by_line(
  p_float_account_id uuid,
  p_from             date,
  p_to               date
)
returns bigint
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(pg_catalog.sum(t.commission_amount), 0)::bigint
    from public.agency_transactions t
   where t.float_account_id = p_float_account_id
     and t.status = 'posted'
     and t.transaction_date between p_from and p_to;
$$;

comment on function public.agency_commission_earned_by_line(uuid, date, date) is
  'Phase 4E. Commission recognised on one agent line''s posted, unreversed transactions dated within a period. Dated rather than posted-at, because the provider''s statement covers the days business was done.';

revoke all on function public.agency_commission_earned_by_line(uuid, date, date)
  from public, anon, authenticated;


-- ---------------------------------------------------------------------------
-- Submitting a statement period
-- ---------------------------------------------------------------------------

create or replace function public.submit_agency_commission_reconciliation(
  p_float_account_id uuid,
  p_period_start     date,
  p_period_end       date,
  p_provider_reported_commission bigint,
  p_statement_ref    text,
  p_notes            text default null
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor    uuid;
  f          record;
  pr         public.agency_service_providers;
  v_ref      text;
  v_earned   bigint;
  v_overlap  record;
  v_id       uuid;
begin
  v_actor := public.agency_actor('agency:reconcile');

  select a.id, a.provider_id, a.branch_id, a.status, a.till_name, a.label
    into f
  from public.agency_provider_float_accounts a where a.id = p_float_account_id;

  if f.id is null or not public.user_can_see_branch(f.branch_id) then
    raise exception 'No such agent line.' using errcode = 'P0001';
  end if;

  select * into pr from public.agency_service_providers where id = f.provider_id;

  if p_period_start is null or p_period_end is null then
    raise exception
      'A commission reconciliation needs the statement''s own start and end dates.'
      using errcode = 'P0001';
  end if;

  if p_period_end < p_period_start then
    raise exception 'The statement period ends before it starts.'
      using errcode = 'P0001';
  end if;

  if p_period_end > public.business_date() then
    raise exception
      'The statement period ends in the future, on %. Today is %.',
      p_period_end, public.business_date()
      using errcode = 'P0001';
  end if;

  if p_provider_reported_commission is null or p_provider_reported_commission < 0 then
    raise exception
      'The commission the provider reports must be stated, and cannot be negative. Enter 0 if their statement shows none.'
      using errcode = 'P0001';
  end if;

  v_ref := nullif(pg_catalog.btrim(coalesce(p_statement_ref, '')), '');
  if v_ref is null then
    raise exception
      'A commission reconciliation needs the provider''s statement reference.'
      using errcode = 'P0001';
  end if;

  -- Serialises two officers submitting for one provider at one branch, which
  -- is what makes the overlap check below sound rather than racy.
  perform public.lock_agency_provider_balance(f.provider_id, f.branch_id);

  select r.period_start, r.period_end, r.statement_ref into v_overlap
  from public.agency_commission_reconciliations r
  where r.float_account_id = p_float_account_id
    and r.period_start <= p_period_end
    and r.period_end >= p_period_start
  order by r.period_start
  limit 1;

  if v_overlap.period_start is not null then
    raise exception
      'That period overlaps the statement already reconciled for % to % (%). Two overlapping statements would count the same transactions twice.',
      v_overlap.period_start, v_overlap.period_end, v_overlap.statement_ref
      using errcode = 'P0001';
  end if;

  v_earned := public.agency_commission_earned_by_line(
    p_float_account_id, p_period_start, p_period_end);

  begin
    insert into public.agency_commission_reconciliations
      (provider_id, branch_id, float_account_id, period_start, period_end,
       system_commission_earned, provider_reported_commission, variance,
       statement_ref, notes, created_by)
    values
      (f.provider_id, f.branch_id, p_float_account_id, p_period_start, p_period_end,
       v_earned, p_provider_reported_commission,
       p_provider_reported_commission - v_earned,
       v_ref, nullif(pg_catalog.btrim(coalesce(p_notes, '')), ''), v_actor)
    returning id into v_id;
  exception when unique_violation then
    raise exception
      'That statement reference, or that exact period, has already been reconciled for this agent line.'
      using errcode = 'P0001';
  end;

  perform public.record_audit_event(
    'agency_commission_reconciliation.submitted',
    'agency_commission_reconciliation', v_id::text,
    null,
    pg_catalog.jsonb_build_object(
      'period_start', p_period_start, 'period_end', p_period_end,
      'system_commission_earned', v_earned,
      'provider_reported_commission', p_provider_reported_commission,
      'variance', p_provider_reported_commission - v_earned,
      'statement_ref', v_ref),
    pg_catalog.jsonb_build_object('provider_code', pr.code), null);

  return v_id;
end;
$$;

comment on function public.submit_agency_commission_reconciliation(
  uuid, date, date, bigint, text, text) is
  'Phase 4E, decision OD-9. Records one provider statement period for one agent line, with what our books recognised over the provider''s own dates and what their statement reports. Refuses a period that overlaps one already reconciled for the line, one that ends in the future, and a missing reference. Posts no journal. Needs agency:reconcile.';

revoke all on function public.submit_agency_commission_reconciliation(
  uuid, date, date, bigint, text, text)
  from public, anon, authenticated;
grant execute on function public.submit_agency_commission_reconciliation(
  uuid, date, date, bigint, text, text)
  to authenticated;


-- ---------------------------------------------------------------------------
-- Certifying one — which changes no balance, deliberately
-- ---------------------------------------------------------------------------

create or replace function public.certify_agency_commission_reconciliation(
  p_reconciliation_id uuid,
  p_notes             text default null
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor uuid;
  r       public.agency_commission_reconciliations;
begin
  v_actor := public.agency_actor('agency:reconcile');

  select * into r from public.agency_commission_reconciliations
   where id = p_reconciliation_id for update;

  if r.id is null or not public.user_can_see_branch(r.branch_id) then
    raise exception 'No such commission reconciliation.' using errcode = 'P0001';
  end if;

  if r.status = 'certified' then
    raise exception 'That commission reconciliation is already certified.'
      using errcode = 'P0001';
  end if;

  if r.created_by = v_actor then
    raise exception
      'A commission reconciliation cannot be certified by the person who submitted it.'
      using errcode = 'P0001';
  end if;

  -- No journal. Decision OD-2: reconciliation never posts a financial change.
  -- A variance that survives certification stays on the exceptions view until
  -- it is corrected at the transaction or adjusted on the Owner's authority.
  update public.agency_commission_reconciliations
     set status        = 'certified',
         reconciled_by = v_actor,
         reconciled_at = now(),
         notes         = coalesce(nullif(pg_catalog.btrim(coalesce(p_notes, '')), ''), notes),
         updated_at    = now()
   where id = p_reconciliation_id;

  perform public.record_audit_event(
    'agency_commission_reconciliation.certified',
    'agency_commission_reconciliation', p_reconciliation_id::text,
    pg_catalog.jsonb_build_object('status', 'open'),
    pg_catalog.jsonb_build_object(
      'status', 'certified', 'variance', r.variance,
      'posted_journal', false),
    null, null);
end;
$$;

comment on function public.certify_agency_commission_reconciliation(uuid, text) is
  'Phase 4E, decisions OD-9 and OD-2. Certifies a commission reconciliation: a second officer has seen the difference. Writes no journal line of any kind, so certification never changes a balance — a real difference is corrected at the transaction or adjusted on the Owner''s authority. Refuses the person who submitted it. Needs agency:reconcile.';

revoke all on function public.certify_agency_commission_reconciliation(uuid, text)
  from public, anon, authenticated;
grant execute on function public.certify_agency_commission_reconciliation(uuid, text)
  to authenticated;
