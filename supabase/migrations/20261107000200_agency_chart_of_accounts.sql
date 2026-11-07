-- ===========================================================================
-- Phase 4A — Agency Banking & Digital Payments: chart of accounts
--
-- Specification: `docs/AGENCY-BANKING-ARCHITECTURE.md` v3.0, §3.
--
-- Seventeen accounts. Every code was re-queried against the 171-migration
-- chart before this was written: the 1300-series, 2200–2900, 4500–4890 and
-- 5960+ ranges hold nothing at all, so correction C1 stands and none of these
-- collides (reconciliation §1).
--
-- ## Three things the specification does not say, and one it says twice
--
-- **`normal_side` is mandatory** (finding D3). §2.1 calls the type column
-- `type`; it is `account_type`, and there is a second `normal_side text not
-- null` column the specification never mentions. Assets and expenses are
-- `debit`; liabilities and income are `credit`.
--
-- **Every account here must be unbranched** (finding D4).
-- `ledger_accounts_cash_is_branch_held` asserts
-- `(cash_kind IS NULL) = (branch_id IS NULL)`. None of these seventeen carries
-- a `cash_kind`, so every one must have `branch_id IS NULL` — giving a payable
-- a branch would fail the check. The commission receivable, the payables and
-- the commission income accounts are therefore company-wide, and branch
-- attribution comes from the journal entry's own `branch_id`, exactly as it
-- does for 1200 Loans Receivable and 2100 Member Savings.
--
-- **The individual float accounts are not created here.** §3.1's
-- `1320.{PROVIDER}.{BRANCH}[.T2]` accounts are per provider, per branch, per
-- till, and which providers are live at which branch is not yet known — the
-- specification flags that as its own implementation risk. They are
-- provisioned one at a time by `ensure_agency_float_account()` in the registry
-- migration, which is also what keeps the code format and the
-- `cash_kind`/`branch_id` invariants in one place.
--
-- **The income account count disagrees with itself** (finding D9). §3.3 tables
-- eight postable income accounts — 4510, 4520, 4530, 4540, 4550, 4560, 4570,
-- 4590 — while §12's checklist says "4510–4590 income accounts (7 accounts)".
-- §3.3 is the normative section and §4.3's category mapping needs all eight, so
-- eight are created. §12 undercounted.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- Assets — 1300 series
--
-- 1300 is top-level: this chart has no `1000` heading, and 1200 Loans
-- Receivable has no parent either.
-- ---------------------------------------------------------------------------

insert into public.ledger_accounts (code, name, account_type, normal_side, is_postable, status, description)
values
  ('1300', 'Agency Services Assets', 'asset', 'debit', false, 'active',
   'Phase 4A heading. Groups what the agency services business is owed and what it holds as electronic float. Not postable.'),
  ('1310', 'Agency Commission Receivable', 'asset', 'debit', true, 'active',
   'Phase 4A. Commission earned but not yet remitted by the provider, under the deferred commission model. Debited when a transaction posts, credited when the provider settles. A provider on the immediate model never touches this account.'),
  ('1320', 'Agency Float Accounts', 'asset', 'debit', false, 'active',
   'Phase 4A heading. Parent of the per-provider, per-branch, per-till float accounts, each created by ensure_agency_float_account() with cash_kind = agency_float. Not postable: float is held in the children, never here.')
on conflict (code) do nothing;



-- ---------------------------------------------------------------------------
-- Liabilities — 2200 series, under the existing 2000 heading
--
-- Correction C1: 2100 Member Savings is taken, so the payables start at 2200.
-- Money collected on a provider's behalf is a liability from the moment it is
-- taken over the counter — it is the customer's payment, held, not the
-- company's income.
-- ---------------------------------------------------------------------------

insert into public.ledger_accounts (code, name, account_type, normal_side, is_postable, status, description)
values
  ('2200', 'Agency Service Payables', 'liability', 'credit', false, 'active',
   'Phase 4A heading. Groups amounts collected over the counter on a provider''s behalf and not yet remitted. Not postable.'),
  ('2210', 'School Fees Payable', 'liability', 'credit', true, 'active',
   'Phase 4A. School fees collected from parents and due to the institution. Credited on collection, debited when remitted by post_agency_payable_settlement(). Never settled by record_transfer(), which refuses a non-cash account (correction C2).'),
  ('2220', 'Bank Agency Payable', 'liability', 'credit', true, 'active',
   'Phase 4A. Net amount due to a partner bank for agency banking deposits taken on its behalf.'),
  ('2290', 'Other Agency Payables', 'liability', 'credit', true, 'active',
   'Phase 4A. Catch-all payable for configurable providers on the cash_payable float model that have no dedicated account.')
on conflict (code) do nothing;


-- ---------------------------------------------------------------------------
-- Income — 4500 series, under the existing 4000 heading
--
-- Correction C1 again: 4400 Meeting Fine Income is taken, and 4900 Other
-- Income is the lending book's catch-all, so agency income starts at 4500 and
-- sits between them.
--
-- Commission is recognised by income account code, not by creating an account
-- per provider (§3.5). Per-provider granularity comes from the journal's
-- source_id, which points at the agency transaction. This is what keeps agency
-- income and lending income separately reportable without the chart growing a
-- row every time a provider is added.
-- ---------------------------------------------------------------------------

insert into public.ledger_accounts (code, name, account_type, normal_side, is_postable, status, description)
values
  ('4500', 'Agency Services Income', 'income', 'credit', false, 'active',
   'Phase 4A heading. Groups all agency and digital payment commission and fee income, separately from lending interest (4100), penalties (4200), fees (4300-4340) and meeting fines (4400). Not postable.'),
  ('4510', 'Mobile Money Commission', 'income', 'credit', true, 'active',
   'Phase 4A. Commission on MTN MoMo and Airtel Money deposits and withdrawals.'),
  ('4520', 'Agency Banking Commission', 'income', 'credit', true, 'active',
   'Phase 4A. Commission on agency banking deposits and withdrawals for partner banks.'),
  ('4530', 'Utility Commission', 'income', 'credit', true, 'active',
   'Phase 4A. Commission on utility bill payments — UEDCL Yaka electricity and NWSC water.'),
  ('4540', 'School Fees Commission', 'income', 'credit', true, 'active',
   'Phase 4A. The handling fee retained on a school fees collection. The fees themselves are a liability in 2210, never income.'),
  ('4550', 'TV Subscription Commission', 'income', 'credit', true, 'active',
   'Phase 4A. Commission on DStv, GOtv, StarTimes and Azam subscription payments.'),
  ('4560', 'Airtime & Data Commission', 'income', 'credit', true, 'active',
   'Phase 4A. Commission on airtime and data sales. These providers use the immediate commission model, so this is credited at the point of sale and never passes through 1310.'),
  ('4570', 'Agency Service Fees', 'income', 'credit', true, 'active',
   'Phase 4A. Convenience fees charged to the customer by the company itself, as distinct from commission remitted by a provider. Earned immediately in every case, because the customer pays it at the counter.'),
  ('4590', 'Other Agency Commission', 'income', 'credit', true, 'active',
   'Phase 4A. Commission income for configurable providers in the `other` category.')
on conflict (code) do nothing;


-- ---------------------------------------------------------------------------
-- Expense — 5960
--
-- Kept separate from 5950 Cash Over and Short on purpose (correction C9). A
-- till that miscounts and float that disagrees with a provider's statement are
-- different failures with different remedies, and netting them into one
-- account would hide both.
-- ---------------------------------------------------------------------------

insert into public.ledger_accounts (code, name, account_type, normal_side, is_postable, status, description)
values
  ('5960', 'Agency Float Over and Short', 'expense', 'debit', true, 'active',
   'Phase 4A, correction C9. Where an electronic float variance is written off when a float reconciliation is approved. Deliberately not 5950 Cash Over and Short, which is for physical till variances: the two have different causes and are investigated differently.')
on conflict (code) do nothing;


-- ---------------------------------------------------------------------------
-- Parent wiring
--
-- Done as separate statements, and this is not stylistic. A multi-row INSERT
-- evaluates its subqueries against the table as it stood when the statement
-- began, so `(select id ... where code = '2200')` inside the same INSERT that
-- creates 2200 returns NULL and the children land unparented. Wiring the
-- hierarchy afterwards is the only correct order, and `where parent_id is
-- null` keeps it idempotent.
-- ---------------------------------------------------------------------------

update public.ledger_accounts
   set parent_id = (select id from public.ledger_accounts where code = '1300')
 where code in ('1310', '1320') and parent_id is null;

update public.ledger_accounts
   set parent_id = (select id from public.ledger_accounts where code = '2000')
 where code = '2200' and parent_id is null;

update public.ledger_accounts
   set parent_id = (select id from public.ledger_accounts where code = '2200')
 where code in ('2210', '2220', '2290') and parent_id is null;

update public.ledger_accounts
   set parent_id = (select id from public.ledger_accounts where code = '4000')
 where code = '4500' and parent_id is null;

update public.ledger_accounts
   set parent_id = (select id from public.ledger_accounts where code = '4500')
 where code in ('4510', '4520', '4530', '4540', '4550', '4560', '4570', '4590')
   and parent_id is null;

update public.ledger_accounts
   set parent_id = (select id from public.ledger_accounts where code = '5000')
 where code = '5960' and parent_id is null;
