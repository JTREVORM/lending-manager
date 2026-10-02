-- ===========================================================================
-- Phase 5 — the authoritative schedule generator.
--
-- ## This is the authoritative implementation
--
-- There are two, exactly as in Phase 4: this one, and
-- `lib/domain/repayment-schedule.ts`. **The database is authoritative.** It
-- writes the rows, inside the disbursement transaction, from
-- `loans.disbursed_at`. The TypeScript engine computes the preview staff see
-- before disbursement and is tested exhaustively in isolation.
--
-- The generator accepts no figures from its caller. It takes a loan id and
-- reads everything else — the contract from `loan_periods`, the cadence from
-- `repayment_frequencies`, the anchor from `loans.disbursed_at`, the timezone
-- from `company_settings`. A caller who could supply a due date or an amount
-- could write a schedule that does not match the agreement.
--
-- ## The date rules
--
-- **Period windows.** Contractual month *n* occupies
-- `[D + (n-1) months, D + n months)` where D is the disbursement calendar
-- date — start inclusive, end exclusive. Exclusive is what stops one calendar
-- date belonging to two adjacent months and producing two collections on one
-- day.
--
-- Both boundaries are anchored on D rather than stepped from the previous
-- boundary. PostgreSQL's `date + interval 'n months'` both clamps to the end
-- of the target month (31 Jan + 1 month = 28 Feb, or 29 Feb in a leap year)
-- and anchors (31 Jan + 2 months = 31 Mar, not 28 Mar), which is precisely the
-- rule `addBusinessMonths` implements in TypeScript. Stepping would let one
-- February clamp drag every later boundary of a long loan earlier.
--
-- **First collection.** `D + interval_days`, never D itself: the borrower
-- receives the money and the first collection follows.
--
-- **The cadence.** `D + k × interval_days` for k = 1, 2, 3, …, each assigned
-- to the one window containing it, stopping strictly before the final
-- boundary. Building one global cadence and *assigning* it — rather than
-- restarting the rhythm inside each month — is what makes the dates strictly
-- increasing, never duplicated and never spilled past the contract, without
-- any of those needing separate arrangements.
--
-- ## The money rules
--
-- No interest is calculated here. It cannot be: interest is contractually
-- fixed in `loan_periods`, and recomputing it daily would be a different loan.
-- Each window's collections split that month's **own** principal and **own**
-- interest with integer division, the remainder landing on the final
-- collections of that same month. The remainder never crosses a month
-- boundary, so every contractual month reconciles independently to its own
-- obligation.
--
-- The allocation is the same rule as `divideEvenly(..., 'last')` in
-- `lib/domain/money.ts`:
--
--     part(i) = amount / count + (1 if i > count - amount % count else 0)
--
-- All integer `bigint` arithmetic. No floating point anywhere, and no `numeric`
-- division that could round.
-- ===========================================================================

create or replace function public.generate_loan_schedule(p_loan_id uuid)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_loan            public.loans;
  v_frequency       public.repayment_frequencies;
  v_timezone        text;
  v_start_date      date;
  v_final_boundary  date;
  v_total_days      integer;
  v_max_steps       integer;
  v_inserted        integer;
  v_orphan_period   smallint;
  v_scheduled_total bigint;
  v_mismatch        record;
begin
  -- Serialises concurrent generation for this loan. Without it, two
  -- transactions could each find no schedule and each proceed; the primary key
  -- on `loan_schedules.loan_id` would stop the second committing, but with a
  -- unique violation rather than the clean idempotent outcome below. The lock
  -- is transaction-scoped, so it is released on commit or rollback.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('loan_schedule:' || p_loan_id::text)
  );

  select * into v_loan from public.loans where id = p_loan_id for update;

  if not found then
    raise exception 'No such loan.' using errcode = 'P0001';
  end if;

  -- --- Idempotency --------------------------------------------------------
  -- A second call finds the schedule already there and returns it, inserting
  -- nothing and auditing nothing. Generation is a fact about the loan, not an
  -- action to repeat.
  if exists (select 1 from public.loan_schedules where loan_id = p_loan_id) then
    return p_loan_id;
  end if;

  -- Capability, when there is a session to check. NULL for the table owner,
  -- `service_role` and migrations — and for the trusted path this function is
  -- normally reached by, `disburse_loan`, which has already made the same
  -- check against the same capability.
  if auth.uid() is not null and not public.user_has_permission('loans:disburse') then
    raise exception 'Generating a repayment schedule requires the loans:disburse capability.'
      using errcode = 'P0001';
  end if;

  -- A schedule is the collection plan for money that has been released. There
  -- is no such plan for a loan that is still a draft, awaiting approval, or
  -- approved but not yet paid out — those get a clearly-labelled preview,
  -- never a persisted schedule.
  if v_loan.status <> 'active' then
    raise exception
      'A repayment schedule is generated when a loan is disbursed; this one is %.',
      v_loan.status
      using errcode = 'P0001';
  end if;

  if v_loan.disbursed_at is null then
    raise exception 'This loan has no disbursement timestamp to schedule from.'
      using errcode = 'P0001';
  end if;

  if not exists (select 1 from public.loan_periods where loan_id = p_loan_id) then
    raise exception
      'This loan has no contractual breakdown, so there is nothing to schedule.'
      using errcode = 'P0001';
  end if;

  -- --- The cadence --------------------------------------------------------
  -- Read from the frequency the loan agreed to, by key. Migration 000200 makes
  -- that row's `interval_days` immutable, so this cannot have been redefined
  -- since approval.
  select * into v_frequency
  from public.repayment_frequencies
  where key = v_loan.repayment_frequency;

  if not found then
    raise exception
      'The repayment frequency "%" on this loan no longer exists.',
      v_loan.repayment_frequency
      using errcode = 'P0001';
  end if;

  -- --- The anchor ---------------------------------------------------------
  -- The business timezone, read from settings rather than hard-coded, so the
  -- database and `lib/domain/datetime.ts` resolve the same zone from the same
  -- place.
  select cs.timezone into v_timezone from public.company_settings cs where cs.id = 1;

  -- Fail closed. Guessing a zone would put every due date a day out for the
  -- first three hours of each Kampala morning.
  if v_timezone is null or pg_catalog.btrim(v_timezone) = '' then
    raise exception
      'The business timezone is not configured, so collection dates cannot be determined.'
      using errcode = 'P0001';
  end if;

  -- The calendar date the disbursement fell on **in Kampala**. A disbursement
  -- stamped 22:30 UTC happened at 01:30 the next morning locally, and
  -- anchoring on the UTC date would shift the whole schedule back a day.
  v_start_date := (v_loan.disbursed_at at time zone v_timezone)::date;

  v_final_boundary :=
    (v_start_date + (v_loan.loan_term_months || ' months')::interval)::date;

  v_total_days := v_final_boundary - v_start_date;

  -- Floor division: the largest k with k × interval ≤ total days. A candidate
  -- landing exactly on the final boundary is excluded by the window join
  -- below, because the boundary belongs to the month that has not started.
  v_max_steps := v_total_days / v_frequency.interval_days;

  -- --- The header ---------------------------------------------------------
  -- Inserted first, so the cadence snapshot is on record before the rows that
  -- depend on it, and so the audit trigger on the installments can read it.
  insert into public.loan_schedules (
    loan_id, repayment_frequency, frequency_label, interval_days,
    disbursement_date, business_timezone, generator_version, generated_by
  )
  values (
    p_loan_id, v_frequency.key, v_frequency.label, v_frequency.interval_days,
    v_start_date, v_timezone, 1, public.current_profile_id()
  );

  -- --- The installments ---------------------------------------------------
  --
  -- One statement. Not a loop with an insert per collection: a three-month
  -- daily loan is 91 rows, and a per-row insert would fire the append-only and
  -- audit triggers 91 times and produce 91 audit entries for one event.
  insert into public.loan_installments (
    loan_id, loan_period_id, loan_period_number,
    installment_number, period_installment_number,
    due_date, scheduled_principal, scheduled_interest, expected_amount
  )
  with cadence as (
    -- Every candidate collection date: one interval after disbursement, then
    -- every interval after that.
    -- `generate_series(1, n)` yields nothing when n < 1, which is the right
    -- behaviour for an interval longer than the whole term: no candidate
    -- dates, and the zero-installment guard below refuses the schedule.
    select (v_start_date + (step * v_frequency.interval_days))::date as due_date
    from pg_catalog.generate_series(1, v_max_steps) as step
  ),
  windows as (
    -- Each contractual month's window, both boundaries anchored on the
    -- disbursement date.
    select
      lp.id                                                   as loan_period_id,
      lp.period_number,
      lp.principal_portion,
      lp.interest,
      (v_start_date + ((lp.period_number - 1) || ' months')::interval)::date as win_start,
      (v_start_date + (lp.period_number || ' months')::interval)::date       as win_end
    from public.loan_periods lp
    where lp.loan_id = p_loan_id
  ),
  assigned as (
    -- Each date to the one window containing it: at or after that month's
    -- start, strictly before the next month's.
    select
      w.loan_period_id,
      w.period_number,
      w.principal_portion,
      w.interest,
      c.due_date,
      pg_catalog.row_number() over (
        partition by w.period_number order by c.due_date
      )                                                        as period_position,
      pg_catalog.count(*) over (partition by w.period_number)  as period_count,
      pg_catalog.row_number() over (order by c.due_date)        as loan_position
    from windows w
    join cadence c
      on c.due_date >= w.win_start
     and c.due_date <  w.win_end
  )
  select
    p_loan_id,
    a.loan_period_id,
    a.period_number,
    a.loan_position::integer,
    a.period_position::integer,
    a.due_date,
    -- The allocation. Integer division, with the remainder on the final
    -- collections of this month — the same rule as divideEvenly(…, 'last').
    (a.principal_portion / a.period_count)
      + case
          when a.period_position > a.period_count - (a.principal_portion % a.period_count)
          then 1 else 0
        end,
    (a.interest / a.period_count)
      + case
          when a.period_position > a.period_count - (a.interest % a.period_count)
          then 1 else 0
        end,
    -- Stated as the sum of the two components, computed the same way, so the
    -- per-row CHECK constraint cannot be satisfied by a different arithmetic.
    (a.principal_portion / a.period_count)
      + case
          when a.period_position > a.period_count - (a.principal_portion % a.period_count)
          then 1 else 0
        end
    + (a.interest / a.period_count)
      + case
          when a.period_position > a.period_count - (a.interest % a.period_count)
          then 1 else 0
        end
  from assigned a;

  get diagnostics v_inserted = row_count;

  -- --- The zero-installment guard -----------------------------------------
  --
  -- A contractual month with nowhere to collect is unreachable at the
  -- frequencies the business offers — the shortest calendar month is 28 days
  -- and the longest interval offered is three. It becomes reachable the moment
  -- an administrator configures, say, a 40-day cadence, and the failure
  -- without this guard is an active loan carrying a month of obligation that
  -- no collection ever gathers.
  --
  -- Checked as a property of the result rather than predicted from the inputs,
  -- so it holds whatever the calendar does.
  select lp.period_number into v_orphan_period
  from public.loan_periods lp
  where lp.loan_id = p_loan_id
    and not exists (
      select 1 from public.loan_installments li
      where li.loan_period_id = lp.id
    )
  order by lp.period_number
  limit 1;

  if v_orphan_period is not null then
    raise exception
      'Contractual month % of this loan would receive no collection at an interval of % days. The repayment frequency "%" is too infrequent for this loan''s contractual months.',
      v_orphan_period, v_frequency.interval_days, v_frequency.key
      using errcode = 'P0001';
  end if;

  if v_inserted = 0 then
    raise exception 'The repayment schedule generated no collections.'
      using errcode = 'P0001';
  end if;

  -- --- Reconciliation, asserted rather than assumed -----------------------
  --
  -- The allocation above is exact by construction, but "by construction" is an
  -- argument and this is money. These run inside the same transaction, so a
  -- failure rolls back the schedule, the activation and the audit entries
  -- together: a loan whose schedule does not reconcile is not disbursed.

  -- Every contractual month, independently. This is the stronger check: a loan
  -- total can balance while two months are wrong in opposite directions.
  select lp.period_number,
         lp.principal_portion, pg_catalog.sum(li.scheduled_principal) as got_principal,
         lp.interest,          pg_catalog.sum(li.scheduled_interest)  as got_interest,
         lp.total_obligation,  pg_catalog.sum(li.expected_amount)     as got_total
    into v_mismatch
  from public.loan_periods lp
  join public.loan_installments li on li.loan_period_id = lp.id
  where lp.loan_id = p_loan_id
  group by lp.period_number, lp.principal_portion, lp.interest, lp.total_obligation
  having pg_catalog.sum(li.scheduled_principal) <> lp.principal_portion
      or pg_catalog.sum(li.scheduled_interest)  <> lp.interest
      or pg_catalog.sum(li.expected_amount)     <> lp.total_obligation
  limit 1;

  if v_mismatch is not null then
    raise exception
      'Schedule reconciliation failed for contractual month %: allocated principal % against %, interest % against %, total % against %.',
      v_mismatch.period_number,
      v_mismatch.got_principal, v_mismatch.principal_portion,
      v_mismatch.got_interest,  v_mismatch.interest,
      v_mismatch.got_total,     v_mismatch.total_obligation
      using errcode = 'P0001';
  end if;

  -- And the loan as a whole against its contractual total.
  select pg_catalog.sum(expected_amount) into v_scheduled_total
  from public.loan_installments
  where loan_id = p_loan_id;

  if v_scheduled_total is distinct from v_loan.total_expected_repayment then
    raise exception
      'Schedule reconciliation failed: the schedule collects % against a contractual total of %.',
      v_scheduled_total, v_loan.total_expected_repayment
      using errcode = 'P0001';
  end if;

  return p_loan_id;
end;
$$;

comment on function public.generate_loan_schedule(uuid) is
  'Generates the collection schedule for a disbursed loan from loans.disbursed_at, the contractual breakdown and the agreed cadence. Idempotent, reconciled before it returns, and accepts no figures from its caller.';

-- ---------------------------------------------------------------------------
-- Not callable by an application role.
--
-- No `grant execute` to `authenticated`. The only legitimate caller is
-- `disburse_loan`, which is SECURITY DEFINER and therefore runs as the table
-- owner. So there is no direct path for a session to generate a schedule at
-- all — not a narrow one guarded by a capability check, none.
--
-- That is deliberately stronger than the Phase 4 lifecycle functions, which
-- are granted to `authenticated` because a person performs those acts. Nobody
-- performs schedule generation: it is a consequence of disbursement.
-- ---------------------------------------------------------------------------

revoke all on function public.generate_loan_schedule(uuid) from public, anon, authenticated;

-- ===========================================================================
-- Disbursement, extended
--
-- ## Why this replaces the Phase 4 function rather than adding a step
--
-- The specification is explicit that disbursement must succeed only if the
-- full schedule is generated, and that there must be no such thing as an
-- active loan without a schedule, a partial schedule, or a schedule for a
-- failed disbursement.
--
-- A separate call — disburse, then generate — cannot give that. Any gap
-- between the two is a window in which the loan is active and uncollectable,
-- and a crash in that window leaves it that way permanently. So generation
-- happens inside the same function and therefore the same transaction: either
-- the loan is active with a complete, reconciled schedule, or nothing
-- happened.
--
-- ## What is preserved exactly
--
-- Every Phase 4 check, in its original order and wording:
--
--   * the loan must be `approved` — which is what refuses a second
--     disbursement, since the first moved it to `active`;
--   * the caller must hold `loans:disburse`;
--   * client eligibility is revalidated, so a client blacklisted between
--     approval and disbursement receives nothing;
--   * the contractual breakdown and the client snapshot must exist;
--   * `disbursed_at` / `disbursed_by` are stamped by the transition trigger,
--     never supplied;
--   * the one-active-loan limit is enforced by the trigger on the same
--     statement, under its advisory lock.
--
-- The only addition is the generation call, after the UPDATE because it needs
-- the `disbursed_at` the trigger has just stamped.
-- ===========================================================================

create or replace function public.disburse_loan(p_loan_id uuid)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_loan   public.loans;
  v_client public.clients;
begin
  select * into v_loan from public.loans where id = p_loan_id for update;

  if not found then
    raise exception 'No such loan.' using errcode = 'P0001';
  end if;

  -- A second tap finds the loan already active and is refused cleanly, rather
  -- than disbursing twice.
  if v_loan.status <> 'approved' then
    raise exception
      'Only an approved loan can be disbursed; this one is %.', v_loan.status
      using errcode = 'P0001';
  end if;

  if auth.uid() is not null and not public.user_has_permission('loans:disburse') then
    raise exception 'Disbursing a loan requires the loans:disburse capability.'
      using errcode = 'P0001';
  end if;

  -- Eligibility again. A client blacklisted between approval and disbursement
  -- must not receive money.
  select * into v_client from public.clients where id = v_loan.client_id;

  if v_client.status <> 'active' then
    raise exception
      'This client is % and cannot receive a disbursement.', v_client.status
      using errcode = 'P0001';
  end if;

  -- The breakdown must exist before money moves. If it does not, approval was
  -- incomplete and disbursing would create an active loan nobody can collect.
  if not exists (select 1 from public.loan_periods where loan_id = p_loan_id) then
    raise exception 'This loan has no contractual breakdown and cannot be disbursed.'
      using errcode = 'P0001';
  end if;

  if not exists (select 1 from public.loan_client_snapshots where loan_id = p_loan_id) then
    raise exception 'This loan has no client snapshot and cannot be disbursed.'
      using errcode = 'P0001';
  end if;

  -- `disbursed_at` and `disbursed_by` are stamped by the transition trigger,
  -- and the active-limit trigger fires on this same statement.
  update public.loans set status = 'active' where id = p_loan_id;

  -- --- Phase 5: the collection plan, in this same transaction -------------
  --
  -- After the UPDATE, because the schedule is anchored on the `disbursed_at`
  -- the trigger has just stamped — the moment the borrower actually received
  -- the money, not the date somebody proposed earlier.
  --
  -- If this raises for any reason — a cadence too infrequent for the
  -- contractual months, a reconciliation failure, a missing timezone — the
  -- exception propagates and the whole transaction rolls back: the loan stays
  -- `approved`, no installment survives, and the `loan.disbursed` audit entry
  -- the UPDATE produced is rolled back with it. There is no partial outcome
  -- and no misleading success in the trail.
  perform public.generate_loan_schedule(p_loan_id);

  return p_loan_id;
end;
$$;

comment on function public.disburse_loan(uuid) is
  'Activates an approved loan and generates its collection schedule in one transaction. Re-checks client eligibility and the presence of the breakdown and snapshots; the active-loan limit is enforced by the trigger on loans. A schedule failure rolls the disbursement back.';

revoke all on function public.disburse_loan(uuid) from public, anon, authenticated;
grant execute on function public.disburse_loan(uuid) to authenticated;
