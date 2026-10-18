import { Card } from '@/components/ui/card';
import {
  DataTable,
  TableCell,
  TableHead,
  TableRow,
} from '@/components/ui/data-table';
import { Money } from '@/components/ui/money';
import { type BusinessDate } from '@/lib/domain/datetime';
import { toUgx } from '@/lib/domain/money';
import {
  INSTALLMENT_DATE_STATE_LABELS,
  installmentDateState,
  type InstallmentDateState,
} from '@/lib/domain/repayment-schedule';
import { DateValue } from '@/components/ui/data-value';

/**
 * The collection schedule for a loan.
 *
 * ## What this deliberately does not show
 *
 * No "paid", no "outstanding", no "missed", no running balance. Nothing posts
 * payments yet, so every one of those would be a claim the system cannot
 * support — and a borrower shown as having missed a collection they actually
 * paid is a worse failure than showing nothing at all.
 *
 * The only state shown is where the date sits relative to today, which the
 * calendar alone decides. "Date passed" says the date has passed and asserts
 * nothing whatever about payment. See `lib/domain/repayment-schedule.ts`.
 *
 * ## Why cards on a phone and a table on a desktop
 *
 * Seven columns at 320px is unreadable however it is squeezed, and a daily
 * three-month loan is 91 rows — a horizontally scrolling table would have a
 * collection officer dragging sideways on every one. So the small-screen
 * rendering is a stack of cards, each one collection, and the table appears
 * from the `sm` breakpoint where the columns fit.
 *
 * Both renderings come from the same rows; neither is a summary of the other.
 */

export interface ScheduleRow {
  readonly id: string;
  readonly installmentNumber: number;
  readonly loanPeriodNumber: number;
  readonly periodInstallmentNumber: number;
  readonly dueDate: BusinessDate;
  readonly scheduledPrincipal: number;
  readonly scheduledInterest: number;
  readonly expectedAmount: number;
}

const STATE_CLASSES: Readonly<Record<InstallmentDateState, string>> = {
  upcoming: 'bg-surface-muted text-text-muted',
  due_today: 'bg-info-surface text-info',
  // Neutral, not a warning colour. Red here would read as "this borrower is
  // delinquent", which is exactly the claim this phase cannot make.
  elapsed: 'bg-surface-muted text-text-muted',
};

function DateStateBadge({ state }: { readonly state: InstallmentDateState }) {
  return (
    <span
      className={`inline-block rounded-full px-2 py-0.5 text-xs ${STATE_CLASSES[state]}`}
    >
      {INSTALLMENT_DATE_STATE_LABELS[state]}
    </span>
  );
}

export function RepaymentScheduleTable({
  installments,
  today,
  provisional = false,
}: {
  readonly installments: readonly ScheduleRow[];
  /** Today in the business timezone, passed in so the component stays pure. */
  readonly today: BusinessDate;
  /**
   * A preview computed from a proposed date, not the stored schedule.
   *
   * Not decoration. A preview is anchored on a date the money has not moved
   * on yet; the real schedule is anchored on when it did. If disbursement
   * slips by a day, every date below shifts. A staff member reading a date to
   * a borrower needs to know which they are looking at.
   */
  readonly provisional?: boolean;
}) {
  if (installments.length === 0) {
    return (
      <Card>
        <p className="text-text-muted text-sm">
          No collection schedule yet. It is generated when the loan is disbursed, from the
          date the money actually reaches the borrower.
        </p>
      </Card>
    );
  }

  return (
    <div className="min-w-0 space-y-3">
      {provisional ? (
        <p className="bg-info-surface text-info rounded-lg px-3 py-2 text-sm">
          <span className="font-medium">Preview only.</span> These dates are estimated
          from the proposed disbursement date. The schedule that binds the borrower is
          generated at disbursement, from the day the money actually changes hands.
        </p>
      ) : null}

      {/* Phones: one card per collection. */}
      <ul className="min-w-0 space-y-2 sm:hidden">
        {installments.map((row) => {
          const state = installmentDateState(row.dueDate, today);

          return (
            <li
              key={row.id}
              className="border-border bg-surface min-w-0 rounded-lg border p-3"
            >
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-text font-medium">
                  <DateValue value={row.dueDate} />
                </span>
                <span className="text-text font-semibold tabular-nums">
                  <Money amount={toUgx(row.expectedAmount)} />
                </span>
              </div>
              <div className="text-text-muted mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                <span>Collection {row.installmentNumber}</span>
                <span>Month {row.loanPeriodNumber}</span>
                <span className="tabular-nums">
                  <Money amount={toUgx(row.scheduledPrincipal)} /> principal
                </span>
                <span className="tabular-nums">
                  <Money amount={toUgx(row.scheduledInterest)} /> interest
                </span>
                {provisional ? null : <DateStateBadge state={state} />}
              </div>
            </li>
          );
        })}
      </ul>

      {/* Tablet and up: the columns fit, and the columns are the point.
          Capped and scrolled so the header stays in view — a twenty-four
          collection schedule is read down, and losing the column names
          halfway is how a principal figure gets read as an interest one. */}
      <div className="hidden min-w-0 sm:block">
        <DataTable
          caption="Repayment collection schedule"
          density="compact"
          stickyHeader
          maxHeight="32rem"
        >
          <thead>
            <tr>
              <TableHead width="count">#</TableHead>
              <TableHead width="date">Due date</TableHead>
              <TableHead width="count">Month</TableHead>
              <TableHead width="money" align="numeric">
                Principal
              </TableHead>
              <TableHead width="money" align="numeric">
                Interest
              </TableHead>
              <TableHead width="money" align="numeric">
                Expected
              </TableHead>
              {provisional ? null : <TableHead width="status">Status</TableHead>}
            </tr>
          </thead>
          <tbody>
            {installments.map((row) => (
              <TableRow key={row.id}>
                <TableCell header width="count" className="text-text-muted font-normal">
                  {row.installmentNumber}
                </TableCell>
                <TableCell width="date" className="text-text">
                  <DateValue value={row.dueDate} />
                </TableCell>
                <TableCell width="count" className="text-text-muted">
                  {row.loanPeriodNumber}
                  <span className="sr-only"> of the contract</span>
                </TableCell>
                <TableCell width="money" align="numeric" className="text-text">
                  <Money amount={toUgx(row.scheduledPrincipal)} />
                </TableCell>
                <TableCell width="money" align="numeric" className="text-text">
                  <Money amount={toUgx(row.scheduledInterest)} />
                </TableCell>
                <TableCell
                  width="money"
                  align="numeric"
                  className="text-text font-medium"
                >
                  <Money amount={toUgx(row.expectedAmount)} />
                </TableCell>
                {provisional ? null : (
                  <TableCell width="status">
                    <DateStateBadge state={installmentDateState(row.dueDate, today)} />
                  </TableCell>
                )}
              </TableRow>
            ))}
          </tbody>
        </DataTable>
      </div>
    </div>
  );
}
