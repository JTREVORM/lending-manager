-- ===========================================================================
-- Polytos Phase 1.8 — moving a member onto new terms, with their agreement
--
-- ## The gap this closes
--
-- Phase 1 froze a policy version the moment anybody was enrolled under it,
-- and refused any change to `memberships.policy_version_id`. Both are right,
-- and together they said something the programme cannot live with: that a
-- member enrolled under version 1.0 is held to version 1.0 for as long as
-- they are a member, whatever the business and that member later agree.
--
-- That is not how terms change. The business publishes version 1.1, and
-- existing members are asked to accept it. What makes that lawful is not an
-- editable column; it is evidence that the member was shown the new terms
-- and agreed to them. `membership_terms_acceptances` has always been keyed
-- on `(membership_id, policy_version_id)` precisely so a second acceptance
-- is recordable. This is the only route that writes one and moves the member
-- in the same breath.
--
-- ## Why a function rather than a permission
--
-- Opening `policy_version_id` to `membership:manage_policies` would have let
-- an owner move a member onto any version by UPDATE, with nothing recording
-- that the member had ever seen it. The acceptance and the move have to be
-- one transaction or they are not one event, and the only way to say that in
-- a database is a function.
--
-- The transaction-local marker this sets is a *route*, not a permission.
-- `memberships_guard_transition` re-checks, on its own account, that the
-- acceptance exists and that the target version is approved and in force —
-- so a caller who found some way to set the marker still could not move a
-- member onto a draft, and still could not move one without their signature.
--
-- ## What this is not
--
-- It is not a screen. Phase 1 ships no membership write path, and this
-- function has no UI: it exists so that the rule above it — a frozen
-- version, an immutable column — can be strict without being a trap, and so
-- that the authorization around re-acceptance is reviewed before Polytos
-- Phase 2 builds the form that calls it.
--
-- ## What Phase 2 must tighten before this is reachable from a screen
--
-- `p_signature_name` is a **typed name**, and a typed name is not consent.
-- Anybody with `membership:manage_policies` can type any member's name, and
-- the row that results is indistinguishable from one the member themselves
-- signed. For Phase 1 that is tolerable because nothing calls this function
-- and no screen offers it. The moment a screen does, a typed name alone
-- becomes a staff member's unilateral power to move somebody onto new terms
-- and produce the paperwork saying they agreed.
--
-- So Phase 2 must require **verifiable evidence of consent**, enforced in
-- the database rather than in the form, before an acceptance row counts:
--
--   * at least one artefact that did not originate with the person typing —
--     a signature image at `signature_path` in the private documents bucket,
--     or a witnessed record carrying `witness_name` and `witness_phone`, or
--     a confirmation the member themselves sent (a portal acknowledgement
--     under their own `clients.profile_id`, or a one-time code delivered to
--     the phone number on the client record and returned);
--   * a CHECK constraint on `membership_terms_acceptances` that refuses a
--     row carrying none of them, so the requirement cannot be skipped by any
--     write path; and
--   * where the evidence is a witness, the witness must be somebody other
--     than `recorded_by` — a staff member witnessing their own entry is the
--     same signature twice.
--
-- `signature_name` stays, because the name a person writes is what a printed
-- form shows. It stops being sufficient on its own.
--
-- The same requirement applies to the acceptance taken at enrolment, which
-- is the other caller Phase 2 adds. See ADR-050.
-- ===========================================================================

create or replace function public.accept_membership_policy_version(
  p_membership_id uuid,
  p_policy_version_id uuid,
  p_signature_name text,
  p_accepted_place text default null,
  p_witness_name text default null,
  p_witness_phone text default null
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
  v_acceptance uuid;
begin
  -- A session needs the capability. There is no session on the trusted
  -- server path, which is where a migration and the test harness call from,
  -- and there is nothing to check a capability against there.
  if auth.uid() is not null
     and not public.user_has_permission('membership:manage_policies') then
    raise exception
      'Moving a member onto new terms requires the membership:manage_policies capability.'
      using errcode = 'P0001';
  end if;

  -- Locked for the duration: the acceptance and the move are one event, and
  -- two concurrent re-acceptances of different versions would otherwise
  -- leave the member on whichever committed last.
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

  -- Terms move forward. Moving a member onto a version that took effect
  -- before the one they are on would be backdating their contract, which is
  -- the thing the freeze upstream exists to prevent.
  if v_target.effective_from < v_current.effective_from then
    raise exception
      'Policy version % took effect before version %, which membership % is already held to.',
      v_target.version, v_current.version, v_membership.membership_number
      using errcode = 'P0001';
  end if;

  -- The evidence first. Its own guard derives the version string and the
  -- recorder, and the unique key on (membership, version) means a second
  -- call for the same version is refused rather than duplicated.
  insert into public.membership_terms_acceptances
    (membership_id, policy_version_id, accepted_at, signature_name,
     witness_name, witness_phone, accepted_place)
  values
    (p_membership_id, p_policy_version_id, pg_catalog.now(), p_signature_name,
     p_witness_name, p_witness_phone, p_accepted_place)
  returning id into v_acceptance;

  -- The marker the transition guard reads, set for this transaction only and
  -- cleared whichever way the update goes.
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
  uuid, uuid, text, text, text, text
) is
  'Polytos Phase 1. Records a member''s acceptance of a newly published policy version and moves them onto it, in one transaction. The only route by which memberships.policy_version_id changes. Requires membership:manage_policies from a session, and the target version must be approved and in force.';

revoke all on function public.accept_membership_policy_version(
  uuid, uuid, text, text, text, text
) from public, anon;
grant execute on function public.accept_membership_policy_version(
  uuid, uuid, text, text, text, text
) to authenticated;
