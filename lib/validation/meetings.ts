/**
 * Validation for membership meetings, attendance, minutes and actions.
 *
 * ## What this layer decides, and what it must not
 *
 * Shape: that a meeting has a title and a venue somebody could find, that a
 * time is a time, that an attendance answer is one the register recognises,
 * that a correction carries a reason, that an amendment to finalised minutes
 * says what changed.
 *
 * Not policy, and in this module there is barely any policy to have: the
 * client's documents say monthly meetings happen and say nothing about a
 * mandatory day, a quorum, or a consequence for missing one. So nothing here
 * imposes a weekday, an hour, a minimum attendance or a penalty — and that
 * absence is the design rather than an omission. See `lib/domain/meetings.ts`.
 *
 * The branch rule *is* a control, and it is not here: a caller may only
 * convene, move, cancel or mark a register at a branch they can see, and
 * `schedule_membership_meeting` and its siblings each check that inside the
 * database, because a SECURITY DEFINER function has no policies applied to it.
 *
 * ## Africa/Kampala
 *
 * A `datetime-local` input sends no offset. Every instant below is therefore
 * read in the business timezone, because a meeting at 00:30 on 1 November
 * announced as November's would be filed in October if the value were read as
 * UTC — and `meeting_date` is a generated column, so the mistake would be
 * permanent.
 */

import { z } from 'zod';

import {
  MEETING_ABSENCE_REASONS,
  MEETING_ATTENDANCE_VALUES,
  MEETING_ACTION_STATUSES,
  MEETING_STATUSES,
  MEETING_TYPES,
} from '@/lib/domain/meetings';
import { businessDateSchema, optionalString, uuidSchema } from './common';

/**
 * An instant from a form, interpreted in Africa/Kampala.
 *
 * The same transform the benefit schemas use for an admission time, and for
 * the same reason.
 */
export const meetingInstantSchema = z
  .string()
  .trim()
  .min(1, 'Enter the date and time of the meeting.')
  .regex(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/,
    'Enter a date and a time, for example 2026-11-14T14:00.',
  )
  .transform((value) => `${value.length === 16 ? `${value}:00` : value}+03:00`);

export const meetingTypeSchema = z.enum(MEETING_TYPES, {
  error: 'Choose the kind of meeting.',
});

export const meetingStatusSchema = z.enum(MEETING_STATUSES);

export const meetingReasonSchema = z
  .string()
  .trim()
  .min(3, 'Say why. Members will have arranged their day around the old arrangement.')
  .max(1000, 'That is too long for a reason.');

/**
 * Scheduling a meeting.
 *
 * The venue is free text and required. Free text because a venue in Kampala is
 * a description rather than an address — "the back room at the Kyanja office",
 * "Mukasa's compound" — and a structured address field would be filled with
 * one of those anyway. Required because a meeting nobody can find is not a
 * meeting.
 *
 * The agenda is optional. An agenda is read aloud rather than queried, which
 * is why it is one text field and not a table of items nothing ever joins to.
 */
export const scheduleMeetingSchema = z.object({
  branchId: uuidSchema,
  meetingType: meetingTypeSchema,
  title: z
    .string()
    .trim()
    .min(3, 'Give the meeting a title members will recognise.')
    .max(200, 'That title is too long.'),
  venue: z
    .string()
    .trim()
    .min(3, 'Say where it is. A meeting nobody can find is not a meeting.')
    .max(200, 'That is too long for a venue.'),
  scheduledAt: meetingInstantSchema,
  agenda: optionalString(8000),
});

export type ScheduleMeetingInput = z.infer<typeof scheduleMeetingSchema>;

export const rescheduleMeetingSchema = z.object({
  meetingId: uuidSchema,
  scheduledAt: meetingInstantSchema,
  reason: meetingReasonSchema,
  /** A move often comes with a new venue, and often does not. */
  venue: optionalString(200),
});

export const cancelMeetingSchema = z.object({
  meetingId: uuidSchema,
  reason: meetingReasonSchema,
});

/**
 * Marking or correcting one member's attendance.
 *
 * `correctionReason` is optional here and required by the database **only when
 * the answer actually changes**. That asymmetry is deliberate and cannot be
 * expressed at this layer: whether this is a correction depends on what the
 * register already says, which only the database knows. So the same submission
 * is a no-op on a double tap and a refusal on a silent change, and
 * `mark_meeting_attendance` is what tells the two apart.
 */
export const markAttendanceSchema = z
  .object({
    meetingId: uuidSchema,
    membershipId: uuidSchema,
    attendance: z.enum(MEETING_ATTENDANCE_VALUES, {
      error: 'Say whether the member came.',
    }),
    absenceReason: z.enum(MEETING_ABSENCE_REASONS).nullable().optional(),
    note: optionalString(500),
    correctionReason: optionalString(500),
  })
  .superRefine((value, ctx) => {
    if (value.attendance === 'present' && (value.absenceReason ?? null) !== null) {
      ctx.addIssue({
        code: 'custom',
        path: ['absenceReason'],
        message: 'A member who was present has no reason for being away.',
      });
    }
  });

export type MarkAttendanceInput = z.infer<typeof markAttendanceSchema>;

/**
 * Writing or amending minutes.
 *
 * `amendmentNote` is required by the database once the minutes are finalised,
 * and the same asymmetry applies: whether this is an amendment depends on
 * whether anybody has finalised them, which the database knows and a form does
 * not. `record_meeting_minutes` refuses a silent edit with a message saying
 * so.
 */
export const recordMinutesSchema = z.object({
  meetingId: uuidSchema,
  minutes: z
    .string()
    .trim()
    .min(3, 'There are no minutes in that.')
    .max(20_000, 'Those minutes are too long to store. Attach the long version.'),
  amendmentNote: optionalString(2000),
});

export const finaliseMinutesSchema = z.object({ meetingId: uuidSchema });

export const addActionItemSchema = z.object({
  meetingId: uuidSchema,
  description: z
    .string()
    .trim()
    .min(3, 'Say what is to be done.')
    .max(1000, 'That is too long. Record the detail in the minutes.'),
  /**
   * A staff profile, not a typed name. "Somebody will look into it" is how an
   * action item becomes nobody's, and the database refuses an assignee whose
   * account is not active.
   */
  assignedTo: uuidSchema.nullable().optional(),
  dueOn: businessDateSchema.nullable().optional(),
});

export const updateActionItemSchema = z.object({
  actionId: uuidSchema,
  status: z.enum(MEETING_ACTION_STATUSES, { error: 'Choose a status.' }),
  note: optionalString(1000),
});

/**
 * The meetings list's filters.
 *
 * A malformed filter falls back to the default view, as every register here
 * does: the filter is a convenience, and which meetings a caller may see is
 * decided by Row Level Security whatever the query string says.
 */
export const meetingSearchSchema = z.object({
  query: z
    .string()
    .trim()
    .max(80)
    .transform((value) => (value === '' ? null : value))
    .nullable()
    .default(null),
  status: z.enum([...MEETING_STATUSES, 'all', 'upcoming']).default('all'),
  type: z.enum([...MEETING_TYPES, 'all']).default('all'),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
});

export type MeetingSearch = z.infer<typeof meetingSearchSchema>;
