-- ===========================================================================
-- Phase 11.2e — the registers, the general ledger, and row level security
--
-- Part of Phase 11.2; the design notes are at the head of
-- 20261011000200_money_movement_tables.sql.
-- ===========================================================================

-- Registers
--
-- One view per document, joining the names a person reads. Every screen and
-- every report in later phases reads these rather than re-deriving the joins,
-- so "expenses by category" means the same thing everywhere it is asked.
-- ---------------------------------------------------------------------------

create view public.transfer_register with (security_invoker = true) as
select
  t.id,
  t.transfer_number,
  t.branch_id,
  b.branch_code,
  b.name as branch_name,
  t.transfer_date,
  t.occurred_at,
  t.amount,
  t.status,
  t.from_account_id,
  fa.code as from_account_code,
  fa.name as from_account_name,
  fa.cash_kind as from_cash_kind,
  t.to_account_id,
  ta.code as to_account_code,
  ta.name as to_account_name,
  ta.cash_kind as to_cash_kind,
  t.external_reference,
  t.description,
  t.initiated_by,
  t.initiated_by_label,
  t.approved_by,
  t.approved_by_label,
  t.approved_at,
  t.decision_reason,
  t.journal_entry_id,
  t.reversal_entry_id,
  t.reversed_at,
  t.created_at
from public.account_transfers t
join public.branches b on b.id = t.branch_id
join public.ledger_accounts fa on fa.id = t.from_account_id
join public.ledger_accounts ta on ta.id = t.to_account_id;

comment on view public.transfer_register is
  'Phase 11. Every transfer with the account and branch names a person reads.';

create view public.expense_register with (security_invoker = true) as
select
  e.id,
  e.expense_number,
  e.branch_id,
  b.branch_code,
  b.name as branch_name,
  e.expense_date,
  e.occurred_at,
  e.amount,
  e.status,
  e.expense_account_id,
  ca.code as category_code,
  ca.name as category_name,
  e.payment_account_id,
  pa.code as payment_account_code,
  pa.name as payment_account_name,
  pa.cash_kind as payment_cash_kind,
  e.payee,
  e.description,
  e.external_reference,
  e.receipt_path,
  e.recorded_by,
  e.recorded_by_label,
  e.approved_by,
  e.approved_by_label,
  e.approved_at,
  e.decision_reason,
  e.journal_entry_id,
  e.reversal_entry_id,
  e.reversed_at,
  e.created_at,
  -- What the expense actually cost the business: nothing, once reversed.
  case when e.status = 'posted' then e.amount else 0 end::bigint as effective_amount
from public.expenses e
join public.branches b on b.id = e.branch_id
join public.ledger_accounts ca on ca.id = e.expense_account_id
join public.ledger_accounts pa on pa.id = e.payment_account_id;

comment on view public.expense_register is
  'Phase 11. Every expense with its category and paying account. `effective_amount` is zero for anything not posted, so a sum over this view is what was actually spent.';

create view public.income_register with (security_invoker = true) as
select
  i.id,
  i.income_number,
  i.branch_id,
  b.branch_code,
  b.name as branch_name,
  i.income_date,
  i.occurred_at,
  i.amount,
  i.status,
  i.income_account_id,
  ia.code as category_code,
  ia.name as category_name,
  i.receiving_account_id,
  ra.code as receiving_account_code,
  ra.name as receiving_account_name,
  ra.cash_kind as receiving_cash_kind,
  i.payer,
  i.client_id,
  c.client_number,
  c.full_name as client_name,
  i.loan_id,
  l.loan_number,
  i.description,
  i.external_reference,
  i.recorded_by,
  i.recorded_by_label,
  i.journal_entry_id,
  i.reversal_entry_id,
  i.reversed_at,
  i.created_at,
  case when i.status = 'posted' then i.amount else 0 end::bigint as effective_amount
from public.other_income i
join public.branches b on b.id = i.branch_id
join public.ledger_accounts ia on ia.id = i.income_account_id
join public.ledger_accounts ra on ra.id = i.receiving_account_id
left join public.clients c on c.id = i.client_id
left join public.loans l on l.id = i.loan_id;

comment on view public.income_register is
  'Phase 11. Fees and other non-loan income, with the client and loan where one was named.';

create view public.reconciliation_register with (security_invoker = true) as
select
  r.id,
  r.reconciliation_number,
  r.branch_id,
  b.branch_code,
  b.name as branch_name,
  r.account_id,
  a.code as account_code,
  a.name as account_name,
  a.cash_kind,
  r.business_date,
  r.system_balance,
  r.counted_balance,
  r.variance,
  r.status,
  r.explanation,
  r.performed_by,
  r.performed_by_label,
  r.performed_at,
  r.reviewed_by,
  r.reviewed_by_label,
  r.reviewed_at,
  r.review_notes,
  r.adjustment_entry_id,
  r.created_at
from public.account_reconciliations r
join public.branches b on b.id = r.branch_id
join public.ledger_accounts a on a.id = r.account_id;

comment on view public.reconciliation_register is
  'Phase 11. Every count, its variance and what was decided about it.';

-- The general ledger: every posting line, in the order a bookkeeper reads
-- them. The one place later reports go for "what happened to this account".
create view public.general_ledger with (security_invoker = true) as
select
  l.id as line_id,
  l.entry_id,
  e.entry_number,
  e.entry_date,
  e.posted_at,
  e.branch_id,
  b.branch_code,
  b.name as branch_name,
  e.source_type,
  e.source_id,
  e.description as entry_description,
  e.loan_id,
  e.client_id,
  e.created_by,
  e.created_by_label,
  e.reversed_by_entry_id,
  l.line_number,
  l.account_id,
  a.code as account_code,
  a.name as account_name,
  a.account_type,
  a.normal_side,
  a.cash_kind,
  a.branch_id as account_branch_id,
  l.debit,
  l.credit,
  -- Signed the way the account is read, so a sum over a filtered slice is
  -- that slice's movement rather than something the reader has to re-sign.
  case when a.normal_side = 'debit' then l.debit - l.credit else l.credit - l.debit end::bigint
    as signed_amount,
  l.memo
from public.journal_lines l
join public.journal_entries e on e.id = l.entry_id
join public.ledger_accounts a on a.id = l.account_id
join public.branches b on b.id = e.branch_id;

comment on view public.general_ledger is
  'Phase 11. Every posting line with its entry, account and branch. The source for account activity, the general ledger report and every financial drill-down.';

-- ---------------------------------------------------------------------------
-- Row level security
--
-- Reads go through a capability and the branch the person may see. Writes go
-- through the SECURITY DEFINER functions above and nowhere else: a table
-- anybody can INSERT into is a table where a document can exist without the
-- journal that makes it true.
-- ---------------------------------------------------------------------------

alter table public.account_transfers enable row level security;
alter table public.expenses enable row level security;
alter table public.other_income enable row level security;
alter table public.account_reconciliations enable row level security;

revoke all on table public.account_transfers from anon, authenticated;
revoke all on table public.expenses from anon, authenticated;
revoke all on table public.other_income from anon, authenticated;
revoke all on table public.account_reconciliations from anon, authenticated;

grant select on table public.account_transfers to authenticated;
grant select on table public.expenses to authenticated;
grant select on table public.other_income to authenticated;
grant select on table public.account_reconciliations to authenticated;

create policy account_transfers_select_with_permission
  on public.account_transfers for select to authenticated
  using (public.user_has_permission('transfers:view') and public.user_can_see_branch(branch_id));

create policy expenses_select_with_permission
  on public.expenses for select to authenticated
  using (public.user_has_permission('expenses:view') and public.user_can_see_branch(branch_id));

create policy other_income_select_with_permission
  on public.other_income for select to authenticated
  using (public.user_has_permission('income:view') and public.user_can_see_branch(branch_id));

create policy account_reconciliations_select_with_permission
  on public.account_reconciliations for select to authenticated
  using (public.user_has_permission('reconciliation:view') and public.user_can_see_branch(branch_id));

-- Supabase's ALTER DEFAULT PRIVILEGES hands `anon` every privilege on a new
-- view in `public`, DELETE included. Revoked before anything is granted, for
-- the reason recorded in `tests/db/security.test.ts`.
revoke all on public.transfer_register from anon, authenticated;
revoke all on public.expense_register from anon, authenticated;
revoke all on public.income_register from anon, authenticated;
revoke all on public.reconciliation_register from anon, authenticated;
revoke all on public.general_ledger from anon, authenticated;

grant select on public.transfer_register to authenticated;
grant select on public.expense_register to authenticated;
grant select on public.income_register to authenticated;
grant select on public.reconciliation_register to authenticated;
grant select on public.general_ledger to authenticated;
