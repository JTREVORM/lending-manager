import { CalendarDays } from 'lucide-react';
import Link from 'next/link';

import { MeetingRegister } from '@/components/meetings/meeting-register';
import { MeetingActionBadge } from '@/components/meetings/meeting-badges';
import { Card } from '@/components/ui/card';
import { DateValue } from '@/components/ui/data-value';
import { ActionLink, PageHeader } from '@/components/ui/page-header';
import { ROUTES } from '@/config/app';
import { contextCan } from '@/lib/auth/context';
import { guardPermission } from '@/lib/auth/guard';
import { getCompanyBranding } from '@/lib/data/company';
import {
  listMeetings,
  listOpenMeetingActions,
  listUpcomingMeetings,
} from '@/lib/data/meetings';
import { businessToday } from '@/lib/domain/datetime';
import { meetingActionIsOverdue } from '@/lib/domain/meetings';
import { meetingSearchSchema } from '@/lib/validation/meetings';

export const metadata = { title: 'Meetings' };

/**
 * The meetings section: what is coming, what is outstanding, and the list.
 *
 * ## Why meetings are a section and not a tab on membership
 *
 * The work is different. A membership screen is about one person; a meeting is
 * about a room — a date, a register, minutes, and a list of things somebody
 * said they would do. Savings got a section for the same reason.
 *
 * ## The two panels above the list earn their place
 *
 * "What is coming" is the question members ask at the counter, and it is the
 * one thing a list ordered newest-first buries. "What is outstanding" is the
 * list of commitments made in a meeting that nobody has closed — the thing a
 * minute book is for and the thing a minute book never surfaces.
 *
 * Both are omitted when empty rather than shown as a zero: an empty
 * commitments panel is not information, and the list below is the page.
 */
export default async function MeetingsPage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const context = await guardPermission(ROUTES.meetings, 'meetings:view');
  const params = await searchParams;

  const parsed = meetingSearchSchema.safeParse({
    query: typeof params.q === 'string' ? params.q : '',
    status: typeof params.status === 'string' ? params.status : 'all',
    type: typeof params.type === 'string' ? params.type : 'all',
    page: typeof params.page === 'string' ? params.page : '1',
  });

  const filter = parsed.success
    ? parsed.data
    : { query: null, status: 'all' as const, type: 'all' as const, page: 1 };

  const [page, upcoming, openActions, { branding }] = await Promise.all([
    listMeetings(filter),
    listUpcomingMeetings(3),
    listOpenMeetingActions(8),
    getCompanyBranding(),
  ]);

  const today = businessToday(new Date(), branding.timezone);
  const canManage = contextCan(context, 'meetings:manage');

  return (
    <div className="min-w-0 space-y-6">
      <PageHeader
        eyebrow="Membership Meetings"
        icon={CalendarDays}
        title="Meetings"
        description="The monthly membership meetings, who came, what was decided, and what somebody said they would do."
        primaryAction={
          canManage ? (
            <ActionLink href={ROUTES.newMeeting}>Schedule a meeting</ActionLink>
          ) : undefined
        }
      />

      {upcoming.length === 0 ? null : (
        <Card>
          <h2 className="text-text text-sm font-semibold">Still to come</h2>
          <ul className="divide-border/60 mt-3 divide-y">
            {upcoming.map((meeting) => (
              <li key={meeting.id} className="min-w-0 py-2.5">
                <Link
                  href={`${ROUTES.meetings}/${meeting.id}`}
                  className="flex min-w-0 items-center justify-between gap-3"
                >
                  <span className="min-w-0">
                    <span className="text-text block text-sm font-medium break-words">
                      {meeting.title}
                    </span>
                    <span className="text-text-muted block text-xs">
                      {meeting.branchName} · {meeting.venue}
                    </span>
                  </span>
                  <span className="text-text shrink-0 text-right text-sm">
                    <DateValue value={meeting.scheduledAt} variant="datetime" />
                    <span className="text-text-muted block text-xs tabular-nums">
                      {meeting.expectedMembers} members expected
                    </span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {openActions.length === 0 ? null : (
        <Card>
          <h2 className="text-text text-sm font-semibold">
            Outstanding from past meetings
          </h2>
          <p className="text-text-muted mt-1 text-sm">
            Commitments made in a meeting that nobody has closed. Soonest due first.
          </p>
          <ul className="divide-border/60 mt-3 divide-y">
            {openActions.map((action) => (
              <li key={action.id} className="min-w-0 py-2.5">
                <Link
                  href={`${ROUTES.meetings}/${action.meetingId}`}
                  className="flex min-w-0 items-start justify-between gap-3"
                >
                  <span className="min-w-0">
                    <span className="text-text block text-sm break-words">
                      {action.description}
                    </span>
                    <span className="text-text-muted block text-xs">
                      {action.assignedToLabel ?? 'Unassigned'}
                      {action.dueOn === null ? ' · no date' : ' · due '}
                      {action.dueOn === null ? null : <DateValue value={action.dueOn} />}
                    </span>
                  </span>
                  <span className="shrink-0">
                    <MeetingActionBadge
                      status={action.status}
                      overdue={meetingActionIsOverdue(action.status, action.dueOn, today)}
                    />
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <MeetingRegister
        page={page}
        filter={{
          query: filter.query ?? '',
          status: filter.status === 'all' ? '' : filter.status,
          type: filter.type === 'all' ? '' : filter.type,
        }}
      />
    </div>
  );
}
