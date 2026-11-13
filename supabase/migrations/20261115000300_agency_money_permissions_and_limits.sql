-- ===========================================================================
-- Phase 4E — who may trade float, and who sets a service's ceiling
--
-- ## `agency:float_trade` (decision OD-7)
--
-- OD-7: "Cashiers may record purchases, sales and transfers. A different
-- Manager or Owner/Admin must verify before posting. Pending transactions must
-- not affect financial balances."
--
-- That is the same maker-checker shape the transaction engine already has, and
-- it needs a *recording* capability distinct from the *posting* one. Today
-- `agency:settlements` does both for a float replenishment: a Manager records
-- and the ledger moves in the same call. Giving cashiers `agency:settlements`
-- to satisfy OD-7 would hand them payable remittances and commission
-- settlements as well, and would let one person post float with no second
-- pair of eyes.
--
-- So: `agency:float_trade` records a pending trade and moves nothing.
-- `agency:settlements` verifies it, which is what posts it. The separation of
-- duties is enforced at the data layer by a maker ≠ checker constraint on each
-- trade table, exactly as `agency_transactions_verifier_not_submitter` does
-- for a transaction — not by hiding a button.
--
-- Granted to `secretary_treasurer`, `manager` and `owner_admin`. A Manager who
-- records a trade still cannot verify it; a different Manager or the Owner
-- must.
--
-- ## `agency:commission_payout`
--
-- Deliberately *not* a new capability. A commission payout is a settlement
-- against 1310 — the same act `record_commission_settlement()` performs, with
-- a different destination — so it stays on `agency:settlements`. A new key
-- would split one duty across two grants and give an administrator two places
-- to get it wrong.
--
-- ## Service ceilings (decision OD-11)
--
-- OD-11: "Owner/Admin configures a maximum separately for each provider and
-- service. No hardcoded limits. Provider activation requires an approved
-- ceiling."
--
-- `agency_transaction_types.max_single_transaction` is already per provider
-- and per service — a type belongs to one provider — and the live-readiness
-- guard already refuses to post a type that states no ceiling. What has never
-- existed is a way for the Owner to set one: the column was only ever written
-- by a migration or a seed. `set_agency_service_limit()` is that way, and it
-- is the only one, which is why it is audited.
--
-- `requires_approval_above` is deliberately **not** settable here. Decision L
-- — whether a threshold gates verification, at what figure, and whose
-- approval it needs — is still open, and the column remains stored, read by
-- nothing and shown struck through. A setter would imply a control that does
-- not exist.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- 1. The capability
-- ---------------------------------------------------------------------------

insert into public.permissions (key, description)
values
  ('agency:float_trade',
   'Record a float purchase, sale or line-to-line transfer as a pending trade. Moves no money: posting requires verification by a different holder of agency:settlements (decision OD-7).')
on conflict (key) do nothing;

insert into public.role_permissions (role_key, permission_key)
values
  ('secretary_treasurer', 'agency:float_trade'),
  ('manager',             'agency:float_trade'),
  ('owner_admin',         'agency:float_trade')
on conflict (role_key, permission_key) do nothing;


-- ---------------------------------------------------------------------------
-- 2. Setting a service's ceiling
--
-- Returns the type id so a caller can chain, and raises rather than returning
-- a status: a ceiling that silently failed to change is the worst outcome
-- here, because the readiness gate would then still refuse every posting and
-- the Owner would have been told it was done.
-- ---------------------------------------------------------------------------

create or replace function public.set_agency_service_limit(
  p_transaction_type_id   uuid,
  p_max_single_transaction bigint,
  p_reason                text default null
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_type     record;
  v_provider record;
  v_old      bigint;
begin
  if auth.uid() is not null
     and not (select public.user_has_permission('agency:providers')) then
    raise exception
      'Not authorized to configure agency service limits.'
      using errcode = '42501';
  end if;

  select t.id, t.code, t.name, t.provider_id, t.max_single_transaction
    into v_type
  from public.agency_transaction_types t
  where t.id = p_transaction_type_id;

  if v_type.id is null then
    raise exception 'No such agency service type.' using errcode = 'P0001';
  end if;

  select pr.id, pr.code, pr.name into v_provider
  from public.agency_service_providers pr
  where pr.id = v_type.provider_id;

  -- A ceiling of zero is not "no limit", it is "nothing may be transacted",
  -- and NULL already means nobody decided. Both are refused so that the only
  -- way to express a limit is to state one.
  if p_max_single_transaction is null or p_max_single_transaction <= 0 then
    raise exception
      'A service ceiling must be a positive amount. NULL means nobody has decided, which is what % %''s ceiling already says.',
      v_provider.name, v_type.name
      using errcode = 'P0001';
  end if;

  v_old := v_type.max_single_transaction;

  update public.agency_transaction_types
     set max_single_transaction = p_max_single_transaction,
         updated_at             = now()
   where id = p_transaction_type_id;

  -- The configuration audit trigger from 20261115000200 records the before and
  -- after values. This adds the Owner's stated reason, which the row itself
  -- cannot carry.
  perform public.record_audit_event(
    'agency_service_type.limit_set',
    'agency_service_type',
    p_transaction_type_id::text,
    pg_catalog.jsonb_build_object('max_single_transaction', v_old),
    pg_catalog.jsonb_build_object('max_single_transaction', p_max_single_transaction),
    pg_catalog.jsonb_build_object(
      'provider_code', v_provider.code,
      'service_code',  v_type.code,
      'reason',        nullif(pg_catalog.btrim(coalesce(p_reason, '')), '')),
    null);

  return p_transaction_type_id;
end;
$$;

comment on function public.set_agency_service_limit(uuid, bigint, text) is
  'Phase 4E, decision OD-11. Sets one service''s maximum single transaction, per provider and per service, with the Owner''s reason in the audit trail. Refuses NULL and zero: the live-readiness guard treats an unstated ceiling as a reason not to post, and this function exists to state one. Does not touch requires_approval_above, which decision L leaves unenforced.';

revoke all on function public.set_agency_service_limit(uuid, bigint, text)
  from public, anon, authenticated;
grant execute on function public.set_agency_service_limit(uuid, bigint, text)
  to authenticated;
