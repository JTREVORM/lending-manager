-- ===========================================================================
-- Operational task 1 — the Owner registers a bank, and a second person
-- approves its commercial terms
--
-- ## The gap this closes
--
-- `app/(app)/agency/providers/page.tsx` says it plainly, and the sentence was
-- accurate when it was written:
--
--   > Registering a provider, approving its commercial terms or making it
--   > live is not a screen in this release: the approval workflow for
--   > commercial terms has not been decided.
--
-- So `STANBIC` was the only bank POLYTOS could ever have. Adding Equity,
-- Centenary or any other partner meant a hand-written migration, reviewed by
-- whoever writes migrations, with the commission rate taken on trust from
-- whatever the ticket said. That is not an approval control. It is the
-- absence of one.
--
-- This migration supplies the workflow the screen was waiting on. Three
-- functions, in the order the business actually does the work:
--
--   1. `register_agency_provider()`     — the Owner records the partner.
--   2. `revise_agency_provider_terms()` — corrections, while unapproved.
--   3. `approve_agency_provider_terms()`— a *different* person confirms them
--                                         against the signed agreement.
--
-- ## What registration deliberately does NOT do
--
-- It does not make a provider live. Every row this function writes is
-- `is_provisional = true, is_active = false`, and neither flag is an argument
-- the caller can pass. Going live is a separate authorization with its own
-- preconditions; registering a partner and switching on its money are not the
-- same decision and must not be the same call.
--
-- `agency_transaction_live_readiness_guard()` already refuses to post
-- anything against a provisional or inactive provider, so a provider
-- registered here is inert until somebody with the authority to do so acts
-- again. That is the intended end state of this migration: the Owner can
-- register Equity Bank this afternoon and nothing whatsoever can be posted
-- against it.
--
-- ## Where the ledger accounts come from, and why they are not arguments
--
-- The 4500 series is already organised by exactly the categories
-- `agency_providers_category_valid` admits, and the 2200 series by the two
-- cash-payable kinds that exist:
--
--   | category        | income | payable (cash_payable only) |
--   |-----------------|--------|-----------------------------|
--   | mobile_money    | 4510   | 2290                        |
--   | agency_banking  | 4520   | 2220                        |
--   | utility         | 4530   | 2290                        |
--   | school_fees     | 4540   | 2210                        |
--   | tv_subscription | 4550   | 2290                        |
--   | airtime_data    | 4560   | 2290                        |
--   | other           | 4590   | 2290                        |
--
-- The nine rows of the provisional catalogue already follow it to the letter.
-- So the category decides the accounts, and the caller cannot choose them.
--
-- That is a deliberate narrowing. `agency_provider_accounts_guard()` would
-- catch an income account of the wrong *type* or outside the 45 series, but
-- it cannot catch 4510 on a bank: Mobile Money Commission is a postable
-- 4500-series income account, and pointing Equity Bank's commission at it
-- passes every check in the schema while quietly making agency banking income
-- and mobile money income inseparable for the rest of time. A dropdown
-- offering seven valid-looking wrong answers is a defect waiting for a busy
-- afternoon. The category is a fact the Owner knows; the account is a
-- consequence of it.
--
-- ## Why terms approval is a second person
--
-- A commission rate is the one number that decides what every future
-- transaction earns. `agency_transactions` snapshots
-- `commission_rate_bps_applied` per posting, so history is safe from a later
-- edit — but the first posting takes the rate as configured, and if that rate
-- was mistyped nothing in the system will ever notice. The signed agreement
-- is held outside POLYTOS; the control is therefore somebody checking the
-- number against the paper, and saying so on the record.
--
-- `agency:provider_approval` is new and granted to `owner_admin` alone,
-- because what is being approved is a commercial agreement rather than an
-- operational entry. Combined with the separation-of-duties refusal below,
-- that means **two Owner/Administrator accounts are required** to bring a
-- partner's terms into force. That is stated here because it is a deployment
-- consequence, not an accident: a business running a single administrator
-- login can register providers and will not be able to approve them.
--
-- ## Preserved
--
-- No existing function, policy, grant, constraint or trigger is weakened
-- here. `agency_service_providers` keeps `SELECT`-only for `authenticated`,
-- keeps its RLS policy, keeps both guard triggers and keeps the audit trigger
-- `agency_service_providers_audited`, which records every row this migration
-- writes with its before and after values. The three functions below are the
-- table's first writers other than `set_agency_provider_float_model()` and
-- `set_agency_provider_commission_source()`, and they are `SECURITY DEFINER`
-- with a capability check before their first read, classification A.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- 1. The approval trail
--
-- Five columns. Four record who did what; `terms_reference` records the
-- instrument the terms were checked against — a contract number, a signed
-- agreement reference, whatever the partner's paper is identified by. It is
-- free text because POLYTOS does not hold the document, and it is required
-- before approval because "approved against nothing" is not an approval.
-- ---------------------------------------------------------------------------

alter table public.agency_service_providers
  add column registered_by        uuid references public.profiles(id) on delete set null,
  add column registered_at        timestamptz,
  add column terms_reference      text,
  add column terms_approved_by    uuid references public.profiles(id) on delete set null,
  add column terms_approved_at    timestamptz,
  add column terms_approval_note  text;

comment on column public.agency_service_providers.registered_by is
  'Operational task 1. The profile that registered this provider through register_agency_provider(). NULL for the nine rows of the provisional catalogue, which arrived as migration data before the function existed.';

comment on column public.agency_service_providers.terms_reference is
  'Operational task 1. How to find the signed commercial agreement these terms were approved against: a contract number or agreement reference. POLYTOS does not hold the document, so this is the pointer to it, and it is required before is_provisional may be cleared.';

comment on column public.agency_service_providers.terms_approved_by is
  'Operational task 1. The profile that checked this provider''s commission terms against the signed agreement and confirmed them. Never the profile that registered it: approve_agency_provider_terms() raises SD001 on that.';

-- The invariant that makes the trail mean something: a provider's terms stop
-- being provisional only when somebody approved them, against a named
-- instrument, on a recorded date — and that somebody is not the person who
-- registered the provider.
--
-- ## Why a trigger on the transition, and not a CHECK on the state
--
-- A CHECK reading `is_provisional or (terms_approved_by is not null and ...)`
-- is the stronger statement and was written first. It is not the right one.
--
-- `authenticated` holds nothing but SELECT on this table, so the only writers
-- are the functions below and the table owner: migrations, the demo seeder,
-- and the database suite's fixtures. Dozens of those fixtures insert a
-- confirmed provider in one statement because they are setting up a counter
-- to test posting, commission or reconciliation against — none of them is
-- about approval, and a CHECK would have required every one of them to
-- manufacture an approval trail it has no opinion about. That does not make
-- the product safer; it makes twenty unrelated suites depend on this
-- migration.
--
-- The transition is where the control belongs. Every route a *user* can take
-- goes through `approve_agency_provider_terms()`, and this trigger holds
-- whatever that function does — including a route that updates the column
-- directly. A fixture that builds a world already containing a confirmed
-- provider is building a world, not taking an approval decision; a fixture
-- that *confirms* one is, and this refuses it without the trail, which is
-- exactly the line worth drawing.
-- ---------------------------------------------------------------------------

create or replace function public.agency_provider_terms_approval_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not (old.is_provisional and not new.is_provisional) then
    return new;
  end if;

  if new.terms_approved_by is null
     or new.terms_approved_at is null
     or pg_catalog.btrim(coalesce(new.terms_reference, '')) = '' then
    raise exception
      'Confirming %''s commercial terms is an approval, so it must name who approved them and the signed agreement they were checked against. Use approve_agency_provider_terms().',
      new.name
      using errcode = 'P0001';
  end if;

  if new.terms_approved_by is not null and new.registered_by is not null
     and new.terms_approved_by = new.registered_by then
    raise exception
      'The person who registered % cannot also approve its commercial terms. A different Owner or Administrator must.',
      new.name
      using errcode = 'SD001';
  end if;

  return new;
end;
$$;

comment on function public.agency_provider_terms_approval_guard() is
  'Operational task 1. Refuses the transition of a provider out of provisional unless the approval trail is complete — who approved the terms, when, and against which signed agreement — and unless that person is somebody other than the one who registered the provider. A trigger on the transition rather than a CHECK on the state: the table admits no session writes, so every route a user can take passes through here, while a fixture building a world that already contains a confirmed provider is not taking an approval decision.';

revoke all on function public.agency_provider_terms_approval_guard()
  from public, anon, authenticated;

create trigger agency_service_providers_terms_approval_guard
  before update on public.agency_service_providers
  for each row execute function public.agency_provider_terms_approval_guard();

-- A reference and a note are pointers for a human to follow, not prose.
alter table public.agency_service_providers
  add constraint agency_providers_terms_reference_shape
  check (terms_reference is null
         or (pg_catalog.btrim(terms_reference) = terms_reference
             and pg_catalog.length(terms_reference) between 2 and 120));

alter table public.agency_service_providers
  add constraint agency_providers_terms_note_shape
  check (terms_approval_note is null
         or (pg_catalog.btrim(terms_approval_note) = terms_approval_note
             and pg_catalog.length(terms_approval_note) between 2 and 500));


-- ---------------------------------------------------------------------------
-- 2. The approval capability
-- ---------------------------------------------------------------------------

insert into public.permissions (key, description) values
  ('agency:provider_approval',
   'Approve the commercial terms of a registered agency provider against its signed agreement, which is what allows the provider to leave provisional. Never one''s own registration: approve_agency_provider_terms() refuses that with SQLSTATE SD001.')
on conflict (key) do nothing;

insert into public.role_permissions (role_key, permission_key) values
  ('owner_admin', 'agency:provider_approval')
on conflict do nothing;


-- ---------------------------------------------------------------------------
-- 3. The category's accounts
--
-- A helper rather than a CASE repeated in three functions, and `immutable`
-- so it can be read in any context. It returns the code, not the id, so the
-- caller's error message can name the account that is missing from the chart
-- rather than report a null.
-- ---------------------------------------------------------------------------

create or replace function public.agency_category_income_code(p_category text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case p_category
           when 'mobile_money'    then '4510'
           when 'agency_banking'  then '4520'
           when 'utility'         then '4530'
           when 'school_fees'     then '4540'
           when 'tv_subscription' then '4550'
           when 'airtime_data'    then '4560'
           when 'other'           then '4590'
         end;
$$;

comment on function public.agency_category_income_code(text) is
  'Operational task 1. The 4500-series commission account a provider of this category credits. The category decides the account so that a bank''s commission cannot be filed under mobile money, which agency_provider_accounts_guard() cannot detect because both are postable 45-series income accounts.';

create or replace function public.agency_category_payable_code(p_category text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case p_category
           when 'school_fees'    then '2210'
           when 'agency_banking' then '2220'
           else '2290'
         end;
$$;

comment on function public.agency_category_payable_code(text) is
  'Operational task 1. The 2200-series liability a cash_payable provider of this category owes the customer''s money onward through. Read only for cash_payable providers; a provider_float provider must carry no payable account at all.';

-- Both are plain SQL over constants: no table is read, nothing is granted
-- that a caller could not compute, and `authenticated` needs them because the
-- registration screen shows which account a chosen category will post to.
revoke all on function public.agency_category_income_code(text) from public, anon;
revoke all on function public.agency_category_payable_code(text) from public, anon;
grant execute on function public.agency_category_income_code(text) to authenticated;
grant execute on function public.agency_category_payable_code(text) to authenticated;


-- ---------------------------------------------------------------------------
-- 4. `register_agency_provider()`
--
-- Writes one provisional, inactive provider. The commission terms it records
-- are a *proposal*: nothing may be posted against them until somebody else
-- approves them in §6.
--
-- `p_commission_source` is carried because the distinction already exists and
-- matters at registration time: a `reported` provider is one whose commission
-- POLYTOS cannot compute and must read off the partner's own statement, and
-- such a provider must carry no rate at all (constraint
-- `agency_providers_reported_states_no_rate`). Taking it as an argument lets
-- the Owner say so once, here, rather than registering a provider with a rate
-- and then correcting it.
-- ---------------------------------------------------------------------------

create or replace function public.register_agency_provider(
  p_code                text,
  p_name                text,
  p_category            text,
  p_float_model         text,
  p_commission_model    text,
  p_commission_source   text    default 'configured',
  p_commission_rate_bps integer default null,
  p_commission_fixed    bigint  default null,
  p_terms_reference     text    default null
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor      uuid;
  v_code       text;
  v_name       text;
  v_ref        text;
  v_income     uuid;
  v_payable    uuid;
  v_income_cd  text;
  v_payable_cd text;
  v_id         uuid;
begin
  if auth.uid() is not null
     and not (select public.user_has_permission('agency:providers')) then
    raise exception 'Not authorized to register an agency provider.'
      using errcode = '42501';
  end if;

  v_actor := public.current_profile_id();

  -- --- The identifiers -----------------------------------------------------
  -- Upper-cased rather than refused, because a provider code is an identifier
  -- the Owner types and `equity` is not a different partner from `EQUITY`.
  v_code := pg_catalog.upper(nullif(pg_catalog.btrim(coalesce(p_code, '')), ''));
  v_name := nullif(pg_catalog.btrim(coalesce(p_name, '')), '');
  v_ref  := nullif(pg_catalog.btrim(coalesce(p_terms_reference, '')), '');

  if v_code is null then
    raise exception 'A provider needs a short code, such as EQUITY.'
      using errcode = 'P0001';
  end if;

  if v_code !~ '^[A-Z0-9_]{2,32}$' then
    raise exception
      '% is not a usable provider code: use 2 to 32 letters, digits or underscores, such as EQUITY or CENTENARY.',
      v_code
      using errcode = 'P0001';
  end if;

  if v_name is null then
    raise exception 'A provider needs a name.' using errcode = 'P0001';
  end if;

  if exists (select 1 from public.agency_service_providers where code = v_code) then
    raise exception
      'A provider with the code % is already registered. Edit that one, or choose another code.',
      v_code
      using errcode = 'P0001';
  end if;

  -- --- The classification --------------------------------------------------
  -- Checked here, before the accounts are looked up, so the refusal names the
  -- argument that was wrong rather than reporting a missing ledger account.
  if p_category is null
     or public.agency_category_income_code(p_category) is null then
    raise exception
      '% is not a provider category. Use one of: mobile_money, agency_banking, utility, school_fees, tv_subscription, airtime_data, other.',
      coalesce(p_category, 'nothing')
      using errcode = 'P0001';
  end if;

  if p_float_model is null or p_float_model not in ('provider_float', 'cash_payable') then
    raise exception
      'A provider either holds electronic float the partner advanced (provider_float) or holds the customer''s cash and owes it onward (cash_payable). % is neither.',
      coalesce(p_float_model, 'nothing')
      using errcode = 'P0001';
  end if;

  if p_commission_model is null or p_commission_model not in ('immediate', 'deferred') then
    raise exception
      'Commission is recognised either at the point of sale (immediate) or accrued and cleared when the partner remits (deferred). % is neither.',
      coalesce(p_commission_model, 'nothing')
      using errcode = 'P0001';
  end if;

  if p_commission_source is null or p_commission_source not in ('configured', 'reported') then
    raise exception
      'Commission is either computed from terms held here (configured) or read off the partner''s statement (reported). % is neither.',
      coalesce(p_commission_source, 'nothing')
      using errcode = 'P0001';
  end if;

  -- --- The commission proposal --------------------------------------------
  -- A `reported` provider must carry no rate: there is a CHECK that says so,
  -- and a clear sentence beats a constraint violation three frames down.
  if p_commission_source = 'reported'
     and (p_commission_rate_bps is not null or p_commission_fixed is not null) then
    raise exception
      '% reports its own commission, so no rate is held here. Register it with no rate, or record the terms as configured.',
      v_name
      using errcode = 'P0001';
  end if;

  if p_commission_rate_bps is not null
     and (p_commission_rate_bps < 0 or p_commission_rate_bps > 10000) then
    -- `p_commission_rate_bps` is kept off the start of its line deliberately.
    -- `tests/integration/migrations.test.ts` reads a line that begins with a
    -- `_bps` identifier as a column declaration and asserts the next word is
    -- `integer`; a line holding only this argument makes it read `using` as
    -- that column's type and fail. The rule it is enforcing is a good one, so
    -- the formatting bends rather than the rule.
    raise exception
      'A commission rate of % basis points is not a rate: 0 to 10000 basis points is 0%% to 100%%.', p_commission_rate_bps
      using errcode = 'P0001';
  end if;

  if p_commission_fixed is not null and p_commission_fixed < 0 then
    raise exception 'A fixed commission cannot be negative.' using errcode = 'P0001';
  end if;

  -- --- The accounts -------------------------------------------------------
  v_income_cd := public.agency_category_income_code(p_category);

  select la.id into v_income
  from public.ledger_accounts la
  where la.code = v_income_cd and la.is_postable and la.status = 'active';

  if v_income is null then
    raise exception
      'The chart of accounts has no active, postable account % for % commission, so there is nowhere to recognise it.',
      v_income_cd, p_category
      using errcode = 'P0001';
  end if;

  if p_float_model = 'cash_payable' then
    v_payable_cd := public.agency_category_payable_code(p_category);

    select la.id into v_payable
    from public.ledger_accounts la
    where la.code = v_payable_cd and la.is_postable and la.status = 'active';

    if v_payable is null then
      raise exception
        'The chart of accounts has no active, postable liability % to hold the customer''s money for %, so a cash-payable provider cannot be registered against it.',
        v_payable_cd, p_category
        using errcode = 'P0001';
    end if;
  end if;

  -- --- The row ------------------------------------------------------------
  -- `is_provisional` and `is_active` are written here and are not arguments.
  -- Registration records a partner; it does not switch on its money.
  insert into public.agency_service_providers (
    code, name, category, float_model,
    income_account_id, payable_account_id,
    commission_model, commission_source,
    commission_rate_bps, commission_fixed,
    is_provisional, is_active,
    terms_reference, registered_by, registered_at
  )
  values (
    v_code, v_name, p_category, p_float_model,
    v_income, v_payable,
    p_commission_model, p_commission_source,
    p_commission_rate_bps, p_commission_fixed,
    true, false,
    v_ref, v_actor, pg_catalog.now()
  )
  returning id into v_id;

  return v_id;
end;
$$;

comment on function public.register_agency_provider(
  text, text, text, text, text, text, integer, bigint, text) is
  'Operational task 1. Registers an agency provider — a partner bank, a mobile money operator, a biller — as provisional and inactive, with its ledger accounts derived from its category rather than chosen by the caller. Requires agency:providers. Posts nothing, activates nothing: agency_transaction_live_readiness_guard() refuses every posting against the row until its terms are approved and it is separately made live.';

revoke all on function public.register_agency_provider(
  text, text, text, text, text, text, integer, bigint, text)
  from public, anon, authenticated;
grant execute on function public.register_agency_provider(
  text, text, text, text, text, text, integer, bigint, text)
  to authenticated;


-- ---------------------------------------------------------------------------
-- 5. `revise_agency_provider_terms()`
--
-- A mistyped rate, before anyone approved it. Permitted only while the
-- provider is still provisional, which is the whole of its life before §6.
--
-- Revising *approved* terms is refused, and the refusal says what to do
-- instead rather than pretending the operation does not exist. Re-negotiating
-- a live partner's commission is a real business event, but it is not this
-- function: it needs the provider taken out of service, the terms amended and
-- re-approved, and a decision about the transactions already posted under the
-- old rate. None of that is a side effect of an UPDATE, and inventing it here
-- would be the one thing this migration exists to prevent.
-- ---------------------------------------------------------------------------

create or replace function public.revise_agency_provider_terms(
  p_provider_id         uuid,
  p_commission_model    text    default null,
  p_commission_source   text    default null,
  p_commission_rate_bps integer default null,
  p_commission_fixed    bigint  default null,
  p_terms_reference     text    default null,
  p_clear_rate          boolean default false,
  p_clear_fixed         boolean default false
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  pr        public.agency_service_providers;
  v_model   text;
  v_source  text;
  v_rate    integer;
  v_fixed   bigint;
  v_ref     text;
begin
  if auth.uid() is not null
     and not (select public.user_has_permission('agency:providers')) then
    raise exception 'Not authorized to revise an agency provider''s terms.'
      using errcode = '42501';
  end if;

  -- Locked: a revision and an approval racing on one row must not interleave,
  -- or the approval could confirm the rate it did not read.
  select * into pr from public.agency_service_providers
  where id = p_provider_id for update;

  if pr.id is null then
    raise exception 'No such agency provider.' using errcode = 'P0001';
  end if;

  if not pr.is_provisional then
    raise exception
      '%''s terms are approved, so they are the terms its postings cite and are not edited here. Amending a partner''s commission is a re-negotiation: it needs the provider taken out of service and its new terms approved on their own merits.',
      pr.name
      using errcode = 'P0001';
  end if;

  -- NULL means "leave this alone", which is what makes a partial edit
  -- possible. Clearing a rate is therefore an explicit flag rather than a
  -- NULL that cannot be told from an omission.
  v_model  := coalesce(nullif(pg_catalog.btrim(coalesce(p_commission_model, '')), ''),
                       pr.commission_model);
  v_source := coalesce(nullif(pg_catalog.btrim(coalesce(p_commission_source, '')), ''),
                       pr.commission_source);
  v_rate   := case when p_clear_rate then null
                   else coalesce(p_commission_rate_bps, pr.commission_rate_bps) end;
  v_fixed  := case when p_clear_fixed then null
                   else coalesce(p_commission_fixed, pr.commission_fixed) end;
  v_ref    := coalesce(nullif(pg_catalog.btrim(coalesce(p_terms_reference, '')), ''),
                       pr.terms_reference);

  if v_model not in ('immediate', 'deferred') then
    raise exception
      'Commission is recognised either at the point of sale (immediate) or accrued and cleared when the partner remits (deferred). % is neither.',
      v_model
      using errcode = 'P0001';
  end if;

  if v_source not in ('configured', 'reported') then
    raise exception
      'Commission is either computed from terms held here (configured) or read off the partner''s statement (reported). % is neither.',
      v_source
      using errcode = 'P0001';
  end if;

  if v_source = 'reported' and (v_rate is not null or v_fixed is not null) then
    raise exception
      '% reports its own commission, so no rate is held here. Clear the rate in the same revision that records the change.',
      pr.name
      using errcode = 'P0001';
  end if;

  if v_rate is not null and (v_rate < 0 or v_rate > 10000) then
    raise exception
      'A commission rate of % basis points is not a rate: 0 to 10000 basis points is 0%% to 100%%.',
      v_rate
      using errcode = 'P0001';
  end if;

  if v_fixed is not null and v_fixed < 0 then
    raise exception 'A fixed commission cannot be negative.' using errcode = 'P0001';
  end if;

  update public.agency_service_providers
     set commission_model    = v_model,
         commission_source   = v_source,
         commission_rate_bps = v_rate,
         commission_fixed    = v_fixed,
         terms_reference     = v_ref,
         updated_at          = pg_catalog.now()
   where id = p_provider_id;
end;
$$;

comment on function public.revise_agency_provider_terms(
  uuid, text, text, integer, bigint, text, boolean, boolean) is
  'Operational task 1. Corrects the proposed commercial terms of a provider whose terms are not yet approved. Requires agency:providers, locks the row so a revision cannot race an approval, and refuses a confirmed provider outright — amending a live partner''s commission is a re-negotiation, not an edit.';

revoke all on function public.revise_agency_provider_terms(
  uuid, text, text, integer, bigint, text, boolean, boolean)
  from public, anon, authenticated;
grant execute on function public.revise_agency_provider_terms(
  uuid, text, text, integer, bigint, text, boolean, boolean)
  to authenticated;


-- ---------------------------------------------------------------------------
-- 6. `approve_agency_provider_terms()`
--
-- The control. A second person, holding `agency:provider_approval`, confirms
-- the terms against the signed agreement and clears `is_provisional`.
--
-- It does not make the provider live. `is_active` is untouched here, and
-- deliberately: approving what a partner pays and deciding that POLYTOS is
-- ready to transact on that partner's behalf are two judgements, and the
-- second one has preconditions of its own — an agent account to transact
-- through, approved limits, a funded float facility — that this function has
-- no business asserting.
-- ---------------------------------------------------------------------------

create or replace function public.approve_agency_provider_terms(
  p_provider_id     uuid,
  p_terms_reference text default null,
  p_note            text default null
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor uuid;
  pr      public.agency_service_providers;
  v_ref   text;
  v_note  text;
begin
  if auth.uid() is not null
     and not (select public.user_has_permission('agency:provider_approval')) then
    raise exception 'Not authorized to approve an agency provider''s commercial terms.'
      using errcode = '42501';
  end if;

  v_actor := public.current_profile_id();

  select * into pr from public.agency_service_providers
  where id = p_provider_id for update;

  if pr.id is null then
    raise exception 'No such agency provider.' using errcode = 'P0001';
  end if;

  if not pr.is_provisional then
    raise exception
      '%''s terms were already approved. There is nothing further to confirm.', pr.name
      using errcode = 'P0001';
  end if;

  -- Maker-checker. SD001 so the application can tell this apart from an RLS
  -- denial and say "ask a colleague" rather than "privilege denied" —
  -- migration 20261121000100 records why the code exists.
  if v_actor is not null and pr.registered_by is not null and v_actor = pr.registered_by then
    raise exception
      'You registered %, so you cannot approve its commercial terms. A different Owner or Administrator must.',
      pr.name
      using errcode = 'SD001';
  end if;

  v_ref  := coalesce(nullif(pg_catalog.btrim(coalesce(p_terms_reference, '')), ''),
                     pr.terms_reference);
  v_note := nullif(pg_catalog.btrim(coalesce(p_note, '')), '');

  if v_ref is null then
    raise exception
      'Approving %''s terms needs the reference of the signed agreement they were checked against. POLYTOS does not hold the document, so the record has to say where it is.',
      pr.name
      using errcode = 'P0001';
  end if;

  -- What the readiness guard will demand later, refused here instead, where
  -- the person can still do something about it. A confirmed provider with no
  -- commission basis would be one Phase 4B recognises income from nothing on.
  if pr.commission_source = 'configured'
     and pr.commission_rate_bps is null
     and pr.commission_fixed is null then
    raise exception
      '% records no commission rate and no fixed commission, so there is nothing to approve. Record its terms first, or register that it reports its own commission.',
      pr.name
      using errcode = 'P0001';
  end if;

  update public.agency_service_providers
     set is_provisional      = false,
         terms_reference     = v_ref,
         terms_approved_by   = v_actor,
         terms_approved_at   = pg_catalog.now(),
         terms_approval_note = v_note,
         updated_at          = pg_catalog.now()
   where id = p_provider_id;
end;
$$;

comment on function public.approve_agency_provider_terms(uuid, text, text) is
  'Operational task 1. A second person confirms a registered provider''s commission terms against the signed agreement, which clears is_provisional. Requires agency:provider_approval, refuses the profile that registered the provider with SQLSTATE SD001, and requires the agreement''s reference. Does not activate the provider: is_active is untouched.';

revoke all on function public.approve_agency_provider_terms(uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.approve_agency_provider_terms(uuid, text, text)
  to authenticated;


-- ---------------------------------------------------------------------------
-- 7. Index
--
-- The registration screen's one list: what is waiting for approval.
-- ---------------------------------------------------------------------------

create index agency_providers_awaiting_approval_idx
  on public.agency_service_providers (is_provisional, category, code)
  where is_provisional;
