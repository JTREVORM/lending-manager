import { Badge } from '@/components/ui/badge';
import {
  MEETING_ACTION_STATUS_LABELS,
  MEETING_ATTENDANCE_LABELS,
  MEETING_STATUS_LABELS,
  MEETING_TYPE_LABELS,
  type MeetingActionStatus,
  type MeetingAttendance,
  type MeetingStatus,
  type MeetingType,
} from '@/lib/domain/meetings';

/**
 * The status pills for meetings.
 *
 * Tone never carries the meaning alone: every badge states its status in
 * words, so each reads correctly for a colour-blind member of staff and in a
 * printed register passed round a room.
 */

type Tone = 'success' | 'neutral' | 'warning' | 'danger' | 'info';

/**
 * `postponed` is amber and `cancelled` is neutral.
 *
 * The opposite of the instinct, and deliberate: a cancelled meeting is
 * finished business, while a postponed one is an arrangement somebody still
 * has to make and members are waiting on. The colour marks what needs doing,
 * not what sounds worst.
 */
const MEETING_TONES: Readonly<Record<MeetingStatus, Tone>> = {
  scheduled: 'info',
  held: 'success',
  cancelled: 'neutral',
  postponed: 'warning',
};

export function MeetingStatusBadge({ status }: { readonly status: MeetingStatus }) {
  return <Badge tone={MEETING_TONES[status]}>{MEETING_STATUS_LABELS[status]}</Badge>;
}

/** All neutral. The kind of meeting is a fact about it, not a judgement. */
export function MeetingTypeBadge({ type }: { readonly type: MeetingType }) {
  return <Badge tone="neutral">{MEETING_TYPE_LABELS[type]}</Badge>;
}

/**
 * Attendance, in four answers.
 *
 * `apology` and `represented` are **info** rather than amber, because neither
 * is a problem: a member who sent word is a member who engaged with the
 * meeting. Nothing in this system attaches a consequence to absence — the
 * client has not decided there is one — so the register must not imply a
 * penalty by colouring one answer as a warning.
 */
const ATTENDANCE_TONES: Readonly<Record<MeetingAttendance, Tone>> = {
  present: 'success',
  absent: 'neutral',
  apology: 'info',
  represented: 'info',
};

export function AttendanceBadge({ value }: { readonly value: MeetingAttendance }) {
  return <Badge tone={ATTENDANCE_TONES[value]}>{MEETING_ATTENDANCE_LABELS[value]}</Badge>;
}

const ACTION_TONES: Readonly<Record<MeetingActionStatus, Tone>> = {
  open: 'warning',
  in_progress: 'info',
  completed: 'success',
  cancelled: 'neutral',
};

export function MeetingActionBadge({
  status,
  overdue = false,
}: {
  readonly status: MeetingActionStatus;
  readonly overdue?: boolean;
}) {
  if (overdue) {
    // Overdue outranks the status, because it is the thing a reader has to
    // act on. The word is in the badge, not only the colour.
    return <Badge tone="danger">Overdue</Badge>;
  }

  return (
    <Badge tone={ACTION_TONES[status]}>{MEETING_ACTION_STATUS_LABELS[status]}</Badge>
  );
}
