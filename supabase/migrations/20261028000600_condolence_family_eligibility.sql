-- ===========================================================================
-- Polytos business-policy update — rule 11: any family member qualifies for
-- the condolence benefit if they were listed as next of kin
-- ===========================================================================
--
-- > Any family member may qualify if they were listed as next of kin in the
-- > system.
--
-- Two halves, and Phase 4 implemented neither because it had neither answer:
--
--   1. **which relationships are family**, on
--      `beneficiary_relationships.condolence_eligible`, NULL on every row; and
--   2. **"listed as next of kin"**, which is a condition on the *claim* and
--      had no column at all.
--
-- ## Which relationships count
--
-- The brief draws the line twice, in both directions: "Support broad family
-- relationships rather than limiting entitlement arbitrarily to spouse,
-- children and parents", and "Do not automatically mark every generic
-- relationship, including unrelated persons, as an eligible family member."
--
-- Ten of the twelve relationships in the vocabulary name a family tie and are
-- marked eligible. Two do not:
--
--   - **Guardian.** A legal relationship, not a family one. A guardian may
--     also be an aunt, and where they are, that is the relationship to record.
--   - **Other.** The vocabulary's escape hatch, used when none of the eleven
--     fits. Marking it eligible would make "any person at all" eligible and
--     would empty the word "family" of content.
--
-- Neither is marked *ineligible as a family member in principle* — they are
-- marked ineligible because the record does not say that they are family. A
-- claim refused on `other` names the relationship the member actually
-- claimed, so the business can decide the real case and, if they wish, extend
-- the vocabulary with the tie that was meant.
--
-- ## "Listed as next of kin"
--
-- This is the half that stops the benefit being claimable for anybody. The
-- deceased has to have been on the member's own next-of-kin record **before
-- the death** — which is exactly the brief's "Do not allow somebody to add a
-- beneficiary after an event and silently use the updated record to justify a
-- historical claim."
--
-- So a condolence claim now cites `deceased_beneficiary_id`: the registered
-- record naming the person who died. That is a different link from
-- `beneficiary_id`, which on a bereavement claim names the person the
-- business **pays**. Conflating them would be a mistake with money attached:
-- on a condolence claim the payee is the member themselves, and the deceased
-- is a relative of theirs.
--
-- The claim shape constraint is replaced rather than loosened — a condolence
-- claim still may not carry a payee beneficiary, and now carries a deceased
-- one instead.
--
-- ## One interpretation, recorded as an interpretation
--
-- The client said "listed", not "verified". A registered record whose
-- verification is still pending therefore satisfies the rule as written, and
-- this migration implements it as written: active, and registered on or
-- before the date of death. The verification status is carried into the
-- assessment snapshot so that a decision taken on an unverified record is
-- visible as one, and `docs/POLYTOS-MEMBERSHIP-POLICY-DECISIONS.md` records
-- this as a reading rather than a quotation. The exposure is small: the
-- condolence benefit is paid to the member, who is already an identified
-- client, not to the next of kin.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Which relationships are family
-- ---------------------------------------------------------------------------

update public.beneficiary_relationships
   set condolence_eligible = true
 where key in (
   'spouse', 'child', 'parent', 'sibling',
   'grandparent', 'grandchild',
   'uncle_aunt', 'nephew_niece', 'cousin',
   'other_relative'
 );

update public.beneficiary_relationships
   set condolence_eligible = false
 where key in ('guardian', 'other');

comment on column public.beneficiary_relationships.condolence_eligible is
  'Polytos Phase 4, answered by the policy update (rule 11). Whether a death in this relationship qualifies for the family condolence benefit. Ten family ties are eligible; "guardian" is a legal relationship rather than a family one, and "other" is the vocabulary''s escape hatch — marking it eligible would make any person at all eligible and empty the word "family" of content. A claim refused on either names the relationship the member actually claimed, so the business can decide the real case.';

-- Every row is now decided. A relationship added later must say which it is,
-- because an undecided row would silently hold every claim citing it.
alter table public.beneficiary_relationships
  alter column condolence_eligible set not null;

-- ---------------------------------------------------------------------------
-- The next-of-kin record naming the deceased
-- ---------------------------------------------------------------------------

alter table public.benefit_claims
  add column deceased_beneficiary_id uuid
    references public.member_beneficiaries(id) on delete restrict;

comment on column public.benefit_claims.deceased_beneficiary_id is
  'Polytos policy update, rule 11. On a family condolence claim: the member''s registered next-of-kin record naming the person who died. Distinct from beneficiary_id, which on a bereavement claim names the person the business pays — on a condolence claim the payee is the member themselves. Required from the policy update onward, because "listed as next of kin" is half of the client''s rule and a claim with no such record satisfies none of it.';

create index benefit_claim_deceased_beneficiary_idx
  on public.benefit_claims (deceased_beneficiary_id)
  where deceased_beneficiary_id is not null;

-- The shape constraint, replaced. A condolence claim still carries no payee
-- beneficiary; it now carries a deceased one.
alter table public.benefit_claims
  drop constraint benefit_claim_condolence_shape;

alter table public.benefit_claims
  add constraint benefit_claim_condolence_shape
    check (
      claim_type <> 'family_condolence'
      or (deceased_name is not null
          and deceased_relationship is not null
          and beneficiary_id is null)
    ),
  -- Only a condolence claim names a deceased next of kin. A medical claim has
  -- no deceased at all, and on a bereavement claim the deceased is the member.
  add constraint benefit_claim_deceased_beneficiary_shape
    check (
      claim_type = 'family_condolence' or deceased_beneficiary_id is null
    );

-- ---------------------------------------------------------------------------
-- Was this person listed, and when?
-- ---------------------------------------------------------------------------

create or replace function public.condolence_next_of_kin_status(
  p_claim_id uuid
)
returns table (
  beneficiary_id        uuid,
  beneficiary_number    text,
  relationship          text,
  relationship_label    text,
  relationship_eligible boolean,
  registered_on         date,
  listed_before_event   boolean,
  beneficiary_status    text,
  verification_status   text
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    b.id,
    b.beneficiary_number,
    b.relationship,
    r.label,
    r.condolence_eligible,
    (b.created_at at time zone 'Africa/Kampala')::date,
    (b.created_at at time zone 'Africa/Kampala')::date <= c.event_date,
    b.status,
    b.verification_status
  from public.benefit_claims c
  join public.member_beneficiaries b on b.id = c.deceased_beneficiary_id
  join public.beneficiary_relationships r on r.key = b.relationship
  where c.id = p_claim_id
    and (
      auth.uid() is null
      or (public.user_has_permission('benefits:view')
          and public.user_can_see_branch(c.branch_id))
      or exists (
        select 1 from public.clients cl where cl.id = c.client_id
          and cl.profile_id = public.current_profile_id()
      )
    );
$$;

comment on function public.condolence_next_of_kin_status(uuid) is
  'Polytos policy update, rule 11. The registered next-of-kin record a condolence claim cites, with whether its relationship is an eligible family tie and whether it was listed before the death. SECURITY DEFINER so a claim screen can show "registered 4 months before the death, relationship eligible" without the reader holding membership:view_sensitive — it returns no name, no telephone number and no identity reference.';

grant execute on function public.condolence_next_of_kin_status(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Intake accepts the deceased's next-of-kin record
-- ---------------------------------------------------------------------------
--
-- A new trailing parameter with a default, so every existing caller — the
-- 10-argument signature the application and the tests use — still resolves.
-- It is **optional** at intake on purpose: §6 of the Phase 4 brief holds, and
-- a business that could not write down that somebody came in and asked would
-- keep the record on paper. A claim with no next-of-kin record is recorded
-- and held; `benefit_claim_eligibility` is where it is refused.
--
-- The membership is read for the policy version only; the claim's own guard
-- derives the client, the branch and both policy columns.

create or replace function public.open_benefit_claim(
  p_membership_id uuid,
  p_claim_type text,
  p_event_date date default null,
  p_provider_name text default null,
  p_admission_at timestamptz default null,
  p_discharge_at timestamptz default null,
  p_bill_amount bigint default null,
  p_deceased_name text default null,
  p_deceased_relationship text default null,
  p_beneficiary_id uuid default null,
  p_deceased_beneficiary_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
  v_policy public.membership_policy_versions;
  v_membership public.memberships;
  v_kin public.member_beneficiaries;
  v_claimed bigint;
begin
  if public.current_profile_id() is null and auth.uid() is not null then
    raise exception
      'A benefit claim must be opened by a signed-in member of staff.'
      using errcode = 'P0001';
  end if;

  if auth.uid() is not null and not public.user_has_permission('benefits:claim') then
    raise exception
      'Opening a benefit claim requires the benefits:claim capability.'
      using errcode = 'P0001';
  end if;

  select * into v_membership from public.memberships where id = p_membership_id;

  if not found then
    raise exception 'No such membership.' using errcode = 'P0001';
  end if;

  -- The **governing** version. A member who has been moved onto new terms
  -- claims under those terms, and reading the frozen enrolment column here
  -- would price the claim against a version they are no longer on.
  select * into v_policy
  from public.membership_policy_versions
  where id = public.membership_governing_policy(p_membership_id,
    case when p_claim_type = 'medical'
      then (p_admission_at at time zone 'Africa/Kampala')::date
      else p_event_date end);

  -- A next-of-kin record cited at intake has to belong to this member. Not a
  -- judgement about eligibility — that is the assessment's — but a record of
  -- somebody else's family cannot be what this claim is about.
  if p_deceased_beneficiary_id is not null then
    select * into v_kin
    from public.member_beneficiaries where id = p_deceased_beneficiary_id;

    if not found then
      raise exception 'No such next-of-kin record.' using errcode = 'P0001';
    end if;

    if v_kin.membership_id <> p_membership_id then
      raise exception
        'Next-of-kin record % belongs to another membership.',
        v_kin.beneficiary_number using errcode = 'P0001';
    end if;
  end if;

  -- What the claim asks for, derived rather than accepted. A claimed amount
  -- the caller could choose would be a figure a claimant could inflate, and
  -- the assessment would then be a negotiation rather than a calculation.
  -- For a medical claim with no discharge yet it stays NULL: there is no
  -- assessable claim until the stay has ended, and a figure now would be a
  -- figure about an admission still running.
  v_claimed := case
    when p_claim_type = 'medical' and p_discharge_at is null then null
    else public.benefit_amount_for_claim(
      p_claim_type, v_policy.medical_benefit_rate_bps, p_bill_amount,
      v_policy.family_condolence_benefit, v_policy.member_bereavement_benefit)
  end;

  insert into public.benefit_claims (
    membership_id, client_id, branch_id,
    policy_version_id, policy_version,
    claim_type, event_date,
    provider_name, admission_at, discharge_at, bill_amount,
    deceased_name, deceased_relationship, beneficiary_id,
    deceased_beneficiary_id,
    claimed_amount
  )
  values (
    p_membership_id,
    -- Placeholders: the guard derives the client, the branch and both policy
    -- columns from the membership.
    v_membership.client_id, v_membership.branch_id,
    v_policy.id, 'pending',
    p_claim_type,
    -- For a medical claim the guard overwrites this with the admission date.
    coalesce(p_event_date, public.business_date()),
    nullif(pg_catalog.btrim(coalesce(p_provider_name, '')), ''),
    p_admission_at, p_discharge_at, p_bill_amount,
    nullif(pg_catalog.regexp_replace(
      pg_catalog.btrim(coalesce(p_deceased_name, '')), '\s+', ' ', 'g'), ''),
    nullif(pg_catalog.btrim(coalesce(p_deceased_relationship, '')), ''),
    p_beneficiary_id,
    p_deceased_beneficiary_id,
    v_claimed
  )
  returning id into v_id;

  return v_id;
end;
$$;

comment on function public.open_benefit_claim(uuid, text, date, text, timestamptz, timestamptz, bigint, text, text, uuid, uuid) is
  'Polytos Phase 4, extended by the policy update. Records that somebody came in and asked. Now also accepts the registered next-of-kin record naming the deceased on a family condolence claim, and prices the claim against the version **governing** the member rather than the one they enrolled under. The next-of-kin record is optional at intake and required at assessment: intake is never blocked by a rule about evidence.';

-- The 10-argument signature is replaced by the 11-argument one above, which
-- is callable with the same ten. Dropping the old one keeps PostgREST from
-- seeing two overloads and refusing an ambiguous call.
drop function if exists public.open_benefit_claim(
  uuid, text, date, text, timestamptz, timestamptz, bigint, text, text, uuid);

grant execute on function public.open_benefit_claim(
  uuid, text, date, text, timestamptz, timestamptz, bigint, text, text, uuid, uuid)
  to authenticated;


-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------
--
-- PostgreSQL grants EXECUTE on a new function to PUBLIC, and a table created
-- in a schema `anon` can reach is reachable unless the grant is taken away.
-- Both defaults are wrong here: every table in this file is written only
-- through a SECURITY DEFINER function, and every function in it decides
-- something about money or about who may read a record.
--
-- The functions a session legitimately calls are granted back to
-- `authenticated` where they are defined. Triggers, numbering helpers and
-- notification hooks are granted back to nobody: they are called by the
-- database, and a session that could call one directly would be writing a
-- row the function assumes was validated elsewhere.

revoke all on function public.condolence_next_of_kin_status(uuid) from public, anon;
revoke all on function public.open_benefit_claim(uuid, text, date, text, timestamptz, timestamptz, bigint, text, text, uuid, uuid) from public, anon;

-- New claims freeze the terms governing their event, preserving enrollment history.
create or replace function public.benefit_claims_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_membership public.memberships;
  v_version text;
  v_tz text := 'Africa/Kampala';
begin
  if tg_op = 'INSERT' then
    select * into v_membership
    from public.memberships where id = new.membership_id;

    if not found then
      raise exception 'No such membership.' using errcode = 'P0001';
    end if;

    -- `pending` is refused: a membership that has not been activated has paid
    -- no fee and saved nothing, so there is no programme to claim against.
    -- `deceased` is permitted — it is the state a bereavement claim is made
    -- in — and `suspended` is permitted at submission so the claim can be
    -- *recorded*, with the assessment refusing it for the reason the client
    -- has not settled what suspension costs a member.
    if v_membership.status not in ('active', 'suspended', 'deceased') then
      raise exception
        'Membership % is %. A benefit may be claimed against an active, suspended or deceased membership.',
        v_membership.membership_number, v_membership.status
        using errcode = 'P0001';
    end if;

    new.client_id := v_membership.client_id;
    new.branch_id := v_membership.branch_id;

    -- The claim is judged under the member's own version, whatever was sent.
    new.policy_version_id := public.membership_governing_policy(v_membership.id,
      case when new.claim_type = 'medical'
        then (new.admission_at at time zone v_tz)::date else new.event_date end);

    select v.version into v_version
    from public.membership_policy_versions v
    where v.id = public.membership_governing_policy(v_membership.id,
      case when new.claim_type = 'medical'
        then (new.admission_at at time zone v_tz)::date else new.event_date end);

    if v_version is null then
      raise exception 'The membership''s policy version is missing.'
        using errcode = 'P0001';
    end if;

    new.policy_version := v_version;

    new.created_by := coalesce(public.current_profile_id(), new.created_by);
    new.created_by_label := public.audit_actor_label();

    -- A claim starts as a draft. Everything downstream is reached by the
    -- function that performs that act, so an insert claiming to be already
    -- assessed, approved or paid is overruled rather than argued with.
    new.status := 'draft';
    new.submitted_at := null;
    new.submitted_by := null;
    new.submitted_by_label := null;
    new.verified_at := null;
    new.verified_by := null;
    new.verified_by_label := null;
    new.assessed_at := null;
    new.assessed_by := null;
    new.assessed_by_label := null;
    new.assessed_amount := null;
    new.assessment_note := null;
    new.decided_at := null;
    new.decided_by := null;
    new.decided_by_label := null;
    new.decision_note := null;
    new.approved_amount := null;
    new.rejected_reason := null;
    new.cancelled_reason := null;
    new.information_required_note := null;
    new.payment_id := null;

    if new.claim_type = 'medical' then
      -- Derived from the two instants, never supplied. All three readings,
      -- because the client has not said which one "longer than one day"
      -- means.
      --
      -- A claim still in the ward — no discharge yet — gets NULL for all
      -- three, which `assess_benefit_claim` refuses: an admission that has
      -- not ended has no length.
      if new.discharge_at is null then
        new.admission_nights := null;
        new.admission_inclusive_days := null;
        new.admission_elapsed_days := null;
      else
        new.admission_nights :=
          ((new.discharge_at at time zone v_tz)::date
            - (new.admission_at at time zone v_tz)::date);
        new.admission_inclusive_days := new.admission_nights + 1;
        new.admission_elapsed_days :=
          pg_catalog.floor(
            pg_catalog.date_part('epoch', new.discharge_at - new.admission_at)
            / 86400.0
          )::integer;
      end if;

      -- The admission date is the event, for every date-based rule.
      new.event_date := (new.admission_at at time zone v_tz)::date;
    end if;

    return new;
  end if;

  -- --- UPDATE ------------------------------------------------------------

  if new.status is distinct from old.status
     and not public.benefit_claim_transition_allowed(old.status, new.status) then
    raise exception
      'A benefit claim cannot go from % to %. See benefit_claim_transition_allowed for what can follow %.',
      old.status, new.status, old.status
      using errcode = 'P0001';
  end if;

  -- Identity never changes.
  if new.id is distinct from old.id
     or new.claim_number is distinct from old.claim_number
     or new.claim_type is distinct from old.claim_type
     or new.membership_id is distinct from old.membership_id
     or new.client_id is distinct from old.client_id
     or new.created_by_label is distinct from old.created_by_label then
    raise exception
      'A benefit claim''s identity does not change. Cancel it and open another.'
      using errcode = 'P0001';
  end if;

  -- The facts freeze at submission. A draft may be corrected freely — that is
  -- what a draft is for — and from `submitted` onwards the claim asserts
  -- them, so changing one would change what the assessment underneath it was
  -- an assessment of.
  if old.status <> 'draft' then
    if new.policy_version_id is distinct from old.policy_version_id
       or new.policy_version is distinct from old.policy_version
       or new.event_date is distinct from old.event_date
       or new.provider_name is distinct from old.provider_name
       or new.admission_at is distinct from old.admission_at
       or new.discharge_at is distinct from old.discharge_at
       or new.bill_amount is distinct from old.bill_amount
       or new.admission_nights is distinct from old.admission_nights
       or new.admission_inclusive_days is distinct from old.admission_inclusive_days
       or new.admission_elapsed_days is distinct from old.admission_elapsed_days
       or new.deceased_name is distinct from old.deceased_name
       or new.deceased_relationship is distinct from old.deceased_relationship
       or new.claimed_amount is distinct from old.claimed_amount then
      raise exception
        'Claim % has been submitted, so the facts it asserts are fixed. Reject it with a reason and open a corrected claim — an assessment of changed facts is an assessment of something else.',
        old.claim_number using errcode = 'P0001';
    end if;

    -- The beneficiary a bereavement claim names may be *added* while the
    -- claim is still being verified — the next of kin is often registered
    -- after the claim is opened — but it may never be swapped once named, and
    -- never once the claim has been assessed. The recipient the business
    -- decides on must not move under the decision.
    if new.beneficiary_id is distinct from old.beneficiary_id
       and (old.beneficiary_id is not null
            or old.status in ('assessed', 'approved', 'paid', 'reversed')) then
      raise exception
        'Claim % already names a beneficiary, or has been assessed. The recipient of an authorised payment does not change — reject the claim and open another.',
        old.claim_number using errcode = 'P0001';
    end if;
  end if;

  -- An assessment, once made, is not edited. A reassessment goes back through
  -- `assess_benefit_claim`, which may only run from a pre-assessment state —
  -- so correcting one means the approver sending it back, on the record.
  if old.assessed_at is not null
     and new.status in ('assessed', 'approved', 'paid', 'reversed')
     and (new.assessed_at is distinct from old.assessed_at
          or new.assessed_by is distinct from old.assessed_by
          or new.assessed_by_label is distinct from old.assessed_by_label
          or new.assessed_amount is distinct from old.assessed_amount) then
    raise exception
      'Claim %''s assessment is on the record. An approver may send it back for reassessment; nobody edits it in place.',
      old.claim_number using errcode = 'P0001';
  end if;

  -- The payment is the ledger's, not the claim's.
  if old.payment_id is not null and new.payment_id is distinct from old.payment_id then
    raise exception
      'Claim % is already paid. A payment is reversed, never repointed.',
      old.claim_number using errcode = 'P0001';
  end if;

  return new;
end;
$$;
