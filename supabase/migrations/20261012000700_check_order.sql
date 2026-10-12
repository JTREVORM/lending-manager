-- ===========================================================================
-- Phase 12.7 — which check speaks first
--
-- Two ordering mistakes from 12.2 and 12.5, each of which made a correct
-- refusal arrive with the wrong explanation.
--
-- ## 1. The business-settings guard ran before the table's own constraints
--
-- 12.5 attached `business_settings_keep_products_valid` as a BEFORE UPDATE
-- trigger. BEFORE triggers run ahead of CHECK constraints, so an update that
-- set a maximum below its own minimum — a straightforwardly invalid row —
-- was refused by the *product* guard, with a sentence about a product, and
-- `business_settings_loan_amount_order` never got the chance to say what was
-- actually wrong.
--
-- It is now AFTER UPDATE. The row's own constraints are evaluated first and
-- name themselves; the product guard speaks only about a row that is
-- internally valid and still strands a product. An exception from an AFTER
-- trigger aborts the transaction exactly as one from a BEFORE trigger does,
-- so nothing is weakened — only the order in which two correct refusals get
-- to speak.
--
-- ## 2. `approve_loan` checked the product before it validated the loan
--
-- 12.3 put the product's amount, duration and cadence checks ahead of
-- `validate_loan_for_approval`. Both would refuse the same application, but
-- the aggregated validator is the one with the documented vocabulary —
-- `below_minimum`, `term_requires_higher_amount`, `client_not_active` — which
-- the UI maps to field-level messages and which the tests assert by name. A
-- 150,000 application against a 250,000 floor came back as a sentence about
-- Individual Loans instead of as `below_minimum`.
--
-- So the validator runs first and keeps its vocabulary. The product checks
-- follow, and now say only what the validator does not cover: a duration that
-- is not on the product's menu, a cadence the product does not offer, an
-- amount outside the *product's* range rather than the business's, and a rate
-- override the product does not permit.
--
-- Nothing else in the function changes. The body below is the 12.3 text with
-- one block moved.
-- ===========================================================================

create or replace trigger business_settings_keep_products_valid
  after update on public.business_settings
  for each row execute function public.business_settings_keep_products_valid();

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
  select * into v_loan from public.loans where id = p_loan_id for update;

  if not found then
    raise exception 'No such loan.' using errcode = 'P0001';
  end if;

  if v_loan.status <> 'pending_approval' then
    raise exception
      'Only a loan awaiting approval can be approved; this one is %.', v_loan.status
      using errcode = 'P0001';
  end if;

  if auth.uid() is not null and not public.user_has_permission('loans:approve') then
    raise exception 'Approving a loan requires the loans:approve capability.'
      using errcode = 'P0001';
  end if;

  select * into v_client from public.clients where id = v_loan.client_id;
  select * into v_product from public.loan_products where id = v_loan.loan_product_id;

  if v_product.id is null then
    raise exception 'Loan % names no product, so it has no terms to approve.',
      v_loan.loan_number using errcode = 'P0001';
  end if;

  -- --- Every rule, re-evaluated now. Not from draft time. -----------------
  -- First, because this is the check with the documented failure codes and
  -- the one a form can map onto its own fields.
  select pg_catalog.string_agg(failure_code, ', ' order by failure_code)
    into v_failures
  from public.validate_loan_for_approval(p_loan_id);

  if v_failures is not null then
    raise exception 'This loan cannot be approved: %', v_failures
      using errcode = 'P0001';
  end if;

  -- --- The effective terms -----------------------------------------------
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

  -- The amount has to be one this product writes. The business's own range
  -- was already applied by the validator above; this is the product's.
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
  -- `loan.snapshot_created` events for what is one act.
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

  -- --- The product terms, frozen -----------------------------------------
  -- After the UPDATE, because the snapshot reads the rate and the applied
  -- grace and penalty off the loan the line above has just written.
  perform public.capture_loan_product_snapshot(p_loan_id);
  return p_loan_id;
end;
$function$;
