-- ===========================================================================
-- Phase 4E — a withdrawal fee that is collected, not deducted (decision OD-5)
--
-- OD-5: "Deposits collect optional manually entered fees on top. Withdrawals
-- support either deduction from the payout or separate fee collection.
-- Preserve actual gross cash movements and accurate net accounting."
--
-- Phase 4B had one convention: the fee is added to the cash a depositor hands
-- over, and subtracted from the cash a withdrawer receives. The first half is
-- what OD-5 asks for. The second is one of the two things it asks for, and the
-- other — the customer takes the full amount and pays the fee separately — is
-- what a counter actually does when a customer wants a round number in their
-- hand.
--
-- ## Why this is not just a presentational choice
--
-- Deducting and collecting have the same net effect on the drawer, and a
-- ledger that recorded only the net would make the two indistinguishable. But
-- they are not the same event: in one, 49,500 crossed the counter; in the
-- other, 50,000 went out and 500 came in. A physical cash count at the end of
-- the day reconciles against movements, and a day of fees collected
-- separately that were booked as deductions understates both the cash paid
-- out and the cash received by the same amount. So the entry carries both
-- movements, as two lines on the same cash account in opposite directions.
-- `journal_lines` has no uniqueness on (entry_id, account_id), and the
-- balanced-entry invariant is unaffected: debits and credits both rise by the
-- fee.
--
-- ## Backward compatibility is the default, deliberately
--
--   * `customer_fee_mode` is NULL on every existing row and NULL means
--     `deduct_from_payout`, so every posted transaction and every existing
--     test keeps its arithmetic exactly;
--   * a deposit must leave it NULL. A deposit's fee is always on top, so a
--     mode would be a control with no effect, and a control with no effect is
--     a thing somebody will one day set and rely on;
--   * a mode with no fee is refused. There is nothing to deduct or collect.
--
-- ## The timestamp (decision OD-12)
--
-- OD-12: "Transaction business date is mandatory, provider transaction time
-- optional, and system entry timestamp automatic. Use Africa/Kampala for
-- business dates."
--
-- All three already exist or are added here: `transaction_date` is mandatory
-- and defaults to `business_date()`, which is Africa/Kampala by ADR-004;
-- `created_at` is the automatic entry timestamp; and `transacted_at` is new —
-- the instant the provider''s own system recorded it, optional, and used for
-- display and reconciliation only. It never decides a posting: the business
-- date does, so a transaction recorded at 00:30 against the previous business
-- day lands where the counter says it does.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- 1. The columns
-- ---------------------------------------------------------------------------

alter table public.agency_transactions
  add column if not exists customer_fee_mode text,
  add column if not exists transacted_at     timestamptz;

comment on column public.agency_transactions.customer_fee_mode is
  'Phase 4E, decision OD-5. How the customer fee crossed the counter on a withdrawal: deduct_from_payout (taken out of the cash handed over, the pre-4E behaviour and what NULL means) or collect_separately (the customer receives the whole amount and pays the fee as a second movement of cash). NULL on every deposit, where the fee is always on top.';

comment on column public.agency_transactions.transacted_at is
  'Phase 4E, decision OD-12. The instant the provider''s own system recorded the transaction, as read from the confirmation message. Optional, and never used to decide a posting: transaction_date, in Africa/Kampala, does that. created_at is when it was typed in.';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'agency_transactions_fee_mode_valid') then
    alter table public.agency_transactions
      add constraint agency_transactions_fee_mode_valid
      check (customer_fee_mode is null
             or customer_fee_mode = any (array['deduct_from_payout', 'collect_separately']));
  end if;

  -- A mode with nothing to apply it to.
  if not exists (select 1 from pg_constraint where conname = 'agency_transactions_fee_mode_needs_fee') then
    alter table public.agency_transactions
      add constraint agency_transactions_fee_mode_needs_fee
      check (customer_fee_mode is null or customer_fee > 0);
  end if;
end;
$$;


-- ---------------------------------------------------------------------------
-- 2. Posting
--
-- Five changes to the function 20261111000100 left in place, each marked in
-- the body: the mode is resolved beside the fee account, the payout leg stops
-- being reduced when the fee is collected separately, the cash sufficiency
-- check asserts the net in both modes, and the fee gains its own cash debit.
-- Everything else — the commission block, the counter leg, the float and
-- payable sufficiency rules, the balance assertion, the snapshot — is
-- character-for-character what was there.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.post_agency_transaction(p_transaction_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
  v_fee_mode   text;
  v_fee_on_top boolean;
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

  -- Phase 4E, decision OD-5. On a deposit the fee is always paid over and
  -- above the amount deposited, which is what `v_cash_leg` below has always
  -- done. On a withdrawal the business may either take the fee out of the
  -- cash it hands over, or collect it separately and hand over the whole
  -- amount. NULL is the pre-4E behaviour, which is the first of those.
  v_fee_mode   := coalesce(t.customer_fee_mode, 'deduct_from_payout');
  v_fee_on_top := (not v_money_in) and v_fee_mode = 'collect_separately';

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
    -- Collected separately, the customer receives the whole amount and hands
    -- the fee over as a second movement of cash, so the payout leg is the
    -- principal and the fee is its own debit below. Both modes have the same
    -- net effect on the drawer; only one of them tells the truth about what
    -- physically crossed the counter.
    v_cash_leg    := t.principal_amount - (case when v_fee_on_top then 0 else t.customer_fee end);
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
    -- The net, not the gross. Under either fee mode the drawer ends up
    -- lower by exactly principal - fee, and the same transaction must not be
    -- affordable in one presentation and refused in the other.
    perform public.assert_cash_available(
      v_cash, v_cash_leg - (case when v_fee_on_top then t.customer_fee else 0 end));

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
    -- Collected separately, the cash the customer hands over for the fee is a
    -- movement of its own: a second line on the same cash account, in the
    -- opposite direction to the payout. `journal_lines` carries no uniqueness
    -- on (entry, account), and the gross presentation is the point.
    if v_fee_on_top then
      v_lines := v_lines
        || public.agency_line(v_cash, t.customer_fee, 0, 'Service fee collected at the counter');
    end if;

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
$function$;


comment on function public.post_agency_transaction(uuid) is
  'Phase 4B, serialised in Phase 4B-S, extended in Phase 4E for decision OD-5. Posts one balanced entry for an agency transaction: the counter leg against float or a payable, the cash leg, the customer fee, and the commission either inside the counter leg (immediate) or accrued to 1310 (deferred). A withdrawal fee is deducted from the payout or collected as its own movement of cash, per customer_fee_mode. Asserts the balance itself so a failure names the transaction.';

-- ---------------------------------------------------------------------------
-- 3. Recording and editing: two more fields
--
-- Both functions are **dropped and recreated** rather than replaced, because
-- adding a parameter to a function that already has defaults creates a second
-- function with a different signature rather than replacing the first. Two
-- overloads of `create_agency_transaction` would be an ambiguity on exactly
-- the call that records money. The existing positional calls — eleven
-- arguments — still resolve, because the two new parameters default to NULL.
--
-- The direction guard is here rather than in a CHECK constraint because a
-- CHECK on `agency_transactions` cannot see the transaction type's direction
-- without a subquery, and a subquery in a CHECK is not a constraint, it is a
-- trigger wearing a constraint's clothes. The refusal is explicit instead, and
-- says why.
-- ---------------------------------------------------------------------------

drop function if exists public.create_agency_transaction(
  uuid, bigint, uuid, text, text, text, bigint, bigint, text, date, text);

create or replace function public.create_agency_transaction(
  p_transaction_type_id uuid,
  p_principal_amount    bigint,
  p_float_account_id    uuid        default null,
  p_customer_identifier text        default null,
  p_customer_name       text        default null,
  p_provider_reference  text        default null,
  p_customer_fee        bigint      default 0,
  p_commission_supplied bigint      default null,
  p_description         text        default null,
  p_transaction_date    date        default null,
  p_idempotency_key     text        default null,
  p_customer_fee_mode   text        default null,
  p_transacted_at       timestamptz default null
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor    uuid;
  v_existing public.agency_transactions;
  v_pr       public.agency_service_providers;
  v_ty       public.agency_transaction_types;
  v_branch   uuid;
  v_payable  uuid;
  v_mode     text;
  v_id       uuid;
begin
  v_actor := public.agency_actor('agency:write');

  -- Phase 4B-S. The idempotency lookup used to return whatever transaction
  -- held the key, whoever asked. Reproduced: a branch-A secretary supplying a
  -- branch-B key was handed branch B's transaction UUID — the one identifier
  -- every other function then accepted. The key is global by design (Phase
  -- 4A's unique index), so the lookup has to decide what to do about a key
  -- from somewhere else, and returning it was the wrong answer.
  --
  -- A genuine retry from the branch that owns the key still gets its own
  -- transaction back. A key held elsewhere is refused without naming it.
  --
  -- Phase 4D-F. And a key held by *this* branch is refused too when the call
  -- describes a different transaction.
  --
  -- Phase 4E. The fee mode joins that comparison: a withdrawal whose fee is
  -- collected separately is a different transaction from one whose fee is
  -- deducted, and a retry that changes it is not a retry.
  if p_idempotency_key is not null then
    select * into v_existing
      from public.agency_transactions
     where idempotency_key = p_idempotency_key;

    if v_existing.id is not null then
      if not public.user_can_see_branch(v_existing.branch_id) then
        raise exception
          'That idempotency key is already in use and is not available to you.'
          using errcode = '42501';
      end if;

      if v_existing.transaction_type_id is distinct from p_transaction_type_id
         or v_existing.principal_amount  is distinct from p_principal_amount
         or v_existing.customer_fee      is distinct from coalesce(p_customer_fee, 0)
         or v_existing.commission_supplied is distinct from p_commission_supplied
         -- Only where the provider keeps a till. For a cash-payable provider
         -- the stored column is null whatever the caller passed, so comparing
         -- it would refuse a retry that repeated its own argument.
         or (v_existing.float_account_id is not null
             and v_existing.float_account_id is distinct from p_float_account_id)
         or v_existing.customer_identifier is distinct from
              nullif(pg_catalog.btrim(coalesce(p_customer_identifier, '')), '')
         or v_existing.provider_reference is distinct from
              nullif(pg_catalog.btrim(coalesce(p_provider_reference, '')), '')
         or (p_customer_fee_mode is not null
             and v_existing.customer_fee_mode is distinct from p_customer_fee_mode)
         or (p_transaction_date is not null
             and v_existing.transaction_date is distinct from p_transaction_date) then
        raise exception
          'That submission key was already recorded for a different transaction. Reload the counter and record this one again; nothing has been written for it.'
          using errcode = 'P0001';
      end if;

      return v_existing.id;
    end if;
  end if;

  select * into v_ty from public.agency_transaction_types where id = p_transaction_type_id;
  if v_ty.id is null then
    raise exception 'No such agency transaction type.' using errcode = 'P0001';
  end if;

  select * into v_pr from public.agency_service_providers where id = v_ty.provider_id;

  -- The branch is the officer's own. It is never an argument: that is what
  -- stops one branch recording against another's till, before RLS or the
  -- till guard are even reached.
  select p.branch_id into v_branch from public.profiles p where p.id = v_actor;
  if v_branch is null then
    select b.id into v_branch from public.branches b
     where b.status = 'active' order by b.branch_code limit 1;
  end if;

  if v_pr.float_model = 'provider_float' then
    if p_float_account_id is null then
      raise exception
        '% is settled from electronic float, so a till must be named.', v_pr.name
        using errcode = 'P0001';
    end if;
  else
    v_payable := v_pr.payable_account_id;
  end if;

  if v_ty.requires_meter_number and pg_catalog.btrim(coalesce(p_customer_identifier, '')) = '' then
    raise exception '% needs the customer''s meter number.', v_ty.name using errcode = 'P0001';
  end if;
  if v_ty.requires_account_number and pg_catalog.btrim(coalesce(p_customer_identifier, '')) = '' then
    raise exception '% needs the customer''s account number.', v_ty.name using errcode = 'P0001';
  end if;
  if v_ty.requires_customer_name and pg_catalog.btrim(coalesce(p_customer_name, '')) = '' then
    raise exception '% needs the customer''s name.', v_ty.name using errcode = 'P0001';
  end if;

  -- Phase 4E, decision OD-5. A deposit's fee is always paid over and above
  -- the amount deposited, so there is no mode to choose; offering one would
  -- be a control with no effect.
  v_mode := nullif(pg_catalog.btrim(coalesce(p_customer_fee_mode, '')), '');

  if v_mode is not null and v_ty.direction in ('deposit', 'payment') then
    raise exception
      'A % fee is always collected on top of the amount, so it has no deduction mode.',
      v_ty.direction
      using errcode = 'P0001';
  end if;

  if v_mode is not null and coalesce(p_customer_fee, 0) = 0 then
    raise exception
      'A fee mode was given with no fee to apply it to.'
      using errcode = 'P0001';
  end if;

  insert into public.agency_transactions
    (branch_id, provider_id, transaction_type_id,
     float_account_id, payable_account_id, status,
     principal_amount, customer_fee, customer_fee_mode, commission_supplied,
     provider_reference, customer_identifier, customer_name, description,
     transaction_date, transacted_at, submitted_by, idempotency_key)
  values
    (v_branch, v_pr.id, v_ty.id,
     case when v_pr.float_model = 'provider_float' then p_float_account_id end,
     v_payable, 'draft',
     p_principal_amount, coalesce(p_customer_fee, 0), v_mode, p_commission_supplied,
     nullif(pg_catalog.btrim(coalesce(p_provider_reference, '')), ''),
     nullif(pg_catalog.btrim(coalesce(p_customer_identifier, '')), ''),
     nullif(pg_catalog.btrim(coalesce(p_customer_name, '')), ''),
     nullif(pg_catalog.btrim(coalesce(p_description, '')), ''),
     coalesce(p_transaction_date, public.business_date()),
     p_transacted_at,
     v_actor, p_idempotency_key)
  returning id into v_id;

  insert into public.agency_transaction_audit_log (transaction_id, action, actor_id, new_value)
  values (v_id, 'submit', v_actor,
          pg_catalog.jsonb_build_object('status', 'draft',
                                        'principal_amount', p_principal_amount));

  return v_id;
end;
$$;

comment on function public.create_agency_transaction(
  uuid, bigint, uuid, text, text, text, bigint, bigint, text, date, text, text, timestamptz) is
  'Phase 4A, hardened in 4B-S and 4D-F, extended in 4E. Records a draft agency transaction in the caller''s own branch. The idempotency key is honoured for a genuine retry and refused when the same key describes different details — the fee mode included. A deposit may not carry a fee mode, and a fee mode may not arrive without a fee.';

revoke all on function public.create_agency_transaction(
  uuid, bigint, uuid, text, text, text, bigint, bigint, text, date, text, text, timestamptz)
  from public, anon, authenticated;
grant execute on function public.create_agency_transaction(
  uuid, bigint, uuid, text, text, text, bigint, bigint, text, date, text, text, timestamptz)
  to authenticated;


drop function if exists public.update_agency_transaction(
  uuid, bigint, text, text, text, bigint, bigint, text);

create or replace function public.update_agency_transaction(
  p_transaction_id      uuid,
  p_principal_amount    bigint      default null,
  p_customer_identifier text        default null,
  p_customer_name       text        default null,
  p_provider_reference  text        default null,
  p_customer_fee        bigint      default null,
  p_commission_supplied bigint      default null,
  p_description         text        default null,
  p_customer_fee_mode   text        default null,
  p_transacted_at       timestamptz default null
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor uuid;
  t       public.agency_transactions;
  v_dir   text;
  v_mode  text;
begin
  v_actor := public.agency_actor('agency:write');

  -- Locks the row and refuses it if the caller's branch may not see it.
  t := public.agency_locked_transaction(p_transaction_id);

  if t.status <> 'draft' then
    raise exception
      'Only a draft can be edited; this one is %. Return it for correction first.', t.status
      using errcode = 'P0001';
  end if;

  v_mode := nullif(pg_catalog.btrim(coalesce(p_customer_fee_mode, '')), '');

  if v_mode is not null then
    select ty.direction into v_dir
    from public.agency_transaction_types ty where ty.id = t.transaction_type_id;

    if v_dir in ('deposit', 'payment') then
      raise exception
        'A % fee is always collected on top of the amount, so it has no deduction mode.',
        v_dir
        using errcode = 'P0001';
    end if;
  end if;

  update public.agency_transactions
     set principal_amount    = coalesce(p_principal_amount, principal_amount),
         customer_identifier = coalesce(nullif(pg_catalog.btrim(coalesce(p_customer_identifier, '')), ''), customer_identifier),
         customer_name       = coalesce(nullif(pg_catalog.btrim(coalesce(p_customer_name, '')), ''), customer_name),
         provider_reference  = coalesce(nullif(pg_catalog.btrim(coalesce(p_provider_reference, '')), ''), provider_reference),
         customer_fee        = coalesce(p_customer_fee, customer_fee),
         customer_fee_mode   = coalesce(v_mode, customer_fee_mode),
         commission_supplied = coalesce(p_commission_supplied, commission_supplied),
         description         = coalesce(nullif(pg_catalog.btrim(coalesce(p_description, '')), ''), description),
         transacted_at       = coalesce(p_transacted_at, transacted_at)
   where id = p_transaction_id;

  insert into public.agency_transaction_audit_log
    (transaction_id, action, actor_id, old_value, new_value)
  values (p_transaction_id, 'submit', v_actor,
          pg_catalog.jsonb_build_object('principal_amount', t.principal_amount,
                                        'customer_fee', t.customer_fee),
          pg_catalog.jsonb_build_object('principal_amount',
                                          coalesce(p_principal_amount, t.principal_amount),
                                        'customer_fee',
                                          coalesce(p_customer_fee, t.customer_fee)));
end;
$$;

comment on function public.update_agency_transaction(
  uuid, bigint, text, text, text, bigint, bigint, text, text, timestamptz) is
  'Phase 4B, extended in Phase 4E. Edits a draft agency transaction, including its fee mode and the provider''s own timestamp. A NULL argument leaves the field alone, which is what makes a partial edit possible; the revision trigger records that the financial details moved, so a Manager cannot verify a figure they have not seen.';

revoke all on function public.update_agency_transaction(
  uuid, bigint, text, text, text, bigint, bigint, text, text, timestamptz)
  from public, anon, authenticated;
grant execute on function public.update_agency_transaction(
  uuid, bigint, text, text, text, bigint, bigint, text, text, timestamptz)
  to authenticated;
