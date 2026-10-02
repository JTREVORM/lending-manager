-- ===========================================================================
-- Phase 6 — the trusted posting and reversal paths.
--
-- ## This is the authoritative implementation
--
-- `lib/domain/payment.ts` computes the preview a staff member sees before
-- confirming. **This writes the ledger.** It accepts an amount, a method, a
-- reference and an idempotency key, and nothing else: no allocations, no
-- balances, no payment number, no actor, no timestamp. A caller who could
-- supply allocations could credit a borrower's principal while leaving the
-- interest unpaid; a caller who could supply a balance could print any receipt
-- it liked.
--
-- `tests/db/payment-parity.test.ts` drives several hundred cases through both
-- implementations and asserts identical allocations.
--
-- ## No interest is ever calculated here
--
-- Interest is fixed by Phase 4 and distributed across collection dates by
-- Phase 5. A payment changes how much of it remains, never how much there is.
-- There is no rate, no day count and no balance multiplication anywhere in
-- this migration.
--
-- ## No division either
--
-- Allocation is a walk of `least` over integers. Interest-first means the
-- components of every allocation are `min()` results, so
-- `principal + interest = amount` holds exactly with nothing to round. See
-- ADR-031 for why that order was chosen over pro-rata.
-- ===========================================================================

create or replace function public.post_payment(
  p_loan_id uuid,
  p_amount bigint,
  p_payment_method text,
  p_external_reference text,
  p_idempotency_key uuid,
  p_notes text default null
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
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

  select * into v_client from public.clients where id = v_loan.client_id;

  if not found then
    raise exception 'The client on this loan no longer exists.' using errcode = 'P0001';
  end if;

  -- Note what is deliberately *not* checked: the client's status. A
  -- blacklisted or suspended borrower must still be able to repay — refusing
  -- their money would be both commercially absurd and a way to manufacture
  -- arrears. Eligibility gates lending, not repayment.

  -- --- The method and its reference ---------------------------------------
  if p_payment_method not in ('cash', 'mtn_mobile_money', 'airtel_money') then
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

  v_outstanding := public.loan_outstanding(p_loan_id);

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

  -- The minimum: the remaining amount of the earliest unpaid collection.
  -- Stated against the remainder rather than the nominal figure, so a
  -- collection a previous overpayment part-covered accepts what is actually
  -- left of it.
  select c.remaining_amount into v_minimum
  from public.loan_installment_coverage c
  where c.loan_id = p_loan_id and c.remaining_amount > 0
  order by c.due_date, c.installment_number
  limit 1;

  if v_minimum is not null and p_amount < v_minimum then
    raise exception
      'The smallest payment accepted now is % shillings, the amount still outstanding on the earliest unpaid collection.',
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
    p_idempotency_key, pg_catalog.now(), v_actor,
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
      c.installment_id,
      c.remaining_amount,
      c.remaining_interest,
      c.remaining_principal,
      pg_catalog.sum(c.remaining_amount) over (
        order by c.due_date, c.installment_number
        rows between unbounded preceding and 1 preceding
      ) as owed_before
    from public.loan_installment_coverage c
    where c.loan_id = p_loan_id
      and c.remaining_amount > 0
  ),
  taken as (
    select
      o.installment_id,
      o.remaining_interest,
      o.remaining_principal,
      least(
        o.remaining_amount,
        greatest(p_amount - coalesce(o.owed_before, 0), 0)
      ) as take
    from ordered o
  )
  insert into public.payment_allocations (
    payment_id, installment_id, loan_id,
    allocated_amount, allocated_principal, allocated_interest
  )
  select
    v_payment_id,
    t.installment_id,
    p_loan_id,
    t.take,
    -- Interest first: what is left of the part-payment once this
    -- collection's outstanding interest has been covered.
    t.take - least(t.remaining_interest, t.take),
    least(t.remaining_interest, t.take)
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

  -- No collection over-allocated, in total or in either component. Checked
  -- across the whole loan rather than only the rows this payment touched, so
  -- a pre-existing inconsistency cannot be built upon.
  select c.installment_number, c.remaining_amount, c.remaining_principal,
         c.remaining_interest
    into v_mismatch
  from public.loan_installment_coverage c
  where c.loan_id = p_loan_id
    and (
      c.remaining_amount < 0
      or c.remaining_principal < 0
      or c.remaining_interest < 0
    )
  order by c.installment_number
  limit 1;

  if v_mismatch is not null then
    raise exception
      'Payment reconciliation failed: collection % is over-allocated (remaining amount %, principal %, interest %).',
      v_mismatch.installment_number, v_mismatch.remaining_amount,
      v_mismatch.remaining_principal, v_mismatch.remaining_interest
      using errcode = 'P0001';
  end if;

  -- The headline reconciliation: posted payments equal posted allocations.
  v_after := public.loan_outstanding(p_loan_id);

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

  return v_payment_id;
end;
$$;

comment on function public.post_payment(uuid, bigint, text, text, uuid, text) is
  'Records a payment against an active loan and allocates it oldest-collection-first, interest before principal, in one transaction. Idempotent on the key. Accepts no allocation, balance, actor, timestamp or payment number from its caller. Clears the loan when the balance reaches zero.';

revoke all on function public.post_payment(uuid, bigint, text, text, uuid, text)
  from public, anon, authenticated;
grant execute on function public.post_payment(uuid, bigint, text, text, uuid, text)
  to authenticated;

-- ===========================================================================
-- Reversal
--
-- ## A reversal is not a deletion
--
-- The payment row, its amount, its method, its receipt figures and all of its
-- allocations remain exactly as posted. What changes is one status, and the
-- balance views stop counting the allocations of a payment that is no longer
-- posted.
--
-- That gives the strongest audit position available: a reader can see that
-- UGX 10,000 was taken on a Tuesday, where every shilling of it was applied,
-- who reversed it, when and why. An architecture that removed the rows, or
-- that posted a mirror-image contra payment, would answer the first question
-- less directly — and a contra entry would make
-- "allocations equal the payment amount" ambiguous for every reader of the
-- table. See ADR-028.
-- ===========================================================================

create or replace function public.reverse_payment(
  p_payment_id uuid,
  p_reason text
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
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
  v_before := public.loan_outstanding(v_payment.loan_id);

  -- The reversal itself. `reversed_at` and `reversed_by` are stamped by the
  -- guard trigger from the session, not by this function and not by its
  -- caller.
  update public.loan_payments
     set status = 'reversed',
         reversed_at = pg_catalog.now(),
         reversed_by = public.current_profile_id(),
         reversal_reason = pg_catalog.btrim(p_reason)
   where id = p_payment_id;

  -- --- Reopen, if the money is owed again ---------------------------------
  v_after := public.loan_outstanding(v_payment.loan_id);

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

  return p_payment_id;
end;
$$;

comment on function public.reverse_payment(uuid, text) is
  'Reverses a posted payment with a required reason, reopening the loan if it owes money again. The payment and every allocation remain on record; they stop counting. Double reversal is refused by the guard trigger.';

revoke all on function public.reverse_payment(uuid, text) from public, anon, authenticated;
grant execute on function public.reverse_payment(uuid, text) to authenticated;
