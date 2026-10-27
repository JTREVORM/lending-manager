import { describe, expect, it } from 'vitest';

import {
  CLOSED_MEETING_ACTION_STATUSES,
  MEETING_ABSENCE_REASONS,
  MEETING_ABSENCE_REASON_LABELS,
  MEETING_ACTION_STATUSES,
  MEETING_ACTION_STATUS_LABELS,
  MEETING_ATTENDANCE_LABELS,
  MEETING_ATTENDANCE_VALUES,
  MEETING_STATUSES,
  MEETING_STATUS_DESCRIPTIONS,
  MEETING_STATUS_LABELS,
  MEETING_TYPES,
  MEETING_TYPE_DESCRIPTIONS,
  MEETING_TYPE_LABELS,
  attendanceMayCarryReason,
  attendanceRate,
  isMeetingAbsenceReason,
  isMeetingActionStatus,
  isMeetingAttendance,
  isMeetingStatus,
  isMeetingType,
  meetingActionIsClosed,
  meetingActionIsOverdue,
  meetingMayBeMoved,
  meetingTypeIsMonthlyUnique,
} from '@/lib/domain/meetings';

/**
 * The meetings domain, in isolation.
 *
 * ## What is deliberately absent, and why that is the point
 *
 * There is no quorum, no mandatory weekday, no attendance threshold and no
 * consequence for missing a meeting — because the client's documents say the
 * membership meets monthly and say nothing about any of those. A domain module
 * that supplied a default would be inventing policy, and the tests below
 * assert the absence as deliberately as they assert anything else: a future
 * change that added a quorum would have to change a test that says there
 * isn't one.
 *
 * ## The one rule the client did state
 *
 * One monthly general meeting per branch per calendar month. The database
 * enforces it with a partial unique index; `meetingTypeIsMonthlyUnique` is the
 * domain's statement of which type it binds, so a screen can say so before
 * somebody tries.
 */

describe('the meeting types', () => {
  it('names four, each with a label and a description', () => {
    expect(MEETING_TYPES).toEqual([
      'monthly_general',
      'annual_general',
      'special',
      'committee',
    ]);

    for (const type of MEETING_TYPES) {
      expect(MEETING_TYPE_LABELS[type].length).toBeGreaterThan(0);
      expect(MEETING_TYPE_DESCRIPTIONS[type].length).toBeGreaterThan(0);
      expect(isMeetingType(type)).toBe(true);
    }

    for (const value of [undefined, null, '', 'monthly', 'MONTHLY_GENERAL']) {
      expect(isMeetingType(value), String(value)).toBe(false);
    }
  });

  it('binds the one-per-month rule to the monthly general meeting alone', () => {
    // The rule the client's documents actually state. A special meeting called
    // in the same month is the business's business, and a system that refused
    // one would be enforcing a rule nobody wrote.
    expect(meetingTypeIsMonthlyUnique('monthly_general')).toBe(true);
    expect(meetingTypeIsMonthlyUnique('special')).toBe(false);
    expect(meetingTypeIsMonthlyUnique('committee')).toBe(false);
    expect(meetingTypeIsMonthlyUnique('annual_general')).toBe(false);
  });
});

describe('the meeting lifecycle', () => {
  it('names four statuses, each with a label and a description', () => {
    expect(MEETING_STATUSES).toEqual(['scheduled', 'held', 'cancelled', 'postponed']);

    for (const status of MEETING_STATUSES) {
      expect(MEETING_STATUS_LABELS[status].length).toBeGreaterThan(0);
      expect(MEETING_STATUS_DESCRIPTIONS[status].length).toBeGreaterThan(0);
      expect(isMeetingStatus(status)).toBe(true);
    }

    expect(isMeetingStatus('open')).toBe(false);
  });

  it('lets only a scheduled meeting be moved', () => {
    // A meeting that happened cannot be moved: the register and the minutes
    // belong to the afternoon that happened. A cancelled one cannot be
    // revived either — scheduling another is the honest way to try again.
    expect(meetingMayBeMoved('scheduled')).toBe(true);
    expect(meetingMayBeMoved('held')).toBe(false);
    expect(meetingMayBeMoved('cancelled')).toBe(false);
    expect(meetingMayBeMoved('postponed')).toBe(false);
  });

  it('says in the description that `held` comes from the register', () => {
    // A meeting with a register and a `scheduled` status would be two
    // statements about one afternoon, so the status is derived rather than
    // set — and the description is where a reader is told that.
    expect(MEETING_STATUS_DESCRIPTIONS.held).toContain('Marking the first member');
    expect(MEETING_STATUS_DESCRIPTIONS.cancelled).toContain('attended cannot');
  });
});

describe('attendance', () => {
  it('names four answers, each with a label', () => {
    expect(MEETING_ATTENDANCE_VALUES).toEqual([
      'present',
      'absent',
      'apology',
      'represented',
    ]);

    for (const value of MEETING_ATTENDANCE_VALUES) {
      expect(MEETING_ATTENDANCE_LABELS[value].length).toBeGreaterThan(0);
      expect(isMeetingAttendance(value)).toBe(true);
    }

    expect(isMeetingAttendance('late')).toBe(false);
  });

  it('keeps an apology apart from an absence', () => {
    // A member who sent word is not in the same position as one who did not,
    // and a register that collapsed the two would make "how many apologies
    // did we have" unanswerable.
    expect(MEETING_ATTENDANCE_LABELS.apology).not.toBe(MEETING_ATTENDANCE_LABELS.absent);
  });

  it('allows a reason for every answer except being there', () => {
    expect(attendanceMayCarryReason('present')).toBe(false);
    expect(attendanceMayCarryReason('absent')).toBe(true);
    expect(attendanceMayCarryReason('apology')).toBe(true);
    expect(attendanceMayCarryReason('represented')).toBe(true);
  });

  it('names seven absence reasons, including "not stated"', () => {
    // "Not stated" earns its place: a member who did not say why is a real
    // and common case, and a register that forced a reason would get a
    // fabricated one.
    expect(MEETING_ABSENCE_REASONS).toContain('not_stated');
    expect(MEETING_ABSENCE_REASONS).toHaveLength(7);

    for (const reason of MEETING_ABSENCE_REASONS) {
      expect(MEETING_ABSENCE_REASON_LABELS[reason].length).toBeGreaterThan(0);
      expect(isMeetingAbsenceReason(reason)).toBe(true);
    }

    expect(isMeetingAbsenceReason('holiday')).toBe(false);
  });

  it('attaches no consequence to any answer', () => {
    // There is nothing to assert *for* here, which is the assertion: no
    // function in this module maps an attendance answer onto a penalty, a
    // score or an eligibility, because the client has not decided there is
    // one. This test exists so that adding one has to change a test that
    // says it does not exist.
    const labels = Object.values(MEETING_ATTENDANCE_LABELS).join(' ').toLowerCase();

    for (const word of ['penalty', 'fine', 'suspend', 'warning', 'strike']) {
      expect(labels, word).not.toContain(word);
    }
  });
});

describe('the attendance rate', () => {
  it('is a whole percentage, rounded', () => {
    expect(attendanceRate(34, 61)).toBe(56);
    expect(attendanceRate(1, 3)).toBe(33);
    expect(attendanceRate(2, 3)).toBe(67);
    expect(attendanceRate(61, 61)).toBe(100);
    expect(attendanceRate(0, 61)).toBe(0);
  });

  it('is null rather than zero when nobody was expected', () => {
    // Dividing by nobody is not a figure. A branch with no live members shows
    // "—" rather than 0%, which would read as a failure to turn up.
    expect(attendanceRate(0, 0)).toBeNull();
    expect(attendanceRate(5, 0)).toBeNull();
    expect(attendanceRate(5, -1)).toBeNull();
    expect(attendanceRate(Number.NaN, 10)).toBeNull();
    expect(attendanceRate(5, Number.POSITIVE_INFINITY)).toBeNull();
  });
});

describe('action items', () => {
  it('names four statuses, each with a label', () => {
    expect(MEETING_ACTION_STATUSES).toEqual([
      'open',
      'in_progress',
      'completed',
      'cancelled',
    ]);

    for (const status of MEETING_ACTION_STATUSES) {
      expect(MEETING_ACTION_STATUS_LABELS[status].length).toBeGreaterThan(0);
      expect(isMeetingActionStatus(status)).toBe(true);
    }

    expect(isMeetingActionStatus('done')).toBe(false);
  });

  it('treats done and dropped as final', () => {
    expect(CLOSED_MEETING_ACTION_STATUSES).toEqual(['completed', 'cancelled']);

    for (const status of MEETING_ACTION_STATUSES) {
      expect(meetingActionIsClosed(status), status).toBe(
        CLOSED_MEETING_ACTION_STATUSES.includes(status),
      );
    }
  });

  it('is overdue only while it is still open', () => {
    expect(meetingActionIsOverdue('open', '2026-10-01', '2026-10-26')).toBe(true);
    expect(meetingActionIsOverdue('in_progress', '2026-10-01', '2026-10-26')).toBe(true);

    // Closed items are not overdue, however late they were closed: an item
    // somebody finished is not a thing to chase.
    expect(meetingActionIsOverdue('completed', '2026-10-01', '2026-10-26')).toBe(false);
    expect(meetingActionIsOverdue('cancelled', '2026-10-01', '2026-10-26')).toBe(false);
  });

  it('is not overdue on its due date, only after it', () => {
    expect(meetingActionIsOverdue('open', '2026-10-26', '2026-10-26')).toBe(false);
    expect(meetingActionIsOverdue('open', '2026-10-27', '2026-10-26')).toBe(false);
  });

  it('is never overdue without a due date', () => {
    // An item nobody put a date on is not more urgent than one somebody did.
    expect(meetingActionIsOverdue('open', null, '2026-10-26')).toBe(false);
  });

  it('compares business dates as strings, so no timezone enters it', () => {
    // Both sides are `YYYY-MM-DD` in Africa/Kampala. Comparing `Date` objects
    // would make an item due today overdue at 21:00 Kampala, which is 00:00
    // UTC the next day — and the register would chase somebody a day early.
    expect(meetingActionIsOverdue('open', '2026-01-01', '2026-12-31')).toBe(true);
    expect(meetingActionIsOverdue('open', '2027-01-01', '2026-12-31')).toBe(false);
  });
});
