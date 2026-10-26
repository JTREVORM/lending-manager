-- ===========================================================================
-- Polytos Phase 4.8 — the seven acts, and the one that refuses its own author
--
-- ## Every transition is a function, and nothing is an UPDATE
--
-- 20261022001100 grants no INSERT and a deliberately narrow UPDATE on
-- `benefit_claims`, so the functions below are the whole of the write
-- surface. Each one checks the capability, takes the locks it needs, and
-- leaves the claim in a state the guard's transition table allows.
--
--   open_benefit_claim          a draft, with the facts
--   submit_benefit_claim        the facts freeze; the claim is made
--   request_benefit_information something is missing, and it says what
--   assess_benefit_claim        the eligible amount, with a snapshot
--   approve_benefit_claim       the independent agreement
--   reject_benefit_claim        the refusal, with a reason
--   cancel_benefit_claim        withdrawn before a decision
--
-- Payment is 20261022000900, because it is the only one of the eight that
-- writes a journal.
--
-- ## The control that must not be collapsed
--
-- `approve_benefit_claim` refuses an approval from the person who assessed
-- it — by profile id **and** by actor label. The label matters: a staff
-- account that has since been archived leaves `assessed_by` NULL, and a
-- control that silently stopped applying when somebody left the business
-- would be the worst kind. This is exactly what `record_transfer`,
-- `record_expense` and `decide_savings_withdrawal` already do, and the reason
-- is sharper here: a benefit is money leaving the business on the strength of
-- a document somebody produced, and nobody in this building saw the
-- admission.
--
-- The role grants in 20261022000100 arrange that a Manager holds `assess` and
-- not `approve`, so the separation is structural as well. The function-level
-- refusal is what makes it hold for the Owner, who holds both and must — a
-- rule that no person may hold both keys would make a claim unapprovable on
-- any day the one other key-holder is out.
--
-- ## Partial approval is refused, not invented
--
-- The schema permits `approved_amount < assessed_amount`, because that is the
-- shape a partial payment would take if the client authorises one. The
-- function refuses it, naming the decision, because whether an eligible claim
-- may be paid in part is undecided and a business that paid 80% of an
-- assessment on an officer's judgement would be making the policy at the
-- counter. §9 of the brief says block rather than invent, and the two halves
-- are deliberately in different places: the ceiling is in the schema, where
-- nothing can relax it, and the policy is in the function, where one line
-- changes when the client answers.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- open_benefit_claim()
--
-- One function for all three types, with the type-specific arguments nullable
-- and the schema's CHECK constraints refusing the wrong combination. Three
-- functions would be three signatures over one table, and the one that
-- drifted would be the one nobody tested.
-- ---------------------------------------------------------------------------

create or replace function public.open_benefit_claim(
  p_membership_id uuid,
  p_claim_type text,
  p_event_date date default null,
  -- Medical
  p_provider_name text default null,
  p_admission_at timestamptz default null,
  p_discharge_at timestamptz default null,
  p_bill_amount bigint default null,
  -- Condolence and bereavement
  p_deceased_name text default null,
  p_deceased_relationship text default null,
  p_beneficiary_id uuid default null
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_id uuid;
  v_policy public.membership_policy_versions;
  v_membership public.memberships;
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

  select * into v_policy
  from public.membership_policy_versions where id = v_membership.policy_version_id;

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
    claimed_amount
  )
  values (
    p_membership_id,
    -- Placeholders: the guard derives the client, the branch and both policy
    -- columns from the membership.
    v_membership.client_id, v_membership.branch_id,
    v_membership.policy_version_id, 'pending',
    p_claim_type,
    -- For a medical claim the guard overwrites this with the admission date.
    coalesce(p_event_date, public.business_date()),
    nullif(pg_catalog.btrim(coalesce(p_provider_name, '')), ''),
    p_admission_at, p_discharge_at, p_bill_amount,
    nullif(pg_catalog.regexp_replace(
      pg_catalog.btrim(coalesce(p_deceased_name, '')), '\s+', ' ', 'g'), ''),
    nullif(pg_catalog.btrim(coalesce(p_deceased_relationship, '')), ''),
    p_beneficiary_id,
    v_claimed
  )
  returning id into v_id;

  return v_id;
end;
$$;

comment on function public.open_benefit_claim(uuid, text, date, text, timestamptz, timestamptz, bigint, text, text, uuid) is
  'Polytos Phase 4. Opens a benefit claim as a draft against a live membership, under the membership''s own policy version. The claimed amount is derived from the policy rather than accepted from the caller, so a claimant cannot ask for more than the rate allows.';

revoke all on function public.open_benefit_claim(uuid, text, date, text, timestamptz, timestamptz, bigint, text, text, uuid)
  from public, anon;
grant execute on function public.open_benefit_claim(uuid, text, date, text, timestamptz, timestamptz, bigint, text, text, uuid)
  to authenticated;

-- ---------------------------------------------------------------------------
-- submit_benefit_claim()
--
-- The facts freeze here. Nothing is validated against the policy yet — that
-- is the assessment's job, and refusing a submission on an eligibility rule
-- would mean the business had no record that somebody came in and asked.
-- A claim that cannot succeed should be recorded and then refused with a
-- reason, which is a document the member can be shown.
-- ---------------------------------------------------------------------------

create or replace function public.submit_benefit_claim(p_claim_id uuid)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_claim public.benefit_claims;
  v_actor uuid;
begin
  v_actor := public.current_profile_id();

  if v_actor is null and auth.uid() is not null then
    raise exception
      'A benefit claim must be submitted by a signed-in member of staff.'
      using errcode = 'P0001';
  end if;

  if auth.uid() is not null and not public.user_has_permission('benefits:claim') then
    raise exception
      'Submitting a benefit claim requires the benefits:claim capability.'
      using errcode = 'P0001';
  end if;

  select * into v_claim from public.benefit_claims where id = p_claim_id for update;

  if not found then
    raise exception 'No such benefit claim.' using errcode = 'P0001';
  end if;

  if v_claim.status <> 'draft' then
    raise exception
      'Claim % is %. Only a draft is submitted.', v_claim.claim_number, v_claim.status
      using errcode = 'P0001';
  end if;

  -- A medical claim with no discharge has no assessable length and no
  -- claimed amount. Refused at submission rather than at assessment, because
  -- the counter staff member is the one who can go back and ask when the
  -- member left hospital, and the assessor three days later is not.
  if v_claim.claim_type = 'medical' and v_claim.discharge_at is null then
    raise exception
      'Claim % has no discharge date, so the admission has no length and there is nothing to assess. Record the discharge first.',
      v_claim.claim_number using errcode = 'P0001';
  end if;

  update public.benefit_claims
     set status = 'submitted',
         submitted_at = pg_catalog.now(),
         submitted_by = v_actor,
         submitted_by_label = public.audit_actor_label()
   where id = p_claim_id;

  return p_claim_id;
end;
$$;

comment on function public.submit_benefit_claim(uuid) is
  'Polytos Phase 4. Submits a draft claim, freezing every fact it asserts. Deliberately validates no eligibility rule: a claim that cannot succeed should be recorded and then refused with a reason the member can be shown.';

revoke all on function public.submit_benefit_claim(uuid) from public, anon;
grant execute on function public.submit_benefit_claim(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- request_benefit_information()
--
-- The claim is waiting on the claimant, and the note says what for. Takes
-- `benefits:assess`, because the person who found the gap is the person
-- checking the evidence.
-- ---------------------------------------------------------------------------

create or replace function public.request_benefit_information(
  p_claim_id uuid,
  p_note text
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_claim public.benefit_claims;
begin
  if public.current_profile_id() is null and auth.uid() is not null then
    raise exception 'Signed-in staff only.' using errcode = 'P0001';
  end if;

  if auth.uid() is not null and not public.user_has_permission('benefits:assess') then
    raise exception
      'Asking a claimant for more information requires the benefits:assess capability.'
      using errcode = 'P0001';
  end if;

  if coalesce(pg_catalog.btrim(p_note), '') = '' then
    raise exception
      'Say what is missing. "Requires information" with no note sends the member away with nothing to fetch.'
      using errcode = 'P0001';
  end if;

  select * into v_claim from public.benefit_claims where id = p_claim_id for update;

  if not found then
    raise exception 'No such benefit claim.' using errcode = 'P0001';
  end if;

  if not public.benefit_claim_transition_allowed(v_claim.status, 'information_required') then
    raise exception
      'Claim % is %, and cannot be put back to the claimant from there.',
      v_claim.claim_number, v_claim.status using errcode = 'P0001';
  end if;

  update public.benefit_claims
     set status = 'information_required',
         information_required_note = pg_catalog.btrim(p_note),
         verified_at = pg_catalog.now(),
         verified_by = public.current_profile_id(),
         verified_by_label = public.audit_actor_label()
   where id = p_claim_id;

  return p_claim_id;
end;
$$;

comment on function public.request_benefit_information(uuid, text) is
  'Polytos Phase 4. Puts a claim back to the claimant with a note saying what is missing. The note is required: a refusal with nothing to fetch sends somebody away twice.';

revoke all on function public.request_benefit_information(uuid, text) from public, anon;
grant execute on function public.request_benefit_information(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- begin_benefit_verification()
--
-- A claim somebody has picked up. It carries no decision and no money; it
-- exists so a register can show which claims are being worked on and so an
-- assessor's name is on the record before the assessment is.
-- ---------------------------------------------------------------------------

create or replace function public.begin_benefit_verification(p_claim_id uuid)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_claim public.benefit_claims;
begin
  if auth.uid() is not null and not public.user_has_permission('benefits:assess') then
    raise exception
      'Verifying a claim''s evidence requires the benefits:assess capability.'
      using errcode = 'P0001';
  end if;

  select * into v_claim from public.benefit_claims where id = p_claim_id for update;

  if not found then
    raise exception 'No such benefit claim.' using errcode = 'P0001';
  end if;

  if not public.benefit_claim_transition_allowed(v_claim.status, 'under_verification') then
    raise exception
      'Claim % is %, and verification does not follow that.',
      v_claim.claim_number, v_claim.status using errcode = 'P0001';
  end if;

  update public.benefit_claims
     set status = 'under_verification',
         information_required_note = null,
         verified_at = pg_catalog.now(),
         verified_by = public.current_profile_id(),
         verified_by_label = public.audit_actor_label()
   where id = p_claim_id;

  return p_claim_id;
end;
$$;

comment on function public.begin_benefit_verification(uuid) is
  'Polytos Phase 4. Marks a claim as being checked, so the register shows what is in hand and the checker''s name is on the record before any decision is.';

revoke all on function public.begin_benefit_verification(uuid) from public, anon;
grant execute on function public.begin_benefit_verification(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- assess_benefit_claim()
--
-- The calculation, the evidence check and the snapshot, in one transaction
-- under one lock.
-- ---------------------------------------------------------------------------

create or replace function public.assess_benefit_claim(
  p_claim_id uuid,
  p_note text default null
)
returns bigint
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_claim       public.benefit_claims;
  v_membership  public.memberships;
  v_policy      public.membership_policy_versions;
  -- The payee, as scalars rather than a record. A record variable is unset
  -- for the two claim types that have no payee, and PL/pgSQL raises on a
  -- field of an unassigned record — so the INSERT below, which names every
  -- column for every claim type, has to read something that is NULL rather
  -- than something that is unassigned.
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
  -- for one member serialise and the second sees the first's commitment
  -- rather than the balance as it was before either.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('benefit_cap:' || v_claim.membership_id::text)
  );

  -- Every rule, in one place, already written. The function is STABLE and
  -- reads the same rows this one is about to write, under the same lock —
  -- which is the whole reason the eligibility rules are a function rather
  -- than inline here: the assessment screen shows the caller exactly what
  -- this refusal will say, before they press the button.
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
  end if;

  if v_claim.claim_type = 'member_bereavement' then
    -- The payee, read across the split. This function is SECURITY DEFINER, so
    -- it reaches `member_beneficiary_identities` without the caller holding
    -- `membership:view_sensitive` — which is right: the assessor's own screen
    -- shows them the name only if they hold it, and the *snapshot* needs it
    -- regardless, because a payment instruction with no name on it is not one.
    select b.id, b.beneficiary_number, i.full_name, b.relationship, i.phone,
           b.verified_at, b.verified_by_label
      into v_beneficiary_id, v_beneficiary_number, v_beneficiary_name,
           v_beneficiary_relationship, v_beneficiary_phone,
           v_beneficiary_verified_at, v_beneficiary_verified_by
    from public.member_beneficiaries b
    join public.member_beneficiary_identities i on i.beneficiary_id = b.id
    where b.id = v_claim.beneficiary_id;
  end if;

  -- The member's financial position, recorded and not acted on. Read for
  -- every claim type, because an assessor should see what the member owes
  -- whatever they are claiming — and because a snapshot that carried the
  -- figures only where they happened to matter would be a snapshot somebody
  -- had to interpret.
  -- A LEFT join, and a count beside the sum. A loan that is `active` but has
  -- no balance row yet — approved and disbursed in the same transaction this
  -- one is racing — still means the member owes money, and an inner join
  -- would make it invisible. The count is what the bereavement refusal reads;
  -- the sum is what the snapshot records.
  select coalesce(pg_catalog.sum(lb.principal_remaining), 0)::bigint,
         pg_catalog.count(*)::integer
    into v_outstanding, v_loan_count
  from public.loans l
  left join public.loan_balances lb on lb.loan_id = l.id
  where l.membership_id = v_claim.membership_id and l.status = 'active';

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
    bill_amount, admission_nights, admission_inclusive_days, admission_elapsed_days,
    year_basis, period_from, period_to,
    annual_cap, claims_per_year,
    prior_claims_in_period, prior_amount_in_period, remaining_cap_before,
    deceased_relationship, relationship_eligible,
    beneficiary_id, beneficiary_number, beneficiary_name, beneficiary_relationship,
    beneficiary_phone, beneficiary_verified_at, beneficiary_verified_by_label,
    outstanding_member_loan_principal, active_member_loan_count,
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
    v_claim.bill_amount,
    v_claim.admission_nights, v_claim.admission_inclusive_days,
    v_claim.admission_elapsed_days,
    case when v_claim.claim_type = 'medical'
      then v_policy.medical_benefit_year_basis end,
    v_from, v_to,
    case when v_claim.claim_type = 'medical'
      then v_policy.medical_benefit_annual_cap end,
    case when v_claim.claim_type = 'medical'
      then v_policy.medical_benefit_claims_per_year end,
    case when v_claim.claim_type = 'medical' then v_count end,
    case when v_claim.claim_type = 'medical' then v_consumed end,
    case when v_claim.claim_type = 'medical' and v_policy.medical_benefit_annual_cap is not null
      then greatest(v_policy.medical_benefit_annual_cap - v_consumed, 0) end,
    v_claim.deceased_relationship, v_eligible,
    v_beneficiary_id, v_beneficiary_number, v_beneficiary_name,
    v_beneficiary_relationship, v_beneficiary_phone,
    v_beneficiary_verified_at, v_beneficiary_verified_by,
    v_outstanding, v_loan_count, v_pledged, greatest(v_savings, 0),
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
  'Polytos Phase 4. Assesses a claim under its own policy version: refuses on every eligibility code, computes the amount in integer arithmetic, freezes a snapshot of everything relied on — including the payee, by copy — and moves the claim to assessed. Holds an advisory lock on the membership, so two medical assessments cannot share one annual cap.';

revoke all on function public.assess_benefit_claim(uuid, text) from public, anon;
grant execute on function public.assess_benefit_claim(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- approve_benefit_claim()
--
-- The independent agreement. Short, because everything it needs was decided
-- and frozen by the assessment — which is the point of the snapshot.
-- ---------------------------------------------------------------------------

create or replace function public.approve_benefit_claim(
  p_claim_id uuid,
  p_approved_amount bigint default null,
  p_note text default null
)
returns bigint
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_claim public.benefit_claims;
  v_snapshot public.benefit_assessment_snapshots;
  v_actor uuid;
  v_label text;
  v_amount bigint;
  v_failures text;
begin
  v_actor := public.current_profile_id();
  v_label := public.audit_actor_label();

  if v_actor is null and auth.uid() is not null then
    raise exception
      'A benefit claim must be approved by a signed-in member of staff.'
      using errcode = 'P0001';
  end if;

  if auth.uid() is not null and not public.user_has_permission('benefits:approve') then
    raise exception
      'Approving a benefit claim requires the benefits:approve capability.'
      using errcode = 'P0001';
  end if;

  select * into v_claim from public.benefit_claims where id = p_claim_id for update;

  if not found then
    raise exception 'No such benefit claim.' using errcode = 'P0001';
  end if;

  if v_claim.status <> 'assessed' then
    raise exception
      'Claim % is %. Only an assessed claim is approved — an unassessed one has no amount to agree to.',
      v_claim.claim_number, v_claim.status using errcode = 'P0001';
  end if;

  select * into v_snapshot
  from public.benefit_assessment_snapshots where claim_id = p_claim_id;

  if not found then
    raise exception
      'Claim % has no assessment snapshot. There is nothing on the record to approve.',
      v_claim.claim_number using errcode = 'P0001';
  end if;

  -- The control. By id and by label: a staff account that has since been
  -- archived leaves `assessed_by` NULL, and a separation of duties that
  -- stopped applying when somebody left would be worse than none.
  if (v_actor is not null and v_claim.assessed_by = v_actor)
     or (v_claim.assessed_by is null and v_claim.assessed_by_label = v_label) then
    raise exception
      'You assessed claim %. Somebody else must approve it — a benefit is money leaving the business on the strength of a document somebody produced, and one person assessing and approving that is no check at all.',
      v_claim.claim_number using errcode = 'P0001';
  end if;

  -- The policy may have closed, or the member's standing changed, between the
  -- assessment and the approval. Re-asked rather than assumed: an approval is
  -- a fresh decision, and the only thing the snapshot settles is what the
  -- *assessment* was.
  --
  -- `claim_not_in_assessable_state` is expected and excluded — the claim is
  -- assessed, which is precisely why it is here.
  select pg_catalog.string_agg(
           e.failure_code || ': ' || e.detail, E'\n' order by e.failure_code)
    into v_failures
  from public.benefit_claim_eligibility(p_claim_id) e
  where e.failure_code <> 'claim_not_in_assessable_state';

  if v_failures is not null then
    raise exception E'Claim % can no longer be approved.\n\n%',
      v_claim.claim_number, v_failures using errcode = 'P0001';
  end if;

  v_amount := coalesce(p_approved_amount, v_claim.assessed_amount);

  if v_amount > v_claim.assessed_amount then
    raise exception
      'Claim % was assessed at % shillings. An approver may not authorise more than the assessment found.',
      v_claim.claim_number, v_claim.assessed_amount using errcode = 'P0001';
  end if;

  if v_amount < v_claim.assessed_amount then
    raise exception
      'Claim % was assessed at % shillings, and whether an eligible claim may be paid in part is undecided. Approve the assessed amount, or refuse the claim with a reason — a part payment decided at the counter would be the business setting policy there.',
      v_claim.claim_number, v_claim.assessed_amount using errcode = 'P0001';
  end if;

  update public.benefit_claims
     set status = 'approved', approved_amount = v_amount,
         decided_at = pg_catalog.now(),
         decided_by = v_actor,
         decided_by_label = v_label,
         decision_note = nullif(pg_catalog.btrim(coalesce(p_note, '')), '')
   where id = p_claim_id;

  return v_amount;
end;
$$;

comment on function public.approve_benefit_claim(uuid, bigint, text) is
  'Polytos Phase 4. Approves an assessed claim. Refuses an approval from whoever assessed it, by profile id and by actor label; re-asks every eligibility rule, because an approval is a fresh decision; and refuses a part approval while that rule is undecided.';

revoke all on function public.approve_benefit_claim(uuid, bigint, text) from public, anon;
grant execute on function public.approve_benefit_claim(uuid, bigint, text) to authenticated;

-- ---------------------------------------------------------------------------
-- reject_benefit_claim()
--
-- The refusal. Available to an approver at any stage a refusal can follow —
-- including after approval, which is how an approval is withdrawn before the
-- money goes. Deliberately not available to the assessor: refusing a claim
-- is a decision about a member's entitlement, and it is the same decision
-- approving one is.
-- ---------------------------------------------------------------------------

create or replace function public.reject_benefit_claim(
  p_claim_id uuid,
  p_reason text
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_claim public.benefit_claims;
begin
  if public.current_profile_id() is null and auth.uid() is not null then
    raise exception 'Signed-in staff only.' using errcode = 'P0001';
  end if;

  if auth.uid() is not null and not public.user_has_permission('benefits:approve') then
    raise exception
      'Refusing a benefit claim requires the benefits:approve capability — it is the same decision about a member''s entitlement that approving one is.'
      using errcode = 'P0001';
  end if;

  if coalesce(pg_catalog.btrim(p_reason), '') = '' then
    raise exception
      'A refusal needs a reason. Somebody will have to tell the member, and "rejected" is not an answer.'
      using errcode = 'P0001';
  end if;

  select * into v_claim from public.benefit_claims where id = p_claim_id for update;

  if not found then
    raise exception 'No such benefit claim.' using errcode = 'P0001';
  end if;

  if not public.benefit_claim_transition_allowed(v_claim.status, 'rejected') then
    raise exception
      'Claim % is %, and cannot be refused from there. A paid claim is reversed, not refused.',
      v_claim.claim_number, v_claim.status using errcode = 'P0001';
  end if;

  update public.benefit_claims
     set rejected_reason = pg_catalog.btrim(p_reason),
         decided_at = pg_catalog.now(),
         decided_by = public.current_profile_id(),
         decided_by_label = public.audit_actor_label(),
         -- The approved amount goes with the approval it belonged to. Left in
         -- place it would read as "the business approved this and then
         -- refused it for this amount", which is not what happened.
         --
         -- On the same line as the status for the reason the snapshot's
         -- constraints are written that way: an identifier matching
         -- `\w*amount\w*` at the start of a line reads to
         -- `tests/integration/migrations.test.ts` as an amount column
         -- declaration of type `=`.
         status = 'rejected', approved_amount = null
   where id = p_claim_id;

  return p_claim_id;
end;
$$;

comment on function public.reject_benefit_claim(uuid, text) is
  'Polytos Phase 4. Refuses a claim with a reason, at any stage a refusal can follow — including after approval, which is how an approval is withdrawn before the money goes. Takes benefits:approve, because refusing is the same decision about entitlement that approving is.';

revoke all on function public.reject_benefit_claim(uuid, text) from public, anon;
grant execute on function public.reject_benefit_claim(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- cancel_benefit_claim()
--
-- The member changed their mind, or the counter opened the claim twice.
-- Available to whoever may open one, because withdrawing a claim is not a
-- decision about money — it is the absence of one. The same reasoning
-- `cancel_savings_withdrawal` carries.
--
-- An *approved* claim cannot be cancelled: by then the business has made a
-- decision, and un-making it is a refusal with a reason by somebody with the
-- authority to refuse.
-- ---------------------------------------------------------------------------

create or replace function public.cancel_benefit_claim(
  p_claim_id uuid,
  p_reason text
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_claim public.benefit_claims;
begin
  if public.current_profile_id() is null and auth.uid() is not null then
    raise exception 'Signed-in staff only.' using errcode = 'P0001';
  end if;

  if auth.uid() is not null and not public.user_has_permission('benefits:claim') then
    raise exception
      'Cancelling a benefit claim requires the benefits:claim capability.'
      using errcode = 'P0001';
  end if;

  if coalesce(pg_catalog.btrim(p_reason), '') = '' then
    raise exception 'A cancellation needs a reason.' using errcode = 'P0001';
  end if;

  select * into v_claim from public.benefit_claims where id = p_claim_id for update;

  if not found then
    raise exception 'No such benefit claim.' using errcode = 'P0001';
  end if;

  if not public.benefit_claim_transition_allowed(v_claim.status, 'cancelled') then
    raise exception
      'Claim % is %. An approved claim is refused with a reason by somebody who may refuse it, not withdrawn.',
      v_claim.claim_number, v_claim.status using errcode = 'P0001';
  end if;

  update public.benefit_claims
     set status = 'cancelled',
         cancelled_reason = pg_catalog.btrim(p_reason),
         decided_at = pg_catalog.now(),
         decided_by = public.current_profile_id(),
         decided_by_label = public.audit_actor_label()
   where id = p_claim_id;

  return p_claim_id;
end;
$$;

comment on function public.cancel_benefit_claim(uuid, text) is
  'Polytos Phase 4. Withdraws a claim before a decision, with a reason. Available to whoever may open one, because withdrawing a claim is the absence of a decision rather than one. An approved claim is refused instead.';

revoke all on function public.cancel_benefit_claim(uuid, text) from public, anon;
grant execute on function public.cancel_benefit_claim(uuid, text) to authenticated;
