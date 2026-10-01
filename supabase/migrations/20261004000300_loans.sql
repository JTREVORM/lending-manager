-- ===========================================================================
-- Phase 4 — the loan record.
--
-- ## The commercial terms are on the loan, not read from settings
--
-- Every figure a loan is worth — its principal, its rate, its term, its
-- method, the totals — is a column here, written once and then frozen. None of
-- it is derived from `business_settings` at read time.
--
-- That is the single most important decision in this migration. If a loan's
-- interest were computed from the current default rate, then the Owner
-- changing 15% to 12% next March would silently restate what every existing
-- borrower owes. The loan would stop being a record of an agreement and
-- become a view over today's policy.
--
-- So the settings are *inputs to origination*, validated and then copied. The
-- immutability guard below makes the copy permanent.
--
-- ## No balances
--
-- There is deliberately no `amount_paid`, `remaining_balance` or
-- `arrears_balance`. Nothing posts payments yet, so such a column could only
-- hold a zero that looks like a fact. Phase 5 and 6 own them.
-- ===========================================================================

create table public.loans (
  id uuid primary key default gen_random_uuid(),

  -- Minted by `next_reference('loan')`, the Phase 1 atomic generator. Refused
  -- if supplied, immutable once issued.
  loan_number text not null unique,

  client_id uuid not null references public.clients (id) on delete restrict,

  -- --- The agreed commercial terms, frozen at approval -------------------
  principal_amount bigint not null,
  interest_rate_bps integer not null,
  interest_method text not null,
  loan_term_months smallint not null,
  repayment_frequency text not null
    references public.repayment_frequencies (key) on delete restrict,

  -- Computed by `public.calculate_loan_breakdown` (migration 000500), which
  -- is the authoritative implementation. Stored rather than recomputed on
  -- read, so what the borrower was told is what the system reports.
  total_interest bigint not null default 0,
  total_expected_repayment bigint not null default 0,

  -- --- The policy in force at origination, snapshotted -------------------
  -- Not used by the Phase 4 engine, but part of the agreement: a borrower in
  -- arrears next year is judged against the grace period and penalty rate
  -- their loan was issued under, not the ones current then.
  currency_code char(3) not null default 'UGX',
  min_loan_amount_applied bigint not null,
  max_loan_amount_applied bigint,
  grace_period_days_applied smallint not null,
  penalty_rate_bps_applied integer not null,

  -- --- Dates -------------------------------------------------------------
  -- When the business intends to hand over the money. Phase 5 generates
  -- collection dates from the actual disbursement, not from this.
  proposed_disbursement_date date not null,

  status text not null default 'draft',

  -- --- Lifecycle attribution. Every one stamped by the database ----------
  submitted_at timestamptz,
  submitted_by uuid references public.profiles (id) on delete set null,
  approved_at timestamptz,
  approved_by uuid references public.profiles (id) on delete set null,
  disbursed_at timestamptz,
  disbursed_by uuid references public.profiles (id) on delete set null,
  cancelled_at timestamptz,
  cancelled_by uuid references public.profiles (id) on delete set null,
  cancellation_reason text,

  -- A reviewer returning a draft says why. Kept so the person correcting it
  -- knows what to change.
  review_note text,

  notes text,

  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),

  -- --- Structural integrity ----------------------------------------------
  constraint loans_loan_number_shape
    check (loan_number ~ '^LN[0-9]{6,}$'),
  constraint loans_principal_positive
    check (principal_amount > 0),
  constraint loans_interest_rate_non_negative
    check (interest_rate_bps >= 0),
  constraint loans_interest_rate_sane
    check (interest_rate_bps <= 1000000),
  constraint loans_term_positive
    check (loan_term_months >= 1),
  constraint loans_term_sane
    check (loan_term_months <= 120),
  constraint loans_interest_method_valid
    check (interest_method in ('reducing_balance_monthly')),
  constraint loans_total_interest_non_negative
    check (total_interest >= 0),

  -- --- The totals ---------------------------------------------------------
  --
  -- The figures are computed at approval, by `approve_loan`, and not before.
  -- So the constraint cannot simply be "total = principal + interest": a
  -- draft has no figures, and neither does a loan being submitted or
  -- cancelled before anyone approved it.
  --
  -- Phrasing this by status proved fragile — two earlier attempts each made
  -- some legitimate transition unsavable, because the list of
  -- not-yet-computed statuses is not the same as the list of pre-approval
  -- ones (a loan cancelled *after* approval keeps its computed totals).
  --
  -- So the rule is stated by *state of the figures* rather than by status:
  -- either nothing has been computed, or what is there is internally
  -- consistent. Partial totals — an interest figure with no expected total —
  -- are what this forbids, because a half-written figure is one somebody
  -- might read as whole.
  constraint loans_totals_consistent
    check (
      (total_interest = 0 and total_expected_repayment = 0)
      or total_expected_repayment = principal_amount + total_interest
    ),

  -- And from approval onward the figures must actually be there. This is the
  -- half that stops a loan going active with nothing to collect.
  constraint loans_approved_requires_totals
    check (
      status not in ('approved', 'active', 'cleared')
      or (
        total_expected_repayment = principal_amount + total_interest
        and total_expected_repayment >= principal_amount
      )
    ),

  constraint loans_currency_ugx
    check (currency_code = 'UGX'),
  constraint loans_min_applied_positive
    check (min_loan_amount_applied > 0),
  constraint loans_max_applied_sane
    check (max_loan_amount_applied is null or max_loan_amount_applied >= min_loan_amount_applied),
  constraint loans_grace_period_non_negative
    check (grace_period_days_applied >= 0),
  constraint loans_penalty_rate_non_negative
    check (penalty_rate_bps_applied >= 0),

  constraint loans_status_valid
    check (status in (
      'draft',
      'pending_approval',
      'approved',
      'active',
      'cleared',
      'cancelled'
    )),

  -- --- State consistency -------------------------------------------------
  -- Each status implies its attribution is present. Without these a loan
  -- could read as approved with nobody named, which is worse than useless in
  -- a dispute: it looks like a record and answers nothing.
  constraint loans_submitted_fields_consistent
    check (
      (submitted_at is null) = (submitted_by is null)
    ),
  constraint loans_approved_requires_attribution
    check (
      status not in ('approved', 'active', 'cleared')
      or (approved_at is not null and approved_by is not null)
    ),
  constraint loans_active_requires_disbursement
    check (
      status not in ('active', 'cleared')
      or (disbursed_at is not null and disbursed_by is not null)
    ),
  constraint loans_cancelled_requires_reason
    check (
      status <> 'cancelled'
      or (
        cancelled_at is not null
        and cancelled_by is not null
        and cancellation_reason is not null
        and btrim(cancellation_reason) <> ''
      )
    ),
  -- The converse: attribution without the status is a half-written
  -- transition, which would let a loan look disbursed while sitting in draft.
  constraint loans_disbursement_implies_active
    check (disbursed_at is null or status in ('active', 'cleared')),
  constraint loans_cancellation_implies_cancelled
    check (cancelled_at is null or status = 'cancelled'),

  constraint loans_cancellation_reason_length
    check (cancellation_reason is null or char_length(cancellation_reason) <= 500),
  constraint loans_review_note_length
    check (review_note is null or char_length(review_note) <= 500),
  constraint loans_notes_length
    check (notes is null or char_length(notes) <= 2000),

  -- --- Chronology --------------------------------------------------------
  -- Money cannot be released before the loan was approved, and nothing can
  -- happen before the loan existed.
  constraint loans_approved_after_created
    check (approved_at is null or approved_at >= created_at),
  constraint loans_disbursed_after_approved
    check (disbursed_at is null or approved_at is null or disbursed_at >= approved_at),
  constraint loans_proposed_date_plausible
    check (proposed_disbursement_date >= '2020-01-01'::date)
);

comment on table public.loans is
  'A loan agreement. Commercial terms are copied here at approval and frozen, so changing business settings never restates an existing loan.';
comment on column public.loans.loan_number is
  'Business reference, e.g. LN260001. Minted atomically by next_reference(); immutable.';
comment on column public.loans.interest_rate_bps is
  'Monthly rate in basis points, as agreed for THIS loan. 1500 = 15%. Never read from settings after origination.';
comment on column public.loans.repayment_frequency is
  'The collection rhythm agreed with the borrower. Phase 4 records it; Phase 5 generates the dates.';
comment on column public.loans.proposed_disbursement_date is
  'When the business intends to hand over the money. Phase 5 schedules from disbursed_at, not from this.';
comment on column public.loans.grace_period_days_applied is
  'The grace period in force at origination. Unused in Phase 4; part of the agreement a later phase will judge arrears against.';

-- ---------------------------------------------------------------------------
-- Indexes
--
-- The register's filters and the lifecycle lookups. Nothing speculative.
-- ---------------------------------------------------------------------------

create index loans_client_idx on public.loans (client_id);
create index loans_status_idx on public.loans (status);
create index loans_created_at_idx on public.loans (created_at desc);

-- Partial: the approval and disbursement queues are small slices of the
-- register, and these are the screens staff live on.
create index loans_pending_approval_idx on public.loans (created_at desc)
  where status = 'pending_approval';
create index loans_approved_idx on public.loans (approved_at desc)
  where status = 'approved';
create index loans_active_idx on public.loans (client_id)
  where status = 'active';

create trigger loans_set_updated_at
  before update on public.loans
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Loan numbering
-- ---------------------------------------------------------------------------

create or replace function public.loans_assign_loan_number()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.loan_number is not null then
    raise exception 'A loan number is assigned by the database, not by the caller.'
      using errcode = 'P0001';
  end if;

  new.loan_number := public.next_reference('loan');
  new.created_by := public.current_profile_id();

  return new;
end;
$$;

comment on function public.loans_assign_loan_number() is
  'BEFORE INSERT on loans: mints the loan number atomically and derives created_by from the session.';

create trigger loans_assign_loan_number
  before insert on public.loans
  for each row execute function public.loans_assign_loan_number();

-- ---------------------------------------------------------------------------
-- The state machine
--
-- Transitions are enumerated. A status column with a CHECK constraint says
-- which values are legal; it says nothing about which *moves* are legal, and
-- without that a draft could jump straight to active, skipping approval
-- entirely.
--
--   draft            → pending_approval   (submit)
--   draft            → cancelled
--   pending_approval → draft              (returned for correction)
--   pending_approval → approved
--   pending_approval → cancelled
--   approved         → active             (disbursement)
--   approved         → cancelled
--   active           → cleared            (reserved for Phase 6; see below)
--
-- `cleared` is reachable only from `active`, and nothing in Phase 4 performs
-- that transition — it becomes possible once payments exist and a loan can be
-- shown to be fully repaid. The edge is declared now so the machine is
-- complete and the reader can see where the lifecycle ends.
--
-- Nothing leaves `cancelled` or `cleared`. Both are terminal: a cancelled loan
-- is history, and reviving one would mean a loan that was never agreed
-- becoming active.
-- ---------------------------------------------------------------------------

create or replace function public.loans_guard_transition()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_allowed   boolean;
  v_approving boolean;
begin
  -- --- Rules binding every caller, including service_role ------------------
  -- Stated before the trusted-path exemption, following the Phase 2 lesson: a
  -- rule after the exemption is one the privileged client can skip, and a
  -- leaked secret key becomes the privileged client.

  if new.loan_number is distinct from old.loan_number then
    raise exception 'A loan number cannot be changed once issued.'
      using errcode = 'P0001';
  end if;

  if new.created_by is distinct from old.created_by
     or new.created_at is distinct from old.created_at then
    raise exception 'Loan provenance cannot be rewritten.'
      using errcode = 'P0001';
  end if;

  -- The transition itself.
  if new.status is distinct from old.status then
    v_allowed := (old.status, new.status) in (
      ('draft', 'pending_approval'),
      ('draft', 'cancelled'),
      ('pending_approval', 'draft'),
      ('pending_approval', 'approved'),
      ('pending_approval', 'cancelled'),
      ('approved', 'active'),
      ('approved', 'cancelled'),
      ('active', 'cleared')
    );

    if not v_allowed then
      raise exception
        'A loan cannot move from % to %.', old.status, new.status
        using errcode = 'P0001';
    end if;
  end if;

  -- --- Attribution is the database''s to write ----------------------------
  -- Derived from the session at the moment of the transition, and a supplied
  -- value is refused. Without this, an approval could name somebody who never
  -- saw the loan — precisely the record a dispute turns on.
  --
  -- Note also what this does *not* have to do: a direct UPDATE to
  -- `status = 'approved'` cannot succeed anyway, because
  -- `loans_approved_requires_totals` demands figures that only
  -- `approve_loan` can compute. The attribution rules and that constraint
  -- close the path from two directions.

  if new.status = 'pending_approval' and old.status = 'draft' then
    -- A supplied value is refused rather than silently overwritten. Silently
    -- overwriting would hide a caller that believes it is choosing the actor,
    -- and on a financial record that belief is worth correcting loudly.
    if new.submitted_at is distinct from old.submitted_at
       or new.submitted_by is distinct from old.submitted_by then
      raise exception 'Submission attribution is maintained by the database.'
        using errcode = 'P0001';
    end if;

    new.submitted_at := pg_catalog.now();
    new.submitted_by := public.current_profile_id();
  elsif new.status = 'draft' and old.status = 'pending_approval' then
    -- Returned for correction: the submission is cleared, so the next
    -- submission is recorded as its own act rather than inheriting the first.
    new.submitted_at := null;
    new.submitted_by := null;
  elsif new.submitted_at is distinct from old.submitted_at
     or new.submitted_by is distinct from old.submitted_by then
    raise exception 'Submission attribution is maintained by the database.'
      using errcode = 'P0001';
  end if;

  if new.status = 'approved' and old.status = 'pending_approval' then
    if new.approved_at is distinct from old.approved_at
       or new.approved_by is distinct from old.approved_by then
      raise exception 'Approval attribution is maintained by the database.'
        using errcode = 'P0001';
    end if;

    new.approved_at := pg_catalog.now();
    new.approved_by := public.current_profile_id();
  elsif new.approved_at is distinct from old.approved_at
     or new.approved_by is distinct from old.approved_by then
    raise exception 'Approval attribution is maintained by the database.'
      using errcode = 'P0001';
  end if;

  if new.status = 'active' and old.status = 'approved' then
    if new.disbursed_at is distinct from old.disbursed_at
       or new.disbursed_by is distinct from old.disbursed_by then
      raise exception 'Disbursement attribution is maintained by the database.'
        using errcode = 'P0001';
    end if;

    new.disbursed_at := pg_catalog.now();
    new.disbursed_by := public.current_profile_id();
  elsif new.disbursed_at is distinct from old.disbursed_at
     or new.disbursed_by is distinct from old.disbursed_by then
    raise exception 'Disbursement attribution is maintained by the database.'
      using errcode = 'P0001';
  end if;

  if new.status = 'cancelled' and old.status <> 'cancelled' then
    if new.cancelled_at is distinct from old.cancelled_at
       or new.cancelled_by is distinct from old.cancelled_by then
      raise exception 'Cancellation attribution is maintained by the database.'
        using errcode = 'P0001';
    end if;

    new.cancelled_at := pg_catalog.now();
    new.cancelled_by := public.current_profile_id();
  elsif new.cancelled_at is distinct from old.cancelled_at
     or new.cancelled_by is distinct from old.cancelled_by then
    raise exception 'Cancellation attribution is maintained by the database.'
      using errcode = 'P0001';
  end if;

  -- --- What freezes, and when ---------------------------------------------
  --
  -- Two different rules, and conflating them is what made the first draft of
  -- this trigger reject the approval function's own write:
  --
  --   * **Never changes once the loan leaves draft.** What the loan *is*:
  --     which client, how much, for how long, at what collection rhythm.
  --     Approval does not touch any of it — it only decides. A mistake here
  --     after submission goes through cancellation and reissue, where it
  --     leaves a trail, rather than being quietly corrected.
  --
  --   * **Written exactly once, at approval.** What the loan *costs*: the
  --     rate, the method, the totals, and the policy in force. These are
  --     genuinely absent until approval computes them, so the freeze has to
  --     begin at approval rather than at submission.
  --
  -- Both rules bind every caller, including service_role, because they sit
  -- above the trusted-path exemption.
  v_approving := old.status = 'pending_approval' and new.status = 'approved';

  if old.status <> 'draft' then
    -- Rule one: the shape of the agreement.
    if new.principal_amount is distinct from old.principal_amount
       or new.loan_term_months is distinct from old.loan_term_months
       or new.repayment_frequency is distinct from old.repayment_frequency
       or new.client_id is distinct from old.client_id
       or new.currency_code is distinct from old.currency_code
       or new.proposed_disbursement_date is distinct from old.proposed_disbursement_date then
      raise exception
        'The agreed terms of a loan cannot be changed after it leaves draft. Cancel it and issue a new loan.'
        using errcode = 'P0001';
    end if;

    -- Rule two: the price, and the policy it was priced under. Settable only
    -- on the one transition that computes them.
    if not v_approving then
      if new.interest_rate_bps is distinct from old.interest_rate_bps
         or new.interest_method is distinct from old.interest_method then
        raise exception
          'A loan''s interest rate is set at approval and cannot be changed afterwards.'
          using errcode = 'P0001';
      end if;

      if new.total_interest is distinct from old.total_interest
         or new.total_expected_repayment is distinct from old.total_expected_repayment then
        raise exception
          'Loan totals are computed at approval and cannot be changed afterwards.'
          using errcode = 'P0001';
      end if;

      if new.min_loan_amount_applied is distinct from old.min_loan_amount_applied
         or new.max_loan_amount_applied is distinct from old.max_loan_amount_applied
         or new.grace_period_days_applied is distinct from old.grace_period_days_applied
         or new.penalty_rate_bps_applied is distinct from old.penalty_rate_bps_applied then
        raise exception
          'The policy snapshot on a loan cannot be changed after approval.'
          using errcode = 'P0001';
      end if;
    end if;
  end if;

  -- --- The trusted server path -------------------------------------------
  -- NULL for service_role, the table owner, and migrations. The checks below
  -- are about a session's capabilities, and there is no session to check.
  if auth.uid() is null then
    return new;
  end if;

  -- --- Capability per transition ------------------------------------------
  if new.status is distinct from old.status then
    if new.status = 'pending_approval' and not public.user_has_permission('loans:submit') then
      raise exception 'Submitting a loan for approval requires the loans:submit capability.'
        using errcode = 'P0001';
    end if;

    if new.status = 'approved' and not public.user_has_permission('loans:approve') then
      raise exception 'Approving a loan requires the loans:approve capability.'
        using errcode = 'P0001';
    end if;

    -- Returning a draft is the approver''s act, not the author''s: it is a
    -- decision about the loan, made by the person who would otherwise have
    -- approved it.
    if new.status = 'draft' and old.status = 'pending_approval'
       and not public.user_has_permission('loans:approve') then
      raise exception 'Returning a loan to draft requires the loans:approve capability.'
        using errcode = 'P0001';
    end if;

    if new.status = 'active' and not public.user_has_permission('loans:disburse') then
      raise exception 'Disbursing a loan requires the loans:disburse capability.'
        using errcode = 'P0001';
    end if;

    if new.status = 'cancelled' and not public.user_has_permission('loans:cancel') then
      raise exception 'Cancelling a loan requires the loans:cancel capability.'
        using errcode = 'P0001';
    end if;
  end if;

  -- Editing a draft.
  if old.status = 'draft' and new.status = 'draft'
     and not public.user_has_permission('loans:update_draft') then
    raise exception 'Changing a loan draft requires the loans:update_draft capability.'
      using errcode = 'P0001';
  end if;

  return new;
end;
$$;

comment on function public.loans_guard_transition() is
  'BEFORE UPDATE on loans: enumerated state machine, database-stamped attribution, and terms frozen once the loan leaves draft.';

create trigger loans_guard_transition
  before update on public.loans
  for each row execute function public.loans_guard_transition();

-- ---------------------------------------------------------------------------
-- The one-active-loan rule
--
-- ## Why a trigger with an advisory lock, and not a partial unique index
--
-- A partial unique index on `(client_id) where status = 'active'` would
-- enforce exactly one active loan, and nothing else. But
-- `business_settings.max_active_loans_per_client` already exists and is
-- configurable, so an index would make that setting a lie the moment anybody
-- raised it to two: the column would say two, the database would allow one,
-- and whoever changed it would get a unique-violation they could not explain.
--
-- The specification is explicit that a configuration setting the database
-- cannot honour must not be created. So the rule is enforced against the
-- setting, at whatever value it holds:
--
--   1. take a transaction-scoped advisory lock keyed on the client;
--   2. count that client's active loans;
--   3. refuse if the count has reached the configured limit.
--
-- The lock is what makes this correct under concurrency. Without it, two
-- transactions could each count zero active loans and each proceed — the
-- classic check-then-insert race. With it, the second transaction blocks until
-- the first commits and then sees its loan. Because the lock is
-- `pg_advisory_xact_lock`, it is held until commit and released automatically,
-- including on rollback.
--
-- It fires on any path to `status = 'active'`, including a direct UPDATE, so
-- bypassing the disbursement function gains nothing.
-- ---------------------------------------------------------------------------

create or replace function public.loans_enforce_active_limit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_limit integer;
  v_active integer;
begin
  -- Serialises every concurrent attempt to activate a loan for this client.
  -- Keyed on the client, so loans for different clients do not contend.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('loan_active:' || new.client_id::text)
  );

  select bs.max_active_loans_per_client into v_limit
  from public.business_settings bs
  where bs.id = 1;

  -- Fail closed. A missing settings row is a broken installation, and
  -- defaulting to "unlimited" would be the worst possible guess.
  if v_limit is null then
    raise exception 'Business settings are unavailable; a loan cannot be activated.'
      using errcode = 'P0001';
  end if;

  select pg_catalog.count(*) into v_active
  from public.loans l
  where l.client_id = new.client_id
    and l.status = 'active'
    and l.id <> new.id;

  if v_active >= v_limit then
    raise exception
      'This client already has % active loan(s); the limit is %.', v_active, v_limit
      using errcode = 'P0001';
  end if;

  return new;
end;
$$;

comment on function public.loans_enforce_active_limit() is
  'BEFORE UPDATE on loans becoming active: enforces business_settings.max_active_loans_per_client under an advisory lock, so concurrent disbursements cannot both pass.';

create trigger loans_enforce_active_limit
  before update on public.loans
  for each row
  when (new.status = 'active' and old.status <> 'active')
  execute function public.loans_enforce_active_limit();

revoke all on function public.loans_assign_loan_number() from public, anon, authenticated;
revoke all on function public.loans_guard_transition() from public, anon, authenticated;
revoke all on function public.loans_enforce_active_limit() from public, anon, authenticated;

alter table public.loans enable row level security;
revoke all on table public.loans from anon, authenticated;
