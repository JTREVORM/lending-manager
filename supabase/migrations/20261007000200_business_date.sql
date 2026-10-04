-- ===========================================================================
-- Phase 7 — the business date, in one place.
--
-- ## Why this function has to exist
--
-- Every delinquency figure is a comparison between a due date and "today",
-- and "today" is not a universal fact. At 23:30 UTC on the 9th it is already
-- the 10th in Kampala, so a loan due on the 10th would be reported overdue by
-- a system that asked UTC and current by a system that asked Kampala. One of
-- those answers is wrong, and which one is wrong depends on the hour at which
-- somebody happened to look.
--
-- Phase 1 established that the business timezone is configured in exactly one
-- place — `company_settings.timezone` — and `next_reference()` already reads
-- it to decide a reference year. Phase 7 needs the same answer far more
-- often, so it gets a name.
--
-- Nothing in Phase 7 calls `current_date`, `now()::date` or
-- `current_timestamp::date`. Those are the server's clock in the server's
-- zone, which is a fact about where the database happens to be hosted.
--
-- ## Why the timezone lookup is SECURITY DEFINER
--
-- `company_settings` is readable only with `settings:view`, which a borrower
-- does not hold. A `security_invoker` view that joined the settings row to
-- find the timezone would therefore return **no rows at all** for a borrower
-- — their own arrears would silently vanish rather than be refused, which is
-- the worst kind of authorization bug: one that looks like an empty state.
--
-- So the timezone is read through a definer function. It exposes one string
-- that is already implicit in every date the borrower is shown, and it means
-- a view's row visibility is decided by the loan policies alone, which is
-- where that decision belongs.
--
-- ## One clock, not two
--
-- Phase 7 compares dates against each other constantly: a due date against
-- today, a payment's `received_at` against a grace deadline. If "today" and
-- "the moment a payment was received" came from different clocks they could
-- disagree, and the first thing that would break is the penalty basis — a
-- payment could be recorded as arriving before a deadline that, by the other
-- clock, had already passed.
--
-- So there is exactly one source of the current instant, `business_now()`,
-- and everything else is derived from it: `business_date()` converts it to a
-- business day, and the payment functions stamp `received_at`, `reversed_at`
-- and `applied_at` from it. Overriding one overrides all of them
-- consistently, which is what makes a grace boundary testable at all.
--
-- ## The test clock, and why it cannot be reached from the application
--
-- Time-sensitive financial rules are untestable without control of the clock:
-- a loan disbursed today cannot reach its expiry date, let alone its grace
-- deadline, and back-dating `loans.disbursed_at` would mean fighting the
-- immutability guards that make a schedule evidence.
--
-- So `business_now()` honours an override in `app.business_now` — but only
-- when `session_user` is the role that owns the tables. That is a direct
-- database connection as the schema owner, which **no application path has**:
--
--   * a browser session reaches PostgreSQL as PostgREST's `authenticator`
--     role, which then switches to `authenticated`; `session_user` stays
--     `authenticator`;
--   * the privileged server client connects as `service_role`;
--   * neither can change `session_user`, and a browser cannot set a
--     configuration parameter at all.
--
-- `set local role authenticated` does not change `session_user` either, which
-- is what lets the database tests exercise a chosen date while acting as a
-- real application role.
--
-- The threat profile is therefore exactly that of the trigger-disabling the
-- test fixtures already document: somebody who can connect as the table owner
-- can do anything whatsoever to the data, and no in-database design changes
-- that. What matters is that no path the application exposes — and nothing a
-- client, a staff member or a leaked publishable key can reach — can move the
-- business date by one day.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Is this session a direct connection as the owner of the tables?
--
-- `session_user` is a SQL construct rather than a catalogue function, so it is
-- deliberately unqualified even under `search_path = ''` — the same reason
-- `coalesce`, `least` and `nullif` are written bare throughout this schema. A
-- `pg_catalog.session_user` does not exist and fails at parse time.
--
-- The owner is discovered from the catalogue rather than hard-coded, because
-- the role name differs between a Supabase project (`postgres`) and the local
-- throwaway cluster the tests use (`lending`), and a name baked into a
-- migration would be wrong in one of them.
-- ---------------------------------------------------------------------------

create or replace function public.is_table_owner_session()
returns boolean
language sql
stable
set search_path = ''
as $$
  select exists (
    select 1
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname = 'loans'
      and pg_catalog.pg_get_userbyid(c.relowner) = session_user
  );
$$;

comment on function public.is_table_owner_session() is
  'True only on a direct connection as the role owning the public tables. No application path qualifies: PostgREST connects as authenticator and the privileged client as service_role.';

revoke all on function public.is_table_owner_session() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- The configured business timezone
-- ---------------------------------------------------------------------------

create or replace function public.business_timezone()
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_timezone text;
begin
  select cs.timezone into v_timezone
  from public.company_settings cs
  where cs.id = 1;

  -- The fallback matters: a delinquency figure must not become NULL — and so
  -- silently disappear from a comparison — because a settings row is missing.
  -- It is the same default the column itself carries.
  return coalesce(nullif(pg_catalog.btrim(v_timezone), ''), 'Africa/Kampala');
end;
$$;

comment on function public.business_timezone() is
  'The configured IANA business timezone. SECURITY DEFINER so a derived view does not inherit the settings:view requirement and lose a borrower''s own rows.';

revoke all on function public.business_timezone() from public, anon, authenticated;
grant execute on function public.business_timezone() to authenticated;

-- ---------------------------------------------------------------------------
-- Now
--
-- `pg_catalog.now()` is the transaction's start time, which is the right
-- semantics for a financial record: every row written by one transaction
-- carries the same instant, so a payment and its allocations cannot appear to
-- have happened at different moments.
-- ---------------------------------------------------------------------------

-- ## Two details that are not stylistic
--
-- **The gate is a nested IF, not `and`.** PostgreSQL does not promise to
-- evaluate the operands of `AND` left to right, or to skip the second when the
-- first is false — it may reorder them freely. Written as
--
--     if v_override is not null and public.is_table_owner_session() then
--
-- the privilege-gated helper could be called on **every** invocation, which
-- for a session role means `permission denied` on a function that every
-- delinquency read depends on. That is not a hypothetical: it is how this was
-- found, by a borrower being unable to read their own arrears.
--
-- **And the function is SECURITY DEFINER**, so that even if the parameter
-- somehow were set on a session connection, the gate is callable and returns
-- the honest answer rather than erroring. `session_user` is unaffected by
-- SECURITY DEFINER — only `current_user` changes — so the gate still reports
-- the *connection's* identity, which is exactly what it is for.
create or replace function public.business_now()
returns timestamptz
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_override text;
begin
  v_override := nullif(
    pg_catalog.btrim(coalesce(pg_catalog.current_setting('app.business_now', true), '')),
    ''
  );

  if v_override is not null then
    if public.is_table_owner_session() then
      return v_override::timestamptz;
    end if;
  end if;

  return pg_catalog.now();
end;
$$;

comment on function public.business_now() is
  'The current instant for every financial record and every delinquency comparison. Transaction start time, as pg_catalog.now() gives it. Honours app.business_now only on a direct owner connection, which no application path has.';

revoke all on function public.business_now() from public, anon, authenticated;
grant execute on function public.business_now() to authenticated;

-- ---------------------------------------------------------------------------
-- Today, as the business reckons it
-- ---------------------------------------------------------------------------

create or replace function public.business_date()
returns date
language sql
stable
set search_path = ''
as $$
  select (pg_catalog.timezone(public.business_timezone(), public.business_now()))::date;
$$;

comment on function public.business_date() is
  'Today''s date in the configured business timezone. The single source of "today" for every delinquency calculation, derived from business_now() so the two can never disagree.';

revoke all on function public.business_date() from public, anon, authenticated;
grant execute on function public.business_date() to authenticated;

-- ---------------------------------------------------------------------------
-- A payment's business date
--
-- `loan_payments.received_at` is authoritative and stored as `timestamptz`.
-- Deciding whether a payment landed before a grace deadline is a comparison
-- of *dates*, so the instant has to be reduced to the business day it fell
-- on — in the business timezone, never in UTC.
-- ---------------------------------------------------------------------------

create or replace function public.payment_business_date(p_received_at timestamptz)
returns date
language sql
stable
set search_path = ''
as $$
  select case
    when p_received_at is null then null
    else (pg_catalog.timezone(public.business_timezone(), p_received_at))::date
  end;
$$;

comment on function public.payment_business_date(timestamptz) is
  'The business day a payment instant fell on. Used to decide which payments count toward a penalty basis.';

revoke all on function public.payment_business_date(timestamptz) from public, anon, authenticated;
grant execute on function public.payment_business_date(timestamptz) to authenticated;
