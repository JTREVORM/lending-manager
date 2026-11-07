-- ===========================================================================
-- Phase 4C — Agency settlement: the provider/branch lock, and deferred
-- commission settlement.
--
-- ## The lock, and why a second kind of lock needs an ordering rule
--
-- Phase 4B-S serialises decisions that read a *cash or float balance* with
-- `lock_ledger_balances(uuid[])`, which takes one advisory lock per account,
-- sorted by account id so that two callers touching the same accounts can
-- never take them in opposite orders.
--
-- A commission settlement is not contended on an account. GL 1310 is shared
-- by every provider, so locking it would serialise every provider's
-- settlements against each other for no reason, while still not being the
-- thing that needs protecting. What needs protecting is one provider's
-- receivable at one branch: two settlements that each fit inside the
-- outstanding balance but together exceed it.
--
-- So this adds a second lock dimension, and a second dimension is where
-- deadlocks come from. The rule, stated once and obeyed by every function in
-- this phase:
--
--   **`lock_agency_provider_balance()` is always taken BEFORE
--   `lock_ledger_balances()`, never after.**
--
-- That gives one global order across both keyspaces, so no two callers can
-- hold one lock each and wait for the other. Nothing before this phase takes
-- a provider lock, so there is no existing path to contradict the rule.
-- ===========================================================================

create or replace function public.lock_agency_provider_balance(
  p_provider_id uuid,
  p_branch_id   uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- A prefixed key, so this cannot collide with the account-id keyspace that
  -- `lock_ledger_balances` hashes. A collision would only over-serialise
  -- rather than mislead, but keeping the spaces apart keeps the lock readable
  -- in pg_locks.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'agency_provider_balance:' || p_provider_id::text || ':'
        || coalesce(p_branch_id::text, 'null'), 0));
end;
$$;

comment on function public.lock_agency_provider_balance(uuid, uuid) is
  'Phase 4C. Serialises decisions that read one provider''s receivable or payable at one branch. Always taken before lock_ledger_balances(), so the two keyspaces have a single global order and cannot deadlock against each other.';

revoke all on function public.lock_agency_provider_balance(uuid, uuid)
  from public, anon, authenticated;


-- ---------------------------------------------------------------------------
-- A settlement account the business actually settles through
--
-- Deviation D9. §8.5 of the specification asks only for `cash_kind IS NOT
-- NULL`, which still admits `mtn_mobile_money` and `airtel_money` — the
-- wallets loan repayments arrive in. Receiving a provider's commission into a
-- loan repayment wallet, or paying a school out of one, would mix agency
-- settlement with lending collection in an account whose reconciliation is
-- somebody else's. `assert_cash_account()` already refuses `agency_float`.
--
-- So an agency settlement account must be a branch-held `cash_at_hand` or
-- `bank` account of the settling branch itself.
-- ---------------------------------------------------------------------------

create or replace function public.assert_agency_settlement_account(
  p_account_id uuid,
  p_branch_id  uuid,
  p_role       text
)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  r record;
begin
  select a.name, a.cash_kind, a.branch_id, a.status, a.is_postable
    into r
  from public.ledger_accounts a
  where a.id = p_account_id;

  if r is null then
    raise exception 'The % account does not exist.', p_role
      using errcode = 'P0001';
  end if;

  if r.cash_kind is null or r.cash_kind not in ('cash_at_hand', 'bank') then
    raise exception
      '% cannot be used as the % for an agency settlement. Use the branch''s cash at hand or its bank account.',
      r.name, p_role
      using errcode = 'P0001';
  end if;

  if r.branch_id is distinct from p_branch_id then
    raise exception
      '% does not belong to the branch settling this amount.', r.name
      using errcode = 'P0001';
  end if;

  if r.status <> 'active' or not r.is_postable then
    raise exception '% is not active, so it cannot be used.', r.name
      using errcode = 'P0001';
  end if;
end;
$$;

comment on function public.assert_agency_settlement_account(uuid, uuid, text) is
  'Phase 4C. An agency settlement account must be a branch-held cash-at-hand or bank account of the settling branch: not an agency float account, and not one of the mobile money wallets loan repayments arrive in.';

revoke all on function public.assert_agency_settlement_account(uuid, uuid, text)
  from public, anon, authenticated;


-- ---------------------------------------------------------------------------
-- record_commission_settlement
--
-- The provider remits accrued commission. §6.8:
--
--   Dr  the receiving branch asset        settlement_amount
--   Cr  1310 Agency Commission Receivable settlement_amount
--
-- 4510 is **not** touched. Income was recognised when the commission accrued,
-- at posting time; a settlement only converts a receivable into cash. Posting
-- to 4510 here would recognise the same income twice, which is why the line
-- builder below has no income leg at all rather than a conditional one.
-- ---------------------------------------------------------------------------

create or replace function public.record_commission_settlement(
  p_provider_id         uuid,
  p_branch_id           uuid,
  p_settlement_amount   bigint,
  p_settlement_account_id uuid,
  p_statement_ref       text default null,
  p_settlement_date     date default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor       uuid;
  v_label       text;
  pr            record;
  v_outstanding bigint;
  v_receivable  uuid;
  v_date        date;
  v_id          uuid;
  v_entry       uuid;
begin
  v_actor := public.agency_actor('agency:settlements');

  -- Branch isolation. A branch-scoped officer settles their own branch only;
  -- a Head Office profile (null branch) may settle any. The refusal is the
  -- same sentence whichever way it fails, so it discloses nothing about
  -- another branch's providers.
  if p_branch_id is null or not public.user_can_see_branch(p_branch_id) then
    raise exception
      'No agency provider with that identifier is available to you at that branch.'
      using errcode = '42501';
  end if;

  select p.id, p.name, p.commission_model, p.is_active, p.is_provisional
    into pr
  from public.agency_service_providers p
  where p.id = p_provider_id;

  if pr.id is null then
    raise exception
      'No agency provider with that identifier is available to you at that branch.'
      using errcode = '42501';
  end if;

  -- An immediate-commission provider never accrues a receivable: its
  -- commission is income at the moment of the transaction. There is nothing
  -- to settle, and accepting one would credit 1310 into a debit balance.
  if pr.commission_model <> 'deferred' then
    raise exception
      '% settles its commission immediately, so there is no receivable to remit.',
      pr.name
      using errcode = 'P0001';
  end if;

  if p_settlement_amount is null or p_settlement_amount <= 0 then
    raise exception
      'A commission settlement must be a positive number of shillings.'
      using errcode = 'P0001';
  end if;

  perform public.assert_agency_settlement_account(
    p_settlement_account_id, p_branch_id, 'receiving account');

  v_receivable := public.ledger_account_by_code('1310');

  -- Provider lock first, then the accounts, in that order. See the header.
  perform public.lock_agency_provider_balance(p_provider_id, p_branch_id);
  perform public.lock_ledger_balances(
    array[p_settlement_account_id, v_receivable]);

  -- Read after the lock, never before it: that is what makes two concurrent
  -- settlements see each other.
  v_outstanding := public.agency_commission_outstanding(
    p_provider_id, p_branch_id);

  if p_settlement_amount > v_outstanding then
    raise exception
      '% shillings of commission are outstanding for % at this branch, which is less than the % being settled.',
      v_outstanding, pr.name, p_settlement_amount
      using errcode = 'P0001';
  end if;

  v_date := coalesce(p_settlement_date, public.business_date());
  select p.full_name into v_label from public.profiles p where p.id = v_actor;

  begin
    insert into public.agency_commission_settlements
      (provider_id, branch_id, settlement_date, settlement_amount,
       settlement_account_id, provider_statement_ref, created_by)
    values
      (p_provider_id, p_branch_id, v_date, p_settlement_amount,
       p_settlement_account_id,
       nullif(pg_catalog.btrim(coalesce(p_statement_ref, '')), ''), v_actor)
    returning id into v_id;
  exception when unique_violation then
    -- The partial unique index on (provider_id, provider_statement_ref).
    raise exception
      'A commission settlement for % already records statement reference %.',
      pr.name, p_statement_ref
      using errcode = 'P0001';
  end;

  v_entry := public.post_journal(
    p_branch_id,
    v_date,
    pr.name || ' commission settlement'
      || coalesce(' — ' || nullif(pg_catalog.btrim(coalesce(p_statement_ref, '')), ''), ''),
    'agency_commission_settlement', v_id, null, null,
    pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'account_id', p_settlement_account_id,
        'debit', p_settlement_amount, 'credit', 0,
        'memo', 'Commission received'),
      pg_catalog.jsonb_build_object(
        'account_id', v_receivable,
        'debit', 0, 'credit', p_settlement_amount,
        'memo', 'Commission receivable cleared')),
    pg_catalog.now(), v_actor, coalesce(v_label, 'system')
  );

  update public.agency_commission_settlements
     set journal_entry_id = v_entry
   where id = v_id;

  -- Deviation D1: the agency transaction audit log cannot hold this, because
  -- its transaction_id is NOT NULL against agency_transactions and a
  -- settlement is not a transaction. The generic stream carries it instead.
  perform public.record_audit_event(
    'agency.commission_settled',
    'agency_commission_settlement',
    v_id::text,
    pg_catalog.jsonb_build_object('outstanding_before', v_outstanding),
    pg_catalog.jsonb_build_object(
      'provider_id', p_provider_id,
      'branch_id', p_branch_id,
      'settlement_amount', p_settlement_amount,
      'settlement_account_id', p_settlement_account_id,
      'statement_ref', p_statement_ref,
      'journal_entry_id', v_entry,
      'outstanding_after', v_outstanding - p_settlement_amount)
  );

  return v_id;
end;
$$;

comment on function public.record_commission_settlement(uuid, uuid, bigint, uuid, text, date) is
  'Phase 4C. Records one remittance of accrued agency commission: Dr the branch receiving account, Cr 1310. Requires agency:settlements, refuses a branch the caller cannot see with 42501, refuses an immediate-commission provider, refuses a non-positive amount, refuses a duplicate provider statement reference, and refuses more than the provider''s outstanding receivable at that branch — read after a provider-and-branch lock so two concurrent settlements cannot both fit. Supports partial settlement. Never touches 4510: the income was recognised at accrual.';

revoke all on function public.record_commission_settlement(uuid, uuid, bigint, uuid, text, date)
  from public, anon;
grant execute on function public.record_commission_settlement(uuid, uuid, bigint, uuid, text, date)
  to authenticated;
