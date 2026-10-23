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
--   * **Undecided** — eight questions the client has not answered. Whether
--     5% is per month or per loan. Whether interest is flat or reducing
--     balance. The savings-to-loan multiplier. Whether six qualifying months
--     must be consecutive. Whether savings may be withdrawn against a live
--     loan. The profit distribution formula. The medical benefit's annual cap
--     and claim frequency. Any waiting period. Every one of these is a
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

  -- The gate every later phase consults before it posts anything. Generated,
  -- not set: it cannot be true while a decision is outstanding, and no UPDATE
  -- can make it so.
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
  'Generated. True only when the version is active, approved, and every undecided rule has been decided. Polytos Phases 2-5 must refuse to post against a version where this is false.';
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
-- Status may still move — draft to active, active to superseded — because
-- that is how a version is retired. Everything substantive is frozen.
-- ---------------------------------------------------------------------------

create or replace function public.membership_policy_versions_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_in_use boolean;
begin
  -- Rules binding every caller, including service_role and the table owner,
  -- are stated before any trusted-path exemption — the Phase 2 lesson.

  if new.id is distinct from old.id
     or new.created_at is distinct from old.created_at then
    raise exception 'A policy version''s provenance cannot be rewritten.'
      using errcode = 'P0001';
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

  if v_in_use and (
       new.version is distinct from old.version
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
  ) then
    raise exception
      'Members are enrolled under policy version %. Publish a new version rather than changing this one.',
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
  'BEFORE UPDATE on membership_policy_versions: freezes the figures of a version members are enrolled under, stamps approval from the session, and requires membership:manage_policies. Rules binding every caller are stated before the trusted-path exemption.';

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
-- caller, so "which policy applies" has one answer. STABLE and
-- SECURITY INVOKER: it reads through the caller's own policies, so a caller
-- who may not read the table gets nothing from it either.
-- ---------------------------------------------------------------------------

create or replace function public.active_membership_policy_id()
returns uuid
language sql
stable
set search_path = ''
as $$
  select v.id
  from public.membership_policy_versions v
  where v.status = 'active'
  limit 1;
$$;

comment on function public.active_membership_policy_id() is
  'Polytos Phase 1. The id of the membership policy version currently in force, or NULL when none has been activated. Reads as the caller, so it discloses nothing the caller could not already read.';

revoke all on function public.active_membership_policy_id() from public, anon;
grant execute on function public.active_membership_policy_id() to authenticated;

-- ---------------------------------------------------------------------------
-- Version 1.0 — a draft, carrying the documented programme
--
-- Seeded as `draft` and unapproved, with every undecided column left NULL.
-- That is the truthful state: the figures below come from the client's own
-- documents, and the eight questions in
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
  'Drafted from the client''s membership and lending documents. Eight rules remain undecided and are held NULL: the basis and method of the 5% rate, the savings-to-loan multiplier, whether the six qualifying months must be consecutive, whether savings may be withdrawn against a live loan, the profit distribution formula, the medical benefit annual cap and claim frequency, and the benefit waiting period. This version is a draft and enables no financial operation.'
)
on conflict (version) do nothing;

-- --- Access control --------------------------------------------------------
-- RLS on and the default grants revoked here, as `clients` does. The policies
-- themselves are in 20261019000600, where every membership policy is stated
-- together and can be reviewed as one surface.

alter table public.membership_policy_versions enable row level security;
revoke all on table public.membership_policy_versions from anon, authenticated;
