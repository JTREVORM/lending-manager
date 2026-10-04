import { Card } from '@/components/ui/card';
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

      <Card className="min-w-0 overflow-x-auto">
        <table className="w-full text-left text-sm">
          <caption className="sr-only">
            Monthly reducing-balance breakdown: opening balance, principal, interest,
            amount due, and closing balance for each month
          </caption>
          <thead>
            <tr className="border-border text-text-muted border-b">
              <th scope="col" className="py-2 pr-4 font-medium">
                Month
              </th>
              <th scope="col" className="py-2 pr-4 text-right font-medium">
                Opening
              </th>
              <th scope="col" className="py-2 pr-4 text-right font-medium">
                Principal
              </th>
              <th scope="col" className="py-2 pr-4 text-right font-medium">
                Interest
              </th>
              <th scope="col" className="py-2 pr-4 text-right font-medium">
                Amount due
              </th>
              <th scope="col" className="py-2 text-right font-medium">
                Closing
              </th>
            </tr>
          </thead>
          <tbody>
            {periods.map((period) => (
              <tr key={period.periodNumber} className="border-border border-b">
                <th scope="row" className="text-text py-2 pr-4 font-normal">
                  {period.periodNumber}
                </th>
                <td className="text-text-muted py-2 pr-4 text-right tabular-nums">
                  <Money amount={period.openingPrincipal} />
                </td>
                <td className="text-text py-2 pr-4 text-right tabular-nums">
                  <Money amount={period.principalPortion} />
                </td>
                <td className="text-text py-2 pr-4 text-right tabular-nums">
                  <Money amount={period.interest} />
                </td>
                <td className="text-text py-2 pr-4 text-right font-medium tabular-nums">
                  <Money amount={period.totalObligation} />
                </td>
                <td className="text-text-muted py-2 text-right tabular-nums">
                  <Money amount={period.closingPrincipal} />
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="font-medium">
              <th scope="row" className="text-text py-2 pr-4 text-left">
                Total
              </th>
              <td />
              <td className="text-text py-2 pr-4 text-right tabular-nums">
                <Money amount={toUgx(principal)} />
              </td>
              <td className="text-text py-2 pr-4 text-right tabular-nums">
                <Money amount={toUgx(totalInterest)} />
              </td>
              <td className="text-text py-2 pr-4 text-right tabular-nums">
                <Money amount={toUgx(totalExpected)} />
              </td>
              <td />
            </tr>
          </tfoot>
        </table>
      </Card>

      <dl className="grid min-w-0 gap-3 sm:grid-cols-3">
        <div className="border-border bg-surface min-w-0 rounded-xl border p-3">
          <dt className="text-text-muted text-sm">Principal</dt>
          <dd className="text-text text-lg font-semibold tabular-nums">
            <Money amount={toUgx(principal)} />
          </dd>
        </div>
        <div className="border-border bg-surface min-w-0 rounded-xl border p-3">
          <dt className="text-text-muted text-sm">Total interest</dt>
          <dd className="text-text text-lg font-semibold tabular-nums">
            <Money amount={toUgx(totalInterest)} />
          </dd>
        </div>
        <div className="border-accent/40 bg-accent/5 min-w-0 rounded-xl border p-3">
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
