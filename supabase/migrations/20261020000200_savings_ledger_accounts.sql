-- ===========================================================================
-- Polytos Phase 2.2 — the accounts and journal source types savings needs
--
-- ## The first liability this business has ever carried
--
-- Every account in this chart until now has been an asset, equity, income or
-- expense. Lending money out creates a receivable; taking a repayment settles
-- one. Nothing the business held belonged to somebody else.
--
-- Member savings are different in kind, and getting that wrong is the single
-- most consequential error available in this phase. A member's UGX 50,000 is
-- **the member's money**, held by Polytos and repayable to them. It is not
-- income, it is not revenue, and it must never appear in a profit figure.
-- Crediting savings to an income account would overstate the year's surplus
-- by the whole savings book, and the profit share computed from that figure
-- in Phase 5 would be money the business does not have, paid out of deposits
-- it owes back.
--
-- So `2100 Member Savings` is a **liability**, and the chart grows a
-- liability heading to put it under.
--
-- ## Why the registration fee is not account 4320
--
-- `4320 Registration Fees` already exists and means something else: what a
-- client pays to be registered as a borrower. Netting the membership
-- programme's registration income into it would make the programme's own
-- income unreportable — "how much did memberships bring in this year" would
-- have no answer that did not involve unpicking two different fees from one
-- balance. `4340 Membership Registration Fees` is its own line, under the
-- same heading, for the same reason `4300` and `4310` are separate.
--
-- Unlike savings, the registration fee **is** income: it is consideration for
-- joining, it is not repayable, and nothing in the client's documents says
-- otherwise. Whether it is refundable on withdrawal is one of the rules the
-- client has not settled; until they do, no refund path exists, which is the
-- honest consequence of not knowing rather than a guess at the answer.
--
-- ## The source types
--
-- `journal_entries_source_valid` is replaced rather than extended in place —
-- a CHECK constraint cannot be added to, only swapped — which is exactly what
-- 20261011000200 did when the money-movement documents arrived. Every
-- existing value is carried across unchanged.
--
-- Each posting kind gets its own source type, and each reversal gets its own
-- again, because `journal_entries_one_per_source` is unique on
-- (source_type, source_id): a contra entry that reused the original's type
-- would collide with the entry it reverses.
-- ===========================================================================

do $chart$
declare
  v_liability_heading uuid;
  v_income_heading    uuid;
begin
  -- The heading. Not postable: a balance belongs on a named account, not on
  -- the group that collects them.
  insert into public.ledger_accounts
    (code, name, account_type, normal_side, is_postable, description)
  values
    ('2000', 'Liabilities', 'liability', 'credit', false,
     'Heading. What the business owes to other people. Member savings are the first of these: money held on behalf of a member and repayable to them.')
  on conflict (code) do nothing;

  select id into v_liability_heading
  from public.ledger_accounts where code = '2000';

  select id into v_income_heading
  from public.ledger_accounts where code = '4000';

  insert into public.ledger_accounts
    (code, name, account_type, normal_side, parent_id, description)
  values
    ('2100', 'Member Savings', 'liability', 'credit', v_liability_heading,
     'Polytos member savings held by the business and repayable to the member. A deposit credits this account; a withdrawal debits it. It is never income, and it never reaches a profit figure.')
  on conflict (code) do nothing;

  insert into public.ledger_accounts
    (code, name, account_type, normal_side, parent_id, description)
  values
    ('4340', 'Membership Registration Fees', 'income', 'credit', v_income_heading,
     'The one-off fee a client pays to join the Polytos membership programme. Separate from 4320, which is what a borrower pays to be registered as a client — netting the two would leave the programme''s own income unreportable.')
  on conflict (code) do nothing;
end;
$chart$;

-- ---------------------------------------------------------------------------
-- The journal source types
--
-- Replaced wholesale, carrying every existing value across. The four new
-- postings and their three reversals are added at the end of the list.
--
-- There is no `savings_withdrawal_reversal` omission to explain: a reversed
-- withdrawal puts the member's money back, which is a different event from
-- the withdrawal, and it needs its own source type so the contra entry does
-- not collide with the original under `journal_entries_one_per_source`.
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
    'savings_withdrawal_reversal'
  ));

comment on constraint journal_entries_source_valid on public.journal_entries is
  'Every kind of business event that may write a journal. Each reversal is its own type, because journal_entries_one_per_source is unique on (source_type, source_id) and a contra entry reusing the original type would collide with it.';
