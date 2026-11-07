-- ===========================================================================
-- Phase 4A — nothing posts against an unconfirmed provider
--
-- Required by the Phase 4A conditional acceptance. Phase 4A deliberately ships
-- a catalogue whose commission terms are the specification's defaults rather
-- than confirmed business rules (open decision C), and whose per-type limits
-- nobody has stated (open decision H). The risk that creates is precise: when
-- Phase 4B adds the posting functions, a provisional provider would be
-- indistinguishable from a confirmed one, and a transaction type with no
-- `max_single_transaction` would accept **any** amount — so an unreviewed
-- commission rate and an unbounded limit would quietly become live financial
-- behaviour.
--
-- ## Why this is a trigger and not a rule inside the posting functions
--
-- The posting functions do not exist yet. A readiness rule written in 4B would
-- be a rule that did not exist while the catalogue did, and one that a second
-- posting path added later could forget. Put here, it constrains every writer
-- of `agency_transactions` — the 4B functions, a future correction script, a
-- migration, and the table owner — because it is the table's own invariant.
--
-- Draft and cancelled rows are deliberately exempt. A draft is somebody typing
-- at a counter and must be possible against a provider being set up; what must
-- not happen is that draft becoming a posting. The gate is therefore on the
-- transition out of draft, which is exactly where money starts to move.
--
-- ## Five conditions, each closing a specific way a figure could go live
--
--   1. the provider is confirmed       — `is_provisional = false`
--   2. the provider is switched on      — `is_active = true`
--   3. the transaction type is switched on
--   4. the type states a maximum        — no silent "unlimited"
--   5. the provider states its commission basis — no silent "zero"
--
-- (5) is also a CHECK below, so a provider cannot be confirmed without it. The
-- trigger keeps it as well, because a CHECK added later cannot be trusted to
-- have held for rows written earlier.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- 1. Confirming a provider requires stating what it pays
--
-- A NULL rate is not zero: it means nobody recorded one. If a provider could
-- be confirmed with both the rate and the fixed amount NULL, Phase 4B would
-- compute commission from nothing and credit 4500-series income with a figure
-- no one agreed. Stating `commission_fixed = 0` is a perfectly good answer —
-- it just has to be an answer.
-- ---------------------------------------------------------------------------

alter table public.agency_service_providers
  add constraint agency_providers_confirmed_states_commission
  check (
    is_provisional
    or commission_rate_bps is not null
    or commission_fixed is not null
  );

comment on constraint agency_providers_confirmed_states_commission
  on public.agency_service_providers is
  'Phase 4A. A provider may not leave the provisional state without a commission basis recorded. NULL means nobody decided, not zero; zero is stated as commission_fixed = 0.';


-- ---------------------------------------------------------------------------
-- 2. The readiness gate on the transaction itself
-- ---------------------------------------------------------------------------

create or replace function public.agency_transaction_live_readiness_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_provider record;
  v_type     record;
begin
  -- A draft is being typed; a cancelled row never moved money. Neither is a
  -- posting, and both must stay possible while a provider is being set up.
  if new.status in ('draft', 'cancelled') then
    return new;
  end if;

  select * into v_provider
  from public.agency_service_providers where id = new.provider_id;

  if v_provider.is_provisional then
    raise exception
      '% is still provisional: its commission terms have not been confirmed, so nothing may be posted against it.',
      v_provider.name
      using errcode = 'P0001';
  end if;

  if not v_provider.is_active then
    raise exception
      '% is not active, so nothing may be posted against it.', v_provider.name
      using errcode = 'P0001';
  end if;

  -- Defence in depth behind the CHECK above: a confirmed provider with no
  -- commission basis would have Phase 4B recognising income from nothing.
  if v_provider.commission_rate_bps is null and v_provider.commission_fixed is null then
    raise exception
      '% records no commission rate and no fixed commission, so what it earns is undecided.',
      v_provider.name
      using errcode = 'P0001';
  end if;

  select * into v_type
  from public.agency_transaction_types where id = new.transaction_type_id;

  if not v_type.is_active then
    raise exception
      '% is not an active transaction type, so nothing may be posted against it.', v_type.name
      using errcode = 'P0001';
  end if;

  -- NULL means "no limit", which is the right default for a catalogue nobody
  -- has reviewed and the wrong one for live posting. Until somebody states a
  -- ceiling, this type cannot take a transaction of any size at all.
  if v_type.max_single_transaction is null then
    raise exception
      '% states no maximum single transaction, so it cannot be posted until a limit is set.',
      v_type.name
      using errcode = 'P0001';
  end if;

  return new;
end;
$$;

comment on function public.agency_transaction_live_readiness_guard() is
  'Phase 4A. Refuses any agency transaction past draft whose provider is still provisional or inactive, whose type is inactive or states no maximum, or whose provider records no commission basis. The gate sits on the transition out of draft, which is where money starts to move. Drafts and cancelled rows are exempt so a provider can still be set up.';

create trigger agency_transactions_live_readiness
  before insert or update on public.agency_transactions
  for each row execute function public.agency_transaction_live_readiness_guard();

-- A trigger fires as the table owner and needs no EXECUTE grant, so the grant
-- Supabase hands out by default is withheld rather than reviewed into the
-- security baseline.
revoke all on function public.agency_transaction_live_readiness_guard()
  from public, anon, authenticated;
