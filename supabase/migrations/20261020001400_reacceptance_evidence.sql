-- ===========================================================================
-- Polytos Phase 2.14 — re-acceptance takes evidence too
--
-- Phase 1's `accept_membership_policy_version()` took a typed signature name
-- and a typed witness name, and its own header said so: "a typed name is not
-- consent … Phase 2 must require verifiable evidence … the same requirement
-- applies to the acceptance taken at enrolment, which is the other caller
-- Phase 2 adds."
--
-- `enrol_member()` now meets that standard. This replaces the re-acceptance
-- route so it meets the same one, and it does so by handing the evidence to
-- exactly the same guard: `membership_terms_acceptances_guard` verifies a
-- portal confirmation, a one-time code, an uploaded signature or a witnessing
-- member of staff, and sets `verification_status` itself. Nothing about
-- moving an existing member onto new terms gets a weaker test than joining
-- did — if anything it deserves a stronger one, because the member is being
-- asked to give up terms they already hold.
--
-- The old signature is dropped rather than left beside the new one. Phase 1
-- shipped no screen that called it and nothing in the application references
-- it, so leaving it would leave a second, weaker door into the same room.
-- ===========================================================================

drop function if exists public.accept_membership_policy_version(
  uuid, uuid, text, text, text, text);

create or replace function public.accept_membership_policy_version(
  p_membership_id uuid,
  p_policy_version_id uuid,
  p_consent_method text,
  p_signature_name text,
  p_signature_path text default null,
  p_witness_profile_id uuid default null,
  p_challenge_id uuid default null,
  p_accepted_place text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_membership public.memberships%rowtype;
  v_target     public.membership_policy_versions%rowtype;
  v_current    public.membership_policy_versions%rowtype;
  v_client     public.clients%rowtype;
  v_acceptance uuid;
begin
  if auth.uid() is not null
     and not public.user_has_permission('membership:manage_policies') then
    raise exception
      'Moving a member onto new terms requires the membership:manage_policies capability.'
      using errcode = 'P0001';
  end if;

  select * into v_membership
  from public.memberships
  where id = p_membership_id
  for update;

  if not found then
    raise exception 'No such membership.' using errcode = 'P0001';
  end if;

  if v_membership.status not in ('pending', 'active', 'suspended') then
    raise exception
      'Membership % has ended. Its terms are history and are not re-accepted.',
      v_membership.membership_number using errcode = 'P0001';
  end if;

  select * into v_target
  from public.membership_policy_versions
  where id = p_policy_version_id;

  if not found then
    raise exception 'No such membership policy version.' using errcode = 'P0001';
  end if;

  if p_policy_version_id = v_membership.policy_version_id then
    raise exception
      'Membership % is already held to version %.',
      v_membership.membership_number, v_target.version using errcode = 'P0001';
  end if;

  if not public.membership_policy_allows(p_policy_version_id, 'enrolment') then
    raise exception
      'Policy version % is not approved and in force, so nobody can be moved onto it.',
      v_target.version using errcode = 'P0001';
  end if;

  select * into v_current
  from public.membership_policy_versions
  where id = v_membership.policy_version_id;

  if v_target.effective_from < v_current.effective_from then
    raise exception
      'Policy version % took effect before version %, which membership % is already held to.',
      v_target.version, v_current.version, v_membership.membership_number
      using errcode = 'P0001';
  end if;

  select * into v_client from public.clients where id = v_membership.client_id;

  -- The evidence. Handed to the same guard the enrolment acceptance goes
  -- through, which verifies it and sets `verification_status` itself — so a
  -- caller cannot assert consent here any more than they can there. If it
  -- cannot be verified the guard raises, and the member stays on the terms
  -- they already hold.
  insert into public.membership_terms_acceptances
    (membership_id, policy_version_id, accepted_at, signature_name,
     consent_method, signature_path, witness_profile_id, challenge_id,
     member_profile_id, accepted_place)
  values
    (p_membership_id, p_policy_version_id, pg_catalog.now(), p_signature_name,
     p_consent_method, p_signature_path, p_witness_profile_id, p_challenge_id,
     case when p_consent_method = 'member_portal' then v_client.profile_id end,
     nullif(pg_catalog.btrim(coalesce(p_accepted_place, '')), ''))
  returning id into v_acceptance;

  perform pg_catalog.set_config(
    'app.membership_policy_reacceptance', p_membership_id::text, true);

  begin
    update public.memberships
       set policy_version_id = p_policy_version_id
     where id = p_membership_id;
  exception
    when others then
      perform pg_catalog.set_config('app.membership_policy_reacceptance', '', true);
      raise;
  end;

  perform pg_catalog.set_config('app.membership_policy_reacceptance', '', true);

  return v_acceptance;
end;
$$;

comment on function public.accept_membership_policy_version(
  uuid, uuid, text, text, text, uuid, uuid, text
) is
  'Polytos Phase 2. Records a member''s verified acceptance of a newly published policy version and moves them onto it, in one transaction. The only route by which memberships.policy_version_id changes. The evidence goes through the same guard an enrolment acceptance does, so a typed name moves nobody.';

revoke all on function public.accept_membership_policy_version(
  uuid, uuid, text, text, text, uuid, uuid, text
) from public, anon;
grant execute on function public.accept_membership_policy_version(
  uuid, uuid, text, text, text, uuid, uuid, text
) to authenticated;

-- ---------------------------------------------------------------------------
-- Issuing a one-time code
--
-- The code is returned to the caller **once**, and only its digest is kept.
-- The application sends it to the member's own number — the one already on
-- the client record, not one typed into the form, because a code sent to a
-- number a staff member chose proves nothing about who received it.
-- ---------------------------------------------------------------------------

create or replace function public.issue_membership_consent_code(
  p_membership_id uuid,
  p_policy_version_id uuid
)
returns table (challenge_id uuid, code text, delivered_to text, expires_at timestamptz)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_membership public.memberships%rowtype;
  v_client     public.clients%rowtype;
  v_code       text;
  v_id         uuid;
  v_expires    timestamptz;
begin
  if auth.uid() is not null
     and not public.user_has_permission('membership:create')
     and not public.user_has_permission('membership:manage_policies') then
    raise exception
      'Issuing a consent code requires the membership:create or membership:manage_policies capability.'
      using errcode = 'P0001';
  end if;

  select * into v_membership from public.memberships where id = p_membership_id;

  if not found then
    raise exception 'No such membership.' using errcode = 'P0001';
  end if;

  select * into v_client from public.clients where id = v_membership.client_id;

  if v_client.phone is null then
    raise exception
      'This member has no phone number on their client record, so a code cannot be sent to them.'
      using errcode = 'P0001';
  end if;

  -- Six digits, which is what a person can be read over a phone and type
  -- back. The entropy that matters is not in the code but in the single live
  -- challenge, the ten-minute window and the one-use rule.
  v_code := pg_catalog.lpad(
    pg_catalog.floor(pg_catalog.random() * 1000000)::integer::text, 6, '0');
  v_expires := pg_catalog.now() + interval '10 minutes';

  -- A previous unspent challenge is stood down, so the unique index on live
  -- challenges holds and only the newest code works.
  update public.membership_consent_challenges
     set consumed_at = pg_catalog.now()
   where membership_id = p_membership_id
     and policy_version_id = p_policy_version_id
     and consumed_at is null;

  insert into public.membership_consent_challenges
    (membership_id, policy_version_id, delivered_to, code_digest,
     issued_by, issued_by_label, expires_at)
  values
    (p_membership_id, p_policy_version_id, v_client.phone,
     public.consent_evidence_digest(v_code),
     public.current_profile_id(), public.audit_actor_label(), v_expires)
  returning id into v_id;

  challenge_id := v_id;
  code := v_code;
  delivered_to := v_client.phone;
  expires_at := v_expires;
  return next;
end;
$$;

comment on function public.issue_membership_consent_code(uuid, uuid) is
  'Polytos Phase 2. Issues a one-time consent code to the phone number already on the member''s client record. Returns the code once; the table keeps only its digest, so reading the database is not a way to consent on somebody''s behalf.';

revoke all on function public.issue_membership_consent_code(uuid, uuid) from public, anon;
grant execute on function public.issue_membership_consent_code(uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Redeeming one
--
-- The code is checked here rather than in the acceptance guard, because the
-- guard is handed a challenge id and should not also be handed a secret. A
-- wrong code increments the attempt count and the challenge dies after five.
-- ---------------------------------------------------------------------------

create or replace function public.redeem_membership_consent_code(
  p_challenge_id uuid,
  p_code text
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_challenge public.membership_consent_challenges%rowtype;
begin
  select * into v_challenge
  from public.membership_consent_challenges
  where id = p_challenge_id
  for update;

  if not found then
    raise exception 'No such consent challenge.' using errcode = 'P0001';
  end if;

  if v_challenge.consumed_at is not null then
    raise exception 'That code has already been used.' using errcode = 'P0001';
  end if;

  if v_challenge.expires_at <= pg_catalog.now() then
    raise exception 'That code has expired. Send a new one.' using errcode = 'P0001';
  end if;

  if v_challenge.attempts >= 5 then
    raise exception
      'Too many wrong attempts on that code. Send a new one.'
      using errcode = 'P0001';
  end if;

  if v_challenge.code_digest
     is distinct from public.consent_evidence_digest(coalesce(p_code, '')) then
    update public.membership_consent_challenges
       set attempts = attempts + 1
     where id = p_challenge_id;

    raise exception 'That code does not match.' using errcode = 'P0001';
  end if;

  -- Correct. The challenge is *not* consumed here: the acceptance guard
  -- consumes it, in the same transaction as the acceptance it proves, so a
  -- code cannot be burned by a redemption that then fails to record anything.
  return p_challenge_id;
end;
$$;

comment on function public.redeem_membership_consent_code(uuid, text) is
  'Polytos Phase 2. Checks a one-time consent code without consuming it; the acceptance guard consumes it in the same transaction as the acceptance it proves. Counts wrong attempts and gives up after five.';

revoke all on function public.redeem_membership_consent_code(uuid, text) from public, anon;
grant execute on function public.redeem_membership_consent_code(uuid, text) to authenticated;
