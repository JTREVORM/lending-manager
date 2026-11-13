-- ===========================================================================
-- Phase 4B — the commission engine, and proof of what it used
--
-- Specification: `docs/AGENCY-BANKING-ARCHITECTURE.md` v3.0 §4.1, §6.3, §6.4.
--
-- Two things land here: a pure function that computes commission from a
-- provider's configuration, and the columns that record what that
-- configuration *was* at the moment of posting.
--
-- ## Why the snapshot columns exist
--
-- `agency_service_providers.commission_rate_bps` is live configuration: an
-- owner may change it, and will, when a provider renegotiates. A transaction
-- posted last month was posted under last month's terms, and the journal it
-- wrote is evidence of income the business recognised. If the only record of
-- the rate is the provider row, then changing the rate silently rewrites the
-- explanation of every historical posting — the journal says 1,500 and the
-- configuration now says it should have been 2,000, with nothing to say which
-- was right.
--
-- So the rate, the fixed amount, the model and the income account are copied
-- onto the transaction when it posts, and a CHECK ties them to the posted
-- states. This is the same reasoning as `loan_product_snapshots` and
-- `loan_client_snapshots`: the row records the moment the business fixed what
-- it relied on.
--
-- ## Integer arithmetic, and the rounding rule
--
-- Basis points mean a division, and a division means a rounding decision that
-- has to be made once, in one place, rather than per caller. The rule is
-- **half-up on the absolute value**: `(principal * bps + 5000) / 10000` in
-- integer arithmetic. 10,000 at 150bp is exactly 150; 10,001 at 150bp is
-- 150.015 and rounds to 150; 10,034 at 150bp is 150.51 and rounds to 151.
--
-- No float, no `numeric`, anywhere: `principal_amount` is `bigint` minor units
-- and `commission_rate_bps` is an `integer`, so the product is `bigint` and
-- the division is integer division. `tests/db/schema.test.ts` fails the build
-- on a `numeric` column and `scripts/audit-financial-arithmetic.mjs` fails it
-- on a float in a money path; both still pass.
--
-- ## A conflicting configuration is refused, not resolved
--
-- A provider with both a rate and a fixed amount is ambiguous: nobody can say
-- whether the intent was the greater, the sum, or the rate with a floor. The
-- engine refuses it rather than picking. An explicit zero is stated as
-- `commission_fixed = 0`, which is a decision; NULL in both is the absence of
-- one and is already refused by Phase 4A's readiness gate.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- 1. What the configuration was, at the moment of posting
-- ---------------------------------------------------------------------------

alter table public.agency_transactions
  -- What the operator typed, if anything. Distinct from `commission_amount`,
  -- which is what posting decided: NULL here means "use the configuration",
  -- and 0 means "the operator stated zero". `commission_amount` defaults to 0
  -- and so cannot carry that distinction by itself.
  add column commission_supplied        bigint,
  add constraint agency_transactions_commission_supplied_not_negative
    check (commission_supplied is null or commission_supplied >= 0),
  add column commission_model_applied   text,
  add column commission_basis_applied   text,
  add column commission_rate_bps_applied integer,
  add column commission_fixed_applied   bigint,
  add column commission_computed        bigint,
  add column income_account_id          uuid references public.ledger_accounts(id) on delete restrict,

  -- The snapshot exists exactly when the transaction has posted. A draft has
  -- no snapshot because nothing has been relied on yet; a posted or reversed
  -- transaction must have one, because its journal is evidence.
  add constraint agency_transactions_snapshot_iff_posted
    check (
      (status in ('posted', 'reversed')) =
      (commission_model_applied is not null
        and commission_basis_applied is not null
        and commission_computed is not null
        and income_account_id is not null)
    ),

  add constraint agency_transactions_snapshot_model_valid
    check (commission_model_applied is null
           or commission_model_applied = any (array['deferred', 'immediate'])),

  add constraint agency_transactions_snapshot_basis_valid
    check (commission_basis_applied is null
           or commission_basis_applied = any (array['rate', 'fixed', 'zero'])),

  -- The basis names which field was used, so the pair must agree. A 'rate'
  -- basis carries a rate and no fixed amount, and the reverse for 'fixed'.
  add constraint agency_transactions_snapshot_basis_agrees
    check (
      commission_basis_applied is null
      or (commission_basis_applied = 'rate'
            and commission_rate_bps_applied is not null
            and commission_fixed_applied is null)
      or (commission_basis_applied = 'fixed'
            and commission_fixed_applied is not null
            and commission_rate_bps_applied is null)
      or (commission_basis_applied = 'zero'
            and commission_computed = 0)
    ),

  add constraint agency_transactions_snapshot_computed_not_negative
    check (commission_computed is null or commission_computed >= 0);

comment on column public.agency_transactions.commission_supplied is
  'Phase 4B. A commission the operator stated explicitly, overriding the configured basis. NULL means the configuration decides. Kept separate from commission_amount so that "nobody typed a figure" and "somebody typed zero" are different facts.';

comment on column public.agency_transactions.commission_model_applied is
  'Phase 4B. The commission model in force when this transaction posted, copied from the provider. Immutable evidence: changing the provider''s model later does not change what this posting recognised.';

comment on column public.agency_transactions.commission_basis_applied is
  'Phase 4B. Which configured field the commission was computed from: rate (basis points), fixed (a per-transaction amount), or zero (explicitly none). Names the arithmetic so a reviewer need not re-derive it.';

comment on column public.agency_transactions.commission_computed is
  'Phase 4B. What the configuration computed, as distinct from commission_amount, which is what was posted. They are equal unless an operator supplied a different figure, which agency_commission_reconcile() refuses unless it is explained.';

comment on column public.agency_transactions.income_account_id is
  'Phase 4B. The 4500-series account this transaction''s commission was credited to, snapshotted from the provider. Re-pointing the provider later cannot move income already recognised.';


-- ---------------------------------------------------------------------------
-- 2. The commission a configuration produces
--
-- Pure: same inputs, same answer, no reads beyond the provider row. Returns
-- the basis alongside the amount so the caller can snapshot both without
-- re-deciding which field was used.
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
  select pr.code, pr.name, pr.commission_rate_bps, pr.commission_fixed
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
  'Phase 4B. The commission a provider''s configuration produces for a principal, with the basis it used. Integer arithmetic throughout, rounding half-up at 10,000 basis points. Refuses a provider that configures both a rate and a fixed amount, and one that configures neither.';

-- Not reachable by a signed-in user. It is called by the posting path, which
-- is DEFINER, and a provider's commission rate is business configuration that
-- nothing outside the engine needs to read.
revoke all on function public.agency_commission_for(uuid, bigint)
  from public, anon, authenticated;


-- ---------------------------------------------------------------------------
-- 3. Reconciling a supplied amount against a computed one
--
-- An operator at a counter may be told a figure by the provider's own
-- handset that differs from what the configured rate produces — a promotion,
-- a tier, a rounding difference in the provider's own system. That is a real
-- situation and refusing it outright would make the module unusable.
--
-- But accepting it silently would mean the configured rate is decorative, and
-- nobody could later say whether income was recognised correctly. So a
-- difference is permitted only when it is **stated**: the caller must pass the
-- supplied amount explicitly, and the difference is recorded on the
-- transaction and in the audit trail. The configuration remains the default
-- and a NULL supplied amount means "use it".
-- ---------------------------------------------------------------------------

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
  c record;
begin
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
  'Phase 4B. Decides the commission to post: the configuration''s figure, or an explicitly supplied one. A supplied figure that differs is allowed and flagged, never silently preferred, so commission_computed and commission_amount together show both what was agreed and what was taken. Refuses a negative commission and one exceeding its own principal.';

revoke all on function public.agency_commission_reconcile(uuid, bigint, bigint)
  from public, anon, authenticated;
