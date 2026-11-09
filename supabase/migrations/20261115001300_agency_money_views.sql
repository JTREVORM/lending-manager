-- ===========================================================================
-- Phase 4E — what the screens read
--
-- Six views and two extensions, all `security_invoker` so the caller's own RLS
-- decides what they see, and all read-only: no screen in this phase reaches a
-- table directly to write.
--
-- ## The one that is easy to get wrong
--
-- `agency_mobile_money_consolidated` adds up a provider's business across its
-- lines, and a line-to-line transfer is the trap. A transfer debits one 1320
-- account and credits another, so consolidated float does not move — but a
-- naive "float in" and "float out" would count the same 300,000 twice, once
-- on each side, and report 600,000 of activity that never happened. Transfers
-- therefore get their own two columns and are excluded from the purchase and
-- sale totals. Balances are never summed across providers either: MTN float
-- and Airtel float are different instruments held with different companies,
-- and one number covering both answers no question anybody has.
--
-- ## Every aggregate is cast back to bigint
--
-- `sum()` over a `bigint` returns `numeric`, and this schema admits no
-- `numeric` money column anywhere: `tests/db/schema.test.ts` fails the build
-- on `real`, `double precision`, `money` **and** `numeric` across the whole of
-- `public`, which is how seventeen of these columns were caught before they
-- reached a screen. Integer money is ADR-002, and a view is not an exemption
-- from it.
--
-- ## Per line, because that is the unit the business runs
--
-- Decision OD-9 reconciles a statement per agent line; OD-7 records a trade
-- per line; the commission payout is attributed per line. So every view here
-- carries `float_account_id` and the line's label, and
-- `agency_transaction_history` finally does too — without it the transaction
-- register could not be filtered to the line whose statement is being read.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- 1. Commission, per agent line
--
-- Earned, received, recovered and still outstanding, each derived from the
-- ledger through the same attribution the engine uses, so a screen and a
-- refusal can never disagree about what a line is owed.
-- ---------------------------------------------------------------------------

create or replace view public.agency_commission_by_line
with (security_invoker = true) as
select
  f.id                                     as float_account_id,
  f.provider_id,
  p.code                                   as provider_code,
  p.name                                   as provider_name,
  f.branch_id,
  b.branch_code,
  f.till_name,
  nullif(f.label, '')                      as label,
  f.status                                 as line_status,
  a.code                                   as ledger_account_code,
  coalesce(bal.balance, 0)                 as float_balance,
  public.agency_commission_outstanding_by_line(f.id)          as commission_outstanding,
  public.agency_commission_recovery_outstanding_by_line(f.id) as recovery_owed
from public.agency_provider_float_accounts f
join public.agency_service_providers p on p.id = f.provider_id
join public.branches b on b.id = f.branch_id
join public.ledger_accounts a on a.id = f.ledger_account_id
left join public.ledger_account_balances bal on bal.account_id = f.ledger_account_id;

comment on view public.agency_commission_by_line is
  'Phase 4E. One row per agent line: its float balance, the commission the provider still owes it, and the commission it owes back. Both figures come from the same functions the posting refusals use, so a screen cannot promise what a refusal would deny.';

revoke all on public.agency_commission_by_line from anon, authenticated;
grant select on public.agency_commission_by_line to authenticated;


-- ---------------------------------------------------------------------------
-- 2. Commission by calendar month (decision OD-9's third part)
--
-- The statement period is what gets reconciled; the calendar month is what
-- management reads. Keeping them separate means neither has to pretend to be
-- the other — a provider whose statement runs the 26th to the 25th does not
-- make the monthly report wrong.
--
-- Africa/Kampala throughout: `transaction_date` is already a business date in
-- that frame by ADR-004, so truncating it needs no conversion.
-- ---------------------------------------------------------------------------

create or replace view public.agency_commission_monthly
with (security_invoker = true) as
select
  t.float_account_id,
  f.provider_id,
  p.code                                   as provider_code,
  p.name                                   as provider_name,
  t.branch_id,
  f.till_name,
  nullif(f.label, '')                      as label,
  -- The first of the month by date arithmetic, not by casting through a
  -- timestamp: a bare `timestamp` means "whatever zone the reader assumes",
  -- which tests/integration/migrations.test.ts forbids anywhere in a
  -- migration, and a business date has no zone to convert through anyway.
  pg_catalog.make_date(
    pg_catalog.date_part('year', t.transaction_date)::integer,
    pg_catalog.date_part('month', t.transaction_date)::integer,
    1)                                     as month_start,
  count(*)                                 as transactions,
  coalesce(sum(t.principal_amount), 0)::bigint  as principal,
  coalesce(sum(t.customer_fee), 0)::bigint      as customer_fees,
  coalesce(sum(t.commission_amount), 0)::bigint as commission_earned
from public.agency_transactions t
join public.agency_provider_float_accounts f on f.id = t.float_account_id
join public.agency_service_providers p on p.id = f.provider_id
where t.status = 'posted'
  and t.float_account_id is not null
group by t.float_account_id, f.provider_id, p.code, p.name, t.branch_id,
         f.till_name, f.label,
         pg_catalog.make_date(
           pg_catalog.date_part('year', t.transaction_date)::integer,
           pg_catalog.date_part('month', t.transaction_date)::integer,
           1);

comment on view public.agency_commission_monthly is
  'Phase 4E, decision OD-9. Commission and volume per agent line per calendar month in Africa/Kampala, kept separate from the provider statement periods that are reconciled, because a statement that runs the 26th to the 25th must not distort the monthly report.';

revoke all on public.agency_commission_monthly from anon, authenticated;
grant select on public.agency_commission_monthly to authenticated;


-- ---------------------------------------------------------------------------
-- 3. The commission reconciliation register
-- ---------------------------------------------------------------------------

create or replace view public.agency_commission_reconciliation_register
with (security_invoker = true) as
select
  r.id,
  r.provider_id,
  p.code              as provider_code,
  p.name              as provider_name,
  r.branch_id,
  b.branch_code,
  r.float_account_id,
  f.till_name,
  nullif(f.label, '') as label,
  r.period_start,
  r.period_end,
  r.system_commission_earned,
  r.provider_reported_commission,
  r.variance,
  case
    when r.variance = 0 then 'our books and the statement agree'
    when r.variance > 0 then 'the provider reports more than we recognised'
    else 'we recognised more than the provider reports'
  end                 as variance_means,
  r.statement_ref,
  r.status,
  r.notes,
  r.created_by,
  r.created_at,
  r.reconciled_by,
  r.reconciled_at,
  -- What the same period says now. A difference from the snapshot means a
  -- transaction in the period has been reversed or corrected since.
  public.agency_commission_earned_by_line(r.float_account_id, r.period_start, r.period_end)
                      as current_system_earned
from public.agency_commission_reconciliations r
join public.agency_service_providers p on p.id = r.provider_id
join public.branches b on b.id = r.branch_id
join public.agency_provider_float_accounts f on f.id = r.float_account_id;

comment on view public.agency_commission_reconciliation_register is
  'Phase 4E. Every provider statement period reconciled against the books, with what the difference means in words and what the same period says now — a gap between the snapshot and the current figure means a transaction in it has since been reversed or corrected.';

revoke all on public.agency_commission_reconciliation_register from anon, authenticated;
grant select on public.agency_commission_reconciliation_register to authenticated;


-- ---------------------------------------------------------------------------
-- 4. The float trade register
-- ---------------------------------------------------------------------------

create or replace view public.agency_float_trade_register
with (security_invoker = true) as
select
  tr.id,
  tr.kind,
  tr.provider_id,
  p.code                       as provider_code,
  p.name                       as provider_name,
  tr.branch_id,
  b.branch_code,
  tr.float_account_id,
  f.till_name,
  nullif(f.label, '')          as label,
  tr.counter_float_account_id,
  cf.till_name                 as counter_till_name,
  nullif(cf.label, '')         as counter_label,
  tr.counter_branch_id,
  cb.branch_code               as counter_branch_code,
  tr.settlement_account_id,
  sa.code                      as settlement_account_code,
  sa.name                      as settlement_account_name,
  tr.trade_date,
  tr.float_amount,
  tr.cash_amount,
  tr.fee_amount,
  -- What the trade came to in total, and what the difference on a purchase
  -- means, so a reader does not have to subtract two columns to find out
  -- whether a premium was paid.
  case tr.kind
    when 'purchase' then tr.cash_amount
    when 'sale'     then tr.float_amount + tr.fee_amount
    else tr.float_amount
  end                          as total_amount,
  case
    when tr.kind <> 'purchase' then null
    when tr.cash_amount = tr.float_amount then 'face value'
    when tr.cash_amount > tr.float_amount then 'premium paid'
    else 'discount received'
  end                          as purchase_basis,
  case
    when tr.kind = 'purchase' then tr.cash_amount - tr.float_amount
    else null
  end                          as purchase_difference,
  tr.source_kind,
  tr.counterparty_name,
  tr.reference,
  tr.notes,
  tr.status,
  tr.revision,
  tr.created_by,
  tr.created_at,
  tr.verified_by,
  tr.verified_at,
  tr.rejected_reason,
  tr.journal_entry_id,
  tr.reversal_entry_id,
  tr.reversed_by,
  tr.reversed_at,
  tr.reversal_reason
from public.agency_float_trades tr
join public.agency_service_providers p on p.id = tr.provider_id
join public.branches b on b.id = tr.branch_id
join public.agency_provider_float_accounts f on f.id = tr.float_account_id
left join public.agency_provider_float_accounts cf on cf.id = tr.counter_float_account_id
left join public.branches cb on cb.id = tr.counter_branch_id
left join public.ledger_accounts sa on sa.id = tr.settlement_account_id;

comment on view public.agency_float_trade_register is
  'Phase 4E. Every float purchase, sale and line-to-line transfer, with the total it came to and — for a purchase — whether it was at face value, a premium or a discount, so a reader need not subtract two columns to find out.';

revoke all on public.agency_float_trade_register from anon, authenticated;
grant select on public.agency_float_trade_register to authenticated;


-- ---------------------------------------------------------------------------
-- 5. The per-line operational dashboard
--
-- One row per agent line, which is what an MTN or an Airtel screen shows.
-- Today's figures and the line's standing obligations in one place, because
-- the question a supervisor asks at a counter is "is this line all right",
-- and that needs the float, what is owed, what is pending and what is
-- unreconciled at once.
-- ---------------------------------------------------------------------------

create or replace view public.agency_mobile_money_dashboard
with (security_invoker = true) as
select
  l.float_account_id,
  l.provider_id,
  l.provider_code,
  l.provider_name,
  l.branch_id,
  l.branch_code,
  l.till_name,
  l.label,
  l.line_status,
  l.ledger_account_code,
  l.float_balance,
  l.commission_outstanding,
  l.recovery_owed,
  coalesce(today.deposits, 0)          as deposits_today,
  coalesce(today.deposit_value, 0)::bigint     as deposit_value_today,
  coalesce(today.withdrawals, 0)       as withdrawals_today,
  coalesce(today.withdrawal_value, 0)::bigint  as withdrawal_value_today,
  coalesce(today.commission, 0)::bigint        as commission_today,
  coalesce(today.fees, 0)::bigint              as customer_fees_today,
  coalesce(pending.trades, 0)          as pending_trades,
  coalesce(inflight.transactions, 0)   as transactions_in_flight,
  coalesce(openrec.reconciliations, 0) as open_commission_reconciliations
from public.agency_commission_by_line l
left join (
  select t.float_account_id,
         count(*) filter (where ty.direction = 'deposit')    as deposits,
         coalesce(sum(t.principal_amount) filter (where ty.direction = 'deposit'), 0)
                                                            as deposit_value,
         count(*) filter (where ty.direction = 'withdrawal') as withdrawals,
         coalesce(sum(t.principal_amount) filter (where ty.direction = 'withdrawal'), 0)
                                                            as withdrawal_value,
         coalesce(sum(t.commission_amount), 0)              as commission,
         coalesce(sum(t.customer_fee), 0)                   as fees
    from public.agency_transactions t
    join public.agency_transaction_types ty on ty.id = t.transaction_type_id
   where t.status = 'posted'
     and t.transaction_date = public.business_date()
   group by t.float_account_id
) today on today.float_account_id = l.float_account_id
left join (
  select tr.float_account_id, count(*) as trades
    from public.agency_float_trades tr
   where tr.status = 'pending'
   group by tr.float_account_id
) pending on pending.float_account_id = l.float_account_id
left join (
  select t.float_account_id, count(*) as transactions
    from public.agency_transactions t
   where t.status in ('draft', 'awaiting_verification')
   group by t.float_account_id
) inflight on inflight.float_account_id = l.float_account_id
left join (
  select r.float_account_id, count(*) as reconciliations
    from public.agency_commission_reconciliations r
   where r.status = 'open'
   group by r.float_account_id
) openrec on openrec.float_account_id = l.float_account_id;

comment on view public.agency_mobile_money_dashboard is
  'Phase 4E. One row per agent line: float, commission owed either way, today''s deposits, withdrawals, commission and fees, and the work outstanding on it — pending trades, transactions in flight, unreconciled statement periods. The provider-scoped screens read this filtered by provider code, so MTN and Airtel are data rather than two hardcoded pages.';

revoke all on public.agency_mobile_money_dashboard from anon, authenticated;
grant select on public.agency_mobile_money_dashboard to authenticated;


-- ---------------------------------------------------------------------------
-- 6. Consolidated, without double-counting a transfer
-- ---------------------------------------------------------------------------

create or replace view public.agency_mobile_money_consolidated
with (security_invoker = true) as
select
  p.id                                   as provider_id,
  p.code                                 as provider_code,
  p.name                                 as provider_name,
  b.id                                   as branch_id,
  b.branch_code,
  count(distinct f.id)                   as agent_lines,
  count(distinct f.id) filter (where f.status = 'active')    as active_lines,
  count(distinct f.id) filter (where f.status = 'suspended') as suspended_lines,
  coalesce(sum(bal.balance), 0)::bigint  as float_held,
  coalesce(sum(public.agency_commission_outstanding_by_line(f.id)), 0)::bigint
                                         as commission_outstanding,
  coalesce(sum(public.agency_commission_recovery_outstanding_by_line(f.id)), 0)::bigint
                                         as recovery_owed,
  -- Purchases and sales are the provider's float coming in and going out.
  coalesce(sum(tr.purchased), 0)::bigint as float_purchased,
  coalesce(sum(tr.purchase_premium), 0)::bigint  as purchase_premium,
  coalesce(sum(tr.purchase_discount), 0)::bigint as purchase_discount,
  coalesce(sum(tr.sold), 0)::bigint      as float_sold,
  coalesce(sum(tr.sale_fees), 0)::bigint as sale_fee_income,
  -- Transfers in their own columns, and excluded from the two above. A
  -- transfer moves float between two of this provider's own lines, so adding
  -- it to either total would report activity that never happened — twice,
  -- once from each side.
  coalesce(sum(tr.transferred_out), 0)::bigint   as float_transferred_out,
  coalesce(sum(tr.transferred_in), 0)::bigint    as float_transferred_in
from public.agency_service_providers p
join public.agency_provider_float_accounts f on f.provider_id = p.id
join public.branches b on b.id = f.branch_id
left join public.ledger_account_balances bal on bal.account_id = f.ledger_account_id
left join (
  select f2.id as float_account_id,
         coalesce(sum(t.float_amount) filter (where t.kind = 'purchase'
                      and t.float_account_id = f2.id), 0) as purchased,
         coalesce(sum(greatest(t.cash_amount - t.float_amount, 0))
                      filter (where t.kind = 'purchase'
                              and t.float_account_id = f2.id), 0) as purchase_premium,
         coalesce(sum(greatest(t.float_amount - t.cash_amount, 0))
                      filter (where t.kind = 'purchase'
                              and t.float_account_id = f2.id), 0) as purchase_discount,
         coalesce(sum(t.float_amount) filter (where t.kind = 'sale'
                      and t.float_account_id = f2.id), 0) as sold,
         coalesce(sum(t.fee_amount) filter (where t.kind = 'sale'
                      and t.float_account_id = f2.id), 0) as sale_fees,
         coalesce(sum(t.float_amount) filter (where t.kind = 'transfer'
                      and t.float_account_id = f2.id), 0) as transferred_out,
         coalesce(sum(t.float_amount) filter (where t.kind = 'transfer'
                      and t.counter_float_account_id = f2.id), 0) as transferred_in
    from public.agency_provider_float_accounts f2
    join public.agency_float_trades t
      on t.float_account_id = f2.id or t.counter_float_account_id = f2.id
   where t.status = 'posted'
   group by f2.id
) tr on tr.float_account_id = f.id
where p.float_model = 'provider_float'
group by p.id, p.code, p.name, b.id, b.branch_code;

comment on view public.agency_mobile_money_consolidated is
  'Phase 4E. One row per provider per branch: lines, float held, commission owed either way, float bought and sold with the premium and discount on purchases, and fee income. Transfers between the provider''s own lines are reported in their own two columns and excluded from the purchase and sale totals, because a transfer moves no float in or out and counting it on both sides would report twice an amount that never moved at all. Balances are never summed across providers.';

revoke all on public.agency_mobile_money_consolidated from anon, authenticated;
grant select on public.agency_mobile_money_consolidated to authenticated;


-- ---------------------------------------------------------------------------
-- 7. The transaction register learns which line it was on
--
-- Replaced rather than extended because a view's column list is its contract;
-- every existing column keeps its name, position and meaning, and three are
-- added at the end.
-- ---------------------------------------------------------------------------

create or replace view public.agency_transaction_history
with (security_invoker = true) as
select
  t.id,
  t.branch_id,
  b.branch_code,
  t.provider_id,
  p.code  as provider_code,
  p.name  as provider_name,
  ty.code as type_code,
  ty.name as type_name,
  ty.direction,
  t.transaction_date,
  t.status,
  t.principal_amount,
  t.customer_fee,
  t.commission_amount,
  t.commission_computed,
  t.commission_supplied,
  t.commission_exception_reason,
  t.customer_identifier,
  t.provider_reference,
  t.journal_entry_id,
  t.reversal_entry_id,
  t.submitted_by,
  t.verified_by,
  t.created_at,
  t.revision,
  -- Phase 4E.
  t.float_account_id,
  f.till_name,
  nullif(f.label, '') as label,
  t.customer_fee_mode,
  t.transacted_at
from public.agency_transactions t
join public.agency_service_providers p on p.id = t.provider_id
join public.agency_transaction_types ty on ty.id = t.transaction_type_id
join public.branches b on b.id = t.branch_id
left join public.agency_provider_float_accounts f on f.id = t.float_account_id;

comment on view public.agency_transaction_history is
  'Phase 4A, extended in Phase 4E. The transaction register, now carrying the agent line a transaction was on, the fee mode and the instant the provider recorded it — without the line, the register could not be filtered to the line whose statement is being reconciled.';

revoke all on public.agency_transaction_history from anon, authenticated;
grant select on public.agency_transaction_history to authenticated;


-- ---------------------------------------------------------------------------
-- 8. Three more end-of-day exceptions
--
-- Decision OD-2 says a reconciliation variance must stay visible until it is
-- properly resolved, and certification does not resolve it — it records that
-- two people have seen it. So a certified reconciliation with a non-zero
-- variance is an exception, and stays one.
-- ---------------------------------------------------------------------------

create or replace view public.agency_end_of_day_exceptions
with (security_invoker = true) as
select 'unverified_transaction'::text as exception_kind,
       t.branch_id, t.transaction_date as as_of_date, t.id as subject_id,
       p.name as provider_name, t.principal_amount as amount, t.status as detail
  from public.agency_transactions t
  join public.agency_service_providers p on p.id = t.provider_id
 where t.status = any (array['draft', 'awaiting_verification'])
union all
select 'open_reconciliation'::text, r.branch_id, r.reconciliation_date, r.id,
       null::text, r.variance, 'cash count awaiting approval'::text
  from public.agency_cash_reconciliations r where r.status = 'open'
union all
select 'open_reconciliation'::text, r.branch_id, r.reconciliation_date, r.id,
       p.name, r.variance, 'float statement awaiting approval'::text
  from public.agency_float_reconciliations r
  left join public.agency_service_providers p on p.id = r.provider_id
 where r.status = 'open'
union all
select 'unexplained_variance'::text, r.branch_id, r.reconciliation_date, r.id,
       null::text, r.variance, 'cash variance recorded but not written off'::text
  from public.agency_cash_reconciliations r
 where r.status = 'reconciled' and r.variance <> 0 and r.variance_written_off = 0
union all
select 'unexplained_variance'::text, r.branch_id, r.reconciliation_date, r.id,
       p.name, r.variance, 'float variance recorded but not written off'::text
  from public.agency_float_reconciliations r
  left join public.agency_service_providers p on p.id = r.provider_id
 where r.status = 'reconciled' and r.variance <> 0 and r.variance_written_off = 0
union all
select 'float_exhausted'::text, v.branch_id, null::date, v.float_account_id,
       v.provider_name, v.balance, 'float till is empty'::text
  from public.agency_float_balances v
 where v.till_is_active and v.provider_is_active and v.balance <= 0
-- Phase 4E.
union all
select 'pending_float_trade'::text, tr.branch_id, tr.trade_date, tr.id,
       p.name,
       case tr.kind when 'purchase' then tr.cash_amount
                    when 'sale' then tr.float_amount + tr.fee_amount
                    else tr.float_amount end,
       ('float ' || tr.kind || ' awaiting verification')::text
  from public.agency_float_trades tr
  join public.agency_service_providers p on p.id = tr.provider_id
 where tr.status = 'pending'
union all
select 'open_reconciliation'::text, r.branch_id, r.period_end, r.id,
       p.name, r.variance, 'commission statement awaiting certification'::text
  from public.agency_commission_reconciliations r
  join public.agency_service_providers p on p.id = r.provider_id
 where r.status = 'open'
union all
select 'unexplained_variance'::text, r.branch_id, r.period_end, r.id,
       p.name, r.variance,
       'commission difference certified but not resolved'::text
  from public.agency_commission_reconciliations r
  join public.agency_service_providers p on p.id = r.provider_id
 where r.status = 'certified' and r.variance <> 0;

comment on view public.agency_end_of_day_exceptions is
  'Phase 4C, extended in Phase 4E. Everything unresolved at the end of a day: transactions not yet verified, reconciliations awaiting approval, variances recorded but not written off, empty float tills, float trades awaiting verification, and commission differences that survived certification. A certified commission variance stays here, because certification records that two people saw a difference and decision OD-2 forbids the reconciliation from resolving it by itself.';

revoke all on public.agency_end_of_day_exceptions from anon, authenticated;
grant select on public.agency_end_of_day_exceptions to authenticated;
