-- ===========================================================================
-- Polytos Phase 3.2 — a cadence has a kind, and a calendar month is not 30 days
--
-- This migration is the one `docs/POLYTOS-EXPANSION-ARCHITECTURE.md` §7 was
-- written to warn about, and it does only the structural half: the column, the
-- constraints, the immutability guard and the two new rows. The generator
-- learns to read them in 20261021000300, so that a change to the schema and a
-- change to a function that builds collection dates can be reviewed — and
-- reverted — separately.
--
-- ## The problem, restated in one paragraph
--
-- `repayment_frequencies.interval_days` is a fixed number of days, and
-- `generate_loan_schedule()` builds collections as `D + k × interval_days`.
-- That expresses weekly collection exactly — seven days is a week, always.
-- It cannot express calendar-monthly collection at all: a month is 28, 29, 30
-- or 31 days, so an `interval_days = 30` cadence on a loan disbursed on
-- 31 January would collect on 2 March, 1 April, 1 May — dates nobody agreed
-- to, drifting a little further every month. The membership documents require
-- monthly collection for member loans longer than two months, so the engine
-- needs a second *kind* of cadence rather than a larger number of days.
--
-- ## What this adds
--
--   `cadence_kind`   'fixed_days' or 'calendar_month'. Part of what the
--                    cadence *means*, so immutable for the same reason
--                    `interval_days` is.
--   `month_anchor`   Only for a calendar cadence: what a monthly collection
--                    does when the original collection day does not exist in
--                    a later month. **NULL, because nobody has decided.**
--
-- `interval_days` becomes nullable, and is required for exactly one kind.
-- `NULL between 1 and 365` evaluates to NULL and a CHECK passes on NULL, so
-- the existing range constraint already tolerates the absence; the new
-- constraint is what makes it *required* where it is meaningful and *refused*
-- where it is not.
--
-- ## The anchor is undecided, and that is recorded rather than guessed
--
-- A loan disbursed on 31 January, collecting monthly, has a second collection
-- in a month with no 31st. Two conventions are plausible and the business has
-- not picked one:
--
--   `clamp_to_month_end`         28 February (29 in a leap year), then
--                                31 March, 30 April, 31 May. This is what
--                                PostgreSQL's `date + interval '1 month'`
--                                already does, and because every boundary is
--                                anchored on the disbursement date rather
--                                than stepped from the previous one, a
--                                February clamp does not drag the rest of the
--                                loan earlier.
--
--   `roll_forward_to_next_month` 1 March, then 31 March, 1 May, 31 May. The
--                                collection never falls earlier in the month
--                                than the day agreed; it falls just after.
--
-- Both are implemented in 20261021000300 and **neither is a default**. A
-- `calendar_month` cadence whose anchor is NULL generates no schedule and
-- blocks approval with a named reason, which is the same shape Phase 2 used
-- for the undecided savings rules: fail shut, and say which decision is
-- missing.
--
-- ### Why the anchor lives here and not on `membership_policy_versions`
--
-- Because it is what the cadence means, in the way `interval_days` is what
-- "daily" means. The nine policy questions in
-- `docs/POLYTOS-MEMBERSHIP-POLICY-DECISIONS.md` are each a *membership
-- programme* rule, and the five readiness gates are generated from exactly
-- those nine — a unit test asserts the union is the nine with nothing left
-- over on either side. Adding a tenth column there would restate a Phase 1
-- decision inventory after the fact, and would also be wrong on the merits:
-- monthly collection is a scheduling convention that would apply identically
-- to a non-member product the business chose to collect monthly. The
-- discrepancy is recorded in ADR-059 rather than papered over.
--
-- ## What cannot change
--
-- `daily`, `every_2_days` and `every_3_days` keep their keys, their intervals
-- and — through the column default — their kind. Nothing about an existing
-- schedule, an existing loan or an existing collection date is touched by this
-- migration. `scripts/verify-membership-upgrade.mjs` compares every
-- collection date on a seeded book across it.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- The kind, and the anchor
-- ---------------------------------------------------------------------------

alter table public.repayment_frequencies
  add column cadence_kind text not null default 'fixed_days',
  add column month_anchor text;

alter table public.repayment_frequencies
  alter column interval_days drop not null;

comment on column public.repayment_frequencies.cadence_kind is
  'fixed_days: collections fall every interval_days. calendar_month: collections fall on the same calendar day of each month, resolved by month_anchor. Immutable, because it is part of what an agreed cadence means.';
comment on column public.repayment_frequencies.month_anchor is
  'Calendar cadences only. What a monthly collection does when the agreed day of the month does not exist in a later month. NULL means the business has not decided, and a schedule cannot be generated.';
comment on column public.repayment_frequencies.interval_days is
  'Days between consecutive collections, for a fixed_days cadence. NULL for a calendar_month cadence, where the step is a month rather than a number of days.';

alter table public.repayment_frequencies
  add constraint repayment_frequencies_cadence_kind_valid
    check (cadence_kind in ('fixed_days', 'calendar_month'));

alter table public.repayment_frequencies
  add constraint repayment_frequencies_month_anchor_valid
    check (
      month_anchor is null
      or month_anchor in ('clamp_to_month_end', 'roll_forward_to_next_month')
    );

-- The two halves of "required where it is meaningful, refused where it is
-- not", stated as one constraint per column so a violation names the column
-- that is wrong.
alter table public.repayment_frequencies
  add constraint repayment_frequencies_interval_matches_kind
    check (
      (cadence_kind = 'fixed_days' and interval_days is not null)
      or (cadence_kind = 'calendar_month' and interval_days is null)
    );

alter table public.repayment_frequencies
  add constraint repayment_frequencies_anchor_matches_kind
    check (cadence_kind = 'calendar_month' or month_anchor is null);

-- ---------------------------------------------------------------------------
-- The immutability guard, extended
--
-- Migration 20261005000200 made `key` and `interval_days` immutable because
-- they are what an agreed cadence means. `cadence_kind` is the same kind of
-- fact and gets the same treatment.
--
-- `month_anchor` is **write-once** rather than immutable, and the difference
-- is the point: it starts NULL because nobody has decided, so the business
-- must be able to decide it. Once set it is an agreed convention and loans
-- have been scheduled against it, so it can never be changed or cleared.
-- That is the same shape `loans.interest_rate_bps` has — absent until
-- somebody decides, frozen from that moment.
-- ---------------------------------------------------------------------------

create or replace function public.repayment_frequencies_guard_identity()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
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

  -- Polytos Phase 3. A cadence's kind is as much what it means as its
  -- interval: turning a fixed-day cadence into a calendar one would redefine
  -- every loan that named it, silently, with no record on the loan.
  if new.cadence_kind is distinct from old.cadence_kind then
    raise exception
      'The cadence kind of "%" cannot be changed from % to %. It is what the cadence means, and loans already agreed to it. Retire this frequency with is_active = false and add a new one instead.',
      old.key, old.cadence_kind, new.cadence_kind
      using errcode = 'P0001';
  end if;

  -- Write-once. Deciding the anchor is a real business decision this schema
  -- is waiting for; un-deciding it, or deciding it differently, would move
  -- collection dates on loans already written against it.
  if old.month_anchor is not null
     and new.month_anchor is distinct from old.month_anchor then
    raise exception
      'The monthly collection anchor of "%" is % and cannot be changed. Loans have been scheduled against it. Retire this frequency with is_active = false and add a new one instead.',
      old.key, old.month_anchor
      using errcode = 'P0001';
  end if;

  return new;
end;
$$;

comment on function public.repayment_frequencies_guard_identity() is
  'BEFORE UPDATE/DELETE on repayment_frequencies: key, interval_days and cadence_kind are immutable, and month_anchor is write-once, because each is what an agreed cadence means. Label, is_active and sort_order stay editable.';

revoke all on function public.repayment_frequencies_guard_identity()
  from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- The two new cadences
--
-- `weekly` is the one-row insert §7 promised: seven days is a week, every
-- week, so it needs nothing this migration added. It is seeded active,
-- because it is correct and complete the moment it exists.
--
-- `monthly` is seeded with its anchor **undecided**, which is the truthful
-- state. It is seeded `is_active = false` as well, so it cannot be chosen on
-- an application form before the convention exists — `validate_loan_for_approval`
-- already refuses an inactive frequency, and a cadence offered in a picker
-- that approval would then refuse is a control that fails late instead of
-- early. Answering the question is two statements: set `month_anchor`, then
-- set `is_active = true`.
-- ---------------------------------------------------------------------------

insert into public.repayment_frequencies
  (key, label, interval_days, cadence_kind, month_anchor, is_active, sort_order)
values
  ('weekly', 'Weekly', 7, 'fixed_days', null, true, 4),
  ('monthly', 'Monthly (calendar)', null, 'calendar_month', null, false, 5)
on conflict (key) do nothing;

comment on table public.repayment_frequencies is
  'Supported repayment cadences, each either a fixed number of days apart or one calendar month apart. Retired by setting is_active = false, never deleted, so historical loans keep a valid reference.';

-- ---------------------------------------------------------------------------
-- The schedule's snapshot of the cadence
--
-- `loan_schedules` already snapshots the key, the label and the interval, so
-- that a generated schedule is explicable without reading another table and
-- stays readable after a cadence is retired. The kind and the anchor are part
-- of that same explanation: without them a calendar-monthly schedule would be
-- a list of dates with no record of the rule that produced them.
--
-- Every existing row is a fixed-day schedule, which is what the default says,
-- and the default is applied without rewriting any date.
-- ---------------------------------------------------------------------------

alter table public.loan_schedules
  add column cadence_kind text not null default 'fixed_days',
  add column month_anchor text;

alter table public.loan_schedules
  alter column interval_days drop not null;

comment on column public.loan_schedules.cadence_kind is
  'The kind of cadence this schedule was generated under, snapshotted. fixed_days for every schedule generated before Polytos Phase 3.';
comment on column public.loan_schedules.month_anchor is
  'For a calendar_month schedule, the convention that resolved a collection day the target month does not have. NULL for a fixed-day schedule.';

alter table public.loan_schedules
  add constraint loan_schedules_cadence_kind_valid
    check (cadence_kind in ('fixed_days', 'calendar_month'));

alter table public.loan_schedules
  add constraint loan_schedules_month_anchor_valid
    check (
      month_anchor is null
      or month_anchor in ('clamp_to_month_end', 'roll_forward_to_next_month')
    );

-- A calendar schedule has an anchor and no interval; a fixed-day schedule the
-- reverse. Stated here as well as on the frequency table, because a schedule
-- is the durable record and must be self-consistent even if the frequency row
-- were later retired.
alter table public.loan_schedules
  add constraint loan_schedules_cadence_consistent
    check (
      (cadence_kind = 'fixed_days'
         and interval_days is not null
         and month_anchor is null)
      or (cadence_kind = 'calendar_month'
         and interval_days is null
         and month_anchor is not null)
    );
