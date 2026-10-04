import Link from 'next/link';

import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { ReportEmpty } from '@/components/reports/report-empty';
import { ROUTES } from '@/config/app';
import { formatInstant } from '@/lib/domain/datetime';
import { formatUgx } from '@/lib/domain/money';
import { PAYMENT_METHOD_LABELS } from '@/lib/domain/payment';
import type { RecentPayment } from '@/lib/data/dashboard';

/**
 * The last few payments taken.
 *
 * Reversed payments are listed and marked, never hidden. Somebody glancing at
 * this panel needs to know that this morning's payment has since been
 * withdrawn — that is the single most useful thing the panel can tell them —
 * and the amount is struck through so it is not read as money in hand.
 */
export function RecentPayments({
  payments,
  timeZone,
}: {
  readonly payments: readonly RecentPayment[];
  readonly timeZone: string;
}) {
  if (payments.length === 0) {
    return (
      <ReportEmpty
        title="No payments recorded yet"
        description="Payments appear here as soon as they are recorded at the counter."
      />
    );
  }

  return (
    <Card className="min-w-0">
      <ul className="divide-border min-w-0 divide-y">
        {payments.map((payment) => (
          <li
            key={payment.paymentId}
            className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-3 gap-y-1 py-2 first:pt-0 last:pb-0"
          >
            <div className="min-w-0">
              <Link
                href={`${ROUTES.payments}/${payment.paymentId}`}
                className="text-brand-700 font-mono text-sm hover:underline"
              >
                {payment.paymentNumber}
              </Link>
              <p className="text-text min-w-0 text-sm break-words">
                {payment.clientName === '' ? 'Client' : payment.clientName} ·{' '}
                <span className="font-mono">{payment.loanNumber}</span>
              </p>
              <p className="text-text-muted text-xs">
                {formatInstant(payment.receivedAt, { timeZone })} ·{' '}
                {PAYMENT_METHOD_LABELS[payment.paymentMethod]} · {payment.recordedByLabel}
              </p>
            </div>

            <div className="shrink-0 text-right">
              <p
                className={
                  payment.isEffective
                    ? 'text-text tabular-nums'
                    : 'text-text-muted tabular-nums line-through'
                }
              >
                {formatUgx(payment.amount)}
              </p>
              {payment.isEffective ? null : <Badge tone="danger">Reversed</Badge>}
            </div>
          </li>
        ))}
      </ul>
    </Card>
  );
}
