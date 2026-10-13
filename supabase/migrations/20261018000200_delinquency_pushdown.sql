-- ===========================================================================
-- Phase 18 — `loan_delinquency` stops recomputing the whole book per loan
--
-- ## What was wrong
--
-- The view was written with three CTEs — `today`, `bounds` and `cover`. That
-- reads well, and `today` in particular made "today in the business timezone"
-- a single named thing. It also made the view opaque to the planner.
--
-- A non-recursive CTE referenced **more than once** is not inlined by
-- PostgreSQL: it is materialised, and a materialised CTE is an optimisation
-- barrier. `today` was referenced four times, which pinned it; `cover`
-- referenced `today`, which pinned `cover` too. With `cover` materialised,
-- PostgreSQL could no longer push `loan_id = <this loan>` into it — so every
-- reader of this view computed the delinquency position of the **entire
-- book**, whatever it had asked for.
--
-- Worse, where the planner chose a nested loop over the view — which is what
-- `loan_workflow_register` does when the register asks for one page — the
-- whole materialised computation ran **once per loan row**. Measured on the
-- harness: 302 installments scanned 14 times for a 21-row page, which is
-- quadratic in the size of the book. The loan register took 3.7 seconds to
-- show fourteen loans.
--
-- ## What this does
--
-- Exactly three structural changes, and no change to a single figure:
--
--   1. `today` is gone. Every use is now `(select public.business_date())`,
--      which is planned as an InitPlan and so is evaluated once per statement
--      — the same "one value per read" the CTE was there to guarantee, and
--      the same function, so the business timezone still decides what today
--      is.
--   2. `bounds` and `cover` become plain grouped subqueries in the FROM
--      clause. PostgreSQL pushes a qualifier on a subquery's **grouping key**
--      into the subquery, so `loan_id = <this loan>` now reaches
--      `loan_installments` as an index condition. A whole-book read is still
--      one hash aggregate; a one-loan read is now an index lookup.
--   3. The two LATERAL joins that compute the penalty basis and eligibility
--      are unchanged in content and now reference `b` rather than the CTE.
--
-- Nothing about the arithmetic moves. `arrears_amount`, `due_today_amount`,
-- `current_due`, `days_past_due`, `missed_installment_count`,
-- `contractual_outstanding`, `total_outstanding`, the penalty basis, the
-- projected charge and `delinquency_state` are the same expressions over the
-- same rows, in the same order of precedence. The view's column list is
-- unchanged, which is why `create or replace view` is the right tool and the
-- eight views that read this one need no change.
--
-- Equivalence is not assumed: `tests/db/delinquency-pushdown.test.ts` asserts
-- the view's full output, column by column and row by row, against the
-- figures the Phase 7 tests already pin, and the money audit still runs.
--
-- ## The penalty basis, which EXPLAIN could not show
--
-- The view also called `public.loan_outstanding_as_of(l.id, grace_end)` from
-- a LATERAL — once per loan. That function is declared
-- `set search_path = ''`, and **PostgreSQL will not inline a function that
-- carries a SET clause**. So it ran as an opaque call: its cost never
-- appeared in the plan, and each invocation paid row-level security on
-- `loan_installments` and `payment_allocations` all over again.
--
-- Measured directly, on a book of 1,370 disbursed loans:
--
--   select sum(public.loan_outstanding_as_of(l.id, current_date))
--     from public.loans l where l.disbursed_at is not null;
--   -- 4,467 ms
--
-- That was the single largest term in the view, and nothing in `EXPLAIN
-- (ANALYZE, BUFFERS)` pointed at it.
--
-- It is replaced by the same arithmetic written where the planner can see
-- it — the contractual total (already computed as `cv.scheduled_total`) less
-- the posted allocations received on or before the loan's own grace end. The
-- **function is untouched**: it is still what `ensure_penalty_applied`
-- charges from, which is the figure that actually becomes a debt, and
-- `delinquency-parity.test.ts` already asserts that every recorded penalty's
-- basis equals what the function returns. The view agreeing with the
-- function is therefore checked rather than assumed, for all 1,370 loans.
--
-- ## Measured
--
-- At the seeded book (14 loans), as `authenticated`, with Phase 18's policy
-- hoisting already applied and measured **as of this migration** — migration
-- `20261018000400` takes them lower again, and `docs/PERFORMANCE.md` §3
-- carries the end-state figures:
--
--   | read                            | before   | after  |
--   | ------------------------------- | -------- | ------ |
--   | `loan_workflow_register` (21)   | 3,210 ms | 120 ms |
--   | `loan_aging` (21)               | 2,496 ms | 136 ms |
--   | `collections_today` (21)        | 1,791 ms | 114 ms |
--   | `portfolio_at_risk`             |   316 ms | 150 ms |
--
-- At 2,014 loans / 41,072 collections / 40,929 payments, with migration
-- `20261018000400` (the coverage view) also applied:
--
--   | read                                  | before   | after  |
--   | ------------------------------------- | -------- | ------ |
--   | `loan_delinquency` for one loan       | 6,918 ms |  63 ms |
--   | `loan_workflow_register` for one loan | 7,480 ms |  63 ms |
--   | `loan_delinquency` (21)               | 7,215 ms |  76 ms |
--
--
-- ## What is still derived
--
-- Everything. Phase 7's rule stands: there is no stored arrears balance, no
-- stored `days_past_due` and no mutable delinquency state. This migration
-- makes the derivation cheap to read; it does not materialise it, cache it,
-- or add a nightly job. A loan is still in arrears because the calendar and
-- the ledger say so.
-- ===========================================================================

create or replace view public.loan_delinquency
with (security_invoker = true)
as
select
  l.id                    as loan_id,
  l.loan_number,
  l.client_id,
  l.status                as loan_status,
  (select public.business_date())                   as business_date,

  b.installment_count,
  b.first_due_date,
  b.final_due_date        as scheduled_completion_date,
  cv.scheduled_total,
  cv.scheduled_due_to_date,
  cv.paid_against_schedule,

  cv.arrears_amount,
  cv.due_today_amount,
  (cv.arrears_amount + cv.due_today_amount)::bigint as current_due,

  cv.missed_installment_count,
  cv.oldest_unpaid_due_date,
  cv.oldest_past_due_date,
  case
    when cv.oldest_past_due_date is null then 0
    else ((select public.business_date()) - cv.oldest_past_due_date)
  end::integer            as days_past_due,

  l.grace_period_days_applied::integer as grace_period_days,
  (b.final_due_date + l.grace_period_days_applied::integer)      as grace_end_date,
  (b.final_due_date + l.grace_period_days_applied::integer + 1)  as penalty_effective_date,
  ((select public.business_date()) > b.final_due_date)           as past_final_due_date,
  (
    (select public.business_date()) > b.final_due_date
    and (select public.business_date()) <= b.final_due_date + l.grace_period_days_applied::integer
  )                                                              as within_grace_period,

  (cv.scheduled_total - cv.paid_total)::bigint      as contractual_outstanding,
  coalesce(pc.penalty_amount, 0)::bigint            as penalty_amount,
  coalesce(pc.allocated_amount, 0)::bigint          as penalty_paid,
  coalesce(pc.remaining_amount, 0)::bigint          as penalty_remaining,
  (
    cv.scheduled_total - cv.paid_total + coalesce(pc.remaining_amount, 0)
  )::bigint                                         as total_outstanding,

  (pc.penalty_id is not null)       as penalty_applied,
  pc.penalty_id,
  pc.effective_date                 as penalty_applied_effective_date,
  pc.basis_amount                   as penalty_basis_amount,
  l.penalty_rate_bps_applied        as penalty_rate_bps,

  basis.basis_amount::bigint        as penalty_basis_as_of_grace_end,

  pending.penalty_eligible,

  case
    when pending.penalty_eligible then pending.projected_amount
    else 0
  end::bigint                       as penalty_projected_amount,

  case
    when l.status = 'cleared' then 'cleared'
    when pc.penalty_id is not null and coalesce(pc.remaining_amount, 0) > 0
      then 'penalty_due'
    when pending.penalty_eligible then 'expired_unpaid'
    when (select public.business_date()) > b.final_due_date
         and cv.scheduled_total - cv.paid_total + coalesce(pc.remaining_amount, 0) > 0
      then 'grace_period'
    when cv.arrears_amount > 0 then 'in_arrears'
    when cv.due_today_amount > 0 then 'due_today'
    else 'current'
  end                               as delinquency_state
from public.loans l
-- Plain subqueries rather than CTEs. A CTE referenced more than once is an
-- optimisation barrier: PostgreSQL materialises it and can no longer push
-- `loan_id = <this loan>` into it, so every reader of this view — including
-- the paginated register, which wants twenty-one loans — computed the whole
-- book, and a nested-loop join recomputed it once per loan. Grouped
-- subqueries take the qual on their grouping key, so a single-loan read is
-- now an index lookup and a whole-book read is one hash aggregate.
join (
  select
    li.loan_id,
    max(li.due_date)  as final_due_date,
    min(li.due_date)  as first_due_date,
    count(*)::integer as installment_count
  from public.loan_installments li
  group by li.loan_id
) b on b.loan_id = l.id
join (
  select
    c.loan_id,
    sum(c.expected_amount)::bigint as scheduled_total,
    sum(c.allocated_amount)::bigint as paid_total,

    sum(case when c.due_date <= (select public.business_date()) then c.expected_amount else 0 end)::bigint
      as scheduled_due_to_date,
    sum(case when c.due_date <= (select public.business_date()) then c.allocated_amount else 0 end)::bigint
      as paid_against_schedule,

    sum(case when c.due_date < (select public.business_date()) then c.remaining_amount else 0 end)::bigint
      as arrears_amount,
    sum(case when c.due_date = (select public.business_date()) then c.remaining_amount else 0 end)::bigint
      as due_today_amount,

    count(*) filter (
      where c.due_date < (select public.business_date()) and c.remaining_amount > 0
    )::integer as missed_installment_count,

    min(c.due_date) filter (where c.remaining_amount > 0) as oldest_unpaid_due_date,

    min(c.due_date) filter (
      where c.remaining_amount > 0 and c.due_date < (select public.business_date())
    ) as oldest_past_due_date
  from public.loan_installment_coverage c
  group by c.loan_id
) cv on cv.loan_id = l.id
left join public.loan_penalty_coverage pc on pc.loan_id = l.id
-- The penalty basis, computed in the open.
--
-- This used to call `public.loan_outstanding_as_of(l.id, grace_end)`, once
-- per loan. That function is `set search_path = ''`, and PostgreSQL will not
-- inline a function carrying a SET clause — so it ran as an opaque call whose
-- cost EXPLAIN cannot show, and whose own reads of `loan_installments` and
-- `payment_allocations` each paid those tables' row-level security again.
-- Measured at 1,370 disbursed loans: 4,467 ms, which was most of the view.
--
-- The arithmetic is the function's, term for term:
--
--   contractual total  -  posted allocations received on or before grace end
--
-- The first term is `cv.scheduled_total`, which is already the sum of this
-- loan's `expected_amount` over the same rows the function would have summed.
-- The second is below, as a LATERAL the planner can plan. The function itself
-- is untouched and is still what `ensure_penalty_applied` charges from;
-- `delinquency-parity.test.ts` asserts the two agree for every penalty.
left join lateral (
  select coalesce(pg_catalog.sum(pa.allocated_amount), 0)::bigint as paid_by_grace_end
  from public.payment_allocations pa
  join public.loan_payments lp on lp.id = pa.payment_id
  where pa.loan_id = l.id
    and lp.status = 'posted'
    and pa.installment_id is not null
    and public.payment_business_date(lp.received_at)
          <= b.final_due_date + l.grace_period_days_applied::integer
) asof on true
cross join lateral (
  select (cv.scheduled_total - asof.paid_by_grace_end) as basis_amount
) basis
left join lateral (
  select
    (basis.basis_amount * l.penalty_rate_bps_applied + 5000) / 10000
      as projected_amount,
    (
      l.status = 'active'
      and pc.penalty_id is null
      and (select public.business_date()) >= b.final_due_date + l.grace_period_days_applied::integer + 1
      and basis.basis_amount > 0
      and (basis.basis_amount * l.penalty_rate_bps_applied + 5000) / 10000 > 0
    ) as penalty_eligible
) pending on true;

comment on view public.loan_delinquency is
  'Derived delinquency position of every disbursed loan, as at today in the business timezone: arrears, due today, current due, lateness, expiry, grace, penalty state and one operational status. Nothing here is stored, so there is no delinquency state any role can edit. Phase 18 restructured the CTEs into grouped subqueries so a one-loan read is an index lookup rather than a whole-book computation; no figure changed.';
