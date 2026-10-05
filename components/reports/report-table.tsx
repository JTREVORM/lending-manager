import type { ReactNode } from 'react';

import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils/cn';

export interface ReportColumn<Row> {
  readonly key: string;
  readonly header: string;
  readonly cell: (row: Row) => ReactNode;
  /** Right-align and use tabular figures. For money and counts. */
  readonly numeric?: boolean;
  /** Omit from the stacked mobile card, which should stay short. */
  readonly hideOnMobile?: boolean;
  /** Use as the card's heading on mobile rather than as a labelled field. */
  readonly primary?: boolean;
}

/**
 * A report table that is readable on a 320px phone.
 *
 * ## Two renderings of the same rows
 *
 * A table on a tablet and up; stacked cards below that. Nine columns squeezed
 * into 320px is unreadable however it is done, and a horizontally scrolling
 * table hides the columns on the right from somebody who does not think to
 * swipe. Both renderings come from the same `rows` and the same `columns`, so
 * they cannot drift — the approach Phase 6's register and Phase 7's overdue
 * list already use.
 *
 * ## Accessibility
 *
 * A real `<table>` with `<th scope="col">` and a caption, so a screen reader
 * announces the column a cell belongs to. The mobile rendering is a
 * description list per row, which announces each value with its own label.
 * Totals, where a report has them, go in a `<tfoot>` inside the table so they
 * are read as part of it.
 */
export function ReportTable<Row>({
  columns,
  rows,
  rowKey,
  caption,
  footer,
  rowTone,
}: {
  readonly columns: readonly ReportColumn<Row>[];
  readonly rows: readonly Row[];
  readonly rowKey: (row: Row) => string;
  /** Announced to a screen reader. Says what the table lists. */
  readonly caption: string;
  readonly footer?: ReactNode;
  readonly rowTone?: (row: Row) => 'muted' | undefined;
}) {
  const primary = columns.find((column) => column.primary) ?? columns[0];
  const mobileColumns = columns.filter(
    (column) => column.hideOnMobile !== true && column !== primary,
  );

  return (
    <>
      {/* Stacked cards: phones. */}
      <ul className="min-w-0 space-y-3 md:hidden">
        {rows.map((row) => (
          <li key={rowKey(row)}>
            <Card
              className={cn(
                'min-w-0 space-y-2',
                // `text-text-muted`, the same thing the table below does —
                // not `opacity-70`.
                //
                // Opacity dims everything inside the card, including a link
                // that has its own colour, and takes it below the contrast
                // floor: an axe sweep found a `text-brand-700` link inside a
                // settled row at under 4.5:1. A muted *token* is a colour
                // that was chosen to be readable, and anything with its own
                // colour keeps it. The information is in a column either way
                // — "Paid", a zero remaining balance — so the dimming was
                // only ever emphasis.
                rowTone?.(row) === 'muted' ? 'text-text-muted' : '',
              )}
            >
              {primary === undefined ? null : (
                <div className="text-text min-w-0 font-medium break-words">
                  {primary.cell(row)}
                </div>
              )}
              <dl className="grid min-w-0 grid-cols-2 gap-2">
                {mobileColumns.map((column) => (
                  <div key={column.key} className="min-w-0">
                    <dt className="text-text-muted text-xs">{column.header}</dt>
                    <dd
                      className={cn(
                        'text-text text-sm break-words',
                        column.numeric === true ? 'tabular-nums' : '',
                      )}
                    >
                      {column.cell(row)}
                    </dd>
                  </div>
                ))}
              </dl>
            </Card>
          </li>
        ))}
      </ul>

      {/* Table: tablets and up, and what a printout uses. */}
      <div className="border-border hidden min-w-0 overflow-x-auto rounded-xl border md:block print:block">
        <table className="w-full border-collapse text-sm">
          <caption className="sr-only">{caption}</caption>
          <thead>
            <tr className="bg-surface-raised">
              {columns.map((column) => (
                <th
                  key={column.key}
                  scope="col"
                  className={cn(
                    'text-text-muted border-border border-b px-3 py-2 font-medium',
                    column.numeric === true ? 'text-right' : 'text-left',
                  )}
                >
                  {column.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr
                key={rowKey(row)}
                className={cn(
                  'border-border border-b last:border-0',
                  rowTone?.(row) === 'muted' ? 'text-text-muted' : '',
                )}
              >
                {columns.map((column) => (
                  <td
                    key={column.key}
                    className={cn(
                      'px-3 py-2 align-top',
                      column.numeric === true ? 'text-right tabular-nums' : '',
                    )}
                  >
                    {column.cell(row)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
          {footer === undefined ? null : <tfoot>{footer}</tfoot>}
        </table>
      </div>
    </>
  );
}
