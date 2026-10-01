-- ===========================================================================
-- 20261001000300_roles_and_assignments
--
-- Role architecture: a lookup table plus an assignment table.
--
-- ## The decision
--
-- Three designs were considered for the four known roles (client,
-- secretary_treasurer, manager, owner_admin):
--
--   1. A `role` column on `profiles`. Simplest, but permits exactly one role
--      per person and records nothing about who granted it. "Who gave this
--      person the ability to approve loans, and when" is an audit question a
--      lending business must be able to answer.
--
--   2. A PostgreSQL `enum`. Type-safe at the column, but adding a role needs
--      `ALTER TYPE` (which cannot run in the same transaction that uses the
--      new value), a value can never be removed, and the role carries no
--      metadata — no label, no rank, no staff flag.
--
--   3. Lookup table + assignment table. CHOSEN. A new role is an INSERT.
--      Roles carry their own label, rank and staff flag. Assignments are rows
--      that record `granted_by` and `granted_at`. Referential integrity is a
--      foreign key. Multiple roles per person are representable at no cost,
--      which the business does not need today but may.
--
-- The TypeScript mirror is lib/permissions/roles.ts, and a database
-- integration test asserts the two lists are identical — so a role added in
-- SQL without updating the application fails the test suite.
--
-- ## Helper functions
--
-- `current_profile_id`, `current_user_role_keys`, `user_has_role` and
-- `user_has_at_least_role` are SECURITY DEFINER for one specific reason: a
-- Phase 2 RLS policy on `user_roles` that itself queried `user_roles` would
-- recurse infinitely. A SECURITY DEFINER function reads the table outside RLS
-- and breaks the cycle. Each one is scoped to the *calling* user's own rows
-- via `auth.uid()`, so none of them can be used to read another person's
-- roles, and EXECUTE is revoked from PUBLIC.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Role vocabulary
-- ---------------------------------------------------------------------------
create table public.roles (
  key text primary key,
  label text not null,
  description text not null,

  -- Higher means more authority. Gaps are left between seeded values so a new
  -- role can be slotted in without renumbering.
  rank integer not null unique,

  -- false for borrower roles, true for employee roles.
  is_staff boolean not null,

  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),

  constraint roles_key_format check (key ~ '^[a-z][a-z0-9_]*$'),
  constraint roles_key_length check (char_length(key) between 2 and 50),
  constraint roles_label_not_blank check (btrim(label) <> ''),
  constraint roles_description_not_blank check (btrim(description) <> ''),
  constraint roles_rank_range check (rank between 1 and 1000)
);

comment on table public.roles is
  'Role vocabulary. Seeded with the four business roles; extensible by INSERT.';
comment on column public.roles.rank is
  'Authority ordering. Used for "at least a manager" checks and to resolve an effective role.';

create trigger roles_set_updated_at
  before update on public.roles
  for each row
  execute function public.set_updated_at();


-- ---------------------------------------------------------------------------
-- Role assignments
-- ---------------------------------------------------------------------------
create table public.user_roles (
  profile_id uuid not null references public.profiles (id) on delete restrict,
  role_key text not null references public.roles (key) on delete restrict,

  -- Who granted it. Nullable because the first owner_admin is necessarily
  -- granted by the system, with nobody to attribute it to.
  granted_by uuid references public.profiles (id) on delete restrict,
  granted_at timestamptz not null default pg_catalog.now(),

  primary key (profile_id, role_key)
);

comment on table public.user_roles is
  'Which roles each profile holds, and who granted them. Composite primary key prevents duplicates.';
comment on column public.user_roles.granted_by is
  'Granting profile. NULL only for system-seeded grants.';

-- "Which profiles hold role X" — needed by Phase 2 user management.
create index user_roles_role_key_idx on public.user_roles (role_key);


-- ---------------------------------------------------------------------------
-- Session helpers
--
-- All four are STABLE (one value per statement) and SECURITY DEFINER (to
-- escape RLS recursion). All are scoped to the calling user.
-- ---------------------------------------------------------------------------

-- The profile belonging to the currently authenticated user, or NULL.
create or replace function public.current_profile_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select p.id
  from public.profiles p
  where p.auth_user_id = auth.uid()
    and p.status = 'active'
$$;

comment on function public.current_profile_id() is
  'Profile id of the authenticated user, or NULL. Only active profiles resolve, so a suspended or archived account has no identity for authorization purposes.';


-- Role keys held by the current user. Empty array when unauthenticated.
create or replace function public.current_user_role_keys()
returns text[]
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(pg_catalog.array_agg(ur.role_key), '{}'::text[])
  from public.user_roles ur
  where ur.profile_id = public.current_profile_id()
$$;

comment on function public.current_user_role_keys() is
  'Role keys held by the authenticated user. Empty array if none — never a default role.';


-- Does the current user hold this exact role?
create or replace function public.user_has_role(p_role_key text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.user_roles ur
    where ur.profile_id = public.current_profile_id()
      and ur.role_key = p_role_key
  )
$$;

comment on function public.user_has_role(text) is
  'True when the authenticated user holds exactly this role.';


-- Does the current user hold this role or anything ranked above it?
create or replace function public.user_has_at_least_role(p_role_key text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.user_roles ur
    join public.roles held on held.key = ur.role_key
    join public.roles required on required.key = p_role_key
    where ur.profile_id = public.current_profile_id()
      and held.rank >= required.rank
  )
$$;

comment on function public.user_has_at_least_role(text) is
  'True when the authenticated user holds this role or one of higher rank. Returns false for an unknown role key.';


-- --- Access control -------------------------------------------------------

alter table public.roles enable row level security;
alter table public.user_roles enable row level security;

revoke all on table public.roles from anon, authenticated;
revoke all on table public.user_roles from anon, authenticated;

-- `roles` is the one table opened for reading in Phase 1.
--
-- It holds a vocabulary — four keys, their labels and their ordering. No
-- personal data, no financial data, nothing about who holds what. Phase 2's
-- user-management UI needs to render the list of roles, and withholding it
-- would buy no security while requiring a workaround. The policy is scoped to
-- `authenticated`: an anonymous visitor still sees nothing.
--
-- `user_roles` is NOT opened. Who holds which role is exactly the kind of
-- information an attacker wants, and Phase 2 defines who may see it.
grant select on table public.roles to authenticated;

create policy roles_select_authenticated
  on public.roles
  for select
  to authenticated
  using (true);

comment on policy roles_select_authenticated on public.roles is
  'Non-sensitive role vocabulary, readable by any signed-in user. No personal or financial data.';

-- EXECUTE on the helpers: available to signed-in users (each is scoped to the
-- caller), denied to anonymous visitors.
--
-- Note that revoking from PUBLIC alone is NOT sufficient on Supabase.
-- PostgreSQL grants EXECUTE to PUBLIC by default, but Supabase additionally
-- grants it explicitly to anon, authenticated and service_role through
-- ALTER DEFAULT PRIVILEGES. An explicit grant survives a revoke from PUBLIC,
-- so each role must be named. Getting this wrong leaves a SECURITY DEFINER
-- function callable by anonymous visitors.
revoke all on function public.current_profile_id() from public, anon, authenticated;
revoke all on function public.current_user_role_keys() from public, anon, authenticated;
revoke all on function public.user_has_role(text) from public, anon, authenticated;
revoke all on function public.user_has_at_least_role(text) from public, anon, authenticated;

grant execute on function public.current_profile_id() to authenticated;
grant execute on function public.current_user_role_keys() to authenticated;
grant execute on function public.user_has_role(text) to authenticated;
grant execute on function public.user_has_at_least_role(text) to authenticated;

-- DEFERRED TO PHASE 2 — intentionally absent:
--   * user_roles SELECT for staff and for self
--   * user_roles INSERT/DELETE for owner_admin, with an audit trigger
