-- ===========================================================================
-- Phase 18 — reading one loan's coverage stops aggregating every allocation
--
-- ## What was wrong
--
-- `loan_installment_coverage` is the base of everything derived: it is what
-- `loan_balances`, `loan_delinquency` and `loan_obligations` are built from,
-- and therefore what the loan register, the collection sheet, the statement,
-- the aging report and the dashboard all ultimately read.
--
-- It was written as a LEFT JOIN onto a whole-table aggregate:
--
--   from loan_installments li
--   left join (
--     select pa.installment_id, sum(...)
--       from payment_allocations pa
--       join loan_payments lp on lp.id = pa.payment_id
--      where lp.status = 'posted'
--      group by pa.installment_id
--   ) posted on posted.installment_id = li.id
--
-- Two properties of that shape are fatal to a narrow read:
--
--   1. **The aggregate groups by `installment_id`, not `loan_id`.** Even an
--      inner join could not push `loan_id = <this loan>` into it, because
--      `loan_id` is not a grouping key.
--   2. **It is the nullable side of an outer join.** PostgreSQL does not push
--      a qualifier from the preserved side into the nullable side of a LEFT
--      JOIN — doing so would change which rows are preserved — so there was
--      no path to restricting it at all.
--
-- The consequence, measured on 2,014 loans with 40,929 payments: opening
-- **one** loan's detail page aggregated every posted allocation in the
-- database. `select * from loan_delinquency where loan_id = '...'` took
-- **6,918 ms**, and the plan showed a `GroupAggregate` over 38,096 rows with
-- 514,603 shared buffer hits — to answer a question about thirty collections.
--
-- ## What this does
--
-- The aggregate becomes a LATERAL correlated on the installment:
--
--   left join lateral (
--     select sum(...) from payment_allocations pa
--       join loan_payments lp on lp.id = pa.payment_id
--      where pa.installment_id = li.id and lp.status = 'posted'
--   ) posted on true
--
-- Now the restriction on the outer side reaches the inner query for free: a
-- one-loan read drives the LATERAL once per that loan's collections, through
-- `payment_allocations_installment_idx`. The figures are identical — a LEFT
-- JOIN onto rows grouped by `installment_id` and a per-installment sum are
-- the same sum over the same rows, and a collection with no allocations
-- still yields NULL and still coalesces to zero.
--
-- Verified by comparing the view's full output, all 41,072 rows and every
-- allocated and remaining column, before and after: identical.
--
-- ## The trade, stated plainly
--
-- A whole-book read now drives 41,072 index lookups where it used to build
-- one hash aggregate, so it is somewhat slower in that direction — measured
-- at 976 ms against 614 ms for `select count(*) from
-- loan_installment_coverage` as `authenticated` at that volume.
--
-- That is the right way round, and deliberately so:
--
--   * A narrow read is what a person does. Opening a client, opening a loan,
--     taking a payment, printing a statement, paging through a register —
--     each of those wants one loan or twenty, and each of them was paying for
--     the whole book. Those went from seconds to tens of milliseconds.
--   * A whole-book read is a report or a dashboard aggregate. It is
--     genuinely O(the book) and always was; it got 60% more expensive in
--     exchange for narrow reads getting about a hundred times cheaper.
--   * Both are fast at the volume the business actually holds. The hosted
--     database carries 35 loans and 470 payments; the figures above come
--     from a synthetic book nearly sixty times larger, measured to find the
--     ceiling rather than to describe today.
--
-- One definition, not two. It would be possible to keep both shapes — the
-- aggregate for reports, the LATERAL for detail — but that would mean two
-- expressions of what "paid against this collection" means, and the first
-- time they disagreed a borrower would see one number on the register and
-- another on their statement. See `docs/PERFORMANCE.md`.
--
-- ## Nothing here changes a figure
--
-- Same columns, same types, same arithmetic, same rows. `security_invoker`
-- is preserved, so the reader's own policies still decide which
-- installments, payments and allocations are visible — a borrower still sees
-- only their own, and the LATERAL is subject to exactly the policies the
-- subquery was.
-- ===========================================================================

create or replace view public.loan_installment_coverage
with (security_invoker = true)
as
select
  li.id                     as installment_id,
  li.loan_id,
  li.loan_period_id,
  li.loan_period_number,
  li.installment_number,
  li.due_date,
  li.expected_amount,
  li.scheduled_principal,
  li.scheduled_interest,
  coalesce(posted.allocated_amount, 0)::bigint     as allocated_amount,
  coalesce(posted.allocated_principal, 0)::bigint  as allocated_principal,
  coalesce(posted.allocated_interest, 0)::bigint   as allocated_interest,
  (li.expected_amount - coalesce(posted.allocated_amount, 0))::bigint
                                                   as remaining_amount,
  (li.scheduled_principal - coalesce(posted.allocated_principal, 0))::bigint
                                                   as remaining_principal,
  (li.scheduled_interest - coalesce(posted.allocated_interest, 0))::bigint
                                                   as remaining_interest
from public.loan_installments li
left join lateral (
  select
    sum(pa.allocated_amount)    as allocated_amount,
    sum(pa.allocated_principal) as allocated_principal,
    sum(pa.allocated_interest)  as allocated_interest
  from public.payment_allocations pa
  join public.loan_payments lp on lp.id = pa.payment_id
  where pa.installment_id = li.id
    and lp.status = 'posted'
) posted on true;

comment on view public.loan_installment_coverage is
  'Each scheduled collection with what posted payments have covered of it and what remains. Derived; nothing is stored. Phase 18 turned the allocation aggregate into a LATERAL correlated on the installment, so reading one loan no longer aggregates every allocation in the database; no figure changed.';
