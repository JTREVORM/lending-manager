/**
 * The meetings domain: the vocabulary, the labels, and the one rule worth
 * stating in code.
 *
 * ## The rule is an absence, and it is deliberate
 *
 * The client's documents say the company intends to hold monthly membership
 * meetings. They do **not** say that missing one suspends a membership,
 * disqualifies savings, blocks a loan, blocks a benefit or reduces a profit
 * share. §15 of the Phase 4 brief says so in those words.
 *
 * So there is nothing in this module that derives a consequence from
 * attendance, and nothing in the schema either: no `consecutive_absences`
 * column, no standing calculation, no gate anywhere that reads the register.
 * `tests/db/meetings.test.ts` asserts that absence mechanically, because an
 * absence that is only documented is one somebody builds a feature on top of
 * next year.
 *
 * It would have been easy to add a rule and a threshold. A business that
 * suspended a member over an attendance rule nobody had written down would
 * have done real harm on this system's authority, and the honest
 * implementation of a requirement that stops at "hold meetings and keep
 * records" is a module that holds meetings and keeps records.
 *
 * ## Africa/Kampala
 *
 * A meeting happens at an instant and belongs to a month. `scheduled_at` is
 * the instant; `meeting_date` is a generated column holding its Kampala
 * calendar day, so the two cannot disagree and a 00:30 meeting on 1 November
 * is November's rather than October's — which it would be if the month were
 * derived in UTC.
 *
 * No mandatory day or hour is invented here. The documents say monthly, so
 * nothing in this module says more.
 */

// ---------------------------------------------------------------------------
// Meetings
// ---------------------------------------------------------------------------

/**
 * The kinds of meeting the programme holds.
 *
 * `monthly_general` is the one the documents promise, and the only one the
 * database limits to once per branch per month. The other three exist because
 * a business that can only record its promised meeting has to keep the rest on
 * paper.
 *
 * Mirrors `membership_meeting_type_valid`.
 */
export const MEETING_TYPES = [
  'monthly_general',
  'annual_general',
  'special',
  'committee',
] as const;

export type MeetingType = (typeof MEETING_TYPES)[number];

export function isMeetingType(value: unknown): value is MeetingType {
  return (
    typeof value === 'string' && (MEETING_TYPES as readonly string[]).includes(value)
  );
}

export const MEETING_TYPE_LABELS: Readonly<Record<MeetingType, string>> = {
  monthly_general: 'Monthly general meeting',
  annual_general: 'Annual general meeting',
  special: 'Special meeting',
  committee: 'Committee meeting',
} as const;

export const MEETING_TYPE_DESCRIPTIONS: Readonly<Record<MeetingType, string>> = {
  monthly_general:
    'The meeting the membership programme holds every month. One per branch per month.',
  annual_general: 'The yearly meeting of the whole membership.',
  special: 'A meeting called for a particular purpose.',
  committee: 'A meeting of a committee rather than of the membership.',
} as const;

/** Only the monthly general meeting is limited to one per branch per month. */
export function meetingTypeIsMonthlyUnique(type: MeetingType): boolean {
  return type === 'monthly_general';
}

export const MEETING_STATUSES = ['scheduled', 'held', 'cancelled', 'postponed'] as const;
export type MeetingStatus = (typeof MEETING_STATUSES)[number];

export function isMeetingStatus(value: unknown): value is MeetingStatus {
  return (
    typeof value === 'string' && (MEETING_STATUSES as readonly string[]).includes(value)
  );
}

export const MEETING_STATUS_LABELS: Readonly<Record<MeetingStatus, string>> = {
  scheduled: 'Scheduled',
  held: 'Held',
  cancelled: 'Cancelled',
  postponed: 'Postponed',
} as const;

export const MEETING_STATUS_DESCRIPTIONS: Readonly<Record<MeetingStatus, string>> = {
  scheduled: 'Announced and still to happen.',
  held: 'It happened. Marking the first member present moves a meeting here.',
  cancelled: 'Called off, with a reason. A meeting people attended cannot be.',
  postponed: 'Deferred without a new date yet.',
} as const;

/**
 * Whether a meeting may still be moved or called off.
 *
 * A meeting that has been held cannot: the register and the minutes belong to
 * the afternoon that happened, and a cancelled meeting cannot be revived
 * either — scheduling another is the honest way to try again, and the monthly
 * index is written to allow exactly that.
 */
export function meetingMayBeMoved(status: MeetingStatus): boolean {
  return status === 'scheduled';
}

// ---------------------------------------------------------------------------
// Attendance
// ---------------------------------------------------------------------------

/**
 * How a member is recorded for a meeting.
 *
 * Four values, and the distinction between `absent` and `apology` is the one
 * that earns its place: a member who sent word is not in the same position as
 * one who did not, and a register that collapsed the two would make
 * "how many apologies did we have" unanswerable.
 *
 * `represented` is for a member whose family member came instead, which is
 * ordinary in Kampala and which neither `present` nor `absent` describes.
 *
 * Mirrors `meeting_attendance_valid`.
 */
export const MEETING_ATTENDANCE_VALUES = [
  'present',
  'absent',
  'apology',
  'represented',
] as const;

export type MeetingAttendance = (typeof MEETING_ATTENDANCE_VALUES)[number];

export function isMeetingAttendance(value: unknown): value is MeetingAttendance {
  return (
    typeof value === 'string' &&
    (MEETING_ATTENDANCE_VALUES as readonly string[]).includes(value)
  );
}

export const MEETING_ATTENDANCE_LABELS: Readonly<Record<MeetingAttendance, string>> = {
  present: 'Present',
  absent: 'Absent',
  apology: 'Apologies',
  represented: 'Represented',
} as const;

/** Whether this answer may carry a reason for being away. */
export function attendanceMayCarryReason(value: MeetingAttendance): boolean {
  return value !== 'present';
}

/**
 * The permitted reasons for being away.
 *
 * A closed list, because a free text field here fills up with "?" and a closed
 * list is what makes "how many were away travelling" answerable.
 * `not_stated` is in it deliberately: a clerk who does not know should be able
 * to say so rather than guess, and a NULL would read the same as not having
 * asked.
 *
 * Mirrors `meeting_attendance_reason_valid`.
 */
export const MEETING_ABSENCE_REASONS = [
  'illness',
  'travel',
  'work',
  'bereavement',
  'family',
  'not_stated',
  'other',
] as const;

export type MeetingAbsenceReason = (typeof MEETING_ABSENCE_REASONS)[number];

export function isMeetingAbsenceReason(value: unknown): value is MeetingAbsenceReason {
  return (
    typeof value === 'string' &&
    (MEETING_ABSENCE_REASONS as readonly string[]).includes(value)
  );
}

export const MEETING_ABSENCE_REASON_LABELS: Readonly<
  Record<MeetingAbsenceReason, string>
> = {
  illness: 'Illness',
  travel: 'Travelling',
  work: 'At work',
  bereavement: 'A bereavement',
  family: 'Family matters',
  not_stated: 'Not stated',
  other: 'Another reason',
} as const;

/**
 * How many members came, as a proportion of those expected.
 *
 * A figure for a register header, and nothing reads it to decide anything.
 * Returns `null` rather than zero when nobody is expected, because a
 * percentage of nothing is not nought — it is a question that does not apply,
 * and showing "0%" for a branch with no members would read as a failure.
 */
export function attendanceRate(present: number, expected: number): number | null {
  if (!Number.isFinite(present) || !Number.isFinite(expected) || expected <= 0) {
    return null;
  }

  return Math.round((present / expected) * 100);
}

// ---------------------------------------------------------------------------
// Action items
// ---------------------------------------------------------------------------

export const MEETING_ACTION_STATUSES = [
  'open',
  'in_progress',
  'completed',
  'cancelled',
] as const;

export type MeetingActionStatus = (typeof MEETING_ACTION_STATUSES)[number];

export function isMeetingActionStatus(value: unknown): value is MeetingActionStatus {
  return (
    typeof value === 'string' &&
    (MEETING_ACTION_STATUSES as readonly string[]).includes(value)
  );
}

export const MEETING_ACTION_STATUS_LABELS: Readonly<Record<MeetingActionStatus, string>> =
  {
    open: 'Open',
    in_progress: 'In hand',
    completed: 'Done',
    cancelled: 'Dropped',
  } as const;

/** Statuses from which an action item no longer moves. */
export const CLOSED_MEETING_ACTION_STATUSES: readonly MeetingActionStatus[] = [
  'completed',
  'cancelled',
] as const;

export function meetingActionIsClosed(status: MeetingActionStatus): boolean {
  return CLOSED_MEETING_ACTION_STATUSES.includes(status);
}

/**
 * Whether an action item is past its due date and still outstanding.
 *
 * Both dates are business dates — `YYYY-MM-DD` strings in Africa/Kampala — so
 * the comparison is a string comparison and no timezone enters it. Comparing
 * `Date` objects here would make an action due today overdue at 21:00 Kampala,
 * which is 00:00 UTC the next day.
 */
export function meetingActionIsOverdue(
  status: MeetingActionStatus,
  dueOn: string | null,
  businessDate: string,
): boolean {
  if (dueOn === null || meetingActionIsClosed(status)) return false;
  return dueOn < businessDate;
}
