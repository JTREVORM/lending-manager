-- ===========================================================================
-- Polytos Phase 3.3 — the generator learns a second cadence kind
--
-- ## The contract this migration must not break
--
-- Every schedule already in the database was built by the `fixed_days` arm,
-- and `scripts/verify-membership-upgrade.mjs` compares every collection date
-- and every scheduled figure, loan by loan, across these migrations. So the
-- fixed-day arm below is the 20261005000400 body **character for character**,
-- moved inside an `if` and nothing else. Not re-derived, not tidied, not
-- re-indented in a way that could hide an edit: copied. `tests/db/schedule-parity.test.ts`
-- regenerates several hundred schedules through both implementations and
-- asserts they are identical, and the upgrade check proves the stored ones
-- did not move.
--
-- ## The calendar arm, and why it needs no window assignment
--
-- The fixed-day arm builds one global rhythm of candidate dates and *assigns*
-- each to the contractual month whose window `[D+(n-1)m, D+n m)` contains it.
-- That is what makes a daily cadence land 28 collections in February and 31
-- in March without anything having to say so.
--
-- A calendar cadence cannot use that machinery, and the reason is worth
-- stating because the first attempt at this looked like it could. The natural
-- monthly collection date for contractual month *n* is `D + n months` — which
-- is precisely the **exclusive end** of month *n*'s window, and therefore
-- inside month *n+1*'s. Running monthly dates through the window join would
-- put month 1's collection in month 2, leave month 1 with nothing, and fire
-- the orphan-period guard on every monthly loan ever written.
--
-- So the calendar arm does not assign: it *constructs* one collection per
-- contractual month, due at the end of that month, carrying that month's own
-- principal and that month's own interest in full. There is no division and
-- therefore no remainder, which makes the reconciliation below exact by
-- construction — and it is still asserted, because "by construction" is an
-- argument and this is money.
--
-- One collection per contractual month is also what the business described:
-- the membership documents say monthly collection for member loans longer
-- than two months, and a five-month loan collecting monthly is five
-- collections.
--
-- ## The anchor, resolved in one place
--
-- `month_anchor` on the cadence decides what `D + n months` means when the
-- target month has no day numbered like D's:
--
--   `clamp_to_month_end`          PostgreSQL's own `date + interval 'n months'`,
--                                 which clamps to the last day of the target
--                                 month. 31 Jan + 1 month = 28 Feb; and
--                                 because the step is always from D rather
--                                 than from the previous date, 31 Jan +
--                                 2 months = 31 Mar and not 28 Mar.
--
--   `roll_forward_to_next_month`  The first day of the month after the target,
--                                 when the target has no such day. 31 Jan +
--                                 1 month = 1 Mar, + 2 months = 31 Mar,
--                                 + 3 months = 1 May.
--
-- Both arms are implemented and neither is a default. A calendar cadence with
-- no anchor raises, naming the decision that is missing, because a collection
-- date nobody has agreed is worse than a loan that cannot yet be disbursed.
--
-- The resolution is a function rather than inline SQL so that the TypeScript
-- preview, the database generator and the tests all describe the same rule
-- once, and so a test can assert the rule directly across a leap year without
-- building a loan to do it.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- The anchor rule, as a function
-- ---------------------------------------------------------------------------

create or replace function public.monthly_collection_date(
  p_anchor_date date,
  p_months integer,
  p_month_anchor text
)
returns date
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_clamped date;
begin
  if p_anchor_date is null or p_months is null then
    return null;
  end if;

  if p_months < 1 then
    raise exception
      'A monthly collection step must be at least one month; received %.', p_months
      using errcode = 'P0001';
  end if;

  if p_month_anchor is null then
    raise exception
      'The monthly collection anchor has not been decided, so a calendar-monthly collection date cannot be determined. Set repayment_frequencies.month_anchor for the calendar cadence first.'
      using errcode = 'P0001';
  end if;

  -- PostgreSQL clamps, and anchors on the original date rather than stepping,
  -- so this is correct for `clamp_to_month_end` as it stands.
  v_clamped := (p_anchor_date + (p_months || ' months')::interval)::date;

  if p_month_anchor = 'clamp_to_month_end' then
    return v_clamped;
  end if;

  if p_month_anchor = 'roll_forward_to_next_month' then
    -- The clamp fired exactly when the target month is shorter than the
    -- anchor's day of the month, which is visible as the day of the month
    -- having changed. Nothing else can change it: PostgreSQL preserves the
    -- day when the target month has one.
    if pg_catalog.date_part('day', v_clamped)
       = pg_catalog.date_part('day', p_anchor_date) then
      return v_clamped;
    end if;

    -- The first day of the month after the one the clamp landed in. Derived
    -- from the clamped date rather than from the anchor, so a run of short
    -- months cannot be got wrong by arithmetic on the original day.
    --
    -- `date + interval` already yields a point in time, so `date_trunc` takes
    -- it without a cast — and the month is truncated *after* the step rather
    -- than before, which is one operation instead of two.
    return (pg_catalog.date_trunc('month', v_clamped + interval '1 month'))::date;
  end if;

  raise exception 'There is no monthly collection anchor called %.', p_month_anchor
    using errcode = 'P0001';
end;
$$;

comment on function public.monthly_collection_date(date, integer, text) is
  'Polytos Phase 3. The calendar-monthly collection date n months after an anchor date, resolved by the agreed convention for a month that has no such day. Raises when the convention has not been decided, because a guessed collection date is worse than no schedule.';

revoke all on function public.monthly_collection_date(date, integer, text)
  from public, anon, authenticated;
grant execute on function public.monthly_collection_date(date, integer, text)
  to authenticated;

-- ===========================================================================
-- The generator
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
  v_out_of_order    integer;
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('loan_schedule:' || p_loan_id::text)
  );

  select * into v_loan from public.loans where id = p_loan_id for update;

  if not found then
    raise exception 'No such loan.' using errcode = 'P0001';
  end if;

  -- --- Idempotency --------------------------------------------------------
  if exists (select 1 from public.loan_schedules where loan_id = p_loan_id) then
    return p_loan_id;
  end if;

  if auth.uid() is not null and not public.user_has_permission('loans:disburse') then
    raise exception 'Generating a repayment schedule requires the loans:disburse capability.'
      using errcode = 'P0001';
  end if;

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
  select * into v_frequency
  from public.repayment_frequencies
  where key = v_loan.repayment_frequency;

  if not found then
    raise exception
      'The repayment frequency "%" on this loan no longer exists.',
      v_loan.repayment_frequency
      using errcode = 'P0001';
  end if;

  -- Polytos Phase 3. Fail shut, and name the decision. A calendar cadence
  -- whose convention nobody has settled cannot produce a collection date, and
  -- inventing one here would put a date on a borrower's agreement that no
  -- person chose. The loan stays approved and undisbursed, which is
  -- recoverable; a wrong collection sheet is not.
  if v_frequency.cadence_kind = 'calendar_month' and v_frequency.month_anchor is null then
    raise exception
      'The cadence "%" collects monthly, but the convention for a month that has no such day has not been decided. Set repayment_frequencies.month_anchor before disbursing a monthly loan.',
      v_frequency.key
      using errcode = 'P0001';
  end if;

  -- --- The anchor ---------------------------------------------------------
  select cs.timezone into v_timezone from public.company_settings cs where cs.id = 1;

  if v_timezone is null or pg_catalog.btrim(v_timezone) = '' then
    raise exception
      'The business timezone is not configured, so collection dates cannot be determined.'
      using errcode = 'P0001';
  end if;

  v_start_date := (v_loan.disbursed_at at time zone v_timezone)::date;

  -- --- The header ---------------------------------------------------------
  insert into public.loan_schedules (
    loan_id, repayment_frequency, frequency_label, interval_days,
    cadence_kind, month_anchor,
    disbursement_date, business_timezone, generator_version, generated_by
  )
  values (
    p_loan_id, v_frequency.key, v_frequency.label, v_frequency.interval_days,
    v_frequency.cadence_kind, v_frequency.month_anchor,
    v_start_date, v_timezone,
    -- The generator version says which **rules** produced a schedule, and the
    -- fixed-day rules did not change: the arm below is the 20261005000400 body
    -- character for character, so a daily schedule generated today is version
    -- 1 exactly as every stored one is. Bumping it would claim the allocation
    -- or the boundaries had moved, and a reader comparing an old schedule with
    -- a new identical one would find a difference that is not there.
    --
    -- The calendar arm is a genuinely new rule set, so it is version 2. What
    -- *kind* of cadence a schedule used is said by `cadence_kind`; the version
    -- says how its rules worked.
    case v_frequency.cadence_kind when 'calendar_month' then 2 else 1 end,
    public.current_profile_id()
  );

  if v_frequency.cadence_kind = 'fixed_days' then
    -- =====================================================================
    -- The fixed-day arm. The 20261005000400 body, unchanged.
    --
    -- Period windows `[D + (n-1) months, D + n months)`, both boundaries
    -- anchored on D. One global cadence `D + k × interval_days`, each date
    -- assigned to the one window containing it. Each window's collections
    -- split that month's own principal and own interest with integer
    -- division, the remainder on that month's final collections.
    -- =====================================================================
    v_final_boundary :=
      (v_start_date + (v_loan.loan_term_months || ' months')::interval)::date;

    v_total_days := v_final_boundary - v_start_date;

    v_max_steps := v_total_days / v_frequency.interval_days;

    insert into public.loan_installments (
      loan_id, loan_period_id, loan_period_number,
      installment_number, period_installment_number,
      due_date, scheduled_principal, scheduled_interest, expected_amount
    )
    with cadence as (
      select (v_start_date + (step * v_frequency.interval_days))::date as due_date
      from pg_catalog.generate_series(1, v_max_steps) as step
    ),
    windows as (
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
  else
    -- =====================================================================
    -- The calendar-month arm.
    --
    -- One collection per contractual month, due at that month's end, carrying
    -- that month's whole obligation. No division, so no remainder, so nothing
    -- can be lost or gained between the contract and the collection plan.
    -- =====================================================================
    insert into public.loan_installments (
      loan_id, loan_period_id, loan_period_number,
      installment_number, period_installment_number,
      due_date, scheduled_principal, scheduled_interest, expected_amount
    )
    select
      p_loan_id,
      lp.id,
      lp.period_number,
      lp.period_number::integer,
      1,
      public.monthly_collection_date(
        v_start_date, lp.period_number::integer, v_frequency.month_anchor
      ),
      lp.principal_portion,
      lp.interest,
      lp.total_obligation
    from public.loan_periods lp
    where lp.loan_id = p_loan_id;

    get diagnostics v_inserted = row_count;

    -- Strictly increasing, asserted rather than reasoned about. Both anchor
    -- conventions are monotonic — a roll-forward lands on the 1st of a month
    -- the next collection falls later in — but a collection sheet that went
    -- backwards would be a contractual defect, and the cost of checking is
    -- one indexed scan of at most 120 rows.
    select pg_catalog.count(*)::integer into v_out_of_order
    from (
      select li.due_date,
             pg_catalog.lag(li.due_date) over (order by li.installment_number) as previous
      from public.loan_installments li
      where li.loan_id = p_loan_id
    ) ordered
    where ordered.previous is not null and ordered.due_date <= ordered.previous;

    if v_out_of_order > 0 then
      raise exception
        'The monthly collection dates for this loan are not strictly increasing under the "%" anchor; % collection(s) fall on or before the one before them.',
        v_frequency.month_anchor, v_out_of_order
        using errcode = 'P0001';
    end if;
  end if;

  -- --- The zero-installment guard -----------------------------------------
  -- Unchanged, and it now covers both arms: the calendar arm builds one
  -- collection per period by construction, so this can only fire there if a
  -- period row vanished mid-transaction, and checking a property of the
  -- result rather than predicting it from the inputs is exactly why it holds
  -- for a cadence kind it was not written against.
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
      'Contractual month % of this loan would receive no collection at the "%" cadence. The repayment frequency is too infrequent for this loan''s contractual months.',
      v_orphan_period, v_frequency.key
      using errcode = 'P0001';
  end if;

  if v_inserted = 0 then
    raise exception 'The repayment schedule generated no collections.'
      using errcode = 'P0001';
  end if;

  -- --- Reconciliation, asserted rather than assumed -----------------------
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
  'Generates the collection schedule for a disbursed loan from loans.disbursed_at, the contractual breakdown and the agreed cadence. Two arms: fixed_days steps a number of days and allocates each month''s figures across the collections inside it; calendar_month collects each contractual month''s whole obligation at that month''s end, resolved by the agreed anchor. Idempotent, reconciled before it returns, and accepts no figures from its caller.';

revoke all on function public.generate_loan_schedule(uuid) from public, anon, authenticated;
