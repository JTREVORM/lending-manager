-- ===========================================================================
-- Phase 4C-S — Cross-phase financial concurrency closure.
--
-- Three races an independent review identified, all three reproduced against
-- the code as it stood at 19f27a6, and all three closed here. No schema
-- change: the two functions below are replaced, and nothing else moves.
--
-- ## The rule, stated once
--
-- A financially relevant function locks, in this order and before it reads
-- any balance it is about to decide on:
--
--   1. `lock_agency_provider_balance(provider, branch)` for every
--      provider-scoped resource it touches — the 1310 receivable and the
--      2200-series payable, both of which are shared across providers and so
--      cannot be protected by an account lock at all.
--   2. `lock_ledger_balances([...])` for every cash or float account whose
--      balance the entry changes, **in either direction**.
--
-- The second clause is the one Phase 4C got wrong. Locks were acquired as a
-- side effect of the sufficiency checks, and sufficiency is only ever checked
-- on the balance being drawn down — so every account an entry *credited* went
-- unlocked. A reconciliation approval could hold a till's lock while a deposit
-- posted into that same till, and the certified variance then described a
-- balance that no longer existed.
--
-- Locking an account you debit does not stop somebody crediting it.
-- ===========================================================================

create or replace function public.post_agency_transaction(p_transaction_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  t            public.agency_transactions;
  pr           public.agency_service_providers;
  ty           public.agency_transaction_types;
  v_cash       uuid;
  v_float      uuid;
  v_counter    uuid;          -- the float or payable account, whichever applies
  v_money_in   boolean;
  v_commission bigint;
  v_computed   bigint;
  v_basis      text;
  v_rate       integer;
  v_fixed      bigint;
  v_immediate  boolean;
  v_counter_leg bigint;
  v_cash_leg   bigint;
  v_lines      jsonb := '[]'::jsonb;
  v_debits     bigint := 0;
  v_credits    bigint := 0;
  v_entry      uuid;
  v_actor      uuid;
  v_label      text;
  v_fee_account uuid;
  v_outstanding bigint;
begin
  -- The lock is what makes two concurrent verifications safe: the second
  -- waits here and then reads the status the first committed.
  select * into t from public.agency_transactions
   where id = p_transaction_id for update;

  if t.id is null then
    raise exception 'No such agency transaction.' using errcode = 'P0001';
  end if;

  -- Idempotent by construction. A retried verification finds the journal
  -- already written and returns it rather than posting a second one.
  if t.journal_entry_id is not null then
    return t.journal_entry_id;
  end if;

  if t.status <> 'awaiting_verification' then
    raise exception
      'Only a transaction awaiting verification can be posted; this one is %.', t.status
      using errcode = 'P0001';
  end if;

  select * into pr from public.agency_service_providers where id = t.provider_id;
  select * into ty from public.agency_transaction_types where id = t.transaction_type_id;

  if ty.direction = 'transfer' then
    raise exception
      'Agency transfers are not supported yet; no provider defines one.'
      using errcode = 'P0001';
  end if;

  v_money_in  := ty.direction in ('deposit', 'payment');
  v_immediate := pr.commission_model = 'immediate';

  -- --- the commission, and what decided it -------------------------------
  select r.amount, r.computed, r.basis, r.rate_bps, r.fixed
    into v_commission, v_computed, v_basis, v_rate, v_fixed
  from public.agency_commission_reconcile(t.provider_id, t.principal_amount,
                                          t.commission_supplied) r;

  -- Phase 4B-S. A supplied figure that differs from the configured terms is a
  -- change to recognised income, so it takes authority rather than typing.
  -- Phase 4B posted it with a flag; the review is right that the person
  -- typing it is the person whose branch earns it, and `agency:write` is held
  -- by every Secretary/Treasurer.
  --
  -- Three things must hold together: a stated reason, a reference to evidence
  -- outside this system, and a verifier holding
  -- `agency:commission_exception`, which only the Owner has. Both figures are
  -- kept either way, so a refused discrepancy is still on the record.
  if v_commission <> v_computed then
    -- The authorisation is checked, not performed. It was granted earlier by
    -- `authorise_agency_commission_exception()`, which requires
    -- `agency:commission_exception` and records who gave it. Requiring the
    -- *verifier* to hold that capability as well would collapse the two roles
    -- into one: the Owner authorises the difference, and a Manager still
    -- verifies the transaction, so neither acts alone.
    --
    -- The reason, the authoriser and the two pinned figures arrive together —
    -- a CHECK constraint says so — therefore a present reason is a complete
    -- authorisation.
    if t.commission_exception_reason is null then
      raise exception
        'The commission supplied (%) differs from the % the provider''s configured terms produce. Correct the provider terms, or have the difference authorised with a reason and external evidence.',
        v_commission, v_computed
        using errcode = 'P0001';
    end if;

    -- An authorisation is for the figures it was given for, not for the
    -- transaction forever. `update_agency_transaction` can still edit a draft
    -- after the Owner has authorised it, and a provider can be re-rated in
    -- between; either would post a difference nobody approved. Both sides are
    -- pinned at authorisation and must still hold here.
    if v_commission <> t.commission_exception_amount
       or v_computed <> t.commission_exception_computed then
      raise exception
        'The authorised difference was % against the % the terms produced then; this transaction now supplies % against %. The figures changed after the authorisation, so it must be authorised again.',
        t.commission_exception_amount, t.commission_exception_computed,
        v_commission, v_computed
        using errcode = 'P0001';
    end if;
  end if;

  -- --- the accounts -------------------------------------------------------
  v_cash := public.branch_cash_account(t.branch_id, 'cash_at_hand');
  v_fee_account := public.ledger_account_by_code('4570');

  if pr.float_model = 'provider_float' then
    select f.ledger_account_id into v_float
    from public.agency_provider_float_accounts f where f.id = t.float_account_id;
    v_counter := v_float;
  else
    v_counter := t.payable_account_id;
  end if;

  -- --- the legs -----------------------------------------------------------
  --
  -- Under the immediate model the commission is realised inside the counter
  -- leg: we send less float than we collected, or receive more float than we
  -- paid out. Under the deferred model the counter leg is the principal and
  -- the commission is accrued separately.
  if v_money_in then
    v_counter_leg := t.principal_amount - (case when v_immediate then v_commission else 0 end);
    v_cash_leg    := t.principal_amount + t.customer_fee;
  else
    v_counter_leg := t.principal_amount + (case when v_immediate then v_commission else 0 end);
    v_cash_leg    := t.principal_amount - t.customer_fee;
  end if;

  if v_counter_leg < 0 then
    raise exception
      'A commission of % cannot exceed the principal of % on this transaction.',
      v_commission, t.principal_amount
      using errcode = 'P0001';
  end if;

  if v_cash_leg <= 0 then
    raise exception
      'A customer fee of % leaves nothing to pay out against a principal of %.',
      t.customer_fee, t.principal_amount
      using errcode = 'P0001';
  end if;

  -- --- the locks, before any balance is read ------------------------------
  --
  -- Phase 4C-S, C2 and C3.
  --
  -- C2: this function decided whether a bank withdrawal would take the
  -- provider's payable into net debit by reading
  -- agency_payable_outstanding(), while post_agency_payable_settlement()
  -- read the same figure under lock_agency_provider_balance(). Two different
  -- locks are no mutual exclusion: a 60,000 withdrawal from Cash at Hand and
  -- a 60,000 settlement funded from Cash at Bank both passed against the same
  -- 100,000 and left the provider at -20,000. Phase 4C's own test for this
  -- passed only because its settlement drew from the same till the withdrawal
  -- locked, so the two serialised on that account rather than on the payable.
  --
  -- C3: sufficiency was checked only on the balance being drawn *down*, and
  -- the lock came with that check. So a deposit - which debits cash at hand
  -- and increases it - took no lock on that till at all, and a reconciliation
  -- approval holding the till's lock did not stop a concurrent credit to it.
  -- Locking the account being debited does not prevent a concurrent change to
  -- the account being credited.
  --
  -- Both accounts are therefore locked here, in either direction, before any
  -- balance is read - and the provider lock comes first, keeping the one
  -- global order this phase relies on.
  perform public.lock_agency_provider_balance(t.provider_id, t.branch_id);
  perform public.lock_ledger_balances(array[v_cash, v_counter]);

  -- --- sufficiency, on whichever balance is being drawn down -------------
  if v_money_in then
    -- Value leaves the float. Nothing leaves the till, so there is no cash
    -- check; a payable rising needs none either.
    if pr.float_model = 'provider_float' then
      perform public.assert_agency_float_available(v_counter, v_counter_leg);
    end if;
  else
    -- Cash leaves the till, whichever model the provider uses.
    perform public.assert_cash_available(v_cash, v_cash_leg);

    -- Phase 4B-S, decision K closed. A cash_payable withdrawal debits the
    -- liability, and past zero it stops being a liability: it becomes the bank
    -- owing us for cash advanced. That is a real arrangement but a different
    -- instrument, with its own accounting, exposure limit and authority, and
    -- it must not appear by arithmetic as a negative number in a payable
    -- account. See docs/POLYTOS-AGENCY-BANK-ADVANCE-MODEL.md, which specifies
    -- the approved model and is deliberately unimplemented — there is no flag
    -- to set.
    --
    -- Attributed per provider: 2220 is shared by every partner bank, so an
    -- account-level balance would let one bank's collections fund another's
    -- withdrawals.
    if pr.float_model = 'cash_payable' then
      v_outstanding := public.agency_payable_outstanding(t.provider_id, t.branch_id);
      if v_outstanding < v_counter_leg then
        raise exception
          'Only % shillings are held on behalf of %, which is less than the % this withdrawal would pay out. No approved bank-advance arrangement exists, so the payable may not go into net debit.',
          v_outstanding, pr.name, v_counter_leg
          using errcode = 'P0001';
      end if;
    end if;
  end if;

  -- --- build the lines ----------------------------------------------------
  if v_money_in then
    v_lines := v_lines
      || public.agency_line(v_cash, v_cash_leg, 0, 'Received at the counter')
      || public.agency_line(v_counter, 0, v_counter_leg,
           case when pr.float_model = 'provider_float'
                then 'Sent from float' else 'Owed to ' || pr.name end);
  else
    v_lines := v_lines
      || public.agency_line(v_counter, v_counter_leg, 0,
           case when pr.float_model = 'provider_float'
                then 'Received into float' else 'Advanced for ' || pr.name end)
      || public.agency_line(v_cash, 0, v_cash_leg, 'Paid out at the counter');
  end if;

  if t.customer_fee > 0 then
    v_lines := v_lines
      || public.agency_line(v_fee_account, 0, t.customer_fee, 'Customer service fee');
  end if;

  if v_commission > 0 then
    if v_immediate then
      v_lines := v_lines
        || public.agency_line(pr.income_account_id, 0, v_commission,
             'Commission earned at the point of sale');
    else
      v_lines := v_lines
        || public.agency_line(public.ledger_account_by_code('1310'), v_commission, 0,
             'Commission receivable from ' || pr.name)
        || public.agency_line(pr.income_account_id, 0, v_commission,
             'Commission accrued');
    end if;
  end if;

  -- --- the assertion post_journal() does not make -------------------------
  select coalesce(pg_catalog.sum((l ->> 'debit')::bigint), 0),
         coalesce(pg_catalog.sum((l ->> 'credit')::bigint), 0)
    into v_debits, v_credits
  from pg_catalog.jsonb_array_elements(v_lines) l;

  if v_debits <> v_credits then
    raise exception
      'Refusing to post an unbalanced agency entry: debits % against credits %.',
      v_debits, v_credits
      using errcode = 'P0001';
  end if;

  v_actor := public.current_profile_id();
  select p.full_name into v_label from public.profiles p where p.id = v_actor;

  v_entry := public.post_journal(
    t.branch_id,
    t.transaction_date,
    pr.name || ' ' || ty.name
      || coalesce(' — ' || nullif(pg_catalog.btrim(coalesce(t.provider_reference, '')), ''), ''),
    'agency_transaction', t.id, null, null,
    v_lines,
    pg_catalog.now(), v_actor, coalesce(v_label, 'system')
  );

  -- The snapshot is written in the same statement that marks the transaction
  -- posted, so a posted row without its evidence is not reachable.
  update public.agency_transactions
     set status                      = 'posted',
         posted_at                   = pg_catalog.now(),
         journal_entry_id            = v_entry,
         commission_amount           = v_commission,
         commission_computed         = v_computed,
         commission_basis_applied    = v_basis,
         commission_rate_bps_applied = v_rate,
         commission_fixed_applied    = v_fixed,
         commission_model_applied    = pr.commission_model,
         income_account_id           = pr.income_account_id
   where id = t.id;

  return v_entry;
end;
$$;


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

  -- Phase 4C-S, C1. The provider lock, before the receivable is read.
  --
  -- This function decided whether a transaction's deferred commission was
  -- still unsettled by reading agency_commission_outstanding(), with no lock
  -- at all; record_commission_settlement() reads the same figure under
  -- lock_agency_provider_balance(). A settlement of 1,500 and a reversal
  -- carrying 1,000 could each see the full 2,000 outstanding and together
  -- leave the receivable at -500.
  --
  -- Taken before the account locks below, so the global order - provider
  -- lock, then sorted account locks - holds on this path as on every other.
  perform public.lock_agency_provider_balance(t.provider_id, t.branch_id);

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
  -- Phase 4C-S, C3: both sides, not only the debits. The contra credits
  -- whichever account the original debited, and a credit moves a balance just
  -- as a debit does. `and l.debit > 0` meant the account the contra was about
  -- to *increase* went unlocked, which is the same mistake the posting path
  -- made with deposits.
  perform public.lock_ledger_balances(array(
    select l.account_id
      from public.journal_lines l
      join public.ledger_accounts a on a.id = l.account_id
     where l.entry_id = t.journal_entry_id
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


-- ---------------------------------------------------------------------------
-- And one lock removed, because it protected nothing and serialised
-- everything. See the note inside each function.
-- ---------------------------------------------------------------------------

create or replace function public.record_commission_settlement(
  p_provider_id         uuid,
  p_branch_id           uuid,
  p_settlement_amount   bigint,
  p_settlement_account_id uuid,
  p_statement_ref       text default null,
  p_settlement_date     date default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor       uuid;
  v_label       text;
  pr            record;
  v_outstanding bigint;
  v_receivable  uuid;
  v_date        date;
  v_id          uuid;
  v_entry       uuid;
begin
  v_actor := public.agency_actor('agency:settlements');

  -- Branch isolation. A branch-scoped officer settles their own branch only;
  -- a Head Office profile (null branch) may settle any. The refusal is the
  -- same sentence whichever way it fails, so it discloses nothing about
  -- another branch's providers.
  if p_branch_id is null or not public.user_can_see_branch(p_branch_id) then
    raise exception
      'No agency provider with that identifier is available to you at that branch.'
      using errcode = '42501';
  end if;

  select p.id, p.name, p.commission_model, p.is_active, p.is_provisional
    into pr
  from public.agency_service_providers p
  where p.id = p_provider_id;

  if pr.id is null then
    raise exception
      'No agency provider with that identifier is available to you at that branch.'
      using errcode = '42501';
  end if;

  -- An immediate-commission provider never accrues a receivable: its
  -- commission is income at the moment of the transaction. There is nothing
  -- to settle, and accepting one would credit 1310 into a debit balance.
  if pr.commission_model <> 'deferred' then
    raise exception
      '% settles its commission immediately, so there is no receivable to remit.',
      pr.name
      using errcode = 'P0001';
  end if;

  if p_settlement_amount is null or p_settlement_amount <= 0 then
    raise exception
      'A commission settlement must be a positive number of shillings.'
      using errcode = 'P0001';
  end if;

  perform public.assert_agency_settlement_account(
    p_settlement_account_id, p_branch_id, 'receiving account');

  v_receivable := public.ledger_account_by_code('1310');

  -- Provider lock first, then the accounts, in that order. See the header.
  perform public.lock_agency_provider_balance(p_provider_id, p_branch_id);
  -- Phase 4C-S. GL 1310 is deliberately NOT locked here.
  --
  -- It was, and that was over-serialisation: 1310 is shared by every
  -- provider, so locking it made every commission settlement in the business
  -- queue behind every other, while protecting nothing. There is no
  -- account-level rule on 1310 - no sufficiency check, no floor - because the
  -- figure that matters is *this provider's* receivable at *this* branch, and
  -- that is what lock_agency_provider_balance() above protects.
  --
  -- The rule this phase states is that account locks cover the cash and float
  -- accounts whose balance the entry changes. 1310 is neither, so locking it
  -- was reaching past the rule rather than following it.
  perform public.lock_ledger_balances(array[p_settlement_account_id]);

  -- Read after the lock, never before it: that is what makes two concurrent
  -- settlements see each other.
  v_outstanding := public.agency_commission_outstanding(
    p_provider_id, p_branch_id);

  if p_settlement_amount > v_outstanding then
    raise exception
      '% shillings of commission are outstanding for % at this branch, which is less than the % being settled.',
      v_outstanding, pr.name, p_settlement_amount
      using errcode = 'P0001';
  end if;

  v_date := coalesce(p_settlement_date, public.business_date());
  select p.full_name into v_label from public.profiles p where p.id = v_actor;

  begin
    insert into public.agency_commission_settlements
      (provider_id, branch_id, settlement_date, settlement_amount,
       settlement_account_id, provider_statement_ref, created_by)
    values
      (p_provider_id, p_branch_id, v_date, p_settlement_amount,
       p_settlement_account_id,
       nullif(pg_catalog.btrim(coalesce(p_statement_ref, '')), ''), v_actor)
    returning id into v_id;
  exception when unique_violation then
    -- The partial unique index on (provider_id, provider_statement_ref).
    raise exception
      'A commission settlement for % already records statement reference %.',
      pr.name, p_statement_ref
      using errcode = 'P0001';
  end;

  v_entry := public.post_journal(
    p_branch_id,
    v_date,
    pr.name || ' commission settlement'
      || coalesce(' — ' || nullif(pg_catalog.btrim(coalesce(p_statement_ref, '')), ''), ''),
    'agency_commission_settlement', v_id, null, null,
    pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'account_id', p_settlement_account_id,
        'debit', p_settlement_amount, 'credit', 0,
        'memo', 'Commission received'),
      pg_catalog.jsonb_build_object(
        'account_id', v_receivable,
        'debit', 0, 'credit', p_settlement_amount,
        'memo', 'Commission receivable cleared')),
    pg_catalog.now(), v_actor, coalesce(v_label, 'system')
  );

  update public.agency_commission_settlements
     set journal_entry_id = v_entry
   where id = v_id;

  -- Deviation D1: the agency transaction audit log cannot hold this, because
  -- its transaction_id is NOT NULL against agency_transactions and a
  -- settlement is not a transaction. The generic stream carries it instead.
  perform public.record_audit_event(
    'agency.commission_settled',
    'agency_commission_settlement',
    v_id::text,
    pg_catalog.jsonb_build_object('outstanding_before', v_outstanding),
    pg_catalog.jsonb_build_object(
      'provider_id', p_provider_id,
      'branch_id', p_branch_id,
      'settlement_amount', p_settlement_amount,
      'settlement_account_id', p_settlement_account_id,
      'statement_ref', p_statement_ref,
      'journal_entry_id', v_entry,
      'outstanding_after', v_outstanding - p_settlement_amount)
  );

  return v_id;
end;
$$;


create or replace function public.reverse_commission_settlement(
  p_settlement_id uuid,
  p_reason        text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor      uuid;
  v_label      text;
  s            public.agency_commission_settlements;
  v_name       text;
  v_receivable uuid;
  v_entry      uuid;
begin
  -- Settlement-reversal authority, not settlement authority: recording a
  -- remittance and undoing one are different acts, as for the payable path.
  v_actor := public.agency_actor('agency:reverse');

  if pg_catalog.btrim(coalesce(p_reason, '')) = '' then
    raise exception 'A settlement correction needs a reason.'
      using errcode = 'P0001';
  end if;

  -- Locks the row and applies the branch rule.
  s := public.agency_locked_commission_settlement(p_settlement_id);

  if s.status <> 'posted' then
    raise exception
      'That commission settlement is already %, so it cannot be corrected again.',
      s.status
      using errcode = 'P0001';
  end if;

  select p.name into v_name
  from public.agency_service_providers p where p.id = s.provider_id;

  v_receivable := public.ledger_account_by_code('1310');

  -- Provider lock, then sorted account locks. The order this phase keeps
  -- everywhere; see 20261110000100's header.
  perform public.lock_agency_provider_balance(s.provider_id, s.branch_id);
  -- Phase 4C-S. GL 1310 is deliberately NOT locked here.
  --
  -- It was, and that was over-serialisation: 1310 is shared by every
  -- provider, so locking it made every commission settlement in the business
  -- queue behind every other, while protecting nothing. There is no
  -- account-level rule on 1310 - no sufficiency check, no floor - because the
  -- figure that matters is *this provider's* receivable at *this* branch, and
  -- that is what lock_agency_provider_balance() above protects.
  --
  -- The rule this phase states is that account locks cover the cash and float
  -- accounts whose balance the entry changes. 1310 is neither, so locking it
  -- was reaching past the rule rather than following it.
  perform public.lock_ledger_balances(array[s.settlement_account_id]);

  -- The money has to still be in the account it was received into.
  perform public.assert_cash_available(
    s.settlement_account_id, s.settlement_amount);

  select p.full_name into v_label from public.profiles p where p.id = v_actor;

  v_entry := public.post_journal(
    s.branch_id,
    public.business_date(),
    coalesce(v_name, 'Agency') || ' commission settlement corrected — ' || p_reason,
    'agency_commission_settlement_reversal', s.id, null, null,
    pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'account_id', v_receivable,
        'debit', s.settlement_amount, 'credit', 0,
        'memo', 'Commission receivable restored'),
      pg_catalog.jsonb_build_object(
        'account_id', s.settlement_account_id,
        'debit', 0, 'credit', s.settlement_amount,
        'memo', 'Commission returned')),
    pg_catalog.now(), v_actor, coalesce(v_label, 'system')
  );

  update public.agency_commission_settlements
     set status            = 'reversed',
         reversed_at       = pg_catalog.now(),
         reversed_by       = v_actor,
         reversal_reason   = p_reason,
         reversal_entry_id = v_entry
   where id = s.id;

  perform public.record_audit_event(
    'agency.commission_settlement_reversed',
    'agency_commission_settlement', s.id::text,
    pg_catalog.jsonb_build_object(
      'status', 'posted', 'journal_entry_id', s.journal_entry_id),
    pg_catalog.jsonb_build_object(
      'status', 'reversed',
      'reversal_entry_id', v_entry,
      'settlement_amount', s.settlement_amount,
      'reason', p_reason)
  );

  return v_entry;
end;
$$;
