import { RowLink } from '@/components/ui/row-link';

import { Card } from '@/components/ui/card';
import { ReportEmpty } from '@/components/reports/report-empty';
import { ROUTES } from '@/config/app';
import { formatBusinessDate, formatInstant } from '@/lib/domain/datetime';
import { formatUgx } from '@/lib/domain/money';
import type { LoanActivityRow } from '@/lib/data/dashboard';

/**
 * A short list of loans that recently did something: paid out, settled, or
 * charged a late-payment penalty.
 *
 * Read from `loan_portfolio_report`, not from the audit trail. The audit trail
 * records who did what and when, which is a different question and a different
 * screen (§78); mixing audit events into a financial panel would blur the two
 * and tempt somebody to reconcile one against the other.
 */
export function LoanActivity({
  rows,
  kind,
  timeZone,
  emptyTitle,
  emptyDescription,
}: {
  readonly rows: readonly LoanActivityRow[];
  readonly kind: 'disbursed' | 'cleared' | 'penalised';
  readonly timeZone: string;
  readonly emptyTitle: string;
  readonly emptyDescription: string;
}) {
  if (rows.length === 0) {
    return <ReportEmpty title={emptyTitle} description={emptyDescription} />;
  }

  return (
    <Card className="min-w-0">
      <ul className="divide-border min-w-0 divide-y">
        {rows.map((row) => (
          <li
            key={row.loanId}
            className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-3 gap-y-1 py-2 first:pt-0 last:pb-0"
          >
            <div className="min-w-0">
              <RowLink
                href={`${ROUTES.loans}/${row.loanId}`}
                className="text-brand-700 font-mono text-sm hover:underline"
              >
                {row.loanNumber}
              </RowLink>
              <p className="text-text min-w-0 text-sm break-words">{row.clientName}</p>
              <p className="text-text-muted text-xs">
                {kind === 'disbursed' && row.disbursedAt !== null
                  ? `Paid out ${formatInstant(row.disbursedAt, { timeZone, withTime: false })}`
                  : null}
                {kind === 'cleared' && row.clearedAt !== null
                  ? `Settled ${formatInstant(row.clearedAt, { timeZone, withTime: false })}`
                  : null}
                {kind === 'penalised' && row.penaltyEffectiveDate !== null
                  ? `Charge from ${formatBusinessDate(row.penaltyEffectiveDate)}`
                  : null}
              </p>
            </div>

            <p className="text-text shrink-0 text-right tabular-nums">
              {kind === 'disbursed'
                ? formatUgx(row.principalAmount)
                : formatUgx(row.totalOutstanding)}
            </p>
          </li>
        ))}
      </ul>
    </Card>
  );
}
