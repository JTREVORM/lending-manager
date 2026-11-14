-- ===========================================================================
-- Polytos Agency redesign — the provider's category, and the line's identity,
-- on the views the screens already read
--
-- ## Why this migration exists
--
-- The client's confirmed requirements put Agent Banking and Mobile Money in
-- two separate operational modules. The schema has carried the distinction
-- since Phase 4A: `agency_service_providers.category` is `agency_banking`,
-- `mobile_money`, `utility`, `school_fees`, `tv_subscription`,
-- `airtime_data` or `other`, and the provisional catalogue already files
-- MTN_MOMO and AIRTEL_MONEY as `mobile_money` and STANBIC as
-- `agency_banking`.
--
-- What the *views* carry is the problem. `agency_commission_by_line`,
-- `agency_mobile_money_dashboard` and `agency_mobile_money_consolidated` each
-- select the provider's id, code and name and stop there. A screen that wants
-- "every bank agent account" therefore cannot ask for one: it would have to
-- read the provider table separately and re-join in TypeScript, or — far
-- worse, and the thing this migration exists to prevent — hard-code the list
-- of codes that count as banks. Both are how `STANBIC` becomes the only bank
-- the application can ever have.
--
-- So the category travels with the row. Then "Agent Banking" is
-- `category = 'agency_banking'`, "MTN Mobile Money" is one provider code
-- inside `category = 'mobile_money'`, and a bank the Owner registers next
-- year appears in the banking module with no code change at all.
--
-- ## And the line's own identity
--
-- `20261115000200` gave `agency_provider_float_accounts` a `label`, a
-- `line_msisdn`, an `agent_code`, an `opened_on` and a `closed_on`. Only
-- `label` reached the views. The per-line operational page the requirements
-- ask for ("Line name or masked phone number, Provider, Branch, Current
-- float…") needs the rest, and a per-account banking page needs the agent
-- code because that is what the bank prints on its statement.
--
-- `line_msisdn` is exposed **masked**, and only masked. The full number is in
-- the table for the people who administer a line and is reachable through the
-- administration path that already guards `agency:providers`; a reporting view
-- that any `authenticated` reader may select has no business handing out a
-- complete agent MSISDN, and every screen in this redesign displays the
-- masked form anyway.
--
-- ## Forward-only, and additive by construction
--
-- `create or replace view` may only *append* columns — it refuses to rename,
-- reorder or retype an existing one. Every definition below is therefore the
-- definition now in the database with new columns added at the end, so the
-- existing readers (`lib/data/agency.ts`, seven screens, the Phase 4E
-- database suite) are untouched by construction rather than by inspection.
--
-- No existing migration is edited. No data is written. No policy is relaxed:
-- all three views keep `security_invoker = true`, so the reader's own branch
-- rule and ledger permission still decide which rows come back.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- 1. Masking an agent MSISDN
--
-- `+256771234567` becomes `+256 77 *** 4567`: the country and network
-- prefix, which is what tells MTN from Airtel on sight, and the last four,
-- which is what a supervisor reads back to confirm they are looking at the
-- right line. The six digits in between are the ones that would let somebody
-- dial it.
--
-- IMMUTABLE and not SECURITY DEFINER: it is a pure string function over its
-- argument, so it may be inlined into a view and indexed if that is ever
-- wanted, and it holds no privilege of its own.
-- ---------------------------------------------------------------------------

create or replace function public.mask_msisdn(p_msisdn text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when p_msisdn is null then null
    when p_msisdn !~ '^\+256[0-9]{9}$' then null
    else pg_catalog.concat(
           '+256 ',
           pg_catalog.substr(p_msisdn, 5, 2),
           ' *** ',
           pg_catalog.substr(p_msisdn, 10, 4)
         )
  end;
$$;

comment on function public.mask_msisdn(text) is
  'Polytos Agency redesign. A +256 number as +256 77 *** 4567: the network prefix and the last four digits, which is what identifies a line to a person, without the six digits that would let them dial it. Returns NULL for NULL and for anything that is not a +256 number of this schema''s shape, so a malformed row can never leak through unmasked.';

revoke all on function public.mask_msisdn(text) from public;
grant execute on function public.mask_msisdn(text) to authenticated;


-- ---------------------------------------------------------------------------
-- 2. `agency_commission_by_line` + category and identity
--
-- The base of both screens below. Thirteen columns as it stands, in the order
-- `20261115001400` left them; six appended.
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
  coalesce(cb.commission_outstanding, 0)   as commission_outstanding,
  coalesce(cb.recovery_owed, 0)            as recovery_owed,
  -- Appended below this line.
  p.category                               as provider_category,
  public.mask_msisdn(f.line_msisdn)        as line_msisdn_masked,
  f.agent_code,
  f.opened_on,
  f.closed_on,
  b.name                                   as branch_name
from public.agency_provider_float_accounts f
join public.agency_service_providers p on p.id = f.provider_id
join public.branches b on b.id = f.branch_id
join public.ledger_accounts a on a.id = f.ledger_account_id
left join public.ledger_account_balances bal on bal.account_id = f.ledger_account_id
left join public.agency_commission_line_balances cb on cb.float_account_id = f.id;

comment on view public.agency_commission_by_line is
  'Phase 4E, extended by the Agency redesign. One row per agent line — a bank agent account or a Mobile Money line, which are the same structure under two names: its float balance, the commission the provider still owes it, and the commission it owes back. provider_category is what separates the Agent Banking module from the Mobile Money module, so neither has to hard-code a provider code. line_msisdn_masked is masked in the view and nowhere unmasked: the full number is in agency_provider_float_accounts, behind the administration path that guards agency:providers.';


-- ---------------------------------------------------------------------------
-- 3. The per-line dashboard + the same six columns
--
-- Named for Mobile Money and never restricted to it: the view joins
-- `agency_commission_by_line` over every float account, whatever its
-- provider's category, which is exactly why one screen can serve a bank agent
-- account and an MTN line. The redesign reads it through a
-- `provider_category` filter rather than renaming a view that carries tested
-- readers.
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
  coalesce(openrec.reconciliations, 0) as open_commission_reconciliations,
  -- Appended below this line.
  l.provider_category,
  l.line_msisdn_masked,
  l.agent_code,
  l.opened_on,
  l.closed_on,
  l.branch_name,
  -- The count a per-line page leads with that the line balances cannot give:
  -- how many transactions this line has posted today in total. Deposits plus
  -- withdrawals is not it — a provider may support a bill payment too, and
  -- `agency_transaction_types.direction` admits `payment` and `transfer`.
  coalesce(today.transactions, 0)      as transactions_today
from public.agency_commission_by_line l
left join (
  select t.float_account_id,
         count(*)                                           as transactions,
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
  'Phase 4E, extended by the Agency redesign. One row per agent line, whatever its provider''s category: float, commission owed either way, today''s deposits, withdrawals, transactions, commission and fees, and the work outstanding on it. The Agent Banking screens read it filtered to provider_category = agency_banking and the Mobile Money screens to a single mobile_money provider code, so a bank agent account and an MTN line share one tested aggregation instead of two that would drift.';


-- ---------------------------------------------------------------------------
-- 4. The consolidated per-provider roll-up + its category
--
-- The body below is the definition `20261115001300` created, verbatim, with
-- one column appended to the select list and `p.category` added to the GROUP
-- BY. Nothing else is touched, so the "a transfer is not a purchase and not a
-- sale" rule keeps counting exactly what it counted before and the Phase 4E
-- assertions over this view keep passing unchanged.
--
-- ## What this view does NOT cover, and why that matters to the redesign
--
-- `where p.float_model = 'provider_float'` — a provider that holds the
-- customer's cash and owes it onward (`cash_payable`) has no electronic float
-- to roll up, so it was correctly excluded. The provisional STANBIC row is
-- `cash_payable`, which means **no bank appears in this view today**.
--
-- The client's Rule 2 says banks do supply electronic float. That is a change
-- to STANBIC's commercial configuration, not to this view, and it is the
-- Owner's to make and approve — a migration that silently rewrote a
-- provider's float model would be exactly the "activate a provider without
-- its commercial configuration being approved" that is forbidden. So the
-- banking screens in this redesign read the per-line view above, which is
-- float-model agnostic, and this roll-up starts reporting banks the moment a
-- bank is configured to hold float.
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
  coalesce(sum(tr.transferred_in), 0)::bigint    as float_transferred_in,
  -- Appended by the Agency redesign: what separates a bank from a Mobile
  -- Money provider, so the consolidated report can split the two without
  -- re-reading the provider table or naming a single provider code.
  p.category                             as provider_category
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
group by p.id, p.code, p.name, p.category, b.id, b.branch_code;

comment on view public.agency_mobile_money_consolidated is
  'Phase 4E, extended by the Agency redesign. One row per provider_float provider per branch. provider_category lets the consolidated Agency report split Agent Banking from Mobile Money without re-reading the provider table. A transfer stays in its own two columns and out of float_purchased and float_sold, because a transfer between two of one provider''s lines moves no float into or out of the provider and counting it on both sides would report twice an amount that never moved. A cash_payable provider is absent by design: it holds no electronic float, and its position is in agency_payable_summary.';
