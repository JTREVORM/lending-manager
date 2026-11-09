-- ===========================================================================
-- Phase 4D-F — a reused key must describe the same transaction.
--
-- `create_agency_transaction` is idempotent on the caller's key: ask twice,
-- get the first transaction. That is the right answer to "did my submission
-- arrive?" and the wrong answer to everything else, because the function
-- never looked at what the second call actually said.
--
-- Reproduced before this migration existed: a secretary records one
-- customer, then types the next customer's details into the same open form
-- and presses Record. The form minted one key per mounted page, so the second
-- submission carried the first one's key. The database returned the first
-- transaction's id, the interface reported success, and the second
-- customer's money was never recorded at all.
--
-- The interface's half of that defect is fixed in `record-form.tsx`: a
-- confirmed success mints a new key, and only an unresolved submission keeps
-- the old one. This is the database's half, and it is the half that matters,
-- because the application is not the only thing that can call this function
-- and "the client will send the right key" is not a guarantee.
--
-- ## What counts as the same transaction
--
-- The money and who it is for: the service, the amount, the fee, any
-- supplied commission, the till it comes out of, the customer's identifier
-- and the provider's reference. Those are the fields a second officer
-- verifies and the fields that reach the journal.
--
-- Deliberately not compared:
--
--   * the customer's name and the description, which are labels on the same
--     transaction - a retry that corrected a spelling is still that retry;
--   * the transaction date when the caller passed none, because the default
--     is today and a retry either side of midnight would otherwise be
--     refused for a difference the caller never expressed.
--
-- A refusal names neither the other transaction nor its figures: the key may
-- belong to a branch the caller can see, but the caller has still asked for
-- something that did not happen, and the answer is to look at what did.
-- ===========================================================================

create or replace function public.create_agency_transaction(
  p_transaction_type_id uuid,
  p_principal_amount    bigint,
  p_float_account_id    uuid    default null,
  p_customer_identifier text    default null,
  p_customer_name       text    default null,
  p_provider_reference  text    default null,
  p_customer_fee        bigint  default 0,
  p_commission_supplied bigint  default null,
  p_description         text    default null,
  p_transaction_date    date    default null,
  p_idempotency_key     text    default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor    uuid;
  v_existing public.agency_transactions;
  v_pr       public.agency_service_providers;
  v_ty       public.agency_transaction_types;
  v_branch   uuid;
  v_payable  uuid;
  v_id       uuid;
begin
  v_actor := public.agency_actor('agency:write');

  -- Phase 4B-S. The idempotency lookup used to return whatever transaction
  -- held the key, whoever asked. Reproduced: a branch-A secretary supplying a
  -- branch-B key was handed branch B's transaction UUID — the one identifier
  -- every other function then accepted. The key is global by design (Phase
  -- 4A's unique index), so the lookup has to decide what to do about a key
  -- from somewhere else, and returning it was the wrong answer.
  --
  -- A genuine retry from the branch that owns the key still gets its own
  -- transaction back. A key held elsewhere is refused without naming it.
  --
  -- Phase 4D-F. And a key held by *this* branch is refused too when the call
  -- describes a different transaction. See this migration's header.
  if p_idempotency_key is not null then
    select * into v_existing
      from public.agency_transactions
     where idempotency_key = p_idempotency_key;

    if v_existing.id is not null then
      if not public.user_can_see_branch(v_existing.branch_id) then
        raise exception
          'That idempotency key is already in use and is not available to you.'
          using errcode = '42501';
      end if;

      if v_existing.transaction_type_id is distinct from p_transaction_type_id
         or v_existing.principal_amount  is distinct from p_principal_amount
         or v_existing.customer_fee      is distinct from coalesce(p_customer_fee, 0)
         or v_existing.commission_supplied is distinct from p_commission_supplied
         -- Only where the provider keeps a till. For a cash-payable provider
         -- the stored column is null whatever the caller passed, so comparing
         -- it would refuse a retry that repeated its own argument.
         or (v_existing.float_account_id is not null
             and v_existing.float_account_id is distinct from p_float_account_id)
         or v_existing.customer_identifier is distinct from
              nullif(pg_catalog.btrim(coalesce(p_customer_identifier, '')), '')
         or v_existing.provider_reference is distinct from
              nullif(pg_catalog.btrim(coalesce(p_provider_reference, '')), '')
         or (p_transaction_date is not null
             and v_existing.transaction_date is distinct from p_transaction_date) then
        raise exception
          'That submission key was already recorded for a different transaction. Reload the counter and record this one again; nothing has been written for it.'
          using errcode = 'P0001';
      end if;

      return v_existing.id;
    end if;
  end if;

  select * into v_ty from public.agency_transaction_types where id = p_transaction_type_id;
  if v_ty.id is null then
    raise exception 'No such agency transaction type.' using errcode = 'P0001';
  end if;

  select * into v_pr from public.agency_service_providers where id = v_ty.provider_id;

  -- The branch is the officer's own. It is never an argument: that is what
  -- stops one branch recording against another's till, before RLS or the
  -- till guard are even reached.
  select p.branch_id into v_branch from public.profiles p where p.id = v_actor;
  if v_branch is null then
    select b.id into v_branch from public.branches b
     where b.status = 'active' order by b.branch_code limit 1;
  end if;

  if v_pr.float_model = 'provider_float' then
    if p_float_account_id is null then
      raise exception
        '% is settled from electronic float, so a till must be named.', v_pr.name
        using errcode = 'P0001';
    end if;
  else
    v_payable := v_pr.payable_account_id;
  end if;

  if v_ty.requires_meter_number and pg_catalog.btrim(coalesce(p_customer_identifier, '')) = '' then
    raise exception '% needs the customer''s meter number.', v_ty.name using errcode = 'P0001';
  end if;
  if v_ty.requires_account_number and pg_catalog.btrim(coalesce(p_customer_identifier, '')) = '' then
    raise exception '% needs the customer''s account number.', v_ty.name using errcode = 'P0001';
  end if;
  if v_ty.requires_customer_name and pg_catalog.btrim(coalesce(p_customer_name, '')) = '' then
    raise exception '% needs the customer''s name.', v_ty.name using errcode = 'P0001';
  end if;

  insert into public.agency_transactions
    (branch_id, provider_id, transaction_type_id,
     float_account_id, payable_account_id, status,
     principal_amount, customer_fee, commission_supplied,
     provider_reference, customer_identifier, customer_name, description,
     transaction_date, submitted_by, idempotency_key)
  values
    (v_branch, v_pr.id, v_ty.id,
     case when v_pr.float_model = 'provider_float' then p_float_account_id end,
     v_payable, 'draft',
     p_principal_amount, coalesce(p_customer_fee, 0), p_commission_supplied,
     nullif(pg_catalog.btrim(coalesce(p_provider_reference, '')), ''),
     nullif(pg_catalog.btrim(coalesce(p_customer_identifier, '')), ''),
     nullif(pg_catalog.btrim(coalesce(p_customer_name, '')), ''),
     nullif(pg_catalog.btrim(coalesce(p_description, '')), ''),
     coalesce(p_transaction_date, public.business_date()),
     v_actor, p_idempotency_key)
  returning id into v_id;

  insert into public.agency_transaction_audit_log (transaction_id, action, actor_id, new_value)
  values (v_id, 'submit', v_actor,
          pg_catalog.jsonb_build_object('status', 'draft',
                                        'principal_amount', p_principal_amount));

  return v_id;
end;
$$;

comment on function public.create_agency_transaction(uuid, bigint, uuid, text, text, text, bigint, bigint, text, date, text) is
  'Phase 4B, extended in Phase 4D-F. Records a draft agency transaction. The branch is the officer''s own and never an argument, so one branch cannot record against another''s till. Requires agency:write. Idempotent on the caller''s key for the same submission, and refuses a key already recorded for a different one rather than returning the earlier transaction as though this one had succeeded.';
