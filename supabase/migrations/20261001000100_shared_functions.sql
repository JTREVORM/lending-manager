-- ===========================================================================
-- 20261001000100_shared_functions
--
-- Shared trigger functions and conventions used by every later migration.
--
-- Conventions established here and followed throughout:
--
--   * Every function is declared `SET search_path = ''` and every object it
--     touches is schema-qualified. Without this, a caller can prepend a schema
--     to their own search_path and have the function resolve `profiles` to a
--     table they control — a privilege-escalation route in any SECURITY
--     DEFINER function. Built-ins are therefore written as `pg_catalog.now()`
--     rather than `now()`.
--
--   * Timestamps are `timestamptz`, never `timestamp`. PostgreSQL stores a
--     `timestamptz` as an absolute instant; a bare `timestamp` means
--     "whatever zone the reader assumes", which is how a repayment ends up
--     filed against the wrong day. Calendar dates that are genuinely dates
--     use `date` and are interpreted in the business timezone.
--
--   * Money is `bigint`, holding whole Ugandan shillings. Never `float`,
--     `real`, `double precision` or `money`.
--
--   * Rates are `integer` basis points: 1 bp = 0.01%, so 15% is 1500.
--
-- No extensions are required: `gen_random_uuid()` has been in core PostgreSQL
-- since version 13, so this schema applies to a plain cluster as well as to
-- Supabase.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- Maintain `updated_at` on write.
--
-- Attached to every table that carries the column. Doing this in a trigger
-- rather than in application code means the timestamp is correct no matter
-- what issued the UPDATE — the app, a migration, or a human in psql.
-- ---------------------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.updated_at := pg_catalog.now();
  return new;
end;
$$;

comment on function public.set_updated_at() is
  'BEFORE UPDATE trigger: stamps updated_at with the current instant.';


-- ---------------------------------------------------------------------------
-- Refuse a mutation outright.
--
-- Used to make append-only tables genuinely append-only. A statement-level
-- BEFORE trigger fires even when the statement would match zero rows, so an
-- attempt fails loudly instead of succeeding vacuously.
-- ---------------------------------------------------------------------------
create or replace function public.reject_mutation()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  raise exception
    'Table %.% is append-only; % is not permitted.',
    tg_table_schema, tg_table_name, tg_op
    using errcode = 'P0001';
end;
$$;

comment on function public.reject_mutation() is
  'Statement-level trigger that raises P0001, making a table append-only.';
