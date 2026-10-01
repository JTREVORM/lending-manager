-- ===========================================================================
-- 20261002000600_identity_audit_triggers
--
-- Automatic audit of identity changes.
--
-- ## Why triggers rather than application calls
--
-- The obvious design is for each Server Action to write its own audit record
-- after doing its work. It has two failures that matter in a financial system:
-- an action can change data and then fail before auditing it, and an action
-- can simply forget. Either way the trail disagrees with the data, and a trail
-- that might be incomplete cannot be used to answer "who did this".
--
-- A trigger records what actually happened to the row, in the same
-- transaction. If the change rolls back, so does its audit record; if the
-- change commits, the record committed with it. There is no path that writes
-- the data and misses the trail, and no path that writes a trail entry for a
-- change that did not happen.
--
-- It also means an administrator who bypasses the interface entirely — direct
-- REST calls, psql — is audited exactly the same.
--
-- ## What is deliberately not recorded
--
-- No passwords, tokens or secrets. `profiles` holds none, and the columns
-- captured below are listed explicitly rather than taking the whole row, so a
-- column added later cannot silently start appearing in the trail.
-- ===========================================================================

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

  -- A change made with no session is a trusted server-side path: the Owner
  -- bootstrap script, a migration, or a privileged maintenance task.
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
    -- Status changes are the security-relevant ones, so they get their own
    -- action name and are easy to filter for.
    if new.status is distinct from old.status then
      v_action := 'user.status_changed';
    elsif new.must_change_password is distinct from old.must_change_password
          and new.must_change_password then
      v_action := 'user.password_reset';
    else
      v_action := 'user.updated';
    end if;

    v_old := pg_catalog.jsonb_build_object(
      'full_name', old.full_name,
      'phone', old.phone,
      'email', old.email,
      'status', old.status,
      'must_change_password', old.must_change_password
    );
    v_new := pg_catalog.jsonb_build_object(
      'full_name', new.full_name,
      'phone', new.phone,
      'email', new.email,
      'status', new.status,
      'must_change_password', new.must_change_password
    );

    -- Nothing auditable changed (a last_sign_in_at stamp, for instance).
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

comment on function public.audit_profile_change() is
  'AFTER INSERT/UPDATE on profiles: records the change in the same transaction, so data and trail cannot disagree.';

create trigger audit_profile_change
  after insert or update on public.profiles
  for each row
  execute function public.audit_profile_change();


create or replace function public.audit_user_role_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_profile uuid;
  v_actor_label   text;
  v_row           record;
begin
  v_row := coalesce(new, old);

  v_actor_profile := public.current_profile_id();

  if v_actor_profile is not null then
    select p.full_name into v_actor_label
    from public.profiles p
    where p.id = v_actor_profile;
  end if;

  v_actor_label := coalesce(nullif(pg_catalog.btrim(v_actor_label), ''), 'system');

  insert into public.audit_log (
    actor_profile_id, actor_auth_user_id, actor_label,
    action, entity_type, entity_id, old_values, new_values
  )
  values (
    v_actor_profile,
    auth.uid(),
    v_actor_label,
    case when tg_op = 'INSERT' then 'user.role_granted' else 'user.role_revoked' end,
    'user_role',
    v_row.profile_id::text,
    case when tg_op = 'DELETE'
      then pg_catalog.jsonb_build_object('role_key', old.role_key)
      else null end,
    case when tg_op = 'INSERT'
      then pg_catalog.jsonb_build_object('role_key', new.role_key)
      else null end
  );

  return null;
end;
$$;

comment on function public.audit_user_role_change() is
  'AFTER INSERT/DELETE on user_roles: every grant and revocation of authority is recorded.';

create trigger audit_user_role_change
  after insert or delete on public.user_roles
  for each row
  execute function public.audit_user_role_change();


create or replace function public.audit_settings_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_profile uuid;
  v_actor_label   text;
begin
  v_actor_profile := public.current_profile_id();

  if v_actor_profile is not null then
    select p.full_name into v_actor_label
    from public.profiles p
    where p.id = v_actor_profile;
  end if;

  v_actor_label := coalesce(nullif(pg_catalog.btrim(v_actor_label), ''), 'system');

  insert into public.audit_log (
    actor_profile_id, actor_auth_user_id, actor_label,
    action, entity_type, entity_id, old_values, new_values
  )
  values (
    v_actor_profile, auth.uid(), v_actor_label,
    'settings.updated', tg_table_name, old.id::text,
    pg_catalog.to_jsonb(old), pg_catalog.to_jsonb(new)
  );

  return null;
end;
$$;

comment on function public.audit_settings_change() is
  'AFTER UPDATE on the settings singletons. Changing a rate is a financial decision and is recorded as one.';

create trigger audit_company_settings_change
  after update on public.company_settings
  for each row
  execute function public.audit_settings_change();

create trigger audit_business_settings_change
  after update on public.business_settings
  for each row
  execute function public.audit_settings_change();


revoke all on function public.audit_profile_change() from public, anon, authenticated;
revoke all on function public.audit_user_role_change() from public, anon, authenticated;
revoke all on function public.audit_settings_change() from public, anon, authenticated;
