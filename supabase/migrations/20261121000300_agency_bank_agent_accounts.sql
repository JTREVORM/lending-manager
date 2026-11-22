-- ===========================================================================
-- Operational task 2 — a bank's agent accounts: its account numbers, its
-- agent identifiers, and as many locations as it has
--
-- ## The gap this closes
--
-- `agency_provider_float_accounts` is the register of agent accounts. Every
-- row in it owns exactly one `1320` ledger account holding electronic float,
-- because `ledger_account_id` is `NOT NULL` and
-- `ensure_agency_float_account()` mints the account as part of registering
-- the line. For MTN, Airtel, and for a bank that genuinely advances float,
-- that is right.
--
-- For a partner on the `cash_payable` model it is not merely wrong, it is
-- impossible: `ensure_agency_float_account()` refuses outright —
--
--   > % settles through a payable account, not float, so it has no till.
--
-- and so a `cash_payable` partner **cannot have an agent account at all**.
-- Not a location, not an account number, not an agent identifier, not a
-- staff roster. `SCHOOL_FEES` has shipped in the catalogue since Phase 4A
-- with nowhere to record which of its collection points is which.
--
-- The tempting fix is the wrong one. Giving such a partner a `1320` float
-- account to hang its identity on would put an asset on the balance sheet
-- that does not exist: POLYTOS holds no electronic float for a school, it
-- holds the parent's cash and owes it onward. That float account would start
-- at zero, never move, and reconcile to nothing — an asset line that exists
-- only to satisfy a `NOT NULL`. This migration therefore makes the float
-- account **optional**, and conditional on the thing that decides whether it
-- is real.
--
-- ## The invariant
--
-- For an agent account that is **open** (active or suspended):
--
--   * the provider advances float (`provider_float`) ⟺ the account owns
--     exactly one `1320` float ledger account, branch-matched and postable;
--   * the provider holds the customer's cash (`cash_payable`) ⟺ the account
--     owns **no** ledger account, and carries the partner's account number
--     instead, because with no float account the account number is the only
--     thing that identifies where the money is owed.
--
-- A **closed** account is exempt. It is history: its ledger account, if it
-- had one, holds posted entries that must stay reachable, and the provider's
-- model may legitimately have changed since. `set_agency_provider_float_model()`
-- is tightened below so the two sides cannot drift while an account is open.
--
-- ## What is new, and what is only now reachable
--
-- New: `bank_account_number`, the number the partner itself identifies this
-- account by, unique per provider. Banks identify an agent outlet by account
-- number; `line_msisdn` is a mobile money line's identity and is the wrong
-- shape for one (`^\+256[0-9]{9}$`).
--
-- Only now reachable: multiple locations per partner, for `cash_payable` as
-- well as `provider_float`. The register has been keyed
-- `(provider_id, branch_id, till_name)` since Phase 4A, so several accounts
-- per partner per branch — and across branches — was always the design. What
-- was missing was the ability to open one at all without float.
--
-- ## Preserved
--
-- `ensure_agency_float_account()` is **not** touched: it still refuses a
-- `cash_payable` provider, and `tests/db/agency-money-float.test.ts` still
-- asserts that refusal. Minting a float account is a float operation and has
-- no business becoming polymorphic. `register_agency_agent_line()` is what
-- learns the difference, and it calls `ensure_agency_float_account()`
-- unchanged on the float path.
--
-- No existing column becomes required. `agent_code` and `line_msisdn` stay
-- optional exactly as they were, so every fixture and every live row keeps
-- validating. The only new requirement falls on rows that could not exist
-- before this migration.
--
-- Every float-only child table — replenishments, reconciliations, trades —
-- gains a guard refusing an account with no float account, so widening the
-- register cannot widen what can be done to a float that is not there.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- 1. The partner's own account number
-- ---------------------------------------------------------------------------

alter table public.agency_provider_float_accounts
  add column bank_account_number text;

comment on column public.agency_provider_float_accounts.bank_account_number is
  'Operational task 2. The number the partner identifies this agent account by — a bank account number, a collection account, a merchant code. Unique per provider. Required for an open cash_payable account, where there is no float ledger account and this is the only identification of where the money is owed; optional for a float account, which is identified by its own 1320 code.';

-- Account numbers are printed on paper and typed in from it, so the shape is
-- permissive about separators and strict about everything else. Not a regex
-- on digits alone: Ugandan bank account numbers run 10 to 16 digits, merchant
-- and agent codes mix letters, and a rule that refuses a real number is worse
-- than one that accepts an odd-looking one.
alter table public.agency_provider_float_accounts
  add constraint agency_float_bank_account_shape
  check (bank_account_number is null
         or (pg_catalog.btrim(bank_account_number) = bank_account_number
             and bank_account_number ~ '^[A-Za-z0-9][A-Za-z0-9 /-]{2,39}$'));

-- Two accounts of one partner cannot be the same account. Partial, like the
-- `agent_code` index beside it, because most rows legitimately have none.
create unique index agency_float_bank_account_unique
  on public.agency_provider_float_accounts (provider_id, bank_account_number)
  where bank_account_number is not null;


-- ---------------------------------------------------------------------------
-- 2. The float account becomes optional
--
-- `unique` is kept: two agent accounts sharing one float account could each
-- spend the other's balance, which is the reason Phase 4A gave for the
-- constraint and has not changed. A unique index ignores NULLs, so any number
-- of cash-payable accounts can carry none.
-- ---------------------------------------------------------------------------

alter table public.agency_provider_float_accounts
  alter column ledger_account_id drop not null;


-- ---------------------------------------------------------------------------
-- 3. The guard learns the provider's model
--
-- Replaces the Phase 4A guard. Every check it made on the float path is
-- carried across unchanged; what is added is the branch on `float_model` and
-- the two refusals that keep the invariant in §0 true.
--
-- The model-shape rule is skipped for a closed account, so closing one never
-- fails on a rule about what it should have been while it was open.
-- ---------------------------------------------------------------------------

create or replace function public.agency_float_account_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  a  record;
  pr record;
begin
  select p.float_model, p.name, p.category into pr
  from public.agency_service_providers p where p.id = new.provider_id;

  if pr is null then
    raise exception 'No such agency provider.' using errcode = 'P0001';
  end if;

  -- --- A closed account is history, not configuration ---------------------
  if new.status = 'closed' then
    return new;
  end if;

  -- --- The partner holds the customer's cash: no float account ------------
  if pr.float_model = 'cash_payable' then
    if new.ledger_account_id is not null then
      raise exception
        '% holds the customer''s cash and owes it onward, so its agent accounts hold no electronic float. This one may not own a float account.',
        pr.name
        using errcode = 'P0001';
    end if;

    if pg_catalog.btrim(coalesce(new.bank_account_number, '')) = '' then
      raise exception
        'An agent account for % has no float account, so it needs the account number the partner identifies it by: with no float account that is the only record of where the money is owed.',
        pr.name
        using errcode = 'P0001';
    end if;

    return new;
  end if;

  -- --- The partner advances float: exactly one real float account ---------
  if new.ledger_account_id is null then
    raise exception
      '% advances electronic float, so each of its agent accounts owns one float account. Register the account through register_agency_agent_line(), which mints it.',
      pr.name
      using errcode = 'P0001';
  end if;

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

comment on function public.agency_float_account_guard() is
  'Phase 4A, widened by operational task 2. Holds the agent-account register to its provider''s model: a provider_float partner''s open account owns exactly one branch-matched, postable 1320 float account; a cash_payable partner''s open account owns none and carries the partner''s own account number instead. A closed account is exempt, being history rather than configuration.';

revoke all on function public.agency_float_account_guard()
  from public, anon, authenticated;


-- ---------------------------------------------------------------------------
-- 4. The immutability trigger stops assuming a ledger account
--
-- Its till-name refusal named the ledger account's code, which is NULL for an
-- account that has none — producing "A till name is part of its ledger
-- account code (<nothing>)". The rule is unchanged; the sentence now says
-- which account it is about either way.
--
-- `ledger_account_id` stays immutable, which is what stops a cash-payable
-- account from quietly acquiring a float account later, or a float account
-- from being re-pointed at another.
-- ---------------------------------------------------------------------------

create or replace function public.agency_float_account_immutable_identity()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.till_name is distinct from old.till_name then
    -- The float case keeps its original sentence, word for word: the till
    -- name really is embedded in the `1320.{PROVIDER}.{BRANCH}` code, and
    -- naming that code is the useful part of the refusal.
    if old.ledger_account_id is not null then
      raise exception
        'A till name is part of its ledger account code (%), so it cannot be renamed. Create a new line and close this one.',
        (select a.code from public.ledger_accounts a where a.id = old.ledger_account_id)
        using errcode = 'P0001';
    end if;

    -- A cash-payable account has no such code. The rule is the same — the
    -- name is referenced by the staff roster, the audit trail and whatever
    -- the partner has on its own records — but the old sentence would have
    -- said "part of its ledger account code (<nothing>)".
    raise exception
      'The name of agent account % is part of its identity, so it cannot be renamed. Open a new account and close this one.',
      old.till_name
      using errcode = 'P0001';
  end if;

  if new.ledger_account_id is distinct from old.ledger_account_id then
    raise exception
      'An agent account cannot be re-pointed at a different ledger account: the posted history belongs to the account it has.'
      using errcode = 'P0001';
  end if;

  if new.provider_id is distinct from old.provider_id
     or new.branch_id is distinct from old.branch_id then
    raise exception
      'An agent account cannot be moved to another provider or branch.'
      using errcode = 'P0001';
  end if;

  return new;
end;
$$;

revoke all on function public.agency_float_account_immutable_identity()
  from public, anon, authenticated;


-- ---------------------------------------------------------------------------
-- 5. Float operations require a float account
--
-- Widening the register means the three float-only child tables can now be
-- handed an account that owns no float. Each of their functions would fail on
-- the NULL somewhere downstream, with a message about a ledger account rather
-- than about the account the user named. A trigger on each table refuses it
-- first, in one sentence, and — being a trigger — refuses it however the row
-- arrives.
-- ---------------------------------------------------------------------------

create or replace function public.agency_requires_float_account()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id   uuid;
  v_name text;
begin
  -- Every table this guards names the account `float_account_id`; trades also
  -- carry a counter account. Both are checked, in that order.
  foreach v_id in array array[
    (pg_catalog.to_jsonb(new) ->> 'float_account_id')::uuid,
    (pg_catalog.to_jsonb(new) ->> 'counter_float_account_id')::uuid
  ]
  loop
    continue when v_id is null;

    select p.name into v_name
    from public.agency_provider_float_accounts f
    join public.agency_service_providers p on p.id = f.provider_id
    where f.id = v_id and f.ledger_account_id is null;

    if v_name is not null then
      raise exception
        '% holds the customer''s cash rather than electronic float, so that agent account has no float to purchase, replenish, trade or reconcile.',
        v_name
        using errcode = 'P0001';
    end if;
  end loop;

  return new;
end;
$$;

comment on function public.agency_requires_float_account() is
  'Operational task 2. Refuses a float replenishment, float reconciliation or float trade against an agent account that owns no float ledger account — which operational task 2 made possible for cash_payable partners. A trigger rather than a check inside each function, so it holds however the row arrives.';

revoke all on function public.agency_requires_float_account()
  from public, anon, authenticated;

create trigger agency_float_replenishments_require_float
  before insert or update on public.agency_float_replenishments
  for each row execute function public.agency_requires_float_account();

create trigger agency_float_reconciliations_require_float
  before insert or update on public.agency_float_reconciliations
  for each row execute function public.agency_requires_float_account();

create trigger agency_float_trades_require_float
  before insert or update on public.agency_float_trades
  for each row execute function public.agency_requires_float_account();


-- ---------------------------------------------------------------------------
-- 6. A model change cannot strand an open account
--
-- `set_agency_provider_float_model()` already refuses a confirmed provider, a
-- provider with transactions in any state, a provider still owing a payable
-- and a provider holding float. What it did not check is the register itself:
-- flipping a provisional provider's model while it has open agent accounts
-- would leave each of them on the wrong side of §2's invariant — a float
-- account under a partner that advances no float, or a bank account number
-- under one that does.
--
-- The function is replaced from the definition the database holds, with one
-- check inserted before the model change and nothing else altered.
-- ---------------------------------------------------------------------------

create or replace function public.set_agency_provider_float_model(
  p_provider_id uuid,
  p_float_model text,
  p_payable_account_id uuid default null,
  p_reason text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  pr          public.agency_service_providers;
  v_old       text;
  v_old_pay   uuid;
  v_posted    bigint;
  v_inflight  bigint;
  v_payable   bigint;
  v_float     bigint;
  v_open      bigint;
begin
  if auth.uid() is not null
     and not (select public.user_has_permission('agency:providers')) then
    raise exception
      'Not authorized to configure agency providers.'
      using errcode = '42501';
  end if;

  if p_float_model is null or p_float_model not in ('provider_float', 'cash_payable') then
    raise exception
      'A float model is either provider_float, where the provider advances electronic float, or cash_payable, where the company holds the customer''s cash and owes it onward.'
      using errcode = 'P0001';
  end if;

  select * into pr from public.agency_service_providers where id = p_provider_id;
  if pr.id is null then
    raise exception 'No such agency provider.' using errcode = 'P0001';
  end if;

  if pr.float_model = p_float_model then
    raise exception '% already holds its money as %.', pr.name, p_float_model
      using errcode = 'P0001';
  end if;

  if not pr.is_provisional then
    raise exception
      '% is confirmed. Its float model decides where every posted transaction put the money, so it cannot be changed by configuration: settle the position it holds under the present model first, then make the change as a deliberate decision with its own authority.',
      pr.name
      using errcode = 'P0001';
  end if;

  select pg_catalog.count(*) into v_posted
    from public.agency_transactions t
   where t.provider_id = p_provider_id
     and t.status in ('posted', 'reversed');

  if v_posted > 0 then
    raise exception
      '% has % posted or reversed transaction(s) against it, which the readiness guard should have made impossible while it is provisional. Its float model is not safe to change until that is explained.',
      pr.name, v_posted
      using errcode = 'P0001';
  end if;

  select pg_catalog.count(*) into v_inflight
    from public.agency_transactions t
   where t.provider_id = p_provider_id
     and t.status in ('draft', 'awaiting_verification');

  if v_inflight > 0 then
    raise exception
      '% has % transaction(s) recorded and not yet resolved. Each was entered expecting the present posting path, so cancel or post them before the model changes.',
      pr.name, v_inflight
      using errcode = 'P0001';
  end if;

  select coalesce(pg_catalog.sum(jl.credit - jl.debit), 0) into v_payable
    from public.journal_entries je
    join public.journal_lines jl on jl.entry_id = je.id
    join public.ledger_accounts la on la.id = jl.account_id
   where je.source_type in ('agency_transaction', 'agency_transaction_reversal',
                            'agency_payable_settlement',
                            'agency_payable_settlement_reversal')
     and la.account_type = 'liability'
     and je.source_id in (
       select t.id from public.agency_transactions t where t.provider_id = p_provider_id
       union all
       select s.id from public.agency_payable_settlements s where s.provider_id = p_provider_id
     );

  if v_payable <> 0 then
    raise exception
      '% still owes % shillings onward. Remit it before changing where its money sits.',
      pr.name, v_payable
      using errcode = 'P0001';
  end if;

  select coalesce(pg_catalog.sum(coalesce(b.balance, 0)), 0) into v_float
    from public.agency_provider_float_accounts f
    left join public.ledger_account_balances b on b.account_id = f.ledger_account_id
   where f.provider_id = p_provider_id;

  if v_float <> 0 then
    raise exception
      '% holds % shillings of electronic float across its agent accounts. Sell or transfer it off before changing where its money sits.',
      pr.name, v_float
      using errcode = 'P0001';
  end if;

  -- Operational task 2. The register has to follow the model, and an open
  -- account cannot be rewritten to the other shape: `ledger_account_id` is
  -- immutable, and whether it is populated is exactly what the model decides.
  select pg_catalog.count(*) into v_open
    from public.agency_provider_float_accounts f
   where f.provider_id = p_provider_id
     and f.status <> 'closed';

  if v_open > 0 then
    raise exception
      '% has % open agent account(s), and whether an agent account holds electronic float is decided by this very setting. Close them first; their history is kept.',
      pr.name, v_open
      using errcode = 'P0001';
  end if;

  if p_float_model = 'cash_payable' and p_payable_account_id is null then
    raise exception
      'A cash_payable provider holds the customer''s money and must name the liability it is owed on. Name a postable liability account.'
      using errcode = 'P0001';
  end if;

  v_old     := pr.float_model;
  v_old_pay := pr.payable_account_id;

  update public.agency_service_providers
     set float_model        = p_float_model,
         payable_account_id = case
                                when p_float_model = 'cash_payable'
                                then p_payable_account_id
                                else null
                              end,
         updated_at         = pg_catalog.now()
   where id = p_provider_id;

  perform public.record_audit_event(
    'agency_provider.float_model_set',
    'agency_provider',
    p_provider_id::text,
    pg_catalog.jsonb_build_object(
      'float_model', v_old, 'payable_account_id', v_old_pay),
    pg_catalog.jsonb_build_object(
      'float_model', p_float_model,
      'payable_account_id', case
                              when p_float_model = 'cash_payable'
                              then p_payable_account_id
                              else null
                            end),
    pg_catalog.jsonb_build_object(
      'provider_code', pr.code,
      'category',      pr.category,
      'reason',        nullif(pg_catalog.btrim(coalesce(p_reason, '')), '')),
    null);

  return p_provider_id;
end;
$$;

comment on function public.set_agency_provider_float_model(uuid, text, uuid, text) is
  'Owner decision 1, tightened by operational task 2. Corrects where a provisional provider''s money sits. Refuses a confirmed provider, one with transactions in any state, one still owing a payable, one holding float, and — new — one with open agent accounts, because whether an agent account owns a float ledger account is decided by this setting and cannot be rewritten afterwards.';

revoke all on function public.set_agency_provider_float_model(uuid, text, uuid, text)
  from public, anon;
grant execute on function public.set_agency_provider_float_model(uuid, text, uuid, text)
  to authenticated;


-- ---------------------------------------------------------------------------
-- 7. Registering an agent account, on either model
--
-- The 8-argument form is dropped rather than left beside a 9-argument one:
-- two overloads differing by a trailing default is how a caller ends up
-- invoking the one it did not mean. Its grants are restated below.
-- ---------------------------------------------------------------------------

drop function if exists public.register_agency_agent_line(
  uuid, uuid, text, text, text, text, date, text);

create or replace function public.register_agency_agent_line(
  p_provider_id        uuid,
  p_branch_id          uuid,
  p_till_name          text,
  p_label              text default null,
  p_line_msisdn        text default null,
  p_agent_code         text default null,
  p_opened_on          date default null,
  p_notes              text default null,
  p_bank_account_number text default null
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor uuid;
  v_till  text;
  v_id    uuid;
  pr      public.agency_service_providers;
begin
  if auth.uid() is not null
     and not (select public.user_has_permission('agency:providers')) then
    raise exception 'Not authorized to register an agent line.'
      using errcode = '42501';
  end if;

  v_actor := public.current_profile_id();
  v_till := nullif(pg_catalog.btrim(coalesce(p_till_name, '')), '');
  if v_till is null then
    raise exception 'An agent line needs a till name.' using errcode = 'P0001';
  end if;

  select * into pr from public.agency_service_providers where id = p_provider_id;
  if pr.id is null then
    raise exception 'No such agency provider.' using errcode = 'P0001';
  end if;

  if exists (
    select 1 from public.agency_provider_float_accounts a
     where a.provider_id = p_provider_id
       and a.branch_id = p_branch_id
       and a.till_name = v_till
  ) then
    raise exception
      '% already has a line called % at that branch. Edit it, or choose another till name.',
      pr.name, v_till
      using errcode = 'P0001';
  end if;

  if pr.float_model = 'cash_payable' then
    -- No float account is minted, and none is wanted: this partner's money is
    -- the customer's cash and the liability it is owed on, both of which
    -- already exist on the provider. What is registered here is the account's
    -- identity and its location. The guard requires the account number.
    insert into public.agency_provider_float_accounts (
      provider_id, branch_id, ledger_account_id, till_name,
      label, line_msisdn, agent_code, bank_account_number,
      opened_on, notes, updated_by
    )
    values (
      p_provider_id, p_branch_id, null, v_till,
      coalesce(nullif(pg_catalog.btrim(coalesce(p_label, '')), ''), ''),
      nullif(pg_catalog.btrim(coalesce(p_line_msisdn, '')), ''),
      nullif(pg_catalog.btrim(coalesce(p_agent_code, '')), ''),
      nullif(pg_catalog.btrim(coalesce(p_bank_account_number, '')), ''),
      coalesce(p_opened_on, public.business_date()),
      nullif(pg_catalog.btrim(coalesce(p_notes, '')), ''),
      v_actor
    )
    returning id into v_id;

    return v_id;
  end if;

  -- The float path, unchanged: `ensure_agency_float_account()` mints the 1320
  -- account and the register row together, then the identity is written over
  -- it in the same transaction.
  v_id := public.ensure_agency_float_account(p_provider_id, p_branch_id, v_till);

  update public.agency_provider_float_accounts
     set label               = coalesce(nullif(pg_catalog.btrim(coalesce(p_label, '')), ''), ''),
         line_msisdn         = nullif(pg_catalog.btrim(coalesce(p_line_msisdn, '')), ''),
         agent_code          = nullif(pg_catalog.btrim(coalesce(p_agent_code, '')), ''),
         bank_account_number = nullif(pg_catalog.btrim(coalesce(p_bank_account_number, '')), ''),
         opened_on           = coalesce(p_opened_on, public.business_date()),
         notes               = nullif(pg_catalog.btrim(coalesce(p_notes, '')), ''),
         updated_by          = v_actor,
         updated_at          = now()
   where id = v_id;

  return v_id;
end;
$$;

comment on function public.register_agency_agent_line(
  uuid, uuid, text, text, text, text, date, text, text) is
  'Phase 4E, widened by operational task 2. Registers an agent account on either model: a provider_float partner''s account mints its 1320 ledger account through ensure_agency_float_account(); a cash_payable partner''s account mints none, because POLYTOS holds no float for it, and carries the partner''s own account number instead. Owner-only, audited by the configuration trigger, and refuses a till name the provider already uses at that branch.';

revoke all on function public.register_agency_agent_line(
  uuid, uuid, text, text, text, text, date, text, text)
  from public, anon, authenticated;
grant execute on function public.register_agency_agent_line(
  uuid, uuid, text, text, text, text, date, text, text)
  to authenticated;


-- ---------------------------------------------------------------------------
-- 8. Editing the identity, including the account number
--
-- Same shape as the 5-argument form it replaces: NULL leaves a field alone,
-- an empty string clears it. An account number may be cleared only where the
-- guard does not require one, which is the float path — a cash-payable
-- account that cleared its number would be a record of money owed to nobody
-- identifiable, and the guard refuses it.
-- ---------------------------------------------------------------------------

drop function if exists public.update_agency_agent_line(uuid, text, text, text, text);

create or replace function public.update_agency_agent_line(
  p_float_account_id    uuid,
  p_label               text default null,
  p_line_msisdn         text default null,
  p_agent_code          text default null,
  p_notes               text default null,
  p_bank_account_number text default null
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor uuid;
  f       record;
begin
  if auth.uid() is not null
     and not (select public.user_has_permission('agency:providers')) then
    raise exception 'Not authorized to edit an agent line.' using errcode = '42501';
  end if;

  v_actor := public.current_profile_id();

  select a.id, a.branch_id, a.status into f
  from public.agency_provider_float_accounts a where a.id = p_float_account_id;

  if f.id is null or not public.user_can_see_branch(f.branch_id) then
    raise exception 'No such agent line.' using errcode = 'P0001';
  end if;

  if f.status = 'closed' then
    raise exception
      'That agent line is closed, so its details are history and are not edited.'
      using errcode = 'P0001';
  end if;

  update public.agency_provider_float_accounts
     set label = case
                   when p_label is null then label
                   else coalesce(nullif(pg_catalog.btrim(p_label), ''), '')
                 end,
         line_msisdn = case
                         when p_line_msisdn is null then line_msisdn
                         else nullif(pg_catalog.btrim(p_line_msisdn), '')
                       end,
         agent_code = case
                        when p_agent_code is null then agent_code
                        else nullif(pg_catalog.btrim(p_agent_code), '')
                      end,
         bank_account_number = case
                                 when p_bank_account_number is null then bank_account_number
                                 else nullif(pg_catalog.btrim(p_bank_account_number), '')
                               end,
         notes = case
                   when p_notes is null then notes
                   else nullif(pg_catalog.btrim(p_notes), '')
                 end,
         updated_by = v_actor,
         updated_at = now()
   where id = p_float_account_id;
end;
$$;

comment on function public.update_agency_agent_line(uuid, text, text, text, text, text) is
  'Phase 4E, widened by operational task 2. Edits an open agent account''s identity, including the partner''s own account number. NULL leaves a field alone and an empty string clears it; the account-number guard refuses clearing it on a cash_payable account, which has nothing else identifying where the money is owed.';

revoke all on function public.update_agency_agent_line(uuid, text, text, text, text, text)
  from public, anon, authenticated;
grant execute on function public.update_agency_agent_line(uuid, text, text, text, text, text)
  to authenticated;


-- ---------------------------------------------------------------------------
-- 9. The register, as a screen reads it
--
-- `agency_float_balances` cannot serve this: it joins `ledger_accounts`
-- through `ledger_account_id`, so a cash-payable account is excluded from it
-- — correctly, because it has no float balance to report. This view is the
-- register itself: who the partner is, where the account is, what the partner
-- calls it, and whether it holds float at all.
--
-- `security_invoker` so the caller's RLS on the underlying tables decides what
-- they see, which is how every agency view in this schema is built.
-- ---------------------------------------------------------------------------

create view public.agency_agent_account_register
with (security_invoker = true) as
select
  f.id                                   as agent_account_id,
  f.provider_id,
  p.code                                 as provider_code,
  p.name                                 as provider_name,
  p.category                             as provider_category,
  p.float_model,
  p.is_provisional                       as provider_is_provisional,
  p.is_active                            as provider_is_active,
  f.branch_id,
  b.branch_code,
  b.name                                 as branch_name,
  f.till_name,
  f.label,
  f.agent_code,
  f.bank_account_number,
  f.line_msisdn,
  f.ledger_account_id,
  a.code                                 as float_account_code,
  (f.ledger_account_id is not null)      as holds_float,
  f.status,
  f.status_reason,
  f.opened_on,
  f.closed_on,
  f.notes,
  (select pg_catalog.count(*)
     from public.agency_account_staff s
    where s.float_account_id = f.id and s.status = 'active') as active_staff
from public.agency_provider_float_accounts f
join public.agency_service_providers p on p.id = f.provider_id
join public.branches b on b.id = f.branch_id
left join public.ledger_accounts a on a.id = f.ledger_account_id;

comment on view public.agency_agent_account_register is
  'Operational task 2. Every registered agent account of every partner, on either float model, with the partner''s own account number and agent identifier, its location, its status and how many staff are rostered on it. holds_float is false for a cash_payable partner''s account, which owns no float ledger account by design. security_invoker, so the reader''s own RLS decides what they see.';

revoke all on public.agency_agent_account_register from public, anon, authenticated;
grant select on public.agency_agent_account_register to authenticated;
