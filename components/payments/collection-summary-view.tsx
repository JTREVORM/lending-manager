import { Alert } from '@/components/ui/alert';
import { Card } from '@/components/ui/card';
import { MagnitudeChart } from '@/components/charts/magnitude-chart';
import { Money } from '@/components/ui/money';
import { PAYMENT_METHOD_LABELS, isPaymentMethod } from '@/lib/domain/payment';
import type { CollectionSlice, CollectionSummary } from '@/lib/data/collections';

/**
 * The Collection Summary: what came in over a period, cut five ways.
 *
 * ## Every slice is a partition of the same rows
 *
 * One query produced all five, which is why the totals agree. Five `group by`
 * queries would be five chances for them not to — a reversal posted between
 * the second and the fourth, and the method totals no longer add up to the
 * staff totals, with nothing on the screen to say why.
 *
 * ## A reversal is reported, not netted away
 *
 * Reversed payments contribute nothing to any amount — `payment_register`
 * already zeroes them — but their count is shown beside the receipts. A day
 * with eight receipts and one reversal is a different day from one with seven
 * receipts, and a summary that showed only the net would hide the correction
 * that was made.
 *
 * ## Branch and product mean "whose lending", not "whose counter"
 *
 * Both come from the loan. The day the business opens a second branch and a
 * borrower pays at the wrong one, these figures stay attached to the branch
 * that owns the loan — which is the question a branch manager is actually
 * asking.
 */
export function CollectionSummaryView({
  summary,
}: {
  readonly summary: CollectionSummary;
}) {
  return (
    <div className="min-w-0 space-y-6">
      {summary.complete ? null : (
        <Alert tone="danger" title="This summary is incomplete">
          More payments fall in this period than the summary will read, so every figure
          below is understated. Narrow the dates and read it again. Do not bank from this
          screen.
        </Alert>
      )}

      {/* --- The totals -------------------------------------------------- */}
      <Card className="min-w-0">
        <dl className="grid min-w-0 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <div className="min-w-0">
            <dt className="text-text-muted text-sm">Collected</dt>
            <dd className="text-text text-xl font-semibold tabular-nums">
              <Money amount={summary.totalCollected} />
            </dd>
            <dd className="text-text-muted text-sm tabular-nums">
              {summary.paymentCount} receipt{summary.paymentCount === 1 ? '' : 's'}
              {summary.reversedCount === 0
                ? ''
                : ` · ${String(summary.reversedCount)} reversed`}
            </dd>
          </div>
          <div className="min-w-0">
            <dt className="text-text-muted text-sm">Principal</dt>
            <dd className="text-text text-xl font-semibold tabular-nums">
              <Money amount={summary.principalCollected} />
            </dd>
          </div>
          <div className="min-w-0">
            <dt className="text-text-muted text-sm">Interest</dt>
            <dd className="text-text text-xl font-semibold tabular-nums">
              <Money amount={summary.interestCollected} />
            </dd>
          </div>
          <div className="min-w-0">
            <dt className="text-text-muted text-sm">Penalties</dt>
            <dd className="text-text text-xl font-semibold tabular-nums">
              <Money amount={summary.penaltyCollected} />
            </dd>
          </div>
        </dl>

        <p className="text-text-muted mt-4 text-sm">
          Posted payments only, by business date, from {summary.from} to {summary.to}
          inclusive. Principal collected is a reduction of what is owed, not revenue;
          interest and penalties are the income in this figure. Allocation follows the
          loan&apos;s own order — penalty, then interest, then principal — and is not
          re-decided here.
        </p>
      </Card>

      {/* --- The five slices --------------------------------------------- */}
      <SliceTable
        heading="By method"
        caption="Collections by payment method: receipts, reversals and the allocation split"
        slices={summary.byMethod}
        nameOf={(slice) =>
          isPaymentMethod(slice.key) ? PAYMENT_METHOD_LABELS[slice.key] : slice.label
        }
        chartTitle="Collected by method"
        chartCaption="Amount collected through each payment method over the period."
      />

      <SliceTable
        heading="By staff member"
        caption="Collections by the staff member who recorded them"
        slices={summary.byStaff}
        nameOf={(slice) => slice.label}
        chartTitle="Collected by staff member"
        chartCaption="Amount collected by each staff member over the period."
      />

      <SliceTable
        heading="By branch"
        caption="Collections by the branch that owns the loan"
        slices={summary.byBranch}
        nameOf={(slice) => slice.label}
        chartTitle="Collected by branch"
        chartCaption="Amount collected against each branch's loans over the period."
      />

      <SliceTable
        heading="By loan product"
        caption="Collections by the product the loan was written on"
        slices={summary.byProduct}
        nameOf={(slice) => slice.label}
        chartTitle="Collected by loan product"
        chartCaption="Amount collected against each loan product over the period."
      />

      <SliceTable
        heading="By day"
        caption="Collections by business date"
        slices={summary.byDay}
        nameOf={(slice) => slice.label}
        chartTitle="Collected by day"
        chartCaption="Amount collected on each business day in the period, in order."
      />
    </div>
  );
}

function SliceTable({
  heading,
  caption,
  slices,
  nameOf,
  chartTitle,
  chartCaption,
}: {
  readonly heading: string;
  readonly caption: string;
  readonly slices: readonly CollectionSlice[];
  readonly nameOf: (slice: CollectionSlice) => string;
  readonly chartTitle: string;
  readonly chartCaption: string;
}) {
  if (slices.length === 0) {
    return (
      <Card className="min-w-0">
        <h2 className="text-text mb-2 text-lg font-semibold">{heading}</h2>
        <p className="text-text-muted text-sm">Nothing was collected in this period.</p>
      </Card>
    );
  }

  const total = slices.reduce((sum, slice) => sum + slice.totalCollected, 0);

  return (
    /*
      `tabIndex` and a labelled region, because this table scrolls sideways on
      a phone and a scroller that only a mouse can reach is unreachable to
      anybody navigating by keyboard. The wider registers in this phase hide
      their table below `md` and show cards instead; these five are the same
      table at every width, so they carry the affordance.
    */
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
              Receipts
            </th>
            <th scope="col" className="t-th py-2.5 pr-4 text-right whitespace-nowrap">
              Reversed
            </th>
            <th scope="col" className="t-th py-2.5 pr-4 text-right whitespace-nowrap">
              Collected
            </th>
            <th scope="col" className="t-th py-2.5 pr-4 text-right whitespace-nowrap">
              Principal
            </th>
            <th scope="col" className="t-th py-2.5 pr-4 text-right whitespace-nowrap">
              Interest
            </th>
            <th scope="col" className="t-th py-2.5 pr-4 text-right whitespace-nowrap">
              Penalties
            </th>
          </tr>
        </thead>
        <tbody className="divide-border divide-y">
          {slices.map((slice) => (
            <tr key={slice.key ?? slice.label}>
              <th scope="row" className="text-text py-2.5 pr-4 font-medium break-words">
                {nameOf(slice)}
              </th>
              <td className="text-text py-2.5 pr-4 text-right tabular-nums">
                {slice.paymentCount}
              </td>
              <td className="text-text-muted py-2.5 pr-4 text-right tabular-nums">
                {slice.reversedCount === 0 ? '—' : slice.reversedCount}
              </td>
              <td className="text-text py-2.5 pr-4 text-right font-semibold tabular-nums">
                <Money amount={slice.totalCollected} />
              </td>
              <td className="text-text py-2.5 pr-4 text-right tabular-nums">
                <Money amount={slice.principalCollected} />
              </td>
              <td className="text-text py-2.5 pr-4 text-right tabular-nums">
                <Money amount={slice.interestCollected} />
              </td>
              <td className="text-text py-2.5 pr-4 text-right tabular-nums">
                <Money amount={slice.penaltyCollected} />
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="border-border bg-surface-sunken border-t">
            <th scope="row" className="text-text py-2.5 pr-4 font-semibold">
              Total
            </th>
            <td colSpan={2} />
            <td className="text-text py-2.5 pr-4 text-right font-semibold tabular-nums">
              <Money amount={total} />
            </td>
            <td colSpan={3} />
          </tr>
        </tfoot>
      </table>

      <MagnitudeChart
        className="mt-4"
        title={chartTitle}
        caption={chartCaption}
        valueHeading="Collected"
        format="money"
        empty="Nothing was collected."
        rows={slices.map((slice) => ({
          label: nameOf(slice),
          value: slice.totalCollected,
          note: `${String(slice.paymentCount)} receipt${
            slice.paymentCount === 1 ? '' : 's'
          }`,
        }))}
      />
    </Card>
  );
}
