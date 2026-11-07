-- ===========================================================================
-- Phase 4A — Agency Banking & Digital Payments: the provider registry
--
-- Specification: `docs/AGENCY-BANKING-ARCHITECTURE.md` v3.0, §5.2–§5.4.
--
-- Three tables and one provisioning function. No provider rows are seeded
-- here: which providers are live, and on which commission model, is an open
-- Product Owner decision (reconciliation §4, decision C), and it is provider
-- *data* rather than schema. The structure therefore lands now and the
-- catalogue arrives in its own reversible migration.
--
-- ## Writes do not come through the Data API
--
-- Every table here is `SELECT`-only for `authenticated`, which is the rule the
-- money-movement module set and the reason is recorded there: a table anybody
-- can INSERT into is a table where a document can exist without the journal
-- that makes it true. Provider and till configuration is no different — a
-- float account registered without its ledger account, or a provider pointed
-- at an income account of the wrong type, is a book that cannot be reconciled.
-- All writes go through SECURITY DEFINER functions that check an `agency:*`
-- capability.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- 1. `agency_service_providers`
--
-- `float_model` decides *where the money sits*: `provider_float` means the
-- company holds electronic float the provider advanced, `cash_payable` means
-- the company holds the customer's cash and owes it onward.
--
-- `commission_model` decides *when income is recognised*: `immediate` at the
-- point of sale with no receivable, `deferred` accrued to 1310 and cleared
-- when the provider remits (correction C7).
--
-- The two are independent. Airtime is `provider_float` + `immediate`; school
-- fees are `cash_payable` + `deferred`.
-- ---------------------------------------------------------------------------

create table public.agency_service_providers (
  id                 uuid primary key default gen_random_uuid(),
  code               text not null unique,
  name               text not null,
  category           text not null,
  float_model        text not null,
  payable_account_id uuid references public.ledger_accounts(id) on delete restrict,
  income_account_id  uuid not null references public.ledger_accounts(id) on delete restrict,
  commission_model   text not null,
  -- Basis points, not a percentage in `numeric`. The specification's §5.2 asks
  -- for `numeric(7,4)`, but this schema admits no `numeric` column anywhere —
  -- `tests/db/schema.test.ts` fails the build on `real`, `double precision`,
  -- `money` *and* `numeric` across the whole of `public`, and the lending side
  -- already states rates as `interest_rate_bps` and `penalty_rate_bps_applied`.
  -- So 150 means 1.5% and 10000 means 100%, and the arithmetic stays integral.
  commission_rate_bps integer,
  commission_fixed   bigint,
  is_provisional     boolean not null default true,
  is_active          boolean not null default true,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),

  constraint agency_providers_code_shape
    check (code = upper(code) and code ~ '^[A-Z0-9_]{2,32}$'),

  constraint agency_providers_category_valid
    check (category = any (array[
      'mobile_money', 'agency_banking', 'utility',
      'school_fees', 'tv_subscription', 'airtime_data', 'other'
    ])),

  constraint agency_providers_float_model_valid
    check (float_model = any (array['provider_float', 'cash_payable'])),

  constraint agency_providers_commission_model_valid
    check (commission_model = any (array['deferred', 'immediate'])),

  -- A cash_payable provider has nowhere to put the customer's money without a
  -- payable account, so the liability is structurally required.
  constraint agency_providers_payable_required_for_cash_payable
    check (float_model <> 'cash_payable' or payable_account_id is not null),

  -- And a provider_float provider must NOT carry one: it would be an unused
  -- liability account that a later posting function could pick up by mistake.
  constraint agency_providers_no_payable_for_provider_float
    check (float_model <> 'provider_float' or payable_account_id is null),

  -- Rate and fixed amount are both optional (a provider may pay neither, or
  -- either), but a negative commission is not a commission, and nothing pays
  -- more than 100%.
  constraint agency_providers_commission_rate_sane
    check (commission_rate_bps is null
           or (commission_rate_bps >= 0 and commission_rate_bps <= 10000)),
  constraint agency_providers_commission_fixed_sane
    check (commission_fixed is null or commission_fixed >= 0)
);

comment on table public.agency_service_providers is
  'Phase 4A. The registry of agency banking and digital payment providers. float_model says where the money sits (electronic float advanced by the provider, or the customer''s cash owed onward); commission_model says when income is recognised (at the point of sale, or accrued to 1310 and cleared on settlement). is_provisional marks a row whose commission model has not yet been confirmed by the Product Owner.';

comment on column public.agency_service_providers.commission_rate_bps is
  'Phase 4A. The provider''s commission rate in basis points: 150 is 1.5%, 10000 is 100%. An integer rather than the specification''s numeric(7,4), because this schema permits no numeric column and the lending side already states rates in basis points. NULL means no percentage rate is recorded, which is not the same as zero.';

comment on column public.agency_service_providers.is_provisional is
  'Phase 4A, decision C. TRUE while the commission model and rate for this provider are the specification''s default rather than a confirmed business rule. Carries no behaviour: it exists so a provisional catalogue cannot be mistaken for an approved one, and so the open decision is visible in the data rather than only in a document.';

comment on column public.agency_service_providers.income_account_id is
  'Phase 4A, §4.3. The 4500-series account this provider''s commission is credited to. Recognised by account code rather than per provider (§3.5), so several providers share one account and provider-level reporting comes from the journal''s source_id.';


-- ---------------------------------------------------------------------------
-- 2. `agency_transaction_types`
--
-- What a provider can actually be asked to do, and the limits on it.
-- `requires_approval_above` is the per-type ceiling above which verification
-- must come from a higher role; it is read by the Phase 4B posting path.
-- ---------------------------------------------------------------------------

create table public.agency_transaction_types (
  id                      uuid primary key default gen_random_uuid(),
  provider_id             uuid not null references public.agency_service_providers(id) on delete restrict,
  code                    text not null,
  name                    text not null,
  direction               text not null,
  requires_meter_number   boolean not null default false,
  requires_account_number boolean not null default false,
  requires_customer_name  boolean not null default false,
  max_single_transaction  bigint,
  requires_approval_above bigint,
  is_active               boolean not null default true,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),

  constraint agency_types_direction_valid
    check (direction = any (array['deposit', 'withdrawal', 'payment', 'transfer'])),
  constraint agency_types_max_single_sane
    check (max_single_transaction is null or max_single_transaction > 0),
  constraint agency_types_approval_sane
    check (requires_approval_above is null or requires_approval_above > 0),
  constraint agency_types_code_shape
    check (code = upper(code) and code ~ '^[A-Z0-9_]{2,32}$'),

  unique (provider_id, code)
);

comment on table public.agency_transaction_types is
  'Phase 4A. The operations a provider supports — a deposit, a withdrawal, a bill payment — with the identifier each one needs from the customer and the limits on it. direction is from the customer''s point of view: a deposit is money the customer hands over.';


-- ---------------------------------------------------------------------------
-- 3. `agency_provider_float_accounts`
--
-- Correction C13: several tills per provider per branch, distinguished by
-- `till_name`. Transactions reference this row, not the provider, so a
-- two-till branch can reconcile each till on its own.
--
-- The `unique (ledger_account_id)` is the one that matters most: two registry
-- rows pointing at one ledger account would let two tills spend the same
-- float and each believe it had the balance to do so.
-- ---------------------------------------------------------------------------

create table public.agency_provider_float_accounts (
  id                uuid primary key default gen_random_uuid(),
  provider_id       uuid not null references public.agency_service_providers(id) on delete restrict,
  branch_id         uuid not null references public.branches(id) on delete restrict,
  ledger_account_id uuid not null unique references public.ledger_accounts(id) on delete restrict,
  till_name         text not null default 'main',
  is_active         boolean not null default true,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  constraint agency_float_till_name_shape
    check (till_name ~ '^[a-z0-9][a-z0-9_-]{0,30}$'),

  unique (provider_id, branch_id, till_name)
);

comment on table public.agency_provider_float_accounts is
  'Phase 4A, correction C13. One row per provider per branch per till, each owning exactly one agency_float ledger account. Several tills per provider per branch are supported; an agency transaction references the till directly, so each reconciles independently. ledger_account_id is unique because two tills sharing one float account could each spend the other''s balance.';


-- ---------------------------------------------------------------------------
-- 4. Integrity the column types cannot express
--
-- Three invariants, enforced by trigger because each spans two tables:
--
--   * a float account's ledger account really is agency float, really belongs
--     to the branch claiming it, and really is postable;
--   * a provider's income account really is a postable 4500-series income
--     account — pointing agency commission at 4100 Interest Income would make
--     agency and lending income inseparable, which Phase 4 exists to prevent;
--   * a provider's payable account really is a postable liability.
-- ---------------------------------------------------------------------------

create or replace function public.agency_float_account_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  a record;
begin
  select la.cash_kind, la.branch_id, la.is_postable, la.status, la.name, la.account_type
    into a
  from public.ledger_accounts la where la.id = new.ledger_account_id;

  if a is null then
    raise exception 'That ledger account does not exist.' using errcode = 'P0001';
  end if;

  if a.account_type <> 'asset' or a.cash_kind is distinct from 'agency_float' then
    raise exception
      '% is not an agency float account; a float till must own one.', a.name
      using errcode = 'P0001';
  end if;

  if a.branch_id is distinct from new.branch_id then
    raise exception
      'Float account % belongs to a different branch than the till claiming it.', a.name
      using errcode = 'P0001';
  end if;

  if not a.is_postable or a.status <> 'active' then
    raise exception 'Float account % is not active and postable.', a.name
      using errcode = 'P0001';
  end if;

  return new;
end;
$$;

create trigger agency_float_accounts_guard
  before insert or update on public.agency_provider_float_accounts
  for each row execute function public.agency_float_account_guard();

-- A trigger fires as the table owner and needs no EXECUTE grant, so the one
-- Supabase hands out by default is pure exposure: a SECURITY DEFINER function
-- any signed-in user could call directly. Withheld rather than baselined.
revoke all on function public.agency_float_account_guard()
  from public, anon, authenticated;


create or replace function public.agency_provider_accounts_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  inc record;
  pay record;
begin
  select la.account_type, la.is_postable, la.status, la.name, la.code into inc
  from public.ledger_accounts la where la.id = new.income_account_id;

  if inc is null then
    raise exception 'That income account does not exist.' using errcode = 'P0001';
  end if;

  if inc.account_type <> 'income' or not inc.is_postable or inc.status <> 'active' then
    raise exception '% is not an active, postable income account.', inc.name
      using errcode = 'P0001';
  end if;

  -- Agency income must stay in the 4500 series. This is what keeps "agency and
  -- lending income remain separately reportable" true by construction rather
  -- than by convention.
  if inc.code not like '45%' then
    raise exception
      '% is not an agency income account; agency commission belongs in the 4500 series.',
      inc.name
      using errcode = 'P0001';
  end if;

  if new.payable_account_id is not null then
    select la.account_type, la.is_postable, la.status, la.name into pay
    from public.ledger_accounts la where la.id = new.payable_account_id;

    if pay is null then
      raise exception 'That payable account does not exist.' using errcode = 'P0001';
    end if;

    if pay.account_type <> 'liability' or not pay.is_postable or pay.status <> 'active' then
      raise exception '% is not an active, postable liability account.', pay.name
        using errcode = 'P0001';
    end if;
  end if;

  return new;
end;
$$;

create trigger agency_providers_accounts_guard
  before insert or update on public.agency_service_providers
  for each row execute function public.agency_provider_accounts_guard();

revoke all on function public.agency_provider_accounts_guard()
  from public, anon, authenticated;


-- ---------------------------------------------------------------------------
-- 5. `ensure_agency_float_account()`
--
-- Provisioning a till means creating a ledger account and a registry row that
-- agree with each other. Doing it by hand is how they stop agreeing, so it is
-- one function: it derives the code in the §3.1 format, sets the kind and the
-- branch the constraints require, parents it under 1320, and registers it.
--
-- Idempotent on (provider, branch, till): a second call returns the existing
-- row rather than creating a second account for the same till.
-- ---------------------------------------------------------------------------

create or replace function public.ensure_agency_float_account(
  p_provider_id uuid,
  p_branch_id   uuid,
  p_till_name   text default 'main'
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_existing    uuid;
  v_provider    record;
  v_branch_code text;
  v_code        text;
  v_account_id  uuid;
  v_till        text := coalesce(nullif(pg_catalog.btrim(p_till_name), ''), 'main');
begin
  if auth.uid() is not null and not public.user_has_permission('agency:providers') then
    raise exception
      'Provisioning an agency float till requires the agency:providers capability.'
      using errcode = '42501';
  end if;

  select * into v_provider
  from public.agency_service_providers where id = p_provider_id;

  if v_provider is null then
    raise exception 'No such agency provider.' using errcode = 'P0001';
  end if;

  if v_provider.float_model <> 'provider_float' then
    raise exception
      '% settles through a payable account, not float, so it has no till.', v_provider.name
      using errcode = 'P0001';
  end if;

  select f.id into v_existing
  from public.agency_provider_float_accounts f
  where f.provider_id = p_provider_id
    and f.branch_id = p_branch_id
    and f.till_name = v_till;

  if v_existing is not null then
    return v_existing;
  end if;

  select b.branch_code into v_branch_code from public.branches b where b.id = p_branch_id;
  if v_branch_code is null then
    raise exception 'No such branch.' using errcode = 'P0001';
  end if;

  -- §3.1: `1320.{PROVIDER}.{BRANCH}` for the first till, `.T2`, `.T3` after.
  -- The suffix is derived from how many tills this provider already has at
  -- this branch, so the first is unsuffixed exactly as the specification has
  -- it and the codes stay stable as more are added.
  v_code := '1320.' || v_provider.code || '.' || v_branch_code;
  if v_till <> 'main' then
    v_code := v_code || '.T' || (
      1 + (select pg_catalog.count(*)
             from public.agency_provider_float_accounts f
            where f.provider_id = p_provider_id and f.branch_id = p_branch_id)
    )::text;
  end if;

  -- The shape constraint allows 64 characters. A clear refusal here beats a
  -- raw check-constraint violation from three frames down.
  if pg_catalog.length(v_code) > 64 then
    raise exception
      'The float account code for % at % would be % characters, which is too long. Shorten the provider code.',
      v_provider.code, v_branch_code, pg_catalog.length(v_code)
      using errcode = 'P0001';
  end if;

  insert into public.ledger_accounts
    (code, name, account_type, normal_side, cash_kind, branch_id, is_postable, status,
     parent_id, description)
  values
    (v_code,
     v_provider.name || ' Float — ' || (select b.name from public.branches b where b.id = p_branch_id)
       || case when v_till = 'main' then '' else ' (' || v_till || ')' end,
     'asset', 'debit', 'agency_float', p_branch_id, true, 'active',
     (select id from public.ledger_accounts where code = '1320'),
     'Phase 4A. Electronic float held for ' || v_provider.name
       || '. Movable only through the agency services module: assert_cash_account() refuses agency float, so a generic cash transfer cannot reach it.')
  returning id into v_account_id;

  insert into public.agency_provider_float_accounts
    (provider_id, branch_id, ledger_account_id, till_name)
  values (p_provider_id, p_branch_id, v_account_id, v_till)
  returning id into v_existing;

  return v_existing;
end;
$$;

comment on function public.ensure_agency_float_account(uuid, uuid, text) is
  'Phase 4A, correction C13. Provisions one agency float till: creates its 1320-series ledger account with cash_kind = agency_float and the branch the constraints require, parents it under 1320, and registers it. Idempotent on (provider, branch, till). Requires agency:providers.';

-- Reachable by a signed-in user, because provisioning a till is something the
-- owner does from the provider configuration screen. The control is the
-- capability check inside, which raises 42501 for anyone without
-- `agency:providers` — classification A in the database security baseline.
revoke all on function public.ensure_agency_float_account(uuid, uuid, text)
  from public, anon;
grant execute on function public.ensure_agency_float_account(uuid, uuid, text)
  to authenticated;


-- ---------------------------------------------------------------------------
-- 6. Housekeeping triggers
-- ---------------------------------------------------------------------------

create trigger agency_service_providers_set_updated_at
  before update on public.agency_service_providers
  for each row execute function public.set_updated_at();

create trigger agency_transaction_types_set_updated_at
  before update on public.agency_transaction_types
  for each row execute function public.set_updated_at();

create trigger agency_provider_float_accounts_set_updated_at
  before update on public.agency_provider_float_accounts
  for each row execute function public.set_updated_at();

-- A float till that has spent float cannot be deleted: its ledger account
-- carries history that must stay reachable. Deactivate it instead.
create trigger agency_provider_float_accounts_no_delete
  before delete on public.agency_provider_float_accounts
  for each row execute function public.reject_mutation();


-- ---------------------------------------------------------------------------
-- 7. Row-level security
--
-- SELECT only, and only with a capability. Reading the registry is reading
-- what the business is contracted to do and how much it earns on each
-- transaction, so it is gated rather than public to any signed-in user.
--
-- Float tills are additionally branch-isolated: one branch has no business
-- reading another branch's till balances.
-- ---------------------------------------------------------------------------

alter table public.agency_service_providers enable row level security;
alter table public.agency_transaction_types enable row level security;
alter table public.agency_provider_float_accounts enable row level security;

revoke all on table public.agency_service_providers from anon, authenticated;
revoke all on table public.agency_transaction_types from anon, authenticated;
revoke all on table public.agency_provider_float_accounts from anon, authenticated;

grant select on table public.agency_service_providers to authenticated;
grant select on table public.agency_transaction_types to authenticated;
grant select on table public.agency_provider_float_accounts to authenticated;

-- The capability call is wrapped in a subselect so PostgreSQL evaluates it
-- once per statement rather than once per candidate row, and the branch test
-- is restated inline rather than calling `user_can_see_branch()`, which is
-- correlated and SECURITY DEFINER and so would run two queries against
-- `profiles` for every row. This is the form migration 20261018000100
-- established and `tests/db/rls-hoisting.test.ts` enforces.

create policy agency_service_providers_select_with_permission
  on public.agency_service_providers for select to authenticated
  using ((select public.user_has_permission('agency:reports')));

create policy agency_transaction_types_select_with_permission
  on public.agency_transaction_types for select to authenticated
  using ((select public.user_has_permission('agency:reports')));

create policy agency_provider_float_accounts_select_with_permission
  on public.agency_provider_float_accounts for select to authenticated
  using (
    (select public.user_has_permission('agency:reports'))
    and (
      branch_id is null
      or (select public.current_user_branch_id()) is null
      or branch_id = (select public.current_user_branch_id())
    )
  );


-- ---------------------------------------------------------------------------
-- 8. Indexes
-- ---------------------------------------------------------------------------

create index agency_providers_active_idx
  on public.agency_service_providers (is_active, category, code);

create index agency_types_provider_idx
  on public.agency_transaction_types (provider_id, is_active);

create index agency_float_accounts_branch_idx
  on public.agency_provider_float_accounts (branch_id, provider_id, is_active);
