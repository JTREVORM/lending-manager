-- ===========================================================================
-- Phase 4B — reversing a posted agency transaction
--
-- Specification: `docs/AGENCY-BANKING-ARCHITECTURE.md` v3.0 §8.3.
--
-- A reversal posts balanced contra entries. It deletes nothing: the original
-- journal stays, the original transaction stays `reversed` rather than
-- vanishing, and its provider reference stays claimed, because the provider's
-- own transaction really did happen and reversing our accounting does not
-- un-send the money at MTN.
--
-- ## The contra is mirrored from the original journal, not recomputed
--
-- The obvious implementation rebuilds the legs from the transaction and flips
-- them. This reads the original journal's lines and swaps debit for credit.
-- That is deliberate: it cannot drift from what was actually posted. If the
-- posting logic changes next year, a reversal of a transaction posted this
-- year still mirrors what this year's code wrote, leg for leg — which is also
-- exactly what Phase 3's harness asserts of every reversal pair.
--
-- ## Sufficiency is checked on the way back too
--
-- `reverse_transfer()` asserts the destination can still give the money back,
-- and this follows it. The check is derived from the journal rather than
-- restated: every account the original entry **debited** is one the contra
-- will credit, so an asset that went up is about to come down. Cash is
-- checked against the cash rule and float against the float rule — never the
-- other way round, which is the whole point of correction C4.
--
-- ## Settled commission is refused, not silently reversed
--
-- Under the deferred model the commission sits in 1310 until the provider
-- remits it. Once remitted it is cash the business has actually received. A
-- reversal that credited 1310 below what has been settled would be claiming
-- back income that is already in the bank, leaving the receivable negative and
-- the settlement unexplained.
--
-- So the reversal compares the commission it is about to withdraw against the
-- receivable still outstanding for that provider and branch. If the
-- outstanding balance will not cover it, the reversal is refused and says so:
-- the settlement must be reversed first, which is Phase 4C's path. This is
-- §8.3 step 6, stated as a balance test rather than a per-transaction flag,
-- because settlements clear the receivable in aggregate (correction C7) and
-- there is no row-level link to consult.
--
-- ## Reversing after the provider has been switched off
--
-- Phase 4A's readiness gate refuses any transaction past draft whose provider
-- is provisional or inactive. Taken literally that traps a historical
-- transaction: deactivate a provider, and a mistake posted the week before can
-- never be corrected. Reactivating the provider to allow the correction would
-- be worse — it would reopen live posting for everybody to fix one entry.
--
-- The gate is therefore amended to exempt `reversed` alongside `draft` and
-- `cancelled`. The reasoning is that the gate exists to stop money moving
-- *forward* on unreviewed terms, and a reversal moves it back on the terms
-- that were in force when it went out — which the transaction itself records,
-- since Phase 4B snapshots them. The authority required is unchanged:
-- `agency:reverse`, plus `agency:reverse_cross_day` for a prior day.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- 1. Commission still owed to us by a provider
--
-- Debits to 1310 from this provider's postings, less credits to 1310 from its
-- settlements. Scoped by branch because the settlement record is.
-- ---------------------------------------------------------------------------

create or replace function public.agency_commission_outstanding(
  p_provider_id uuid,
  p_branch_id   uuid
)
returns bigint
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(pg_catalog.sum(l.debit - l.credit), 0)::bigint
    from public.journal_lines l
    join public.journal_entries e on e.id = l.entry_id
    join public.ledger_accounts a on a.id = l.account_id
   where a.code = '1310'
     and e.branch_id = p_branch_id
     and (
       -- the accruals: entries whose source is one of this provider's
       -- transactions
       (e.source_type in ('agency_transaction', 'agency_transaction_reversal')
         and exists (select 1 from public.agency_transactions t
                      where t.id = e.source_id and t.provider_id = p_provider_id))
       -- the settlements that cleared them
       or (e.source_type = 'agency_commission_settlement'
         and exists (select 1 from public.agency_commission_settlements s
                      where s.id = e.source_id and s.provider_id = p_provider_id))
     );
$$;

comment on function public.agency_commission_outstanding(uuid, uuid) is
  'Phase 4B. Commission accrued to 1310 for a provider at a branch and not yet settled: its accrual debits less its settlement credits. Used to refuse a reversal that would claw back commission the provider has already remitted.';

-- Withheld from signed-in users: it aggregates a provider's outstanding
-- receivable, which is a business figure rather than anything a counter needs,
-- and the reversal path that consults it is DEFINER.
revoke all on function public.agency_commission_outstanding(uuid, uuid)
  from public, anon, authenticated;


-- ---------------------------------------------------------------------------
-- 2. The readiness gate exempts a reversal
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
  -- switched off. Phase 4B, §8.3.
  --
  -- Phase 4B-S narrows the exemption to the transition it was written for.
  -- Previously any row whose status *was* 'reversed' skipped the gate, which
  -- also exempted an INSERT that arrived already reversed and an UPDATE from
  -- any other state. Neither is a correction of a posting, and neither should
  -- buy an exemption from the readiness rules. Now only a posted row moving to
  -- reversed is exempt, and nothing else is.
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
  'Phase 4A, amended in Phase 4B. Refuses any agency transaction moving to awaiting_verification or posted whose provider is still provisional or inactive, whose type is inactive or states no maximum, or whose provider records no commission basis. Exempts draft, cancelled and reversed: the first two have moved no money and the third is a correction of money already moved, which must stay possible after a provider is switched off.';

revoke all on function public.agency_transaction_live_readiness_guard()
  from public, anon, authenticated;


-- ---------------------------------------------------------------------------
-- 3. The reversal
-- ---------------------------------------------------------------------------

create or replace function public.reverse_agency_transaction(
  p_transaction_id uuid,
  p_reason         text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor       uuid;
  t             public.agency_transactions;
  pr            public.agency_service_providers;
  v_lines       jsonb := '[]'::jsonb;
  v_entry       uuid;
  v_label       text;
  v_outstanding bigint;
  r             record;
  v_debits      bigint := 0;
  v_credits     bigint := 0;
begin
  v_actor := public.agency_actor('agency:reverse');

  if pg_catalog.btrim(coalesce(p_reason, '')) = '' then
    raise exception 'A reversal needs a reason.' using errcode = 'P0001';
  end if;

  -- Phase 4B-S: locked and branch-authorized, like every other lifecycle
  -- function. A reversal moves money, so it was one of the two worst cases in
  -- the reproduced cross-branch vulnerability.
  t := public.agency_locked_transaction(p_transaction_id);

  if t.status = 'reversed' then
    return t.reversal_entry_id;              -- idempotent
  end if;

  if t.status <> 'posted' then
    raise exception
      'Only a posted transaction can be reversed; this one is %.', t.status
      using errcode = 'P0001';
  end if;

  -- Reopening a closed day is a different decision from correcting today's.
  if t.transaction_date < public.business_date()
     and not public.user_has_permission('agency:reverse_cross_day') then
    raise exception
      'This transaction is dated %, and reversing a prior day requires the agency:reverse_cross_day capability.',
      t.transaction_date
      using errcode = '42501';
  end if;

  select * into pr from public.agency_service_providers where id = t.provider_id;

  -- Settled commission cannot be clawed back here.
  if t.commission_model_applied = 'deferred' and t.commission_amount > 0 then
    v_outstanding := public.agency_commission_outstanding(t.provider_id, t.branch_id);
    if v_outstanding < t.commission_amount then
      raise exception
        'Commission of % on this transaction has already been settled — only % remains outstanding for %. Reverse the commission settlement first.',
        t.commission_amount, v_outstanding, pr.name
        using errcode = 'P0001';
    end if;
  end if;

  -- Phase 4B-S. Every cash or float account the contra will draw down, locked
  -- up front in one sorted batch.
  --
  -- In practice an agency entry debits exactly one of cash or float, so the
  -- loop below would take a single lock anyway. But the loop walks the journal
  -- in line order, which is data-dependent, and relying on "there happens to
  -- be only one" is how a lock-order inversion arrives later with a new
  -- posting shape. Sorting them here makes the ordering a property of the code
  -- rather than of the data.
  perform public.lock_ledger_balances(array(
    select l.account_id
      from public.journal_lines l
      join public.ledger_accounts a on a.id = l.account_id
     where l.entry_id = t.journal_entry_id
       and l.debit > 0
       and a.cash_kind is not null
  ));

  -- Mirror the original journal, leg for leg, and check sufficiency on every
  -- asset the contra is about to draw down.
  for r in
    select l.account_id, l.debit, l.credit, l.memo, a.cash_kind
      from public.journal_lines l
      join public.ledger_accounts a on a.id = l.account_id
     where l.entry_id = t.journal_entry_id
     order by l.line_number
  loop
    if r.debit > 0 then
      if r.cash_kind = 'cash_at_hand' then
        perform public.assert_cash_available(r.account_id, r.debit);
      elsif r.cash_kind = 'agency_float' then
        perform public.assert_agency_float_available(r.account_id, r.debit);
      end if;
    end if;

    v_lines := v_lines || public.agency_line(
      r.account_id, r.credit, r.debit,
      'Reversal: ' || coalesce(r.memo, 'original line'));
  end loop;

  if v_lines = '[]'::jsonb then
    raise exception
      'The original journal for this transaction has no lines; it cannot be mirrored.'
      using errcode = 'P0001';
  end if;

  select coalesce(pg_catalog.sum((l ->> 'debit')::bigint), 0),
         coalesce(pg_catalog.sum((l ->> 'credit')::bigint), 0)
    into v_debits, v_credits
  from pg_catalog.jsonb_array_elements(v_lines) l;

  if v_debits <> v_credits then
    raise exception
      'Refusing to post an unbalanced agency reversal: debits % against credits %.',
      v_debits, v_credits
      using errcode = 'P0001';
  end if;

  select p.full_name into v_label from public.profiles p where p.id = v_actor;

  v_entry := public.post_journal(
    t.branch_id,
    public.business_date(),
    'Reversal of ' || pr.name || ' transaction'
      || coalesce(' — ' || nullif(pg_catalog.btrim(coalesce(t.provider_reference, '')), ''), ''),
    'agency_transaction_reversal', t.id, null, null,
    v_lines,
    pg_catalog.now(), v_actor, coalesce(v_label, 'system')
  );

  update public.agency_transactions
     set status            = 'reversed',
         reversed_at       = pg_catalog.now(),
         reversed_by       = v_actor,
         reversal_reason   = p_reason,
         reversal_entry_id = v_entry
   where id = p_transaction_id;

  -- The stamp that lets the original entry name what undid it. `journal_entries`
  -- refuses DELETE but permits this, which is the pattern `reverse_transfer()`
  -- established.
  update public.journal_entries
     set reversed_by_entry_id = v_entry
   where id = t.journal_entry_id and reversed_by_entry_id is null;

  insert into public.agency_transaction_audit_log
    (transaction_id, action, actor_id, old_value, new_value, reason)
  values (p_transaction_id, 'reverse', v_actor,
          pg_catalog.jsonb_build_object('status', 'posted',
                                        'journal_entry_id', t.journal_entry_id,
                                        'commission_amount', t.commission_amount),
          pg_catalog.jsonb_build_object('status', 'reversed',
                                        'reversal_entry_id', v_entry),
          p_reason);

  return v_entry;
end;
$$;

comment on function public.reverse_agency_transaction(uuid, text) is
  'Phase 4B, §8.3. Reverses a posted agency transaction by mirroring its journal leg for leg, deleting nothing. Requires agency:reverse, and agency:reverse_cross_day for a prior day. Refuses a reversal whose deferred commission has already been settled, and asserts cash and float sufficiency separately on the way back. Idempotent.';

revoke all on function public.reverse_agency_transaction(uuid, text) from public, anon;
grant execute on function public.reverse_agency_transaction(uuid, text) to authenticated;
