import type { ReactNode } from 'react';

import { Money } from '@/components/ui/money';
import { cn } from '@/lib/utils/cn';

/**
 * The one chart shape this application draws.
 *
 * ## Why only one, and why this one
 *
 * Phases 1–8 deliberately shipped no chart at all, and the pre-Phase-9 review
 * called that out: twenty-eight metrics, six reports and a seven-day outlook,
 * every one of them text. The answer is not a chart library and a dashboard
 * of dials. Every question this system actually asks of a picture has the
 * same shape — *compare magnitude across a handful of named things* — which
 * is a bar chart with one hue.
 *
 * One hue, not a categorical palette. That is a correctness decision, not a
 * stylistic one: the project's own `success` green and `warning` amber sit at
 * a CVD separation of ΔE 5.8 under protanopia, below the floor at which
 * colour may carry meaning even with labels. A reader with the commonest form
 * of colour blindness could not tell a "current" segment from a "grace
 * period" one. A single hue, with the identity carried by the row label, has
 * no such failure mode — and magnitude is what the reader is comparing
 * anyway.
 *
 * ## It computes nothing financial
 *
 * The bars arrive with their values already decided by the query that drew the
 * table beside them. What this component works out is geometry — what
 * fraction of the widest bar each one is — and geometry is not money. There is
 * no rounding, no rate, no total: a chart that summed its own rows could
 * disagree with the table above it, and the table is the authority.
 *
 * ## Every chart carries its own table
 *
 * `<figure>` with a caption, the bars, and a table of the same rows. On a
 * screen the table is visually hidden; in a screen reader, in a printout and
 * with CSS off, it is the chart. No value is available only as a picture.
 */

export interface MagnitudeRow {
  /** The row's name. Carries the identity, because the colour does not. */
  readonly label: string;
  /** Already decided by the query. Never computed here. */
  readonly value: number;
  /** Optional second line under the label — a date's weekday, a count. */
  readonly note?: string;
  /** Pulls one row forward without giving it a second hue. */
  readonly emphasis?: boolean;
}

export interface MagnitudeChartProps {
  readonly title: string;
  /** What the figures are, in words. Read aloud before the table. */
  readonly caption: string;
  readonly rows: readonly MagnitudeRow[];
  /** `money` renders each value through `Money`; `count` renders a number. */
  readonly format: 'money' | 'count';
  /** Heading for the table's value column. */
  readonly valueHeading: string;
  readonly className?: string;
  /** Shown instead of the bars when there is nothing to draw. */
  readonly empty?: ReactNode;
}

export function MagnitudeChart({
  title,
  caption,
  rows,
  format,
  valueHeading,
  className,
  empty = 'Nothing to show for this period.',
}: MagnitudeChartProps) {
  // The widest bar sets the scale. Geometry, not arithmetic on money: no
  // figure below is derived from this, only a width.
  const largest = rows.reduce((max, row) => (row.value > max ? row.value : max), 0);

  return (
    <figure className={cn('min-w-0', className)} data-chart="magnitude">
      <figcaption className="mb-3">
        <span className="text-text block text-sm font-medium">{title}</span>
        <span className="text-text-muted block text-xs">{caption}</span>
      </figcaption>

      {rows.length === 0 ? (
        <p className="text-text-muted py-6 text-center text-sm">{empty}</p>
      ) : (
        <>
          {/* The picture. `aria-hidden`, because the table below says the
              same thing better to anything that is not looking at it. */}
          <ul aria-hidden="true" className="min-w-0 space-y-2">
            {rows.map((row) => (
              <li key={row.label} className="min-w-0">
                <div className="flex items-baseline justify-between gap-3">
                  <span className="text-text-muted min-w-0 truncate text-xs">
                    {row.label}
                    {row.note === undefined ? null : (
                      <span className="text-text-muted/70"> · {row.note}</span>
                    )}
                  </span>
                  <span className="text-text shrink-0 text-xs font-medium">
                    {format === 'money' ? (
                      <Money amount={row.value} variant="bare" />
                    ) : (
                      <span className="tabular">{row.value}</span>
                    )}
                  </span>
                </div>

                {/* The track is one step off the surface, the bar is the
                    accent. 8px tall and 4px-rounded at the data end, square
                    at the baseline — the bar grows from the left and the
                    rounding marks where it stops. */}
                <div className="bg-surface-raised mt-1 h-2 w-full overflow-hidden rounded-l-none rounded-r">
                  <div
                    className={cn(
                      'h-full rounded-r',
                      row.emphasis === true ? 'bg-accent' : 'bg-accent/70',
                    )}
                    style={{
                      width: largest === 0 ? '0%' : `${(row.value / largest) * 100}%`,
                    }}
                  />
                </div>
              </li>
            ))}
          </ul>

          {/* The same rows, as a table. Visually hidden on screen and shown
              in print, so a printed report carries the figures rather than a
              row of bars with no axis. */}
          <table className="sr-only print:not-sr-only print:mt-3 print:w-full print:text-sm">
            <caption>{caption}</caption>
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">{valueHeading}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.label}>
                  <th scope="row">
                    {row.label}
                    {row.note === undefined ? '' : ` (${row.note})`}
                  </th>
                  <td>{format === 'money' ? <Money amount={row.value} /> : row.value}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </figure>
  );
}
