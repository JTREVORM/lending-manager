-- ===========================================================================
-- Phase 4B — the transaction lifecycle
--
-- Specification: `docs/AGENCY-BANKING-ARCHITECTURE.md` v3.0 §7, §8.
--
--   draft ──submit──► awaiting_verification ──verify──► posted ──reverse──► reversed
--     │                        │
--     └──cancel──► cancelled   └──return──► draft
--
-- `return_agency_transaction()` is not in the specification. It is required
-- here because §7 offers a verifier exactly two moves — post it, or nothing —
-- so a transaction with a mistyped meter number could only be posted and
-- reversed, which puts two journal entries in the books to fix a typo that
-- never moved money. Returning it to draft moves no money and releases the
-- provider reference, because a draft does not claim one.
--
-- ## Every transition is one statement under one lock
--
-- Each function takes `for update` on the row before reading its status, so a
-- second caller waits and then sees the state the first committed. The status
-- change and everything that depends on it — the journal, the snapshot, the
-- audit row — are in the same transaction, so there is no reachable state in
-- which a transaction is posted and its journal is not, or vice versa.
--
-- ## Capability refusals raise 42501
--
-- Not `P0001`. New code is on the correct side of finding F1 from the outset:
-- see `docs/POLYTOS-F1-AUTHORIZATION-ERROR-CLASSIFICATION.md` §5. Business
-- refusals — wrong state, insufficient float, a duplicate reference — stay
-- `P0001`, because they are not about who is asking.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- A shared identity check
--
-- Every mutation needs the acting profile, and a session that cannot be
-- attributed must not move money. This mirrors the control Phase 3 found on
-- loan disbursement (finding F3): the officer is taken from the session, not
-- from an argument, so it cannot be claimed.
-- ---------------------------------------------------------------------------

create or replace function public.agency_actor(p_capability text)
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_actor uuid;
begin
  v_actor := public.current_profile_id();

  if v_actor is null then
    raise exception
      'An agency transaction cannot be recorded by an unidentified session.'
      using errcode = '42501';
  end if;

  if auth.uid() is not null and not public.user_has_permission(p_capability) then
    raise exception 'This action requires the % capability.', p_capability
      using errcode = '42501';
  end if;

  return v_actor;
end;
$$;

comment on function public.agency_actor(text) is
  'Phase 4B. The acting profile for an agency mutation, refusing an unattributable session and a caller without the named capability. Raises 42501 for both, which is what an authorization refusal should carry.';

revoke all on function public.agency_actor(text) from public, anon, authenticated;


-- ---------------------------------------------------------------------------
-- Branch authorization, for a transaction named by its identifier
--
-- Phase 4B-S. This closes a reproduced vulnerability, and the reason it
-- existed is worth stating plainly: `agency_actor()` answers "who is this and
-- may they do this kind of thing", and nothing answered "may they do it to
-- *this* record". Every lifecycle function then loaded its target by UUID.
--
-- `agency_transactions` has a branch-isolating SELECT policy, so a branch's
-- staff cannot *read* another branch's transaction. But these functions are
-- SECURITY DEFINER: inside them the policies do not apply, because the owner
-- is exempt. So the table was protected and the writers were not — a confused
-- deputy. Measured before the fix, a branch-A manager could update, submit,
-- return, verify, cancel, reverse and correct a branch-B transaction: seven of
-- seven, including the two that move money.
--
-- The refusal is deliberately **uniform and non-disclosing**. A transaction
-- that does not exist and one that belongs to another branch produce exactly
-- the same message and the same SQLSTATE, so the caller cannot use the
-- difference to discover which identifiers are real. That is why this does not
-- keep the old "No such agency transaction" wording for the not-found case.
--
-- Head Office keeps the policy it has everywhere else: `user_can_see_branch()`
-- is true for every branch when the profile carries no branch, so an owner
-- without one acts across branches exactly as they do in every other module.
-- ---------------------------------------------------------------------------

create or replace function public.agency_locked_transaction(p_transaction_id uuid)
returns public.agency_transactions
language plpgsql
security definer
set search_path = ''
as $$
declare
  t public.agency_transactions;
begin
  -- Locked before the branch is read, so a concurrent writer cannot change the
  -- branch between the check and the caller's use of the row.
  select * into t from public.agency_transactions
   where id = p_transaction_id for update;

  if t.id is null or not public.user_can_see_branch(t.branch_id) then
    raise exception
      'No agency transaction with that identifier is available to you.'
      using errcode = '42501';
  end if;

  return t;
end;
$$;

comment on function public.agency_locked_transaction(uuid) is
  'Phase 4B-S. Locks one agency transaction and refuses it unless the caller''s branch may see it. The refusal is identical for a transaction that does not exist and one belonging to another branch, so the difference discloses nothing. Every lifecycle function loads its target through this; the SELECT policy cannot protect a SECURITY DEFINER write.';

revoke all on function public.agency_locked_transaction(uuid)
  from public, anon, authenticated;


-- ---------------------------------------------------------------------------
-- 1. Create a draft
--
-- `p_idempotency_key` is the caller's protection against a double tap: a
-- second call with the same key returns the first transaction instead of
-- creating a twin. Phase 4A's unique index makes the race safe; this makes
-- the retry quiet.
-- ---------------------------------------------------------------------------

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
  v_existing uuid;
  v_existing_branch uuid;
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
  if p_idempotency_key is not null then
    select id, branch_id into v_existing, v_existing_branch
      from public.agency_transactions
     where idempotency_key = p_idempotency_key;

    if v_existing is not null then
      if public.user_can_see_branch(v_existing_branch) then
        return v_existing;
      end if;
      raise exception
        'That idempotency key is already in use and is not available to you.'
        using errcode = '42501';
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
  'Phase 4B. Records a draft agency transaction. The branch is the officer''s own and never an argument, so one branch cannot record against another''s till. Requires agency:write. Idempotent on the caller''s key.';

revoke all on function public.create_agency_transaction(uuid, bigint, uuid, text, text, text, bigint, bigint, text, date, text) from public, anon;
grant execute on function public.create_agency_transaction(uuid, bigint, uuid, text, text, text, bigint, bigint, text, date, text) to authenticated;


-- ---------------------------------------------------------------------------
-- 2. Edit a draft
--
-- Only a draft, and only by somebody holding `agency:write`. A submitted
-- transaction is somebody else's to look at, so editing it in place would let
-- the maker change what the checker is about to approve.
-- ---------------------------------------------------------------------------

create or replace function public.update_agency_transaction(
  p_transaction_id      uuid,
  p_principal_amount    bigint default null,
  p_customer_identifier text   default null,
  p_customer_name       text   default null,
  p_provider_reference  text   default null,
  p_customer_fee        bigint default null,
  p_commission_supplied bigint default null,
  p_description         text   default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid;
  t       public.agency_transactions;
begin
  v_actor := public.agency_actor('agency:write');

  -- Locks the row and refuses it if the caller's branch may not see it.
  t := public.agency_locked_transaction(p_transaction_id);

  if t.status <> 'draft' then
    raise exception
      'Only a draft can be edited; this one is %. Return it for correction first.', t.status
      using errcode = 'P0001';
  end if;

  update public.agency_transactions
     set principal_amount    = coalesce(p_principal_amount, principal_amount),
         customer_identifier = coalesce(nullif(pg_catalog.btrim(coalesce(p_customer_identifier, '')), ''), customer_identifier),
         customer_name       = coalesce(nullif(pg_catalog.btrim(coalesce(p_customer_name, '')), ''), customer_name),
         provider_reference  = coalesce(nullif(pg_catalog.btrim(coalesce(p_provider_reference, '')), ''), provider_reference),
         customer_fee        = coalesce(p_customer_fee, customer_fee),
         commission_supplied = coalesce(p_commission_supplied, commission_supplied),
         description         = coalesce(nullif(pg_catalog.btrim(coalesce(p_description, '')), ''), description)
   where id = p_transaction_id;

  insert into public.agency_transaction_audit_log
    (transaction_id, action, actor_id, old_value, new_value)
  values (p_transaction_id, 'submit', v_actor,
          pg_catalog.jsonb_build_object('principal_amount', t.principal_amount,
                                        'customer_fee', t.customer_fee),
          pg_catalog.jsonb_build_object('principal_amount',
                                          coalesce(p_principal_amount, t.principal_amount),
                                        'customer_fee',
                                          coalesce(p_customer_fee, t.customer_fee)));
end;
$$;

revoke all on function public.update_agency_transaction(uuid, bigint, text, text, text, bigint, bigint, text) from public, anon;
grant execute on function public.update_agency_transaction(uuid, bigint, text, text, text, bigint, bigint, text) to authenticated;


-- ---------------------------------------------------------------------------
-- 3. Submit for verification
--
-- This is where the provider reference becomes a claim: Phase 4A's partial
-- unique index covers every status but draft and cancelled, so submitting is
-- the moment a duplicate is refused.
-- ---------------------------------------------------------------------------

create or replace function public.submit_agency_transaction(p_transaction_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid;
  t       public.agency_transactions;
  v_pr    public.agency_service_providers;
begin
  v_actor := public.agency_actor('agency:write');

  -- Locks the row and refuses it if the caller's branch may not see it.
  t := public.agency_locked_transaction(p_transaction_id);

  if t.status = 'awaiting_verification' then
    return;                                  -- idempotent: already submitted
  end if;

  if t.status <> 'draft' then
    raise exception 'Only a draft can be submitted; this one is %.', t.status
      using errcode = 'P0001';
  end if;

  select * into v_pr from public.agency_service_providers where id = t.provider_id;

  -- A float transaction must name a reference the provider issued, because
  -- without it nothing ties the booking to the provider's own record of it.
  if v_pr.float_model = 'provider_float'
     and pg_catalog.btrim(coalesce(t.provider_reference, '')) = '' then
    raise exception
      '% issues a transaction reference, and it must be recorded before this is submitted.',
      v_pr.name
      using errcode = 'P0001';
  end if;

  update public.agency_transactions set status = 'awaiting_verification'
   where id = p_transaction_id;

  insert into public.agency_transaction_audit_log
    (transaction_id, action, actor_id, old_value, new_value)
  values (p_transaction_id, 'submit', v_actor,
          pg_catalog.jsonb_build_object('status', 'draft'),
          pg_catalog.jsonb_build_object('status', 'awaiting_verification'));
end;
$$;

revoke all on function public.submit_agency_transaction(uuid) from public, anon;
grant execute on function public.submit_agency_transaction(uuid) to authenticated;


-- ---------------------------------------------------------------------------
-- 4. Return for correction
--
-- The verifier's second move. Needs `agency:verify`, because deciding a
-- transaction is wrong is the same authority as deciding it is right.
-- ---------------------------------------------------------------------------

create or replace function public.return_agency_transaction(
  p_transaction_id uuid,
  p_reason         text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid;
  t       public.agency_transactions;
begin
  v_actor := public.agency_actor('agency:verify');

  if pg_catalog.btrim(coalesce(p_reason, '')) = '' then
    raise exception 'Returning a transaction needs a reason.' using errcode = 'P0001';
  end if;

  -- Locks the row and refuses it if the caller's branch may not see it.
  t := public.agency_locked_transaction(p_transaction_id);

  if t.status <> 'awaiting_verification' then
    raise exception
      'Only a transaction awaiting verification can be returned; this one is %.', t.status
      using errcode = 'P0001';
  end if;

  update public.agency_transactions set status = 'draft' where id = p_transaction_id;

  insert into public.agency_transaction_audit_log
    (transaction_id, action, actor_id, old_value, new_value, reason)
  values (p_transaction_id, 'submit', v_actor,
          pg_catalog.jsonb_build_object('status', 'awaiting_verification'),
          pg_catalog.jsonb_build_object('status', 'draft'), p_reason);
end;
$$;

revoke all on function public.return_agency_transaction(uuid, text) from public, anon;
grant execute on function public.return_agency_transaction(uuid, text) to authenticated;


-- ---------------------------------------------------------------------------
-- 5. Verify, which posts
--
-- The separation of duties is checked here *and* by
-- `agency_transactions_verifier_not_submitter`. The constraint is the one that
-- cannot be forgotten; this one gives the person a sentence they can act on.
-- ---------------------------------------------------------------------------

create or replace function public.verify_agency_transaction(p_transaction_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid;
  t       public.agency_transactions;
  v_entry uuid;
begin
  v_actor := public.agency_actor('agency:verify');

  -- Locks the row and refuses it if the caller's branch may not see it.
  t := public.agency_locked_transaction(p_transaction_id);

  if t.status = 'posted' then
    return t.journal_entry_id;               -- idempotent: already verified
  end if;

  if t.status <> 'awaiting_verification' then
    raise exception
      'Only a transaction awaiting verification can be verified; this one is %.', t.status
      using errcode = 'P0001';
  end if;

  if t.submitted_by = v_actor then
    raise exception
      'A transaction cannot be verified by the person who recorded it.'
      using errcode = '42501';
  end if;

  -- Stamped before posting, because the snapshot CHECK requires a verifier on
  -- any posted row and `post_agency_transaction` is what sets `posted`.
  update public.agency_transactions set verified_by = v_actor where id = p_transaction_id;

  v_entry := public.post_agency_transaction(p_transaction_id);

  insert into public.agency_transaction_audit_log
    (transaction_id, action, actor_id, old_value, new_value)
  values (p_transaction_id, 'verify', v_actor,
          pg_catalog.jsonb_build_object('status', 'awaiting_verification'),
          pg_catalog.jsonb_build_object('status', 'posted', 'journal_entry_id', v_entry));

  insert into public.agency_transaction_audit_log
    (transaction_id, action, actor_id, new_value)
  values (p_transaction_id, 'post', v_actor,
          pg_catalog.jsonb_build_object('journal_entry_id', v_entry));

  return v_entry;
end;
$$;

comment on function public.verify_agency_transaction(uuid) is
  'Phase 4B. Verifies a submitted agency transaction and posts it, in one transaction. Refuses the submitter with 42501, which the verifier_not_submitter CHECK also refuses independently. Idempotent: a retry on a posted transaction returns its journal.';

revoke all on function public.verify_agency_transaction(uuid) from public, anon;
grant execute on function public.verify_agency_transaction(uuid) to authenticated;


-- ---------------------------------------------------------------------------
-- 6. Cancel an unposted transaction
-- ---------------------------------------------------------------------------

create or replace function public.cancel_agency_transaction(
  p_transaction_id uuid,
  p_reason         text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid;
  t       public.agency_transactions;
begin
  v_actor := public.agency_actor('agency:write');

  -- Locks the row and refuses it if the caller's branch may not see it.
  t := public.agency_locked_transaction(p_transaction_id);

  if t.status = 'cancelled' then
    return;                                  -- idempotent
  end if;

  if t.status not in ('draft', 'awaiting_verification') then
    raise exception
      'Only an unposted transaction can be cancelled; this one is %. A posted transaction is reversed.',
      t.status
      using errcode = 'P0001';
  end if;

  -- A draft is the recorder's own to abandon. Cancelling somebody else's
  -- submitted transaction is the verifier's decision, so it needs that
  -- authority rather than merely `agency:write`.
  if t.status = 'awaiting_verification'
     and t.submitted_by <> v_actor
     and not public.user_has_permission('agency:verify') then
    raise exception
      'Cancelling a transaction somebody else submitted requires the agency:verify capability.'
      using errcode = '42501';
  end if;

  update public.agency_transactions set status = 'cancelled' where id = p_transaction_id;

  insert into public.agency_transaction_audit_log
    (transaction_id, action, actor_id, old_value, new_value, reason)
  values (p_transaction_id, 'cancel', v_actor,
          pg_catalog.jsonb_build_object('status', t.status),
          pg_catalog.jsonb_build_object('status', 'cancelled'), p_reason);
end;
$$;

revoke all on function public.cancel_agency_transaction(uuid, text) from public, anon;
grant execute on function public.cancel_agency_transaction(uuid, text) to authenticated;


-- ---------------------------------------------------------------------------
-- 7. Correct a provider reference, with no financial movement
--
-- Correction C6 keeps this apart from reversal on purpose: a mistyped MTN
-- reference is a metadata error, and posting two journal entries to fix it
-- would put a correction in the books where there was no financial mistake.
-- ---------------------------------------------------------------------------

create or replace function public.update_agency_transaction_reference(
  p_transaction_id uuid,
  p_new_reference  text,
  p_reason         text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid;
  t       public.agency_transactions;
  v_new   text := nullif(pg_catalog.btrim(coalesce(p_new_reference, '')), '');
begin
  v_actor := public.agency_actor('agency:correct');

  if pg_catalog.btrim(coalesce(p_reason, '')) = '' then
    raise exception 'Correcting a reference needs a reason.' using errcode = 'P0001';
  end if;

  if v_new is null then
    raise exception 'A corrected reference cannot be blank.' using errcode = 'P0001';
  end if;

  -- Locks the row and refuses it if the caller's branch may not see it.
  t := public.agency_locked_transaction(p_transaction_id);

  if t.status <> 'posted' then
    raise exception
      'Only a posted transaction''s reference is corrected here; this one is %.', t.status
      using errcode = 'P0001';
  end if;

  if t.provider_reference = v_new then
    return;                                  -- idempotent
  end if;

  if exists (
    select 1 from public.agency_transactions o
     where o.provider_id = t.provider_id
       and o.provider_reference = v_new
       and o.status not in ('draft', 'cancelled')
       and o.id <> t.id
  ) then
    raise exception
      'Another transaction for this provider already carries the reference %.', v_new
      using errcode = 'P0001';
  end if;

  update public.agency_transactions set provider_reference = v_new
   where id = p_transaction_id;

  insert into public.agency_transaction_audit_log
    (transaction_id, action, actor_id, old_value, new_value, reason)
  values (p_transaction_id, 'reference_corrected', v_actor,
          pg_catalog.jsonb_build_object('provider_reference', t.provider_reference),
          pg_catalog.jsonb_build_object('provider_reference', v_new), p_reason);
end;
$$;

comment on function public.update_agency_transaction_reference(uuid, text, text) is
  'Phase 4B, correction C6. Corrects the provider reference on a posted transaction. Writes no journal entry: this is a metadata correction, kept apart from the financial reversal path. Requires agency:correct and a reason, and refuses a reference another transaction already claims.';

revoke all on function public.update_agency_transaction_reference(uuid, text, text) from public, anon;
grant execute on function public.update_agency_transaction_reference(uuid, text, text) to authenticated;
