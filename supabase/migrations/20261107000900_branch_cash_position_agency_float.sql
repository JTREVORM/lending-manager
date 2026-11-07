-- ===========================================================================
-- Phase 4A — `branch_cash_position` accounts for agency float
--
-- ## The defect this repairs, which Phase 4A itself introduced
--
-- `branch_cash_position` reports four named components — cash at hand, MTN,
-- Airtel, bank — and a `total_liquidity` that is **not** filtered by kind:
--
--   coalesce(sum(bal.balance), 0) as total_liquidity
--
-- joined over `bal.cash_kind is not null`. While there were exactly four
-- kinds, the four components summed to the total by construction. Migration
-- `20261107000100` added a fifth, so the moment a branch holds any agency
-- float the total exceeds its own parts and the screen silently stops adding
-- up.
--
-- This is not hypothetical. It is asserted in three places that all failed
-- when float accounts first existed: `money-movement.test.ts` ("leaves
-- liquidity unchanged", "agrees with branch_cash_position after every
-- movement"), `ledger-posting.test.ts` ("balances the trial balance, the
-- branch position and Loans Receivable"), and the financial reconciliation
-- harness identity "total liquidity is the sum of its parts".
--
-- ## Why float is counted rather than excluded
--
-- Two repairs were possible: give float its own component, or filter it out of
-- the total.
--
-- Filtering it out would have broken the *other* identity the harness walks —
-- "total liquidity agrees with every cash GL account" — because the general
-- ledger would hold a cash-kinded asset the cash position refused to show.
-- One of the two identities has to give, and this is the one that should not:
-- a cash position that disagrees with the general ledger is the failure mode
-- the harness exists to catch.
--
-- And on the merits, float belongs in liquidity. It is an asset the company
-- holds and can spend to serve a customer, no less than the balance in its
-- bank account, which this view has always counted. What it must not be is
-- *invisible inside a total*, which is exactly what it was for one migration.
--
-- So it becomes its own column. Both identities hold again, the four existing
-- components keep their meaning, and anybody reading the screen can see float
-- separately from till cash.
--
-- The view is replaced in place, so its `security_invoker = true` setting and
-- its grants are untouched. `create or replace view` can only *append* a
-- column — it refuses to insert one, because that would rename the columns
-- after it — so `agency_float` goes last, after `total_liquidity`. Every
-- existing column keeps its name, type and position, and nothing reads this
-- view positionally.
-- ===========================================================================

create or replace view public.branch_cash_position with (security_invoker = true) as
select
  b.id as branch_id,
  b.branch_code,
  b.name as branch_name,
  b.status as branch_status,
  coalesce(pg_catalog.sum(bal.balance) filter (where bal.cash_kind = 'cash_at_hand'), 0)::bigint
    as cash_at_hand,
  coalesce(pg_catalog.sum(bal.balance) filter (where bal.cash_kind = 'mtn_mobile_money'), 0)::bigint
    as mtn_mobile_money,
  coalesce(pg_catalog.sum(bal.balance) filter (where bal.cash_kind = 'airtel_money'), 0)::bigint
    as airtel_money,
  coalesce(pg_catalog.sum(bal.balance) filter (where bal.cash_kind = 'bank'), 0)::bigint
    as cash_at_bank,
  coalesce(pg_catalog.sum(bal.balance), 0)::bigint as total_liquidity,
  -- Phase 4A. The fifth kind, as its own line so the parts still sum to the
  -- total. Electronic float held with an agency provider, across every till at
  -- this branch. Appended rather than inserted, for the reason in the header.
  coalesce(pg_catalog.sum(bal.balance) filter (where bal.cash_kind = 'agency_float'), 0)::bigint
    as agency_float
from public.branches b
left join public.ledger_account_balances bal
  on bal.branch_id = b.id and bal.cash_kind is not null
group by b.id;

comment on view public.branch_cash_position is
  'Phase 10, extended in Phase 4A. Where the company''s money is, by branch: till cash, the two mobile money wallets, the bank, agency float, and the total of all five. total_liquidity is every account with a cash_kind, so it equals the sum of the five components and equals the general ledger — both identities are walked by scripts/certify-financial-reconciliation.mjs.';
