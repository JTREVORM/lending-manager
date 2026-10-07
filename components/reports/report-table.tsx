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
  /**
   * A relative width hint for the desktop table, in the reference's own units
   * — a percentage-like number read as a minimum, not as a share of 100.
   *
   * The reference's `MisTable` carries the same idea and the same warning:
   * the numbers across a wide report routinely add up to well past 100 on
   * purpose, because they mean "give the note roughly four times the room of
   * Days late", not "the note takes 40% of the table". They are applied as a
   * `min-width` under `table-auto`, so a column is never squeezed below its
   * hint and the table grows past the card instead — which is what the
   * horizontal scroll on the wrapper is for.
   *
   * Without this, auto-layout hands a long prose column whatever is left over.
   * On the arrears report that was 127px for the latest note, wrapping it to
   * thirteen lines and making every row in the table 240px tall.
   */
  readonly width?: number;
  /**
   * Let this cell wrap. Off by default: a figure, a date or a loan number is
   * read across a row and a wrapped one is harder to follow than a table the
   * reader scrolls. Prose columns — a note, a reason — set it.
   */
  readonly wrap?: boolean;
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
/**
 * A column's width hint, in pixels.
 *
 * The reference's own conversion: the hint times 12. It is arbitrary and it
 * is meant to be — the hints are relative to each other, and this is the
 * factor that turns the set of them into a table that fills a laptop without
 * overflowing it on the common reports.
 */
function columnWidth(hint: number): number {
  return Math.round(hint * 12);
}

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

      {/* Table: tablets and up, and what a printout uses.

          The reference's density, which is the whole point of its report
          screens: 11px body, 10px uppercase headers on the slate fill, cells
          at `px-2 py-2.5`, rows separated by a hairline and hovering as a
          unit. Twelve columns of currency fit on a laptop at this size and do
          not at 14px. */}
      <div className="border-border scroll-area scroll-x hidden min-w-0 rounded-lg border md:block print:block">
        <table className="w-full table-auto border-collapse text-left text-[11px]">
          <caption className="sr-only">{caption}</caption>
          <colgroup>
            {columns.map((column) => (
              <col
                key={column.key}
                {...(column.width === undefined
                  ? {}
                  : { style: { width: `${String(columnWidth(column.width))}px` } })}
              />
            ))}
          </colgroup>
          <thead className="bg-surface-sunken">
            <tr>
              {columns.map((column) => (
                <th
                  key={column.key}
                  scope="col"
                  {...(column.width === undefined
                    ? {}
                    : { style: { minWidth: `${String(columnWidth(column.width))}px` } })}
                  className={cn(
                    't-th border-border border-b px-2 py-2.5 whitespace-nowrap',
                    column.numeric === true ? 'text-right' : 'text-left',
                  )}
                >
                  {column.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-border/60 divide-y">
            {rows.map((row) => (
              <tr
                key={rowKey(row)}
                className={cn(
                  'hover:bg-surface-hover transition-colors',
                  rowTone?.(row) === 'muted' ? 'text-text-muted' : '',
                )}
              >
                {columns.map((column) => (
                  <td
                    key={column.key}
                    {...(column.width === undefined
                      ? {}
                      : {
                          style: { minWidth: `${String(columnWidth(column.width))}px` },
                        })}
                    className={cn(
                      'px-2 py-2.5 align-top',
                      column.wrap === true ? undefined : 'whitespace-nowrap',
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
