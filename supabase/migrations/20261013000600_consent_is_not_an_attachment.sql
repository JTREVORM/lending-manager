-- ===========================================================================
-- Phase 13.6 — signing an undertaking is not taking on a new guarantee
--
-- `loan_guarantors_check_eligibility` fires on an UPDATE of a named column
-- list, and 13.3 put the consent columns in that list. The effect, found by
-- taking a consent on a real application:
--
--     ERROR: Ssempijja Alex Bbaale already guarantees 2 active loans,
--            which is the limit the business permits.
--
-- He does. He was attached to this application while he guaranteed one, and a
-- second has since gone active. Re-running the concentration rule when he
-- picks up a pen refuses the signature — and because the consent is the only
-- thing standing between the application and a decision, the application is
-- now stuck: he cannot sign, and he cannot be removed either, because
-- removing a guarantor is itself a change to the application.
--
-- The rule is right and the moment is wrong. "How many active loans may one
-- person stand behind" is a question about *taking on* a guarantee, and it is
-- asked when the guarantor is attached — at which point the answer was yes.
-- Signing the undertaking records what they already agreed to.
--
-- So the column list narrows to the three columns that say *who* is
-- guaranteeing and *how they are related*. Attaching still runs every rule;
-- so does changing who the guarantor is. The consent columns come off the
-- list, and they are not left unguarded: `loan_guarantors_guard_snapshot`
-- makes a signed consent write-once, and `validate_loan_for_approval`
-- re-evaluates the guarantor's standing — blacklisted, suspended, archived —
-- at the moment of the decision.
--
-- `create or replace trigger` rather than a drop and a re-create: the
-- tooling that reaches the live database cannot run a destructive statement
-- non-interactively, and replacing in place is also the thing that cannot
-- leave the table briefly unguarded.
--
-- ## What this does not change
--
-- Concentration is still counted only when a guarantee is taken on, which
-- means three applications naming the same guarantor can all be approved and
-- leave them behind three active loans. That is a gap, and it is deliberately
-- left for Phase 5 to close alongside the rest of the guarantor register and
-- exposure reporting, where the figure a business wants to act on is total
-- exposure rather than a count.
-- ===========================================================================

create or replace trigger loan_guarantors_check_eligibility
  before insert or update of
    guarantor_id, guarantor_client_id, relationship_to_client
  on public.loan_guarantors
  for each row execute function public.loan_guarantors_check_eligibility();

comment on function public.loan_guarantors_check_eligibility() is
  'Phase 13. Applies the business''s guarantor rules when a guarantor is attached to an application: who may act, how old they must be, and how many active loans one person may stand behind. Runs when the guarantee is taken on, not when the undertaking is signed.';
