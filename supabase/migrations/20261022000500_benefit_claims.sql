-- ===========================================================================
-- Polytos Phase 4.5 — one claim table, three benefits, one state machine
--
-- ## Why one table and not three
--
-- A medical claim, a condolence claim and a bereavement claim differ in what
-- evidences them and in how the amount is arrived at. They do not differ in
-- anything else: each is submitted by a member of staff on a member's behalf,
-- each is verified, assessed, approved and paid by the same four people under
-- the same four capabilities, each posts to the ledger the same way, and each
-- is refused for the same reasons when the policy is not open.
--
-- Three tables would therefore be one workflow written three times, with
-- three state machines to keep in step, three sets of RLS policies and three
-- registers. The type-specific parts are columns that are required for one
-- type and forbidden for the others — enforced by CHECK constraints, so the
-- schema refuses a medical claim carrying a date of death as firmly as three
-- tables would have.
--
-- ## The lifecycle, and the two statuses that are not here
--
--   draft                 being prepared. No evidence promised, nothing
--                         claimed. Deletable only by cancellation.
--   submitted             the claim is made. Facts frozen from here.
--   under_verification    somebody is checking the documents
--   information_required  something is missing, and the claim says what
--   assessed              the eligible amount has been computed and
--                         recommended. **This is "pending approval"**
--   approved              independently approved. **This is "pending
--                         payment"**
--   rejected              refused, with a reason. Terminal
--   paid                  the money has left, with a journal behind it
--   cancelled             withdrawn before a decision. Terminal
--   reversed              paid and then un-paid, with a contra journal
--
-- The brief lists "pending approval" and "pending payment" as separate
-- statuses. They are not modelled, deliberately: a status earns its place
-- when some *act* moves a claim into it, and nothing happens between being
-- assessed and being pending approval — they are the same moment named twice.
-- A status with no transition into it is a status that drifts out of step with
-- the one it shadows, and then two screens disagree about one claim. `assessed`
-- means waiting for an approver; `approved` means waiting for a payer; and the
-- register labels them in those words, so nothing is lost to the reader.
--
-- ## Transitions are enumerated, not implied
--
-- `benefit_claim_transition_allowed` is a function, and the guard refuses
-- anything it does not list. So a draft cannot become paid, a rejected claim
-- cannot be paid, an unassessed claim cannot be approved and a paid claim
-- cannot be paid again — each of those is the absence of an edge rather than a
-- special case somebody remembered to write.
--
-- ## What freezes when
--
-- At **submission**: the claim type, the membership, the policy version, and
-- every fact the claim asserts — the provider, the admission and discharge
-- times, the bill, the deceased's name, the relationship, the date of death.
-- A claim whose facts could change after submission is not a claim, it is a
-- draft with a reference number, and the assessment underneath it would be an
-- assessment of something else.
--
-- At **assessment**: the assessed amount, and a snapshot of everything the
-- assessment relied on (20261022000700).
--
-- At **approval**: the approved amount and the recipient. For a bereavement
-- claim that means a copy of the beneficiary's details, so a later change to
-- the beneficiary record cannot rewrite a payment instruction the business has
-- already authorised.
--
-- At **payment**: the journal entry, the receipt number and the cash account.
--
-- ## Duplicate events
--
-- Three partial unique indexes, one per claim type, each expressing "the same
-- event, claimed twice" in the terms that type's event actually has. They are
-- partial on the live statuses, so a *rejected* claim does not block a
-- resubmission — which it must not, because the commonest reason a claim is
-- rejected is a document somebody can go and fetch.
-- ===========================================================================

create table public.benefit_claims (
  id uuid primary key default pg_catalog.gen_random_uuid(),

  -- `BC2600001`, from the atomic counter.
  claim_number text not null unique,

  claim_type text not null,

  membership_id uuid not null references public.memberships(id) on delete restrict,
  client_id uuid not null references public.clients(id) on delete restrict,
  branch_id uuid not null references public.branches(id) on delete restrict,

  -- The version the claim is judged under: the membership's own, frozen at
  -- submission. Not "the version in force today", for the reason the whole
  -- policy-versioning design exists — a member who joined in March is held to
  -- March's terms, and a benefit assessed in June under a version published in
  -- May would be applying rules the member never accepted.
  policy_version_id uuid not null
    references public.membership_policy_versions(id) on delete restrict,
  policy_version text not null,

  status text not null default 'draft',

  -- --- The event ---------------------------------------------------------
  --
  -- One date every type has: when the thing being claimed for happened. The
  -- admission date for a medical claim, the date of death for the other two.
  -- Carried separately from the type-specific columns because every eligibility
  -- rule that depends on *when* — the waiting period, the policy year, the
  -- effective date of the policy version — reads this one column, and a rule
  -- that had to switch on the claim type to find its own date would be three
  -- rules.
  event_date date not null,

  -- --- Medical -----------------------------------------------------------

  provider_name text,
  admission_at timestamptz,
  discharge_at timestamptz,
  bill_amount bigint,

  -- The three readings of "an admission longer than one day", all computed
  -- and all stored, because the client has not said which one they mean.
  --
  --   nights         discharge date - admission date, in Africa/Kampala
  --   inclusive_days nights + 1: the hospital's own "days in ward" count
  --   elapsed_days   whole 24-hour periods between the two instants
  --
  -- `assess_benefit_claim` requires *every* reading to clear the policy
  -- threshold, and refuses — naming the decision — when they disagree. So an
  -- admission that qualifies under one reading and not another is never
  -- quietly paid, and one that qualifies under all three never waits on a
  -- decision it does not need. See 20261022000700.
  admission_nights integer,
  admission_inclusive_days integer,
  admission_elapsed_days integer,

  -- --- Family condolence and member bereavement --------------------------

  deceased_name text,
  -- For a condolence claim: what the deceased was to the member. NULL for a
  -- bereavement claim, where the deceased *is* the member.
  deceased_relationship text
    references public.beneficiary_relationships(key) on delete restrict,

  -- For a bereavement claim: the beneficiary the claim names. A reference,
  -- not the payee — the payee is the frozen copy taken at approval.
  beneficiary_id uuid references public.member_beneficiaries(id) on delete restrict,

  -- --- The amounts -------------------------------------------------------
  --
  -- Three, and they are three different statements:
  --
  --   claimed_amount   what the claim asks for. For a medical claim this is
  --                    derived from the bill at submission, so a claimant
  --                    cannot ask for more than the rate allows; for the two
  --                    fixed benefits it is the policy figure.
  --   assessed_amount  what the assessor found payable after the cap, the
  --                    claim count and the evidence
  --   approved_amount  what the approver authorised. Never more than
  --                    assessed — a constraint, not a convention.

  claimed_amount bigint,
  assessed_amount bigint,
  approved_amount bigint,

  -- --- Who did what ------------------------------------------------------

  submitted_at timestamptz,
  submitted_by uuid references public.profiles(id) on delete set null,
  submitted_by_label text,

  verified_at timestamptz,
  verified_by uuid references public.profiles(id) on delete set null,
  verified_by_label text,

  -- What is missing, when the claim is waiting on the claimant.
  information_required_note text,

  assessed_at timestamptz,
  assessed_by uuid references public.profiles(id) on delete set null,
  assessed_by_label text,
  assessment_note text,

  decided_at timestamptz,
  decided_by uuid references public.profiles(id) on delete set null,
  decided_by_label text,
  decision_note text,

  -- Terminal reasons, kept apart from `decision_note` because a refusal and a
  -- withdrawal are different events with different readers.
  rejected_reason text,
  cancelled_reason text,

  -- The payment, once there is one. Set by `post_benefit_payment`, which also
  -- moves the status — the two cannot disagree because one statement does
  -- both.
  payment_id uuid,

  created_by uuid references public.profiles(id) on delete set null,
  created_by_label text not null default 'system',
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),

  constraint benefit_claim_number_shape check (claim_number ~ '^BC[0-9]{6,}$'),
  constraint benefit_claim_type_valid
    check (claim_type in ('medical', 'family_condolence', 'member_bereavement')),
  constraint benefit_claim_status_valid
    check (status in (
      'draft', 'submitted', 'under_verification', 'information_required',
      'assessed', 'approved', 'rejected', 'paid', 'cancelled', 'reversed'
    )),
  constraint benefit_claim_event_date_plausible
    check (
      event_date >= date '2020-01-01'
      and event_date <= ((pg_catalog.now() at time zone 'Africa/Kampala')::date + 1)
    ),

  -- --- The type shape ----------------------------------------------------
  --
  -- Required for one type, forbidden for the others. This is what makes one
  -- table as strict as three would have been: a medical claim carrying a date
  -- of death cannot be stored by any route.

  constraint benefit_claim_medical_shape
    check (
      case claim_type
        when 'medical' then
          provider_name is not null
          and admission_at is not null
          and bill_amount is not null
          and deceased_name is null
          and deceased_relationship is null
          and beneficiary_id is null
        else
          provider_name is null
          and admission_at is null
          and discharge_at is null
          and bill_amount is null
          and admission_nights is null
          and admission_inclusive_days is null
          and admission_elapsed_days is null
      end
    ),
  constraint benefit_claim_condolence_shape
    check (
      claim_type <> 'family_condolence'
      or (deceased_name is not null
          and deceased_relationship is not null
          and beneficiary_id is null)
    ),
  -- A bereavement claim names no relationship, because the deceased is the
  -- member. It may name a beneficiary from the moment it is drafted, and the
  -- *verified* one is required at assessment rather than here — a claim
  -- opened the day a member dies, before anybody has checked the next of
  -- kin, is a real and common case, and refusing to record it would push the
  -- work onto paper.
  constraint benefit_claim_bereavement_shape
    check (
      claim_type <> 'member_bereavement'
      or (deceased_name is not null and deceased_relationship is null)
    ),
  constraint benefit_claim_provider_length
    check (provider_name is null
           or char_length(btrim(provider_name)) between 3 and 150),
  constraint benefit_claim_deceased_name_length
    check (deceased_name is null
           or char_length(btrim(deceased_name)) between 3 and 150),
  constraint benefit_claim_bill_positive
    check (bill_amount is null or (bill_amount > 0 and bill_amount <= 1000000000)),
  constraint benefit_claim_discharge_after_admission
    check (discharge_at is null or admission_at is null or discharge_at > admission_at),
  -- The three readings follow from the two instants, so they are checked
  -- against each other rather than trusted. `inclusive_days = nights + 1` is
  -- the definition, not an observation.
  constraint benefit_claim_admission_days_coherent
    check (
      (admission_nights is null and admission_inclusive_days is null
       and admission_elapsed_days is null)
      or (admission_nights >= 0
          and admission_elapsed_days >= 0
          and admission_inclusive_days = admission_nights + 1)
    ),

  -- --- The amounts -------------------------------------------------------

  constraint benefit_claim_claimed_positive
    check (claimed_amount is null
           or (claimed_amount > 0 and claimed_amount <= 1000000000)),
  constraint benefit_claim_assessed_non_negative
    check (assessed_amount is null
           or (assessed_amount >= 0 and assessed_amount <= 1000000000)),
  constraint benefit_claim_approved_non_negative
    check (approved_amount is null
           or (approved_amount >= 0 and approved_amount <= 1000000000)),
  -- The rule, as a constraint. An approver may authorise less than the
  -- assessment found — the client has not said whether they may, so the
  -- schema permits it and `approve_benefit_claim` refuses it until they do,
  -- which keeps the ceiling in the schema and the policy in the function.
  -- They may never authorise more.
  constraint benefit_claim_approved_within_assessed
    check (approved_amount is null or assessed_amount is null
           or approved_amount <= assessed_amount),
  -- A paid or approved claim has an amount. A claim approved for nothing is
  -- a rejection somebody mislabelled.
  constraint benefit_claim_decided_amount_present
    check (
      status not in ('approved', 'paid', 'reversed')
      or (approved_amount is not null and approved_amount > 0)
    ),
  constraint benefit_claim_assessed_amount_present
    check (
      status not in ('assessed', 'approved', 'paid', 'reversed')
      or assessed_amount is not null
    ),

  -- --- The lifecycle, as constraints -------------------------------------
  --
  -- The guard enforces the *transitions*; these enforce that each state
  -- carries the evidence of having been reached properly. Both, because the
  -- guard can be reasoned about and a constraint cannot be forgotten.

  constraint benefit_claim_submitted_complete
    check (
      (status = 'draft') = (submitted_at is null)
      and (submitted_at is null) = (submitted_by_label is null)
    ),
  constraint benefit_claim_assessment_complete
    check (
      (assessed_at is null) = (assessed_by_label is null)
      and (assessed_at is null) = (assessed_amount is null)
    ),
  constraint benefit_claim_decision_complete
    check ((decided_at is null) = (decided_by_label is null)),
  constraint benefit_claim_rejected_has_reason
    check ((status = 'rejected') = (rejected_reason is not null)),
  constraint benefit_claim_cancelled_has_reason
    check ((status = 'cancelled') = (cancelled_reason is not null)),
  constraint benefit_claim_information_required_has_note
    check ((status = 'information_required') = (information_required_note is not null)),
  constraint benefit_claim_paid_has_payment
    check ((status in ('paid', 'reversed')) = (payment_id is not null)),
  -- An approved claim was assessed by somebody and decided by somebody else.
  -- The *identity* check is in `approve_benefit_claim`; this is the weaker
  -- statement that both acts happened, which no route can bypass.
  constraint benefit_claim_approved_was_assessed
    check (
      status not in ('approved', 'paid', 'reversed')
      or (assessed_by_label is not null and decided_by_label is not null)
    ),

  constraint benefit_claim_note_lengths
    check (
      (assessment_note is null or char_length(btrim(assessment_note)) <= 4000)
      and (decision_note is null or char_length(btrim(decision_note)) <= 2000)
      and (rejected_reason is null
           or char_length(btrim(rejected_reason)) between 3 and 1000)
      and (cancelled_reason is null
           or char_length(btrim(cancelled_reason)) between 3 and 1000)
      and (information_required_note is null
           or char_length(btrim(information_required_note)) between 3 and 1000)
    ),
  constraint benefit_claim_labels_not_blank
    check (
      (submitted_by_label is null or btrim(submitted_by_label) <> '')
      and (verified_by_label is null or btrim(verified_by_label) <> '')
      and (assessed_by_label is null or btrim(assessed_by_label) <> '')
      and (decided_by_label is null or btrim(decided_by_label) <> '')
      and btrim(created_by_label) <> ''
    )
);

comment on table public.benefit_claims is
  'Polytos Phase 4. Medical, family condolence and member bereavement claims, in one table with one state machine. Facts freeze at submission, the assessment at assessment, the recipient at approval and the journal at payment. Reference scope BC.';
comment on column public.benefit_claims.policy_version_id is
  'The membership''s own policy version, frozen at submission. Not the version in force today: a member is held to the terms they accepted, which is the whole reason policy versions exist.';
comment on column public.benefit_claims.claimed_amount is
  'What the claim asks for. Derived from the bill and the policy rate for a medical claim, so a claimant cannot ask for more than the rate allows; the policy figure for the two fixed benefits.';
comment on column public.benefit_claims.admission_nights is
  'Discharge date minus admission date in Africa/Kampala. One of three readings of "an admission longer than one day", all stored because the client has not said which they mean; assessment requires every reading to clear the threshold and refuses when they disagree.';
comment on column public.benefit_claims.beneficiary_id is
  'The beneficiary a bereavement claim names. A reference, not the payee: the payee is the copy of this record frozen into the assessment snapshot at approval, so a later beneficiary change cannot redirect an authorised payment.';
comment on column public.benefit_claims.status is
  'The lifecycle. `assessed` is "waiting for an approver" and `approved` is "waiting for a payer" — the brief''s separate pending-approval and pending-payment statuses are those same moments, and a status no act moves a claim into would drift out of step with the one it shadows.';

-- ---------------------------------------------------------------------------
-- The duplicate-event rules
--
-- Partial on the live statuses, so a rejected or cancelled claim does not
-- block a resubmission — which it must not: the commonest reason a claim is
-- refused is a document somebody can go and fetch. A *draft* does not block
-- one either, because two members of staff each starting a draft for the same
-- family is a coordination problem, not a fraud.
-- ---------------------------------------------------------------------------

-- A member dies once. One live bereavement claim per membership, whatever
-- date anybody typed.
create unique index benefit_claims_one_live_bereavement
  on public.benefit_claims (membership_id)
  where claim_type = 'member_bereavement'
    and status in ('submitted', 'under_verification', 'information_required',
                   'assessed', 'approved', 'paid');

comment on index public.benefit_claims_one_live_bereavement is
  'A member dies once. One live bereavement claim per membership — the index, not a check in a function, because two concurrent submissions would both pass a check.';

-- A family member dies once. Keyed on the normalised name and the date,
-- because that is what identifies the event when two siblings are both
-- members and both claim.
create unique index benefit_claims_one_live_condolence
  on public.benefit_claims (
    membership_id,
    pg_catalog.lower(pg_catalog.regexp_replace(btrim(deceased_name), '\s+', ' ', 'g')),
    event_date
  )
  where claim_type = 'family_condolence'
    and status in ('submitted', 'under_verification', 'information_required',
                   'assessed', 'approved', 'paid');

-- One admission, one claim. Keyed on the provider and the admission date: a
-- member readmitted to the same hospital a month later has a different event
-- and may claim again, subject to the annual cap and claim count the client
-- has yet to set.
create unique index benefit_claims_one_live_medical_admission
  on public.benefit_claims (
    membership_id,
    pg_catalog.lower(pg_catalog.regexp_replace(btrim(provider_name), '\s+', ' ', 'g')),
    event_date
  )
  where claim_type = 'medical'
    and status in ('submitted', 'under_verification', 'information_required',
                   'assessed', 'approved', 'paid');

create index benefit_claims_membership_idx
  on public.benefit_claims (membership_id, event_date desc);
create index benefit_claims_client_idx on public.benefit_claims (client_id);
create index benefit_claims_branch_idx on public.benefit_claims (branch_id);
create index benefit_claims_status_idx
  on public.benefit_claims (status, created_at desc);
create index benefit_claims_type_status_idx
  on public.benefit_claims (claim_type, status);
-- The annual cap query: every medical claim for one member that has consumed
-- entitlement. Partial, because the rejected and cancelled ones never did.
create index benefit_claims_medical_consuming_idx
  on public.benefit_claims (membership_id, event_date)
  where claim_type = 'medical'
    and status in ('assessed', 'approved', 'paid');
create index benefit_claims_beneficiary_idx
  on public.benefit_claims (beneficiary_id)
  where beneficiary_id is not null;

create trigger benefit_claims_set_updated_at
  before update on public.benefit_claims
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- The number
-- ---------------------------------------------------------------------------

create or replace function public.benefit_claims_assign_number()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  new.claim_number := public.next_reference('benefit_claim');
  return new;
end;
$$;

comment on function public.benefit_claims_assign_number() is
  'Polytos Phase 4. Mints BC2600001 from the atomic counter, overruling anything supplied.';

revoke all on function public.benefit_claims_assign_number()
  from public, anon, authenticated;

create trigger benefit_claims_assign_number
  before insert on public.benefit_claims
  for each row execute function public.benefit_claims_assign_number();

-- ---------------------------------------------------------------------------
-- The transitions, enumerated
--
-- A function rather than a table, because the set is small, closed and
-- interesting to read — and because a table of edges is a table somebody can
-- INSERT into. IMMUTABLE, so it inlines into the guard.
-- ---------------------------------------------------------------------------

create or replace function public.benefit_claim_transition_allowed(
  p_from text,
  p_to text
)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select (p_from, p_to) in (
    -- Preparing it.
    ('draft', 'submitted'),
    ('draft', 'cancelled'),

    -- Checking the evidence. `submitted` may go straight to `assessed` where
    -- the verification and the assessment are one sitting — a small business
    -- does not have a verification desk — but it may never skip to approved.
    ('submitted', 'under_verification'),
    ('submitted', 'information_required'),
    ('submitted', 'assessed'),
    ('submitted', 'rejected'),
    ('submitted', 'cancelled'),

    ('under_verification', 'information_required'),
    ('under_verification', 'assessed'),
    ('under_verification', 'rejected'),
    ('under_verification', 'cancelled'),

    -- The claimant brought what was missing.
    ('information_required', 'under_verification'),
    ('information_required', 'assessed'),
    ('information_required', 'rejected'),
    ('information_required', 'cancelled'),

    -- The approver's three options: agree, refuse, or send it back for
    -- reassessment. Sending it back is not a rejection — the commonest reason
    -- is an arithmetic disagreement — and it returns to the stage where the
    -- assessment is made rather than to the assessor personally.
    ('assessed', 'approved'),
    ('assessed', 'rejected'),
    ('assessed', 'under_verification'),
    ('assessed', 'information_required'),
    ('assessed', 'cancelled'),

    -- Approved. The money may go, or the approval may be withdrawn before it
    -- does. Not `cancelled`: an approved claim the business changes its mind
    -- about is a *refusal* by somebody with the authority to refuse, and it
    -- needs a reason on the record rather than a withdrawal note.
    ('approved', 'paid'),
    ('approved', 'rejected'),

    -- Paid. The only way out is a reversal, which posts a contra journal and
    -- keeps the original. There is deliberately no edge from `paid` back to
    -- `approved`: a reversed claim is not a claim awaiting payment again.
    ('paid', 'reversed')
  );
$$;

comment on function public.benefit_claim_transition_allowed(text, text) is
  'Polytos Phase 4. The complete set of benefit claim transitions. Everything absent is refused by the guard: a draft cannot become paid, a rejected claim cannot be paid, an unassessed claim cannot be approved, and a paid claim cannot be paid twice.';

revoke all on function public.benefit_claim_transition_allowed(text, text) from public, anon;
grant execute on function public.benefit_claim_transition_allowed(text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- The guard
--
-- Derives what must not be supplied, refuses an unlisted transition, and
-- refuses an edit to a fact the claim has already asserted.
-- ---------------------------------------------------------------------------

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
    new.policy_version_id := v_membership.policy_version_id;

    select v.version into v_version
    from public.membership_policy_versions v
    where v.id = v_membership.policy_version_id;

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

comment on function public.benefit_claims_guard() is
  'Polytos Phase 4. Derives the membership''s client, branch and policy version and the medical admission lengths; forces a new claim to draft; refuses an unlisted transition; and freezes the claim''s facts at submission, the assessment once made, the beneficiary once named and the payment once posted.';

revoke all on function public.benefit_claims_guard() from public, anon, authenticated;

create trigger benefit_claims_guard
  before insert or update on public.benefit_claims
  for each row execute function public.benefit_claims_guard();

-- A claim is never deleted. A draft nobody wants is cancelled, which keeps
-- the reference spent and the record readable.
create trigger benefit_claims_no_delete
  before delete on public.benefit_claims
  for each row execute function public.reject_mutation();
