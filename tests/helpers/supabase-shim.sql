-- ===========================================================================
-- Supabase compatibility shim — TEST HARNESS ONLY
--
-- The migrations in supabase/migrations/ target a Supabase project, where the
-- `auth` and `storage` schemas and the `anon` / `authenticated` /
-- `service_role` roles already exist. This file recreates just enough of that
-- environment for a plain PostgreSQL cluster, so migrations can be verified
-- against a clean database without Docker.
--
-- This file is NOT a migration and is never applied to a Supabase project.
-- It lives under tests/ precisely so it cannot be mistaken for one.
--
-- Fidelity matters in one respect especially: Supabase grants broad table
-- privileges in `public` to anon/authenticated/service_role via ALTER DEFAULT
-- PRIVILEGES. That is replicated below, so the explicit REVOKE statements in
-- the migrations are actually doing something and the tests that assert
-- "anon holds no privilege on this table" are meaningful rather than vacuous.
-- ===========================================================================

-- --- Roles ----------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'service_role') then
    -- Supabase's service_role carries BYPASSRLS.
    create role service_role nologin noinherit bypassrls;
  end if;
end
$$;

grant usage on schema public to anon, authenticated, service_role;

-- Replicate Supabase's default privileges, so the migrations' REVOKEs matter.
alter default privileges in schema public
  grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public
  grant all on functions to anon, authenticated, service_role;
alter default privileges in schema public
  grant all on sequences to anon, authenticated, service_role;


-- --- auth schema ----------------------------------------------------------
create schema if not exists auth;

create table if not exists auth.users (
  id uuid primary key default gen_random_uuid(),
  email text,
  created_at timestamptz not null default now()
);

-- In Supabase, auth.uid() reads the `sub` claim of the request's JWT. Here it
-- reads a session GUC, so a test can impersonate a user with
--   set local "request.jwt.claim.sub" = '<uuid>';
create or replace function auth.uid()
returns uuid
language sql
stable
as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;

grant usage on schema auth to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated, service_role;


-- --- storage schema -------------------------------------------------------
create schema if not exists storage;

create table if not exists storage.buckets (
  id text primary key,
  name text not null unique,
  public boolean not null default false,
  file_size_limit bigint,
  allowed_mime_types text[],
  created_at timestamptz not null default now()
);

grant usage on schema storage to anon, authenticated, service_role;
