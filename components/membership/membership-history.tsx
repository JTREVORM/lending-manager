import {
  DataTable,
  NotRecorded,
  TableCell,
  TableHead,
  TableRow,
} from '@/components/ui/data-table';
import { DateValue } from '@/components/ui/data-value';
import { EmptyState } from '@/components/ui/states';
import { MEMBERSHIP_STATUS_LABELS, type MembershipStatus } from '@/lib/domain/membership';
import type { MembershipStatusEvent } from '@/lib/data/membership';

/**
 * A membership's lifecycle, oldest first.
 *
 * Oldest first and not newest first, which is the opposite of every other
 * register here. The difference is deliberate: a register answers "what is
 * happening now", and this answers "how did this membership get here" — a
 * story, which is read forwards.
 *
 * Rendered as a table rather than as a decorated timeline because the rows
 * carry four facts each and a reader comparing two suspensions wants them in
 * columns. The opening row has no "from", which `NotRecorded` says in words
 * for a screen reader rather than leaving as a bare dash.
 */
export function MembershipHistory({
  events,
}: {
  readonly events: readonly MembershipStatusEvent[];
}) {
  if (events.length === 0) {
    return (
      <EmptyState
        title="No status history"
        description="Nothing has been recorded against this membership yet."
      />
    );
  }

  return (
    <DataTable caption="Membership status history, oldest first">
      <thead>
        <tr>
          <TableHead width="date">Date</TableHead>
          <TableHead width="status">From</TableHead>
          <TableHead width="status">To</TableHead>
          <TableHead width="prose">Reason</TableHead>
          <TableHead width="name" hideBelow="lg">
            Recorded by
          </TableHead>
        </tr>
      </thead>
      <tbody>
        {events.map((event) => (
          <TableRow key={event.id}>
            <TableCell width="date" className="text-text-muted">
              <DateValue value={event.effectiveOn} />
            </TableCell>
            <TableCell width="status" className="text-text-muted">
              {event.fromStatus === null ? <NotRecorded /> : label(event.fromStatus)}
            </TableCell>
            <TableCell width="status" header>
              {label(event.toStatus)}
            </TableCell>
            <TableCell width="prose" wrap="wrap" className="text-text-muted">
              {event.reason ?? <NotRecorded />}
            </TableCell>
            <TableCell
              width="name"
              wrap="clamp"
              hideBelow="lg"
              title={event.changedByLabel}
              className="text-text-muted"
            >
              {event.changedByLabel}
            </TableCell>
          </TableRow>
        ))}
      </tbody>
    </DataTable>
  );
}

function label(status: MembershipStatus): string {
  return MEMBERSHIP_STATUS_LABELS[status];
}
