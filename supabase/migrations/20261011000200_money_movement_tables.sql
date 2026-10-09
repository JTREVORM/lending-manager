-- ===========================================================================
-- Phase 11.2 — transfers, expenses, other income, daily reconciliation
--
-- Four ways money moves that are not a loan, all of them posting through the
-- Phase 10 ledger and none of them able to move a shilling without one.
--
-- ## The shape every one of them shares
--
-- A document row (`account_transfers`, `expenses`, `other_income`,
-- `account_reconciliations`) holds what a person typed and who agreed to it.
-- A journal entry holds what it did to the books. The document points at the
-- entry, the entry points back through `(source_type, source_id)`, and the
-- unique index from migration 20261010000200 makes a second journal for the
-- same document impossible at the storage level.
--
-- Posting happens inside the same SECURITY DEFINER function that writes the
-- document, so there is no ordering in which the document commits and the
-- journal does not — the same guarantee `post_payment` gives, for the same
-- reason.
--
-- ## Approval
--
-- A transfer or an expense above the configured threshold is written with
-- status `pending_approval` and **no journal at all**. Nothing has moved yet,
-- so there is nothing to post; writing a journal and reversing it on
-- rejection would put two entries in the books for an event that never
-- happened. Approval posts; rejection records a reason and posts nothing.
--
-- ## Correction
--
-- Nothing here is edited or deleted after it posts. A mistake is reversed:
-- the contra entry cancels the original, both stay visible, and the document
-- moves to `reversed`. That is why the source-type vocabulary grows by three
-- reversal kinds below rather than reusing the original kind — the one-per-
-- source index must still mean something.
--
-- ## Why a transfer is neither income nor an expense
--
-- Moving 500,000 from Cash at Hand to the bank debits one asset and credits
-- another. The company is no richer and no poorer, and the income statement
-- must not twitch. This is worth stating because the opposite mistake —
-- booking a bank deposit as income — is the single most common error in a
-- hand-kept cash book, and the schema is what makes it unavailable: the two
-- legs of a transfer can only be cash accounts.
--
-- Split from one file into five because that is how it was applied to the
-- live project: the Supabase MCP is the only reachable channel here, and a
-- 1,800-line statement is a worse thing to send through it than five
-- self-contained ones. Keeping the files in step with the versions the
-- live registry actually holds is worth more than the tidiness of one file,
-- because a registry that disagrees with the directory is a trap for
-- whoever runs the next migration.

-- ===========================================================================

-- A reversal needs a source type of its own, or the one-per-source unique
-- index would refuse the contra entry.
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
    'adjustment'
  ));

-- ---------------------------------------------------------------------------
-- Transfers between the company's own accounts
-- ---------------------------------------------------------------------------

create table public.account_transfers (
  id uuid primary key default gen_random_uuid(),

  transfer_number text not null unique,

  -- The branch the movement is attributed to. For a transfer between two
  -- branches' accounts this is the source branch; the *balances* stay right
  -- regardless, because a cash account's branch is a property of the account
  -- and `branch_cash_position` reads it from there.
  branch_id uuid not null references public.branches(id) on delete restrict,

  from_account_id uuid not null references public.ledger_accounts(id) on delete restrict,
  to_account_id   uuid not null references public.ledger_accounts(id) on delete restrict,

  amount bigint not null,

  transfer_date date not null,
  occurred_at timestamptz not null default pg_catalog.now(),

  -- The other side's reference: a deposit slip, a wallet transaction id.
  external_reference text,
  description text not null,

  status text not null default 'posted',

  initiated_by uuid references public.profiles(id) on delete set null,
  initiated_by_label text not null default 'system',

  approved_by uuid references public.profiles(id) on delete set null,
  approved_by_label text,
  approved_at timestamptz,

  -- Why it was rejected, or why it was reversed. One column, because a
  -- document only ever leaves the happy path once.
  decision_reason text,

  journal_entry_id  uuid unique references public.journal_entries(id) on delete restrict,
  reversal_entry_id uuid unique references public.journal_entries(id) on delete restrict,
  reversed_at timestamptz,
  reversed_by uuid references public.profiles(id) on delete set null,

  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),

  constraint account_transfers_amount_positive check (amount > 0),
  constraint account_transfers_distinct_accounts check (from_account_id <> to_account_id),
  constraint account_transfers_description_not_blank check (btrim(description) <> ''),
  constraint account_transfers_status_valid
    check (status in ('pending_approval', 'posted', 'rejected', 'reversed')),
  -- A posted transfer has a journal and a waiting one does not. Without this
  -- the two could drift and the register would show money that never moved.
  constraint account_transfers_posted_has_journal
    check ((status in ('posted', 'reversed')) = (journal_entry_id is not null)),
  constraint account_transfers_rejected_has_reason
    check (status <> 'rejected' or btrim(coalesce(decision_reason, '')) <> ''),
  constraint account_transfers_reversed_consistent
    check ((status = 'reversed') = (reversal_entry_id is not null))
);

create index account_transfers_branch_date_idx on public.account_transfers (branch_id, transfer_date desc);
create index account_transfers_status_idx on public.account_transfers (status, transfer_date desc);
create index account_transfers_from_idx on public.account_transfers (from_account_id);
create index account_transfers_to_idx on public.account_transfers (to_account_id);
create index account_transfers_initiated_by_idx on public.account_transfers (initiated_by);

comment on table public.account_transfers is
  'Phase 11. Money moved between the company''s own cash accounts. Never income and never an expense: both legs are assets, so the income statement does not move.';

create trigger account_transfers_set_updated_at
  before update on public.account_transfers
  for each row execute function public.set_updated_at();

create trigger account_transfers_no_delete
  before delete on public.account_transfers
  for each row execute function public.reject_mutation();

-- ---------------------------------------------------------------------------
-- Expenses
-- ---------------------------------------------------------------------------

create table public.expenses (
  id uuid primary key default gen_random_uuid(),

  expense_number text not null unique,
  branch_id uuid not null references public.branches(id) on delete restrict,

  -- The category. An expense account from the chart, which is what makes a
  -- category configurable without a second table — see the head of
  -- 20261011000100.
  expense_account_id uuid not null references public.ledger_accounts(id) on delete restrict,

  -- Where the money came out of.
  payment_account_id uuid not null references public.ledger_accounts(id) on delete restrict,

  amount bigint not null,

  expense_date date not null,
  occurred_at timestamptz not null default pg_catalog.now(),

  payee text,
  description text not null,
  external_reference text,

  -- A path in the receipts bucket. Nullable because a boda fare has no
  -- receipt and refusing the expense would push it off the books entirely.
  receipt_path text,

  status text not null default 'posted',

  recorded_by uuid references public.profiles(id) on delete set null,
  recorded_by_label text not null default 'system',

  approved_by uuid references public.profiles(id) on delete set null,
  approved_by_label text,
  approved_at timestamptz,
  decision_reason text,

  journal_entry_id  uuid unique references public.journal_entries(id) on delete restrict,
  reversal_entry_id uuid unique references public.journal_entries(id) on delete restrict,
  reversed_at timestamptz,
  reversed_by uuid references public.profiles(id) on delete set null,

  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),

  constraint expenses_amount_positive check (amount > 0),
  constraint expenses_description_not_blank check (btrim(description) <> ''),
  constraint expenses_accounts_distinct check (expense_account_id <> payment_account_id),
  constraint expenses_status_valid
    check (status in ('pending_approval', 'posted', 'rejected', 'reversed')),
  constraint expenses_posted_has_journal
    check ((status in ('posted', 'reversed')) = (journal_entry_id is not null)),
  constraint expenses_rejected_has_reason
    check (status <> 'rejected' or btrim(coalesce(decision_reason, '')) <> ''),
  constraint expenses_reversed_consistent
    check ((status = 'reversed') = (reversal_entry_id is not null))
);

create index expenses_branch_date_idx on public.expenses (branch_id, expense_date desc);
create index expenses_status_idx on public.expenses (status, expense_date desc);
create index expenses_category_idx on public.expenses (expense_account_id, expense_date desc);
create index expenses_payment_account_idx on public.expenses (payment_account_id);
create index expenses_recorded_by_idx on public.expenses (recorded_by);

comment on table public.expenses is
  'Phase 11. What the business spent, and out of which account. Loan principal is never here: paying out a loan moves an asset rather than consuming one.';

create trigger expenses_set_updated_at
  before update on public.expenses
  for each row execute function public.set_updated_at();

create trigger expenses_no_delete
  before delete on public.expenses
  for each row execute function public.reject_mutation();

-- ---------------------------------------------------------------------------
-- Other income
-- ---------------------------------------------------------------------------

create table public.other_income (
  id uuid primary key default gen_random_uuid(),

  income_number text not null unique,
  branch_id uuid not null references public.branches(id) on delete restrict,

  income_account_id    uuid not null references public.ledger_accounts(id) on delete restrict,
  receiving_account_id uuid not null references public.ledger_accounts(id) on delete restrict,

  amount bigint not null,

  income_date date not null,
  occurred_at timestamptz not null default pg_catalog.now(),

  -- Who paid, as free text, and optionally the client and loan it relates to
  -- so a fee can be read back from the borrower's record.
  payer text,
  client_id uuid references public.clients(id) on delete restrict,
  loan_id   uuid references public.loans(id) on delete restrict,

  description text not null,
  external_reference text,

  status text not null default 'posted',

  recorded_by uuid references public.profiles(id) on delete set null,
  recorded_by_label text not null default 'system',

  decision_reason text,

  journal_entry_id  uuid unique references public.journal_entries(id) on delete restrict,
  reversal_entry_id uuid unique references public.journal_entries(id) on delete restrict,
  reversed_at timestamptz,
  reversed_by uuid references public.profiles(id) on delete set null,

  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),

  constraint other_income_amount_positive check (amount > 0),
  constraint other_income_description_not_blank check (btrim(description) <> ''),
  constraint other_income_accounts_distinct check (income_account_id <> receiving_account_id),
  constraint other_income_status_valid check (status in ('posted', 'reversed')),
  constraint other_income_reversed_consistent
    check ((status = 'reversed') = (reversal_entry_id is not null))
);

create index other_income_branch_date_idx on public.other_income (branch_id, income_date desc);
create index other_income_category_idx on public.other_income (income_account_id, income_date desc);
create index other_income_receiving_idx on public.other_income (receiving_account_id);
create index other_income_client_idx on public.other_income (client_id) where client_id is not null;
create index other_income_loan_idx on public.other_income (loan_id) where loan_id is not null;
create index other_income_recorded_by_idx on public.other_income (recorded_by);

comment on table public.other_income is
  'Phase 11. Fees and other income that is not interest or a penalty. Money arrives, so there is nothing to approve; a mistake is reversed.';

create trigger other_income_set_updated_at
  before update on public.other_income
  for each row execute function public.set_updated_at();

create trigger other_income_no_delete
  before delete on public.other_income
  for each row execute function public.reject_mutation();

-- ---------------------------------------------------------------------------
-- Daily reconciliation
-- ---------------------------------------------------------------------------

create table public.account_reconciliations (
  id uuid primary key default gen_random_uuid(),

  reconciliation_number text not null unique,
  branch_id uuid not null references public.branches(id) on delete restrict,
  account_id uuid not null references public.ledger_accounts(id) on delete restrict,

  business_date date not null,

  -- What the ledger said at the moment of counting, frozen. Not recomputed
  -- on read: a reconciliation is a statement about a moment, and a figure
  -- that moves afterwards would make yesterday's count unreadable.
  system_balance bigint not null,
  counted_balance bigint not null,

  -- Positive means more money was found than the books expected.
  variance bigint not null generated always as (counted_balance - system_balance) stored,

  explanation text,

  status text not null default 'submitted',

  performed_by uuid references public.profiles(id) on delete set null,
  performed_by_label text not null default 'system',
  performed_at timestamptz not null default pg_catalog.now(),

  reviewed_by uuid references public.profiles(id) on delete set null,
  reviewed_by_label text,
  reviewed_at timestamptz,
  review_notes text,

  -- The journal that wrote the difference off to Cash Over and Short. NULL
  -- while the difference is still unexplained, which is the whole point: the
  -- ledger is not quietly moved to match the count.
  adjustment_entry_id uuid unique references public.journal_entries(id) on delete restrict,

  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),

  constraint account_reconciliations_counted_not_negative check (counted_balance >= 0),
  constraint account_reconciliations_status_valid
    check (status in ('balanced', 'submitted', 'approved', 'rejected')),
  constraint account_reconciliations_rejected_has_reason
    check (status <> 'rejected' or btrim(coalesce(review_notes, '')) <> ''),
  -- An adjustment exists only for an approved count that actually differed.
  constraint account_reconciliations_adjustment_consistent
    check (adjustment_entry_id is null or status = 'approved'),
  -- One count per account per business date. A second count of the same
  -- drawer on the same day is a correction to the first, not a new fact.
  unique (account_id, business_date)
);

create index account_reconciliations_branch_date_idx
  on public.account_reconciliations (branch_id, business_date desc);
create index account_reconciliations_status_idx
  on public.account_reconciliations (status, business_date desc);
create index account_reconciliations_variance_idx
  on public.account_reconciliations (business_date desc) where variance <> 0;
create index account_reconciliations_performed_by_idx
  on public.account_reconciliations (performed_by);

comment on table public.account_reconciliations is
  'Phase 11. What was counted against what the ledger said, per account per day. A difference stays visible until somebody with the capability explains and approves it; the ledger is never edited to make the two agree.';

create trigger account_reconciliations_set_updated_at
  before update on public.account_reconciliations
  for each row execute function public.set_updated_at();

create trigger account_reconciliations_no_delete
  before delete on public.account_reconciliations
  for each row execute function public.reject_mutation();

-- ---------------------------------------------------------------------------
