-- ===========================================================================
-- 20261001000500_reference_sequences
--
-- Concurrency-safe generation of human-readable references:
--   CL26001 (client), LN260001 (loan), PAY260001 (payment)
--
-- ## What was rejected, and why
--
--   * `SELECT count(*) + 1` — two transactions read the same count and both
--     produce the same number. This is the classic duplicate-invoice bug and
--     it fails under exactly the load it matters under: two cashiers at once.
--
--   * A timestamp — collides within the same millisecond, is not sequential
--     to a human, and leaks when the business is busy.
--
--   * Client-side generation (random, UUID, counter) — a client controls the
--     value, so it can be forged or replayed, and the numbers are not
--     quotable over a counter.
--
--   * A plain PostgreSQL `SEQUENCE` — `nextval` is non-transactional, so a
--     rolled-back transaction burns a number permanently and the series
--     develops visible gaps. It also cannot restart per calendar year without
--     a scheduled job.
--
-- ## What is used
--
-- An `INSERT … ON CONFLICT … DO UPDATE … RETURNING` against
-- `reference_sequences`. This is a single atomic statement: PostgreSQL takes a
-- row lock on the `(scope, period_year)` row, so concurrent callers are
-- serialised and each receives a distinct value. There is no read-then-write
-- window for two transactions to race through.
--
-- A rolled-back transaction does release its number, leaving a gap. That is
-- accepted: gaps are harmless for a reference, whereas a duplicate is not.
--
-- ## Configurability
--
-- The prefix and the zero-padding width are rows in `reference_formats`, not
-- constants, so the business can change `CL` to something else, or widen the
-- padding, without a code change. A sequence that exceeds its padding width
-- is NOT truncated — the reference simply grows a digit, because truncating
-- would reintroduce duplicates.
--
-- ## The year
--
-- The two-digit year comes from `company_settings.timezone`, not from the
-- server's clock zone. Africa/Kampala is UTC+03:00, so between 21:00 and
-- 00:00 UTC on 31 December the business is already in the new year; a
-- UTC-based year would issue `CL25…` to a client registered on 1 January.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- Per-scope format configuration
-- ---------------------------------------------------------------------------
create table public.reference_formats (
  scope text primary key,
  prefix text not null,

  -- Minimum digits in the sequence portion, left-padded with zeros.
  padding smallint not null default 4,

  description text not null,

  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),

  constraint reference_formats_scope_format check (scope ~ '^[a-z][a-z0-9_]*$'),
  constraint reference_formats_prefix_format check (prefix ~ '^[A-Z]{1,6}$'),
  constraint reference_formats_padding_range check (padding between 1 and 12),
  constraint reference_formats_description_not_blank check (btrim(description) <> '')
);

comment on table public.reference_formats is
  'Prefix and padding for each reference scope. Configurable without a code change.';

create trigger reference_formats_set_updated_at
  before update on public.reference_formats
  for each row
  execute function public.set_updated_at();


-- ---------------------------------------------------------------------------
-- Counter state, one row per scope per year
-- ---------------------------------------------------------------------------
create table public.reference_sequences (
  scope text not null references public.reference_formats (scope) on delete restrict,

  -- Two-digit year in the business timezone: 26 for 2026.
  period_year smallint not null,

  -- Highest value issued so far. 0 means none yet.
  last_value bigint not null default 0,

  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),

  primary key (scope, period_year),

  constraint reference_sequences_period_year_range check (period_year between 0 and 99),
  constraint reference_sequences_last_value_non_negative check (last_value >= 0)
);

comment on table public.reference_sequences is
  'Counter state for reference numbers, one row per (scope, year). Advanced only by public.next_reference().';
comment on column public.reference_sequences.last_value is
  'Highest sequence value issued for this scope and year. Gaps are possible when a transaction rolls back; duplicates are not.';


-- ---------------------------------------------------------------------------
-- The generator
--
-- SECURITY DEFINER so it can advance the counter without the caller needing
-- write access to `reference_sequences` — which no application role should
-- ever hold directly, since a direct UPDATE could rewind the counter and
-- cause duplicates.
-- ---------------------------------------------------------------------------
create or replace function public.next_reference(p_scope text)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_prefix     text;
  v_padding    smallint;
  v_timezone   text;
  v_year       smallint;
  v_next_value bigint;
begin
  select f.prefix, f.padding
    into v_prefix, v_padding
  from public.reference_formats f
  where f.scope = p_scope;

  if v_prefix is null then
    raise exception 'Unknown reference scope: %', p_scope
      using errcode = 'P0001';
  end if;

  -- The business timezone, from the single place it is configured.
  select c.timezone
    into v_timezone
  from public.company_settings c
  where c.id = 1;

  v_timezone := coalesce(nullif(pg_catalog.btrim(v_timezone), ''), 'Africa/Kampala');

  v_year := (pg_catalog.date_part('year', pg_catalog.timezone(v_timezone, pg_catalog.now()))::int % 100)::smallint;

  -- One atomic statement. The row lock on (scope, period_year) serialises
  -- concurrent callers, so no two can receive the same value.
  insert into public.reference_sequences as s (scope, period_year, last_value, updated_at)
  values (p_scope, v_year, 1, pg_catalog.now())
  on conflict (scope, period_year) do update
    set last_value = s.last_value + 1,
        updated_at = pg_catalog.now()
  returning s.last_value into v_next_value;

  return v_prefix
      || pg_catalog.lpad(v_year::text, 2, '0')
      || pg_catalog.lpad(v_next_value::text, v_padding::int, '0');
end;
$$;

comment on function public.next_reference(text) is
  'Atomically issues the next reference for a scope, e.g. next_reference(''client'') -> CL26001. Safe under concurrency; gaps possible on rollback, duplicates impossible.';


-- --- Access control -------------------------------------------------------

alter table public.reference_formats enable row level security;
alter table public.reference_sequences enable row level security;

revoke all on table public.reference_formats from anon, authenticated;
revoke all on table public.reference_sequences from anon, authenticated;

-- EXECUTE is revoked from every application role. Nothing in Phase 1 issues
-- a reference —
-- client, loan and payment creation are later phases — and granting it now
-- would let any signed-in user inflate the counters for no benefit.
--
-- anon and authenticated are named explicitly: Supabase grants EXECUTE to
-- them through ALTER DEFAULT PRIVILEGES, and an explicit grant is NOT removed
-- by a revoke from PUBLIC. service_role keeps EXECUTE deliberately, so a
-- privileged server-side task can issue a reference.
--
-- DEFERRED TO PHASE 2/3: grant EXECUTE to the staff roles that create clients,
-- loans and payments, once those operations exist and their own authorization
-- checks are in place.
revoke all on function public.next_reference(text) from public, anon, authenticated;
