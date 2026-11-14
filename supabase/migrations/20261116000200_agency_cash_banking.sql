-- ===========================================================================
-- Polytos Agency redesign — Cash Banking: the agent's collected cash into the
-- company's own bank account
--
-- ## The business event, and what it is not
--
-- Client Rule 5: "When an agent deposits collected physical cash into a bank,
-- POLYTOS must record the movement from Cash at Hand to the relevant bank
-- account. This must not be counted as a customer deposit, new revenue or
-- electronic float top-up unless the confirmed bank process explicitly says
-- otherwise."
--
-- Every word of that is a refusal this migration has to make structural,
-- because all three mistakes were available before it:
--
--   * recorded at `/agency/record` it would become an `agency_transaction`
--     with a transaction type and a commission, i.e. a customer's banking;
--   * recorded as a float replenishment it would credit a funding account and
--     debit a `1320` float till, i.e. electronic float the bank never sent;
--   * recorded as a transfer through `record_transfer()` it would post with
--     `transfers:create` alone, outside every agency control, and
--     `assert_cash_account()` would have accepted both ends.
--
-- So it is its own event, with its own table, its own source type and its own
-- maker-checker control, and it touches no provider, no float account, no
-- transaction type and no income account at all.
--
-- ## The posting
--
--   Dr  Cash at Bank      (the branch's chosen `1040` account)   amount - charge
--   Dr  Bank Charges      (5080), only when a charge was levied  charge
--   Cr  Cash at Hand      (the branch's `1010` account)          amount
--
-- The credit is the full amount because that is what physically left the till.
-- The bank credits the account net of its charge, so the debit side splits:
-- what the bank actually holds, and what it kept. A charge is an expense, not
-- a reduction of the deposit, and never a commission.
--
-- With `charge = 0` — the ordinary case — this is a two-line entry, which is
-- the plain reading of Rule 5.
--
-- ## Balance effects
--
--   * physical cash at the branch falls by `amount`;
--   * the bank account rises by `amount - charge`;
--   * `5080 Bank Charges` rises by `charge`;
--   * no electronic float moves, no payable is settled, no income is
--     recognised, no agency transaction exists.
--
-- ## Maker-checker, idempotency, concurrency
--
--   * **Verification** is required: recording needs `agency:write` and posts
--     nothing; posting needs `agency:settlements` and is refused to the person
--     who recorded it (`agency_cash_banking_checker_is_not_maker`).
--   * **Idempotency** twice over: the bank's own deposit reference is unique
--     per destination account, so the same slip cannot be banked twice; and
--     `verify_agency_cash_banking()` returns the existing journal entry when
--     the row is already posted, so a double-clicked verifier gets the entry
--     rather than a second one.
--   * **Concurrency**: the row is taken `for update`, then both ledger
--     balances are locked through `lock_ledger_balances()`, which orders the
--     account ids — so two bankings touching the same till cannot deadlock —
--     and only then is the cash read and checked. No provider balance lock is
--     taken because no provider is involved.
--   * **Reversal** is by contra entries under `agency:reverse`, leaving the
--     original journal immutable, exactly as the float trade and the agency
--     transaction do.
--
-- ## Which accounts are allowed at each end
--
-- The source must be the branch's own `cash_at_hand` wallet: physical cash is
-- the only thing an agent can carry to a bank. The destination must be a
-- `bank` account of the same branch. Both are asserted against
-- `ledger_accounts.cash_kind` rather than against a code pattern, so a second
-- bank account added later works with no change here, and
-- `assert_agency_settlement_account()` is deliberately **not** reused: it
-- accepts cash at hand at either end, which would let a banking post cash to
-- cash and call it banked.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- 1. Two new journal source types
--
-- The list below is the 37 source types the constraint allows today, read
-- back out of the live constraint rather than copied from a previous
-- migration, plus the two this migration adds. A CHECK cannot be extended in
-- place, so it is dropped and recreated whole; dropping it without restating
-- every existing value would invalidate posted history, so the full list is
-- the only safe form and the suite asserts the set afterwards.
-- ---------------------------------------------------------------------------

alter table public.journal_entries
  drop constraint journal_entries_source_valid;

alter table public.journal_entries
  add constraint journal_entries_source_valid
  check (
    source_type = any (array[
      'adjustment', 'agency_commission_payout', 'agency_commission_payout_reversal', 'agency_commission_recovery',
      'agency_commission_settlement', 'agency_commission_settlement_reversal', 'agency_float_purchase', 'agency_float_purchase_reversal',
      'agency_float_replenishment', 'agency_float_sale', 'agency_float_sale_reversal', 'agency_float_transfer',
      'agency_float_transfer_reversal', 'agency_payable_settlement', 'agency_payable_settlement_reversal', 'agency_transaction',
      'agency_transaction_reversal', 'benefit_payment', 'benefit_payment_reversal', 'expense',
      'expense_reversal', 'loan_disbursement', 'loan_repayment', 'membership_fee',
      'membership_fee_reversal', 'opening_balance', 'other_income', 'other_income_reversal',
      'payment_reversal', 'penalty_charge', 'reconciliation_adjustment', 'savings_deposit',
      'savings_deposit_reversal', 'savings_withdrawal', 'savings_withdrawal_reversal', 'transfer',
      'transfer_reversal', 'agency_cash_banking', 'agency_cash_banking_reversal'
    ])
  );


-- ---------------------------------------------------------------------------
-- 2. `agency_cash_bankings`
-- ---------------------------------------------------------------------------

create table if not exists public.agency_cash_bankings (
  id                  uuid primary key default gen_random_uuid(),

  branch_id           uuid not null references public.branches(id) on delete restrict,

  -- Both ends, named rather than derived. The branch has exactly one cash at
  -- hand wallet, so `cash_account_id` could have been looked up — but a
  -- banking is evidence of a movement between two accounts, and a record of
  -- it that stores only one of them cannot be re-checked against the journal.
  cash_account_id     uuid not null references public.ledger_accounts(id) on delete restrict,
  bank_account_id     uuid not null references public.ledger_accounts(id) on delete restrict,

  -- The staff member who physically carried the cash, which is not necessarily
  -- the person typing: a supervisor records what a cashier banked. Separate
  -- from `created_by` for exactly that reason, and required, because "who
  -- banked it" is the accountability Rule 5 exists to keep.
  banked_by           uuid not null references public.profiles(id) on delete restrict,

  banking_date        date   not null,
  amount              bigint not null,
  charge              bigint not null default 0,

  -- The bank's own reference from the deposit slip. Required: a cash banking
  -- with nothing to match against a bank statement is not reconcilable, and
  -- §4.4 asks for a bank deposit reference.
  deposit_reference   text   not null,

  -- Free text describing the slip, the teller stamp or the photograph filed
  -- elsewhere. Evidence that somebody had to name something checkable.
  evidence_note       text,
  notes               text,

  status              text   not null default 'pending',

  journal_entry_id    uuid references public.journal_entries(id) on delete restrict,
  reversal_entry_id   uuid references public.journal_entries(id) on delete restrict,

  created_by          uuid not null references public.profiles(id) on delete restrict,
  created_at          timestamptz not null default now(),
  verified_by         uuid references public.profiles(id) on delete restrict,
  verified_at         timestamptz,
  rejected_reason     text,
  reversed_by         uuid references public.profiles(id) on delete restrict,
  reversed_at         timestamptz,
  reversal_reason     text,
  -- Bumped on every edit of a pending row, and checked by the verifier, so a
  -- figure cannot change between the screen that showed it and the click that
  -- posts it. The same control `agency_float_trades` carries.
  revision            integer not null default 1,
  updated_at          timestamptz not null default now(),

  constraint agency_cash_banking_amount_positive
    check (amount > 0),
  -- A charge is allowed to be zero, must not be negative, and must not
  -- swallow the deposit: a charge equal to the amount would bank nothing and
  -- is a data-entry error, not a banking.
  constraint agency_cash_banking_charge_sane
    check (charge >= 0 and charge < amount),
  constraint agency_cash_banking_accounts_differ
    check (cash_account_id <> bank_account_id),
  constraint agency_cash_banking_reference_shape
    check (pg_catalog.btrim(deposit_reference) = deposit_reference
           and pg_catalog.length(deposit_reference) between 2 and 64),
  constraint agency_cash_banking_status_valid
    check (status = any (array['pending', 'posted', 'rejected', 'reversed'])),
  constraint agency_cash_banking_checker_is_not_maker
    check (verified_by is null or verified_by <> created_by),

  constraint agency_cash_banking_posted_states
    check (status <> 'posted'
           or (journal_entry_id is not null
               and verified_by is not null
               and verified_at is not null)),
  constraint agency_cash_banking_pending_states
    check (status <> 'pending'
           or (journal_entry_id is null
               and verified_by is null
               and verified_at is null
               and rejected_reason is null
               and reversal_entry_id is null)),
  constraint agency_cash_banking_rejected_states
    check (status <> 'rejected'
           or (pg_catalog.btrim(coalesce(rejected_reason, '')) <> ''
               and journal_entry_id is null)),
  constraint agency_cash_banking_reversed_states
    check (status <> 'reversed'
           or (journal_entry_id is not null
               and reversal_entry_id is not null
               and reversed_by is not null
               and reversed_at is not null
               and pg_catalog.btrim(coalesce(reversal_reason, '')) <> ''))
);

comment on table public.agency_cash_bankings is
  'Polytos Agency redesign, client Rule 5. One deposit of collected physical cash into one of the company''s own bank accounts: Dr the bank account net of charge, Dr 5080 for the charge, Cr the branch''s cash at hand for the full amount. Not a customer transaction, not a float top-up and not income — it references no provider, no float till and no transaction type, which is what makes those three misclassifications impossible rather than merely discouraged. Recorded with agency:write, posted with agency:settlements by somebody else, reversed with agency:reverse by contra entries.';

comment on column public.agency_cash_bankings.banked_by is
  'The staff member who physically took the cash to the bank, which is not necessarily created_by: a supervisor may record what a cashier banked. Rule 5''s accountability lives in this column.';
comment on column public.agency_cash_bankings.charge is
  'The bank''s charge on the deposit, in shillings. Posted to 5080 Bank Charges as an expense — never netted off the amount, and never treated as a commission. Zero in the ordinary case.';
comment on column public.agency_cash_bankings.deposit_reference is
  'The bank''s own reference from the deposit slip. Required and unique per destination account, so the same slip cannot be banked twice.';

-- The idempotency key. Unique per destination account rather than globally:
-- two different banks may legitimately issue the same slip number.
create unique index if not exists agency_cash_banking_reference_unique
  on public.agency_cash_bankings (bank_account_id, deposit_reference);

create index if not exists agency_cash_banking_branch_idx
  on public.agency_cash_bankings (branch_id, banking_date desc);
create index if not exists agency_cash_banking_status_idx
  on public.agency_cash_bankings (status, banking_date desc);
create index if not exists agency_cash_banking_banked_by_idx
  on public.agency_cash_bankings (banked_by, banking_date desc);

create trigger agency_cash_bankings_set_updated_at
  before update on public.agency_cash_bankings
  for each row execute function public.set_updated_at();

create trigger agency_cash_bankings_no_delete
  before delete on public.agency_cash_bankings
  for each row execute function public.reject_mutation();


-- ---------------------------------------------------------------------------
-- 3. The invariants a CHECK cannot express
--
-- Both ends have to be the right kind of account, at the right branch. A
-- trigger, because the invariant spans `ledger_accounts`.
-- ---------------------------------------------------------------------------

create or replace function public.agency_cash_banking_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  src record;
  dst record;
begin
  select l.cash_kind, l.branch_id, l.is_postable, l.status into src
    from public.ledger_accounts l where l.id = new.cash_account_id;

  if src is null or src.cash_kind is distinct from 'cash_at_hand' then
    raise exception
      'Cash banking must come out of a cash at hand account. Physical cash is the only thing an agent can carry to a bank.'
      using errcode = 'P0001';
  end if;

  select l.cash_kind, l.branch_id, l.is_postable, l.status into dst
    from public.ledger_accounts l where l.id = new.bank_account_id;

  if dst is null or dst.cash_kind is distinct from 'bank' then
    raise exception
      'Cash banking must go into a bank account. An agency float account is not a bank account and is funded through a float top-up instead.'
      using errcode = 'P0001';
  end if;

  if not src.is_postable or src.status <> 'active'
     or not dst.is_postable or dst.status <> 'active' then
    raise exception 'Both accounts in a cash banking must be postable and active.'
      using errcode = 'P0001';
  end if;

  if src.branch_id is distinct from new.branch_id
     or dst.branch_id is distinct from new.branch_id then
    raise exception
      'Both accounts in a cash banking must belong to the branch recording it.'
      using errcode = 'P0001';
  end if;

  return new;
end;
$$;

comment on function public.agency_cash_banking_guard() is
  'Polytos Agency redesign. Asserts a cash banking moves cash_at_hand to bank, both postable, both active and both at the recording branch. Read off ledger_accounts.cash_kind rather than an account-code pattern, so a bank account added later needs no change here.';

revoke all on function public.agency_cash_banking_guard() from public, anon, authenticated;

create trigger agency_cash_bankings_guard
  before insert or update on public.agency_cash_bankings
  for each row execute function public.agency_cash_banking_guard();


-- A pending row may be corrected; a posted, rejected or reversed one may not,
-- beyond the state columns the functions below set. The same revision idiom
-- `agency_float_trades` uses.
create or replace function public.agency_cash_banking_revision_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.status = 'pending'
     and new.status = 'pending'
     and (old.amount, old.charge, old.bank_account_id, old.cash_account_id,
          old.banked_by, old.banking_date, old.deposit_reference)
         is distinct from
         (new.amount, new.charge, new.bank_account_id, new.cash_account_id,
          new.banked_by, new.banking_date, new.deposit_reference)
  then
    new.revision := old.revision + 1;
  end if;

  if old.status <> 'pending'
     and (old.amount, old.charge, old.bank_account_id, old.cash_account_id,
          old.banked_by, old.banking_date, old.deposit_reference)
         is distinct from
         (new.amount, new.charge, new.bank_account_id, new.cash_account_id,
          new.banked_by, new.banking_date, new.deposit_reference)
  then
    raise exception
      'A cash banking that is % can no longer be edited. Reverse it and record a correction.',
      old.status
      using errcode = 'P0001';
  end if;

  return new;
end;
$$;

revoke all on function public.agency_cash_banking_revision_guard() from public, anon, authenticated;

create trigger agency_cash_bankings_revision
  before update on public.agency_cash_bankings
  for each row execute function public.agency_cash_banking_revision_guard();


-- ---------------------------------------------------------------------------
-- 4. Row Level Security
--
-- Readable with `agency:reports`, scoped to the reader's branch in the
-- hoisted form this repository enforces. Writes come only through the
-- functions below: no INSERT, UPDATE or DELETE grant exists.
-- ---------------------------------------------------------------------------

alter table public.agency_cash_bankings enable row level security;

create policy agency_cash_bankings_select_with_permission
  on public.agency_cash_bankings
  for select to authenticated
  using (
    (select public.user_has_permission('agency:reports'))
    and (
      branch_id is null
      or (select public.current_user_branch_id()) is null
      or branch_id = (select public.current_user_branch_id())
    )
  );

revoke all on table public.agency_cash_bankings from anon, authenticated;
grant select on public.agency_cash_bankings to authenticated;


-- ---------------------------------------------------------------------------
-- 5. Recording — posts nothing
-- ---------------------------------------------------------------------------

create or replace function public.record_agency_cash_banking(
  p_bank_account_id uuid,
  p_amount          bigint,
  p_reference       text,
  p_banked_by       uuid    default null,
  p_charge          bigint  default 0,
  p_banking_date    date    default null,
  p_evidence_note   text    default null,
  p_notes           text    default null,
  p_branch_id       uuid    default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor  uuid;
  v_branch uuid;
  v_cash   uuid;
  v_banker uuid;
  v_date   date;
  v_id     uuid;
begin
  v_actor := public.agency_actor('agency:write');

  -- The branch rule the operating-branch migration established: an officer
  -- with a branch records at their own and may name no other; a branch-less
  -- officer must name one, because guessing it is how head-office postings
  -- silently moved branch.
  select coalesce(p.branch_id, p_branch_id) into v_branch
    from public.profiles p where p.id = v_actor;

  if v_branch is null then
    raise exception
      'Name the branch this cash was banked from. Your profile carries no branch, so it cannot be inferred.'
      using errcode = 'P0001';
  end if;

  if not public.user_can_see_branch(v_branch) then
    raise exception 'That branch is not available to you.' using errcode = '42501';
  end if;

  if not exists (select 1 from public.branches b
                  where b.id = v_branch and b.status = 'active') then
    raise exception 'That branch is not open, so nothing can be banked from it.'
      using errcode = 'P0001';
  end if;

  if p_amount is null or p_amount <= 0 then
    raise exception 'A cash banking must be a positive number of shillings.'
      using errcode = 'P0001';
  end if;

  if coalesce(p_charge, 0) < 0 or coalesce(p_charge, 0) >= p_amount then
    raise exception
      'A bank charge must be zero or more, and less than the amount banked.'
      using errcode = 'P0001';
  end if;

  if pg_catalog.btrim(coalesce(p_reference, '')) = '' then
    raise exception
      'A cash banking needs the bank''s deposit reference, so it can be matched to a statement.'
      using errcode = 'P0001';
  end if;

  -- The branch's one physical cash wallet. Looked up rather than taken as an
  -- argument: there is exactly one per branch (a unique index says so), and a
  -- caller that could name it could name another branch's.
  select l.id into v_cash
    from public.ledger_accounts l
   where l.branch_id = v_branch and l.cash_kind = 'cash_at_hand';

  if v_cash is null then
    raise exception 'That branch has no cash at hand account.' using errcode = 'P0001';
  end if;

  -- Who carried the cash. Defaults to the person recording, which is the
  -- common case; naming somebody else is allowed and is what makes a
  -- supervisor-recorded banking accountable to the cashier who did it.
  v_banker := coalesce(p_banked_by, v_actor);
  if not exists (select 1 from public.profiles p
                  where p.id = v_banker and p.status = 'active') then
    raise exception 'The staff member said to have banked the cash is not active.'
      using errcode = 'P0001';
  end if;

  v_date := coalesce(p_banking_date, public.business_date());
  if v_date > public.business_date() then
    raise exception 'A cash banking cannot be dated in the future.'
      using errcode = 'P0001';
  end if;

  begin
    insert into public.agency_cash_bankings
      (branch_id, cash_account_id, bank_account_id, banked_by, banking_date,
       amount, charge, deposit_reference, evidence_note, notes, created_by)
    values
      (v_branch, v_cash, p_bank_account_id, v_banker, v_date,
       p_amount, coalesce(p_charge, 0), pg_catalog.btrim(p_reference),
       nullif(pg_catalog.btrim(coalesce(p_evidence_note, '')), ''),
       nullif(pg_catalog.btrim(coalesce(p_notes, '')), ''), v_actor)
    returning id into v_id;
  exception when unique_violation then
    raise exception
      'Deposit reference % has already been banked into that account.', p_reference
      using errcode = 'P0001';
  end;

  perform public.record_audit_event(
    'agency_cash_banking.recorded', 'agency_cash_banking', v_id::text, null,
    pg_catalog.jsonb_build_object(
      'status', 'pending', 'branch_id', v_branch, 'amount', p_amount,
      'charge', coalesce(p_charge, 0), 'bank_account_id', p_bank_account_id,
      'cash_account_id', v_cash, 'banked_by', v_banker,
      'deposit_reference', pg_catalog.btrim(p_reference)),
    null, null);

  return v_id;
end;
$$;

comment on function public.record_agency_cash_banking(uuid, bigint, text, uuid, bigint, date, text, text, uuid) is
  'Polytos Agency redesign, client Rule 5. Records an agent banking collected physical cash into a company bank account, and posts nothing: verification is what posts it. Needs agency:write. The source cash account is the recording branch''s own cash at hand, looked up rather than named. Refuses a future date, a non-positive amount, a charge at or above the amount, a missing deposit reference, a duplicate reference on the same bank account, an inactive banker, a closed branch and a branch the caller cannot see.';

revoke all on function public.record_agency_cash_banking(uuid, bigint, text, uuid, bigint, date, text, text, uuid)
  from public, anon;
grant execute on function public.record_agency_cash_banking(uuid, bigint, text, uuid, bigint, date, text, text, uuid)
  to authenticated;


-- ---------------------------------------------------------------------------
-- 6. Verifying — the one step that posts
-- ---------------------------------------------------------------------------

create or replace function public.verify_agency_cash_banking(
  p_banking_id       uuid,
  p_expected_revision integer default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid;
  b       public.agency_cash_bankings;
  v_label text;
  v_lines jsonb;
  v_entry uuid;
begin
  v_actor := public.agency_actor('agency:settlements');

  select * into b from public.agency_cash_bankings
   where id = p_banking_id for update;

  if b.id is null then
    raise exception 'No such cash banking.' using errcode = 'P0001';
  end if;

  if not public.user_can_see_branch(b.branch_id) then
    raise exception 'That cash banking belongs to another branch.'
      using errcode = '42501';
  end if;

  -- Idempotent: a verifier who presses twice gets the entry, not a second one.
  if b.status = 'posted' then
    return b.journal_entry_id;
  end if;

  if b.status <> 'pending' then
    raise exception 'Only a pending cash banking can be posted; this one is %.',
      b.status using errcode = 'P0001';
  end if;

  if b.created_by = v_actor then
    raise exception
      'A cash banking cannot be posted by the person who recorded it.'
      using errcode = 'P0001';
  end if;

  if p_expected_revision is not null and p_expected_revision <> b.revision then
    raise exception
      'This cash banking has changed since you read it (revision % now, you saw %). Reload it and check the figures again.',
      b.revision, p_expected_revision
      using errcode = 'P0001';
  end if;

  -- Both accounts, in the order `lock_ledger_balances` imposes, before any
  -- balance is read. Then the cash has to actually be there.
  perform public.lock_ledger_balances(array[b.cash_account_id, b.bank_account_id]);
  perform public.assert_cash_available(b.cash_account_id, b.amount);

  select p.full_name into v_label from public.profiles p where p.id = v_actor;

  -- Dr the bank net of the charge, Cr the till for the whole amount, and the
  -- charge to 5080 only when there is one. The credit is the full amount
  -- because that is what left the till.
  v_lines := pg_catalog.jsonb_build_array(
    pg_catalog.jsonb_build_object(
      'account_id', b.bank_account_id,
      'debit', b.amount - b.charge, 'credit', 0,
      'memo', 'Cash banked'),
    pg_catalog.jsonb_build_object(
      'account_id', b.cash_account_id,
      'debit', 0, 'credit', b.amount,
      'memo', 'Cash taken to the bank'));

  if b.charge > 0 then
    v_lines := v_lines || pg_catalog.jsonb_build_object(
      'account_id', public.ledger_account_by_code('5080'),
      'debit', b.charge, 'credit', 0,
      'memo', 'Bank charge on a cash deposit');
  end if;

  v_entry := public.post_journal(
    b.branch_id,
    b.banking_date,
    'Cash banked (' || b.deposit_reference || ')',
    'agency_cash_banking', b.id, null, null,
    v_lines,
    pg_catalog.now(), v_actor, coalesce(v_label, 'system'));

  update public.agency_cash_bankings
     set status           = 'posted',
         verified_by      = v_actor,
         verified_at      = pg_catalog.now(),
         journal_entry_id = v_entry,
         updated_at       = pg_catalog.now()
   where id = p_banking_id;

  perform public.record_audit_event(
    'agency_cash_banking.posted', 'agency_cash_banking', p_banking_id::text,
    pg_catalog.jsonb_build_object('status', 'pending', 'revision', b.revision),
    pg_catalog.jsonb_build_object(
      'status', 'posted', 'journal_entry_id', v_entry,
      'amount', b.amount, 'charge', b.charge,
      'bank_account_id', b.bank_account_id,
      'cash_account_id', b.cash_account_id),
    null, null);

  return v_entry;
end;
$$;

comment on function public.verify_agency_cash_banking(uuid, integer) is
  'Polytos Agency redesign, client Rule 5. Posts a pending cash banking: Dr the bank account for amount - charge, Dr 5080 Bank Charges for the charge when there is one, Cr the branch cash at hand for the full amount, because that is what left the till. Needs agency:settlements and refuses the person who recorded it. Idempotent once posted, refuses a stale revision, locks both ledger balances before reading the cash, and refuses insufficient cash. Recognises no income and moves no electronic float.';

revoke all on function public.verify_agency_cash_banking(uuid, integer)
  from public, anon;
grant execute on function public.verify_agency_cash_banking(uuid, integer)
  to authenticated;


-- ---------------------------------------------------------------------------
-- 7. Rejecting — the other half of the control
-- ---------------------------------------------------------------------------

create or replace function public.reject_agency_cash_banking(
  p_banking_id uuid,
  p_reason     text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid;
  b       public.agency_cash_bankings;
begin
  v_actor := public.agency_actor('agency:settlements');

  if pg_catalog.btrim(coalesce(p_reason, '')) = '' then
    raise exception 'Say why the cash banking is being rejected.'
      using errcode = 'P0001';
  end if;

  select * into b from public.agency_cash_bankings
   where id = p_banking_id for update;

  if b.id is null then
    raise exception 'No such cash banking.' using errcode = 'P0001';
  end if;

  if not public.user_can_see_branch(b.branch_id) then
    raise exception 'That cash banking belongs to another branch.'
      using errcode = '42501';
  end if;

  if b.status <> 'pending' then
    raise exception 'Only a pending cash banking can be rejected; this one is %.',
      b.status using errcode = 'P0001';
  end if;

  if b.created_by = v_actor then
    raise exception
      'A cash banking cannot be rejected by the person who recorded it.'
      using errcode = 'P0001';
  end if;

  update public.agency_cash_bankings
     set status          = 'rejected',
         verified_by     = v_actor,
         verified_at     = pg_catalog.now(),
         rejected_reason = pg_catalog.btrim(p_reason),
         updated_at      = pg_catalog.now()
   where id = p_banking_id;

  perform public.record_audit_event(
    'agency_cash_banking.rejected', 'agency_cash_banking', p_banking_id::text,
    pg_catalog.jsonb_build_object('status', 'pending'),
    pg_catalog.jsonb_build_object('status', 'rejected',
                                  'reason', pg_catalog.btrim(p_reason)),
    null, null);
end;
$$;

comment on function public.reject_agency_cash_banking(uuid, text) is
  'Polytos Agency redesign. Rejects a pending cash banking with a stated reason, posting nothing. The row is kept, because a control that can only say yes is not a control and a rejected slip is evidence. Needs agency:settlements and refuses the person who recorded it.';

revoke all on function public.reject_agency_cash_banking(uuid, text) from public, anon;
grant execute on function public.reject_agency_cash_banking(uuid, text) to authenticated;


-- ---------------------------------------------------------------------------
-- 8. Reversing — contra entries, original journal untouched
-- ---------------------------------------------------------------------------

create or replace function public.reverse_agency_cash_banking(
  p_banking_id uuid,
  p_reason     text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid;
  b       public.agency_cash_bankings;
  v_label text;
  v_lines jsonb;
  v_entry uuid;
begin
  v_actor := public.agency_actor('agency:reverse');

  if pg_catalog.btrim(coalesce(p_reason, '')) = '' then
    raise exception 'Say why the cash banking is being reversed.'
      using errcode = 'P0001';
  end if;

  select * into b from public.agency_cash_bankings
   where id = p_banking_id for update;

  if b.id is null then
    raise exception 'No such cash banking.' using errcode = 'P0001';
  end if;

  if not public.user_can_see_branch(b.branch_id) then
    raise exception 'That cash banking belongs to another branch.'
      using errcode = '42501';
  end if;

  -- Idempotent, like the verifier: a second press returns the reversal.
  if b.status = 'reversed' then
    return b.reversal_entry_id;
  end if;

  if b.status <> 'posted' then
    raise exception 'Only a posted cash banking can be reversed; this one is %.',
      b.status using errcode = 'P0001';
  end if;

  -- Reversing a banking dated before today needs the wider capability, the
  -- same rule agency transactions follow.
  if b.banking_date < public.business_date()
     and not public.user_has_permission('agency:reverse_cross_day') then
    raise exception
      'That cash banking is dated %, which is before today. Reversing a closed day needs a wider permission.',
      b.banking_date
      using errcode = '42501';
  end if;

  perform public.lock_ledger_balances(array[b.cash_account_id, b.bank_account_id]);
  -- The money has to be able to come back out of the bank.
  perform public.assert_cash_available(b.bank_account_id, b.amount - b.charge);

  select p.full_name into v_label from public.profiles p where p.id = v_actor;

  -- Every leg of the original, the other way round. The charge comes back out
  -- of 5080 too: if the banking did not happen, the bank did not keep a fee.
  v_lines := pg_catalog.jsonb_build_array(
    pg_catalog.jsonb_build_object(
      'account_id', b.cash_account_id,
      'debit', b.amount, 'credit', 0,
      'memo', 'Cash banking reversed'),
    pg_catalog.jsonb_build_object(
      'account_id', b.bank_account_id,
      'debit', 0, 'credit', b.amount - b.charge,
      'memo', 'Cash banking reversed'));

  if b.charge > 0 then
    v_lines := v_lines || pg_catalog.jsonb_build_object(
      'account_id', public.ledger_account_by_code('5080'),
      'debit', 0, 'credit', b.charge,
      'memo', 'Bank charge reversed');
  end if;

  v_entry := public.post_journal(
    b.branch_id,
    public.business_date(),
    'Cash banking reversed (' || b.deposit_reference || ')',
    'agency_cash_banking_reversal', b.id, null, null,
    v_lines,
    pg_catalog.now(), v_actor, coalesce(v_label, 'system'));

  update public.agency_cash_bankings
     set status            = 'reversed',
         reversal_entry_id = v_entry,
         reversed_by       = v_actor,
         reversed_at       = pg_catalog.now(),
         reversal_reason   = pg_catalog.btrim(p_reason),
         updated_at        = pg_catalog.now()
   where id = p_banking_id;

  perform public.record_audit_event(
    'agency_cash_banking.reversed', 'agency_cash_banking', p_banking_id::text,
    pg_catalog.jsonb_build_object('status', 'posted',
                                  'journal_entry_id', b.journal_entry_id),
    pg_catalog.jsonb_build_object('status', 'reversed',
                                  'reversal_entry_id', v_entry,
                                  'reason', pg_catalog.btrim(p_reason)),
    null, null);

  return v_entry;
end;
$$;

comment on function public.reverse_agency_cash_banking(uuid, text) is
  'Polytos Agency redesign. Reverses a posted cash banking by contra entries — the original journal is never touched — and refuses to reverse a banking dated before today without agency:reverse_cross_day. Needs agency:reverse, is idempotent once reversed, and refuses when the bank account no longer holds what was banked. The charge is reversed out of 5080 as well, because a banking that did not happen incurred no fee.';

revoke all on function public.reverse_agency_cash_banking(uuid, text) from public, anon;
grant execute on function public.reverse_agency_cash_banking(uuid, text) to authenticated;


-- ---------------------------------------------------------------------------
-- 9. The register the screens read
--
-- `security_invoker`, so the policy above decides the rows. Names resolved
-- here rather than in five screens that would each join differently.
-- ---------------------------------------------------------------------------

create or replace view public.agency_cash_banking_register
with (security_invoker = true) as
select
  cb.id,
  cb.branch_id,
  b.branch_code,
  b.name                        as branch_name,
  cb.banking_date,
  cb.amount,
  cb.charge,
  cb.amount - cb.charge         as net_banked,
  cb.deposit_reference,
  cb.evidence_note,
  cb.notes,
  cb.status,
  cb.revision,
  cb.cash_account_id,
  src.code                      as cash_account_code,
  cb.bank_account_id,
  dst.code                      as bank_account_code,
  dst.name                      as bank_account_name,
  dst.institution               as bank_institution,
  cb.banked_by,
  banker.full_name              as banked_by_name,
  cb.created_by,
  maker.full_name               as created_by_name,
  cb.created_at,
  cb.verified_by,
  checker.full_name             as verified_by_name,
  cb.verified_at,
  cb.rejected_reason,
  cb.journal_entry_id,
  cb.reversal_entry_id,
  cb.reversed_by,
  reverser.full_name            as reversed_by_name,
  cb.reversed_at,
  cb.reversal_reason
from public.agency_cash_bankings cb
join public.branches b on b.id = cb.branch_id
join public.ledger_accounts src on src.id = cb.cash_account_id
join public.ledger_accounts dst on dst.id = cb.bank_account_id
join public.profiles banker on banker.id = cb.banked_by
join public.profiles maker on maker.id = cb.created_by
left join public.profiles checker on checker.id = cb.verified_by
left join public.profiles reverser on reverser.id = cb.reversed_by;

comment on view public.agency_cash_banking_register is
  'Polytos Agency redesign. Cash bankings with their branch, both accounts and the people who banked, recorded, verified and reversed them. security_invoker, so the table''s own branch-scoped policy decides which rows come back.';

revoke all on public.agency_cash_banking_register from anon, authenticated;
grant select on public.agency_cash_banking_register to authenticated;
