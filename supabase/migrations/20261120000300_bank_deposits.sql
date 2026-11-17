-- ===========================================================================
-- Decision A, part 3 of 4 — bank deposits, clearance and the second officer
--
-- The document that moves money through Cash in Transit, and the four acts
-- that may be performed on it. Modelled on `verify_agency_transaction`, the
-- strongest maker-checker precedent in the codebase: the clearance journal is
-- written BY the verification, the verifier may not be the recorder at the
-- function layer AND as a CHECK, and a retry on a cleared deposit returns its
-- journal rather than posting twice.
--
--   record_bank_deposit         till → 1050      a deposit IS an outgoing path:
--                                                 available funds in the till
--   verify_bank_deposit         1050 → bank      a different officer, full
--                                                 amount only (A-7), dated today
--   open_deposit_investigation  posts nothing    the bank refused or the money
--                                                 is late; stays in 1050 (A-8)
--   confirm_physical_cash_return 1050 → till     only on independently verified
--                                                 physical receipt (A-8)
--   reverse_bank_clearance      bank → 1050      Owner only, never the original
--                                                 verifier, needs available funds
--                                                 in the bank (A-9)
--
-- ## Three dates, kept apart (A-6)
--
--   bank_value_date  what the bank's evidence says; may precede verification
--   verified_at      when the officer verified
--   entry_date       the accounting date of the clearance: always today
--
-- Nothing here can post into the past.
--
-- ## What is deliberately absent, and why
--
-- No ageing, partial return, recovery receivable or loss write-off (DD-2 to
-- DD-5): those rest on a qualified accountant's determination of how 1190 /
-- 2900 present at a reporting date (blocker B-1), which the Owner has not yet
-- received. A deposit that never clears and never comes back therefore stays
-- `under_investigation` — honestly in 1050, spendable by nobody — until that
-- decision exists. Failing safe, not inventing an accounting treatment.
-- ===========================================================================

-- 1. Vocabulary.
insert into public.reference_formats (scope, prefix, padding, description)
values ('bank_deposit', 'BD', 5, 'Bank deposits from a till, e.g. BD2600001')
on conflict (scope) do nothing;

alter table public.journal_entries drop constraint journal_entries_source_valid;
alter table public.journal_entries add constraint journal_entries_source_valid
  check (source_type in (
    'opening_balance', 'loan_disbursement', 'loan_repayment', 'payment_reversal',
    'penalty_charge', 'transfer', 'transfer_reversal', 'expense', 'expense_reversal',
    'other_income', 'other_income_reversal', 'reconciliation_adjustment', 'adjustment',
    'membership_fee', 'membership_fee_reversal', 'savings_deposit',
    'savings_deposit_reversal', 'savings_withdrawal', 'savings_withdrawal_reversal',
    'benefit_payment', 'benefit_payment_reversal', 'agency_transaction',
    'agency_transaction_reversal', 'agency_commission_settlement',
    'agency_payable_settlement', 'agency_payable_settlement_reversal',
    'agency_float_replenishment', 'agency_commission_settlement_reversal',
    'agency_commission_payout', 'agency_commission_payout_reversal',
    'agency_commission_recovery', 'agency_float_purchase',
    'agency_float_purchase_reversal', 'agency_float_sale', 'agency_float_sale_reversal',
    'agency_float_transfer', 'agency_float_transfer_reversal', 'agency_cash_banking',
    'agency_cash_banking_reversal',
    -- Decision A
    'bank_deposit', 'bank_deposit_clearance', 'bank_deposit_return',
    'bank_deposit_clearance_reversal'
  ));

insert into public.permissions (key, description)
values
  ('deposits:view',   'Read the bank deposit register.'),
  ('deposits:create', 'Record that cash has been taken from a till to the bank. Moves it into Cash in Transit, where it is spendable by nobody.'),
  ('deposits:verify', 'Verify the bank''s clearance of a deposit, open an investigation, or confirm the physical return of unbanked cash. Refused for a deposit the verifier recorded (Decision A, rule 8).'),
  ('deposits:reverse','Reverse a verified clearance. Owner only, never the original verifier, and only with available funds in the bank (Decision A, A-9).')
on conflict (key) do nothing;

insert into public.role_permissions (role_key, permission_key)
values
  ('secretary_treasurer', 'deposits:view'),
  ('secretary_treasurer', 'deposits:create'),
  ('manager',             'deposits:view'),
  ('manager',             'deposits:create'),
  ('manager',             'deposits:verify'),
  ('owner_admin',         'deposits:view'),
  ('owner_admin',         'deposits:create'),
  ('owner_admin',         'deposits:verify'),
  ('owner_admin',         'deposits:reverse')
on conflict (role_key, permission_key) do nothing;

-- 2. The document.
create table public.bank_deposits (
  id                         uuid primary key default gen_random_uuid(),
  deposit_number             text not null unique,
  branch_id                  uuid not null references public.branches(id) on delete restrict,
  from_account_id            uuid not null references public.ledger_accounts(id) on delete restrict,
  transit_account_id         uuid not null references public.ledger_accounts(id) on delete restrict,
  bank_account_id            uuid not null references public.ledger_accounts(id) on delete restrict,
  amount                     bigint not null,
  deposit_date               date not null,
  description                text,
  status                     text not null default 'submitted',

  bank_value_date            date,
  bank_reference             text,
  deposit_slip_path          text,
  clearance_notes            text,

  investigation_opened_at    timestamptz,
  investigation_opened_by    uuid references public.profiles(id) on delete restrict,
  investigation_reason       text,

  return_confirmed_at        timestamptz,
  return_confirmed_by        uuid references public.profiles(id) on delete restrict,
  return_evidence_note       text,

  recorded_by                uuid references public.profiles(id) on delete restrict,
  recorded_by_label          text not null,
  verified_by                uuid references public.profiles(id) on delete restrict,
  verified_by_label          text,
  verified_at                timestamptz,

  reversed_by                uuid references public.profiles(id) on delete restrict,
  reversed_by_label          text,
  reversed_at                timestamptz,
  reversal_reason            text,

  deposit_journal_entry_id   uuid not null unique references public.journal_entries(id) on delete cascade,
  clearance_journal_entry_id uuid unique references public.journal_entries(id) on delete cascade,
  return_journal_entry_id    uuid unique references public.journal_entries(id) on delete cascade,
  reversal_entry_id          uuid unique references public.journal_entries(id) on delete cascade,

  idempotency_key            uuid not null unique,
  created_at                 timestamptz not null default now(),
  updated_at                 timestamptz not null default now(),

  constraint bank_deposits_amount_positive check (amount > 0),
  constraint bank_deposits_status_valid
    check (status in ('submitted', 'cleared', 'under_investigation', 'returned_to_till', 'reversed')),
  constraint bank_deposits_three_accounts_distinct
    check (from_account_id <> transit_account_id and transit_account_id <> bank_account_id
           and from_account_id <> bank_account_id),
  -- Document ↔ journal consistency, per journal.
  constraint bank_deposits_cleared_has_journal
    check ((status in ('cleared', 'reversed')) = (clearance_journal_entry_id is not null)),
  constraint bank_deposits_returned_has_journal
    check ((status = 'returned_to_till') = (return_journal_entry_id is not null)),
  constraint bank_deposits_reversed_has_journal
    check ((status = 'reversed') = (reversal_entry_id is not null)),
  -- Clearance evidence: the bank's reference and value date, and who verified.
  constraint bank_deposits_clearance_evidence
    check (
      clearance_journal_entry_id is null
      or (bank_reference is not null and btrim(bank_reference) <> ''
          and bank_value_date is not null
          and verified_by_label is not null and btrim(verified_by_label) <> ''
          and verified_at is not null)
    ),
  -- A-6: the value date is bank evidence and may be historical, but never
  -- earlier than the deposit itself.
  constraint bank_deposits_value_date_after_deposit
    check (bank_value_date is null or bank_value_date >= deposit_date),
  -- Rule 8. Nobody verifies, returns or reverses their own work. Stated as
  -- constraints so no route — service_role included — can forget it.
  constraint bank_deposits_verifier_not_recorder
    check (verified_by is null or recorded_by is null or verified_by <> recorded_by),
  constraint bank_deposits_returner_not_recorder
    check (return_confirmed_by is null or recorded_by is null or return_confirmed_by <> recorded_by),
  constraint bank_deposits_reverser_not_verifier
    check (reversed_by is null or verified_by is null or reversed_by <> verified_by),
  -- The reason and the moment are mandatory; the profile id is not, for the
  -- reason `cash_receipt_confirmations_confirmed_complete` gives — a trusted
  -- no-JWT path has none to offer, and the audit event carries the label.
  constraint bank_deposits_investigation_has_reason
    check (investigation_opened_at is null
           or (investigation_reason is not null and btrim(investigation_reason) <> '')),
  constraint bank_deposits_return_has_evidence
    check (return_journal_entry_id is null
           or (return_evidence_note is not null and btrim(return_evidence_note) <> ''
               and return_confirmed_at is not null)),
  constraint bank_deposits_reversal_has_reason
    check (reversal_entry_id is null
           or (reversal_reason is not null and btrim(reversal_reason) <> ''
               and reversed_at is not null))
);

comment on table public.bank_deposits is
  'Decision A. Cash taken from a till to the bank. Recorded: till → Cash in Transit. Cleared: Transit → bank, by a different officer, full amount only, dated today. Under investigation: posts nothing, the money stays in transit. Returned to till: Transit → till, on independently verified physical receipt. Reversed: bank → Transit, Owner only, never the verifier.';
comment on column public.bank_deposits.bank_value_date is
  'A-6. The bank''s evidenced value date. May precede verification and may fall in a closed period; must be on or after the deposit date. The clearance journal is dated the day it is verified, never this.';

create index bank_deposits_branch_status_idx on public.bank_deposits (branch_id, status, deposit_date desc);
create index bank_deposits_status_idx on public.bank_deposits (status, created_at desc);

create trigger bank_deposits_set_updated_at
  before update on public.bank_deposits
  for each row execute function public.set_updated_at();

create trigger bank_deposits_no_delete
  before delete on public.bank_deposits
  for each row execute function public.reject_mutation();

-- What a deposit is — its accounts, amount, date, recorder and deposit
-- journal — is write-once. Evidence, once attached, is write-once too.
create or replace function public.bank_deposits_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.branch_id <> old.branch_id
     or new.from_account_id <> old.from_account_id
     or new.transit_account_id <> old.transit_account_id
     or new.bank_account_id <> old.bank_account_id
     or new.amount <> old.amount
     or new.deposit_date <> old.deposit_date
     or new.deposit_number <> old.deposit_number
     or new.deposit_journal_entry_id <> old.deposit_journal_entry_id
     or new.idempotency_key <> old.idempotency_key
     or new.recorded_by is distinct from old.recorded_by
     or new.recorded_by_label <> old.recorded_by_label then
    raise exception 'A bank deposit is history. What it was cannot be edited.'
      using errcode = 'P0001';
  end if;

  if old.clearance_journal_entry_id is not null
     and (new.clearance_journal_entry_id is distinct from old.clearance_journal_entry_id
          or new.bank_reference is distinct from old.bank_reference
          or new.bank_value_date is distinct from old.bank_value_date
          or new.verified_by is distinct from old.verified_by
          or new.verified_at is distinct from old.verified_at) then
    raise exception 'Clearance evidence, once recorded, cannot be edited.'
      using errcode = 'P0001';
  end if;

  if old.status in ('returned_to_till', 'reversed') and new.status <> old.status then
    raise exception 'A deposit that is % is finished.', old.status using errcode = 'P0001';
  end if;

  return new;
end;
$$;

revoke all on function public.bank_deposits_guard() from public, anon, authenticated;

create trigger bank_deposits_guard
  before update on public.bank_deposits
  for each row execute function public.bank_deposits_guard();

create or replace function public.bank_deposits_assign_number()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.deposit_number is null or new.deposit_number = '' then
    new.deposit_number := public.next_reference('bank_deposit');
  end if;
  return new;
end;
$$;

revoke all on function public.bank_deposits_assign_number() from public, anon, authenticated;

create trigger bank_deposits_assign_number
  before insert on public.bank_deposits
  for each row execute function public.bank_deposits_assign_number();

alter table public.bank_deposits enable row level security;
revoke all on table public.bank_deposits from public, anon, authenticated;
grant select on public.bank_deposits to authenticated;

-- The branch rule restated rather than called, for the reason given on
-- `cash_receipt_confirmations` and enforced by `rls-hoisting.test.ts`.
create policy bank_deposits_select_with_permission
  on public.bank_deposits
  for select to authenticated
  using (
    (select public.user_has_permission('deposits:view'))
    and (
      (select public.current_user_branch_id()) is null
      or branch_id = (select public.current_user_branch_id())
    )
  );

-- 3. The functions.

-- A shared preamble: identity, capability, and the branch.
create or replace function public.bank_deposit_actor(p_capability text)
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_actor uuid;
begin
  perform public.require_business_identity();
  v_actor := public.current_profile_id();

  if v_actor is null and auth.uid() is not null then
    raise exception 'A bank deposit must be handled by a signed-in member of staff.'
      using errcode = '42501';
  end if;

  if auth.uid() is not null and not public.user_has_permission(p_capability) then
    raise exception 'This requires the % capability.', p_capability
      using errcode = '42501';
  end if;

  return v_actor;
end;
$$;

revoke all on function public.bank_deposit_actor(text) from public, anon, authenticated;

create or replace function public.record_bank_deposit(
  p_from_account_id uuid,
  p_bank_account_id uuid,
  p_amount          bigint,
  p_description     text,
  p_idempotency_key uuid
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor   uuid;
  v_label   text;
  v_id      uuid;
  v_branch  uuid;
  v_bank_branch uuid;
  v_bank_kind text;
  v_transit uuid;
  v_entry   uuid;
  v_from_name text;
  v_bank_name text;
  v_date    date;
begin
  v_actor := public.bank_deposit_actor('deposits:create');
  v_label := public.audit_actor_label();

  if p_idempotency_key is null then
    raise exception 'A deposit needs a receipt key.' using errcode = 'P0001';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('bank_deposit_key:' || p_idempotency_key::text));

  -- Authorisation above the replay return (ADR-056).
  select a.branch_id, a.name into v_branch, v_from_name
    from public.ledger_accounts a where a.id = p_from_account_id;

  if v_branch is null then
    raise exception 'The till account does not exist.' using errcode = 'P0001';
  end if;

  if not public.user_can_see_branch(v_branch) then
    raise exception 'That branch is not available to you.' using errcode = '42501';
  end if;

  select d.id into v_id from public.bank_deposits d where d.idempotency_key = p_idempotency_key;
  if v_id is not null then
    return v_id;
  end if;

  if p_amount is null or p_amount <= 0 then
    raise exception 'A deposit must be a positive number of shillings.' using errcode = 'P0001';
  end if;

  -- The till: spendable, and only a till or wallet.
  perform public.assert_spendable_account(p_from_account_id, 'source');

  -- The bank: a bank account of the same branch.
  select a.branch_id, a.cash_kind, a.name, a.status into v_bank_branch, v_bank_kind, v_bank_name, v_from_name
    from public.ledger_accounts a where a.id = p_bank_account_id;
  if v_bank_kind is distinct from 'bank' then
    raise exception 'A deposit must be made into a bank account.' using errcode = 'P0001';
  end if;
  if v_bank_branch <> v_branch then
    raise exception 'The bank account belongs to a different branch from the till.' using errcode = 'P0001';
  end if;

  select a.name into v_from_name from public.ledger_accounts a where a.id = p_from_account_id;

  v_transit := public.ensure_branch_transit_account(v_branch);

  -- A deposit IS an outgoing movement from the till: available funds, no override.
  perform public.lock_ledger_balances(array[p_from_account_id, v_transit]);
  perform public.assert_cash_funds_available(p_from_account_id, p_amount);

  v_date := public.business_date();
  v_id := pg_catalog.gen_random_uuid();

  v_entry := public.post_journal(
    v_branch, v_date,
    'Bank deposit from ' || v_from_name || ' to ' || v_bank_name
      || coalesce(' — ' || nullif(pg_catalog.btrim(coalesce(p_description, '')), ''), ''),
    'bank_deposit', v_id, null, null,
    pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object('account_id', v_transit, 'debit', p_amount, 'credit', 0,
        'memo', 'Taken to the bank — in transit'),
      pg_catalog.jsonb_build_object('account_id', p_from_account_id, 'debit', 0, 'credit', p_amount,
        'memo', 'Cash taken to the bank')
    ),
    null, v_actor, v_label);

  insert into public.bank_deposits
    (id, branch_id, from_account_id, transit_account_id, bank_account_id, amount,
     deposit_date, description, status, recorded_by, recorded_by_label,
     deposit_journal_entry_id, idempotency_key)
  values
    (v_id, v_branch, p_from_account_id, v_transit, p_bank_account_id, p_amount,
     v_date, nullif(pg_catalog.btrim(coalesce(p_description, '')), ''), 'submitted',
     v_actor, coalesce(v_label, 'system'), v_entry, p_idempotency_key);

  perform public.record_audit_event(
    'bank_deposit.recorded', 'bank_deposit', v_id::text, null,
    pg_catalog.jsonb_build_object('status', 'submitted', 'amount', p_amount),
    pg_catalog.jsonb_build_object('from_account_id', p_from_account_id,
      'bank_account_id', p_bank_account_id, 'journal_entry_id', v_entry));

  return v_id;
end;
$$;

revoke all on function public.record_bank_deposit(uuid, uuid, bigint, text, uuid) from public, anon;
grant execute on function public.record_bank_deposit(uuid, uuid, bigint, text, uuid) to authenticated;

create or replace function public.verify_bank_deposit(
  p_deposit_id      uuid,
  p_bank_reference  text,
  p_bank_value_date date,
  p_deposit_slip_path text default null,
  p_notes           text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  d        public.bank_deposits;
  v_actor  uuid;
  v_label  text;
  v_ref    text;
  v_entry  uuid;
  v_today  date;
begin
  v_actor := public.bank_deposit_actor('deposits:verify');
  v_label := public.audit_actor_label();

  select * into d from public.bank_deposits where id = p_deposit_id for update;
  if not found then
    raise exception 'No such bank deposit.' using errcode = 'P0001';
  end if;

  if not public.user_can_see_branch(d.branch_id) then
    raise exception 'That branch is not available to you.' using errcode = '42501';
  end if;

  -- Idempotent: a verified deposit stays verified.
  if d.status = 'cleared' then
    return d.clearance_journal_entry_id;
  end if;

  if d.status not in ('submitted', 'under_investigation') then
    raise exception 'Deposit % is %, and cannot be cleared.', d.deposit_number, d.status
      using errcode = 'P0001';
  end if;

  if v_actor is not null and d.recorded_by = v_actor then
    raise exception
      'You recorded this deposit, so you cannot verify its clearance. A different Manager or Owner must.'
      using errcode = '42501';
  end if;

  v_ref := pg_catalog.upper(pg_catalog.btrim(coalesce(p_bank_reference, '')));
  if v_ref = '' or char_length(v_ref) < 4 then
    raise exception 'A clearance needs the bank''s reference for the credit.' using errcode = 'P0001';
  end if;

  v_today := public.business_date();
  if p_bank_value_date is null then
    raise exception 'A clearance needs the bank''s value date.' using errcode = 'P0001';
  end if;
  if p_bank_value_date < d.deposit_date then
    raise exception 'The bank''s value date cannot precede the deposit.' using errcode = 'P0001';
  end if;
  if p_bank_value_date > v_today then
    raise exception 'The bank''s value date cannot be in the future.' using errcode = 'P0001';
  end if;

  -- The whole set, sorted, before the balance is read. Then the full amount
  -- must still be in transit (A-7: full clearance only).
  perform public.lock_ledger_balances(array[d.transit_account_id, d.bank_account_id]);
  perform public.assert_cash_funds_available(d.transit_account_id, d.amount);

  -- Dated today (A-6), never the value date.
  v_entry := public.post_journal(
    d.branch_id, v_today,
    'Bank clearance of ' || d.deposit_number || ' — ' || v_ref,
    'bank_deposit_clearance', d.id, null, null,
    pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object('account_id', d.bank_account_id, 'debit', d.amount, 'credit', 0,
        'memo', 'Cleared by the bank'),
      pg_catalog.jsonb_build_object('account_id', d.transit_account_id, 'debit', 0, 'credit', d.amount,
        'memo', 'Out of transit')
    ),
    null, v_actor, v_label);

  update public.bank_deposits
     set status = 'cleared',
         bank_reference = v_ref,
         bank_value_date = p_bank_value_date,
         deposit_slip_path = nullif(pg_catalog.btrim(coalesce(p_deposit_slip_path, '')), ''),
         clearance_notes = nullif(pg_catalog.btrim(coalesce(p_notes, '')), ''),
         verified_by = v_actor,
         verified_by_label = coalesce(v_label, 'system'),
         verified_at = pg_catalog.now(),
         clearance_journal_entry_id = v_entry
   where id = d.id;

  perform public.record_audit_event(
    'bank_deposit.cleared', 'bank_deposit', d.id::text,
    pg_catalog.jsonb_build_object('status', d.status),
    pg_catalog.jsonb_build_object('status', 'cleared', 'bank_reference', v_ref,
      'bank_value_date', p_bank_value_date),
    pg_catalog.jsonb_build_object('journal_entry_id', v_entry, 'amount', d.amount,
      'recorded_by_label', d.recorded_by_label, 'verified_by_label', coalesce(v_label, 'system')));

  return v_entry;
end;
$$;

revoke all on function public.verify_bank_deposit(uuid, text, date, text, text) from public, anon;
grant execute on function public.verify_bank_deposit(uuid, text, date, text, text) to authenticated;

-- Posts nothing. The money stays in transit, which is where it honestly is.
create or replace function public.open_deposit_investigation(p_deposit_id uuid, p_reason text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  d       public.bank_deposits;
  v_actor uuid;
  v_reason text;
begin
  v_actor := public.bank_deposit_actor('deposits:verify');

  v_reason := nullif(pg_catalog.btrim(coalesce(p_reason, '')), '');
  if v_reason is null or char_length(v_reason) < 4 then
    raise exception 'Say why this deposit is under investigation.' using errcode = 'P0001';
  end if;

  select * into d from public.bank_deposits where id = p_deposit_id for update;
  if not found then
    raise exception 'No such bank deposit.' using errcode = 'P0001';
  end if;
  if not public.user_can_see_branch(d.branch_id) then
    raise exception 'That branch is not available to you.' using errcode = '42501';
  end if;
  if d.status = 'under_investigation' then
    return d.id;
  end if;
  if d.status <> 'submitted' then
    raise exception 'Deposit % is %. Only a submitted deposit can be investigated.',
      d.deposit_number, d.status using errcode = 'P0001';
  end if;

  update public.bank_deposits
     set status = 'under_investigation',
         investigation_opened_at = pg_catalog.now(),
         investigation_opened_by = v_actor,
         investigation_reason = v_reason
   where id = d.id;

  perform public.record_audit_event(
    'bank_deposit.investigation_opened', 'bank_deposit', d.id::text,
    pg_catalog.jsonb_build_object('status', 'submitted'),
    pg_catalog.jsonb_build_object('status', 'under_investigation', 'reason', v_reason),
    pg_catalog.jsonb_build_object('amount', d.amount));

  return d.id;
end;
$$;

revoke all on function public.open_deposit_investigation(uuid, text) from public, anon;
grant execute on function public.open_deposit_investigation(uuid, text) to authenticated;

-- A-8. Cash returns to the till only after a different officer has verified
-- that it physically came back.
create or replace function public.confirm_physical_cash_return(p_deposit_id uuid, p_evidence_note text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  d        public.bank_deposits;
  v_actor  uuid;
  v_label  text;
  v_note   text;
  v_entry  uuid;
begin
  v_actor := public.bank_deposit_actor('deposits:verify');
  v_label := public.audit_actor_label();

  v_note := nullif(pg_catalog.btrim(coalesce(p_evidence_note, '')), '');
  if v_note is null or char_length(v_note) < 4 then
    raise exception 'Record the evidence of the physical return — who handed it back, when, and what was counted.'
      using errcode = 'P0001';
  end if;

  select * into d from public.bank_deposits where id = p_deposit_id for update;
  if not found then
    raise exception 'No such bank deposit.' using errcode = 'P0001';
  end if;
  if not public.user_can_see_branch(d.branch_id) then
    raise exception 'That branch is not available to you.' using errcode = '42501';
  end if;
  if d.status = 'returned_to_till' then
    return d.return_journal_entry_id;
  end if;
  if d.status <> 'under_investigation' then
    raise exception 'Deposit % is %. Only a deposit under investigation can be returned to the till.',
      d.deposit_number, d.status using errcode = 'P0001';
  end if;
  if v_actor is not null and d.recorded_by = v_actor then
    raise exception
      'You recorded this deposit, so you cannot confirm its return. A different Manager or Owner must.'
      using errcode = '42501';
  end if;

  perform public.lock_ledger_balances(array[d.transit_account_id, d.from_account_id]);
  perform public.assert_cash_funds_available(d.transit_account_id, d.amount);

  v_entry := public.post_journal(
    d.branch_id, public.business_date(),
    'Unbanked cash returned to the till — ' || d.deposit_number,
    'bank_deposit_return', d.id, null, null,
    pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object('account_id', d.from_account_id, 'debit', d.amount, 'credit', 0,
        'memo', 'Physical return verified'),
      pg_catalog.jsonb_build_object('account_id', d.transit_account_id, 'debit', 0, 'credit', d.amount,
        'memo', 'Out of transit')
    ),
    null, v_actor, v_label);

  update public.bank_deposits
     set status = 'returned_to_till',
         return_confirmed_at = pg_catalog.now(),
         return_confirmed_by = v_actor,
         return_evidence_note = v_note,
         return_journal_entry_id = v_entry
   where id = d.id;

  perform public.record_audit_event(
    'bank_deposit.returned_to_till', 'bank_deposit', d.id::text,
    pg_catalog.jsonb_build_object('status', 'under_investigation'),
    pg_catalog.jsonb_build_object('status', 'returned_to_till'),
    pg_catalog.jsonb_build_object('journal_entry_id', v_entry, 'amount', d.amount,
      'evidence', v_note));

  return v_entry;
end;
$$;

revoke all on function public.confirm_physical_cash_return(uuid, text) from public, anon;
grant execute on function public.confirm_physical_cash_return(uuid, text) to authenticated;

-- A-9. Owner only; never the verifier; the bank must hold the money as
-- AVAILABLE; an exact contra; the clearance evidence is preserved.
create or replace function public.reverse_bank_clearance(p_deposit_id uuid, p_reason text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  d        public.bank_deposits;
  v_actor  uuid;
  v_label  text;
  v_reason text;
  v_entry  uuid;
begin
  v_actor := public.bank_deposit_actor('deposits:reverse');
  v_label := public.audit_actor_label();

  v_reason := nullif(pg_catalog.btrim(coalesce(p_reason, '')), '');
  if v_reason is null or char_length(v_reason) < 4 then
    raise exception 'A clearance reversal must say why.' using errcode = 'P0001';
  end if;

  select * into d from public.bank_deposits where id = p_deposit_id for update;
  if not found then
    raise exception 'No such bank deposit.' using errcode = 'P0001';
  end if;
  if not public.user_can_see_branch(d.branch_id) then
    raise exception 'That branch is not available to you.' using errcode = '42501';
  end if;
  if d.status = 'reversed' then
    return d.reversal_entry_id;
  end if;
  if d.status <> 'cleared' then
    raise exception 'Deposit % is %. Only a cleared deposit can have its clearance reversed.',
      d.deposit_number, d.status using errcode = 'P0001';
  end if;
  if v_actor is not null and d.verified_by = v_actor then
    raise exception
      'You verified this clearance, so you cannot reverse it. A different Owner must.'
      using errcode = '42501';
  end if;

  perform public.lock_ledger_balances(array[d.bank_account_id, d.transit_account_id]);
  -- Available, not merely booked: the bank may have spent it since.
  perform public.assert_cash_funds_available(d.bank_account_id, d.amount);

  v_entry := public.post_journal(
    d.branch_id, public.business_date(),
    'Reversal of bank clearance ' || d.deposit_number || ' — ' || v_reason,
    'bank_deposit_clearance_reversal', d.id, null, null,
    pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object('account_id', d.transit_account_id, 'debit', d.amount, 'credit', 0,
        'memo', 'Back into transit'),
      pg_catalog.jsonb_build_object('account_id', d.bank_account_id, 'debit', 0, 'credit', d.amount,
        'memo', 'Clearance reversed')
    ),
    null, v_actor, v_label);

  update public.journal_entries
     set reversed_by_entry_id = v_entry
   where id = d.clearance_journal_entry_id and reversed_by_entry_id is null;

  update public.bank_deposits
     set status = 'reversed',
         reversed_by = v_actor,
         reversed_by_label = coalesce(v_label, 'system'),
         reversed_at = pg_catalog.now(),
         reversal_reason = v_reason,
         reversal_entry_id = v_entry
   where id = d.id;

  perform public.record_audit_event(
    'bank_deposit.clearance_reversed', 'bank_deposit', d.id::text,
    pg_catalog.jsonb_build_object('status', 'cleared', 'bank_reference', d.bank_reference,
      'bank_value_date', d.bank_value_date, 'verified_by_label', d.verified_by_label),
    pg_catalog.jsonb_build_object('status', 'reversed', 'reason', v_reason),
    pg_catalog.jsonb_build_object('journal_entry_id', v_entry, 'amount', d.amount));

  return v_entry;
end;
$$;

revoke all on function public.reverse_bank_clearance(uuid, text) from public, anon;
grant execute on function public.reverse_bank_clearance(uuid, text) to authenticated;
