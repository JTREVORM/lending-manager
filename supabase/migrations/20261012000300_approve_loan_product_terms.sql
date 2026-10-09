-- ===========================================================================
-- Phase 12.3 — approval reads the product
--
-- `approve_loan` has always taken a loan's terms from `business_settings`,
-- because until Phase 12.2 that was the only place terms existed. It now
-- takes them from the loan's product, and freezes the whole product
-- configuration onto the loan in the same transaction.
--
-- The body below is the *exact* text PostgreSQL held for the function,
-- extracted with `pg_get_functiondef`, with the terms section rewritten and
-- one `perform` added before the final `return`. It was not retyped: the
-- allocation and snapshot arithmetic in the middle is the most expensive
-- thing in this codebase to get subtly wrong.
--
-- ## What changed, precisely
--
--   - The rate, method, amount bounds, grace period and penalty rate now
--     come from `loan_products` rather than `business_settings`.
--   - The amount, the duration and the cadence are checked against what the
--     product actually offers, and refused with a sentence naming the
--     product rather than a constraint name.
--   - A rate that differs from the product default is permitted only where
--     the product allows overriding and only inside its own band.
--   - `capture_loan_product_snapshot` runs last, after the UPDATE, so the
--     snapshot reads the rate that was just written.
--
-- ## What did not change
--
-- Everything else: the row lock, the capability check, the re-validation,
-- the contractual breakdown, and the three identity and guarantor snapshots.
-- A failure anywhere still leaves the loan awaiting approval.
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.approve_loan(p_loan_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_loan      public.loans;
  v_client    public.clients;
  v_product   public.loan_products;
  -- The rate this loan is actually written at. Phase 12: the product's, not
  -- the business default's — see the precedence note at the head of
  -- migration 20261012000200.
  v_rate_bps  integer;
  v_method    text;
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

  -- `business_settings` is deliberately not read here any more. Phase 12
  -- made the product the source of a loan's terms, and the global row is
  -- the guard rail the product itself had to pass — enforced by
  -- `loan_products_within_business_rules` when the product was saved, not
  -- re-litigated per approval. The one global rule that still applies to a
  -- loan, `max_active_loans_per_client`, is enforced by its own trigger.
  select * into v_client from public.clients where id = v_loan.client_id;
  select * into v_product from public.loan_products where id = v_loan.loan_product_id;

  if v_product.id is null then
    raise exception 'Loan % names no product, so it has no terms to approve.',
      v_loan.loan_number using errcode = 'P0001';
  end if;

  -- An inactive product may still be approved against: the loan was taken
  -- under it, and retiring a product must not strand an application that is
  -- already in the pipeline. What an inactive product cannot do is be chosen
  -- for a *new* application, which the picker and the draft path enforce.

  -- --- The effective terms -----------------------------------------------
  -- The product decides, inside the bounds `business_settings` sets. Where
  -- the loan already carries a rate it is an override that was recorded
  -- earlier, and it has to sit inside the product's own band.
  -- `proposed_interest_rate_bps`, not `interest_rate_bps`: the latter is NOT
  -- NULL and every draft carries a placeholder in it, so reading an override
  -- off it would make every loan an override of itself.
  v_rate_bps := coalesce(v_loan.proposed_interest_rate_bps, v_product.default_interest_rate_bps);
  v_method   := v_product.interest_method;

  if v_rate_bps <> v_product.default_interest_rate_bps then
    if not v_product.interest_override_allowed then
      raise exception
        '% does not permit a rate other than its standard %.',
        v_product.name, v_product.default_interest_rate_bps
        using errcode = 'P0001';
    end if;

    if v_rate_bps < v_product.min_interest_rate_bps
       or v_rate_bps > v_product.max_interest_rate_bps then
      raise exception
        'A rate of % bp is outside what % permits (% to % bp).',
        v_rate_bps, v_product.name,
        v_product.min_interest_rate_bps, v_product.max_interest_rate_bps
        using errcode = 'P0001';
    end if;
  end if;

  -- The amount has to be one this product writes.
  if v_loan.principal_amount < v_product.min_amount
     or v_loan.principal_amount > v_product.max_amount then
    raise exception
      '% lends between % and %; this application is for %.',
      v_product.name, v_product.min_amount, v_product.max_amount,
      v_loan.principal_amount
      using errcode = 'P0001';
  end if;

  -- And a duration it offers.
  if v_loan.loan_term_months < v_product.min_term_months
     or v_loan.loan_term_months > v_product.max_term_months then
    raise exception
      '% runs for % to % months; this application is for %.',
      v_product.name, v_product.min_term_months, v_product.max_term_months,
      v_loan.loan_term_months
      using errcode = 'P0001';
  end if;

  if v_product.allowed_term_months is not null
     and not (v_loan.loan_term_months = any (v_product.allowed_term_months)) then
    raise exception
      '% is not a duration % offers.', v_loan.loan_term_months, v_product.name
      using errcode = 'P0001';
  end if;

  if not (v_loan.repayment_frequency = any (v_product.allowed_repayment_frequencies)) then
    raise exception
      '% does not offer the % repayment cadence.',
      v_product.name, v_loan.repayment_frequency
      using errcode = 'P0001';
  end if;

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
    v_rate_bps,
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
    v_rate_bps,
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
         interest_rate_bps = v_rate_bps,
         interest_method = v_method,
         total_interest = v_total_interest,
         total_expected_repayment = v_total_expected,
         min_loan_amount_applied = v_product.min_amount,
         max_loan_amount_applied = v_product.max_amount,
         grace_period_days_applied = v_product.grace_period_days,
         penalty_rate_bps_applied = v_product.penalty_rate_bps
   where id = p_loan_id;

  -- --- Phase 12: the product terms, frozen --------------------------------
  --
  -- After the UPDATE, because the snapshot reads the rate and the applied
  -- grace and penalty off the loan the line above has just written. A
  -- product repriced next month cannot change what this borrower signed.
  perform public.capture_loan_product_snapshot(p_loan_id);
  return p_loan_id;
end;
$function$;
