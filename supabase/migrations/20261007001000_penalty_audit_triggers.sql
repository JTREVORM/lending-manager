-- ===========================================================================
-- Phase 7 — audit for penalties.
--
-- ## What is audited, and what deliberately is not
--
-- **Audited:** the penalty. It is a financial event — a charge of real money
-- against a borrower — and the trail records the complete arithmetic so the
-- charge can be explained years later from the audit row alone: the balance it
-- was taken from, the date that balance was reconstructed as at, the rate, the
-- amount, and the rule that fired.
--
-- **Not audited:** arrears, missed collections, days past due, entering or
-- leaving the grace period, or becoming penalty-eligible. None of those is an
-- action anybody took. They are consequences of the calendar moving, and a
-- trail that recorded them would grow by one row per loan per day while
-- recording nothing a reader could act on — and it would bury the events that
-- do matter. The audit trail records actions and materialised financial
-- events, never the passage of time.
--
-- ## The actor problem, answered honestly
--
-- A penalty has no human author. It is not approved, not authorised and not
-- entered: it follows from a rule, a date and a balance. The existing audit
-- schema turns out to accommodate that exactly as it stands —
-- `actor_profile_id` and `actor_auth_user_id` are both nullable, and
-- `audit_actor_label()` already returns `'system'` when there is no session —
-- so Phase 7 needs no change to the audit architecture and makes none.
--
-- What it does **not** do is take the session's profile and write it in as the
-- actor. The materialisation usually happens inside somebody's payment
-- transaction, and recording the Secretary who took that payment as the
-- person who charged a 50% penalty would be a false record of a decision
-- nobody made. ADR-025 insists that an approval must name a human; the same
-- principle, honestly applied, insists that this one must not.
--
-- The session is still recorded, under `session_profile_id`, because knowing
-- which transaction a charge appeared in is genuinely useful to somebody
-- investigating one. It is metadata about the circumstances, clearly not an
-- attribution of responsibility.
--
-- ## No identity data
--
-- No National Identification Number, no phone number, no address, no date of
-- birth. The loan number is a reference, not identity evidence, and the same
-- reasoning Phase 3 set out for `audit_log` applies: the trail is readable
-- with `audit:view`, a broader capability than the ones that gate identity.
-- ===========================================================================

create or replace function public.audit_penalty_applied()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_loan_number text;
begin
  select l.loan_number into v_loan_number
  from public.loans l
  where l.id = new.loan_id;

  insert into public.audit_log (
    -- No actor. A business rule applied this charge, and the trail says so
    -- rather than naming whoever happened to be signed in.
    actor_profile_id, actor_auth_user_id, actor_label,
    action, entity_type, entity_id, new_values, metadata
  )
  values (
    null, null, 'system',
    'loan.penalty_applied', 'loan', new.loan_id::text,
    pg_catalog.jsonb_build_object(
      'penalty_id', new.id,
      'penalty_type', new.penalty_type,
      -- The complete arithmetic, so the charge is explicable from this row.
      'basis_amount', new.basis_amount,
      'penalty_rate_bps', new.penalty_rate_bps,
      'penalty_amount', new.penalty_amount,
      -- And the dates it followed from.
      'final_due_date', new.final_due_date,
      'grace_period_days', new.grace_period_days,
      'grace_end_date', new.grace_end_date,
      'effective_date', new.effective_date
    ),
    pg_catalog.jsonb_build_object(
      'loan_number', v_loan_number,
      'trigger_rule', new.trigger_rule,
      -- An explicit marker, so a reader never has to infer "system" from an
      -- absent actor — and so a future query can separate rule-generated
      -- events from human ones without pattern-matching on a label.
      'actor_type', 'system',
      -- The circumstances, not the responsibility: which session the
      -- materialisation happened inside, where there was one.
      'session_profile_id', public.current_profile_id(),
      'applied_at', new.applied_at
    )
  );

  return null;
end;
$$;

comment on function public.audit_penalty_applied() is
  'AFTER INSERT on loan_penalties: one event carrying the full arithmetic of the charge. Records no actor, because a business rule applied it; the session is noted as circumstance under metadata.';

create trigger audit_penalty_applied
  after insert on public.loan_penalties
  for each row execute function public.audit_penalty_applied();

revoke all on function public.audit_penalty_applied() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- The allocation event, extended
--
-- Phase 6's version reported how much of a payment reached principal and how
-- much reached interest, and found the collections it touched by joining
-- `loan_installments`. A penalty allocation has no installment, so under the
-- Phase 6 function a payment that went entirely to a penalty would record
-- zeroes and a null collection range — a trail entry saying nothing happened.
--
-- Restated here to report the penalty component alongside the other two, and
-- to say so explicitly when a payment reached a penalty at all.
-- ---------------------------------------------------------------------------

create or replace function public.audit_payment_allocated()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_payment_id uuid;
  v_loan_id    uuid;
  v_count      integer;
  v_amount     bigint;
  v_principal  bigint;
  v_interest   bigint;
  v_penalty    bigint;
  v_first      integer;
  v_last       integer;
  v_penalties  integer;
begin
  -- The transition table is read through dynamic SQL, following the Phase 4
  -- pattern: `inserted` is not a schema-qualified relation and this function
  -- runs with an empty search_path.
  execute
    'select payment_id,
            loan_id,
            pg_catalog.count(*)::integer,
            pg_catalog.sum(allocated_amount),
            pg_catalog.sum(allocated_principal),
            pg_catalog.sum(allocated_interest),
            pg_catalog.sum(allocated_penalty)
       from inserted
      group by payment_id, loan_id
      limit 1'
    into v_payment_id, v_loan_id, v_count, v_amount, v_principal, v_interest,
         v_penalty;

  if v_payment_id is null then
    return null;
  end if;

  -- Which collections the money reached, as a range rather than a list. Null
  -- when the payment reached only a penalty, which the count below makes
  -- unambiguous rather than merely absent.
  select pg_catalog.min(li.installment_number),
         pg_catalog.max(li.installment_number)
    into v_first, v_last
  from public.payment_allocations pa
  join public.loan_installments li on li.id = pa.installment_id
  where pa.payment_id = v_payment_id;

  select pg_catalog.count(*)::integer
    into v_penalties
  from public.payment_allocations pa
  where pa.payment_id = v_payment_id
    and pa.penalty_id is not null;

  insert into public.audit_log (
    actor_profile_id, actor_auth_user_id, actor_label,
    action, entity_type, entity_id, new_values
  )
  values (
    public.current_profile_id(), auth.uid(), public.audit_actor_label(),
    'payment.allocated', 'payment', v_payment_id::text,
    pg_catalog.jsonb_build_object(
      'loan_id', v_loan_id,
      'allocation_count', v_count,
      'allocated_amount', v_amount,
      'allocated_principal', v_principal,
      'allocated_interest', v_interest,
      -- Phase 7. Its own figure, never folded into interest: a penalty is
      -- neither principal nor contractual interest, and a trail that blurred
      -- them would misstate what the borrower was charged for.
      'allocated_penalty', v_penalty,
      'penalty_allocation_count', v_penalties,
      'first_collection', v_first,
      'last_collection', v_last
      -- Deliberately not the allocations themselves. They are append-only in
      -- their own table, so the trail has no history to preserve that the
      -- rows do not already hold.
    )
  );

  return null;
end;
$$;

comment on function public.audit_payment_allocated() is
  'AFTER INSERT statement-level on payment_allocations: one event per payment recording how much reached principal, how much interest, how much a penalty, and which collections — never the rows.';
