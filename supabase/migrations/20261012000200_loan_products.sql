-- ===========================================================================
-- Phase 12.2 — loan products
--
-- The business offers four things: Quick Loans, Salary Loans, Business Loans
-- and Individual Loans. Until now there was one implicit product — whatever
-- `business_settings` said — and every loan took its terms from that single
-- row.
--
-- ## Precedence, stated once
--
-- Two places now hold lending rules, so the rule about the rules matters more
-- than either of them:
--
--   1. **`business_settings` is the guard rail.** Its amount range, term
--      range, interest ceiling and penalty ceiling bound what any product may
--      offer. A product that tried to lend more than the business permits, or
--      at a rate above the business ceiling, is refused by a trigger — so the
--      global row stays a real constraint rather than dead configuration
--      somebody forgot to delete.
--
--   2. **The product is the source of truth for a loan.** Within the guard
--      rail, the product decides the amount range, the rate and its band, the
--      method, the term options, the cadences, the grace period, the penalty,
--      whether a guarantor or collateral is required, and what happens on
--      early or extra payment. `business_settings` is consulted only where
--      the product is silent.
--
--   3. **`max_active_loans_per_client` stays global and only global.** It is
--      a fact about the borrower, not about the product, and a per-product
--      limit would let somebody hold one of each.
--
--   4. **At approval the effective terms are snapshotted** onto
--      `loan_product_snapshots`, and nothing afterwards rewrites them.
--      Changing a product next month cannot alter a loan agreed last month —
--      the same guarantee Phase 4 already gives for the interest rate, now
--      extended to the whole product configuration.
--
-- ## The application profile
--
-- A Salary Loan asks for an employer and a payslip; a Business Loan asks for
-- turnover and a trading licence. Those are *different questions*, not
-- different columns on `loans`: putting them there would add thirty nullable
-- fields of which at most a third apply to any row, and no constraint could
-- say which. So a product names an `application_profile`, and Phase 4 hangs
-- the product-specific answers off the loan in their own typed table.
--
-- ## The migrated product
--
-- 33 loans exist and predate all of this. Nothing in their records says which
-- product they would have been sold under, and guessing would put a label on
-- a contract that never carried one. So they are assigned to an explicitly
-- named, inactive product — `IL-LEGACY`, "Individual Loan (migrated)" —
-- configured with exactly the terms those loans actually carry. Nothing about
-- any historical agreement changes; the field is populated truthfully, and a
-- report that groups by product shows them as what they are.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Products
-- ---------------------------------------------------------------------------

create table public.loan_products (
  id uuid primary key default gen_random_uuid(),

  product_code text not null unique,
  name text not null unique,
  description text,

  status text not null default 'active',
  -- Where it sits in a picker. A business orders its products by how it
  -- sells them, not alphabetically.
  sort_order smallint not null default 100,

  -- The product a loan gets when nothing names one. Explicit rather than
  -- "whichever sorts first", because sort order is about how a picker reads
  -- and this is about what the business does by default — and the first
  -- draft of this table conflated the two, which quietly made every
  -- unnamed loan a Quick Loan with a one-month ceiling.
  is_default boolean not null default false,

  -- --- Amount ------------------------------------------------------------
  min_amount bigint not null,
  max_amount bigint not null,

  -- --- Interest ----------------------------------------------------------
  default_interest_rate_bps integer not null,
  min_interest_rate_bps integer not null,
  max_interest_rate_bps integer not null,
  interest_method text not null default 'reducing_balance_monthly',

  -- Whether a rate other than the default may be used at all, and by whom.
  -- Two columns rather than one, because "overriding is allowed" and "these
  -- people may do it" are separately useful: turning the first off suspends
  -- the capability without losing the list.
  interest_override_allowed boolean not null default false,
  interest_override_roles text[] not null default '{}',

  -- --- Duration ----------------------------------------------------------
  min_term_months integer not null,
  max_term_months integer not null,
  -- A fixed menu of durations, where the product sells one. NULL means any
  -- whole month between the two bounds.
  allowed_term_months integer[],

  -- --- Repayment ---------------------------------------------------------
  allowed_repayment_frequencies text[] not null,
  default_repayment_frequency text not null
    references public.repayment_frequencies(key) on delete restrict,

  -- --- Lateness ----------------------------------------------------------
  grace_period_days integer not null,
  penalty_rate_bps integer not null,
  penalty_method text not null default 'one_time_percent_of_outstanding',

  -- --- Security ----------------------------------------------------------
  guarantor_required boolean not null default false,
  min_guarantors smallint not null default 0,
  collateral_required boolean not null default false,

  -- --- Repayment behaviour ----------------------------------------------
  early_repayment text not null default 'allowed_no_rebate',
  extra_payment text not null default 'reduces_balance',

  -- --- The application -----------------------------------------------------
  application_profile text not null default 'individual',
  -- Whether the product's own documents are demanded before submission. A
  -- Quick Loan turns this off; it is the only thing that makes it quick, and
  -- it does not weaken approval, which is unchanged for every product.
  requires_supporting_documents boolean not null default true,

  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  updated_by uuid references public.profiles(id) on delete set null,

  constraint loan_products_code_shape check (product_code ~ '^[A-Z][A-Z0-9-]{1,15}$'),
  constraint loan_products_name_not_blank check (btrim(name) <> ''),
  constraint loan_products_status_valid check (status in ('active', 'inactive')),

  constraint loan_products_amount_positive check (min_amount > 0),
  constraint loan_products_amount_order check (max_amount >= min_amount),

  constraint loan_products_rate_range
    check (min_interest_rate_bps >= 0 and max_interest_rate_bps <= 1000000),
  constraint loan_products_rate_order
    check (max_interest_rate_bps >= min_interest_rate_bps),
  -- The default has to be a rate the product actually offers. Without this a
  -- product could default to 20% while permitting only 10–15%, and every
  -- application would open pre-filled with a value it then refused.
  constraint loan_products_default_rate_in_band
    check (default_interest_rate_bps between min_interest_rate_bps and max_interest_rate_bps),
  constraint loan_products_interest_method_valid
    check (interest_method in ('reducing_balance_monthly')),
  -- A list of roles is meaningless unless overriding is permitted.
  constraint loan_products_override_roles_consistent
    check (interest_override_allowed or pg_catalog.cardinality(interest_override_roles) = 0),

  constraint loan_products_term_positive check (min_term_months >= 1),
  constraint loan_products_term_order check (max_term_months >= min_term_months),
  constraint loan_products_term_ceiling check (max_term_months <= 120),
  constraint loan_products_allowed_terms_nonempty
    check (allowed_term_months is null or pg_catalog.cardinality(allowed_term_months) > 0),

  constraint loan_products_frequencies_nonempty
    check (pg_catalog.cardinality(allowed_repayment_frequencies) > 0),

  constraint loan_products_grace_range check (grace_period_days between 0 and 3650),
  constraint loan_products_penalty_range check (penalty_rate_bps between 0 and 1000000),
  constraint loan_products_penalty_method_valid
    check (penalty_method in ('one_time_percent_of_outstanding')),

  constraint loan_products_guarantors_sane check (min_guarantors between 0 and 10),
  -- "A guarantor is required" and "at least one guarantor" are the same
  -- statement, and a product that said the first while asking for zero would
  -- be a product nobody could satisfy or fail.
  constraint loan_products_guarantor_count_consistent
    check (not guarantor_required or min_guarantors >= 1),

  constraint loan_products_early_repayment_valid
    check (early_repayment in ('allowed_no_rebate', 'allowed_with_rebate', 'not_allowed')),
  constraint loan_products_extra_payment_valid
    check (extra_payment in ('reduces_balance', 'advances_schedule', 'not_allowed')),
  constraint loan_products_application_profile_valid
    check (application_profile in ('individual', 'salary', 'business', 'quick'))
);

create index loan_products_status_idx on public.loan_products (status, sort_order, name);

-- At most one default, and only an active product may be it.
create unique index loan_products_one_default on public.loan_products ((true)) where is_default;

alter table public.loan_products add constraint loan_products_default_is_active
  check (not is_default or status = 'active');

comment on table public.loan_products is
  'Phase 12. What the business sells. Within the bounds business_settings sets, a product is the source of truth for a loan''s terms; at approval those terms are snapshotted so a later change cannot rewrite an agreement.';

create trigger loan_products_set_updated_at
  before update on public.loan_products
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Where a product is sold
--
-- An empty set means everywhere. That is the common case and the one a
-- single-branch business is always in, so it is the one that needs no rows.
-- ---------------------------------------------------------------------------

create table public.loan_product_branches (
  product_id uuid not null references public.loan_products(id) on delete cascade,
  branch_id uuid not null references public.branches(id) on delete restrict,
  created_at timestamptz not null default pg_catalog.now(),
  primary key (product_id, branch_id)
);

create index loan_product_branches_branch_idx on public.loan_product_branches (branch_id);

comment on table public.loan_product_branches is
  'Phase 12. Which branches may sell a product. No rows for a product means every branch, which is what a single-branch business always wants and what a join table would otherwise make it state explicitly.';

-- ---------------------------------------------------------------------------
-- A product must fit inside what the business permits
--
-- The guard rail from the head of this file, enforced. Without it the global
-- settings become documentation: a product could lend 50,000,000 against a
-- business maximum of 20,000,000 and nothing would notice.
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
    -- Twice the standing rate, not the standing rate itself: a product may
    -- legitimately price risk above the default, and a ceiling equal to the
    -- default would make every product identical. What this refuses is a
    -- rate nobody intended to type.
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

  if new.max_term_months > b.max_loan_term_months then
    raise exception
      'This product would run to % months but the business maximum is %.',
      new.max_term_months, b.max_loan_term_months using errcode = 'P0001';
  end if;

  -- Every cadence it offers has to be one the business actually supports,
  -- and the default has to be one of them.
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

  -- A named duration menu has to sit inside the product's own bounds.
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

  -- An override list names roles that exist.
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

revoke all on function public.loan_products_within_business_rules() from public, anon, authenticated;

create trigger loan_products_within_business_rules
  before insert or update on public.loan_products
  for each row execute function public.loan_products_within_business_rules();

-- ---------------------------------------------------------------------------
-- The four products, and the one the existing loans belong to
-- ---------------------------------------------------------------------------

insert into public.loan_products (
  product_code, name, description, status, sort_order, is_default,
  min_amount, max_amount,
  default_interest_rate_bps, min_interest_rate_bps, max_interest_rate_bps,
  interest_override_allowed, interest_override_roles,
  min_term_months, max_term_months, allowed_term_months,
  allowed_repayment_frequencies, default_repayment_frequency,
  grace_period_days, penalty_rate_bps,
  guarantor_required, min_guarantors, collateral_required,
  early_repayment, extra_payment,
  application_profile, requires_supporting_documents
) values
  (
    'QL', 'Quick Loans',
    'A small, short advance decided the same day. The application asks for less; the approval asks for exactly as much as any other product.',
    'active', 10, false,
    100000, 2000000,
    1500, 1200, 2000,
    false, '{}',
    1, 1, array[1],
    array['daily', 'every_2_days'], 'daily',
    3, 5000,
    false, 0, false,
    'allowed_no_rebate', 'reduces_balance',
    'quick', false
  ),
  (
    'SL', 'Salary Loans',
    'For an employed borrower, repaid against a salary. The application captures the employer, the pay date and the evidence of both.',
    'active', 20, false,
    200000, 20000000,
    1200, 1000, 1800,
    true, array['owner_admin', 'manager'],
    1, 3, null,
    array['daily', 'every_2_days', 'every_3_days'], 'every_3_days',
    5, 5000,
    true, 1, false,
    'allowed_with_rebate', 'reduces_balance',
    'salary', true
  ),
  (
    'BL', 'Business Loans',
    'Working capital for a trading business. The application captures the business, its turnover and what the money is for.',
    'active', 30, false,
    300000, 20000000,
    1500, 1200, 2000,
    true, array['owner_admin'],
    1, 3, null,
    array['daily', 'every_2_days', 'every_3_days'], 'every_2_days',
    3, 5000,
    true, 2, true,
    'allowed_no_rebate', 'reduces_balance',
    'business', true
  ),
  (
    'IL', 'Individual Loans',
    'Ordinary personal lending. The standard application, the standard terms.',
    -- The default: ordinary personal lending is what the business does when
    -- nothing else is specified.
    'active', 40, true,
    100000, 20000000,
    1500, 1200, 1800,
    true, array['owner_admin', 'manager'],
    1, 3, null,
    array['daily', 'every_2_days', 'every_3_days'], 'daily',
    3, 5000,
    false, 0, false,
    'allowed_no_rebate', 'reduces_balance',
    'individual', true
  ),
  (
    -- Inactive, so it cannot be chosen for a new application. It exists so
    -- that a loan agreed before products existed can name what it actually
    -- was rather than being filed under a product it was never sold as.
    'IL-LEGACY', 'Individual Loan (migrated)',
    'The loans the business wrote before it had named products. Configured with exactly the terms those agreements carry, and inactive so it cannot be chosen again. See migration 20261012000200.',
    'inactive', 900, false,
    100000, 20000000,
    1500, 1500, 1500,
    false, '{}',
    1, 3, null,
    array['daily', 'every_2_days', 'every_3_days'], 'daily',
    3, 5000,
    false, 0, false,
    'allowed_no_rebate', 'reduces_balance',
    'individual', false
  );

-- ---------------------------------------------------------------------------
-- A loan names its product
-- ---------------------------------------------------------------------------

alter table public.loans
  add column loan_product_id uuid references public.loan_products(id) on delete restrict;

comment on column public.loans.loan_product_id is
  'Phase 12. The product this loan was sold under. The live configuration; the terms that were agreed are in loan_product_snapshots and do not move.';

-- A rate somebody deliberately chose, as distinct from the product's own.
--
-- This column exists because `interest_rate_bps` cannot carry the
-- distinction: it is NOT NULL and a draft has to be savable, so every draft
-- is written with a placeholder that approval overwrites. Reading an
-- override off it would make every draft look like one — which is precisely
-- what the first version of `approve_loan` did, writing every loan at the
-- placeholder rate instead of the product's.
--
-- NULL therefore means "the product's standard rate", which is the ordinary
-- case and the one nobody has to think about.
alter table public.loans
  add column proposed_interest_rate_bps integer;

comment on column public.loans.proposed_interest_rate_bps is
  'Phase 12. A rate deliberately chosen in place of the product default, or NULL for the standard rate. Approval refuses one the product does not permit, and records who chose it on the snapshot.';

alter table public.loans add constraint loans_proposed_rate_range
  check (proposed_interest_rate_bps is null
         or proposed_interest_rate_bps between 0 and 1000000);

create index loans_product_idx on public.loans (loan_product_id);

update public.loans
   set loan_product_id = (select id from public.loan_products where product_code = 'IL-LEGACY')
 where loan_product_id is null;

-- Supplied by the database when the caller does not name one, exactly as
-- `branch_id` is: nothing that creates a loan today knows products exist, and
-- making the column mandatory without this would break loan creation
-- outright. Phase 4 gives the application a product picker and this stops
-- firing, without anything here changing.
create or replace function public.loans_stamp_product()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.loan_product_id is null then
    select p.id into new.loan_product_id
    from public.loan_products p
    where p.is_default
    limit 1;
  end if;

  if new.loan_product_id is null then
    raise exception
      'No active loan product exists, so this loan cannot be written against one.'
      using errcode = 'P0001';
  end if;

  return new;
end;
$$;

revoke all on function public.loans_stamp_product() from public, anon, authenticated;

create trigger loans_stamp_product
  before insert on public.loans
  for each row execute function public.loans_stamp_product();

alter table public.loans alter column loan_product_id set not null;

-- ---------------------------------------------------------------------------
-- What was agreed, frozen
--
-- The same discipline as `loan_client_snapshots`: a loan is evidence of an
-- agreement, so the terms it was agreed under are stored, not looked up. A
-- product repriced next month cannot change what a borrower signed.
-- ---------------------------------------------------------------------------

create table public.loan_product_snapshots (
  loan_id uuid primary key references public.loans(id) on delete restrict,
  product_id uuid not null references public.loan_products(id) on delete restrict,

  product_code text not null,
  product_name text not null,

  min_amount bigint not null,
  max_amount bigint not null,
  interest_rate_bps integer not null,
  interest_method text not null,
  min_term_months integer not null,
  max_term_months integer not null,
  repayment_frequency text not null,
  grace_period_days integer not null,
  penalty_rate_bps integer not null,
  penalty_method text not null,
  guarantor_required boolean not null,
  min_guarantors smallint not null,
  collateral_required boolean not null,
  early_repayment text not null,
  extra_payment text not null,
  application_profile text not null,

  -- Whether the rate on this loan is the product's default or something a
  -- person chose, and who was entitled to choose it. A rate that differs
  -- from the default with nobody named is the thing an auditor looks for.
  interest_rate_overridden boolean not null default false,
  overridden_by uuid references public.profiles(id) on delete set null,
  overridden_by_label text,

  captured_at timestamptz not null default pg_catalog.now(),

  constraint loan_product_snapshots_amounts check (max_amount >= min_amount),
  constraint loan_product_snapshots_terms check (max_term_months >= min_term_months),
  constraint loan_product_snapshots_override_named
    check (not interest_rate_overridden or overridden_by_label is not null)
);

create index loan_product_snapshots_product_idx on public.loan_product_snapshots (product_id);

comment on table public.loan_product_snapshots is
  'Phase 12. The product configuration as it stood when the loan was approved. Append-only: a repriced product cannot rewrite an agreement that was already signed.';

create trigger loan_product_snapshots_no_update
  before update on public.loan_product_snapshots
  for each row execute function public.reject_mutation();

create trigger loan_product_snapshots_no_delete
  before delete on public.loan_product_snapshots
  for each row execute function public.reject_mutation();

-- ---------------------------------------------------------------------------
-- Capturing the snapshot
--
-- Called by `approve_loan` in the next migration. Separate so that the
-- existing function gains one line rather than being rewritten, and so the
-- backfill below can use the same code path the live approval does.
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

  insert into public.loan_product_snapshots (
    loan_id, product_id, product_code, product_name,
    min_amount, max_amount,
    -- The rate that was actually agreed, which lives on the loan. The
    -- product's default is not it: an approved override is a term of this
    -- agreement and the snapshot has to carry what was signed.
    interest_rate_bps, interest_method,
    min_term_months, max_term_months, repayment_frequency,
    grace_period_days, penalty_rate_bps, penalty_method,
    guarantor_required, min_guarantors, collateral_required,
    early_repayment, extra_payment, application_profile,
    interest_rate_overridden, overridden_by, overridden_by_label
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
    l.interest_rate_bps <> p.default_interest_rate_bps,
    case when l.interest_rate_bps <> p.default_interest_rate_bps then l.approved_by end,
    case when l.interest_rate_bps <> p.default_interest_rate_bps
         then coalesce(
                (select pr.full_name from public.profiles pr where pr.id = l.approved_by),
                'system')
    end
  );
end;
$$;

comment on function public.capture_loan_product_snapshot(uuid) is
  'Phase 12. Freezes the effective product terms onto the loan. Idempotent, and refuses to run twice because the snapshot table is append-only.';

revoke all on function public.capture_loan_product_snapshot(uuid) from public, anon, authenticated;

-- Every loan that is already past approval gets its snapshot now, from the
-- migrated product and from the rate each loan actually carries. No figure
-- here is invented: every one is read off the loan or off the product the
-- loan was just assigned to, whose configuration was chosen to match them.
do $backfill$
declare
  r record;
begin
  for r in
    select id from public.loans
     where status in ('approved', 'active', 'cleared', 'cancelled')
     order by created_at
  loop
    perform public.capture_loan_product_snapshot(r.id);
  end loop;
end
$backfill$;

-- ---------------------------------------------------------------------------
-- Reading products
-- ---------------------------------------------------------------------------

create view public.loan_product_catalogue with (security_invoker = true) as
select
  p.id as product_id,
  p.product_code,
  p.name,
  p.description,
  p.status,
  p.sort_order,
  p.is_default,
  p.min_amount,
  p.max_amount,
  p.default_interest_rate_bps,
  p.min_interest_rate_bps,
  p.max_interest_rate_bps,
  p.interest_method,
  p.interest_override_allowed,
  p.interest_override_roles,
  p.min_term_months,
  p.max_term_months,
  p.allowed_term_months,
  p.allowed_repayment_frequencies,
  p.default_repayment_frequency,
  p.grace_period_days,
  p.penalty_rate_bps,
  p.penalty_method,
  p.guarantor_required,
  p.min_guarantors,
  p.collateral_required,
  p.early_repayment,
  p.extra_payment,
  p.application_profile,
  p.requires_supporting_documents,
  -- NULL means every branch, which is what no rows in the join table means.
  (
    select pg_catalog.array_agg(b.branch_id order by b.branch_id)
    from public.loan_product_branches b
    where b.product_id = p.id
  ) as branch_ids,
  (select pg_catalog.count(*) from public.loans l where l.loan_product_id = p.id)::bigint
    as loans_written,
  p.created_at,
  p.updated_at
from public.loan_products p;

comment on view public.loan_product_catalogue is
  'Phase 12. Every product with its configuration, the branches that may sell it and how many loans have been written against it.';

-- ---------------------------------------------------------------------------
-- Capabilities
-- ---------------------------------------------------------------------------

insert into public.permissions (key, description) values
  ('products:view',   'See the loan products and their terms.'),
  ('products:manage', 'Create a loan product, change its terms, or retire it.')
on conflict (key) do nothing;

insert into public.role_permissions (role_key, permission_key) values
  ('secretary_treasurer', 'products:view'),
  ('manager',             'products:view'),
  ('owner_admin',         'products:view'),
  -- Pricing is the Owner's. A Manager who could edit a product could lend at
  -- a rate nobody agreed, which is the same reason `settings:update` is not
  -- theirs.
  ('owner_admin',         'products:manage')
on conflict (role_key, permission_key) do nothing;

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------

alter table public.loan_products enable row level security;
alter table public.loan_product_branches enable row level security;
alter table public.loan_product_snapshots enable row level security;

revoke all on table public.loan_products from anon, authenticated;
revoke all on table public.loan_product_branches from anon, authenticated;
revoke all on table public.loan_product_snapshots from anon, authenticated;

grant select on table public.loan_products to authenticated;
grant select on table public.loan_product_branches to authenticated;
grant select on table public.loan_product_snapshots to authenticated;

create policy loan_products_select_with_permission
  on public.loan_products for select to authenticated
  using (public.user_has_permission('products:view'));

create policy loan_product_branches_select_with_permission
  on public.loan_product_branches for select to authenticated
  using (public.user_has_permission('products:view'));

-- A borrower reads the snapshot for their own loan, because the terms they
-- agreed to are theirs to see. Everyone else needs `loans:view`.
create policy loan_product_snapshots_select_own_or_register
  on public.loan_product_snapshots for select to authenticated
  using (
    public.user_has_permission('loans:view')
    or exists (
      select 1
      from public.loans l
      join public.clients c on c.id = l.client_id
      where l.id = loan_id
        and c.profile_id is not null
        and c.profile_id = public.current_profile_id()
    )
  );

revoke all on public.loan_product_catalogue from anon, authenticated;
grant select on public.loan_product_catalogue to authenticated;
