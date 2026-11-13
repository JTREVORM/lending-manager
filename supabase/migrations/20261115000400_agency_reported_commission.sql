-- ===========================================================================
-- Phase 4E — commission the provider reports, rather than commission we compute
--
-- Approved decision: "Remove the configured-rate requirement from the standard
-- Mobile Money transaction workflow only, without changing unrelated provider
-- categories. The cashier enters the actual reported commission."
--
-- ## Why a new column and not a new `commission_model`
--
-- `commission_model` answers *when* income is recognised: `immediate` puts the
-- commission inside the counter leg, `deferred` accrues it as Dr 1310 · Cr
-- income. That is a different question from *where the figure comes from*, and
-- conflating them would have three bad consequences: `commission_model_applied`,
-- the immutable snapshot on every posted transaction, would stop meaning one
-- thing; `record_commission_settlement()`'s `commission_model <> 'deferred'`
-- guard would silently change scope; and a reported-commission provider on the
-- immediate model would become inexpressible.
--
-- So `commission_source` is its own column, `configured` by default. MTN and
-- Airtel are `deferred` + `reported`: accrued to 1310 as before, with the
-- amount taken from the confirmation message.
--
-- ## What `reported` changes, and what it does not
--
--   * the amount comes from `commission_supplied`, which becomes **mandatory**
--     — a NULL is "nobody typed a figure" and must stay distinguishable from a
--     stated zero, which is a perfectly good answer for a transaction that
--     earned nothing;
--   * `commission_computed` equals the reported figure, so the Owner-only
--     commission-exception path never fires. That path exists to stop a
--     configured rate becoming decorative; where there is no configured rate
--     there is nothing to decorate, and requiring an Owner authorisation per
--     counter transaction would train the Owner to rubber-stamp;
--   * `commission_basis_applied` records `reported` — the fourth basis, beside
--     `rate`, `fixed` and `zero`. It is the snapshot: a later change of source
--     cannot restate what a posting recognised;
--   * the provider may be confirmed without a rate. **Only that condition is
--     relaxed.** The live-readiness guard's other four — provider confirmed,
--     provider active, type active, type states a `max_single_transaction` —
--     are untouched, so nothing posts against MTN or Airtel until their terms
--     are approved and decision OD-11's ceiling is set.
--
-- Every existing provider leaves `commission_source` at `configured` and is
-- bit-for-bit unaffected: each relaxation below is predicated on the new value.
--
-- ## The control that replaces the configured rate
--
-- A rate is a cross-check: it says what the provider ought to have paid. Take
-- it away and the cross-check has to come from somewhere else, or the figure a
-- cashier types is simply believed. It comes from 20261115001000's
-- statement-period reconciliation, which compares what we recognised against
-- what the provider's own statement says for the same line and period, and
-- from decision OD-2's rule that reconciliation never posts a correction by
-- itself. This migration is only half of the change; that one is the other.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- 1. The column
-- ---------------------------------------------------------------------------

alter table public.agency_service_providers
  add column if not exists commission_source text not null default 'configured';

comment on column public.agency_service_providers.commission_source is
  'Phase 4E. Where a transaction''s commission figure comes from: configured (from commission_rate_bps or commission_fixed, the default and every pre-4E provider) or reported (from the provider''s confirmation message, typed by the cashier into commission_supplied). Orthogonal to commission_model, which decides when income is recognised.';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'agency_providers_commission_source_valid') then
    alter table public.agency_service_providers
      add constraint agency_providers_commission_source_valid
      check (commission_source = any (array['configured', 'reported']));
  end if;

  -- A reported provider must not also carry a configured figure. Two sources
  -- that can disagree is one source too many, and the disagreement would only
  -- surface as a reconciliation variance nobody could explain.
  if not exists (select 1 from pg_constraint where conname = 'agency_providers_reported_states_no_rate') then
    alter table public.agency_service_providers
      add constraint agency_providers_reported_states_no_rate
      check (commission_source <> 'reported'
             or (commission_rate_bps is null and commission_fixed is null));
  end if;
end;
$$;


-- ---------------------------------------------------------------------------
-- 2. The two relaxations, each predicated on `reported`
-- ---------------------------------------------------------------------------

alter table public.agency_service_providers
  drop constraint if exists agency_providers_confirmed_states_commission;

alter table public.agency_service_providers
  add constraint agency_providers_confirmed_states_commission
  check (
    is_provisional
    or commission_source = 'reported'
    or commission_rate_bps is not null
    or commission_fixed is not null
  );

comment on constraint agency_providers_confirmed_states_commission
  on public.agency_service_providers is
  'Phase 4A, relaxed in Phase 4E for reported-commission providers only. A provider on the configured source may not leave the provisional state without a commission basis recorded; one on the reported source has none by design, because the figure arrives per transaction from the provider.';

-- The snapshot's fourth basis.
alter table public.agency_transactions
  drop constraint if exists agency_transactions_snapshot_basis_valid;

alter table public.agency_transactions
  add constraint agency_transactions_snapshot_basis_valid
  check (commission_basis_applied is null
         or commission_basis_applied = any (array['rate', 'fixed', 'zero', 'reported']));


-- ---------------------------------------------------------------------------
-- 3. `agency_commission_for` and `agency_commission_reconcile`
--
-- Both are the Phase 4B bodies with one branch added, spliced from the
-- original rather than retyped: every existing refusal keeps its exact words,
-- the positive-principal guard stays, and a fixed zero still reports `zero`
-- as its own basis so "we agreed nothing" remains distinguishable from "we
-- have not decided".
-- ---------------------------------------------------------------------------

create or replace function public.agency_commission_for(
  p_provider_id uuid,
  p_principal   bigint
)
returns table (amount bigint, basis text, rate_bps integer, fixed bigint)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  p record;
begin
  select pr.code, pr.name, pr.commission_rate_bps, pr.commission_fixed,
         pr.commission_source
    into p
  from public.agency_service_providers pr
  where pr.id = p_provider_id;

  if p is null then
    raise exception 'No such agency provider.' using errcode = 'P0001';
  end if;

  if p_principal is null or p_principal <= 0 then
    raise exception 'A commission needs a positive principal to be computed from.'
      using errcode = 'P0001';
  end if;

  -- Phase 4E. Two other functions reach this one to learn what a provider's
  -- configuration produces: the commission control in 20261109000200 and the
  -- exception authorisation in 20261113000100. For a reported-commission
  -- provider there is nothing to compute, and "records no commission basis"
  -- would read as a misconfiguration rather than as the design.
  if p.commission_source = 'reported' then
    raise exception
      '% takes its commission from the provider''s own confirmation message, so there is no configured figure to compute. The amount is supplied per transaction.',
      p.name
      using errcode = 'P0001';
  end if;

  -- Both configured is ambiguous. Refused rather than resolved: the greater,
  -- the sum and the rate-with-a-floor are all defensible readings, and the
  -- engine must not pick one on the business's behalf.
  if p.commission_rate_bps is not null and p.commission_fixed is not null then
    raise exception
      '% configures both a % basis-point rate and a fixed commission of %; only one may be set.',
      p.name, p.commission_rate_bps, p.commission_fixed
      using errcode = 'P0001';
  end if;

  if p.commission_rate_bps is null and p.commission_fixed is null then
    raise exception
      '% records no commission basis, so what it earns is undecided.', p.name
      using errcode = 'P0001';
  end if;

  if p.commission_fixed is not null then
    -- A fixed zero is an explicit decision and is reported as its own basis,
    -- so a reviewer can tell "we agreed nothing" from "we have not decided".
    return query select
      p.commission_fixed,
      case when p.commission_fixed = 0 then 'zero' else 'fixed' end,
      null::integer,
      p.commission_fixed;
    return;
  end if;

  if p.commission_rate_bps = 0 then
    return query select 0::bigint, 'zero', 0, null::bigint;
    return;
  end if;

  -- Half-up, in integer arithmetic. Both operands are integral and the
  -- addition of half the divisor before dividing is the whole rounding rule.
  return query select
    ((p_principal * p.commission_rate_bps) + 5000) / 10000,
    'rate',
    p.commission_rate_bps,
    null::bigint;
end;
$$;

comment on function public.agency_commission_for(uuid, bigint) is
  'Phase 4B, extended in Phase 4E. The commission a provider''s configuration produces for a principal, with the basis it used. Integer arithmetic throughout, rounding half-up at 10,000 basis points. Refuses a provider that configures both a rate and a fixed amount, one that records no basis at all, and one whose commission is reported per transaction rather than configured.';

revoke all on function public.agency_commission_for(uuid, bigint)
  from public, anon, authenticated;


create or replace function public.agency_commission_reconcile(
  p_provider_id uuid,
  p_principal   bigint,
  p_supplied    bigint default null
)
returns table (amount bigint, computed bigint, basis text, rate_bps integer, fixed bigint, differs boolean)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  pr public.agency_service_providers;
  c  record;
begin
  select * into pr from public.agency_service_providers where id = p_provider_id;

  if pr.id is null then
    raise exception 'No such agency provider.' using errcode = 'P0001';
  end if;

  -- Phase 4E. On the reported source the supplied figure *is* the basis, so
  -- amount and computed are equal and `differs` is false. That is what keeps
  -- the Owner-only commission-exception path out of the counter workflow: it
  -- fires on a difference, and there is none to fire on.
  --
  -- The figure is mandatory. NULL means "nobody typed one", and a transaction
  -- that genuinely earned nothing says so with a zero.
  if pr.commission_source = 'reported' then
    if p_supplied is null then
      raise exception
        '% reports its commission per transaction, so the amount from the confirmation message is required. Enter 0 if this transaction earned none.',
        pr.name
        using errcode = 'P0001';
    end if;

    if p_supplied < 0 then
      raise exception 'A commission cannot be negative.' using errcode = 'P0001';
    end if;

    if p_supplied > p_principal then
      raise exception
        'A commission of % cannot exceed the principal of %.', p_supplied, p_principal
        using errcode = 'P0001';
    end if;

    return query select
      p_supplied, p_supplied, 'reported'::text, null::integer, null::bigint, false;
    return;
  end if;

  select * into c from public.agency_commission_for(p_provider_id, p_principal);

  if p_supplied is null then
    return query select c.amount, c.amount, c.basis, c.rate_bps, c.fixed, false;
    return;
  end if;

  if p_supplied < 0 then
    raise exception 'A commission cannot be negative.' using errcode = 'P0001';
  end if;

  -- A supplied figure may not exceed the principal: a commission larger than
  -- the transaction it is earned on is a keying error, not a promotion.
  if p_supplied > p_principal then
    raise exception
      'A commission of % cannot exceed the principal of %.', p_supplied, p_principal
      using errcode = 'P0001';
  end if;

  return query select
    p_supplied, c.amount, c.basis, c.rate_bps, c.fixed, p_supplied <> c.amount;
end;
$$;

comment on function public.agency_commission_reconcile(uuid, bigint, bigint) is
  'Phase 4B, extended in Phase 4E. Decides the commission to post. On the configured source: the configuration''s figure, or an explicitly supplied one, where a difference is flagged and never silently preferred. On the reported source: the supplied figure is the basis, it is mandatory, and a stated zero is a valid answer. Refuses a negative commission and one exceeding its own principal in both cases.';

revoke all on function public.agency_commission_reconcile(uuid, bigint, bigint)
  from public, anon, authenticated;


-- ---------------------------------------------------------------------------
-- 5. The live-readiness guard's fifth condition
--
-- Replaced in full rather than patched, because a trigger function that
-- decides whether money may move is not a thing to carry two versions of.
-- Conditions one to four are character-for-character what Phase 4A and 4B-S
-- wrote; only the commission condition gains the reported branch.
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
  -- A draft is being typed and a cancelled row never moved money.
  if new.status in ('draft', 'cancelled') then
    return new;
  end if;

  -- A reversal is a correction of something already posted, on the terms the
  -- transaction itself snapshots, so it is not live posting — and refusing it
  -- would trap a historical mistake behind a provider that has since been
  -- switched off. Phase 4B, §8.3. Phase 4B-S narrowed the exemption to the
  -- transition it was written for.
  if new.status = 'reversed' then
    if tg_op = 'UPDATE' and old.status = 'posted' then
      return new;
    end if;
    raise exception
      'A transaction may only become reversed from a posted state.'
      using errcode = 'P0001';
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

  -- Phase 4E. A reported-commission provider states no rate by design: the
  -- figure arrives per transaction and is mandatory there instead. Every other
  -- provider must still have decided what it earns.
  if v_provider.commission_source <> 'reported'
     and v_provider.commission_rate_bps is null
     and v_provider.commission_fixed is null then
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

  if v_type.max_single_transaction is null then
    raise exception
      '% states no maximum single transaction, so it cannot be posted until a limit is set.',
      v_type.name
      using errcode = 'P0001';
  end if;

  return new;
end;
$$;

revoke all on function public.agency_transaction_live_readiness_guard()
  from public, anon, authenticated;

comment on function public.agency_transaction_live_readiness_guard() is
  'Phase 4A, extended in Phase 4E. Five conditions on any transition of agency_transactions out of draft: the provider is confirmed, the provider is active, the type is active, the type states a maximum, and — unless the provider''s commission is reported per transaction — it states a commission basis. Draft and cancelled rows are exempt, as is a posted row becoming reversed.';


-- ---------------------------------------------------------------------------
-- 6. The Owner sets a provider's commission source
--
-- Deliberately a function and not a data update in this migration. Which
-- source a provider uses is configuration the Owner owns, it is audited like
-- every other configuration change, and a migration that quietly set it for
-- MTN and Airtel would be this phase deciding something on the business's
-- behalf — and would have silently changed the fixture four existing tests
-- use as "a provider with no commission basis".
--
-- So MTN and Airtel ship as `configured` with no rate, exactly as Phase 4A
-- left them, and become `reported` when the Owner says so. Nothing is
-- activated either way: `is_provisional` stays true until their commercial
-- terms are approved.
--
-- The source may not change once the provider is confirmed. A provider that
-- has posted transactions has snapshots citing a basis, and moving the source
-- underneath them would leave the configuration disagreeing with history
-- about how those figures were arrived at.
-- ---------------------------------------------------------------------------

create or replace function public.set_agency_provider_commission_source(
  p_provider_id uuid,
  p_source      text,
  p_reason      text default null
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  pr     public.agency_service_providers;
  v_old  text;
begin
  if auth.uid() is not null
     and not (select public.user_has_permission('agency:providers')) then
    raise exception
      'Not authorized to configure agency providers.'
      using errcode = '42501';
  end if;

  select * into pr from public.agency_service_providers where id = p_provider_id;
  if pr.id is null then
    raise exception 'No such agency provider.' using errcode = 'P0001';
  end if;

  if p_source is null or p_source not in ('configured', 'reported') then
    raise exception
      'A commission source is either configured or reported.'
      using errcode = 'P0001';
  end if;

  if not pr.is_provisional then
    raise exception
      '% is already confirmed. Its commission source decides how every posted transaction''s figure was arrived at, so it cannot be changed once it is in use.',
      pr.name
      using errcode = 'P0001';
  end if;

  if p_source = 'reported'
     and (pr.commission_rate_bps is not null or pr.commission_fixed is not null) then
    raise exception
      '% configures a commission figure, so it cannot also report one. Clear the rate and the fixed amount first.',
      pr.name
      using errcode = 'P0001';
  end if;

  v_old := pr.commission_source;

  update public.agency_service_providers
     set commission_source = p_source,
         updated_at        = now()
   where id = p_provider_id;

  perform public.record_audit_event(
    'agency_provider.commission_source_set',
    'agency_provider',
    p_provider_id::text,
    pg_catalog.jsonb_build_object('commission_source', v_old),
    pg_catalog.jsonb_build_object('commission_source', p_source),
    pg_catalog.jsonb_build_object(
      'provider_code', pr.code,
      'reason',        nullif(pg_catalog.btrim(coalesce(p_reason, '')), '')),
    null);

  return p_provider_id;
end;
$$;

comment on function public.set_agency_provider_commission_source(uuid, text, text) is
  'Phase 4E. Sets whether a provider''s commission comes from its configuration or from the confirmation message of each transaction. Owner-only, audited, and refused once the provider is confirmed, because the posted snapshots cite the basis that was in force.';

revoke all on function public.set_agency_provider_commission_source(uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.set_agency_provider_commission_source(uuid, text, text)
  to authenticated;
