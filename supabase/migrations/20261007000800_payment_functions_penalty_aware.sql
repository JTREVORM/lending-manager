-- ===========================================================================
-- Phase 7 — the money functions, made penalty-aware.
--
-- Three functions are restated here in full, because PostgreSQL replaces a
-- function body wholesale and there is no way to patch a line of one. The
-- changes are small and each is marked with a Phase 7 comment at the point it
-- occurs; everything else is Phase 6's text unchanged, carried over
-- deliberately rather than rewritten.
--
-- ## `loans_guard_transition`
--
-- The ledger test for clearance and reopening now reads
-- `loan_total_outstanding` instead of `loan_outstanding`. That single
-- substitution is what makes "a loan may never be cleared while an unpaid
-- penalty remains" an invariant of the database rather than a rule the
-- application remembers — and it binds `service_role` and the table owner
-- like every other rule in that function.
--
-- ## `post_payment`
--
--   * materialises an eligible penalty **first**, before any balance is read;
--   * caps the payment at the total obligation, penalty included, and freezes
--     that figure onto the receipt;
--   * allocates over `loan_obligations` rather than installments alone, so
--     the same oldest-first rule reaches a penalty with no special case;
--   * reconciles against the total, and clears the loan only when the total
--     reaches zero.
--
-- ## `reverse_payment`
--
--   * reconciles against the total, because a reversed payment may have been
--     partly allocated to a penalty;
--   * materialises a penalty afterwards if withdrawing the money means one is
--     now due.
--
-- ## What did not change
--
-- The receipt figures of **existing** payments. Nothing here rewrites a
-- stored `outstanding_before` or `outstanding_after`: a Phase 6 receipt says
-- what it said, and a receipt issued after a penalty exists includes the
-- penalty because the function froze the total at the moment it posted. That
-- is the ADR-029 distinction holding up under a new kind of obligation.
-- ===========================================================================

create or replace function public.loans_guard_transition()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_allowed     boolean;
  v_approving   boolean;
  v_outstanding bigint;
begin
  -- --- Rules binding every caller, including service_role ------------------
  -- Stated before the trusted-path exemption, following the Phase 2 lesson: a
  -- rule after the exemption is one the privileged client can skip, and a
  -- leaked secret key becomes the privileged client.

  if new.loan_number is distinct from old.loan_number then
    raise exception 'A loan number cannot be changed once issued.'
      using errcode = 'P0001';
  end if;

  if new.created_by is distinct from old.created_by
     or new.created_at is distinct from old.created_at then
    raise exception 'Loan provenance cannot be rewritten.'
      using errcode = 'P0001';
  end if;

  -- The transition itself.
  if new.status is distinct from old.status then
    v_allowed := (old.status, new.status) in (
      ('draft', 'pending_approval'),
      ('draft', 'cancelled'),
      ('pending_approval', 'draft'),
      ('pending_approval', 'approved'),
      ('pending_approval', 'cancelled'),
      ('approved', 'active'),
      ('approved', 'cancelled'),
      ('active', 'cleared'),
      -- Phase 6: a reversal that leaves money outstanding reopens the loan.
      ('cleared', 'active')
    );

    if not v_allowed then
      raise exception
        'A loan cannot move from % to %.', old.status, new.status
        using errcode = 'P0001';
    end if;
  end if;

  -- --- Phase 6: the status may never contradict the ledger -----------------
  --
  -- Checked from the data rather than trusted to a caller or a session
  -- marker, so these two transitions are correct whatever path reached them —
  -- the posting function, a direct UPDATE, or `service_role`.
  -- Phase 7 changes one thing here, and it is the thing that matters: the
  -- figure is now `loan_total_outstanding`, which includes an unpaid penalty.
  -- With the Phase 6 function a borrower could settle their contractual
  -- obligations, leave a 50,000 penalty standing, and the loan would clear.
  if new.status = 'cleared' and old.status = 'active' then
    v_outstanding := public.loan_total_outstanding(new.id);

    if v_outstanding <> 0 then
      raise exception
        'This loan cannot be cleared: % shillings are still outstanding, penalty included.',
        v_outstanding
        using errcode = 'P0001';
    end if;
  end if;

  if new.status = 'active' and old.status = 'cleared' then
    v_outstanding := public.loan_total_outstanding(new.id);

    if v_outstanding <= 0 then
      raise exception
        'This loan cannot be reopened: it owes nothing.'
        using errcode = 'P0001';
    end if;
  end if;

  -- --- Attribution is the database''s to write ----------------------------
  -- Derived from the session at the moment of the transition, and a supplied
  -- value is refused. Without this, an approval could name somebody who never
  -- saw the loan — precisely the record a dispute turns on.

  if new.status = 'pending_approval' and old.status = 'draft' then
    if new.submitted_at is distinct from old.submitted_at
       or new.submitted_by is distinct from old.submitted_by then
      raise exception 'Submission attribution is maintained by the database.'
        using errcode = 'P0001';
    end if;

    new.submitted_at := pg_catalog.now();
    new.submitted_by := public.current_profile_id();
  elsif new.status = 'draft' and old.status = 'pending_approval' then
    new.submitted_at := null;
    new.submitted_by := null;
  elsif new.submitted_at is distinct from old.submitted_at
     or new.submitted_by is distinct from old.submitted_by then
    raise exception 'Submission attribution is maintained by the database.'
      using errcode = 'P0001';
  end if;

  if new.status = 'approved' and old.status = 'pending_approval' then
    if new.approved_at is distinct from old.approved_at
       or new.approved_by is distinct from old.approved_by then
      raise exception 'Approval attribution is maintained by the database.'
        using errcode = 'P0001';
    end if;

    new.approved_at := pg_catalog.now();
    new.approved_by := public.current_profile_id();
  elsif new.approved_at is distinct from old.approved_at
     or new.approved_by is distinct from old.approved_by then
    raise exception 'Approval attribution is maintained by the database.'
      using errcode = 'P0001';
  end if;

  if new.status = 'active' and old.status = 'approved' then
    if new.disbursed_at is distinct from old.disbursed_at
       or new.disbursed_by is distinct from old.disbursed_by then
      raise exception 'Disbursement attribution is maintained by the database.'
        using errcode = 'P0001';
    end if;

    new.disbursed_at := pg_catalog.now();
    new.disbursed_by := public.current_profile_id();
  elsif new.disbursed_at is distinct from old.disbursed_at
     or new.disbursed_by is distinct from old.disbursed_by then
    raise exception 'Disbursement attribution is maintained by the database.'
      using errcode = 'P0001';
  end if;

  if new.status = 'cancelled' and old.status <> 'cancelled' then
    if new.cancelled_at is distinct from old.cancelled_at
       or new.cancelled_by is distinct from old.cancelled_by then
      raise exception 'Cancellation attribution is maintained by the database.'
        using errcode = 'P0001';
    end if;

    new.cancelled_at := pg_catalog.now();
    new.cancelled_by := public.current_profile_id();
  elsif new.cancelled_at is distinct from old.cancelled_at
     or new.cancelled_by is distinct from old.cancelled_by then
    raise exception 'Cancellation attribution is maintained by the database.'
      using errcode = 'P0001';
  end if;

  -- --- Phase 6: clearance attribution, on the same terms ------------------
  if new.status = 'cleared' and old.status = 'active' then
    if new.cleared_at is distinct from old.cleared_at
       or new.cleared_by is distinct from old.cleared_by then
      raise exception 'Clearance attribution is maintained by the database.'
        using errcode = 'P0001';
    end if;

    new.cleared_at := pg_catalog.now();
    new.cleared_by := public.current_profile_id();
  elsif new.status = 'active' and old.status = 'cleared' then
    -- Reopened. The stamp is cleared, so the column keeps meaning "currently
    -- cleared, at this time" rather than "was cleared once". Both events are
    -- in the audit trail, which is where history belongs.
    new.cleared_at := null;
    new.cleared_by := null;
  elsif new.cleared_at is distinct from old.cleared_at
     or new.cleared_by is distinct from old.cleared_by then
    raise exception 'Clearance attribution is maintained by the database.'
      using errcode = 'P0001';
  end if;

  -- --- What freezes, and when ---------------------------------------------
  v_approving := old.status = 'pending_approval' and new.status = 'approved';

  if old.status <> 'draft' then
    -- Rule one: the shape of the agreement.
    if new.principal_amount is distinct from old.principal_amount
       or new.loan_term_months is distinct from old.loan_term_months
       or new.repayment_frequency is distinct from old.repayment_frequency
       or new.client_id is distinct from old.client_id
       or new.currency_code is distinct from old.currency_code
       or new.proposed_disbursement_date is distinct from old.proposed_disbursement_date then
      raise exception
        'The agreed terms of a loan cannot be changed after it leaves draft. Cancel it and issue a new loan.'
        using errcode = 'P0001';
    end if;

    -- Rule two: the price, and the policy it was priced under.
    if not v_approving then
      if new.interest_rate_bps is distinct from old.interest_rate_bps
         or new.interest_method is distinct from old.interest_method then
        raise exception
          'A loan''s interest rate is set at approval and cannot be changed afterwards.'
          using errcode = 'P0001';
      end if;

      if new.total_interest is distinct from old.total_interest
         or new.total_expected_repayment is distinct from old.total_expected_repayment then
        raise exception
          'Loan totals are computed at approval and cannot be changed afterwards.'
          using errcode = 'P0001';
      end if;

      if new.min_loan_amount_applied is distinct from old.min_loan_amount_applied
         or new.max_loan_amount_applied is distinct from old.max_loan_amount_applied
         or new.grace_period_days_applied is distinct from old.grace_period_days_applied
         or new.penalty_rate_bps_applied is distinct from old.penalty_rate_bps_applied then
        raise exception
          'The policy snapshot on a loan cannot be changed after approval.'
          using errcode = 'P0001';
      end if;
    end if;
  end if;

  -- --- The trusted server path -------------------------------------------
  -- NULL for service_role, the table owner, and migrations. The checks below
  -- are about a session's capabilities, and there is no session to check.
  if auth.uid() is null then
    return new;
  end if;

  -- --- Capability per transition ------------------------------------------
  if new.status is distinct from old.status then
    if new.status = 'pending_approval' and not public.user_has_permission('loans:submit') then
      raise exception 'Submitting a loan for approval requires the loans:submit capability.'
        using errcode = 'P0001';
    end if;

    if new.status = 'approved' and not public.user_has_permission('loans:approve') then
      raise exception 'Approving a loan requires the loans:approve capability.'
        using errcode = 'P0001';
    end if;

    if new.status = 'draft' and old.status = 'pending_approval'
       and not public.user_has_permission('loans:approve') then
      raise exception 'Returning a loan to draft requires the loans:approve capability.'
        using errcode = 'P0001';
    end if;

    if new.status = 'active' and old.status = 'approved'
       and not public.user_has_permission('loans:disburse') then
      raise exception 'Disbursing a loan requires the loans:disburse capability.'
        using errcode = 'P0001';
    end if;

    if new.status = 'cancelled' and not public.user_has_permission('loans:cancel') then
      raise exception 'Cancelling a loan requires the loans:cancel capability.'
        using errcode = 'P0001';
    end if;

    -- --- Phase 6 ----------------------------------------------------------
    -- The capability is the one that *causes* the transition. Clearing a loan
    -- is a consequence of taking its final payment, so whoever may record a
    -- payment may clear it; reopening is a consequence of reversing, which
    -- only the Owner may do.
    if new.status = 'cleared' and old.status = 'active'
       and not public.user_has_permission('payments:create') then
      raise exception 'Clearing a loan requires the payments:create capability.'
        using errcode = 'P0001';
    end if;

    if new.status = 'active' and old.status = 'cleared'
       and not public.user_has_permission('payments:reverse') then
      raise exception 'Reopening a cleared loan requires the payments:reverse capability.'
        using errcode = 'P0001';
    end if;
  end if;

  -- Editing a draft.
  if old.status = 'draft' and new.status = 'draft'
     and not public.user_has_permission('loans:update_draft') then
    raise exception 'Changing a loan draft requires the loans:update_draft capability.'
      using errcode = 'P0001';
  end if;

  return new;
end;
$$;

comment on function public.loans_guard_transition() is
  'BEFORE UPDATE on loans: enumerated state machine, database-stamped attribution, terms frozen once the loan leaves draft, and clearance and reopening permitted only when the ledger agrees — including any unpaid penalty (Phase 7).';

revoke all on function public.loans_guard_transition() from public, anon, authenticated;

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

  return v_payment_id;
end;
$$;

comment on function public.post_payment(uuid, bigint, text, text, uuid, text) is
  'Records a payment against an active loan and allocates it oldest-obligation-first, interest before principal within a collection, in one transaction. Materialises any eligible penalty before reading a balance, so a payment cannot bypass one. Idempotent on the key. Accepts no allocation, balance, actor, timestamp or payment number from its caller. Clears the loan when nothing at all remains outstanding.';

revoke all on function public.post_payment(uuid, bigint, text, text, uuid, text)
  from public, anon, authenticated;
grant execute on function public.post_payment(uuid, bigint, text, text, uuid, text)
  to authenticated;

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

  return p_payment_id;
end;
$$;

comment on function public.reverse_payment(uuid, text) is
  'Reverses a posted payment with a required reason, reopening the loan if it owes money again and materialising an expiry penalty if the withdrawal of this money means one is now due. The payment and every allocation remain on record; they stop counting. Double reversal is refused by the guard trigger.';

revoke all on function public.reverse_payment(uuid, text) from public, anon, authenticated;
grant execute on function public.reverse_payment(uuid, text) to authenticated;

-- ===========================================================================
-- Phase 7 — the reversal stamp, from the business clock.
--
-- `loan_payments_guard_mutation` is restated here in full, because PostgreSQL
-- replaces a function body wholesale. One line changes: the reversal
-- timestamp. Everything else is Phase 6's text.
--
-- The defect this fixes: `reverse_payment` set `reversed_at` from the
-- business clock and this trigger then overwrote it from `pg_catalog.now()`.
-- The trigger winning is correct — the database stamps attribution, never the
-- caller — but it was stamping from a different clock than every other
-- financial timestamp in the system, and a reversal recorded before the
-- payment it reverses is refused by that payment's own CHECK constraint.
-- ===========================================================================

create or replace function public.loan_payments_guard_mutation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- --- Double reversal, refused at the database -------------------------
  -- Stated first, and before the trusted-path exemption, so no caller can
  -- reverse a payment twice. A second reversal would be a second audit event
  -- and a second apparent withdrawal of money that was only ever taken once.
  if old.status = 'reversed' then
    raise exception
      'Payment % has already been reversed, on %. A reversal cannot be repeated.',
      old.payment_number, old.reversed_at
      using errcode = 'P0001';
  end if;

  -- --- Everything financial is frozen ------------------------------------
  if new.id is distinct from old.id
     or new.payment_number is distinct from old.payment_number
     or new.loan_id is distinct from old.loan_id
     or new.client_id is distinct from old.client_id
     or new.amount is distinct from old.amount
     or new.payment_method is distinct from old.payment_method
     or new.external_reference is distinct from old.external_reference
     or new.idempotency_key is distinct from old.idempotency_key
     or new.received_at is distinct from old.received_at
     or new.recorded_by is distinct from old.recorded_by
     or new.recorded_by_label is distinct from old.recorded_by_label
     or new.outstanding_before is distinct from old.outstanding_before
     or new.outstanding_after is distinct from old.outstanding_after
     or new.client_name_at_payment is distinct from old.client_name_at_payment
     or new.created_at is distinct from old.created_at
     or new.notes is distinct from old.notes then
    raise exception
      'A recorded payment cannot be altered. Reverse it and record a correct payment instead.'
      using errcode = 'P0001';
  end if;

  -- --- The one permitted change -----------------------------------------
  -- A reversal, entire. Not a status change without attribution, and not
  -- attribution without a status change: either would leave a row that looks
  -- like a record and answers nothing.
  if new.status = 'reversed' and old.status = 'posted' then
    if new.reversed_at is null
       or new.reversed_by is null
       or new.reversal_reason is null
       or pg_catalog.btrim(new.reversal_reason) = '' then
      raise exception
        'Reversing a payment requires the actor, the time and a reason.'
        using errcode = 'P0001';
    end if;

    -- Stamped by the database, not accepted from the caller — the Phase 4
    -- attribution rule. A reversal naming somebody who never authorised it is
    -- precisely the record a dispute turns on.
    --
    -- Phase 7 changes one thing: the time comes from `business_now()` rather
    -- than `pg_catalog.now()`. In production the two are identical. They are
    -- not identical when the business clock is set deliberately, and a
    -- reversal stamped from a second clock can land *before* the payment it
    -- reverses — which the `loan_payments_reversed_after_received` CHECK then
    -- refuses, failing a legitimate reversal. One clock for every financial
    -- timestamp is the rule; this was the one place that had two.
    new.reversed_at := public.business_now();
    new.reversed_by := public.current_profile_id();

    -- A reversal with no human behind it is not a reversal anybody can be
    -- held to. The same reasoning as ADR-025.
    if new.reversed_by is null then
      raise exception
        'A payment reversal must name the person performing it.'
        using errcode = 'P0001';
    end if;
  elsif new.status is distinct from old.status then
    raise exception
      'A payment can only move from posted to reversed.'
      using errcode = 'P0001';
  elsif new.reversed_at is distinct from old.reversed_at
     or new.reversed_by is distinct from old.reversed_by
     or new.reversal_reason is distinct from old.reversal_reason then
    -- Reversal metadata without the status change: an attempt to make a
    -- payment *look* reversed while it still counts toward the balance, or to
    -- rewrite who reversed it.
    raise exception
      'Reversal details are written only when a payment is reversed.'
      using errcode = 'P0001';
  end if;

  -- --- The trusted server path -------------------------------------------
  -- NULL for service_role, the table owner and migrations. Stated last, so
  -- every rule above binds them too.
  if auth.uid() is null then
    return new;
  end if;

  if not public.user_has_permission('payments:reverse') then
    raise exception 'Reversing a payment requires the payments:reverse capability.'
      using errcode = 'P0001';
  end if;

  return new;
end;
$$;

comment on function public.loan_payments_guard_mutation() is
  'BEFORE UPDATE on loan_payments: every financial field is frozen; the only permitted change is posted to reversed, with the actor and the time stamped by the database from the business clock. Double reversal is refused above the trusted-path exemption.';
