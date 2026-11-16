-- ===========================================================================
-- Decision A, part 1 of 4 — available funds, and the restriction on a receipt
--
-- The Owner's ruling of 2026-11-16: NO UNFUNDED PAYOUTS. Every outgoing
-- payment must be covered by funds that are actually available in the one
-- account it leaves; balances are never pooled; `allow_negative_cash` is no
-- longer an override; and money received physically is restricted until a
-- different authorised officer confirms it.
--
-- Until now the system had one balance — `ledger_account_balance()`, the sum
-- of every journal line — and one sufficiency check, `assert_cash_available`,
-- which read `allow_negative_cash` and was reached from the transfer, expense,
-- income and agency paths and from nothing in lending. A branch till reached
-- −345,000 during the full-system audit because a loan was disbursed from a
-- branch that had never been funded, and nothing refused it
-- (docs/POLYTOS-FULL-SYSTEM-BUSINESS-RULES-CERTIFICATION.md, GAP-001).
--
-- ## The model: a restriction, not a second ledger
--
-- A receipt is posted exactly as it always was — one journal, at receipt, to
-- the real cash account, on the real date — so every borrower figure, arrears
-- amount, delinquency state and reconciliation identity is unchanged (A-10).
-- What is added is a *restriction record* beside it:
--
--     available = booked − pending confirmations
--
-- Nothing is cached (ADR-052): both terms are derived on demand. A receipt
-- that nobody has confirmed therefore counts for the borrower and for the
-- ledger, and not yet for the company's spending.
--
-- ## Which inflows are restricted
--
-- Physical cash and wallet money arriving at the counter: a loan repayment, a
-- savings deposit, a membership fee, a meeting fine, other income. These are
-- `receipt_requires_confirmation()`'s allowlist and nothing else.
--
-- An agency / Mobile Money transaction carries NO restriction. Its journal is
-- written *by* `verify_agency_transaction`, which is already the independent
-- verification by a second officer, so a second confirmation would be the
-- duplicate posting A-3 and D-3 forbid. Opening balances, transfers between
-- the business's own accounts, deposits to the bank, clearances and every
-- reversal are not receipts and carry none either.
--
-- ## Where the check runs
--
-- `assert_cash_available` — reached by every money-out path that already
-- checked sufficiency — is redefined here to check *available* funds, under
-- the account lock, with no override. `assert_cash_funds_available` is the
-- same check under the name Decision A gives it, for the lending paths that
-- checked nothing (part 4). Part 4 also adds a deferred constraint trigger so
-- that the rule binds at the storage level, for every caller, including any
-- posting path written later.
--
-- ## What this migration does not do
--
-- It writes no confirmation row for any historical receipt and posts nothing.
-- The absence of a record means "available", so no historical figure moves
-- (plan §11.3). Whether legacy till cash is physically present is an
-- operational cutover question (plan §11.4), not something a migration can
-- assert.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. The restriction record
-- ---------------------------------------------------------------------------

create table public.cash_receipt_confirmations (
  id                  uuid primary key default gen_random_uuid(),
  -- Cascading, because a confirmation is *about* an entry and has no
  -- meaning without it. The ledger grants DELETE to nobody, so in the
  -- product this never fires; it keeps the table from blocking the
  -- owner-level cleanup the test fixtures do.
  journal_entry_id    uuid not null references public.journal_entries(id) on delete cascade,
  account_id          uuid not null references public.ledger_accounts(id) on delete restrict,
  branch_id           uuid not null references public.branches(id) on delete restrict,
  amount              bigint not null,
  source_type         text not null,
  state               text not null default 'pending',
  recorded_by         uuid references public.profiles(id) on delete restrict,
  recorded_by_label   text not null,
  confirmed_by        uuid references public.profiles(id) on delete restrict,
  confirmed_by_label  text,
  confirmed_at        timestamptz,
  confirmation_note   text,
  void_reason         text,
  voided_at           timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  constraint cash_receipt_confirmations_amount_positive
    check (amount > 0),
  constraint cash_receipt_confirmations_state_valid
    check (state in ('pending', 'confirmed', 'voided')),
  -- A confirmation names who confirmed and when, or it is not one.
  --
  -- The *label* is mandatory and the profile id is not, which is the same
  -- shape `recorded_by` / `recorded_by_label` take above and the same one
  -- every money-in document in this schema uses. A trusted no-JWT path — the
  -- ledger backfill, a migration, a seeder — has no `current_profile_id()`
  -- to offer, and refusing it a label of its own would mean refusing it the
  -- row. What must never happen is a confirmation with nobody's name on it,
  -- and the label is what carries that.
  constraint cash_receipt_confirmations_confirmed_complete
    check (
      (state <> 'confirmed')
      or (confirmed_by_label is not null and btrim(confirmed_by_label) <> ''
          and confirmed_at is not null)
    ),
  constraint cash_receipt_confirmations_void_has_reason
    check (
      (state <> 'voided')
      or (void_reason is not null and btrim(void_reason) <> '' and voided_at is not null)
    ),
  -- A-1. Nobody confirms their own receipt. Stated here so it cannot be
  -- forgotten by any route, including service_role; restated in the function
  -- so the refusal arrives as a sentence rather than a constraint name.
  constraint cash_receipt_confirmations_verifier_not_recorder
    check (confirmed_by is null or recorded_by is null or confirmed_by <> recorded_by),
  -- One restriction per cash line of one entry.
  constraint cash_receipt_confirmations_one_per_line
    unique (journal_entry_id, account_id)
);

comment on table public.cash_receipt_confirmations is
  'Decision A. The restriction on money received physically or by wallet: one row per cash line of a receipt journal, pending until a different authorised officer confirms it. available = booked − pending. Written only by post_journal(); never by hand. Absent for every historical receipt, which therefore counts as available.';
comment on column public.cash_receipt_confirmations.state is
  'pending — restricts the amount; confirmed — released by a second officer; voided — the receipt was reversed before it was confirmed, so there is nothing left to confirm.';

create index cash_receipt_confirmations_pending_idx
  on public.cash_receipt_confirmations (account_id)
  where state = 'pending';
create index cash_receipt_confirmations_branch_idx
  on public.cash_receipt_confirmations (branch_id, state, created_at desc);

create trigger cash_receipt_confirmations_set_updated_at
  before update on public.cash_receipt_confirmations
  for each row execute function public.set_updated_at();

create trigger cash_receipt_confirmations_no_delete
  before delete on public.cash_receipt_confirmations
  for each row execute function public.reject_mutation();

-- What a confirmation is *about* is write-once. Only the state and the
-- confirmer/void columns may change, and only forward.
create or replace function public.cash_receipt_confirmations_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.journal_entry_id <> old.journal_entry_id
     or new.account_id <> old.account_id
     or new.branch_id <> old.branch_id
     or new.amount <> old.amount
     or new.source_type <> old.source_type
     or new.recorded_by is distinct from old.recorded_by
     or new.recorded_by_label <> old.recorded_by_label then
    raise exception
      'A receipt confirmation describes one cash line of one entry; what it is about cannot be edited.'
      using errcode = 'P0001';
  end if;

  if old.state <> 'pending' and new.state <> old.state then
    raise exception
      'A receipt confirmation that is % cannot become %.', old.state, new.state
      using errcode = 'P0001';
  end if;

  return new;
end;
$$;

revoke all on function public.cash_receipt_confirmations_guard() from public, anon, authenticated;

create trigger cash_receipt_confirmations_guard
  before update on public.cash_receipt_confirmations
  for each row execute function public.cash_receipt_confirmations_guard();

alter table public.cash_receipt_confirmations enable row level security;

revoke all on table public.cash_receipt_confirmations from public, anon, authenticated;
grant select on public.cash_receipt_confirmations to authenticated;

-- ---------------------------------------------------------------------------
-- 2. Which receipts carry the restriction
-- ---------------------------------------------------------------------------

create or replace function public.receipt_requires_confirmation(p_source_type text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_source_type in (
    'loan_repayment',
    'savings_deposit',
    'membership_fee',
    'other_income'      -- including a meeting fine, which posts under it
  );
$$;

revoke all on function public.receipt_requires_confirmation(text)
  from public, anon, authenticated;

comment on function public.receipt_requires_confirmation(text) is
  'Decision A. The allowlist of journal source types whose cash lines are restricted until confirmed. Deliberately not "everything that debits cash": an agency transaction is already independently verified when its journal is written, and transfers, deposits, clearances and reversals are not receipts.';

-- Written from inside post_journal(), over the lines it has just inserted —
-- one place instead of five, so a receipt path added later is covered too.
--
-- ## Why the entry's own date decides
--
-- A restriction means "cash arrived at the counter and nobody has counted it
-- yet". That can only be said of money arriving *now*. A journal dated in the
-- past is history being written down — the ledger backfill replaying four
-- months of recorded payments, or a fixture building a book — and the cash it
-- describes was received, banked or spent long ago. Restricting it would
-- freeze the whole opening position behind a confirmation queue for receipts
-- nobody alive can confirm.
--
-- This is not a way around the rule. Every receipt path in the application
-- posts on `business_date()` and offers no date field: `post_payment`,
-- `post_savings_deposit`, `record_membership_fee`, `post_meeting_fine_payment`
-- and `record_other_income` all take the business clock, not a caller's
-- choice. A backdated receipt is reachable only by the backfill and by test
-- fixtures, neither of which is a cashier.
create or replace function public.register_receipt_restrictions(
  p_entry_id   uuid,
  p_source_type text,
  p_branch_id  uuid,
  p_recorded_by uuid,
  p_recorded_by_label text,
  p_entry_date date default null
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rows integer := 0;
begin
  if not public.receipt_requires_confirmation(p_source_type) then
    return 0;
  end if;

  -- History, not a receipt. See the header.
  if p_entry_date is not null and p_entry_date < public.business_date() then
    return 0;
  end if;

  insert into public.cash_receipt_confirmations
    (journal_entry_id, account_id, branch_id, amount, source_type,
     recorded_by, recorded_by_label)
  select p_entry_id, l.account_id, p_branch_id, (l.debit - l.credit), p_source_type,
         p_recorded_by, coalesce(p_recorded_by_label, 'system')
    from public.journal_lines l
    join public.ledger_accounts a on a.id = l.account_id
   where l.entry_id = p_entry_id
     and a.cash_kind in ('cash_at_hand', 'mtn_mobile_money', 'airtel_money', 'bank')
     and l.debit > l.credit
  on conflict (journal_entry_id, account_id) do nothing;

  get diagnostics v_rows = row_count;
  return v_rows;
end;
$$;

revoke all on function public.register_receipt_restrictions(uuid, text, uuid, uuid, text, date)
  from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. post_journal, with the hook
--
-- Re-emitted from its live definition (20261112000100) with one addition at
-- the end. Everything above the hook is verbatim.
-- ---------------------------------------------------------------------------

create or replace function public.post_journal(
  p_branch_id uuid, p_entry_date date, p_description text, p_source_type text,
  p_source_id uuid, p_loan_id uuid, p_client_id uuid, p_lines jsonb,
  p_posted_at timestamp with time zone default null,
  p_created_by uuid default null, p_created_by_label text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_entry_id uuid;
  v_line     jsonb;
  v_number   smallint := 0;
  v_debit    bigint;
  v_credit   bigint;
  v_by       uuid;
  v_label    text;
begin
  -- Workstream A (20261112000100). Every cash and float account this entry
  -- touches, locked before a single line is written and before
  -- `next_reference` is taken. Global order: provider lock, account locks
  -- (sorted), counter.
  perform public.lock_ledger_balances(array(
    select (l ->> 'account_id')::uuid
      from pg_catalog.jsonb_array_elements(p_lines) l
      join public.ledger_accounts a on a.id = (l ->> 'account_id')::uuid
     where a.cash_kind is not null
  ));

  v_by := coalesce(p_created_by, public.current_profile_id());
  v_label := coalesce(nullif(pg_catalog.btrim(coalesce(p_created_by_label, '')), ''),
                      public.audit_actor_label());

  insert into public.journal_entries (
    entry_number, branch_id, entry_date, posted_at, description,
    source_type, source_id, loan_id, client_id, created_by, created_by_label
  )
  values (
    public.next_reference('journal'),
    p_branch_id,
    p_entry_date,
    coalesce(p_posted_at, pg_catalog.now()),
    p_description,
    p_source_type,
    p_source_id,
    p_loan_id,
    p_client_id,
    v_by,
    v_label
  )
  returning id into v_entry_id;

  for v_line in select * from pg_catalog.jsonb_array_elements(p_lines)
  loop
    v_debit := coalesce((v_line ->> 'debit')::bigint, 0);
    v_credit := coalesce((v_line ->> 'credit')::bigint, 0);

    -- A component that is zero is not a line.
    continue when v_debit = 0 and v_credit = 0;

    v_number := v_number + 1;

    insert into public.journal_lines
      (entry_id, line_number, account_id, debit, credit, memo)
    values
      (v_entry_id, v_number, (v_line ->> 'account_id')::uuid, v_debit, v_credit,
       nullif(pg_catalog.btrim(coalesce(v_line ->> 'memo', '')), ''));
  end loop;

  -- Decision A. A receipt's cash lines are restricted until confirmed. Written
  -- here, over the lines just inserted, so no receipt path can forget it.
  perform public.register_receipt_restrictions(
    v_entry_id, p_source_type, p_branch_id, v_by, v_label, p_entry_date);

  return v_entry_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Booked, pending, available
-- ---------------------------------------------------------------------------

-- Derived from the rows, never stored. Reads one account and nothing else:
-- no sibling, no branch total, no reconciliation (A-3, A-5).
create or replace function public.cash_account_pending_amount(p_account_id uuid)
returns bigint
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(pg_catalog.sum(c.amount), 0)::bigint
    from public.cash_receipt_confirmations c
   where c.account_id = p_account_id
     and c.state = 'pending';
$$;

create or replace function public.cash_account_available_balance(p_account_id uuid)
returns bigint
language sql
stable
security definer
set search_path = ''
as $$
  select public.ledger_account_balance(p_account_id)
       - public.cash_account_pending_amount(p_account_id);
$$;

comment on function public.cash_account_available_balance(uuid) is
  'Decision A. What this one account may actually pay out: its booked balance less every receipt on it that nobody has yet confirmed. Never an aggregate, never a cache.';

-- `cash_account_available_balance` is reachable from a session; the pending
-- figure on its own is not. The available figure passes through
-- `ledger_account_balance`, which refuses a caller who may not read company
-- ledger balances, so the composition is guarded. The pending total has no
-- such gate of its own, and granting it would hand a borrower the amount of
-- uncounted cash sitting in a branch drawer. Nothing outside the database
-- calls it: the screens read `cash_account_availability`, whose rows the
-- `receipts:view` policy decides, and the internal callers are all SECURITY
-- DEFINER, so they execute it as the owner and need no grant.
revoke all on function public.cash_account_pending_amount(uuid)
  from public, anon, authenticated;
revoke all on function public.cash_account_available_balance(uuid) from public, anon;
grant execute on function public.cash_account_available_balance(uuid) to authenticated;

-- An account money may leave at the counter. Refuses what is not cash, what
-- is not active, and the kinds that are cash in the ledger's sense but may
-- only be moved by their own module: agency float by the agency engine, and
-- Cash in Transit (part 2) by clearance and verified return alone.
create or replace function public.assert_spendable_account(p_account_id uuid, p_role text)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  r record;
begin
  select a.cash_kind, a.status, a.name, a.is_postable into r
    from public.ledger_accounts a where a.id = p_account_id;

  if r is null then
    raise exception 'The % account does not exist.', coalesce(p_role, 'funding')
      using errcode = 'P0001';
  end if;

  if r.cash_kind is null then
    raise exception '% is not a cash account, so money cannot be paid out of it.', r.name
      using errcode = 'P0001';
  end if;

  if r.cash_kind = 'agency_float' then
    raise exception
      '% is an agency float account. Float is moved through the agency services module, not paid out at the counter.',
      r.name using errcode = 'P0001';
  end if;

  if r.cash_kind = 'in_transit' then
    raise exception
      '% holds money on its way to the bank. It is not spendable until the bank has cleared it, and it can only be moved by a verified clearance or a verified physical return.',
      r.name using errcode = 'P0001';
  end if;

  if r.status <> 'active' or not r.is_postable then
    raise exception '% is not active, so it cannot be used.', r.name
      using errcode = 'P0001';
  end if;
end;
$$;

revoke all on function public.assert_spendable_account(uuid, text) from public, anon, authenticated;

-- The check. Lock first, read after, raise if short. No override argument,
-- no override setting, no capability that skips it (A-4).
create or replace function public.assert_cash_funds_available(p_account_id uuid, p_amount bigint)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_booked    bigint;
  v_pending   bigint;
  v_available bigint;
  v_name      text;
  v_kind      text;
begin
  if p_amount is null or p_amount <= 0 then
    raise exception 'A payout must be a positive number of shillings.'
      using errcode = 'P0001';
  end if;

  -- Before the balance is read, so the read is not stale by the time the
  -- caller posts against it. The same lock post_journal() takes, so the two
  -- serialise on this account.
  perform public.lock_ledger_balances(array[p_account_id]);

  select a.name, a.cash_kind into v_name, v_kind
    from public.ledger_accounts a where a.id = p_account_id;

  if v_name is null then
    raise exception 'No such ledger account.' using errcode = 'P0001';
  end if;

  v_booked  := public.ledger_account_balance(p_account_id);
  v_pending := case when v_kind = 'in_transit' then 0
                    else public.cash_account_pending_amount(p_account_id) end;
  v_available := v_booked - v_pending;

  if v_available >= p_amount then
    return;
  end if;

  if v_pending > 0 then
    raise exception
      '% holds % shillings available (% booked, % awaiting confirmation), which is less than the % being taken out of it.',
      v_name, v_available, v_booked, v_pending, p_amount
      using errcode = 'P0001';
  end if;

  raise exception
    '% holds % shillings, which is less than the % being taken out of it.',
    v_name, v_available, p_amount
    using errcode = 'P0001';
end;
$$;

comment on function public.assert_cash_funds_available(uuid, bigint) is
  'Decision A, A-4. Refuses to take more out of one cash account than it holds as available — booked less unconfirmed receipts — under the account lock. There is no override: not allow_negative_cash, not a capability, not an argument.';

revoke all on function public.assert_cash_funds_available(uuid, bigint) from public, anon, authenticated;

-- Every existing caller — the transfer, expense, income and agency paths —
-- reaches this name. It now means available funds, with no override. Kept
-- under its old name precisely so that no caller has to change and none can
-- be missed.
create or replace function public.assert_cash_available(p_account_id uuid, p_amount bigint)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  perform public.assert_cash_funds_available(p_account_id, p_amount);
end;
$$;

comment on function public.assert_cash_available(uuid, bigint) is
  'Decision A. Since 20261120000100 this is assert_cash_funds_available under its original name: available funds, under lock, no override. finance_settings.allow_negative_cash is read by nothing.';

-- The setting stays, so nothing that reads the row breaks, and is read by
-- nothing. Removing it would be a second migration''s business; documenting
-- that it is inert is this one''s.
comment on column public.finance_settings.allow_negative_cash is
  'INERT since Decision A (20261120000100). No payout path reads it: every outgoing movement must be covered by available funds in the one account it leaves, with no override. Retained so the row keeps its shape; it will be removed in a later tidy-up.';

alter table public.finance_settings
  add column if not exists cash_sufficiency_enforced_at timestamptz;

update public.finance_settings
   set cash_sufficiency_enforced_at = pg_catalog.now()
 where id = 1 and cash_sufficiency_enforced_at is null;

comment on column public.finance_settings.cash_sufficiency_enforced_at is
  'Decision A. The moment the no-unfunded-payouts rule began to bind on this database. The certification harness uses it to tell a historical balance from a newly prohibited one.';

-- ---------------------------------------------------------------------------
-- 5. The read surface
-- ---------------------------------------------------------------------------

create view public.cash_account_availability with (security_invoker = true) as
select
  a.id          as account_id,
  a.code,
  a.name,
  a.cash_kind,
  a.branch_id,
  a.status,
  coalesce(bal.balance, 0)::bigint as booked,
  coalesce(pend.amount, 0)::bigint as pending_confirmation,
  (coalesce(bal.balance, 0) - coalesce(pend.amount, 0))::bigint as available,
  coalesce(pend.receipts, 0)::integer as pending_receipts
from public.ledger_accounts a
left join public.ledger_account_balances bal on bal.account_id = a.id
left join lateral (
  select pg_catalog.sum(c.amount) as amount, pg_catalog.count(*) as receipts
    from public.cash_receipt_confirmations c
   where c.account_id = a.id and c.state = 'pending'
) pend on true
where a.cash_kind is not null;

comment on view public.cash_account_availability is
  'Decision A. Per cash account: booked (the ledger), pending_confirmation (receipts awaiting a second officer), available (what may be paid out). One row per account, no aggregate column, because a branch total is never a funding source.';

revoke all on public.cash_account_availability from public, anon, authenticated;
grant select on public.cash_account_availability to authenticated;

-- ---------------------------------------------------------------------------
-- 6. Confirmation — the second officer
-- ---------------------------------------------------------------------------

insert into public.permissions (key, description)
values
  ('receipts:view',
   'Read the register of cash receipts awaiting confirmation, and their history.'),
  ('receipts:confirm',
   'Confirm that money recorded as received is physically in the till or wallet, releasing it for payout. Refused for a receipt the confirmer recorded themselves (Decision A, A-1).')
on conflict (key) do nothing;

insert into public.role_permissions (role_key, permission_key)
values
  ('secretary_treasurer', 'receipts:view'),
  ('manager',             'receipts:view'),
  ('owner_admin',         'receipts:view'),
  ('manager',             'receipts:confirm'),
  ('owner_admin',         'receipts:confirm')
on conflict (role_key, permission_key) do nothing;

-- The branch rule is restated rather than called. `user_can_see_branch` is
-- correlated and SECURITY DEFINER, so PostgreSQL neither hoists nor inlines
-- it: it stays a real call per candidate row, each running two queries
-- against `profiles`. `tests/db/rls-hoisting.test.ts` refuses a policy that
-- calls it, and proves the restatement equivalent.
create policy cash_receipt_confirmations_select_with_permission
  on public.cash_receipt_confirmations
  for select to authenticated
  using (
    (select public.user_has_permission('receipts:view'))
    and (
      (select public.current_user_branch_id()) is null
      or branch_id = (select public.current_user_branch_id())
    )
  );

-- One receipt. Raises on every refusal, so a single action gets a sentence.
create or replace function public.confirm_cash_receipt(p_confirmation_id uuid, p_note text default null)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  c       public.cash_receipt_confirmations;
  v_actor uuid;
  v_label text;
  v_entry public.journal_entries;
begin
  perform public.require_business_identity();
  v_actor := public.current_profile_id();
  v_label := public.audit_actor_label();

  if v_actor is null and auth.uid() is not null then
    raise exception 'A receipt must be confirmed by a signed-in member of staff.'
      using errcode = '42501';
  end if;

  if auth.uid() is not null and not public.user_has_permission('receipts:confirm') then
    raise exception 'Confirming a receipt requires the receipts:confirm capability.'
      using errcode = '42501';
  end if;

  select * into c from public.cash_receipt_confirmations
   where id = p_confirmation_id for update;

  if not found then
    raise exception 'No such receipt confirmation.' using errcode = 'P0001';
  end if;

  if not public.user_can_see_branch(c.branch_id) then
    raise exception 'That branch''s receipts are not available to you.'
      using errcode = '42501';
  end if;

  -- Already done. Returned rather than raised: a retry is not a second
  -- confirmation.
  if c.state = 'confirmed' then
    return c.id;
  end if;

  if c.state = 'voided' then
    raise exception
      'That receipt was reversed before it was confirmed, so there is nothing to confirm.'
      using errcode = 'P0001';
  end if;

  if v_actor is not null and c.recorded_by = v_actor then
    raise exception
      'You recorded this receipt, so you cannot be the one who confirms it. A different Manager or Owner must.'
      using errcode = '42501';
  end if;

  -- The account it makes available, locked, so a payout racing this
  -- confirmation sees one state or the other and never half of each.
  perform public.lock_ledger_balances(array[c.account_id]);

  update public.cash_receipt_confirmations
     set state = 'confirmed',
         confirmed_by = v_actor,
         confirmed_by_label = coalesce(v_label, 'system'),
         confirmed_at = pg_catalog.now(),
         confirmation_note = nullif(pg_catalog.btrim(coalesce(p_note, '')), '')
   where id = c.id;

  select * into v_entry from public.journal_entries where id = c.journal_entry_id;

  perform public.record_audit_event(
    'cash_receipt.confirmed', 'cash_receipt_confirmation', c.id::text,
    pg_catalog.jsonb_build_object('state', 'pending'),
    pg_catalog.jsonb_build_object('state', 'confirmed', 'confirmed_by', v_actor),
    pg_catalog.jsonb_build_object(
      'journal_entry_id', c.journal_entry_id,
      'entry_number', v_entry.entry_number,
      'account_id', c.account_id, 'amount', c.amount,
      'recorded_by_label', c.recorded_by_label,
      'confirmed_by_label', coalesce(v_label, 'system'))
  );

  return c.id;
end;
$$;

revoke all on function public.confirm_cash_receipt(uuid, text) from public, anon;
grant execute on function public.confirm_cash_receipt(uuid, text) to authenticated;

-- A batch (A-1: "secure batch verification is permitted, performing every
-- per-receipt check"). Every receipt is checked, locked and transitioned on
-- its own; the ones this officer may not confirm are refused by name and the
-- rest are confirmed. Returns one row per id so the caller sees exactly what
-- happened to each.
create or replace function public.confirm_cash_receipts(p_confirmation_ids uuid[], p_note text default null)
returns table (confirmation_id uuid, outcome text, detail text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  perform public.require_business_identity();

  if auth.uid() is not null and not public.user_has_permission('receipts:confirm') then
    raise exception 'Confirming receipts requires the receipts:confirm capability.'
      using errcode = '42501';
  end if;

  for v_id in select distinct t.x from pg_catalog.unnest(p_confirmation_ids) t(x) where t.x is not null
  loop
    begin
      perform public.confirm_cash_receipt(v_id, p_note);
      confirmation_id := v_id; outcome := 'confirmed'; detail := null;
      return next;
    exception when others then
      confirmation_id := v_id; outcome := 'refused'; detail := sqlerrm;
      return next;
    end;
  end loop;
end;
$$;

revoke all on function public.confirm_cash_receipts(uuid[], text) from public, anon;
grant execute on function public.confirm_cash_receipts(uuid[], text) to authenticated;

-- Internal: a receipt reversed before it was confirmed has nothing left to
-- confirm, and must stop restricting the account. Called by the reversal
-- paths in part 4; not reachable by a session.
create or replace function public.void_pending_cash_receipt(p_journal_entry_id uuid, p_reason text)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rows integer;
begin
  update public.cash_receipt_confirmations
     set state = 'voided',
         void_reason = coalesce(nullif(pg_catalog.btrim(coalesce(p_reason, '')), ''), 'Reversed before confirmation'),
         voided_at = pg_catalog.now()
   where journal_entry_id = p_journal_entry_id
     and state = 'pending';
  get diagnostics v_rows = row_count;
  return v_rows;
end;
$$;

revoke all on function public.void_pending_cash_receipt(uuid, text) from public, anon, authenticated;

-- A reversal of a receipt: if the receipt is still pending, void the
-- restriction and let the contra post — booked and pending fall together and
-- available cannot fall below what it was. If it was confirmed, the money is
-- in the spendable pool and the contra is a payout like any other, so it
-- needs available funds.
create or replace function public.release_or_assert_receipt_reversal(
  p_original_entry_id uuid, p_account_id uuid, p_amount bigint)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_pending integer;
begin
  perform public.lock_ledger_balances(array[p_account_id]);

  select pg_catalog.count(*) into v_pending
    from public.cash_receipt_confirmations c
   where c.journal_entry_id = p_original_entry_id
     and c.account_id = p_account_id
     and c.state = 'pending';

  if v_pending > 0 then
    perform public.void_pending_cash_receipt(p_original_entry_id, 'Reversed before confirmation');
    return;
  end if;

  perform public.assert_cash_funds_available(p_account_id, p_amount);
end;
$$;

revoke all on function public.release_or_assert_receipt_reversal(uuid, uuid, bigint)
  from public, anon, authenticated;
