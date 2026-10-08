-- ===========================================================================
-- Phase 10.3 — the money functions post to the ledger
--
-- Three functions, one added line each. The bodies below are the *exact*
-- text PostgreSQL holds for them, extracted with `pg_get_functiondef` and
-- re-emitted with a single `perform` inserted before the final `return`.
-- They were not retyped: a transcription slip inside three hundred lines of
-- allocation arithmetic is the most expensive kind of mistake available
-- here, so the only human-written content in this migration is the comment
-- block and the one call in each.
--
-- ## Atomicity
--
-- Each posting function raises on any failure, and a raise inside a
-- PL/pgSQL function with no handler aborts the whole transaction. So there
-- is no ordering of events in which the loan or payment mutation commits and
-- the journal does not: the money record and its two ledger sides are one
-- transaction or they are nothing.
--
-- ## Why `ensure_penalty_applied` is not here
--
-- Because charging a penalty moves no money. Under the cash-basis
-- recognition this ledger uses — stated at the head of migration
-- 20261010000200 — penalty income arises when the borrower pays, and it
-- reaches the books through the `allocated_penalty` component of the
-- repayment that settles it. A journal at charge time would have to credit
-- income that has not been received and debit an asset the model does not
-- carry. The penalty is already recorded, in `loan_penalties`, and already
-- shown in the outstanding balance; what it is not is cash.
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.disburse_loan(p_loan_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_loan   public.loans;
  v_client public.clients;
begin
  select * into v_loan from public.loans where id = p_loan_id for update;

  if not found then
    raise exception 'No such loan.' using errcode = 'P0001';
  end if;

  -- A second tap finds the loan already active and is refused cleanly, rather
  -- than disbursing twice.
  if v_loan.status <> 'approved' then
    raise exception
      'Only an approved loan can be disbursed; this one is %.', v_loan.status
      using errcode = 'P0001';
  end if;

  if auth.uid() is not null and not public.user_has_permission('loans:disburse') then
    raise exception 'Disbursing a loan requires the loans:disburse capability.'
      using errcode = 'P0001';
  end if;

  -- Eligibility again. A client blacklisted between approval and disbursement
  -- must not receive money.
  select * into v_client from public.clients where id = v_loan.client_id;

  if v_client.status <> 'active' then
    raise exception
      'This client is % and cannot receive a disbursement.', v_client.status
      using errcode = 'P0001';
  end if;

  -- The breakdown must exist before money moves. If it does not, approval was
  -- incomplete and disbursing would create an active loan nobody can collect.
  if not exists (select 1 from public.loan_periods where loan_id = p_loan_id) then
    raise exception 'This loan has no contractual breakdown and cannot be disbursed.'
      using errcode = 'P0001';
  end if;

  if not exists (select 1 from public.loan_client_snapshots where loan_id = p_loan_id) then
    raise exception 'This loan has no client snapshot and cannot be disbursed.'
      using errcode = 'P0001';
  end if;

  -- `disbursed_at` and `disbursed_by` are stamped by the transition trigger,
  -- and the active-limit trigger fires on this same statement.
  update public.loans set status = 'active' where id = p_loan_id;

  -- --- Phase 5: the collection plan, in this same transaction -------------
  --
  -- After the UPDATE, because the schedule is anchored on the `disbursed_at`
  -- the trigger has just stamped — the moment the borrower actually received
  -- the money, not the date somebody proposed earlier.
  --
  -- If this raises for any reason — a cadence too infrequent for the
  -- contractual months, a reconciliation failure, a missing timezone — the
  -- exception propagates and the whole transaction rolls back: the loan stays
  -- `approved`, no installment survives, and the `loan.disbursed` audit entry
  -- the UPDATE produced is rolled back with it. There is no partial outcome
  -- and no misleading success in the trail.
  perform public.generate_loan_schedule(p_loan_id);


  -- --- Phase 10: the ledger ----------------------------------------------
  --
  -- Dr Loans Receivable, Cr the branch's Cash at Hand, in this transaction.
  -- If it raises — no branch account, a missing chart row — the exception
  -- propagates and the disbursement goes with it. There is deliberately no
  -- path that pays money out and leaves the ledger unaware of it.
  perform public.post_disbursement_journal(p_loan_id);
  return p_loan_id;
end;
$function$;

CREATE OR REPLACE FUNCTION public.post_payment(p_loan_id uuid, p_amount bigint, p_payment_method text, p_external_reference text, p_idempotency_key uuid, p_notes text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_loan        public.loans;
  v_client      public.clients;
  v_actor       uuid;
  v_reference   text;
  v_outstanding bigint;
  v_minimum     bigint;
  v_payment_id  uuid;
  v_allocated   bigint;
  v_mismatch    record;
  v_after       bigint;
  v_penalty_id  uuid;
begin
  -- --- Idempotency, before anything else ---------------------------------
  --
  -- The lock is taken on the *key*, not the loan, so two deliveries of the
  -- same submission serialise against each other even before the loan is
  -- known. Without it both could find no existing payment and both proceed;
  -- the unique constraint would stop the second committing, but with a
  -- constraint violation rather than the clean replay below.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('payment_key:' || p_idempotency_key::text)
  );

  select id into v_payment_id
  from public.loan_payments
  where idempotency_key = p_idempotency_key;

  -- A retried submission — a double tap, a lost response, a replayed form —
  -- returns the payment that already exists. The money is recorded once and
  -- the caller gets the same answer it would have got the first time.
  if v_payment_id is not null then
    return v_payment_id;
  end if;

  -- --- The actor ----------------------------------------------------------
  -- Derived from the session, never a parameter. A payment that cannot name
  -- who received the money is not a record anybody can be held to — the
  -- ADR-025 rule, applied to the counter.
  v_actor := public.current_profile_id();

  if v_actor is null then
    raise exception
      'A payment must be recorded by a signed-in member of staff.'
      using errcode = 'P0001';
  end if;

  if auth.uid() is not null and not public.user_has_permission('payments:create') then
    raise exception 'Recording a payment requires the payments:create capability.'
      using errcode = 'P0001';
  end if;

  -- --- The loan -----------------------------------------------------------
  -- Locked for the rest of the transaction, so a concurrent payment against
  -- the same loan waits here rather than racing the allocation below.
  select * into v_loan from public.loans where id = p_loan_id for update;

  if not found then
    raise exception 'No such loan.' using errcode = 'P0001';
  end if;

  -- Only a live loan can receive money. A draft, a loan awaiting approval and
  -- an approved-but-undisbursed loan have had nothing paid out to repay; a
  -- cancelled loan was never agreed; and a cleared loan owes nothing, which
  -- the outstanding check below would catch anyway but which deserves its own
  -- message.
  if v_loan.status = 'cleared' then
    raise exception
      'Loan % is fully repaid. There is nothing left to pay.', v_loan.loan_number
      using errcode = 'P0001';
  end if;

  if v_loan.status <> 'active' then
    raise exception
      'A payment can only be recorded against an active loan; loan % is %.',
      v_loan.loan_number, v_loan.status
      using errcode = 'P0001';
  end if;

  -- --- Phase 7: the penalty, before any balance is read ------------------
  --
  -- This is the critical ordering in the whole phase. If a loan is already
  -- past its grace deadline, the charge exists as a matter of business rule
  -- whether or not anything has written it down yet — so it is written down
  -- *here*, before the outstanding balance is read, before the cap is
  -- applied, and before the receipt figures are frozen.
  --
  -- Without this a borrower could walk in after the grace period, pay the
  -- contractual balance to the shilling, and have the loan clear — escaping a
  -- penalty that was due, purely because no scheduled job had run. The
  -- materialisation shares this transaction and this loan's row lock, so the
  -- two cannot interleave.
  v_penalty_id := public.ensure_penalty_applied(p_loan_id);

  select * into v_client from public.clients where id = v_loan.client_id;

  if not found then
    raise exception 'The client on this loan no longer exists.' using errcode = 'P0001';
  end if;

  -- Note what is deliberately *not* checked: the client's status. A
  -- blacklisted or suspended borrower must still be able to repay — refusing
  -- their money would be both commercially absurd and a way to manufacture
  -- arrears. Eligibility gates lending, not repayment.

  -- --- The method and its reference ---------------------------------------
  -- Phase 10 adds Bank. The table constraint was widened in migration
  -- 20261010000200; this is the function's own copy of the same rule, which
  -- exists so the caller gets a sentence rather than a constraint name.
  if p_payment_method not in ('cash', 'mtn_mobile_money', 'airtel_money', 'bank') then
    raise exception 'Unknown payment method "%".', p_payment_method
      using errcode = 'P0001';
  end if;

  -- Normalised once, here, so every stored reference is comparable and the
  -- uniqueness rule cannot be defeated by whitespace or case. Trimmed and
  -- upper-cased; nothing else is stripped, because an internal character a
  -- network put there is part of the reference.
  v_reference := pg_catalog.upper(pg_catalog.btrim(coalesce(p_external_reference, '')));

  if v_reference = '' then
    v_reference := null;
  end if;

  if p_payment_method = 'cash' then
    -- Forbidden rather than ignored. Silently dropping a reference a staff
    -- member typed would lose information they thought they had recorded.
    if v_reference is not null then
      raise exception
        'A cash payment has no network reference. Its payment number is its reference.'
        using errcode = 'P0001';
    end if;
  elsif v_reference is null then
    -- Everything that is not cash arrives through somebody else's system and
    -- carries their reference. Without it a posting cannot be matched back to
    -- a statement, which is the whole of reconciliation.
    if p_payment_method = 'bank' then
      raise exception
        'A bank payment needs the transfer reference from the statement. It is what makes the posting reconcilable.'
        using errcode = 'P0001';
    end if;

    raise exception
      'A Mobile Money payment needs the transaction reference from the network. It is what makes a duplicate posting detectable.'
      using errcode = 'P0001';
  elsif char_length(v_reference) < 4 then
    raise exception
      'That transaction reference is too short to identify a payment.'
      using errcode = 'P0001';
  end if;

  -- The duplicate check, stated explicitly so the message explains itself.
  -- The unique index is the real guarantee — it holds under concurrency,
  -- where this check alone would not.
  if v_reference is not null and exists (
    select 1 from public.loan_payments
    where payment_method = p_payment_method and external_reference = v_reference
  ) then
    raise exception
      'A % payment with reference % has already been recorded.',
      p_payment_method, v_reference
      using errcode = 'P0001';
  end if;

  -- --- The amount ---------------------------------------------------------
  if p_amount is null or p_amount <= 0 then
    raise exception 'A payment must be more than zero shillings.'
      using errcode = 'P0001';
  end if;

  -- Everything the borrower owes: the contract plus any unpaid penalty. The
  -- cap, the receipt figures and the clearance test are all this figure, so a
  -- penalty cannot be paid around.
  v_outstanding := public.loan_total_outstanding(p_loan_id);

  if v_outstanding <= 0 then
    raise exception
      'Loan % owes nothing further.', v_loan.loan_number
      using errcode = 'P0001';
  end if;

  -- No credit balances in this phase. A borrower offering more than they owe
  -- is told the balance rather than having the excess parked somewhere
  -- nothing in the system knows how to return.
  if p_amount > v_outstanding then
    raise exception
      'That is more than loan % still owes. The outstanding balance is % shillings.',
      v_loan.loan_number, v_outstanding
      using errcode = 'P0001';
  end if;

  -- The minimum: the remaining amount of the earliest unpaid **obligation**.
  -- Stated against the remainder rather than the nominal figure, so an
  -- obligation a previous overpayment part-covered accepts what is actually
  -- left of it.
  --
  -- Phase 7 widens the source from collections to obligations, which changes
  -- nothing while any collection is unpaid — a penalty's effective date is
  -- later than every due date, so it sorts last — and makes the rule say the
  -- right thing once the contract is settled and only a penalty remains: then
  -- the minimum is what is left of the penalty.
  select o.remaining_amount into v_minimum
  from public.loan_obligations o
  where o.loan_id = p_loan_id and o.remaining_amount > 0
  order by o.effective_date, o.obligation_rank, o.sequence_number
  limit 1;

  if v_minimum is not null and p_amount < v_minimum then
    raise exception
      'The smallest payment accepted now is % shillings, the amount still outstanding on the earliest unpaid obligation.',
      v_minimum
      using errcode = 'P0001';
  end if;

  -- --- Record the payment -------------------------------------------------
  -- The payment number is minted by the trigger; the receipt balances and the
  -- snapshots are computed here from figures this function derived.
  insert into public.loan_payments (
    loan_id, client_id, amount, payment_method, external_reference,
    idempotency_key, received_at, recorded_by,
    outstanding_before, outstanding_after,
    client_name_at_payment, recorded_by_label, notes
  )
  values (
    p_loan_id, v_loan.client_id, p_amount, p_payment_method, v_reference,
    -- Phase 7: `business_now()` rather than `pg_catalog.now()`. Still not
    -- caller-supplied — a clock the client controls would decide which
    -- collections a payment covers, and whether it beat a grace deadline —
    -- but now the same clock the delinquency comparisons use, so a payment's
    -- business date and the business date can never disagree.
    p_idempotency_key, public.business_now(), v_actor,
    v_outstanding, v_outstanding - p_amount,
    v_client.full_name, public.audit_actor_label(),
    nullif(pg_catalog.btrim(coalesce(p_notes, '')), '')
  )
  returning id into v_payment_id;

  -- --- Allocate it --------------------------------------------------------
  --
  -- One statement, not a loop. A payment settling a month of daily
  -- collections touches thirty rows, and a per-row insert would fire the
  -- append-only and audit triggers thirty times.
  --
  -- The running total is what makes this work without a loop: for each unpaid
  -- collection in due-date order, `before` is everything still owed on the
  -- *earlier* ones, so what this collection receives is whatever the payment
  -- has left after them — clamped to what it is owed, and floored at zero so
  -- collections beyond the payment's reach drop out.
  --
  -- `least`, `greatest` and `coalesce` are SQL constructs rather than
  -- functions: the parser resolves them, so they are deliberately unqualified
  -- even under `search_path = ''`. A `pg_catalog.`-qualified form of any of
  -- them does not exist and fails at parse time, which is how this was
  -- found. The same applies to `nullif`.
  with ordered as (
    select
      o.installment_id,
      o.penalty_id,
      o.remaining_amount,
      o.remaining_interest,
      o.remaining_penalty,
      pg_catalog.sum(o.remaining_amount) over (
        order by o.effective_date, o.obligation_rank, o.sequence_number
        rows between unbounded preceding and 1 preceding
      ) as owed_before
    from public.loan_obligations o
    where o.loan_id = p_loan_id
      and o.remaining_amount > 0
  ),
  taken as (
    select
      o.installment_id,
      o.penalty_id,
      o.remaining_interest,
      o.remaining_penalty,
      least(
        o.remaining_amount,
        greatest(p_amount - coalesce(o.owed_before, 0), 0)
      ) as take
    from ordered o
  )
  insert into public.payment_allocations (
    payment_id, installment_id, penalty_id, loan_id,
    allocated_amount, allocated_principal, allocated_interest, allocated_penalty
  )
  select
    v_payment_id,
    t.installment_id,
    t.penalty_id,
    p_loan_id,
    t.take,
    -- The three components, each a `least` of two integers, so they sum to the
    -- amount exactly with nothing to round. An obligation is either
    -- contractual or a penalty, never both, so at most one of the two `least`
    -- terms below is non-zero for any row:
    --
    --   a collection -> remaining_penalty is 0, so interest first, then principal
    --   a penalty    -> remaining_interest is 0, so the whole take is penalty
    --
    -- Principal is what is left over, which is what keeps a penalty from ever
    -- being recorded as principal or as contractual interest. The table's
    -- CHECK constraints refuse the row if it ever were.
    t.take
      - least(t.remaining_interest, t.take)
      - least(t.remaining_penalty, t.take),
    least(t.remaining_interest, t.take),
    least(t.remaining_penalty, t.take)
  from taken t
  where t.take > 0;

  -- --- Reconcile, inside the transaction ----------------------------------
  --
  -- The allocation above is exact by construction, but "by construction" is an
  -- argument and this is a ledger. A failure here rolls back the payment, its
  -- allocations and the audit entries together, so there is no partial
  -- posting and no misleading success in the trail.

  select pg_catalog.sum(allocated_amount) into v_allocated
  from public.payment_allocations
  where payment_id = v_payment_id;

  -- No unallocated money, and none invented.
  if v_allocated is distinct from p_amount then
    raise exception
      'Payment reconciliation failed: % shillings were recorded but % allocated.',
      p_amount, coalesce(v_allocated, 0)
      using errcode = 'P0001';
  end if;

  -- No obligation over-allocated, in total or in any component. Checked
  -- across the whole loan rather than only the rows this payment touched, so
  -- a pre-existing inconsistency cannot be built upon — and across penalties
  -- as well as collections, so a payment cannot over-cover a charge either.
  select o.obligation_kind, o.sequence_number, o.remaining_amount,
         o.remaining_principal, o.remaining_interest, o.remaining_penalty
    into v_mismatch
  from public.loan_obligations o
  where o.loan_id = p_loan_id
    and (
      o.remaining_amount < 0
      or o.remaining_principal < 0
      or o.remaining_interest < 0
      or o.remaining_penalty < 0
    )
  order by o.effective_date, o.obligation_rank, o.sequence_number
  limit 1;

  if v_mismatch is not null then
    raise exception
      'Payment reconciliation failed: % % is over-allocated (remaining amount %, principal %, interest %, penalty %).',
      v_mismatch.obligation_kind, v_mismatch.sequence_number,
      v_mismatch.remaining_amount, v_mismatch.remaining_principal,
      v_mismatch.remaining_interest, v_mismatch.remaining_penalty
      using errcode = 'P0001';
  end if;

  -- The headline reconciliation: posted payments equal posted allocations.
  v_after := public.loan_total_outstanding(p_loan_id);

  if v_after < 0 then
    raise exception
      'Payment reconciliation failed: the loan would owe % shillings.', v_after
      using errcode = 'P0001';
  end if;

  if v_after <> v_outstanding - p_amount then
    raise exception
      'Payment reconciliation failed: the balance moved from % to %, not to %.',
      v_outstanding, v_after, v_outstanding - p_amount
      using errcode = 'P0001';
  end if;

  -- --- Clearance ----------------------------------------------------------
  -- Automatic, in this same transaction, and never a manual act. The
  -- transition guard re-derives the balance itself before permitting it, so
  -- this cannot clear a loan that still owes money even if the arithmetic
  -- above were wrong.
  if v_after = 0 then
    update public.loans set status = 'cleared' where id = p_loan_id;
  end if;


  -- --- Phase 10: the ledger ----------------------------------------------
  --
  -- Last, after the allocations exist and after the reconciliation above has
  -- proved them, because the journal is posted *from* those allocations. A
  -- failure here rolls back the payment, its allocations, the clearance and
  -- the audit entries together.
  perform public.post_repayment_journal(v_payment_id);
  return v_payment_id;
end;
$function$;

CREATE OR REPLACE FUNCTION public.reverse_payment(p_payment_id uuid, p_reason text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_payment public.loan_payments;
  v_loan    public.loans;
  v_before  bigint;
  v_after   bigint;
begin
  if p_reason is null or pg_catalog.btrim(p_reason) = '' then
    raise exception 'Reversing a payment requires a reason.' using errcode = 'P0001';
  end if;

  -- Serialises two reversal attempts on one payment. The row lock below would
  -- do it too; the advisory lock makes the ordering explicit and keeps the
  -- "already reversed" message the one the loser sees.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('payment_reverse:' || p_payment_id::text)
  );

  select * into v_payment from public.loan_payments where id = p_payment_id for update;

  if not found then
    raise exception 'No such payment.' using errcode = 'P0001';
  end if;

  if v_payment.status = 'reversed' then
    raise exception
      'Payment % was already reversed on %.',
      v_payment.payment_number, v_payment.reversed_at
      using errcode = 'P0001';
  end if;

  if auth.uid() is not null and not public.user_has_permission('payments:reverse') then
    raise exception 'Reversing a payment requires the payments:reverse capability.'
      using errcode = 'P0001';
  end if;

  -- The loan is locked before the payment's status changes, so a concurrent
  -- payment posting cannot interleave with the reopening below.
  select * into v_loan from public.loans where id = v_payment.loan_id for update;

  -- The live balance, taken now. Deliberately **not**
  -- `v_payment.outstanding_after`: that is what the receipt said at the
  -- counter, frozen, and it is only the current balance if nothing has
  -- happened since. Reversing the first of two payments would compare against
  -- a figure two payments out of date — which is exactly the confusion
  -- ADR-029 exists to prevent, and the first draft of this function walked
  -- into it.
  -- Phase 7: the **total** obligation, penalty included. A payment may have
  -- been allocated partly to a penalty, in which case the contractual figure
  -- alone would not rise by the payment's amount and the reconciliation below
  -- would refuse a correct reversal.
  v_before := public.loan_total_outstanding(v_payment.loan_id);

  -- The reversal itself. `reversed_at` and `reversed_by` are stamped by the
  -- guard trigger from the session, not by this function and not by its
  -- caller.
  update public.loan_payments
     set status = 'reversed',
         reversed_at = public.business_now(),
         reversed_by = public.current_profile_id(),
         reversal_reason = pg_catalog.btrim(p_reason)
   where id = p_payment_id;

  -- --- Reopen, if the money is owed again ---------------------------------
  v_after := public.loan_total_outstanding(v_payment.loan_id);

  if v_after < 0 then
    raise exception
      'Reversal reconciliation failed: the loan would owe % shillings.', v_after
      using errcode = 'P0001';
  end if;

  -- A cleared loan that owes money again must say so. The transition guard
  -- re-derives the balance before permitting it, so this cannot reopen a loan
  -- that is still settled.
  if v_loan.status = 'cleared' and v_after > 0 then
    update public.loans set status = 'active' where id = v_payment.loan_id;
  end if;

  -- The balance must have risen by exactly the reversed amount, from whatever
  -- it was immediately before. Nothing else about the loan may have moved, and
  -- payments recorded after this one are unaffected.
  if v_after <> v_before + v_payment.amount then
    raise exception
      'Reversal reconciliation failed: the balance moved from % to %, not to %.',
      v_before, v_after, v_before + v_payment.amount
      using errcode = 'P0001';
  end if;

  -- The allocations are still there, untouched, and still attached to the
  -- payment. Asserted because their survival is the whole audit value of
  -- reversing rather than deleting.
  if not exists (
    select 1 from public.payment_allocations where payment_id = p_payment_id
  ) then
    raise exception
      'Reversal reconciliation failed: the payment''s allocations are missing.'
      using errcode = 'P0001';
  end if;

  -- --- Phase 7: a reversal can make a penalty due -------------------------
  --
  -- A loan that was settled during its grace period, and so never incurred a
  -- penalty, is a loan whose exemption rested on money that has now been
  -- withdrawn. The basis is recomputed from the effective ledger — in which
  -- the reversed payment no longer counts — so if the loan did owe money at
  -- the grace deadline after all, and that deadline has passed, the charge
  -- applies now.
  --
  -- The alternative would be to exempt a loan because it *temporarily looked*
  -- cleared, which is an exemption anybody could manufacture. Note the
  -- ordering: this runs after the reconciliation above, because materialising
  -- a penalty legitimately moves the total outstanding and the assertion is
  -- about the reversal alone.
  perform public.ensure_penalty_applied(v_payment.loan_id);


  -- --- Phase 10: the ledger ----------------------------------------------
  --
  -- The contra entry. Posted after `ensure_penalty_applied` above, so that a
  -- penalty the reversal re-exposes is already materialised and this
  -- transaction either records both or neither.
  perform public.post_reversal_journal(p_payment_id);
  return p_payment_id;
end;
$function$;
