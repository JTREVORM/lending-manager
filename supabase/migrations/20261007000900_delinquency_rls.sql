-- ===========================================================================
-- Phase 7 — Row Level Security for penalties.
--
-- The same boundary as Phase 6, for the same reason: route protection, hidden
-- panels and guarded Server Actions give people a coherent experience and fail
-- early, and none of them survives a caller who takes their own token straight
-- to PostgREST. So this policy is written to be correct on the assumption that
-- everything above it has been bypassed.
--
-- ## SELECT only. There is no write policy, and no write grant
--
-- A penalty is written by `ensure_penalty_applied` alone, which is SECURITY
-- DEFINER and so runs as the table owner, bypassing RLS. No session role —
-- not the Owner, not `authenticated` under any capability — holds INSERT,
-- UPDATE or DELETE on `loan_penalties`.
--
-- That is stronger than a narrow INSERT policy would be, and deliberately so.
-- If the only path to a charge is one function, then every rule that function
-- enforces — the grace deadline, the basis reconstructed as at that deadline,
-- the loan's own snapshotted rate, the one-penalty-per-loan rule, half-up
-- rounding — is enforced on every penalty that can ever exist. An INSERT
-- grant, however carefully policed, would be a second path with none of them,
-- and the thing it would let somebody create is an arbitrary charge against a
-- borrower.
--
-- The append-only triggers in `20261007000300` are the backstop beneath that:
-- they refuse UPDATE and DELETE for the table owner and `service_role` too.
--
-- ## Delegation rather than restatement
--
-- Visibility asks whether the **loan** is visible, exactly as
-- `loan_payments` does. The sub-select is itself subject to the policy on
-- `loans`, so this is that rule rather than a copy of it free to drift.
--
-- The delegation matters for the derived views as much as for the table:
-- `loan_balances` and `loan_delinquency` aggregate penalties, so a role that
-- could see a loan but not its penalty would read a balance that
-- under-reports what the borrower owes.
--
-- ## The borrower sees their own penalty
--
-- Without a capability, through the ownership clause — the arrangement every
-- phase since Phase 4 has used. A charge against somebody's account that they
-- cannot see is not a position this system will take: it is the figure they
-- are being asked to pay.
-- ===========================================================================

create policy loan_penalties_select_with_loan
  on public.loan_penalties
  for select
  to authenticated
  using (
    exists (
      select 1
        from public.loans l
        join public.clients c on c.id = l.client_id
       where l.id = loan_penalties.loan_id
         and (
           public.user_has_permission('penalties:view')
           or (
             c.profile_id is not null
             and c.profile_id = public.current_profile_id()
           )
         )
    )
  );

comment on policy loan_penalties_select_with_loan on public.loan_penalties is
  'Visible exactly when its loan is, and then only to penalties:view or to the borrower themselves. No write policy and no write grant: only ensure_penalty_applied creates a penalty, and nothing may change one.';
