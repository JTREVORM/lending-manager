-- ===========================================================================
-- Polytos business-policy update — the assessment snapshot records the new
-- evidence, and the payment re-asks the new conditions
-- ===========================================================================
--
-- `benefit_assessment_snapshots` is the row that has to explain a payment
-- years later: what the business saw, what rules it applied, and why that
-- produced this figure. Four of the client's answers add facts the snapshot
-- did not previously carry, and a payment justified by a rule the snapshot
-- does not record is a payment nobody can audit.
--
--   rule 7  — which medical ceiling rule applied: an amount, or the recorded
--             decision that the claim count is the whole limit. "Annual cap:
--             blank" means two different things and the snapshot must say
--             which.
--   rule 9  — that the member had been saving for six qualifying months **as
--             at the event date**, with the count. §10 of the brief is
--             explicit that a later deposit must not silently rewrite an
--             earlier decision, and freezing the answer is how.
--   rule 11 — the next-of-kin record naming the deceased, and the date it was
--             registered, so "listed before the death" is provable from the
--             snapshot alone.
--   rule 12 — how many group members confirmed, against how many were
--             required.
--   rule 14 — every outstanding loan of the client, not only member loans on
--             this membership.
--
-- ## The constraints are the point
--
-- Each new column arrives with a CHECK that makes the corresponding rule
-- impossible to break in a stored row. A snapshot that recorded a bereavement
-- assessment beside an outstanding loan, or a condolence assessment with the
-- next of kin registered after the death, would be a row asserting the
-- business broke its own policy. The constraints mean such a row cannot be
-- written at all — not by this function, not by the table owner, not by an
-- import.
--
-- `benefit_snapshot_bereavement_no_open_loan` is kept and a wider one added
-- beside it. The old one spoke of member loans; rule 14 speaks of any loan.
-- Keeping both costs nothing — member loans are a subset — and removing a
-- constraint that still expresses something true is how a guard gets lost.
-- ===========================================================================

alter table public.benefit_assessment_snapshots
  -- Rule 9, frozen.
  add column qualification_basis       text,
  add column savings_qualifying_months integer,
  add column savings_months_required   smallint,
  add column savings_qualified         boolean,

  -- Rule 7, so that a blank cap is readable.
  add column medical_cap_mode          text,

  -- Rule 12.
  add column death_confirmations_required smallint,
  add column death_confirmations_recorded integer,

  -- Rule 11.
  add column deceased_beneficiary_id     uuid
    references public.member_beneficiaries(id) on delete restrict,
  add column deceased_beneficiary_number text,
  add column deceased_listed_on          date,

  -- Rule 14, across every loan rather than only member loans.
  add column outstanding_loan_principal bigint,
  add column outstanding_loan_count     integer;

comment on column public.benefit_assessment_snapshots.qualification_basis is
  'Polytos policy update, rule 9. How the qualifying period was measured for this assessment — the savings-month rule or a day count. Recorded because the two are different rules and a snapshot that did not say which could not be re-checked.';

comment on column public.benefit_assessment_snapshots.savings_qualified is
  'Rule 9. Whether the member had met the qualifying-month savings rule as at the event date. Frozen here so that a deposit made after the assessment cannot rewrite the decision the business took.';

comment on column public.benefit_assessment_snapshots.medical_cap_mode is
  'Rule 7. Which ceiling rule applied: "amount" (annual_cap carries it) or "no_separate_cap" (the claim count was the whole limit). Without this a blank annual_cap would be unreadable — it could mean either.';

comment on column public.benefit_assessment_snapshots.deceased_listed_on is
  'Rule 11. The day the deceased''s next-of-kin record was registered, so that "listed before the death" is provable from the snapshot without reading the live record — which may since have been superseded.';

comment on column public.benefit_assessment_snapshots.outstanding_loan_principal is
  'Rule 14. What every unfinished loan of the client owed at the moment of assessment — member loans and ordinary loans alike. Zero on a bereavement snapshot by constraint, because the benefit is not released while anything is outstanding.';

-- Historical assessments predate these evidence columns and remain byte for
-- byte intact. NOT VALID preserves them while enforcing the two new evidence
-- requirements on every future INSERT/UPDATE; the snapshots remain immutable.
alter table public.benefit_assessment_snapshots
  add constraint benefit_snapshot_qualification_basis_valid
    check (
      qualification_basis is null
      or qualification_basis in ('waiting_period_days', 'savings_qualifying_months')
    ),
  -- Under the savings basis the member must have qualified. The generic
  -- `waiting_period_served` column says the qualifying period was served
  -- however it was measured; this says which measurement produced that.
  add constraint benefit_snapshot_savings_basis_qualified
    check (
      qualification_basis is distinct from 'savings_qualifying_months'
      or (savings_qualified and savings_qualifying_months is not null
          and savings_months_required is not null
          and savings_qualifying_months >= savings_months_required)
    ),
  add constraint benefit_snapshot_medical_cap_mode_valid
    check (
      medical_cap_mode is null
      or medical_cap_mode in ('amount', 'no_separate_cap')
    ),
  -- A cap amount recorded under "no separate cap" would be two answers.
  add constraint benefit_snapshot_cap_mode_coherent
    check (
      medical_cap_mode is distinct from 'no_separate_cap' or annual_cap is null
    ),
  -- Rule 12, as a stored fact: a death-related snapshot carries enough
  -- confirmations.
  add constraint benefit_snapshot_death_confirmations_met
    check (
      claim_type not in ('family_condolence', 'member_bereavement')
      or (death_confirmations_required is not null
          and death_confirmations_recorded is not null
          and death_confirmations_recorded >= death_confirmations_required)
    ) not valid,
  -- Rule 11, as a stored fact: the deceased was listed, and listed first.
  add constraint benefit_snapshot_condolence_next_of_kin
    check (
      claim_type <> 'family_condolence'
      or (deceased_beneficiary_id is not null
          and deceased_listed_on is not null
          and deceased_listed_on <= event_date)
    ) not valid,
  -- Rule 14, as a stored fact, across every loan.
  add constraint benefit_snapshot_bereavement_no_outstanding_loan
    check (
      claim_type <> 'member_bereavement'
      or (coalesce(outstanding_loan_principal, 0) = 0
          and coalesce(outstanding_loan_count, 0) = 0)
    ),
  add constraint benefit_snapshot_outstanding_non_negative
    check (
      coalesce(outstanding_loan_principal, 0) >= 0
      and coalesce(outstanding_loan_count, 0) >= 0
      and coalesce(death_confirmations_recorded, 0) >= 0
      and coalesce(savings_qualifying_months, 0) >= 0
    );

-- ---------------------------------------------------------------------------
-- The assessment
-- ---------------------------------------------------------------------------

create or replace function public.assess_benefit_claim(
  p_claim_id uuid,
  p_note text default null
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
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
    medical_cap_mode, annual_cap, claims_per_year,
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
$$;

comment on function public.assess_benefit_claim(uuid, text) is
  'Polytos Phase 4, extended by the policy update. Works the eligibility rules, writes the immutable assessment snapshot and moves the claim to assessed. The snapshot now also freezes which medical ceiling rule applied, the member''s savings qualification as at the event date, the next-of-kin listing behind a condolence claim, the death confirmations, and every outstanding loan of the client — so a payment can be explained years later from the row alone.';

-- ---------------------------------------------------------------------------
-- The payment re-asks the conditions that can change
-- ---------------------------------------------------------------------------
--
-- A claim can sit approved for days. Two of the client's rules can stop being
-- satisfied in that time, and both are re-asked here, at the last point where
-- asking can still prevent anything:
--
--   - the policy gate for **this benefit**, which Phase 4 asked for all three
--     at once;
--   - rule 14's outstanding loan, because a reversed repayment reopens a debt
--     that was settled when the claim was approved. The brief names exactly
--     that case: "Reversed repayment reopens outstanding debt: reassess before
--     any unpaid benefit payment."

create or replace function public.benefit_payment_blocked_reason(p_claim_id uuid)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_claim public.benefit_claims;
  v_activity text;
  v_outstanding bigint;
  v_loan_count integer;
  v_loans text;
begin
  select * into v_claim from public.benefit_claims where id = p_claim_id;

  if not found then
    return 'No such benefit claim.';
  end if;

  if auth.uid() is not null and not (
    (public.user_has_permission('benefits:view') and public.user_can_see_branch(v_claim.branch_id))
    or exists (select 1 from public.clients c where c.id = v_claim.client_id
      and c.profile_id = public.current_profile_id())
  ) then
    return 'That claim cannot be read.';
  end if;

  v_activity := case v_claim.claim_type
                  when 'medical'            then 'medical_benefit'
                  when 'family_condolence'  then 'condolence_benefit'
                  when 'member_bereavement' then 'bereavement_benefit'
                end;

  if not public.membership_policy_allows(v_claim.policy_version_id, v_activity) then
    return coalesce(
      public.benefit_blocked_reason(v_claim.policy_version_id, v_claim.claim_type),
      pg_catalog.format(
        'This benefit is not open under policy version %s.', v_claim.policy_version));
  end if;

  if v_claim.claim_type = 'member_bereavement' then
    select
      coalesce(pg_catalog.sum(
        o.contractual_outstanding + o.penalty_outstanding), 0)::bigint,
      pg_catalog.count(*)::integer,
      pg_catalog.string_agg(
        o.loan_number || ' (' || o.status || ')', ', ' order by o.loan_number)
      into v_outstanding, v_loan_count, v_loans
    from public.client_outstanding_loans(v_claim.client_id) o;

    if v_loan_count > 0 then
      return pg_catalog.format(
        'This member has %s outstanding loan(s) — %s — with %s shillings owed. The bereavement benefit is not released until the loan is fully cleared, and a repayment reversed since the approval reopens that debt.',
        v_loan_count, v_loans, v_outstanding);
    end if;
  end if;

  return null;
end;
$$;

comment on function public.benefit_payment_blocked_reason(uuid) is
  'Polytos policy update. What stops an approved claim being paid right now, re-asked rather than remembered: this benefit''s own policy gate, and rule 14''s outstanding loan. A repayment reversed between approval and payment reopens a debt that was clear when the claim was approved, and the benefit screen shows that before the button is pressed.';

grant execute on function public.benefit_payment_blocked_reason(uuid) to authenticated;

create or replace function public.post_benefit_payment(
  p_claim_id uuid,
  p_payment_method text,
  p_external_reference text,
  p_idempotency_key uuid
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_claim     public.benefit_claims;
  v_snapshot  public.benefit_assessment_snapshots;
  v_client    public.clients;
  v_actor     uuid;
  v_label     text;
  v_reference text;
  v_payment_id uuid;
  v_cash      uuid;
  v_expense   uuid;
  v_entry_id  uuid;
  v_date      date;
  v_recipient_kind text;
  v_recipient_name text;
  v_recipient_phone text;
  v_beneficiary_id uuid;
  v_beneficiary_number text;
  v_blocked   text;
begin
  v_actor := public.current_profile_id();
  v_label := public.audit_actor_label();

  -- Authorisation above the replay shortcut. ADR-056: the early return reads
  -- a payment record, so it sits behind the check that decides whether this
  -- caller may see one.
  if v_actor is null and auth.uid() is not null then
    raise exception
      'A benefit must be paid by a signed-in member of staff.'
      using errcode = 'P0001';
  end if;

  if auth.uid() is not null and not public.user_has_permission('benefits:pay') then
    raise exception
      'Paying a benefit requires the benefits:pay capability.'
      using errcode = 'P0001';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('benefit_payment_key:' || p_idempotency_key::text)
  );

  select id into v_payment_id
  from public.benefit_payments where idempotency_key = p_idempotency_key;

  if v_payment_id is not null then
    return v_payment_id;
  end if;

  select * into v_claim from public.benefit_claims where id = p_claim_id for update;

  if not found then
    raise exception 'No such benefit claim.' using errcode = 'P0001';
  end if;

  if v_claim.status <> 'approved' then
    raise exception
      'Claim % is %. Only an approved claim is paid.',
      v_claim.claim_number, v_claim.status using errcode = 'P0001';
  end if;

  -- The conditions that can change between approval and payment, re-asked at
  -- the moment the money moves: this benefit's gate, and rule 14's loan.
  v_blocked := public.benefit_payment_blocked_reason(p_claim_id);

  if v_blocked is not null then
    raise exception
      'Claim % cannot be paid. %', v_claim.claim_number, v_blocked
      using errcode = 'P0001';
  end if;

  select * into v_snapshot
  from public.benefit_assessment_snapshots where claim_id = p_claim_id;

  if not found then
    raise exception
      'Claim % has no assessment snapshot, so there is no authorised recipient or amount. Nothing is paid on a claim whose assessment is not on the record.',
      v_claim.claim_number using errcode = 'P0001';
  end if;

  if v_claim.approved_amount is null or v_claim.approved_amount <= 0 then
    raise exception
      'Claim % has no approved amount.', v_claim.claim_number using errcode = 'P0001';
  end if;

  if v_claim.approved_amount > v_snapshot.assessed_amount then
    raise exception
      'Claim % is approved for % but was assessed at %. A payment never exceeds the assessment it rests on.',
      v_claim.claim_number, v_claim.approved_amount, v_snapshot.assessed_amount
      using errcode = 'P0001';
  end if;

  -- The recipient, from the authorisation rather than from the live record.
  if v_claim.claim_type = 'member_bereavement' then
    if v_snapshot.beneficiary_id is null
       or v_snapshot.beneficiary_name is null
       or v_snapshot.beneficiary_phone is null then
      raise exception
        'Claim %''s assessment records no verified beneficiary, so there is nobody the business may pay.',
        v_claim.claim_number using errcode = 'P0001';
    end if;

    v_recipient_kind := 'beneficiary';
    v_recipient_name := v_snapshot.beneficiary_name;
    v_recipient_phone := v_snapshot.beneficiary_phone;
    v_beneficiary_id := v_snapshot.beneficiary_id;
    v_beneficiary_number := v_snapshot.beneficiary_number;
  else
    select * into v_client from public.clients where id = v_claim.client_id;

    if v_client.phone is null then
      raise exception
        'Client % has no telephone number on record, so the payment has no recipient detail to issue a receipt against.',
        v_client.client_number using errcode = 'P0001';
    end if;

    v_recipient_kind := 'member';
    v_recipient_name := v_client.full_name;
    v_recipient_phone := v_client.phone;
    v_beneficiary_id := null;
    v_beneficiary_number := null;
  end if;

  if p_payment_method not in ('cash', 'mtn_mobile_money', 'airtel_money', 'bank') then
    raise exception 'Unknown payment method "%".', p_payment_method
      using errcode = 'P0001';
  end if;

  v_reference := pg_catalog.upper(pg_catalog.btrim(coalesce(p_external_reference, '')));
  if v_reference = '' then
    v_reference := null;
  end if;

  if p_payment_method = 'cash' then
    if v_reference is not null then
      raise exception
        'A cash benefit payment has no network reference. Its payment number is its reference.'
        using errcode = 'P0001';
    end if;
  elsif v_reference is null then
    raise exception
      'A % benefit payment needs the reference from the network or the bank.',
      p_payment_method using errcode = 'P0001';
  elsif char_length(v_reference) < 4 then
    raise exception
      'That transaction reference is too short to identify a payment.'
      using errcode = 'P0001';
  end if;

  v_cash := public.branch_cash_account(
    v_claim.branch_id, public.payment_method_cash_kind(p_payment_method));
  v_expense := public.benefit_expense_account(v_claim.claim_type);

  if v_expense is null then
    raise exception
      'There is no benefit expense account for a claim of type "%".', v_claim.claim_type
      using errcode = 'P0001';
  end if;

  v_date := public.business_date();
  v_payment_id := pg_catalog.gen_random_uuid();

  v_entry_id := public.post_journal(
    v_claim.branch_id,
    v_date,
    'Member benefit — ' || v_claim.claim_number || ' (' || v_claim.claim_type || ')',
    'benefit_payment',
    v_payment_id,
    -- No loan. A benefit payment is not a loan event, and attaching one would
    -- put it on the loan's own ledger view.
    null,
    v_claim.client_id,
    pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'account_id', v_expense,
        'debit', v_claim.approved_amount, 'credit', 0,
        'memo', 'Benefit — ' || v_claim.claim_number),
      pg_catalog.jsonb_build_object(
        'account_id', v_cash,
        'debit', 0, 'credit', v_claim.approved_amount,
        'memo', 'Benefit paid to ' || v_recipient_kind)
    ),
    null, v_actor, v_label
  );

  insert into public.benefit_payments (
    id, payment_number, claim_id, claim_number, claim_type,
    membership_id, client_id, branch_id, amount,
    recipient_kind, recipient_name, recipient_phone,
    recipient_beneficiary_id, recipient_beneficiary_number,
    payment_method, cash_account_id, expense_account_id, external_reference,
    idempotency_key, value_date, journal_entry_id,
    paid_by, paid_by_label
  )
  values (
    v_payment_id, 'BP000000', p_claim_id, v_claim.claim_number, v_claim.claim_type,
    v_claim.membership_id, v_claim.client_id, v_claim.branch_id,
    v_claim.approved_amount,
    v_recipient_kind, v_recipient_name, v_recipient_phone,
    v_beneficiary_id, v_beneficiary_number,
    p_payment_method, v_cash, v_expense, v_reference,
    p_idempotency_key, v_date, v_entry_id,
    v_actor, v_label
  );

  update public.benefit_claims
     set status = 'paid',
         payment_id = v_payment_id
   where id = p_claim_id;

  return v_payment_id;
end;
$$;

comment on function public.post_benefit_payment(uuid, text, text, uuid) is
  'Polytos Phase 4, extended by the policy update. Pays an approved claim to the recipient its assessment authorised, posts the double entry and marks the claim paid. The gate it re-asks is now this benefit''s own, and a bereavement payment is refused if any loan of the client is outstanding at the moment of payment — a repayment reversed since the approval reopens a debt that was clear when it was given.';


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

revoke all on function public.assess_benefit_claim(uuid, text) from public, anon;
revoke all on function public.benefit_payment_blocked_reason(uuid) from public, anon;
revoke all on function public.post_benefit_payment(uuid, text, text, uuid) from public, anon;
