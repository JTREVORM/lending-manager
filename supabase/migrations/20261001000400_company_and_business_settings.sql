-- ===========================================================================
-- 20261001000400_company_and_business_settings
--
-- Two singleton settings tables, plus the repayment-cadence vocabulary.
--
-- ## Why two tables
--
-- `company_settings` is identity and branding — who the business is. It
-- changes when the company registers, rebrands or moves.
--
-- `business_settings` is lending policy — how the business lends. It changes
-- when the Owner/Admin adjusts a rate or a limit.
--
-- They are separated because they have different audiences, different change
-- frequencies and (in Phase 2) different permissions: a manager may well read
-- lending policy without being allowed to edit the company's tax number.
--
-- ## Why singletons rather than versioned rows
--
-- `business_settings` holds the *current* defaults. It is deliberately not a
-- history table, because a rate change must never retroactively alter an
-- existing loan: loans snapshot their own terms at origination (Phase 3), so
-- the schedule a client agreed to is the schedule they keep. The change
-- history of the settings themselves lives in `public.audit_log`.
--
-- The singleton is enforced by `CHECK (id = 1)` on a `smallint` primary key:
-- a second row is rejected by the database, not by convention.
--
-- ## Everything here is data, not code
--
-- The business's 15% monthly interest and 50% penalty are *seeded values in
-- these columns*. No calculation may hard-code them — see
-- docs/DECISIONS.md (ADR-008). Rates are integer basis points (15% = 1500) and
-- amounts are bigint whole shillings.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- Repayment cadences
--
-- A lookup table rather than an array column or an enum, so the Owner/Admin
-- can retire a cadence (`is_active = false`) without breaking the loans that
-- already reference it, and add one without a migration.
-- ---------------------------------------------------------------------------
create table public.repayment_frequencies (
  key text primary key,
  label text not null,

  -- Days between consecutive installments: 1 = daily, 2 = every 2 days.
  interval_days integer not null,

  -- Retiring a cadence hides it from new loans; existing loans keep it.
  is_active boolean not null default true,

  sort_order integer not null,

  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),

  constraint repayment_frequencies_key_format check (key ~ '^[a-z][a-z0-9_]*$'),
  constraint repayment_frequencies_label_not_blank check (btrim(label) <> ''),
  constraint repayment_frequencies_interval_range check (interval_days between 1 and 365),
  constraint repayment_frequencies_sort_order_positive check (sort_order > 0)
);

comment on table public.repayment_frequencies is
  'Supported repayment cadences. Retired by setting is_active = false, never deleted, so historical loans keep a valid reference.';

create trigger repayment_frequencies_set_updated_at
  before update on public.repayment_frequencies
  for each row
  execute function public.set_updated_at();


-- ---------------------------------------------------------------------------
-- Company identity and branding — single source of truth
--
-- The company name is NOT a UI constant. Components read this row (via
-- lib/data/company.ts) and fall back to config/defaults.ts only when the row
-- cannot be read. When registration completes, one UPDATE renames the system
-- everywhere.
-- ---------------------------------------------------------------------------
create table public.company_settings (
  id smallint primary key default 1,

  company_name text not null,

  -- All NULL until company registration completes.
  legal_name text,
  registration_number text,
  tax_identification_number text,

  phone text,
  email text,

  address_line1 text,
  address_line2 text,
  city text,
  country text,

  currency_code char(3) not null default 'UGX',
  locale text not null default 'en-UG',

  -- IANA timezone. Read by public.next_reference() to decide the reference
  -- year, so the business timezone is configured in exactly one place.
  timezone text not null default 'Africa/Kampala',

  -- Object path inside the private `company-assets` bucket, not a URL.
  -- Delivery is via a signed URL; see docs/DECISIONS.md (ADR-010).
  logo_path text,

  receipt_header text,
  receipt_footer text,
  brand_primary_color text,

  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  updated_by uuid references public.profiles (id) on delete restrict,

  constraint company_settings_singleton check (id = 1),

  constraint company_settings_company_name_length
    check (char_length(btrim(company_name)) between 2 and 120),

  constraint company_settings_currency_code_format
    check (currency_code ~ '^[A-Z]{3}$'),

  constraint company_settings_locale_format
    check (locale ~ '^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$'),

  constraint company_settings_timezone_not_blank
    check (btrim(timezone) <> ''),

  constraint company_settings_phone_e164
    check (phone is null or phone ~ '^\+256[0-9]{9}$'),

  constraint company_settings_email_shape
    check (email is null or email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),

  constraint company_settings_brand_color_hex
    check (brand_primary_color is null or brand_primary_color ~ '^#[0-9A-Fa-f]{6}$'),

  -- No absolute paths and no traversal, so a crafted value cannot escape its
  -- bucket prefix.
  constraint company_settings_logo_path_safe
    check (
      logo_path is null
      or (logo_path ~ '^[A-Za-z0-9][A-Za-z0-9._/-]*$' and logo_path not like '%..%')
    )
);

comment on table public.company_settings is
  'Singleton (id = 1). Authoritative company identity and branding. The company name is temporary until registration completes.';
comment on column public.company_settings.timezone is
  'IANA timezone of the business. Read by public.next_reference() to determine the reference year.';
comment on column public.company_settings.logo_path is
  'Object path within the private company-assets storage bucket. Not a public URL.';

create trigger company_settings_set_updated_at
  before update on public.company_settings
  for each row
  execute function public.set_updated_at();


-- ---------------------------------------------------------------------------
-- Lending policy — configurable, never hard-coded
-- ---------------------------------------------------------------------------
create table public.business_settings (
  id smallint primary key default 1,

  -- Whole Ugandan shillings.
  min_loan_amount bigint not null,
  max_loan_amount bigint not null,

  -- Monthly interest in basis points. 15% is 1500. Applied to the reducing
  -- principal by the Phase 3 engine, which reads this value rather than
  -- embedding it.
  default_monthly_interest_rate_bps integer not null,

  min_loan_term_months integer not null,
  max_loan_term_months integer not null,

  -- Days after loan expiry before a penalty may be applied.
  grace_period_days integer not null,

  -- One-time penalty on the remaining outstanding debt, in basis points.
  -- 50% is 5000.
  penalty_rate_bps integer not null,

  -- The business permits one active loan per client today. Stored as a number
  -- so the rule is configurable rather than a constant in the codebase.
  max_active_loans_per_client integer not null default 1,

  default_repayment_frequency text not null
    references public.repayment_frequencies (key) on delete restrict,

  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  updated_by uuid references public.profiles (id) on delete restrict,

  constraint business_settings_singleton check (id = 1),

  constraint business_settings_min_loan_positive
    check (min_loan_amount > 0),

  -- Mirrors MAX_UGX_AMOUNT in lib/domain/money.ts.
  constraint business_settings_max_loan_in_range
    check (max_loan_amount between 1 and 1000000000000000),

  constraint business_settings_loan_amount_order
    check (max_loan_amount >= min_loan_amount),

  -- Mirrors MAX_BPS in lib/domain/rate.ts.
  constraint business_settings_interest_rate_range
    check (default_monthly_interest_rate_bps between 0 and 1000000),

  constraint business_settings_penalty_rate_range
    check (penalty_rate_bps between 0 and 1000000),

  constraint business_settings_min_term_positive
    check (min_loan_term_months >= 1),

  constraint business_settings_max_term_in_range
    check (max_loan_term_months between 1 and 120),

  constraint business_settings_term_order
    check (max_loan_term_months >= min_loan_term_months),

  constraint business_settings_grace_period_range
    check (grace_period_days between 0 and 3650),

  constraint business_settings_active_loans_range
    check (max_active_loans_per_client between 1 and 20)
);

comment on table public.business_settings is
  'Singleton (id = 1). Configurable lending rules. Loans snapshot their own terms at origination, so editing a rate here never rewrites an existing schedule.';
comment on column public.business_settings.default_monthly_interest_rate_bps is
  'Monthly interest in integer basis points (1500 = 15%). Read by the Phase 3 calculation engine; never hard-coded.';
comment on column public.business_settings.penalty_rate_bps is
  'One-time post-grace-period penalty in integer basis points (5000 = 50%), applied to the remaining outstanding debt.';
comment on column public.business_settings.max_active_loans_per_client is
  'Concurrent active loans permitted per client. Currently 1, by business rule.';

create trigger business_settings_set_updated_at
  before update on public.business_settings
  for each row
  execute function public.set_updated_at();


-- --- Access control -------------------------------------------------------

alter table public.repayment_frequencies enable row level security;
alter table public.company_settings enable row level security;
alter table public.business_settings enable row level security;

revoke all on table public.repayment_frequencies from anon, authenticated;
revoke all on table public.company_settings from anon, authenticated;
revoke all on table public.business_settings from anon, authenticated;

-- `repayment_frequencies` is a vocabulary, like `roles`: three keys, their
-- labels and their intervals. No personal or financial data. Opened for
-- reading to signed-in users only, and limited to active cadences so a
-- retired one does not appear in a picker.
grant select on table public.repayment_frequencies to authenticated;

create policy repayment_frequencies_select_authenticated
  on public.repayment_frequencies
  for select
  to authenticated
  using (is_active);

comment on policy repayment_frequencies_select_authenticated on public.repayment_frequencies is
  'Active cadences are readable by any signed-in user. Non-sensitive vocabulary.';

-- DEFERRED TO PHASE 2 — intentionally absent:
--   * company_settings SELECT for staff; UPDATE for owner_admin
--   * business_settings SELECT for staff; UPDATE for owner_admin
--   * repayment_frequencies write policies for owner_admin
--
-- Note in particular that company_settings is NOT readable yet, including for
-- branding the sign-in page. Phase 2 decides how the company name reaches an
-- anonymous visitor — most likely a narrow server-side read exposing the name
-- and logo alone, rather than opening the row (which also holds the tax
-- number and registration details) to `anon`.
