import Link from 'next/link';

import { Card } from '@/components/ui/card';
import { PortalLoanPosition } from '@/components/delinquency/portal-loan-position';
import { Money } from '@/components/ui/money';
import { ROUTES } from '@/config/app';
import type { LoanDelinquency } from '@/lib/data/delinquency';
import type { PortfolioRow } from '@/lib/data/reports';
import { DateValue } from '@/components/ui/data-value';

/**
 * One of a borrower's loans, in the portal.
 *
 * ## It wraps Phase 7 rather than replacing it
 *
 * `PortalLoanPosition` already says what is due now, what was missed, what
 * remains and when the loan ends, in careful language that four sections of
 * Phase 7's specification went into. Phase 8 adds what it was missing — the
 * agreement itself — and a link to the full statement. Rewriting the position
 * panel would have meant re-earning all of that wording, and getting one
 * sentence of it wrong is how a borrower reads an outstanding balance as a
 * settlement quote.
 *
 * ## Business-friendly labels
 *
 * Amount borrowed, total interest, total to repay, next payment. Nothing says
 * principal, obligation, allocation or basis points — §11. The one internal
 * word kept is the loan number, because that is what a borrower is asked for
 * at the counter.
 */
export function PortalLoanCard({
  position,
  loan,
}: {
  readonly position: LoanDelinquency;
  /** The contract, from the portfolio view. Absent is survivable, not expected. */
  readonly loan: PortfolioRow | undefined;
}) {
  return (
    <div className="min-w-0 space-y-3">
      <PortalLoanPosition position={position} />

      {loan === undefined ? null : (
        <Card className="min-w-0">
          <h4 className="text-text text-sm font-semibold">What you agreed</h4>
          <dl className="mt-3 grid min-w-0 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div className="min-w-0">
              <dt className="text-text-muted text-sm">Amount borrowed</dt>
              <dd className="text-text">
                <Money amount={loan.principalAmount} />
              </dd>
            </div>
            <div className="min-w-0">
              <dt className="text-text-muted text-sm">Total interest</dt>
              <dd className="text-text">
                <Money amount={loan.contractualInterest} />
              </dd>
            </div>
            <div className="min-w-0">
              <dt className="text-text-muted text-sm">Total to repay</dt>
              <dd className="text-text">
                <Money amount={loan.totalExpectedRepayment} />
              </dd>
            </div>
            <div className="min-w-0">
              <dt className="text-text-muted text-sm">Amount paid so far</dt>
              <dd className="text-text">
                <Money amount={loan.totalCollected} />
              </dd>
            </div>
            {loan.penaltyAssessed > 0 ? (
              <div className="min-w-0">
                <dt className="text-text-muted text-sm">Late-payment charge</dt>
                <dd className="text-text">
                  <Money amount={loan.penaltyAssessed} />
                </dd>
              </div>
            ) : null}
            {position.oldestUnpaidDueDate === null ? null : (
              <div className="min-w-0">
                <dt className="text-text-muted text-sm">Next payment date</dt>
                <dd className="text-text">
                  <DateValue value={position.oldestUnpaidDueDate} />
                </dd>
              </div>
            )}
            <div className="min-w-0">
              <dt className="text-text-muted text-sm">Loan completion date</dt>
              <dd className="text-text">
                {loan.scheduledCompletionDate === null ? (
                  '—'
                ) : (
                  <DateValue value={loan.scheduledCompletionDate} />
                )}
              </dd>
            </div>
          </dl>

          <Link
            href={`${ROUTES.portal}/loans/${position.loanId}`}
            className="text-brand-700 mt-3 inline-block text-sm hover:underline"
          >
            See the full statement, payment plan and receipts
          </Link>
        </Card>
      )}
    </div>
  );
}
