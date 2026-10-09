-- ===========================================================================
-- Phase 11.1 — what money movement needs before it can move
--
-- Phase 10 gave the business a ledger with five accounts beyond the four cash
-- kinds: Loans Receivable, Owner Capital, Interest Income and Penalty Income.
-- That is everything lending itself touches, and nothing else. A rent payment,
-- an application fee or a cash transfer to the bank has nowhere to post.
--
-- So this migration adds the rest of the chart, the settings that govern
-- approval and overdraft, the reference scopes for the new documents, the
-- capabilities, and one thing that is not about money at all: branch
-- visibility.
--
-- ## Expense and income categories ARE ledger accounts
--
-- The obvious design is an `expense_categories` table with a name and an
-- active flag, pointing at a ledger account. It is also wrong here, and for
-- the reason stated at the head of migration 20261010000100: a category and
-- the account it posts to are one fact, and splitting them creates two places
-- to add "Fuel" and two ways for them to disagree.
--
-- `ledger_accounts` already carries everything a category needs — a code, a
-- name, a description, an active/inactive status, a parent for grouping and
-- an `is_postable` flag for headings. So a category *is* an account row, and
-- adding one is adding an account. It then appears in the trial balance and
-- the general ledger without anybody wiring it up, which is the behaviour a
-- bookkeeper expects and the behaviour a separate table would have to
-- reimplement.
--
-- Headings (`is_postable = false`) group them for reporting:
--
--   4000  Income                      heading
--     4100  Interest Income           Phase 10
--     4200  Penalty Income            Phase 10
--     4300  Application Fees          here
--     4310  Processing Fees
--     4320  Registration Fees
--     4330  Documentation Fees
--     4900  Other Income
--   5000  Operating Expenses          heading
--     5010  Rent … 5900 Other Expenses
--
-- ## Cash Over and Short
--
-- `5950` exists so that an approved reconciliation difference has somewhere
-- honest to go. A count that comes up short debits it; one that comes up over
-- credits it. What must never happen is the ledger being edited to match the
-- count, so the account is the pressure valve that makes the correct
-- behaviour also the easy one.
--
-- ## Branch visibility
--
-- `clients` and `loans` have carried a `branch_id` since Phase 10 and nothing
-- reads it for access control, because every profile could see everything.
-- The finance tables in the next migration are the first data where that is
-- plainly wrong: a branch's cash position is its own.
--
-- Rather than scope only the new tables and leave the old ones open — two
-- rules for one question — `profiles.branch_id` and
-- `user_can_see_branch(uuid)` arrive here and are applied to clients and
-- loans in the same change. A profile with no branch is unrestricted, which
-- every existing profile is, so nothing visible changes today and the rule is
-- in place for the day somebody is assigned to a branch.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- The rest of the chart
-- ---------------------------------------------------------------------------

do $chart$
declare
  v_income_heading  uuid;
  v_expense_heading uuid;
begin
  insert into public.ledger_accounts (code, name, account_type, normal_side, is_postable, description)
  values ('4000', 'Income', 'income', 'credit', false,
          'Heading. Everything the business earns.')
  on conflict (code) do nothing;

  insert into public.ledger_accounts (code, name, account_type, normal_side, is_postable, description)
  values ('5000', 'Operating Expenses', 'expense', 'debit', false,
          'Heading. What it costs to run the business. Loan principal is never here: paying out a loan moves an asset, it does not consume one.')
  on conflict (code) do nothing;

  select id into v_income_heading from public.ledger_accounts where code = '4000';
  select id into v_expense_heading from public.ledger_accounts where code = '5000';

  -- Phase 10's two income accounts join the heading they always belonged to.
  update public.ledger_accounts
     set parent_id = v_income_heading
   where code in ('4100', '4200') and parent_id is null;

  insert into public.ledger_accounts (code, name, account_type, normal_side, parent_id, description)
  values
    ('4300', 'Application Fees', 'income', 'credit', v_income_heading,
     'Charged when a loan application is taken.'),
    ('4310', 'Processing Fees', 'income', 'credit', v_income_heading,
     'Charged for processing an approved loan.'),
    ('4320', 'Registration Fees', 'income', 'credit', v_income_heading,
     'Charged when a client is registered.'),
    ('4330', 'Documentation Fees', 'income', 'credit', v_income_heading,
     'Charged for preparing loan documents.'),
    ('4900', 'Other Income', 'income', 'credit', v_income_heading,
     'Income that does not fit a named category.')
  on conflict (code) do nothing;

  insert into public.ledger_accounts (code, name, account_type, normal_side, parent_id, description)
  values
    ('5010', 'Rent', 'expense', 'debit', v_expense_heading, 'Premises.'),
    ('5020', 'Salaries and Wages', 'expense', 'debit', v_expense_heading, 'Staff pay.'),
    ('5030', 'Transport', 'expense', 'debit', v_expense_heading, 'Travel on company business.'),
    ('5040', 'Utilities', 'expense', 'debit', v_expense_heading, 'Power and water.'),
    ('5050', 'Stationery', 'expense', 'debit', v_expense_heading, 'Office supplies and printing.'),
    ('5060', 'Internet and Airtime', 'expense', 'debit', v_expense_heading, 'Connectivity.'),
    ('5070', 'Mobile Money Charges', 'expense', 'debit', v_expense_heading,
     'What MTN and Airtel take. An expense, never netted off the collection.'),
    ('5080', 'Bank Charges', 'expense', 'debit', v_expense_heading, 'What the bank takes.'),
    ('5090', 'Fuel', 'expense', 'debit', v_expense_heading, 'Vehicle and generator fuel.'),
    ('5100', 'Repairs and Maintenance', 'expense', 'debit', v_expense_heading, 'Keeping things working.'),
    ('5900', 'Other Expenses', 'expense', 'debit', v_expense_heading,
     'An expense that does not fit a named category.'),
    ('5950', 'Cash Over and Short', 'expense', 'debit', v_expense_heading,
     'Where an approved reconciliation difference goes. A shortage debits it, an overage credits it. It exists so that a count that disagrees with the ledger is explained rather than hidden by editing the ledger.')
  on conflict (code) do nothing;
end
$chart$;

-- ---------------------------------------------------------------------------
-- Finance settings
--
-- Separate from `business_settings`, which is about lending — interest, terms,
-- penalties, how many loans a client may hold. Nothing on this table changes
-- what a borrower owes; everything on it governs how the company's own money
-- is moved and who has to agree.
-- ---------------------------------------------------------------------------

create table public.finance_settings (
  id smallint primary key default 1,

  -- Above this figure a transfer or an expense waits for somebody with the
  -- approving capability. NULL means never — a business of this size may
  -- reasonably run without a second signature, and saying so explicitly is
  -- better than a sentinel like 0 that reads as "approve everything".
  transfer_approval_threshold bigint,
  expense_approval_threshold  bigint,

  -- Whether a cash account may be taken below zero. Off, because a negative
  -- Cash at Hand is not a balance, it is a mistake that has already happened.
  allow_negative_cash boolean not null default false,

  -- Whether a count that disagrees with the ledger needs a second person
  -- before the difference is written off to 5950.
  reconciliation_requires_review boolean not null default true,

  -- What counts as low, per cash kind. Phase 6 raises a notification from
  -- these; nothing enforces them, because a float running low is a thing to
  -- know about rather than a thing to refuse.
  low_balance_cash_at_hand     bigint not null default 200000,
  low_balance_mtn_mobile_money bigint not null default 200000,
  low_balance_airtel_money     bigint not null default 200000,
  low_balance_bank             bigint not null default 500000,

  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  updated_by uuid references public.profiles(id) on delete set null,

  constraint finance_settings_singleton check (id = 1),
  constraint finance_settings_transfer_threshold_sane
    check (transfer_approval_threshold is null or transfer_approval_threshold >= 0),
  constraint finance_settings_expense_threshold_sane
    check (expense_approval_threshold is null or expense_approval_threshold >= 0),
  constraint finance_settings_low_cash_sane check (low_balance_cash_at_hand >= 0),
  constraint finance_settings_low_mtn_sane check (low_balance_mtn_mobile_money >= 0),
  constraint finance_settings_low_airtel_sane check (low_balance_airtel_money >= 0),
  constraint finance_settings_low_bank_sane check (low_balance_bank >= 0)
);

comment on table public.finance_settings is
  'Phase 11. Singleton. How the company''s own money may be moved: approval thresholds, whether an account may go overdrawn, whether a reconciliation difference needs a second person, and what counts as a low float.';

create trigger finance_settings_set_updated_at
  before update on public.finance_settings
  for each row execute function public.set_updated_at();

insert into public.finance_settings (id, transfer_approval_threshold, expense_approval_threshold)
values (1, 2000000, 1000000)
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- An account's balance, as one number
--
-- `ledger_account_balances` already computes this, but it is a view over
-- every line in the ledger and a posting function needs one account's figure
-- inside a transaction that is about to add to it. This reads the lines
-- directly and signs the result the way the account is read.
-- ---------------------------------------------------------------------------

create or replace function public.ledger_account_balance(p_account_id uuid)
returns bigint
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_side    text;
  v_debit   bigint;
  v_credit  bigint;
begin
  select a.normal_side into v_side
  from public.ledger_accounts a where a.id = p_account_id;

  if v_side is null then
    raise exception 'No such ledger account.' using errcode = 'P0001';
  end if;

  select coalesce(pg_catalog.sum(l.debit), 0), coalesce(pg_catalog.sum(l.credit), 0)
    into v_debit, v_credit
  from public.journal_lines l
  where l.account_id = p_account_id;

  if v_side = 'debit' then
    return v_debit - v_credit;
  end if;

  return v_credit - v_debit;
end;
$$;

comment on function public.ledger_account_balance(uuid) is
  'Phase 11. One account''s balance, signed the way the account is read. The same arithmetic as ledger_account_balances, for a posting function that needs the figure mid-transaction.';

revoke all on function public.ledger_account_balance(uuid) from public, anon, authenticated;
grant execute on function public.ledger_account_balance(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Refusing to overdraw
--
-- Called by every function that takes money out of a cash account. Reads the
-- setting itself rather than taking a boolean argument, so there is no caller
-- that can decide the rule does not apply to it.
-- ---------------------------------------------------------------------------

create or replace function public.assert_cash_available(p_account_id uuid, p_amount bigint)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_allow   boolean;
  v_balance bigint;
  v_name    text;
begin
  select fs.allow_negative_cash into v_allow from public.finance_settings fs where fs.id = 1;

  if coalesce(v_allow, false) then
    return;
  end if;

  v_balance := public.ledger_account_balance(p_account_id);

  if v_balance >= p_amount then
    return;
  end if;

  select a.name into v_name from public.ledger_accounts a where a.id = p_account_id;

  raise exception
    '% holds % shillings, which is less than the % being taken out of it.',
    coalesce(v_name, 'That account'), v_balance, p_amount
    using errcode = 'P0001';
end;
$$;

comment on function public.assert_cash_available(uuid, bigint) is
  'Phase 11. Refuses to take more out of a cash account than it holds, unless finance_settings says an account may go overdrawn. Reads the setting itself so no caller can opt out.';

revoke all on function public.assert_cash_available(uuid, bigint) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Branch visibility
-- ---------------------------------------------------------------------------

alter table public.profiles
  add column branch_id uuid references public.branches(id) on delete restrict;

comment on column public.profiles.branch_id is
  'Phase 11. The branch this person works at, or NULL for somebody who is not restricted to one. NULL is the unrestricted case rather than a missing value: an Owner belongs to the company, not to a branch.';

create index profiles_branch_idx on public.profiles (branch_id) where branch_id is not null;

create or replace function public.user_can_see_branch(p_branch_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select
    p_branch_id is null
    or not exists (
      select 1 from public.profiles p
      where p.id = public.current_profile_id() and p.branch_id is not null
    )
    or exists (
      select 1 from public.profiles p
      where p.id = public.current_profile_id() and p.branch_id = p_branch_id
    );
$$;

comment on function public.user_can_see_branch(uuid) is
  'Phase 11. Whether the signed-in person may see data belonging to this branch. True for everybody when the person is not assigned to a branch, which is how every account stands today.';

revoke all on function public.user_can_see_branch(uuid) from public, anon, authenticated;
grant execute on function public.user_can_see_branch(uuid) to authenticated;

-- `clients` and `loans` carry a branch and did not consult it. The predicate
-- is added to the existing read policies rather than replacing them, so the
-- capability check still decides *whether* a person may read clients at all
-- and this decides *which*.
do $scope$
declare
  r record;
begin
  for r in
    select c.relname as table_name, p.polname as policy_name,
           pg_catalog.pg_get_expr(p.polqual, p.polrelid) as qual
    from pg_catalog.pg_policy p
    join pg_catalog.pg_class c on c.oid = p.polrelid
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname in ('clients', 'loans')
      and p.polcmd = 'r'
  loop
    execute pg_catalog.format(
      'alter policy %I on public.%I using (%s and public.user_can_see_branch(branch_id))',
      r.policy_name, r.table_name, r.qual
    );
  end loop;
end
$scope$;

-- ---------------------------------------------------------------------------
-- Reference scopes for the new documents
-- ---------------------------------------------------------------------------

insert into public.reference_formats (scope, prefix, padding, description)
values
  ('transfer',       'TF', 5, 'Account transfers, e.g. TF2600001'),
  ('expense',        'EX', 5, 'Expense vouchers, e.g. EX2600001'),
  ('other_income',   'OI', 5, 'Other income receipts, e.g. OI2600001'),
  ('reconciliation', 'RC', 5, 'Account reconciliations, e.g. RC2600001')
on conflict (scope) do nothing;

-- ---------------------------------------------------------------------------
-- Capabilities
-- ---------------------------------------------------------------------------

insert into public.permissions (key, description) values
  ('transfers:view',        'See transfers between the company''s own accounts.'),
  ('transfers:create',      'Move money between the company''s own accounts.'),
  ('transfers:approve',     'Approve or reject a transfer that is waiting.'),
  ('expenses:view',         'See what the business has spent.'),
  ('expenses:create',       'Record an expense.'),
  ('expenses:approve',      'Approve or reject an expense that is waiting.'),
  ('income:view',           'See non-loan income.'),
  ('income:create',         'Record a fee or other non-loan income.'),
  ('reconciliation:view',   'See account reconciliations and their differences.'),
  ('reconciliation:perform','Count an account and record what was found.'),
  ('reconciliation:approve','Approve a reconciliation difference, writing it off to Cash Over and Short.'),
  ('finance:settings',      'Change approval thresholds, overdraft policy and low-balance levels.'),
  ('finance:accounts',      'Add or retire a ledger account, including an expense or income category.')
on conflict (key) do nothing;

insert into public.role_permissions (role_key, permission_key) values
  ('secretary_treasurer', 'transfers:view'),
  ('secretary_treasurer', 'transfers:create'),
  ('secretary_treasurer', 'expenses:view'),
  ('secretary_treasurer', 'expenses:create'),
  ('secretary_treasurer', 'income:view'),
  ('secretary_treasurer', 'income:create'),
  ('secretary_treasurer', 'reconciliation:view'),
  ('secretary_treasurer', 'reconciliation:perform'),

  ('manager', 'transfers:view'),
  ('manager', 'transfers:create'),
  ('manager', 'transfers:approve'),
  ('manager', 'expenses:view'),
  ('manager', 'expenses:create'),
  ('manager', 'expenses:approve'),
  ('manager', 'income:view'),
  ('manager', 'income:create'),
  ('manager', 'reconciliation:view'),
  ('manager', 'reconciliation:perform'),
  ('manager', 'reconciliation:approve'),

  ('owner_admin', 'transfers:view'),
  ('owner_admin', 'transfers:create'),
  ('owner_admin', 'transfers:approve'),
  ('owner_admin', 'expenses:view'),
  ('owner_admin', 'expenses:create'),
  ('owner_admin', 'expenses:approve'),
  ('owner_admin', 'income:view'),
  ('owner_admin', 'income:create'),
  ('owner_admin', 'reconciliation:view'),
  ('owner_admin', 'reconciliation:perform'),
  ('owner_admin', 'reconciliation:approve'),
  ('owner_admin', 'finance:settings'),
  ('owner_admin', 'finance:accounts')
on conflict (role_key, permission_key) do nothing;

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------

alter table public.finance_settings enable row level security;

revoke all on table public.finance_settings from anon, authenticated;
grant select on table public.finance_settings to authenticated;

create policy finance_settings_select_with_permission
  on public.finance_settings for select to authenticated
  using (public.user_has_permission('settings:view'));
