-- ===========================================================================
-- Phase 9 — rate limiting
--
-- ## Why this lives in PostgreSQL
--
-- A rate limiter has to be shared. Counting in the Node process would reset
-- on every deploy and count separately on every instance, which means the
-- limit is whatever the limit is multiplied by however many containers are
-- running — a number nobody chose. Redis would be the usual answer; this
-- deployment already has exactly one strongly-consistent shared store, and
-- adding a second piece of infrastructure to a one-office lending business is
-- a cost with no matching benefit.
--
-- The counter is a fixed window. A sliding window is more precise at the
-- boundary, and the precision is not worth the extra row per request: the
-- question being answered is "is somebody hammering sign-in", not "exactly
-- how many requests arrived in the last 60 seconds".
--
-- ## Why the function is SECURITY DEFINER
--
-- The caller must not be able to read other people's counters, reset their
-- own, or discover whether a given phone number has been attempted — all of
-- which are possible if the table is readable. So the table is readable by
-- nobody, and the only way in is one function that takes a key and returns a
-- verdict. `set search_path = ''` and fully qualified names, as every
-- definer function in this schema does.
--
-- ## What is deliberately not here
--
-- No personal data. The key is a hash, computed by the application from the
-- action and the actor, so a dump of this table says that *something* was
-- rate limited and not who or what they were trying to reach.
-- ===========================================================================

create table public.rate_limit_counters (
  -- A SHA-256 hex digest of (action, subject). Opaque here by design.
  bucket_key text primary key,

  -- The action, for operations. Safe to store in the clear: it names an
  -- endpoint, not a person.
  action text not null,

  -- Start of the fixed window this row is counting.
  window_started_at timestamptz not null,
  window_seconds integer not null,

  request_count integer not null default 0,

  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),

  constraint rate_limit_counters_key_shape check (bucket_key ~ '^[0-9a-f]{64}$'),
  constraint rate_limit_counters_action_not_blank check (btrim(action) <> ''),
  constraint rate_limit_counters_window_positive check (window_seconds between 1 and 86400),
  constraint rate_limit_counters_count_positive check (request_count >= 0)
);

comment on table public.rate_limit_counters is
  'Phase 9. Fixed-window request counters. The key is a hash so the table carries no identity; rows are disposable and may be deleted at any time.';
comment on column public.rate_limit_counters.bucket_key is
  'SHA-256 of the action and the subject (profile id, or IP for an anonymous caller). Opaque: the table must not reveal who was limited.';

-- The same convention every other table follows, even though the counter
-- function sets `updated_at` itself: the trigger is what makes the column
-- true for any future write that forgets to.
create trigger rate_limit_counters_set_updated_at
  before update on public.rate_limit_counters
  for each row
  execute function public.set_updated_at();

-- Sweeping expired rows is the only query that is not by primary key.
create index rate_limit_counters_window_idx
  on public.rate_limit_counters (window_started_at);

alter table public.rate_limit_counters enable row level security;

-- No policies at all. RLS with no policy denies everything, and the only
-- intended access is through the SECURITY DEFINER function below. Supabase's
-- ALTER DEFAULT PRIVILEGES grants broadly in `public`, so this REVOKE is what
-- makes "no policies" mean something.
revoke all on table public.rate_limit_counters from anon, authenticated;


-- ---------------------------------------------------------------------------
-- Consuming one unit of a limit
-- ---------------------------------------------------------------------------

create or replace function public.consume_rate_limit(
  p_bucket_key text,
  p_action text,
  p_limit integer,
  p_window_seconds integer
)
returns table (allowed boolean, remaining integer, retry_after_seconds integer)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_window_start timestamptz;
  v_count integer;
begin
  if p_limit < 1 or p_window_seconds < 1 then
    raise exception 'A rate limit must allow at least one request in at least one second.'
      using errcode = '22023';
  end if;

  -- One statement, so two concurrent requests cannot both read zero and both
  -- write one. The ON CONFLICT branch is where an existing window is either
  -- incremented or rolled over, and it is evaluated under the row lock the
  -- conflict takes.
  insert into public.rate_limit_counters as c
    (bucket_key, action, window_started_at, window_seconds, request_count)
  values
    (p_bucket_key, p_action, v_now, p_window_seconds, 1)
  on conflict (bucket_key) do update
    set
      request_count =
        case
          when c.window_started_at + make_interval(secs => c.window_seconds) <= v_now
            then 1
          else c.request_count + 1
        end,
      window_started_at =
        case
          when c.window_started_at + make_interval(secs => c.window_seconds) <= v_now
            then v_now
          else c.window_started_at
        end,
      window_seconds = p_window_seconds,
      action = p_action,
      updated_at = v_now
  returning c.request_count, c.window_started_at into v_count, v_window_start;

  return query
  select
    v_count <= p_limit,
    greatest(p_limit - v_count, 0),
    case
      when v_count <= p_limit then 0
      else greatest(
        ceil(
          extract(
            epoch from (v_window_start + make_interval(secs => p_window_seconds) - v_now)
          )
        )::integer,
        1
      )
    end;
end;
$$;

comment on function public.consume_rate_limit(text, text, integer, integer) is
  'Phase 9. Records one request against a fixed window and reports whether it is within the limit. SECURITY DEFINER because the counter table is readable by nobody: a caller who could read it could tell whether a phone number has been attempted.';

revoke all on function public.consume_rate_limit(text, text, integer, integer)
  from public, anon;

-- `authenticated` for the signed-in paths, `anon` is excluded: the sign-in
-- limiter runs on the server through the service role, because an anonymous
-- browser must not be able to call the limiter at all — being able to consume
-- somebody else's budget is itself an attack.
grant execute on function public.consume_rate_limit(text, text, integer, integer)
  to authenticated, service_role;


-- ---------------------------------------------------------------------------
-- Sweeping
-- ---------------------------------------------------------------------------

create or replace function public.purge_expired_rate_limits()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_deleted integer;
begin
  -- A generous margin past the window: a row that is merely stale is
  -- harmless, and deleting one that is still counting would hand an attacker
  -- a fresh budget.
  delete from public.rate_limit_counters
  where window_started_at + make_interval(secs => window_seconds * 4) < pg_catalog.clock_timestamp();

  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

comment on function public.purge_expired_rate_limits() is
  'Phase 9. Deletes counters whose window closed long ago. Safe to run at any time; it never deletes a window that is still counting.';

revoke all on function public.purge_expired_rate_limits() from public, anon, authenticated;
grant execute on function public.purge_expired_rate_limits() to service_role;
