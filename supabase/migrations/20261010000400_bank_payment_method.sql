-- ===========================================================================
-- Phase 10.4 — Bank, in the dashboard's method split
--
-- Migration 20261010000200 widened `loan_payments.payment_method` to include
-- `bank`, because the ledger needed a fourth cash account and a payment that
-- lands in it. That left one gap: `dashboard_collection_summary` splits
-- today's receipts into cash, MTN and Airtel, so a bank transfer taken today
-- would count in `collected_today` and in none of the method columns. A
-- method split that does not sum to its own total is worse than no split.
--
-- So the view gains `bank_received`, appended last, which is what lets this
-- be a `create or replace` rather than a drop and recreate: the existing
-- columns keep their names, types and order, so nothing that reads the view
-- has to change at the same time.
--
-- The view's own comment is also corrected. It said the system "has no cash
-- or bank accounting, so a figure called 'cash at hand' would be an
-- accounting claim it cannot support". As of 20261010000100 that is no longer
-- true — `branch_cash_position` is exactly that claim, properly supported by
-- a double-entry ledger. The `_received` names still mean what they say,
-- though: a day's receipts by channel, not a balance.
-- ===========================================================================

create or replace view public.dashboard_collection_summary
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
  coalesce(reg.reversed_today_count, 0)::integer as reversed_today_count,
  coalesce(reg.bank_received, 0)::bigint         as bank_received
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
    sum(pr.effective_amount) filter (where pr.payment_method = 'bank')::bigint
                                                                    as bank_received,
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
  'One row for today in the business timezone: the start-of-day target, what has been received, the method split across all four methods and the components collected. Method figures are payments received, never a cash or wallet position — branch_cash_position answers that.';
