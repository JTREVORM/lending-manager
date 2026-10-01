-- ===========================================================================
-- 20261002000100_permission_matrix
--
-- The permission matrix, as database rows.
--
-- ## Why the matrix lives here as well as in TypeScript
--
-- Phase 1 established that Row Level Security is the real security boundary:
-- a caller holding a valid token can bypass every application check by
-- calling the Supabase REST API directly. So the policies that Phase 2 adds
-- must be able to ask "may this user do X", and the only way to do that
-- inside a policy is to have the matrix in the database.
--
-- The alternative — writing policies in terms of role names — was rejected.
-- It would mean the same rule stated twice in two different vocabularies
-- ("owner_admin" in SQL, "users:create" in TypeScript), which drift the first
-- time somebody changes one and not the other.
--
-- Instead there is one vocabulary and two representations, kept in step by a
-- database test (`tests/db/permissions.test.ts`) that compares these rows
-- against `rolePermissionPairs()` in lib/permissions/permissions.ts and fails
-- on any difference. Adding a grant in one place without the other breaks the
-- build.
--
-- ## Mutability
--
-- These rows are migration-managed. No application role may write them: a
-- user who could insert into this table could grant themselves anything.
-- There is no INSERT, UPDATE or DELETE policy, and the write privileges are
-- revoked.
-- ===========================================================================

create table public.permissions (
  key text primary key,
  description text not null,
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),

  -- `resource:action`. The format is constrained so a typo becomes an error
  -- at write time rather than a silently ungranted capability.
  constraint permissions_key_format check (key ~ '^[a-z][a-z0-9_]*:[a-z][a-z0-9_]*$'),
  constraint permissions_description_not_blank check (btrim(description) <> '')
);

comment on table public.permissions is
  'Capability vocabulary. Mirrors PERMISSIONS in lib/permissions/permissions.ts.';

create trigger permissions_set_updated_at
  before update on public.permissions
  for each row
  execute function public.set_updated_at();


create table public.role_permissions (
  role_key text not null references public.roles (key) on delete restrict,
  permission_key text not null references public.permissions (key) on delete restrict,
  created_at timestamptz not null default pg_catalog.now(),

  primary key (role_key, permission_key)
);

comment on table public.role_permissions is
  'Which capabilities each role grants. Migration-managed; no application role may write it.';

-- "Which roles grant this permission" — the direction user_has_permission
-- queries in.
create index role_permissions_permission_idx on public.role_permissions (permission_key);


-- ---------------------------------------------------------------------------
-- The authorization predicate used by every Phase 2 policy.
--
-- SECURITY DEFINER for the same reason as the Phase 1 session helpers: a
-- policy on `user_roles` that itself queried `user_roles` would recurse.
--
-- Note what this inherits from `public.current_profile_id()`: that function
-- resolves only profiles whose status is 'active'. A suspended, archived or
-- inactive account therefore has NO permissions at all, immediately, without
-- waiting for its JWT to expire. That property is what makes disabling a user
-- actually take effect, and it is why every Phase 2 policy is written against
-- this function rather than against `auth.uid()` directly.
-- ---------------------------------------------------------------------------
create or replace function public.user_has_permission(p_permission_key text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.user_roles ur
    join public.role_permissions rp on rp.role_key = ur.role_key
    where ur.profile_id = public.current_profile_id()
      and rp.permission_key = p_permission_key
  )
$$;

comment on function public.user_has_permission(text) is
  'True when the authenticated, ACTIVE user holds a role granting this capability. Returns false for an unknown permission key, an inactive account, or no session.';


-- Every capability the current user holds. Used by the application to build
-- its view of the session in one round trip.
create or replace function public.current_user_permissions()
returns text[]
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (
      select pg_catalog.array_agg(distinct rp.permission_key order by rp.permission_key)
      from public.user_roles ur
      join public.role_permissions rp on rp.role_key = ur.role_key
      where ur.profile_id = public.current_profile_id()
    ),
    '{}'::text[]
  )
$$;

comment on function public.current_user_permissions() is
  'Distinct capabilities held by the authenticated user. Empty array when unauthenticated or inactive.';


-- --- Seed ------------------------------------------------------------------
-- Mirrors PERMISSIONS and ROLE_PERMISSIONS in lib/permissions/permissions.ts.
-- A database test asserts these match exactly.

insert into public.permissions (key, description)
values
  ('dashboard:view',        'Reach the authenticated staff shell and its dashboard.'),
  ('account:view',          'View one''s own profile and account details.'),
  ('account:update',        'Change one''s own non-privileged details.'),
  ('portal:view',           'Reach the client portal.'),
  ('users:view',            'See the staff directory and individual user records.'),
  ('users:create',          'Create a staff account and its linked authentication identity.'),
  ('users:update',          'Change another user''s name or contact details.'),
  ('users:disable',         'Activate, suspend or archive another user''s account.'),
  ('users:assign_role',     'Grant or revoke role assignments.'),
  ('users:reset_password',  'Set another user''s password to a temporary value.'),
  ('settings:view',         'Read company and business settings.'),
  ('settings:update',       'Change company or business settings.'),
  ('audit:view',            'Read the audit trail.')
on conflict (key) do nothing;

insert into public.role_permissions (role_key, permission_key)
values
  -- A borrower reaches the portal and their own account. Nothing else.
  ('client', 'portal:view'),
  ('client', 'account:view'),
  ('client', 'account:update'),

  ('secretary_treasurer', 'dashboard:view'),
  ('secretary_treasurer', 'account:view'),
  ('secretary_treasurer', 'account:update'),
  ('secretary_treasurer', 'settings:view'),

  -- A Manager sees who works here, but holds none of the capabilities that
  -- would let them promote themselves or lock the Owner out.
  ('manager', 'dashboard:view'),
  ('manager', 'account:view'),
  ('manager', 'account:update'),
  ('manager', 'settings:view'),
  ('manager', 'users:view'),

  ('owner_admin', 'dashboard:view'),
  ('owner_admin', 'account:view'),
  ('owner_admin', 'account:update'),
  ('owner_admin', 'settings:view'),
  ('owner_admin', 'settings:update'),
  ('owner_admin', 'users:view'),
  ('owner_admin', 'users:create'),
  ('owner_admin', 'users:update'),
  ('owner_admin', 'users:disable'),
  ('owner_admin', 'users:assign_role'),
  ('owner_admin', 'users:reset_password'),
  ('owner_admin', 'audit:view')
on conflict (role_key, permission_key) do nothing;


-- --- Access control --------------------------------------------------------

alter table public.permissions enable row level security;
alter table public.role_permissions enable row level security;

revoke all on table public.permissions from anon, authenticated;
revoke all on table public.role_permissions from anon, authenticated;

-- Both tables are vocabulary: capability names and which role grants which.
-- They contain no personal or financial data, and the interface needs them to
-- explain to an administrator what a role can do. Readable by signed-in users,
-- never by anonymous visitors.
grant select on table public.permissions to authenticated;
grant select on table public.role_permissions to authenticated;

create policy permissions_select_authenticated
  on public.permissions
  for select
  to authenticated
  using (true);

create policy role_permissions_select_authenticated
  on public.role_permissions
  for select
  to authenticated
  using (true);

comment on policy permissions_select_authenticated on public.permissions is
  'Capability vocabulary, readable by any signed-in user. No personal or financial data.';
comment on policy role_permissions_select_authenticated on public.role_permissions is
  'Role-to-capability mapping, readable by any signed-in user. Writes are migration-only.';

-- No INSERT/UPDATE/DELETE policy on either table, deliberately: a user who
-- could write here could grant themselves any capability in the system.

revoke all on function public.user_has_permission(text) from public, anon, authenticated;
revoke all on function public.current_user_permissions() from public, anon, authenticated;

grant execute on function public.user_has_permission(text) to authenticated;
grant execute on function public.current_user_permissions() to authenticated;
