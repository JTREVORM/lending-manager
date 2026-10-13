import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { Money } from '@/components/ui/money';
import { RowLink } from '@/components/ui/row-link';
import { DateValue, PhoneValue } from '@/components/ui/data-value';
import { ROUTES } from '@/config/app';
import {
  PROMISE_STATUS_LABELS,
  RECOVERY_ACTION_KIND_LABELS,
  type PromiseStatus,
} from '@/lib/domain/security';
import type { RecoveryAction, RecoveryStatusRow } from '@/lib/data/security';

/**
 * The follow-up worklist and the promise register.
 *
 * Both are tables of loans somebody has already touched, which is what makes
 * them different from the aging register above them. Aging says which loans are
 * late; these two say which ones are *being worked*, and where that work has
 * reached — the thing a supervisor cannot see from an arrears figure.
 */

/** Loans whose follow-up date has passed without another action being recorded. */
export function FollowUpWorklist({
  rows,
}: {
  readonly rows: readonly RecoveryStatusRow[];
}) {
  if (rows.length === 0) {
    return (
      <Card>
        <p className="text-text-muted text-sm">
          No follow-up is outstanding. Follow-ups appear here on the day after they were
          due.
        </p>
      </Card>
    );
  }

  return (
    <Card
      className="min-w-0 overflow-x-auto"
      tabIndex={0}
      role="region"
      aria-label="Loans with an overdue follow-up"
    >
      <table className="w-full text-left text-sm">
        <caption className="sr-only">
          Loans with an overdue follow-up: borrower, phone, loan, arrears, days late, when
          the follow-up was due, and what was last done
        </caption>
        <thead>
          <tr className="border-border bg-surface-sunken border-b">
            <th scope="col" className="t-th py-2.5 pr-4 whitespace-nowrap">
              Borrower
            </th>
            <th scope="col" className="t-th py-2.5 pr-4 whitespace-nowrap">
              Phone
            </th>
            <th scope="col" className="t-th py-2.5 pr-4 whitespace-nowrap">
              Loan
            </th>
            <th scope="col" className="t-th py-2.5 pr-4 text-right whitespace-nowrap">
              Arrears
            </th>
            <th scope="col" className="t-th py-2.5 pr-4 text-right whitespace-nowrap">
              Days
            </th>
            <th scope="col" className="t-th py-2.5 pr-4 whitespace-nowrap">
              Follow-up was due
            </th>
            <th scope="col" className="t-th py-2.5 pr-4 whitespace-nowrap">
              Last done
            </th>
          </tr>
        </thead>
        <tbody className="divide-border divide-y">
          {rows.map((row) => (
            <tr key={row.loanId} className="hover:bg-surface-hover">
              <th scope="row" className="py-2.5 pr-4 font-medium">
                <RowLink
                  href={`${ROUTES.loans}/${row.loanId}`}
                  className="text-brand-700 hover:underline"
                >
                  {row.clientName}
                </RowLink>
                <span className="text-text-muted block text-xs">{row.clientNumber}</span>
              </th>
              <td className="py-2.5 pr-4 whitespace-nowrap">
                <PhoneValue value={row.clientPhone} linked className="text-accent" />
              </td>
              <td className="text-text py-2.5 pr-4 font-mono whitespace-nowrap">
                {row.loanNumber}
              </td>
              <td className="text-text py-2.5 pr-4 text-right tabular-nums">
                {row.arrearsAmount === null ? '—' : <Money amount={row.arrearsAmount} />}
              </td>
              <td className="text-text py-2.5 pr-4 text-right tabular-nums">
                {row.daysPastDue ?? 0}
              </td>
              <td className="text-danger py-2.5 pr-4 whitespace-nowrap">
                {row.overdueFollowUpOn === null ? (
                  '—'
                ) : (
                  <DateValue value={row.overdueFollowUpOn} />
                )}
              </td>
              <td className="text-text-muted py-2.5 pr-4">
                {row.lastActionKind === null
                  ? 'Nothing'
                  : RECOVERY_ACTION_KIND_LABELS[row.lastActionKind]}
                {row.lastActionDate === null ? null : (
                  <span className="block text-xs">
                    <DateValue value={row.lastActionDate} />
                    {row.lastActionBy === null ? '' : ` · ${row.lastActionBy}`}
                  </span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

const PROMISE_TONES: Readonly<Record<PromiseStatus, 'info' | 'success' | 'danger'>> = {
  pending: 'info',
  kept: 'success',
  broken: 'danger',
};

/**
 * Promises to pay.
 *
 * The "paid in the window" column is the one that makes the register useful:
 * it says *why* a promise reads as kept or not kept, from the posted payments,
 * so nobody has to take the verdict on trust. A reversal moves this column and
 * the verdict together, because both are the same question asked of the same
 * rows.
 */
export function PromiseRegister({
  promises,
}: {
  readonly promises: readonly RecoveryAction[];
}) {
  if (promises.length === 0) {
    return (
      <Card>
        <p className="text-text-muted text-sm">
          No promise to pay has been recorded. One is taken from a loan&apos;s recovery
          panel.
        </p>
      </Card>
    );
  }

  return (
    <Card
      className="min-w-0 overflow-x-auto"
      tabIndex={0}
      role="region"
      aria-label="Promises to pay"
    >
      <table className="w-full text-left text-sm">
        <caption className="sr-only">
          Promises to pay: borrower, loan, amount promised, the date promised, what was
          paid in that window, the verdict, and who took the promise
        </caption>
        <thead>
          <tr className="border-border bg-surface-sunken border-b">
            <th scope="col" className="t-th py-2.5 pr-4 whitespace-nowrap">
              Borrower
            </th>
            <th scope="col" className="t-th py-2.5 pr-4 whitespace-nowrap">
              Loan
            </th>
            <th scope="col" className="t-th py-2.5 pr-4 text-right whitespace-nowrap">
              Promised
            </th>
            <th scope="col" className="t-th py-2.5 pr-4 whitespace-nowrap">
              By
            </th>
            <th scope="col" className="t-th py-2.5 pr-4 text-right whitespace-nowrap">
              Paid in the window
            </th>
            <th scope="col" className="t-th py-2.5 pr-4 whitespace-nowrap">
              Verdict
            </th>
            <th scope="col" className="t-th py-2.5 pr-4 whitespace-nowrap">
              Taken by
            </th>
          </tr>
        </thead>
        <tbody className="divide-border divide-y">
          {promises.map((promise) => (
            <tr key={promise.id} className="hover:bg-surface-hover">
              <th scope="row" className="py-2.5 pr-4 font-medium">
                <RowLink
                  href={`${ROUTES.loans}/${promise.loanId}`}
                  className="text-brand-700 hover:underline"
                >
                  {promise.clientName}
                </RowLink>
              </th>
              <td className="text-text py-2.5 pr-4 font-mono whitespace-nowrap">
                {promise.loanNumber}
              </td>
              <td className="text-text py-2.5 pr-4 text-right tabular-nums">
                {promise.promisedAmount === null ? (
                  '—'
                ) : (
                  <Money amount={promise.promisedAmount} />
                )}
              </td>
              <td className="text-text py-2.5 pr-4 whitespace-nowrap">
                {promise.promisedOn === null ? (
                  '—'
                ) : (
                  <DateValue value={promise.promisedOn} />
                )}
              </td>
              <td className="text-text py-2.5 pr-4 text-right tabular-nums">
                {promise.promisePaidAmount === null ? (
                  '—'
                ) : (
                  <Money amount={promise.promisePaidAmount} />
                )}
              </td>
              <td className="py-2.5 pr-4 whitespace-nowrap">
                {promise.promiseStatus === null ? (
                  '—'
                ) : (
                  <Badge tone={PROMISE_TONES[promise.promiseStatus]}>
                    {PROMISE_STATUS_LABELS[promise.promiseStatus]}
                  </Badge>
                )}
              </td>
              <td className="text-text-muted py-2.5 pr-4">
                {promise.createdByLabel}
                <span className="block text-xs">
                  <DateValue value={promise.actionDate} />
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <p className="text-text-muted mt-3 text-sm">
        A promise changes nothing contractual — no due date, no arrears figure, no
        penalty. Whether it was kept is read from the payments posted between the day it
        was given and the day it was for, so a reversal un-keeps one on its own.
      </p>
    </Card>
  );
}

/** The security register across the book. */
export function CollateralRegister({
  items,
}: {
  readonly items: readonly {
    readonly id: string;
    readonly loanId: string;
    readonly loanNumber: string;
    readonly clientName: string;
    readonly productCode: string;
    readonly itemTypeLabel: string;
    readonly description: string;
    readonly estimatedValue: number;
    readonly valuedOn: string;
    readonly statusLabel: string;
    readonly totalOutstanding: number | null;
  }[];
}) {
  if (items.length === 0) {
    return (
      <Card>
        <p className="text-text-muted text-sm">
          No security has been recorded against any loan. Items are recorded from a
          loan&apos;s own security panel.
        </p>
      </Card>
    );
  }

  return (
    <Card
      className="min-w-0 overflow-x-auto"
      tabIndex={0}
      role="region"
      aria-label="Security held"
    >
      <table className="w-full text-left text-sm">
        <caption className="sr-only">
          Security held: borrower, loan, product, item, valuation, valuation date, status
          and what the loan still owes
        </caption>
        <thead>
          <tr className="border-border bg-surface-sunken border-b">
            <th scope="col" className="t-th py-2.5 pr-4 whitespace-nowrap">
              Borrower
            </th>
            <th scope="col" className="t-th py-2.5 pr-4 whitespace-nowrap">
              Loan
            </th>
            <th scope="col" className="t-th py-2.5 pr-4 whitespace-nowrap">
              Item
            </th>
            <th scope="col" className="t-th py-2.5 pr-4 text-right whitespace-nowrap">
              Valued at
            </th>
            <th scope="col" className="t-th py-2.5 pr-4 whitespace-nowrap">
              Valued on
            </th>
            <th scope="col" className="t-th py-2.5 pr-4 whitespace-nowrap">
              Status
            </th>
            <th scope="col" className="t-th py-2.5 pr-4 text-right whitespace-nowrap">
              Loan owes
            </th>
          </tr>
        </thead>
        <tbody className="divide-border divide-y">
          {items.map((item) => (
            <tr key={item.id} className="hover:bg-surface-hover">
              <th scope="row" className="py-2.5 pr-4 font-medium">
                <RowLink
                  href={`${ROUTES.loans}/${item.loanId}`}
                  className="text-brand-700 hover:underline"
                >
                  {item.clientName}
                </RowLink>
              </th>
              <td className="text-text py-2.5 pr-4 font-mono whitespace-nowrap">
                {item.loanNumber}
                <span className="text-text-muted block font-sans text-xs">
                  {item.productCode}
                </span>
              </td>
              <td className="text-text py-2.5 pr-4">
                {item.itemTypeLabel}
                <span className="text-text-muted block text-xs">{item.description}</span>
              </td>
              <td className="text-text py-2.5 pr-4 text-right tabular-nums">
                <Money amount={item.estimatedValue} />
              </td>
              <td className="text-text py-2.5 pr-4 whitespace-nowrap">
                <DateValue value={item.valuedOn} />
              </td>
              <td className="text-text py-2.5 pr-4 whitespace-nowrap">
                {item.statusLabel}
              </td>
              <td className="text-text py-2.5 pr-4 text-right tabular-nums">
                {item.totalOutstanding === null ? (
                  '—'
                ) : (
                  <Money amount={item.totalOutstanding} />
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <p className="text-text-muted mt-3 text-sm">
        A valuation is a judgement recorded on a date, not a figure any balance is
        computed from. Realising an item reduces a loan only through the payment the sale
        produces.
      </p>
    </Card>
  );
}
