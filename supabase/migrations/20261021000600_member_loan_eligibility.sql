-- ===========================================================================
-- Polytos Phase 3.5 — the member interest engine and the eligibility engine
--
-- Two things, in one migration because the second cannot be read without the
-- first: what a member loan costs, and whether a member may have one.
--
-- ===========================================================================
-- PART ONE — the interest engine
-- ===========================================================================
--
-- ## The grid, and the cell that is not defined
--
-- Undecided questions 1 and 2 are the basis and the method, and together they
-- make a 2x2 grid. Three cells are well-defined arithmetic; the fourth is not
-- a calculation anybody has described.
--
--                    | reducing_balance_monthly | flat
--   -----------------+--------------------------+--------------------------
--   per_month        | the existing engine      | 5% of the original
--                    | (delegated, not copied)  | principal, every month
--   per_loan         | **refused**              | 5% of the original
--                    |                          | principal, once, spread
--
-- `per_month` + `reducing_balance_monthly` **delegates to
-- `calculate_loan_breakdown`**. Not reimplemented, not copied: called. That is
-- what makes "all existing ordinary-loan calculation results remain
-- unchanged" structural rather than something a parity test has to keep
-- discovering — there is one reducing-balance implementation in the database
-- and this is a caller of it.
--
-- `per_loan` + `reducing_balance_monthly` is **refused with a message naming
-- what has to be settled**, following the precedent Phase 2 set for
-- `above_pledged`. A reducing-balance calculation is intrinsically per-period:
-- it charges a rate on each period's opening balance. "5% once over the loan,
-- on a reducing balance" could mean a per-period rate of 5%/term, or 5% of the
-- average outstanding balance, or 5% of the original principal — three
-- different prices, none of them stated anywhere. Picking one would be
-- inventing the price of the loan.
--
-- ## The money rules, identical to the existing engine's
--
--   * `bigint` throughout. No `numeric`, no float, no division by a
--     non-integer.
--   * Half-up by adding half the divisor before an integer division:
--     `(x * bps + 5000) / 10000`. Exactly half-up for non-negative operands.
--   * Principal split level, remainder in the **final** periods, which is the
--     `divideEvenly(..., 'last')` rule the whole system uses.
--   * Interest on a `per_loan` basis is split the same way, so the periods sum
--     to the total exactly and the final period carries the odd shilling.
--   * The principal must be fully allocated by the last period, asserted
--     rather than assumed.
--
-- ===========================================================================
-- PART TWO — the eligibility engine
-- ===========================================================================
--
-- ## What it is
--
-- One function that answers, for a client and optionally a requested amount
-- and term: may this person borrow, how much do their savings support, and if
-- not, why not. It returns a **structured result with an explicit blocking
-- reason** rather than a number with a guess in it. Where a policy value is
-- undecided, the ceiling comes back NULL and the reason names the decision —
-- never a default multiplier, because a default multiplier is an invented
-- credit limit.
--
-- ## Why savings qualification is delegated, not recomputed
--
-- `member_savings_qualification(account, as_of)` is Phase 2's and is the only
-- implementation. It already handles the Kampala month boundary, several
-- deposits in one month, reversals attributed back to the month they correct,
-- both arms of the consecutive rule, and the "as of" snapshot that a later
-- deposit cannot change. A second contribution calculator here would be the
-- same rule stated twice, and the copy that drifts is the one a member is
-- refused by.
--
-- ## The eligible savings base is the balance, not the deposits
--
-- `total_contributed` is what was paid in over the member's lifetime;
-- `balance` is what the business still holds. A member who saved UGX 600,000
-- and withdrew UGX 500,000 has UGX 100,000 securing a loan, not UGX 600,000.
-- The ceiling is therefore computed from the balance as of the assessment
-- date, which is also what makes a withdrawal between assessment and approval
-- reduce the ceiling rather than being invisible.
--
-- ## Two functions, and why the inner one is unreachable from a session
--
-- `member_loan_eligibility_of` is the assessment. It is SECURITY DEFINER with
-- **no capability check** and EXECUTE revoked from every application role, so
-- there is no path for a session to call it at all — the same arrangement
-- `generate_loan_schedule` has, and for the same reason: its only legitimate
-- callers are other privileged functions, `validate_loan_for_approval` among
-- them, which have already decided who may act.
--
-- `assess_member_loan_eligibility` is the one a screen calls. It checks
-- `member_loans:view_eligibility`, restates the branch rule the policy on
-- `memberships` states, and then delegates. The two are separate because an
-- approver holding `loans:approve` must be able to have a loan validated
-- without also holding the capability that reads a ceiling — and because a
-- capability check inside the assessment would then fire in the middle of
-- `approve_loan`.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- The interest engine
-- ---------------------------------------------------------------------------

create or replace function public.member_loan_interest(
  p_principal bigint,
  p_interest_rate_bps integer,
  p_term_months smallint,
  p_interest_basis text,
  p_interest_method text
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
  v_base           bigint;
  v_remainder      bigint;
  v_opening        bigint;
  v_portion        bigint;
  v_interest       bigint;
  v_period         smallint;
  v_total_interest bigint;
  v_int_base       bigint;
  v_int_remainder  bigint;
begin
  -- The same refusals `calculate_loan_breakdown` makes, in the same words, so
  -- a caller cannot tell the two engines apart by how they fail on bad input.
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

  -- The undecided rules, refused by name rather than defaulted. A member loan
  -- priced with a guessed basis is a member charged five times what they may
  -- have agreed to, or a fifth of it.
  if p_interest_basis is null then
    raise exception
      'Whether the member interest rate is charged per month or once over the loan has not been decided, so a member loan cannot be priced.'
      using errcode = 'P0001';
  end if;

  if p_interest_method is null then
    raise exception
      'Whether member interest is flat on the original principal or on a reducing balance has not been decided, so a member loan cannot be priced.'
      using errcode = 'P0001';
  end if;

  if p_interest_basis not in ('per_month', 'per_loan') then
    raise exception 'There is no member interest basis called %.', p_interest_basis
      using errcode = 'P0001';
  end if;

  if p_interest_method not in ('flat', 'reducing_balance_monthly') then
    raise exception 'There is no member interest method called %.', p_interest_method
      using errcode = 'P0001';
  end if;

  -- --- The delegated cell -------------------------------------------------
  -- One reducing-balance implementation in the database, and this is a caller
  -- of it. An ordinary loan and a per-month reducing-balance member loan of
  -- the same principal, rate and term produce the same figures because they
  -- are the same function, not because two functions agree.
  if p_interest_basis = 'per_month'
     and p_interest_method = 'reducing_balance_monthly' then
    return query
      select b.period_number, b.opening_principal, b.principal_portion,
             b.interest, b.total_obligation, b.closing_principal
      from public.calculate_loan_breakdown(
             p_principal, p_interest_rate_bps, p_term_months
           ) b;
    return;
  end if;

  -- --- The cell nobody has defined ----------------------------------------
  if p_interest_basis = 'per_loan'
     and p_interest_method = 'reducing_balance_monthly' then
    raise exception
      'A rate charged once over the loan on a reducing balance is not a calculation the business has described. A reducing-balance method charges a rate on each period''s opening balance, so "once over the loan" could mean the rate divided by the term, the rate applied to the average outstanding balance, or the rate applied to the original principal — three different prices. The client must settle which, or choose the flat method.'
      using errcode = 'P0001';
  end if;

  -- --- Flat, on either basis ---------------------------------------------
  -- Level principal portions with the remainder in the final periods, which
  -- is the rule every allocation in this system uses.
  v_base := p_principal / p_term_months;
  v_remainder := p_principal % p_term_months;

  if p_interest_basis = 'per_loan' then
    -- Charged once, on the original principal, and spread across the periods
    -- the same way the principal is — so the periods sum to the total exactly
    -- and the final period carries the odd shilling.
    v_total_interest := (p_principal * p_interest_rate_bps + 5000) / 10000;
    v_int_base := v_total_interest / p_term_months;
    v_int_remainder := v_total_interest % p_term_months;
  else
    -- Charged every month, on the original principal — which is what makes it
    -- flat rather than reducing. No division, so no remainder.
    v_total_interest := null;
    v_int_base := (p_principal * p_interest_rate_bps + 5000) / 10000;
    v_int_remainder := 0;
  end if;

  v_opening := p_principal;

  for v_period in 1..p_term_months loop
    v_portion := v_base + (
      case when v_period > p_term_months - v_remainder then 1 else 0 end
    );

    v_interest := v_int_base + (
      case when v_period > p_term_months - v_int_remainder then 1 else 0 end
    );

    period_number     := v_period;
    opening_principal := v_opening;
    principal_portion := v_portion;
    interest          := v_interest;
    total_obligation  := v_portion + v_interest;
    closing_principal := v_opening - v_portion;

    return next;

    v_opening := v_opening - v_portion;
  end loop;

  if v_opening <> 0 then
    raise exception
      'Loan breakdown did not fully allocate the principal; % remains.', v_opening
      using errcode = 'P0001';
  end if;

  return;
end;
$$;

comment on function public.member_loan_interest(bigint, integer, smallint, text, text) is
  'Polytos Phase 3. The authoritative member loan breakdown for a configured interest basis and method. per_month + reducing_balance_monthly delegates to calculate_loan_breakdown, so there is one reducing-balance implementation; per_loan + reducing_balance_monthly is refused as undefined; both flat arms are computed here. Integer arithmetic, half-up rounding, remainder in the final periods.';

revoke all on function public.member_loan_interest(bigint, integer, smallint, text, text)
  from public, anon, authenticated;
-- Readable by any signed-in user: a pure function of its arguments that
-- discloses nothing, exactly as `calculate_loan_breakdown` is. The application
-- preview calls it so staff see the authoritative figures.
grant execute on function public.member_loan_interest(bigint, integer, smallint, text, text)
  to authenticated;

-- ---------------------------------------------------------------------------
-- The permitted cadence for a member loan term
--
-- The confirmed rule: weekly collection for member loans up to
-- `member_loan_weekly_cadence_max_months` (2), calendar-monthly for longer.
-- One function, so the application form, the validator and the tests all read
-- the same sentence.
-- ---------------------------------------------------------------------------

create or replace function public.member_loan_cadence_for_term(
  p_version_id uuid,
  p_term_months smallint
)
returns text
language sql
stable
set search_path = ''
as $$
  select case
           when p_term_months is null then null
           when p_term_months <= v.member_loan_weekly_cadence_max_months then 'weekly'
           else 'monthly'
         end
  from public.membership_policy_versions v
  where v.id = p_version_id;
$$;

comment on function public.member_loan_cadence_for_term(uuid, smallint) is
  'Polytos Phase 3. Which collection cadence a member loan of this term must use under a policy version: weekly up to the version''s weekly boundary, calendar-monthly beyond it.';

revoke all on function public.member_loan_cadence_for_term(uuid, smallint)
  from public, anon, authenticated;
grant execute on function public.member_loan_cadence_for_term(uuid, smallint) to authenticated;

-- ---------------------------------------------------------------------------
-- The assessment
--
-- Reached only from another privileged function. See the head of this file.
-- ---------------------------------------------------------------------------

create or replace function public.member_loan_eligibility_of(
  p_client_id uuid,
  p_amount bigint default null,
  p_term_months smallint default null,
  p_repayment_frequency text default null,
  p_as_of date default null
)
returns table (
  client_id uuid,
  membership_id uuid,
  membership_number text,
  membership_status text,
  policy_version_id uuid,
  policy_version text,
  as_of date,
  savings_account_id uuid,
  savings_account_number text,
  savings_account_status text,
  months_required smallint,
  must_be_consecutive boolean,
  qualifying_months integer,
  consecutive_qualifying_months integer,
  savings_qualifies boolean,
  eligible_savings bigint,
  multiplier_bps integer,
  max_eligible_loan bigint,
  max_term_months smallint,
  required_cadence text,
  active_loan_count integer,
  active_loan_limit integer,
  outstanding_principal bigint,
  pledged_savings bigint,
  amount_requested bigint,
  term_requested smallint,
  is_eligible boolean,
  may_proceed boolean,
  blocking_reasons text[]
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_membership public.memberships;
  v_policy     public.membership_policy_versions;
  v_account    public.savings_accounts;
  v_settings   public.business_settings;
  v_qual       record;
  v_reasons    text[] := '{}';
  v_product    public.loan_products;
begin
  as_of := coalesce(p_as_of, public.business_date());
  client_id := p_client_id;
  amount_requested := p_amount;
  term_requested := p_term_months;
  is_eligible := false;
  may_proceed := false;

  select * into v_settings from public.business_settings where id = 1;

  if not found then
    blocking_reasons := array['Business settings have not been configured.'];
    return next;
    return;
  end if;

  active_loan_limit := v_settings.max_active_loans_per_client;

  -- --- Is there a client at all ------------------------------------------
  if p_client_id is null
     or not exists (select 1 from public.clients c where c.id = p_client_id) then
    blocking_reasons := array['There is no such client.'];
    return next;
    return;
  end if;

  -- --- Is there a live membership ----------------------------------------
  -- The partial unique index on `memberships` guarantees at most one row in
  -- pending/active/suspended, so this is a single row by construction rather
  -- than by `limit 1`.
  select * into v_membership
  from public.memberships m
  where m.client_id = p_client_id
    and m.status in ('pending', 'active', 'suspended');

  if not found then
    blocking_reasons :=
      array['This client is not a member of the savings programme, so they cannot take a member loan. An ordinary loan product is unaffected.'];
    return next;
    return;
  end if;

  membership_id := v_membership.id;
  membership_number := v_membership.membership_number;
  membership_status := v_membership.status;
  policy_version_id := v_membership.policy_version_id;

  select * into v_policy
  from public.membership_policy_versions
  where id = v_membership.policy_version_id;

  policy_version := v_policy.version;
  months_required := v_policy.savings_qualifying_months;
  must_be_consecutive := v_policy.qualifying_months_consecutive;
  multiplier_bps := v_policy.savings_to_loan_multiplier_bps;
  max_term_months := v_policy.member_loan_max_term_months;
  required_cadence := public.member_loan_cadence_for_term(
    v_membership.policy_version_id, p_term_months
  );

  -- --- The membership's own standing -------------------------------------
  if v_membership.status = 'pending' then
    v_reasons := v_reasons
      || 'This membership has not been activated: the registration fee and a verified acceptance of the member''s own terms are both required first.';
  elsif v_membership.status = 'suspended' then
    v_reasons := v_reasons
      || ('This membership is suspended'
          || coalesce(' — ' || v_membership.status_reason, '') || '.');
  end if;

  -- --- Is member lending open under *this member's* version --------------
  -- Their frozen version, not the programme as it stands. A member on a
  -- superseded version is authorised for nothing, and a member on a version
  -- whose lending decisions are open cannot borrow however long they have
  -- saved.
  if not public.membership_policy_allows(v_membership.policy_version_id, 'lending') then
    v_reasons := v_reasons
      || ('Member lending is not open under policy version '
          || coalesce(v_policy.version, '(unknown)')
          || '. ' || public.member_lending_blocked_reason(v_membership.policy_version_id));
  end if;

  -- --- The savings account -----------------------------------------------
  -- Aliased, because `membership_id` is also an OUT parameter of this
  -- function and an unqualified reference would be ambiguous.
  select sa.* into v_account
  from public.savings_accounts sa
  where sa.membership_id = v_membership.id;

  if not found then
    v_reasons := v_reasons
      || 'This member has no savings account, so there is no qualifying history and nothing securing a loan.';
  else
    savings_account_id := v_account.id;
    savings_account_number := v_account.account_number;
    savings_account_status := v_account.status;

    if v_account.status <> 'active' then
      v_reasons := v_reasons
        || ('This savings account is ' || v_account.status
            || coalesce(' — ' || v_account.status_reason, '') || '.');
    end if;

    -- Phase 2's calculation, as of the assessment date. The only one.
    select * into v_qual
    from public.member_savings_qualification(v_account.id, as_of);

    qualifying_months := v_qual.qualifying_months;
    consecutive_qualifying_months := v_qual.longest_consecutive_months;
    savings_qualifies := v_qual.qualifies;
    -- The balance, not the lifetime deposits: a withdrawal reduces what
    -- secures a loan.
    eligible_savings := v_qual.balance;

    if not v_qual.qualifies then
      v_reasons := v_reasons
        || coalesce(v_qual.blocked_reason, 'The savings qualifying period has not been served.');
    end if;
  end if;

  -- --- The ceiling, where there is one ------------------------------------
  -- NULL, not a guess, while the multiplier is undecided. The reason is
  -- already in `v_reasons` by way of the lending gate; stating a number here
  -- would be inventing the member's credit limit.
  if multiplier_bps is not null and eligible_savings is not null then
    max_eligible_loan := (eligible_savings * multiplier_bps + 5000) / 10000;

    -- The business's own bounds still apply. The multiplier decides how much a
    -- member's savings support; it does not exempt them from what the business
    -- lends at all.
    select * into v_product
    from public.loan_products
    where product_code = 'ML';

    if v_product.id is not null then
      max_eligible_loan := least(max_eligible_loan, v_product.max_amount);
    end if;

    max_eligible_loan := least(
      max_eligible_loan, v_settings.max_loan_amount
    );
  end if;

  -- --- Existing obligations ----------------------------------------------
  select pg_catalog.count(*)::integer
    into active_loan_count
  from public.loans l
  where l.client_id = p_client_id and l.status = 'active';

  select coalesce(pg_catalog.sum(b.principal_remaining), 0)::bigint
    into outstanding_principal
  from public.loan_balances b
  join public.loans l on l.id = b.loan_id
  where l.client_id = p_client_id and l.status = 'active';

  if active_loan_count >= v_settings.max_active_loans_per_client then
    v_reasons := v_reasons
      || ('This client already has ' || active_loan_count
          || ' active loan(s), and the business permits '
          || v_settings.max_active_loans_per_client
          || ' at a time. An existing ordinary loan is not converted or repriced by membership; it has to run its course.');
  end if;

  -- --- Savings already pledged -------------------------------------------
  -- Zero until a multiplier exists, because nothing can be pledged against a
  -- limit nobody has set. See 20261021000800.
  if savings_account_id is not null then
    pledged_savings := public.savings_pledged_amount(savings_account_id, as_of);
  end if;

  -- --- Eligibility, before the request ------------------------------------
  is_eligible := pg_catalog.cardinality(v_reasons) = 0;

  -- --- The request itself -------------------------------------------------
  if p_amount is not null then
    if p_amount <= 0 then
      v_reasons := v_reasons || 'A loan amount must be a positive number of shillings.';
    else
      if max_eligible_loan is not null and p_amount > max_eligible_loan then
        v_reasons := v_reasons
          || ('The requested ' || p_amount || ' exceeds the '
              || max_eligible_loan || ' this member''s savings support.');
      end if;

      if p_amount < v_settings.min_loan_amount then
        v_reasons := v_reasons
          || ('The business lends from ' || v_settings.min_loan_amount || '.');
      end if;
    end if;
  end if;

  if p_term_months is not null then
    if p_term_months < 1 then
      v_reasons := v_reasons || 'A loan term must be at least one month.';
    elsif p_term_months > v_policy.member_loan_max_term_months then
      v_reasons := v_reasons
        || ('A member loan runs for at most '
            || v_policy.member_loan_max_term_months || ' months; '
            || p_term_months || ' was requested.');
    end if;

    if p_term_months > 1
       and p_amount is not null
       and p_amount < v_settings.multi_month_min_amount then
      v_reasons := v_reasons
        || ('A loan of more than one month requires at least '
            || v_settings.multi_month_min_amount || '.');
    end if;
  end if;

  if p_repayment_frequency is not null
     and required_cadence is not null
     and p_repayment_frequency <> required_cadence then
    v_reasons := v_reasons
      || ('A ' || p_term_months || '-month member loan is collected '
          || required_cadence || ', not ' || p_repayment_frequency || '.');
  end if;

  if p_repayment_frequency is not null
     and not exists (
       select 1 from public.repayment_frequencies rf
       where rf.key = p_repayment_frequency and rf.is_active
     ) then
    v_reasons := v_reasons
      || ('The ' || p_repayment_frequency
          || ' collection cadence is not available. A calendar-monthly cadence stays unavailable until the business decides what a monthly collection does in a month that has no such day.');
  end if;

  blocking_reasons := v_reasons;
  may_proceed := pg_catalog.cardinality(v_reasons) = 0
    and p_amount is not null
    and p_term_months is not null;

  return next;
end;
$$;

comment on function public.member_loan_eligibility_of(uuid, bigint, smallint, text, date) is
  'Polytos Phase 3. Whether a client may take a member loan, the savings evidence behind the answer, and the ceiling their savings support — as of a date, so a later deposit cannot change what was true then. Returns explicit blocking reasons and a NULL ceiling where a policy value is undecided, never a default. Not callable by a session: see the migration head.';

revoke all on function public.member_loan_eligibility_of(uuid, bigint, smallint, text, date)
  from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Why member lending is shut, as a sentence
--
-- `membership_policy_allows(v, 'lending')` answers yes or no. A screen that
-- can only say no is a screen somebody has to come and ask about, so this
-- names the decision — the same job `activityBlockedReason()` does in
-- TypeScript, which a database test asserts agrees with this.
-- ---------------------------------------------------------------------------

create or replace function public.member_lending_blocked_reason(p_version_id uuid)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v public.membership_policy_versions;
  v_missing text[] := '{}';
begin
  select * into v from public.membership_policy_versions where id = p_version_id;

  if not found then
    return 'There is no such membership policy version.';
  end if;

  if v.status = 'superseded' then
    return 'Policy version ' || v.version
      || ' has been superseded, so it authorises nothing. The member has to be moved onto the current terms by a recorded re-acceptance.';
  end if;

  if v.status = 'draft' then
    v_missing := v_missing || 'the version is still a draft';
  end if;

  if v.approved_at is null then
    v_missing := v_missing || 'nobody has approved it';
  end if;

  if v.effective_from > public.business_date() then
    v_missing := v_missing || ('it does not take effect until ' || v.effective_from);
  end if;

  if v.interest_basis is null then
    v_missing := v_missing
      || 'whether the 5% is charged per month or once over the loan is undecided';
  end if;

  if v.interest_method is null then
    v_missing := v_missing
      || 'whether member interest is flat or on a reducing balance is undecided';
  end if;

  if v.savings_to_loan_multiplier_bps is null then
    v_missing := v_missing
      || 'the multiple of savings a member may borrow is undecided';
  end if;

  if v.qualifying_months_consecutive is null then
    v_missing := v_missing
      || 'whether the qualifying months must be consecutive is undecided';
  end if;

  if v.savings_withdrawal_with_active_loan is null then
    v_missing := v_missing
      || 'whether savings may be withdrawn against a live member loan is undecided';
  end if;

  if pg_catalog.cardinality(v_missing) = 0 then
    return 'Member lending is open under this version.';
  end if;

  return 'Member lending is held up because '
    || pg_catalog.array_to_string(v_missing, '; ') || '.';
end;
$$;

comment on function public.member_lending_blocked_reason(uuid) is
  'Polytos Phase 3. Why member lending is not open under a policy version, naming each decision that is missing rather than only refusing.';

revoke all on function public.member_lending_blocked_reason(uuid) from public, anon;
grant execute on function public.member_lending_blocked_reason(uuid) to authenticated;
