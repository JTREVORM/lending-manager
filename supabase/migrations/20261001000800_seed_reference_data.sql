-- ===========================================================================
-- 20261001000800_seed_reference_data
--
-- Baseline data the application cannot run without.
--
-- This belongs in a migration rather than in `supabase/seed.sql` because it is
-- not development convenience data — it is required in production. Without
-- the `roles` rows nobody can be granted a role; without the singleton
-- settings rows there is nothing to read or edit; without `reference_formats`
-- no reference can be issued.
--
-- `supabase/seed.sql` is reserved for local development data, and deliberately
-- contains no people and no financial history.
--
-- Every statement is `ON CONFLICT DO NOTHING`, so re-running against a
-- database that already holds the rows is a no-op rather than an error.
--
-- NO REAL PERSONAL DATA. No profiles, no clients, no loans, no payments.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- Roles — mirrors ROLES in lib/permissions/roles.ts.
-- A database test asserts the two lists match exactly.
--
-- Ranks are spaced by 20 so a new role can be inserted between two existing
-- ones without renumbering.
-- ---------------------------------------------------------------------------
insert into public.roles (key, label, description, rank, is_staff)
values
  (
    'client',
    'Client',
    'A borrower. May view only their own loans, schedule and payment history through the client portal.',
    10,
    false
  ),
  (
    'secretary_treasurer',
    'Secretary / Treasurer',
    'Front-office staff. Registers clients and guarantors and records payments.',
    30,
    true
  ),
  (
    'manager',
    'Manager',
    'Supervises lending operations: approves loans, applies penalties and reviews reports.',
    50,
    true
  ),
  (
    'owner_admin',
    'Owner / Administrator',
    'Full control, including business settings, user management and the audit trail.',
    70,
    true
  )
on conflict (key) do nothing;


-- ---------------------------------------------------------------------------
-- Repayment cadences — the three the business supports today.
-- Mirrors REPAYMENT_FREQUENCY_DEFAULTS in config/defaults.ts.
-- ---------------------------------------------------------------------------
insert into public.repayment_frequencies (key, label, interval_days, is_active, sort_order)
values
  ('daily',        'Daily',         1, true, 1),
  ('every_2_days', 'Every 2 days',  2, true, 2),
  ('every_3_days', 'Every 3 days',  3, true, 3)
on conflict (key) do nothing;


-- ---------------------------------------------------------------------------
-- Reference formats — mirrors REFERENCE_FORMAT_DEFAULTS in
-- lib/domain/reference.ts.
--
-- Padding widths come from the examples the business gave: CL26001 (3 digits),
-- LN260001 and PAY260001 (4 digits). Loans and payments are padded wider
-- because there will be more of them than there are clients.
-- ---------------------------------------------------------------------------
insert into public.reference_formats (scope, prefix, padding, description)
values
  ('client',  'CL',  3, 'Client numbers, e.g. CL26001'),
  ('loan',    'LN',  4, 'Loan numbers, e.g. LN260001'),
  ('payment', 'PAY', 4, 'Payment receipt numbers, e.g. PAY260001')
on conflict (scope) do nothing;


-- ---------------------------------------------------------------------------
-- Company settings — the singleton row.
--
-- TEMPORARY NAME. Company registration is in progress, so there is no legal
-- name, registration number or TIN to record. Those columns stay NULL, and
-- `company_name` holds a working title that one UPDATE will replace.
-- ---------------------------------------------------------------------------
insert into public.company_settings (
  id,
  company_name,
  currency_code,
  locale,
  timezone,
  country
)
values (
  1,
  'Money Lending Management System',
  'UGX',
  'en-UG',
  'Africa/Kampala',
  'Uganda'
)
on conflict (id) do nothing;


-- ---------------------------------------------------------------------------
-- Business settings — the singleton row.
--
-- These are the rules the business confirmed. They are stored as DATA so the
-- Owner/Admin can change them; no calculation may hard-code them.
--
--   min_loan_amount                    UGX 100,000
--   max_loan_amount                    UGX 20,000,000  (conservative ceiling,
--                                      not stated by the business — raise it
--                                      from the settings screen)
--   default_monthly_interest_rate_bps  1500 = 15% per month, reducing principal
--   min/max_loan_term_months           1 to 3 months
--   grace_period_days                  3 days after expiry
--   penalty_rate_bps                   5000 = 50% of remaining debt, once
--   max_active_loans_per_client        1
--   default_repayment_frequency        daily
-- ---------------------------------------------------------------------------
insert into public.business_settings (
  id,
  min_loan_amount,
  max_loan_amount,
  default_monthly_interest_rate_bps,
  min_loan_term_months,
  max_loan_term_months,
  grace_period_days,
  penalty_rate_bps,
  max_active_loans_per_client,
  default_repayment_frequency
)
values (
  1,
  100000,
  20000000,
  1500,
  1,
  3,
  3,
  5000,
  1,
  'daily'
)
on conflict (id) do nothing;
