-- ===========================================================================
-- Phase 13.1 — a refused application is not the same thing as a withdrawn one
--
-- Today both end as `status = 'cancelled'` with a free-text reason, so the
-- register cannot tell a loan the business *refused* from one the borrower
-- walked away from. Those are different events: one is a credit decision, the
-- other is a change of mind, and only the first belongs in a report about
-- lending standards.
--
-- ## Why a kind on the terminal state rather than a seventh status
--
-- `status` answers one question that the whole system branches on: did this
-- loan ever become debt? Every portfolio view, the ledger's posting rules,
-- the delinquency engine, PAR and a dozen reports read it as
-- `status in (...)`. A seventh value means revisiting every one of those
-- lists, and getting one wrong means a refused application counted as
-- outstanding debt.
--
-- `cancelled` is already the terminal "never became debt" state. What was
-- missing is *why*, as a typed value rather than prose — so a kind sits
-- beside it, and "expired" or "superseded" can be added later as a kind
-- rather than as a state with its own transitions and its own report branch.
--
-- There is a second, smaller reason and it is only fair to name it: changing
-- the existing `loans_status_valid` CHECK would mean removing and re-adding a
-- constraint, and the tooling this project uses to reach the live database
-- cannot run a destructive statement non-interactively. That made the choice
-- convenient as well as defensible. The design argument above is the one that
-- decided it; had the two disagreed, the constraint would have been changed
-- by hand.
--
-- ## The invariant
--
-- A kind exists exactly when the loan is cancelled. Not "may be set" — a
-- cancelled loan with no kind is a loan whose outcome nobody recorded, and
-- the one thing this migration exists to prevent.
-- ===========================================================================

alter table public.loans add column closure_kind text;

comment on column public.loans.closure_kind is
  'Phase 13. Why a cancelled loan was cancelled: rejected (the business refused the application) or withdrawn (the applicant or the business pulled it). Present exactly when status = cancelled.';

-- Two kinds, because two things can write one. A permitted value that no
-- function can produce is configuration nobody can reach: if the business
-- later lets an untouched application expire, that is a new kind and a new
-- function to write it, added together.
alter table public.loans add constraint loans_closure_kind_valid
  check (closure_kind is null or closure_kind in ('rejected', 'withdrawn'));

-- The invariant, both ways round: a kind only on a cancelled loan, and no
-- cancelled loan without one.
alter table public.loans add constraint loans_closure_kind_matches_status
  check ((status = 'cancelled') = (closure_kind is not null));

-- ---------------------------------------------------------------------------
-- Rejecting an application
--
-- Separate from `cancel_loan` rather than a parameter on it, because the two
-- are different decisions with different preconditions: a rejection can only
-- happen to an application that is awaiting a decision, while a cancellation
-- can also take back a loan that was already approved but not yet disbursed.
-- ---------------------------------------------------------------------------

create or replace function public.reject_loan(p_loan_id uuid, p_reason text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_loan public.loans;
begin
  if p_reason is null or pg_catalog.btrim(p_reason) = '' then
    raise exception 'Rejecting an application requires a reason.'
      using errcode = 'P0001';
  end if;

  -- The row lock serialises two reviewers acting at once: the second blocks,
  -- then finds the application is no longer awaiting a decision.
  select * into v_loan from public.loans where id = p_loan_id for update;

  if not found then
    raise exception 'No such loan.' using errcode = 'P0001';
  end if;

  if v_loan.status <> 'pending_approval' then
    raise exception
      'Only an application awaiting approval can be rejected; this one is %.',
      v_loan.status using errcode = 'P0001';
  end if;

  -- Whoever may approve may refuse. A separate capability would mean a
  -- business could grant the power to say yes without the power to say no,
  -- which is not a distinction anybody wants.
  if auth.uid() is not null and not public.user_has_permission('loans:approve') then
    raise exception 'Rejecting an application requires the loans:approve capability.'
      using errcode = 'P0001';
  end if;

  -- The reason is the borrower's explanation and the auditor's record, so it
  -- is stored where every other closure reason is stored. `cancelled_at` and
  -- `cancelled_by` are stamped by the transition trigger, not supplied here.
  update public.loans
     set status = 'cancelled',
         closure_kind = 'rejected',
         cancellation_reason = pg_catalog.btrim(p_reason)
   where id = p_loan_id;

  return p_loan_id;
end;
$$;

comment on function public.reject_loan(uuid, text) is
  'Phase 13. Refuses an application awaiting approval: terminal, reasoned, and distinguishable from a withdrawal by closure_kind.';

revoke all on function public.reject_loan(uuid, text) from public, anon;
grant execute on function public.reject_loan(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- Cancelling, which now has to say which kind of ending it is
--
-- The body is the existing text with one line added to the UPDATE. The
-- signature is deliberately unchanged: `create or replace function` with an
-- extra parameter creates an *overload* rather than replacing anything, and
-- every existing two-argument call would have kept resolving to the old body
-- — which does not set the kind, and would now fail the constraint above.
-- Found by applying this migration and reading `pg_proc`.
--
-- So a cancellation means withdrawn, always, and a refusal has its own verb.
-- ---------------------------------------------------------------------------

create or replace function public.cancel_loan(p_loan_id uuid, p_reason text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_loan public.loans;
begin
  if p_reason is null or pg_catalog.btrim(p_reason) = '' then
    raise exception 'Cancelling a loan requires a reason.' using errcode = 'P0001';
  end if;

  select * into v_loan from public.loans where id = p_loan_id for update;

  if not found then
    raise exception 'No such loan.' using errcode = 'P0001';
  end if;

  if v_loan.status = 'cancelled' then
    raise exception 'This loan is already cancelled.' using errcode = 'P0001';
  end if;

  if v_loan.status not in ('draft', 'pending_approval', 'approved') then
    raise exception
      'A % loan cannot be cancelled. Money has already been released.', v_loan.status
      using errcode = 'P0001';
  end if;

  if auth.uid() is not null and not public.user_has_permission('loans:cancel') then
    raise exception 'Cancelling a loan requires the loans:cancel capability.'
      using errcode = 'P0001';
  end if;

  update public.loans
     set status = 'cancelled',
         closure_kind = 'withdrawn',
         cancellation_reason = pg_catalog.btrim(p_reason)
   where id = p_loan_id;

  return p_loan_id;
end;
$$;

comment on function public.cancel_loan(uuid, text) is
  'Phase 4, extended in Phase 13. Takes back a loan that has not been disbursed; records it as withdrawn. A refusal of an application is reject_loan.';
