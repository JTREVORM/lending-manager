-- ===========================================================================
-- 20261002000200_account_security
--
-- Account-state columns and the trigger that protects them.
--
-- ## The problem this solves
--
-- Row Level Security decides which ROWS a caller may touch. It cannot, on its
-- own, decide which COLUMNS of a permitted row they may change. A policy that
-- lets a user update their own profile — which they need, to correct their
-- name — would equally let them set their own status back to 'active' after
-- being suspended, or point `auth_user_id` at somebody else's login.
--
-- A BEFORE UPDATE trigger can compare OLD to NEW, so that is where
-- column-level authorization lives.
--
-- ## Why "no session" means "allowed"
--
-- The trigger permits anything when `auth.uid()` is null. That is not a hole:
-- a statement with no JWT is running as the table owner, as `service_role`,
-- or inside a migration — all trusted server-side paths that already bypass
-- RLS entirely. The trigger exists to constrain *authenticated users*, who
-- always carry a JWT.
-- ===========================================================================

alter table public.profiles
  -- Set when an administrator issues a temporary password, cleared when the
  -- user actually changes it. While true, route protection sends the user to
  -- the change-password screen and nowhere else.
  add column must_change_password boolean not null default false,

  -- When an administrator last set this account's password. Informational:
  -- it is shown on the user detail screen so an administrator can see whether
  -- a temporary password has been sitting unused.
  add column password_set_at timestamptz,

  -- When the account last signed in successfully. Lets an administrator spot
  -- dormant staff accounts, which are the ones worth disabling.
  add column last_sign_in_at timestamptz;

comment on column public.profiles.must_change_password is
  'True while the account still holds an administrator-issued temporary password. Enforced by route protection.';
comment on column public.profiles.password_set_at is
  'When an administrator last set this account''s password. Never the password itself.';
comment on column public.profiles.last_sign_in_at is
  'Last successful sign-in. Used to identify dormant accounts.';


-- ---------------------------------------------------------------------------
-- Column-level authorization for public.profiles
-- ---------------------------------------------------------------------------
create or replace function public.profiles_guard_privileged_columns()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- Trusted server-side path: service_role, a migration, or a bootstrap
  -- script. These already bypass RLS; the trigger constrains sessions.
  if auth.uid() is null then
    return new;
  end if;

  -- The link to a login identity is never editable through the data API.
  -- Re-pointing it would let one person's profile adopt another's session.
  -- It is set once, at account creation, by a privileged server path.
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

  -- `must_change_password` is set by an administrator issuing a temporary
  -- password, and cleared ONLY by public.complete_password_change(), which
  -- announces itself with a transaction-local setting. A user must not be
  -- able to clear the flag with a direct UPDATE and thereby keep a password
  -- their administrator also knows.
  if new.must_change_password is distinct from old.must_change_password then
    if new.must_change_password then
      if not public.user_has_permission('users:reset_password') then
        raise exception
          'Requiring a password change needs the users:reset_password capability.'
          using errcode = 'P0001';
      end if;
    elsif coalesce(
            pg_catalog.current_setting('app.completing_password_change', true),
            ''
          ) <> 'on' then
      raise exception
        'The password-change requirement is cleared by changing the password, not by editing the profile.'
        using errcode = 'P0001';
    end if;
  end if;

  -- Both are stamped by privileged paths only.
  if new.password_set_at is distinct from old.password_set_at
     and not public.user_has_permission('users:reset_password') then
    raise exception 'password_set_at is maintained by the password reset path.'
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
  'BEFORE UPDATE trigger: column-level authorization for profiles. RLS decides which rows a caller may touch; this decides which columns.';

create trigger profiles_guard_privileged_columns
  before update on public.profiles
  for each row
  execute function public.profiles_guard_privileged_columns();


-- ---------------------------------------------------------------------------
-- Clearing the forced-password-change flag
--
-- Called by the change-password Server Action, and only after Supabase Auth
-- has confirmed the password was actually updated. It clears the flag for the
-- CALLING user alone — a profile id cannot be passed in, so one user cannot
-- clear another's.
--
-- The transaction-local setting is how the guard trigger above distinguishes
-- this sanctioned path from a direct UPDATE. `set_config(..., true)` scopes it
-- to the current transaction, so it cannot leak into a later statement.
-- ---------------------------------------------------------------------------
create or replace function public.complete_password_change()
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_profile_id uuid;
begin
  v_profile_id := public.current_profile_id();

  if v_profile_id is null then
    raise exception 'No active profile for the current session.'
      using errcode = 'P0001';
  end if;

  perform pg_catalog.set_config('app.completing_password_change', 'on', true);

  update public.profiles
     set must_change_password = false
   where id = v_profile_id;

  perform pg_catalog.set_config('app.completing_password_change', 'off', true);
end;
$$;

comment on function public.complete_password_change() is
  'Clears must_change_password for the calling user only. Called after Supabase Auth confirms a password update.';


-- ---------------------------------------------------------------------------
-- Recording a successful sign-in
--
-- Separate from the guard trigger's blanket refusal of last_sign_in_at: this
-- is the one sanctioned writer, and it only ever stamps the calling user's own
-- row.
-- ---------------------------------------------------------------------------
create or replace function public.record_sign_in()
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_profile_id uuid;
begin
  v_profile_id := public.current_profile_id();

  if v_profile_id is null then
    return;
  end if;

  -- Bypasses the guard trigger deliberately: SECURITY DEFINER runs as the
  -- owner, and the trigger's refusal targets ordinary session UPDATEs.
  perform pg_catalog.set_config('app.recording_sign_in', 'on', true);

  update public.profiles
     set last_sign_in_at = pg_catalog.now()
   where id = v_profile_id;

  perform pg_catalog.set_config('app.recording_sign_in', 'off', true);
end;
$$;

comment on function public.record_sign_in() is
  'Stamps last_sign_in_at for the calling user. The only sanctioned writer of that column from a session.';


-- --- Access control --------------------------------------------------------

revoke all on function public.profiles_guard_privileged_columns() from public, anon, authenticated;
revoke all on function public.complete_password_change() from public, anon, authenticated;
revoke all on function public.record_sign_in() from public, anon, authenticated;

-- Both act only on the calling user's own row and take no arguments, so there
-- is nothing for a caller to forge.
grant execute on function public.complete_password_change() to authenticated;
grant execute on function public.record_sign_in() to authenticated;
