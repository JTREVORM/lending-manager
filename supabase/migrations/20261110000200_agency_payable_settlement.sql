-- ===========================================================================
-- Phase 4C — Payable settlement, and its reversal.
--
-- §6.9: the agent hands collected cash over to the institution it collected
-- for, clearing the liability.
--
--   Dr  the provider's payable (2210 / 2220)   settlement_amount
--   Cr  the branch's cash or bank account      settlement_amount
--
-- This does **not** use `record_transfer()`, and could not: a payable account
-- has `cash_kind IS NULL`, so `assert_cash_account()` refuses it outright.
-- That is a property of the database rather than a convention to remember.
--
-- ## The no-advance rule applies here too
--
-- Phase 4B-S refuses a bank agency withdrawal that would take a provider's
-- net payable below zero, because past zero the liability becomes the bank
-- owing us for cash advanced — a different instrument. A settlement reduces
-- the same liability, so an over-settlement reaches the identical state by a
-- different route. The floor is therefore re-asserted on this path, against
-- the same per-provider, per-branch figure.
-- ===========================================================================

-- Deviation D5: commission settlements have had a duplicate-reference guard
-- since Phase 4A; payable settlements never did, so the same receipt could be
-- recorded twice. Partial, so that a settlement with no receipt reference is
-- still allowed — some institutions issue none — while any reference that is
-- given is unique per provider.
create unique index agency_payable_settlement_receipt_unique
  on public.agency_payable_settlements (provider_id, provider_receipt_ref)
  where provider_receipt_ref is not null;


-- ---------------------------------------------------------------------------
-- Branch-safe access to one settlement
--
-- The same shape as `agency_locked_transaction()` from Phase 4B-S, and for
-- the same reason: this function is SECURITY DEFINER, so the table's SELECT
-- policy does not run for it and the branch rule has to be applied in the
-- body. The refusal is identical for a settlement at another branch and for
-- an id that does not exist, so it discloses neither.
-- ---------------------------------------------------------------------------

create or replace function public.agency_locked_payable_settlement(
  p_settlement_id uuid
)
returns public.agency_payable_settlements
language plpgsql
security definer
set search_path = ''
as $$
declare
  s public.agency_payable_settlements;
begin
  select * into s from public.agency_payable_settlements
   where id = p_settlement_id for update;

  if s.id is null or not public.user_can_see_branch(s.branch_id) then
    raise exception
      'No agency payable settlement with that identifier is available to you.'
      using errcode = '42501';
  end if;

  return s;
end;
$$;

comment on function public.agency_locked_payable_settlement(uuid) is
  'Phase 4C. Locks one payable settlement and refuses it if the caller''s branch may not see it, with the same refusal as for an unknown id. The SELECT policy does not run for a definer function, so the branch rule is applied here.';

revoke all on function public.agency_locked_payable_settlement(uuid)
  from public, anon, authenticated;


-- ---------------------------------------------------------------------------
-- post_agency_payable_settlement
-- ---------------------------------------------------------------------------

create or replace function public.post_agency_payable_settlement(
  p_provider_id       uuid,
  p_branch_id         uuid,
  p_settlement_amount bigint,
  p_cash_account_id   uuid,
  p_receipt_ref       text default null,
  p_settlement_date   date default null
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
  v_date        date;
  v_id          uuid;
  v_entry       uuid;
begin
  v_actor := public.agency_actor('agency:settlements');

  if p_branch_id is null or not public.user_can_see_branch(p_branch_id) then
    raise exception
      'No agency provider with that identifier is available to you at that branch.'
      using errcode = '42501';
  end if;

  select p.id, p.name, p.float_model, p.payable_account_id
    into pr
  from public.agency_service_providers p
  where p.id = p_provider_id;

  if pr.id is null then
    raise exception
      'No agency provider with that identifier is available to you at that branch.'
      using errcode = '42501';
  end if;

  -- A provider_float provider holds no liability to settle: its money moves
  -- through its own float till, not through a payable.
  if pr.float_model <> 'cash_payable' or pr.payable_account_id is null then
    raise exception
      '% does not collect money on anybody''s behalf, so it has no payable to settle.',
      pr.name
      using errcode = 'P0001';
  end if;

  if p_settlement_amount is null or p_settlement_amount <= 0 then
    raise exception
      'A payable settlement must be a positive number of shillings.'
      using errcode = 'P0001';
  end if;

  perform public.assert_agency_settlement_account(
    p_cash_account_id, p_branch_id, 'paying account');

  -- Provider lock first, then accounts. See 20261110000100's header.
  perform public.lock_agency_provider_balance(p_provider_id, p_branch_id);
  perform public.lock_ledger_balances(
    array[p_cash_account_id, pr.payable_account_id]);

  v_outstanding := public.agency_payable_outstanding(p_provider_id, p_branch_id);

  if p_settlement_amount > v_outstanding then
    raise exception
      'Only % shillings are held on behalf of % at this branch, which is less than the % being settled. No approved bank-advance arrangement exists, so the payable may not go into net debit.',
      v_outstanding, pr.name, p_settlement_amount
      using errcode = 'P0001';
  end if;

  -- The cash really has to be in the till to hand over.
  perform public.assert_cash_available(p_cash_account_id, p_settlement_amount);

  v_date := coalesce(p_settlement_date, public.business_date());
  select p.full_name into v_label from public.profiles p where p.id = v_actor;

  begin
    insert into public.agency_payable_settlements
      (provider_id, branch_id, payable_account_id, cash_account_id,
       settlement_date, settlement_amount, provider_receipt_ref, created_by)
    values
      (p_provider_id, p_branch_id, pr.payable_account_id, p_cash_account_id,
       v_date, p_settlement_amount,
       nullif(pg_catalog.btrim(coalesce(p_receipt_ref, '')), ''), v_actor)
    returning id into v_id;
  exception when unique_violation then
    raise exception
      'A payable settlement for % already records receipt reference %.',
      pr.name, p_receipt_ref
      using errcode = 'P0001';
  end;

  v_entry := public.post_journal(
    p_branch_id,
    v_date,
    pr.name || ' payable settlement'
      || coalesce(' — ' || nullif(pg_catalog.btrim(coalesce(p_receipt_ref, '')), ''), ''),
    'agency_payable_settlement', v_id, null, null,
    pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'account_id', pr.payable_account_id,
        'debit', p_settlement_amount, 'credit', 0,
        'memo', 'Collections remitted'),
      pg_catalog.jsonb_build_object(
        'account_id', p_cash_account_id,
        'debit', 0, 'credit', p_settlement_amount,
        'memo', 'Cash handed over')),
    pg_catalog.now(), v_actor, coalesce(v_label, 'system')
  );

  update public.agency_payable_settlements
     set journal_entry_id = v_entry
   where id = v_id;

  perform public.record_audit_event(
    'agency.payable_settled',
    'agency_payable_settlement',
    v_id::text,
    pg_catalog.jsonb_build_object('outstanding_before', v_outstanding),
    pg_catalog.jsonb_build_object(
      'provider_id', p_provider_id,
      'branch_id', p_branch_id,
      'settlement_amount', p_settlement_amount,
      'payable_account_id', pr.payable_account_id,
      'cash_account_id', p_cash_account_id,
      'receipt_ref', p_receipt_ref,
      'journal_entry_id', v_entry,
      'outstanding_after', v_outstanding - p_settlement_amount)
  );

  return v_id;
end;
$$;

comment on function public.post_agency_payable_settlement(uuid, uuid, bigint, uuid, text, date) is
  'Phase 4C. Remits collections held on a provider''s behalf: Dr the provider''s payable, Cr the branch''s cash or bank account. Requires agency:settlements, refuses a branch the caller cannot see with 42501, refuses a provider_float provider, refuses a non-positive amount, refuses a duplicate receipt reference, refuses more than the provider''s own outstanding payable at that branch — so one bank''s collections cannot fund another''s settlement and no settlement can drive the liability into net debit — and refuses more cash than the till holds. Never uses record_transfer(), which could not reach a payable account anyway.';

revoke all on function public.post_agency_payable_settlement(uuid, uuid, bigint, uuid, text, date)
  from public, anon;
grant execute on function public.post_agency_payable_settlement(uuid, uuid, bigint, uuid, text, date)
  to authenticated;


-- ---------------------------------------------------------------------------
-- reverse_agency_payable_settlement
--
-- The cash was never actually handed over, or was handed over twice. The
-- contra restores both sides:
--
--   Dr  the branch's cash or bank account   settlement_amount
--   Cr  the provider's payable              settlement_amount
--
-- Requires `agency:reverse` rather than `agency:settlements`: recording a
-- remittance and undoing one are different authorities, and the officer who
-- recorded it should not be able to erase it on their own.
-- ---------------------------------------------------------------------------

create or replace function public.reverse_agency_payable_settlement(
  p_settlement_id uuid,
  p_reason        text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid;
  v_label text;
  s       public.agency_payable_settlements;
  v_name  text;
  v_entry uuid;
begin
  v_actor := public.agency_actor('agency:reverse');

  if pg_catalog.btrim(coalesce(p_reason, '')) = '' then
    raise exception 'A reversal needs a reason.' using errcode = 'P0001';
  end if;

  -- Locks the row and applies the branch rule.
  s := public.agency_locked_payable_settlement(p_settlement_id);

  if s.status <> 'posted' then
    raise exception
      'That payable settlement is already %, so it cannot be reversed again.',
      s.status
      using errcode = 'P0001';
  end if;

  select p.name into v_name
  from public.agency_service_providers p where p.id = s.provider_id;

  perform public.lock_agency_provider_balance(s.provider_id, s.branch_id);
  perform public.lock_ledger_balances(
    array[s.cash_account_id, s.payable_account_id]);

  select p.full_name into v_label from public.profiles p where p.id = v_actor;

  v_entry := public.post_journal(
    s.branch_id,
    public.business_date(),
    coalesce(v_name, 'Agency') || ' payable settlement reversed — ' || p_reason,
    'agency_payable_settlement_reversal', s.id, null, null,
    pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'account_id', s.cash_account_id,
        'debit', s.settlement_amount, 'credit', 0,
        'memo', 'Cash restored'),
      pg_catalog.jsonb_build_object(
        'account_id', s.payable_account_id,
        'debit', 0, 'credit', s.settlement_amount,
        'memo', 'Liability restored')),
    pg_catalog.now(), v_actor, coalesce(v_label, 'system')
  );

  update public.agency_payable_settlements
     set status          = 'reversed',
         reversed_at     = pg_catalog.now(),
         reversed_by     = v_actor,
         reversal_reason = p_reason,
         reversal_entry_id = v_entry
   where id = s.id;

  perform public.record_audit_event(
    'agency.payable_settlement_reversed',
    'agency_payable_settlement',
    s.id::text,
    pg_catalog.jsonb_build_object(
      'status', 'posted', 'journal_entry_id', s.journal_entry_id),
    pg_catalog.jsonb_build_object(
      'status', 'reversed',
      'reversal_entry_id', v_entry,
      'settlement_amount', s.settlement_amount,
      'reason', p_reason)
  );

  return v_entry;
end;
$$;

comment on function public.reverse_agency_payable_settlement(uuid, text) is
  'Phase 4C. Reverses one payable settlement by a contra entry — Dr cash, Cr the payable — restoring the liability the remittance cleared. Requires agency:reverse, not agency:settlements: recording a remittance and undoing one are different authorities. Refuses a settlement at another branch with 42501, refuses one already reversed, and requires a reason. The original row is never deleted or rewritten; its status, reverser, reason and contra entry are recorded on it.';

revoke all on function public.reverse_agency_payable_settlement(uuid, text)
  from public, anon;
grant execute on function public.reverse_agency_payable_settlement(uuid, text)
  to authenticated;
