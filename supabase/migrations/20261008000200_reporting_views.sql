-- ===========================================================================
-- Phase 8 — reporting views.
--
-- ## These views invent nothing
--
-- Every figure here is read from somewhere that already decided it: the loan
-- register, the immutable schedule, the payment ledger and its allocations,
-- `loan_balances`, `loan_delinquency`. Not one line recomputes interest,
-- re-derives arrears, or applies a penalty rate. A dashboard that arrives at
-- its own answer is not a dashboard, it is a second ledger — and the moment
-- the two disagree, nobody can tell which is wrong.
--
-- So the rule for this file is narrow and absolute: **aggregate and join, never
-- calculate.** The only arithmetic permitted is summing figures the
-- authoritative views already produced, and the one genuinely new measure that
-- no earlier phase needed — what was uncovered at the *start* of today, for
-- the collection sheet. Even that is a subtraction between two stored
-- quantities, not a formula.
--
-- ## security_invoker, for the fourth phase running
--
-- Every view sets it. A reporting view that ran as its owner would be the
-- single most valuable thing in the schema to an attacker: one SELECT
-- returning every borrower's position regardless of who asked. With
-- `security_invoker` each view is read under the caller's own policies, so a
-- borrower reading `loan_portfolio_report` gets their own loans and a
-- Secretary/Treasurer gets what the loan policies already admit.
--
-- This is also why **no reporting view is `SECURITY DEFINER` and none is
-- materialised.** A materialised view is owned data: it is populated by
-- whoever refreshes it, so it has no caller to be read on behalf of and Row
-- Level Security cannot apply to it at all. Phase 7 noted a materialised view
-- might one day help a larger portfolio; Phase 8 declines it, and the reason is
-- security before performance.
--
-- ## Nothing here writes
--
-- A report must never materialise a penalty. Phase 7 made reads side-effect
-- free on purpose — eligibility is derived, the charge is written by the next
-- transaction that touches the loan — and every view below preserves that. A
-- loan past its grace deadline reports `penalty_eligible` with a projected
-- amount, labelled as pending, and selecting from these views a thousand times
-- changes no row.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- The payment register
--
-- One row per recorded payment, with the borrower, the loan, the business date
-- it was received on, and what the money was applied to. This is the single
-- source for every collection report: the date-range report, the daily, weekly
-- and monthly summaries, the payment-method split, and the "collected today"
-- figure on three different dashboards.
--
-- ## Gross and effective are separate columns, deliberately
--
-- `amount` is what was recorded. `effective_amount` is zero for a reversed
-- payment. A reversed payment therefore stays visible in every report — the
-- row is history and history does not disappear — while every total built on
-- `effective_amount` excludes it without the report having to remember to
-- filter. The alternative, filtering `status = 'posted'` at each of a dozen
-- call sites, is one forgotten `WHERE` away from a collection total that
-- includes money the business gave back.
--
-- The same split applies to the components: `allocated_*` is what the payment
-- was applied to, `*_collected` is zero once reversed.
--
-- ## Why the client and loan joins are outer
--
-- A financial register must never silently drop a row the caller is entitled
-- to read. Every role that holds `payments:view` today also reads loans and
-- clients, so the joins find their rows — but if a future role were given
-- payments without the client directory, a left join shows the payment with a
-- blank name while an inner join would quietly shorten the day's takings.
-- Between a missing label and a missing shilling, the label.
-- ---------------------------------------------------------------------------

create view public.payment_register
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
                                      as penalty_collected
from public.loan_payments lp
left join public.loans l on l.id = lp.loan_id
left join public.clients c on c.id = lp.client_id
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
  'Every recorded payment with its borrower, loan, business date and allocation components. amount/allocated_* are gross; effective_amount and *_collected are zero for a reversed payment, so totals exclude reversals without each report remembering to filter.';

-- ---------------------------------------------------------------------------
-- Today's collection sheet
--
-- One row per loan with a collection falling due today that was **not already
-- covered before today**.
--
-- ## The one new measure in Phase 8, and why it had to be new
--
-- `expected_today` is the day's collection target: the scheduled amount due
-- today, less whatever earlier payments had already covered of it. Phase 7's
-- `due_today_amount` nets off *every* payment including today's, which is the
-- right answer to "what is still owed" and the wrong answer to "what were we
-- expecting to collect when the day started". Both are needed, and they are
-- different numbers the moment somebody pays.
--
-- Deliberately **not** the original installment amount. A borrower who paid
-- ahead last week has already covered today's collection; listing them as due
-- would send a collections officer to a client who owes nothing today, which is
-- the prepayment defect §130 exists to prevent. Such a loan is absent from
-- this view entirely, because `expected_today` would be zero.
--
-- ## Expected, collected and remaining do not form an identity
--
-- `expected_today - collected_today ≠ remaining_today`, and the reports say so
-- rather than implying otherwise. Money taken today may settle arrears from
-- last month or run ahead into next week; it does not have to land on today's
-- installment. Presenting the three as a tidy subtraction would be a invented
-- relationship, which is the one thing a financial screen may not do.
--
--   * `expected_today`  — today's uncovered obligation as at the start of day
--   * `collected_today` — every effective payment taken today on this loan,
--                         wherever it was applied
--   * `remaining_today` — Phase 7's `due_today_amount`, live
--
-- ## One row per loan is guaranteed
--
-- `loan_installments` carries a unique index on `(loan_id, due_date)`, so a
-- loan has at most one collection on any date. That is a schema fact, not an
-- assumption this view makes.
-- ---------------------------------------------------------------------------

create view public.collections_today
with (security_invoker = true)
as
with today as (
  select public.business_date() as business_date
),
covered_before as (
  select
    pa.installment_id,
    sum(pa.allocated_amount) as allocated
  from public.payment_allocations pa
  join public.loan_payments lp on lp.id = pa.payment_id
  cross join today t
  where lp.status = 'posted'
    and pa.installment_id is not null
    and public.payment_business_date(lp.received_at) < t.business_date
  group by pa.installment_id
),
due as (
  select
    li.loan_id,
    li.id                as installment_id,
    li.installment_number,
    li.due_date,
    li.expected_amount,
    coalesce(cb.allocated, 0)::bigint as covered_before_today
  from public.loan_installments li
  cross join today t
  left join covered_before cb on cb.installment_id = li.id
  where li.due_date = t.business_date
),
paid_today as (
  select
    lp.loan_id,
    sum(lp.amount)::bigint as collected_today,
    count(*)::integer      as payments_today
  from public.loan_payments lp
  cross join today t
  where lp.status = 'posted'
    and public.payment_business_date(lp.received_at) = t.business_date
  group by lp.loan_id
)
select
  d.loan_id,
  l.loan_number,
  l.status                             as loan_status,
  l.client_id,
  c.client_number,
  c.full_name                          as client_name,
  c.phone                              as client_phone,
  t.business_date,

  d.installment_id,
  d.installment_number,
  d.expected_amount                    as scheduled_amount,
  (d.expected_amount - d.covered_before_today)::bigint as expected_today,
  coalesce(pt.collected_today, 0)::bigint              as collected_today,
  coalesce(pt.payments_today, 0)::integer              as payments_today,

  -- Straight from Phase 7. Not recomputed here, and not reconciled against the
  -- two columns above, because they answer different questions.
  dq.due_today_amount                  as remaining_today,
  dq.arrears_amount,
  dq.current_due,
  dq.total_outstanding,
  dq.days_past_due,
  dq.missed_installment_count,
  dq.delinquency_state,

  case
    when dq.due_today_amount = 0 then 'paid'
    when coalesce(pt.collected_today, 0) > 0 then 'part_paid'
    else 'unpaid'
  end                                  as collection_status
from due d
join public.loans l on l.id = d.loan_id
join public.loan_delinquency dq on dq.loan_id = d.loan_id
cross join today t
left join public.clients c on c.id = l.client_id
left join paid_today pt on pt.loan_id = d.loan_id
-- A collection already covered in full before today is not due today. The
-- borrower paid ahead; the sheet should not send anybody to their door.
where d.expected_amount > d.covered_before_today;

comment on view public.collections_today is
  'Loans with a collection due today that was not already covered before today. expected_today is the start-of-day target, collected_today is every effective payment taken today on the loan, remaining_today is Phase 7 due_today_amount. The three are not an identity.';

-- ---------------------------------------------------------------------------
-- The loan portfolio report
--
-- One row per loan, joining the contract, the derived balances and the derived
-- delinquency position. Every column comes from an authoritative source; the
-- view's whole job is to put them side by side so a report does not need four
-- queries and a join in JavaScript.
--
-- Loans that were never disbursed are included with null delinquency and zero
-- balances, because the loan register legitimately contains drafts and
-- cancellations, and `status` is a filter rather than a secret.
-- ---------------------------------------------------------------------------

create view public.loan_portfolio_report
with (security_invoker = true)
as
select
  l.id                                 as loan_id,
  l.loan_number,
  l.client_id,
  c.client_number,
  c.full_name                          as client_name,
  c.phone                              as client_phone,
  c.status                             as client_status,
  -- The borrower as they were when the loan was written. Used for statements
  -- and anything historical; the current name sits beside it for finding them.
  snap.full_name                       as client_name_at_origination,
  snap.phone                           as client_phone_at_origination,

  l.status                             as loan_status,
  l.principal_amount,
  l.interest_rate_bps,
  l.interest_method,
  l.loan_term_months,
  l.repayment_frequency,
  l.total_interest                     as contractual_interest,
  l.total_expected_repayment,
  l.grace_period_days_applied,
  l.penalty_rate_bps_applied,
  l.proposed_disbursement_date,
  l.disbursed_at,
  l.cleared_at,
  l.cancelled_at,
  l.created_at,

  b.scheduled_total,
  b.total_paid,
  b.principal_paid,
  b.interest_paid,
  b.contractual_outstanding,
  b.principal_remaining,
  b.interest_remaining,
  b.penalty_assessed,
  b.penalty_paid,
  b.penalty_remaining,
  b.total_outstanding,
  b.total_collected,
  b.fully_repaid,
  b.posted_payment_total,
  b.posted_payment_count,
  b.reversed_payment_count,
  b.last_payment_at,

  dq.scheduled_completion_date,
  dq.installment_count,
  dq.first_due_date,
  dq.arrears_amount,
  dq.due_today_amount,
  dq.current_due,
  dq.missed_installment_count,
  dq.days_past_due,
  dq.oldest_unpaid_due_date,
  dq.oldest_past_due_date,
  dq.grace_end_date,
  dq.penalty_effective_date,
  dq.within_grace_period,
  dq.penalty_applied,
  dq.penalty_eligible,
  dq.penalty_projected_amount,
  dq.delinquency_state
from public.loans l
left join public.clients c on c.id = l.client_id
left join public.loan_client_snapshots snap on snap.loan_id = l.id
left join public.loan_balances b on b.loan_id = l.id
left join public.loan_delinquency dq on dq.loan_id = l.id;

comment on view public.loan_portfolio_report is
  'One row per loan: the contract, the borrower (current and at origination), the derived balances from loan_balances and the derived position from loan_delinquency. Joins and nothing else — no figure is recomputed here.';

-- ---------------------------------------------------------------------------
-- The portfolio summary
--
-- A single row of business-wide figures for the executive dashboard. Read
-- under the caller's policies like everything else, so a borrower who somehow
-- reached it would be summarising their own one loan.
--
-- ## Two kinds of count, named apart
--
-- Delinquency states are mutually exclusive, so `loans_state_*` partitions the
-- disbursed book exactly: the seven counts sum to `loans_with_schedule` and no
-- loan is in two of them. That is what a status breakdown needs.
--
-- But "how many borrowers owe past-due money" is a different question, and its
-- answer overlaps: a loan in `penalty_due` usually has arrears too. So
-- `loans_with_arrears` exists separately and is documented as overlapping.
-- Mixing the two is how a dashboard ends up claiming more loans than it has.
--
-- ## Lifecycle and delinquency are not the same axis
--
-- `loans_active` counts `loans.status = 'active'` — the lifecycle. A penalised
-- loan is still an active loan: it has been disbursed and not settled.
-- `loans_state_penalty_due` counts the same loan under its delinquency state.
-- Adding a lifecycle count to a delinquency count double-counts, and the two
-- families are kept visibly separate here for that reason.
-- ---------------------------------------------------------------------------

create view public.dashboard_portfolio_summary
with (security_invoker = true)
as
select
  public.business_date() as business_date,

  -- --- Borrowers -----------------------------------------------------------
  cl.total_clients,
  cl.active_clients,
  cl.inactive_clients,
  cl.suspended_clients,
  cl.blacklisted_clients,
  cl.archived_clients,
  cl.clients_with_active_loan,

  -- --- The loan book, by lifecycle -----------------------------------------
  ln.loans_total,
  ln.loans_draft,
  ln.loans_pending_approval,
  ln.loans_approved,
  ln.loans_active,
  ln.loans_cleared,
  ln.loans_cancelled,

  -- --- What the business has lent and agreed ------------------------------
  -- Disbursed means the money left the business: `disbursed_at is not null`.
  -- Not `status = 'active'`, which would drop every loan that has since been
  -- settled and understate the book's history.
  ln.principal_disbursed,
  ln.contractual_interest,
  ln.contractual_expected,

  -- --- What has been collected, from the ledger ---------------------------
  bal.total_paid                as contract_collected,
  bal.principal_paid            as principal_collected,
  bal.interest_paid             as interest_collected,
  bal.penalty_paid              as penalty_collected,
  bal.total_collected,
  bal.posted_payment_total,

  -- --- What is owed -------------------------------------------------------
  bal.contractual_outstanding,
  bal.principal_remaining       as principal_outstanding,
  bal.interest_remaining        as interest_outstanding,
  bal.penalty_assessed,
  bal.penalty_remaining         as penalty_outstanding,
  bal.total_outstanding,

  -- --- Delinquency, derived ------------------------------------------------
  coalesce(dq.loans_with_schedule, 0)::integer       as loans_with_schedule,
  coalesce(dq.loans_state_current, 0)::integer       as loans_state_current,
  coalesce(dq.loans_state_due_today, 0)::integer     as loans_state_due_today,
  coalesce(dq.loans_state_in_arrears, 0)::integer    as loans_state_in_arrears,
  coalesce(dq.loans_state_grace_period, 0)::integer  as loans_state_grace_period,
  coalesce(dq.loans_state_expired_unpaid, 0)::integer as loans_state_expired_unpaid,
  coalesce(dq.loans_state_penalty_due, 0)::integer   as loans_state_penalty_due,
  coalesce(dq.loans_state_cleared, 0)::integer       as loans_state_cleared,

  -- Overlapping measures. A loan can appear in more than one of these.
  coalesce(dq.loans_with_arrears, 0)::integer        as loans_with_arrears,
  coalesce(dq.loans_penalised, 0)::integer           as loans_penalised,
  coalesce(dq.loans_penalty_pending, 0)::integer     as loans_penalty_pending,

  coalesce(dq.arrears_total, 0)::bigint              as arrears_total,
  coalesce(dq.due_today_total, 0)::bigint            as due_today_total,
  coalesce(dq.current_due_total, 0)::bigint          as current_due_total
from (
  select
    count(*)::integer                                                as total_clients,
    count(*) filter (where c.status = 'active')::integer             as active_clients,
    count(*) filter (where c.status = 'inactive')::integer           as inactive_clients,
    count(*) filter (where c.status = 'suspended')::integer          as suspended_clients,
    count(*) filter (where c.status = 'blacklisted')::integer        as blacklisted_clients,
    count(*) filter (where c.status = 'archived')::integer           as archived_clients,
    count(*) filter (
      where exists (
        select 1 from public.loans l
        where l.client_id = c.id and l.status = 'active'
      )
    )::integer                                                       as clients_with_active_loan
  from public.clients c
) cl
cross join (
  select
    count(*)::integer                                                as loans_total,
    count(*) filter (where l.status = 'draft')::integer              as loans_draft,
    count(*) filter (where l.status = 'pending_approval')::integer   as loans_pending_approval,
    count(*) filter (where l.status = 'approved')::integer           as loans_approved,
    count(*) filter (where l.status = 'active')::integer             as loans_active,
    count(*) filter (where l.status = 'cleared')::integer            as loans_cleared,
    count(*) filter (where l.status = 'cancelled')::integer          as loans_cancelled,
    coalesce(sum(l.principal_amount) filter (where l.disbursed_at is not null), 0)::bigint
                                                                     as principal_disbursed,
    coalesce(sum(l.total_interest) filter (where l.disbursed_at is not null), 0)::bigint
                                                                     as contractual_interest,
    coalesce(sum(l.total_expected_repayment) filter (where l.disbursed_at is not null), 0)::bigint
                                                                     as contractual_expected
  from public.loans l
) ln
cross join (
  select
    coalesce(sum(b.total_paid), 0)::bigint               as total_paid,
    coalesce(sum(b.principal_paid), 0)::bigint           as principal_paid,
    coalesce(sum(b.interest_paid), 0)::bigint            as interest_paid,
    coalesce(sum(b.penalty_paid), 0)::bigint             as penalty_paid,
    coalesce(sum(b.total_collected), 0)::bigint          as total_collected,
    coalesce(sum(b.posted_payment_total), 0)::bigint     as posted_payment_total,
    coalesce(sum(b.contractual_outstanding), 0)::bigint  as contractual_outstanding,
    coalesce(sum(b.principal_remaining), 0)::bigint      as principal_remaining,
    coalesce(sum(b.interest_remaining), 0)::bigint       as interest_remaining,
    coalesce(sum(b.penalty_assessed), 0)::bigint         as penalty_assessed,
    coalesce(sum(b.penalty_remaining), 0)::bigint        as penalty_remaining,
    coalesce(sum(b.total_outstanding), 0)::bigint        as total_outstanding
  from public.loan_balances b
) bal
left join lateral (
  select
    count(*)::integer                                                       as loans_with_schedule,
    count(*) filter (where d.delinquency_state = 'current')::integer        as loans_state_current,
    count(*) filter (where d.delinquency_state = 'due_today')::integer      as loans_state_due_today,
    count(*) filter (where d.delinquency_state = 'in_arrears')::integer     as loans_state_in_arrears,
    count(*) filter (where d.delinquency_state = 'grace_period')::integer   as loans_state_grace_period,
    count(*) filter (where d.delinquency_state = 'expired_unpaid')::integer as loans_state_expired_unpaid,
    count(*) filter (where d.delinquency_state = 'penalty_due')::integer    as loans_state_penalty_due,
    count(*) filter (where d.delinquency_state = 'cleared')::integer        as loans_state_cleared,
    count(*) filter (where d.arrears_amount > 0)::integer                   as loans_with_arrears,
    count(*) filter (where d.penalty_applied)::integer                      as loans_penalised,
    count(*) filter (where d.penalty_eligible)::integer                     as loans_penalty_pending,
    coalesce(sum(d.arrears_amount), 0)::bigint                              as arrears_total,
    coalesce(sum(d.due_today_amount), 0)::bigint                            as due_today_total,
    coalesce(sum(d.current_due), 0)::bigint                                 as current_due_total
  from public.loan_delinquency d
) dq on true;

comment on view public.dashboard_portfolio_summary is
  'One row of business-wide figures, every one aggregated from loans, loan_balances and loan_delinquency. loans_state_* partition the disbursed book exactly; loans_with_arrears/penalised/penalty_pending overlap and are named to say so.';

-- ---------------------------------------------------------------------------
-- Today's collection summary
--
-- A single row for the operational dashboards. The method split answers "what
-- came in by which channel today" and nothing more: it is **payments received**,
-- not a cash position and not a wallet balance. The system has no cash or bank
-- accounting, so a figure called "cash at hand" would be an accounting claim
-- it cannot support. The column names say `_received` for that reason.
-- ---------------------------------------------------------------------------

create view public.dashboard_collection_summary
with (security_invoker = true)
as
select
  public.business_date() as business_date,

  coalesce(sheet.expected_today, 0)::bigint      as expected_today,
  coalesce(sheet.remaining_today, 0)::bigint     as remaining_today,
  coalesce(sheet.loans_due_today, 0)::integer    as loans_due_today,
  coalesce(sheet.clients_due_today, 0)::integer  as clients_due_today,
  coalesce(sheet.loans_settled_today, 0)::integer as loans_settled_today,

  coalesce(reg.collected_today, 0)::bigint       as collected_today,
  coalesce(reg.payments_today, 0)::integer       as payments_today,
  coalesce(reg.clients_paying_today, 0)::integer as clients_paying_today,
  coalesce(reg.cash_received, 0)::bigint         as cash_received,
  coalesce(reg.mtn_received, 0)::bigint          as mtn_received,
  coalesce(reg.airtel_received, 0)::bigint       as airtel_received,
  coalesce(reg.principal_collected, 0)::bigint   as principal_collected,
  coalesce(reg.interest_collected, 0)::bigint    as interest_collected,
  coalesce(reg.penalty_collected, 0)::bigint     as penalty_collected,
  coalesce(reg.reversed_today_amount, 0)::bigint as reversed_today_amount,
  coalesce(reg.reversed_today_count, 0)::integer as reversed_today_count
from (
  select
    sum(ct.expected_today)::bigint                                  as expected_today,
    sum(ct.remaining_today)::bigint                                 as remaining_today,
    count(*)::integer                                               as loans_due_today,
    count(distinct ct.client_id)::integer                           as clients_due_today,
    count(*) filter (where ct.collection_status = 'paid')::integer   as loans_settled_today
  from public.collections_today ct
) sheet
cross join (
  select
    sum(pr.effective_amount)::bigint                                as collected_today,
    count(*) filter (where pr.is_effective)::integer                as payments_today,
    count(distinct pr.client_id) filter (where pr.is_effective)::integer
                                                                    as clients_paying_today,
    sum(pr.effective_amount) filter (where pr.payment_method = 'cash')::bigint
                                                                    as cash_received,
    sum(pr.effective_amount) filter (where pr.payment_method = 'mtn_mobile_money')::bigint
                                                                    as mtn_received,
    sum(pr.effective_amount) filter (where pr.payment_method = 'airtel_money')::bigint
                                                                    as airtel_received,
    sum(pr.principal_collected)::bigint                             as principal_collected,
    sum(pr.interest_collected)::bigint                              as interest_collected,
    sum(pr.penalty_collected)::bigint                               as penalty_collected,
    -- Reversed *today*, by the day the reversal happened, not the day the
    -- payment was taken. A payment from last week withdrawn this morning is
    -- this morning's correction.
    coalesce(sum(pr.amount) filter (
      where pr.status = 'reversed'
        and public.payment_business_date(pr.reversed_at) = public.business_date()
    ), 0)::bigint                                                   as reversed_today_amount,
    count(*) filter (
      where pr.status = 'reversed'
        and public.payment_business_date(pr.reversed_at) = public.business_date()
    )::integer                                                      as reversed_today_count
  from public.payment_register pr
  where pr.business_date = public.business_date()
     or (pr.status = 'reversed'
         and public.payment_business_date(pr.reversed_at) = public.business_date())
) reg;

comment on view public.dashboard_collection_summary is
  'One row for today in the business timezone: the start-of-day target, what has been received, the method split and the components collected. Method figures are payments received, never a cash or wallet position.';

-- ---------------------------------------------------------------------------
-- Privileges
--
-- Supabase's ALTER DEFAULT PRIVILEGES has already granted `anon` and
-- `authenticated` every privilege on each of these views, so each REVOKE must
-- name both before SELECT is granted back. Phase 6 shipped this wrong and the
-- Phase 1 privilege guard caught it; the shape below is the corrected one.
-- ---------------------------------------------------------------------------

revoke all on public.payment_register from public, anon, authenticated;
revoke all on public.collections_today from public, anon, authenticated;
revoke all on public.loan_portfolio_report from public, anon, authenticated;
revoke all on public.dashboard_portfolio_summary from public, anon, authenticated;
revoke all on public.dashboard_collection_summary from public, anon, authenticated;

grant select on public.payment_register to authenticated;
grant select on public.collections_today to authenticated;
grant select on public.loan_portfolio_report to authenticated;
grant select on public.dashboard_portfolio_summary to authenticated;
grant select on public.dashboard_collection_summary to authenticated;
