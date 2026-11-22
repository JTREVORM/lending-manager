-- ===========================================================================
-- Operational task 3 — the money the business was started and funded with
--
-- ## The gap this closes
--
-- POLYTOS can account for every shilling that moves through it and cannot
-- account for the shillings it began with. The chart has carried `3000 Owner
-- Capital` since Phase 10, and exactly one thing has ever credited it: the
-- Phase 10 backfill, which *derived* an opening balance by finding the
-- deepest the cash position ever reached and crediting the difference to
-- capital so the books would not go negative. Its own memo says so:
--
--   > Derived: the deepest the cash position reaches over its whole history,
--   > so it never goes negative.
--
-- That was the right thing to do for a migration reconstructing history it
-- was not present for. It is not a way to record capital. There is no screen,
-- no function and no document: an Owner who puts 50,000,000 into the business
-- has nowhere to say so, and a lender who advances 20,000,000 is
-- indistinguishable from an owner who contributed it.
--
-- ## Equity is not borrowing, and the difference is the balance sheet
--
-- The distinction this migration exists to make:
--
--   * **Equity.** The owner's own money. It is not repayable, it carries no
--     interest, and it credits the 3000 series. The business's net worth goes
--     up by the whole amount.
--   * **Borrowing.** Somebody else's money. It is repayable, it may carry
--     interest, and it credits a 2300-series liability. The business's net
--     worth does not change at all: an asset and a liability arrive
--     together.
--
-- Recorded in one column with two values, and the ledger account each is
-- allowed to touch is checked against it. A borrowing cannot credit equity
-- and a contribution cannot credit a loan account — not by convention, by
-- refusal.
--
-- `2300` and its three children are added here because the chart had no
-- liability for money the business itself borrowed. `2100` is member savings
-- and `2200` is agency payables; neither is a borrowing, and putting a bank
-- loan in either would make the savings or the agency position unreadable.
--
-- ## Why recording posts nothing
--
-- The maker-checker spine, as `verify_bank_deposit` and
-- `verify_agency_transaction` have it: the journal is written **by the
-- verification**, by somebody who did not record it.
--
-- Capital is the largest single entry this business will ever make and the
-- least self-correcting. A till that is short shows up at the next cash
-- count; a float that is wrong shows up at the next reconciliation. An equity
-- credit shows up nowhere — it sits on the balance sheet looking exactly like
-- the truth. So one person records what the evidence says, a second checks it
-- against the evidence, and only then does anything post.
--
-- ## The three dates, kept apart
--
--   `funded_on`   what the evidence says: the date on the bank slip. May be
--                 historical, including before the system was in use.
--   `verified_at` when the second officer checked it.
--   `entry_date`  the accounting date of the journal: always today.
--
-- This is the `bank_value_date` discipline from Decision A, and it has the
-- same consequence, stated plainly rather than hidden: **a capital funding
-- recorded today posts today, whatever the slip says.** POLYTOS has no
-- period-close and no backdated posting, by deliberate design, so an opening
-- balance entered now lands in the current period with the real date recorded
-- beside it as evidence. An accountant reconciling to a prior-year balance
-- sheet reads `funded_on`; the ledger reads `entry_date`. Neither is guessed.
--
-- ## Preserved
--
-- Nothing existing is altered. `3000` keeps its code, type and postability.
-- `post_journal()` is called unmodified, so the balance lock, the reference
-- counter, the receipt restrictions and the balanced-entry triggers all apply
-- exactly as they do to every other posting. The journal's `source_type`
-- constraint is extended, not rewritten in meaning: the previous 44 values
-- are carried across verbatim.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- 1. Vocabulary
-- ---------------------------------------------------------------------------

insert into public.reference_formats (scope, prefix, padding, description)
values ('capital_funding', 'CF', 5, 'Capital introduced into the business, e.g. CF2600001')
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
    'bank_deposit', 'bank_deposit_clearance', 'bank_deposit_return',
    'bank_deposit_clearance_reversal',
    -- Operational task 3
    'capital_funding', 'capital_funding_reversal'
  ));

insert into public.permissions (key, description) values
  ('capital:view',    'Read the register of capital introduced into the business — the owner''s contributions and the money it has borrowed.'),
  ('capital:record',  'Record that capital has been introduced, with the evidence for it. Posts nothing: the journal is written by a second officer''s verification.'),
  ('capital:verify',  'Verify capital against its evidence, which posts it — debiting where the money landed and crediting equity or the borrowing it created. Refused for a funding the verifier recorded.'),
  ('capital:reverse', 'Reverse a posted capital funding. Owner only, never the officer who verified it, and only while the money is still where it landed.')
on conflict (key) do nothing;

-- Recording is an Owner or Manager act; verifying and reversing are the
-- Owner's. A Secretary/Treasurer is deliberately absent from all four: this
-- is the business's own capital structure, not front-office work.
insert into public.role_permissions (role_key, permission_key) values
  ('manager',     'capital:view'),
  ('manager',     'capital:record'),
  ('owner_admin', 'capital:view'),
  ('owner_admin', 'capital:record'),
  ('owner_admin', 'capital:verify'),
  ('owner_admin', 'capital:reverse')
on conflict (role_key, permission_key) do nothing;


-- ---------------------------------------------------------------------------
-- 2. Somewhere to put a borrowing
--
-- Parented under `2000 Liabilities` beside member savings and agency
-- payables. Three children rather than one, because a director's loan, a bank
-- facility and an unsecured advance are read differently by anybody looking
-- at the balance sheet, and splitting them later means restating history.
-- ---------------------------------------------------------------------------

insert into public.ledger_accounts
  (code, name, account_type, normal_side, is_postable, status, parent_id, description)
values
  ('2300', 'Borrowings', 'liability', 'credit', false, 'active',
   public.ledger_account_by_code('2000'),
   'Operational task 3. Money the business itself has borrowed and must repay. Distinct from 2100 member savings, which members own, and from 2200 agency payables, which are the customer''s money in transit.')
on conflict (code) do nothing;

insert into public.ledger_accounts
  (code, name, account_type, normal_side, is_postable, status, parent_id, description)
values
  ('2310', 'Director and Shareholder Loans', 'liability', 'credit', true, 'active',
   public.ledger_account_by_code('2300'),
   'Operational task 3. Money an owner or director has lent the business rather than contributed as capital: repayable, and not part of equity.'),
  ('2320', 'Bank and Institutional Loans', 'liability', 'credit', true, 'active',
   public.ledger_account_by_code('2300'),
   'Operational task 3. A facility advanced by a bank or other institution.'),
  ('2330', 'Other Borrowings', 'liability', 'credit', true, 'active',
   public.ledger_account_by_code('2300'),
   'Operational task 3. Borrowing that is neither a director''s loan nor an institutional facility.')
on conflict (code) do nothing;


-- ---------------------------------------------------------------------------
-- 3. The document
-- ---------------------------------------------------------------------------

create table public.capital_fundings (
  id                   uuid primary key default gen_random_uuid(),
  funding_number       text not null unique,
  branch_id            uuid not null references public.branches(id) on delete restrict,

  -- What kind of money this is. The whole point of the table.
  funding_kind         text not null,

  amount               bigint not null,

  -- Where it landed, and what it created.
  destination_account_id uuid not null references public.ledger_accounts(id) on delete restrict,
  capital_account_id     uuid not null references public.ledger_accounts(id) on delete restrict,

  -- Who provided it. Required: capital from nobody is not evidence of
  -- anything, and a borrowing with no lender cannot be repaid.
  funder_name          text not null,

  -- Borrowing terms. Null for equity, and the CHECK below says so.
  interest_rate_bps    integer,
  repayment_due_on     date,

  -- The evidence, and the date it bears.
  funded_on            date not null,
  evidence_kind        text not null,
  evidence_reference   text not null,
  description          text,

  status               text not null default 'submitted',

  recorded_by          uuid references public.profiles(id) on delete set null,
  recorded_by_label    text not null,

  verified_by          uuid references public.profiles(id) on delete set null,
  verified_by_label    text,
  verified_at          timestamptz,
  verification_note    text,

  rejected_by          uuid references public.profiles(id) on delete set null,
  rejected_by_label    text,
  rejected_at          timestamptz,
  rejection_reason     text,

  reversed_by          uuid references public.profiles(id) on delete set null,
  reversed_by_label    text,
  reversed_at          timestamptz,
  reversal_reason      text,

  journal_entry_id     uuid unique references public.journal_entries(id) on delete restrict,
  reversal_entry_id    uuid unique references public.journal_entries(id) on delete restrict,

  idempotency_key      uuid not null unique,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),

  constraint capital_fundings_amount_positive check (amount > 0),

  constraint capital_fundings_kind_valid
    check (funding_kind in ('equity', 'borrowing')),

  constraint capital_fundings_status_valid
    check (status in ('submitted', 'verified', 'rejected', 'reversed')),

  constraint capital_fundings_evidence_kind_valid
    check (evidence_kind in ('bank_transfer', 'cash_deposit', 'cheque', 'mobile_money', 'other')),

  constraint capital_fundings_funder_not_blank
    check (btrim(funder_name) <> '' and length(funder_name) <= 120),

  constraint capital_fundings_evidence_not_blank
    check (btrim(evidence_reference) <> '' and length(evidence_reference) <= 120),

  -- An asset cannot be its own source.
  constraint capital_fundings_accounts_distinct
    check (destination_account_id <> capital_account_id),

  -- Equity is not repayable and carries no interest. Stated as a constraint
  -- rather than left to the function, so no route can record an equity
  -- contribution that quietly has a due date.
  constraint capital_fundings_equity_has_no_terms
    check (funding_kind <> 'equity'
           or (interest_rate_bps is null and repayment_due_on is null)),

  constraint capital_fundings_rate_sane
    check (interest_rate_bps is null
           or (interest_rate_bps >= 0 and interest_rate_bps <= 100000)),

  constraint capital_fundings_due_after_funded
    check (repayment_due_on is null or repayment_due_on >= funded_on),

  -- Document ↔ journal consistency.
  constraint capital_fundings_posted_has_journal
    check ((status in ('verified', 'reversed')) = (journal_entry_id is not null)),

  constraint capital_fundings_reversed_has_reversal
    check ((status = 'reversed') = (reversal_entry_id is not null)),

  constraint capital_fundings_verified_has_evidence
    check (journal_entry_id is null
           or (verified_by_label is not null and btrim(verified_by_label) <> ''
               and verified_at is not null)),

  constraint capital_fundings_rejected_has_reason
    check ((status = 'rejected')
           = (rejection_reason is not null and btrim(coalesce(rejection_reason, '')) <> ''
              and rejected_at is not null)),

  constraint capital_fundings_reversal_has_reason
    check (reversal_entry_id is null
           or (reversal_reason is not null and btrim(reversal_reason) <> ''
               and reversed_at is not null)),

  -- Maker-checker, as constraints so no route — service_role included — can
  -- forget them. The `is null` escapes are for the trusted no-JWT path, which
  -- has no profile to offer and whose actions the audit event labels.
  constraint capital_fundings_verifier_not_recorder
    check (verified_by is null or recorded_by is null or verified_by <> recorded_by),
  constraint capital_fundings_rejecter_not_recorder
    check (rejected_by is null or recorded_by is null or rejected_by <> recorded_by),
  constraint capital_fundings_reverser_not_verifier
    check (reversed_by is null or verified_by is null or reversed_by <> verified_by)
);

comment on table public.capital_fundings is
  'Operational task 3. Capital introduced into the business: the owner''s own money (equity, crediting the 3000 series, not repayable) or money the business borrowed (crediting a 2300-series liability, repayable and possibly interest-bearing). Recording posts nothing; the journal is written by a second officer''s verification. funded_on is what the evidence says and may be historical; the journal is always dated the day it is verified.';

comment on column public.capital_fundings.funding_kind is
  'Operational task 3. equity or borrowing. Decides which ledger account the credit is allowed to touch, and therefore whether this money changed the business''s net worth.';

comment on column public.capital_fundings.funded_on is
  'Operational task 3. The date the evidence bears — the date on the bank slip. May precede the system''s own history, which is how an opening balance is recorded. The journal entry is dated the day of verification, never this: POLYTOS has no backdated posting.';

comment on column public.capital_fundings.interest_rate_bps is
  'Operational task 3. The borrowing''s rate in basis points: 1200 is 12% a year. Integer, like every other rate in this schema, because no numeric column is permitted here. NULL means none is recorded, which is not the same as zero, and an equity contribution must have none at all.';

create index capital_fundings_branch_status_idx
  on public.capital_fundings (branch_id, status, funded_on desc);
create index capital_fundings_status_idx
  on public.capital_fundings (status, created_at desc);
create index capital_fundings_kind_idx
  on public.capital_fundings (funding_kind, funded_on desc);

create trigger capital_fundings_set_updated_at
  before update on public.capital_fundings
  for each row execute function public.set_updated_at();

create trigger capital_fundings_no_delete
  before delete on public.capital_fundings
  for each row execute function public.reject_mutation();


-- ---------------------------------------------------------------------------
-- 4. What the document is, is write-once
-- ---------------------------------------------------------------------------

create or replace function public.capital_fundings_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.funding_number <> old.funding_number
     or new.branch_id <> old.branch_id
     or new.funding_kind <> old.funding_kind
     or new.amount <> old.amount
     or new.destination_account_id <> old.destination_account_id
     or new.capital_account_id <> old.capital_account_id
     or new.funded_on <> old.funded_on
     or new.idempotency_key <> old.idempotency_key
     or new.recorded_by is distinct from old.recorded_by
     or new.recorded_by_label <> old.recorded_by_label then
    raise exception
      'What a capital funding is — its kind, its amount, where the money went and who recorded it — is the thing being verified, so it cannot be edited. Reject it and record it again.'
      using errcode = 'P0001';
  end if;

  if old.journal_entry_id is not null
     and (new.journal_entry_id is distinct from old.journal_entry_id
          or new.verified_by is distinct from old.verified_by
          or new.verified_at is distinct from old.verified_at) then
    raise exception 'A verification, once recorded, cannot be edited.'
      using errcode = 'P0001';
  end if;

  if old.status in ('rejected', 'reversed') and new.status <> old.status then
    raise exception 'A capital funding that is % is finished.', old.status
      using errcode = 'P0001';
  end if;

  return new;
end;
$$;

revoke all on function public.capital_fundings_guard() from public, anon, authenticated;

create trigger capital_fundings_guard
  before update on public.capital_fundings
  for each row execute function public.capital_fundings_guard();

create or replace function public.capital_fundings_assign_number()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.funding_number is null or new.funding_number = '' then
    new.funding_number := public.next_reference('capital_funding');
  end if;
  return new;
end;
$$;

revoke all on function public.capital_fundings_assign_number()
  from public, anon, authenticated;

create trigger capital_fundings_assign_number
  before insert on public.capital_fundings
  for each row execute function public.capital_fundings_assign_number();


-- ---------------------------------------------------------------------------
-- 5. The accounts have to match the kind
--
-- A trigger, because it spans two tables and because it must hold however
-- the row arrives. The rule in one sentence: equity credits a postable 3000-
-- series equity account, a borrowing credits a postable 2300-series
-- liability, and the money lands in a branch-held cash or bank account of
-- the branch the document names.
-- ---------------------------------------------------------------------------

create or replace function public.capital_funding_accounts_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  d record;
  c record;
begin
  select la.account_type, la.cash_kind, la.branch_id, la.is_postable, la.status, la.name, la.code
    into d
  from public.ledger_accounts la where la.id = new.destination_account_id;

  if d is null then
    raise exception 'That destination account does not exist.' using errcode = 'P0001';
  end if;

  -- Capital arrives as money, into somewhere money is held. Not into a
  -- receivable, not into float: `cash_at_hand` or `bank`.
  if d.account_type <> 'asset'
     or d.cash_kind is null
     or d.cash_kind not in ('cash_at_hand', 'bank') then
    raise exception
      'Capital arrives as money, so it must land in a cash or bank account. % is not one.',
      d.name
      using errcode = 'P0001';
  end if;

  if not d.is_postable or d.status <> 'active' then
    raise exception '% is not active and postable.', d.name using errcode = 'P0001';
  end if;

  if d.branch_id is distinct from new.branch_id then
    raise exception
      '% belongs to a different branch than the funding claiming it.', d.name
      using errcode = 'P0001';
  end if;

  select la.account_type, la.is_postable, la.status, la.name, la.code into c
  from public.ledger_accounts la where la.id = new.capital_account_id;

  if c is null then
    raise exception 'That capital account does not exist.' using errcode = 'P0001';
  end if;

  if not c.is_postable or c.status <> 'active' then
    raise exception '% is not active and postable.', c.name using errcode = 'P0001';
  end if;

  if new.funding_kind = 'equity' then
    if c.account_type <> 'equity' or c.code not like '3%' then
      raise exception
        'A contribution of the owner''s own money is equity, so it credits the 3000 series. % is not an equity account.',
        c.name
        using errcode = 'P0001';
    end if;
  else
    if c.account_type <> 'liability' or c.code not like '23%' then
      raise exception
        'Borrowed money is repayable, so it credits a 2300-series borrowing. % is not one — 2100 is money members own and 2200 is the customer''s money in transit, and neither is a loan to the business.',
        c.name
        using errcode = 'P0001';
    end if;
  end if;

  return new;
end;
$$;

comment on function public.capital_funding_accounts_guard() is
  'Operational task 3. Holds a capital funding to its own kind: equity credits a postable 3000-series equity account, a borrowing credits a postable 2300-series liability, and the money lands in a branch-matched, postable cash or bank account. A trigger, so no route can post capital into the wrong half of the balance sheet.';

revoke all on function public.capital_funding_accounts_guard()
  from public, anon, authenticated;

create trigger capital_fundings_accounts_guard
  before insert or update on public.capital_fundings
  for each row execute function public.capital_funding_accounts_guard();


-- ---------------------------------------------------------------------------
-- 6. Row-level security
--
-- SELECT only, with `capital:view`, branch-isolated. The branch rule is
-- restated inline rather than calling `user_can_see_branch()`, which is
-- correlated and SECURITY DEFINER — the form `rls-hoisting.test.ts` enforces.
-- ---------------------------------------------------------------------------

alter table public.capital_fundings enable row level security;
revoke all on table public.capital_fundings from public, anon, authenticated;
grant select on table public.capital_fundings to authenticated;

create policy capital_fundings_select_with_permission
  on public.capital_fundings for select to authenticated
  using (
    (select public.user_has_permission('capital:view'))
    and (
      (select public.current_user_branch_id()) is null
      or branch_id = (select public.current_user_branch_id())
    )
  );


-- ---------------------------------------------------------------------------
-- 7. The shared preamble
-- ---------------------------------------------------------------------------

create or replace function public.capital_funding_actor(p_capability text)
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
    raise exception 'Capital must be handled by a signed-in member of staff.'
      using errcode = '42501';
  end if;

  if auth.uid() is not null and not public.user_has_permission(p_capability) then
    raise exception 'This requires the % capability.', p_capability
      using errcode = '42501';
  end if;

  return v_actor;
end;
$$;

revoke all on function public.capital_funding_actor(text)
  from public, anon, authenticated;


-- ---------------------------------------------------------------------------
-- 8. `record_capital_funding()` — posts nothing
-- ---------------------------------------------------------------------------

create or replace function public.record_capital_funding(
  p_funding_kind           text,
  p_amount                 bigint,
  p_destination_account_id uuid,
  p_capital_account_id     uuid,
  p_funder_name            text,
  p_funded_on              date,
  p_evidence_kind          text,
  p_evidence_reference     text,
  p_idempotency_key        uuid,
  p_interest_rate_bps      integer default null,
  p_repayment_due_on       date default null,
  p_description            text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor  uuid;
  v_label  text;
  v_id     uuid;
  v_branch uuid;
begin
  v_actor := public.capital_funding_actor('capital:record');
  v_label := public.audit_actor_label();

  if p_idempotency_key is null then
    raise exception 'A capital funding needs a receipt key.' using errcode = 'P0001';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('capital_funding_key:' || p_idempotency_key::text));

  -- Authorisation above the replay return (ADR-056): the branch is checked
  -- before an existing row is handed back.
  select a.branch_id into v_branch
  from public.ledger_accounts a where a.id = p_destination_account_id;

  if v_branch is null then
    raise exception
      'Capital must land in a branch-held cash or bank account, and that account does not exist.'
      using errcode = 'P0001';
  end if;

  if not public.user_can_see_branch(v_branch) then
    raise exception 'That branch is not available to you.' using errcode = '42501';
  end if;

  select f.id into v_id
  from public.capital_fundings f where f.idempotency_key = p_idempotency_key;
  if v_id is not null then
    return v_id;
  end if;

  if p_funding_kind is null or p_funding_kind not in ('equity', 'borrowing') then
    raise exception
      'Capital is either the owner''s own money (equity) or money the business borrowed (borrowing). % is neither.',
      coalesce(p_funding_kind, 'nothing')
      using errcode = 'P0001';
  end if;

  if p_amount is null or p_amount <= 0 then
    raise exception 'Capital must be a positive number of shillings.' using errcode = 'P0001';
  end if;

  if nullif(pg_catalog.btrim(coalesce(p_funder_name, '')), '') is null then
    raise exception
      'Record who provided this money. Capital from nobody is evidence of nothing, and a borrowing with no lender cannot be repaid.'
      using errcode = 'P0001';
  end if;

  if nullif(pg_catalog.btrim(coalesce(p_evidence_reference, '')), '') is null then
    raise exception
      'Record the reference of the evidence — the bank slip, the transfer, the cheque. It is what the second officer checks against.'
      using errcode = 'P0001';
  end if;

  if p_funded_on is null then
    raise exception 'Record the date the evidence bears.' using errcode = 'P0001';
  end if;

  if p_funded_on > public.business_date() then
    raise exception
      'That evidence is dated % , which is in the future. Capital cannot be recorded before it arrives.',
      p_funded_on
      using errcode = 'P0001';
  end if;

  if p_funding_kind = 'equity'
     and (p_interest_rate_bps is not null or p_repayment_due_on is not null) then
    raise exception
      'A contribution of the owner''s own money is not repayable and carries no interest. Record it as a borrowing if it is a loan to the business.'
      using errcode = 'P0001';
  end if;

  insert into public.capital_fundings (
    branch_id, funding_kind, amount,
    destination_account_id, capital_account_id,
    funder_name, interest_rate_bps, repayment_due_on,
    funded_on, evidence_kind, evidence_reference, description,
    status, recorded_by, recorded_by_label, idempotency_key
  )
  values (
    v_branch, p_funding_kind, p_amount,
    p_destination_account_id, p_capital_account_id,
    pg_catalog.btrim(p_funder_name), p_interest_rate_bps, p_repayment_due_on,
    p_funded_on,
    coalesce(nullif(pg_catalog.btrim(coalesce(p_evidence_kind, '')), ''), 'other'),
    pg_catalog.btrim(p_evidence_reference),
    nullif(pg_catalog.btrim(coalesce(p_description, '')), ''),
    'submitted', v_actor, coalesce(v_label, 'system'), p_idempotency_key
  )
  returning id into v_id;

  perform public.record_audit_event(
    'capital_funding.recorded', 'capital_funding', v_id::text, null,
    pg_catalog.jsonb_build_object(
      'status', 'submitted', 'funding_kind', p_funding_kind, 'amount', p_amount),
    pg_catalog.jsonb_build_object(
      'destination_account_id', p_destination_account_id,
      'capital_account_id', p_capital_account_id,
      'funder_name', pg_catalog.btrim(p_funder_name),
      'evidence_reference', pg_catalog.btrim(p_evidence_reference),
      'funded_on', p_funded_on),
    null);

  return v_id;
end;
$$;

comment on function public.record_capital_funding(
  text, bigint, uuid, uuid, text, date, text, text, uuid, integer, date, text) is
  'Operational task 3. Records that capital has been introduced, with its evidence. Posts nothing: the journal is written by verify_capital_funding(), run by somebody else. Requires capital:record. Idempotent on the receipt key.';

revoke all on function public.record_capital_funding(
  text, bigint, uuid, uuid, text, date, text, text, uuid, integer, date, text)
  from public, anon;
grant execute on function public.record_capital_funding(
  text, bigint, uuid, uuid, text, date, text, text, uuid, integer, date, text)
  to authenticated;


-- ---------------------------------------------------------------------------
-- 9. `verify_capital_funding()` — this is what posts
--
-- Two lines, and only two. Debit where the money landed; credit equity or the
-- borrowing. `post_journal()` does the rest: it locks the destination
-- account's balance before writing anything, takes the reference from the
-- counter, and the balanced-entry triggers refuse the entry if the two sides
-- disagree.
-- ---------------------------------------------------------------------------

create or replace function public.verify_capital_funding(
  p_funding_id uuid,
  p_note       text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  f        public.capital_fundings;
  v_actor  uuid;
  v_label  text;
  v_entry  uuid;
  v_today  date;
  v_dest   text;
  v_cap    text;
begin
  v_actor := public.capital_funding_actor('capital:verify');
  v_label := public.audit_actor_label();

  select * into f from public.capital_fundings where id = p_funding_id for update;
  if not found then
    raise exception 'No such capital funding.' using errcode = 'P0001';
  end if;

  if not public.user_can_see_branch(f.branch_id) then
    raise exception 'That branch is not available to you.' using errcode = '42501';
  end if;

  -- Idempotent: a verified funding stays verified and hands back its journal
  -- rather than posting a second one.
  if f.status = 'verified' then
    return f.journal_entry_id;
  end if;

  if f.status <> 'submitted' then
    raise exception 'Capital funding % is %, and cannot be verified.',
      f.funding_number, f.status
      using errcode = 'P0001';
  end if;

  if v_actor is not null and f.recorded_by is not null and v_actor = f.recorded_by then
    raise exception
      'You recorded capital funding %, so you cannot verify it. A different Owner or Administrator must check it against the evidence.',
      f.funding_number
      using errcode = 'SD001';
  end if;

  select a.name into v_dest from public.ledger_accounts a where a.id = f.destination_account_id;
  select a.name into v_cap  from public.ledger_accounts a where a.id = f.capital_account_id;

  v_today := public.business_date();

  v_entry := public.post_journal(
    f.branch_id, v_today,
    case f.funding_kind
      when 'equity' then 'Capital contributed by ' || f.funder_name
      else 'Borrowing from ' || f.funder_name
    end
      || ' — ' || f.evidence_reference
      || coalesce(' — ' || f.description, ''),
    'capital_funding', f.id, null, null,
    pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'account_id', f.destination_account_id, 'debit', f.amount, 'credit', 0,
        'memo', 'Capital received into ' || v_dest),
      pg_catalog.jsonb_build_object(
        'account_id', f.capital_account_id, 'debit', 0, 'credit', f.amount,
        'memo', case f.funding_kind
                  when 'equity' then 'Owner''s capital — not repayable'
                  else 'Borrowed from ' || f.funder_name || ' — repayable'
                end)
    ),
    null, v_actor, v_label);

  update public.capital_fundings
     set status            = 'verified',
         verified_by       = v_actor,
         verified_by_label = coalesce(v_label, 'system'),
         verified_at       = pg_catalog.now(),
         verification_note = nullif(pg_catalog.btrim(coalesce(p_note, '')), ''),
         journal_entry_id  = v_entry,
         updated_at        = pg_catalog.now()
   where id = p_funding_id;

  perform public.record_audit_event(
    'capital_funding.verified', 'capital_funding', p_funding_id::text,
    pg_catalog.jsonb_build_object('status', 'submitted'),
    pg_catalog.jsonb_build_object('status', 'verified', 'journal_entry_id', v_entry),
    pg_catalog.jsonb_build_object(
      'funding_kind', f.funding_kind, 'amount', f.amount,
      'entry_date', v_today, 'funded_on', f.funded_on),
    null);

  return v_entry;
end;
$$;

comment on function public.verify_capital_funding(uuid, text) is
  'Operational task 3. A second officer checks a recorded capital funding against its evidence, which posts it: debit where the money landed, credit equity or the borrowing it created. Requires capital:verify, refuses the officer who recorded it with SQLSTATE SD001, and is idempotent — a verified funding returns its existing journal rather than posting twice. The entry is dated today, never the evidence date.';

revoke all on function public.verify_capital_funding(uuid, text) from public, anon;
grant execute on function public.verify_capital_funding(uuid, text) to authenticated;


-- ---------------------------------------------------------------------------
-- 10. `reject_capital_funding()` — posts nothing, and is terminal
-- ---------------------------------------------------------------------------

create or replace function public.reject_capital_funding(
  p_funding_id uuid,
  p_reason     text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  f       public.capital_fundings;
  v_actor uuid;
  v_label text;
  v_reason text;
begin
  v_actor := public.capital_funding_actor('capital:verify');
  v_label := public.audit_actor_label();

  v_reason := nullif(pg_catalog.btrim(coalesce(p_reason, '')), '');
  if v_reason is null then
    raise exception 'Say why this capital funding is being rejected.'
      using errcode = 'P0001';
  end if;

  select * into f from public.capital_fundings where id = p_funding_id for update;
  if not found then
    raise exception 'No such capital funding.' using errcode = 'P0001';
  end if;

  if not public.user_can_see_branch(f.branch_id) then
    raise exception 'That branch is not available to you.' using errcode = '42501';
  end if;

  if f.status <> 'submitted' then
    raise exception 'Capital funding % is %, and cannot be rejected.',
      f.funding_number, f.status
      using errcode = 'P0001';
  end if;

  if v_actor is not null and f.recorded_by is not null and v_actor = f.recorded_by then
    raise exception
      'You recorded capital funding %, so you cannot reject it either. A different Owner or Administrator must.',
      f.funding_number
      using errcode = 'SD001';
  end if;

  update public.capital_fundings
     set status            = 'rejected',
         rejected_by       = v_actor,
         rejected_by_label = coalesce(v_label, 'system'),
         rejected_at       = pg_catalog.now(),
         rejection_reason  = v_reason,
         updated_at        = pg_catalog.now()
   where id = p_funding_id;

  perform public.record_audit_event(
    'capital_funding.rejected', 'capital_funding', p_funding_id::text,
    pg_catalog.jsonb_build_object('status', 'submitted'),
    pg_catalog.jsonb_build_object('status', 'rejected'),
    pg_catalog.jsonb_build_object('reason', v_reason), null);
end;
$$;

comment on function public.reject_capital_funding(uuid, text) is
  'Operational task 3. Rejects a recorded capital funding whose evidence does not hold up. Posts nothing and is terminal: the funding is re-recorded rather than edited, because what it claims is the thing being checked. Requires capital:verify and refuses the officer who recorded it.';

revoke all on function public.reject_capital_funding(uuid, text) from public, anon;
grant execute on function public.reject_capital_funding(uuid, text) to authenticated;


-- ---------------------------------------------------------------------------
-- 11. `reverse_capital_funding()` — Owner only, and only if the money is there
--
-- The contra of a posted funding. It needs available funds in the destination
-- account for the same reason `reverse_bank_clearance` does: reversing an
-- entry that credited equity and debited the bank takes the money back out of
-- the bank, and if it has already been lent out there is nothing to take.
-- Refusing is correct — what is wanted then is a capital *withdrawal*, which
-- is a different instrument and is not invented here.
-- ---------------------------------------------------------------------------

create or replace function public.reverse_capital_funding(
  p_funding_id uuid,
  p_reason     text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  f        public.capital_fundings;
  v_actor  uuid;
  v_label  text;
  v_entry  uuid;
  v_reason text;
  v_dest   text;
begin
  v_actor := public.capital_funding_actor('capital:reverse');
  v_label := public.audit_actor_label();

  v_reason := nullif(pg_catalog.btrim(coalesce(p_reason, '')), '');
  if v_reason is null then
    raise exception 'Say why this capital funding is being reversed.'
      using errcode = 'P0001';
  end if;

  select * into f from public.capital_fundings where id = p_funding_id for update;
  if not found then
    raise exception 'No such capital funding.' using errcode = 'P0001';
  end if;

  if not public.user_can_see_branch(f.branch_id) then
    raise exception 'That branch is not available to you.' using errcode = '42501';
  end if;

  if f.status = 'reversed' then
    return f.reversal_entry_id;
  end if;

  if f.status <> 'verified' then
    raise exception
      'Only a posted capital funding can be reversed; % is %.', f.funding_number, f.status
      using errcode = 'P0001';
  end if;

  if v_actor is not null and f.verified_by is not null and v_actor = f.verified_by then
    raise exception
      'You verified capital funding %, so you cannot reverse it. A different Owner must.',
      f.funding_number
      using errcode = 'SD001';
  end if;

  select a.name into v_dest from public.ledger_accounts a where a.id = f.destination_account_id;

  -- The money has to still be there. `assert_cash_funds_available` is the
  -- same check every outgoing path in this schema makes, and it is made after
  -- the balance lock so a concurrent spend cannot slip between them.
  perform public.lock_ledger_balances(array[f.destination_account_id]);
  perform public.assert_cash_funds_available(f.destination_account_id, f.amount);

  v_entry := public.post_journal(
    f.branch_id, public.business_date(),
    'Reversal of capital funding ' || f.funding_number || ' — ' || v_reason,
    'capital_funding_reversal', f.id, null, null,
    pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'account_id', f.capital_account_id, 'debit', f.amount, 'credit', 0,
        'memo', 'Reversal of ' || f.funding_number),
      pg_catalog.jsonb_build_object(
        'account_id', f.destination_account_id, 'debit', 0, 'credit', f.amount,
        'memo', 'Capital taken back out of ' || v_dest)
    ),
    null, v_actor, v_label);

  update public.capital_fundings
     set status            = 'reversed',
         reversed_by       = v_actor,
         reversed_by_label = coalesce(v_label, 'system'),
         reversed_at       = pg_catalog.now(),
         reversal_reason   = v_reason,
         reversal_entry_id = v_entry,
         updated_at        = pg_catalog.now()
   where id = p_funding_id;

  perform public.record_audit_event(
    'capital_funding.reversed', 'capital_funding', p_funding_id::text,
    pg_catalog.jsonb_build_object('status', 'verified'),
    pg_catalog.jsonb_build_object('status', 'reversed', 'reversal_entry_id', v_entry),
    pg_catalog.jsonb_build_object('reason', v_reason, 'amount', f.amount), null);

  return v_entry;
end;
$$;

comment on function public.reverse_capital_funding(uuid, text) is
  'Operational task 3. Posts the contra of a verified capital funding. Owner only, never the officer who verified it, and only while the money is still available in the account it landed in — reversing capital that has already been lent out is refused rather than driving the account negative.';

revoke all on function public.reverse_capital_funding(uuid, text) from public, anon;
grant execute on function public.reverse_capital_funding(uuid, text) to authenticated;


-- ---------------------------------------------------------------------------
-- 12. The register, as a screen reads it
-- ---------------------------------------------------------------------------

create view public.capital_funding_register
with (security_invoker = true) as
select
  f.id                      as funding_id,
  f.funding_number,
  f.branch_id,
  b.branch_code,
  b.name                    as branch_name,
  f.funding_kind,
  f.amount,
  f.funder_name,
  f.interest_rate_bps,
  f.repayment_due_on,
  f.funded_on,
  f.evidence_kind,
  f.evidence_reference,
  f.description,
  f.status,
  da.code                   as destination_account_code,
  da.name                   as destination_account_name,
  ca.code                   as capital_account_code,
  ca.name                   as capital_account_name,
  f.recorded_by_label,
  f.created_at              as recorded_at,
  f.verified_by_label,
  f.verified_at,
  f.verification_note,
  f.rejected_by_label,
  f.rejected_at,
  f.rejection_reason,
  f.reversed_by_label,
  f.reversed_at,
  f.reversal_reason,
  f.journal_entry_id,
  je.entry_number           as journal_entry_number,
  je.entry_date             as journal_entry_date,
  f.reversal_entry_id
from public.capital_fundings f
join public.branches b on b.id = f.branch_id
join public.ledger_accounts da on da.id = f.destination_account_id
join public.ledger_accounts ca on ca.id = f.capital_account_id
left join public.journal_entries je on je.id = f.journal_entry_id;

comment on view public.capital_funding_register is
  'Operational task 3. Every capital funding with its kind, its evidence, both ledger accounts, the whole maker-checker trail and the journal entry it posted. security_invoker, so the reader''s own RLS on capital_fundings decides what they see.';

revoke all on public.capital_funding_register from public, anon, authenticated;
grant select on public.capital_funding_register to authenticated;
