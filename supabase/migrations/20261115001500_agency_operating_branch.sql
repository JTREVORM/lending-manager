-- ===========================================================================
-- Polytos Phase 4E — the operating branch, named rather than guessed
--
-- ## What was wrong
--
-- `create_agency_transaction()` stamped a transaction with the recording
-- officer's branch, and for an officer whose profile carries none it fell
-- through to the **alphabetically first active branch**:
--
--     select b.id into v_branch from public.branches b
--      where b.status = 'active' order by b.branch_code limit 1;
--
-- Head Office is exactly that officer: the Owner and the Secretary both have
-- `profiles.branch_id` null. With one branch the fallback was correct by
-- accident. The Phase 4E browser suite opened a second branch — the first
-- time this system has had two — and five counter tests failed at once with
-- "That till belongs to a different branch", because the transaction had been
-- routed to a branch chosen by a string comparison.
--
-- In a real business that is worse than a refusal. Open a branch whose code
-- sorts before the first one and every head-office officer's agency
-- transactions move to it, silently, and they can post against no other
-- branch's till.
--
-- ## What this migration does
--
-- Removes the fallback and replaces it with the approved rule: a branch-less
-- officer names the operating branch, a branch-assigned officer records at
-- their own and may name no other, the branch is validated against what the
-- officer may see, and it must be open. It applies to Agent Banking and
-- Mobile Money alike, because it runs before the function looks at whether
-- the provider keeps float or a payable.
--
-- Nothing else changes. The posting rules, the commission engine, the
-- idempotency guard, maker-checker, the revision check, the locks and the
-- audit trail are the same code they were; the only new behaviour is which
-- branch the transaction is recorded at, and that it is refused rather than
-- guessed.
--
-- ## Why the signature changes rather than the body alone
--
-- The branch has to be an argument now, and a defaulted parameter added to an
-- existing function creates an overload rather than replacing it — PostgreSQL
-- would then refuse every call as ambiguous. So the old signature is dropped
-- and the new one created, as `20261115000500` did for the fee mode.
--
-- `p_branch_id` goes last, which keeps every existing positional call valid:
-- a branch-assigned cashier's call is unchanged, because their branch is
-- still their own.
-- ===========================================================================


drop function if exists public.create_agency_transaction(
  uuid, bigint, uuid, text, text, text, bigint, bigint, text, date, text, text, timestamptz);

create or replace function public.create_agency_transaction(
  p_transaction_type_id uuid,
  p_principal_amount    bigint,
  p_float_account_id    uuid        default null,
  p_customer_identifier text        default null,
  p_customer_name       text        default null,
  p_provider_reference  text        default null,
  p_customer_fee        bigint      default 0,
  p_commission_supplied bigint      default null,
  p_description         text        default null,
  p_transaction_date    date        default null,
  p_idempotency_key     text        default null,
  p_customer_fee_mode   text        default null,
  p_transacted_at       timestamptz default null,
  -- The branch this transaction is being recorded at. Mandatory for an
  -- officer whose profile carries no branch; for one whose profile does, it
  -- may be omitted or may name their own branch and nothing else.
  p_branch_id           uuid        default null
)
returns uuid
language plpgsql
volatile
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
  v_mode     text;
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
  -- describes a different transaction.
  --
  -- Phase 4E. The fee mode joins that comparison: a withdrawal whose fee is
  -- collected separately is a different transaction from one whose fee is
  -- deducted, and a retry that changes it is not a retry.
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
         or (p_customer_fee_mode is not null
             and v_existing.customer_fee_mode is distinct from p_customer_fee_mode)
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

  -- The operating branch.
  --
  -- Phase 4B set this from the officer's own profile and, for an officer with
  -- no branch, fell back to `order by branch_code limit 1` — the
  -- alphabetically first active branch. With one branch that was right by
  -- accident. With two it is wrong in a way nothing announces: a Head Office
  -- cashier naming a Head Office till was refused with "That till belongs to
  -- a different branch", because the transaction had been stamped with
  -- whichever branch sorted first by code.
  --
  -- The approved rule, and what each line of it is for:
  --
  --   * an officer with no branch of their own — Head Office, which is both
  --     the Owner and the Secretary on the seeded book — **names** the branch.
  --     There is no default. A transaction recorded at the wrong branch takes
  --     cash out of the wrong drawer and reports in the wrong place, and
  --     neither is visible at the counter;
  --   * an officer who has a branch records at it. They may pass it, which is
  --     what the form does, and passing a different one is refused rather
  --     than quietly ignored — a refusal is a fact the officer can act on;
  --   * the branch is checked against what the officer may actually see,
  --     through the same helper every policy uses, so this cannot become a
  --     way round branch isolation;
  --   * and the branch must be open. Recording at a closed branch would post
  --     to a drawer nobody is counting.
  --
  -- This runs before the float-or-payable split below, so it holds for Agent
  -- Banking — a water bill collected into 2290 — exactly as it does for a
  -- Mobile Money transaction settled from electronic float.
  select p.branch_id into v_branch from public.profiles p where p.id = v_actor;

  if v_branch is null then
    if p_branch_id is null then
      raise exception
        'Choose the branch this transaction is being recorded at. Your account is not assigned to one, so the branch cannot be assumed.'
        using errcode = 'P0001';
    end if;
    v_branch := p_branch_id;
  elsif p_branch_id is not null and p_branch_id <> v_branch then
    raise exception
      'You may only record transactions at your own branch.'
      using errcode = 'P0001';
  end if;

  if not public.user_can_see_branch(v_branch) then
    raise exception 'You do not have access to that branch.' using errcode = '42501';
  end if;

  if not exists (select 1 from public.branches b
                  where b.id = v_branch and b.status = 'active') then
    raise exception 'That branch is not open for business.' using errcode = 'P0001';
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

  -- Phase 4E, decision OD-5. A deposit's fee is always paid over and above
  -- the amount deposited, so there is no mode to choose; offering one would
  -- be a control with no effect.
  v_mode := nullif(pg_catalog.btrim(coalesce(p_customer_fee_mode, '')), '');

  if v_mode is not null and v_ty.direction in ('deposit', 'payment') then
    raise exception
      'A % fee is always collected on top of the amount, so it has no deduction mode.',
      v_ty.direction
      using errcode = 'P0001';
  end if;

  if v_mode is not null and coalesce(p_customer_fee, 0) = 0 then
    raise exception
      'A fee mode was given with no fee to apply it to.'
      using errcode = 'P0001';
  end if;

  insert into public.agency_transactions
    (branch_id, provider_id, transaction_type_id,
     float_account_id, payable_account_id, status,
     principal_amount, customer_fee, customer_fee_mode, commission_supplied,
     provider_reference, customer_identifier, customer_name, description,
     transaction_date, transacted_at, submitted_by, idempotency_key)
  values
    (v_branch, v_pr.id, v_ty.id,
     case when v_pr.float_model = 'provider_float' then p_float_account_id end,
     v_payable, 'draft',
     p_principal_amount, coalesce(p_customer_fee, 0), v_mode, p_commission_supplied,
     nullif(pg_catalog.btrim(coalesce(p_provider_reference, '')), ''),
     nullif(pg_catalog.btrim(coalesce(p_customer_identifier, '')), ''),
     nullif(pg_catalog.btrim(coalesce(p_customer_name, '')), ''),
     nullif(pg_catalog.btrim(coalesce(p_description, '')), ''),
     coalesce(p_transaction_date, public.business_date()),
     p_transacted_at,
     v_actor, p_idempotency_key)
  returning id into v_id;

  insert into public.agency_transaction_audit_log (transaction_id, action, actor_id, new_value)
  values (v_id, 'submit', v_actor,
          pg_catalog.jsonb_build_object('status', 'draft',
                                        'principal_amount', p_principal_amount));

  return v_id;
end;
$$;

comment on function public.create_agency_transaction(
  uuid, bigint, uuid, text, text, text, bigint, bigint, text, date, text, text, timestamptz, uuid) is
  'Phase 4A, hardened in 4B-S and 4D-F, extended in 4E and corrected in 4E. Records a draft agency transaction at a named operating branch: mandatory for an officer whose profile carries no branch, fixed to their own branch for one that does, validated against what the officer may see, and required to be open. There is no fallback — a branch is never substituted. The idempotency key is honoured for a genuine retry and refused when the same key describes different details, the fee mode included. A deposit may not carry a fee mode, and a fee mode may not arrive without a fee.';

revoke all on function public.create_agency_transaction(
  uuid, bigint, uuid, text, text, text, bigint, bigint, text, date, text, text, timestamptz, uuid)
  from public, anon, authenticated;
grant execute on function public.create_agency_transaction(
  uuid, bigint, uuid, text, text, text, bigint, bigint, text, date, text, text, timestamptz, uuid)
  to authenticated;


-- ---------------------------------------------------------------------------
-- Rule 4, which needed no change
--
-- A Mobile Money transaction's agent line must belong to the operating
-- branch. `agency_transaction_guard()` already refuses otherwise — "That till
-- belongs to a different branch" — and that check is Phase 4B's and correct;
-- what was wrong was the branch it was comparing against, which is what this
-- migration fixes. The guard is left exactly as it is, and the recording
-- screen now offers only the tills of the branch the officer has chosen, so
-- the refusal is reached by a mistake rather than by the system's own
-- arithmetic.
-- ---------------------------------------------------------------------------
