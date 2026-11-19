-- November 2026 decision: pay the unused medical annual allowance.
-- This is not a live-policy activation or an alteration of old claim terms.
-- Other policy versions continue refusing a claim that exceeds their cap
-- unless they explicitly opt into the same rule on an unfrozen draft.
--
-- IMPORTANT: assessment alone never moves money. Existing evidence checks,
-- eligibility, cap advisory locks, maker-checker approval and payment guards
-- remain in place. A reserved assessed amount counts towards annual usage.

alter table public.membership_policy_versions
  add column medical_benefit_excess_handling text;

alter table public.membership_policy_versions
  add constraint membership_medical_excess_handling_valid
  check (medical_benefit_excess_handling is null
         or medical_benefit_excess_handling in ('pay_remaining', 'reject_claim'));

comment on column public.membership_policy_versions.medical_benefit_excess_handling is
  'Versioned instruction when a valid medical claim exceeds the remaining monetary annual cap: pay_remaining permits a partial assessed amount, reject_claim explicitly refuses, NULL preserves the original refusal because no partial decision was recorded. An exhausted cap always refuses.';

create or replace function public.membership_medical_excess_handling_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $guard$
begin
  if new.medical_benefit_excess_handling
     is distinct from old.medical_benefit_excess_handling
     and (
       old.approved_at is not null
       or old.status <> 'draft'
       or exists (
         select 1 from public.memberships m
          where m.policy_version_id = old.id
       )
     ) then
    raise exception
      'Medical cap excess handling is a contractual term. An approved or assigned policy cannot be changed; publish a new version.'
      using errcode = 'P0001';
  end if;
  return new;
end;
$guard$;

create trigger membership_medical_excess_handling_guard
before update of medical_benefit_excess_handling
on public.membership_policy_versions
for each row execute function public.membership_medical_excess_handling_guard();

revoke all on function public.membership_medical_excess_handling_guard()
  from public, anon, authenticated;

do $decision$
declare
  v_policy public.membership_policy_versions;
begin
  select * into v_policy from public.membership_policy_versions
   where version = '2.0' for update;
  if not found or v_policy.status <> 'draft'
     or v_policy.approved_at is not null
     or exists (select 1 from public.memberships m
                where m.policy_version_id = v_policy.id) then
    raise exception 'Cannot stage medical partial-payment decision on a frozen or absent Policy 2.0.';
  end if;
  if v_policy.medical_benefit_excess_handling is not null
     and v_policy.medical_benefit_excess_handling <> 'pay_remaining' then
    raise exception 'A conflicting partial-payment policy already exists.';
  end if;
  update public.membership_policy_versions
     set medical_benefit_excess_handling = 'pay_remaining'
   where id = v_policy.id;
end;
$decision$;

-- Preserve the existing SECURITY DEFINER, search path, grants and scope of
-- both functions. The cap-excess branch, amount assignment and snapshot differ.

-- An assessment snapshot must say *why* a medical amount was clipped:
-- the cap/remaining balance alone cannot distinguish a deliberately partial
-- entitlement from an erroneous assessment.
alter table public.benefit_assessment_snapshots
  add column medical_benefit_excess_handling text;

comment on column public.benefit_assessment_snapshots.medical_benefit_excess_handling is
  'Excess-cap handling policy captured at assessment (pay_remaining / reject_claim / NULL legacy). Snapshotted alongside the cap and remaining amount.';



CREATE OR REPLACE FUNCTION public.benefit_claim_eligibility(p_claim_id uuid)
 RETURNS TABLE(failure_code text, detail text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_claim       public.benefit_claims;
  v_membership  public.memberships;
  v_policy      public.membership_policy_versions;
  v_activity    text;
  v_benefit_key text;
  v_threshold   smallint;
  v_benefit     bigint;
  v_from        date;
  v_to          date;
  v_consumed    bigint;
  v_count       integer;
  v_missing     text;
  v_beneficiary public.member_beneficiaries;
  v_outstanding bigint;
  v_loan_count  integer;
  v_loans       text;
  v_qual        record;
  v_kin         record;
  v_confirmed   integer;
begin
  select * into v_claim from public.benefit_claims where id = p_claim_id;

  if not found then
    return;
  end if;

  if auth.uid() is not null and not (
    (public.user_has_permission('benefits:view') and public.user_can_see_branch(v_claim.branch_id))
    or exists (select 1 from public.clients c where c.id = v_claim.client_id
      and c.profile_id = public.current_profile_id())
  ) then
    raise exception 'You cannot read that claim.' using errcode = '42501';
  end if;

  select * into v_membership
  from public.memberships where id = v_claim.membership_id;

  select * into v_policy
  from public.membership_policy_versions where id = v_claim.policy_version_id;

  v_activity := case v_claim.claim_type
                  when 'medical'            then 'medical_benefit'
                  when 'family_condolence'  then 'condolence_benefit'
                  when 'member_bereavement' then 'bereavement_benefit'
                end;
  v_benefit_key := v_claim.claim_type;

  -- --- Is this benefit open? ----------------------------------------------
  --
  -- This benefit, not every benefit. A condolence claim held because nobody
  -- has decided whether the *medical* benefit has a ceiling is a refusal that
  -- makes no sense to the person reading it, and that is what the single gate
  -- produced.
  if not public.membership_policy_allows(v_claim.policy_version_id, v_activity) then
    return query select
      'policy_not_open'::text,
      coalesce(
        public.benefit_blocked_reason(v_claim.policy_version_id, v_benefit_key),
        pg_catalog.format(
          'This benefit is not open under policy version %s.',
          v_claim.policy_version));
  end if;

  -- --- Is this a member who may claim? -----------------------------------
  if v_membership.status not in ('active', 'suspended', 'deceased') then
    return query select
      'membership_not_claimable'::text,
      pg_catalog.format('Membership %s is %s.',
        v_membership.membership_number, v_membership.status);
  end if;

  -- A bereavement claim is the one claim a deceased membership may make.
  if v_membership.status = 'deceased' and v_claim.claim_type <> 'member_bereavement' then
    return query select
      'membership_not_claimable'::text,
      pg_catalog.format(
        'Membership %s is deceased. Only the bereavement benefit is claimable on a deceased membership: whether a medical or condolence claim outstanding at the member''s death is payable, and to whom, is not settled.',
        v_membership.membership_number);
  end if;

  if v_membership.status = 'suspended' then
    return query select
      'membership_suspended_undecided'::text,
      pg_catalog.format(
        'Membership %s is suspended. Whether a suspension stops benefits, stops savings, or both, is recorded as undecided in docs/POLYTOS-MEMBERSHIP-POLICY-DECISIONS.md — so the claim is recorded and held rather than assessed against a rule nobody has set.',
        v_membership.membership_number);
  end if;

  -- --- The qualifying period ----------------------------------------------
  --
  -- Two bases, both implemented, neither defaulted. A NULL basis cannot be
  -- reached here: `policy_not_open` above already fired on it.
  if v_policy.benefit_qualification_basis = 'savings_qualifying_months' then
    -- Rule 9. The client's rule is six months of **saving**, not six months of
    -- membership, and the authoritative answer is the savings qualification
    -- engine — asked as of the claim's own event date, so an unrelated deposit
    -- afterwards cannot rewrite the decision.
    select * into v_qual
    from public.membership_savings_qualified(v_claim.membership_id, v_claim.event_date);

    if not v_qual.qualifies then
      return query select
        'savings_months_not_qualified'::text,
        pg_catalog.format(
          'A benefit needs a confirmed member who has been saving for at least %s qualifying month(s) of at least %s shillings. As at %s this member had %s. %s',
          coalesce(v_qual.months_required::text, '(undecided)'),
          coalesce(v_qual.monthly_minimum::text, '(undecided)'),
          v_claim.event_date,
          v_qual.qualifying_months,
          coalesce(v_qual.blocked_reason, ''));
    end if;

  elsif v_policy.benefit_qualification_basis = 'waiting_period_days' then
    -- Measured from activation, not application: the clock is a year of
    -- membership and a pending application is not one.
    if v_membership.activated_on is null then
      return query select
        'waiting_period_not_served'::text,
        'The membership has never been activated, so no waiting period has started.'::text;
    elsif v_claim.event_date
            < v_membership.activated_on + v_policy.benefit_waiting_period_days then
      return query select
        'waiting_period_not_served'::text,
        pg_catalog.format(
          'The waiting period is %s days from activation on %s, so a benefit may first be claimed for an event on or after %s. This event was on %s.',
          v_policy.benefit_waiting_period_days,
          v_membership.activated_on,
          v_membership.activated_on + v_policy.benefit_waiting_period_days,
          v_claim.event_date);
    end if;
  end if;

  -- --- Medical ------------------------------------------------------------
  if v_claim.claim_type = 'medical' then
    v_threshold := v_policy.medical_benefit_min_admission_days;

    if v_claim.discharge_at is null then
      return query select
        'admission_not_ended'::text,
        'No discharge has been recorded, so the admission has no length. A medical claim is assessed once the member has left hospital.'::text;
    else
      -- Every reading must clear the threshold. The readings disagree for a
      -- stay of about a day, and which one counts is the client's to say.
      if v_claim.admission_nights > v_threshold
         and v_claim.admission_inclusive_days > v_threshold
         and v_claim.admission_elapsed_days > v_threshold then
        null; -- qualifies on every reading
      elsif v_claim.admission_nights <= v_threshold
            and v_claim.admission_inclusive_days <= v_threshold
            and v_claim.admission_elapsed_days <= v_threshold then
        return query select
          'admission_too_short'::text,
          pg_catalog.format(
            'The admission must be longer than %s day(s). This stay was %s night(s), %s day(s) on the ward and %s whole day(s) elapsed — short of the threshold on every reading.',
            v_threshold, v_claim.admission_nights,
            v_claim.admission_inclusive_days, v_claim.admission_elapsed_days);
      else
        return query select
          'admission_measure_undecided'::text,
          pg_catalog.format(
            'This stay was %s night(s), %s day(s) on the ward and %s whole day(s) elapsed, so whether it is "longer than %s day(s)" depends on which of the three the client means. That is recorded as undecided, and the claim is held rather than assessed on the reading that happens to favour one side.',
            v_claim.admission_nights, v_claim.admission_inclusive_days,
            v_claim.admission_elapsed_days, v_threshold);
      end if;
    end if;

    -- The annual period, then the frequency, then the ceiling if there is one.
    if v_policy.medical_benefit_year_basis is null then
      return query select
        'medical_year_basis_undecided'::text,
        'The medical benefit''s claim count runs over a year, and nobody has said whether that year is the calendar year or the year from the member''s own enrolment anniversary. A member admitted in December and again in January has either one year''s entitlement or two, so the claim is held.'::text;
    elsif v_membership.activated_on is not null then
      select b.period_from, b.period_to into v_from, v_to
      from public.benefit_policy_year_bounds(
        v_policy.medical_benefit_year_basis,
        v_membership.activated_on,
        v_claim.event_date) b;

      select m.consumed_amount, m.consumed_claims into v_consumed, v_count
      from public.medical_benefit_consumed(
        v_claim.membership_id, v_from, v_to, p_claim_id) m;

      -- Rule 7 and 8: twice a year. This is the limit the client set, and
      -- under `no_separate_cap` it is the **whole** limit.
      if v_policy.medical_benefit_claims_per_year is not null
         and v_count >= v_policy.medical_benefit_claims_per_year then
        return query select
          'medical_claims_exhausted'::text,
          pg_catalog.format(
            'This member has %s medical claim(s) committed between %s and %s, and the policy allows %s a year.',
            v_count, v_from, v_to, v_policy.medical_benefit_claims_per_year);
      end if;

      -- The ceiling, under the mode that has one. `no_separate_cap` skips
      -- this entirely — deliberately, because that mode *is* the recorded
      -- decision that the claim count is the only limit. NULL cannot be
      -- reached: the gate above fired on it.
      if v_policy.medical_benefit_cap_mode = 'amount'
         and v_claim.discharge_at is not null then
        v_benefit := public.benefit_amount_for_claim(
          'medical', v_policy.medical_benefit_rate_bps, v_claim.bill_amount,
          v_policy.family_condolence_benefit, v_policy.member_bereavement_benefit);

        if v_consumed >= v_policy.medical_benefit_annual_cap then
          return query select
            'medical_cap_exceeded'::text,
            pg_catalog.format(
              'The member has already consumed %s of the %s shilling annual medical benefit cap. Nothing remains for this benefit year.',
              v_consumed, v_policy.medical_benefit_annual_cap);
        elsif v_consumed + v_benefit > v_policy.medical_benefit_annual_cap
           and v_policy.medical_benefit_excess_handling is distinct from 'pay_remaining' then
          -- Older policies with no explicit partial-payment decision continue
          -- to refuse a claim above the remaining ceiling.
          return query select
            'medical_cap_exceeded'::text,
            pg_catalog.format(
              'This claim is worth %s shillings, but only %s of the %s annual cap remains. The governing policy does not authorize payment of the remainder.',
              v_benefit,
              greatest(v_policy.medical_benefit_annual_cap - v_consumed, 0),
              v_policy.medical_benefit_annual_cap);
        end if;
      end if;
    end if;
  end if;

  -- --- Death-related claims: three other group members ---------------------
  --
  -- Rule 12. The death certificate is a required document and is checked with
  -- the rest of the evidence below; this is the other half.
  if v_claim.claim_type in ('family_condolence', 'member_bereavement') then
    v_confirmed := public.death_confirmation_count(p_claim_id);

    if v_policy.death_confirmations_required is null then
      return query select
        'death_confirmations_undecided'::text,
        'How many other group members must confirm a death has not been recorded, so a death-related claim cannot be assessed against it.'::text;
    elsif v_confirmed < v_policy.death_confirmations_required then
      return query select
        'death_confirmations_insufficient'::text,
        pg_catalog.format(
          '%s of the %s required confirmations from other group members have been recorded. Each one names a real membership, and the deceased does not confirm their own death.',
          v_confirmed, v_policy.death_confirmations_required);
    end if;
  end if;

  -- --- Family condolence --------------------------------------------------
  if v_claim.claim_type = 'family_condolence' then
    -- Rule 11, first half: is this relationship a family tie?
    if not exists (
      select 1 from public.beneficiary_relationships r
      where r.key = v_claim.deceased_relationship and r.condolence_eligible
    ) then
      return query select
        'relationship_not_eligible'::text,
        pg_catalog.format(
          'A %s is not an eligible family member under policy version %s. The condolence benefit covers a death in the family, and this relationship is not recorded as one.',
          coalesce((select r.label from public.beneficiary_relationships r
                     where r.key = v_claim.deceased_relationship),
                   v_claim.deceased_relationship),
          v_claim.policy_version);
    end if;

    -- Rule 11, second half: were they listed as next of kin, before the
    -- death? A record added afterwards is a record created to justify the
    -- claim, which is exactly what the brief says must not work.
    select * into v_kin from public.condolence_next_of_kin_status(p_claim_id);

    if v_claim.deceased_beneficiary_id is null or v_kin is null then
      return query select
        'next_of_kin_not_listed'::text,
        'The condolence benefit covers a family member who was listed as next of kin in the system. This claim names no such record.'::text;
    elsif not v_kin.listed_before_event then
      return query select
        'next_of_kin_listed_after_event'::text,
        pg_catalog.format(
          'Next-of-kin record %s was registered on %s, after the death on %s. A record created after the event does not establish that the person was listed before it.',
          v_kin.beneficiary_number, v_kin.registered_on, v_claim.event_date);
    elsif v_kin.beneficiary_status <> 'active' then
      return query select
        'next_of_kin_not_listed'::text,
        pg_catalog.format(
          'Next-of-kin record %s is %s, so it was not a live listing.',
          v_kin.beneficiary_number, v_kin.beneficiary_status);
    elsif not v_kin.relationship_eligible then
      return query select
        'relationship_not_eligible'::text,
        pg_catalog.format(
          'Next-of-kin record %s records the deceased as a %s, which is not an eligible family relationship.',
          v_kin.beneficiary_number, v_kin.relationship_label);
    end if;
  end if;

  -- --- Member bereavement -------------------------------------------------
  if v_claim.claim_type = 'member_bereavement' then
    select * into v_beneficiary
    from public.member_beneficiaries b
    where b.id = v_claim.beneficiary_id;

    -- Rule 13. One next of kin receives it, and that one must be verified.
    if v_claim.beneficiary_id is null or not found then
      return query select
        'beneficiary_missing'::text,
        'The bereavement benefit is payable to one registered next of kin, and this membership has no beneficiary on the claim. There is nobody the business may pay.'::text;
    elsif v_beneficiary.status <> 'active' then
      return query select
        'beneficiary_not_verified'::text,
        pg_catalog.format('Beneficiary %s is %s, so it is not a live payment instruction.',
          v_beneficiary.beneficiary_number, v_beneficiary.status);
    elsif v_beneficiary.verification_status <> 'verified' then
      return query select
        'beneficiary_not_verified'::text,
        pg_catalog.format(
          'Beneficiary %s is %s. An unverified beneficiary is a name somebody typed, and the business does not pay UGX %s to a name somebody typed.',
          v_beneficiary.beneficiary_number,
          pg_catalog.replace(v_beneficiary.verification_status, '_', ' '),
          v_policy.member_bereavement_benefit);
    end if;

    -- Rule 14. Withheld while a loan is outstanding — the client's answer to
    -- the question Phase 3 raised and Phase 4 held open.
    --
    -- Every unfinished loan of the **client**, not only member loans on this
    -- membership: an ordinary loan carries no membership_id, and Phase 4's
    -- query filtered on one.
    select
      coalesce(pg_catalog.sum(
        o.contractual_outstanding + o.penalty_outstanding), 0)::bigint,
      pg_catalog.count(*)::integer,
      pg_catalog.string_agg(
        o.loan_number || ' (' || o.status || ')', ', ' order by o.loan_number)
      into v_outstanding, v_loan_count, v_loans
    from public.client_outstanding_loans(v_claim.client_id) o;

    if v_loan_count > 0 then
      return query select
        'bereavement_loan_outstanding'::text,
        pg_catalog.format(
          'This member has %s outstanding loan(s) — %s — with %s shillings owed. The bereavement benefit is not released until the loan is fully cleared. Nothing has been netted against the benefit, no pledge released and no savings touched: the loan is repaid by a repayment, which is a separate authorised transaction.',
          v_loan_count, v_loans, v_outstanding);
    end if;
  end if;

  -- --- The evidence -------------------------------------------------------
  --
  -- A **verified** document of each required kind. Counting uploads rather
  -- than verifications would make a claim look documented with nobody having
  -- looked at anything.
  select pg_catalog.string_agg(k.label, ', ' order by k.sort_order)
    into v_missing
  from public.benefit_document_kinds k
  where k.is_required_for_assessment
    and k.claim_type = v_claim.claim_type
    and not exists (
      select 1 from public.benefit_claim_documents d
      where d.claim_id = p_claim_id
        and d.kind = k.key
        and d.verification_status = 'verified'
    );

  if v_missing is not null then
    return query select
      'evidence_missing'::text,
      pg_catalog.format(
        'These are required and have not been checked: %s. A document that has been uploaded but that nobody has checked does not establish anything.',
        v_missing);
  end if;

  -- --- Is the claim even waiting to be assessed? --------------------------
  if v_claim.status not in ('submitted', 'under_verification',
                            'information_required') then
    return query select
      'claim_not_in_assessable_state'::text,
      pg_catalog.format('Claim %s is %s.', v_claim.claim_number, v_claim.status);
  end if;

  return;
end;
$function$;


CREATE OR REPLACE FUNCTION public.assess_benefit_claim(p_claim_id uuid, p_note text DEFAULT NULL::text)
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_claim       public.benefit_claims;
  v_membership  public.memberships;
  v_policy      public.membership_policy_versions;
  -- The payee, as scalars rather than a record. A record variable is unset
  -- for the two claim types that have no payee, and PL/pgSQL raises on a
  -- field of an unassigned record.
  v_beneficiary_id uuid;
  v_beneficiary_number text;
  v_beneficiary_name text;
  v_beneficiary_relationship text;
  v_beneficiary_phone text;
  v_beneficiary_verified_at timestamptz;
  v_beneficiary_verified_by text;
  v_actor       uuid;
  v_label       text;
  v_failures    text;
  v_amount      bigint;
  v_from        date;
  v_to          date;
  v_consumed    bigint := 0;
  v_count       integer := 0;
  v_eligible    boolean;
  v_doc_count   integer;
  v_doc_kinds   text[];
  v_outstanding bigint := 0;
  v_loan_count integer := 0;
  v_pledged     bigint := 0;
  v_savings     bigint := 0;
  -- The policy update's own figures. The next-of-kin listing is held as
  -- scalars rather than as a record, for the reason stated above the payee
  -- block: a record variable is unset for the two claim types that have no
  -- such listing, and PL/pgSQL raises on a field of an unassigned record —
  -- which the INSERT below would do on every medical and bereavement claim,
  -- because it names every column for every claim type. CI found exactly
  -- that, as `record "v_kin" is not assigned yet`.
  v_qual        record;
  v_kin_number  text;
  v_kin_listed  date;
  v_confirmed   integer := 0;
  v_client_outstanding bigint := 0;
  v_client_loan_count  integer := 0;
begin
  v_actor := public.current_profile_id();
  v_label := public.audit_actor_label();

  if v_actor is null and auth.uid() is not null then
    raise exception
      'A benefit claim must be assessed by a signed-in member of staff.'
      using errcode = 'P0001';
  end if;

  if auth.uid() is not null and not public.user_has_permission('benefits:assess') then
    raise exception
      'Assessing a benefit claim requires the benefits:assess capability.'
      using errcode = 'P0001';
  end if;

  select * into v_claim from public.benefit_claims where id = p_claim_id for update;

  if not found then
    raise exception 'No such benefit claim.' using errcode = 'P0001';
  end if;

  -- The cap lock. Taken before anything is read, so two medical assessments
  -- for one member serialise and the second sees the first's commitment.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('benefit_cap:' || v_claim.membership_id::text)
  );

  -- Every rule, in one place, already written. The function is STABLE and
  -- reads the same rows this one is about to write, under the same lock.
  select pg_catalog.string_agg(
           e.failure_code || ': ' || e.detail, E'\n' order by e.failure_code)
    into v_failures
  from public.benefit_claim_eligibility(p_claim_id) e;

  if v_failures is not null then
    raise exception E'Claim % cannot be assessed.\n\n%',
      v_claim.claim_number, v_failures using errcode = 'P0001';
  end if;

  select * into v_membership from public.memberships where id = v_claim.membership_id;
  select * into v_policy
  from public.membership_policy_versions where id = v_claim.policy_version_id;

  v_amount := public.benefit_amount_for_claim(
    v_claim.claim_type, v_policy.medical_benefit_rate_bps, v_claim.bill_amount,
    v_policy.family_condolence_benefit, v_policy.member_bereavement_benefit);

  if v_amount is null or v_amount <= 0 then
    raise exception
      'Claim % assesses to nothing. A benefit of zero is a refusal, and it should be recorded as one with a reason.',
      v_claim.claim_number using errcode = 'P0001';
  end if;

  if v_claim.claim_type = 'medical' then
    select b.period_from, b.period_to into v_from, v_to
    from public.benefit_policy_year_bounds(
      v_policy.medical_benefit_year_basis, v_membership.activated_on,
      v_claim.event_date) b;

    select m.consumed_amount, m.consumed_claims into v_consumed, v_count
    from public.medical_benefit_consumed(
      v_claim.membership_id, v_from, v_to, p_claim_id) m;

    -- The cap is allocated under the per-membership advisory transaction lock
    -- acquired above. Other assessed/approved/paid claims reserve capacity.
    -- Only policy versions with an explicit choice permit a partial amount.
    if v_policy.medical_benefit_cap_mode = 'amount'
       and v_policy.medical_benefit_excess_handling = 'pay_remaining' then
      v_amount := least(
        v_amount,
        greatest(v_policy.medical_benefit_annual_cap - v_consumed, 0)
      );
      if v_amount <= 0 then
        raise exception
          'This member has no annual medical benefit allowance remaining.'
          using errcode = 'P0001';
      end if;
    end if;
  end if;

  if v_claim.claim_type = 'family_condolence' then
    select r.condolence_eligible into v_eligible
    from public.beneficiary_relationships r where r.key = v_claim.deceased_relationship;

    select k.beneficiary_number, k.registered_on
      into v_kin_number, v_kin_listed
    from public.condolence_next_of_kin_status(p_claim_id) k;
  end if;

  if v_claim.claim_type in ('family_condolence', 'member_bereavement') then
    v_confirmed := public.death_confirmation_count(p_claim_id);
  end if;

  if v_claim.claim_type = 'member_bereavement' then
    -- The payee, read across the split. SECURITY DEFINER, so it reaches
    -- `member_beneficiary_identities` without the caller holding
    -- `membership:view_sensitive` — which is right: the snapshot needs the
    -- name regardless, because a payment instruction with no name is not one.
    select b.id, b.beneficiary_number, i.full_name, b.relationship, i.phone,
           b.verified_at, b.verified_by_label
      into v_beneficiary_id, v_beneficiary_number, v_beneficiary_name,
           v_beneficiary_relationship, v_beneficiary_phone,
           v_beneficiary_verified_at, v_beneficiary_verified_by
    from public.member_beneficiaries b
    join public.member_beneficiary_identities i on i.beneficiary_id = b.id
    where b.id = v_claim.beneficiary_id;
  end if;

  -- Rule 9, frozen as of the event date rather than as of today. A deposit
  -- made between the event and the assessment does not change what the member
  -- had saved when the event happened.
  select * into v_qual
  from public.membership_savings_qualified(v_claim.membership_id, v_claim.event_date);

  -- The member's financial position. Read for every claim type, because an
  -- assessor should see what the member owes whatever they are claiming.
  --
  -- The member-loan pair, as Phase 4 recorded it: a LEFT join and a count,
  -- because a loan that is `active` with no balance row yet still means the
  -- member owes money.
  select coalesce(pg_catalog.sum(lb.principal_remaining), 0)::bigint,
         pg_catalog.count(*)::integer
    into v_outstanding, v_loan_count
  from public.loans l
  left join public.loan_balances lb on lb.loan_id = l.id
  where l.membership_id = v_claim.membership_id and l.status = 'active';

  -- And the client-wide pair rule 14 is actually about.
  select coalesce(pg_catalog.sum(
           o.contractual_outstanding + o.penalty_outstanding), 0)::bigint,
         pg_catalog.count(*)::integer
    into v_client_outstanding, v_client_loan_count
  from public.client_outstanding_loans(v_claim.client_id) o;

  select coalesce(pg_catalog.sum(p.pledged_amount), 0)::bigint into v_pledged
  from public.member_loan_savings_pledges p
  where p.membership_id = v_claim.membership_id and p.released_at is null;

  select coalesce(pg_catalog.sum(t.signed_amount), 0)::bigint into v_savings
  from public.savings_transactions t
  join public.savings_accounts a on a.id = t.savings_account_id
  where a.membership_id = v_claim.membership_id;

  select pg_catalog.count(*)::integer,
         coalesce(pg_catalog.array_agg(distinct d.kind order by d.kind), '{}')
    into v_doc_count, v_doc_kinds
  from public.benefit_claim_documents d
  where d.claim_id = p_claim_id and d.verification_status = 'verified';

  insert into public.benefit_assessment_snapshots (
    claim_id, claim_number, claim_type,
    membership_id, membership_number, client_id,
    policy_version_id, policy_version,
    assessed_on, event_date,
    benefit_rate_bps, min_admission_days, fixed_benefit_amount,
    waiting_period_days, waiting_period_served,
    qualification_basis, savings_qualifying_months, savings_months_required,
    savings_qualified,
    bill_amount, admission_nights, admission_inclusive_days, admission_elapsed_days,
    year_basis, period_from, period_to,
    medical_cap_mode, annual_cap, medical_benefit_excess_handling, claims_per_year,
    prior_claims_in_period, prior_amount_in_period, remaining_cap_before,
    deceased_relationship, relationship_eligible,
    deceased_beneficiary_id, deceased_beneficiary_number, deceased_listed_on,
    death_confirmations_required, death_confirmations_recorded,
    beneficiary_id, beneficiary_number, beneficiary_name, beneficiary_relationship,
    beneficiary_phone, beneficiary_verified_at, beneficiary_verified_by_label,
    outstanding_member_loan_principal, active_member_loan_count,
    outstanding_loan_principal, outstanding_loan_count,
    pledged_savings, savings_balance,
    verified_document_count, verified_document_kinds,
    assessed_amount, assessment_note,
    assessed_by, assessed_by_label
  )
  values (
    p_claim_id, v_claim.claim_number, v_claim.claim_type,
    v_claim.membership_id, v_membership.membership_number, v_claim.client_id,
    v_claim.policy_version_id, v_claim.policy_version,
    public.business_date(), v_claim.event_date,
    case when v_claim.claim_type = 'medical'
      then v_policy.medical_benefit_rate_bps end,
    case when v_claim.claim_type = 'medical'
      then v_policy.medical_benefit_min_admission_days end,
    case when v_claim.claim_type <> 'medical' then v_amount end,
    v_policy.benefit_waiting_period_days, true,
    v_policy.benefit_qualification_basis,
    v_qual.qualifying_months, v_qual.months_required, v_qual.qualifies,
    v_claim.bill_amount,
    v_claim.admission_nights, v_claim.admission_inclusive_days,
    v_claim.admission_elapsed_days,
    case when v_claim.claim_type = 'medical'
      then v_policy.medical_benefit_year_basis end,
    v_from, v_to,
    case when v_claim.claim_type = 'medical'
      then v_policy.medical_benefit_cap_mode end,
    case when v_claim.claim_type = 'medical'
      then v_policy.medical_benefit_annual_cap end,
    case when v_claim.claim_type = 'medical'
      then v_policy.medical_benefit_excess_handling end,
    case when v_claim.claim_type = 'medical'
      then v_policy.medical_benefit_claims_per_year end,
    case when v_claim.claim_type = 'medical' then v_count end,
    case when v_claim.claim_type = 'medical' then v_consumed end,
    case when v_claim.claim_type = 'medical' and v_policy.medical_benefit_annual_cap is not null
      then greatest(v_policy.medical_benefit_annual_cap - v_consumed, 0) end,
    v_claim.deceased_relationship, v_eligible,
    v_claim.deceased_beneficiary_id, v_kin_number, v_kin_listed,
    case when v_claim.claim_type in ('family_condolence', 'member_bereavement')
      then v_policy.death_confirmations_required end,
    case when v_claim.claim_type in ('family_condolence', 'member_bereavement')
      then v_confirmed end,
    v_beneficiary_id, v_beneficiary_number, v_beneficiary_name,
    v_beneficiary_relationship, v_beneficiary_phone,
    v_beneficiary_verified_at, v_beneficiary_verified_by,
    v_outstanding, v_loan_count,
    v_client_outstanding, v_client_loan_count,
    v_pledged, greatest(v_savings, 0),
    v_doc_count, v_doc_kinds,
    v_amount, nullif(pg_catalog.btrim(coalesce(p_note, '')), ''),
    v_actor, v_label
  );

  update public.benefit_claims
     set status = 'assessed', assessed_amount = v_amount,
         assessed_at = pg_catalog.now(),
         assessed_by = v_actor,
         assessed_by_label = v_label,
         assessment_note = nullif(pg_catalog.btrim(coalesce(p_note, '')), ''),
         information_required_note = null
   where id = p_claim_id;

  return v_amount;
end;
$function$;


-- No benefit claim is modified by this migration. No payment is posted.
