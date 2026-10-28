-- ===========================================================================
-- Polytos business-policy update — version 2.0, as a draft
-- ===========================================================================
--
-- The client's fifteen answers, written into a policy version so that they
-- are configuration rather than code. Thirteen of the fifteen are recorded
-- here; two are not, and the two that are not are the whole reason this ships
-- as a **draft**.
--
-- ## It is a draft, and nothing about that is a formality
--
-- `status = 'draft'` and `approved_at is null`, which means every generated
-- gate on it is false and it authorises nothing: no enrolment, no savings, no
-- lending, no benefit, no fine. It governs nobody, because no membership
-- points at it and no transition has moved anybody onto it.
--
-- The brief is explicit — "Do not create an approved production policy
-- version yet", "First prove the system can migrate safely" — and the draft
-- is what makes that provable. The figures can be read, the transition can be
-- previewed against it, and the whole thing can be tested, without a single
-- member being held to it.
--
-- Approving it is a deliberate act by somebody holding
-- `membership_policy:manage`, through `membership_policy_versions_guard`,
-- which stamps the approver from the session. Moving the existing book onto
-- it is a second deliberate act, per member, with each member's acceptance on
-- the record. Neither happens in a migration.
--
-- ## What is recorded, and which rule each answers
--
--   registration_fee                        5,000     (from 1.0, unchanged)
--   monthly_savings_minimum                50,000     rule 1
--   savings_qualifying_months                   6     rule 1 / rule 9
--   qualifying_months_consecutive           false     rule 1
--   savings_withdrawal_with_active_loan   blocked     rule 2
--   member_loan_interest_rate_bps             500     rule 3
--   interest_basis                      per_month     rule 3
--   interest_method                          flat     rule 4
--   savings_to_loan_multiplier_bps         20,000     rule 5  (2x)
--   medical_benefit_rate_bps                  500     rule 7  (5%)
--   medical_benefit_claims_per_year             2     rule 7 / rule 8
--   medical_benefit_year_basis  enrolment_anniversary rule 10
--   benefit_qualification_basis
--                        savings_qualifying_months     rule 9
--   death_confirmations_required                3     rule 12
--   family_condolence_benefit             100,000     rule 11
--   member_bereavement_benefit            200,000     rule 13
--   meeting_absence_fine                    5,000     rule 15
--
-- Terms carried forward from 1.0 unchanged, because the client's message does
-- not revisit them: the maximum member loan term (5 months), the weekly
-- cadence boundary (2 months), the maximum non-member term (3 months) and the
-- admission threshold (longer than 1 day).
--
-- ## What is deliberately NULL
--
-- **`medical_benefit_cap_mode`.** The client said 5% of the bill, twice a
-- year. They did not say whether there is also a shilling ceiling for the
-- year, and §9 of the brief forbids both inventing one and treating the
-- silence as approval of unlimited liability. So the mode is unrecorded, and
-- the consequence is precise and contained: `is_medical_benefit_enabled` is
-- false, every medical claim can still be recorded and have its evidence
-- checked, and assessment refuses with the decision named.
--
-- Condolence and bereavement are **not** affected, which is the entire point
-- of splitting the gate. The two benefits the client fully specified open as
-- soon as this version is approved; the one they did not stays shut.
--
-- Recording it later is one `update` on this draft, before approval:
--
--     update public.membership_policy_versions
--        set medical_benefit_cap_mode = 'no_separate_cap'
--      where version = '2.0';          -- or 'amount', with the ceiling
--
-- **`profit_distribution_basis`.** Question 6, Phase 5, and outside these
-- answers. "Do not activate profit sharing" is explicit in the brief.
--
-- **`benefit_waiting_period_days`.** Not a gap: the qualifying period under
-- this version is measured in qualifying savings months, so a day count has
-- nothing to say. Writing `0` here would assert the client decided there is
-- no waiting period, which they did not; the basis column is what carries
-- their actual answer.
--
-- ## Effective date
--
-- 1 December 2026, a month after version 1.0's. `membership_policy_versions_
-- effective_from_unique` means two versions cannot share a day, and
-- `membership_policy_allows` refuses a version whose date has not arrived —
-- so even an approved 2.0 authorises nothing until the first of December.
-- The transition's own `effective_on` is separate again, and may be later.
-- ===========================================================================

insert into public.membership_policy_versions (
  version, title, effective_from, status,

  -- Carried from 1.0, unchanged by the client's message.
  registration_fee,
  member_loan_max_term_months,
  member_loan_weekly_cadence_max_months,
  non_member_loan_max_term_months,
  medical_benefit_min_admission_days,

  -- Rule 1.
  monthly_savings_minimum,
  savings_qualifying_months,
  qualifying_months_consecutive,

  -- Rule 2.
  savings_withdrawal_with_active_loan,

  -- Rules 3 and 4.
  member_loan_interest_rate_bps,
  interest_basis,
  interest_method,

  -- Rule 5.
  savings_to_loan_multiplier_bps,

  -- Rules 7, 8 and 10.
  medical_benefit_rate_bps,
  medical_benefit_claims_per_year,
  medical_benefit_year_basis,

  -- Rule 9.
  benefit_qualification_basis,

  -- Rules 11, 12 and 13.
  family_condolence_benefit,
  death_confirmations_required,
  member_bereavement_benefit,

  -- Rule 15.
  meeting_absence_fine,

  notes
)
values (
  '2.0',
  'Polytos membership programme — official policy, management decisions of October 2026',
  date '2026-12-01',
  'draft',

  5000,
  5,
  2,
  3,
  1,

  50000,
  6,
  false,

  'blocked',

  500,
  'per_month',
  'flat',

  20000,

  500,
  2,
  'enrolment_anniversary',

  'savings_qualifying_months',

  100000,
  3,
  200000,

  5000,

  'Thirteen of the client''s fifteen decisions, as configuration. Two columns are deliberately NULL and each has a consequence that is contained rather than general: medical_benefit_cap_mode, because the client stated a claim frequency and no shilling ceiling and silence is not an approval of unlimited liability — which holds the medical benefit alone, not condolence or bereavement; and profit_distribution_basis, which is question 6 and a later phase. benefit_waiting_period_days is NULL because the qualifying period under this version is measured in qualifying savings months, so a day count has nothing to say. DRAFT: it authorises nothing, governs nobody, and is approved and transitioned onto by deliberate acts outside any migration.'
)
on conflict (version) do nothing;

-- ---------------------------------------------------------------------------
-- What the draft is waiting on, as a readable fact
-- ---------------------------------------------------------------------------
--
-- A test asserts this rather than a comment claiming it: on a clean database
-- after this migration, version 2.0 exists, is a draft, authorises nothing,
-- and names the medical cap mode as the one benefit decision outstanding.
-- `tests/db/official-policy.test.ts` is where that is checked.

comment on table public.membership_policy_versions is
  'Polytos Phase 1. An immutable, effective-dated set of membership programme terms. Version 1.0 is the client''s founding document as a draft; version 2.0 is their October 2026 decisions, also as a draft, with the medical annual-ceiling rule and the profit-distribution basis deliberately unrecorded. Contractual columns freeze the moment a version is approved or anybody is enrolled under it; changing a term is publishing a new version and moving members onto it with their acceptance.';
