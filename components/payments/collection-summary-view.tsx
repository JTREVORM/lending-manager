import { Alert } from '@/components/ui/alert';
import { Card } from '@/components/ui/card';
import { MagnitudeChart } from '@/components/charts/magnitude-chart';
import {
  DataTable,
  NotRecorded,
  NotTotalled,
  TableCell,
  TableFootRow,
  TableHead,
  TableRow,
} from '@/components/ui/data-table';
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

        {/* Shortened, not removed: a reader who counts principal as revenue
            has overstated the business's income, and the allocation order is
            the loan's, not this screen's. */}
        <p className="text-text-muted mt-4 text-xs">
          Posted payments only, by business date, {summary.from} to {summary.to}
          inclusive. Principal collected reduces what is owed and is not revenue; interest
          and penalties are the income here.
        </p>
      </Card>

      {/* --- The five slices --------------------------------------------- */}
      <SliceTable
        id="by-method"
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
        id="by-staff"
        heading="By staff member"
        caption="Collections by the staff member who recorded them"
        slices={summary.byStaff}
        nameOf={(slice) => slice.label}
        chartTitle="Collected by staff member"
        chartCaption="Amount collected by each staff member over the period."
      />

      <SliceTable
        id="by-branch"
        heading="By branch"
        caption="Collections by the branch that owns the loan"
        slices={summary.byBranch}
        nameOf={(slice) => slice.label}
        chartTitle="Collected by branch"
        chartCaption="Amount collected against each branch's loans over the period."
      />

      <SliceTable
        id="by-product"
        heading="By loan product"
        caption="Collections by the product the loan was written on"
        slices={summary.byProduct}
        nameOf={(slice) => slice.label}
        chartTitle="Collected by loan product"
        chartCaption="Amount collected against each loan product over the period."
      />

      <SliceTable
        id="by-day"
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
  id,
  heading,
  caption,
  slices,
  nameOf,
  chartTitle,
  chartCaption,
}: {
  /**
   * The heading's element id, so a link can name this slice.
   *
   * The rail's "Collections by …" entries and Branch Network's "Branch
   * Performance" are deep links into this one page: the summary reads the
   * register once and sums it five ways, so five screens would be five
   * chances for the totals to disagree.
   */
  readonly id: string;
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
        <h2 id={id} className="text-text mb-2 text-lg font-semibold">
          {heading}
        </h2>
        <p className="text-text-muted text-sm">Nothing was collected in this period.</p>
      </Card>
    );
  }

  const total = slices.reduce((sum, slice) => sum + slice.totalCollected, 0);

  return (
    <div className="min-w-0 space-y-3">
      <h2 id={id} className="text-text text-lg font-semibold">
        {heading}
      </h2>

      <DataTable caption={caption} density="compact">
        <thead>
          <tr>
            <TableHead width="name-wide">Name</TableHead>
            <TableHead width="count" align="numeric">
              Receipts
            </TableHead>
            <TableHead width="count" align="numeric">
              Reversed
            </TableHead>
            <TableHead width="money" align="numeric">
              Collected
            </TableHead>
            <TableHead width="money" align="numeric">
              Principal
            </TableHead>
            <TableHead width="money" align="numeric">
              Interest
            </TableHead>
            <TableHead width="money" align="numeric">
              Penalties
            </TableHead>
          </tr>
        </thead>
        <tbody>
          {slices.map((slice) => (
            <TableRow key={slice.key ?? slice.label}>
              <TableCell
                header
                width="name-wide"
                wrap="clamp"
                title={nameOf(slice)}
                className="text-text"
              >
                {nameOf(slice)}
              </TableCell>
              <TableCell width="count" align="numeric" className="text-text">
                {slice.paymentCount}
              </TableCell>
              <TableCell width="count" align="numeric" className="text-text-muted">
                {slice.reversedCount === 0 ? <NotRecorded /> : slice.reversedCount}
              </TableCell>
              <TableCell
                width="money"
                align="numeric"
                className="text-text font-semibold"
              >
                <Money amount={slice.totalCollected} />
              </TableCell>
              <TableCell width="money" align="numeric" className="text-text">
                <Money amount={slice.principalCollected} />
              </TableCell>
              <TableCell width="money" align="numeric" className="text-text">
                <Money amount={slice.interestCollected} />
              </TableCell>
              <TableCell width="money" align="numeric" className="text-text">
                <Money amount={slice.penaltyCollected} />
              </TableCell>
            </TableRow>
          ))}
        </tbody>
        <tfoot>
          <TableFootRow>
            <TableCell header width="name-wide">
              Total
            </TableCell>
            {/* Receipt and reversal counts are counts of rows, not a sum the
                query returned, so they are deliberately not totalled here —
                marked rather than left blank, which reads as a zero. */}
            <TableCell width="count" align="numeric">
              <NotTotalled />
            </TableCell>
            <TableCell width="count" align="numeric">
              <NotTotalled />
            </TableCell>
            <TableCell width="money" align="numeric">
              <Money amount={total} />
            </TableCell>
            <TableCell width="money" align="numeric">
              <NotTotalled />
            </TableCell>
            <TableCell width="money" align="numeric">
              <NotTotalled />
            </TableCell>
            <TableCell width="money" align="numeric">
              <NotTotalled />
            </TableCell>
          </TableFootRow>
        </tfoot>
      </DataTable>

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
    </div>
  );
}
