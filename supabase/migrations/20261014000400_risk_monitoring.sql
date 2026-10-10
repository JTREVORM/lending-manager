-- ===========================================================================
-- Phase 14.4 — aging, portfolio at risk, and collections that can be sliced
--
-- Phase 7 computed delinquency per loan: days past due, arrears, grace, the
-- penalty clock. What it never did was *group* it. "Fourteen loans overdue" is
-- a number the business cannot act on; "two at 1–7 days, nine at 8–30 and
-- three over 90" is a morning's work plan, because the three are a different
-- problem from the nine.
--
-- ## Aging is a presentation of days past due, not a second opinion about it
--
-- `loan_aging` adds no arithmetic of its own. `days_past_due` already exists
-- and is already the agreed figure — net of the grace period, measured from
-- the oldest unpaid installment. This view puts a loan in a bucket and names
-- the bucket, and it is careful to derive the bucket from that one column so
-- that a screen and a report can never disagree about which bucket a loan is
-- in.
--
-- ## PAR, and the denominator that makes it honest
--
-- Portfolio at Risk is outstanding *principal* on loans past due over N days,
-- over total outstanding principal. Principal, not total outstanding, and not
-- the arrears figure — those are the two substitutions that quietly turn PAR
-- into a different ratio that happens to share its name. Interest not yet
-- earned is not portfolio, and a penalty is not principal lent.
--
-- The denominator is the *active* book. A cleared loan is not at risk and is
-- not in the portfolio either, so including it would flatter every ratio.
--
-- ## And payments, finally sliceable
--
-- `payment_register` has carried the method and the staff member since Phase
-- 8, which covers Collections by Method and by Staff. Collections by Branch
-- and by Product were impossible, because the view never joined either. Two
-- columns and two more, and the whole Collection Summary becomes one query.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Aging
-- ---------------------------------------------------------------------------

create view public.loan_aging with (security_invoker = true) as
select
  l.id as loan_id,
  l.loan_number,
  l.status as loan_status,
  l.branch_id,
  br.name as branch_name,
  l.loan_product_id,
  p.product_code,
  p.name as product_name,
  l.client_id,
  c.client_number,
  c.full_name as client_name,
  c.phone as client_phone,

  l.principal_amount,
  bal.principal_remaining,
  bal.interest_remaining,
  bal.penalty_remaining,
  d.total_outstanding,
  d.arrears_amount,
  d.current_due,
  d.missed_installment_count,
  d.days_past_due,
  d.oldest_past_due_date,
  d.grace_end_date,
  d.within_grace_period,
  d.delinquency_state,
  d.penalty_applied,
  d.penalty_amount,
  d.penalty_paid,

  -- The bucket. One `case` over one column, so nothing else in the system can
  -- form a different opinion about where a loan belongs.
  case
    when d.days_past_due is null or d.days_past_due <= 0 then 'current'
    when d.days_past_due <= 7 then '1_7'
    when d.days_past_due <= 30 then '8_30'
    when d.days_past_due <= 60 then '31_60'
    when d.days_past_due <= 90 then '61_90'
    else '90_plus'
  end as aging_bucket,

  -- Sort key, because '1_7' sorts after '31_60' and a register ordered by the
  -- label reads as nonsense.
  case
    when d.days_past_due is null or d.days_past_due <= 0 then 0
    when d.days_past_due <= 7 then 1
    when d.days_past_due <= 30 then 2
    when d.days_past_due <= 60 then 3
    when d.days_past_due <= 90 then 4
    else 5
  end as aging_rank,

  -- The PAR thresholds as flags, so a report sums columns instead of
  -- re-deciding the boundaries five times.
  (coalesce(d.days_past_due, 0) >= 1)  as at_risk_1,
  (coalesce(d.days_past_due, 0) >= 7)  as at_risk_7,
  (coalesce(d.days_past_due, 0) >= 30) as at_risk_30,
  (coalesce(d.days_past_due, 0) >= 60) as at_risk_60,
  (coalesce(d.days_past_due, 0) >= 90) as at_risk_90,

  l.disbursed_at,
  d.last_payment_date
from public.loans l
join public.clients c on c.id = l.client_id
join public.loan_products p on p.id = l.loan_product_id
left join public.branches br on br.id = l.branch_id
left join public.loan_balances bal on bal.loan_id = l.id
left join (
  select
    dl.*,
    (select pg_catalog.max(public.payment_business_date(lp.received_at))
       from public.loan_payments lp
      where lp.loan_id = dl.loan_id and lp.status = 'posted') as last_payment_date
  from public.loan_delinquency dl
) d on d.loan_id = l.id
where l.status in ('active', 'grace_period', 'arrears');

comment on view public.loan_aging is
  'Phase 14. The active book, one row per loan, bucketed by days past due (current, 1-7, 8-30, 31-60, 61-90, 90+) with the PAR thresholds as flags. The bucket is derived from `days_past_due` alone, so no screen can disagree with a report about it.';

revoke all on public.loan_aging from anon, authenticated;
grant select on public.loan_aging to authenticated;

-- ---------------------------------------------------------------------------
-- Portfolio at Risk
--
-- One row per branch and product, plus the rolled-up row for each with a null
-- key, so a reader can take the whole book or any slice of it from one query
-- without the caller having to sum anything.
-- ---------------------------------------------------------------------------

create view public.portfolio_at_risk with (security_invoker = true) as
with scoped as (
  select
    a.branch_id,
    a.branch_name,
    a.loan_product_id,
    a.product_code,
    a.product_name,
    coalesce(a.principal_remaining, 0) as principal_remaining,
    coalesce(a.total_outstanding, 0) as total_outstanding,
    coalesce(a.arrears_amount, 0) as arrears_amount,
    a.at_risk_1, a.at_risk_7, a.at_risk_30, a.at_risk_60, a.at_risk_90,
    a.aging_bucket
  from public.loan_aging a
),
grouped as (
  select
    grouping(branch_id) as branch_grouped,
    grouping(loan_product_id) as product_grouped,
    branch_id,
    pg_catalog.min(branch_name) as branch_name,
    loan_product_id,
    pg_catalog.min(product_code) as product_code,
    pg_catalog.min(product_name) as product_name,

    pg_catalog.count(*)::integer as loan_count,
    pg_catalog.sum(principal_remaining)::bigint as principal_outstanding,
    pg_catalog.sum(total_outstanding)::bigint as total_outstanding,
    pg_catalog.sum(arrears_amount)::bigint as arrears_amount,

    pg_catalog.count(*) filter (where at_risk_1)::integer as loans_at_risk_1,
    pg_catalog.count(*) filter (where at_risk_7)::integer as loans_at_risk_7,
    pg_catalog.count(*) filter (where at_risk_30)::integer as loans_at_risk_30,
    pg_catalog.count(*) filter (where at_risk_60)::integer as loans_at_risk_60,
    pg_catalog.count(*) filter (where at_risk_90)::integer as loans_at_risk_90,

    pg_catalog.sum(principal_remaining) filter (where at_risk_1)::bigint
      as principal_at_risk_1,
    pg_catalog.sum(principal_remaining) filter (where at_risk_7)::bigint
      as principal_at_risk_7,
    pg_catalog.sum(principal_remaining) filter (where at_risk_30)::bigint
      as principal_at_risk_30,
    pg_catalog.sum(principal_remaining) filter (where at_risk_60)::bigint
      as principal_at_risk_60,
    pg_catalog.sum(principal_remaining) filter (where at_risk_90)::bigint
      as principal_at_risk_90,

    pg_catalog.count(*) filter (where aging_bucket = 'current')::integer
      as loans_bucket_current,
    pg_catalog.count(*) filter (where aging_bucket = '1_7')::integer
      as loans_bucket_1_7,
    pg_catalog.count(*) filter (where aging_bucket = '8_30')::integer
      as loans_bucket_8_30,
    pg_catalog.count(*) filter (where aging_bucket = '31_60')::integer
      as loans_bucket_31_60,
    pg_catalog.count(*) filter (where aging_bucket = '61_90')::integer
      as loans_bucket_61_90,
    pg_catalog.count(*) filter (where aging_bucket = '90_plus')::integer
      as loans_bucket_90_plus,

    pg_catalog.sum(principal_remaining) filter (where aging_bucket = 'current')::bigint
      as principal_bucket_current,
    pg_catalog.sum(principal_remaining) filter (where aging_bucket = '1_7')::bigint
      as principal_bucket_1_7,
    pg_catalog.sum(principal_remaining) filter (where aging_bucket = '8_30')::bigint
      as principal_bucket_8_30,
    pg_catalog.sum(principal_remaining) filter (where aging_bucket = '31_60')::bigint
      as principal_bucket_31_60,
    pg_catalog.sum(principal_remaining) filter (where aging_bucket = '61_90')::bigint
      as principal_bucket_61_90,
    pg_catalog.sum(principal_remaining) filter (where aging_bucket = '90_plus')::bigint
      as principal_bucket_90_plus
  from scoped
  group by grouping sets (
    (),
    (branch_id),
    (loan_product_id),
    (branch_id, loan_product_id)
  )
)
select
  case
    when branch_grouped = 1 and product_grouped = 1 then 'portfolio'
    when product_grouped = 1 then 'branch'
    when branch_grouped = 1 then 'product'
    else 'branch_product'
  end as scope,
  branch_id,
  branch_name,
  loan_product_id,
  product_code,
  product_name,
  loan_count,
  coalesce(principal_outstanding, 0) as principal_outstanding,
  coalesce(total_outstanding, 0) as total_outstanding,
  coalesce(arrears_amount, 0) as arrears_amount,
  loans_at_risk_1, loans_at_risk_7, loans_at_risk_30,
  loans_at_risk_60, loans_at_risk_90,
  coalesce(principal_at_risk_1, 0)  as principal_at_risk_1,
  coalesce(principal_at_risk_7, 0)  as principal_at_risk_7,
  coalesce(principal_at_risk_30, 0) as principal_at_risk_30,
  coalesce(principal_at_risk_60, 0) as principal_at_risk_60,
  coalesce(principal_at_risk_90, 0) as principal_at_risk_90,

  -- The ratios, in basis points, computed once here rather than in four
  -- callers. Null — not zero — when there is no portfolio to divide by: a
  -- branch with no active loans has no PAR, and 0% would read as "healthy".
  case when principal_outstanding > 0
    then pg_catalog.round(coalesce(principal_at_risk_1, 0) * 10000.0 / principal_outstanding)::integer
  end as par1_bps,
  case when principal_outstanding > 0
    then pg_catalog.round(coalesce(principal_at_risk_7, 0) * 10000.0 / principal_outstanding)::integer
  end as par7_bps,
  case when principal_outstanding > 0
    then pg_catalog.round(coalesce(principal_at_risk_30, 0) * 10000.0 / principal_outstanding)::integer
  end as par30_bps,
  case when principal_outstanding > 0
    then pg_catalog.round(coalesce(principal_at_risk_60, 0) * 10000.0 / principal_outstanding)::integer
  end as par60_bps,
  case when principal_outstanding > 0
    then pg_catalog.round(coalesce(principal_at_risk_90, 0) * 10000.0 / principal_outstanding)::integer
  end as par90_bps,

  loans_bucket_current, loans_bucket_1_7, loans_bucket_8_30,
  loans_bucket_31_60, loans_bucket_61_90, loans_bucket_90_plus,
  coalesce(principal_bucket_current, 0)  as principal_bucket_current,
  coalesce(principal_bucket_1_7, 0)      as principal_bucket_1_7,
  coalesce(principal_bucket_8_30, 0)     as principal_bucket_8_30,
  coalesce(principal_bucket_31_60, 0)    as principal_bucket_31_60,
  coalesce(principal_bucket_61_90, 0)    as principal_bucket_61_90,
  coalesce(principal_bucket_90_plus, 0)  as principal_bucket_90_plus
from grouped;

comment on view public.portfolio_at_risk is
  'Phase 14. PAR1/7/30/60/90 and the aging buckets, for the whole active portfolio and sliced by branch, by product and by both (see `scope`). The ratio is outstanding principal past due over total outstanding principal, and is null rather than zero where there is no portfolio to divide by.';

revoke all on public.portfolio_at_risk from anon, authenticated;
grant select on public.portfolio_at_risk to authenticated;

-- ---------------------------------------------------------------------------
-- payment_register, with the two joins it was missing
--
-- Re-emitted in full. The new columns are at the end, so every existing
-- caller's column list is untouched.
-- ---------------------------------------------------------------------------

create or replace view public.payment_register
with (security_invoker = true)
as
select
  lp.id                               as payment_id,
  lp.payment_number,
  lp.loan_id,
  l.loan_number,
  lp.client_id,
  c.client_number,
  c.full_name                         as client_name,
  c.phone                             as client_phone,
  -- The borrower's name as it stood when the money was taken. A statement or a
  -- historical report should read the way the receipt does, and a client who
  -- marries and changes their name has not changed what happened in March.
  lp.client_name_at_payment,

  lp.amount,
  lp.payment_method,
  lp.status,
  (lp.status = 'posted')              as is_effective,
  (case when lp.status = 'posted' then lp.amount else 0 end)::bigint
                                      as effective_amount,

  lp.received_at,
  public.payment_business_date(lp.received_at) as business_date,
  lp.recorded_by,
  lp.recorded_by_label,
  lp.external_reference,
  lp.reversed_at,
  lp.reversed_by,
  lp.reversal_reason,
  lp.outstanding_before,
  lp.outstanding_after,

  coalesce(alloc.allocated_principal, 0)::bigint as allocated_principal,
  coalesce(alloc.allocated_interest, 0)::bigint  as allocated_interest,
  coalesce(alloc.allocated_penalty, 0)::bigint   as allocated_penalty,

  (case when lp.status = 'posted' then coalesce(alloc.allocated_principal, 0) else 0 end)::bigint
                                      as principal_collected,
  (case when lp.status = 'posted' then coalesce(alloc.allocated_interest, 0) else 0 end)::bigint
                                      as interest_collected,
  (case when lp.status = 'posted' then coalesce(alloc.allocated_penalty, 0) else 0 end)::bigint
                                      as penalty_collected,

  -- Phase 14. The branch and the product the money came in against, so
  -- Collections by Branch and Collections by Product are slices of this one
  -- view rather than two more queries.
  --
  -- Taken from the loan rather than from the payment, because a payment has no
  -- branch of its own: it is a receipt against a loan, and the loan is what
  -- belongs to a branch. Which means these read as "the branch that owns this
  -- lending", not "the counter the cash was handed over at" — a distinction
  -- that matters the day the business opens a second branch and a borrower
  -- pays at the wrong one.
  l.branch_id,
  br.name                             as branch_name,
  l.loan_product_id,
  p.product_code,
  p.name                              as product_name
from public.loan_payments lp
left join public.loans l on l.id = lp.loan_id
left join public.clients c on c.id = lp.client_id
left join public.branches br on br.id = l.branch_id
left join public.loan_products p on p.id = l.loan_product_id
left join (
  select
    pa.payment_id,
    sum(pa.allocated_principal) as allocated_principal,
    sum(pa.allocated_interest)  as allocated_interest,
    sum(pa.allocated_penalty)   as allocated_penalty
  from public.payment_allocations pa
  group by pa.payment_id
) alloc on alloc.payment_id = lp.id;

comment on view public.payment_register is
  'Every recorded payment with its borrower, loan, business date, branch, product and allocation components. amount/allocated_* are gross; effective_amount and *_collected are zero for a reversed payment, so totals exclude reversals without each report remembering to filter. branch_id and loan_product_id come from the loan, so they say which lending the money belongs to, not which counter took it.';
