-- ===========================================================================
-- Phase 6 — Row Level Security for the payment ledger.
--
-- The boundary. Hidden buttons, guarded Server Actions and route protection
-- exist to give people a coherent experience and to fail early; none survives
-- a caller who takes their own token to PostgREST directly. So each policy is
-- written to be correct assuming everything above it has been bypassed.
--
-- ## SELECT only. There is no write policy on either table
--
-- Not a narrow INSERT policy guarded by `payments:create` — none at all, and
-- no INSERT, UPDATE or DELETE grant either. Payments and allocations are
-- written solely by `post_payment`, which is SECURITY DEFINER and so runs as
-- the table owner, bypassing RLS.
--
-- That is deliberately stronger than it needs to be for correctness, and it
-- is the Phase 5 reasoning applied to money: if the only path to the ledger is
-- one function, then every rule that function enforces — the minimum, the
-- outstanding cap, the duplicate check, the allocation order, the
-- reconciliation — is enforced on every row that can ever exist. A direct
-- INSERT grant, however carefully policed, would be a second path with none of
-- them.
--
-- The one UPDATE that is legitimate — a reversal — also goes through a
-- function, `reverse_payment`. No session has the privilege to perform it
-- directly, and the guard trigger in migration `20261006000500` would refuse
-- anything but a complete, attributed reversal even if one did.
--
-- ## Delegation rather than restatement
--
-- `loan_payments` decides visibility by asking whether the **loan** is
-- visible, and `payment_allocations` by asking whether the **payment** is.
-- Each sub-select is itself subject to the policy on the table it reads, so
-- these are those rules rather than copies free to drift from them.
--
-- The allocation delegation is load-bearing beyond tidiness. The balance views
-- aggregate allocations, so a role that could see a payment but not its
-- allocations would read a silently under-reported balance. Delegating makes
-- the two visibilities the same visibility by construction.
-- ===========================================================================

grant select on table public.loan_payments to authenticated;
grant select on table public.payment_allocations to authenticated;

create policy loan_payments_select_with_loan
  on public.loan_payments
  for select
  to authenticated
  using (
    exists (
      select 1
        from public.loans l
        join public.clients c on c.id = l.client_id
       where l.id = loan_payments.loan_id
         and (
           public.user_has_permission('payments:view')
           -- The borrower, on their own loan. No capability: a receipt is the
           -- borrower's evidence of what they handed over, and withholding it
           -- from them would be indefensible.
           or (
             c.profile_id is not null
             and c.profile_id = public.current_profile_id()
           )
         )
    )
  );

comment on policy loan_payments_select_with_loan on public.loan_payments is
  'Visible exactly when its loan is, and then only to payments:view or to the borrower themselves. No write policy and no write grant: only post_payment and reverse_payment touch this table.';

create policy payment_allocations_select_with_payment
  on public.payment_allocations
  for select
  to authenticated
  using (
    exists (
      select 1
        from public.loan_payments lp
       where lp.id = payment_allocations.payment_id
    )
  );

comment on policy payment_allocations_select_with_payment on public.payment_allocations is
  'Visible exactly when its payment is. Delegates entirely, because the balance views aggregate these rows: a role that could read a payment but not its allocations would see an under-reported balance.';
