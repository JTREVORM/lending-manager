-- ===========================================================================
-- Phase 4A — Agency Banking & Digital Payments: extend the existing financial
-- constraints
--
-- Specification: `docs/AGENCY-BANKING-ARCHITECTURE.md` v3.0, §5.1 and §8.1.
-- Reconciliation: `docs/POLYTOS-PHASE-4-ARCHITECTURE-RECONCILIATION.md`.
--
-- This is the first Phase 4 migration. It changes no existing row and adds no
-- table; it widens three constraints, adds two settings columns, and closes
-- the one bypass that widening the first constraint would otherwise open.
--
-- ## The constraint names in the specification are wrong
--
-- §5.1 drops `ledger_accounts_cash_kind_check` and
-- `journal_entries_source_type_check`. Neither exists. The real names, queried
-- from the 171-migration schema, are `ledger_accounts_cash_kind_valid` and
-- `journal_entries_source_valid` (findings D1 and D2). Taken literally the
-- specification's DDL aborts, which is why it is corrected here rather than
-- transcribed.
--
-- ## Why `agency_float` must be a `cash_kind` at all
--
-- It would be safer, on the face of it, to leave float accounts with
-- `cash_kind IS NULL` and mark them only in the agency registry. The schema
-- forbids it. `ledger_accounts_cash_is_branch_held` asserts
-- `(cash_kind IS NULL) = (branch_id IS NULL)`, and a float account is held by
-- one branch — so it must carry a branch, and therefore must carry a kind.
--
-- ## What that opens, and what is done about it
--
-- `assert_cash_account()` never enumerated kinds. Its only test is
-- `cash_kind is null`. So the moment `agency_float` is legal, every float
-- account becomes a legal `record_transfer()` endpoint, and four things follow
-- (all verified against the live function bodies, finding A):
--
--   1. `record_transfer()` gates on `transfers:create`, which
--      `secretary_treasurer` holds. Float could be moved by somebody holding
--      no `agency:*` permission whatsoever.
--   2. The movement posts `source_type = 'transfer'`, so it never appears in
--      `agency_transactions`, never reaches the agency audit log, and is
--      invisible to every agency report.
--   3. `record_transfer()` calls `assert_cash_available()`, which reads
--      `allow_negative_cash` — the very flag correction C4 separates agency
--      float from. The bypass C4 exists to prevent, on the one path C4 does
--      not cover.
--   4. `branch_cash_account(branch, 'agency_float')` resolves
--      `order by code limit 1`, so with several tills per branch it would
--      silently return an arbitrary one.
--
-- So the kind is added and `assert_cash_account()` is hardened to refuse it in
-- the same migration. The two are inseparable: either without the other is a
-- defect. This is backward compatible by construction — no account carries
-- `cash_kind = 'agency_float'` before this migration runs, so no existing
-- transfer, test or certified behaviour can change.
--
-- Float accounts are resolved through `agency_provider_float_accounts` by
-- (provider, branch, till), never through `branch_cash_account()`.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- 1. `cash_kind` admits agency float
-- ---------------------------------------------------------------------------

alter table public.ledger_accounts
  drop constraint ledger_accounts_cash_kind_valid;

alter table public.ledger_accounts
  add constraint ledger_accounts_cash_kind_valid
  check (
    cash_kind is null
    or cash_kind = any (array[
      'cash_at_hand', 'mtn_mobile_money', 'airtel_money', 'bank', 'agency_float'
    ])
  );

-- `ledger_accounts_one_wallet_per_branch` is deliberately NOT touched. It is a
-- partial unique index over ('cash_at_hand','mtn_mobile_money','airtel_money')
-- only, so `agency_float` falls outside it and a branch may hold several float
-- accounts — one per provider, and several per provider where there are
-- several tills (correction C13). Adding the kind to that index would make
-- multiple tills impossible.


-- ---------------------------------------------------------------------------
-- 1b. The account code shape admits the float account format
--
-- `ledger_accounts_code_shape` was `^[0-9A-Z][0-9A-Z.-]{1,23}$` — no
-- underscore, 24 characters at most. §3.1 mandates
-- `1320.{PROVIDER}.{BRANCH}[.T2]`, and a provider code may contain an
-- underscore (`MTN_MOMO`) while a branch code may be 16 characters on its own,
-- so the specified format does not fit: `1320.MTN_MOMO.BR2601` is rejected on
-- the underscore alone, and a long provider at a long branch with a second
-- till would exceed 24 characters even without one.
--
-- Widened rather than worked around, because the alternatives are worse: a
-- shortened code would collide between providers, and a provisioning function
-- that fails on a long provider code is an operational landmine that only
-- appears the first time somebody opens a second till.
--
-- This is a pure widening. Every code that matched the old pattern matches the
-- new one, so no existing row and no existing test is affected, and nothing
-- outside this constraint depends on the old length.
-- ---------------------------------------------------------------------------

alter table public.ledger_accounts
  drop constraint ledger_accounts_code_shape;

alter table public.ledger_accounts
  add constraint ledger_accounts_code_shape
  check (code ~ '^[0-9A-Z][0-9A-Z._-]{1,63}$');


-- ---------------------------------------------------------------------------
-- 2. `assert_cash_account()` refuses agency float
--
-- The existing messages and error codes are preserved exactly; one refusal is
-- inserted. `P0001` is correct here and is not an instance of finding F1: this
-- is a business-rule refusal about the kind of account offered, not a
-- capability refusal about who is asking.
-- ---------------------------------------------------------------------------

create or replace function public.assert_cash_account(p_account_id uuid, p_role text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  r record;
begin
  select a.cash_kind, a.status, a.name, a.is_postable into r
  from public.ledger_accounts a where a.id = p_account_id;

  if r is null then
    raise exception 'The % account does not exist.', p_role using errcode = 'P0001';
  end if;

  if r.cash_kind is null then
    raise exception
      '% is not a cash account, so money cannot be % it.', r.name,
      case p_role when 'source' then 'taken out of' else 'put into' end
      using errcode = 'P0001';
  end if;

  -- Phase 4A. An agency float account is a cash account in the ledger's sense
  -- — it is an asset with a kind and a branch — but it is not reachable by a
  -- generic cash transfer. Float is funded by `post_float_replenishment()` and
  -- spent by the agency posting path, both of which require an `agency:*`
  -- capability and both of which write the agency audit trail. Allowing it
  -- here would let `transfers:create` alone move it, unaudited, under
  -- `allow_negative_cash`.
  if r.cash_kind = 'agency_float' then
    raise exception
      '% is an agency float account. Float is moved through the agency services module, not through a cash transfer.',
      r.name
      using errcode = 'P0001';
  end if;

  if r.status <> 'active' or not r.is_postable then
    raise exception '% is not active, so it cannot be used.', r.name
      using errcode = 'P0001';
  end if;
end;
$$;

comment on function public.assert_cash_account(uuid, text) is
  'Phase 11, hardened in Phase 4A. Refuses any account that is not an active, postable cash account — and refuses agency float specifically, because float must move through the agency services module where it is gated on agency capabilities and recorded in the agency audit trail. See docs/POLYTOS-PHASE-4-ARCHITECTURE-RECONCILIATION.md finding A.';


-- ---------------------------------------------------------------------------
-- 3. `source_type` admits the five agency kinds
--
-- The 21 existing values are repeated verbatim; five are added. The `_reversal`
-- suffix follows the established convention (correction C5). There is no
-- `agency_commission_settlement_reversal`: a commission settlement is cleared
-- by a further settlement entry rather than reversed, so the value would never
-- be written.
-- ---------------------------------------------------------------------------

alter table public.journal_entries
  drop constraint journal_entries_source_valid;

alter table public.journal_entries
  add constraint journal_entries_source_valid
  check (
    source_type = any (array[
      'opening_balance', 'loan_disbursement', 'loan_repayment', 'payment_reversal',
      'penalty_charge', 'transfer', 'transfer_reversal', 'expense', 'expense_reversal',
      'other_income', 'other_income_reversal', 'reconciliation_adjustment', 'adjustment',
      'membership_fee', 'membership_fee_reversal', 'savings_deposit',
      'savings_deposit_reversal', 'savings_withdrawal', 'savings_withdrawal_reversal',
      'benefit_payment', 'benefit_payment_reversal',
      -- Phase 4A
      'agency_transaction', 'agency_transaction_reversal',
      'agency_commission_settlement',
      'agency_payable_settlement', 'agency_payable_settlement_reversal'
    ])
  );


-- ---------------------------------------------------------------------------
-- 4. Agency float settings, independent of the cash settings
--
-- Correction C4. `allow_negative_agency_float` is a separate column from
-- `allow_negative_cash` so that permitting a negative till can never, by
-- itself, permit negative electronic float. They are different risks: a
-- negative till is a counting error, negative float is money the provider
-- never advanced.
-- ---------------------------------------------------------------------------

alter table public.finance_settings
  add column allow_negative_agency_float boolean not null default false,
  add column low_balance_agency_float bigint not null default 200000;

comment on column public.finance_settings.allow_negative_agency_float is
  'Phase 4A, correction C4. Whether an agency float account may be drawn below zero. Deliberately NOT allow_negative_cash: read only by assert_agency_float_available(), so relaxing the cash rule cannot relax the float rule.';

comment on column public.finance_settings.low_balance_agency_float is
  'Phase 4A. The balance at or below which an agency float account is reported as low, in UGX minor units. A warning threshold only; it refuses nothing.';


-- ---------------------------------------------------------------------------
-- 5. `assert_agency_float_available()`
--
-- Correction C4, §8.1. Deliberately not a call to `assert_cash_available()`:
-- that function reads `allow_negative_cash`, and the whole point of the
-- separate column is that the two cannot be conflated. The structure mirrors
-- it so the two read alike, but the setting it consults is its own.
-- ---------------------------------------------------------------------------

create or replace function public.assert_agency_float_available(
  p_account_id uuid,
  p_amount bigint
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_allow   boolean;
  v_balance bigint;
  v_name    text;
  v_kind    text;
begin
  select a.name, a.cash_kind into v_name, v_kind
  from public.ledger_accounts a where a.id = p_account_id;

  if v_name is null then
    raise exception 'That float account does not exist.' using errcode = 'P0001';
  end if;

  -- Guards against the mirror of finding A: an agency posting aimed at a
  -- non-float cash account would otherwise be checked against the float
  -- setting instead of the cash one.
  if v_kind is distinct from 'agency_float' then
    raise exception
      '% is not an agency float account, so the float rule does not apply to it.', v_name
      using errcode = 'P0001';
  end if;

  select fs.allow_negative_agency_float into v_allow
  from public.finance_settings fs where fs.id = 1;

  if coalesce(v_allow, false) then
    return;
  end if;

  v_balance := public.ledger_account_balance(p_account_id);

  if v_balance >= p_amount then
    return;
  end if;

  raise exception
    '% holds % shillings of float, which is less than the % being sent out of it.',
    v_name, v_balance, p_amount
    using errcode = 'P0001';
end;
$$;

comment on function public.assert_agency_float_available(uuid, bigint) is
  'Phase 4A, correction C4. Refuses an agency float movement that would overdraw the account, unless finance_settings.allow_negative_agency_float is set. Reads only that column — never allow_negative_cash — so the cash rule and the float rule stay independent. Refuses any account that is not agency float.';

revoke all on function public.assert_agency_float_available(uuid, bigint)
  from public, anon, authenticated;
