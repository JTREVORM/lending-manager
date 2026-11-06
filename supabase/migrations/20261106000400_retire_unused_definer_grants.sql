-- ===========================================================================
-- Shrink the Data API's SECURITY DEFINER surface to what is actually used.
--
-- ## Why a grant and not a guard
--
-- 20261103000100 recorded sixteen `SECURITY DEFINER` functions that are
-- executable by `authenticated` and hold no authorization check of their own.
-- Two of them disclosed enough to be worth guarding, and are now guarded
-- (20261106000100, 20261106000200). For the rest, the Phase 2 review asked a
-- blunter question first: does anything actually call them through the Data
-- API?
--
-- For eight of them the answer is no. Nothing in `app/`, `lib/` or
-- `components/` issues an RPC against any of these names, and every caller
-- inside the database is another `SECURITY DEFINER` function, which executes
-- as the owner and therefore does not need the caller to hold EXECUTE.
--
-- So the right treatment is not a guard bolted onto a function nobody calls.
-- It is to stop exposing it. PostgREST can only reach what the request's role
-- may execute, so revoking the grant removes the route entirely — a smaller
-- surface than any check could give, and nothing to keep correct over time.
--
-- ## The eight, and what each one leaked
--
--   benefit_blocked_reason            which benefit rule a policy leaves undecided
--   benefits_blocked_reason           the same, for benefits as a whole
--   member_lending_blocked_reason     the same, for member lending
--   benefit_expense_account           which GL account a claim type expenses to
--   membership_fee_is_posted          whether a named membership paid its fee
--   membership_terms_are_accepted     whether a named membership accepted terms
--   savings_account_governing_policy  which policy version governs an account
--
-- Individually small — configuration and policy metadata, not a member's
-- money. Together they are seven unauthenticated-by-capability routes into
-- per-member facts, and none of them has a reason to exist.
--
-- ## The nine that are NOT in this migration, and why
--
-- Four of the sixteen must keep the grant, because something evaluated in the
-- *caller's* context depends on it. Verified structurally, not assumed:
--
--   active_membership_policy_id   `memberships_insert_with_permission`,
--                                 a WITH CHECK policy expression
--   membership_policy_allows      the `member_loan_eligibility` view,
--                                 which is `security_invoker = true`
--   membership_governing_policy   the `membership_register` view,
--                                 likewise `security_invoker = true`
--   business_timezone             `loan_schedules_timezone_not_blank`,
--                                 a CHECK constraint
--
-- Revoking any of those would turn a correct, silent denial into
-- "permission denied for function" on an ordinary insert or register read.
--
-- Two more are called by the application and stay: `business_now` (the
-- business clock) and `consume_rate_limit` (the rate limiter itself, which
-- `enforce_password_change` deliberately allowlists so a forced session can
-- still be throttled).
--
-- `user_can_see_branch` also stays, on a different ground: it is an
-- authorization predicate whose whole answer is about the caller. It takes a
-- branch id and returns whether *this* session may see that branch, reading
-- nothing out of the branch itself, so calling it tells a caller only what
-- they already know about themselves. It has thirty internal callers, and
-- `tests/db/rls-hoisting.test.ts` evaluates it in a real session to prove the
-- hoisted inline predicate in the RLS policies is the same predicate — a
-- comparison that only means anything when the function runs as the caller.
-- Exempt, with that evidence, rather than revoked.
--
-- `validate_loan_for_approval` and `redeem_membership_consent_code` are the
-- two now guarded. That leaves seven reviewed exceptions, down from sixteen,
-- each with a reason recorded in `docs/POLYTOS-SECURITY-RISK-INVENTORY.md`
-- and enforced by `scripts/check-database-security.mjs`.
--
-- ## What is not touched
--
-- Every function keeps its body, signature, volatility, result shape and
-- owner. `postgres` and `service_role` keep EXECUTE, so internal definer
-- callers, migrations, the bootstrap script and the seeders are unaffected.
-- No policy, constraint, view, row, financial record, account or policy
-- version changes.
-- ===========================================================================

REVOKE EXECUTE ON FUNCTION public.benefit_blocked_reason(uuid, text)
  FROM public, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.benefits_blocked_reason(uuid)
  FROM public, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.member_lending_blocked_reason(uuid)
  FROM public, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.benefit_expense_account(text)
  FROM public, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.membership_fee_is_posted(uuid)
  FROM public, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.membership_terms_are_accepted(uuid)
  FROM public, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.savings_account_governing_policy(uuid, date)
  FROM public, anon, authenticated;
