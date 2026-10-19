import { Card } from '@/components/ui/card';
import {
  DataTable,
  NotTotalled,
  TableCell,
  TableFootRow,
  TableHead,
  TableRow,
} from '@/components/ui/data-table';
import { Money } from '@/components/ui/money';
import { toUgx } from '@/lib/domain/money';
import type { LoanPeriod } from '@/lib/domain/loan';

/**
 * The contractual monthly breakdown.
 *
 * ## Why the preview is labelled
 *
 * The same component renders both the figures stored against an approved loan
 * and the preview shown while a draft is being entered. Those are not the same
 * thing: a preview is computed from the settings in force *now*, and approval
 * recomputes from the settings in force *then*. If the Owner changes the rate
 * in between, the figures will differ.
 *
 * So `provisional` is not decoration. It is the difference between "this is
 * what the borrower owes" and "this is what the borrower would owe if the loan
 * were approved on today's terms", and a staff member reading a number off a
 * screen to a borrower needs to know which they are looking at.
 *
 * A table rather than cards even on a phone, because the columns are the
 * point — a borrower asks "what do I pay in month two", and the answer is a
 * cell. It scrolls horizontally inside its own container rather than widening
 * the page, so the rest of the screen stays usable at 320px.
 */
export function LoanBreakdownTable({
  periods,
  totalInterest,
  totalExpected,
  principal,
  provisional = false,
}: {
  readonly periods: readonly LoanPeriod[];
  readonly totalInterest: number;
  readonly totalExpected: number;
  readonly principal: number;
  readonly provisional?: boolean;
}) {
  if (periods.length === 0) {
    return (
      <Card>
        <p className="text-text-muted text-sm">
          {provisional
            ? 'Enter an amount and a period to see the calculation.'
            : 'No breakdown has been calculated. It is created when the loan is approved.'}
        </p>
      </Card>
    );
  }

  return (
    <div className="min-w-0 space-y-3">
      {provisional ? (
        <p className="bg-info-surface text-info rounded-lg px-3 py-2 text-sm">
          <span className="font-medium">Preview only.</span> These figures are calculated
          on today&rsquo;s lending settings. The amounts that bind the borrower are
          recalculated and recorded when the loan is approved.
        </p>
      ) : null}

      <DataTable
        caption="Monthly reducing-balance breakdown: opening balance, principal, interest, amount due, and closing balance for each month"
        density="compact"
        stickyHeader
        maxHeight="26rem"
      >
        <thead>
          <tr>
            <TableHead width="count">Month</TableHead>
            <TableHead width="money" align="numeric">
              Opening
            </TableHead>
            <TableHead width="money" align="numeric">
              Principal
            </TableHead>
            <TableHead width="money" align="numeric">
              Interest
            </TableHead>
            <TableHead width="money" align="numeric">
              Amount due
            </TableHead>
            <TableHead width="money" align="numeric">
              Closing
            </TableHead>
          </tr>
        </thead>
        <tbody>
          {periods.map((period) => (
            <TableRow key={period.periodNumber}>
              <TableCell header width="count" className="font-normal">
                {period.periodNumber}
              </TableCell>
              <TableCell width="money" align="numeric" className="text-text-muted">
                <Money amount={period.openingPrincipal} />
              </TableCell>
              <TableCell width="money" align="numeric">
                <Money amount={period.principalPortion} />
              </TableCell>
              <TableCell width="money" align="numeric">
                <Money amount={period.interest} />
              </TableCell>
              <TableCell width="money" align="numeric" className="font-medium">
                <Money amount={period.totalObligation} />
              </TableCell>
              <TableCell width="money" align="numeric" className="text-text-muted">
                <Money amount={period.closingPrincipal} />
              </TableCell>
            </TableRow>
          ))}
        </tbody>
        <tfoot>
          <TableFootRow>
            <TableCell header width="count">
              Total
            </TableCell>
            {/* Opening and closing balances are a running position, not a
                series that sums to anything — a total under them would be a
                number with no meaning. Marked as deliberately not totalled
                rather than left blank, which reads as a zero. */}
            <TableCell width="money" align="numeric">
              <NotTotalled />
            </TableCell>
            <TableCell width="money" align="numeric">
              <Money amount={toUgx(principal)} />
            </TableCell>
            <TableCell width="money" align="numeric">
              <Money amount={toUgx(totalInterest)} />
            </TableCell>
            <TableCell width="money" align="numeric">
              <Money amount={toUgx(totalExpected)} />
            </TableCell>
            <TableCell width="money" align="numeric">
              <NotTotalled />
            </TableCell>
          </TableFootRow>
        </tfoot>
      </DataTable>

      <dl className="grid min-w-0 gap-3 sm:grid-cols-3">
        <div className="border-border bg-surface min-w-0 rounded-lg border p-3">
          <dt className="text-text-muted text-sm">Principal</dt>
          <dd className="text-text text-lg font-semibold tabular-nums">
            <Money amount={toUgx(principal)} />
          </dd>
        </div>
        <div className="border-border bg-surface min-w-0 rounded-lg border p-3">
          <dt className="text-text-muted text-sm">Total interest</dt>
          <dd className="text-text text-lg font-semibold tabular-nums">
            <Money amount={toUgx(totalInterest)} />
          </dd>
        </div>
        <div className="border-accent/40 bg-accent/5 min-w-0 rounded-lg border p-3">
          <dt className="text-text-muted text-sm">
            {provisional ? 'Total repayable (preview)' : 'Total repayable'}
          </dt>
          <dd className="text-text text-lg font-semibold tabular-nums">
            <Money amount={toUgx(totalExpected)} />
          </dd>
        </div>
      </dl>
    </div>
  );
}
