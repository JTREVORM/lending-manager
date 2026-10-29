-- ===========================================================================
-- Polytos business-policy update — Row Level Security on everything this
-- update added
-- ===========================================================================
--
-- Seven new tables. Every one of them is read behind a capability and, where
-- the row belongs to a branch, within that branch. None of them is writable
-- from a session at all: every write goes through a `SECURITY DEFINER`
-- function that checks the capability, the branch and the business rule, so
-- the tables carry no INSERT or UPDATE grant and a forged PostgREST request
-- has nothing to write to.
--
-- That is stricter than Phase 4 needed to be in two places — `meeting_fines`
-- and `meeting_fine_payments` have no UPDATE grant where
-- `membership_meetings` has one — and the reason is that nothing about a fine
-- is ever changed by a plain statement. Collection, cancellation and reversal
-- each have a function, each of which does several things atomically.
--
-- ## Who reads what, and why
--
-- **Policy transitions and assignments** — `membership_policy:manage` only.
-- Not `membership:view`: the assignment history is the record of terms being
-- changed, and a counter clerk reading "this member was moved onto 2.0 on 1
-- December" is reading a decision about the business rather than a fact about
-- the member. The *effect* of it — which rules govern them — is on the
-- membership register, which they do read.
--
-- **Carry-forwards** — `payments:view`, within branch. A collection record,
-- read by whoever works collections, and by the member whose loan it is:
-- there **is** a self-clause here, because "October's instalment is on
-- November's list" is information the borrower is entitled to and the portal
-- already shows them their own schedule.
--
-- **Death confirmations** — `benefits:view`, within branch, and no
-- self-clause of any kind. Who confirmed a death, and what they said about
-- it, is the evidence behind somebody else's payment; a member reading the
-- list for their own family's claim would be reading three other members'
-- statements about them.
--
-- **Absence notices** — `meetings:view`, within branch, plus a self-clause.
-- A member may see that their own excuse was recorded and whether it was
-- accepted, because the alternative is a member who is charged UGX 5,000 and
-- cannot find out whether the message they left was ever considered.
--
-- **Fines and their payments** — `fines:view`, within branch, plus a
-- self-clause. The same reasoning, with money attached: a charge against a
-- member is something that member may read.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Policy transitions
-- ---------------------------------------------------------------------------

grant select on table public.membership_policy_transitions to authenticated;

alter table public.membership_policy_transitions enable row level security;

create policy membership_policy_transitions_select
  on public.membership_policy_transitions
  for select
  to authenticated
  using ((select public.user_has_permission('membership_policy:manage')));

comment on policy membership_policy_transitions_select
  on public.membership_policy_transitions is
  'membership_policy:manage only, and no branch clause — a transition is a decision about the whole book, not about one branch''s members.';

grant select on table public.membership_policy_assignments to authenticated;

alter table public.membership_policy_assignments enable row level security;

create policy membership_policy_assignments_select
  on public.membership_policy_assignments
  for select
  to authenticated
  using ((select public.user_has_permission('membership_policy:manage')));

comment on policy membership_policy_assignments_select
  on public.membership_policy_assignments is
  'membership_policy:manage only. The history of terms being changed is a record about the business; which rules govern a member today is on the membership register, which membership:view reads.';

-- ---------------------------------------------------------------------------
-- Collection carry-forwards
-- ---------------------------------------------------------------------------

grant select on table public.loan_installment_carry_forwards to authenticated;

alter table public.loan_installment_carry_forwards enable row level security;

create policy loan_carry_forwards_select
  on public.loan_installment_carry_forwards
  for select
  to authenticated
  using (
    (
      (select public.user_has_permission('payments:view'))
      and exists (
        select 1 from public.loans l
        where l.id = loan_id and (l.branch_id is null or (select public.current_user_branch_id()) is null
            or l.branch_id = (select public.current_user_branch_id()))
      )
    )
    -- The borrower's own. "October's instalment is on November's list" is
    -- information the person who owes it is entitled to.
    or exists (
      select 1 from public.loans l
      join public.clients c on c.id = l.client_id
      where l.id = loan_id
        and c.profile_id is not null
        and c.profile_id = (select public.current_profile_id())
    )
  );

comment on policy loan_carry_forwards_select
  on public.loan_installment_carry_forwards is
  'payments:view within branch, or the borrower''s own. A carry-forward says when the business will chase an instalment it is already owed; the person who owes it may read that.';

-- ---------------------------------------------------------------------------
-- Death confirmations
-- ---------------------------------------------------------------------------

grant select on table public.benefit_death_confirmations to authenticated;

alter table public.benefit_death_confirmations enable row level security;

create policy benefit_death_confirmations_select
  on public.benefit_death_confirmations
  for select
  to authenticated
  using (
    (select public.user_has_permission('benefits:view'))
    and exists (
      select 1 from public.benefit_claims bc
      where bc.id = claim_id and (bc.branch_id is null or (select public.current_user_branch_id()) is null
            or bc.branch_id = (select public.current_user_branch_id()))
    )
  );

comment on policy benefit_death_confirmations_select
  on public.benefit_death_confirmations is
  'benefits:view, within branch, and deliberately no self-clause. These are three other members'' statements about a death; the claimant reads how many were given — death_confirmation_count is SECURITY DEFINER for exactly that — and not who said what.';

-- ---------------------------------------------------------------------------
-- Absence notices
-- ---------------------------------------------------------------------------

grant select on table public.meeting_absence_notices to authenticated;

alter table public.meeting_absence_notices enable row level security;

create policy meeting_absence_notices_select
  on public.meeting_absence_notices
  for select
  to authenticated
  using (
    (
      (select public.user_has_permission('meetings:view'))
      and (branch_id is null or (select public.current_user_branch_id()) is null
            or branch_id = (select public.current_user_branch_id()))
    )
    or exists (
      select 1 from public.clients c
      where c.id = client_id
        and c.profile_id is not null
        and c.profile_id = (select public.current_profile_id())
    )
  );

comment on policy meeting_absence_notices_select on public.meeting_absence_notices is
  'meetings:view within branch, or the member''s own. A member who is charged UGX 5,000 must be able to find out whether the message they left was ever considered.';

-- ---------------------------------------------------------------------------
-- Fines
-- ---------------------------------------------------------------------------

grant select on table public.meeting_fines to authenticated;

alter table public.meeting_fines enable row level security;

create policy meeting_fines_select
  on public.meeting_fines
  for select
  to authenticated
  using (
    (
      (select public.user_has_permission('fines:view'))
      and (branch_id is null or (select public.current_user_branch_id()) is null
            or branch_id = (select public.current_user_branch_id()))
    )
    or exists (
      select 1 from public.clients c
      where c.id = client_id
        and c.profile_id is not null
        and c.profile_id = (select public.current_profile_id())
    )
  );

comment on policy meeting_fines_select on public.meeting_fines is
  'fines:view within branch, or the member''s own. No INSERT or UPDATE grant at all: a fine is charged, collected, cancelled and reversed by functions that each do several things atomically, and a bare statement could do one of them.';

grant select on table public.meeting_fine_payments to authenticated;

alter table public.meeting_fine_payments enable row level security;

create policy meeting_fine_payments_select
  on public.meeting_fine_payments
  for select
  to authenticated
  using (
    (
      (select public.user_has_permission('fines:view'))
      and (branch_id is null or (select public.current_user_branch_id()) is null
            or branch_id = (select public.current_user_branch_id()))
    )
    or exists (
      select 1 from public.clients c
      where c.id = client_id
        and c.profile_id is not null
        and c.profile_id = (select public.current_profile_id())
    )
  );

comment on policy meeting_fine_payments_select on public.meeting_fine_payments is
  'fines:view within branch, or the member''s own — a receipt for money they paid.';

-- ---------------------------------------------------------------------------
-- The capability a fine reversal must not grant
-- ---------------------------------------------------------------------------
--
-- `fines:reverse` cancels a charge and reverses a collection. It is granted to
-- the Owner/Administrator alone, and this is the assertion that it buys
-- nothing else: it appears in no policy above, so holding it gives no extra
-- read anywhere, and the two functions that check it touch only
-- `meeting_fines`, `meeting_fine_payments` and the General Ledger — never a
-- loan, a savings balance, a benefit or another branch's rows.
--
-- `tests/db/meeting-fines.test.ts` asserts this from a session: a holder of
-- `fines:reverse` and nothing else can reverse a fine and can read no client,
-- loan, savings account or benefit claim.
