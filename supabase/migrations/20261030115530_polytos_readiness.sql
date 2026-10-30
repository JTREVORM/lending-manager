-- No-data readiness endpoint. The REST root is not available to public keys
-- on hosted Supabase. This RPC proves PostgreSQL execution without reading
-- financial, membership, identity or policy records.
create or replace function public.polytos_readiness()
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
  select true;
$$;

-- Do not inherit PostgreSQL's default EXECUTE grant to every role.
revoke all on function public.polytos_readiness() from public;
grant execute on function public.polytos_readiness() to anon, authenticated;

comment on function public.polytos_readiness() is
  'No-data readiness probe: constant true, caller privileges, no table access.';
