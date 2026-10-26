-- ===========================================================================
-- Polytos Phase 4.10 — monthly meetings, attendance, minutes and actions
--
-- ## What this module deliberately does not do
--
-- The client's documents say the company intends to hold monthly membership
-- meetings. They do not say that missing one suspends a membership,
-- disqualifies savings, blocks a loan, blocks a benefit or reduces a profit
-- share. §15 of the brief is explicit, and so is this schema: **there is no
-- column anywhere that makes attendance a condition of anything.**
--
-- That absence is the design, not an omission. It would have been easy to add
-- `memberships.consecutive_absences` and a trigger that suspended somebody at
-- three — and a business that suspended a member over an attendance rule
-- nobody had written down would have done real harm on this system's
-- authority. An attendance register that records attendance accurately and
-- affects nothing else is the honest implementation of a requirement that
-- stops at "hold meetings and keep records".
--
-- So nothing in Phase 4 reads `meeting_attendance` to decide anything.
-- `tests/db/meetings.test.ts` asserts that no benefit, savings or loan
-- function consults it, which is how the absence stays an absence after
-- somebody adds a feature next year.
--
-- ## Africa/Kampala, and why a meeting carries a timestamp and a date
--
-- A meeting happens at an instant — 2 p.m. on the third Saturday — and it
-- also belongs to a *month*, because the programme is monthly and "have we
-- held October's meeting" is a real question. Those are different things, and
-- a system that stored only the instant would have to re-derive the month on
-- every read, in the right timezone, or get October's 11 p.m. meeting wrong.
--
-- So `scheduled_at` is a `timestamptz` and `meeting_date` is a generated
-- `date` in Africa/Kampala. Generated, so they cannot disagree, and in the
-- business timezone rather than UTC because a meeting at 00:30 Kampala on
-- 1 November is November's meeting and 21:30 UTC on 31 October is the same
-- instant.
--
-- No mandatory day or hour is invented. The documents say monthly; they do not
-- say the third Saturday, so nothing here does either.
--
-- ## Attendance is corrected, never overwritten
--
-- One row per (meeting, membership) — a unique constraint, so a duplicate
-- attendance record is impossible rather than merely discouraged. A
-- correction updates the row and appends the previous state to
-- `meeting_attendance_corrections`, which is append-only. So "she was marked
-- absent and then present" is answerable, and the register still has exactly
-- one row per member.
--
-- The alternative — append-only attendance rows with the latest winning —
-- was rejected because every read would then need a window function to find
-- the current state, and the register is the most-read screen in the module.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- The meetings
-- ---------------------------------------------------------------------------

create table public.membership_meetings (
  id uuid primary key default pg_catalog.gen_random_uuid(),

  meeting_number text not null unique,

  -- The branch that convenes it. A branch rather than nullable-for-everybody,
  -- because the attendance register is a list of that branch's members and
  -- `user_can_see_branch` is how every other register here is scoped.
  branch_id uuid not null references public.branches(id) on delete restrict,

  meeting_type text not null default 'monthly_general',

  title text not null,
  -- Where. Free text, because a venue in Kampala is a description rather than
  -- an address — "the back room at the Kyanja office", "Mukasa's compound" —
  -- and a structured address field would be filled with one of those anyway.
  venue text not null,

  scheduled_at timestamptz not null,
  -- The month the meeting belongs to, in the business timezone. Generated, so
  -- it cannot disagree with the instant.
  meeting_date date generated always as
    ((scheduled_at at time zone 'Africa/Kampala')::date) stored,

  status text not null default 'scheduled',

  -- The agenda, as text. Not a table of agenda items: an agenda is read
  -- aloud, it is not queried, and a table of items would be a table whose
  -- rows nothing ever joins to.
  agenda text,

  -- --- Minutes -----------------------------------------------------------
  --
  -- Written after the meeting, and finalised as a separate act — because a
  -- set of minutes everybody can still edit is not a record of what was
  -- decided. Once finalised, amending them takes `meetings:manage` and leaves
  -- the amendment on the record.

  minutes text,
  minutes_finalised_at timestamptz,
  minutes_finalised_by uuid references public.profiles(id) on delete set null,
  minutes_finalised_by_label text,
  minutes_amended_at timestamptz,
  minutes_amendment_note text,

  -- --- Rescheduling and cancellation -------------------------------------

  -- What the meeting was previously scheduled for, where it moved. One
  -- column rather than a history table: a meeting that is moved twice is
  -- rare, the original date is what people ask about, and a table would be
  -- three joins for a question nobody asks twice. The audit trail carries
  -- every move.
  rescheduled_from timestamptz,
  reschedule_reason text,
  cancelled_at timestamptz,
  cancellation_reason text,

  created_by uuid references public.profiles(id) on delete set null,
  created_by_label text not null default 'system',
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),

  constraint membership_meeting_number_shape check (meeting_number ~ '^MM[0-9]{5,}$'),
  constraint membership_meeting_type_valid
    check (meeting_type in (
      'monthly_general', 'annual_general', 'special', 'committee'
    )),
  constraint membership_meeting_status_valid
    check (status in ('scheduled', 'held', 'cancelled', 'postponed')),
  constraint membership_meeting_title_length
    check (char_length(btrim(title)) between 3 and 200),
  constraint membership_meeting_venue_length
    check (char_length(btrim(venue)) between 3 and 200),
  constraint membership_meeting_agenda_length
    check (agenda is null or char_length(btrim(agenda)) between 3 and 8000),
  constraint membership_meeting_minutes_length
    check (minutes is null or char_length(btrim(minutes)) between 3 and 20000),
  -- Minutes belong to a meeting that happened. A set of minutes on a
  -- scheduled meeting is a set of minutes for a meeting nobody has held.
  constraint membership_meeting_minutes_need_a_meeting
    check (minutes is null or status = 'held'),
  constraint membership_meeting_finalised_complete
    check (
      (minutes_finalised_at is null)
      = (minutes_finalised_by_label is null)
    ),
  constraint membership_meeting_finalised_needs_minutes
    check (minutes_finalised_at is null or minutes is not null),
  constraint membership_meeting_amendment_complete
    check (
      (minutes_amended_at is null) = (minutes_amendment_note is null)
    ),
  -- An amendment is an amendment *of* something finalised. Amending a draft
  -- is editing it.
  constraint membership_meeting_amendment_needs_finalised
    check (minutes_amended_at is null or minutes_finalised_at is not null),
  constraint membership_meeting_amendment_note_length
    check (
      minutes_amendment_note is null
      or char_length(btrim(minutes_amendment_note)) between 3 and 2000
    ),
  constraint membership_meeting_cancelled_complete
    check ((cancelled_at is null) = (cancellation_reason is null)),
  constraint membership_meeting_cancelled_status
    check ((status = 'cancelled') = (cancelled_at is not null)),
  constraint membership_meeting_cancellation_reason_length
    check (
      cancellation_reason is null
      or char_length(btrim(cancellation_reason)) between 3 and 1000
    ),
  constraint membership_meeting_reschedule_complete
    check ((rescheduled_from is null) = (reschedule_reason is null)),
  constraint membership_meeting_reschedule_reason_length
    check (
      reschedule_reason is null
      or char_length(btrim(reschedule_reason)) between 3 and 1000
    ),
  constraint membership_meeting_scheduled_plausible
    check (scheduled_at >= timestamptz '2020-01-01 00:00+03'),
  constraint membership_meeting_labels_not_blank
    check (
      btrim(created_by_label) <> ''
      and (minutes_finalised_by_label is null
           or btrim(minutes_finalised_by_label) <> '')
    )
);

comment on table public.membership_meetings is
  'Polytos Phase 4. Monthly membership meetings: when, where, the agenda, the minutes and whether they are finalised. meeting_date is generated in Africa/Kampala, so the instant and the month it belongs to cannot disagree. Nothing in this schema makes attendance a condition of anything, because nothing in the client''s documents does.';
comment on column public.membership_meetings.meeting_date is
  'Generated from scheduled_at in Africa/Kampala. "Have we held October''s meeting" is a real question, and a system storing only the instant would have to re-derive the month on every read — and would put a 00:30 Kampala meeting on 1 November into October.';
comment on column public.membership_meetings.minutes_finalised_at is
  'When the minutes stopped being a draft. A separate act, because a set of minutes everybody can still edit is not a record of what was decided; amending them afterwards leaves minutes_amendment_note on the row.';

-- One monthly general meeting per branch per month. `monthly_general` only:
-- a special meeting and a committee meeting may happen any number of times,
-- and an AGM is annual but nothing here needs to enforce that.
create unique index membership_meetings_one_monthly_per_branch
  on public.membership_meetings (
    branch_id,
    -- Cast to `timestamp` before truncating: date_trunc over `timestamptz`
    -- is STABLE rather than IMMUTABLE, because it depends on the session
    -- timezone, and an index expression may not be. `meeting_date` is
    -- already a date in Africa/Kampala, so the cast loses nothing.
    (pg_catalog.date_trunc('month', meeting_date::timestamp))
  )
  where meeting_type = 'monthly_general' and status <> 'cancelled';

comment on index public.membership_meetings_one_monthly_per_branch is
  'One live monthly general meeting per branch per month. Partial on the status, so a cancelled meeting does not block the one that replaces it — which is what a cancellation is usually for.';

create index membership_meetings_date_idx
  on public.membership_meetings (meeting_date desc, scheduled_at desc);
create index membership_meetings_branch_date_idx
  on public.membership_meetings (branch_id, meeting_date desc);
create index membership_meetings_status_idx
  on public.membership_meetings (status, scheduled_at desc);

create trigger membership_meetings_set_updated_at
  before update on public.membership_meetings
  for each row execute function public.set_updated_at();

create or replace function public.membership_meetings_assign_number()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  new.meeting_number := public.next_reference('membership_meeting');
  return new;
end;
$$;

revoke all on function public.membership_meetings_assign_number()
  from public, anon, authenticated;

create trigger membership_meetings_assign_number
  before insert on public.membership_meetings
  for each row execute function public.membership_meetings_assign_number();

-- ---------------------------------------------------------------------------
-- The meeting guard
-- ---------------------------------------------------------------------------

create or replace function public.membership_meetings_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    new.created_by := coalesce(public.current_profile_id(), new.created_by);
    new.created_by_label := public.audit_actor_label();
    new.status := 'scheduled';
    new.minutes := null;
    new.minutes_finalised_at := null;
    new.minutes_finalised_by := null;
    new.minutes_finalised_by_label := null;
    new.minutes_amended_at := null;
    new.minutes_amendment_note := null;
    new.rescheduled_from := null;
    new.reschedule_reason := null;
    new.cancelled_at := null;
    new.cancellation_reason := null;
    return new;
  end if;

  if new.id is distinct from old.id
     or new.meeting_number is distinct from old.meeting_number
     or new.branch_id is distinct from old.branch_id
     or new.created_by_label is distinct from old.created_by_label then
    raise exception
      'A meeting''s identity and convening branch do not change. Cancel it and schedule another.'
      using errcode = 'P0001';
  end if;

  -- A cancelled meeting is over. Nothing about it moves afterwards —
  -- rescheduling a cancelled meeting is scheduling a new one, and the index
  -- on the monthly slot is written to allow exactly that.
  if old.status = 'cancelled' and new.status is distinct from old.status then
    raise exception
      'Meeting % was cancelled. Schedule a new one rather than reviving it — the register and the minutes belong to the meeting that happened.',
      old.meeting_number using errcode = 'P0001';
  end if;

  -- Finalised minutes are not silently edited. An amendment must say it is
  -- one, which is what `minutes_amendment_note` is for.
  if old.minutes_finalised_at is not null
     and new.minutes is distinct from old.minutes
     and new.minutes_amendment_note is not distinct from old.minutes_amendment_note then
    raise exception
      'The minutes of meeting % are finalised. Amend them with a note saying what changed and why — a record of decisions that can be edited without trace is not a record.',
      old.meeting_number using errcode = 'P0001';
  end if;

  return new;
end;
$$;

comment on function public.membership_meetings_guard() is
  'Polytos Phase 4. Forces a new meeting to scheduled with no minutes, freezes its identity and convening branch, refuses the revival of a cancelled meeting, and refuses a silent edit to finalised minutes.';

revoke all on function public.membership_meetings_guard()
  from public, anon, authenticated;

create trigger membership_meetings_guard
  before insert or update on public.membership_meetings
  for each row execute function public.membership_meetings_guard();

create trigger membership_meetings_no_delete
  before delete on public.membership_meetings
  for each row execute function public.reject_mutation();

-- ---------------------------------------------------------------------------
-- Attendance
-- ---------------------------------------------------------------------------

create table public.meeting_attendance (
  id uuid primary key default pg_catalog.gen_random_uuid(),

  meeting_id uuid not null
    references public.membership_meetings(id) on delete restrict,
  membership_id uuid not null references public.memberships(id) on delete restrict,
  client_id uuid not null references public.clients(id) on delete restrict,

  attendance text not null,
  -- Why somebody was away, where they said. Permitted reasons only: a free
  -- text field here fills up with "?" and a closed list is what makes
  -- "how many apologies did we have" answerable.
  absence_reason text,
  -- Anything else worth noting — arrived late, left early, represented by a
  -- family member. Free text, because this one genuinely is a remark.
  note text,

  marked_at timestamptz not null default pg_catalog.now(),
  marked_by uuid references public.profiles(id) on delete set null,
  marked_by_label text not null default 'system',

  -- Set when the row has been corrected at least once, so a register can show
  -- which entries were revised without joining the corrections table.
  corrected_at timestamptz,
  correction_count integer not null default 0,

  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),

  -- One row per member per meeting. The constraint, not a check in a
  -- function: two staff marking the register at once would both pass a check.
  constraint meeting_attendance_one_per_member unique (meeting_id, membership_id),
  constraint meeting_attendance_valid
    check (attendance in ('present', 'absent', 'apology', 'represented')),
  -- An absence or an apology may carry a reason; being present may not.
  constraint meeting_attendance_reason_valid
    check (
      absence_reason is null
      or absence_reason in (
        'illness', 'travel', 'work', 'bereavement', 'family', 'not_stated', 'other'
      )
    ),
  constraint meeting_attendance_present_has_no_reason
    check (attendance <> 'present' or absence_reason is null),
  constraint meeting_attendance_note_length
    check (note is null or char_length(btrim(note)) between 2 and 500),
  constraint meeting_attendance_label_not_blank
    check (btrim(marked_by_label) <> ''),
  constraint meeting_attendance_correction_coherent
    check (
      (corrected_at is null) = (correction_count = 0)
      and correction_count >= 0
    )
);

comment on table public.meeting_attendance is
  'Polytos Phase 4. Who came to a meeting, one row per member per meeting. Corrections update the row and append the previous state to meeting_attendance_corrections, so the register has one row per member and the history is still answerable. Nothing reads this table to decide anything about savings, loans or benefits.';
comment on column public.meeting_attendance.absence_reason is
  'A closed list, because a free text field here fills up with "?" and a closed list is what makes "how many apologies did we have" answerable.';

create index meeting_attendance_meeting_idx
  on public.meeting_attendance (meeting_id, attendance);
create index meeting_attendance_membership_idx
  on public.meeting_attendance (membership_id, marked_at desc);
create index meeting_attendance_client_idx on public.meeting_attendance (client_id);

create trigger meeting_attendance_set_updated_at
  before update on public.meeting_attendance
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- The corrections, append-only
-- ---------------------------------------------------------------------------

create table public.meeting_attendance_corrections (
  id uuid primary key default pg_catalog.gen_random_uuid(),

  attendance_id uuid not null
    references public.meeting_attendance(id) on delete restrict,
  meeting_id uuid not null
    references public.membership_meetings(id) on delete restrict,
  membership_id uuid not null references public.memberships(id) on delete restrict,

  previous_attendance text not null,
  previous_absence_reason text,
  previous_note text,
  previous_marked_by_label text not null,

  new_attendance text not null,
  new_absence_reason text,

  reason text not null,

  corrected_at timestamptz not null default pg_catalog.now(),
  corrected_by uuid references public.profiles(id) on delete set null,
  corrected_by_label text not null default 'system',

  constraint attendance_correction_values_valid
    check (
      previous_attendance in ('present', 'absent', 'apology', 'represented')
      and new_attendance in ('present', 'absent', 'apology', 'represented')
    ),
  -- A correction that changes nothing is not a correction.
  constraint attendance_correction_changes_something
    check (
      previous_attendance is distinct from new_attendance
      or previous_absence_reason is distinct from new_absence_reason
    ),
  constraint attendance_correction_reason_length
    check (char_length(btrim(reason)) between 3 and 500),
  constraint attendance_correction_labels_not_blank
    check (btrim(corrected_by_label) <> '' and btrim(previous_marked_by_label) <> '')
);

comment on table public.meeting_attendance_corrections is
  'Polytos Phase 4. What an attendance entry said before it was corrected, who corrected it and why. Append-only: a correction history that could be edited would make every corrected entry unexplainable.';

create index attendance_corrections_attendance_idx
  on public.meeting_attendance_corrections (attendance_id, corrected_at desc);
create index attendance_corrections_meeting_idx
  on public.meeting_attendance_corrections (meeting_id);

create trigger attendance_corrections_no_update
  before update on public.meeting_attendance_corrections
  for each row execute function public.reject_mutation();

create trigger attendance_corrections_no_delete
  before delete on public.meeting_attendance_corrections
  for each row execute function public.reject_mutation();

-- ---------------------------------------------------------------------------
-- Action items
-- ---------------------------------------------------------------------------

create table public.meeting_action_items (
  id uuid primary key default pg_catalog.gen_random_uuid(),

  meeting_id uuid not null
    references public.membership_meetings(id) on delete restrict,

  description text not null,
  -- Who is doing it: a member of staff with an account, not a typed name.
  -- "Somebody will look into it" is how an action item becomes nobody's, and
  -- a profile reference is a person who can be asked.
  assigned_to uuid references public.profiles(id) on delete restrict,
  assigned_to_label text,
  due_on date,

  status text not null default 'open',
  completed_at timestamptz,
  completed_by uuid references public.profiles(id) on delete set null,
  completed_by_label text,
  completion_note text,

  created_by uuid references public.profiles(id) on delete set null,
  created_by_label text not null default 'system',
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),

  constraint meeting_action_description_length
    check (char_length(btrim(description)) between 3 and 1000),
  constraint meeting_action_status_valid
    check (status in ('open', 'in_progress', 'completed', 'cancelled')),
  constraint meeting_action_completed_complete
    check (
      (status in ('completed', 'cancelled'))
      = (completed_at is not null and completed_by_label is not null)
    ),
  constraint meeting_action_completion_note_length
    check (
      completion_note is null
      or char_length(btrim(completion_note)) between 2 and 1000
    ),
  constraint meeting_action_assignee_complete
    check ((assigned_to is null) = (assigned_to_label is null)),
  constraint meeting_action_due_plausible
    check (due_on is null or due_on >= date '2020-01-01'),
  constraint meeting_action_labels_not_blank
    check (
      btrim(created_by_label) <> ''
      and (assigned_to_label is null or btrim(assigned_to_label) <> '')
      and (completed_by_label is null or btrim(completed_by_label) <> '')
    )
);

comment on table public.meeting_action_items is
  'Polytos Phase 4. What a meeting decided somebody would do, who, by when, and whether it is done. assigned_to is a profile rather than a typed name, because "somebody will look into it" is how an action item becomes nobody''s.';

create index meeting_action_items_meeting_idx
  on public.meeting_action_items (meeting_id, status);
create index meeting_action_items_assignee_idx
  on public.meeting_action_items (assigned_to, status)
  where assigned_to is not null;
create index meeting_action_items_due_idx
  on public.meeting_action_items (due_on)
  where status in ('open', 'in_progress');

create trigger meeting_action_items_set_updated_at
  before update on public.meeting_action_items
  for each row execute function public.set_updated_at();

-- ===========================================================================
-- The functions
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- schedule_membership_meeting()
-- ---------------------------------------------------------------------------

create or replace function public.schedule_membership_meeting(
  p_branch_id uuid,
  p_meeting_type text,
  p_title text,
  p_venue text,
  p_scheduled_at timestamptz,
  p_agenda text default null
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if public.current_profile_id() is null and auth.uid() is not null then
    raise exception
      'A meeting must be scheduled by a signed-in member of staff.'
      using errcode = 'P0001';
  end if;

  if auth.uid() is not null and not public.user_has_permission('meetings:manage') then
    raise exception
      'Scheduling a meeting requires the meetings:manage capability.'
      using errcode = 'P0001';
  end if;

  -- The branch rule, restated here rather than left to RLS: a function that
  -- is SECURITY DEFINER has no policies applied to it, so a caller could
  -- otherwise convene a meeting at a branch they cannot see.
  --
  -- The existence check comes first and is part of the same refusal.
  -- `user_can_see_branch` answers "is this branch outside my scope", and for
  -- a user with no branch of their own — which the Owner and a head-office
  -- Manager both are — the answer for *any* id is no, including an id that is
  -- not a branch at all. Without this, a forged branch reference would reach
  -- the foreign key and surface as a constraint error rather than as the
  -- authorisation refusal it is.
  if not exists (
    select 1 from public.branches b
    where b.id = p_branch_id and b.status = 'active'
  ) or not public.user_can_see_branch(p_branch_id) then
    raise exception
      'You cannot convene a meeting at that branch.' using errcode = 'P0001';
  end if;

  insert into public.membership_meetings (
    branch_id, meeting_type, title, venue, scheduled_at, agenda
  )
  values (
    p_branch_id, p_meeting_type,
    pg_catalog.btrim(p_title), pg_catalog.btrim(p_venue),
    p_scheduled_at,
    nullif(pg_catalog.btrim(coalesce(p_agenda, '')), '')
  )
  returning id into v_id;

  return v_id;
end;
$$;

comment on function public.schedule_membership_meeting(uuid, text, text, text, timestamptz, text) is
  'Polytos Phase 4. Schedules a membership meeting at a branch the caller can see. No mandatory day or hour is imposed: the documents say monthly and nothing more.';

revoke all on function public.schedule_membership_meeting(uuid, text, text, text, timestamptz, text)
  from public, anon;
grant execute on function public.schedule_membership_meeting(uuid, text, text, text, timestamptz, text)
  to authenticated;

-- ---------------------------------------------------------------------------
-- reschedule_membership_meeting()
-- ---------------------------------------------------------------------------

create or replace function public.reschedule_membership_meeting(
  p_meeting_id uuid,
  p_scheduled_at timestamptz,
  p_reason text,
  p_venue text default null
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_meeting public.membership_meetings;
begin
  if auth.uid() is not null and not public.user_has_permission('meetings:manage') then
    raise exception
      'Rescheduling a meeting requires the meetings:manage capability.'
      using errcode = 'P0001';
  end if;

  if coalesce(pg_catalog.btrim(p_reason), '') = '' then
    raise exception
      'A reschedule needs a reason. Members have arranged their day around the old one.'
      using errcode = 'P0001';
  end if;

  select * into v_meeting
  from public.membership_meetings where id = p_meeting_id for update;

  if not found then
    raise exception 'No such meeting.' using errcode = 'P0001';
  end if;

  if v_meeting.status <> 'scheduled' then
    raise exception
      'Meeting % is %. Only a scheduled meeting is moved.',
      v_meeting.meeting_number, v_meeting.status using errcode = 'P0001';
  end if;

  if not public.user_can_see_branch(v_meeting.branch_id) then
    raise exception 'You cannot move that branch''s meeting.' using errcode = 'P0001';
  end if;

  update public.membership_meetings
     set scheduled_at = p_scheduled_at,
         venue = coalesce(nullif(pg_catalog.btrim(coalesce(p_venue, '')), ''), venue),
         -- The *first* date it was scheduled for, not the previous one. A
         -- meeting moved twice has one original that members remember.
         rescheduled_from = coalesce(rescheduled_from, v_meeting.scheduled_at),
         reschedule_reason = pg_catalog.btrim(p_reason)
   where id = p_meeting_id;

  return p_meeting_id;
end;
$$;

comment on function public.reschedule_membership_meeting(uuid, timestamptz, text, text) is
  'Polytos Phase 4. Moves a scheduled meeting, keeping the first date it was announced for and the reason. Refused once a meeting has been held or cancelled.';

revoke all on function public.reschedule_membership_meeting(uuid, timestamptz, text, text)
  from public, anon;
grant execute on function public.reschedule_membership_meeting(uuid, timestamptz, text, text)
  to authenticated;

-- ---------------------------------------------------------------------------
-- cancel_membership_meeting()
-- ---------------------------------------------------------------------------

create or replace function public.cancel_membership_meeting(
  p_meeting_id uuid,
  p_reason text
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_meeting public.membership_meetings;
  v_attendance integer;
begin
  if auth.uid() is not null and not public.user_has_permission('meetings:manage') then
    raise exception
      'Cancelling a meeting requires the meetings:manage capability.'
      using errcode = 'P0001';
  end if;

  if coalesce(pg_catalog.btrim(p_reason), '') = '' then
    raise exception 'A cancellation needs a reason.' using errcode = 'P0001';
  end if;

  select * into v_meeting
  from public.membership_meetings where id = p_meeting_id for update;

  if not found then
    raise exception 'No such meeting.' using errcode = 'P0001';
  end if;

  if not public.user_can_see_branch(v_meeting.branch_id) then
    raise exception 'You cannot cancel that branch''s meeting.' using errcode = 'P0001';
  end if;

  -- A meeting people attended was held, whatever anybody wants the record to
  -- say afterwards. Cancelling it would leave attendance rows for a meeting
  -- the register says never happened.
  --
  -- Asked **before** the status check, and deliberately. Marking the first
  -- member present already moves the meeting to `held`, so the status check
  -- would catch this case first and answer "the meeting is held" — true, and
  -- not the reason. This one says what to do instead. The status check below
  -- still earns its place for a meeting that is cancelled or postponed.
  select pg_catalog.count(*) into v_attendance
  from public.meeting_attendance where meeting_id = p_meeting_id;

  if v_attendance > 0 then
    raise exception
      'Meeting % has % attendance record(s), so it happened. A meeting that took place is marked held, not cancelled.',
      v_meeting.meeting_number, v_attendance using errcode = 'P0001';
  end if;

  if v_meeting.status <> 'scheduled' then
    raise exception
      'Meeting % is %.', v_meeting.meeting_number, v_meeting.status
      using errcode = 'P0001';
  end if;

  update public.membership_meetings
     set status = 'cancelled',
         cancelled_at = pg_catalog.now(),
         cancellation_reason = pg_catalog.btrim(p_reason)
   where id = p_meeting_id;

  return p_meeting_id;
end;
$$;

comment on function public.cancel_membership_meeting(uuid, text) is
  'Polytos Phase 4. Cancels a scheduled meeting with a reason, and refuses to cancel one people attended — a meeting that took place is marked held, whatever anybody wants the record to say.';

revoke all on function public.cancel_membership_meeting(uuid, text) from public, anon;
grant execute on function public.cancel_membership_meeting(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- mark_meeting_attendance()
--
-- One member, one meeting, idempotent on the pair: calling it twice with the
-- same answer is a no-op, and calling it twice with different answers is a
-- *correction* and is refused unless a reason is given. That is deliberate —
-- the common double-tap must not silently rewrite a register, and a genuine
-- change must say why.
-- ---------------------------------------------------------------------------

create or replace function public.mark_meeting_attendance(
  p_meeting_id uuid,
  p_membership_id uuid,
  p_attendance text,
  p_absence_reason text default null,
  p_note text default null,
  p_correction_reason text default null
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_meeting public.membership_meetings;
  v_membership public.memberships;
  v_existing public.meeting_attendance;
  v_id uuid;
  v_actor uuid;
  v_label text;
begin
  v_actor := public.current_profile_id();
  v_label := public.audit_actor_label();

  if v_actor is null and auth.uid() is not null then
    raise exception
      'Attendance must be marked by a signed-in member of staff.'
      using errcode = 'P0001';
  end if;

  if auth.uid() is not null and not public.user_has_permission('meetings:manage') then
    raise exception
      'Marking attendance requires the meetings:manage capability.'
      using errcode = 'P0001';
  end if;

  select * into v_meeting
  from public.membership_meetings where id = p_meeting_id for update;

  if not found then
    raise exception 'No such meeting.' using errcode = 'P0001';
  end if;

  if v_meeting.status = 'cancelled' then
    raise exception
      'Meeting % was cancelled.', v_meeting.meeting_number using errcode = 'P0001';
  end if;

  if not public.user_can_see_branch(v_meeting.branch_id) then
    raise exception
      'You cannot mark that branch''s register.' using errcode = 'P0001';
  end if;

  -- A member of this branch. Not a capability question — it is a question
  -- about whether the register makes sense: a member enrolled at another
  -- branch is not on this meeting's list.
  select * into v_membership
  from public.memberships where id = p_membership_id;

  if not found then
    raise exception 'No such membership.' using errcode = 'P0001';
  end if;

  if v_membership.branch_id <> v_meeting.branch_id then
    raise exception
      'Membership % belongs to another branch, so it is not on this meeting''s register.',
      v_membership.membership_number using errcode = 'P0001';
  end if;

  if v_membership.status not in ('active', 'suspended') then
    raise exception
      'Membership % is %. A register records the members the programme had at the time.',
      v_membership.membership_number, v_membership.status using errcode = 'P0001';
  end if;

  select * into v_existing
  from public.meeting_attendance
  where meeting_id = p_meeting_id and membership_id = p_membership_id
  for update;

  if not found then
    insert into public.meeting_attendance (
      meeting_id, membership_id, client_id,
      attendance, absence_reason, note, marked_by, marked_by_label
    )
    values (
      p_meeting_id, p_membership_id, v_membership.client_id,
      p_attendance,
      nullif(pg_catalog.btrim(coalesce(p_absence_reason, '')), ''),
      nullif(pg_catalog.btrim(coalesce(p_note, '')), ''),
      v_actor, v_label
    )
    returning id into v_id;

    -- The meeting happened, so it says so. Derived from the register rather
    -- than set by hand: a meeting with a register and a `scheduled` status
    -- would be two statements about one afternoon.
    if v_meeting.status = 'scheduled' then
      update public.membership_meetings set status = 'held' where id = p_meeting_id;
    end if;

    return v_id;
  end if;

  -- Same answer twice: the double tap. Nothing to record.
  if v_existing.attendance = p_attendance
     and v_existing.absence_reason
         is not distinct from nullif(pg_catalog.btrim(coalesce(p_absence_reason, '')), '') then
    return v_existing.id;
  end if;

  if coalesce(pg_catalog.btrim(coalesce(p_correction_reason, '')), '') = '' then
    raise exception
      'Membership % is already marked "%" for meeting %. Changing a register entry is a correction and needs a reason.',
      v_membership.membership_number, v_existing.attendance, v_meeting.meeting_number
      using errcode = 'P0001';
  end if;

  insert into public.meeting_attendance_corrections (
    attendance_id, meeting_id, membership_id,
    previous_attendance, previous_absence_reason, previous_note,
    previous_marked_by_label,
    new_attendance, new_absence_reason,
    reason, corrected_by, corrected_by_label
  )
  values (
    v_existing.id, p_meeting_id, p_membership_id,
    v_existing.attendance, v_existing.absence_reason, v_existing.note,
    v_existing.marked_by_label,
    p_attendance, nullif(pg_catalog.btrim(coalesce(p_absence_reason, '')), ''),
    pg_catalog.btrim(p_correction_reason), v_actor, v_label
  );

  update public.meeting_attendance
     set attendance = p_attendance,
         absence_reason = nullif(pg_catalog.btrim(coalesce(p_absence_reason, '')), ''),
         note = coalesce(nullif(pg_catalog.btrim(coalesce(p_note, '')), ''), note),
         marked_at = pg_catalog.now(),
         marked_by = v_actor,
         marked_by_label = v_label,
         corrected_at = pg_catalog.now(),
         correction_count = v_existing.correction_count + 1
   where id = v_existing.id;

  return v_existing.id;
end;
$$;

comment on function public.mark_meeting_attendance(uuid, uuid, text, text, text, text) is
  'Polytos Phase 4. Marks or corrects one member''s attendance. The same answer twice is a no-op, so a double tap cannot rewrite a register; a different answer is a correction and needs a reason, which is appended to meeting_attendance_corrections before the row moves.';

revoke all on function public.mark_meeting_attendance(uuid, uuid, text, text, text, text)
  from public, anon;
grant execute on function public.mark_meeting_attendance(uuid, uuid, text, text, text, text)
  to authenticated;

-- ---------------------------------------------------------------------------
-- record_meeting_minutes() and finalise_meeting_minutes()
-- ---------------------------------------------------------------------------

create or replace function public.record_meeting_minutes(
  p_meeting_id uuid,
  p_minutes text,
  p_amendment_note text default null
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_meeting public.membership_meetings;
begin
  if auth.uid() is not null and not public.user_has_permission('meetings:manage') then
    raise exception
      'Writing minutes requires the meetings:manage capability.'
      using errcode = 'P0001';
  end if;

  if coalesce(pg_catalog.btrim(p_minutes), '') = '' then
    raise exception 'There are no minutes in that.' using errcode = 'P0001';
  end if;

  select * into v_meeting
  from public.membership_meetings where id = p_meeting_id for update;

  if not found then
    raise exception 'No such meeting.' using errcode = 'P0001';
  end if;

  if not public.user_can_see_branch(v_meeting.branch_id) then
    raise exception 'You cannot write that branch''s minutes.' using errcode = 'P0001';
  end if;

  if v_meeting.status = 'cancelled' then
    raise exception
      'Meeting % was cancelled, so there is nothing to minute.', v_meeting.meeting_number
      using errcode = 'P0001';
  end if;

  if v_meeting.status = 'scheduled' then
    raise exception
      'Meeting % has not been held. Mark the register first — minutes for a meeting that has not happened are minutes of nothing.',
      v_meeting.meeting_number using errcode = 'P0001';
  end if;

  if v_meeting.minutes_finalised_at is not null
     and coalesce(pg_catalog.btrim(coalesce(p_amendment_note, '')), '') = '' then
    raise exception
      'The minutes of meeting % are finalised. Amending them needs a note saying what changed and why.',
      v_meeting.meeting_number using errcode = 'P0001';
  end if;

  update public.membership_meetings
     set minutes = pg_catalog.btrim(p_minutes),
         minutes_amended_at = case
           when minutes_finalised_at is not null then pg_catalog.now()
           else minutes_amended_at
         end,
         minutes_amendment_note = case
           when minutes_finalised_at is not null
             then pg_catalog.btrim(p_amendment_note)
           else minutes_amendment_note
         end
   where id = p_meeting_id;

  return p_meeting_id;
end;
$$;

comment on function public.record_meeting_minutes(uuid, text, text) is
  'Polytos Phase 4. Writes or amends a held meeting''s minutes. Refused for a meeting that has not happened, and an amendment to finalised minutes needs a note saying what changed.';

revoke all on function public.record_meeting_minutes(uuid, text, text) from public, anon;
grant execute on function public.record_meeting_minutes(uuid, text, text) to authenticated;

create or replace function public.finalise_meeting_minutes(p_meeting_id uuid)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_meeting public.membership_meetings;
begin
  if auth.uid() is not null and not public.user_has_permission('meetings:manage') then
    raise exception
      'Finalising minutes requires the meetings:manage capability.'
      using errcode = 'P0001';
  end if;

  select * into v_meeting
  from public.membership_meetings where id = p_meeting_id for update;

  if not found then
    raise exception 'No such meeting.' using errcode = 'P0001';
  end if;

  if not public.user_can_see_branch(v_meeting.branch_id) then
    raise exception 'You cannot finalise that branch''s minutes.' using errcode = 'P0001';
  end if;

  if v_meeting.minutes is null then
    raise exception
      'Meeting % has no minutes to finalise.', v_meeting.meeting_number
      using errcode = 'P0001';
  end if;

  if v_meeting.minutes_finalised_at is not null then
    raise exception
      'The minutes of meeting % were finalised on %.',
      v_meeting.meeting_number, v_meeting.minutes_finalised_at::date
      using errcode = 'P0001';
  end if;

  update public.membership_meetings
     set minutes_finalised_at = pg_catalog.now(),
         minutes_finalised_by = public.current_profile_id(),
         minutes_finalised_by_label = public.audit_actor_label()
   where id = p_meeting_id;

  return p_meeting_id;
end;
$$;

comment on function public.finalise_meeting_minutes(uuid) is
  'Polytos Phase 4. Marks a meeting''s minutes as the record. A separate act from writing them, because minutes everybody can still edit are not a record of what was decided.';

revoke all on function public.finalise_meeting_minutes(uuid) from public, anon;
grant execute on function public.finalise_meeting_minutes(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- The action items
-- ---------------------------------------------------------------------------

create or replace function public.add_meeting_action_item(
  p_meeting_id uuid,
  p_description text,
  p_assigned_to uuid default null,
  p_due_on date default null
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_meeting public.membership_meetings;
  v_assignee public.profiles;
  v_id uuid;
begin
  if auth.uid() is not null and not public.user_has_permission('meetings:manage') then
    raise exception
      'Recording a meeting action requires the meetings:manage capability.'
      using errcode = 'P0001';
  end if;

  select * into v_meeting
  from public.membership_meetings where id = p_meeting_id;

  if not found then
    raise exception 'No such meeting.' using errcode = 'P0001';
  end if;

  if not public.user_can_see_branch(v_meeting.branch_id) then
    raise exception
      'You cannot record an action for that branch''s meeting.' using errcode = 'P0001';
  end if;

  if p_assigned_to is not null then
    select * into v_assignee from public.profiles where id = p_assigned_to;

    if not found or v_assignee.status <> 'active' then
      raise exception
        'That staff member does not have an active account, so they cannot be given an action.'
        using errcode = 'P0001';
    end if;
  end if;

  insert into public.meeting_action_items (
    meeting_id, description, assigned_to, assigned_to_label, due_on,
    created_by, created_by_label
  )
  values (
    p_meeting_id, pg_catalog.btrim(p_description),
    p_assigned_to, v_assignee.full_name, p_due_on,
    public.current_profile_id(), public.audit_actor_label()
  )
  returning id into v_id;

  return v_id;
end;
$$;

comment on function public.add_meeting_action_item(uuid, text, uuid, date) is
  'Polytos Phase 4. Records something a meeting decided somebody would do. The assignee is a staff profile with an active account, not a typed name.';

revoke all on function public.add_meeting_action_item(uuid, text, uuid, date) from public, anon;
grant execute on function public.add_meeting_action_item(uuid, text, uuid, date) to authenticated;

create or replace function public.update_meeting_action_item(
  p_action_id uuid,
  p_status text,
  p_note text default null
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_action public.meeting_action_items;
  v_meeting public.membership_meetings;
begin
  if auth.uid() is not null and not public.user_has_permission('meetings:manage') then
    raise exception
      'Updating a meeting action requires the meetings:manage capability.'
      using errcode = 'P0001';
  end if;

  select * into v_action
  from public.meeting_action_items where id = p_action_id for update;

  if not found then
    raise exception 'No such action item.' using errcode = 'P0001';
  end if;

  select * into v_meeting
  from public.membership_meetings where id = v_action.meeting_id;

  if not public.user_can_see_branch(v_meeting.branch_id) then
    raise exception
      'You cannot update that branch''s meeting actions.' using errcode = 'P0001';
  end if;

  if v_action.status in ('completed', 'cancelled') then
    raise exception
      'That action is already %.', v_action.status using errcode = 'P0001';
  end if;

  update public.meeting_action_items
     set status = p_status,
         completion_note = nullif(pg_catalog.btrim(coalesce(p_note, '')), ''),
         completed_at = case
           when p_status in ('completed', 'cancelled') then pg_catalog.now()
         end,
         completed_by = case
           when p_status in ('completed', 'cancelled')
             then public.current_profile_id()
         end,
         completed_by_label = case
           when p_status in ('completed', 'cancelled')
             then public.audit_actor_label()
         end
   where id = p_action_id;

  return p_action_id;
end;
$$;

comment on function public.update_meeting_action_item(uuid, text, text) is
  'Polytos Phase 4. Moves an action item along, stamping who closed it. An action that is already completed or cancelled is not reopened.';

revoke all on function public.update_meeting_action_item(uuid, text, text) from public, anon;
grant execute on function public.update_meeting_action_item(uuid, text, text) to authenticated;
