-- ===========================================================================
-- Phase 6 — balances, derived.
--
-- ## Why views and not columns
--
-- There is no `amount_paid` on a loan and no `remaining_balance`. Every figure
-- below is computed from the contract and the allocations of **posted**
-- payments, every time it is read.
--
-- A cached balance column would be wrong in one specific, expensive way:
-- reversing a payment would have to find and correct every cache that depended
-- on it, and any path that missed one would leave a loan reporting a balance
-- the ledger does not support. Deriving means a reversal changes every figure
-- in the system the instant its status changes, because the reversed payment's
-- allocations simply stop being counted.
--
-- The specification permits caching with "strict reconciliation and
-- source-of-truth rules". These views are the cheaper answer: a loan has at
-- most a few hundred installments and a few dozen payments, every aggregate is
-- indexed, and there is no reconciliation to maintain because there is only
-- one source.
--
-- ## security_invoker, and why it is not optional
--
-- A view runs as its **owner** by default, which would make these a complete
-- bypass of every Row Level Security policy in the system: a borrower could
-- read any loan's balance by selecting from the view. `security_invoker = true`
-- makes the underlying tables' policies apply to the caller instead.
--
-- So the views need no policies of their own — they inherit exactly the access
-- `loans`, `loan_installments`, `loan_payments` and `payment_allocations`
-- already grant. `tests/db/security.test.ts` asserts that every view in the
-- schema sets it, so a future view cannot quietly reintroduce the bypass.
--
-- One consequence worth stating: allocation visibility must track payment
-- visibility exactly, or an aggregate would silently under-report for a role
-- that could see a payment but not its allocations. Migration
-- `20261006000600` makes the allocation policy delegate to the payment policy
-- for precisely this reason.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Per-installment coverage
--
-- What each scheduled collection has received, and what remains. The
-- foundation of the allocation order, the minimum-payment rule and the
-- "what is due now" figure.
-- ---------------------------------------------------------------------------

create view public.loan_installment_coverage
with (security_invoker = true)
as
select
  li.id                      as installment_id,
  li.loan_id,
  li.loan_period_id,
  li.loan_period_number,
  li.installment_number,
  li.due_date,
  li.expected_amount,
  li.scheduled_principal,
  li.scheduled_interest,

  -- Posted allocations only. A reversed payment's rows stay in the table as
  -- history and are excluded here; that exclusion is what a reversal *is*.
  -- Every money figure is `bigint`, including the aggregates.
  --
  -- `sum(bigint)` returns `numeric` in PostgreSQL — a wider type chosen so a
  -- sum cannot overflow. It is exact, so nothing would be *wrong*, but it is
  -- not this project's money type: ADR-002 fixed UGX as `bigint` end to end,
  -- and `numeric` crosses the wire as a decimal string that a careless
  -- consumer could parse as a float. The casts keep the invariant whole, and
  -- the schema guard in `tests/db/schema.test.ts` asserts it across views as
  -- well as tables. Exact at this scale by a wide margin: a loan has a few
  -- hundred collections of a few thousand shillings each.
  coalesce(posted.allocated_amount, 0)::bigint    as allocated_amount,
  coalesce(posted.allocated_principal, 0)::bigint as allocated_principal,
  coalesce(posted.allocated_interest, 0)::bigint  as allocated_interest,

  (li.expected_amount - coalesce(posted.allocated_amount, 0))::bigint
                                                                  as remaining_amount,
  (li.scheduled_principal - coalesce(posted.allocated_principal, 0))::bigint
                                                                  as remaining_principal,
  (li.scheduled_interest - coalesce(posted.allocated_interest, 0))::bigint
                                                                  as remaining_interest
from public.loan_installments li
left join (
  select
    pa.installment_id,
    sum(pa.allocated_amount)    as allocated_amount,
    sum(pa.allocated_principal) as allocated_principal,
    sum(pa.allocated_interest)  as allocated_interest
  from public.payment_allocations pa
  join public.loan_payments lp on lp.id = pa.payment_id
  where lp.status = 'posted'
  group by pa.installment_id
) posted on posted.installment_id = li.id;

comment on view public.loan_installment_coverage is
  'Each scheduled collection with what posted payments have covered and what remains. Derived — the installment row itself is never written to.';

-- ---------------------------------------------------------------------------
-- Per-loan balances
--
-- Every figure the specification requires, each one derived, and the set
-- reconciling by construction: the contractual side comes from the schedule
-- and the paid side from the allocations, so `paid + outstanding = total`
-- holds because both halves are sums over the same rows.
-- ---------------------------------------------------------------------------

create view public.loan_balances
with (security_invoker = true)
as
select
  l.id                                  as loan_id,
  l.loan_number,
  l.client_id,
  l.status,
  l.principal_amount                    as contractual_principal,
  l.total_interest                      as contractual_interest,
  l.total_expected_repayment,

  -- `::bigint` throughout, for the reason given on the coverage view above.
  coalesce(cover.scheduled_total, 0)::bigint     as scheduled_total,
  coalesce(cover.total_paid, 0)::bigint          as total_paid,
  coalesce(cover.principal_paid, 0)::bigint      as principal_paid,
  coalesce(cover.interest_paid, 0)::bigint       as interest_paid,

  (coalesce(cover.scheduled_total, 0) - coalesce(cover.total_paid, 0))::bigint
                                         as outstanding,
  (coalesce(cover.scheduled_principal, 0) - coalesce(cover.principal_paid, 0))::bigint
                                         as principal_remaining,
  (coalesce(cover.scheduled_interest, 0) - coalesce(cover.interest_paid, 0))::bigint
                                         as interest_remaining,

  -- A loan with no schedule has nothing scheduled and nothing paid, which
  -- would read as "fully repaid" on a naive comparison. It is not: it has not
  -- been disbursed. So this is false until there is something to repay.
  (
    coalesce(cover.scheduled_total, 0) > 0
    and coalesce(cover.total_paid, 0) = coalesce(cover.scheduled_total, 0)
  )                                      as fully_repaid,

  coalesce(paid.posted_payment_total, 0)::bigint   as posted_payment_total,
  coalesce(paid.posted_payment_count, 0)::integer  as posted_payment_count,
  coalesce(paid.reversed_payment_count, 0)::integer as reversed_payment_count,
  paid.last_payment_at
from public.loans l
left join (
  select
    c.loan_id,
    sum(c.expected_amount)      as scheduled_total,
    sum(c.scheduled_principal)  as scheduled_principal,
    sum(c.scheduled_interest)   as scheduled_interest,
    sum(c.allocated_amount)     as total_paid,
    sum(c.allocated_principal)  as principal_paid,
    sum(c.allocated_interest)   as interest_paid
  from public.loan_installment_coverage c
  group by c.loan_id
) cover on cover.loan_id = l.id
left join (
  select
    lp.loan_id,
    sum(lp.amount) filter (where lp.status = 'posted')     as posted_payment_total,
    count(*) filter (where lp.status = 'posted')           as posted_payment_count,
    count(*) filter (where lp.status = 'reversed')         as reversed_payment_count,
    max(lp.received_at) filter (where lp.status = 'posted') as last_payment_at
  from public.loan_payments lp
  group by lp.loan_id
) paid on paid.loan_id = l.id;

comment on view public.loan_balances is
  'Derived position of every loan: paid, outstanding, and the principal and interest split. posted_payment_total is carried alongside total_paid so the headline reconciliation — payments equal allocations — can be checked by reading one row.';

-- ---------------------------------------------------------------------------
-- Collection totals by day and method
--
-- "What did we take today, and how much of it was cash." Posted payments
-- only, so a reversal removes its payment from the day's total.
--
-- Deliberately not a report. There is no shortfall figure and no comparison
-- against what was due, because naming a gap between the two is arrears
-- interpretation and Phase 7 owns it.
-- ---------------------------------------------------------------------------

create view public.payment_collection_totals
with (security_invoker = true)
as
select
  (lp.received_at at time zone cs.timezone)::date as collection_date,
  lp.payment_method,
  count(*)::integer      as payment_count,
  sum(lp.amount)::bigint as total_amount
from public.loan_payments lp
cross join public.company_settings cs
where lp.status = 'posted'
  and cs.id = 1
group by (lp.received_at at time zone cs.timezone)::date, lp.payment_method;

comment on view public.payment_collection_totals is
  'Posted payments per business day and method, in the configured business timezone. No expected-versus-collected comparison: that is arrears interpretation and belongs to Phase 7.';

-- ---------------------------------------------------------------------------
-- Privileges
--
-- ## Why every REVOKE names each role
--
-- Supabase installs `ALTER DEFAULT PRIVILEGES` granting all privileges on new
-- objects in `public` to `anon` and `authenticated`. So a freshly created view
-- arrives with INSERT, UPDATE, DELETE, TRUNCATE, TRIGGER and REFERENCES
-- already granted to both — including to anonymous visitors — and
-- `grant select` alone would add nothing while leaving all of that in place.
--
-- `revoke all from public` does **not** remove them, because they were granted
-- to the roles by name rather than inherited from `PUBLIC`. Each role has to
-- be named. This is the Phase 1 lesson, and the first draft of this migration
-- got it wrong: the exhaustive privilege guard in `tests/db/security.test.ts`
-- caught it.
--
-- `security_invoker` meant the base tables' own privileges denied the read
-- regardless, so nothing was exposed. But that is protection from the wrong
-- layer: a later view over a table `anon` *can* read would have leaked with no
-- warning. The grant simply should not exist.
-- ---------------------------------------------------------------------------

revoke all on public.loan_installment_coverage from public, anon, authenticated;
revoke all on public.loan_balances from public, anon, authenticated;
revoke all on public.payment_collection_totals from public, anon, authenticated;

grant select on public.loan_installment_coverage to authenticated;
grant select on public.loan_balances to authenticated;
grant select on public.payment_collection_totals to authenticated;
