import { Alert } from '@/components/ui/alert';
import { Card } from '@/components/ui/card';
import { MagnitudeChart } from '@/components/charts/magnitude-chart';
import { Money } from '@/components/ui/money';
import {
  AGING_BUCKETS,
  AGING_BUCKET_DESCRIPTIONS,
  AGING_BUCKET_LABELS,
  PAR_DESCRIPTIONS,
  PAR_LABELS,
  PAR_THRESHOLDS,
  formatRatioBps,
  ratioSeverity,
} from '@/lib/domain/risk';
import type { ParSlice } from '@/lib/data/security';

/**
 * Risk monitoring: PAR at five thresholds, and the aging of the book.
 *
 * ## PAR is stated with its denominator in view
 *
 * A percentage on its own invites a reader to compare it with a figure from
 * somewhere else that was computed differently. So each tile carries the
 * principal behind it, and the card says in one line what the ratio divides by
 * — outstanding principal on loans past due, over outstanding principal. That
 * is the standard definition, and the two substitutions that quietly break it
 * are using total outstanding (which includes interest not yet earned) or
 * using the arrears figure (which is a fraction of the exposure, not the
 * exposure).
 *
 * ## An empty book has no PAR
 *
 * `null` renders as a dash, not 0.0%. A branch with no active loans is not a
 * branch in perfect health, and a tile reading "0.0%" says the second thing.
 *
 * ## The buckets are drawn in one hue
 *
 * The same reason the overdue list gives: `success` and `warning` separate by
 * ΔE 5.8 under protanopia, so six status colours would be six bars a reader
 * with the commonest colour blindness cannot tell apart. The label carries the
 * identity; the bar carries the magnitude.
 */
export function RiskSummary({ slice }: { readonly slice: ParSlice }) {
  const hasBook = slice.principalOutstanding > 0;

  return (
    <div className="min-w-0 space-y-4">
      <Card className="min-w-0">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <h2 className="text-text text-lg font-semibold">Portfolio at risk</h2>
          <p className="text-text-muted text-sm tabular-nums">
            {slice.loanCount} active loan{slice.loanCount === 1 ? '' : 's'} ·{' '}
            <Money amount={slice.principalOutstanding} /> principal outstanding
          </p>
        </div>

        {hasBook ? (
          <dl className="mt-4 grid min-w-0 grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
            {PAR_THRESHOLDS.map((threshold) => {
              const bps = slice.parBps[threshold];
              const severity = ratioSeverity(bps);

              return (
                <div key={threshold} className="min-w-0">
                  <dt
                    className="text-text-muted text-sm"
                    title={PAR_DESCRIPTIONS[threshold]}
                  >
                    {PAR_LABELS[threshold]}
                  </dt>
                  <dd
                    className={[
                      'text-xl font-semibold tabular-nums',
                      severity === 'bad'
                        ? 'text-danger'
                        : severity === 'watch'
                          ? 'text-warning'
                          : 'text-text',
                    ].join(' ')}
                  >
                    {formatRatioBps(bps)}
                  </dd>
                  <dd className="text-text-muted text-sm tabular-nums">
                    <Money amount={slice.principalAtRisk[threshold]} /> ·{' '}
                    {slice.loansAtRisk[threshold]} loan
                    {slice.loansAtRisk[threshold] === 1 ? '' : 's'}
                  </dd>
                </div>
              );
            })}
          </dl>
        ) : (
          <Alert tone="info" className="mt-3">
            There are no active loans, so there is no portfolio to measure. That is not
            the same as a portfolio at zero risk.
          </Alert>
        )}

        <p className="text-text-muted mt-4 text-sm">
          Outstanding principal on loans at least this many days past due, over total
          outstanding principal. Principal only — interest not yet earned is not
          portfolio, and a penalty is not principal lent. Days past due are counted net of
          each product&apos;s grace period.
        </p>
      </Card>

      <Card className="min-w-0">
        <h2 className="text-text text-lg font-semibold">Aging</h2>

        <dl className="mt-4 grid min-w-0 grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          {AGING_BUCKETS.map((bucket) => (
            <div key={bucket} className="min-w-0">
              <dt
                className="text-text-muted text-sm"
                title={AGING_BUCKET_DESCRIPTIONS[bucket]}
              >
                {AGING_BUCKET_LABELS[bucket]}
              </dt>
              <dd className="text-text text-xl font-semibold tabular-nums">
                {slice.loansByBucket[bucket]}
              </dd>
              <dd className="text-text-muted text-sm tabular-nums">
                <Money amount={slice.principalByBucket[bucket]} />
              </dd>
            </div>
          ))}
        </dl>

        <MagnitudeChart
          className="mt-4"
          title="Outstanding principal by age"
          caption="Outstanding principal in each aging bucket. Every active loan is in exactly one bucket."
          valueHeading="Principal"
          format="money"
          empty="There are no active loans."
          rows={AGING_BUCKETS.filter((bucket) => bucket !== 'current').map((bucket) => ({
            label: AGING_BUCKET_LABELS[bucket],
            value: slice.principalByBucket[bucket],
            note: `${String(slice.loansByBucket[bucket])} loan${
              slice.loansByBucket[bucket] === 1 ? '' : 's'
            }`,
            emphasis: bucket === '61_90' || bucket === '90_plus',
          }))}
        />

        <p className="text-text-muted mt-3 text-sm">
          The chart leaves out loans that are current, because a bar for the healthy
          majority flattens the five buckets anybody opens this screen to compare. Their
          count and principal are in the figures above.
        </p>
      </Card>
    </div>
  );
}

/** PAR broken out by branch or by product. One table, two callers. */
export function RiskBreakdown({
  heading,
  caption,
  slices,
  nameOf,
}: {
  readonly heading: string;
  readonly caption: string;
  readonly slices: readonly ParSlice[];
  readonly nameOf: (slice: ParSlice) => string;
}) {
  if (slices.length <= 1) {
    // One slice is the whole portfolio under another name, and a breakdown
    // table with a single row says nothing the summary above it did not.
    return null;
  }

  return (
    <Card
      className="min-w-0 overflow-x-auto"
      tabIndex={0}
      role="region"
      aria-label={heading}
    >
      <h2 className="text-text mb-3 text-lg font-semibold">{heading}</h2>

      <table className="w-full text-left text-sm">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr className="border-border bg-surface-sunken border-b">
            <th scope="col" className="t-th py-2.5 pr-4 whitespace-nowrap">
              Name
            </th>
            <th scope="col" className="t-th py-2.5 pr-4 text-right whitespace-nowrap">
              Loans
            </th>
            <th scope="col" className="t-th py-2.5 pr-4 text-right whitespace-nowrap">
              Principal
            </th>
            <th scope="col" className="t-th py-2.5 pr-4 text-right whitespace-nowrap">
              Arrears
            </th>
            {PAR_THRESHOLDS.map((threshold) => (
              <th
                key={threshold}
                scope="col"
                className="t-th py-2.5 pr-4 text-right whitespace-nowrap"
                title={PAR_DESCRIPTIONS[threshold]}
              >
                {PAR_LABELS[threshold]}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-border divide-y">
          {slices.map((slice) => (
            <tr key={`${slice.branchId ?? ''}:${slice.productId ?? ''}`}>
              <th scope="row" className="text-text py-2.5 pr-4 font-medium">
                {nameOf(slice)}
              </th>
              <td className="text-text py-2.5 pr-4 text-right tabular-nums">
                {slice.loanCount}
              </td>
              <td className="text-text py-2.5 pr-4 text-right tabular-nums">
                <Money amount={slice.principalOutstanding} />
              </td>
              <td className="text-text py-2.5 pr-4 text-right tabular-nums">
                <Money amount={slice.arrearsAmount} />
              </td>
              {PAR_THRESHOLDS.map((threshold) => (
                <td
                  key={threshold}
                  className="text-text py-2.5 pr-4 text-right tabular-nums"
                >
                  {formatRatioBps(slice.parBps[threshold])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}
