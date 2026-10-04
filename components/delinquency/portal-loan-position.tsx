import { Alert } from '@/components/ui/alert';
import { Card } from '@/components/ui/card';
import { DelinquencyBadge } from '@/components/delinquency/delinquency-badge';
import { Money } from '@/components/ui/money';
import { formatBusinessDate } from '@/lib/domain/datetime';
import { formatUgx } from '@/lib/domain/money';
import type { LoanDelinquency } from '@/lib/data/delinquency';
import { DateValue } from '@/components/ui/data-value';

/**
 * A borrower's own loan position, in the portal.
 *
 * ## Why Phase 7 shows a balance where Phase 6 withheld one
 *
 * Phase 6 deliberately showed a borrower their payment history and no balance,
 * because a single outstanding figure in a self-service portal reads as a
 * settlement quote, and an early-settlement figure is a commercial decision
 * nobody had made.
 *
 * Phase 7 is asked for the opposite, and the request is right: a borrower who
 * is behind needs to know *that they are behind*, by how much, and by when —
 * and learning it from a phone call rather than their own account is worse for
 * everybody. The Phase 6 worry is answered by showing the position rather than
 * a number:
 *
 *   * **what is due now**, itemised into what was missed and what falls due
 *     today, which is the figure to bring to the counter;
 *   * **the total still owed**, labelled as the whole loan rather than a
 *     settlement figure, with the penalty shown separately when one exists;
 *   * **when the loan ends**, so "how much longer" has an answer.
 *
 * ## The four figures are kept distinct
 *
 * Scheduled payment, past unpaid amount, current amount due, and total
 * outstanding are four different numbers, and the specification is emphatic
 * that a borrower must be able to tell them apart. Each has its own label and
 * its own explanatory line; none is presented as a substitute for another.
 *
 * ## What a borrower is never shown
 *
 * No staff attribution, no internal remarks, no other borrower's anything, and
 * no projected penalty dressed up as a charge that already exists. Where a
 * charge is pending the wording says so and tells them to come in — inventing
 * certainty about a figure that is not yet on the ledger would be worse than
 * saying nothing.
 */
export function PortalLoanPosition({ position }: { readonly position: LoanDelinquency }) {
  const settled = position.state === 'cleared';

  return (
    <Card className="min-w-0">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-text text-base font-semibold">
          Loan <span className="font-mono">{position.loanNumber}</span>
        </h3>
        <DelinquencyBadge state={position.state} />
      </div>

      {settled ? (
        <Alert tone="success">
          This loan is fully paid. Thank you — there is nothing more to pay on it.
        </Alert>
      ) : (
        <>
          <dl className="grid min-w-0 gap-4 sm:grid-cols-2">
            <div className="min-w-0">
              <dt className="text-text-muted text-sm">Please pay now</dt>
              <dd className="text-text text-2xl font-semibold tabular-nums">
                <Money amount={position.currentDue} />
              </dd>
              <dd className="text-text-muted text-xs">
                {position.arrearsAmount > 0
                  ? `${formatUgx(position.arrearsAmount)} not yet paid from earlier, plus ${formatUgx(position.dueToday)} due today`
                  : 'Your payment due today'}
              </dd>
            </div>

            <div className="min-w-0">
              <dt className="text-text-muted text-sm">Still to pay on this loan</dt>
              <dd className="text-text text-2xl font-semibold tabular-nums">
                <Money amount={position.totalOutstanding} />
              </dd>
              <dd className="text-text-muted text-xs">
                {position.penaltyRemaining > 0
                  ? `Includes a late-payment charge of ${formatUgx(position.penaltyRemaining)}`
                  : 'The whole remaining balance, not a settlement offer'}
              </dd>
            </div>
          </dl>

          {position.arrearsAmount > 0 ? (
            <Alert tone="warning" className="mt-4">
              <span className="font-medium">
                {position.missedInstallmentCount === 1
                  ? '1 payment has been missed'
                  : `${String(position.missedInstallmentCount)} payments have been missed`}
                {position.daysPastDue > 0
                  ? `, the oldest ${position.daysPastDue === 1 ? '1 day' : `${String(position.daysPastDue)} days`} ago`
                  : ''}
                .
              </span>{' '}
              Missed payments are added to what you owe now. They do not add extra
              interest.
            </Alert>
          ) : null}

          {position.withinGracePeriod ? (
            <Alert tone="warning" className="mt-4">
              Your final payment date has passed. You have until{' '}
              {position.graceEndDate === null ? (
                'the end of your grace period'
              ) : (
                <DateValue value={position.graceEndDate} />
              )}{' '}
              to pay the balance in full with no extra charge. After that a late-payment
              charge applies.
            </Alert>
          ) : null}

          {position.penaltyEligible ? (
            <Alert tone="danger" className="mt-4">
              Your grace period has passed and this loan is still unpaid, so a
              late-payment charge of{' '}
              <span className="font-semibold">
                <Money amount={position.penaltyProjectedAmount} />
              </span>{' '}
              applies. It will be added to your balance when you next pay. Please speak to
              our staff.
            </Alert>
          ) : null}

          {position.penaltyApplied && position.penaltyRemaining > 0 ? (
            <Alert tone="danger" className="mt-4">
              A late-payment charge of <Money amount={position.penaltyAmount} /> was added
              to this loan
              {position.penaltyAppliedEffectiveDate === null
                ? ''
                : ` on ${formatBusinessDate(position.penaltyAppliedEffectiveDate)}`}
              , of which <Money amount={position.penaltyRemaining} /> is still to pay. It
              is a charge for settling late, not interest.
            </Alert>
          ) : null}

          <dl className="border-border mt-4 grid min-w-0 gap-3 border-t pt-4 sm:grid-cols-2">
            <div className="min-w-0">
              <dt className="text-text-muted text-sm">Next payment to clear</dt>
              <dd className="text-text">
                {position.oldestUnpaidDueDate === null ? (
                  'Nothing outstanding'
                ) : (
                  <DateValue value={position.oldestUnpaidDueDate} />
                )}
              </dd>
            </div>
            <div className="min-w-0">
              <dt className="text-text-muted text-sm">Last payment date on this loan</dt>
              <dd className="text-text">
                {position.scheduledCompletionDate === null ? (
                  'Unknown'
                ) : (
                  <DateValue value={position.scheduledCompletionDate} />
                )}
              </dd>
            </div>
          </dl>
        </>
      )}
    </Card>
  );
}
