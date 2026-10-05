import { RowLink } from '@/components/ui/row-link';

import { Card } from '@/components/ui/card';
import { ReportEmpty } from '@/components/reports/report-empty';
import { Money } from '@/components/ui/money';
import { ROUTES } from '@/config/app';
import type { UpcomingCollection } from '@/lib/data/dashboard';
import { DateValue } from '@/components/ui/data-value';

/**
 * Collections falling due over the next few days.
 *
 * ## Prepaid collections are absent
 *
 * The query filters on what remains uncovered, so a future collection a
 * borrower has already paid ahead on does not appear. It is not upcoming work;
 * it is finished work with a date in the future, and listing it would make the
 * week look busier than it is.
 *
 * Grouped by day, because the question this answers is "what is coming this
 * week", and a flat list of forty rows does not answer it.
 */
export function UpcomingCollections({
  collections,
}: {
  readonly collections: readonly UpcomingCollection[];
}) {
  if (collections.length === 0) {
    return (
      <ReportEmpty
        title="Nothing scheduled in the next week"
        description="Collections that have already been paid ahead are not listed here."
      />
    );
  }

  const byDay = new Map<string, UpcomingCollection[]>();

  for (const collection of collections) {
    const day = byDay.get(collection.dueDate);
    if (day === undefined) byDay.set(collection.dueDate, [collection]);
    else day.push(collection);
  }

  return (
    <Card className="min-w-0">
      <ul className="divide-border min-w-0 divide-y">
        {[...byDay.entries()].map(([day, rows]) => {
          const total = rows.reduce((sum, row) => sum + row.remainingAmount, 0);

          return (
            <li key={day} className="min-w-0 py-2 first:pt-0 last:pb-0">
              <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                <p className="text-text text-sm font-medium">
                  <DateValue value={day} />
                </p>
                <p className="text-text-muted text-sm tabular-nums">
                  <Money amount={total} /> · {rows.length}{' '}
                  {rows.length === 1 ? 'loan' : 'loans'}
                </p>
              </div>
              <p className="text-text-muted mt-0.5 min-w-0 text-xs break-words">
                {rows.slice(0, 6).map((row, index) => (
                  <span key={row.loanId}>
                    {index > 0 ? ', ' : ''}
                    <RowLink
                      href={`${ROUTES.loans}/${row.loanId}`}
                      className="text-brand-700 font-mono hover:underline"
                    >
                      {row.loanNumber}
                    </RowLink>
                  </span>
                ))}
                {rows.length > 6 ? ` and ${String(rows.length - 6)} more` : ''}
              </p>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
