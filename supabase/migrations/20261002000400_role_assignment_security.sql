-- ===========================================================================
-- 20261002000400_role_assignment_security
--
-- The rules that stop privilege escalation and system lockout.
--
-- Holding `users:assign_role` means "may administer role assignments". It does
-- not mean "may grant any role to anyone, including oneself". Three rules
-- narrow it, and none of them can be expressed in a Row Level Security policy
-- because each needs to compare the acting user to the target:
--
--   1. Nobody edits their own role assignments. This is the self-promotion
--      guard, and it also stops an administrator quietly removing the
--      constraint that someone else granted them.
--
--   2. Nobody grants a role outranking their own. Rank is used here — one of
--      the two places it is used at all — because "may not exceed your own
--      authority" is inherently an ordering question.
--
--   3. The last active Owner/Administrator cannot be removed, by revoking
--      their role or by disabling their account. A financial system with
--      nobody able to administer it is unrecoverable without direct database
--      access.
--
-- Rule 3 is the one that breaks under concurrency if written naively: two
-- administrators each removing one of the last two Owners both observe a count
-- of two and both proceed. An advisory lock serialises the check, so the
-- second transaction sees the first one's effect. `tests/db/concurrency.test.ts`
-- drives this with genuinely parallel connections.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- The acting user's highest rank, or NULL when there is no session.
-- ---------------------------------------------------------------------------
create or replace function public.current_user_max_rank()
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select pg_catalog.max(r.rank)
  from public.user_roles ur
  join public.roles r on r.key = ur.role_key
  where ur.profile_id = public.current_profile_id()
$$;

comment on function public.current_user_max_rank() is
  'Highest role rank held by the authenticated user, or NULL. Used only for the "may not exceed your own authority" rule.';


-- ---------------------------------------------------------------------------
-- Refuse to leave the system without an Owner/Administrator.
--
-- Called AFTER the change, so the count reflects it. The advisory lock is
-- taken first and held to the end of the transaction, which serialises
-- concurrent removals: the second transaction blocks, then counts with the
-- first one's effect visible.
-- ---------------------------------------------------------------------------
create or replace function public.assert_owner_admin_remains()
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_remaining integer;
begin
  -- Arbitrary but fixed key. Every path that could remove an Owner takes this
  -- same lock, so they cannot interleave.
  perform pg_catalog.pg_advisory_xact_lock(hashtext('public.owner_admin_guard'));

  select pg_catalog.count(*)
    into v_remaining
  from public.user_roles ur
  join public.profiles p on p.id = ur.profile_id
  where ur.role_key = 'owner_admin'
    and p.status = 'active';

  if v_remaining = 0 then
    raise exception
      'This would leave the system with no active Owner/Administrator. Appoint another before removing this one.'
      using errcode = 'P0001';
  end if;
end;
$$;

comment on function public.assert_owner_admin_remains() is
  'Raises if no active owner_admin would remain. Serialised by an advisory lock so concurrent removals cannot both succeed.';


-- ---------------------------------------------------------------------------
-- Role assignment guard
-- ---------------------------------------------------------------------------
create or replace function public.user_roles_guard_assignment()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor       uuid;
  v_actor_rank  integer;
  v_target_rank integer;
  v_target_role text;
  v_target_prof uuid;
begin
  v_target_role := coalesce(new.role_key, old.role_key);
  v_target_prof := coalesce(new.profile_id, old.profile_id);

  -- Trusted server-side path: service_role, a migration, or the Owner
  -- bootstrap script. The first Owner has to be created by something that is
  -- not yet an Owner, so this path must exist; it is reachable only with the
  -- secret key, which never leaves the server.
  if auth.uid() is null then
    return coalesce(new, old);
  end if;

  v_actor := public.current_profile_id();

  if v_actor is null then
    raise exception 'No active profile for the current session.'
      using errcode = 'P0001';
  end if;

  -- Belt and braces with the RLS policy: a policy can be dropped, a trigger
  -- is harder to lose by accident.
  if not public.user_has_permission('users:assign_role') then
    raise exception 'Changing role assignments requires the users:assign_role capability.'
      using errcode = 'P0001';
  end if;

  -- Rule 1 — no self-administration of authority.
  if v_target_prof = v_actor then
    raise exception
      'You cannot change your own role assignments. Ask another administrator.'
      using errcode = 'P0001';
  end if;

  -- Rule 2 — never grant or revoke authority above your own.
  select r.rank into v_target_rank
  from public.roles r
  where r.key = v_target_role;

  if v_target_rank is null then
    raise exception 'Unknown role: %', v_target_role using errcode = 'P0001';
  end if;

  v_actor_rank := public.current_user_max_rank();

  if v_actor_rank is null or v_target_rank > v_actor_rank then
    raise exception
      'You cannot grant or revoke a role that outranks your own.'
      using errcode = 'P0001';
  end if;

  return coalesce(new, old);
end;
$$;

comment on function public.user_roles_guard_assignment() is
  'BEFORE INSERT/DELETE on user_roles: blocks self-administration of authority and grants above the actor''s own rank.';

create trigger user_roles_guard_assignment
  before insert or delete on public.user_roles
  for each row
  execute function public.user_roles_guard_assignment();


-- ---------------------------------------------------------------------------
-- `granted_by` is derived, never supplied
--
-- Without this a caller could attribute a grant to somebody else, which would
-- make the audit trail lie about who extended authority to whom.
-- ---------------------------------------------------------------------------
create or replace function public.user_roles_set_granted_by()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is not null then
    new.granted_by := public.current_profile_id();
  end if;

  return new;
end;
$$;

comment on function public.user_roles_set_granted_by() is
  'BEFORE INSERT on user_roles: overwrites granted_by with the acting profile, so attribution cannot be forged.';

-- Ordered after the guard alphabetically (`user_roles_guard_assignment` <
-- `user_roles_set_granted_by`), so authorization is decided before the row is
-- rewritten. PostgreSQL fires per-row triggers in name order.
create trigger user_roles_set_granted_by
  before insert on public.user_roles
  for each row
  execute function public.user_roles_set_granted_by();


-- ---------------------------------------------------------------------------
-- Last-owner protection, on both routes out of being an Owner
-- ---------------------------------------------------------------------------
create or replace function public.user_roles_assert_owner_remains()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.role_key = 'owner_admin' then
    perform public.assert_owner_admin_remains();
  end if;

  return null;
end;
$$;

create trigger user_roles_assert_owner_remains
  after delete on public.user_roles
  for each row
  execute function public.user_roles_assert_owner_remains();

comment on function public.user_roles_assert_owner_remains() is
  'AFTER DELETE on user_roles: refuses to revoke the last active owner_admin assignment.';


create or replace function public.profiles_assert_owner_remains()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- Only when an account stops being active, and only when it was an Owner.
  if old.status = 'active' and new.status <> 'active'
     and exists (
       select 1 from public.user_roles ur
       where ur.profile_id = new.id and ur.role_key = 'owner_admin'
     )
  then
    perform public.assert_owner_admin_remains();
  end if;

  return null;
end;
$$;

create trigger profiles_assert_owner_remains
  after update on public.profiles
  for each row
  execute function public.profiles_assert_owner_remains();

comment on function public.profiles_assert_owner_remains() is
  'AFTER UPDATE on profiles: refuses to deactivate the last active owner_admin.';


-- --- Access control --------------------------------------------------------

revoke all on function public.current_user_max_rank() from public, anon, authenticated;
revoke all on function public.assert_owner_admin_remains() from public, anon, authenticated;
revoke all on function public.user_roles_guard_assignment() from public, anon, authenticated;
revoke all on function public.user_roles_set_granted_by() from public, anon, authenticated;
revoke all on function public.user_roles_assert_owner_remains() from public, anon, authenticated;
revoke all on function public.profiles_assert_owner_remains() from public, anon, authenticated;

-- Trigger functions need no grant: PostgreSQL invokes them as the table owner.
-- `current_user_max_rank` is read by the application to decide which roles an
-- administrator may offer in a picker.
grant execute on function public.current_user_max_rank() to authenticated;
