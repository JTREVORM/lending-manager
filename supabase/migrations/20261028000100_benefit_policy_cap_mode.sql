-- ===========================================================================
-- Polytos business-policy update — the medical cap mode, the benefit
-- qualification basis, and a gate per benefit instead of one for all three
-- ===========================================================================
--
-- The client has now answered most of the nine open questions. Two of their
-- answers do not fit the shape this schema gave the questions, and this
-- migration is that mismatch.
--
-- ## 1. "Twice a year" is a frequency, not a cap
--
-- Question 7 asked for **the most the medical benefit pays one member in a
-- year**, as a number of shillings. `medical_benefit_annual_cap` is that
-- number, and `is_benefits_enabled` waits on it.
--
-- The client answered question 8 — two claims a year — and said nothing
-- about a shilling ceiling. Three things could be true, and the schema as it
-- stands cannot tell them apart, because all three look like `NULL`:
--
--   1. a numerical annual cap applies, and it is <amount>;
--   2. no separate monetary cap applies, and the claim count is the whole
--      limit;
--   3. nobody has recorded which of the first two is the business's rule.
--
-- Collapsing 2 and 3 is the dangerous part in both directions. Reading NULL
-- as "no cap" would commit the business to 5% of an unbounded bill, twice a
-- year, on the strength of a sentence that does not say so. Reading it as
-- "undecided" forever would hold the medical benefit shut even after
-- management records that there is deliberately no monetary ceiling.
--
-- So `medical_benefit_cap_mode` records **which rule applies**, and the cap
-- amount is only meaningful under one of them:
--
--   `amount`           → `medical_benefit_annual_cap` carries the ceiling.
--   `no_separate_cap`  → there is no monetary ceiling; the claim count is
--                        the limit. The amount column must be NULL, because
--                        a number under this mode would be a second answer.
--   NULL               → not recorded. The medical gate stays shut.
--
-- Both modes are implemented and both are tested. **This migration records
-- neither**: the client's message states a frequency and is silent on a
-- monetary ceiling, and silence is not an approval of unlimited liability.
-- Mode 3 is where the official policy sits until management says otherwise,
-- and §9 of the brief is explicit that this restricts the medical approval
-- and payment gate only.
--
-- ## 2. "Saving for at least six months" is not a waiting period in days
--
-- Question 9 asked how many days after enrolment a benefit may first be
-- claimed. `benefit_waiting_period_days` is that number.
--
-- The client's benefit-qualification rule is a different measurement: a
-- confirmed member who has **been saving for at least six months**. That is
-- `member_savings_qualification` — six qualifying monthly contributions of at
-- least the monthly minimum — and it is not 180 days. A member who saved
-- nothing for five months and joined in January has served any day-count
-- waiting period and qualifies under none of the client's rule.
--
-- Writing `0` into the day count to make the gate open would assert that the
-- client decided there is no waiting period. They did not say that either.
-- So `benefit_qualification_basis` records **which measurement applies**:
--
--   `waiting_period_days`        → the Phase 4 rule, from `activated_on`.
--                                  The day count must then be recorded.
--   `savings_qualifying_months`  → the client's rule: the authoritative
--                                  savings qualification as of the claim's
--                                  own event date.
--   NULL                         → not recorded. Every benefit gate shut.
--
-- The day-count column is left exactly as it was and is simply not read
-- under the second basis. No existing row changes meaning, which is why the
-- coherence constraint below binds `waiting_period_days` only in the arm
-- that uses it.
--
-- ## 3. One gate for three benefits was always going to break
--
-- `is_benefits_enabled` is a single switch over every benefit, and the cap
-- question bears on exactly one of them. The client has now fully specified
-- family condolence (UGX 100,000, to any registered family next of kin) and
-- member bereavement (UGX 200,000, one verified next of kin, withheld while
-- a loan is outstanding), and left the medical monetary ceiling unrecorded.
-- Under the old single switch, the two fully-specified benefits would stay
-- shut because of a question neither of them asks.
--
-- Phase 4 already recorded this shape of mistake twice — ADR-059 on the
-- monthly anchor, and the note on `medical_benefit_year_basis` — and both
-- times the answer was to keep a one-benefit rule off an all-activity gate.
-- This migration finishes that: three generated columns, one per benefit,
-- and `is_benefits_enabled` redefined as the conjunction of the three so
-- that every existing reader keeps its meaning.
--
-- `medical_benefit_year_basis` now joins the medical gate. Phase 4 kept it
-- out on the grounds that two of three benefits ignore it — true, and the
-- reason there was no medical-only gate to put it in. There is one now.
-- `benefit_claim_eligibility` keeps its `medical_year_basis_undecided`
-- branch, so a claim screen still names that decision specifically rather
-- than reporting only that the gate is shut.
--
-- ## What this migration does not do
--
-- It does not approve or activate anything. Every column it adds is NULL on
-- every existing row, so every gate that was shut stays shut and every gate
-- that was open — enrolment on the demonstration version — stays open. The
-- official policy version is a separate migration and ships as a **draft**.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- The two new policy columns
-- ---------------------------------------------------------------------------

alter table public.membership_policy_versions
  add column medical_benefit_cap_mode text,
  add column benefit_qualification_basis text,
  -- Rule 12: "confirmation by at least three other group members". A client
  -- figure, so it lives where every other client figure lives — on the policy
  -- version — rather than as a constant in a function. NULL means nobody has
  -- recorded it, which is why the two death-related gates wait on it.
  add column death_confirmations_required smallint;

comment on column public.membership_policy_versions.medical_benefit_cap_mode is
  'Polytos policy update. Which medical annual-limit rule applies: "amount" (medical_benefit_annual_cap carries a shilling ceiling), "no_separate_cap" (the claim count is the whole limit and the amount column is NULL), or NULL (nobody has recorded which). NULL and "no_separate_cap" are different answers and the module treats them as such: the first holds the medical gate shut, the second opens it. Silence about a ceiling is not an approval of unlimited liability.';

comment on column public.membership_policy_versions.death_confirmations_required is
  'Polytos policy update, rule 12. How many other group members must confirm a death before a death-related benefit may be assessed. The client''s own figure is three. NULL means nobody has recorded it, and the condolence and bereavement gates wait on it — a death benefit assessed against "some confirmations" would be assessed against no rule at all.';

comment on column public.membership_policy_versions.benefit_qualification_basis is
  'Polytos policy update. How the qualifying period before a first benefit claim is measured: "waiting_period_days" (the Phase 4 rule, benefit_waiting_period_days from activated_on) or "savings_qualifying_months" (the client''s rule — the authoritative member_savings_qualification as of the claim''s event date). NULL means nobody has recorded which. Six qualifying monthly contributions is not 180 days, which is why this is a basis rather than a number.';

-- Preserve already recorded legacy decisions without inventing new amounts.
-- These are the old columns expressed in the new vocabulary. This executes
-- before the new terms guard exists, and changes no financial record.
update public.membership_policy_versions
   set medical_benefit_cap_mode = case
         when medical_benefit_annual_cap is not null then 'amount' end,
       benefit_qualification_basis = case
         when benefit_waiting_period_days is not null then 'waiting_period_days' end;

alter table public.membership_policy_versions
  add constraint membership_policy_medical_cap_mode_valid
    check (
      medical_benefit_cap_mode is null
      or medical_benefit_cap_mode in ('amount', 'no_separate_cap')
    ),
  -- The pairing, in both directions. A ceiling recorded under
  -- `no_separate_cap` would be two answers to one question; a mode of
  -- `amount` with no ceiling would be a mode that says nothing.
  add constraint membership_policy_medical_cap_mode_coherent
    check (
      case medical_benefit_cap_mode
        when 'amount'          then medical_benefit_annual_cap is not null
        when 'no_separate_cap' then medical_benefit_annual_cap is null
        else medical_benefit_annual_cap is null
      end
    ),
  add constraint membership_policy_death_confirmations_range
    check (
      death_confirmations_required is null
      or (death_confirmations_required >= 0 and death_confirmations_required <= 20)
    ),
  add constraint membership_policy_benefit_qualification_basis_valid
    check (
      benefit_qualification_basis is null
      or benefit_qualification_basis in
           ('waiting_period_days', 'savings_qualifying_months')
    ),
  -- Only the arm that reads the day count requires it. The other arm leaves
  -- `benefit_waiting_period_days` alone rather than forcing it to NULL,
  -- because every policy version written before this migration carries
  -- whatever it carries and none of them changes meaning today.
  add constraint membership_policy_benefit_qualification_coherent
    check (
      benefit_qualification_basis is distinct from 'waiting_period_days'
      or benefit_waiting_period_days is not null
    );

-- ---------------------------------------------------------------------------
-- The gates
-- ---------------------------------------------------------------------------
--
-- `membership_register` selects `is_benefits_enabled`, so it is dropped and
-- rebuilt around the replacement. Nothing else in the database depends on
-- either column — checked against `pg_depend` rather than assumed.
--
-- PostgreSQL 16 has no `ALTER COLUMN ... SET EXPRESSION`, so a generated
-- column is changed by dropping and re-adding it. The columns move to the end
-- of the table; every reader names its columns, so nothing depends on their
-- position.

drop view if exists public.membership_register;

alter table public.membership_policy_versions
  drop column is_benefits_enabled,
  drop column is_financially_enabled;

alter table public.membership_policy_versions
  -- Medical: the cap **mode**, the claim count, the qualification basis and
  -- the year the count runs over. Four decisions, and the year basis is here
  -- rather than on the all-benefit gate because it bears on this benefit
  -- alone — which is the reason it was kept off `is_benefits_enabled`.
  add column is_medical_benefit_enabled boolean
    generated always as (
      status = 'active'
      and approved_at is not null
      and medical_benefit_cap_mode is not null
      and medical_benefit_claims_per_year is not null
      and benefit_qualification_basis is not null
      and medical_benefit_year_basis is not null
    ) stored,

  -- Condolence and bereavement have a fixed benefit amount, no annual cap and
  -- no claim count, so they wait on the qualifying period alone. Whether a
  -- particular relationship qualifies is a property of the relationship and
  -- is answered on `beneficiary_relationships`; whether a particular member
  -- owes money is a property of their loans. Neither belongs on a gate about
  -- the programme.
  add column is_condolence_benefit_enabled boolean
    generated always as (
      status = 'active'
      and approved_at is not null
      and benefit_qualification_basis is not null
      and death_confirmations_required is not null
    ) stored,

  add column is_bereavement_benefit_enabled boolean
    generated always as (
      status = 'active'
      and approved_at is not null
      and benefit_qualification_basis is not null
      and death_confirmations_required is not null
    ) stored,

  -- The conjunction of the three, so that every existing reader of
  -- `is_benefits_enabled` keeps its meaning: "every benefit is open".
  -- Restated rather than referenced, because a generated column may not read
  -- another generated column.
  add column is_benefits_enabled boolean
    generated always as (
      status = 'active'
      and approved_at is not null
      and medical_benefit_cap_mode is not null
      and medical_benefit_claims_per_year is not null
      and benefit_qualification_basis is not null
      and medical_benefit_year_basis is not null
      and death_confirmations_required is not null
    ) stored,

  -- The nine client questions, and still only those nine. The medical cap and
  -- the waiting period are now asked as a mode and a basis, so the two
  -- clauses change shape; the tenth decision — the medical year — stays off
  -- this column deliberately, because this one is the client's own list.
  add column is_financially_enabled boolean
    generated always as (
      status = 'active'
      and approved_at is not null
      and interest_basis is not null
      and interest_method is not null
      and savings_to_loan_multiplier_bps is not null
      and qualifying_months_consecutive is not null
      and savings_withdrawal_with_active_loan is not null
      and profit_distribution_basis is not null
      and medical_benefit_cap_mode is not null
      and medical_benefit_claims_per_year is not null
      and benefit_qualification_basis is not null
    ) stored;

comment on column public.membership_policy_versions.is_medical_benefit_enabled is
  'Polytos policy update. Whether a medical claim may be assessed, approved and paid under this version: active, approved, with the cap mode, the claims-per-year, the qualification basis and the medical year all recorded.';

comment on column public.membership_policy_versions.is_condolence_benefit_enabled is
  'Polytos policy update. Whether a family condolence claim may be assessed, approved and paid under this version. It waits on the qualifying-period basis alone — the benefit is a fixed amount with no annual cap and no claim count, and which relationships qualify is a property of beneficiary_relationships rather than of the programme.';

comment on column public.membership_policy_versions.is_bereavement_benefit_enabled is
  'Polytos policy update. Whether a member bereavement claim may be assessed, approved and paid under this version. As with condolence, it waits on the qualifying-period basis alone; the outstanding-loan condition is a property of the member and is enforced at assessment and again at payment.';

comment on column public.membership_policy_versions.is_benefits_enabled is
  'Polytos Phase 4, redefined by the policy update: every benefit is open. The conjunction of is_medical_benefit_enabled, is_condolence_benefit_enabled and is_bereavement_benefit_enabled, restated because a generated column cannot read another. Readers that need one benefit should ask for that one — a module held shut by a question two of its three benefits never ask is the single-switch mistake this phase corrected.';

comment on column public.membership_policy_versions.is_financially_enabled is
  'Phase 1, with two clauses reshaped by the policy update. Every one of the client''s nine questions is answered: the medical ceiling now as a recorded cap mode and the qualifying period now as a recorded basis. The tenth decision, the medical benefit year, is deliberately not here — this column is the client''s own list.';

-- ---------------------------------------------------------------------------
-- The register view, rebuilt
-- ---------------------------------------------------------------------------

create view public.membership_register
with (security_invoker = true) as
select
  m.id,
  m.membership_number,
  m.client_id,
  c.client_number,
  c.full_name,
  c.phone,
  c.village_area,
  c.district,
  c.status                as client_status,
  m.branch_id,
  b.name                  as branch_name,
  m.status,
  m.status_reason,
  m.status_changed_at,
  m.applied_on,
  m.activated_on,
  m.ended_on,
  m.policy_version_id,
  v.version               as policy_version,
  -- The gates, one per activity, as the version governing this member
  -- computes them. Not `is_financially_enabled`: that is one boolean about
  -- five different activities, and a member screen that showed it would say
  -- "no" about a version under which enrolment and savings are both open.
  -- "Has it started" is deliberately absent here too — the register is a
  -- list of members, not the gate a posting consults, and that gate is
  -- `membership_policy_allows()`.
  v.is_enrolment_enabled   as policy_enrolment_enabled,
  v.is_savings_enabled     as policy_savings_enabled,
  v.is_member_lending_enabled as policy_member_lending_enabled,
  v.is_benefits_enabled    as policy_benefits_enabled,
  -- One per benefit, because the policy update split the gate. A member
  -- screen that said "benefits: no" while a condolence claim was payable
  -- would be the single-switch mistake showing through to the counter.
  v.is_medical_benefit_enabled     as policy_medical_benefit_enabled,
  v.is_condolence_benefit_enabled  as policy_condolence_benefit_enabled,
  v.is_bereavement_benefit_enabled as policy_bereavement_benefit_enabled,
  v.is_profit_sharing_enabled as policy_profit_sharing_enabled,
  m.notes,
  m.created_at,
  m.updated_at
from public.memberships m
join public.clients c on c.id = m.client_id
join public.membership_policy_versions v on v.id = m.policy_version_id
left join public.branches b on b.id = m.branch_id;

comment on view public.membership_register is
  'Polytos Phase 1. A membership with the member''s name and the policy version governing them, as one read. security_invoker, so every underlying policy still applies. The policy update added one column per benefit, because the benefit gate is now three gates.';

revoke all on table public.membership_register from anon, authenticated;
grant select on table public.membership_register to authenticated;

-- ---------------------------------------------------------------------------
-- The freeze guard covers the two new columns
-- ---------------------------------------------------------------------------
--
-- Same reasoning as the other nine and as `medical_benefit_year_basis`: a
-- member enrolled while the cap mode was unrecorded did not agree to
-- `no_separate_cap` written in afterwards, and a member enrolled under a
-- day-count waiting period did not agree to be moved onto a savings-months
-- basis. Both are contractual terms the moment anybody is held to them.
--
-- It is a trigger of its own rather than two more clauses inside
-- `membership_policy_versions_guard`, exactly as
-- `membership_policy_year_basis_guard` is, so neither function is a copy of
-- the other and the rule can be tested as a rule.

create or replace function public.membership_policy_terms_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_in_use boolean;
begin
  if new.medical_benefit_cap_mode is not distinct from old.medical_benefit_cap_mode
     and new.benefit_qualification_basis
           is not distinct from old.benefit_qualification_basis
     and new.death_confirmations_required
           is not distinct from old.death_confirmations_required then
    return new;
  end if;

  if old.approved_at is not null then
    raise exception
      'Policy version % has been approved. Publish a new version to change how the medical ceiling, the benefit qualifying period or the death-confirmation requirement is measured.',
      old.version using errcode = 'P0001';
  end if;

  select exists (
    select 1 from public.memberships m where m.policy_version_id = old.id
  ) into v_in_use;

  if v_in_use then
    raise exception
      'Members are enrolled under policy version %. Publish a new version to change how the medical ceiling, the benefit qualifying period or the death-confirmation requirement is measured.',
      old.version using errcode = 'P0001';
  end if;

  return new;
end;
$$;

comment on function public.membership_policy_terms_guard() is
  'Polytos policy update. Freezes medical_benefit_cap_mode, benefit_qualification_basis and death_confirmations_required once a version is approved or anybody is enrolled under it. Both are contractual: a member enrolled while the ceiling rule was unrecorded did not agree to "no separate cap" written in afterwards.';

create trigger membership_policy_terms_guard
  before update on public.membership_policy_versions
  for each row execute function public.membership_policy_terms_guard();

-- ---------------------------------------------------------------------------
-- `membership_policy_allows` learns the three benefits
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
       'enrolment', 'savings', 'lending', 'benefits', 'profit_sharing',
       -- The policy update: one name per benefit. `benefits` is kept and
       -- still means all three, so every Phase 4 caller is unchanged.
       'medical_benefit', 'condolence_benefit', 'bereavement_benefit'
     ) then
    raise exception
      'There is no membership activity called %. The gates are enrolment, savings, lending, benefits, medical_benefit, condolence_benefit, bereavement_benefit and profit_sharing.',
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
    when 'enrolment'           then v.is_enrolment_enabled
    when 'savings'             then v.is_savings_enabled
    when 'lending'             then v.is_member_lending_enabled
    when 'benefits'            then v.is_benefits_enabled
    when 'medical_benefit'     then v.is_medical_benefit_enabled
    when 'condolence_benefit'  then v.is_condolence_benefit_enabled
    when 'bereavement_benefit' then v.is_bereavement_benefit_enabled
    when 'profit_sharing'      then v.is_profit_sharing_enabled
  end;

  return coalesce(v_ready, false);
end;
$$;

comment on function public.membership_policy_allows(uuid, text) is
  'Phase 1, extended by the policy update. Whether a version authorises an activity: the generated readiness column and the effective date. Eight activities — the five original ones plus one per benefit, because the benefit gate is now three gates and a condolence claim should not wait on a medical question.';

-- ---------------------------------------------------------------------------
-- A benefit-specific blocked reason
-- ---------------------------------------------------------------------------

create or replace function public.benefit_blocked_reason(
  p_version_id uuid,
  p_benefit text
)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v public.membership_policy_versions;
  v_missing text[] := '{}';
begin
  if p_benefit is null
     or p_benefit not in ('medical', 'family_condolence', 'member_bereavement') then
    raise exception
      'There is no benefit called %. The benefits are medical, family_condolence and member_bereavement.',
      coalesce(p_benefit, '(null)') using errcode = 'P0001';
  end if;

  select * into v
  from public.membership_policy_versions where id = p_version_id;

  if not found then
    return 'That policy version does not exist.';
  end if;

  if v.status <> 'active' then
    return pg_catalog.format(
      'Policy version %s is %s, so it authorises nothing.', v.version, v.status);
  end if;

  if v.approved_at is null then
    return pg_catalog.format(
      'Policy version %s has not been approved.', v.version);
  end if;

  if v.effective_from > public.business_date() then
    return pg_catalog.format(
      'Policy version %s takes effect on %s.', v.version, v.effective_from);
  end if;

  -- Every benefit waits on this one: how the qualifying period before a first
  -- claim is measured. The `::text` casts matter — without them PostgreSQL
  -- reads `text[] || <untyped literal>` as array concatenation and tries to
  -- parse the sentence as an array literal.
  if v.benefit_qualification_basis is null then
    v_missing := v_missing
      || 'how the qualifying period before a first claim is measured — six qualifying savings months, or a number of days from enrolment'::text;
  end if;

  if p_benefit in ('family_condolence', 'member_bereavement')
     and v.death_confirmations_required is null then
    v_missing := v_missing
      || 'how many other group members must confirm a death before the benefit is assessed'::text;
  end if;

  if p_benefit = 'medical' then
    if v.medical_benefit_cap_mode is null then
      v_missing := v_missing
        || 'whether the medical benefit has a shilling ceiling for the year or whether the claim count is the whole limit'::text;
    end if;

    if v.medical_benefit_claims_per_year is null then
      v_missing := v_missing
        || 'how many medical claims a member may make in a year'::text;
    end if;

    if v.medical_benefit_year_basis is null then
      v_missing := v_missing
        || 'whether that year is the calendar year or the year from the member''s own enrolment anniversary'::text;
    end if;
  end if;

  if pg_catalog.array_length(v_missing, 1) is null then
    return null;
  end if;

  return case p_benefit
           when 'medical'            then 'Medical benefit payments wait on '
           when 'family_condolence'  then 'Family condolence payments wait on '
           when 'member_bereavement' then 'Member bereavement payments wait on '
         end
    || pg_catalog.array_to_string(v_missing, '; ')
    || '. Until that is recorded, a claim of this kind can be recorded and its evidence checked, but it cannot be assessed, approved or paid.';
end;
$$;

comment on function public.benefit_blocked_reason(uuid, text) is
  'Polytos policy update. What one benefit is waiting on under a version, naming the decisions rather than reporting that something is unavailable. Separate from benefits_blocked_reason, which answers for all three at once.';

grant execute on function public.benefit_blocked_reason(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- `benefits_blocked_reason` names the decisions as they are now asked
-- ---------------------------------------------------------------------------

create or replace function public.benefits_blocked_reason(p_version_id uuid)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v public.membership_policy_versions;
  v_missing text[] := '{}';
begin
  select * into v
  from public.membership_policy_versions where id = p_version_id;

  if not found then
    return 'That policy version does not exist.';
  end if;

  if v.status <> 'active' then
    return pg_catalog.format(
      'Policy version %s is %s, so it authorises nothing.', v.version, v.status);
  end if;

  if v.approved_at is null then
    return pg_catalog.format(
      'Policy version %s has not been approved.', v.version);
  end if;

  if v.effective_from > public.business_date() then
    return pg_catalog.format(
      'Policy version %s takes effect on %s.', v.version, v.effective_from);
  end if;

  if v.medical_benefit_cap_mode is null then
    v_missing := v_missing
      || 'whether the medical benefit has a shilling ceiling for the year, or whether the two-claim limit is the whole limit'::text;
  end if;

  if v.medical_benefit_claims_per_year is null then
    v_missing := v_missing
      || 'how many medical claims a member may make in a year'::text;
  end if;

  if v.benefit_qualification_basis is null then
    v_missing := v_missing
      || 'how the qualifying period before a first claim is measured'::text;
  end if;

  if v.medical_benefit_year_basis is null then
    v_missing := v_missing
      || 'whether the medical year is the calendar year or the member''s own enrolment year'::text;
  end if;

  if v.death_confirmations_required is null then
    v_missing := v_missing
      || 'how many other group members must confirm a death'::text;
  end if;

  if pg_catalog.array_length(v_missing, 1) is null then
    return null;
  end if;

  return 'Some benefit payments wait on '
    || pg_catalog.array_to_string(v_missing, '; ')
    || '. Each benefit is gated on its own decisions, so ask benefit_blocked_reason for the one you need.';
end;
$$;


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

revoke all on function public.membership_policy_terms_guard() from public, anon, authenticated;
revoke all on function public.membership_policy_allows(uuid, text) from public, anon;
revoke all on function public.benefit_blocked_reason(uuid, text) from public, anon;
revoke all on function public.benefits_blocked_reason(uuid) from public, anon;
