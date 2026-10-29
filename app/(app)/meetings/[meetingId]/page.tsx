import { getPolicyBusinessNow } from '@/lib/data/policy-update';
import { MeetingPolicyWork } from '@/components/policy-update/meeting-policy-work';
import { CalendarDays } from 'lucide-react';
import { notFound } from 'next/navigation';

import { AttendanceRegister } from '@/components/meetings/attendance-register';
import {
  MeetingStatusBadge,
  MeetingTypeBadge,
} from '@/components/meetings/meeting-badges';
import { MeetingActionsPanel } from '@/components/meetings/meeting-actions-panel';
import { MeetingDecisionPanel } from '@/components/meetings/meeting-decision-panel';
import { MeetingMinutesPanel } from '@/components/meetings/meeting-minutes-panel';
import { Alert } from '@/components/ui/alert';
import { Card } from '@/components/ui/card';
import { DateValue } from '@/components/ui/data-value';
import { PageHeader } from '@/components/ui/page-header';
import { ROUTES } from '@/config/app';
import { contextCan } from '@/lib/auth/context';
import { guardPermission } from '@/lib/auth/guard';
import { getCompanyBranding } from '@/lib/data/company';
import {
  getMeeting,
  listAttendanceCorrections,
  listExpectedMembers,
  listMeetingActions,
  listMeetingAssignees,
  listMeetingAttendance,
} from '@/lib/data/meetings';
import { businessToday } from '@/lib/domain/datetime';
import { MEETING_STATUS_DESCRIPTIONS, attendanceRate } from '@/lib/domain/meetings';

export const metadata = { title: 'Meeting' };

/**
 * One meeting: the arrangement, the register, the minutes and the actions.
 *
 * ## The status is derived, not set
 *
 * Marking the first member present moves a meeting to `held`, inside
 * `mark_meeting_attendance`. A meeting with a register and a `scheduled`
 * status would be two statements about one afternoon, and somebody would have
 * to remember to reconcile them. So there is no "mark as held" button on this
 * page, and its absence is the design.
 *
 * ## The expected register is the branch's live memberships
 *
 * Read from `membership_register`, filtered to this meeting's branch and to
 * the statuses `mark_meeting_attendance` accepts — `active` and `suspended`.
 * A pending application is not a member yet, and a withdrawn or deceased one
 * is not one any more.
 */
export default async function MeetingPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ readonly meetingId: string }>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const context = await guardPermission(ROUTES.meetings, 'meetings:view');
  const { meetingId } = await params;
  const query = await searchParams;

  const meeting = await getMeeting(meetingId);

  if (meeting === null) notFound();

  const canManage = contextCan(context, 'meetings:manage');

  // Whether the assignee list below is the staff directory or only the
  // caller's own record. `profiles_select_self_or_directory` decides what
  // comes back; this decides what the form says about it.
  const canSeeStaffDirectory = contextCan(context, 'users:view');

  const [attendance, expected, corrections, actions, assignees, { branding }, policyNow] =
    await Promise.all([
      listMeetingAttendance(meeting.id),
      listExpectedMembers(meeting.branchId),
      listAttendanceCorrections(meeting.id),
      listMeetingActions(meeting.id),
      canManage ? listMeetingAssignees() : Promise.resolve([]),
      getCompanyBranding(),
      getPolicyBusinessNow(),
    ]);

  const today = businessToday(new Date(), branding.timezone);
  const rate = attendanceRate(meeting.presentCount, meeting.expectedMembers);

  return (
    <div className="min-w-0 space-y-6">
      <PageHeader
        eyebrow="Membership Meetings"
        icon={CalendarDays}
        title={meeting.title}
        description={`${meeting.meetingNumber} · ${meeting.branchName}`}
        back={{ href: ROUTES.meetings, label: 'Meetings' }}
        status={<MeetingStatusBadge status={meeting.status} />}
      />
      <MeetingPolicyWork
        meetingId={meeting.id}
        members={expected}
        canRecord={
          canManage &&
          meeting.status === 'scheduled' &&
          Date.parse(meeting.scheduledAt) > policyNow
        }
        canReview={contextCan(context, 'meetings:excuse_review')}
        canAssess={
          contextCan(context, 'fines:assess') &&
          meeting.status === 'held' &&
          Date.parse(meeting.scheduledAt) <= policyNow
        }
      />

      {query.scheduled === '1' ? (
        <Alert tone="success" title="Meeting scheduled">
          The members of this branch have been notified. Mark the register on the day —
          marking the first member present is what records that the meeting happened.
        </Alert>
      ) : null}

      <Card>
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <h2 className="text-text mr-auto text-sm font-semibold">The arrangement</h2>
          <MeetingTypeBadge type={meeting.meetingType} />
        </div>
        <p className="text-text-muted mt-1 text-sm">
          {MEETING_STATUS_DESCRIPTIONS[meeting.status]}
        </p>

        <dl className="mt-4 grid min-w-0 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <Line label="When">
            <DateValue value={meeting.scheduledAt} variant="datetime" />
          </Line>
          <Line label="Where">
            <span className="break-words">{meeting.venue}</span>
          </Line>
          <Line label="Branch">{meeting.branchName}</Line>
          <Line label="Members expected">
            <span className="tabular-nums">{meeting.expectedMembers}</span>
          </Line>
          <Line label="Came">
            <span className="tabular-nums">
              {meeting.presentCount} present · {meeting.absentCount} away
              {rate === null ? '' : ` · ${String(rate)}%`}
            </span>
          </Line>
          <Line label="Convened by">{meeting.createdByLabel}</Line>

          {meeting.rescheduledFrom === null ? null : (
            <Line label="Moved from">
              <DateValue value={meeting.rescheduledFrom} variant="datetime" />
              <span className="text-text-muted block text-xs">
                {meeting.rescheduleReason ?? 'No reason was recorded.'}
              </span>
            </Line>
          )}

          {meeting.cancelledAt === null ? null : (
            <Line label="Called off">
              <DateValue value={meeting.cancelledAt} variant="datetime" />
              <span className="text-text-muted block text-xs">
                {meeting.cancellationReason ?? 'No reason was recorded.'}
              </span>
            </Line>
          )}
        </dl>

        {meeting.agenda === null ? null : (
          <div className="border-border mt-4 border-t pt-4">
            <h3 className="text-text text-sm font-medium">Agenda</h3>
            <p className="text-text mt-1 text-sm whitespace-pre-wrap">{meeting.agenda}</p>
          </div>
        )}
      </Card>

      <MeetingDecisionPanel meeting={meeting} canManage={canManage} />

      <AttendanceRegister
        meetingId={meeting.id}
        expected={expected}
        marked={attendance}
        corrections={corrections}
        presentCount={meeting.presentCount}
        canManage={canManage}
        meetingStatus={meeting.status}
      />

      <MeetingMinutesPanel meeting={meeting} canManage={canManage} />

      <MeetingActionsPanel
        meetingId={meeting.id}
        actions={actions}
        assignees={assignees}
        canSeeStaffDirectory={canSeeStaffDirectory}
        businessDate={today}
        canManage={canManage}
      />
    </div>
  );
}

function Line({
  label,
  children,
}: {
  readonly label: string;
  readonly children: React.ReactNode;
}) {
  return (
    <div className="min-w-0">
      <dt className="text-text-muted text-xs">{label}</dt>
      <dd className="text-text mt-0.5 text-sm">{children}</dd>
    </div>
  );
}
