-- ===========================================================================
-- Phase 6 — clearance, and reopening after a reversal.
--
-- ## The edge Phase 4 declared and could not perform
--
-- Phase 4's state machine declared `active → cleared` and deliberately left
-- it unreachable: a loan can only be shown settled once payments exist, and
-- ADR-025 recorded what such an automation would need. Phase 6 is that phase.
--
-- It also adds the edge Phase 4 could not have anticipated the need for:
-- `cleared → active`. If the payment that settled a loan is reversed, the
-- borrower owes the money again, and a loan reading `cleared` while carrying
-- an outstanding balance would be a false record.
--
-- ## How these transitions are protected
--
-- Not by a session marker. Phase 1 uses `set_config(..., true)` to mark a
-- trusted path, which works where the condition cannot be checked from the
-- data — but here it can, and checking the data is strictly stronger:
--
--   * `active → cleared` is permitted **only when the loan's outstanding
--     balance is zero**;
--   * `cleared → active` is permitted **only when it is above zero**.
--
-- So the status can never contradict the ledger, whatever path the UPDATE
-- came from. A staff member with a token who tries to mark a loan cleared by
-- hand is refused unless the loan genuinely is fully paid — in which case the
-- transition is the correct one anyway and nothing is gained by it. A leaked
-- secret key gains nothing either, because the rule is stated above the
-- trusted-path exemption. A session marker could have been set by both.
--
-- The capability required is the one that causes the transition:
-- `payments:create` to clear, `payments:reverse` to reopen. A
-- Secretary/Treasurer taking a final payment must be able to clear the loan;
-- only the Owner can reopen one, because only the Owner can reverse.
-- ===========================================================================

alter table public.loans
  add column if not exists cleared_at timestamptz,
  add column if not exists cleared_by uuid references public.profiles (id) on delete restrict;

comment on column public.loans.cleared_at is
  'When the loan was settled. Cleared back to NULL if a reversal reopens it, so the column means "currently cleared, at this time" — the audit trail holds the history of both events.';

-- Each half implies the other, and both imply the status. Without this a loan
-- could read as cleared with nobody named, or carry a clearance stamp while
-- active.
alter table public.loans
  add constraint loans_clearance_complete
    check ((cleared_at is null) = (cleared_by is null));

alter table public.loans
  add constraint loans_clearance_implies_cleared
    check (cleared_at is null or status = 'cleared');

alter table public.loans
  add constraint loans_cleared_requires_clearance
    check (status <> 'cleared' or cleared_at is not null);

alter table public.loans
  add constraint loans_cleared_after_disbursed
    check (cleared_at is null or disbursed_at is null or cleared_at >= disbursed_at);

-- ---------------------------------------------------------------------------
-- The outstanding balance, derived
--
-- The single definition of what a loan still owes, used by the transition
-- guard, by the posting and reversal functions, and by the balance views. One
-- definition rather than four, because four would be four chances to disagree
-- about whether a loan is settled.
--
--   outstanding = every scheduled collection, less every allocation belonging
--                 to a payment that is still posted
--
-- A reversed payment's allocations remain in the database as history and are
-- excluded here. That exclusion *is* the reversal: nothing is deleted, and
-- every balance in the system changes the instant the status does.
--
-- SECURITY INVOKER (the default), so a session calling it sees only what Row
-- Level Security lets it see. Inside the SECURITY DEFINER functions it runs as
-- the table owner and therefore sees the whole loan, which is what the
-- transition guard needs.
-- ---------------------------------------------------------------------------

create or replace function public.loan_outstanding(p_loan_id uuid)
returns bigint
language sql
stable
set search_path = ''
as $$
  select coalesce(
           (select pg_catalog.sum(li.expected_amount)
              from public.loan_installments li
             where li.loan_id = p_loan_id),
           0
         )
       - coalesce(
           (select pg_catalog.sum(pa.allocated_amount)
              from public.payment_allocations pa
              join public.loan_payments lp on lp.id = pa.payment_id
             where pa.loan_id = p_loan_id
               and lp.status = 'posted'),
           0
         );
$$;

comment on function public.loan_outstanding(uuid) is
  'What a loan still owes: every scheduled collection less every allocation of a still-posted payment. The single definition used by the transition guard, the posting and reversal functions, and the balance views.';

revoke all on function public.loan_outstanding(uuid) from public, anon;
grant execute on function public.loan_outstanding(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- The state machine, extended
--
-- `create or replace` of the Phase 4 function. Every existing rule is
-- preserved in its original order and wording; the additions are marked
-- "Phase 6". The Phase 4 migration file itself is untouched.
--
--   draft            → pending_approval   (submit)
--   draft            → cancelled
--   pending_approval → draft              (returned for correction)
--   pending_approval → approved
--   pending_approval → cancelled
--   approved         → active             (disbursement)
--   approved         → cancelled
--   active           → cleared            (Phase 6: fully repaid)
--   cleared          → active             (Phase 6: a reversal reopened it)
--
-- `cancelled` remains terminal. Nothing reopens a loan that was never agreed,
-- and no payment can be posted against one.
-- ---------------------------------------------------------------------------

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
  if new.status = 'cleared' and old.status = 'active' then
    v_outstanding := public.loan_outstanding(new.id);

    if v_outstanding <> 0 then
      raise exception
        'This loan cannot be cleared: % shillings are still outstanding.',
        v_outstanding
        using errcode = 'P0001';
    end if;
  end if;

  if new.status = 'active' and old.status = 'cleared' then
    v_outstanding := public.loan_outstanding(new.id);

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
  'BEFORE UPDATE on loans: enumerated state machine, database-stamped attribution, terms frozen once the loan leaves draft, and (Phase 6) clearance and reopening permitted only when the ledger agrees.';

revoke all on function public.loans_guard_transition() from public, anon, authenticated;
