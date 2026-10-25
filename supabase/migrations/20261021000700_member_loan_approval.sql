-- ===========================================================================
-- Polytos Phase 3.7 — eligibility enforced where it cannot be bypassed
--
-- ## Why this is the most important migration in the phase
--
-- Every control in §8 and §12 of the member-loan specification can be written
-- into a form, and every one of them can then be defeated by a POST. The only
-- control that holds against a forged request, a leaked key, a mistaken
-- `UPDATE`, a Server Action somebody adds later, and `psql` is a control
-- inside the function that writes the approval.
--
-- So the rules live in `validate_loan_for_approval()`, which `approve_loan()`
-- already calls and already refuses on, and in `approve_loan()` itself for the
-- things that have to happen atomically with the write. Nothing about member
-- eligibility is checked only in TypeScript.
--
-- ## The new failure codes
--
-- `validate_loan_for_approval` returns codes rather than raising, so an
-- approval screen can list every reason at once instead of revealing them one
-- refusal at a time. The member codes follow the same convention:
--
--   `member_product_not_member`     the product requires membership and the
--                                   borrower has no live membership
--   `member_not_active`            pending, suspended, withdrawn or deceased
--   `member_policy_not_open`       member lending is not open under the
--                                   borrower's own frozen policy version
--   `member_savings_missing`       no savings account, so no qualification
--   `member_savings_suspended`     the account is dormant or closed
--   `member_not_qualified`         the qualifying months have not been served
--   `member_amount_above_ceiling`  more than the savings multiplier supports
--   `member_term_above_maximum`    longer than the policy's member maximum
--   `member_cadence_not_permitted` the wrong cadence for the term
--   `cadence_anchor_undecided`     a calendar-monthly loan whose monthly
--                                   convention nobody has decided
--
-- The last one is **not** member-specific and is checked for every product,
-- because an approved loan whose schedule cannot be generated is a loan that
-- can never be disbursed — and finding that out at the disbursement counter,
-- with the borrower present, is the wrong place to find it out.
--
-- ## What approval freezes
--
-- `approve_loan` already freezes the product, the rate, the method, the
-- totals and the policy figures. For a member loan it additionally freezes:
--
--   on `loans`                            the membership, the interest basis
--   in `member_loan_eligibility_snapshots` the whole assessment: the policy
--                                          version, the qualifying months,
--                                          the savings balance relied on, the
--                                          multiplier, the ceiling and the
--                                          amount requested
--   in `member_loan_savings_pledges`      the savings capacity consumed
--
-- The snapshot is the evidence. Without it, a member refused a second loan
-- next year has no way to see what the business relied on the first time, and
-- an auditor has no way to check that the ceiling was respected — the live
-- savings balance will have moved, and re-deriving the assessment would give
-- a different answer for a legitimate reason.
--
-- ## Concurrency
--
-- Two approvals racing for one member's savings capacity must not both
-- succeed. `approve_loan` takes `lock_savings_capacity()` on the member's
-- savings account before it assesses, which is the same key the withdrawal
-- path takes — so approval-versus-approval and approval-versus-withdrawal are
-- both serialised on one lock rather than on two that could be taken in
-- different orders.
--
-- The existing one-active-loan limit is a separate and independent control,
-- enforced by the trigger on `loans` under its own advisory lock. Both apply.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- The evidence
-- ---------------------------------------------------------------------------

create table public.member_loan_eligibility_snapshots (
  loan_id uuid primary key references public.loans(id) on delete restrict,

  membership_id uuid not null references public.memberships(id) on delete restrict,
  membership_number text not null,
  client_id uuid not null references public.clients(id) on delete restrict,

  policy_version_id uuid not null
    references public.membership_policy_versions(id) on delete restrict,
  policy_version text not null,

  savings_account_id uuid not null
    references public.savings_accounts(id) on delete restrict,
  savings_account_number text not null,

  -- The date the assessment was made against. Everything below is "as of"
  -- this, and a deposit made afterwards does not change any of it.
  assessed_on date not null,

  -- The qualification, as Phase 2's calculation returned it.
  months_required smallint not null,
  must_be_consecutive boolean not null,
  qualifying_months integer not null,
  consecutive_qualifying_months integer not null,

  -- The savings the business relied on, and what it multiplied them by.
  eligible_savings bigint not null,
  multiplier_bps integer not null,
  max_eligible_loan bigint not null,

  -- The terms the policy priced the loan at, frozen here as well as on
  -- `loans`, so the snapshot is self-contained evidence.
  interest_rate_bps integer not null,
  interest_basis text not null,
  interest_method text not null,
  max_term_months smallint not null,
  required_cadence text not null,

  -- What was asked for, beside what was permitted.
  amount_requested bigint not null,
  term_requested smallint not null,
  repayment_frequency text not null,

  -- What else the borrower owed when the business decided.
  active_loan_count integer not null,
  outstanding_principal bigint not null,
  pledged_savings_before bigint not null,

  captured_at timestamptz not null default pg_catalog.now(),
  captured_by uuid references public.profiles(id) on delete set null,
  captured_by_label text not null default 'system',

  constraint member_loan_snapshots_months_sane
    check (months_required >= 1
           and qualifying_months >= 0
           and consecutive_qualifying_months >= 0
           and consecutive_qualifying_months <= qualifying_months),
  constraint member_loan_snapshots_savings_non_negative
    check (eligible_savings >= 0 and pledged_savings_before >= 0),
  constraint member_loan_snapshots_multiplier_positive check (multiplier_bps > 0),
  constraint member_loan_snapshots_ceiling_positive check (max_eligible_loan > 0),
  constraint member_loan_snapshots_amount_positive check (amount_requested > 0),
  -- The rule the business actually applied, as a constraint. A snapshot
  -- recording an approval above the ceiling cannot be stored by any route,
  -- which makes the row evidence rather than a claim.
  constraint member_loan_snapshots_within_ceiling
    check (amount_requested <= max_eligible_loan),
  constraint member_loan_snapshots_term_within_maximum
    check (term_requested >= 1 and term_requested <= max_term_months),
  constraint member_loan_snapshots_qualified
    check (
      case
        when must_be_consecutive
          then consecutive_qualifying_months >= months_required
        else qualifying_months >= months_required
      end
    ),
  constraint member_loan_snapshots_basis_valid
    check (interest_basis in ('per_month', 'per_loan')),
  constraint member_loan_snapshots_method_valid
    check (interest_method in ('flat', 'reducing_balance_monthly')),
  constraint member_loan_snapshots_rate_non_negative check (interest_rate_bps >= 0),
  constraint member_loan_snapshots_outstanding_non_negative
    check (outstanding_principal >= 0 and active_loan_count >= 0)
);

comment on table public.member_loan_eligibility_snapshots is
  'Polytos Phase 3. The eligibility assessment a member loan was approved on, frozen. Append-only: a later deposit, withdrawal, policy change or membership withdrawal cannot rewrite what the business relied on. Its constraints restate the rules, so a row recording an approval above the ceiling or by an unqualified member cannot exist.';
comment on column public.member_loan_eligibility_snapshots.assessed_on is
  'The business date the assessment was made against. Phase 2''s qualification reads only transactions dated on or before this, so the snapshot stays the snapshot it took.';
comment on column public.member_loan_eligibility_snapshots.pledged_savings_before is
  'How much of this member''s savings already secured other member loans when this one was approved. The figure that stops the same capacity being lent twice.';

create index member_loan_snapshots_membership_idx
  on public.member_loan_eligibility_snapshots (membership_id);
create index member_loan_snapshots_client_idx
  on public.member_loan_eligibility_snapshots (client_id);
create index member_loan_snapshots_savings_idx
  on public.member_loan_eligibility_snapshots (savings_account_id);

-- Append-only, with the pattern the other snapshot tables use.
create trigger member_loan_snapshots_no_update
  before update on public.member_loan_eligibility_snapshots
  for each row execute function public.reject_mutation();

create trigger member_loan_snapshots_no_delete
  before delete on public.member_loan_eligibility_snapshots
  for each row execute function public.reject_mutation();

-- ---------------------------------------------------------------------------
-- The validator
--
-- The 13.4 body, with one section added. Every rule it already checked it
-- still checks, in its original order and wording, because each is still
-- right and because a reordering would change which failure a screen shows
-- first.
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

  return;
end;
$$;

comment on function public.validate_loan_for_approval(uuid) is
  'Phase 4, extended in Phase 13 and Polytos Phase 3. Every rule an approval must satisfy, as failure codes. Reads the application''s own guarantors and the product''s own questions; for a product requiring membership it reads the borrower''s member-loan eligibility, and for any product it refuses a cadence whose monthly convention is undecided.';

revoke all on function public.validate_loan_for_approval(uuid)
  from public, anon, authenticated;
grant execute on function public.validate_loan_for_approval(uuid) to authenticated;

-- ===========================================================================
-- Approval
--
-- The 13.4 body, with a member-loan section. The lock, the capability check,
-- the validation, the breakdown, the client snapshot, the guarantor freeze,
-- the identity snapshots and the product snapshot are unchanged.
--
-- What changes:
--
--   1. the savings-capacity lock is taken **before** validation, for a member
--      loan, so the assessment validation makes and the assessment approval
--      acts on are the same one;
--   2. the rate, basis and method for a policy-priced product come from the
--      borrower's own frozen policy version, not from the product;
--   3. the breakdown comes from `member_loan_interest` rather than
--      `calculate_loan_breakdown` — which for a per-month reducing-balance
--      policy is the same function by delegation;
--   4. the eligibility snapshot and the savings pledge are written.
-- ===========================================================================

create or replace function public.approve_loan(p_loan_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_loan      public.loans;
  v_client    public.clients;
  v_product   public.loan_products;
  v_rate_bps  integer;
  v_method    text;
  v_basis     text;
  v_failures  text;
  v_total_interest bigint;
  v_total_expected bigint;
  v_actor     uuid;
  v_member    record;
  v_policy    public.membership_policy_versions;
  v_pledged   bigint;
  -- Held separately from `v_member` because the UPDATE below runs for every
  -- product, and PL/pgSQL substitutes a record's fields into a statement
  -- eagerly: referencing `v_member.membership_id` inside a CASE would raise
  -- "record is not assigned yet" on every ordinary loan, whichever arm of the
  -- CASE would have been taken.
  v_membership_id uuid;
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

  -- --- Polytos Phase 3: the capacity lock, before validation -------------
  --
  -- Taken here rather than after validation, which is the whole point. Two
  -- approvals that each validated against the same untouched savings balance
  -- and then each pledged it would both succeed, and the member's savings
  -- would secure twice what they can. The lock makes the second approval
  -- validate against a balance the first has already pledged against, so it
  -- is refused by `member_amount_above_ceiling` rather than by a constraint
  -- nobody can explain.
  if coalesce(v_product.requires_membership, false) then
    perform public.lock_savings_capacity((
      select sa.id
      from public.savings_accounts sa
      join public.memberships m on m.id = sa.membership_id
      where m.client_id = v_loan.client_id
        and m.status in ('pending', 'active', 'suspended')
    ));
  end if;

  select pg_catalog.string_agg(failure_code, ', ' order by failure_code)
    into v_failures
  from public.validate_loan_for_approval(p_loan_id);

  if v_failures is not null then
    raise exception 'This loan cannot be approved: %', v_failures
      using errcode = 'P0001';
  end if;

  -- --- The price ----------------------------------------------------------
  if v_product.interest_source = 'membership_policy' then
    -- Polytos Phase 3. From the borrower's own frozen version. Validation has
    -- already established that the member exists, that lending is open under
    -- that version — which requires all three pricing decisions to have been
    -- made — and that the amount, term and cadence are permitted.
    select * into v_member
    from public.member_loan_eligibility_of(
      v_loan.client_id,
      v_loan.principal_amount,
      v_loan.loan_term_months,
      v_loan.repayment_frequency,
      public.business_date()
    );

    if v_member.membership_id is null or not v_member.may_proceed then
      -- Unreachable while validation runs immediately above, and asserted
      -- anyway: this is the statement that stops a future edit reordering the
      -- two and pricing a loan nobody was eligible for.
      raise exception
        'Loan % is priced from a membership policy but the borrower is not eligible. This is a defect: validation should have refused it.',
        v_loan.loan_number using errcode = 'P0001';
    end if;

    select * into v_policy
    from public.membership_policy_versions where id = v_member.policy_version_id;

    v_rate_bps      := v_policy.member_loan_interest_rate_bps;
    v_basis         := v_policy.interest_basis;
    v_method        := v_policy.interest_method;
    v_membership_id := v_member.membership_id;

    -- An override is impossible for a policy-priced product — a CHECK
    -- constraint refuses `interest_override_allowed` on one — but a proposed
    -- rate on the application would otherwise be silently ignored, and a
    -- silently ignored rate is a quote the business did not honour.
    if v_loan.proposed_interest_rate_bps is not null
       and v_loan.proposed_interest_rate_bps <> v_rate_bps then
      raise exception
        'A member loan is priced at the % bp its membership policy version sets; this application proposes % bp.',
        v_rate_bps, v_loan.proposed_interest_rate_bps
        using errcode = 'P0001';
    end if;
  else
    v_rate_bps := coalesce(v_loan.proposed_interest_rate_bps, v_product.default_interest_rate_bps);
    v_method   := v_product.interest_method;
    v_basis    := null;

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

  -- --- The breakdown ------------------------------------------------------
  -- One engine call either way. For an ordinary loan the arguments make
  -- `member_loan_interest` delegate straight to `calculate_loan_breakdown`,
  -- which is the function that produced every existing agreement — so this is
  -- the same arithmetic reached by one more frame, not a second engine.
  if v_basis is null then
    select pg_catalog.sum(b.interest) into v_total_interest
    from public.calculate_loan_breakdown(
      v_loan.principal_amount, v_rate_bps, v_loan.loan_term_months
    ) b;
  else
    select pg_catalog.sum(b.interest) into v_total_interest
    from public.member_loan_interest(
      v_loan.principal_amount, v_rate_bps, v_loan.loan_term_months,
      v_basis, v_method
    ) b;
  end if;

  v_total_expected := v_loan.principal_amount + v_total_interest;

  if v_basis is null then
    insert into public.loan_periods (
      loan_id, period_number, opening_principal,
      principal_portion, interest, total_obligation, closing_principal
    )
    select
      p_loan_id, b.period_number, b.opening_principal,
      b.principal_portion, b.interest, b.total_obligation, b.closing_principal
    from public.calculate_loan_breakdown(
      v_loan.principal_amount, v_rate_bps, v_loan.loan_term_months
    ) b;
  else
    insert into public.loan_periods (
      loan_id, period_number, opening_principal,
      principal_portion, interest, total_obligation, closing_principal
    )
    select
      p_loan_id, b.period_number, b.opening_principal,
      b.principal_portion, b.interest, b.total_obligation, b.closing_principal
    from public.member_loan_interest(
      v_loan.principal_amount, v_rate_bps, v_loan.loan_term_months,
      v_basis, v_method
    ) b;
  end if;

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
         interest_basis = v_basis,
         membership_id = v_membership_id,
         total_interest = v_total_interest,
         total_expected_repayment = v_total_expected,
         min_loan_amount_applied = v_product.min_amount,
         max_loan_amount_applied = v_product.max_amount,
         grace_period_days_applied = v_product.grace_period_days,
         penalty_rate_bps_applied = v_product.penalty_rate_bps
   where id = p_loan_id;

  perform public.capture_loan_product_snapshot(p_loan_id);

  -- --- Polytos Phase 3: the evidence and the pledge ----------------------
  -- After the loan is `approved`, because the pledge's own guard reads the
  -- loan's status to decide whether the capacity is live.
  if coalesce(v_product.requires_membership, false) then
    v_pledged := coalesce(v_member.pledged_savings, 0);

    insert into public.member_loan_eligibility_snapshots (
      loan_id, membership_id, membership_number, client_id,
      policy_version_id, policy_version,
      savings_account_id, savings_account_number,
      assessed_on,
      months_required, must_be_consecutive,
      qualifying_months, consecutive_qualifying_months,
      eligible_savings, multiplier_bps, max_eligible_loan,
      interest_rate_bps, interest_basis, interest_method,
      max_term_months, required_cadence,
      amount_requested, term_requested, repayment_frequency,
      active_loan_count, outstanding_principal, pledged_savings_before,
      captured_by, captured_by_label
    )
    values (
      p_loan_id, v_member.membership_id, v_member.membership_number, v_loan.client_id,
      v_member.policy_version_id, v_member.policy_version,
      v_member.savings_account_id, v_member.savings_account_number,
      v_member.as_of,
      v_member.months_required, v_member.must_be_consecutive,
      v_member.qualifying_months, v_member.consecutive_qualifying_months,
      v_member.eligible_savings, v_member.multiplier_bps, v_member.max_eligible_loan,
      v_rate_bps, v_basis, v_method,
      v_member.max_term_months, v_member.required_cadence,
      v_loan.principal_amount, v_loan.loan_term_months, v_loan.repayment_frequency,
      v_member.active_loan_count, v_member.outstanding_principal, v_pledged,
      v_actor, public.audit_actor_label()
    );

    insert into public.member_loan_savings_pledges (
      loan_id, savings_account_id, membership_id, client_id, policy_version_id,
      pledged_amount, loan_principal, multiplier_bps, eligible_savings_at_pledge,
      pledged_by, pledged_by_label
    )
    values (
      p_loan_id, v_member.savings_account_id, v_member.membership_id,
      v_loan.client_id, v_member.policy_version_id,
      (v_loan.principal_amount * 10000 + v_member.multiplier_bps - 1)
        / v_member.multiplier_bps,
      v_loan.principal_amount, v_member.multiplier_bps, v_member.eligible_savings,
      v_actor, public.audit_actor_label()
    );

    -- The invariant the whole pledge mechanism exists for, asserted inside the
    -- transaction that could break it: a member's live pledges may never
    -- exceed the savings they hold. A failure rolls the approval back.
    if public.savings_pledged_amount(v_member.savings_account_id)
         > v_member.eligible_savings then
      raise exception
        'Approving this loan would pledge % of savings against a balance of %. The member''s savings cannot secure more than they hold.',
        public.savings_pledged_amount(v_member.savings_account_id),
        v_member.eligible_savings
        using errcode = 'P0001';
    end if;
  end if;

  return p_loan_id;
end;
$$;

comment on function public.approve_loan(uuid) is
  'Phase 4, extended through Phase 13 and Polytos Phase 3. Validates, prices, computes and freezes the contractual breakdown, and snapshots the client, guarantors, identities and product. For a product requiring membership it takes the savings-capacity lock before validating, prices from the borrower''s own frozen policy version, and freezes the eligibility assessment and the savings pledge.';

revoke all on function public.approve_loan(uuid) from public, anon, authenticated;
grant execute on function public.approve_loan(uuid) to authenticated;
