-- ===========================================================================
-- Phase 5 — the repayment collection schedule.
--
-- ## The contract and the collection plan are different things
--
-- `loan_periods` (Phase 4) is the **contract**: a month-by-month
-- reducing-balance agreement, frozen at approval. "UGX 115,000 falls due in
-- the second month."
--
-- `loan_installments` (here) is the **collection plan**: how that UGX 115,000
-- is actually gathered, every day or every two or three days.
--
-- They are deliberately separate tables rather than one. Merging them would
-- mean either losing the monthly obligation that the agreement is stated in,
-- or storing each collection with a copy of its month's figures and inviting
-- the two to disagree. The schedule *allocates* the contract; it never
-- restates it, and it never recalculates interest — interest is already
-- contractually fixed, and recomputing it daily would be a different loan.
--
-- ## Two tables, because they hold two different kinds of fact
--
--   * `loan_schedules` — one row per loan. What was true **at the moment of
--     generation**: the cadence agreed, what that cadence meant in days, the
--     calendar date the money actually reached the borrower, and who released
--     it. None of this can be derived from the installments.
--
--   * `loan_installments` — the collections themselves.
--
-- The one-row-per-loan shape is also what makes generation idempotent: the
-- primary key on `loan_id` means a second attempt cannot produce a second
-- schedule, enforced by the database rather than by a check somebody could
-- forget.
--
-- ## No payment columns
--
-- There is deliberately no `amount_paid`, no `remaining_balance`, no
-- `arrears` and no `status`. Nothing posts payments yet, so `amount_paid = 0`
-- would not be a fact about a borrower — it would be a fact about this phase,
-- written in a column that looks like a ledger. Phase 6 owns payment state,
-- and it will own it in its own structures so that the original installment
-- row never has to be rewritten.
--
-- That last point matters more than it looks. Phase 7 must treat a missed
-- Monday of UGX 4,000 as arrears without changing Monday's row to UGX 8,000:
-- the original schedule is the collection plan that was agreed, and arrears
-- are a separate fact about what happened to it. A design that needed to
-- rewrite history to express arrears would make the schedule useless as
-- evidence. See docs/DECISIONS.md (ADR-026).
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- loan_schedules — the generation record
-- ---------------------------------------------------------------------------

create table public.loan_schedules (
  -- One schedule per loan, enforced structurally. This is the idempotency
  -- guarantee: a duplicate generation attempt cannot insert a second row.
  loan_id uuid primary key references public.loans (id) on delete cascade,

  -- --- The cadence, snapshotted ------------------------------------------
  -- Migration 000200 makes `repayment_frequencies.interval_days` immutable, so
  -- these cannot drift from the live row. They are captured anyway, for two
  -- reasons: a generated schedule should be explicable without reading another
  -- table at all, and a cadence the business later retires
  -- (`is_active = false`) must still be readable on the loans that used it.
  repayment_frequency text not null
    references public.repayment_frequencies (key) on delete restrict,
  frequency_label text not null,
  interval_days integer not null,

  -- --- The anchor --------------------------------------------------------
  -- The calendar date, in the business timezone, that `loans.disbursed_at`
  -- fell on. Stored as a `date` because the schedule is built from calendar
  -- days, and stored rather than re-derived so that nobody has to repeat the
  -- timezone conversion and risk a different answer.
  --
  -- Never `proposed_disbursement_date`: one is a plan that may have slipped,
  -- the other is when the borrower took possession of the money.
  disbursement_date date not null,

  -- The zone the conversion above used, recorded so a reader can verify it.
  -- Africa/Kampala today; read from company_settings, not hard-coded.
  business_timezone text not null,

  -- --- Provenance --------------------------------------------------------
  -- Which generator produced this. If the allocation or boundary rules ever
  -- change, existing schedules say which rules they were built under instead
  -- of being silently reinterpreted.
  generator_version smallint not null default 1,

  generated_at timestamptz not null default pg_catalog.now(),
  -- The disbursing user. Derived from the session by the generation function,
  -- never accepted from a caller.
  generated_by uuid references public.profiles (id) on delete restrict,

  constraint loan_schedules_interval_positive check (interval_days >= 1),
  constraint loan_schedules_interval_sane check (interval_days <= 365),
  constraint loan_schedules_label_not_blank check (btrim(frequency_label) <> ''),
  constraint loan_schedules_timezone_not_blank check (btrim(business_timezone) <> ''),
  constraint loan_schedules_generator_version_positive check (generator_version >= 1),
  constraint loan_schedules_disbursement_date_plausible
    check (disbursement_date >= '2020-01-01'::date)
);

comment on table public.loan_schedules is
  'One row per loan: the cadence, interval and disbursement calendar date a schedule was generated from. The primary key on loan_id is what makes generation idempotent.';
comment on column public.loan_schedules.interval_days is
  'Days between collections, snapshotted at generation. Immutable in repayment_frequencies too, so the agreed cadence cannot be redefined underneath a live loan.';
comment on column public.loan_schedules.disbursement_date is
  'The Africa/Kampala calendar date of loans.disbursed_at. The authoritative schedule anchor — never proposed_disbursement_date.';

-- ---------------------------------------------------------------------------
-- loan_installments — the collections
-- ---------------------------------------------------------------------------

create table public.loan_installments (
  id uuid primary key default gen_random_uuid(),

  loan_id uuid not null references public.loans (id) on delete cascade,

  -- Which contractual month this collection gathers part of. The relationship
  -- Phase 6 allocates payments through.
  loan_period_id uuid not null references public.loan_periods (id) on delete cascade,
  -- Denormalised from `loan_periods.period_number` so the schedule can be read
  -- and ordered without a join. Safe to denormalise because both tables are
  -- append-only: neither value can change, so they cannot come to disagree.
  loan_period_number smallint not null,

  -- 1-based across the whole loan.
  installment_number integer not null,
  -- 1-based within the contractual month, which is what makes "the last
  -- collection of this month carries the remainder" a readable rule.
  period_installment_number integer not null,

  -- A `date`, not a timestamp. A due date is "the 14th", not "the 14th at
  -- 00:00 UTC" — which in Kampala is 03:00 on the 14th, and in a zone behind
  -- UTC would be the 13th. Storing a midnight timestamp is how a schedule
  -- silently shifts a day; see docs/DECISIONS.md (ADR-004).
  due_date date not null,

  scheduled_principal bigint not null,
  scheduled_interest bigint not null,
  expected_amount bigint not null,

  created_at timestamptz not null default pg_catalog.now(),

  constraint loan_installments_number_positive check (installment_number >= 1),
  constraint loan_installments_period_number_positive
    check (period_installment_number >= 1),
  constraint loan_installments_loan_period_number_positive
    check (loan_period_number >= 1),

  constraint loan_installments_principal_non_negative
    check (scheduled_principal >= 0),
  constraint loan_installments_interest_non_negative
    check (scheduled_interest >= 0),

  -- The invariant that must always hold, enforced per row rather than trusted.
  constraint loan_installments_expected_follows
    check (expected_amount = scheduled_principal + scheduled_interest),

  constraint loan_installments_due_date_plausible
    check (due_date >= '2020-01-01'::date),

  -- --- Uniqueness, chosen for what each one actually means ----------------
  --
  -- Loan-wide sequence: no two collections share a position in the schedule.
  constraint loan_installments_unique_number unique (loan_id, installment_number),

  -- Within a contractual month: the positions are a sequence too, and this is
  -- what a per-period remainder rule is stated against.
  constraint loan_installments_unique_period_position
    unique (loan_period_id, period_installment_number),

  -- One collection per calendar day per loan. This is a real business
  -- invariant, not just a tidiness check: the whole reason period windows are
  -- upper-exclusive is to stop a single date belonging to two adjacent months
  -- and producing two collections on one day. Enforcing it here means a future
  -- change to the boundary rule that reintroduced that bug would fail at the
  -- database rather than quietly double a borrower's Monday.
  constraint loan_installments_unique_due_date unique (loan_id, due_date)
);

comment on table public.loan_installments is
  'The collection plan: each scheduled collection, its date, and the principal and interest it gathers from one contractual month. Append-only — this is the plan that was agreed, and arrears never rewrite it.';
comment on column public.loan_installments.due_date is
  'The Africa/Kampala calendar date the collection falls due. A date, not a timestamp, so no timezone conversion can shift it.';
comment on column public.loan_installments.loan_period_number is
  'Denormalised from loan_periods.period_number. Safe because both tables are append-only, so the two cannot drift.';
comment on constraint loan_installments_unique_due_date on public.loan_installments is
  'One collection per day per loan. Guards the upper-exclusive period boundary: without it, a boundary bug would silently double a day.';

-- ---------------------------------------------------------------------------
-- Indexes
--
-- Four, each answering a query the system actually makes. Nothing
-- speculative — an index that is never probed still has to be maintained on
-- every insert, and a schedule insert writes a few hundred rows at once.
-- ---------------------------------------------------------------------------

-- The loan detail screen: one loan's schedule, in order. Also the index the
-- reconciliation checks and the per-loan aggregates read.
create index loan_installments_loan_due_idx
  on public.loan_installments (loan_id, due_date);

-- "What is due today", and the date-range filters a collection round needs.
-- Date first, because that is the selective column across the whole book.
create index loan_installments_due_date_idx
  on public.loan_installments (due_date, loan_id);

-- Per contractual month, which is how the per-period reconciliation and the
-- grouped display read it.
create index loan_installments_period_idx
  on public.loan_installments (loan_period_id, period_installment_number);

-- ---------------------------------------------------------------------------
-- Immutability
--
-- A collection plan that can be edited is not a plan, it is a suggestion. Both
-- tables are append-only in the same way `audit_log`, `client_remarks` and the
-- Phase 4 snapshots are: a **statement-level** BEFORE trigger refuses UPDATE
-- and DELETE outright.
--
-- Statement-level is the important detail, and it is the Phase 3 lesson. A
-- row-level trigger does not fire for an UPDATE that matches no rows, so
-- `update loan_installments set expected_amount = 0 where loan_id = '<wrong>'`
-- would succeed silently and look like it had worked. This way it is refused
-- whatever the WHERE clause finds.
--
-- `reject_mutation()` is the Phase 1 guard, reused rather than reimplemented.
-- It binds the table owner and `service_role` as well, so a leaked secret key
-- cannot rewrite a due date either. There is no application path to amending a
-- schedule, by design: rescheduling is a future, explicitly audited workflow,
-- not an edit.
-- ---------------------------------------------------------------------------

create trigger loan_schedules_no_update
  before update on public.loan_schedules execute function public.reject_mutation();
create trigger loan_schedules_no_delete
  before delete on public.loan_schedules execute function public.reject_mutation();

create trigger loan_installments_no_update
  before update on public.loan_installments execute function public.reject_mutation();
create trigger loan_installments_no_delete
  before delete on public.loan_installments execute function public.reject_mutation();

alter table public.loan_schedules enable row level security;
alter table public.loan_installments enable row level security;

revoke all on table public.loan_schedules from anon, authenticated;
revoke all on table public.loan_installments from anon, authenticated;
