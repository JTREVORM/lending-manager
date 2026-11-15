-- ===========================================================================
-- The guarantor concentration ceiling, enforced where it binds
--
-- `business_settings.guarantor_max_active_loans` (configured at 2) carries
-- this comment, written when the column was added in Phase 13:
--
--     'How many active loans one person may guarantee at once. A guarantor
--      standing behind six loans is a concentration nobody chose.'
--
-- That is not what the database guaranteed. The ceiling was asked in exactly
-- one place -- `loan_guarantors_check_eligibility()`, on INSERT into
-- `loan_guarantors` -- and it counted loans whose status was already
-- `active`. A guarantor is attached while the loan is still a *draft*, so at
-- the moment the question was asked the answer was almost always zero.
--
-- The attach-time rule is not useless: attach somebody who already backs two
-- active loans and it refuses, correctly. What it cannot see is the ordinary
-- case. Attach one guarantor to three drafts -- every attach permitted, every
-- count zero -- then approve and disburse all three, and that person stands
-- behind three active loans against a ceiling of two. Nothing refused it, and
-- no report showed it.
--
-- Reproduced before this migration was written, with the ceiling at 2: one
-- guarantor, three drafts, three disbursements, three active guaranteed
-- loans. `tests/db/guarantor-concentration.test.ts` is that reproduction.
--
-- ## Why the ceiling is enforced at activation, not at approval
--
-- Because that is what the rule says. It is a ceiling on *active* loans, and
-- a loan becomes active when it is disbursed.
--
-- The first attempt at this fix enforced it at approval and counted
-- `approved` loans as committed exposure. That broke two existing
-- concurrency tests, and they were right to break: the business routinely
-- approves more loans for one borrower than that borrower can ever hold --
-- `max_active_loans_per_client` means only one of four approvals is ever
-- disbursed -- so counting approvals refused the third of four applications
-- that were always going to resolve to a single active loan.
--
-- So this is deliberately the same two-part shape as
-- `max_active_loans_per_client`, which has worked since Phase 4:
--
--   1. `validate_loan_for_approval_internal` returns the documented failure
--      code `guarantor_concentration` when a guarantor already backs the
--      maximum number of **active** loans. Advisory, like
--      `active_loan_exists`: it tells the approver which rule will refuse,
--      before they decide.
--
--   2. `loans_enforce_guarantor_concentration` is the guarantee. It fires on
--      the transition to `active`, takes an advisory lock per guarantor so
--      two concurrent disbursements cannot both read a stale count, and binds
--      every caller -- `service_role` and a hand-written UPDATE included --
--      not only `disburse_loan`.
--
-- An approved loan that cannot be disbursed is not a new situation: the
-- one-active-loan rule has produced exactly that since Phase 4, and
-- `tests/db/loan-concurrency.test.ts` asserts it. A loan in that position is
-- cancelled, or its guarantor is substituted while it is returned to draft.
--
-- ## Why 13.6 is not being re-litigated
--
-- Phase 13.6 moved this rule *off* the consent step, and was right to: a
-- guarantor attached while eligible, whose other loans then went active,
-- could neither sign nor be removed, and the application was stranded with
-- nothing anybody could do about it. Nothing here touches the consent step.
--
-- NOTE FOR REVIEW: this changes what the business can disburse. A
-- disbursement whose guarantor already backs the maximum number of active
-- loans is now refused where it previously succeeded. That is the documented
-- rule being enforced rather than a new rule, but it is a visible change and
-- it wants the Owner's sign-off before this is merged.
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.validate_loan_for_approval_internal(p_loan_id uuid)
 RETURNS TABLE(failure_code text, detail text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
  v_overcommitted integer;
  v_active    integer;
  v_frequency public.repayment_frequencies;
  v_member    record;
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
  -- Polytos Phase 3. The business term ceiling is the non-member rule, and a
  -- member product's ceiling is the member rule on the borrower's own policy
  -- version — checked by `member_term_above_maximum` below. So a member loan
  -- is exempted from this clause and not from a ceiling: it is held to a
  -- different, stricter-in-its-own-right number that the client's documents
  -- state. Every other product is unchanged.
  if not coalesce(v_product.requires_membership, false) then
    if v_loan.loan_term_months < v_settings.min_loan_term_months
       or v_loan.loan_term_months > v_settings.max_loan_term_months then
      return query select 'term_not_permitted'::text, v_loan.loan_term_months::text;
    end if;
  elsif v_loan.loan_term_months < v_settings.min_loan_term_months then
    return query select 'term_not_permitted'::text, v_loan.loan_term_months::text;
  end if;

  if v_loan.loan_term_months > 1
     and v_loan.principal_amount < v_settings.multi_month_min_amount then
    return query select 'term_requires_higher_amount'::text,
                        v_settings.multi_month_min_amount::text;
  end if;

  -- --- The repayment rhythm ----------------------------------------------
  select * into v_frequency
  from public.repayment_frequencies rf
  where rf.key = v_loan.repayment_frequency and rf.is_active;

  if not found then
    return query select 'frequency_not_permitted'::text, v_loan.repayment_frequency;
  elsif v_frequency.cadence_kind = 'calendar_month'
        and v_frequency.month_anchor is null then
    -- Polytos Phase 3, and deliberately not member-specific. A loan approved
    -- on a cadence whose monthly convention nobody has decided is a loan
    -- `generate_loan_schedule` will refuse at the disbursement counter, with
    -- the borrower standing there. Refusing it at approval is the same answer
    -- a day earlier.
    return query select 'cadence_anchor_undecided'::text, v_frequency.key;
  end if;

  -- --- The product's own questions ---------------------------------------
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

  -- --- Polytos Phase 3: membership eligibility ---------------------------
  --
  -- Reached only for a product that requires membership, so every ordinary
  -- loan takes exactly the path it took before this migration.
  --
  -- The assessment is `member_loan_eligibility_of`, the same function the
  -- screens read through, with the loan's **own** figures as the request —
  -- never figures from a caller. An approver who could supply the amount, the
  -- term or the membership could approve an unqualified member by typing a
  -- different number into a request; what the loan says it is for is what it
  -- is assessed against.
  --
  -- The assessment date is the business date rather than the application
  -- date. A savings balance that has fallen since the application must refuse
  -- the approval: the business decides on what is true when it decides.
  if coalesce(v_product.requires_membership, false) then
    select * into v_member
    from public.member_loan_eligibility_of(
      v_loan.client_id,
      v_loan.principal_amount,
      v_loan.loan_term_months,
      v_loan.repayment_frequency,
      public.business_date()
    );

    if v_member.membership_id is null then
      return query select 'member_product_not_member'::text, v_product.name;
    else
      if v_member.membership_status <> 'active' then
        return query select 'member_not_active'::text, v_member.membership_status;
      end if;

      if not public.membership_policy_allows(v_member.policy_version_id, 'lending') then
        return query select 'member_policy_not_open'::text,
          public.member_lending_blocked_reason(v_member.policy_version_id);
      end if;

      if v_member.savings_account_id is null then
        return query select 'member_savings_missing'::text, v_member.membership_number;
      else
        if v_member.savings_account_status <> 'active' then
          return query select 'member_savings_suspended'::text,
                              v_member.savings_account_status;
        end if;

        if not coalesce(v_member.savings_qualifies, false) then
          return query select 'member_not_qualified'::text,
            coalesce(v_member.qualifying_months, 0)::text || ' of '
              || coalesce(v_member.months_required, 0)::text;
        end if;
      end if;

      if v_member.max_eligible_loan is null then
        -- No ceiling because the multiplier is undecided. `member_policy_not_open`
        -- has already fired, so this is the belt to that brace: a ceiling that
        -- cannot be computed can never be satisfied, and an approval must not
        -- pass merely because the comparison had nothing to compare.
        return query select 'member_amount_above_ceiling'::text,
          'the savings-to-loan multiplier has not been decided';
      elsif v_loan.principal_amount > v_member.max_eligible_loan then
        return query select 'member_amount_above_ceiling'::text,
                            v_member.max_eligible_loan::text;
      end if;

      if v_member.max_term_months is not null
         and v_loan.loan_term_months > v_member.max_term_months then
        return query select 'member_term_above_maximum'::text,
                            v_member.max_term_months::text;
      end if;

      if v_member.required_cadence is not null
         and v_loan.repayment_frequency <> v_member.required_cadence then
        return query select 'member_cadence_not_permitted'::text,
                            v_member.required_cadence;
      end if;
    end if;
  end if;

  -- --- The guarantors -----------------------------------------------------
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

  select pg_catalog.count(*) into v_unsigned
  from public.loan_guarantors lg
  where lg.loan_id = p_loan_id and lg.consented_at is null;

  if v_unsigned > 0 then
    return query select 'guarantor_consent_missing'::text, v_unsigned::text;
  end if;

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

  -- --- Guarantor concentration -------------------------------------------
  --
  -- `business_settings.guarantor_max_active_loans` says, in its own comment,
  -- "how many active loans one person may guarantee at once". This is the
  -- approval-time half of that rule, and it is deliberately the same shape as
  -- `active_loan_exists` above: it counts loans that are already **active**,
  -- so the approver is told which rule will refuse before they decide, and
  -- `loans_enforce_guarantor_concentration` is what actually guarantees the
  -- ceiling when the loan is disbursed.
  --
  -- It deliberately does NOT count `approved` loans. The business approves
  -- more loans for one borrower than that borrower can hold -- the
  -- one-active-loan rule means only one of them is ever disbursed -- and
  -- counting approvals would refuse the second of four applications that were
  -- always going to resolve to one active loan.
  select pg_catalog.count(*) into v_overcommitted
  from public.loan_guarantors lg
  where lg.loan_id = p_loan_id
    and (
      select pg_catalog.count(*)
      from public.loan_guarantors other
      join public.loans ol on ol.id = other.loan_id
      where other.loan_id <> p_loan_id
        and ol.status = 'active'
        and (
             (lg.guarantor_id is not null
              and other.guarantor_id = lg.guarantor_id)
          or (lg.guarantor_client_id is not null
              and other.guarantor_client_id = lg.guarantor_client_id)
        )
    ) >= coalesce(v_settings.guarantor_max_active_loans, 2147483647);

  if v_overcommitted > 0 then
    return query select 'guarantor_concentration'::text, v_overcommitted::text;
  end if;

  return;
end;
$function$;

comment on function public.validate_loan_for_approval_internal(uuid) is
  'Why a loan may not be approved, as machine-readable codes. Re-emitted 20261119000100 to add guarantor_concentration, the advisory half of the guarantor ceiling; loans_enforce_guarantor_concentration is the guarantee.';

-- ---------------------------------------------------------------------------
-- The guarantee
-- ---------------------------------------------------------------------------
create or replace function public.loans_enforce_guarantor_concentration()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_limit integer;
  v_count integer;
  v_name  text;
  v_g     record;
begin
  select bs.guarantor_max_active_loans into v_limit
  from public.business_settings bs
  where bs.id = 1;

  -- Fail closed, exactly as loans_enforce_active_limit does. A missing
  -- settings row is a broken installation, and guessing "unlimited" would be
  -- the worst available guess about a risk ceiling.
  if v_limit is null then
    raise exception
      'Business settings are unavailable; a loan cannot be activated.'
      using errcode = 'P0001';
  end if;

  for v_g in
    select lg.guarantor_id, lg.guarantor_client_id
    from public.loan_guarantors lg
    where lg.loan_id = new.id
    order by lg.guarantor_id, lg.guarantor_client_id
  loop
    -- Serialised per guarantor, and taken in a stable order, so two
    -- disbursements that share two guarantors cannot deadlock against each
    -- other. Keyed on the guarantor, so unrelated loans do not contend.
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtext(
        'loan_guarantor_load:'
        || coalesce(v_g.guarantor_id::text, '')
        || ':'
        || coalesce(v_g.guarantor_client_id::text, '')
      )
    );

    select pg_catalog.count(*) into v_count
    from public.loan_guarantors other
    join public.loans ol on ol.id = other.loan_id
    where other.loan_id <> new.id
      and ol.status = 'active'
      and (
           (v_g.guarantor_id is not null
            and other.guarantor_id = v_g.guarantor_id)
        or (v_g.guarantor_client_id is not null
            and other.guarantor_client_id = v_g.guarantor_client_id)
      );

    if v_count >= v_limit then
      select coalesce(c.full_name, g.full_name) into v_name
      from (select 1) _
      left join public.clients c on c.id = v_g.guarantor_client_id
      left join public.guarantors g on g.id = v_g.guarantor_id;

      raise exception
        '% already guarantees % active loan(s); the limit is %.',
        coalesce(v_name, 'That guarantor'), v_count, v_limit
        using errcode = 'P0001';
    end if;
  end loop;

  return new;
end;
$$;

comment on function public.loans_enforce_guarantor_concentration() is
  'Refuses to let a loan reach `active` when one of its guarantors already stands behind the configured maximum of active loans. Advisory-locked per guarantor so concurrent disbursements serialise; binds every caller, not only disburse_loan. The approval-time half of the rule is validate_loan_for_approval_internal''s guarantor_concentration code.';

revoke all on function public.loans_enforce_guarantor_concentration()
  from public, anon, authenticated;

drop trigger if exists loans_enforce_guarantor_concentration on public.loans;

create trigger loans_enforce_guarantor_concentration
  before update on public.loans
  for each row
  when (new.status = 'active' and old.status is distinct from 'active')
  execute function public.loans_enforce_guarantor_concentration();
