-- ===========================================================================
-- Phase 4D — recording the proposed exceptional commission, not only
-- authorising one somebody else typed.
--
-- The defect this closes. Phase 4B-S took the commission field away from the
-- counter: an operator-typed figure is how recognised income becomes whatever
-- somebody entered, so `create_agency_transaction` is now called with
-- `p_commission_supplied = NULL` and the engine computes the figure from the
-- provider's configured terms.
--
-- But `authorise_agency_commission_exception()` was written for the world
-- where the counter *did* supply a figure. Its second guard is:
--
--   if t.commission_supplied is null then
--     raise 'This transaction supplies no commission of its own ...'
--
-- So with the interface behaving correctly there is no transaction it will
-- accept. The owner-only exception workflow was unreachable: a guard against
-- authorising nothing had become a dead end.
--
-- ## The correction
--
-- One function, not two. `p_proposed_amount` is added with a default of NULL,
-- so the existing three-argument call still means exactly what it meant -
-- authorise the figure already on the transaction - and a four-argument call
-- records the Owner's proposed figure and authorises it in the same
-- transaction. Adding a defaulted parameter changes the signature, so the old
-- function is dropped rather than replaced: leaving both would make a
-- three-argument call ambiguous.
--
-- Authorization stays in the database. `agency_actor('agency:commission_
-- exception')` refuses anybody without the capability with SQLSTATE 42501
-- before the function reads the transaction, and `agency_locked_transaction()`
-- refuses another branch's. A role check in the application is a courtesy on
-- top of this, never instead of it.
--
-- ## Drafts and submitted transactions, explicitly
--
-- A draft has not been sent anywhere, so recording the figure on it is an
-- ordinary edit.
--
-- A transaction awaiting verification has been handed to a second officer,
-- and changing its money after that must not be quiet. It is allowed - the
-- alternative is cancelling and re-recording a customer's transaction to
-- correct a commission - but the audit row carries the figure **before** and
-- the figure after, so the change is visible to the officer who verifies it
-- and to anybody reading the trail later. Nothing about verification moves:
-- the Owner authorises the difference, a Manager still posts it, and the
-- database still refuses an officer verifying their own entry.
--
-- The pinning Phase 4B-S added is untouched and is what makes this safe: the
-- authorised figure and the computed figure are both stored, and
-- `post_agency_transaction` refuses to post if either has moved since. An
-- Owner authorising 1,800 cannot become a posting of 50,000.
-- ===========================================================================

drop function if exists public.authorise_agency_commission_exception(uuid, text, text);

create or replace function public.authorise_agency_commission_exception(
  p_transaction_id  uuid,
  p_reason          text,
  p_evidence        text,
  p_proposed_amount bigint default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor    uuid;
  t          public.agency_transactions;
  v_computed bigint;
  v_supplied bigint;
  v_before   bigint;
begin
  v_actor := public.agency_actor('agency:commission_exception');

  if pg_catalog.btrim(coalesce(p_reason, '')) = ''
     or pg_catalog.btrim(coalesce(p_evidence, '')) = '' then
    raise exception
      'A commission exception needs both a reason and a reference to external evidence.'
      using errcode = 'P0001';
  end if;

  t := public.agency_locked_transaction(p_transaction_id);

  if t.status not in ('draft', 'awaiting_verification') then
    raise exception
      'A commission exception is authorised before the transaction is posted; this one is %.',
      t.status
      using errcode = 'P0001';
  end if;

  v_before   := t.commission_supplied;
  v_supplied := coalesce(p_proposed_amount, t.commission_supplied);

  -- Unchanged from Phase 4B-S for a three-argument call: with no figure
  -- proposed and none on the transaction, there is nothing to authorise.
  if v_supplied is null then
    raise exception
      'This transaction supplies no commission of its own, so there is no difference to authorise.'
      using errcode = 'P0001';
  end if;

  if v_supplied < 0 then
    raise exception 'A commission cannot be negative.' using errcode = 'P0001';
  end if;

  -- The posting engine refuses a commission above the principal, because the
  -- counter leg would go negative. Refused here too, so the Owner is told at
  -- the point of decision rather than by a posting failure later.
  if v_supplied > t.principal_amount then
    raise exception
      'A commission of % cannot exceed the principal of % on this transaction.',
      v_supplied, t.principal_amount
      using errcode = 'P0001';
  end if;

  select c.amount into v_computed
  from public.agency_commission_for(t.provider_id, t.principal_amount) c;

  if v_supplied = v_computed then
    raise exception
      'The figure already equals the % the configured terms produce, so there is nothing to authorise.',
      v_computed
      using errcode = 'P0001';
  end if;

  update public.agency_transactions
     set commission_supplied         = v_supplied,
         commission_exception_reason = p_reason,
         commission_exception_evidence = p_evidence,
         commission_exception_by     = v_actor,
         commission_exception_amount   = v_supplied,
         commission_exception_computed = v_computed
   where id = p_transaction_id;

  -- The figure before and the figure after, so a change made after
  -- submission is visible to whoever verifies it rather than quiet.
  insert into public.agency_transaction_audit_log
    (transaction_id, action, actor_id, old_value, new_value, reason)
  values (p_transaction_id, 'commission_exception', v_actor,
          pg_catalog.jsonb_build_object(
            'commission_supplied_before', v_before,
            'commission_computed', v_computed,
            'status', t.status),
          pg_catalog.jsonb_build_object(
            'commission_supplied', v_supplied,
            'proposed_by_authoriser', p_proposed_amount is not null,
            'evidence', p_evidence),
          p_reason);
end;
$$;

comment on function public.authorise_agency_commission_exception(uuid, text, text, bigint) is
  'Phase 4B-S, extended in Phase 4D. Authorises one agency transaction to post a commission differing from its provider''s configured terms, with a reason and external evidence. Called with four arguments it also records the Owner''s proposed figure, which is what the interface does now that the counter supplies none; called with three it authorises the figure already present, as before. Requires agency:commission_exception, which only owner_admin holds, refuses another branch''s transaction, refuses a posted one, refuses a negative figure or one above the principal, and refuses a figure that does not actually differ. The audit row carries the figure before and after, so a change made after submission is never quiet.';

revoke all on function public.authorise_agency_commission_exception(uuid, text, text, bigint)
  from public, anon;
grant execute on function public.authorise_agency_commission_exception(uuid, text, text, bigint)
  to authenticated;
