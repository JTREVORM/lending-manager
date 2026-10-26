-- ===========================================================================
-- Polytos Phase 4.2 — the accounts and journal source types benefits need
--
-- ## A benefit is an expense, and it is not an operating expense
--
-- `5000 Operating Expenses` is the cost of running the business: rent,
-- salaries, fuel, bank charges. A medical support payment is none of those. It
-- is the cost of a **promise the membership programme made** — the business
-- undertook to pay 5% of a member's hospital bill, and when it pays, that
-- promise costs it money.
--
-- Netting the two together would make the programme's own cost unreportable.
-- "What did the benefits scheme cost us this year" would have no answer that
-- did not involve unpicking three kinds of support payment out of a column
-- that also holds the rent — and that figure is exactly what the client will
-- want when they come to answer questions 7 and 8, because the annual cap
-- they have not yet set is a statement about this number.
--
-- So `5200 Member Benefits` is a heading of its own at the top of the chart,
-- a sibling of `5000` rather than a child of it, with the three confirmed
-- benefits under it. The same reasoning that made `4340 Membership
-- Registration Fees` its own line beside `4320`, and for the same reader.
--
-- ## Three children, not one
--
-- `5210 Medical Support`, `5220 Family Condolence Support`,
-- `5230 Member Bereavement Support`. Three accounts because they are three
-- promises with three different rules — a percentage of a bill, a fixed
-- UGX 100,000, a fixed UGX 200,000 — and because the only interesting
-- question about benefit spending is which of the three it went on. One
-- account with the claim type in the memo would make that a text search.
--
-- The heading itself is **not postable**: a balance belongs on a named
-- account, not on the group that collects them, which is the rule every other
-- heading in this chart already follows.
--
-- ## Why there is no benefits *payable* account
--
-- The documented pattern, and the one this phase implements, is recognition
-- and settlement in one event:
--
--     Debit   52x0 the benefit expense
--     Credit  the branch's cash / MTN / Airtel / bank account
--
-- A payable — credit `21xx Benefits Payable` on approval, debit it on
-- settlement — is the right model if the business approves claims and pays
-- them later, as a batch, on a schedule. Nothing in the client's documents
-- says it does, and the documents that exist describe handing money to a
-- member or to a bereaved family at the counter.
--
-- Modelling a liability the business does not know it has would be inventing
-- an accrual policy, which §14 of the Phase 4 brief forbids as plainly as it
-- forbids inventing the medical cap. So: no payable account, and the gap
-- recorded in docs/POLYTOS-BENEFITS.md as a decision for the client. If they
-- answer "we approve monthly and pay in a batch", the account and a
-- `benefit_accrual` source type are the additive migration that follows — the
-- approval already exists as a distinct, timestamped, authorised event, which
-- is the hard part and is why this phase can defer the easy one.
--
-- What is **not** deferred is the consequence of approval on the member's
-- remaining entitlement. An approved-but-unpaid claim consumes annual cap
-- immediately (20261022000600), because a cap that counted only completed
-- payments would let two approvals share one member's ceiling. That is the
-- substance of recognising an obligation at approval; only its presentation
-- in the balance sheet waits on the client.
--
-- ## The source types
--
-- `journal_entries_source_valid` is replaced wholesale rather than extended,
-- because a CHECK constraint cannot be added to — the same thing
-- 20261011000200 and 20261020000200 each did, and every existing value is
-- carried across unchanged.
--
-- Two new types, not one. `journal_entries_one_per_source` is unique on
-- (source_type, source_id), so a contra entry reusing the original's type
-- would collide with the entry it reverses.
-- ===========================================================================

do $chart$
declare
  v_benefits_heading uuid;
begin
  -- The heading. `5200` rather than a child of `5000`, for the reason above:
  -- a benefit is the cost of a promise, not the cost of an office.
  insert into public.ledger_accounts
    (code, name, account_type, normal_side, is_postable, description)
  values
    ('5200', 'Member Benefits', 'expense', 'debit', false,
     'Heading. What the Polytos membership programme pays out to members and their families under the benefits scheme. Separate from 5000 Operating Expenses, which is the cost of running the business rather than the cost of a promise made to a member.')
  on conflict (code) do nothing;

  select id into v_benefits_heading
  from public.ledger_accounts where code = '5200';

  insert into public.ledger_accounts
    (code, name, account_type, normal_side, parent_id, description)
  values
    ('5210', 'Medical Support', 'expense', 'debit', v_benefits_heading,
     'Medical support paid to a member: a percentage of an eligible hospital bill, under the rate on the governing membership policy version. Debited when the benefit is paid.'),
    ('5220', 'Family Condolence Support', 'expense', 'debit', v_benefits_heading,
     'Condolence support paid to a member on the death of an eligible family member. A fixed amount, under the governing membership policy version.'),
    ('5230', 'Member Bereavement Support', 'expense', 'debit', v_benefits_heading,
     'Bereavement support paid on the death of a member, to their registered and verified next of kin. A fixed amount, under the governing membership policy version.')
  on conflict (code) do nothing;
end;
$chart$;

-- ---------------------------------------------------------------------------
-- The journal source types
--
-- Replaced wholesale, carrying every existing value across.
-- ---------------------------------------------------------------------------

alter table public.journal_entries drop constraint journal_entries_source_valid;

alter table public.journal_entries add constraint journal_entries_source_valid
  check (source_type in (
    'opening_balance',
    'loan_disbursement',
    'loan_repayment',
    'payment_reversal',
    'penalty_charge',
    'transfer',
    'transfer_reversal',
    'expense',
    'expense_reversal',
    'other_income',
    'other_income_reversal',
    'reconciliation_adjustment',
    'adjustment',
    -- Polytos Phase 2.
    'membership_fee',
    'membership_fee_reversal',
    'savings_deposit',
    'savings_deposit_reversal',
    'savings_withdrawal',
    'savings_withdrawal_reversal',
    -- Polytos Phase 4. A benefit payment is never a `loan_disbursement`: it
    -- creates no receivable, nothing is repayable, and classifying it as one
    -- would put it in the loan book and in every arrears report.
    'benefit_payment',
    'benefit_payment_reversal'
  ));

comment on constraint journal_entries_source_valid on public.journal_entries is
  'Every kind of business event that may write a journal. Each reversal is its own type, because journal_entries_one_per_source is unique on (source_type, source_id) and a contra entry reusing the original type would collide with it.';

-- ---------------------------------------------------------------------------
-- The benefit expense account for a claim type
--
-- One function rather than three literals scattered through the posting path,
-- so "which account does a condolence payment hit" has exactly one answer and
-- a test can assert it. `ledger_account_by_code` raises on a missing code, so
-- a typo here fails loudly at posting time rather than silently debiting the
-- wrong line.
--
-- IMMUTABLE is wrong for this (it reads a table) and STABLE is right:
-- `ledger_account_by_code` is itself STABLE.
-- ---------------------------------------------------------------------------

create or replace function public.benefit_expense_account(p_claim_type text)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select case p_claim_type
    when 'medical'            then public.ledger_account_by_code('5210')
    when 'family_condolence'  then public.ledger_account_by_code('5220')
    when 'member_bereavement' then public.ledger_account_by_code('5230')
  end;
$$;

comment on function public.benefit_expense_account(text) is
  'Polytos Phase 4. The expense account a benefit of this type is debited to: 5210 medical, 5220 family condolence, 5230 member bereavement. NULL for an unrecognised type, which every caller treats as a refusal rather than as a default account.';

revoke all on function public.benefit_expense_account(text) from public, anon;
grant execute on function public.benefit_expense_account(text) to authenticated;
