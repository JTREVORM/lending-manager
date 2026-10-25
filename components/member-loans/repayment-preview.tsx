import { DataTable, TableCell, TableHead, TableRow } from '@/components/ui/data-table';
import { Money } from '@/components/ui/money';
import type { MemberLoanCalculation } from '@/lib/domain/member-loan';

/**
 * What a member loan would cost, month by month.
 *
 * ## What this is and is not
 *
 * It is the **contract**: a month-by-month statement of what falls due. It is
 * not the collection plan — how that month's obligation is actually gathered,
 * weekly or at the month's end — because that is generated at disbursement
 * from the day the money reaches the member, and quoting a date here would be
 * quoting a day nobody has fixed yet.
 *
 * So the cadence is named and the footnote says what it will mean, and the
 * dates arrive with the schedule.
 *
 * ## Why the totals line is the last row rather than a separate panel
 *
 * Because a borrower reads down the column and the total is the number they
 * came for. A figure in a card above the table is read before the table and
 * then not reconciled against it; a figure at the foot is read after and is.
 */
export function MemberLoanRepaymentPreview({
  calculation,
  cadence,
}: {
  readonly calculation: MemberLoanCalculation;
  readonly cadence: 'weekly' | 'monthly';
}) {
  return (
    <div className="min-w-0 space-y-3">
      <DataTable caption="What the member would owe, month by month">
        <thead>
          <tr>
            <TableHead width="count" align="numeric">
              Month
            </TableHead>
            <TableHead width="money" align="numeric" hideBelow="lg">
              Opening
            </TableHead>
            <TableHead width="money" align="numeric">
              Principal
            </TableHead>
            <TableHead width="money" align="numeric">
              Interest
            </TableHead>
            <TableHead width="money" align="numeric">
              Falls due
            </TableHead>
            <TableHead width="money" align="numeric" hideBelow="lg">
              Closing
            </TableHead>
          </tr>
        </thead>
        <tbody>
          {calculation.periods.map((period) => (
            <TableRow key={period.periodNumber}>
              <TableCell width="count" align="numeric">
                {period.periodNumber}
              </TableCell>
              <TableCell width="money" align="numeric" hideBelow="lg">
                <Money amount={period.openingPrincipal} variant="bare" />
              </TableCell>
              <TableCell width="money" align="numeric">
                <Money amount={period.principalPortion} variant="bare" />
              </TableCell>
              <TableCell width="money" align="numeric">
                <Money amount={period.interest} variant="bare" />
              </TableCell>
              <TableCell width="money" align="numeric">
                <Money amount={period.totalObligation} variant="bare" weight="medium" />
              </TableCell>
              <TableCell width="money" align="numeric" hideBelow="lg">
                <Money amount={period.closingPrincipal} variant="bare" />
              </TableCell>
            </TableRow>
          ))}

          <TableRow>
            <TableCell width="count" align="numeric" header>
              Total
            </TableCell>
            <TableCell width="money" align="numeric" hideBelow="lg">
              {''}
            </TableCell>
            <TableCell width="money" align="numeric" header>
              <Money amount={calculation.principal} variant="bare" weight="semibold" />
            </TableCell>
            <TableCell width="money" align="numeric" header>
              <Money
                amount={calculation.totalInterest}
                variant="bare"
                weight="semibold"
              />
            </TableCell>
            <TableCell width="money" align="numeric" header>
              <Money
                amount={calculation.totalExpectedRepayment}
                variant="bare"
                weight="semibold"
              />
            </TableCell>
            <TableCell width="money" align="numeric" hideBelow="lg">
              {''}
            </TableCell>
          </TableRow>
        </tbody>
      </DataTable>

      <p className="text-text-muted text-xs">
        {cadence === 'weekly'
          ? "Each month's obligation above is collected weekly: the collection dates are generated when the money is paid out, from the day the member actually receives it."
          : "Each month's obligation above is collected once, at that month's end. The exact dates are generated when the money is paid out, from the day the member actually receives it."}{' '}
        These figures are the contract and are frozen at approval; the database recomputes
        every one of them from the member&rsquo;s own policy version at that moment.
      </p>
    </div>
  );
}
