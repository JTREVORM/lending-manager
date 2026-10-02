-- ===========================================================================
-- Phase 6 — the ledger is append-only, with one exception stated precisely.
--
-- ## What may change after a payment is posted
--
-- Three columns, once, together: `status` from `posted` to `reversed`,
-- `reversed_at`, `reversed_by` and `reversal_reason` from NULL to a value.
-- Nothing else, ever, by anybody — including the table owner and
-- `service_role`.
--
-- That is the whole of it. The amount, the method, the loan, the client, the
-- payment number, the actor, the timestamp and the receipt balances are frozen
-- the moment the row exists. An Owner who believes a payment is wrong reverses
-- it; there is no path to editing what was recorded, because a ledger whose
-- past can be edited is not evidence of anything.
--
-- ## Why a row-level trigger here, and statement-level for DELETE
--
-- The reversal exception is a comparison of `old` and `new` column by column,
-- which needs a row-level trigger. DELETE has no exception at all, so it gets
-- the statement-level guard — which fires even when the WHERE clause matches
-- nothing, so `delete from loan_payments where id = '<wrong>'` is refused
-- rather than succeeding silently and looking like it worked. That is the
-- Phase 3 lesson, applied again.
--
-- ## Allocations have no exception whatsoever
--
-- `payment_allocations` refuses UPDATE and DELETE outright. A reversed
-- payment's allocations stay exactly as they were posted; they stop counting
-- because their parent payment's status changed, not because anything was
-- rewritten. That is what makes a reversal fully traceable: the money that was
-- allocated, and where it went, is still on record.
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
    new.reversed_at := pg_catalog.now();
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
  'BEFORE UPDATE on loan_payments: every financial field is frozen; the only permitted change is posted to reversed, with the actor stamped by the database. Double reversal is refused above the trusted-path exemption.';

create trigger loan_payments_guard_mutation
  before update on public.loan_payments
  for each row execute function public.loan_payments_guard_mutation();

-- No DELETE, for anybody. Statement-level, so the refusal does not depend on
-- the caller's WHERE clause matching anything.
create trigger loan_payments_no_delete
  before delete on public.loan_payments execute function public.reject_mutation();

-- Allocations: no exception at all.
create trigger payment_allocations_no_update
  before update on public.payment_allocations execute function public.reject_mutation();
create trigger payment_allocations_no_delete
  before delete on public.payment_allocations execute function public.reject_mutation();

revoke all on function public.loan_payments_guard_mutation()
  from public, anon, authenticated;
