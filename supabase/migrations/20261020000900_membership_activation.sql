-- ===========================================================================
-- Polytos Phase 2.9 — activation has preconditions, and enrolment is one act
--
-- ## The Phase 1 commitment, now enforceable
--
-- ADR-050 recorded that `pending -> active` must be refused unless the member
-- has actually paid and actually agreed, and that neither check could be
-- written in Phase 1 because neither record existed. Both exist now, so both
-- checks go here — inside `memberships_guard_transition()`, **above** the
-- trusted-path exemption, so they bind `service_role` and the table owner as
-- well as a session.
--
-- Condition A — a registration fee that **posted**
--
--   A `membership_fee_receipts` row for this membership, `status = 'posted'`,
--   whose journal entry exists and has not been reversed. The test is the
--   journal, not the receipt's own column: "successfully posted" means the
--   ledger moved, and a document that believes it posted while its entry was
--   reversed is exactly the discrepancy a financial system exists to make
--   impossible.
--
-- Condition B — consent that was **verified**
--
--   A `membership_terms_acceptances` row for this membership *and* the exact
--   `policy_version_id` the membership carries, with
--   `verification_status = 'verified'`. Not any acceptance: accepting version
--   1.0 does not activate somebody enrolled under 1.1. And not a typed name:
--   20261020000300 made `verification_status` something the database derives
--   from evidence it can check rather than something a caller asserts.
--
-- Neither can be a CHECK constraint — both are statements about rows in other
-- tables — and neither belongs in a Server Action, because every route to the
-- table has to be refused and not merely the one the form takes. A membership
-- that reached `active` without them is a person the business is taking
-- savings from under terms nobody can show they agreed to.
--
-- ## Why `enrol_member()` is a function and not three calls
--
-- Taking the fee, recording the consent and opening the account are one
-- business act. Three calls from a form can half-succeed, and the half that
-- succeeds is money taken from somebody who is not a member. One function,
-- one transaction, all of it or none of it.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- The two preconditions, as functions
--
-- Written out so the guard reads as the rule rather than as two subqueries,
-- and so the enrolment screen can ask the same question the guard will ask
-- rather than approximating it.
-- ---------------------------------------------------------------------------

create or replace function public.membership_fee_is_posted(p_membership_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.membership_fee_receipts r
    join public.journal_entries e on e.id = r.journal_entry_id
    where r.membership_id = p_membership_id
      and r.status = 'posted'
      and e.reversed_by_entry_id is null
  );
$$;

comment on function public.membership_fee_is_posted(uuid) is
  'Polytos Phase 2. Whether this membership''s registration fee has actually reached the ledger: a posted receipt whose journal entry exists and has not been reversed. The journal is the test, not the receipt''s own status column.';

revoke all on function public.membership_fee_is_posted(uuid) from public, anon;
grant execute on function public.membership_fee_is_posted(uuid) to authenticated;

create or replace function public.membership_terms_are_accepted(p_membership_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.membership_terms_acceptances a
    join public.memberships m on m.id = a.membership_id
    where a.membership_id = p_membership_id
      and a.policy_version_id = m.policy_version_id
      and a.verification_status = 'verified'
  );
$$;

comment on function public.membership_terms_are_accepted(uuid) is
  'Polytos Phase 2. Whether this membership has a verified acceptance of the exact policy version it is held to. Accepting a different version does not count, and an unverified acceptance is a typed name.';

revoke all on function public.membership_terms_are_accepted(uuid) from public, anon;
grant execute on function public.membership_terms_are_accepted(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- The guard, with the two preconditions added
--
-- Everything else in this function is Phase 1's, unchanged. The new block is
-- the `pending -> active` case, and it sits inside the "binding on everyone"
-- section above the trusted-path exemption.
-- ---------------------------------------------------------------------------

create or replace function public.memberships_guard_transition()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_allowed text[];
begin
  -- --- Binding on everyone -----------------------------------------------

  if new.membership_number is distinct from old.membership_number then
    raise exception 'A membership number cannot be changed once issued.'
      using errcode = 'P0001';
  end if;

  if new.client_id is distinct from old.client_id then
    raise exception
      'A membership belongs to the client it was opened for. Withdraw it and enrol the other client.'
      using errcode = 'P0001';
  end if;

  -- The branch follows the client, on an update as on an insert. A
  -- membership moved to a branch the client has no relationship with would
  -- put the row outside the branch rule that decides who may read it.
  if new.branch_id is distinct from old.branch_id
     and new.branch_id is distinct from (
       select c.branch_id from public.clients c where c.id = old.client_id
     ) then
    raise exception
      'A membership is held at the client''s own branch. Move the client, and the membership follows.'
      using errcode = 'P0001';
  end if;

  -- A member's terms move only through a recorded re-acceptance.
  if new.policy_version_id is distinct from old.policy_version_id then
    if coalesce(
         pg_catalog.current_setting('app.membership_policy_reacceptance', true), ''
       ) <> old.id::text then
      raise exception
        'A member is held to the policy version they were enrolled under. Record a re-acceptance with accept_membership_policy_version() to move them onto new terms.'
        using errcode = 'P0001';
    end if;

    if not exists (
      select 1
      from public.membership_terms_acceptances a
      where a.membership_id = old.id
        and a.policy_version_id = new.policy_version_id
        and a.verification_status = 'verified'
    ) then
      raise exception
        'Moving a member onto a new policy version needs their verified acceptance of it.'
        using errcode = 'P0001';
    end if;

    if not public.membership_policy_allows(new.policy_version_id, 'enrolment') then
      raise exception
        'A member can only be moved onto a membership policy version that is approved and in force.'
        using errcode = 'P0001';
    end if;
  end if;

  if new.status is distinct from old.status then
    v_allowed := case old.status
      when 'pending'   then array['active', 'withdrawn', 'deceased']
      when 'active'    then array['suspended', 'withdrawn', 'deceased']
      when 'suspended' then array['active', 'withdrawn', 'deceased']
      else array[]::text[]
    end;

    if not (new.status = any (v_allowed)) then
      raise exception
        'A membership cannot move from % to %.', old.status, new.status
        using errcode = 'P0001';
    end if;

    -- --- ADR-050: the two preconditions of becoming a member --------------
    --
    -- Only on the first activation. `suspended -> active` is a restoration of
    -- somebody who was already a member and already met these; re-checking
    -- would mean a member whose fee was later corrected could never be
    -- un-suspended, which is a different policy than the one intended.
    if new.status = 'active' and old.status = 'pending' then
      if not public.membership_fee_is_posted(old.id) then
        raise exception
          'Membership % cannot be activated: its registration fee has not been posted to the ledger, or the posting was reversed.',
          old.membership_number using errcode = 'P0001';
      end if;

      if not public.membership_terms_are_accepted(old.id) then
        raise exception
          'Membership % cannot be activated: there is no verified acceptance of the policy version it is held to.',
          old.membership_number using errcode = 'P0001';
      end if;
    end if;

    -- The date each transition needs, stamped rather than trusted. A caller
    -- that could set `activated_on` freely could backdate a savings
    -- qualification by six months.
    if new.status = 'active' and old.status = 'pending' then
      new.activated_on := coalesce(new.activated_on, public.business_date());
    end if;

    if new.status in ('withdrawn', 'deceased') then
      new.ended_on := coalesce(new.ended_on, public.business_date());
    end if;

    new.status_changed_at := pg_catalog.now();
    new.status_changed_by := public.current_profile_id();
  end if;

  -- The lifecycle dates are set by the transitions above and nowhere else.
  if new.status is not distinct from old.status
     and (new.activated_on is distinct from old.activated_on
          or new.ended_on is distinct from old.ended_on) then
    raise exception
      'Membership dates are stamped by the transition that sets them.'
      using errcode = 'P0001';
  end if;

  -- --- The trusted server path -------------------------------------------
  if auth.uid() is null then
    return new;
  end if;

  -- --- Binding on sessions -----------------------------------------------

  if new.applied_on is distinct from old.applied_on
     or new.created_by is distinct from old.created_by
     or new.created_at is distinct from old.created_at then
    raise exception 'Membership provenance cannot be rewritten.'
      using errcode = 'P0001';
  end if;

  if new.status is not distinct from old.status
     and (new.status_changed_at is distinct from old.status_changed_at
          or new.status_changed_by is distinct from old.status_changed_by) then
    raise exception
      'Status attribution is maintained by the database, not by the caller.'
      using errcode = 'P0001';
  end if;

  if new.status is distinct from old.status then
    if not public.user_has_permission('membership:manage_status') then
      raise exception
        'Changing a membership status requires the membership:manage_status capability.'
        using errcode = 'P0001';
    end if;
  end if;

  if (
       new.notes is distinct from old.notes
    or new.branch_id is distinct from old.branch_id
  ) and not public.user_has_permission('membership:update') then
    raise exception
      'Changing membership details requires the membership:update capability.'
      using errcode = 'P0001';
  end if;

  if new.status is not distinct from old.status
     and new.status_reason is distinct from old.status_reason
     and not public.user_has_permission('membership:update') then
    raise exception
      'Changing membership details requires the membership:update capability.'
      using errcode = 'P0001';
  end if;

  return new;
end;
$$;

comment on function public.memberships_guard_transition() is
  'BEFORE UPDATE on memberships: enforces the lifecycle, keeps the branch following the client, permits a change of policy version only through a verified re-acceptance, and — the ADR-050 commitment — refuses pending -> active unless the registration fee has reached the ledger unreversed and a verified acceptance of the member''s own policy version exists. Binds every caller, service_role included.';

-- ===========================================================================
-- enrol_member()
--
-- The whole enrolment, as one transaction:
--
--   1. open the membership (pending)
--   2. take the registration fee, posting its journal
--   3. record the consent, which the acceptance guard verifies
--   4. activate — which the guard above now re-checks independently
--   5. open the savings account, if the savings rules are open
--   6. take the first deposit, if one was handed over
--
-- Step 4 deliberately re-asks what steps 2 and 3 just did. Not redundancy:
-- the guard is what binds every *other* route to the table, and a function
-- that trusted its own earlier steps would be asserting the precondition
-- rather than meeting it.
--
-- Step 5 is conditional because enrolment and savings are gated separately —
-- a member can legitimately join while the savings rules are undecided, and
-- the alternative would be holding up registration on a question that has
-- nothing to do with it.
--
-- The combined payment (Section 8): the fee and the first deposit are two
-- postings inside one transaction, so the member hands over UGX 55,000 once
-- and the books separate it into UGX 5,000 of income and UGX 50,000 of
-- liability. If either posting fails, neither happened and the member is not
-- half-enrolled.
-- ===========================================================================

create or replace function public.enrol_member(
  p_client_id uuid,
  p_payment_method text,
  p_fee_reference text,
  p_consent_method text,
  p_signature_name text,
  p_fee_idempotency_key uuid,
  p_signature_path text default null,
  p_witness_profile_id uuid default null,
  p_challenge_id uuid default null,
  p_initial_deposit bigint default null,
  p_deposit_reference text default null,
  p_deposit_idempotency_key uuid default null,
  p_notes text default null
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_membership_id uuid;
  v_policy_id     uuid;
  v_client        public.clients;
  v_actor         uuid;
  v_account_id    uuid;
begin
  -- Idempotent on the fee key: a retried enrolment finds the receipt it
  -- already wrote and returns the membership that receipt belongs to, rather
  -- than enrolling the client a second time.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('membership_fee_key:' || p_fee_idempotency_key::text)
  );

  select r.membership_id into v_membership_id
  from public.membership_fee_receipts r
  where r.idempotency_key = p_fee_idempotency_key;

  if v_membership_id is not null then
    return v_membership_id;
  end if;

  v_actor := public.current_profile_id();

  if auth.uid() is not null
     and not public.user_has_permission('membership:create') then
    raise exception 'Enrolling a member requires the membership:create capability.'
      using errcode = 'P0001';
  end if;

  select * into v_client from public.clients where id = p_client_id;

  if not found then
    raise exception 'No such client.' using errcode = 'P0001';
  end if;

  if v_client.status = 'blacklisted' then
    raise exception
      'Client % is blacklisted and cannot be enrolled as a member.',
      v_client.client_number using errcode = 'P0001';
  end if;

  -- The partial unique index refuses a second live membership; this says so
  -- in words the counter can act on.
  if exists (
    select 1 from public.memberships
    where client_id = p_client_id
      and status in ('pending', 'active', 'suspended')
  ) then
    raise exception
      'Client % already holds a live membership.', v_client.client_number
      using errcode = 'P0001';
  end if;

  -- 1. The membership. Its branch and policy version are stamped by the
  --    Phase 1 provenance trigger, which also refuses enrolment when no
  --    version is in force.
  insert into public.memberships (client_id, applied_on, notes)
  values (p_client_id, public.business_date(),
          nullif(pg_catalog.btrim(coalesce(p_notes, '')), ''))
  returning id, policy_version_id into v_membership_id, v_policy_id;

  -- 2. The fee. The amount comes from the policy, so it is not a parameter.
  perform public.record_membership_fee(
    v_membership_id,
    (select registration_fee from public.membership_policy_versions
      where id = v_policy_id),
    p_payment_method,
    p_fee_reference,
    p_fee_idempotency_key,
    null);

  -- 3. The consent. The acceptance guard verifies the evidence and sets
  --    `verification_status` itself; if it cannot verify, it raises and the
  --    whole enrolment rolls back.
  insert into public.membership_terms_acceptances (
    membership_id, policy_version_id, accepted_at, signature_name,
    consent_method, signature_path, witness_profile_id, challenge_id,
    member_profile_id
  )
  values (
    v_membership_id, v_policy_id, pg_catalog.now(), p_signature_name,
    p_consent_method, p_signature_path, p_witness_profile_id, p_challenge_id,
    case when p_consent_method = 'member_portal' then v_client.profile_id end
  );

  -- 4. Activation, re-checked by the guard on its own account.
  update public.memberships
     set status = 'active'
   where id = v_membership_id;

  -- 5. The savings account, when the savings rules are open. A member
  --    enrolled while they are not is a member with no account yet, which is
  --    the honest state rather than an account nothing may post to.
  if public.membership_policy_allows(v_policy_id, 'savings') then
    v_account_id := public.open_savings_account(v_membership_id);

    -- 6. The first deposit, if the member handed one over with the fee.
    if p_initial_deposit is not null and p_initial_deposit > 0 then
      if p_deposit_idempotency_key is null then
        raise exception
          'An initial deposit needs its own idempotency key, so a retry cannot post it twice.'
          using errcode = 'P0001';
      end if;

      perform public.post_savings_deposit(
        v_account_id, p_initial_deposit, p_payment_method,
        p_deposit_reference, p_deposit_idempotency_key, null);
    end if;
  elsif p_initial_deposit is not null and p_initial_deposit > 0 then
    raise exception
      'Savings are not open under the membership policy in force, so an initial deposit cannot be taken.'
      using errcode = 'P0001';
  end if;

  return v_membership_id;
end;
$$;

comment on function public.enrol_member(uuid, text, text, text, text, uuid, text, uuid, uuid, bigint, text, uuid, text) is
  'Polytos Phase 2. Enrols an existing client as a member in one transaction: membership, registration fee and its journal, verified consent, activation, savings account and an optional first deposit. All of it or none of it. Idempotent on the fee key.';

revoke all on function public.enrol_member(uuid, text, text, text, text, uuid, text, uuid, uuid, bigint, text, uuid, text)
  from public, anon;
grant execute on function public.enrol_member(uuid, text, text, text, text, uuid, text, uuid, uuid, bigint, text, uuid, text)
  to authenticated;
