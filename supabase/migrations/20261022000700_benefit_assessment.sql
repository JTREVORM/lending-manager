-- ===========================================================================
-- Polytos Phase 4.7 — the assessment, and every rule nobody has decided
--
-- ## Why this is the most important migration in the phase
--
-- Every control described in §9 to §13 of the Phase 4 brief can be written
-- into a form, and every one of them can then be defeated by a POST. The only
-- control that holds against a forged request, a leaked key, a stray `UPDATE`,
-- a Server Action somebody adds next year and a `psql` session is a control
-- inside the function that writes the assessment.
--
-- So the rules live in `benefit_claim_eligibility()`, which
-- `assess_benefit_claim()` refuses on, and in `assess_benefit_claim()` itself
-- for the things that must happen atomically with the write. Nothing about
-- benefit eligibility is checked only in TypeScript.
--
-- ## The arithmetic
--
-- 5% of a hospital bill is
--
--     (bill * rate_bps + 5000) / 10000
--
-- in `bigint`, which is exactly half-up for non-negative operands and is the
-- form the loan engine, the penalty engine and the member-loan engine all
-- already use. `bill * 0.05` in JavaScript is 30000.000000000004 on the wrong
-- bill, and `scripts/audit-financial-arithmetic.mjs` fails the build on it.
--
-- On a UGX 400,000 bill at 500 bps: (400000 * 500 + 5000) / 10000 = 20000.
--
-- The two fixed benefits are read from the policy version — UGX 100,000 and
-- UGX 200,000 in version 1.0 — rather than written here, because a figure in
-- a posting function cannot be effective-dated and a member enrolled under
-- the old amount must keep it.
--
-- ## The failure codes, and why they are returned rather than raised
--
-- `benefit_claim_eligibility` returns codes, the way
-- `validate_loan_for_approval` does, so an assessment screen can list every
-- reason at once instead of revealing them one refusal at a time. A claimant
-- told "no verified beneficiary" who fixes that and is then told "outside the
-- waiting period" has been made to come back twice for information the
-- business had on the first visit.
--
--   `policy_not_open`                 benefits are not open under the
--                                     claim's own policy version
--   `membership_not_claimable`        pending or withdrawn
--   `membership_suspended_undecided`  suspended, and nobody has decided what
--                                     suspension costs a member
--   `waiting_period_not_served`       the event is inside the waiting period
--   `admission_not_ended`             no discharge recorded, so no length
--   `admission_too_short`             under the threshold on every reading
--   `admission_measure_undecided`     the readings disagree, and nobody has
--                                     said which one counts
--   `medical_year_basis_undecided`    the annual period is undefined, so the
--                                     cap cannot be applied
--   `medical_claims_exhausted`        the year's claim count is spent
--   `medical_cap_exceeded`            the benefit would exceed what is left
--                                     of the annual cap, and partial payment
--                                     is undefined
--   `evidence_missing`                a required document kind has no
--                                     verified document
--   `relationship_eligibility_undecided`
--                                     nobody has defined an eligible family
--                                     member
--   `beneficiary_missing`             no beneficiary is registered
--   `beneficiary_not_verified`        one is registered and unchecked
--   `bereavement_loan_offset_undecided`
--                                     the member owes money, and nobody has
--                                     decided whether the benefit is reduced
--   `claim_not_in_assessable_state`   the claim is not waiting to be assessed
--
-- Seven of those sixteen are the words "nobody has decided". That is the
-- phase, honestly reported: the client's documents confirm three amounts and
-- one rate, and leave the ceiling, the period, the measure, the eligible
-- relative, the consequence of suspension and the loan interaction open.
-- Every one of them is a refusal with the decision named, never a default.
--
-- ## The three readings of "an admission longer than one day"
--
-- The documents say the admission must be "longer than one day" and the
-- schema stores the threshold as a number the admission must *exceed*. What
-- nobody has said is what is being counted. Three readings are defensible:
--
--   nights          Mon 22:00 → Tue 09:00 is 1
--   inclusive days  the same stay is 2, which is what a ward chart says
--   elapsed days    the same stay is 0, which is what a clock says
--
-- All three are computed and stored on the claim. The assessment requires
-- **every** reading to exceed the threshold, and refuses with
-- `admission_measure_undecided` when they disagree. So a stay that qualifies
-- on any reading is never quietly paid, a stay that qualifies on all of them
-- never waits for a decision it does not need, and the business is never
-- exposed to the generous reading by accident. This is the same discipline
-- Phase 3 applied to the four interest basis/method combinations: implement
-- every arm, refuse the one that is not a calculation, default nothing.
--
-- ## The annual period, which is a tenth decision
--
-- The client's nine questions do not include one, and §9 of the brief names
-- it: is the medical cap a calendar year or an anniversary year? It cannot be
-- guessed — a member admitted in December and again in January has either one
-- year's cap or two — so it is a new nullable column,
-- `medical_benefit_year_basis`, with both arms implemented and no default.
--
-- It is deliberately **not** added to the generated `is_benefits_enabled`
-- column, for the reason ADR-059 gave for keeping the monthly anchor off the
-- policy's lending gate: it bears on one benefit rather than on the activity.
-- Condolence and bereavement claims have no annual cap and do not wait on it;
-- only a medical assessment does, and it is refused with its own code. A gate
-- that held the whole benefits module hostage to a rule two of its three
-- benefits do not use would be the `is_financially_enabled` mistake again.
--
-- ## Concurrency
--
-- Two medical claims for one member must not independently consume the same
-- remaining cap. `assess_benefit_claim` takes an advisory lock on the
-- membership before it reads the year's consumption, so the second
-- assessment sees the first.
--
-- Consumption counts `assessed`, `approved` **and** `paid` claims — not paid
-- alone. A cap that counted only completed payments would let two approvals
-- share one member's ceiling and leave the business committed to twice what
-- it meant to be: §9 of the brief is explicit, and it is the one place where
-- the absence of a payable account on the balance sheet (20261022000200) has
-- no consequence, because the *obligation* is recognised here regardless.
--
-- A `reversed` claim releases its capacity, because the money came back. It
-- does not reopen: `reversed` is terminal, and nothing about a reversal
-- reinstates a claim or revives a rejected one.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- The tenth decision
-- ---------------------------------------------------------------------------

alter table public.membership_policy_versions
  add column if not exists medical_benefit_year_basis text;

alter table public.membership_policy_versions
  drop constraint if exists membership_policy_medical_year_basis_valid;

alter table public.membership_policy_versions
  add constraint membership_policy_medical_year_basis_valid
  check (
    medical_benefit_year_basis is null
    or medical_benefit_year_basis in ('calendar_year', 'enrolment_anniversary')
  );

comment on column public.membership_policy_versions.medical_benefit_year_basis is
  'Polytos Phase 4. Whether the medical benefit''s annual cap and claim count run over the calendar year or over the year from the member''s own enrolment anniversary. NULL means the client has not decided; there is no default, because a member admitted in December and again in January has either one year''s cap or two. Deliberately not part of is_benefits_enabled: condolence and bereavement claims do not use it, and a gate that held the whole module hostage to a rule two of its three benefits ignore would be the single-switch mistake again.';

-- ---------------------------------------------------------------------------
-- benefit_amount_for_claim()
--
-- The whole of the benefit arithmetic, in one place that a test can drive
-- directly. Integer throughout, half-up by construction.
-- ---------------------------------------------------------------------------

create or replace function public.benefit_amount_for_claim(
  p_claim_type text,
  p_rate_bps integer,
  p_bill_amount bigint,
  p_condolence_benefit bigint,
  p_bereavement_benefit bigint
)
returns bigint
language sql
immutable
set search_path = ''
as $$
  select case p_claim_type
    -- (bill * bps + 5000) / 10000. Exactly half-up for non-negative
    -- operands, and never floating point: `bill * 0.05` is 30000.000000000004
    -- on the wrong bill, and across a year of postings that is a ledger that
    -- does not balance.
    when 'medical' then (p_bill_amount * p_rate_bps + 5000) / 10000
    when 'family_condolence' then p_condolence_benefit
    when 'member_bereavement' then p_bereavement_benefit
  end;
$$;

comment on function public.benefit_amount_for_claim(text, integer, bigint, bigint, bigint) is
  'Polytos Phase 4. What a benefit of this type is worth before caps: (bill * rate_bps + 5000) / 10000 in bigint for medical — half-up, never floating point — and the policy''s fixed figure for the other two. NULL for an unrecognised type, which every caller treats as a refusal.';

revoke all on function public.benefit_amount_for_claim(text, integer, bigint, bigint, bigint)
  from public, anon;
grant execute on function public.benefit_amount_for_claim(text, integer, bigint, bigint, bigint)
  to authenticated;

-- ---------------------------------------------------------------------------
-- benefit_policy_year_bounds()
--
-- The window the cap and the claim count are measured over. Both arms, no
-- default: a NULL basis yields NULL bounds, and the caller refuses.
--
-- The anniversary arm is written against `activated_on` rather than
-- `applied_on`, because the benefit year is a year of *membership* and a
-- pending application is not one.
-- ---------------------------------------------------------------------------

create or replace function public.benefit_policy_year_bounds(
  p_basis text,
  p_activated_on date,
  p_event_date date
)
returns table (period_from date, period_to date)
language sql
immutable
set search_path = ''
as $$
  select
    case p_basis
      when 'calendar_year' then
        pg_catalog.make_date(pg_catalog.date_part('year', p_event_date)::int, 1, 1)
      when 'enrolment_anniversary' then
        -- The anniversary on or before the event. Whole years since
        -- activation, added back to the activation date — which handles 29
        -- February correctly, because `date + interval 'n years'` clamps.
        (p_activated_on
          + (pg_catalog.floor(
               pg_catalog.date_part('year', p_event_date)
               - pg_catalog.date_part('year', p_activated_on)
               - case
                   when (pg_catalog.date_part('month', p_event_date),
                         pg_catalog.date_part('day', p_event_date))
                      < (pg_catalog.date_part('month', p_activated_on),
                         pg_catalog.date_part('day', p_activated_on))
                     then 1 else 0
                 end
             )::int || ' years')::interval)::date
    end as period_from,
    case p_basis
      when 'calendar_year' then
        pg_catalog.make_date(pg_catalog.date_part('year', p_event_date)::int, 12, 31)
      when 'enrolment_anniversary' then
        ((p_activated_on
          + (pg_catalog.floor(
               pg_catalog.date_part('year', p_event_date)
               - pg_catalog.date_part('year', p_activated_on)
               - case
                   when (pg_catalog.date_part('month', p_event_date),
                         pg_catalog.date_part('day', p_event_date))
                      < (pg_catalog.date_part('month', p_activated_on),
                         pg_catalog.date_part('day', p_activated_on))
                     then 1 else 0
                 end
             )::int || ' years')::interval)
          + interval '1 year' - interval '1 day')::date
    end as period_to;
$$;

comment on function public.benefit_policy_year_bounds(text, date, date) is
  'Polytos Phase 4. The benefit year containing an event, under either basis. NULL bounds for a NULL basis, which is how an undecided annual period reaches the caller as a refusal rather than as a guess.';

revoke all on function public.benefit_policy_year_bounds(text, date, date) from public, anon;
grant execute on function public.benefit_policy_year_bounds(text, date, date) to authenticated;

-- ---------------------------------------------------------------------------
-- medical_benefit_consumed()
--
-- What a member has already committed of their year, in money and in claims.
-- Counts assessed, approved and paid — see the header on why not paid alone.
--
-- SECURITY DEFINER with a capability gate, because the honest alternative is
-- worse: as INVOKER the figure would silently fall to zero for a caller who
-- cannot read every one of the member's claims, and a cap computed from a
-- partial view of the history is a cap that over-approves. `benefits:assess`
-- is the capability, because this figure is an input to an assessment and to
-- nothing else.
-- ---------------------------------------------------------------------------

create or replace function public.medical_benefit_consumed(
  p_membership_id uuid,
  p_period_from date,
  p_period_to date,
  p_exclude_claim_id uuid default null
)
returns table (consumed_amount bigint, consumed_claims integer)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.user_has_permission('benefits:assess')
     and not public.user_has_permission('benefits:approve') then
    raise exception 'permission denied for benefit consumption'
      using errcode = '42501';
  end if;

  return query
    select
      coalesce(pg_catalog.sum(
        coalesce(c.approved_amount, c.assessed_amount)), 0)::bigint,
      pg_catalog.count(*)::integer
    from public.benefit_claims c
    where c.membership_id = p_membership_id
      and c.claim_type = 'medical'
      and c.status in ('assessed', 'approved', 'paid')
      and c.event_date between p_period_from and p_period_to
      and (p_exclude_claim_id is null or c.id <> p_exclude_claim_id);
end;
$$;

comment on function public.medical_benefit_consumed(uuid, date, date, uuid) is
  'Polytos Phase 4. What a member has committed of their medical benefit year: the money and the claim count, over assessed, approved and paid claims. Counting paid alone would let two approvals share one ceiling. A reversed claim is absent, because the money came back.';

revoke all on function public.medical_benefit_consumed(uuid, date, date, uuid)
  from public, anon;
grant execute on function public.medical_benefit_consumed(uuid, date, date, uuid)
  to authenticated;

-- ---------------------------------------------------------------------------
-- benefit_claim_eligibility()
--
-- Every rule, as codes. The order is the order a reader would ask the
-- questions in — is the programme open, is this person a member, has the
-- waiting period passed, is the event what it claims to be, is there evidence,
-- is there a payee — because that is the order the assessment screen lists
-- them in and reordering it would change which refusal a reader sees first.
-- ---------------------------------------------------------------------------

create or replace function public.benefit_claim_eligibility(p_claim_id uuid)
returns table (failure_code text, detail text)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_claim      public.benefit_claims;
  v_membership public.memberships;
  v_policy     public.membership_policy_versions;
  v_threshold  smallint;
  v_benefit    bigint;
  v_from       date;
  v_to         date;
  v_consumed   bigint;
  v_count      integer;
  v_missing    text;
  v_eligible   boolean;
  v_beneficiary public.member_beneficiaries;
  v_outstanding bigint;
  v_loan_count integer;
begin
  select * into v_claim from public.benefit_claims where id = p_claim_id;

  if not found then
    return;
  end if;

  select * into v_membership
  from public.memberships where id = v_claim.membership_id;

  select * into v_policy
  from public.membership_policy_versions where id = v_claim.policy_version_id;

  -- --- Is the programme open at all? -------------------------------------
  --
  -- `membership_policy_allows` is the authoritative gate: the generated
  -- readiness column *and* the effective date. Asked first, because when it
  -- is shut nothing below it matters and a screen that listed six further
  -- objections would bury the one that counts.
  if not public.membership_policy_allows(v_claim.policy_version_id, 'benefits') then
    return query select
      'policy_not_open'::text,
      pg_catalog.format(
        'Benefit payments are not open under policy version %s. The medical annual cap, the claims a member may make in a year and the benefit waiting period are undecided, and a benefit cannot be assessed against rules nobody has set.',
        v_claim.policy_version);
  end if;

  -- --- Is this a member who may claim? -----------------------------------
  if v_membership.status not in ('active', 'suspended', 'deceased') then
    return query select
      'membership_not_claimable'::text,
      pg_catalog.format('Membership %s is %s.',
        v_membership.membership_number, v_membership.status);
  end if;

  -- A bereavement claim is the one claim a deceased membership may make.
  -- The others cannot: a medical claim for a member who has since died is a
  -- real case, but nobody has said whether it is payable and to whom, and
  -- that is the client's question rather than this function's guess.
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

  -- --- The waiting period ------------------------------------------------
  --
  -- Measured from activation, not application: the clock is a year of
  -- membership and a pending application is not one. A NULL waiting period
  -- cannot be reached here, because `policy_not_open` above already fired on
  -- it — this is the arm for a decided one.
  if v_policy.benefit_waiting_period_days is not null then
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
      -- Every reading must clear the threshold. See the header: the
      -- readings disagree for a stay of about a day, and which one counts is
      -- the client's to say.
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

    -- The annual period, and then the cap and the count within it.
    if v_policy.medical_benefit_year_basis is null then
      return query select
        'medical_year_basis_undecided'::text,
        'The medical benefit''s annual cap and claim count run over a year, and nobody has said whether that year is the calendar year or the year from the member''s own enrolment anniversary. A member admitted in December and again in January has either one year''s cap or two, so the claim is held.'::text;
    elsif v_membership.activated_on is not null then
      select b.period_from, b.period_to into v_from, v_to
      from public.benefit_policy_year_bounds(
        v_policy.medical_benefit_year_basis,
        v_membership.activated_on,
        v_claim.event_date) b;

      select m.consumed_amount, m.consumed_claims into v_consumed, v_count
      from public.medical_benefit_consumed(
        v_claim.membership_id, v_from, v_to, p_claim_id) m;

      if v_policy.medical_benefit_claims_per_year is not null
         and v_count >= v_policy.medical_benefit_claims_per_year then
        return query select
          'medical_claims_exhausted'::text,
          pg_catalog.format(
            'This member has %s medical claim(s) committed between %s and %s, and the policy allows %s a year.',
            v_count, v_from, v_to, v_policy.medical_benefit_claims_per_year);
      end if;

      if v_policy.medical_benefit_annual_cap is not null and v_claim.discharge_at is not null then
        v_benefit := public.benefit_amount_for_claim(
          'medical', v_policy.medical_benefit_rate_bps, v_claim.bill_amount,
          v_policy.family_condolence_benefit, v_policy.member_bereavement_benefit);

        if v_consumed + v_benefit > v_policy.medical_benefit_annual_cap then
          -- Not part-paid. Whether an eligible claim may be paid in part, and
          -- whether a claim above the cap is paid up to it or refused
          -- outright, are two readings the client has not chosen between —
          -- and inventing either would be inventing how much the business
          -- pays. §9 of the brief says block rather than invent.
          return query select
            'medical_cap_exceeded'::text,
            pg_catalog.format(
              'This claim is worth %s shillings. The member has committed %s of a %s annual cap between %s and %s, leaving %s. Whether a claim above the cap is paid up to it or refused outright is undecided, so it is held rather than part-paid.',
              v_benefit, v_consumed, v_policy.medical_benefit_annual_cap,
              v_from, v_to,
              greatest(v_policy.medical_benefit_annual_cap - v_consumed, 0));
        end if;
      end if;
    end if;
  end if;

  -- --- Family condolence --------------------------------------------------
  if v_claim.claim_type = 'family_condolence' then
    select r.condolence_eligible into v_eligible
    from public.beneficiary_relationships r
    where r.key = v_claim.deceased_relationship;

    if v_eligible is null then
      return query select
        'relationship_eligibility_undecided'::text,
        pg_catalog.format(
          'Nobody has defined which family members the condolence benefit covers, so whether a %s qualifies is unanswered. The claim is recorded and held.',
          coalesce((select r.label from public.beneficiary_relationships r
                     where r.key = v_claim.deceased_relationship),
                   v_claim.deceased_relationship));
    elsif not v_eligible then
      return query select
        'relationship_not_eligible'::text,
        pg_catalog.format(
          'A %s is not an eligible family member under policy version %s.',
          (select r.label from public.beneficiary_relationships r
            where r.key = v_claim.deceased_relationship),
          v_claim.policy_version);
    end if;
  end if;

  -- --- Member bereavement -------------------------------------------------
  if v_claim.claim_type = 'member_bereavement' then
    select * into v_beneficiary
    from public.member_beneficiaries b
    where b.id = v_claim.beneficiary_id;

    if v_claim.beneficiary_id is null or not found then
      return query select
        'beneficiary_missing'::text,
        'The bereavement benefit is payable to the registered next of kin, and this membership has no beneficiary on the claim. There is nobody the business may pay.'::text;
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

    -- The loan boundary. Phase 3 recorded that nobody has decided whether a
    -- bereavement benefit is reduced, withheld, offset or unaffected by an
    -- outstanding member loan. Where the member owes nothing, the question
    -- does not arise and the claim proceeds; where they owe something, the
    -- amount payable depends on an unresolved rule, so it is held.
    --
    -- Nothing here nets anything, releases a pledge or touches the savings
    -- balance. The figures are shown to the assessor (see
    -- `benefit_claim_assessment_context`) and acted on by nobody.
    -- A LEFT join and a count. A loan that is `active` with no balance row
    -- yet still means the member owes money, and an inner join would make it
    -- invisible — so the refusal reads the count and the message reads the
    -- sum.
    select coalesce(pg_catalog.sum(b.principal_remaining), 0)::bigint,
           pg_catalog.count(*)::integer
      into v_outstanding, v_loan_count
    from public.loans l
    left join public.loan_balances b on b.loan_id = l.id
    where l.membership_id = v_claim.membership_id
      and l.status = 'active';

    if v_loan_count > 0 then
      return query select
        'bereavement_loan_offset_undecided'::text,
        pg_catalog.format(
          'This member holds %s live member loan(s), with %s shillings of principal outstanding. Whether a bereavement benefit is reduced by an outstanding loan, withheld, offset against pledged savings, or unaffected, is undecided — so the amount payable cannot be determined and the claim is held. Nothing has been netted, no pledge released and no savings touched.',
          v_loan_count, v_outstanding);
    end if;
  end if;

  -- --- The evidence -------------------------------------------------------
  --
  -- A **verified** document of each required kind. Counting uploads rather
  -- than verifications is the decorative-evidence failure §12 warns about:
  -- the claim would look documented and nobody would have looked at anything.
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
$$;

comment on function public.benefit_claim_eligibility(uuid) is
  'Polytos Phase 4. Every reason a benefit claim cannot be assessed, as codes rather than one raise, so an assessment screen lists them all at once. Seven of the sixteen codes are an undecided client rule named explicitly; none is a default.';

revoke all on function public.benefit_claim_eligibility(uuid) from public, anon;
grant execute on function public.benefit_claim_eligibility(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- The evidence of the decision
--
-- The Phase 3 snapshot pattern, append-only, with its constraints restating
-- the rules — so a row recording an assessment above the cap, or of an
-- unverified beneficiary, cannot exist by any route. That is what makes the
-- row evidence rather than a claim about what somebody did.
-- ---------------------------------------------------------------------------

create table public.benefit_assessment_snapshots (
  claim_id uuid primary key references public.benefit_claims(id) on delete restrict,

  claim_number text not null,
  claim_type text not null,

  membership_id uuid not null references public.memberships(id) on delete restrict,
  membership_number text not null,
  client_id uuid not null references public.clients(id) on delete restrict,

  policy_version_id uuid not null
    references public.membership_policy_versions(id) on delete restrict,
  policy_version text not null,

  -- The business date the assessment was made against. Everything below is
  -- "as of" this, and a document verified afterwards does not change any of
  -- it.
  assessed_on date not null,
  event_date date not null,

  -- --- The rules that were in force -------------------------------------

  benefit_rate_bps integer,
  min_admission_days smallint,
  fixed_benefit_amount bigint,
  waiting_period_days smallint not null,
  waiting_period_served boolean not null,

  -- --- The medical arithmetic -------------------------------------------

  bill_amount bigint,
  admission_nights integer,
  admission_inclusive_days integer,
  admission_elapsed_days integer,

  year_basis text,
  period_from date,
  period_to date,
  annual_cap bigint,
  claims_per_year smallint,
  prior_claims_in_period integer,
  prior_amount_in_period bigint,
  remaining_cap_before bigint,

  -- --- The condolence and bereavement facts ------------------------------

  deceased_relationship text,
  relationship_eligible boolean,

  -- The payee, copied. This is the point of the table for a bereavement
  -- claim: a later change to the beneficiary record cannot rewrite what the
  -- business authorised, because the authorisation carries its own copy.
  beneficiary_id uuid references public.member_beneficiaries(id) on delete restrict,
  beneficiary_number text,
  beneficiary_name text,
  beneficiary_relationship text,
  beneficiary_phone text,
  beneficiary_verified_at timestamptz,
  beneficiary_verified_by_label text,

  -- What the member owed when the business decided. Recorded, never netted —
  -- see this migration's header on the loan boundary.
  --
  -- The count as well as the sum, because a loan that is `active` with no
  -- balance row yet still means the member owes money, and a bereavement
  -- snapshot has to be refusable on the fact rather than on the figure.
  outstanding_member_loan_principal bigint not null default 0,
  active_member_loan_count integer not null default 0,
  pledged_savings bigint not null default 0,
  savings_balance bigint not null default 0,

  -- --- The documents relied on -------------------------------------------

  verified_document_count integer not null,
  -- The kinds that were verified, as a sorted array. Enough to answer "what
  -- did the business look at" without copying the documents themselves into
  -- a second place they would have to be protected in.
  verified_document_kinds text[] not null,

  -- --- The answer --------------------------------------------------------

  assessed_amount bigint not null,
  assessment_note text,

  assessed_by uuid references public.profiles(id) on delete set null,
  assessed_by_label text not null,
  captured_at timestamptz not null default pg_catalog.now(),

  constraint benefit_snapshot_type_valid
    check (claim_type in ('medical', 'family_condolence', 'member_bereavement')),
  constraint benefit_snapshot_amount_non_negative
    check (assessed_amount >= 0 and assessed_amount <= 1000000000),
  constraint benefit_snapshot_waiting_served check (waiting_period_served),
  constraint benefit_snapshot_year_basis_valid
    check (
      year_basis is null
      or year_basis in ('calendar_year', 'enrolment_anniversary')
    ),
  -- The medical shape. A medical snapshot carries the bill, the readings, the
  -- period and the cap arithmetic; the others carry none of it.
  constraint benefit_snapshot_medical_shape
    check (
      case claim_type
        when 'medical' then
          bill_amount is not null
          and benefit_rate_bps is not null
          and admission_nights is not null
          and year_basis is not null
          and period_from is not null
          and period_to is not null
          and prior_claims_in_period is not null
          and prior_amount_in_period is not null
        else
          bill_amount is null
          and admission_nights is null
          and admission_inclusive_days is null
          and admission_elapsed_days is null
          and fixed_benefit_amount is not null
      end
    ),
  -- The rule the business applied, as a constraint. A medical snapshot whose
  -- amount is not the policy rate applied to the bill is not evidence.
  constraint benefit_snapshot_medical_arithmetic
    check (
      claim_type <> 'medical'
      or assessed_amount = (bill_amount * benefit_rate_bps + 5000) / 10000
    ),
  -- And it is within what was left of the cap. A snapshot recording an
  -- over-cap assessment cannot be stored by any route.
  constraint benefit_snapshot_within_cap
    check (
      claim_type <> 'medical'
      or annual_cap is null
      or prior_amount_in_period + assessed_amount <= annual_cap
    ),
  constraint benefit_snapshot_within_claim_count
    check (
      claim_type <> 'medical'
      or claims_per_year is null
      or prior_claims_in_period < claims_per_year
    ),
  constraint benefit_snapshot_admission_exceeds_threshold
    check (
      claim_type <> 'medical'
      or (admission_nights > min_admission_days
          and admission_inclusive_days > min_admission_days
          and admission_elapsed_days > min_admission_days)
    ),
  -- A fixed benefit is the policy's figure, exactly. Neither of the two is
  -- capped, counted or pro-rated, so there is nothing for the amount to be
  -- other than the figure.
  constraint benefit_snapshot_fixed_arithmetic
    check (
      claim_type = 'medical' or assessed_amount = fixed_benefit_amount
    ),
  -- A condolence snapshot records an eligible relationship. `relationship_
  -- eligible` cannot be NULL here, because an undecided relationship is a
  -- refusal rather than an assessment.
  constraint benefit_snapshot_condolence_shape
    check (
      claim_type <> 'family_condolence'
      or (deceased_relationship is not null and relationship_eligible)
    ),
  -- A bereavement snapshot records a verified payee, by copy. This is the
  -- constraint that makes "do not pay an unverified beneficiary" a property
  -- of the database rather than a rule in a function.
  constraint benefit_snapshot_bereavement_shape
    check (
      claim_type <> 'member_bereavement'
      or (beneficiary_id is not null
          and beneficiary_number is not null
          and beneficiary_name is not null
          and beneficiary_phone is not null
          and beneficiary_verified_at is not null
          and beneficiary_verified_by_label is not null)
    ),
  -- And the loan question did not arise. Phase 3's unresolved offset rule, as
  -- a constraint: a bereavement assessment against an outstanding member loan
  -- cannot be stored, so no route can produce one and then pay it.
  constraint benefit_snapshot_bereavement_no_open_loan
    check (
      claim_type <> 'member_bereavement'
      or (outstanding_member_loan_principal = 0
          and active_member_loan_count = 0)
    ),
  constraint benefit_snapshot_counts_non_negative
    check (
      verified_document_count >= 0
      and coalesce(prior_claims_in_period, 0) >= 0
      and coalesce(prior_amount_in_period, 0) >= 0
      and outstanding_member_loan_principal >= 0
      and active_member_loan_count >= 0
      and pledged_savings >= 0
      and savings_balance >= 0
    ),
  constraint benefit_snapshot_assessor_label_not_blank
    check (btrim(assessed_by_label) <> ''),
  constraint benefit_snapshot_note_length
    check (assessment_note is null or char_length(btrim(assessment_note)) <= 4000)
);

comment on table public.benefit_assessment_snapshots is
  'Polytos Phase 4. The assessment a benefit claim was decided on, frozen. Append-only: a later document, policy change or beneficiary change cannot rewrite what the business relied on. Its constraints restate the rules, so a row recording an over-cap assessment, a short admission, an ineligible relationship, an unverified payee or a bereavement against an outstanding loan cannot exist.';
comment on column public.benefit_assessment_snapshots.beneficiary_name is
  'The payee''s name, copied at assessment. The reason the table exists for a bereavement claim: a later change to the beneficiary record cannot redirect a payment the business has already authorised, because the authorisation carries its own copy.';
comment on column public.benefit_assessment_snapshots.outstanding_member_loan_principal is
  'What the member owed when the business decided. Recorded, never netted. Constrained to zero on a bereavement snapshot, because whether a benefit is reduced by an outstanding loan is undecided and a snapshot that implied an answer would be the invented policy this phase refuses to write.';
comment on column public.benefit_assessment_snapshots.verified_document_kinds is
  'Which kinds of evidence had been checked. Enough to answer "what did the business look at" without copying medical documents into a second place they would have to be protected in.';

create index benefit_snapshots_membership_idx
  on public.benefit_assessment_snapshots (membership_id, event_date desc);
create index benefit_snapshots_client_idx
  on public.benefit_assessment_snapshots (client_id);
create index benefit_snapshots_beneficiary_idx
  on public.benefit_assessment_snapshots (beneficiary_id)
  where beneficiary_id is not null;

create trigger benefit_snapshots_no_update
  before update on public.benefit_assessment_snapshots
  for each row execute function public.reject_mutation();

create trigger benefit_snapshots_no_delete
  before delete on public.benefit_assessment_snapshots
  for each row execute function public.reject_mutation();
