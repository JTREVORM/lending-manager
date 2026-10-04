-- ===========================================================================
-- Phase 7 — delinquency, derived.
--
-- ## Nothing here is stored
--
-- There is no `arrears_amount` column, no `days_past_due` column and no
-- `delinquency_status` column anywhere in the schema. Every figure in this
-- file is computed when it is read, from three things that cannot be edited:
-- the immutable schedule, the allocations of posted payments, and today's
-- date in the business timezone.
--
-- That is not a performance compromise, it is the whole design:
--
--   * **A stored arrears balance would be a lie waiting to happen.** It would
--     have to be recomputed after every payment, every reversal and every
--     midnight, and the path that missed one would leave a borrower shown as
--     delinquent when they are not, or current when they are months behind.
--   * **A loan is in arrears because the calendar and the ledger say so**, not
--     because a job ran. A system whose arrears appear only after a nightly
--     process is a system that is wrong every morning until it runs, and
--     silently wrong forever if it stops.
--   * **There is nothing to attack.** Phase 7 adds no mutable delinquency
--     state, so no role — including the Owner and `service_role` — can edit a
--     borrower into or out of arrears. The only way to change arrears is to
--     pay, or to reverse a payment, both of which are audited financial acts.
--
-- The one thing Phase 7 does materialise is the penalty, because a charge
-- against a borrower must exist as a record with provenance rather than as an
-- opinion a query holds. See `20261007000600`.
--
-- ## security_invoker, again and for the same reason
--
-- Every view here sets it. Without it a view runs as its owner and becomes a
-- complete Row Level Security bypass — a borrower could read the whole
-- portfolio's arrears by selecting from `loan_delinquency`. With it, each view
-- sees exactly the loans, installments, payments and penalties the reader's
-- own policies admit, and needs no policy of its own.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Penalty coverage
--
-- The penalty obligation and what posted payments have covered of it. The
-- counterpart of `loan_installment_coverage`, deliberately the same shape so
-- the obligation view below can union them without special cases.
-- ---------------------------------------------------------------------------

create view public.loan_penalty_coverage
with (security_invoker = true)
as
select
  p.id                     as penalty_id,
  p.loan_id,
  p.client_id,
  p.penalty_type,
  p.final_due_date,
  p.grace_period_days,
  p.grace_end_date,
  p.effective_date,
  p.basis_amount,
  p.penalty_rate_bps,
  p.penalty_amount,
  p.trigger_rule,
  p.applied_at,

  -- Posted allocations only. A reversal stops counting toward the penalty in
  -- exactly the way it stops counting toward a collection — the row stays and
  -- the coverage disappears, with nothing deleted.
  coalesce(paid.allocated_amount, 0)::bigint              as allocated_amount,
  (p.penalty_amount - coalesce(paid.allocated_amount, 0))::bigint
                                                          as remaining_amount
from public.loan_penalties p
left join (
  select
    pa.penalty_id,
    sum(pa.allocated_amount) as allocated_amount
  from public.payment_allocations pa
  join public.loan_payments lp on lp.id = pa.payment_id
  where lp.status = 'posted'
    and pa.penalty_id is not null
  group by pa.penalty_id
) paid on paid.penalty_id = p.id;

comment on view public.loan_penalty_coverage is
  'Each penalty with what posted payments have covered and what remains. Derived; the penalty row itself is never written to.';

-- ---------------------------------------------------------------------------
-- Every obligation a payment can satisfy
--
-- One list, in the order money is applied to it: oldest first by effective
-- date. A penalty's effective date is the day after the grace period, which is
-- necessarily later than every scheduled collection — so the ordinary
-- oldest-first rule covers the whole contract before it touches the penalty,
-- with no special case for penalties anywhere in the allocation logic. That is
-- why the penalty is modelled with a date at all.
--
-- `obligation_rank` breaks a tie that cannot currently arise (0 for a
-- collection, 1 for a penalty) so the order stays total and deterministic
-- rather than depending on the planner.
-- ---------------------------------------------------------------------------

create view public.loan_obligations
with (security_invoker = true)
as
select
  c.loan_id,
  'installment'::text         as obligation_kind,
  0::smallint                 as obligation_rank,
  c.installment_id,
  null::uuid                  as penalty_id,
  c.due_date                  as effective_date,
  c.installment_number        as sequence_number,
  c.expected_amount,
  c.scheduled_principal,
  c.scheduled_interest,
  0::bigint                   as scheduled_penalty,
  c.allocated_amount,
  c.allocated_principal,
  c.allocated_interest,
  0::bigint                   as allocated_penalty,
  c.remaining_amount,
  c.remaining_principal,
  c.remaining_interest,
  0::bigint                   as remaining_penalty
from public.loan_installment_coverage c

union all

select
  pc.loan_id,
  'penalty'::text             as obligation_kind,
  1::smallint                 as obligation_rank,
  null::uuid                  as installment_id,
  pc.penalty_id,
  pc.effective_date,
  1                           as sequence_number,
  pc.penalty_amount           as expected_amount,
  -- A penalty is neither principal nor contractual interest. Zeroes here are
  -- not a placeholder: they are the classification, and the CHECK constraints
  -- on `payment_allocations` refuse any row that disagrees.
  0::bigint                   as scheduled_principal,
  0::bigint                   as scheduled_interest,
  pc.penalty_amount           as scheduled_penalty,
  pc.allocated_amount,
  0::bigint                   as allocated_principal,
  0::bigint                   as allocated_interest,
  pc.allocated_amount         as allocated_penalty,
  pc.remaining_amount,
  0::bigint                   as remaining_principal,
  0::bigint                   as remaining_interest,
  pc.remaining_amount         as remaining_penalty
from public.loan_penalty_coverage pc;

comment on view public.loan_obligations is
  'Every obligation on a loan — scheduled collections and the expiry penalty — in allocation order (effective_date, obligation_rank, sequence_number). The penalty sorts last by its own date, so oldest-first needs no penalty special case.';

-- ---------------------------------------------------------------------------
-- Per-loan balances, penalty-aware
--
-- ## What changed from Phase 6, and why
--
-- `outstanding` is **renamed** to `contractual_outstanding`. The old name is
-- not kept as an alias: with penalties in the system, a figure called
-- "outstanding" that excludes a charge the borrower owes is a trap, and the
-- cost of two names for one number is that a future report quotes the wrong
-- one. A name that has to be explained is a name that will be misread.
--
-- `total_paid` keeps its Phase 6 meaning — money applied to the contract —
-- so `total_paid + contractual_outstanding = scheduled_total` and
-- `principal_paid + principal_remaining = contractual_principal` both still
-- hold exactly. Penalty money is in `penalty_paid`, and `total_collected`
-- is the pair of them, which is what now equals `posted_payment_total`.
--
-- `fully_repaid` becomes stricter: it means nothing is owed **including** the
-- penalty. For every loan without a penalty it is unchanged.
-- ---------------------------------------------------------------------------

drop view public.loan_balances;

create view public.loan_balances
with (security_invoker = true)
as
select
  l.id                                  as loan_id,
  l.loan_number,
  l.client_id,
  l.status,

  -- --- The contract, as agreed. Never altered by a penalty. --------------
  l.principal_amount                    as contractual_principal,
  l.total_interest                      as contractual_interest,
  l.total_expected_repayment,

  coalesce(cover.scheduled_total, 0)::bigint     as scheduled_total,
  coalesce(cover.total_paid, 0)::bigint          as total_paid,
  coalesce(cover.principal_paid, 0)::bigint      as principal_paid,
  coalesce(cover.interest_paid, 0)::bigint       as interest_paid,

  (coalesce(cover.scheduled_total, 0) - coalesce(cover.total_paid, 0))::bigint
                                         as contractual_outstanding,
  (coalesce(cover.scheduled_principal, 0) - coalesce(cover.principal_paid, 0))::bigint
                                         as principal_remaining,
  (coalesce(cover.scheduled_interest, 0) - coalesce(cover.interest_paid, 0))::bigint
                                         as interest_remaining,

  -- --- The penalty, separately -------------------------------------------
  coalesce(pen.penalty_assessed, 0)::bigint  as penalty_assessed,
  coalesce(pen.penalty_paid, 0)::bigint      as penalty_paid,
  coalesce(pen.penalty_remaining, 0)::bigint as penalty_remaining,

  -- --- What the borrower actually owes ------------------------------------
  (
    coalesce(cover.scheduled_total, 0) - coalesce(cover.total_paid, 0)
    + coalesce(pen.penalty_remaining, 0)
  )::bigint                              as total_outstanding,

  -- Everything collected on this loan, contract and penalty together. This is
  -- the figure that reconciles against the payments themselves.
  (coalesce(cover.total_paid, 0) + coalesce(pen.penalty_paid, 0))::bigint
                                         as total_collected,

  -- A loan with no schedule has nothing scheduled and nothing paid, which
  -- would read as "fully repaid" on a naive comparison. It is not: it has not
  -- been disbursed. So this is false until there is something to repay — and
  -- it now also requires the penalty to be settled.
  (
    coalesce(cover.scheduled_total, 0) > 0
    and coalesce(cover.total_paid, 0) = coalesce(cover.scheduled_total, 0)
    and coalesce(pen.penalty_remaining, 0) = 0
  )                                      as fully_repaid,

  coalesce(paid.posted_payment_total, 0)::bigint    as posted_payment_total,
  coalesce(paid.posted_payment_count, 0)::integer   as posted_payment_count,
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
    pc.loan_id,
    sum(pc.penalty_amount)    as penalty_assessed,
    sum(pc.allocated_amount)  as penalty_paid,
    sum(pc.remaining_amount)  as penalty_remaining
  from public.loan_penalty_coverage pc
  group by pc.loan_id
) pen on pen.loan_id = l.id
left join (
  select
    lp.loan_id,
    sum(lp.amount) filter (where lp.status = 'posted')      as posted_payment_total,
    count(*) filter (where lp.status = 'posted')            as posted_payment_count,
    count(*) filter (where lp.status = 'reversed')          as reversed_payment_count,
    max(lp.received_at) filter (where lp.status = 'posted') as last_payment_at
  from public.loan_payments lp
  group by lp.loan_id
) paid on paid.loan_id = l.id;

comment on view public.loan_balances is
  'Derived position of every loan. The contractual side (scheduled_total, total_paid, contractual_outstanding, principal/interest) is unaffected by penalties; penalty_assessed/paid/remaining stand apart; total_outstanding is what the borrower owes and total_collected is what reconciles against the payments.';

-- ---------------------------------------------------------------------------
-- Delinquency
--
-- ## The three figures the business asked for, defined exactly
--
--   * **past-due arrears** — the uncovered amount of every collection whose
--     due date is strictly **before** today. The uncovered amount, not the
--     scheduled amount: a collection partly covered by an earlier overpayment
--     contributes only what is actually left of it.
--   * **due today** — the uncovered amount of collections due **today**.
--   * **current amount due** — the two added together. This is the figure a
--     collection officer asks a borrower for, and the one that makes a missed
--     UGX 4,000 Monday turn Tuesday's UGX 4,000 into UGX 8,000 **without
--     either row changing**.
--
-- ## Two measures of "how late", never conflated
--
--   * `missed_installment_count` counts past collections still uncovered.
--   * `days_past_due` is calendar days since the oldest uncovered past-due
--     date.
--
-- They are different numbers and the difference is not pedantry: on an
-- every-3-days schedule, three missed collections are nine days. Calling a
-- count of installments "days" would overstate a borrower's lateness by a
-- factor of three.
--
-- ## Why cleared loans appear
--
-- With `delinquency_state = 'cleared'`, so a screen can show a settled loan
-- without a second query and without inferring "not overdue" from absence.
-- Only disbursed loans are here at all, because only they have a schedule.
-- ---------------------------------------------------------------------------

create view public.loan_delinquency
with (security_invoker = true)
as
with today as (
  select public.business_date() as business_date
),
bounds as (
  -- The contractual completion date is the **final installment's due date**,
  -- as Phase 5 established. Deliberately not recomputed from the disbursement
  -- date and the term: the schedule already resolved every month-end and
  -- leap-year question, and a second calculation would eventually disagree
  -- with the collections the borrower was actually given.
  select
    li.loan_id,
    max(li.due_date)  as final_due_date,
    min(li.due_date)  as first_due_date,
    count(*)::integer as installment_count
  from public.loan_installments li
  group by li.loan_id
),
cover as (
  select
    c.loan_id,
    sum(c.expected_amount)::bigint as scheduled_total,
    sum(c.allocated_amount)::bigint as paid_total,

    sum(case when c.due_date <= t.business_date then c.expected_amount else 0 end)::bigint
      as scheduled_due_to_date,
    sum(case when c.due_date <= t.business_date then c.allocated_amount else 0 end)::bigint
      as paid_against_schedule,

    sum(case when c.due_date < t.business_date then c.remaining_amount else 0 end)::bigint
      as arrears_amount,
    sum(case when c.due_date = t.business_date then c.remaining_amount else 0 end)::bigint
      as due_today_amount,

    count(*) filter (
      where c.due_date < t.business_date and c.remaining_amount > 0
    )::integer as missed_installment_count,

    -- The earliest collection with anything left on it, past due or not. This
    -- is also the obligation the minimum-payment rule points at.
    min(c.due_date) filter (where c.remaining_amount > 0) as oldest_unpaid_due_date,

    -- The earliest **overdue** uncovered collection, which is what lateness is
    -- measured from.
    min(c.due_date) filter (
      where c.remaining_amount > 0 and c.due_date < t.business_date
    ) as oldest_past_due_date
  from public.loan_installment_coverage c
  cross join today t
  group by c.loan_id
)
select
  l.id                    as loan_id,
  l.loan_number,
  l.client_id,
  l.status                as loan_status,
  t.business_date,

  -- --- The schedule against the calendar ---------------------------------
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
    else (t.business_date - cv.oldest_past_due_date)
  end::integer            as days_past_due,

  -- --- Expiry and grace ---------------------------------------------------
  -- From the loan's **own snapshotted** grace period, never the current
  -- business setting: an old loan keeps the terms it was approved under, which
  -- is the ADR-023 rule. Changing the setting today must not move a penalty
  -- date on a loan agreed last year.
  l.grace_period_days_applied::integer as grace_period_days,
  (b.final_due_date + l.grace_period_days_applied::integer)      as grace_end_date,
  (b.final_due_date + l.grace_period_days_applied::integer + 1)  as penalty_effective_date,
  (t.business_date > b.final_due_date)                           as past_final_due_date,
  (
    t.business_date > b.final_due_date
    and t.business_date <= b.final_due_date + l.grace_period_days_applied::integer
  )                                                              as within_grace_period,

  -- --- The money ----------------------------------------------------------
  (cv.scheduled_total - cv.paid_total)::bigint      as contractual_outstanding,
  coalesce(pc.penalty_amount, 0)::bigint            as penalty_amount,
  coalesce(pc.allocated_amount, 0)::bigint          as penalty_paid,
  coalesce(pc.remaining_amount, 0)::bigint          as penalty_remaining,
  (
    cv.scheduled_total - cv.paid_total + coalesce(pc.remaining_amount, 0)
  )::bigint                                         as total_outstanding,

  -- --- The penalty --------------------------------------------------------
  (pc.penalty_id is not null)       as penalty_applied,
  pc.penalty_id,
  pc.effective_date                 as penalty_applied_effective_date,
  pc.basis_amount                   as penalty_basis_amount,
  l.penalty_rate_bps_applied        as penalty_rate_bps,

  -- What the penalty would be charged on if it were materialised now: the
  -- effective balance reconstructed as at the **end of the grace period**, not
  -- today. A borrower who pays late, after grace but before anything touches
  -- the loan, does not shrink the charge by doing so.
  basis.basis_amount::bigint        as penalty_basis_as_of_grace_end,

  -- Eligible, but not yet recorded. A penalty is materialised by a trusted
  -- function (see `ensure_penalty_applied`), which every payment path invokes
  -- before it posts — so a borrower cannot settle the old balance and escape
  -- a charge that was already due. Until then this flag and the projected
  -- amount are what a screen shows, clearly labelled as pending.
  pending.penalty_eligible,

  case
    when pending.penalty_eligible then pending.projected_amount
    else 0
  end::bigint                       as penalty_projected_amount,

  -- --- One operational state, by a fixed precedence -----------------------
  --
  --   cleared        the loan owes nothing at all, penalty included
  --   penalty_due    a penalty is recorded and not fully paid
  --   expired_unpaid past the penalty date and eligible, not yet materialised
  --   grace_period   past the final due date, inside grace, still owing
  --   in_arrears     a collection before today is uncovered
  --   due_today      nothing overdue, but today's collection is uncovered
  --   current        nothing is owed today or earlier
  --
  -- Mutually exclusive by construction and evaluated in this order, so one
  -- loan can never present two operational states at once. Core lifecycle
  -- state stays in `loans.status`: nothing here is written anywhere, so the
  -- passage of midnight changes a loan's delinquency without any transition.
  case
    when l.status = 'cleared' then 'cleared'
    when pc.penalty_id is not null and coalesce(pc.remaining_amount, 0) > 0
      then 'penalty_due'
    when pending.penalty_eligible then 'expired_unpaid'
    when t.business_date > b.final_due_date
         and cv.scheduled_total - cv.paid_total + coalesce(pc.remaining_amount, 0) > 0
      then 'grace_period'
    when cv.arrears_amount > 0 then 'in_arrears'
    when cv.due_today_amount > 0 then 'due_today'
    else 'current'
  end                               as delinquency_state
from public.loans l
join bounds b on b.loan_id = l.id
join cover cv on cv.loan_id = l.id
cross join today t
left join public.loan_penalty_coverage pc on pc.loan_id = l.id
-- LATERAL so the as-of balance is computed once per loan and can use the
-- loan's own grace period, which an ordinary scalar subquery in the select
-- list would have to repeat for every column that needs it.
left join lateral (
  select public.loan_outstanding_as_of(
    l.id,
    b.final_due_date + l.grace_period_days_applied::integer
  ) as basis_amount
) basis on true
-- A second LATERAL, which may reference the first: the charge is computed
-- once and eligibility is defined in terms of it.
--
-- Eligibility requires the charge to be **more than zero**. A business
-- running a penalty rate of zero has decided not to charge, and reporting a
-- loan as "a penalty applies" while `ensure_penalty_applied` correctly
-- records nothing would be the view and the function disagreeing — which is
-- exactly the kind of contradiction a derived state must not produce.
left join lateral (
  select
    (basis.basis_amount * l.penalty_rate_bps_applied + 5000) / 10000
      as projected_amount,
    (
      l.status = 'active'
      and pc.penalty_id is null
      and t.business_date >= b.final_due_date + l.grace_period_days_applied::integer + 1
      and basis.basis_amount > 0
      and (basis.basis_amount * l.penalty_rate_bps_applied + 5000) / 10000 > 0
    ) as penalty_eligible
) pending on true;

comment on view public.loan_delinquency is
  'Derived delinquency position of every disbursed loan, as at today in the business timezone: arrears, due today, current due, lateness, expiry, grace, penalty state and one operational status. Nothing here is stored, so there is no delinquency state any role can edit.';

-- ---------------------------------------------------------------------------
-- Privileges
--
-- Every REVOKE names `anon` and `authenticated`, because Supabase's ALTER
-- DEFAULT PRIVILEGES has already granted both every privilege on each new
-- view. Phase 6 learned this the hard way.
-- ---------------------------------------------------------------------------

revoke all on public.loan_penalty_coverage from public, anon, authenticated;
revoke all on public.loan_obligations from public, anon, authenticated;
revoke all on public.loan_balances from public, anon, authenticated;
revoke all on public.loan_delinquency from public, anon, authenticated;

grant select on public.loan_penalty_coverage to authenticated;
grant select on public.loan_obligations to authenticated;
grant select on public.loan_balances to authenticated;
grant select on public.loan_delinquency to authenticated;
