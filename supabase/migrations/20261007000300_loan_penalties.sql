-- ===========================================================================
-- Phase 7 — the expiry penalty, as its own obligation.
--
-- ## Why a table rather than a column on the loan
--
-- The business rule is that an unpaid loan is charged 50% of what it owed
-- when the grace period ran out. That charge is a **new obligation**, not a
-- change to the agreement: the principal, the contractual interest, the
-- monthly periods and every scheduled collection stay exactly as they were
-- agreed and generated.
--
-- Columns on `loans` would mean the opposite. `total_expected_repayment`
-- would stop meaning "what this borrower agreed to repay" and start meaning
-- "what they owe us now, including a charge added later", and the two are
-- different questions that a dispute turns on. ADR-023's snapshot argument
-- applies directly: the contract is a record of what was agreed, and nothing
-- that happens afterwards may rewrite it.
--
-- So a penalty is a row of its own, carrying the complete provenance of the
-- charge: the final due date it followed, the grace period that applied, the
-- balance it was calculated from, the rate, and the date it took effect.
-- Anybody can reconstruct the arithmetic from the row alone.
--
-- ## Why the amount is a CHECK rather than a trusted calculation
--
-- `loan_penalties_amount_matches_basis` re-derives the penalty from the basis
-- and the rate and refuses the row if they disagree. That is not redundancy
-- with the function that inserts it: it means a **forged** penalty is
-- impossible rather than merely unauthorized. The table owner and
-- `service_role` can bypass every policy in this schema, but neither can
-- store a penalty whose amount is not exactly half-up 50% of a stated basis.
--
-- The same reasoning gives the dates their own CHECK: a row claiming a grace
-- period that does not match its own dates cannot exist.
--
-- ## One penalty, ever
--
-- `loan_penalties_one_per_loan` is a unique index on `(loan_id,
-- penalty_type)`. The confirmed rule is a one-time charge: not 50% a day, not
-- 50% a month, and never a penalty on a penalty. Making that a uniqueness
-- rule rather than a check in application code means two concurrent
-- materialisations cannot both succeed however they race — see
-- `ensure_penalty_applied` for the lock that turns the loser into a clean
-- no-op rather than a constraint violation.
--
-- ## Append-only, with no exceptions at all
--
-- Not even the status-transition exception `loan_payments` allows. There is
-- nothing in this row that may ever change: a penalty recorded in error is a
-- defect to be fixed in the rule that created it, and a waiver — if the
-- business ever wants one — is a new audited transaction that leaves the
-- penalty standing. Free-form editing of a charge against a borrower is
-- exactly what must not exist.
-- ===========================================================================

create table public.loan_penalties (
  id uuid primary key default gen_random_uuid(),

  loan_id uuid not null references public.loans (id) on delete cascade,

  -- Denormalised from the loan, as `loan_payments.client_id` is, so a policy
  -- and a report can reach the borrower without a join. Safe because a loan
  -- never changes hands: `loans.client_id` is immutable from draft onwards.
  client_id uuid not null references public.clients (id) on delete restrict,

  -- The kind of charge. One value today; named rather than implied so that a
  -- future charge of a different kind is a new value in a documented
  -- vocabulary instead of a second table that duplicates this one.
  penalty_type text not null default 'expiry_penalty',

  -- --- The contractual facts this charge followed from -------------------
  --
  -- Snapshotted, not looked up. A penalty must stay explicable after the
  -- business changes its grace period or its penalty rate, and after the
  -- settings row has moved on several times. This is the ADR-023 rule applied
  -- to a charge.
  final_due_date date not null,
  grace_period_days smallint not null,
  grace_end_date date not null,

  -- The business date on which the charge took effect: the day after the
  -- grace period ended. A payment made on this date is made *after* the
  -- penalty, which is what makes the boundary unambiguous.
  effective_date date not null,

  -- --- The arithmetic ----------------------------------------------------
  basis_amount bigint not null,
  penalty_rate_bps integer not null,
  penalty_amount bigint not null,

  -- Why this row exists, in words, for a reader who has only the row.
  trigger_rule text not null default 'grace_period_expired',

  -- When the system materialised it, as distinct from the business date it
  -- took effect on. These differ whenever a penalty becomes eligible before
  -- anything touches the loan, and the difference is not a defect: the charge
  -- dates from the rule, not from the moment a process noticed.
  applied_at timestamptz not null default pg_catalog.now(),
  created_at timestamptz not null default pg_catalog.now(),

  constraint loan_penalties_type_known
    check (penalty_type in ('expiry_penalty')),

  constraint loan_penalties_trigger_rule_known
    check (trigger_rule in ('grace_period_expired')),

  -- Money and rates, in the project's types. A rate of zero would make a
  -- penalty of zero, which is not a penalty; a basis of zero would mean the
  -- borrower owed nothing and should never have been charged.
  constraint loan_penalties_basis_positive
    check (basis_amount > 0),
  constraint loan_penalties_rate_positive
    check (penalty_rate_bps > 0 and penalty_rate_bps <= 1000000),
  constraint loan_penalties_amount_positive
    check (penalty_amount > 0),

  -- Half-up to the whole shilling, in integer arithmetic. `+ 5000` before an
  -- integer division by 10000 is the rounding rule ADR-002 fixed and
  -- `calculate_loan_breakdown` already uses, so a penalty rounds the way
  -- every other figure in the system rounds.
  constraint loan_penalties_amount_matches_basis
    check (penalty_amount = (basis_amount * penalty_rate_bps + 5000) / 10000),

  -- The grace window, stated as arithmetic so it cannot be misdescribed.
  constraint loan_penalties_grace_days_non_negative
    check (grace_period_days >= 0),
  constraint loan_penalties_grace_end_follows_due_date
    check (grace_end_date = final_due_date + grace_period_days),
  constraint loan_penalties_effective_follows_grace
    check (effective_date = grace_end_date + 1)
);

comment on table public.loan_penalties is
  'The one-time expiry penalty charged when a loan is still unpaid after its grace period. An obligation in its own right: nothing here alters the contract. Append-only, system-calculated, one row per loan.';

comment on column public.loan_penalties.basis_amount is
  'The effective amount owed at the end of the grace period, reconstructed from the ledger as it stood on that date. Never today''s smaller balance.';
comment on column public.loan_penalties.penalty_rate_bps is
  'The loan''s own snapshotted penalty rate in basis points (5000 = 50%), not the current business setting.';
comment on column public.loan_penalties.penalty_amount is
  'basis_amount x rate, half-up to the whole shilling. Enforced by CHECK, so a forged amount cannot be stored even by the table owner.';
comment on column public.loan_penalties.effective_date is
  'The business date the charge took effect: the day after the grace period ended. A payment on this date is made after the penalty.';
comment on column public.loan_penalties.applied_at is
  'When the system materialised the row, which may be later than effective_date. The charge dates from the rule, not from when a process noticed.';

-- ---------------------------------------------------------------------------
-- One penalty per loan
-- ---------------------------------------------------------------------------

create unique index loan_penalties_one_per_loan
  on public.loan_penalties (loan_id, penalty_type);

comment on index public.loan_penalties_one_per_loan is
  'The one-time rule, enforced by the database. Two concurrent materialisations cannot both succeed.';

-- Overdue queries scan by effective date ("which loans were penalised, and
-- when"); the unique index above already serves lookups by loan.
create index loan_penalties_effective_date_idx
  on public.loan_penalties (effective_date);

-- ---------------------------------------------------------------------------
-- Append-only
--
-- Statement-level, so the refusal does not depend on the caller's WHERE
-- clause finding a row, and so an UPDATE matching nothing is still refused
-- rather than quietly succeeding.
-- ---------------------------------------------------------------------------

create trigger loan_penalties_no_update
  before update on public.loan_penalties execute function public.reject_mutation();

create trigger loan_penalties_no_delete
  before delete on public.loan_penalties execute function public.reject_mutation();

-- ---------------------------------------------------------------------------
-- Privileges
--
-- No INSERT for any session role: the only way a penalty comes into existence
-- is `ensure_penalty_applied`, which runs as the table owner. SELECT is
-- granted and gated by policy in `20261007000800`.
--
-- Every REVOKE names `anon` and `authenticated` explicitly, because Supabase's
-- ALTER DEFAULT PRIVILEGES has already granted them everything on this new
-- table. This is the Phase 1 lesson and the Phase 6 bug.
-- ---------------------------------------------------------------------------

revoke all on table public.loan_penalties from public, anon, authenticated;
grant select on table public.loan_penalties to authenticated;

alter table public.loan_penalties enable row level security;
