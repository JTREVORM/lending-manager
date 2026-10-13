-- ===========================================================================
-- Phase 18 — the caller is resolved in one round trip
--
-- ## What was wrong
--
-- `lib/auth/context.ts` resolved the caller with three sequential network
-- calls, every one of them blocking the page:
--
--   1. `supabase.auth.getClaims()` — intended as a local signature check.
--      It is local only when the project signs its tokens with an
--      **asymmetric** key. This project's tokens are HS256, and for a
--      symmetric algorithm `getClaims()` falls back to `getUser(token)`,
--      which is an HTTP request to the Auth service. See
--      `GoTrueClient.getClaims`: `if (!signingKey) { await this.getUser(token) }`.
--   2. `select ... from profiles where auth_user_id = ...`
--   3. `select role_key from user_roles where profile_id = ...`
--
-- Three round trips, strictly serial because each needs the one before. The
-- production deployment runs in `iad1` and the database is in `eu-west-1`, so
-- each of those is a transatlantic round trip — roughly 80 ms, about 240 ms
-- before a page has begun to render, on **every** request including every
-- client-side navigation.
--
-- ## What this does
--
-- One function, one round trip, returning exactly what `AuthContext` needs.
--
-- It is built by composition over the two primitives Phase 2 already
-- established, so it introduces no second definition of "who is this":
--
--   * the profile is the one `public.current_profile_id()` resolves — which
--     is to say the caller's own, and only while it is ACTIVE, so a suspended
--     account still resolves nothing and still reports as unauthorised on the
--     very next request;
--   * the roles are what `public.current_user_role_keys()` reports for that
--     same profile.
--
-- ## Why dropping the `getClaims()` call does not weaken anything
--
-- The concern `getClaims()` answers is real: a cookie is attacker-controlled
-- input, so the server must never believe a token's contents without
-- verifying its signature. That verification still happens, twice:
--
--   * **The proxy still calls `getClaims()`.** It has to — that call is what
--     refreshes an expiring token and writes the new cookies, which a Server
--     Component cannot do. So every request still passes a verified token
--     check before any page code runs, and that has not changed.
--   * **PostgREST verifies the token before this function can observe it.**
--     `auth.uid()` reads `request.jwt.claims`, and PostgREST populates that
--     only after checking the signature against the project's key and
--     rejecting an expired `exp` with a 401. A row coming back from this
--     function is therefore proof that the token was well-formed, correctly
--     signed and unexpired — the same proof `getClaims()` was asked for, from
--     the service that was going to be asked anyway.
--
-- What is removed is the *third* verification of the same token in the same
-- request, which cost a transatlantic round trip and established nothing the
-- other two had not. Nothing here trusts `getSession()`, and nothing here
-- trusts a request header.
--
-- ## Why it reports its own failure reason
--
-- The application distinguishes "no session" from "no active profile" from
-- "no role", because it responds differently to each and because the reason
-- must never be shown to an anonymous visitor at the sign-in screen. Those
-- three cases were previously told apart by *which* of the three calls came
-- back empty. With one call they have to be reported, so `outcome` says
-- which it is — decided in the database, where identity already lives, rather
-- than inferred in the application from an absence.
--
-- The function always returns exactly one row, so "no rows" is never a case
-- the caller has to interpret.
--
-- ## Nothing here touches money
--
-- No balance, schedule, interest, penalty or ledger object is read or
-- altered. This function reads `profiles` and `user_roles` and nothing else.
-- ===========================================================================

create or replace function public.current_session_context()
returns table (
  outcome              text,
  auth_user_id         uuid,
  profile_id           uuid,
  full_name            text,
  phone                text,
  email                text,
  status               text,
  must_change_password boolean,
  role_keys            text[]
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    case
      -- No verified token reached the database at all.
      when (select auth.uid()) is null then 'no_session'
      -- A verified token, but no profile the caller can resolve: either the
      -- account was never linked to one, or it is no longer active. The two
      -- are indistinguishable here by design, because `current_profile_id()`
      -- returns NULL for both and telling them apart would disclose whether
      -- an account exists.
      when p.id is null then 'no_active_profile'
      -- A profile with no role assignment. An incomplete account, not a
      -- borrower: defaulting it to `client` would silently grant portal
      -- access to a half-created user.
      when coalesce(pg_catalog.array_length(r.keys, 1), 0) = 0 then 'no_roles'
      else 'ok'
    end                                 as outcome,
    (select auth.uid())                 as auth_user_id,
    p.id                                as profile_id,
    p.full_name,
    p.phone,
    p.email,
    p.status,
    p.must_change_password,
    coalesce(r.keys, '{}'::text[])      as role_keys
  -- A one-row anchor, so the function answers even when there is no profile
  -- and the caller never has to treat "no rows" as a fourth outcome.
  from (select 1) anchor
  left join public.profiles p
    on p.id = (select public.current_profile_id())
  left join lateral (
    select public.current_user_role_keys() as keys
  ) r on true
$$;

comment on function public.current_session_context() is
  'Phase 18. The authenticated caller in one round trip: their active profile, their role keys, and an outcome saying why not when there is no usable session. Composed over current_profile_id() and current_user_role_keys(), so it adds no second definition of identity; always returns exactly one row.';

revoke all on function public.current_session_context() from public, anon, authenticated;
grant execute on function public.current_session_context() to authenticated;
