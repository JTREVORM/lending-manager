import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { DataTable, TableCell, TableHead, TableRow } from '@/components/ui/data-table';
import { DateValue } from '@/components/ui/data-value';
import { EmptyState } from '@/components/ui/states';
import { AUDIT_ACTION_LABELS, type AuditEntry } from '@/lib/domain/audit';

/**
 * The audit trail.
 *
 * ## Why this is a table on a desktop
 *
 * It used to be one bordered card per entry. Twenty-five entries — most of
 * them a single line reading "Signed in — by Namirembe Grace Atim" — came to
 * nearly 7,000px of page, and finding the one payment reversal in a morning's
 * sign-ins meant scrolling past two screens of identical boxes.
 *
 * An audit trail is a log. Logs are read by scanning down a column, which is
 * what a table is for and what a stack of cards actively prevents. Five
 * columns, sticky header, and the metadata behind a disclosure on the row
 * that has any — so the page is as long as the information in it rather than
 * as long as the number of rows.
 *
 * The phone keeps cards, because five columns do not fit in 390px and a
 * horizontally scrolling log is worse than a tall one.
 *
 * ## Nothing here mutates
 *
 * There is no action on a row and no control that writes. The audit log is
 * append-only in the database — no UPDATE or DELETE privilege exists for any
 * session role — and this component is a reader.
 */
export function AuditLog({
  entries,
  timeZone,
}: {
  readonly entries: readonly AuditEntry[];
  readonly timeZone: string;
}) {
  if (entries.length === 0) {
    return (
      <EmptyState
        title="No audit records match"
        description="Nothing was recorded with these filters. Try clearing the action or widening the dates."
      />
    );
  }

  return (
    <>
      {/* Phones: one compact card per entry. Three lines, not a bordered
          block with a heading. */}
      <ul className="divide-border border-border bg-surface min-w-0 divide-y rounded-lg border md:hidden">
        {entries.map((entry) => (
          <li key={entry.id} className="min-w-0 p-3">
            <div className="flex items-start justify-between gap-2">
              <p className="text-text min-w-0 text-sm font-medium break-words">
                {AUDIT_ACTION_LABELS[entry.action] ?? entry.action}
              </p>
              <Badge className="shrink-0">{entry.entityType.replace(/_/g, ' ')}</Badge>
            </div>
            <p className="text-text-muted mt-0.5 text-xs break-words">
              {entry.actorLabel} ·{' '}
              <DateValue
                value={entry.occurredAt}
                variant="datetime"
                timeZone={timeZone}
              />
            </p>
            <Changes entry={entry} />
          </li>
        ))}
      </ul>

      {/* Tablet and up: the log as a log. */}
      <div className="hidden md:block">
        <DataTable
          caption="Audit records: when, what was done, which record it touched, who did it, and what changed"
          stickyHeader
        >
          <thead>
            <tr>
              <TableHead nowrap>When</TableHead>
              <TableHead>Action</TableHead>
              <TableHead>Record</TableHead>
              <TableHead>Done by</TableHead>
              <TableHead>Detail</TableHead>
            </tr>
          </thead>
          <tbody>
            {entries.map((entry) => (
              <TableRow key={entry.id}>
                <TableCell className="text-text-muted text-xs">
                  <DateValue
                    value={entry.occurredAt}
                    variant="datetime"
                    timeZone={timeZone}
                  />
                </TableCell>
                <TableCell header>
                  {AUDIT_ACTION_LABELS[entry.action] ?? entry.action}
                </TableCell>
                <TableCell>
                  <Badge>{entry.entityType.replace(/_/g, ' ')}</Badge>
                </TableCell>
                <TableCell className="text-text-muted">{entry.actorLabel}</TableCell>
                <TableCell>
                  <Changes entry={entry} />
                </TableCell>
              </TableRow>
            ))}
          </tbody>
        </DataTable>
      </div>
    </>
  );
}

/**
 * The before-and-after, where there is one.
 *
 * Collapsed by default and absent entirely on a row with no metadata — which
 * is most of them. The old page rendered a "What changed" disclosure on every
 * card including the ones with nothing behind it, so the control taught
 * people it was never worth opening.
 */
function Changes({ entry }: { readonly entry: AuditEntry }) {
  if (entry.newValues === null && entry.oldValues === null) {
    return <span className="text-text-muted text-xs">—</span>;
  }

  return (
    <details className="min-w-0">
      <summary className="text-accent min-h-8 cursor-pointer text-xs">
        What changed
      </summary>
      <pre className="bg-surface-raised mt-2 max-w-full overflow-x-auto rounded-lg p-3 text-xs">
        {JSON.stringify({ before: entry.oldValues, after: entry.newValues }, null, 2)}
      </pre>
    </details>
  );
}

/** A labelled count, for the summary row above the log. */
export function AuditSummary({
  shown,
  page,
}: {
  readonly shown: number;
  readonly page: number;
}) {
  return (
    <Card className="flex flex-wrap items-baseline justify-between gap-2 py-3">
      <p className="text-text-muted text-sm">
        {shown} {shown === 1 ? 'record' : 'records'} shown
      </p>
      <p className="text-text-muted text-xs">Page {page}</p>
    </Card>
  );
}
