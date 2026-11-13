-- ===========================================================================
-- Polytos Phase 4E — the idempotency key answers after the branch, not before
--
-- ## What independent review found
--
-- `20261115001500` made the operating branch explicit and validated, and put
-- that check where the old fallback had been: after the idempotency lookup.
--
-- The lookup returns early. Given a key it already holds, it checked that the
-- caller could *see* that transaction's branch, compared the amount, the
-- customer, the reference, the float account and the fee mode, and returned
-- the id. The branch the caller had just asked for was not in that
-- comparison and had not yet been resolved. So:
--
--   * a Head Office officer retrying key K while naming a **different
--     branch** was handed the first transaction and told it was theirs;
--   * one retrying key K with **no branch at all** was answered rather than
--     asked to choose — the mandatory rule, silently not applied;
--   * a **branch cashier** retrying key K against another branch got an id
--     instead of a refusal.
--
-- Nothing double-posted. The key did its job: one transaction, one journal.
-- What was wrong was the answer — "yes, recorded" for a transaction recorded
-- somewhere else.
--
-- ## The correction
--
-- Two changes, and nothing else:
--
--   1. the branch block moves to the top of the function, before the key is
--      consulted. A refusal about the branch now happens whether or not a key
--      is in hand;
--   2. `v_existing.branch_id is distinct from v_branch` joins the comparison
--      that decides whether a key describes a different transaction. It does,
--      so the retry is refused with the message that already exists for that
--      case — "reload the counter and record this one again; nothing has been
--      written for it."
--
-- A genuine retry — the same submission, the same branch — is answered
-- exactly as before. The posting rules, the commission engine, maker-checker,
-- the revision check, the locks, RLS and the audit trail are untouched, and
-- the signature does not change, so no caller needs editing.
-- ===========================================================================


drop function if exists public.create_agency_transaction(
  uuid, bigint, uuid, text, text, text, bigint, bigint, text, date, text, text, timestamptz, uuid);

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
  -- This runs before everything else the function does, which is the point.
  --
  -- It was placed after the idempotency lookup, and independent review found
  -- what that cost: the key was answered before the branch existed. A Head
  -- Office officer retrying a key while naming a different branch was handed
  -- the first transaction and told it was theirs; one retrying with no branch
  -- at all was answered instead of asked, so the mandatory rule above went
  -- quietly missing; and a branch cashier naming somebody else's branch got
  -- an id rather than a refusal. Nothing double-posted — that is what the key
  -- is for and it held — but "yes, recorded" was the wrong answer.
  --
  -- Being first also means it holds for Agent Banking, where a water bill is
  -- collected into 2290 and no till is involved, exactly as it does for a
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
         -- The branch the caller has just named, resolved above. A retry that
         -- moves the transaction to another branch is not a retry, and
         -- returning the first one would tell the officer their money is
         -- somewhere it is not.
         or v_existing.branch_id         is distinct from v_branch
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
  'Phase 4A, hardened in 4B-S and 4D-F, extended in 4E and corrected twice in 4E. Records a draft agency transaction at a named operating branch: mandatory for an officer whose profile carries no branch, fixed to their own branch for one that does, validated against what the officer may see, and required to be open. There is no fallback — a branch is never substituted. The branch is resolved before the idempotency key is consulted and is part of what makes a key describe a different transaction, so a retry naming another branch is refused rather than answered with the first one. A deposit may not carry a fee mode, and a fee mode may not arrive without a fee.';

revoke all on function public.create_agency_transaction(
  uuid, bigint, uuid, text, text, text, bigint, bigint, text, date, text, text, timestamptz, uuid)
  from public, anon, authenticated;
grant execute on function public.create_agency_transaction(
  uuid, bigint, uuid, text, text, text, bigint, bigint, text, date, text, text, timestamptz, uuid)
  to authenticated;
