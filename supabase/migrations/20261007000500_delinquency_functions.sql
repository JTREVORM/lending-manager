-- ===========================================================================
-- Phase 7 — the balance functions, made penalty-aware.
--
-- ## A defect in Phase 6's `loan_outstanding`, exposed by this phase
--
-- Phase 6 defined a loan's outstanding balance as every scheduled collection
-- less **every allocation** of a still-posted payment:
--
--     where pa.loan_id = p_loan_id and lp.status = 'posted'
--
-- With only one kind of obligation that was exactly right. The moment a
-- payment can also satisfy a penalty it is wrong in a way that costs the
-- business money: paying a penalty would reduce the *contractual* outstanding
-- balance, so a borrower could clear their loan without paying for all of it.
--
-- So `loan_outstanding` is redefined here to count contractual allocations
-- only, and it keeps its name because its meaning — what the borrower owes on
-- the agreement — has not changed. What has changed is that the agreement is
-- no longer the only thing they can owe, which is why the two functions below
-- it exist.
--
-- This is the kind of defect that only appears when a new obligation type is
-- added, and it is why every balance figure in Phase 7 is derived from one of
-- these three functions rather than from an open-coded sum.
--
-- ## Three questions, three functions
--
--   `loan_outstanding(loan)`          what remains on the contract
--   `loan_penalty_outstanding(loan)`  what remains on the penalty
--   `loan_total_outstanding(loan)`    what the borrower owes, all in
--
-- The third is the one a payment is capped at and the one clearance requires
-- to be zero. The first is the one that must keep reconciling against the
-- schedule, which is why it stays separate rather than being generalised away.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- The contract
-- ---------------------------------------------------------------------------

create or replace function public.loan_outstanding(p_loan_id uuid)
returns bigint
language sql
stable
set search_path = ''
as $$
  select coalesce(
           (select pg_catalog.sum(li.expected_amount)
              from public.loan_installments li
             where li.loan_id = p_loan_id),
           0
         )
       - coalesce(
           (select pg_catalog.sum(pa.allocated_amount)
              from public.payment_allocations pa
              join public.loan_payments lp on lp.id = pa.payment_id
             where pa.loan_id = p_loan_id
               and lp.status = 'posted'
               -- Contractual allocations only. Money that went to a penalty
               -- settles the penalty, not the schedule.
               and pa.installment_id is not null),
           0
         );
$$;

comment on function public.loan_outstanding(uuid) is
  'What a loan still owes on its contract: every scheduled collection less every contractual allocation of a still-posted payment. Excludes penalty allocations, which settle a different obligation.';

revoke all on function public.loan_outstanding(uuid) from public, anon;

-- ---------------------------------------------------------------------------
-- The penalty
-- ---------------------------------------------------------------------------

create or replace function public.loan_penalty_outstanding(p_loan_id uuid)
returns bigint
language sql
stable
set search_path = ''
as $$
  select coalesce(
           (select pg_catalog.sum(p.penalty_amount)
              from public.loan_penalties p
             where p.loan_id = p_loan_id),
           0
         )
       - coalesce(
           (select pg_catalog.sum(pa.allocated_amount)
              from public.payment_allocations pa
              join public.loan_payments lp on lp.id = pa.payment_id
             where pa.loan_id = p_loan_id
               and lp.status = 'posted'
               and pa.penalty_id is not null),
           0
         );
$$;

comment on function public.loan_penalty_outstanding(uuid) is
  'What remains unpaid of a loan''s penalties. Zero for a loan that never incurred one.';

revoke all on function public.loan_penalty_outstanding(uuid) from public, anon;
grant execute on function public.loan_penalty_outstanding(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Everything the borrower owes
-- ---------------------------------------------------------------------------

create or replace function public.loan_total_outstanding(p_loan_id uuid)
returns bigint
language sql
stable
set search_path = ''
as $$
  select public.loan_outstanding(p_loan_id)
       + public.loan_penalty_outstanding(p_loan_id);
$$;

comment on function public.loan_total_outstanding(uuid) is
  'The full effective obligation: contractual outstanding plus unpaid penalties. The figure a payment is capped at, and the one that must be zero for a loan to clear.';

revoke all on function public.loan_total_outstanding(uuid) from public, anon;
grant execute on function public.loan_total_outstanding(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- The contract, as it stood on a given business date
--
-- ## Why a penalty cannot be charged on today's smaller balance
--
-- The rule is 50% of what the borrower owed when the grace period ran out.
-- Nothing guarantees that a process looked at the loan on that day: the
-- penalty may be materialised a week later, by the very payment that is trying
-- to settle the loan. If the basis were read then, a borrower who paid
-- UGX 90,000 of a UGX 100,000 debt on day six would be charged 50% of 10,000
-- instead of 50% of 100,000 — and the later they paid, the less they would
-- owe. The incentive would be exactly backwards.
--
-- So the basis is **reconstructed** as at the end of the grace period: the
-- contract's scheduled total, less the allocations of posted payments that
-- were actually received on or before that business date.
--
-- ## The boundary, stated once
--
--   * a payment whose business date is **on or before** `p_as_of` counts;
--   * a payment on the day **after** the grace period — the penalty's
--     effective date — does not, because the penalty takes effect at the start
--     of that day;
--   * `received_at` is converted to a business date in the configured
--     timezone, never compared as UTC.
--
-- ## Reversed payments never counted
--
-- Only `posted` payments are included, as at the moment of asking. A payment
-- made during grace and reversed afterwards therefore does not reduce the
-- basis: the money was withdrawn, so it never really paid. This is what stops
-- a loan escaping a penalty by looking cleared for a few days — and it is why
-- the function takes no "as at which ledger version" parameter: there is only
-- one ledger, and a reversal is a fact about it rather than a new version of
-- it.
-- ---------------------------------------------------------------------------

create or replace function public.loan_outstanding_as_of(
  p_loan_id uuid,
  p_as_of date
)
returns bigint
language sql
stable
set search_path = ''
as $$
  select coalesce(
           (select pg_catalog.sum(li.expected_amount)
              from public.loan_installments li
             where li.loan_id = p_loan_id),
           0
         )
       - coalesce(
           (select pg_catalog.sum(pa.allocated_amount)
              from public.payment_allocations pa
              join public.loan_payments lp on lp.id = pa.payment_id
             where pa.loan_id = p_loan_id
               and lp.status = 'posted'
               and pa.installment_id is not null
               and public.payment_business_date(lp.received_at) <= p_as_of),
           0
         );
$$;

comment on function public.loan_outstanding_as_of(uuid, date) is
  'The contractual balance as it stood at the end of the given business date, counting only still-posted payments received on or before it. The penalty basis, and a read-only historical figure: no mutation accepts an as-of date.';

revoke all on function public.loan_outstanding_as_of(uuid, date) from public, anon;
grant execute on function public.loan_outstanding_as_of(uuid, date) to authenticated;
