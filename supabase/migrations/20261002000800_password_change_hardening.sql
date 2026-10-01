-- ===========================================================================
-- 20261002000800_password_change_hardening
--
-- Closes the forced-password-change bypass reported at the end of Phase 2.
--
-- ## The bypass
--
-- `public.complete_password_change()` took no arguments, cleared the flag for
-- the calling user, and was granted EXECUTE to `authenticated`. The reasoning
-- was that it could only ever act on the caller's own row, so there was
-- nothing to forge.
--
-- That missed the actual attack. The database cannot observe whether Supabase
-- Auth changed anything, so a user holding an administrator-issued temporary
-- password could call the function over PostgREST — `POST /rest/v1/rpc/
-- complete_password_change` — and clear the flag while continuing to use the
-- password their administrator also knows. The interface was never involved.
--
-- ## The fix
--
-- Remove the primitive from the client entirely, and make the column
-- unclearable by anybody who does not announce the sanctioned path.
--
--   1. `complete_password_change()` is dropped. Its replacement,
--      `confirm_password_change(uuid)`, has EXECUTE revoked from `anon` and
--      `authenticated`, so no browser session can reach it at any price. Only
--      `service_role` retains it, which means only a trusted server path can
--      call it — and the secret key never leaves the server.
--
--   2. The guard trigger's refusal to clear `must_change_password` moves ABOVE
--      the trusted-path exemption. Previously a caller with no `auth.uid()`
--      skipped every column rule, so the privileged client could have cleared
--      the flag with a plain UPDATE. Now even `service_role` must go through
--      the function, which is the only thing that sets the marker.
--
--   3. `password_set_at` becomes database-maintained. It is stamped when the
--      flag is raised and when a change is confirmed, using the database
--      clock, and is refused from every caller otherwise. An application that
--      cannot supply it cannot backdate it, and the two timestamps cannot
--      disagree because of clock skew between the application server and the
--      database.
--
-- ## What still cannot be enforced here, and why that is acceptable
--
-- The database cannot verify that Supabase Auth accepted a new password; only
-- the server that made the call knows that. What this migration guarantees is
-- that **the only way to clear the flag is through a server path holding the
-- secret key**. Ordering within that path — re-authenticate, validate, update,
-- only then confirm — is enforced in `lib/auth/password-change.ts` and
-- asserted by `tests/unit/password-change.test.ts`.
--
-- A heuristic was considered and rejected: comparing `auth.users.updated_at`
-- against `password_set_at` to prove a password update landed. It depends on a
-- GoTrue implementation detail, and the failure mode is the wrong way round —
-- a false negative would lock a user permanently on the change-password
-- screen, which is worse than the narrow residual it would close.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- Column-level authorization, with the password rules hoisted above the
-- trusted-path exemption.
-- ---------------------------------------------------------------------------
create or replace function public.profiles_guard_privileged_columns()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_confirming boolean;
begin
  v_confirming := coalesce(
    pg_catalog.current_setting('app.completing_password_change', true),
    ''
  ) = 'on';

  -- ---- Rules that bind EVERY caller, including service_role ---------------
  --
  -- Deliberately before the trusted-path exemption below. The forced password
  -- change exists because somebody other than the account holder knows the
  -- password; a path that could clear it without a password actually changing
  -- would defeat the mechanism, and "it was the privileged client" is not a
  -- reason to trust that it did.

  if old.must_change_password and not new.must_change_password
     and not v_confirming then
    raise exception
      'The password-change requirement is cleared by confirming a completed password change, not by editing the profile.'
      using errcode = 'P0001';
  end if;

  -- `password_set_at` is stamped by the database, never supplied. Both
  -- branches use the database clock, so the stamp cannot be backdated and
  -- cannot drift from the application server's clock.
  if v_confirming then
    new.password_set_at := pg_catalog.now();
  elsif new.must_change_password and not old.must_change_password then
    new.password_set_at := pg_catalog.now();
  elsif new.password_set_at is distinct from old.password_set_at then
    raise exception
      'password_set_at is maintained by the database, not by the caller.'
      using errcode = 'P0001';
  end if;

  -- ---- Trusted server-side path -------------------------------------------
  -- service_role, a migration, or the bootstrap script. These already bypass
  -- Row Level Security; what follows constrains authenticated sessions.
  if auth.uid() is null then
    return new;
  end if;

  -- The link to a login identity is never editable through the data API.
  -- Re-pointing it would let one person's profile adopt another's session.
  if new.auth_user_id is distinct from old.auth_user_id then
    raise exception
      'The authentication link on a profile cannot be changed through this path.'
      using errcode = 'P0001';
  end if;

  -- Suspending or reactivating an account is an administrative act. Without
  -- this, a suspended user with a still-valid JWT could restore themselves.
  if new.status is distinct from old.status
     and not public.user_has_permission('users:disable') then
    raise exception
      'Changing an account status requires the users:disable capability.'
      using errcode = 'P0001';
  end if;

  -- Raising the flag is a password reset, and needs the capability for one.
  if new.must_change_password and not old.must_change_password
     and not public.user_has_permission('users:reset_password') then
    raise exception
      'Requiring a password change needs the users:reset_password capability.'
      using errcode = 'P0001';
  end if;

  -- Stamped only by public.record_sign_in(), which announces itself the same
  -- way. A user must not be able to backdate or forge their own sign-in
  -- history, which an administrator reads to spot dormant accounts.
  if new.last_sign_in_at is distinct from old.last_sign_in_at
     and coalesce(
           pg_catalog.current_setting('app.recording_sign_in', true),
           ''
         ) <> 'on' then
    raise exception 'last_sign_in_at is maintained by the sign-in path.'
      using errcode = 'P0001';
  end if;

  return new;
end;
$$;

comment on function public.profiles_guard_privileged_columns() is
  'BEFORE UPDATE trigger: column-level authorization. The password rules bind every caller including service_role; the rest constrain authenticated sessions.';


-- ---------------------------------------------------------------------------
-- `password_set_at` on insert
--
-- The guard above only sees UPDATE. Without this, a caller creating a profile
-- could supply any value — including one far in the past, to make a temporary
-- password look long since replaced.
-- ---------------------------------------------------------------------------
create or replace function public.profiles_stamp_password_set_at()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  new.password_set_at := case
    when new.must_change_password then pg_catalog.now()
    else null
  end;

  return new;
end;
$$;

comment on function public.profiles_stamp_password_set_at() is
  'BEFORE INSERT trigger: password_set_at is set by the database, never accepted from the caller.';

create trigger profiles_stamp_password_set_at
  before insert on public.profiles
  for each row
  execute function public.profiles_stamp_password_set_at();


-- ---------------------------------------------------------------------------
-- Confirming a completed password change
--
-- Replaces complete_password_change(). The difference that matters is the
-- grant: this is callable only by `service_role`, so a browser session cannot
-- reach it however the request is crafted.
--
-- It takes the authentication identity rather than a profile id because that
-- is what the server has verified — the `sub` claim of the session whose
-- password it just changed. Resolving the profile here, as the owner, also
-- lets the status be checked explicitly: a suspended or archived account
-- cannot complete the flow, matching every other authorization decision.
-- ---------------------------------------------------------------------------
drop function if exists public.complete_password_change();

create or replace function public.confirm_password_change(p_auth_user_id uuid)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_profile_id uuid;
begin
  if p_auth_user_id is null then
    raise exception 'An authentication identity is required.'
      using errcode = 'P0001';
  end if;

  select p.id
    into v_profile_id
  from public.profiles p
  where p.auth_user_id = p_auth_user_id
    and p.status = 'active';

  if v_profile_id is null then
    raise exception 'No active profile for that authentication identity.'
      using errcode = 'P0001';
  end if;

  -- Transaction-local, so it cannot leak into a later statement and cannot be
  -- observed or set from another session.
  perform pg_catalog.set_config('app.completing_password_change', 'on', true);

  update public.profiles
     set must_change_password = false
   where id = v_profile_id;

  perform pg_catalog.set_config('app.completing_password_change', 'off', true);

  return v_profile_id;
end;
$$;

comment on function public.confirm_password_change(uuid) is
  'Clears must_change_password and stamps password_set_at after a password change the server has already confirmed. Callable only by service_role: no browser session can reach it.';


-- ---------------------------------------------------------------------------
-- Audit: a cleared flag is a password change, and says so
-- ---------------------------------------------------------------------------
create or replace function public.audit_profile_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_profile uuid;
  v_actor_label   text;
  v_action        text;
  v_old           jsonb;
  v_new           jsonb;
begin
  v_actor_profile := public.current_profile_id();

  if v_actor_profile is not null then
    select p.full_name into v_actor_label
    from public.profiles p
    where p.id = v_actor_profile;
  end if;

  -- A change made with no session is a trusted server-side path: the password
  -- confirmation, the bootstrap script, or a migration.
  v_actor_label := coalesce(nullif(pg_catalog.btrim(v_actor_label), ''), 'system');

  if tg_op = 'INSERT' then
    v_action := 'user.created';
    v_new := pg_catalog.jsonb_build_object(
      'full_name', new.full_name,
      'phone', new.phone,
      'email', new.email,
      'status', new.status
    );
  else
    if new.status is distinct from old.status then
      v_action := 'user.status_changed';
    elsif new.must_change_password and not old.must_change_password then
      v_action := 'user.password_reset';
    elsif old.must_change_password and not new.must_change_password then
      -- The user chose their own password, so nobody else knows it any more.
      v_action := 'user.password_changed';
    elsif new.password_set_at is distinct from old.password_set_at then
      v_action := 'user.password_changed';
    else
      v_action := 'user.updated';
    end if;

    -- Timestamps and flags only. No password, hash or token is captured here,
    -- and the columns are listed explicitly so one added later cannot start
    -- appearing in the trail by accident.
    v_old := pg_catalog.jsonb_build_object(
      'full_name', old.full_name,
      'phone', old.phone,
      'email', old.email,
      'status', old.status,
      'must_change_password', old.must_change_password,
      'password_set_at', old.password_set_at
    );
    v_new := pg_catalog.jsonb_build_object(
      'full_name', new.full_name,
      'phone', new.phone,
      'email', new.email,
      'status', new.status,
      'must_change_password', new.must_change_password,
      'password_set_at', new.password_set_at
    );

    -- Nothing auditable changed — a last_sign_in_at stamp, for instance.
    if v_old = v_new then
      return null;
    end if;
  end if;

  insert into public.audit_log (
    actor_profile_id, actor_auth_user_id, actor_label,
    action, entity_type, entity_id, old_values, new_values
  )
  values (
    v_actor_profile, auth.uid(), v_actor_label,
    v_action, 'profile', new.id::text, v_old, v_new
  );

  return null;
end;
$$;


-- --- Access control --------------------------------------------------------
--
-- The decisive line. `authenticated` is named explicitly because Supabase
-- grants EXECUTE to it through ALTER DEFAULT PRIVILEGES, and an explicit grant
-- is not removed by a revoke from PUBLIC — the mistake this project already
-- made once, in Phase 1.
--
-- `service_role` deliberately keeps its grant: it is the trusted server path.
revoke all on function public.confirm_password_change(uuid) from public, anon, authenticated;
revoke all on function public.profiles_stamp_password_set_at() from public, anon, authenticated;
