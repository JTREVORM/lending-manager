-- ===========================================================================
-- Polytos Agency redesign — correcting a provisional provider's float model
--
-- ## The decision this implements
--
-- The Product Owner has confirmed with the client that **banks provide
-- electronic float, just as MTN and Airtel do**. The provisional `STANBIC`
-- row is configured `float_model = 'cash_payable'`, which says the opposite:
-- that the company holds the customer's cash and owes it onward. The two
-- cannot both be true, and the delivery report raised it as the largest open
-- item.
--
-- What was missing was not the intent but the *mechanism*: there was no way
-- to change a provider's float model at all. The column was writable only by
-- the table owner, every exposed role is `SELECT`-only on it, and no RPC
-- touched it. So the correction could not be made safely, by anybody.
--
-- This migration adds that mechanism. It does **not** apply it: no provider
-- row is updated here, STANBIC is not touched, and nothing is activated.
-- Which banks hold float, and on what commercial terms, stays an Owner action
-- taken deliberately through this function and recorded in the audit log.
--
-- ## Why restricting it to a provisional provider makes it safe
--
-- `agency_transaction_live_readiness_guard()` refuses **any** status beyond
-- `draft` and `cancelled` while a provider `is_provisional`:
--
--     if v_provider.is_provisional then
--       raise exception '% is still provisional: its commission terms have
--         not been confirmed, so nothing may be posted against it.'
--
-- A provisional provider therefore has no posted transaction, no payable
-- balance and no float balance. Its float model is pure configuration, and
-- changing it strands nothing. That is the whole safety argument, and it is a
-- property of the existing engine rather than something invented here.
--
-- A **confirmed** provider is refused, for the reason
-- `set_agency_provider_commission_source()` gives about its own column: the
-- posted history cites the basis that was in force. Moving a confirmed
-- provider from `cash_payable` to `provider_float` would leave a real
-- `2220`-series liability behind with no path to settle it through the new
-- model, and the correct answer there is a settlement of the old position
-- followed by a decision the Owner makes with their accountant — not a column
-- update. The refusal says so.
--
-- ## And the checks that should be impossible
--
-- Four of the guards below cannot fire while the provisional rule holds: a
-- posted transaction, a transaction in flight, an outstanding payable, a
-- non-zero float balance. They are checked anyway. If one of them is ever
-- true of a provisional provider then something upstream is wrong, and
-- refusing the change is the right behaviour in exactly that case — the one
-- where an assumption has quietly stopped being true.
--
-- ## The CHECK coupling
--
-- Two constraints make the payable account and the float model a single fact:
--
--     agency_providers_payable_required_for_cash_payable
--       cash_payable   → payable_account_id IS NOT NULL
--     agency_providers_no_payable_for_provider_float
--       provider_float → payable_account_id IS NULL
--
-- So the two columns must move in one statement, which is what this function
-- does. Attempting them separately fails, correctly, and that is why a
-- hand-written UPDATE was never the answer either.
-- ===========================================================================


create or replace function public.set_agency_provider_float_model(
  p_provider_id        uuid,
  p_float_model        text,
  -- Required when moving *to* `cash_payable`: the liability the customer's
  -- money is owed on. Ignored when moving to `provider_float`, which must
  -- carry none. Validated by `agency_provider_accounts_guard()`, which the
  -- UPDATE below fires.
  p_payable_account_id uuid default null,
  p_reason             text default null
)
returns uuid
language plpgsql
volatile
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
begin
  -- The same capability idiom `set_agency_provider_commission_source()` uses:
  -- a signed-in caller needs `agency:providers`, and a trusted server path
  -- with no JWT subject (a seeder, a migration) is let through.
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

  -- ---------------------------------------------------------------------
  -- 1. Confirmed providers are refused, and told what to do instead.
  -- ---------------------------------------------------------------------
  if not pr.is_provisional then
    raise exception
      '% is confirmed. Its float model decides where every posted transaction put the money, so it cannot be changed by configuration: settle the position it holds under the present model first, then make the change as a deliberate decision with its own authority.',
      pr.name
      using errcode = 'P0001';
  end if;

  -- ---------------------------------------------------------------------
  -- 2. The four that should be impossible while provisional.
  -- ---------------------------------------------------------------------
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

  -- The payable this provider still owes onward, if any. Attributed by source
  -- entity, as every other agency figure is, because the 2200-series accounts
  -- are shared between providers and an account-level total would mix them.
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

  -- ---------------------------------------------------------------------
  -- 3. The destination model's own requirement.
  -- ---------------------------------------------------------------------
  if p_float_model = 'cash_payable' and p_payable_account_id is null then
    raise exception
      'A cash_payable provider holds the customer''s money and must name the liability it is owed on. Name a postable liability account.'
      using errcode = 'P0001';
  end if;

  v_old     := pr.float_model;
  v_old_pay := pr.payable_account_id;

  -- One statement, because the two CHECK constraints make the model and the
  -- payable account a single fact. `agency_provider_accounts_guard()` fires on
  -- this UPDATE and validates the payable account is an active, postable
  -- liability; `audit_agency_configuration_change()` records the row's before
  -- and after on top of the explicit audit event below.
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
  'Polytos Agency redesign. Corrects where a provisional provider''s money sits: provider_float, where the provider advances electronic float, or cash_payable, where the company holds the customer''s cash and owes it onward. Needed because the client confirmed banks provide electronic float while the provisional catalogue says cash_payable, and nothing could change that column safely. Owner-only (agency:providers), audited, and refused for a confirmed provider — whose posted history cites the model that was in force. Also refuses a provider with posted or in-flight transactions, an outstanding payable or a non-zero float balance; the first of those should be impossible while provisional, which is exactly why it is checked. Moves float_model and payable_account_id in one statement, because two CHECK constraints make them a single fact. Applies to no provider by itself: this migration changes no data.';

revoke all on function public.set_agency_provider_float_model(uuid, text, uuid, text)
  from public, anon, authenticated;
grant execute on function public.set_agency_provider_float_model(uuid, text, uuid, text)
  to authenticated;
