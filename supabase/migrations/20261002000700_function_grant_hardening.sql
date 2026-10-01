-- ===========================================================================
-- 20261002000700_function_grant_hardening
--
-- Remove the last EXECUTE grants that nobody needs.
--
-- The two Phase 1 trigger functions were created without an explicit revoke,
-- so they inherited PostgreSQL's default grant of EXECUTE to PUBLIC and
-- Supabase's grants to `anon` and `authenticated`.
--
-- This is **not** closing an exploitable hole. PostgreSQL refuses to call a
-- function returning `trigger` outside a trigger context — the attempt fails
-- with "trigger functions can only be called as triggers" — so there was
-- nothing an anonymous caller could do with them.
--
-- It is worth doing anyway for one reason: it makes the answer to "which
-- functions can an anonymous visitor execute?" an unqualified "none". An
-- audit that has to stop and reason about why two entries are harmless is an
-- audit that will eventually wave through a third that is not.
--
-- `tests/db/security.test.ts` asserts the list stays empty.
-- ===========================================================================

revoke all on function public.set_updated_at() from public, anon, authenticated;
revoke all on function public.reject_mutation() from public, anon, authenticated;
