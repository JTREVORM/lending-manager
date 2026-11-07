-- ===========================================================================
-- Phase 4C — Electronic float replenishment.
--
-- §6.10 gives the journal and then defers the decision:
--
--   "Use a dedicated post_float_replenishment() function or extend
--    record_transfer() to accept agency_float — decision deferred for
--    implementation."
--
-- Resolved here as a **dedicated function**, and `record_transfer()` is left
-- exactly as it is. Extending it was the cheaper change and the worse one:
-- that path is shared with lending, it is reachable with `transfers:create`
-- alone, and it honours `allow_negative_cash`. Widening it to accept
-- `agency_float` would put every lending caller one argument away from an
-- agency float account, under the wrong setting and with no agency audit
-- trail. `assert_cash_account()` already refuses `agency_float` and says so
-- in its own comment, naming this function as the way float is funded.
--
--   Dr  the provider's float till (1320-series)   amount
--   Cr  an approved funding account               amount
--
-- The funding account goes through `assert_agency_settlement_account()`, so
-- it must be the settling branch's own cash-at-hand or bank account. That
-- refusal is what keeps a top-up out of `mtn_mobile_money` and
-- `airtel_money` — the wallets loan repayments arrive in — and out of another
-- float account, which would move float sideways while appearing to fund it.
-- ===========================================================================

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
      'agency_payable_settlement', 'agency_payable_settlement_reversal',
      -- Phase 4C
      'agency_float_replenishment'
    ])
  );


create table public.agency_float_replenishments (
  id                  uuid primary key default gen_random_uuid(),

  -- Provider and branch are denormalised from the till so that a report can
  -- scope by either without a three-table join, and a guard trigger below
  -- asserts they agree with the till's own registration rather than trusting
  -- the caller. Deviation D3 records the same choice for float reconciliation.
  provider_id         uuid not null references public.agency_service_providers(id) on delete restrict,
  branch_id           uuid not null references public.branches(id) on delete restrict,
  float_account_id    uuid not null references public.agency_provider_float_accounts(id) on delete restrict,

  funding_account_id  uuid not null references public.ledger_accounts(id) on delete restrict,

  replenishment_date  date   not null,
  amount              bigint not null,

  -- What the provider said when the float arrived. Not validated — its value
  -- is that somebody had to name something checkable.
  provider_reference  text,

  journal_entry_id    uuid references public.journal_entries(id) on delete restrict,

  created_by          uuid not null references public.profiles(id) on delete restrict,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  constraint agency_float_replenishment_amount_positive
    check (amount > 0),
  constraint agency_float_replenishment_reference_shape
    check (provider_reference is null or btrim(provider_reference) <> '')
);

comment on table public.agency_float_replenishments is
  'Phase 4C. One top-up of one provider float till from an approved funding account. Recorded per till, so a provider with several tills replenishes each independently.';

-- Deviation D5 applied to this table from the start: a provider reference, if
-- given, is unique per till, so the same top-up cannot be recorded twice.
create unique index agency_float_replenishment_reference_unique
  on public.agency_float_replenishments (float_account_id, provider_reference)
  where provider_reference is not null;

create index agency_float_replenishments_provider_idx
  on public.agency_float_replenishments (provider_id, replenishment_date desc);

create index agency_float_replenishments_branch_idx
  on public.agency_float_replenishments (branch_id, replenishment_date desc);

create trigger agency_float_replenishments_set_updated_at
  before update on public.agency_float_replenishments
  for each row execute function public.set_updated_at();

create trigger agency_float_replenishments_no_delete
  before delete on public.agency_float_replenishments
  for each row execute function public.reject_mutation();


-- The denormalised provider and branch must agree with the till's own
-- registration. A trigger rather than a CHECK, because the invariant spans
-- two tables and a CHECK cannot read one.
create or replace function public.agency_float_replenishment_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  f record;
begin
  select a.provider_id, a.branch_id into f
  from public.agency_provider_float_accounts a
  where a.id = new.float_account_id;

  if f is null then
    raise exception 'That float till is not registered.' using errcode = 'P0001';
  end if;

  if f.provider_id <> new.provider_id or f.branch_id <> new.branch_id then
    raise exception
      'That float till belongs to a different provider or branch than the one recorded.'
      using errcode = 'P0001';
  end if;

  return new;
end;
$$;

revoke all on function public.agency_float_replenishment_guard() from public, anon, authenticated;

create trigger agency_float_replenishments_guard
  before insert or update on public.agency_float_replenishments
  for each row execute function public.agency_float_replenishment_guard();


alter table public.agency_float_replenishments enable row level security;

-- The hoisted form the repository enforces (tests/db/rls-hoisting.test.ts),
-- with the Head Office rule restated inline.
create policy agency_float_replenishments_select_with_permission
  on public.agency_float_replenishments
  for select
  using (
    (select public.user_has_permission('agency:reports'))
    and (
      branch_id is null
      or (select public.current_user_branch_id()) is null
      or branch_id = (select public.current_user_branch_id())
    )
  );

grant select on public.agency_float_replenishments to authenticated;


-- ---------------------------------------------------------------------------
-- post_float_replenishment
-- ---------------------------------------------------------------------------

create or replace function public.post_float_replenishment(
  p_float_account_id   uuid,
  p_amount             bigint,
  p_funding_account_id uuid,
  p_reference          text default null,
  p_replenishment_date date default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor  uuid;
  v_label  text;
  f        record;
  v_ledger uuid;
  v_date   date;
  v_id     uuid;
  v_entry  uuid;
begin
  v_actor := public.agency_actor('agency:settlements');

  -- The till identifies the provider and the branch; the caller does not get
  -- to assert either. Keyed on the till, so a provider with several tills
  -- replenishes each one separately and a top-up cannot land on the wrong one.
  select a.id, a.provider_id, a.branch_id, a.ledger_account_id, a.is_active,
         p.name as provider_name
    into f
  from public.agency_provider_float_accounts a
  join public.agency_service_providers p on p.id = a.provider_id
  where a.id = p_float_account_id;

  if f.id is null or not public.user_can_see_branch(f.branch_id) then
    raise exception
      'No agency float till with that identifier is available to you.'
      using errcode = '42501';
  end if;

  if not f.is_active then
    raise exception
      'That float till is not active, so it cannot be replenished.'
      using errcode = 'P0001';
  end if;

  if p_amount is null or p_amount <= 0 then
    raise exception
      'A float replenishment must be a positive number of shillings.'
      using errcode = 'P0001';
  end if;

  -- Refuses an agency float account, a mobile money wallet, an account of
  -- another branch, and anything that is not cash at all.
  perform public.assert_agency_settlement_account(
    p_funding_account_id, f.branch_id, 'funding account');

  v_ledger := f.ledger_account_id;

  -- Provider lock first, then accounts. See 20261110000100's header.
  perform public.lock_agency_provider_balance(f.provider_id, f.branch_id);
  perform public.lock_ledger_balances(array[v_ledger, p_funding_account_id]);

  -- The funding has to be there. Reads after the lock.
  perform public.assert_cash_available(p_funding_account_id, p_amount);

  v_date := coalesce(p_replenishment_date, public.business_date());
  select p.full_name into v_label from public.profiles p where p.id = v_actor;

  begin
    insert into public.agency_float_replenishments
      (provider_id, branch_id, float_account_id, funding_account_id,
       replenishment_date, amount, provider_reference, created_by)
    values
      (f.provider_id, f.branch_id, p_float_account_id, p_funding_account_id,
       v_date, p_amount,
       nullif(pg_catalog.btrim(coalesce(p_reference, '')), ''), v_actor)
    returning id into v_id;
  exception when unique_violation then
    raise exception
      'A replenishment of that float till already records reference %.',
      p_reference
      using errcode = 'P0001';
  end;

  v_entry := public.post_journal(
    f.branch_id,
    v_date,
    f.provider_name || ' float replenishment'
      || coalesce(' — ' || nullif(pg_catalog.btrim(coalesce(p_reference, '')), ''), ''),
    'agency_float_replenishment', v_id, null, null,
    pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'account_id', v_ledger,
        'debit', p_amount, 'credit', 0,
        'memo', 'Float topped up'),
      pg_catalog.jsonb_build_object(
        'account_id', p_funding_account_id,
        'debit', 0, 'credit', p_amount,
        'memo', 'Funding transferred')),
    pg_catalog.now(), v_actor, coalesce(v_label, 'system')
  );

  update public.agency_float_replenishments
     set journal_entry_id = v_entry
   where id = v_id;

  perform public.record_audit_event(
    'agency.float_replenished',
    'agency_float_replenishment',
    v_id::text,
    null,
    pg_catalog.jsonb_build_object(
      'provider_id', f.provider_id,
      'branch_id', f.branch_id,
      'float_account_id', p_float_account_id,
      'funding_account_id', p_funding_account_id,
      'amount', p_amount,
      'reference', p_reference,
      'journal_entry_id', v_entry)
  );

  return v_id;
end;
$$;

comment on function public.post_float_replenishment(uuid, bigint, uuid, text, date) is
  'Phase 4C. Tops up one provider float till from an approved funding account: Dr the till''s 1320-series account, Cr the funding account. Requires agency:settlements. The till identifies the provider and branch, so neither is a caller assertion and a provider''s several tills stay independent. Refuses a till the caller''s branch cannot see with 42501, an inactive till, a non-positive amount, a funding account that is not the branch''s own cash at hand or bank — which excludes agency float and the mobile money repayment wallets — insufficient funding, and a duplicate provider reference. Resolves the deferred decision in architecture section 6.10 without touching record_transfer().';

revoke all on function public.post_float_replenishment(uuid, bigint, uuid, text, date)
  from public, anon;
grant execute on function public.post_float_replenishment(uuid, bigint, uuid, text, date)
  to authenticated;
