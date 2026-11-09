-- ===========================================================================
-- Phase 4E — two invariants the approved decisions meet head-on
--
-- The brief asks that where an approved requirement conflicts with an existing
-- financial invariant, the accounting design be resolved before the posting
-- code changes. Two conflicts surfaced, both found by running the engine
-- rather than by reading it, and this migration is their resolution.
--
-- ## 1. `agency_transactions_snapshot_basis_agrees` and the reported basis
--
-- The snapshot CHECK ties the recorded basis to the figures it was derived
-- from: `rate` must carry a rate and no fixed amount, `fixed` the reverse, and
-- `zero` must have computed zero. That is a good invariant — it is what stops
-- a posting claiming a derivation its own columns contradict.
--
-- A reported commission has **neither** a rate nor a fixed amount, by design,
-- so it satisfied none of the three branches and every reported posting was
-- refused. The invariant is not wrong; it was complete for three bases and
-- there are now four. The fourth branch states the same kind of agreement:
-- `reported` carries no configured figure at all, and asserting that is
-- stronger than leaving the columns unconstrained.
--
-- ## 2. `agency_transaction_guard()` and a suspended line (decision OD-4)
--
-- OD-4: "Emergency suspension immediately stops new activity while retaining
-- balances, histories and authorized recovery operations."
--
-- The guard refused **every** write against an inactive till, and a reversal
-- is a write: the posted row is updated to `reversed`. So suspending a
-- compromised line trapped the float the suspension existed to protect, and
-- the only route to the money was to un-suspend the line that was known to be
-- compromised. That is the opposite of a control.
--
-- The resolution distinguishes the two inactive states, which is what OD-4
-- asks for and what Phase 4A had no way to express:
--
--   * `closed` refuses everything. A closed line is finished, and closure is
--     only reachable with zero float and nothing outstanding, so there is
--     nothing left to recover.
--   * `suspended` refuses new business and permits exactly one transition: a
--     posted transaction becoming reversed. That is the same exemption
--     `agency_transaction_live_readiness_guard()` already makes for a provider
--     switched off after the fact, for the same reason — a historical mistake
--     must not be trapped behind a configuration change.
--   * cancelling a draft stays possible in both, because a draft never moved
--     money and leaving un-cancellable drafts on a dead line is clutter, not
--     control.
--
-- Nothing else widens. New recording, submission and verification against a
-- suspended line are refused exactly as before, which the test suite asserts
-- beside the reversal it now allows.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- 1. The fourth basis
-- ---------------------------------------------------------------------------

alter table public.agency_transactions
  drop constraint if exists agency_transactions_snapshot_basis_agrees;

alter table public.agency_transactions
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
    or (commission_basis_applied = 'reported'
        and commission_rate_bps_applied is null
        and commission_fixed_applied is null)
  );

comment on constraint agency_transactions_snapshot_basis_agrees
  on public.agency_transactions is
  'Phase 4B, extended in Phase 4E. The recorded basis must agree with the figures it was derived from: rate carries a rate alone, fixed a fixed amount alone, zero computed nothing, and reported carries no configured figure at all because the amount came from the provider.';


-- ---------------------------------------------------------------------------
-- 2. The guard, with the two inactive states told apart
--
-- Replaced in full. Every other check — the provider, the branch, the till's
-- ownership, the payable account, the exactly-one settlement account — is
-- character-for-character what Phase 4A wrote.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.agency_transaction_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_provider record;
  v_type     record;
  v_till     record;
begin
  select * into v_provider
  from public.agency_service_providers where id = new.provider_id;

  if v_provider is null then
    raise exception 'No such agency provider.' using errcode = 'P0001';
  end if;

  select * into v_type
  from public.agency_transaction_types where id = new.transaction_type_id;

  if v_type is null then
    raise exception 'No such agency transaction type.' using errcode = 'P0001';
  end if;

  if v_type.provider_id <> new.provider_id then
    raise exception
      'Transaction type % does not belong to %.', v_type.name, v_provider.name
      using errcode = 'P0001';
  end if;

  -- The float model decides which settlement account the row must carry, and
  -- the exactly-one CHECK has already guaranteed it carries precisely one.
  if v_provider.float_model = 'provider_float' then
    if new.float_account_id is null then
      raise exception
        '% is settled from electronic float, so the transaction needs a till.', v_provider.name
        using errcode = 'P0001';
    end if;

    select * into v_till
    from public.agency_provider_float_accounts where id = new.float_account_id;

    if v_till.provider_id <> new.provider_id then
      raise exception 'That till does not belong to %.', v_provider.name
        using errcode = 'P0001';
    end if;

    -- Branch isolation, at the data layer: a branch cannot post against
    -- another branch's till even if it can name one.
    if v_till.branch_id <> new.branch_id then
      raise exception 'That till belongs to a different branch.'
        using errcode = 'P0001';
    end if;

    -- Phase 4E, decision OD-4. A closed line is finished: nothing may be
    -- written against it, in either direction. A *suspended* line is the
    -- emergency stop, and OD-4 requires that it "retain balances, histories
    -- and authorized recovery operations" — so the one transition that
    -- recovers what is already there stays open to it.
    --
    -- That transition is a posted transaction becoming reversed, which is the
    -- same exemption `agency_transaction_live_readiness_guard()` already makes
    -- for a provider that has since been switched off. Without it, suspending
    -- a compromised line would trap the float the suspension was invoked to
    -- protect, and the only way out would be to un-suspend the line that is
    -- known to be compromised.
    if v_till.status = 'closed' then
      raise exception
        'That till is closed, so nothing may be recorded against it.'
        using errcode = 'P0001';
    end if;

    if not v_till.is_active
       and not (tg_op = 'UPDATE' and new.status = 'reversed' and old.status = 'posted')
       and new.status <> 'cancelled' then
      raise exception 'That till is not active.' using errcode = 'P0001';
    end if;
  else
    if new.payable_account_id is null then
      raise exception
        '% is settled through a payable account, so the transaction needs one.', v_provider.name
        using errcode = 'P0001';
    end if;

    if new.payable_account_id is distinct from v_provider.payable_account_id then
      raise exception
        'That payable account is not the one registered for %.', v_provider.name
        using errcode = 'P0001';
    end if;
  end if;

  -- A transaction cannot be worth more than its type allows. Checked here
  -- rather than only in the posting function so it holds for a draft too.
  if v_type.max_single_transaction is not null
     and new.principal_amount > v_type.max_single_transaction then
    raise exception
      'A single % may not exceed % shillings.', v_type.name, v_type.max_single_transaction
      using errcode = 'P0001';
  end if;

  return new;
end;
$function$;

revoke all on function public.agency_transaction_guard()
  from public, anon, authenticated;

comment on function public.agency_transaction_guard() is
  'Phase 4A, extended in Phase 4E for decision OD-4. Validates every write to agency_transactions: the provider exists, the settlement account matches the float model, the till belongs to the provider and the branch, and the till is open. A closed till refuses everything; a suspended one refuses new business but permits a posted transaction to be reversed, which is how its float is recovered.';
