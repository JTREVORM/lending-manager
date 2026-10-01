-- ===========================================================================
-- Phase 4 — the contractual breakdown and the identity snapshots.
--
-- ## Why snapshots exist at all
--
-- Phase 3 left this as an explicit obligation. A client moves; a guarantor
-- changes their number; the business raises its rate. If a loan file read
-- through to the live records, then every one of those ordinary edits would
-- silently rewrite what the business claims it was told in 2026 — and the file
-- would stop being evidence in exactly the dispute it exists for.
--
-- So at approval the loan captures what the business relied on. The live
-- records keep moving; the snapshot does not.
--
-- ## Why the identity snapshot is a separate table
--
-- Phase 3's central decision (ADR-018) was that a National Identification
-- Number lives behind its own policy, because PostgreSQL cannot restrict
-- columns to application roles — every signed-in user is `authenticated`, so
-- a NIN column on a broadly readable table is protected by nothing but the
-- interface not selecting it.
--
-- Copying NINs into a loan table readable by anyone with `loans:view` would
-- undo that in one line. A Secretary/Treasurer who cannot read a client's NIN
-- would simply read it off the loan instead.
--
-- `loan_identity_snapshots` therefore holds every NIN captured for a loan —
-- the client's and each guarantor's — behind `loans:view_sensitive`, which
-- only the Manager and the Owner hold. One table rather than two, because the
-- rule is identical for both subjects and a `subject_type` column is cheaper
-- to reason about than two near-identical tables.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- loan_periods — the contractual monthly breakdown
--
-- This is **not** the repayment schedule. It is the month-by-month
-- reducing-balance agreement: what principal falls due, what interest it
-- carries, what remains outstanding. Phase 5 turns this into actual collection
-- dates at a daily, two-day or three-day rhythm; the two must not be
-- conflated, because one is the contract and the other is the collection plan.
-- ---------------------------------------------------------------------------

create table public.loan_periods (
  id uuid primary key default gen_random_uuid(),
  loan_id uuid not null references public.loans (id) on delete cascade,

  period_number smallint not null,
  opening_principal bigint not null,
  principal_portion bigint not null,
  interest bigint not null,
  total_obligation bigint not null,
  closing_principal bigint not null,

  created_at timestamptz not null default pg_catalog.now(),

  constraint loan_periods_number_positive check (period_number >= 1),
  constraint loan_periods_opening_non_negative check (opening_principal >= 0),
  constraint loan_periods_principal_non_negative check (principal_portion >= 0),
  constraint loan_periods_interest_non_negative check (interest >= 0),
  constraint loan_periods_closing_non_negative check (closing_principal >= 0),

  -- The two arithmetic identities, enforced per row. A breakdown that fails
  -- either is not a rounding disagreement; it is corruption.
  constraint loan_periods_closing_follows
    check (closing_principal = opening_principal - principal_portion),
  constraint loan_periods_obligation_follows
    check (total_obligation = principal_portion + interest),

  constraint loan_periods_unique_per_loan unique (loan_id, period_number)
);

comment on table public.loan_periods is
  'The contractual monthly reducing-balance breakdown. Not the repayment schedule: Phase 5 generates collection dates from this.';
comment on column public.loan_periods.opening_principal is
  'Principal outstanding at the start of the period. Interest is charged on this figure — that is what reducing balance means.';

create index loan_periods_loan_idx on public.loan_periods (loan_id, period_number);

-- ---------------------------------------------------------------------------
-- loan_client_snapshots — who the business lent to
-- ---------------------------------------------------------------------------

create table public.loan_client_snapshots (
  loan_id uuid primary key references public.loans (id) on delete cascade,

  -- Kept so the live record can still be reached, while nothing is read
  -- *through* it for historical purposes.
  client_id uuid not null references public.clients (id) on delete restrict,

  client_number text not null,
  full_name text not null,
  phone text not null,
  alternative_phone text,
  sex text not null,
  date_of_birth date not null,
  occupation text not null,
  business_type text,
  village_area text not null,
  district text not null,

  -- The eligibility the business relied on. A client suspended next year does
  -- not retroactively make this loan improper.
  client_status_at_origination text not null,

  captured_at timestamptz not null default pg_catalog.now(),

  constraint loan_client_snapshots_name_not_blank check (btrim(full_name) <> ''),
  constraint loan_client_snapshots_phone_e164 check (phone ~ '^\+256[0-9]{9}$'),
  constraint loan_client_snapshots_sex_valid check (sex in ('female', 'male'))
);

comment on table public.loan_client_snapshots is
  'The client details the business relied on when issuing this loan. Immutable; later profile edits do not reach it.';
comment on column public.loan_client_snapshots.client_status_at_origination is
  'The client status at approval. Evidence that eligibility was checked, not a live status.';

-- ---------------------------------------------------------------------------
-- loan_guarantor_snapshots — who vouched for it
-- ---------------------------------------------------------------------------

create table public.loan_guarantor_snapshots (
  id uuid primary key default gen_random_uuid(),
  loan_id uuid not null references public.loans (id) on delete cascade,
  guarantor_id uuid not null references public.guarantors (id) on delete restrict,

  full_name text not null,
  phone text not null,
  alternative_phone text,
  sex text not null,
  date_of_birth date not null,
  occupation text not null,
  location text not null,
  district text,

  -- Per association, not per person: the same guarantor is a brother to one
  -- client and a business partner to another.
  relationship_to_client text not null,

  -- Whether a photograph was on file at origination. The path is not copied:
  -- the object lives in a private bucket under Phase 3's policies, and
  -- duplicating the path here would create a second route to it.
  had_photograph boolean not null default false,

  captured_at timestamptz not null default pg_catalog.now(),

  constraint loan_guarantor_snapshots_name_not_blank check (btrim(full_name) <> ''),
  constraint loan_guarantor_snapshots_phone_e164 check (phone ~ '^\+256[0-9]{9}$'),
  constraint loan_guarantor_snapshots_sex_valid check (sex in ('female', 'male')),
  constraint loan_guarantor_snapshots_relationship_not_blank
    check (btrim(relationship_to_client) <> ''),
  constraint loan_guarantor_snapshots_unique_per_loan unique (loan_id, guarantor_id)
);

comment on table public.loan_guarantor_snapshots is
  'The guarantor details relied on at origination. A guarantor changing their phone later does not rewrite this.';

create index loan_guarantor_snapshots_loan_idx
  on public.loan_guarantor_snapshots (loan_id);
create index loan_guarantor_snapshots_guarantor_idx
  on public.loan_guarantor_snapshots (guarantor_id);

-- ---------------------------------------------------------------------------
-- loan_identity_snapshots — the sensitive half
--
-- Every National Identification Number captured for a loan, client and
-- guarantor alike, behind `loans:view_sensitive`.
-- ---------------------------------------------------------------------------

create table public.loan_identity_snapshots (
  id uuid primary key default gen_random_uuid(),
  loan_id uuid not null references public.loans (id) on delete cascade,

  subject_type text not null,
  -- The client or guarantor this number belongs to. Not a foreign key,
  -- because it references one of two tables depending on `subject_type`; the
  -- referential pairing is maintained by the approval function, which is the
  -- only thing that writes here.
  subject_id uuid not null,

  nin text,

  captured_at timestamptz not null default pg_catalog.now(),

  constraint loan_identity_snapshots_subject_valid
    check (subject_type in ('client', 'guarantor')),
  constraint loan_identity_snapshots_nin_shape
    check (nin is null or nin ~ '^C[MF][0-9A-Z]{12}$'),
  constraint loan_identity_snapshots_unique_subject
    unique (loan_id, subject_type, subject_id)
);

comment on table public.loan_identity_snapshots is
  'National Identification Numbers captured against a loan. Separate from the loan and from the other snapshots so that reading one is a distinct, policy-enforced privilege — see ADR-018.';
comment on column public.loan_identity_snapshots.subject_id is
  'The client or guarantor the number belongs to, per subject_type. Written only by approve_loan().';

create index loan_identity_snapshots_loan_idx
  on public.loan_identity_snapshots (loan_id);

-- ---------------------------------------------------------------------------
-- Immutability
--
-- A snapshot that can be edited is not a snapshot. All four tables are
-- append-only in the same way `audit_log` and `client_remarks` are: a
-- statement-level BEFORE trigger refuses UPDATE and DELETE outright, so the
-- refusal does not depend on an attacker's WHERE clause matching anything.
--
-- Statement-level matters here. A row-level trigger does not fire for an
-- UPDATE that matches no rows, so `update loan_periods set interest = 0`
-- against the wrong loan id would succeed silently and look like it had
-- worked. This way it is refused regardless.
--
-- `reject_mutation()` is the Phase 1 guard, reused rather than reimplemented.
-- ---------------------------------------------------------------------------

create trigger loan_periods_no_update
  before update on public.loan_periods execute function public.reject_mutation();
create trigger loan_periods_no_delete
  before delete on public.loan_periods execute function public.reject_mutation();

create trigger loan_client_snapshots_no_update
  before update on public.loan_client_snapshots execute function public.reject_mutation();
create trigger loan_client_snapshots_no_delete
  before delete on public.loan_client_snapshots execute function public.reject_mutation();

create trigger loan_guarantor_snapshots_no_update
  before update on public.loan_guarantor_snapshots execute function public.reject_mutation();
create trigger loan_guarantor_snapshots_no_delete
  before delete on public.loan_guarantor_snapshots execute function public.reject_mutation();

create trigger loan_identity_snapshots_no_update
  before update on public.loan_identity_snapshots execute function public.reject_mutation();
create trigger loan_identity_snapshots_no_delete
  before delete on public.loan_identity_snapshots execute function public.reject_mutation();

alter table public.loan_periods enable row level security;
alter table public.loan_client_snapshots enable row level security;
alter table public.loan_guarantor_snapshots enable row level security;
alter table public.loan_identity_snapshots enable row level security;

revoke all on table public.loan_periods from anon, authenticated;
revoke all on table public.loan_client_snapshots from anon, authenticated;
revoke all on table public.loan_guarantor_snapshots from anon, authenticated;
revoke all on table public.loan_identity_snapshots from anon, authenticated;
