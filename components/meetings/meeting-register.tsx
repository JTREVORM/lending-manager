'use client';

import { CalendarDays, SearchX } from 'lucide-react';

import {
  DataTable,
  TableCell,
  TableHead,
  TableLead,
  TableRow,
} from '@/components/ui/data-table';
import { DateValue } from '@/components/ui/data-value';
import {
  RegisterCount,
  RegisterFilters,
  RegisterPagination,
} from '@/components/ui/register';
import { RowLink } from '@/components/ui/row-link';
import { EmptyState } from '@/components/ui/states';
import { ROUTES } from '@/config/app';
import type { MeetingPage } from '@/lib/data/meetings';
import {
  MEETING_STATUSES,
  MEETING_STATUS_LABELS,
  MEETING_TYPES,
  MEETING_TYPE_LABELS,
  attendanceRate,
} from '@/lib/domain/meetings';
import { MeetingStatusBadge, MeetingTypeBadge } from './meeting-badges';

/**
 * The meetings list.
 *
 * ## Attendance is shown as a count and a rate, and the rate is never a verdict
 *
 * "34 of 61 · 56%" — the figures, and nothing that reads as a grade. Nothing
 * in this system attaches a consequence to attendance, because the client has
 * not decided there is one, and a register that coloured 56% red would be the
 * interface inventing a policy. The rate is `null` rather than 0% when a
 * branch has no live members, because dividing by nobody is not a figure.
 *
 * ## `upcoming` is a filter the list offers and the database does not
 *
 * Scheduled meetings still in the future, which is what somebody asking "when
 * is the next one" wants and which no single column holds.
 */
export function MeetingRegister({
  page,
  filter,
}: {
  readonly page: MeetingPage;
  readonly filter: {
    readonly query: string;
    readonly status: string;
    readonly type: string;
  };
}) {
  const filtered = filter.query !== '' || filter.status !== '' || filter.type !== '';

  return (
    <div className="min-w-0 space-y-4">
      <RegisterFilters
        search={{
          id: 'meeting-search',
          label: 'Search',
          param: 'q',
          value: filter.query,
          placeholder: 'Meeting number, title or venue',
        }}
        selects={[
          {
            id: 'meeting-type',
            label: 'Kind',
            param: 'type',
            value: filter.type,
            options: [
              { value: '', label: 'All meetings' },
              ...MEETING_TYPES.map((type) => ({
                value: type,
                label: MEETING_TYPE_LABELS[type],
              })),
            ],
          },
          {
            id: 'meeting-status',
            label: 'State',
            param: 'status',
            value: filter.status,
            options: [
              { value: '', label: 'Any state' },
              { value: 'upcoming', label: 'Still to come' },
              ...MEETING_STATUSES.map((status) => ({
                value: status,
                label: MEETING_STATUS_LABELS[status],
              })),
            ],
          },
        ]}
        summary={
          <RegisterCount
            shown={page.meetings.length}
            page={page.page}
            hasMore={page.hasMore}
            noun="meeting"
          />
        }
      />

      {page.meetings.length === 0 ? (
        <EmptyState
          icon={filtered ? SearchX : CalendarDays}
          title={
            filtered ? 'No meeting matches this search' : 'No meeting has been held yet'
          }
          description={
            filtered
              ? 'Try a shorter search, or clear the kind and state filters.'
              : 'The membership programme meets monthly. Schedule the first one from this section.'
          }
        />
      ) : (
        <>
          {/* Phone: cards. */}
          <ul className="space-y-3 md:hidden">
            {page.meetings.map((meeting) => {
              const rate = attendanceRate(meeting.presentCount, meeting.expectedMembers);

              return (
                <li key={meeting.id}>
                  <RowLink
                    href={`${ROUTES.meetings}/${meeting.id}`}
                    className="record-surface focus-visible:outline-accent block rounded-lg p-4 focus-visible:outline-2 focus-visible:outline-offset-2"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-text font-medium break-words">
                          {meeting.title}
                        </p>
                        <p className="text-text-muted font-mono text-sm">
                          {meeting.meetingNumber}
                        </p>
                      </div>
                      <MeetingStatusBadge status={meeting.status} />
                    </div>

                    <dl className="mt-3 grid grid-cols-2 gap-2 text-sm">
                      <div className="min-w-0">
                        <dt className="text-text-muted">When</dt>
                        <dd className="text-text">
                          <DateValue value={meeting.scheduledAt} variant="datetime" />
                        </dd>
                      </div>
                      <div className="min-w-0">
                        <dt className="text-text-muted">Where</dt>
                        <dd className="text-text break-words">{meeting.venue}</dd>
                      </div>
                      <div className="min-w-0">
                        <dt className="text-text-muted">Branch</dt>
                        <dd className="text-text">{meeting.branchName}</dd>
                      </div>
                      <div className="min-w-0">
                        <dt className="text-text-muted">Came</dt>
                        <dd className="text-text tabular-nums">
                          {meeting.presentCount} of {meeting.expectedMembers}
                          {rate === null ? '' : ` · ${String(rate)}%`}
                        </dd>
                      </div>
                    </dl>
                  </RowLink>
                </li>
              );
            })}
          </ul>

          {/* Tablet and up: a table. */}
          <div className="hidden min-w-0 md:block">
            <DataTable caption="Membership meetings, most recent first">
              <thead>
                <tr>
                  <TableHead width="ref">Meeting</TableHead>
                  <TableHead width="name-wide">Title</TableHead>
                  <TableHead width="status">Kind</TableHead>
                  <TableHead width="datetime">When</TableHead>
                  <TableHead width="place" hideBelow="lg">
                    Where
                  </TableHead>
                  <TableHead width="count" align="numeric" hideBelow="lg">
                    Came
                  </TableHead>
                  <TableHead width="count" align="numeric" hideBelow="xl">
                    Actions open
                  </TableHead>
                  <TableHead width="status">State</TableHead>
                </tr>
              </thead>
              <tbody>
                {page.meetings.map((meeting) => {
                  const rate = attendanceRate(
                    meeting.presentCount,
                    meeting.expectedMembers,
                  );

                  return (
                    <TableRow key={meeting.id} interactive>
                      <TableCell width="ref" className="font-mono">
                        <RowLink
                          href={`${ROUTES.meetings}/${meeting.id}`}
                          className="text-accent focus-visible:outline-accent underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2"
                        >
                          {meeting.meetingNumber}
                        </RowLink>
                      </TableCell>
                      <TableCell width="name-wide" wrap="wrap">
                        <TableLead
                          primary={meeting.title}
                          secondary={meeting.branchName}
                        />
                      </TableCell>
                      <TableCell width="status">
                        <MeetingTypeBadge type={meeting.meetingType} />
                      </TableCell>
                      <TableCell width="datetime">
                        <DateValue value={meeting.scheduledAt} variant="datetime" />
                      </TableCell>
                      <TableCell width="place" hideBelow="lg" wrap="clamp">
                        {meeting.venue}
                      </TableCell>
                      <TableCell width="count" align="numeric" hideBelow="lg">
                        {meeting.presentCount} / {meeting.expectedMembers}
                        {rate === null ? null : (
                          <span className="text-text-muted block text-[11px]">
                            {rate}%
                          </span>
                        )}
                      </TableCell>
                      <TableCell width="count" align="numeric" hideBelow="xl">
                        {meeting.openActionCount}
                      </TableCell>
                      <TableCell width="status">
                        <MeetingStatusBadge status={meeting.status} />
                      </TableCell>
                    </TableRow>
                  );
                })}
              </tbody>
            </DataTable>
          </div>
        </>
      )}

      <RegisterPagination page={page.page} hasMore={page.hasMore} />
    </div>
  );
}
