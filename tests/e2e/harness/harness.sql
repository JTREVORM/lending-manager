-- ===========================================================================
-- END-TO-END HARNESS ONLY — not a migration, never applied to a real project.
--
-- Bridges the test shim to a real PostgREST, which is how the application
-- actually talks to PostgreSQL. Three things are needed and nothing else:
--
--  1. `auth.uid()` must also read PostgREST's `request.jwt.claims`, because
--     PostgREST ≥ 9 sets that single JSON GUC rather than the per-claim GUCs
--     the test harness uses. Both forms are supported so the test suite is
--     unaffected.
--  2. A LOGIN role for PostgREST to connect as, which can switch into
--     `anon` and `authenticated` — exactly the `authenticator` arrangement a
--     hosted Supabase project uses.
--  3. Somewhere to keep a password hash, since the shim's `auth.users` has no
--     such column.
-- ===========================================================================

create or replace function auth.uid()
returns uuid
language sql
stable
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    nullif(current_setting('request.jwt.claims', true)::json ->> 'sub', '')
  )::uuid
$$;

grant execute on function auth.uid() to anon, authenticated, service_role;

alter table auth.users add column if not exists encrypted_password text;

-- `:'password'` is a psql variable supplied by stack.sh, run through `\gexec`
-- because a psql variable does not interpolate inside a DO block's body. A
-- literal here would be a credential checked into the repository, even a
-- harness-only one.
select format('create role authenticator noinherit login password %L', :'password')
 where not exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticator')
\gexec

-- Always set it, so a second run with a different password still connects.
select format('alter role authenticator password %L', :'password')
\gexec

grant anon, authenticated, service_role to authenticator;

-- PostgREST reads the schema cache as the authenticator, then switches role.
grant usage on schema public to authenticator;
grant usage on schema auth to authenticator;
