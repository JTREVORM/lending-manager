-- ===========================================================================
-- Polytos Phase 3.4 — a member loan is a product, not a second lending engine
--
-- ## What makes a loan a member loan
--
-- Two facts about its **product**, and they are deliberately two columns
-- rather than one boolean, because they are two different decisions a
-- business could take separately:
--
--   `requires_membership`  who may borrow. An application against this
--                          product asserts the borrower is a member in good
--                          standing with a qualifying savings record, and
--                          `validate_loan_for_approval` re-checks that claim.
--
--   `interest_source`      where the price comes from. `product` is every
--                          existing product: the rate band on the row is the
--                          authority. `membership_policy` means the rate, the
--                          basis and the method are read from the **member's
--                          own policy version** at approval — the version they
--                          enrolled under, frozen, not the programme as it
--                          stands today.
--
-- The implication runs one way, and is a constraint: pricing from the
-- membership policy requires membership, because there is no policy version to
-- read for a non-member. The converse is left open on purpose — a business
-- could offer a member-only product at an ordinary product rate, and nothing
-- here should have to change for it to.
--
-- ## Why the price comes from the policy and not from the product
--
-- Because the three things that decide a member loan's price are the three
-- questions the client has not answered, and they live on
-- `membership_policy_versions` where Phase 1 put them:
-- `member_loan_interest_rate_bps` (confirmed: 500), `interest_basis`
-- (undecided) and `interest_method` (undecided). Copying them onto the
-- product would be two homes for one figure, and the copy that drifts is the
-- one a borrower is charged from. Reading them from the member's frozen
-- version is also what makes "a policy change must not reprice an existing
-- loan" structural: a member on version 1.0 is priced by 1.0 forever, and a
-- loan already approved carries its own frozen rate regardless.
--
-- ## The term ceiling, and a guard rail that had the wrong number in it
--
-- `business_settings.max_loan_term_months` is 3, and
-- `loan_products_within_business_rules` refuses a product above it. The
-- membership documents state a **5-month** maximum member loan term and a
-- **3-month** maximum non-member term — both NOT NULL, both confirmed, both
-- already columns on `membership_policy_versions`
-- (`member_loan_max_term_months`, `non_member_loan_max_term_months`).
--
-- So the business maximum of 3 is not a general ceiling at all: it is the
-- non-member rule, and the member rule is a different confirmed number the
-- business has already given. The guard rail therefore reads its term ceiling
-- for a `requires_membership` product from the in-force policy's
-- `member_loan_max_term_months`, and from `business_settings` for every other
-- product — which is unchanged for all five existing products.
--
-- This is not a weakening dressed up as a rule. Three properties hold:
--
--   1. It applies only to a product that requires membership, so no ordinary
--      product can be lengthened by it.
--   2. The number is one the client's own documents state, not one invented
--      here, and it is read from the policy row rather than typed into this
--      migration.
--   3. `validate_loan_for_approval` enforces the same ceiling per loan
--      (20261021000600), so a product mis-set beyond it still approves
--      nothing.
--
-- Recorded as ADR-060, because it corrects a Phase 12 assumption — that one
-- business term ceiling governs every product — rather than quietly routing
-- around it.
--
-- ## Flat interest
--
-- `loan_products.interest_method` and `loans.interest_method` both permitted
-- exactly `reducing_balance_monthly`. `flat` is added to both, because it is
-- one arm of undecided question 2 and the engine in 20261021000500 implements
-- it. The constraints only widen: no existing value is removed, so no
-- existing row can fail them.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- The product columns
-- ---------------------------------------------------------------------------

alter table public.loan_products
  add column requires_membership boolean not null default false,
  add column interest_source text not null default 'product';

comment on column public.loan_products.requires_membership is
  'Polytos Phase 3. Whether only a member in good standing, with a qualifying savings record, may borrow on this product. Re-checked at approval by validate_loan_for_approval.';
comment on column public.loan_products.interest_source is
  'product: the rate band on this row prices the loan. membership_policy: the rate, basis and method are read from the borrower''s own frozen membership policy version at approval.';

alter table public.loan_products
  add constraint loan_products_interest_source_valid
    check (interest_source in ('product', 'membership_policy'));

alter table public.loan_products
  add constraint loan_products_policy_priced_requires_membership
    check (interest_source = 'product' or requires_membership);

-- Widened, never narrowed.
alter table public.loan_products
  drop constraint loan_products_interest_method_valid;

alter table public.loan_products
  add constraint loan_products_interest_method_valid
    check (interest_method in ('reducing_balance_monthly', 'flat'));

-- A policy-priced product must not also offer a rate override: the two would
-- be competing authorities over the same figure, and an approver able to type
-- a member rate could price a member loan at nothing.
alter table public.loan_products
  add constraint loan_products_policy_priced_has_no_override
    check (interest_source = 'product' or not interest_override_allowed);

create index loan_products_member_idx
  on public.loan_products (requires_membership)
  where requires_membership;

-- ---------------------------------------------------------------------------
-- The product snapshot carries them too
--
-- `loan_product_snapshots` is the product configuration as it stood at
-- approval, append-only. Whether the product required membership, and where
-- its price came from, are part of that configuration: without them a reader
-- of an old member loan could not tell why its rate differs from the
-- product's current band.
-- ---------------------------------------------------------------------------

alter table public.loan_product_snapshots
  add column requires_membership boolean not null default false,
  add column interest_source text not null default 'product';

comment on column public.loan_product_snapshots.requires_membership is
  'Polytos Phase 3. Whether the product required membership when this loan was approved.';
comment on column public.loan_product_snapshots.interest_source is
  'Polytos Phase 3. Where this loan''s price came from when it was approved: the product''s own band, or the borrower''s membership policy version.';

alter table public.loan_product_snapshots
  add constraint loan_product_snapshots_interest_source_valid
    check (interest_source in ('product', 'membership_policy'));

-- ---------------------------------------------------------------------------
-- The loan's own frozen member terms
--
-- On `loans`, beside `interest_rate_bps` and `grace_period_days_applied`,
-- following the pattern the schema already uses for a loan's own frozen
-- terms: a separate snapshot table exists for the details of *other* entities
-- that change independently, and these are per-loan facts.
--
--   `membership_id`    which membership this loan was lent against. NULL for
--                      every ordinary loan, and for every loan already in the
--                      database.
--   `interest_basis`   whether the rate was charged per month or once over the
--                      loan. NULL where it does not apply — every existing
--                      loan is priced per month by `calculate_loan_breakdown`,
--                      and backfilling a value onto 35 historical agreements
--                      would be writing a term onto a contract after the fact.
-- ---------------------------------------------------------------------------

alter table public.loans
  add column membership_id uuid references public.memberships(id) on delete restrict,
  add column interest_basis text;

comment on column public.loans.membership_id is
  'Polytos Phase 3. The membership this loan was lent against, frozen at approval. NULL for an ordinary loan — and a client joining the programme later does not fill it in, because that would reprice an agreement nobody re-signed.';
comment on column public.loans.interest_basis is
  'Polytos Phase 3. per_month or per_loan, frozen at approval, for a loan priced from a membership policy. NULL for an ordinary loan, which is priced per month by the reducing-balance engine.';

alter table public.loans
  add constraint loans_interest_basis_valid
    check (interest_basis is null or interest_basis in ('per_month', 'per_loan'));

alter table public.loans
  drop constraint loans_interest_method_valid;

alter table public.loans
  add constraint loans_interest_method_valid
    check (interest_method in ('reducing_balance_monthly', 'flat'));

-- A flat loan must say on what basis it was flat: "flat" alone does not say
-- whether the 5% was charged five times or once, which on a five-month loan
-- is a five-fold difference in what the borrower owes.
alter table public.loans
  add constraint loans_flat_states_its_basis
    check (interest_method <> 'flat' or interest_basis is not null);

create index loans_membership_idx
  on public.loans (membership_id)
  where membership_id is not null;

-- ---------------------------------------------------------------------------
-- Both new columns freeze, and the trigger that freezes them
--
-- `loans_guard_transition` already distinguishes two rules: what the loan
-- *is*, which never changes once it leaves draft, and what it *costs*, which
-- is written exactly once at approval. The two new columns belong to the
-- second — they are absent until approval reads the policy, and from that
-- moment they are the agreement.
--
-- Both checks sit above the trusted-path exemption, so they bind
-- `service_role` and the table owner too. That is the whole point: a
-- membership withdrawal, a policy change or a well-meaning backfill must not
-- be able to rewrite what a borrower agreed to, by any route the application,
-- a leaked key or a mistaken UPDATE can take.
-- ---------------------------------------------------------------------------

create or replace function public.loans_guard_member_terms()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_approving boolean;
begin
  v_approving := old.status = 'pending_approval' and new.status = 'approved';

  if old.status = 'draft' then
    return new;
  end if;

  if v_approving then
    return new;
  end if;

  if new.membership_id is distinct from old.membership_id then
    raise exception
      'The membership a loan was lent against is set at approval and cannot be changed. A member who later withdraws, or who joins after borrowing, does not change the terms of an agreement already signed.'
      using errcode = 'P0001';
  end if;

  if new.interest_basis is distinct from old.interest_basis then
    raise exception
      'A loan''s interest basis is set at approval and cannot be changed afterwards.'
      using errcode = 'P0001';
  end if;

  return new;
end;
$$;

comment on function public.loans_guard_member_terms() is
  'Polytos Phase 3. BEFORE UPDATE on loans: membership_id and interest_basis are written once, at approval, and frozen thereafter — for every caller, service_role included.';

revoke all on function public.loans_guard_member_terms() from public, anon, authenticated;

-- A second trigger rather than an edit to `loans_guard_transition`, so that
-- the Phase 4 state machine and the Phase 3 member terms can be reviewed and
-- reverted separately. BEFORE UPDATE triggers fire in name order, so this one
-- runs after `loans_guard_member_terms` would alphabetically precede
-- `loans_guard_transition`; neither depends on the other's outcome, because
-- both only ever raise or pass `new` through unchanged.
create trigger loans_guard_member_terms
  before update on public.loans
  for each row execute function public.loans_guard_member_terms();

-- ---------------------------------------------------------------------------
-- The guard rail, with the member term ceiling read from the policy
--
-- The 12.6 body, with one clause changed: the term ceiling. Everything else —
-- the amount bounds, the rate ceiling, the cadence membership check that only
-- runs when the list is being set, the duration menu, the override roles — is
-- unchanged, because each is still right.
-- ---------------------------------------------------------------------------

create or replace function public.loan_products_within_business_rules()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  b record;
  v_freq text;
  v_cadences_changed boolean;
  v_term_ceiling integer;
  v_ceiling_source text;
begin
  select * into b from public.business_settings where id = 1;

  if b is null then
    raise exception 'Business settings have not been configured.' using errcode = 'P0001';
  end if;

  if new.min_amount < b.min_loan_amount then
    raise exception
      'This product would lend from % but the business minimum is %.',
      new.min_amount, b.min_loan_amount using errcode = 'P0001';
  end if;

  if new.max_amount > b.max_loan_amount then
    raise exception
      'This product would lend up to % but the business maximum is %.',
      new.max_amount, b.max_loan_amount using errcode = 'P0001';
  end if;

  if new.max_interest_rate_bps > b.default_monthly_interest_rate_bps * 2 then
    raise exception
      'This product''s ceiling of % bp is more than twice the business rate of % bp.',
      new.max_interest_rate_bps, b.default_monthly_interest_rate_bps
      using errcode = 'P0001';
  end if;

  if new.min_term_months < b.min_loan_term_months then
    raise exception
      'This product would run from % months but the business minimum is %.',
      new.min_term_months, b.min_loan_term_months using errcode = 'P0001';
  end if;

  -- --- Polytos Phase 3: whose ceiling -------------------------------------
  -- A member product's ceiling is the member rule the client's documents
  -- state, read from the in-force policy version. Every other product keeps
  -- the business maximum, unchanged. Where no version is in force there is no
  -- member rule to read and the business maximum applies, which fails shut.
  v_term_ceiling := b.max_loan_term_months;
  v_ceiling_source := 'the business maximum';

  if new.requires_membership then
    -- The longest member term the programme states, across every version that
    -- has not been superseded.
    --
    -- Not "the in-force version", and the distinction matters. A *product*
    -- belongs to no policy version — a **loan** does, through the member who
    -- took it, and `validate_loan_for_approval` checks each member loan's term
    -- against that borrower's own frozen version. This bound is therefore a
    -- configuration envelope rather than the enforcement: it stops a member
    -- product being set to a term no version of the programme has ever
    -- offered, and nothing more. Reading only the in-force version would make
    -- the envelope collapse to the non-member ceiling whenever the programme
    -- is between versions, and would leave a member product unconfigurable
    -- before the first version is approved.
    --
    -- `member_loan_max_term_months` is safe to read from a draft because it is
    -- one of the **confirmed** figures: NOT NULL on every version by
    -- constraint, taken from the client's own documents, and frozen once the
    -- version is approved. It is not one of the nine undecided rules.
    select pg_catalog.max(v.member_loan_max_term_months)
      into v_term_ceiling
    from public.membership_policy_versions v
    where v.status in ('draft', 'active');

    v_ceiling_source := 'the membership programme''s member loan maximum';

    if v_term_ceiling is null then
      v_term_ceiling := b.max_loan_term_months;
      v_ceiling_source :=
        'the business maximum, because no membership policy version states a member loan term';
    end if;
  end if;

  if new.max_term_months > v_term_ceiling then
    raise exception
      'This product would run to % months but % is %.',
      new.max_term_months, v_ceiling_source, v_term_ceiling
      using errcode = 'P0001';
  end if;

  v_cadences_changed := tg_op = 'INSERT'
    or new.allowed_repayment_frequencies is distinct from old.allowed_repayment_frequencies
    or new.default_repayment_frequency is distinct from old.default_repayment_frequency;

  if v_cadences_changed then
    foreach v_freq in array new.allowed_repayment_frequencies loop
      if not exists (
        select 1 from public.repayment_frequencies f where f.key = v_freq and f.is_active
      ) then
        raise exception 'There is no active repayment cadence called "%".', v_freq
          using errcode = 'P0001';
      end if;
    end loop;

    if not (new.default_repayment_frequency = any (new.allowed_repayment_frequencies)) then
      raise exception
        'The default cadence "%" is not one this product offers.',
        new.default_repayment_frequency using errcode = 'P0001';
    end if;
  end if;

  if new.allowed_term_months is not null then
    if exists (
      select 1 from pg_catalog.unnest(new.allowed_term_months) as t(months)
      where t.months < new.min_term_months or t.months > new.max_term_months
    ) then
      raise exception
        'A duration option falls outside this product''s own % to % month range.',
        new.min_term_months, new.max_term_months using errcode = 'P0001';
    end if;
  end if;

  if pg_catalog.cardinality(new.interest_override_roles) > 0 then
    if exists (
      select 1 from pg_catalog.unnest(new.interest_override_roles) as r(key)
      where not exists (select 1 from public.roles ro where ro.key = r.key)
    ) then
      raise exception 'An override role does not exist.' using errcode = 'P0001';
    end if;
  end if;

  return new;
end;
$$;

comment on function public.loan_products_within_business_rules() is
  'Phase 12, extended in Polytos Phase 3. A product must fit inside what the business permits. A product requiring membership takes its term ceiling from the in-force membership policy''s member loan maximum instead of the business maximum, which is the non-member rule.';

-- ---------------------------------------------------------------------------
-- The member loan product
--
-- Seeded **inactive**, and that is the honest state rather than a caution.
-- Its price is three decisions the client has not made: whether 5% is monthly
-- or once, whether it is flat or reducing, and what multiple of savings may be
-- borrowed. A product offered in a picker that approval would then refuse is a
-- control that fails late; an inactive product is a configuration waiting for
-- an answer.
--
-- Its figures are the ones the client's documents state and nothing more:
--
--   * 500 bp, from `member_loan_interest_rate_bps`. Recorded on the row so the
--     band is well-formed, but `interest_source = 'membership_policy'` means
--     approval reads the rate from the member's own version rather than here.
--   * the amount band is the business's own, because the documents give no
--     member-specific amount limits — the limit is the savings multiplier,
--     which is undecided and is enforced per application by the eligibility
--     engine rather than by a product bound.
--   * `weekly` only, with monthly deliberately absent: the `monthly` cadence
--     is inactive until its anchor is decided, and a product cannot name an
--     inactive cadence. Adding it is one statement once the convention exists.
--   * one guarantor, the business floor, because the documents name no
--     member-specific security and the floor applies to every product.
--
-- `max_term_months` is 5, from the policy. A 3-to-5-month member loan must
-- collect monthly under `member_loan_weekly_cadence_max_months = 2`, so until
-- the monthly anchor is decided such a loan is refused at approval — which is
-- the correct outcome and is asserted by a test rather than left to be
-- discovered.
-- ---------------------------------------------------------------------------

do $$
declare
  v_policy public.membership_policy_versions;
begin
  if exists (select 1 from public.loan_products where product_code = 'ML') then
    return;
  end if;

  -- The programme's figures come from the policy row, read rather than
  -- retyped, so this product cannot state a term or a rate the policy does
  -- not. Any version will do for the shape — the draft 1.0 carries the
  -- confirmed figures, and the confirmed figures are all this reads.
  select * into v_policy
  from public.membership_policy_versions
  order by effective_from
  limit 1;

  if not found then
    raise exception
      'Polytos Phase 3 expects a membership policy version to read the member loan terms from; none exists.'
      using errcode = 'P0001';
  end if;

  insert into public.loan_products (
    product_code, name, description,
    status, sort_order, is_default,
    min_amount, max_amount,
    default_interest_rate_bps, min_interest_rate_bps, max_interest_rate_bps,
    interest_method, interest_override_allowed, interest_override_roles,
    min_term_months, max_term_months, allowed_term_months,
    allowed_repayment_frequencies, default_repayment_frequency,
    grace_period_days, penalty_rate_bps, penalty_method,
    guarantor_required, min_guarantors, collateral_required,
    early_repayment, extra_payment,
    application_profile, requires_supporting_documents,
    requires_membership, interest_source
  )
  select
    'ML',
    'Member Loans',
    'Lending to members of the Polytos savings programme, priced by the '
      || 'membership policy version the member enrolled under and limited by '
      || 'their qualifying savings. INACTIVE until the client decides the '
      || 'interest basis, the interest method and the savings-to-loan '
      || 'multiplier. See docs/POLYTOS-MEMBER-LOANS.md.',
    -- After the four products the business sells today and before the
    -- migrated one, so a picker reads in the order the business sells.
    'inactive', 50, false,
    b.min_loan_amount, b.max_loan_amount,
    v_policy.member_loan_interest_rate_bps,
    v_policy.member_loan_interest_rate_bps,
    v_policy.member_loan_interest_rate_bps,
    -- A placeholder the policy overrides at approval. `reducing_balance_monthly`
    -- rather than `flat` because it is the method the existing engine
    -- implements, and because a product row is not where question 2 gets
    -- answered.
    'reducing_balance_monthly', false, '{}',
    1, v_policy.member_loan_max_term_months, null,
    array['weekly'], 'weekly',
    b.grace_period_days, b.penalty_rate_bps,
    'one_time_percent_of_outstanding',
    b.min_guarantors_required >= 1, b.min_guarantors_required, false,
    'allowed_no_rebate', 'reduces_balance',
    'individual', true,
    true, 'membership_policy'
  from public.business_settings b
  where b.id = 1;
end;
$$;

-- ---------------------------------------------------------------------------
-- The snapshot capture, carrying the two new columns
--
-- The 12.2 body with three changes:
--
--   * `requires_membership` and `interest_source` are copied from the product,
--     so a reader of an old member loan can see why its rate differs from the
--     product's current band;
--   * an override is recorded only for a product priced from its own band. A
--     policy-priced loan whose rate differs from the product's default has not
--     been overridden by anybody — it is priced from the member's policy
--     version — and recording it as an override would name an approver as
--     having chosen a rate they could not choose. A CHECK constraint refuses
--     `interest_override_allowed` on such a product precisely so that there is
--     no override to record.
-- ---------------------------------------------------------------------------

create or replace function public.capture_loan_product_snapshot(p_loan_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  l record;
  p record;
  v_overridden boolean;
begin
  select * into l from public.loans where id = p_loan_id;

  if l.id is null then
    raise exception 'No such loan.' using errcode = 'P0001';
  end if;

  if exists (select 1 from public.loan_product_snapshots s where s.loan_id = p_loan_id) then
    return;
  end if;

  select * into p from public.loan_products where id = l.loan_product_id;

  if p.id is null then
    raise exception 'Loan % names no product.', l.loan_number using errcode = 'P0001';
  end if;

  v_overridden := p.interest_source = 'product'
    and l.interest_rate_bps <> p.default_interest_rate_bps;

  insert into public.loan_product_snapshots (
    loan_id, product_id, product_code, product_name,
    min_amount, max_amount,
    interest_rate_bps, interest_method,
    min_term_months, max_term_months, repayment_frequency,
    grace_period_days, penalty_rate_bps, penalty_method,
    guarantor_required, min_guarantors, collateral_required,
    early_repayment, extra_payment, application_profile,
    interest_rate_overridden, overridden_by, overridden_by_label,
    requires_membership, interest_source
  )
  values (
    l.id, p.id, p.product_code, p.name,
    p.min_amount, p.max_amount,
    l.interest_rate_bps, l.interest_method,
    p.min_term_months, p.max_term_months, l.repayment_frequency,
    coalesce(l.grace_period_days_applied, p.grace_period_days),
    coalesce(l.penalty_rate_bps_applied, p.penalty_rate_bps),
    p.penalty_method,
    p.guarantor_required, p.min_guarantors, p.collateral_required,
    p.early_repayment, p.extra_payment, p.application_profile,
    v_overridden,
    case when v_overridden then l.approved_by end,
    case when v_overridden
         then coalesce(
                (select pr.full_name from public.profiles pr where pr.id = l.approved_by),
                'system')
    end,
    p.requires_membership, p.interest_source
  );
end;
$$;

comment on function public.capture_loan_product_snapshot(uuid) is
  'Phase 12, extended in Polytos Phase 3. Freezes the effective product terms onto the loan, including whether the product required membership and where its price came from. A policy-priced loan is never recorded as a rate override. Idempotent, and refuses to run twice because the snapshot table is append-only.';

revoke all on function public.capture_loan_product_snapshot(uuid) from public, anon, authenticated;
