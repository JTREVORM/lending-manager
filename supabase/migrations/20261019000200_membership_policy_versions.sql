-- ===========================================================================
-- Polytos Phase 1.2 — the membership policy, as effective-dated versions
--
-- ## The problem this table exists to solve
--
-- The membership programme is a set of promises with numbers in them: a
-- registration fee of UGX 5,000, a savings minimum of UGX 50,000 a month, a
-- qualification period of six months, UGX 200,000 to a deceased member's next
-- of kin. Those numbers will change. When they do, a member who joined under
-- the old ones must still be held to the old ones — a business that could
-- retroactively raise the savings minimum on everybody by editing one row has
-- no auditable policy at all, it has a mutable global variable.
--
-- So the policy is a **version**, not a settings row. A membership references
-- the version it was enrolled under (`memberships.policy_version_id`), the
-- acceptance a member signs records the version they were shown
-- (`membership_terms_acceptances`), and publishing a change means inserting a
-- new row — never editing one that anybody has been enrolled under. This is
-- the same shape `guarantor_consent_terms` takes for the undertaking a
-- guarantor signs, and for the same reason.
--
-- ## Why this is not `business_settings` or `finance_settings`
--
-- `business_settings` is a singleton that governs *lending* — the amount
-- range, the interest ceiling, the penalty. `finance_settings` is a singleton
-- that governs how the company's own money moves. Both are deliberately
-- current-state-only, and both are right to be: a loan snapshots its terms at
-- approval, so the live row never has to be historic.
--
-- Membership has no equivalent snapshot point, because a membership is not an
-- agreement struck once and run off. It is a standing relationship with a
-- monthly obligation, an accruing qualification and an annual distribution,
-- all of which have to be evaluated against *the rules that applied at the
-- time*. That requires versions with dates on them, which a singleton cannot
-- express.
--
-- ## Confirmed, proposed, and undecided
--
-- Three categories, and the schema distinguishes them structurally rather
-- than in a comment:
--
--   * **Confirmed by the client's documents** — the registration fee, the
--     savings minimum, the six-month qualification period, the advertised 5%
--     rate, the five-month member maximum, the three-month non-member
--     maximum, the weekly/monthly cadence split, the three benefit figures.
--     These are `NOT NULL` columns, carrying the documented values.
--
--   * **Undecided** — nine questions the client has not answered. Whether
--     5% is per month or per loan. Whether interest is flat or reducing
--     balance. The savings-to-loan multiplier. Whether six qualifying months
--     must be consecutive. Whether savings may be withdrawn against a live
--     loan. The profit distribution formula. The medical benefit's annual cap.
--     Its claim frequency. Any waiting period. Every one of these is a
--     **nullable** column, and NULL means "the client has not decided" — not
--     zero, not a default somebody invented.
--
--   * **Approval** — `approved_at` and `approved_by`. A version the business
--     has not formally approved is a draft, whatever numbers are in it.
--
-- ## The gate: `is_financially_enabled`
--
-- A stored generated column that is true only when the version is active,
-- approved, and every undecided field has been decided. Polytos Phases 2–5
-- must consult it before posting anything: savings cannot be collected
-- against a policy whose withdrawal rule is unknown, a member loan cannot be
-- priced against a rate whose basis is unknown, and a profit distribution
-- cannot be computed from a formula nobody has written down.
--
-- Making it a generated column rather than a flag an administrator ticks is
-- the whole point. A flag can be ticked on an incomplete policy; this cannot
-- be true while a field is NULL, and no amount of UPDATE makes it so.
--
-- The version seeded below is therefore a **draft**, and
-- `is_financially_enabled` is false. That is the honest state of the
-- programme today, and Polytos Phase 1 ships it as such rather than
-- pretending the unresolved questions have answers.
-- ===========================================================================

create table public.membership_policy_versions (
  id uuid primary key default gen_random_uuid(),

  -- `1.0`, `1.1`, `2.0`. The shape is constrained so the ordering a reader
  -- infers from the number is the ordering the business meant.
  version text not null unique,
  title text not null,

  -- The date from which this version governs new enrolments and the monthly
  -- obligations of the memberships that reference it.
  effective_from date not null,

  -- draft      — being prepared; governs nothing.
  -- active     — in force. At most one at a time.
  -- superseded — was in force; memberships enrolled under it still reference
  --              it, and its figures must never change.
  status text not null default 'draft',

  -- --- Membership -------------------------------------------------------
  -- Confirmed by the client's documents. Whole shillings, like every other
  -- amount in this schema.

  -- UGX 5,000, charged once when a client is enrolled. Income to the
  -- business, never part of the member's savings — see
  -- docs/POLYTOS-EXPANSION-ARCHITECTURE.md on the two accounts this splits
  -- across.
  registration_fee bigint not null,

  -- UGX 50,000. A floor, not a fixed instalment: a member may save more.
  monthly_savings_minimum bigint not null,

  -- Six. How many qualifying monthly savings a member needs before they may
  -- borrow on member terms.
  savings_qualifying_months smallint not null,

  -- --- Member lending ----------------------------------------------------

  -- 500 basis points — the advertised 5%. What that 5% is *of*, and over what
  -- period, is `interest_basis` and `interest_method` below, both undecided.
  member_loan_interest_rate_bps integer not null,

  -- Five months, the advertised maximum for a member.
  member_loan_max_term_months smallint not null,

  -- A member loan of this many months or fewer is collected weekly; anything
  -- longer is collected monthly. Two, from the documents.
  member_loan_weekly_cadence_max_months smallint not null,

  -- Three months, the advertised maximum for a non-member. Recorded here
  -- rather than on a loan product because it is a *membership* policy
  -- statement — "this is what we offer people who are not members" — and the
  -- product that implements it is created in Polytos Phase 3.
  non_member_loan_max_term_months smallint not null,

  -- --- Benefits ----------------------------------------------------------

  -- 500 basis points — 5% of an eligible hospital bill.
  medical_benefit_rate_bps integer not null,

  -- The admission must exceed this many days. One, from the documents
  -- ("admission longer than one day"). Stored as the threshold the admission
  -- must be strictly greater than, because that is what the sentence says;
  -- whether a 36-hour stay qualifies is noted as a validation question in
  -- docs/POLYTOS-MEMBERSHIP-POLICY-DECISIONS.md.
  medical_benefit_min_admission_days smallint not null,

  -- UGX 100,000, on the death of a member's family member.
  family_condolence_benefit bigint not null,

  -- UGX 200,000, on the death of a member, paid to the registered next of
  -- kin.
  member_bereavement_benefit bigint not null,

  -- --- Undecided ---------------------------------------------------------
  -- Every column below is nullable, and NULL means the client has not
  -- decided. None of them has a default, because a default here would be an
  -- invented policy.

  -- Is the advertised 5% charged per month, or once over the life of the
  -- loan? The difference on a five-month loan is five-fold.
  interest_basis text,

  -- Flat on the original principal, or reducing balance? The existing lending
  -- engine computes reducing balance monthly; a flat member product would
  -- need its own method.
  interest_method text,

  -- How much a member may borrow against their savings, in basis points of
  -- the savings balance. 20000 would be two times savings. Undecided.
  savings_to_loan_multiplier_bps integer,

  -- Must the six qualifying months be consecutive, or is it six months of
  -- qualifying savings whenever they happened?
  qualifying_months_consecutive boolean,

  -- May a member withdraw savings while they hold an active member loan?
  -- 'allowed', 'blocked', or 'above_pledged' — the last meaning only the
  -- excess over what secures the loan.
  savings_withdrawal_with_active_loan text,

  -- How the year's distributable profit is shared. 'pro_rata_savings',
  -- 'equal_shares', 'pro_rata_savings_months' — undecided.
  profit_distribution_basis text,

  -- The most the medical benefit will pay one member in a policy year, and
  -- how many claims they may make. Both undecided, and both material: 5% of
  -- an uncapped bill is an uncapped liability.
  medical_benefit_annual_cap bigint,
  medical_benefit_claims_per_year smallint,

  -- How long after enrolment a member must wait before a benefit may be
  -- claimed. Undecided; zero and "none" are different answers and the schema
  -- refuses to guess which was meant.
  benefit_waiting_period_days smallint,

  -- --- Approval ----------------------------------------------------------

  approved_at timestamptz,
  approved_by uuid references public.profiles(id) on delete set null,
  -- Provenance degrades gracefully, as it does everywhere else here: a
  -- profile that no longer exists is less useful than NULL, and the label
  -- keeps the name the version was approved under. `approved_by` is also
  -- NULL for an unattended approval — a migration, or the privileged
  -- server-side path — which is why the label rather than the id is what the
  -- completeness constraint below is written against.
  approved_by_label text,
  -- The client's own approval document — a board minute, a signed policy
  -- sheet. Free text, because it names a piece of paper this system does not
  -- hold.
  approval_reference text,

  notes text,

  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),

  -- --- Readiness, one gate per activity ----------------------------------
  --
  -- A single `is_financially_enabled` switch was the wrong shape. It held the
  -- registration fee hostage to the year-end profit formula: a programme
  -- could not take UGX 5,000 at the counter — a figure the client's own
  -- documents confirm — because nobody had yet decided how December's
  -- surplus is divided. Those are different promises to different people at
  -- different times, and they fail independently.
  --
  -- So each activity carries its own gate, and each gate names only the
  -- decisions that activity actually needs. Every one is **generated**: it
  -- cannot be ticked, and no UPDATE can make it true while a rule it depends
  -- on is NULL.
  --
  -- What each is not: "in force today". An effective date is a comparison
  -- against the business date, which is not immutable and therefore cannot
  -- live in a generated column. `membership_policy_allows()` below is the
  -- function every later phase calls, and it is these columns *and* the date.

  -- Taking an application and the registration fee. Needs no undecided rule:
  -- the fee is confirmed, and nothing about enrolment waits on the savings,
  -- lending, benefit or profit questions.
  is_enrolment_enabled boolean generated always as (
    status = 'active' and approved_at is not null
  ) stored,

  -- Taking and returning savings. Needs the qualification rule, because the
  -- clock is what savings are for here, and the withdrawal rule, because a
  -- module that takes money and cannot say whether it may be given back is
  -- worse than one that is closed.
  is_savings_enabled boolean generated always as (
    status = 'active'
    and approved_at is not null
    and qualifying_months_consecutive is not null
    and savings_withdrawal_with_active_loan is not null
  ) stored,

  -- Lending to a member. Everything savings needs, because the loan is
  -- secured against them, plus the price and the size of the loan.
  is_member_lending_enabled boolean generated always as (
    status = 'active'
    and approved_at is not null
    and qualifying_months_consecutive is not null
    and savings_withdrawal_with_active_loan is not null
    and interest_basis is not null
    and interest_method is not null
    and savings_to_loan_multiplier_bps is not null
  ) stored,

  -- Paying a benefit. The three amounts and the medical rate are confirmed;
  -- what is missing is the ceiling. 5% of an uncapped bill is an uncapped
  -- liability, so the cap, the claim frequency and the waiting period are
  -- what this one waits for — and none of them has anything to do with
  -- whether savings may be taken.
  is_benefits_enabled boolean generated always as (
    status = 'active'
    and approved_at is not null
    and medical_benefit_annual_cap is not null
    and medical_benefit_claims_per_year is not null
    and benefit_waiting_period_days is not null
  ) stored,

  -- Declaring and paying a year-end share. One decision, and it is the whole
  -- activity.
  is_profit_sharing_enabled boolean generated always as (
    status = 'active'
    and approved_at is not null
    and profit_distribution_basis is not null
  ) stored,

  -- The overall completeness indicator, kept because "is this version
  -- finished" is a real question with a real reader — the policy screen
  -- counts the outstanding decisions from it. It is no longer the gate
  -- anything posts against.
  is_financially_enabled boolean generated always as (
    status = 'active'
    and approved_at is not null
    and interest_basis is not null
    and interest_method is not null
    and savings_to_loan_multiplier_bps is not null
    and qualifying_months_consecutive is not null
    and savings_withdrawal_with_active_loan is not null
    and profit_distribution_basis is not null
    and medical_benefit_annual_cap is not null
    and medical_benefit_claims_per_year is not null
    and benefit_waiting_period_days is not null
  ) stored,

  constraint membership_policy_version_shape
    check (version ~ '^[0-9]+\.[0-9]+$'),
  constraint membership_policy_title_not_blank
    check (btrim(title) <> ''),
  constraint membership_policy_status_valid
    check (status in ('draft', 'active', 'superseded')),

  constraint membership_policy_registration_fee_sane
    check (registration_fee between 0 and 100000000),
  constraint membership_policy_savings_minimum_positive
    check (monthly_savings_minimum > 0 and monthly_savings_minimum <= 1000000000),
  constraint membership_policy_qualifying_months_range
    check (savings_qualifying_months between 1 and 60),

  constraint membership_policy_member_rate_range
    check (member_loan_interest_rate_bps between 0 and 100000),
  constraint membership_policy_member_term_range
    check (member_loan_max_term_months between 1 and 120),
  constraint membership_policy_weekly_cadence_within_term
    check (
      member_loan_weekly_cadence_max_months between 0 and member_loan_max_term_months
    ),
  constraint membership_policy_non_member_term_range
    check (non_member_loan_max_term_months between 1 and 120),

  constraint membership_policy_medical_rate_range
    check (medical_benefit_rate_bps between 0 and 10000),
  constraint membership_policy_medical_admission_range
    check (medical_benefit_min_admission_days between 0 and 365),
  constraint membership_policy_condolence_sane
    check (family_condolence_benefit between 0 and 1000000000),
  constraint membership_policy_bereavement_sane
    check (member_bereavement_benefit between 0 and 1000000000),

  -- The undecided columns are nullable, but a value written into one must be
  -- a value the business recognises. A typo in a policy is worse than a gap.
  constraint membership_policy_interest_basis_valid
    check (interest_basis is null or interest_basis in ('per_month', 'per_loan')),
  constraint membership_policy_interest_method_valid
    check (
      interest_method is null
      or interest_method in ('flat', 'reducing_balance_monthly')
    ),
  -- Written on one line deliberately. A `*_bps` identifier at the start of a
  -- line is how `tests/integration/migrations.test.ts` finds a rate *column*
  -- declaration, and a constraint that opened with one would be read as a
  -- column of type `is`.
  constraint membership_policy_multiplier_range
    check (savings_to_loan_multiplier_bps is null
           or savings_to_loan_multiplier_bps between 0 and 1000000),
  constraint membership_policy_withdrawal_rule_valid
    check (
      savings_withdrawal_with_active_loan is null
      or savings_withdrawal_with_active_loan
         in ('allowed', 'blocked', 'above_pledged')
    ),
  constraint membership_policy_distribution_basis_valid
    check (
      profit_distribution_basis is null
      or profit_distribution_basis
         in ('pro_rata_savings', 'pro_rata_savings_months', 'equal_shares')
    ),
  constraint membership_policy_medical_cap_sane
    check (
      medical_benefit_annual_cap is null
      or medical_benefit_annual_cap between 0 and 1000000000
    ),
  constraint membership_policy_medical_claims_range
    check (
      medical_benefit_claims_per_year is null
      or medical_benefit_claims_per_year between 0 and 52
    ),
  constraint membership_policy_waiting_period_range
    check (
      benefit_waiting_period_days is null
      or benefit_waiting_period_days between 0 and 3650
    ),

  -- Approval is both halves or neither. An `approved_at` with nobody's name
  -- on it is not an approval, and a name with no date is not one either.
  constraint membership_policy_approval_complete
    check ((approved_at is null) = (approved_by_label is null)),
  -- An approver id without a date is incoherent; a date without an id is an
  -- unattended approval and is permitted, with the label carrying the name.
  constraint membership_policy_approver_needs_a_date
    check (approved_by is null or approved_at is not null),
  constraint membership_policy_approver_label_not_blank
    check (approved_by_label is null or btrim(approved_by_label) <> ''),

  -- A version in force, or one that has been in force, must have been
  -- approved. Only a draft may be unapproved.
  constraint membership_policy_in_force_is_approved
    check (status = 'draft' or approved_at is not null),

  constraint membership_policy_notes_length
    check (notes is null or char_length(notes) <= 4000),
  constraint membership_policy_approval_reference_length
    check (approval_reference is null or char_length(btrim(approval_reference)) <= 200)
);

comment on table public.membership_policy_versions is
  'Polytos Phase 1. The membership programme''s rules, effective-dated. A membership references the version it was enrolled under; a version that has been enrolled under is never edited, only superseded. Columns that are NULL are decisions the client has not yet made.';
comment on column public.membership_policy_versions.is_financially_enabled is
  'Generated. True only when the version is active, approved, and every undecided rule has been decided. The overall completeness indicator; the gate a posting consults is membership_policy_allows(), which asks only about that activity and also checks the effective date.';
comment on column public.membership_policy_versions.is_enrolment_enabled is
  'Generated. Whether this version opens enrolment and the registration fee. Waits on no undecided rule.';
comment on column public.membership_policy_versions.is_savings_enabled is
  'Generated. Whether this version opens savings. Waits on the qualification rule and the withdrawal rule, and on nothing about benefits or profit sharing.';
comment on column public.membership_policy_versions.is_member_lending_enabled is
  'Generated. Whether this version opens member lending. Waits on the savings rules and on the price, method and multiple of a member loan.';
comment on column public.membership_policy_versions.is_benefits_enabled is
  'Generated. Whether this version opens benefit payments. Waits on the medical cap, the claim frequency and the waiting period.';
comment on column public.membership_policy_versions.is_profit_sharing_enabled is
  'Generated. Whether this version opens a year-end distribution. Waits on the distribution basis alone.';
comment on column public.membership_policy_versions.interest_basis is
  'Whether the advertised member rate is charged per month or once per loan. NULL means the client has not decided; it does not mean per month.';
comment on column public.membership_policy_versions.savings_to_loan_multiplier_bps is
  'How much a member may borrow against their savings, in basis points of the savings balance. NULL means undecided.';

-- At most one version is in force. Enforced structurally so no screen has to
-- decide which of two active versions it meant.
create unique index membership_policy_versions_one_active
  on public.membership_policy_versions ((true))
  where status = 'active';

-- Two versions cannot claim the same effective date. Which one governed a
-- membership enrolled that day would be unanswerable.
create unique index membership_policy_versions_effective_from_unique
  on public.membership_policy_versions (effective_from)
  where status <> 'draft';

create index membership_policy_versions_status_idx
  on public.membership_policy_versions (status, effective_from desc);

create trigger membership_policy_versions_set_updated_at
  before update on public.membership_policy_versions
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- A version that governs anybody is evidence
--
-- The same guard `guarantor_consent_terms` carries, and for the same reason:
-- once a member has been enrolled under a set of figures, those figures are
-- what the business promised that person. Changing them is not an edit, it is
-- a retroactive variation of a contract.
--
-- ## Everything contractual, not only the figures that were filled in
--
-- The first draft of this guard froze the twelve confirmed figures and left
-- the nine undecided rules writable, on the reasoning that writing into a
-- blank is not changing anything. That reasoning is wrong. A member who
-- enrolled while "may savings be withdrawn against a live loan" was
-- undecided did not agree to whatever answer the business later writes into
-- that column; they agreed to a version in which it was open. Filling it in
-- afterwards is exactly the retroactive variation this guard exists to
-- prevent, and it is the more dangerous form because it leaves no trace of
-- having changed a value. So the freeze covers every contractual column —
-- the twelve, the nine, the version string, the effective date and the title
-- a printed form carries.
--
-- ## Frozen once approved, not only once somebody is enrolled
--
-- Approval is the business committing to a set of terms. Changing a figure
-- after approval and before the first enrolment would mean the version
-- members are later held to is not the version anybody approved. So approval
-- freezes it too, and the way to change an approved version is the way the
-- programme is meant to change: publish the next one.
--
-- What remains editable on a frozen version: `notes`, which is operational
-- commentary rather than a term, and `status`, because retiring a version is
-- how the next one takes effect.
--
-- ## The status moves one way
--
--   draft      -> active       (publishing it, which the approval constraint
--                               already requires an approval for)
--   active     -> superseded   (retiring it)
--   superseded -> nothing
--
-- Nothing returns to draft. A version that has been in force governed
-- somebody's terms for a period of time, and "draft" would assert that it
-- never did. Nothing returns from superseded either: bringing an old version
-- back is publishing a new one with the old figures, which leaves the dates
-- telling the truth.
-- ---------------------------------------------------------------------------

create or replace function public.membership_policy_versions_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_in_use  boolean;
  v_frozen  boolean;
  v_allowed text[];
begin
  -- Rules binding every caller, including service_role and the table owner,
  -- are stated before any trusted-path exemption — the Phase 2 lesson.

  if new.id is distinct from old.id
     or new.created_at is distinct from old.created_at then
    raise exception 'A policy version''s provenance cannot be rewritten.'
      using errcode = 'P0001';
  end if;

  if new.status is distinct from old.status then
    v_allowed := case old.status
      when 'draft'  then array['active']
      when 'active' then array['superseded']
      else array[]::text[]
    end;

    if not (new.status = any (v_allowed)) then
      raise exception
        'A membership policy version cannot move from % to %.',
        old.status, new.status using errcode = 'P0001';
    end if;
  end if;

  -- Approval is stamped by the database from the session, not supplied.
  if new.approved_at is distinct from old.approved_at then
    if old.approved_at is not null then
      raise exception
        'Policy version % has already been approved. Publish a new version instead.',
        old.version using errcode = 'P0001';
    end if;
    new.approved_at := pg_catalog.now();
    new.approved_by := public.current_profile_id();
    new.approved_by_label := public.audit_actor_label();
  end if;

  select exists (
    select 1 from public.memberships m where m.policy_version_id = old.id
  ) into v_in_use;

  -- Frozen by either event: somebody is held to it, or the business has
  -- approved it. `old.approved_at` rather than `new.approved_at`, so the
  -- update that stamps the approval may still carry the figures being
  -- approved — the approver is the one writing the statement, and the audit
  -- trigger records the whole before and after.
  v_frozen := v_in_use or old.approved_at is not null;

  if v_frozen and (
       new.version is distinct from old.version
    or new.title is distinct from old.title
    or new.effective_from is distinct from old.effective_from
    or new.registration_fee is distinct from old.registration_fee
    or new.monthly_savings_minimum is distinct from old.monthly_savings_minimum
    or new.savings_qualifying_months is distinct from old.savings_qualifying_months
    or new.member_loan_interest_rate_bps
         is distinct from old.member_loan_interest_rate_bps
    or new.member_loan_max_term_months is distinct from old.member_loan_max_term_months
    or new.member_loan_weekly_cadence_max_months
         is distinct from old.member_loan_weekly_cadence_max_months
    or new.non_member_loan_max_term_months
         is distinct from old.non_member_loan_max_term_months
    or new.medical_benefit_rate_bps is distinct from old.medical_benefit_rate_bps
    or new.medical_benefit_min_admission_days
         is distinct from old.medical_benefit_min_admission_days
    or new.family_condolence_benefit is distinct from old.family_condolence_benefit
    or new.member_bereavement_benefit is distinct from old.member_bereavement_benefit
    -- The nine the client has not settled. Frozen for the reason in the
    -- header: a member enrolled while one of these was open did not agree to
    -- the answer somebody writes into it afterwards.
    or new.interest_basis is distinct from old.interest_basis
    or new.interest_method is distinct from old.interest_method
    or new.savings_to_loan_multiplier_bps
         is distinct from old.savings_to_loan_multiplier_bps
    or new.qualifying_months_consecutive
         is distinct from old.qualifying_months_consecutive
    or new.savings_withdrawal_with_active_loan
         is distinct from old.savings_withdrawal_with_active_loan
    or new.profit_distribution_basis is distinct from old.profit_distribution_basis
    or new.medical_benefit_annual_cap is distinct from old.medical_benefit_annual_cap
    or new.medical_benefit_claims_per_year
         is distinct from old.medical_benefit_claims_per_year
    or new.benefit_waiting_period_days is distinct from old.benefit_waiting_period_days
  ) then
    if v_in_use then
      raise exception
        'Members are enrolled under policy version %. Publish a new version rather than changing this one.',
        old.version using errcode = 'P0001';
    end if;

    raise exception
      'Policy version % has been approved. Publish a new version rather than changing this one.',
      old.version using errcode = 'P0001';
  end if;

  -- --- The trusted server path -------------------------------------------
  -- auth.uid() is NULL for migrations, service_role and the test harness.
  -- There is no session to check a capability against.
  if auth.uid() is null then
    return new;
  end if;

  -- --- Binding on sessions -----------------------------------------------
  --
  -- Approval attribution is checked here rather than above for the reason
  -- `clients_guard_privileged_columns` checks the same class of thing here:
  -- `approved_by` is `ON DELETE SET NULL`, so deleting the approver's profile
  -- blanks it. That is a database cascade which leaves `approved_at` and
  -- `approved_by_label` intact — the approval survives under the name it was
  -- given — and it is not a caller claiming somebody else's approval.

  if new.approved_at is not distinct from old.approved_at
     and (new.approved_by is distinct from old.approved_by
          or new.approved_by_label is distinct from old.approved_by_label) then
    raise exception
      'Policy approval attribution is maintained by the database, not by the caller.'
      using errcode = 'P0001';
  end if;

  if not public.user_has_permission('membership:manage_policies') then
    raise exception
      'Changing a membership policy requires the membership:manage_policies capability.'
      using errcode = 'P0001';
  end if;

  return new;
end;
$$;

comment on function public.membership_policy_versions_guard() is
  'BEFORE UPDATE on membership_policy_versions: enforces the one-way status sequence, freezes every contractual column — the nine undecided rules included — once the version is approved or anybody is enrolled under it, stamps approval from the session, and requires membership:manage_policies. Rules binding every caller are stated before the trusted-path exemption.';

create trigger membership_policy_versions_guard
  before update on public.membership_policy_versions
  for each row execute function public.membership_policy_versions_guard();

-- A policy version is never deleted. Memberships point at it, and a
-- superseded version is the record of what somebody was promised.
create trigger membership_policy_versions_no_delete
  before delete on public.membership_policy_versions
  for each statement execute function public.reject_mutation();

revoke all on function public.membership_policy_versions_guard()
  from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- The version in force
--
-- One function rather than a `where status = 'active'` repeated in every
-- caller, so "which policy applies" has one answer.
--
-- ## In force means active, approved **and** started
--
-- `status = 'active'` alone was not enough. A version is activated when the
-- business decides it is next, and `effective_from` is the day it begins —
-- a programme announced in October and starting in November is the ordinary
-- case, not an edge one. Without the date comparison, enrolling somebody in
-- October would have bound them to terms that do not take effect until
-- November, and the register would have said they joined under rules nobody
-- was operating yet.
--
-- ## SECURITY DEFINER, deliberately
--
-- It was SECURITY INVOKER, so that it disclosed nothing the caller could not
-- already read. That is the wrong trade here: this function is what the
-- enrolment rule is written against, and a rule that gives a different
-- answer depending on who asks is not a rule. It returns an opaque id and
-- nothing else; the row behind it is still governed by
-- `membership_policy_versions_select`, so holding the id gets a caller no
-- further than they could already go.
-- ---------------------------------------------------------------------------

create or replace function public.active_membership_policy_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select v.id
  from public.membership_policy_versions v
  where v.status = 'active'
    and v.approved_at is not null
    and v.effective_from <= public.business_date()
  limit 1;
$$;

comment on function public.active_membership_policy_id() is
  'Polytos Phase 1. The id of the membership policy version in force on the business date — active, approved and started — or NULL when there is none. One answer for every caller, because it is what the enrolment rule is written against.';

revoke all on function public.active_membership_policy_id() from public, anon;
grant execute on function public.active_membership_policy_id() to authenticated;

-- ---------------------------------------------------------------------------
-- May this version carry this activity, today?
--
-- The one gate Polytos Phases 2-5 consult before they post anything. Two
-- questions in one answer, and both have to be yes:
--
--   * the decisions **that activity** needs have been made, which the
--     generated readiness columns settle and no write can forge; and
--   * the version is in force on the business date, which no generated
--     column can express because the business date is not immutable.
--
-- An activity nobody has defined raises rather than returning false. Failing
-- shut is the safe direction, but a typo that silently disables a module
-- looks exactly like a policy that has not been decided, and the two need
-- very different responses.
-- ---------------------------------------------------------------------------

create or replace function public.membership_policy_allows(
  p_version_id uuid,
  p_activity text
)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v public.membership_policy_versions%rowtype;
  v_ready boolean;
begin
  if p_activity is null or p_activity not in (
       'enrolment', 'savings', 'lending', 'benefits', 'profit_sharing'
     ) then
    raise exception
      'There is no membership activity called %. The gates are enrolment, savings, lending, benefits and profit_sharing.',
      coalesce(p_activity, '(null)') using errcode = 'P0001';
  end if;

  if p_version_id is null then
    return false;
  end if;

  select * into v
  from public.membership_policy_versions
  where id = p_version_id;

  if not found then
    return false;
  end if;

  if v.effective_from > public.business_date() then
    return false;
  end if;

  v_ready := case p_activity
    when 'enrolment'      then v.is_enrolment_enabled
    when 'savings'        then v.is_savings_enabled
    when 'lending'        then v.is_member_lending_enabled
    when 'benefits'       then v.is_benefits_enabled
    when 'profit_sharing' then v.is_profit_sharing_enabled
  end;

  return coalesce(v_ready, false);
end;
$$;

comment on function public.membership_policy_allows(uuid, text) is
  'Polytos Phase 1. Whether a membership policy version opens one named activity today: the decisions that activity needs have been made, and the version is approved, active and started. The single gate every later phase posts behind.';

revoke all on function public.membership_policy_allows(uuid, text) from public, anon;
grant execute on function public.membership_policy_allows(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- Version 1.0 — a draft, carrying the documented programme
--
-- Seeded as `draft` and unapproved, with every undecided column left NULL.
-- That is the truthful state: the figures below come from the client's own
-- documents, and the nine questions in
-- docs/POLYTOS-MEMBERSHIP-POLICY-DECISIONS.md are unanswered. Nothing may
-- post against it, which `is_financially_enabled = false` enforces.
--
-- `effective_from` is the first of the month following the seed rather than a
-- past date, so that activating this version cannot be read as a claim that
-- it governed anything retrospectively.
-- ---------------------------------------------------------------------------

insert into public.membership_policy_versions (
  version,
  title,
  effective_from,
  status,
  registration_fee,
  monthly_savings_minimum,
  savings_qualifying_months,
  member_loan_interest_rate_bps,
  member_loan_max_term_months,
  member_loan_weekly_cadence_max_months,
  non_member_loan_max_term_months,
  medical_benefit_rate_bps,
  medical_benefit_min_admission_days,
  family_condolence_benefit,
  member_bereavement_benefit,
  notes
)
values (
  '1.0',
  'Polytos membership programme — proposed terms',
  (pg_catalog.date_trunc(
     'month',
     (pg_catalog.now() at time zone 'Africa/Kampala')
   ) + interval '1 month')::date,
  'draft',
  5000,
  50000,
  6,
  500,
  5,
  2,
  3,
  500,
  1,
  100000,
  200000,
  'Drafted from the client''s membership and lending documents. Nine rules remain undecided and are held NULL: the basis and method of the 5% rate, the savings-to-loan multiplier, whether the six qualifying months must be consecutive, whether savings may be withdrawn against a live loan, the profit distribution formula, the medical benefit annual cap and claim frequency, and the benefit waiting period. This version is a draft and enables no financial operation.'
)
on conflict (version) do nothing;

-- --- Access control --------------------------------------------------------
-- RLS on and the default grants revoked here, as `clients` does. The policies
-- themselves are in 20261019000600, where every membership policy is stated
-- together and can be reviewed as one surface.

alter table public.membership_policy_versions enable row level security;
revoke all on table public.membership_policy_versions from anon, authenticated;
