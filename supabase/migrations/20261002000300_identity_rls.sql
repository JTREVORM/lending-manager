-- ===========================================================================
-- 20261002000300_identity_rls
--
-- Row Level Security for the identity tables.
--
-- Phase 1 left `profiles` and `user_roles` default-deny, because deciding who
-- may read whom belongs with the authentication that reads them. This is that
-- decision.
--
-- ## The rule every policy follows
--
-- Every policy is written against `public.user_has_permission(...)` or
-- `public.current_profile_id()`, and never against `auth.uid()` directly.
--
-- That is not a style preference. `current_profile_id()` resolves only
-- profiles whose status is `'active'`, so routing every policy through it
-- means a suspended or archived account loses database access the instant its
-- status changes — not when its JWT eventually expires. A policy written as
-- `auth.uid() = something` would keep working for a disabled user holding a
-- valid token, which is precisely the failure this phase has to prevent.
--
-- `tests/db/rls-identity.test.ts` asserts the disabled-user case directly.
--
-- ## Column-level rules
--
-- These policies decide which ROWS are reachable. Which COLUMNS a caller may
-- change is enforced by `profiles_guard_privileged_columns()` in migration
-- 20261002000200. Both are needed: a policy alone would let a user who can
-- edit their own name also edit their own status.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- profiles
-- ---------------------------------------------------------------------------

grant select, insert, update on table public.profiles to authenticated;

-- A user always sees their own record. Staff holding `users:view` see the
-- directory. Note there is no "clients see other clients" path, and no
-- "Secretary/Treasurer sees staff" path — the Secretary/Treasurer does not
-- hold `users:view`, so they see only themselves.
create policy profiles_select_self_or_directory
  on public.profiles
  for select
  to authenticated
  using (
    id = public.current_profile_id()
    or public.user_has_permission('users:view')
  );

comment on policy profiles_select_self_or_directory on public.profiles is
  'A user reads their own profile. Holders of users:view read the directory. A client sees only themselves.';

-- Creating a profile is an administrative act. The row inserted must not
-- arrive already privileged, so status is pinned to a non-escalating value and
-- the authentication link is left for the privileged server path to set.
create policy profiles_insert_with_permission
  on public.profiles
  for insert
  to authenticated
  with check (
    public.user_has_permission('users:create')
    and status in ('active', 'inactive')
    and must_change_password is true
    and auth_user_id is null
  );

comment on policy profiles_insert_with_permission on public.profiles is
  'Only users:create may add a profile, and the new row may not arrive suspended-proof or pre-linked to a login.';

-- Who may attempt an update. Which columns actually change is then decided by
-- profiles_guard_privileged_columns().
create policy profiles_update_self_or_administer
  on public.profiles
  for update
  to authenticated
  using (
    (id = public.current_profile_id() and public.user_has_permission('account:update'))
    or public.user_has_permission('users:update')
    or public.user_has_permission('users:disable')
    or public.user_has_permission('users:reset_password')
  )
  with check (
    (id = public.current_profile_id() and public.user_has_permission('account:update'))
    or public.user_has_permission('users:update')
    or public.user_has_permission('users:disable')
    or public.user_has_permission('users:reset_password')
  );

comment on policy profiles_update_self_or_administer on public.profiles is
  'Self-service edits plus administrative edits. Column-level authorization is enforced by the guard trigger, not here.';

-- No DELETE policy, and no DELETE grant. Profiles are archived, never
-- deleted (ADR-006). The absence is deliberate.


-- ---------------------------------------------------------------------------
-- user_roles
--
-- The most security-sensitive table in the system: a row here is a grant of
-- authority. Reads are narrow, and writes are additionally constrained by
-- `user_roles_guard_assignment()` in migration 20261002000400, which is what
-- actually prevents privilege escalation.
-- ---------------------------------------------------------------------------

grant select, insert, delete on table public.user_roles to authenticated;

create policy user_roles_select_self_or_directory
  on public.user_roles
  for select
  to authenticated
  using (
    profile_id = public.current_profile_id()
    or public.user_has_permission('users:view')
  );

comment on policy user_roles_select_self_or_directory on public.user_roles is
  'A user reads their own assignments. Holders of users:view read everyone''s.';

-- The policy establishes the capability; the guard trigger enforces the rules
-- the capability alone cannot express — that an administrator may not promote
-- themselves, and may not grant a role outranking their own.
create policy user_roles_insert_with_permission
  on public.user_roles
  for insert
  to authenticated
  with check (public.user_has_permission('users:assign_role'));

create policy user_roles_delete_with_permission
  on public.user_roles
  for delete
  to authenticated
  using (public.user_has_permission('users:assign_role'));

comment on policy user_roles_insert_with_permission on public.user_roles is
  'Granting a role needs users:assign_role. Escalation rules are enforced by the guard trigger.';
comment on policy user_roles_delete_with_permission on public.user_roles is
  'Revoking a role needs users:assign_role. Last-owner protection is enforced by the guard trigger.';

-- No UPDATE policy: a row is (profile_id, role_key, granted_by, granted_at)
-- and the first two are the primary key. Changing a grant means revoking one
-- and issuing another, which leaves both acts in the audit trail.
