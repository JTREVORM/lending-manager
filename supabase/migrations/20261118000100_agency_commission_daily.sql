-- ---------------------------------------------------------------------------
-- Commission, by day, by provider, by account.
--
-- The Owner's decision 3: "Complete the daily commission breakdown by
-- provider, bank account, agent line and reporting period while preserving
-- the earned/received/outstanding separation."
--
-- Client Rule 3 is what makes that separation worth insisting on: "Commission
-- is earned daily. Recognition and receipt are separate events." The existing
-- reporting had the two ends and not the middle — `agency_commission_monthly`
-- gives commission earned per line per calendar month, and
-- `agency_commission_line_balances` gives the standing position per line. What
-- no view answered was "what did this account earn on Tuesday, and what did
-- the provider actually pay us that day".
--
-- ## Why there is no daily "outstanding" column
--
-- Because there is no such figure, and inventing one is the mistake this view
-- exists to avoid. Outstanding is a position, not a flow: it is what the
-- provider owes at a moment, and it moves with every transaction and every
-- settlement whenever they happen. A column headed "outstanding" against a
-- Tuesday would be read as "still owed for Tuesday's business", which no
-- figure here can mean — a settlement on Friday does not pay off Tuesday
-- specifically, it pays down a balance.
--
-- So the daily rows carry the two flows, and a report that wants the position
-- reads `agency_commission_line_balances`, which is the one view that has it.
-- `commission_movement` is given as earned less settled, named as a movement
-- precisely so nobody reads it as a balance.
--
-- ## Why earned comes from the transactions and settled from the journal
--
-- They are different kinds of fact and the honest source differs.
--
-- Earned is recognition, and recognition happens when a transaction posts:
-- one row, one date, one commission figure, whatever model the provider is on.
-- Taking it from `agency_transactions` therefore covers both commission
-- models. A journal-only reading would miss every `immediate` provider
-- entirely, because immediate commission credits income at the counter and
-- never touches 1310 — which is exactly the trap of treating "commission
-- earned" as "1310 debits".
--
-- Settled is receipt, and receipt is a ledger event: a settlement, a payout,
-- a recovery the provider withheld, and the reversal of any of them. Those are
-- four source types and a fifth that undoes them, and the only thing that
-- reconciles them is 1310 itself. So settled is read from the journal, with
-- the agent account resolved through the entry's source exactly as
-- `agency_commission_line_balances` resolves it — because 1310 is shared
-- across every provider, line and branch, and an account-level balance would
-- mix them.
--
-- `commission_at_point_of_sale` is carried separately for the same reason: on
-- an immediate provider, earned and received are one event, and a report that
-- showed those rows as earned-but-unsettled would be reporting a debt that was
-- never owed.
--
-- ## What `commission_settled` cannot include, and why
--
-- Only receipts that name an agent account. `record_agency_commission_payout`
-- and `record_agency_commission_recovery` both take a float account, so their
-- entries attribute. `record_commission_settlement` takes a provider and a
-- branch and leaves `float_account_id` null, because a provider paying one
-- lump sum against a branch's whole position has not told us which counter
-- earned it — and guessing, by apportioning it across accounts, would invent
-- a fact the provider never stated.
--
-- So an unattributed settlement is absent here. That is the same limit
-- `agency_commission_line_balances` has for the same reason, and it is a limit
-- of the data rather than of this view: the figure exists, at provider level,
-- in `agency_commission_summary` and in the settlement register.
--
-- This is why the column must never be presented as "what the provider paid".
-- It is what was settled *to this account*, and a screen or a document that
-- drops those three words would have a reader conclude a paying provider had
-- paid nothing.
--
-- ## What this migration changes
--
-- Nothing. It adds one view over tables that already exist and alters no
-- data, no function and no policy.
-- ---------------------------------------------------------------------------

create or replace view public.agency_commission_daily
with (security_invoker = true) as
with earned as (
  select
    t.transaction_date                            as business_date,
    t.float_account_id,
    count(*)                                      as transactions,
    coalesce(sum(t.principal_amount), 0)::bigint  as principal,
    coalesce(sum(t.customer_fee), 0)::bigint      as customer_fees,
    coalesce(sum(t.commission_amount), 0)::bigint as commission_earned,
    coalesce(sum(
      case when t.commission_model_applied = 'immediate'
           then t.commission_amount else 0 end), 0)::bigint
                                                  as commission_at_point_of_sale
  from public.agency_transactions t
  where t.status = 'posted'
    and t.float_account_id is not null
  group by t.transaction_date, t.float_account_id
),
settled as (
  -- 1310 movements that are receipt rather than recognition: a settlement, a
  -- payout, a recovery, and the reversal of any of them. Credits lower what
  -- the provider owes, so credit less debit is what was settled, and a
  -- reversal nets itself out without a case for each source type.
  select
    e.entry_date                                     as business_date,
    coalesce(s.float_account_id, rc.float_account_id) as float_account_id,
    coalesce(sum(l.credit - l.debit), 0)::bigint      as commission_settled
  from public.journal_lines l
  join public.journal_entries e on e.id = l.entry_id
  join public.ledger_accounts a on a.id = l.account_id
  left join public.agency_commission_settlements s
    on s.id = e.source_id
   and e.source_type in ('agency_commission_settlement',
                         'agency_commission_settlement_reversal',
                         'agency_commission_payout',
                         'agency_commission_payout_reversal')
  left join public.agency_commission_recoveries rc
    on rc.id = e.source_id
   and e.source_type = 'agency_commission_recovery'
  where a.code = '1310'
    and coalesce(s.float_account_id, rc.float_account_id) is not null
  group by e.entry_date, coalesce(s.float_account_id, rc.float_account_id)
)
select
  coalesce(earned.business_date, settled.business_date)       as business_date,
  f.id                                                        as float_account_id,
  f.provider_id,
  p.code                                                      as provider_code,
  p.name                                                      as provider_name,
  p.category                                                  as provider_category,
  f.branch_id,
  b.branch_code,
  b.name                                                      as branch_name,
  f.till_name,
  nullif(f.label, '')                                         as label,
  f.agent_code,
  public.mask_msisdn(f.line_msisdn)                           as line_msisdn_masked,
  coalesce(earned.transactions, 0)                            as transactions,
  coalesce(earned.principal, 0)::bigint                       as principal,
  coalesce(earned.customer_fees, 0)::bigint                   as customer_fees,
  coalesce(earned.commission_earned, 0)::bigint               as commission_earned,
  coalesce(earned.commission_at_point_of_sale, 0)::bigint     as commission_at_point_of_sale,
  coalesce(settled.commission_settled, 0)::bigint             as commission_settled,
  -- A movement, never a balance. See the note above on why there is no daily
  -- "outstanding".
  (coalesce(earned.commission_earned, 0)
     - coalesce(earned.commission_at_point_of_sale, 0)
     - coalesce(settled.commission_settled, 0))::bigint       as commission_movement
from earned
full outer join settled
  on settled.business_date = earned.business_date
 and settled.float_account_id = earned.float_account_id
join public.agency_provider_float_accounts f
  on f.id = coalesce(earned.float_account_id, settled.float_account_id)
join public.agency_service_providers p on p.id = f.provider_id
join public.branches b on b.id = f.branch_id;

comment on view public.agency_commission_daily is
  'Polytos Agency redesign, the Owner''s decision 3 and client Rule 3. One row per business date per agent account — a bank agent account or a Mobile Money line: commission earned that day, how much of it was taken at the point of sale, and what the provider actually settled that day. Earned comes from the posted transactions, so it covers both commission models; settled comes from GL 1310, attributed through each entry''s source, so it covers settlements, payouts, recoveries and reversals. There is deliberately no daily outstanding column: outstanding is a position and belongs to agency_commission_line_balances, so what is given here is a movement. commission_settled counts only receipts that name an agent account — payouts and recoveries — because a provider-level settlement names a provider and a branch and apportioning it across accounts would invent a fact the provider never stated; those are in agency_commission_summary and the settlement register.';

revoke all on public.agency_commission_daily from anon, authenticated;
grant select on public.agency_commission_daily to authenticated;
