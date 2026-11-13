-- ===========================================================================
-- Phase 4D — four registers the operational screens read.
--
-- The Phase 4C views report: what is outstanding, what moved today, what the
-- variances were. None of them lists the records an officer has to act on -
-- a count waiting for a second signature, a settlement that was recorded by
-- mistake - because Phase 4C had no screens.
--
-- Each of these is a plain join: the record, the provider, branch and ledger
-- account it names, and nothing computed that the database does not already
-- hold. `security_invoker`, so the branch rules on the underlying tables are
-- the branch rules here; a screen reading one of these sees exactly what its
-- officer may see.
--
-- ## The two reconciliation registers carry the current balance
--
-- Approval refuses a count whose account has moved since it was recorded -
-- the variance would no longer describe anything. That refusal is the
-- database's, and it stands whatever a screen does. But a screen that offers
-- an Approve button which is certain to fail is lying to the officer, so both
-- registers carry today's balance beside the recorded one and a flag saying
-- whether they still agree. The flag is read from the same
-- `ledger_account_balances` row the approval function locks and compares, so
-- the screen and the database are never describing different things - though
-- the screen's reading is a moment older, which is why the button it enables
-- is a courtesy and the refusal is the control.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- 1. Physical cash counts
-- ---------------------------------------------------------------------------

create view public.agency_cash_reconciliation_register
with (security_invoker = true) as
select
  r.id,
  r.branch_id,
  b.branch_code,
  r.cash_account_id,
  a.code                      as account_code,
  a.name                      as account_name,
  r.reconciliation_date,
  r.status,
  r.system_closing_balance,
  r.physical_count,
  r.variance,
  -- The two reconciliation tables use opposite conventions, and this one is
  -- not the same as the float register's below. Carried as a column, exactly
  -- as `agency_variance_report` does, so a screen states the database's own
  -- sentence instead of a developer's recollection of it.
  'physical count less the books'::text as variance_means,
  r.variance_written_off,
  r.variance_journal_entry_id,
  r.notes,
  r.created_by,
  r.created_at,
  r.reconciled_by,
  r.reconciled_at,
  -- What the books say now, against what they said when the drawer was
  -- counted. Approval refuses the count if these differ.
  coalesce(bal.balance, 0) as current_system_balance,
  (coalesce(bal.balance, 0) <> r.system_closing_balance) as balance_moved
from public.agency_cash_reconciliations r
join public.branches b on b.id = r.branch_id
join public.ledger_accounts a on a.id = r.cash_account_id
left join public.ledger_account_balances bal on bal.account_id = r.cash_account_id;

comment on view public.agency_cash_reconciliation_register is
  'Phase 4D. One row per physical cash count, with the account and branch it names, its variance, and whether the account has moved since it was counted - which is what approval refuses. security_invoker.';

-- The database grants defaults on every new relation, so a bare grant is not
-- enough: without this revoke, anon holds all seven privileges on a brand-new
-- view. Revoke first, then grant the one that is intended.
revoke all on table public.agency_cash_reconciliation_register from anon, authenticated;
grant select on table public.agency_cash_reconciliation_register to authenticated;


-- ---------------------------------------------------------------------------
-- 2. Electronic float statements
-- ---------------------------------------------------------------------------

create view public.agency_float_reconciliation_register
with (security_invoker = true) as
select
  r.id,
  r.float_account_id,
  f.till_name,
  f.ledger_account_id,
  a.code                      as account_code,
  a.name                      as account_name,
  r.provider_id,
  p.code                      as provider_code,
  p.name                      as provider_name,
  r.branch_id,
  b.branch_code,
  r.reconciliation_date,
  r.status,
  r.system_closing_balance,
  r.provider_statement_balance,
  r.provider_statement_ref,
  r.variance,
  -- The opposite sign to the cash register above: positive here means our
  -- books hold more than the provider's statement does.
  'the books less the provider statement'::text as variance_means,
  r.variance_written_off,
  r.variance_journal_entry_id,
  r.notes,
  r.created_by,
  r.created_at,
  r.reconciled_by,
  r.reconciled_at,
  coalesce(bal.balance, 0) as current_system_balance,
  (coalesce(bal.balance, 0) <> r.system_closing_balance) as balance_moved
from public.agency_float_reconciliations r
join public.agency_provider_float_accounts f on f.id = r.float_account_id
join public.ledger_accounts a on a.id = f.ledger_account_id
left join public.agency_service_providers p on p.id = r.provider_id
left join public.branches b on b.id = r.branch_id
left join public.ledger_account_balances bal on bal.account_id = f.ledger_account_id;

comment on view public.agency_float_reconciliation_register is
  'Phase 4D. One row per provider float statement, with its till, provider and branch, its variance against the provider''s own figure, and whether the till has moved since - which is what approval refuses. security_invoker.';

revoke all on table public.agency_float_reconciliation_register from anon, authenticated;
grant select on table public.agency_float_reconciliation_register to authenticated;


-- ---------------------------------------------------------------------------
-- 3. Commission settlements received
-- ---------------------------------------------------------------------------

create view public.agency_commission_settlement_register
with (security_invoker = true) as
select
  s.id,
  s.provider_id,
  p.code              as provider_code,
  p.name              as provider_name,
  s.branch_id,
  b.branch_code,
  s.settlement_date,
  s.settlement_amount,
  s.settlement_account_id,
  a.code              as settlement_account_code,
  a.name              as settlement_account_name,
  s.provider_statement_ref,
  s.status,
  s.journal_entry_id,
  s.reversal_entry_id,
  s.reversal_reason,
  s.reversed_at,
  s.reversed_by,
  s.created_by,
  s.created_at
from public.agency_commission_settlements s
join public.agency_service_providers p on p.id = s.provider_id
join public.branches b on b.id = s.branch_id
join public.ledger_accounts a on a.id = s.settlement_account_id;

comment on view public.agency_commission_settlement_register is
  'Phase 4D. One row per recorded commission settlement, with the account it was received into and its reversal, if any. security_invoker.';

revoke all on table public.agency_commission_settlement_register from anon, authenticated;
grant select on table public.agency_commission_settlement_register to authenticated;


-- ---------------------------------------------------------------------------
-- 4. Payable remittances made
-- ---------------------------------------------------------------------------

create view public.agency_payable_settlement_register
with (security_invoker = true) as
select
  s.id,
  s.provider_id,
  p.code              as provider_code,
  p.name              as provider_name,
  s.branch_id,
  b.branch_code,
  s.settlement_date,
  s.settlement_amount,
  s.cash_account_id,
  c.code              as cash_account_code,
  c.name              as cash_account_name,
  s.payable_account_id,
  s.provider_receipt_ref,
  s.status,
  s.journal_entry_id,
  s.reversal_entry_id,
  s.reversal_reason,
  s.reversed_at,
  s.reversed_by,
  s.created_by,
  s.created_at
from public.agency_payable_settlements s
join public.agency_service_providers p on p.id = s.provider_id
join public.branches b on b.id = s.branch_id
join public.ledger_accounts c on c.id = s.cash_account_id;

comment on view public.agency_payable_settlement_register is
  'Phase 4D. One row per remittance paid to a provider, with the account it was paid from and its reversal, if any. security_invoker.';

revoke all on table public.agency_payable_settlement_register from anon, authenticated;
grant select on table public.agency_payable_settlement_register to authenticated;
