-- ===========================================================================
-- Phase 4 — the authoritative calculation and the lifecycle operations.
--
-- ## Which implementation computes the money
--
-- `calculate_loan_breakdown` below is **authoritative**. The TypeScript engine
-- in `lib/domain/loan.ts` computes the preview staff see while entering a
-- loan; this computes the figures that are stored.
--
-- The split is not duplication for its own sake. The approval function must
-- not accept a breakdown from its caller: an approver who could supply the
-- numbers could approve a loan at zero interest, and `loans:approve` is held
-- by the Manager. So the database computes, from the principal, rate and term
-- alone.
--
-- Two implementations that must agree is a real risk, so it is tested as one
-- thing: `tests/db/loan-engine-parity.test.ts` runs several hundred cases
-- through both and compares period by period. If they diverge, that test fails
-- rather than a borrower being quoted one figure and charged another.
--
-- ## No floating point
--
-- Interest is `opening × bps / 10_000` in `bigint`, rounded half-up by adding
-- half the divisor before an integer division:
--
--     (opening * bps + 5000) / 10000
--
-- For non-negative operands that is exactly half-up. `numeric` would also be
-- exact but invites a later `::float8`; integers cannot be got wrong by
-- accident.
--
-- Principal is split with integer division, and the remainder is placed in the
-- final periods — the same rule as `divideEvenly(..., { remainder: 'last' })`,
-- so UGX 200,001 over two months is 100,000 then 100,001.
-- ===========================================================================

create or replace function public.calculate_loan_breakdown(
  p_principal bigint,
  p_interest_rate_bps integer,
  p_term_months smallint
)
returns table (
  period_number smallint,
  opening_principal bigint,
  principal_portion bigint,
  interest bigint,
  total_obligation bigint,
  closing_principal bigint
)
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_base      bigint;
  v_remainder bigint;
  v_opening   bigint;
  v_portion   bigint;
  v_interest  bigint;
  v_period    smallint;
begin
  if p_principal is null or p_principal <= 0 then
    raise exception 'A loan principal must be a positive number of shillings.'
      using errcode = 'P0001';
  end if;

  if p_interest_rate_bps is null or p_interest_rate_bps < 0 then
    raise exception 'An interest rate must be a non-negative number of basis points.'
      using errcode = 'P0001';
  end if;

  if p_term_months is null or p_term_months < 1 then
    raise exception 'A loan term must be at least one month.'
      using errcode = 'P0001';
  end if;

  if p_term_months > 120 then
    raise exception 'A loan term beyond 120 months is not supported.'
      using errcode = 'P0001';
  end if;

  -- Level portions, remainder in the final periods.
  v_base := p_principal / p_term_months;
  v_remainder := p_principal % p_term_months;

  v_opening := p_principal;

  for v_period in 1..p_term_months loop
    -- The last `v_remainder` periods each carry one extra shilling, so the
    -- portions sum to the principal exactly.
    v_portion := v_base + (
      case when v_period > p_term_months - v_remainder then 1 else 0 end
    );

    -- Half-up, in integers. Charged on the opening balance: this one line is
    -- the reducing-balance rule.
    v_interest := (v_opening * p_interest_rate_bps + 5000) / 10000;

    period_number     := v_period;
    opening_principal := v_opening;
    principal_portion := v_portion;
    interest          := v_interest;
    total_obligation  := v_portion + v_interest;
    closing_principal := v_opening - v_portion;

    return next;

    v_opening := v_opening - v_portion;
  end loop;

  -- The loan must be fully repaid by the last period. If this ever fires the
  -- allocation above is wrong, and refusing is better than storing a
  -- breakdown that leaves principal uncollected.
  if v_opening <> 0 then
    raise exception
      'Loan breakdown did not fully allocate the principal; % remains.', v_opening
      using errcode = 'P0001';
  end if;

  return;
end;
$$;

comment on function public.calculate_loan_breakdown(bigint, integer, smallint) is
  'The authoritative reducing-balance breakdown. Integer arithmetic, half-up rounding, remainder in the final periods. Mirrored for preview by lib/domain/loan.ts and compared by a parity test.';

-- Readable by any signed-in user: it is a pure function of its arguments and
-- discloses nothing. The preview screen calls it so that staff see the
-- authoritative figures rather than the browser's.
revoke all on function public.calculate_loan_breakdown(bigint, integer, smallint)
  from public, anon, authenticated;
grant execute on function public.calculate_loan_breakdown(bigint, integer, smallint)
  to authenticated;

-- ===========================================================================
-- Eligibility
--
-- One function, returning a set of machine-readable failure codes. Having it
-- in one place is the point: the approval path, the approval screen and the
-- tests all ask the same question and get the same answer, rather than three
-- near-identical rule sets drifting apart.
--
-- Returns zero rows when the loan may be approved.
-- ===========================================================================

create or replace function public.validate_loan_for_approval(p_loan_id uuid)
returns table (failure_code text, detail text)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_loan      public.loans;
  v_client    public.clients;
  v_settings  public.business_settings;
  v_guarantors integer;
  v_incomplete integer;
  v_active    integer;
begin
  select * into v_loan from public.loans where id = p_loan_id;

  if not found then
    return query select 'loan_not_found'::text, null::text;
    return;
  end if;

  select * into v_settings from public.business_settings where id = 1;

  if not found then
    return query select 'settings_unavailable'::text, null::text;
    return;
  end if;

  select * into v_client from public.clients where id = v_loan.client_id;

  if not found then
    return query select 'client_not_found'::text, null::text;
    return;
  end if;

  -- --- The client ---------------------------------------------------------
  -- Re-checked here rather than trusted from draft time. A client blacklisted
  -- between drafting and approval must stop the approval, which is exactly
  -- the race this function exists to lose safely.
  if v_client.status <> 'active' then
    return query select 'client_not_active'::text, v_client.status::text;
  end if;

  select pg_catalog.count(*) into v_active
  from public.loans l
  where l.client_id = v_loan.client_id
    and l.status = 'active'
    and l.id <> v_loan.id;

  if v_active >= v_settings.max_active_loans_per_client then
    return query select 'active_loan_exists'::text, v_active::text;
  end if;

  -- --- The amount ---------------------------------------------------------
  if v_loan.principal_amount < v_settings.min_loan_amount then
    return query select 'below_minimum'::text, v_settings.min_loan_amount::text;
  end if;

  if v_settings.max_loan_amount is not null
     and v_loan.principal_amount > v_settings.max_loan_amount then
    return query select 'above_maximum'::text, v_settings.max_loan_amount::text;
  end if;

  -- --- The term -----------------------------------------------------------
  if v_loan.loan_term_months < v_settings.min_loan_term_months
     or v_loan.loan_term_months > v_settings.max_loan_term_months then
    return query select 'term_not_permitted'::text, v_loan.loan_term_months::text;
  end if;

  -- The confirmed rule: a multi-month term is available only at or above the
  -- threshold. Below it, a loan runs for a single month.
  if v_loan.loan_term_months > 1
     and v_loan.principal_amount < v_settings.multi_month_min_amount then
    return query select 'term_requires_higher_amount'::text,
                        v_settings.multi_month_min_amount::text;
  end if;

  -- --- The repayment rhythm ----------------------------------------------
  if not exists (
    select 1 from public.repayment_frequencies rf
    where rf.key = v_loan.repayment_frequency and rf.is_active
  ) then
    return query select 'frequency_not_permitted'::text, v_loan.repayment_frequency;
  end if;

  -- --- The guarantors -----------------------------------------------------
  select pg_catalog.count(*) into v_guarantors
  from public.client_guarantors cg
  where cg.client_id = v_loan.client_id and cg.active;

  if v_guarantors < v_settings.min_guarantors_required then
    return query select 'insufficient_guarantors'::text,
                        v_settings.min_guarantors_required::text;
  end if;

  -- Completeness, not merely presence. An approval that passes on a guarantor
  -- with no phone number has recorded somebody the business cannot actually
  -- call.
  select pg_catalog.count(*) into v_incomplete
  from public.client_guarantors cg
  join public.guarantors g on g.id = cg.guarantor_id
  left join public.guarantor_identities gi on gi.guarantor_id = g.id
  where cg.client_id = v_loan.client_id
    and cg.active
    and (
         pg_catalog.btrim(coalesce(g.phone, '')) = ''
      or pg_catalog.btrim(coalesce(g.occupation, '')) = ''
      or pg_catalog.btrim(coalesce(g.location, '')) = ''
      or pg_catalog.btrim(coalesce(cg.relationship_to_client, '')) = ''
      or gi.nin is null
    );

  if v_incomplete > 0 then
    return query select 'guarantor_incomplete'::text, v_incomplete::text;
  end if;

  return;
end;
$$;

comment on function public.validate_loan_for_approval(uuid) is
  'Every rule a loan must satisfy to be approved, as machine-readable failure codes. Zero rows means approvable. Re-evaluated at approval, never trusted from draft time.';

revoke all on function public.validate_loan_for_approval(uuid)
  from public, anon, authenticated;
grant execute on function public.validate_loan_for_approval(uuid) to authenticated;

-- ===========================================================================
-- Approval
--
-- One function, one transaction. Either the loan is approved with its terms
-- computed, its breakdown written and every snapshot captured, or nothing
-- happened at all. A partially approved loan — approved but with no
-- breakdown, or with the client snapshot missing — would be worse than a
-- failed approval, because it would look complete.
--
-- ## The settings-race policy
--
-- Terms are snapshotted **at approval, from the settings in force at
-- approval**, after revalidating the loan against them.
--
-- So: a draft entered when the rate was 15%, approved after the Owner moved
-- the rate to 12%, is approved **at 12%**. That is the deliberate choice, and
-- the reasoning is that the rate the borrower is told at the counter is not
-- binding — the approval is. Approving at a stale rate would mean the business
-- lending at a rate it had already decided to stop offering, with no record of
-- having decided to.
--
-- The cost is that a reviewer may approve figures that differ from the ones
-- the Secretary saw. The function therefore returns the figures it used, and
-- the approval screen re-reads them before asking for confirmation, so the
-- change is visible rather than silent.
-- ===========================================================================

create or replace function public.approve_loan(p_loan_id uuid)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_loan      public.loans;
  v_client    public.clients;
  v_settings  public.business_settings;
  v_failures  text;
  v_total_interest bigint;
  v_total_expected bigint;
  v_actor     uuid;
begin
  v_actor := public.current_profile_id();

  -- The row lock serialises concurrent approvals of the same loan: the second
  -- blocks, then finds the status is no longer `pending_approval` and refuses.
  -- That is what makes a double-tap idempotent rather than a double approval.
  select * into v_loan from public.loans where id = p_loan_id for update;

  if not found then
    raise exception 'No such loan.' using errcode = 'P0001';
  end if;

  if v_loan.status <> 'pending_approval' then
    raise exception
      'Only a loan awaiting approval can be approved; this one is %.', v_loan.status
      using errcode = 'P0001';
  end if;

  -- Capability checked here as well as in the transition trigger. The trigger
  -- is the guarantee; this gives the caller a clear refusal before any work.
  if auth.uid() is not null and not public.user_has_permission('loans:approve') then
    raise exception 'Approving a loan requires the loans:approve capability.'
      using errcode = 'P0001';
  end if;

  select * into v_settings from public.business_settings where id = 1;
  select * into v_client from public.clients where id = v_loan.client_id;

  -- Every rule, re-evaluated now. Not from draft time.
  select pg_catalog.string_agg(failure_code, ', ' order by failure_code)
    into v_failures
  from public.validate_loan_for_approval(p_loan_id);

  if v_failures is not null then
    raise exception 'This loan cannot be approved: %', v_failures
      using errcode = 'P0001';
  end if;

  -- --- The authoritative figures -----------------------------------------
  select pg_catalog.sum(b.interest) into v_total_interest
  from public.calculate_loan_breakdown(
    v_loan.principal_amount,
    v_settings.default_monthly_interest_rate_bps,
    v_loan.loan_term_months
  ) b;

  v_total_expected := v_loan.principal_amount + v_total_interest;

  -- --- The contractual breakdown -----------------------------------------
  insert into public.loan_periods (
    loan_id, period_number, opening_principal,
    principal_portion, interest, total_obligation, closing_principal
  )
  select
    p_loan_id, b.period_number, b.opening_principal,
    b.principal_portion, b.interest, b.total_obligation, b.closing_principal
  from public.calculate_loan_breakdown(
    v_loan.principal_amount,
    v_settings.default_monthly_interest_rate_bps,
    v_loan.loan_term_months
  ) b;

  -- --- The client snapshot -----------------------------------------------
  insert into public.loan_client_snapshots (
    loan_id, client_id, client_number, full_name, phone, alternative_phone,
    sex, date_of_birth, occupation, business_type, village_area, district,
    client_status_at_origination
  )
  values (
    p_loan_id, v_client.id, v_client.client_number, v_client.full_name,
    v_client.phone, v_client.alternative_phone, v_client.sex,
    v_client.date_of_birth, v_client.occupation, v_client.business_type,
    v_client.village_area, v_client.district, v_client.status
  );

  -- --- The guarantor snapshots -------------------------------------------
  insert into public.loan_guarantor_snapshots (
    loan_id, guarantor_id, full_name, phone, alternative_phone, sex,
    date_of_birth, occupation, location, district, relationship_to_client,
    had_photograph
  )
  select
    p_loan_id, g.id, g.full_name, g.phone, g.alternative_phone, g.sex,
    g.date_of_birth, g.occupation, g.location, g.district,
    cg.relationship_to_client, g.photo_path is not null
  from public.client_guarantors cg
  join public.guarantors g on g.id = cg.guarantor_id
  where cg.client_id = v_loan.client_id and cg.active;

  -- --- The identity snapshots, into the protected table ------------------
  -- Client and guarantors in **one statement**, deliberately. The audit
  -- trigger on this table is statement-level, so two inserts would record two
  -- `loan.snapshot_created` events for what is one act, and a reader counting
  -- events against snapshot tables would find one too many.
  insert into public.loan_identity_snapshots (loan_id, subject_type, subject_id, nin)
  select p_loan_id, 'client', ci.client_id, ci.nin
  from public.client_identities ci
  where ci.client_id = v_client.id
  union all
  select p_loan_id, 'guarantor', g.id, gi.nin
  from public.client_guarantors cg
  join public.guarantors g on g.id = cg.guarantor_id
  join public.guarantor_identities gi on gi.guarantor_id = g.id
  where cg.client_id = v_loan.client_id and cg.active;

  -- --- The terms, frozen -------------------------------------------------
  -- Last, so that a failure above leaves the loan awaiting approval rather
  -- than approved with pieces missing. `approved_at` and `approved_by` are
  -- stamped by the transition trigger, not supplied here.
  update public.loans
     set status = 'approved',
         interest_rate_bps = v_settings.default_monthly_interest_rate_bps,
         interest_method = v_settings.default_interest_method,
         total_interest = v_total_interest,
         total_expected_repayment = v_total_expected,
         min_loan_amount_applied = v_settings.min_loan_amount,
         max_loan_amount_applied = v_settings.max_loan_amount,
         grace_period_days_applied = v_settings.grace_period_days,
         penalty_rate_bps_applied = v_settings.penalty_rate_bps
   where id = p_loan_id;

  return p_loan_id;
end;
$$;

comment on function public.approve_loan(uuid) is
  'Approves a loan atomically: revalidates every rule against current settings, computes the authoritative breakdown, captures all snapshots, and freezes the terms. Either all of it or none.';

-- Callable by a session, because approval is a Manager''s act performed from
-- the interface. The capability is checked inside, and the transition trigger
-- checks it again independently.
revoke all on function public.approve_loan(uuid) from public, anon, authenticated;
grant execute on function public.approve_loan(uuid) to authenticated;

-- ===========================================================================
-- Disbursement
--
-- Releasing the money. The active-loan limit is enforced by the trigger on
-- `loans`, under an advisory lock, so two concurrent disbursements for one
-- client cannot both succeed however they are issued.
-- ===========================================================================

create or replace function public.disburse_loan(p_loan_id uuid)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_loan   public.loans;
  v_client public.clients;
begin
  select * into v_loan from public.loans where id = p_loan_id for update;

  if not found then
    raise exception 'No such loan.' using errcode = 'P0001';
  end if;

  -- A second tap finds the loan already active and is refused cleanly, rather
  -- than disbursing twice.
  if v_loan.status <> 'approved' then
    raise exception
      'Only an approved loan can be disbursed; this one is %.', v_loan.status
      using errcode = 'P0001';
  end if;

  if auth.uid() is not null and not public.user_has_permission('loans:disburse') then
    raise exception 'Disbursing a loan requires the loans:disburse capability.'
      using errcode = 'P0001';
  end if;

  -- Eligibility again. A client blacklisted between approval and disbursement
  -- must not receive money.
  select * into v_client from public.clients where id = v_loan.client_id;

  if v_client.status <> 'active' then
    raise exception
      'This client is % and cannot receive a disbursement.', v_client.status
      using errcode = 'P0001';
  end if;

  -- The breakdown must exist before money moves. If it does not, approval was
  -- incomplete and disbursing would create an active loan nobody can collect.
  if not exists (select 1 from public.loan_periods where loan_id = p_loan_id) then
    raise exception 'This loan has no contractual breakdown and cannot be disbursed.'
      using errcode = 'P0001';
  end if;

  if not exists (select 1 from public.loan_client_snapshots where loan_id = p_loan_id) then
    raise exception 'This loan has no client snapshot and cannot be disbursed.'
      using errcode = 'P0001';
  end if;

  -- `disbursed_at` and `disbursed_by` are stamped by the transition trigger,
  -- and the active-limit trigger fires on this same statement.
  update public.loans set status = 'active' where id = p_loan_id;

  return p_loan_id;
end;
$$;

comment on function public.disburse_loan(uuid) is
  'Activates an approved loan. Re-checks client eligibility and the presence of the breakdown and snapshots; the active-loan limit is enforced by the trigger on loans.';

revoke all on function public.disburse_loan(uuid) from public, anon, authenticated;
grant execute on function public.disburse_loan(uuid) to authenticated;

-- ===========================================================================
-- Cancellation
--
-- Only before the money moves. An active loan has been paid out; "cancelling"
-- it would be a write-off, which is a different act with different accounting
-- and belongs to a later phase.
-- ===========================================================================

create or replace function public.cancel_loan(p_loan_id uuid, p_reason text)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_loan public.loans;
begin
  if p_reason is null or pg_catalog.btrim(p_reason) = '' then
    raise exception 'Cancelling a loan requires a reason.' using errcode = 'P0001';
  end if;

  select * into v_loan from public.loans where id = p_loan_id for update;

  if not found then
    raise exception 'No such loan.' using errcode = 'P0001';
  end if;

  if v_loan.status = 'cancelled' then
    raise exception 'This loan is already cancelled.' using errcode = 'P0001';
  end if;

  if v_loan.status not in ('draft', 'pending_approval', 'approved') then
    raise exception
      'A % loan cannot be cancelled. Money has already been released.', v_loan.status
      using errcode = 'P0001';
  end if;

  if auth.uid() is not null and not public.user_has_permission('loans:cancel') then
    raise exception 'Cancelling a loan requires the loans:cancel capability.'
      using errcode = 'P0001';
  end if;

  update public.loans
     set status = 'cancelled',
         cancellation_reason = pg_catalog.btrim(p_reason)
   where id = p_loan_id;

  return p_loan_id;
end;
$$;

comment on function public.cancel_loan(uuid, text) is
  'Cancels a loan before disbursement, with a required reason. An active loan cannot be cancelled: that would be a write-off.';

revoke all on function public.cancel_loan(uuid, text) from public, anon, authenticated;
grant execute on function public.cancel_loan(uuid, text) to authenticated;
