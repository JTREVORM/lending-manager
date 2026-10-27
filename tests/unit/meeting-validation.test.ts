import { describe, expect, it } from 'vitest';

import {
  addActionItemSchema,
  cancelMeetingSchema,
  finaliseMinutesSchema,
  markAttendanceSchema,
  meetingInstantSchema,
  meetingSearchSchema,
  recordMinutesSchema,
  rescheduleMeetingSchema,
  scheduleMeetingSchema,
  updateActionItemSchema,
} from '@/lib/validation/meetings';

/**
 * The edge of the meetings write surface.
 *
 * As with every validation suite here, this is not the control: the branch
 * rule, the one-per-month rule and the correction rule are all enforced inside
 * the database, because a `SECURITY DEFINER` function has no policies applied
 * to it. What these tests protect is that a person is told what is wrong
 * before they commit.
 *
 * ## What is deliberately not here
 *
 * No weekday, no hour, no quorum, no minimum attendance, no penalty. The
 * client's documents say the membership meets monthly and say nothing about
 * any of those, so the schemas impose none of them — and these tests assert
 * the absence, so adding one has to change a test that says it is not there.
 *
 * ## The two asymmetries the database owns and a form cannot
 *
 * A correction reason is required only when an answer actually *changes*, and
 * an amendment note only once minutes have been *finalised*. Both depend on
 * what is already recorded, which only the database knows — so the schemas
 * accept the submission either way and the functions refuse the silent edit.
 */

const UUID = '00000000-0000-4000-8000-000000000001';
const OTHER_UUID = '00000000-0000-4000-8000-000000000002';

describe('the meeting instant', () => {
  it('appends the business offset, as the benefit schemas do', () => {
    // A meeting at 00:30 on 1 November announced as November's would be filed
    // in October if the value were read as UTC — and `meeting_date` is a
    // generated column, so the mistake would be permanent.
    expect(meetingInstantSchema.parse('2026-11-14T14:00')).toBe(
      '2026-11-14T14:00:00+03:00',
    );
  });

  it('refuses a date with no time', () => {
    expect(meetingInstantSchema.safeParse('2026-11-14').success).toBe(false);
    expect(meetingInstantSchema.safeParse('').success).toBe(false);
  });
});

describe('scheduling a meeting', () => {
  const valid = {
    branchId: UUID,
    meetingType: 'monthly_general',
    title: 'November general meeting',
    venue: 'The branch hall, Kalerwe',
    scheduledAt: '2026-11-14T14:00',
  };

  it('accepts a title, a venue and a time', () => {
    expect(scheduleMeetingSchema.safeParse(valid).success).toBe(true);
  });

  it('requires a venue, because a meeting nobody can find is not a meeting', () => {
    expect(scheduleMeetingSchema.safeParse({ ...valid, venue: '' }).success).toBe(false);
    expect(scheduleMeetingSchema.safeParse({ ...valid, venue: 'X' }).success).toBe(false);
  });

  it('accepts a venue that is a description rather than an address', () => {
    // A venue in Kampala is "the back room at the Kyanja office" or
    // "Mukasa's compound". A structured address field would be filled with
    // one of those anyway.
    expect(
      scheduleMeetingSchema.safeParse({ ...valid, venue: "Mukasa's compound, Bwaise" })
        .success,
    ).toBe(true);
  });

  it('takes the agenda as one optional field', () => {
    // An agenda is read aloud rather than queried, which is why it is one
    // text field and not a table of items nothing ever joins to.
    expect(scheduleMeetingSchema.safeParse({ ...valid, agenda: undefined }).success).toBe(
      true,
    );
    expect(
      scheduleMeetingSchema.safeParse({ ...valid, agenda: '1. Savings\n2. Benefits' })
        .success,
    ).toBe(true);
  });

  it('imposes no weekday, no hour and no quorum', () => {
    // A Sunday at 06:00 is accepted, because nobody has said it should not
    // be. The absence is the design.
    const sunday = scheduleMeetingSchema.safeParse({
      ...valid,
      scheduledAt: '2026-11-15T06:00',
    });

    expect(sunday.success).toBe(true);
    if (sunday.success) {
      // Six fields, and `agenda` only when one was given. Not one of them is
      // a weekday, an hour, a quorum or an attendance threshold.
      expect(Object.keys(sunday.data).sort()).toEqual([
        'branchId',
        'meetingType',
        'scheduledAt',
        'title',
        'venue',
      ]);
    }
  });

  it('refuses a meeting type the register does not recognise', () => {
    expect(
      scheduleMeetingSchema.safeParse({ ...valid, meetingType: 'agm' }).success,
    ).toBe(false);
  });
});

describe('moving and calling off a meeting', () => {
  it('requires a reason for both', () => {
    // Members arrange their day around a meeting, and the reason is carried
    // into the notification they receive.
    expect(
      rescheduleMeetingSchema.safeParse({
        meetingId: UUID,
        scheduledAt: '2026-11-21T14:00',
        reason: '',
      }).success,
    ).toBe(false);

    expect(cancelMeetingSchema.safeParse({ meetingId: UUID, reason: 'No' }).success).toBe(
      false,
    );

    expect(
      cancelMeetingSchema.safeParse({
        meetingId: UUID,
        reason: 'The hall was unavailable.',
      }).success,
    ).toBe(true);
  });

  it('takes a new venue and does not require one', () => {
    // A move often comes with a new venue, and often does not.
    expect(
      rescheduleMeetingSchema.safeParse({
        meetingId: UUID,
        scheduledAt: '2026-11-21T14:00',
        reason: 'The hall was unavailable.',
      }).success,
    ).toBe(true);
  });
});

describe('marking the register', () => {
  it('accepts the four answers and nothing else', () => {
    for (const attendance of ['present', 'absent', 'apology', 'represented']) {
      expect(
        markAttendanceSchema.safeParse({
          meetingId: UUID,
          membershipId: OTHER_UUID,
          attendance,
        }).success,
        attendance,
      ).toBe(true);
    }

    expect(
      markAttendanceSchema.safeParse({
        meetingId: UUID,
        membershipId: OTHER_UUID,
        attendance: 'late',
      }).success,
    ).toBe(false);
  });

  it('refuses a reason for being away on a member who was there', () => {
    const refused = markAttendanceSchema.safeParse({
      meetingId: UUID,
      membershipId: OTHER_UUID,
      attendance: 'present',
      absenceReason: 'travel',
    });

    expect(refused.success).toBe(false);
    if (!refused.success) {
      expect(refused.error.issues[0]?.path).toEqual(['absenceReason']);
    }
  });

  it('leaves the correction reason optional, because only the database knows', () => {
    // Whether this is a correction depends on what the register already says.
    // So the same submission is valid either way and
    // `mark_meeting_attendance` refuses a changed answer with no reason.
    expect(
      markAttendanceSchema.safeParse({
        meetingId: UUID,
        membershipId: OTHER_UUID,
        attendance: 'present',
      }).success,
    ).toBe(true);

    expect(
      markAttendanceSchema.safeParse({
        meetingId: UUID,
        membershipId: OTHER_UUID,
        attendance: 'present',
        correctionReason: 'Marked absent in error.',
      }).success,
    ).toBe(true);
  });
});

describe('the minutes', () => {
  it('refuses minutes with nothing in them', () => {
    expect(recordMinutesSchema.safeParse({ meetingId: UUID, minutes: '' }).success).toBe(
      false,
    );
    expect(
      recordMinutesSchema.safeParse({ meetingId: UUID, minutes: 'ok' }).success,
    ).toBe(false);
  });

  it('leaves the amendment note optional, for the same reason', () => {
    // Whether this is an amendment depends on whether anybody has finalised
    // them, which the database knows and a form does not.
    expect(
      recordMinutesSchema.safeParse({
        meetingId: UUID,
        minutes: 'The meeting reviewed savings for the month.',
      }).success,
    ).toBe(true);
  });

  it('takes nothing but the meeting to finalise', () => {
    const parsed = finaliseMinutesSchema.safeParse({ meetingId: UUID, note: 'x' });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(Object.keys(parsed.data)).toEqual(['meetingId']);
  });
});

describe('action items', () => {
  it('requires something to be done', () => {
    expect(
      addActionItemSchema.safeParse({ meetingId: UUID, description: '' }).success,
    ).toBe(false);

    expect(
      addActionItemSchema.safeParse({
        meetingId: UUID,
        description: 'Visit the members who have not saved this month.',
      }).success,
    ).toBe(true);
  });

  it('takes an assignee as a profile, never as a typed name', () => {
    // "Somebody will look into it" is how an action item becomes nobody's,
    // and a free-text name cannot be notified, listed on a dashboard, or
    // checked against an account that still exists.
    expect(
      addActionItemSchema.safeParse({
        meetingId: UUID,
        description: 'Collect next of kin details.',
        assignedTo: 'Grace',
      }).success,
    ).toBe(false);

    expect(
      addActionItemSchema.safeParse({
        meetingId: UUID,
        description: 'Collect next of kin details.',
        assignedTo: OTHER_UUID,
      }).success,
    ).toBe(true);
  });

  it('accepts an item with no owner and no date', () => {
    // Both are real and ordinary states, and a form that insisted would get a
    // fabricated answer for each.
    const parsed = addActionItemSchema.safeParse({
      meetingId: UUID,
      description: 'Agree what a member who misses three meetings should expect.',
    });

    expect(parsed.success).toBe(true);
  });

  it('refuses a due date that is not a date', () => {
    expect(
      addActionItemSchema.safeParse({
        meetingId: UUID,
        description: 'Collect next of kin details.',
        dueOn: 'next month',
      }).success,
    ).toBe(false);
  });

  it('takes a status and an optional note on an update', () => {
    expect(
      updateActionItemSchema.safeParse({ actionId: UUID, status: 'done' }).success,
    ).toBe(false);

    expect(
      updateActionItemSchema.safeParse({ actionId: UUID, status: 'completed' }).success,
    ).toBe(true);

    expect(
      updateActionItemSchema.safeParse({
        actionId: UUID,
        status: 'cancelled',
        note: 'Overtaken by the policy decision.',
      }).success,
    ).toBe(true);
  });
});

describe('the meetings list filters', () => {
  it('defaults to everything, and offers "upcoming"', () => {
    const parsed = meetingSearchSchema.safeParse({});
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data).toEqual({ query: null, status: 'all', type: 'all', page: 1 });
    }

    // Scheduled meetings still in the future — what somebody asking "when is
    // the next one" wants, and what no single column holds.
    expect(meetingSearchSchema.safeParse({ status: 'upcoming' }).success).toBe(true);
    expect(meetingSearchSchema.safeParse({ status: 'nonsense' }).success).toBe(false);
  });
});
