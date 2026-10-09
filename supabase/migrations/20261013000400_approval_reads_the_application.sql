-- ===========================================================================
-- Phase 13.4 — approval reads the application it was given
--
-- 13.2 and 13.3 gave an application its own product-specific answers and its
-- own guarantors with signed consent. Nothing read them yet: approval still
-- counted the *client's* register and ignored the product's questions
-- entirely. This migration makes the decision depend on the file.
--
-- ## Where a loan's frozen guarantor details now live
--
-- On `loan_guarantors` itself, in `snapshot_*` columns filled at approval —
-- not in `loan_guarantor_snapshots`.
--
-- That table cannot hold them: `guarantor_id` is NOT NULL with a foreign key
-- to `guarantors`, and half of a loan's guarantors are now existing clients
-- who have no row there and must not be given one (a second identity record
-- for the same person is how a register comes to hold two of somebody with
-- different phone numbers). Relaxing that column would mean removing a
-- constraint, which the tooling that reaches the live database cannot do
-- non-interactively — but the shape is the real reason, and it would be the
-- reason even with a free hand.
--
-- Putting them on the row is also the pattern this schema already uses where
-- the row *is* per-loan: `loans` carries `interest_rate_bps`,
-- `grace_period_days_applied` and `min_loan_amount_applied` — its own frozen
-- terms, on the live row. A separate snapshot table exists for the details of
-- *other* entities, which change independently (a client's phone, a
-- guarantor's address). `loan_guarantors` is itself one row per loan per
-- guarantor and is already immutable from submission, so its frozen copy
-- belongs on it.
--
-- `loan_guarantor_snapshots` keeps every row it has: it is the record for the
-- loans approved before this phase, and `loan_guarantor_evidence` presents
-- both as one list so a reader never has to know which era a loan is from.
--
-- ## The guarantor requirement, when two places have a number
--
-- The stricter of the two applies: `greatest(business floor, product
-- minimum)`. `business_settings.min_guarantors_required` is the floor every
-- product sits above — the guard rail doctrine from Phase 12 — and a product
-- may ask for more. So Quick Loans asking for none still inherits the
-- business's floor of one, and a business that genuinely wants guarantor-free
-- quick advances lowers the floor on the Settings screen. That is a decision
-- for a person, not a default.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- The frozen details
-- ---------------------------------------------------------------------------

alter table public.loan_guarantors
  add column snapshot_full_name text,
  add column snapshot_phone text,
  add column snapshot_alternative_phone text,
  add column snapshot_sex text,
  add column snapshot_date_of_birth date,
  add column snapshot_occupation text,
  add column snapshot_location text,
  add column snapshot_district text,
  add column snapshot_had_identification boolean,
  add column snapshot_had_photograph boolean,
  add column snapshot_at timestamptz;

comment on column public.loan_guarantors.snapshot_full_name is
  'Phase 13. The guarantor''s details as they stood when the loan was approved, frozen onto the row. Null until approval: before that the live record is what the screens read.';

alter table public.loan_guarantors add constraint loan_guarantors_snapshot_complete
  check (
    (snapshot_at is null and snapshot_full_name is null)
    or (snapshot_at is not null
        and btrim(coalesce(snapshot_full_name, '')) <> ''
        and btrim(coalesce(snapshot_phone, '')) <> ''
        and snapshot_had_identification is not null)
  );

-- Written once, by approval, and never again.
create or replace function public.loan_guarantors_guard_snapshot()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.snapshot_at is not null
     and (new.snapshot_at is distinct from old.snapshot_at
       or new.snapshot_full_name is distinct from old.snapshot_full_name
       or new.snapshot_phone is distinct from old.snapshot_phone
       or new.snapshot_alternative_phone is distinct from old.snapshot_alternative_phone
       or new.snapshot_sex is distinct from old.snapshot_sex
       or new.snapshot_date_of_birth is distinct from old.snapshot_date_of_birth
       or new.snapshot_occupation is distinct from old.snapshot_occupation
       or new.snapshot_location is distinct from old.snapshot_location
       or new.snapshot_district is distinct from old.snapshot_district
       or new.snapshot_had_identification is distinct from old.snapshot_had_identification
       or new.snapshot_had_photograph is distinct from old.snapshot_had_photograph) then
    raise exception
      'The guarantor details frozen at approval cannot be changed. They are what the business relied on.'
      using errcode = 'P0001';
  end if;

  -- The consent is evidence too, from the moment it is signed.
  if old.consented_at is not null
     and (new.consented_at is distinct from old.consented_at
       or new.consent_terms_id is distinct from old.consent_terms_id
       or new.consent_version is distinct from old.consent_version
       or new.signature_name is distinct from old.signature_name
       or new.witness_name is distinct from old.witness_name) then
    raise exception
      'A signed guarantor undertaking cannot be altered. Take a fresh consent instead.'
      using errcode = 'P0001';
  end if;

  return new;
end;
$$;

comment on function public.loan_guarantors_guard_snapshot() is
  'Phase 13. Makes the frozen details and the signed consent on a loan guarantor write-once.';

revoke all on function public.loan_guarantors_guard_snapshot()
  from public, anon, authenticated;

create trigger loan_guarantors_guard_snapshot
  before update on public.loan_guarantors
  for each row execute function public.loan_guarantors_guard_snapshot();

-- ---------------------------------------------------------------------------
-- One list, whichever era the loan is from
-- ---------------------------------------------------------------------------

create view public.loan_guarantor_evidence with (security_invoker = true) as
select
  lg.loan_id,
  case when lg.guarantor_client_id is not null then 'client' else 'external' end
    as subject_kind,
  lg.guarantor_id,
  lg.guarantor_client_id,
  lg.snapshot_full_name as full_name,
  lg.snapshot_phone as phone,
  lg.snapshot_alternative_phone as alternative_phone,
  lg.snapshot_sex as sex,
  lg.snapshot_date_of_birth as date_of_birth,
  lg.snapshot_occupation as occupation,
  lg.snapshot_location as location,
  lg.snapshot_district as district,
  lg.relationship_to_client,
  lg.snapshot_had_photograph as had_photograph,
  lg.snapshot_had_identification as had_identification,
  lg.consent_version,
  lg.consented_at,
  lg.signature_name,
  lg.witness_name,
  lg.snapshot_at as captured_at,
  'loan_guarantors'::text as source
from public.loan_guarantors lg
where lg.snapshot_at is not null

union all

select
  s.loan_id,
  coalesce(s.subject_kind, 'external') as subject_kind,
  s.guarantor_id,
  s.subject_client_id as guarantor_client_id,
  s.full_name,
  s.phone,
  s.alternative_phone,
  s.sex,
  s.date_of_birth,
  s.occupation,
  s.location,
  s.district,
  s.relationship_to_client,
  s.had_photograph,
  -- Phase 4 did not record whether identification was on file; the identity
  -- snapshot beside it did, and still does.
  null::boolean as had_identification,
  s.consent_version,
  s.consented_at,
  s.signature_name,
  s.witness_name,
  s.captured_at,
  'loan_guarantor_snapshots'::text as source
from public.loan_guarantor_snapshots s;

comment on view public.loan_guarantor_evidence is
  'Phase 13. Who guaranteed a loan, as frozen at approval — from loan_guarantors for loans approved from Phase 13 onward, and from loan_guarantor_snapshots for the loans approved before it. The source column says which.';

revoke all on public.loan_guarantor_evidence from anon, authenticated;
grant select on public.loan_guarantor_evidence to authenticated;

-- ---------------------------------------------------------------------------
-- The validator
--
-- Same signature, same return shape, four new failure codes. Every rule it
-- already checked it still checks; what changes is that the guarantors now
-- come from the application rather than the client's register, and that the
-- product's own questions have to have been answered.
-- ---------------------------------------------------------------------------

create or replace function public.validate_loan_for_approval(p_loan_id uuid)
returns table(failure_code text, detail text)
language plpgsql
stable security definer
set search_path = ''
as $$
declare
  v_loan      public.loans;
  v_client    public.clients;
  v_settings  public.business_settings;
  v_product   public.loan_products;
  v_required  integer;
  v_guarantors integer;
  v_incomplete integer;
  v_unsigned  integer;
  v_ineligible integer;
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

  select * into v_product from public.loan_products where id = v_loan.loan_product_id;

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

  -- --- The product's own questions ---------------------------------------
  -- Phase 13. A salary product that cannot say who employs the borrower has
  -- not been assessed; the answer is a row, and its completeness is the
  -- row's own constraints.
  if v_product.id is not null then
    if v_product.application_profile = 'salary'
       and not exists (
         select 1 from public.loan_salary_details d where d.loan_id = p_loan_id
       ) then
      return query select 'salary_details_missing'::text, v_product.name;
    end if;

    if v_product.application_profile = 'business'
       and not exists (
         select 1 from public.loan_business_details d where d.loan_id = p_loan_id
       ) then
      return query select 'business_details_missing'::text, v_product.name;
    end if;
  end if;

  -- --- The guarantors -----------------------------------------------------
  -- Phase 13: the application's own guarantors, not the client's register.
  -- The register is the borrower's directory of backers; what matters here is
  -- who agreed to stand behind *this* loan.
  v_required := greatest(
    coalesce(v_settings.min_guarantors_required, 0),
    coalesce(v_product.min_guarantors, 0)
  );

  select pg_catalog.count(*) into v_guarantors
  from public.loan_guarantors lg
  where lg.loan_id = p_loan_id;

  if v_guarantors < v_required then
    return query select 'insufficient_guarantors'::text, v_required::text;
  end if;

  -- Completeness, not merely presence. An approval that passes on a guarantor
  -- with no phone number has recorded somebody the business cannot actually
  -- call.
  select pg_catalog.count(*) into v_incomplete
  from public.loan_guarantors lg
  left join public.clients c on c.id = lg.guarantor_client_id
  left join public.guarantors g on g.id = lg.guarantor_id
  where lg.loan_id = p_loan_id
    and (
         pg_catalog.btrim(coalesce(coalesce(c.phone, g.phone), '')) = ''
      or pg_catalog.btrim(coalesce(coalesce(c.occupation, g.occupation), '')) = ''
      or pg_catalog.btrim(coalesce(coalesce(c.village_area, g.location), '')) = ''
      or pg_catalog.btrim(coalesce(lg.relationship_to_client, '')) = ''
      or not (
        case
          when lg.guarantor_client_id is not null
            then exists (select 1 from public.client_identities ci
                          where ci.client_id = lg.guarantor_client_id)
          else exists (select 1 from public.guarantor_identities gi
                        where gi.guarantor_id = lg.guarantor_id)
        end
      )
    );

  if v_incomplete > 0 then
    return query select 'guarantor_incomplete'::text, v_incomplete::text;
  end if;

  -- The undertaking. A guarantor who has not signed is somebody the business
  -- cannot hold to anything, so an unsigned consent stops the approval rather
  -- than being noted on it.
  select pg_catalog.count(*) into v_unsigned
  from public.loan_guarantors lg
  where lg.loan_id = p_loan_id and lg.consented_at is null;

  if v_unsigned > 0 then
    return query select 'guarantor_consent_missing'::text, v_unsigned::text;
  end if;

  -- Eligibility, re-evaluated now. The trigger checked it when the guarantor
  -- was attached; a client blacklisted the next day, or a guarantor archived,
  -- must stop the approval for the same reason a blacklisted borrower does.
  select pg_catalog.count(*) into v_ineligible
  from public.loan_guarantors lg
  left join public.clients c on c.id = lg.guarantor_client_id
  left join public.guarantors g on g.id = lg.guarantor_id
  where lg.loan_id = p_loan_id
    and (
         (lg.guarantor_client_id is not null and c.status <> 'active')
      or (lg.guarantor_id is not null and g.archived_at is not null)
    );

  if v_ineligible > 0 then
    return query select 'guarantor_ineligible'::text, v_ineligible::text;
  end if;

  return;
end;
$$;

comment on function public.validate_loan_for_approval(uuid) is
  'Phase 4, extended in Phase 13. Every rule an approval must satisfy, as failure codes. Reads the application''s own guarantors and the product''s own questions; collateral is Phase 5.';

-- ---------------------------------------------------------------------------
-- Approval
--
-- The 12.7 body with the guarantor section rewritten: the snapshot is frozen
-- onto `loan_guarantors` and the identity snapshots cover both kinds of
-- guarantor. Everything else — the lock, the capability check, the
-- validation, the breakdown, the client snapshot, the product snapshot — is
-- unchanged.
-- ---------------------------------------------------------------------------

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

  select pg_catalog.string_agg(failure_code, ', ' order by failure_code)
    into v_failures
  from public.validate_loan_for_approval(p_loan_id);

  if v_failures is not null then
    raise exception 'This loan cannot be approved: %', v_failures
      using errcode = 'P0001';
  end if;

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

  if v_loan.principal_amount < v_product.min_amount
     or v_loan.principal_amount > v_product.max_amount then
    raise exception
      '% lends between % and %; this application is for %.',
      v_product.name, v_product.min_amount, v_product.max_amount,
      v_loan.principal_amount
      using errcode = 'P0001';
  end if;

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

  select pg_catalog.sum(b.interest) into v_total_interest
  from public.calculate_loan_breakdown(
    v_loan.principal_amount,
    v_rate_bps,
    v_loan.loan_term_months
  ) b;

  v_total_expected := v_loan.principal_amount + v_total_interest;

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

  -- --- The guarantors, frozen onto the application's own rows -------------
  -- Phase 13. One statement, so every guarantor on the loan is frozen at the
  -- same instant and a failure leaves none of them frozen.
  update public.loan_guarantors lg
     set snapshot_full_name = src.full_name,
         snapshot_phone = src.phone,
         snapshot_alternative_phone = src.alternative_phone,
         snapshot_sex = src.sex,
         snapshot_date_of_birth = src.date_of_birth,
         snapshot_occupation = src.occupation,
         snapshot_location = src.location,
         snapshot_district = src.district,
         snapshot_had_photograph = src.had_photograph,
         snapshot_had_identification = src.had_identification,
         snapshot_at = pg_catalog.now()
    from (
      select
        lg2.id,
        coalesce(c.full_name, g.full_name) as full_name,
        coalesce(c.phone, g.phone) as phone,
        coalesce(c.alternative_phone, g.alternative_phone) as alternative_phone,
        coalesce(c.sex, g.sex) as sex,
        coalesce(c.date_of_birth, g.date_of_birth) as date_of_birth,
        coalesce(c.occupation, g.occupation) as occupation,
        coalesce(c.village_area, g.location) as location,
        coalesce(c.district, g.district) as district,
        coalesce(g.photo_path is not null, false) as had_photograph,
        case
          when lg2.guarantor_client_id is not null
            then exists (select 1 from public.client_identities ci
                          where ci.client_id = lg2.guarantor_client_id)
          else exists (select 1 from public.guarantor_identities gi
                        where gi.guarantor_id = lg2.guarantor_id)
        end as had_identification
      from public.loan_guarantors lg2
      left join public.clients c on c.id = lg2.guarantor_client_id
      left join public.guarantors g on g.id = lg2.guarantor_id
      where lg2.loan_id = p_loan_id and lg2.snapshot_at is null
    ) src
   where src.id = lg.id;

  -- --- The identity snapshots, into the protected table ------------------
  -- Client and guarantors in **one statement**, deliberately. The audit
  -- trigger on this table is statement-level, so two inserts would record two
  -- `loan.snapshot_created` events for what is one act.
  --
  -- A guarantor who is an existing client is recorded as `client`, with their
  -- own client id: that is what they are, and the borrower is distinguishable
  -- by `loans.client_id`. Inventing a third subject type would have meant
  -- changing a CHECK constraint for a distinction the data already makes.
  insert into public.loan_identity_snapshots (loan_id, subject_type, subject_id, nin)
  select p_loan_id, 'client', ci.client_id, ci.nin
  from public.client_identities ci
  where ci.client_id = v_client.id
  union all
  select p_loan_id, 'guarantor', g.id, gi.nin
  from public.loan_guarantors lg
  join public.guarantors g on g.id = lg.guarantor_id
  join public.guarantor_identities gi on gi.guarantor_id = g.id
  where lg.loan_id = p_loan_id
  union all
  select p_loan_id, 'client', ci.client_id, ci.nin
  from public.loan_guarantors lg
  join public.client_identities ci on ci.client_id = lg.guarantor_client_id
  where lg.loan_id = p_loan_id
  on conflict (loan_id, subject_type, subject_id) do nothing;

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

  perform public.capture_loan_product_snapshot(p_loan_id);
  return p_loan_id;
end;
$function$;

-- ---------------------------------------------------------------------------
-- The trail still records that the guarantor evidence was frozen
--
-- `audit_loan_snapshot_created` is an AFTER INSERT statement trigger, and the
-- freeze is now an UPDATE — so moving the evidence onto `loan_guarantors`
-- silently lost one of the four `loan.snapshot_created` events approval
-- used to write. Found by a test that counts them, which is why it counts
-- them.
--
-- The rule is the same as the original's: the kind and the row count, never
-- the contents. `audit:view` is broader than `loans:view_sensitive`, and a
-- snapshot in the trail would hand every identity number to anyone who can
-- read the trail.
--
-- It fires on every UPDATE of the table and decides for itself whether a
-- freeze happened, by comparing the two transition tables — a statement
-- trigger cannot carry a WHEN clause, and an event logged for an ordinary
-- consent edit would be a lie about what happened.
-- ---------------------------------------------------------------------------

create or replace function public.audit_loan_guarantors_frozen()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_loan_id uuid;
  v_count   integer;
begin
  select i.loan_id, pg_catalog.count(*)::integer
    into v_loan_id, v_count
  from inserted i
  join before b on b.id = i.id
  where i.snapshot_at is not null and b.snapshot_at is null
  group by i.loan_id
  limit 1;

  if v_loan_id is null then
    return null;
  end if;

  insert into public.audit_log (
    actor_profile_id, actor_auth_user_id, actor_label,
    action, entity_type, entity_id, new_values
  )
  values (
    public.current_profile_id(), auth.uid(), public.audit_actor_label(),
    'loan.snapshot_created', 'loan', v_loan_id::text,
    pg_catalog.jsonb_build_object('snapshot', 'guarantor', 'rows_captured', v_count)
  );

  return null;
end;
$$;

comment on function public.audit_loan_guarantors_frozen() is
  'Phase 13. Records that a loan''s guarantor evidence was frozen at approval: the kind and the row count, never the contents.';

revoke all on function public.audit_loan_guarantors_frozen() from public, anon, authenticated;

create trigger audit_loan_guarantors_frozen
  after update on public.loan_guarantors
  referencing old table as before new table as inserted
  for each statement execute function public.audit_loan_guarantors_frozen();
