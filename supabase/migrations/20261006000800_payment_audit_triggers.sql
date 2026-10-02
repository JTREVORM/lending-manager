-- ===========================================================================
-- Phase 6 — the payment audit trail.
--
-- Triggers rather than application calls, for the reason established in
-- Phase 3: a trigger fires in the same transaction as the change, so the data
-- and the trail cannot disagree, and an audit call in a Server Action is
-- skipped by anything reaching the table another way.
--
-- ## What is deliberately not recorded
--
-- **The network transaction reference.** `audit_log` is readable by
-- `audit:view`, and a Mobile Money reference is a handle on a borrower's
-- transaction with a third party — closer to identity data than to a
-- commercial figure. The payment number identifies the payment in the trail;
-- anybody entitled to the reference reads it on the payment itself, behind
-- `payments:view`. This follows the Phase 4 reasoning that kept identity
-- snapshots out of the trail.
--
-- **The borrower's name.** Already on the payment row, behind its own policy.
--
-- The commercial figures are recorded in full. They are not sensitive — they
-- are the transaction — and a dispute about what was taken is exactly what the
-- trail is for.
-- ===========================================================================

create or replace function public.audit_payment_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_action text;
  v_old    jsonb;
  v_new    jsonb;
begin
  if tg_op = 'INSERT' then
    v_action := 'payment.posted';
    v_new := pg_catalog.jsonb_build_object(
      'payment_number', new.payment_number,
      'loan_id', new.loan_id,
      'amount', new.amount,
      'payment_method', new.payment_method,
      -- Whether a reference was captured, not what it was. Enough to audit
      -- the Mobile Money rule without putting the reference in a broader
      -- readership's reach.
      'has_external_reference', new.external_reference is not null,
      'outstanding_before', new.outstanding_before,
      'outstanding_after', new.outstanding_after,
      'status', new.status
    );
  else
    -- The only UPDATE the guard trigger permits is a reversal, so there is
    -- exactly one shape to record here.
    v_action := 'payment.reversed';

    v_old := pg_catalog.jsonb_build_object(
      'status', old.status,
      'amount', old.amount,
      'outstanding_after', old.outstanding_after
    );
    v_new := pg_catalog.jsonb_build_object(
      'payment_number', new.payment_number,
      'loan_id', new.loan_id,
      'amount', new.amount,
      'payment_method', new.payment_method,
      'status', new.status,
      'reversal_reason', new.reversal_reason,
      -- What the reversal gives back. The balance after it is derived, so the
      -- amount restored is the figure that explains the event.
      'amount_restored', new.amount
    );
  end if;

  insert into public.audit_log (
    actor_profile_id, actor_auth_user_id, actor_label,
    action, entity_type, entity_id, old_values, new_values
  )
  values (
    public.current_profile_id(), auth.uid(), public.audit_actor_label(),
    v_action, 'payment', new.id::text, v_old, v_new
  );

  return null;
end;
$$;

comment on function public.audit_payment_change() is
  'AFTER INSERT/UPDATE on loan_payments. Records the commercial figures in full and the network reference not at all — only whether one was captured.';

create trigger audit_payment_change
  after insert or update on public.loan_payments
  for each row execute function public.audit_payment_change();

-- ---------------------------------------------------------------------------
-- Allocation capture
--
-- One event per payment, statement-level, recording how the money was spread
-- and never the spread itself. A payment settling a month of daily
-- collections produces one entry saying thirty rather than thirty entries.
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
  v_first      integer;
  v_last       integer;
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
            pg_catalog.sum(allocated_interest)
       from inserted
      group by payment_id, loan_id
      limit 1'
    into v_payment_id, v_loan_id, v_count, v_amount, v_principal, v_interest;

  if v_payment_id is null then
    return null;
  end if;

  -- Which collections the money reached, as a range rather than a list.
  select pg_catalog.min(li.installment_number),
         pg_catalog.max(li.installment_number)
    into v_first, v_last
  from public.payment_allocations pa
  join public.loan_installments li on li.id = pa.installment_id
  where pa.payment_id = v_payment_id;

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
  'AFTER INSERT statement-level on payment_allocations: one event per payment recording how much reached principal, how much interest, and which collections — never the rows.';

create trigger audit_payment_allocated
  after insert on public.payment_allocations
  referencing new table as inserted
  for each statement
  execute function public.audit_payment_allocated();

-- ---------------------------------------------------------------------------
-- Clearance and reopening, in the Phase 4 loan trail
--
-- ## Two defects this fixes, both found by a test that counted events
--
-- **A reopened loan was audited as a disbursement.** Phase 4's
-- `audit_loan_change` maps a transition *into* `active` to `loan.disbursed`,
-- which was exactly right when `approved → active` was the only way in. Phase
-- 6 adds `cleared → active`, and under the original mapping a reversal that
-- reopened a loan would have written `loan.disbursed` — a false record that the
-- business had paid the money out a second time, in the one trail a dispute
-- turns on.
--
-- **A clearance produced two events.** The first draft of this migration added
-- a separate `audit_loan_clearance` trigger emitting its own `loan.cleared`
-- alongside the one `audit_loan_change` already wrote. Two entries for one
-- transition is not merely noise: it makes "how many times was this loan
-- settled" unanswerable by counting, which is how the duplicate was found.
--
-- So rather than adding a second trigger, this replaces the Phase 4 function:
-- the transition is named correctly, and the balance that justified it is
-- recorded on the two transitions where a reader needs it. Every other action
-- name and every recorded field is preserved exactly. One transition, one
-- event.
--
-- `public.loan_outstanding` is called only for those two transitions, so an
-- ordinary draft edit does not pay for a balance query it has no use for.
-- ---------------------------------------------------------------------------

create or replace function public.audit_loan_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_action text;
  v_old    jsonb;
  v_new    jsonb;
  v_ledger jsonb := '{}'::jsonb;
begin
  if tg_op = 'INSERT' then
    v_action := 'loan.created';
    v_new := pg_catalog.jsonb_build_object(
      'loan_number', new.loan_number,
      'client_id', new.client_id,
      'principal_amount', new.principal_amount,
      'loan_term_months', new.loan_term_months,
      'repayment_frequency', new.repayment_frequency,
      'proposed_disbursement_date', new.proposed_disbursement_date,
      'status', new.status
    );
  else
    -- One change, one name. A status transition is recorded as that
    -- transition, because that is the event somebody will later search for.
    if new.status is distinct from old.status then
      v_action := case new.status
        when 'pending_approval' then
          case when old.status = 'draft' then 'loan.submitted' else 'loan.updated' end
        when 'approved'  then 'loan.approved'
        -- Phase 6: `active` is now reachable two ways. Disbursement is the
        -- money going out; a reopening is a reversal putting a settled debt
        -- back. Naming both 'loan.disbursed' would claim the business paid
        -- out twice.
        when 'active'    then
          case when old.status = 'cleared' then 'loan.reopened' else 'loan.disbursed' end
        when 'cancelled' then 'loan.cancelled'
        when 'cleared'   then 'loan.cleared'
        when 'draft'     then 'loan.returned_to_draft'
        else 'loan.updated'
      end;
    else
      v_action := 'loan.updated';
    end if;

    -- Phase 6: the balance that justified a clearance or a reopening. Only on
    -- those two transitions — an auditor asking "why is this owed again" needs
    -- the figure, and a draft edit does not.
    if (new.status = 'cleared' and old.status <> 'cleared')
       or (old.status = 'cleared' and new.status <> 'cleared') then
      v_ledger := pg_catalog.jsonb_build_object(
        'outstanding', public.loan_outstanding(new.id),
        'cleared_at', new.cleared_at
      );
    end if;

    v_old := pg_catalog.jsonb_build_object(
      'status', old.status,
      'principal_amount', old.principal_amount,
      'interest_rate_bps', old.interest_rate_bps,
      'loan_term_months', old.loan_term_months,
      'repayment_frequency', old.repayment_frequency,
      'total_interest', old.total_interest,
      'total_expected_repayment', old.total_expected_repayment
    );
    v_new := pg_catalog.jsonb_build_object(
      'status', new.status,
      'principal_amount', new.principal_amount,
      'interest_rate_bps', new.interest_rate_bps,
      'interest_method', new.interest_method,
      'loan_term_months', new.loan_term_months,
      'repayment_frequency', new.repayment_frequency,
      'total_interest', new.total_interest,
      'total_expected_repayment', new.total_expected_repayment,
      'cancellation_reason', new.cancellation_reason
    ) || v_ledger;
  end if;

  insert into public.audit_log (
    actor_profile_id, actor_auth_user_id, actor_label,
    action, entity_type, entity_id, old_values, new_values
  )
  values (
    public.current_profile_id(), auth.uid(), public.audit_actor_label(),
    v_action, 'loan', new.id::text, v_old, v_new
  );

  return null;
end;
$$;

comment on function public.audit_loan_change() is
  'AFTER INSERT/UPDATE on loans. Records the commercial figures in full and no identity data. Phase 6 distinguishes a reopening from a disbursement and records the balance that justified a clearance.';

revoke all on function public.audit_payment_change() from public, anon, authenticated;
revoke all on function public.audit_payment_allocated() from public, anon, authenticated;
revoke all on function public.audit_loan_change() from public, anon, authenticated;
