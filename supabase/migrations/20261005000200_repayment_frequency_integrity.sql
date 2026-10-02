-- ===========================================================================
-- Phase 5 — a repayment frequency's interval is its identity.
--
-- ## The hole this closes
--
-- Phase 4 freezes `loans.repayment_frequency` — the borrower's agreed cadence
-- cannot be changed after the loan leaves draft. But that column stores a
-- *key*, `'daily'`, and the days that key means live in
-- `repayment_frequencies.interval_days`, which was freely editable.
--
-- So the agreement was only half frozen. An administrator editing `daily` from
-- 1 to 2 would not be adjusting a setting; they would be silently redefining
-- every loan that ever named it. A borrower who agreed to pay daily would find
-- their schedule generated every two days, and nothing in the loan record
-- would show that anything had changed.
--
-- Two ways to deal with that:
--
--   1. **Snapshot the interval** when a schedule is generated, and let the
--      table keep changing underneath.
--   2. **Refuse the change**, because the interval is not a property of the
--      cadence — it *is* the cadence.
--
-- Both are done here, and they protect different things.
--
-- This migration does (2). "Daily" means one day; a row claiming to be daily
-- while meaning two is not an edited setting, it is a false record. The
-- business retires a cadence it no longer offers by setting
-- `is_active = false` — which Phase 1 already provided and documented for
-- exactly this reason — and adds a new row if it wants a new rhythm.
--
-- Migration `20261005000300` does (1), snapshotting key, label and interval
-- onto the schedule. That is what makes an *already generated* schedule
-- provably independent of this table, and keeps it readable after a cadence is
-- retired.
--
-- ## What remains editable
--
-- `label`, `is_active` and `sort_order`. Renaming "Every 2 days" to "Every
-- second day" changes a presentation string; deactivating hides a cadence from
-- new loans while existing ones keep working. Neither alters what any existing
-- agreement means, which is the line being drawn.
-- ===========================================================================

create or replace function public.repayment_frequencies_guard_identity()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    -- Phase 1 already documented that frequencies are retired, never deleted,
    -- so that historical loans keep a valid reference. The foreign keys from
    -- `loans` and `business_settings` are `on delete restrict`, which stops a
    -- referenced row going; this stops an unreferenced one going too, so the
    -- vocabulary a loan's key is read against is append-only.
    raise exception
      'A repayment frequency is retired by setting is_active = false, never deleted, so historical loans keep a valid reference.'
      using errcode = 'P0001';
  end if;

  if new.key is distinct from old.key then
    raise exception 'A repayment frequency key cannot be changed; loans reference it.'
      using errcode = 'P0001';
  end if;

  if new.interval_days is distinct from old.interval_days then
    raise exception
      'The collection interval of "%" cannot be changed from % to % days. It is what the cadence means, and loans already agreed to it. Retire this frequency with is_active = false and add a new one instead.',
      old.key, old.interval_days, new.interval_days
      using errcode = 'P0001';
  end if;

  return new;
end;
$$;

comment on function public.repayment_frequencies_guard_identity() is
  'BEFORE UPDATE/DELETE on repayment_frequencies: key and interval_days are immutable, because they are what an agreed cadence means. Label, is_active and sort_order stay editable.';

-- Row-level for UPDATE, so `old` and `new` can be compared column by column.
create trigger repayment_frequencies_guard_identity
  before update on public.repayment_frequencies
  for each row execute function public.repayment_frequencies_guard_identity();

-- Statement-level for DELETE, following the Phase 1 pattern: a statement-level
-- trigger fires even when the WHERE clause matches nothing, so the refusal
-- does not depend on an attacker's predicate finding a row.
create trigger repayment_frequencies_no_delete
  before delete on public.repayment_frequencies
  for each statement execute function public.repayment_frequencies_guard_identity();

revoke all on function public.repayment_frequencies_guard_identity()
  from public, anon, authenticated;
