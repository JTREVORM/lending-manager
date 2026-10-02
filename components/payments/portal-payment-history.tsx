import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { formatInstant } from '@/lib/domain/datetime';
import { formatUgx, toUgx } from '@/lib/domain/money';
import {
  PAYMENT_METHOD_LABELS,
  type PaymentMethod,
  type PaymentStatus,
} from '@/lib/domain/payment';

/**
 * A borrower's own payment history, in the portal.
 *
 * ## What a borrower sees, and what they do not
 *
 * They see what they handed over: the date, the amount, how it was paid, the
 * receipt number to quote, and whether it still stands.
 *
 * They do **not** see who took the money, any internal note, the loan's
 * review history, or any staff attribution. Those are operational records
 * about the business's own handling, not facts about the borrower's payment,
 * and the policy on `loan_payments` would return them — so leaving them out is
 * this component's job rather than the database's.
 *
 * ## A reversed payment is shown, not hidden
 *
 * If a borrower holds a receipt the business has since withdrawn, the worst
 * possible outcome is a portal that shows no trace of it. So the row stays,
 * struck through and labelled, and the explanatory line tells them to ask.
 *
 * ## Cards, not a table
 *
 * This is the one screen in the system most likely to be read on a cheap phone
 * held one-handed, so there is no table rendering at all — the card layout is
 * the layout at every width.
 */
export function PortalPaymentHistory({
  payments,
  timeZone,
}: {
  readonly payments: readonly {
    readonly id: string;
    readonly paymentNumber: string;
    readonly loanNumber: string;
    readonly amount: number;
    readonly paymentMethod: PaymentMethod;
    readonly status: PaymentStatus;
    readonly receivedAt: string;
  }[];
  readonly timeZone: string;
}) {
  const totalPosted = payments
    .filter((payment) => payment.status === 'posted')
    .reduce((sum, payment) => sum + payment.amount, 0);

  return (
    <div className="min-w-0 space-y-3">
      <Card>
        <dl className="min-w-0">
          <dt className="text-text-muted text-sm">Total you have paid</dt>
          <dd className="text-text text-2xl font-semibold tabular-nums">
            {formatUgx(toUgx(totalPosted))}
          </dd>
          <dd className="text-text-muted text-xs">
            Across {payments.filter((p) => p.status === 'posted').length} payment
            {payments.filter((p) => p.status === 'posted').length === 1 ? '' : 's'}
          </dd>
        </dl>
      </Card>

      <ul className="min-w-0 space-y-2">
        {payments.map((payment) => {
          const isReversed = payment.status === 'reversed';

          return (
            <li
              key={payment.id}
              className="border-border bg-surface min-w-0 rounded-xl border p-3"
            >
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="text-text font-medium">
                  {formatInstant(payment.receivedAt, {
                    timeZone,
                    withTime: false,
                  })}
                </span>
                <span
                  className={
                    isReversed
                      ? 'text-text-muted font-medium tabular-nums line-through'
                      : 'text-text font-semibold tabular-nums'
                  }
                >
                  {formatUgx(toUgx(payment.amount))}
                </span>
              </div>

              <div className="text-text-muted mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                <span>
                  Receipt <span className="font-mono">{payment.paymentNumber}</span>
                </span>
                <span>{PAYMENT_METHOD_LABELS[payment.paymentMethod]}</span>
                <span className="font-mono">{payment.loanNumber}</span>
                {isReversed ? <Badge tone="danger">Reversed</Badge> : null}
              </div>

              {isReversed ? (
                <p className="text-text-muted mt-2 text-xs">
                  This payment was withdrawn and does not count toward your loan. Please
                  ask our staff if you were not expecting this.
                </p>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
