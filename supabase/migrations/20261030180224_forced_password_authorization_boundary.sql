-- Forced-password accounts have recovery identity, not business authority.
-- Applying this migration is NOT sufficient on its own: enable the reviewed
-- PostgREST db-pre-request hook (chain any existing hook) before certification.
-- No account, financial record, role assignment or policy version is changed.

create or replace function public.current_profile_id()
returns uuid
language sql stable security definer set search_path = ''
as $$
  select p.id from public.profiles p
  where p.auth_user_id = (select auth.uid())
    and p.status = 'active' and not p.must_change_password
$$;

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
      -- Recovery identity is deliberately separate from business identity.
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
    on p.auth_user_id = (select auth.uid()) and p.status = 'active'
  left join lateral (
    select pg_catalog.array_agg(ur.role_key order by ur.role_key) as keys
    from public.user_roles ur where ur.profile_id = p.id
  ) r on true
$$;

comment on function public.current_session_context() is
  'Recovery bootstrap: only the verified caller active profile and assigned roles. This is NOT business authorization; forced-password accounts have no current_profile_id or capabilities.';

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
  select p.id into v_profile_id from public.profiles p
   where p.auth_user_id = (select auth.uid()) and p.status = 'active';

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

create or replace function public.record_security_event(
  p_action   text,
  p_metadata jsonb default null
)
returns bigint
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_profile_id  uuid;
  v_actor_label text;
  v_id          bigint;
begin
  if p_action not in (
    'auth.signed_in',
    'auth.signed_out',
    'auth.password_changed',
    'auth.sign_in_denied'
  ) then
    raise exception 'Unsupported security event: %', p_action
      using errcode = 'P0001';
  end if;

  select p.id into v_profile_id from public.profiles p
   where p.auth_user_id = (select auth.uid()) and p.status = 'active';

  if v_profile_id is not null then
    select p.full_name into v_actor_label
    from public.profiles p
    where p.id = v_profile_id;
  end if;

  insert into public.audit_log (
    actor_profile_id, actor_auth_user_id, actor_label,
    action, entity_type, entity_id, metadata
  )
  values (
    v_profile_id,
    auth.uid(),
    coalesce(nullif(pg_catalog.btrim(v_actor_label), ''), 'unknown'),
    p_action,
    'auth_session',
    v_profile_id::text,
    p_metadata
  )
  returning id into v_id;

  return v_id;
end;
$$;


-- Covers SECURITY DEFINER business RPCs as well as ordinary table requests.
-- Request path/method are PostgREST transaction settings, not client headers.
create or replace function public.enforce_password_change()
returns void
language plpgsql stable security invoker set search_path = ''
as $$
declare
  v_path text := pg_catalog.current_setting('request.path', true);
  v_method text := pg_catalog.current_setting('request.method', true);
  v_context record;
begin
  if (select auth.uid()) is null then return; end if;

  if (v_method in ('GET', 'POST') and v_path in (
        '/rpc/current_session_context', '/rpc/polytos_readiness'
      )) or (v_method = 'POST' and v_path in (
        '/rpc/record_sign_in', '/rpc/record_security_event', '/rpc/consume_rate_limit'
      )) or (v_method = 'GET' and v_path = '/company_identity') then
    return;
  end if;

  select * into v_context from public.current_session_context();
  if v_context.outcome <> 'ok' or v_context.must_change_password then
    raise exception 'Business access requires an active account with a completed password change.'
      using errcode = '42501';
  end if;
end;
$$;

revoke all on function public.enforce_password_change() from public, anon, authenticated, service_role;
grant execute on function public.enforce_password_change() to anon, authenticated, service_role;
comment on function public.enforce_password_change() is
  'PostgREST db-pre-request gate. Recovery-only allowlist; denies business routes for forced-password, inactive, suspended, unlinked and roleless sessions.';

comment on column public.profiles.must_change_password is
  'While true: recovery bootstrap only, no business identity/capabilities. Enforced by RLS helpers, server actions and the configured Data API pre-request hook.';

