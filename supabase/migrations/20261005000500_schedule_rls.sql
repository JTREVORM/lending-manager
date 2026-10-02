-- ===========================================================================
-- Phase 5 — Row Level Security for the repayment schedule.
--
-- The boundary. Hidden buttons, guarded Server Actions and route protection
-- exist to give people a coherent experience and to fail early; none survives
-- a caller who takes their own token to PostgREST directly. So each policy is
-- written to be correct assuming everything above it has been bypassed.
--
-- ## SELECT only. There is no write policy on either table
--
-- Not a narrow INSERT policy guarded by a capability — none at all, and no
-- INSERT, UPDATE or DELETE grant either. Schedule rows are written solely by
-- `generate_loan_schedule`, which is SECURITY DEFINER and so runs as the table
-- owner, bypassing RLS. That is the point: nobody can write a collection plan
-- by hand, so the stored dates and amounts are always the ones the database
-- computed from the contract.
--
-- The append-only triggers in migration 000300 then bind the owner and
-- `service_role` too, so a leaked secret key cannot rewrite a due date that
-- a borrower is being collected against.
--
-- ## Delegation rather than restatement
--
-- Both policies decide visibility by asking whether the **loan** is visible,
-- through `exists (select 1 from public.loans …)`. That sub-select is itself
-- subject to the SELECT policy on `loans`, so this is that rule rather than a
-- second copy of it.
--
-- The alternative — restating the loans rule here, including its borrower
-- self-clause and its exclusion of drafts — would be two copies of one
-- intention, free to drift apart at the next change. Delegating is the
-- stronger choice, and `tests/db/security.test.ts` asserts the delegation is
-- actually present rather than exempting these tables from its check.
--
-- Staff additionally need `schedules:view`. A borrower needs no capability:
-- their own loan's collection plan is the document they are being collected
-- against, and the ownership clause is what admits them.
-- ===========================================================================

grant select on table public.loan_schedules to authenticated;
grant select on table public.loan_installments to authenticated;

create policy loan_schedules_select_with_loan
  on public.loan_schedules
  for select
  to authenticated
  using (
    exists (
      select 1
        from public.loans l
        join public.clients c on c.id = l.client_id
       where l.id = loan_schedules.loan_id
         and (
           public.user_has_permission('schedules:view')
           -- The borrower, on their own loan. No capability: the loans policy
           -- has already decided this is their loan and that it is not a
           -- draft, and this is the plan they are collected against.
           or (
             c.profile_id is not null
             and c.profile_id = public.current_profile_id()
           )
         )
    )
  );

comment on policy loan_schedules_select_with_loan on public.loan_schedules is
  'Visible exactly when its loan is, and then only to schedules:view or to the borrower themselves. Delegates to the loans policy rather than restating it.';

create policy loan_installments_select_with_loan
  on public.loan_installments
  for select
  to authenticated
  using (
    exists (
      select 1
        from public.loans l
        join public.clients c on c.id = l.client_id
       where l.id = loan_installments.loan_id
         and (
           public.user_has_permission('schedules:view')
           or (
             c.profile_id is not null
             and c.profile_id = public.current_profile_id()
           )
         )
    )
  );

comment on policy loan_installments_select_with_loan on public.loan_installments is
  'Visible exactly when its loan is, and then only to schedules:view or to the borrower themselves. No write policy and no write grant: only generate_loan_schedule writes installments.';
