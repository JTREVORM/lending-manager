import 'server-only';

import { mapDatabaseError } from '@/lib/db-errors';
import { logger } from '@/lib/logger';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import type {
  MeetingAbsenceReason,
  MeetingActionStatus,
  MeetingAttendance,
  MeetingStatus,
  MeetingType,
} from '@/lib/domain/meetings';
import type { MeetingSearch } from '@/lib/validation/meetings';

/**
 * Reading meetings.
 *
 * Every query runs as the signed-in caller, so the policies decide what comes
 * back and none of these functions contains a capability check. A caller
 * without `meetings:view` gets nothing — not an error, nothing — which is the
 * right answer for a register they are not on.
 *
 * ## Why `expected_members` is named the way it is
 *
 * The register reports a branch's live memberships at *read* time, not at
 * meeting time. A membership withdrawn since October was still expected at
 * October's meeting, and recording the expected roll as of each day would need
 * a snapshot table nobody asked for. So the column says `expected_members`
 * rather than implying it is a historical figure, and `attendanceRate` divides
 * by it with that caveat attached.
 *
 * ## Nothing here derives a consequence
 *
 * No function in this module computes a standing, a penalty or an
 * eligibility. The client's documents do not make attendance a condition of
 * savings, a loan, a benefit or a profit share, so nothing in the schema or in
 * this module does either — and `tests/db/meetings.test.ts` asserts that
 * absence mechanically.
 */

const MEETING_PAGE_SIZE = 25;

function escapeSearchTerm(term: string): string {
  return term.replace(/[\\%_,()]/g, (match) => `\\${match}`);
}

// ---------------------------------------------------------------------------
// Meetings
// ---------------------------------------------------------------------------

export interface MeetingSummary {
  readonly id: string;
  readonly meetingNumber: string;
  readonly branchId: string;
  readonly branchName: string;
  readonly meetingType: MeetingType;
  readonly title: string;
  readonly venue: string;
  readonly scheduledAt: string;
  readonly meetingDate: string;
  readonly status: MeetingStatus;
  readonly agenda: string | null;
  readonly minutes: string | null;
  readonly minutesFinalisedAt: string | null;
  readonly minutesFinalisedByLabel: string | null;
  readonly minutesAmendedAt: string | null;
  readonly minutesAmendmentNote: string | null;
  readonly rescheduledFrom: string | null;
  readonly rescheduleReason: string | null;
  readonly cancelledAt: string | null;
  readonly cancellationReason: string | null;
  readonly attendanceRecorded: number;
  readonly presentCount: number;
  readonly absentCount: number;
  readonly expectedMembers: number;
  readonly actionCount: number;
  readonly openActionCount: number;
  readonly createdByLabel: string;
}

const MEETING_COLUMNS = `
  id, meeting_number, branch_id, branch_name, meeting_type, title, venue,
  scheduled_at, meeting_date, status, agenda, minutes,
  minutes_finalised_at, minutes_finalised_by_label,
  minutes_amended_at, minutes_amendment_note,
  rescheduled_from, reschedule_reason, cancelled_at, cancellation_reason,
  attendance_recorded, present_count, absent_count, expected_members,
  action_count, open_action_count, created_by_label
`;

interface MeetingRow {
  readonly id: string | null;
  readonly meeting_number: string | null;
  readonly branch_id: string | null;
  readonly branch_name: string | null;
  readonly meeting_type: string | null;
  readonly title: string | null;
  readonly venue: string | null;
  readonly scheduled_at: string | null;
  readonly meeting_date: string | null;
  readonly status: string | null;
  readonly agenda: string | null;
  readonly minutes: string | null;
  readonly minutes_finalised_at: string | null;
  readonly minutes_finalised_by_label: string | null;
  readonly minutes_amended_at: string | null;
  readonly minutes_amendment_note: string | null;
  readonly rescheduled_from: string | null;
  readonly reschedule_reason: string | null;
  readonly cancelled_at: string | null;
  readonly cancellation_reason: string | null;
  readonly attendance_recorded: number | null;
  readonly present_count: number | null;
  readonly absent_count: number | null;
  readonly expected_members: number | null;
  readonly action_count: number | null;
  readonly open_action_count: number | null;
  readonly created_by_label: string | null;
}

function toMeeting(row: MeetingRow): MeetingSummary {
  return {
    id: row.id ?? '',
    meetingNumber: row.meeting_number ?? '',
    branchId: row.branch_id ?? '',
    branchName: row.branch_name ?? '',
    meetingType: (row.meeting_type ?? 'monthly_general') as MeetingType,
    title: row.title ?? '',
    venue: row.venue ?? '',
    scheduledAt: row.scheduled_at ?? '',
    meetingDate: row.meeting_date ?? '',
    status: (row.status ?? 'scheduled') as MeetingStatus,
    agenda: row.agenda,
    minutes: row.minutes,
    minutesFinalisedAt: row.minutes_finalised_at,
    minutesFinalisedByLabel: row.minutes_finalised_by_label,
    minutesAmendedAt: row.minutes_amended_at,
    minutesAmendmentNote: row.minutes_amendment_note,
    rescheduledFrom: row.rescheduled_from,
    rescheduleReason: row.reschedule_reason,
    cancelledAt: row.cancelled_at,
    cancellationReason: row.cancellation_reason,
    attendanceRecorded: row.attendance_recorded ?? 0,
    presentCount: row.present_count ?? 0,
    absentCount: row.absent_count ?? 0,
    expectedMembers: row.expected_members ?? 0,
    actionCount: row.action_count ?? 0,
    openActionCount: row.open_action_count ?? 0,
    createdByLabel: row.created_by_label ?? 'system',
  };
}

export interface MeetingPage {
  readonly meetings: readonly MeetingSummary[];
  readonly page: number;
  readonly hasMore: boolean;
}

/**
 * The meetings list, searched and filtered.
 *
 * Newest first, because the question a reader opens this with is almost always
 * "what did we decide last month" or "when is the next one" — and both are at
 * the top. `status=upcoming` is a filter the list offers and the database does
 * not: it is scheduled meetings still in the future, which no single column
 * holds.
 */
export async function listMeetings(filter: MeetingSearch): Promise<MeetingPage> {
  const supabase = await createSupabaseServerClient();

  const page = Math.max(1, filter.page);
  const from = (page - 1) * MEETING_PAGE_SIZE;
  const to = from + MEETING_PAGE_SIZE;

  let query = supabase
    .from('membership_meeting_register')
    .select(MEETING_COLUMNS)
    .order('scheduled_at', { ascending: false })
    .range(from, to);

  if (filter.type !== 'all') {
    query = query.eq('meeting_type', filter.type);
  }

  if (filter.status === 'upcoming') {
    query = query.eq('status', 'scheduled').gte('scheduled_at', new Date().toISOString());
  } else if (filter.status !== 'all') {
    query = query.eq('status', filter.status);
  }

  const term = filter.query === null ? '' : escapeSearchTerm(filter.query.trim());

  if (term !== '') {
    query = query.or(
      [
        `meeting_number.ilike.%${term}%`,
        `title.ilike.%${term}%`,
        `venue.ilike.%${term}%`,
      ].join(','),
    );
  }

  const { data, error } = await query;

  if (error !== null) {
    logger.warn('Could not list membership meetings.', { code: error.code });
    throw mapDatabaseError(error, 'meetings');
  }

  const rows = (data ?? []) as unknown as MeetingRow[];
  const hasMore = rows.length > MEETING_PAGE_SIZE;

  return {
    meetings: rows.slice(0, MEETING_PAGE_SIZE).map(toMeeting),
    page,
    hasMore,
  };
}

export async function getMeeting(meetingId: string): Promise<MeetingSummary | null> {
  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase
    .from('membership_meeting_register')
    .select(MEETING_COLUMNS)
    .eq('id', meetingId)
    .maybeSingle();

  if (error !== null) {
    logger.warn('Could not read a membership meeting.', { code: error.code });
    throw mapDatabaseError(error, 'meetings');
  }

  return data === null ? null : toMeeting(data);
}

/** The next few meetings, for a dashboard panel. */
export async function listUpcomingMeetings(
  limit = 5,
): Promise<readonly MeetingSummary[]> {
  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase
    .from('membership_meeting_register')
    .select(MEETING_COLUMNS)
    .eq('status', 'scheduled')
    .gte('scheduled_at', new Date().toISOString())
    .order('scheduled_at', { ascending: true })
    .limit(limit);

  if (error !== null) {
    logger.warn('Could not list upcoming meetings.', { code: error.code });
    return [];
  }

  return ((data ?? []) as unknown as MeetingRow[]).map(toMeeting);
}

// ---------------------------------------------------------------------------
// Attendance
// ---------------------------------------------------------------------------

export interface AttendanceRow {
  readonly id: string;
  readonly meetingId: string;
  readonly meetingNumber: string;
  readonly meetingTitle: string;
  readonly meetingDate: string;
  readonly membershipId: string;
  readonly membershipNumber: string;
  readonly clientId: string;
  readonly clientNumber: string;
  readonly memberName: string;
  readonly memberPhone: string | null;
  readonly attendance: MeetingAttendance;
  readonly absenceReason: MeetingAbsenceReason | null;
  readonly note: string | null;
  readonly markedAt: string;
  readonly markedByLabel: string;
  readonly correctedAt: string | null;
  readonly correctionCount: number;
}

const ATTENDANCE_COLUMNS = `
  id, meeting_id, meeting_number, meeting_title, meeting_date,
  membership_id, membership_number, client_id, client_number,
  member_name, member_phone,
  attendance, absence_reason, note, marked_at, marked_by_label,
  corrected_at, correction_count
`;

interface AttendanceDbRow {
  readonly id: string | null;
  readonly meeting_id: string | null;
  readonly meeting_number: string | null;
  readonly meeting_title: string | null;
  readonly meeting_date: string | null;
  readonly membership_id: string | null;
  readonly membership_number: string | null;
  readonly client_id: string | null;
  readonly client_number: string | null;
  readonly member_name: string | null;
  readonly member_phone: string | null;
  readonly attendance: string | null;
  readonly absence_reason: string | null;
  readonly note: string | null;
  readonly marked_at: string | null;
  readonly marked_by_label: string | null;
  readonly corrected_at: string | null;
  readonly correction_count: number | null;
}

function toAttendance(row: AttendanceDbRow): AttendanceRow {
  return {
    id: row.id ?? '',
    meetingId: row.meeting_id ?? '',
    meetingNumber: row.meeting_number ?? '',
    meetingTitle: row.meeting_title ?? '',
    meetingDate: row.meeting_date ?? '',
    membershipId: row.membership_id ?? '',
    membershipNumber: row.membership_number ?? '',
    clientId: row.client_id ?? '',
    clientNumber: row.client_number ?? '',
    memberName: row.member_name ?? '',
    memberPhone: row.member_phone,
    attendance: (row.attendance ?? 'absent') as MeetingAttendance,
    absenceReason: row.absence_reason as MeetingAbsenceReason | null,
    note: row.note,
    markedAt: row.marked_at ?? '',
    markedByLabel: row.marked_by_label ?? 'system',
    correctedAt: row.corrected_at,
    correctionCount: row.correction_count ?? 0,
  };
}

export async function listMeetingAttendance(
  meetingId: string,
): Promise<readonly AttendanceRow[]> {
  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase
    .from('meeting_attendance_register')
    .select(ATTENDANCE_COLUMNS)
    .eq('meeting_id', meetingId)
    .order('member_name', { ascending: true });

  if (error !== null) {
    logger.warn('Could not list meeting attendance.', { code: error.code });
    throw mapDatabaseError(error, 'meetings');
  }

  return ((data ?? []) as unknown as AttendanceDbRow[]).map(toAttendance);
}

export interface ExpectedMember {
  readonly membershipId: string;
  readonly membershipNumber: string;
  readonly clientId: string;
  readonly memberName: string;
  readonly phone: string | null;
  readonly membershipStatus: string;
}

/**
 * The members a meeting's register should list.
 *
 * Read from `membership_register`, filtered to the meeting's branch and to the
 * statuses a register records — `active` and `suspended`, which is what
 * `mark_meeting_attendance` accepts. A pending application is not a member
 * yet, and a withdrawn or deceased one is not one any more.
 *
 * Returned as "everybody", with the already-marked rows layered on top by the
 * screen rather than excluded here: a register that only listed the unmarked
 * would lose its place every time somebody was marked.
 */
export async function listExpectedMembers(
  branchId: string,
): Promise<readonly ExpectedMember[]> {
  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase
    .from('membership_register')
    .select('membership_id, membership_number, client_id, full_name, phone, status')
    .eq('branch_id', branchId)
    .in('status', ['active', 'suspended'])
    .order('full_name', { ascending: true })
    .limit(500);

  if (error !== null) {
    logger.warn('Could not list the members expected at a meeting.', {
      code: error.code,
    });
    throw mapDatabaseError(error, 'meetings');
  }

  return (
    (data ?? []) as unknown as readonly {
      readonly membership_id: string | null;
      readonly membership_number: string | null;
      readonly client_id: string | null;
      readonly full_name: string | null;
      readonly phone: string | null;
      readonly status: string | null;
    }[]
  ).map((row) => ({
    membershipId: row.membership_id ?? '',
    membershipNumber: row.membership_number ?? '',
    clientId: row.client_id ?? '',
    memberName: row.full_name ?? '',
    phone: row.phone,
    membershipStatus: row.status ?? 'active',
  }));
}

export interface AttendanceCorrection {
  readonly id: string;
  readonly membershipId: string;
  readonly previousAttendance: MeetingAttendance;
  readonly previousAbsenceReason: MeetingAbsenceReason | null;
  readonly previousMarkedByLabel: string;
  readonly newAttendance: MeetingAttendance;
  readonly newAbsenceReason: MeetingAbsenceReason | null;
  readonly reason: string;
  readonly correctedAt: string;
  readonly correctedByLabel: string;
}

/**
 * What a register said before it was corrected.
 *
 * Staff only, and with no self-clause even for the member it is about: "she
 * was marked absent and then present, and here is who changed it" is an
 * internal control record.
 */
export async function listAttendanceCorrections(
  meetingId: string,
): Promise<readonly AttendanceCorrection[]> {
  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase
    .from('meeting_attendance_corrections')
    .select(
      `id, membership_id, previous_attendance, previous_absence_reason,
       previous_marked_by_label, new_attendance, new_absence_reason,
       reason, corrected_at, corrected_by_label`,
    )
    .eq('meeting_id', meetingId)
    .order('corrected_at', { ascending: false });

  if (error !== null) {
    logger.warn('Could not list attendance corrections.', { code: error.code });
    throw mapDatabaseError(error, 'meetings');
  }

  return (
    (data ?? []) as unknown as readonly {
      readonly id: string;
      readonly membership_id: string;
      readonly previous_attendance: string;
      readonly previous_absence_reason: string | null;
      readonly previous_marked_by_label: string;
      readonly new_attendance: string;
      readonly new_absence_reason: string | null;
      readonly reason: string;
      readonly corrected_at: string;
      readonly corrected_by_label: string;
    }[]
  ).map((row) => ({
    id: row.id,
    membershipId: row.membership_id,
    previousAttendance: row.previous_attendance as MeetingAttendance,
    previousAbsenceReason: row.previous_absence_reason as MeetingAbsenceReason | null,
    previousMarkedByLabel: row.previous_marked_by_label,
    newAttendance: row.new_attendance as MeetingAttendance,
    newAbsenceReason: row.new_absence_reason as MeetingAbsenceReason | null,
    reason: row.reason,
    correctedAt: row.corrected_at,
    correctedByLabel: row.corrected_by_label,
  }));
}

// ---------------------------------------------------------------------------
// Action items
// ---------------------------------------------------------------------------

export interface MeetingActionItem {
  readonly id: string;
  readonly meetingId: string;
  readonly description: string;
  readonly assignedTo: string | null;
  readonly assignedToLabel: string | null;
  readonly dueOn: string | null;
  readonly status: MeetingActionStatus;
  readonly completedAt: string | null;
  readonly completedByLabel: string | null;
  readonly completionNote: string | null;
  readonly createdByLabel: string;
}

const ACTION_COLUMNS = `
  id, meeting_id, description, assigned_to, assigned_to_label, due_on, status,
  completed_at, completed_by_label, completion_note, created_by_label
`;

function toAction(row: {
  readonly id: string;
  readonly meeting_id: string;
  readonly description: string;
  readonly assigned_to: string | null;
  readonly assigned_to_label: string | null;
  readonly due_on: string | null;
  readonly status: string;
  readonly completed_at: string | null;
  readonly completed_by_label: string | null;
  readonly completion_note: string | null;
  readonly created_by_label: string;
}): MeetingActionItem {
  return {
    id: row.id,
    meetingId: row.meeting_id,
    description: row.description,
    assignedTo: row.assigned_to,
    assignedToLabel: row.assigned_to_label,
    dueOn: row.due_on,
    status: row.status as MeetingActionStatus,
    completedAt: row.completed_at,
    completedByLabel: row.completed_by_label,
    completionNote: row.completion_note,
    createdByLabel: row.created_by_label,
  };
}

export async function listMeetingActions(
  meetingId: string,
): Promise<readonly MeetingActionItem[]> {
  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase
    .from('meeting_action_items')
    .select(ACTION_COLUMNS)
    .eq('meeting_id', meetingId)
    .order('status', { ascending: true })
    .order('due_on', { ascending: true, nullsFirst: false });

  if (error !== null) {
    logger.warn('Could not list meeting actions.', { code: error.code });
    throw mapDatabaseError(error, 'meetings');
  }

  return ((data ?? []) as unknown as Parameters<typeof toAction>[0][]).map(toAction);
}

/**
 * Every outstanding action across meetings, soonest due first.
 *
 * For the meetings dashboard. Actions with no due date come last, because an
 * action nobody put a date on is not more urgent than one somebody did.
 */
export async function listOpenMeetingActions(
  limit = 20,
): Promise<readonly MeetingActionItem[]> {
  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase
    .from('meeting_action_items')
    .select(ACTION_COLUMNS)
    .in('status', ['open', 'in_progress'])
    .order('due_on', { ascending: true, nullsFirst: false })
    .limit(limit);

  if (error !== null) {
    logger.warn('Could not list open meeting actions.', { code: error.code });
    return [];
  }

  return ((data ?? []) as unknown as Parameters<typeof toAction>[0][]).map(toAction);
}

// ---------------------------------------------------------------------------
// Who an action item can be given to
// ---------------------------------------------------------------------------

export interface MeetingAssignee {
  readonly profileId: string;
  readonly fullName: string;
}

/**
 * The members of staff an action item can be assigned to.
 *
 * Read as the caller from `profiles`, whose select policy requires
 * `users:view` — which a Manager and an Owner hold and a
 * Secretary/Treasurer does not. So this returns an empty list for the person
 * who most often writes the minutes, and that is not a fault to paper over:
 * the form says it cannot offer names rather than pretending there are none,
 * and the item is recorded unassigned.
 *
 * It is not fixed by reading with a privileged client. "Who works here" is a
 * staff directory question, `users:view` is the capability that answers it,
 * and widening it for the convenience of one form would widen it for
 * everything. An action item assigned to nobody is a real and ordinary thing;
 * a Secretary who needs one assigned asks the Manager who holds the names.
 *
 * Unlike `listWitnessCandidates`, the caller is **not** excluded: an action
 * item taken on by the person recording it is the commonest case of all.
 */
export async function listMeetingAssignees(): Promise<readonly MeetingAssignee[]> {
  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase
    .from('profiles')
    .select('id, full_name')
    .eq('status', 'active')
    .order('full_name', { ascending: true })
    .limit(200);

  if (error !== null) {
    // A policy refusal as often as a fault, so not a warning: the form has a
    // sentence for the empty case.
    return [];
  }

  return (data ?? []).map((row) => ({
    profileId: row.id,
    fullName: row.full_name,
  }));
}
