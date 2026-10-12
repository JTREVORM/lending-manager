-- ===========================================================================
-- Phase 10.1 — branches, the chart of accounts, and double-entry journals
--
-- ## The gap this closes
--
-- Up to here the system knows, to the shilling, what every borrower owes. It
-- knows nothing at all about where the company's own money is. `loan_payments`
-- records that 150,000 arrived by MTN; nothing records that MTN therefore
-- holds 150,000 more than it did. Cash at Hand, the two wallets and the bank
-- are not objects in this schema — they are adjectives on a payment row.
--
-- That is the foundation every later module stands on: transfers, expenses,
-- other income, daily reconciliation, the liquidity cards on the dashboard
-- and the whole Financial family of reports are all questions about accounts,
-- and none of them can be asked yet. So this migration adds the accounts and
-- the ledger that moves money between them, and nothing else.
--
-- ## What is deliberately not here
--
-- No backfill, and no change to `post_payment`, `disburse_loan` or
-- `reverse_payment`. This migration only creates the structure; the one that
-- follows derives history into it, and the one after that makes the live
-- functions post. Splitting them means the structure can be reviewed, and
-- reverted, without touching a function that handles real money.
--
-- ## Why one chart of accounts rather than a cash-accounts table
--
-- Double entry needs more than the four places money sits. A disbursement
-- credits Cash and debits Loans Receivable; a repayment splits across
-- Loans Receivable, Interest Income and Penalty Income. If the four cash
-- accounts lived in their own table, every journal line would need to point
-- at one of two tables and every balance query would be a union. So there is
-- one `ledger_accounts` table holding the whole chart, and the four cash
-- kinds are the rows that additionally carry a `branch_id` — because cash is
-- the only thing that is physically *somewhere*.
--
-- Income and expense are not branched in the chart. They are sliced by branch
-- through the journal entry, which carries one. Otherwise adding a branch
-- would mean cloning every income and expense account, and a trial balance
-- would list "Interest Income — Nansana" as a separate account from
-- "Interest Income", which is a reporting dimension pretending to be an
-- account.
--
-- ## Balance enforcement
--
-- A deferred constraint trigger, not an application check. Lines are inserted
-- one at a time, so the rule cannot be evaluated per row; it is evaluated at
-- commit, against the whole entry. An unbalanced journal then cannot be
-- committed by the application, by `service_role`, or by a hand-typed INSERT
-- — which is the only version of this rule worth having.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Branches
-- ---------------------------------------------------------------------------

create table public.branches (
  id uuid primary key default gen_random_uuid(),

  -- Minted by `next_reference('branch')`, so it follows the same shape as
  -- client, loan and payment numbers rather than being typed by hand.
  branch_code text not null unique,

  name text not null,
  location text not null,
  district text,

  phone text,
  email text,

  -- The manager is a profile, not a free-text name, so "branch performance by
  -- manager" is a join rather than a string match. Nullable: a branch may be
  -- opened before anybody is appointed to run it.
  manager_profile_id uuid references public.profiles(id) on delete set null,

  status text not null default 'active',
  opened_on date not null,
  closed_on date,

  notes text,

  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),

  constraint branches_code_shape check (branch_code ~ '^[A-Z0-9-]{2,16}$'),
  constraint branches_name_not_blank check (btrim(name) <> ''),
  constraint branches_location_not_blank check (btrim(location) <> ''),
  constraint branches_status_valid
    check (status in ('active', 'inactive', 'closed')),
  -- A closed branch has a closing date and an open one does not. Without
  -- this the status and the dates drift apart and neither can be trusted.
  constraint branches_closed_consistent
    check ((status = 'closed') = (closed_on is not null)),
  constraint branches_closed_after_opened
    check (closed_on is null or closed_on >= opened_on)
);

create index branches_status_idx on public.branches (status);
create index branches_manager_idx on public.branches (manager_profile_id);

comment on table public.branches is
  'Phase 10. A place the business operates from. Cash accounts belong to a branch; income and expense are sliced by the branch on the journal entry.';

create trigger branches_set_updated_at
  before update on public.branches
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- The chart of accounts
-- ---------------------------------------------------------------------------

create table public.ledger_accounts (
  id uuid primary key default gen_random_uuid(),

  -- Stable, human-readable, and the thing a trial balance sorts by.
  code text not null unique,
  name text not null,

  account_type text not null,

  -- Stored rather than derived at read time. Every balance query needs it,
  -- and a CHECK below keeps it honest against the type, so storing it costs
  -- nothing and saves a CASE in a dozen views.
  normal_side text not null,

  -- Non-null exactly for the four places money physically sits. Those rows
  -- are the ones a branch holds, the ones a transfer moves between, and the
  -- ones daily reconciliation counts.
  cash_kind text,
  branch_id uuid references public.branches(id) on delete restrict,

  -- A bank account needs an institution and a number; a wallet needs the
  -- operator's name. Free text, because this is reference information printed
  -- on a reconciliation sheet, not something the system reasons about.
  institution text,
  account_number text,

  -- A heading row such as "Operating expenses" groups its children in a
  -- report and may not be posted to.
  is_postable boolean not null default true,
  parent_id uuid references public.ledger_accounts(id) on delete restrict,

  status text not null default 'active',
  description text,

  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),

  constraint ledger_accounts_code_shape check (code ~ '^[0-9A-Z][0-9A-Z.-]{1,23}$'),
  constraint ledger_accounts_name_not_blank check (btrim(name) <> ''),
  constraint ledger_accounts_type_valid
    check (account_type in ('asset', 'liability', 'equity', 'income', 'expense')),
  constraint ledger_accounts_side_valid
    check (normal_side in ('debit', 'credit')),
  -- Assets and expenses increase on the debit side; everything else on the
  -- credit side. This is the one piece of accounting that is not a policy
  -- choice, so it is a constraint rather than a convention.
  constraint ledger_accounts_side_matches_type check (
    (account_type in ('asset', 'expense') and normal_side = 'debit')
    or (account_type in ('liability', 'equity', 'income') and normal_side = 'credit')
  ),
  constraint ledger_accounts_cash_kind_valid
    check (cash_kind is null or cash_kind in (
      'cash_at_hand', 'mtn_mobile_money', 'airtel_money', 'bank'
    )),
  -- Cash lives at a branch, and only cash does. The two columns are one fact
  -- and are kept that way.
  constraint ledger_accounts_cash_is_branch_held
    check ((cash_kind is null) = (branch_id is null)),
  -- A cash account is an asset. Nothing else makes sense, and without this a
  -- typo could make Cash at Hand an income account and every balance wrong.
  constraint ledger_accounts_cash_is_asset
    check (cash_kind is null or account_type = 'asset'),
  constraint ledger_accounts_status_valid
    check (status in ('active', 'inactive')),
  constraint ledger_accounts_heading_has_no_cash
    check (is_postable or cash_kind is null),
  constraint ledger_accounts_not_own_parent check (parent_id is distinct from id)
);

-- One Cash at Hand, one MTN float and one Airtel float per branch. A branch
-- may hold several bank accounts, so `bank` is excluded from the rule.
create unique index ledger_accounts_one_wallet_per_branch
  on public.ledger_accounts (branch_id, cash_kind)
  where cash_kind in ('cash_at_hand', 'mtn_mobile_money', 'airtel_money');

create index ledger_accounts_type_idx on public.ledger_accounts (account_type, code);
create index ledger_accounts_branch_idx on public.ledger_accounts (branch_id)
  where branch_id is not null;
create index ledger_accounts_parent_idx on public.ledger_accounts (parent_id)
  where parent_id is not null;

comment on table public.ledger_accounts is
  'Phase 10. The chart of accounts. Rows with a cash_kind are the four places money physically sits and belong to a branch; everything else is company-wide and sliced by the branch on the journal entry.';

create trigger ledger_accounts_set_updated_at
  before update on public.ledger_accounts
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Journal entries
-- ---------------------------------------------------------------------------

create table public.journal_entries (
  id uuid primary key default gen_random_uuid(),

  entry_number text not null unique,

  branch_id uuid not null references public.branches(id) on delete restrict,

  -- The business date the event belongs to, which is not necessarily the day
  -- the row was written — a back-dated correction posts to the day it
  -- happened. `posted_at` records when the system learned of it.
  entry_date date not null,
  posted_at timestamptz not null default pg_catalog.now(),

  description text not null,

  -- What caused this entry. Operational users never construct a journal; one
  -- of these events does, and this column says which, so every line can be
  -- traced back to the act that produced it.
  source_type text not null,
  source_id uuid,

  -- Denormalised handles for drill-down. A report that lists interest income
  -- by client should not have to walk back through source_type to find out
  -- whose interest it was.
  loan_id uuid references public.loans(id) on delete restrict,
  client_id uuid references public.clients(id) on delete restrict,

  -- The contra entry that cancels this one. A journal is never edited or
  -- deleted; it is reversed by an equal and opposite entry, and this points
  -- at it so the pair can be shown together.
  reversed_by_entry_id uuid unique references public.journal_entries(id)
    on delete restrict,

  -- Provenance degrades gracefully, as it does everywhere else here: an
  -- account that no longer exists is less useful than NULL, and
  -- `created_by_label` keeps the name the entry was posted under.
  created_by uuid references public.profiles(id) on delete set null,
  created_by_label text not null default 'system',

  created_at timestamptz not null default pg_catalog.now(),
  -- The row is append-only in substance but not literally immutable: being
  -- reversed stamps `reversed_by_entry_id`, and that is a mutation, so the
  -- table carries the same `updated_at` discipline as every other mutable
  -- table here.
  updated_at timestamptz not null default pg_catalog.now(),

  constraint journal_entries_description_not_blank check (btrim(description) <> ''),
  constraint journal_entries_source_valid check (source_type in (
    'opening_balance',
    'loan_disbursement',
    'loan_repayment',
    'payment_reversal',
    'penalty_charge',
    'transfer',
    'expense',
    'other_income',
    'adjustment'
  )),
  constraint journal_entries_not_own_reversal
    check (reversed_by_entry_id is distinct from id)
);

create index journal_entries_date_idx on public.journal_entries (entry_date desc, entry_number);
create index journal_entries_branch_date_idx on public.journal_entries (branch_id, entry_date desc);
create index journal_entries_source_idx on public.journal_entries (source_type, source_id);
create index journal_entries_loan_idx on public.journal_entries (loan_id) where loan_id is not null;
create index journal_entries_client_idx on public.journal_entries (client_id) where client_id is not null;

comment on table public.journal_entries is
  'Phase 10. The header of a balanced double-entry posting. Append-only: an entry is never edited or deleted, only reversed by a contra entry.';

-- ---------------------------------------------------------------------------
-- Journal lines
-- ---------------------------------------------------------------------------

create table public.journal_lines (
  id uuid primary key default gen_random_uuid(),

  entry_id uuid not null references public.journal_entries(id) on delete cascade,
  line_number smallint not null,

  account_id uuid not null references public.ledger_accounts(id) on delete restrict,

  -- Two columns rather than one signed amount. A trial balance has a debit
  -- column and a credit column, a reader checks that they foot, and a signed
  -- amount makes every report re-derive which side a figure belongs on.
  debit bigint not null default 0,
  credit bigint not null default 0,

  memo text,

  created_at timestamptz not null default pg_catalog.now(),

  constraint journal_lines_debit_not_negative check (debit >= 0),
  constraint journal_lines_credit_not_negative check (credit >= 0),
  -- Exactly one side, and never zero on both. A line that moves nothing is
  -- noise in a ledger that is read by people.
  constraint journal_lines_one_side check ((debit = 0) <> (credit = 0)),
  constraint journal_lines_line_number_positive check (line_number >= 1),
  unique (entry_id, line_number)
);

create index journal_lines_entry_idx on public.journal_lines (entry_id, line_number);
create index journal_lines_account_idx on public.journal_lines (account_id);

comment on table public.journal_lines is
  'Phase 10. One side of one posting. Debits and credits are separate columns because that is how a trial balance is read.';

-- ---------------------------------------------------------------------------
-- Every journal balances, and no journal is empty
--
-- Deferred, because the lines arrive one INSERT at a time and the rule is
-- about the set of them. Checked at commit against the whole entry, so it
-- holds for the application, for `service_role`, and for anything typed
-- directly into psql.
-- ---------------------------------------------------------------------------

-- The rule itself, taking the entry rather than a trigger row. Two thin
-- triggers call it, because a single shared trigger function cannot read
-- `new.entry_id` on one table and `new.id` on the other: PL/pgSQL plans both
-- arms of the expression, so the arm that does not apply still fails to
-- resolve its field. Found by the first test written against this migration.
create or replace function public.journal_assert_balanced(p_entry_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_debit  bigint;
  v_credit bigint;
  v_lines  integer;
  v_number text;
begin
  -- The entry may have been deleted in this same transaction, cascading its
  -- lines away. Nothing to assert about an entry that no longer exists.
  select e.entry_number into v_number
  from public.journal_entries e
  where e.id = p_entry_id;

  if v_number is null then
    return;
  end if;

  select coalesce(pg_catalog.sum(l.debit), 0),
         coalesce(pg_catalog.sum(l.credit), 0),
         pg_catalog.count(*)
    into v_debit, v_credit, v_lines
  from public.journal_lines l
  where l.entry_id = p_entry_id;

  if v_lines = 0 then
    raise exception 'Journal % has no lines. An entry that posts nothing is not an entry.', v_number
      using errcode = 'P0001';
  end if;

  if v_lines < 2 then
    raise exception 'Journal % has one line. A posting has at least two sides.', v_number
      using errcode = 'P0001';
  end if;

  if v_debit <> v_credit then
    raise exception
      'Journal % does not balance: debits %, credits %, difference %.',
      v_number, v_debit, v_credit, v_debit - v_credit
      using errcode = 'P0001';
  end if;
end;
$$;

comment on function public.journal_assert_balanced(uuid) is
  'At commit, a journal has at least two lines and its debits equal its credits.';

-- Nobody calls this directly. It is reachable only through the two constraint
-- triggers, which run as the table owner regardless of who provoked them.
revoke all on function public.journal_assert_balanced(uuid) from public, anon, authenticated;

create or replace function public.journal_lines_assert_balanced()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.journal_assert_balanced(coalesce(new.entry_id, old.entry_id));
  return null;
end;
$$;

create or replace function public.journal_entries_assert_balanced()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.journal_assert_balanced(coalesce(new.id, old.id));
  return null;
end;
$$;

revoke all on function public.journal_lines_assert_balanced() from public, anon, authenticated;
revoke all on function public.journal_entries_assert_balanced() from public, anon, authenticated;

create constraint trigger journal_lines_assert_balanced
  after insert or update or delete on public.journal_lines
  deferrable initially deferred
  for each row execute function public.journal_lines_assert_balanced();

create constraint trigger journal_entries_assert_balanced
  after insert or update on public.journal_entries
  deferrable initially deferred
  for each row execute function public.journal_entries_assert_balanced();

-- ---------------------------------------------------------------------------
-- Append-only
--
-- A ledger that can be edited is a ledger nobody can rely on. Corrections are
-- contra entries, which is both the accounting convention and the only form
-- that leaves the original visible.
-- ---------------------------------------------------------------------------

create trigger journal_entries_no_delete
  before delete on public.journal_entries
  for each row execute function public.reject_mutation();

create trigger journal_lines_no_update
  before update on public.journal_lines
  for each row execute function public.reject_mutation();

create trigger journal_lines_no_delete
  before delete on public.journal_lines
  for each row execute function public.reject_mutation();

-- `journal_entries` permits exactly one update: stamping the contra entry
-- that reverses it. Everything else on the row is history.
create or replace function public.journal_entries_guard_update()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.id is distinct from old.id
     or new.entry_number is distinct from old.entry_number
     or new.branch_id is distinct from old.branch_id
     or new.entry_date is distinct from old.entry_date
     or new.posted_at is distinct from old.posted_at
     or new.description is distinct from old.description
     or new.source_type is distinct from old.source_type
     or new.source_id is distinct from old.source_id
     or new.loan_id is distinct from old.loan_id
     or new.client_id is distinct from old.client_id
     or new.created_by is distinct from old.created_by
     or new.created_by_label is distinct from old.created_by_label
     or new.created_at is distinct from old.created_at then
    raise exception
      'A journal entry is history. Reverse it with a contra entry rather than editing it.'
      using errcode = 'P0001';
  end if;

  if old.reversed_by_entry_id is not null
     and new.reversed_by_entry_id is distinct from old.reversed_by_entry_id then
    raise exception 'Journal % has already been reversed.', old.entry_number
      using errcode = 'P0001';
  end if;

  return new;
end;
$$;

revoke all on function public.journal_entries_guard_update() from public, anon, authenticated;

create trigger journal_entries_guard_update
  before update on public.journal_entries
  for each row execute function public.journal_entries_guard_update();

create trigger journal_entries_set_updated_at
  before update on public.journal_entries
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Balances
-- ---------------------------------------------------------------------------

create view public.ledger_account_balances with (security_invoker = true) as
select
  a.id as account_id,
  a.code,
  a.name,
  a.account_type,
  a.normal_side,
  a.cash_kind,
  a.branch_id,
  b.branch_code,
  b.name as branch_name,
  a.institution,
  a.account_number,
  a.status,
  coalesce(pg_catalog.sum(l.debit), 0)::bigint as total_debit,
  coalesce(pg_catalog.sum(l.credit), 0)::bigint as total_credit,
  -- Signed the way the account is read: an asset with more debits than
  -- credits is positive, and so is an income account with more credits.
  case
    when a.normal_side = 'debit'
      then coalesce(pg_catalog.sum(l.debit), 0) - coalesce(pg_catalog.sum(l.credit), 0)
    else coalesce(pg_catalog.sum(l.credit), 0) - coalesce(pg_catalog.sum(l.debit), 0)
  end::bigint as balance,
  pg_catalog.count(l.id)::bigint as line_count,
  pg_catalog.max(e.entry_date) as last_movement_on
from public.ledger_accounts a
left join public.journal_lines l on l.account_id = a.id
left join public.journal_entries e on e.id = l.entry_id
left join public.branches b on b.id = a.branch_id
group by a.id, b.branch_code, b.name;

comment on view public.ledger_account_balances is
  'Phase 10. Every account with its debit and credit totals and its balance, signed the way the account is read.';

-- Where the company''s money is, which is the question the whole module
-- exists to answer.
create view public.branch_cash_position with (security_invoker = true) as
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
  coalesce(pg_catalog.sum(bal.balance), 0)::bigint as total_liquidity
from public.branches b
left join public.ledger_account_balances bal
  on bal.branch_id = b.id and bal.cash_kind is not null
group by b.id;

comment on view public.branch_cash_position is
  'Phase 10. Cash at Hand, the two wallets and the bank, per branch, with their total. The liquidity cards on the dashboard read this.';

create view public.trial_balance with (security_invoker = true) as
select
  a.code,
  a.name,
  a.account_type,
  a.normal_side,
  coalesce(pg_catalog.sum(l.debit), 0)::bigint as total_debit,
  coalesce(pg_catalog.sum(l.credit), 0)::bigint as total_credit
from public.ledger_accounts a
left join public.journal_lines l on l.account_id = a.id
group by a.id
order by a.code;

comment on view public.trial_balance is
  'Phase 10. Debit and credit totals per account. The two columns foot to the same figure when the ledger is sound.';

-- ---------------------------------------------------------------------------
-- Reference scopes for the new numbers
-- ---------------------------------------------------------------------------

insert into public.reference_formats (scope, prefix, padding, description)
values
  ('branch', 'BR', 2, 'Branch codes, e.g. BR2601'),
  ('journal', 'JV', 5, 'Journal vouchers, e.g. JV2600001')
on conflict (scope) do nothing;

-- ---------------------------------------------------------------------------
-- Capabilities
-- ---------------------------------------------------------------------------

insert into public.permissions (key, description) values
  ('branches:view',   'See the branch network and its performance.'),
  ('branches:create', 'Open a new branch.'),
  ('branches:update', 'Change a branch''s details, manager or status.'),
  ('ledger:view',     'Read account balances, journals and the trial balance.'),
  ('ledger:post',     'Post a manual journal entry. Corrections only; the ordinary path is an operational act that posts for itself.')
on conflict (key) do nothing;

-- Everyone who works here needs to know where the money is; only the Owner
-- may open a branch or hand-post a journal.
insert into public.role_permissions (role_key, permission_key) values
  ('owner_admin',         'branches:view'),
  ('owner_admin',         'branches:create'),
  ('owner_admin',         'branches:update'),
  ('owner_admin',         'ledger:view'),
  ('owner_admin',         'ledger:post'),
  ('manager',             'branches:view'),
  ('manager',             'branches:update'),
  ('manager',             'ledger:view'),
  ('secretary_treasurer', 'branches:view'),
  ('secretary_treasurer', 'ledger:view')
on conflict (role_key, permission_key) do nothing;

-- ---------------------------------------------------------------------------
-- Row level security
--
-- Reads go through a capability. Writes do not go through RLS at all: every
-- posting is made by a SECURITY DEFINER function, because a ledger anybody
-- can INSERT into directly is a ledger with no guarantee that the two sides
-- of an event were written by the same hand.
-- ---------------------------------------------------------------------------

alter table public.branches enable row level security;
alter table public.ledger_accounts enable row level security;
alter table public.journal_entries enable row level security;
alter table public.journal_lines enable row level security;

revoke all on table public.branches from anon, authenticated;
revoke all on table public.ledger_accounts from anon, authenticated;
revoke all on table public.journal_entries from anon, authenticated;
revoke all on table public.journal_lines from anon, authenticated;

grant select on table public.branches to authenticated;
grant select on table public.ledger_accounts to authenticated;
grant select on table public.journal_entries to authenticated;
grant select on table public.journal_lines to authenticated;

create policy branches_select_with_permission
  on public.branches for select to authenticated
  using (public.user_has_permission('branches:view'));

create policy ledger_accounts_select_with_permission
  on public.ledger_accounts for select to authenticated
  using (public.user_has_permission('ledger:view'));

create policy journal_entries_select_with_permission
  on public.journal_entries for select to authenticated
  using (public.user_has_permission('ledger:view'));

create policy journal_lines_select_with_permission
  on public.journal_lines for select to authenticated
  using (public.user_has_permission('ledger:view'));

-- A view created in `public` inherits this deployment's ALTER DEFAULT
-- PRIVILEGES, which hands `anon` every privilege including DELETE and
-- TRUNCATE. The revoke is not tidying — without it the balance views are
-- world-readable before a single policy is consulted, and the views are
-- `security_invoker` precisely so that RLS still decides who sees what.
revoke all on public.ledger_account_balances from anon, authenticated;
revoke all on public.branch_cash_position from anon, authenticated;
revoke all on public.trial_balance from anon, authenticated;

grant select on public.ledger_account_balances to authenticated;
grant select on public.branch_cash_position to authenticated;
grant select on public.trial_balance to authenticated;
