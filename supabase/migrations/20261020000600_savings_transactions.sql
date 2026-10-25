-- ===========================================================================
-- Polytos Phase 2.6 — the savings subledger, and the deposit
--
-- ## Every row is positive; the sign is derived
--
-- `amount` is always a positive number of shillings, because that is what a
-- receipt shows and what a person says. `signed_amount` is **generated** from
-- the kind:
--
--   deposit              +amount    money in
--   withdrawal           -amount    money out
--   deposit_reversal     -amount    a deposit un-done
--   withdrawal_reversal  +amount    a withdrawal un-done
--
-- The balance is then `sum(signed_amount)` and nothing else. No column to
-- drift, no trigger to maintain one, no possibility of the summary and the
-- detail disagreeing. A generated column cannot be written, so the sign
-- cannot be forged into the wrong direction either.
--
-- ## A reversal is a row, not a status
--
-- Nothing here is ever edited or deleted. Reversing a deposit inserts a
-- `deposit_reversal` pointing at it, which moves the balance back and leaves
-- both facts visible on the statement. `reverses_transaction_id` is unique,
-- so a transaction is reversed at most once.
--
-- This is also why there is no `status` column. "Reversed" is not a property
-- of the original row; it is the existence of another row, which is how the
-- journal already works and how an auditor already reads it.
--
-- ## The contribution month is stamped in Kampala, once
--
-- `value_date` is `business_date()` — already Africa/Kampala — and
-- `contribution_month` is generated from it. A deposit taken at 00:30 on the
-- 1st in Kampala belongs to the new month, and a deposit at 23:30 on the 31st
-- belongs to the old one, without any reader of this table having to know
-- what timezone it was written in. The monthly engine in 20261020001200 then
-- groups on a column rather than re-deriving a boundary each time it runs.
-- ===========================================================================

create table public.savings_transactions (
  id uuid primary key default gen_random_uuid(),

  transaction_number text not null unique,

  savings_account_id uuid not null
    references public.savings_accounts(id) on delete restrict,
  -- Denormalised, as the receipt fields are: a statement line has to stay
  -- attributable without four joins.
  membership_id uuid not null references public.memberships(id) on delete restrict,
  client_id uuid not null references public.clients(id) on delete restrict,
  branch_id uuid not null references public.branches(id) on delete restrict,

  kind text not null,

  amount bigint not null,
  signed_amount bigint generated always as (
    case kind
      when 'deposit' then amount
      when 'withdrawal_reversal' then amount
      else -amount
    end
  ) stored,

  -- Where the money moved. NULL on a reversal only when the original had
  -- none, which cannot happen — every movement touches a cash account — so
  -- in practice always set.
  payment_method text,
  cash_account_id uuid references public.ledger_accounts(id) on delete restrict,
  external_reference text,

  idempotency_key uuid not null unique,

  value_date date not null,
  contribution_month date generated always as (
    pg_catalog.make_date(
      pg_catalog.date_part('year', value_date)::integer,
      pg_catalog.date_part('month', value_date)::integer,
      1)
  ) stored,
  occurred_at timestamptz not null default pg_catalog.now(),

  journal_entry_id uuid references public.journal_entries(id) on delete restrict,

  -- Set on a reversal row: the transaction it un-does.
  reverses_transaction_id uuid
    references public.savings_transactions(id) on delete restrict,
  reversal_reason text,

  -- Set on a withdrawal: the request it pays.
  withdrawal_request_id uuid,

  -- RESTRICT, not SET NULL. This table refuses UPDATE outright, and an
  -- implicit SET NULL *is* an UPDATE — deleting a staff profile would be
  -- refused by the append-only trigger with an error naming the wrong table.
  -- `notifications` and `membership_status_history` hold their references
  -- the same way, and `recorded_by_label` is what makes it affordable: the
  -- name survives even where the id could not.
  recorded_by uuid references public.profiles(id) on delete restrict,
  recorded_by_label text not null default 'system',
  notes text,

  created_at timestamptz not null default pg_catalog.now(),

  constraint savings_transaction_number_shape
    check (transaction_number ~ '^SV[0-9]{7,}$'),
  constraint savings_transaction_kind_valid
    check (kind in ('deposit', 'withdrawal', 'deposit_reversal', 'withdrawal_reversal')),
  constraint savings_transaction_amount_positive
    check (amount > 0 and amount <= 1000000000000),
  constraint savings_transaction_method_valid
    check (payment_method is null
           or payment_method in ('cash', 'mtn_mobile_money', 'airtel_money', 'bank')),
  constraint savings_transaction_cash_has_no_reference
    check (payment_method is distinct from 'cash' or external_reference is null),
  constraint savings_transaction_reference_length
    check (external_reference is null
           or char_length(btrim(external_reference)) between 4 and 100),
  -- A reversal names what it reverses and why; an original names neither.
  constraint savings_transaction_reversal_is_complete
    check (
      (kind in ('deposit_reversal', 'withdrawal_reversal'))
      = (reverses_transaction_id is not null and reversal_reason is not null)
    ),
  constraint savings_transaction_reversal_reason_length
    check (reversal_reason is null
           or char_length(btrim(reversal_reason)) between 4 and 500),
  constraint savings_transaction_withdrawal_names_request
    check (kind <> 'withdrawal' or withdrawal_request_id is not null),
  constraint savings_transaction_notes_length
    check (notes is null or char_length(notes) <= 1000),
  constraint savings_transaction_value_date_plausible
    check (value_date >= '2020-01-01'::date)
);

comment on table public.savings_transactions is
  'Polytos Phase 2. The member savings subledger. Append-only: a correction is a reversal row, never an edit. The balance is sum(signed_amount), and there is no balance column to disagree with it.';
comment on column public.savings_transactions.signed_amount is
  'Generated from the kind. Deposits and withdrawal reversals add; withdrawals and deposit reversals subtract. Cannot be written, so the direction cannot be forged.';
comment on column public.savings_transactions.contribution_month is
  'Generated from value_date, which is the Africa/Kampala business date. The month a contribution counts towards, decided once at posting rather than re-derived by every reader.';

-- A transaction is reversed at most once.
create unique index savings_transactions_one_reversal_per_original
  on public.savings_transactions (reverses_transaction_id)
  where reverses_transaction_id is not null;

-- One network reference, one movement of money — the rule the loan payments
-- already carry.
create unique index savings_transactions_reference_unique
  on public.savings_transactions (payment_method, external_reference)
  where external_reference is not null;

-- A withdrawal request is paid once.
create unique index savings_transactions_one_payment_per_request
  on public.savings_transactions (withdrawal_request_id)
  where kind = 'withdrawal';

-- The statement: an account's transactions in order.
create index savings_transactions_account_idx
  on public.savings_transactions (savings_account_id, value_date, transaction_number);
-- The contribution engine: an account's months.
create index savings_transactions_contribution_idx
  on public.savings_transactions (savings_account_id, contribution_month);
create index savings_transactions_client_idx on public.savings_transactions (client_id);
create index savings_transactions_branch_date_idx
  on public.savings_transactions (branch_id, value_date desc);
create index savings_transactions_kind_idx on public.savings_transactions (kind);

-- ---------------------------------------------------------------------------
-- The transaction number, and append-only enforcement
-- ---------------------------------------------------------------------------

create or replace function public.savings_transactions_assign_number()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.transaction_number is not null then
    raise exception
      'A savings transaction number is assigned by the database, not by the caller.'
      using errcode = 'P0001';
  end if;

  new.transaction_number := public.next_reference('savings_transaction');
  return new;
end;
$$;

create trigger savings_transactions_assign_number
  before insert on public.savings_transactions
  for each row execute function public.savings_transactions_assign_number();

revoke all on function public.savings_transactions_assign_number()
  from public, anon, authenticated;

-- Append-only in the strict sense: no UPDATE at all, no DELETE at all. Both
-- statement-level, and no privilege is granted for either, so the trigger is
-- the second line rather than the first.
create trigger savings_transactions_no_update
  before update on public.savings_transactions
  for each statement execute function public.reject_mutation();

create trigger savings_transactions_no_delete
  before delete on public.savings_transactions
  for each statement execute function public.reject_mutation();

-- ---------------------------------------------------------------------------
-- The balance, and the register
--
-- `security_invoker = true` on both, so every underlying policy still
-- applies: a borrower reading the register sees their own account and no
-- other, because `savings_accounts` says so.
-- ---------------------------------------------------------------------------

create or replace view public.member_savings_balances
with (security_invoker = true) as
select
  a.id                      as savings_account_id,
  a.account_number,
  a.membership_id,
  a.client_id,
  a.branch_id,
  a.status,
  a.opened_on,
  a.policy_version_id,
  coalesce(sum(t.signed_amount), 0)::bigint                      as balance,
  coalesce(sum(t.amount) filter (where t.kind = 'deposit'), 0)::bigint
                                                                 as total_deposited,
  coalesce(sum(t.amount) filter (where t.kind = 'withdrawal'), 0)::bigint
                                                                 as total_withdrawn,
  coalesce(sum(t.amount) filter (where t.kind = 'deposit_reversal'), 0)::bigint
                                                                 as total_deposits_reversed,
  coalesce(sum(t.amount) filter (where t.kind = 'withdrawal_reversal'), 0)::bigint
                                                                 as total_withdrawals_reversed,
  count(t.id)                                                    as transaction_count,
  max(t.value_date)                                              as last_transaction_on
from public.savings_accounts a
left join public.savings_transactions t on t.savings_account_id = a.id
group by a.id, a.account_number, a.membership_id, a.client_id, a.branch_id,
         a.status, a.opened_on, a.policy_version_id;

comment on view public.member_savings_balances is
  'Polytos Phase 2. A savings account''s authoritative balance, computed from its transactions. There is no stored balance for this to disagree with.';

create or replace view public.savings_account_register
with (security_invoker = true) as
select
  b.savings_account_id,
  b.account_number,
  b.membership_id,
  m.membership_number,
  m.status                  as membership_status,
  b.client_id,
  c.client_number,
  c.full_name,
  c.phone,
  b.branch_id,
  br.name                   as branch_name,
  b.status                  as account_status,
  b.opened_on,
  b.balance,
  b.total_deposited,
  b.total_withdrawn,
  b.transaction_count,
  b.last_transaction_on,
  v.monthly_savings_minimum,
  v.savings_qualifying_months
from public.member_savings_balances b
join public.savings_accounts a on a.id = b.savings_account_id
join public.memberships m on m.id = b.membership_id
join public.clients c on c.id = b.client_id
join public.membership_policy_versions v on v.id = b.policy_version_id
left join public.branches br on br.id = b.branch_id;

comment on view public.savings_account_register is
  'Polytos Phase 2. The savings register: an account, its member, its branch and its balance, as one read.';

-- ===========================================================================
-- post_savings_deposit()
--
--   Debit   the branch's cash / MTN / Airtel / bank account
--   Credit  2100 Member Savings       <- a liability, never income
--
-- The credit leg is the thing to get right. A deposit increases what the
-- business owes its member; it is not a sale and it must not reach a profit
-- figure. Crediting an income account here would overstate the year's surplus
-- by the whole savings book and, in Phase 5, pay a profit share out of
-- deposits.
-- ===========================================================================

create or replace function public.post_savings_deposit(
  p_savings_account_id uuid,
  p_amount bigint,
  p_payment_method text,
  p_external_reference text,
  p_idempotency_key uuid,
  p_notes text default null
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_account     public.savings_accounts;
  v_membership  public.memberships;
  v_actor       uuid;
  v_label       text;
  v_reference   text;
  v_txn_id      uuid;
  v_cash        uuid;
  v_liability   uuid;
  v_entry_id    uuid;
  v_date        date;
begin
  v_actor := public.current_profile_id();
  v_label := public.audit_actor_label();

  -- Authorisation first, and **above the replay shortcut below**, which is
  -- not an ordering detail. A caller who may not deposit must not be able to
  -- learn a transaction id by replaying a key either: the early return is a
  -- read of somebody else's movement, and putting it before this check would
  -- have made every posted deposit readable by any signed-in caller holding a
  -- key. The rule is: establish who is asking, then decide whether this is a
  -- retry of their own request.
  if v_actor is null and auth.uid() is not null then
    raise exception
      'A deposit must be recorded by a signed-in member of staff.'
      using errcode = 'P0001';
  end if;

  if auth.uid() is not null and not public.user_has_permission('savings:deposit') then
    raise exception 'Recording a deposit requires the savings:deposit capability.'
      using errcode = 'P0001';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('savings_txn_key:' || p_idempotency_key::text)
  );

  select id into v_txn_id
  from public.savings_transactions where idempotency_key = p_idempotency_key;

  -- The retry path. A lost response, a double tap, a replayed form: the money
  -- is recorded once and the caller gets the answer it would have had.
  if v_txn_id is not null then
    return v_txn_id;
  end if;

  if p_amount is null or p_amount <= 0 then
    raise exception 'A deposit must be more than zero shillings.'
      using errcode = 'P0001';
  end if;

  -- Locked for the rest of the transaction. A concurrent deposit or
  -- withdrawal on the same account waits here.
  select * into v_account
  from public.savings_accounts where id = p_savings_account_id for update;

  if not found then
    raise exception 'No such savings account.' using errcode = 'P0001';
  end if;

  if v_account.status = 'closed' then
    raise exception
      'Savings account % is closed.', v_account.account_number
      using errcode = 'P0001';
  end if;

  select * into v_membership
  from public.memberships where id = v_account.membership_id;

  if v_membership.status not in ('pending', 'active', 'suspended') then
    raise exception
      'Membership % has ended. Its savings account takes no further deposits.',
      v_membership.membership_number using errcode = 'P0001';
  end if;

  if not public.membership_policy_allows(v_account.policy_version_id, 'savings') then
    raise exception
      'Savings are not open under the policy version governing this account. The savings rules have not been decided.'
      using errcode = 'P0001';
  end if;

  -- --- The method and its reference ---------------------------------------
  if p_payment_method not in ('cash', 'mtn_mobile_money', 'airtel_money', 'bank') then
    raise exception 'Unknown payment method "%".', p_payment_method
      using errcode = 'P0001';
  end if;

  v_reference := pg_catalog.upper(pg_catalog.btrim(coalesce(p_external_reference, '')));
  if v_reference = '' then
    v_reference := null;
  end if;

  if p_payment_method = 'cash' then
    if v_reference is not null then
      raise exception
        'A cash deposit has no network reference. Its transaction number is its reference.'
        using errcode = 'P0001';
    end if;
  elsif v_reference is null then
    raise exception
      'A % deposit needs the reference from the network or the bank. It is what makes the line findable when the account is reconciled.',
      p_payment_method using errcode = 'P0001';
  elsif char_length(v_reference) < 4 then
    raise exception
      'That transaction reference is too short to identify a deposit.'
      using errcode = 'P0001';
  end if;

  v_cash := public.branch_cash_account(
    v_account.branch_id, public.payment_method_cash_kind(p_payment_method));
  v_liability := public.ledger_account_by_code('2100');
  v_date := public.business_date();

  -- The id is minted here rather than by the default, so the journal can
  -- name its source before the source row exists and the row can carry its
  -- entry id from the moment it is written.
  --
  -- The alternative — insert, post, then UPDATE the entry id back — would
  -- need the append-only trigger suspended for the duration, and
  -- `alter table ... disable trigger` takes an ACCESS EXCLUSIVE lock on the
  -- whole table. Every deposit in the business would serialise behind every
  -- other, and readers would block too. `journal_entries.source_id` carries
  -- no foreign key precisely so this ordering is available.
  v_txn_id := pg_catalog.gen_random_uuid();

  v_entry_id := public.post_journal(
    v_account.branch_id,
    v_date,
    'Member savings deposit — ' || v_account.account_number,
    'savings_deposit',
    v_txn_id,
    null,
    v_account.client_id,
    pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'account_id', v_cash, 'debit', p_amount, 'credit', 0,
        'memo', 'Savings received'),
      pg_catalog.jsonb_build_object(
        'account_id', v_liability, 'debit', 0, 'credit', p_amount,
        'memo', 'Member savings — ' || v_account.account_number)
    ),
    null, v_actor, v_label
  );

  insert into public.savings_transactions (
    id, savings_account_id, membership_id, client_id, branch_id,
    kind, amount, payment_method, cash_account_id, external_reference,
    idempotency_key, value_date, journal_entry_id,
    recorded_by, recorded_by_label, notes
  )
  values (
    v_txn_id, p_savings_account_id, v_account.membership_id, v_account.client_id,
    v_account.branch_id,
    'deposit', p_amount, p_payment_method, v_cash, v_reference,
    p_idempotency_key, v_date, v_entry_id, v_actor, v_label,
    nullif(pg_catalog.btrim(coalesce(p_notes, '')), '')
  );

  return v_txn_id;
end;
$$;

comment on function public.post_savings_deposit(uuid, bigint, text, text, uuid, text) is
  'Polytos Phase 2. Records a savings deposit and posts it: debit the branch cash account, credit 2100 Member Savings. A liability, never income. Idempotent on p_idempotency_key.';

revoke all on function public.post_savings_deposit(uuid, bigint, text, text, uuid, text)
  from public, anon;
grant execute on function public.post_savings_deposit(uuid, bigint, text, text, uuid, text)
  to authenticated;
