-- ===========================================================================
-- Polytos business-policy update — the benefit rules the client answered
-- ===========================================================================
--
-- Five of the fifteen rules land in `benefit_claim_eligibility`, and they land
-- there together because it is one function and rewriting it five times would
-- leave four intermediate versions nobody ever ran:
--
--   rule 7  — 5% of the bill, twice a year. The frequency is a limit; the
--             **monetary ceiling is a separate decision** and is read through
--             `medical_benefit_cap_mode` rather than inferred from a NULL.
--   rule 9  — a confirmed member who has been **saving for at least six
--             months**, read from the authoritative savings qualification as
--             of the claim's own event date, not from a day count.
--   rule 10 — the benefit year runs from the member's entry date.
--   rule 12 — a death certificate and three other group members.
--   rule 13 — one next of kin receives the bereavement benefit.
--   rule 14 — the bereavement benefit is withheld while a loan is
--             outstanding.
--
-- And rule 11's second half — the deceased was listed as next of kin before
-- the death — which the previous migration gave a column and this one gives
-- teeth.
--
-- ## The gate is now per benefit
--
-- `policy_not_open` asked `membership_policy_allows(..., 'benefits')`, which
-- is every benefit at once. A condolence claim held because nobody has
-- recorded whether the *medical* benefit has a shilling ceiling is a refusal
-- that makes no sense to the person reading it. Each claim type now asks its
-- own gate and reports `benefit_blocked_reason` for that benefit, which names
-- the decisions that benefit is actually waiting on.
--
-- ## Rule 9 is a savings rule, and that is the point
--
-- The brief is blunt: "The client's rule is not simply 'wait 180 days'." A
-- member who joined in January and saved nothing has served any day-count
-- waiting period and has saved for zero months. So under
-- `benefit_qualification_basis = 'savings_qualifying_months'` the check is
-- `member_savings_qualification` as of the **event date** — which judges each
-- contribution month against the minimum that governed the member in that
-- month, so a later policy transition cannot retrospectively take away a
-- member's entitlement to a benefit they had already earned.
--
-- "As of the event date" is doing work. A member who did not qualify when the
-- hospital admitted them does not become eligible by saving afterwards, and a
-- member who did qualify then does not lose it by withdrawing later. The
-- assessment snapshot records the answer, so a deposit made after an
-- assessment cannot silently rewrite the decision — which is §10's
-- requirement, and the reason the figures are frozen rather than recomputed.
--
-- ## Rule 14 replaces an undecided question with an answer
--
-- Phase 4 held a bereavement claim with `bereavement_loan_offset_undecided`,
-- because nobody had said whether the benefit was reduced, withheld or
-- unaffected by an outstanding loan. The client has now said: **withheld
-- until there is no outstanding loan.** So:
--
--   - the refusal code becomes `bereavement_loan_outstanding`, which is a
--     statement about this claim rather than about an open question;
--   - it reads **every** unfinished loan of the client, not only member loans
--     on this membership — the brief says "all applicable outstanding loans,
--     not only the special member-loan product", and Phase 4's query filtered
--     on `membership_id`, which an ordinary loan does not carry;
--   - nothing is netted. No offset, no pledge release, no savings movement,
--     no change to the loan. The benefit waits; the loan is repaid by a
--     repayment, which is a separate authorised transaction.
--
-- ## What is still undecided, and still refused by name
--
--   - the medical monetary ceiling, when the cap mode is unrecorded;
--   - whether a benefit may be paid **in part**, which is why a claim over an
--     `amount` cap is refused rather than trimmed;
--   - whether a suspension stops benefits;
--   - which of the three readings of "longer than one day" governs an
--     admission of about a day.
--
-- Each is held with a code naming the decision. None has acquired a default.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Has this member been saving long enough, as of a date?
-- ---------------------------------------------------------------------------
--
-- One answer per membership, taken from the account that is furthest along. A
-- member with two accounts qualifies on the strength of the better one, which
-- is what `member_loan_eligibility_of` already does and what the preview in
-- the transition migration already assumes.

create or replace function public.membership_savings_qualified(
  p_membership_id uuid,
  p_as_of date default null
)
returns table (
  qualifies          boolean,
  qualifying_months  integer,
  months_required    smallint,
  must_be_consecutive boolean,
  monthly_minimum    bigint,
  accounts_considered integer,
  blocked_reason     text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_as_of date;
  v_best  record;
begin
  v_as_of := coalesce(p_as_of, public.business_date());

  select
    bool_or(q.qualifies)                        as qualifies,
    coalesce(pg_catalog.max(q.qualifying_months), 0)::integer as months,
    pg_catalog.max(q.months_required)           as required,
    bool_or(q.must_be_consecutive)              as consecutive,
    pg_catalog.max(q.monthly_minimum)           as minimum,
    pg_catalog.count(*)::integer                as accounts,
    (pg_catalog.array_agg(q.blocked_reason)
       filter (where q.blocked_reason is not null))[1] as reason
  into v_best
  from public.savings_accounts a
  cross join lateral public.member_savings_qualification(a.id, v_as_of) q
  where a.membership_id = p_membership_id
    and a.status = 'active'
    and a.opened_on <= v_as_of;

  qualifies := coalesce(v_best.qualifies, false);
  qualifying_months := coalesce(v_best.months, 0);
  months_required := v_best.required;
  must_be_consecutive := v_best.consecutive;
  monthly_minimum := v_best.minimum;
  accounts_considered := coalesce(v_best.accounts, 0);

  if accounts_considered = 0 then
    blocked_reason :=
      'This member had no open savings account on that date, so no month of saving can be counted.';
  elsif qualifies then
    blocked_reason := null;
  else
    blocked_reason := v_best.reason;
  end if;

  return next;
end;
$$;

comment on function public.membership_savings_qualified(uuid, date) is
  'Polytos policy update, rule 9. Whether a membership had met the qualifying-month savings rule as of a date — the authoritative answer the benefit module reads, taken across the member''s open accounts. Asked "as of" because a member who did not qualify when the hospital admitted them does not become eligible by saving afterwards.';

grant execute on function public.membership_savings_qualified(uuid, date) to authenticated;

-- ---------------------------------------------------------------------------
-- The eligibility rules
-- ---------------------------------------------------------------------------

create or replace function public.benefit_claim_eligibility(p_claim_id uuid)
returns table (failure_code text, detail text)
language plpgsql
stable
security definer
set search_path = ''
as $$
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

        if v_consumed + v_benefit > v_policy.medical_benefit_annual_cap then
          -- Not part-paid. Whether an eligible claim may be paid in part, and
          -- whether a claim above the cap is paid up to it or refused
          -- outright, are two readings the client has not chosen between —
          -- and inventing either would be inventing how much the business
          -- pays.
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
$$;

comment on function public.benefit_claim_eligibility(uuid) is
  'Polytos Phase 4, rewritten by the policy update. Every rule a claim must satisfy, as rows rather than as an exception, so a screen can show the caller exactly what the assessment will refuse before they press the button. Each claim type asks its own policy gate; the qualifying period is read from the savings qualification when that is the recorded basis; a death-related claim needs the recorded number of confirmations from other group members; a condolence claim needs the deceased listed as next of kin before the death; and a bereavement claim is withheld while any loan of the client is outstanding.';


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

revoke all on function public.membership_savings_qualified(uuid, date) from public, anon;
revoke all on function public.benefit_claim_eligibility(uuid) from public, anon;
