import Link from 'next/link';

import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { DelinquencyBadge } from '@/components/delinquency/delinquency-badge';
import { ReportEmpty } from '@/components/reports/report-empty';
import { Money } from '@/components/ui/money';
import { ROUTES } from '@/config/app';
import { formatBusinessDate } from '@/lib/domain/datetime';
import type { PortfolioRow } from '@/lib/data/reports';

/**
 * A client's loans, with where each one stands.
 *
 * ## Why this exists now when Phase 3 declined it
 *
 * Phase 3 left the client page without a loan list on the reasoning that the
 * register at `/loans` filters by client, so a second route to the same rows
 * was duplication — and that an empty heading would read as "this client has
 * no loans" when the page had not asked.
 *
 * Both objections are answered rather than ignored. The page now *does* ask,
 * so an empty list is a fact rather than an absence, and it says so in a
 * sentence. And what is shown is not the register's rows: it is each loan's
 * derived position — outstanding, arrears, status — which is the question
 * somebody has when they open a client record, and which the register does not
 * answer at a glance.
 *
 * ## Current loans first, finished ones after
 *
 * A settled loan among live ones invites somebody to chase a borrower who has
 * finished paying. Removed entirely, the record would look as though it never
 * happened — which matters when the question is whether to lend again. §132:
 * status never erases history.
 */
export function ClientLoanSummary({
  loans,
}: {
  readonly loans: readonly PortfolioRow[];
}) {
  if (loans.length === 0) {
    return (
      <ReportEmpty
        title="No loans yet"
        description="This client has no loan on record — not a draft, not a settled one."
      />
    );
  }

  const live = loans.filter(
    (loan) => loan.loanStatus !== 'cleared' && loan.loanStatus !== 'cancelled',
  );
  const done = loans.filter(
    (loan) => loan.loanStatus === 'cleared' || loan.loanStatus === 'cancelled',
  );

  return (
    <div className="min-w-0 space-y-3">
      {[...live, ...done].map((loan) => (
        <Card key={loan.loanId} className="min-w-0">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="min-w-0">
              <Link
                href={`${ROUTES.loans}/${loan.loanId}`}
                className="text-brand-700 font-mono hover:underline"
              >
                {loan.loanNumber}
              </Link>
              <p className="text-text-muted text-sm">
                <Money amount={loan.principalAmount} /> borrowed ·{' '}
                {loan.scheduledCompletionDate === null
                  ? 'not yet paid out'
                  : `ends ${formatBusinessDate(loan.scheduledCompletionDate)}`}
              </p>
            </div>
            <div className="flex shrink-0 flex-wrap items-center gap-1.5">
              <Badge
                tone={
                  loan.loanStatus === 'active'
                    ? 'info'
                    : loan.loanStatus === 'cleared'
                      ? 'success'
                      : 'neutral'
                }
              >
                {loan.loanStatus.replace(/_/g, ' ')}
              </Badge>
              {loan.state === null ? null : <DelinquencyBadge state={loan.state} />}
            </div>
          </div>

          <dl className="mt-3 grid min-w-0 grid-cols-2 gap-3 sm:grid-cols-4">
            <div className="min-w-0">
              <dt className="text-text-muted text-sm">Paid</dt>
              <dd className="text-text tabular-nums">
                <Money amount={loan.totalCollected} />
              </dd>
            </div>
            <div className="min-w-0">
              <dt className="text-text-muted text-sm">Outstanding</dt>
              <dd className="text-text tabular-nums">
                <Money amount={loan.totalOutstanding} />
              </dd>
            </div>
            <div className="min-w-0">
              <dt className="text-text-muted text-sm">Past unpaid</dt>
              <dd className="text-text tabular-nums">
                <Money amount={loan.arrearsAmount} />
              </dd>
            </div>
            <div className="min-w-0">
              <dt className="text-text-muted text-sm">Charges unpaid</dt>
              <dd className="text-text tabular-nums">
                <Money amount={loan.penaltyRemaining} />
              </dd>
            </div>
          </dl>

          {loan.loanStatus === 'active' || loan.loanStatus === 'cleared' ? (
            <Link
              href={`${ROUTES.loans}/${loan.loanId}/statement`}
              className="text-brand-700 mt-3 inline-block text-sm hover:underline"
            >
              Statement
            </Link>
          ) : null}
        </Card>
      ))}
    </div>
  );
}
