-- ===========================================================================
-- Phase 4B — posting an agency transaction to the ledger
--
-- Specification: `docs/AGENCY-BANKING-ARCHITECTURE.md` v3.0 §6 and §8.2.
--
-- One function does the posting, for every provider and every direction,
-- because the alternative is nine nearly-identical functions that drift. The
-- journal it builds is decided by two configured facts — the provider's
-- `float_model` and the type's `direction` — and three amounts.
--
-- ## Three amounts, three different claims
--
--   P  principal_amount   what the customer transacts: reaches their wallet,
--                         their bill, or their bank account
--   C  commission         what the provider pays us for doing it
--   F  customer_fee       what we charge the customer directly, over the
--                         counter, which is always our income immediately
--
-- Keeping them apart is the whole reason the reversal of a transaction can
-- later say which part was income being given back.
--
-- ## The four shapes
--
-- **Float, money in** (MoMo deposit, Yaka, water, DStv, GOtv, airtime):
--   the customer hands over cash, we send value from float.
--     Dr Cash P+F · Cr Float P−C(immediate) · Cr 4570 F · Cr income C
--
-- **Float, money out** (MoMo withdrawal): we pay cash, the provider credits
--   our float.
--     Dr Float P+C(immediate) · Cr Cash P−F · Cr 4570 F · Cr income C
--
-- **Payable, money in** (school fees, bank agency deposit): the customer
--   hands over cash and we owe it onward.
--     Dr Cash P+F · Cr Payable P−C(immediate) · Cr 4570 F · Cr income C
--
-- **Payable, money out** (bank agency withdrawal) — *the case the
-- specification does not cover*. §8.2's `cash_payable` branch posts
-- "Dr Cash, Cr Payable" whatever the direction, which is simply wrong for a
-- withdrawal: the customer receives cash and the liability must fall, not
-- rise. Posting it the specification's way would credit the payable twice for
-- a deposit-and-withdrawal pair and show the business owing a bank money it
-- had just handed back.
--     Dr Payable P+C(immediate) · Cr Cash P−F · Cr 4570 F · Cr income C
--
-- Debiting the payable can take it into a net debit balance, which is the
-- bank owing us for cash we advanced on its behalf. That is the economics of
-- agency banking and 2220 is named "Net settlement due to partner bank" for
-- it. It is recorded as an open decision rather than silently prevented: the
-- ceiling that does bind is the type's `max_single_transaction`, and the till
-- cannot pay out money it does not hold.
--
-- Under the **deferred** model the commission is not in the principal legs at
-- all; it is accrued with its own pair, Dr 1310 · Cr income.
--
-- ## One entry, not two
--
-- §6.3 describes the commission accrual as "a separate entry in the same
-- database transaction". This posts **one** entry carrying both pairs. It is
-- the same arithmetic and the same accounts, and it is better in three ways:
-- `agency_transactions.journal_entry_id` can point at the whole posting
-- rather than half of it, the reversal is one mirrored entry rather than two
-- that could half-fail, and "every journal entry balances individually" stays
-- true of the posting as a unit. Recorded as a deliberate deviation.
--
-- ## The balance assertion is not belt and braces
--
-- `post_journal()` does **not** check that debits equal credits. It has no
-- such check and no constraint behind it — `journal_lines_one_side` only
-- asserts each line is one-sided. "Every entry balances" is a *test* in this
-- repository, not an invariant of the writer. So this function computes both
-- totals and refuses to call `post_journal()` unless they agree. Without it,
-- a future edit to the line builder could write an unbalanced entry and only
-- the certification harness would notice, after the fact.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- One journal line, as the single-element array the builder concatenates
--
-- A small helper rather than inline `jsonb_build_object` at seven call sites:
-- the argument order is then stated once, and an account/debit/credit mix-up
-- cannot hide in one branch of a nine-provider matrix.
-- ---------------------------------------------------------------------------

create or replace function public.agency_line(
  p_account_id uuid,
  p_debit      bigint,
  p_credit     bigint,
  p_memo       text
)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select pg_catalog.jsonb_build_array(
    pg_catalog.jsonb_build_object(
      'account_id', p_account_id,
      'debit',      p_debit,
      'credit',     p_credit,
      'memo',       p_memo));
$$;

comment on function public.agency_line(uuid, bigint, bigint, text) is
  'Phase 4B. One journal line as a single-element JSONB array, so the agency line builder can concatenate them and the account/debit/credit order is stated once.';

revoke all on function public.agency_line(uuid, bigint, bigint, text) from public, anon, authenticated;


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

comment on function public.post_agency_transaction(uuid) is
  'Phase 4B. Posts one agency transaction as a single balanced journal entry, for every provider and direction. Idempotent: a transaction that already has a journal returns it rather than posting again. Locks the row, so two concurrent verifications cannot both post. Asserts debits equal credits before writing, because post_journal() does not.';

revoke all on function public.post_agency_transaction(uuid) from public, anon, authenticated;
