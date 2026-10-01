-- ===========================================================================
-- Phase 4 — the lending policy settings the loan engine needs.
--
-- Three rules the business has confirmed had nowhere to live:
--
--   * a loan below some amount may only run for a single month, and loans of
--     UGX 200,000 and above may qualify for two or three;
--   * a loan needs some minimum number of guarantors;
--   * interest is charged by a named method, so a loan computed under a future
--     second method stays explicable.
--
-- All three are *settings*, not constants in the engine. That is the point:
-- the business changes its lending policy without a deployment, and — because
-- Phase 4 snapshots the terms onto each loan — changing them never rewrites a
-- loan already issued.
--
-- `business_settings` already carries `min_loan_amount`, `max_loan_amount`,
-- `default_monthly_interest_rate_bps`, `min_loan_term_months`,
-- `max_loan_term_months`, `grace_period_days`, `penalty_rate_bps`,
-- `max_active_loans_per_client` and `default_repayment_frequency`. Those are
-- reused rather than duplicated.
-- ===========================================================================

alter table public.business_settings
  -- The amount at or above which a multi-month term becomes available. Below
  -- it, a loan runs for one month.
  --
  -- Note what this is not: it is not "loans of 200,000 get three months". The
  -- specification is explicit that the longer period is *available*, not
  -- automatic, so this gates the choice rather than making it.
  add column multi_month_min_amount bigint not null default 200000,

  -- How many guarantors a loan must carry before it can be approved.
  --
  -- The business has not fixed this number, so it is a setting with a
  -- deliberately modest default of one rather than an invented constant. One
  -- is the smallest number that makes the guarantor requirement real; the
  -- business raises it without a deployment when it decides to.
  add column min_guarantors_required smallint not null default 1,

  -- The interest method new loans are originated under. One method exists
  -- today; naming it means a loan carries the method it was computed with,
  -- rather than later readers having to assume.
  add column default_interest_method text not null default 'reducing_balance_monthly',

  add constraint business_settings_multi_month_min_amount_positive
    check (multi_month_min_amount > 0),

  -- A multi-month threshold below the minimum loan would mean every loan
  -- qualifies, which is a policy the business can hold but should state by
  -- setting the threshold equal to the minimum rather than by accident.
  add constraint business_settings_min_guarantors_sane
    check (min_guarantors_required between 0 and 10),

  add constraint business_settings_interest_method_valid
    check (default_interest_method in ('reducing_balance_monthly'));

comment on column public.business_settings.multi_month_min_amount is
  'At or above this amount a loan may run for more than one month. Below it, one month only.';
comment on column public.business_settings.min_guarantors_required is
  'Guarantors a loan must carry to be approved. Default 1; the business has not fixed a final number.';
comment on column public.business_settings.default_interest_method is
  'The interest method new loans are originated under. Snapshotted onto each loan.';

-- No UPDATE follows deliberately.
--
-- `ALTER TABLE ... ADD COLUMN ... DEFAULT` backfills the existing settings
-- row, so the confirmed figures are already in place. An explicit UPDATE
-- would have changed nothing except to fire the settings audit trigger,
-- leaving a migration-authored row in the trail attributed to 'system' — and
-- `tests/db/schema.test.ts` asserts that a freshly seeded database contains no
-- audit record of its own, which is how this was caught.
