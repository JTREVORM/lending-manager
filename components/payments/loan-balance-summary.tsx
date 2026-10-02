import { Alert } from '@/components/ui/alert';
import { Card } from '@/components/ui/card';
import { formatUgx, toUgx } from '@/lib/domain/money';

/**
 * A loan's financial position.
 *
 * ## Every figure here is derived, not stored
 *
 * They come from `loan_balances`, which computes them from the contract and
 * the allocations of posted payments each time it is read. So reversing a
 * payment changes this panel the instant it commits, and there is no cached
 * figure that could disagree with the ledger.
 *
 * `reconciles` reports whether the figures satisfied every invariant when they
 * were read. That state should be unreachable — the posting function
 * reconciles before it commits — which is exactly why it is worth surfacing
 * loudly if it ever appears: a borrower must not be shown a balance nobody can
 * stand behind.
 *
 * ## Why "due now" is not called arrears
 *
 * `unpaidScheduledDue` is the sum of scheduled amounts dated today or earlier
 * that remain uncovered, and nothing more. Whether that is *arrears* depends
 * on a grace period and carries a penalty, both of which are Phase 7's. Naming
 * it arrears here would be making a judgement about a borrower on no basis.
 */
export function LoanBalanceSummary({
  totalExpectedRepayment,
  totalPaid,
  outstanding,
  principalPaid,
  principalRemaining,
  interestPaid,
  interestRemaining,
  unpaidScheduledDue,
  postedPaymentCount,
  reversedPaymentCount,
  fullyRepaid,
  reconciles,
  reconciliationProblem,
}: {
  readonly totalExpectedRepayment: number;
  readonly totalPaid: number;
  readonly outstanding: number;
  readonly principalPaid: number;
  readonly principalRemaining: number;
  readonly interestPaid: number;
  readonly interestRemaining: number;
  readonly unpaidScheduledDue: number;
  readonly postedPaymentCount: number;
  readonly reversedPaymentCount: number;
  readonly fullyRepaid: boolean;
  readonly reconciles: boolean;
  readonly reconciliationProblem: string | null;
}) {
  const paidPercent =
    totalExpectedRepayment === 0
      ? 0
      : Math.round((totalPaid / totalExpectedRepayment) * 100);

  return (
    <div className="min-w-0 space-y-3">
      {reconciles ? null : (
        <Alert tone="danger" title="This balance does not reconcile">
          {reconciliationProblem ?? 'The ledger is inconsistent.'} Do not take a payment
          against this loan or quote this figure to the borrower. Report it immediately.
        </Alert>
      )}

      {fullyRepaid ? (
        <Alert tone="success">
          <span className="font-medium">Fully repaid.</span> Every scheduled collection
          has been covered and the loan is settled.
        </Alert>
      ) : null}

      <Card>
        <dl className="grid min-w-0 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <div className="min-w-0">
            <dt className="text-text-muted text-sm">Outstanding</dt>
            <dd className="text-text text-2xl font-semibold tabular-nums">
              {formatUgx(toUgx(outstanding))}
            </dd>
          </div>

          <div className="min-w-0">
            <dt className="text-text-muted text-sm">Paid</dt>
            <dd className="text-text text-2xl font-semibold tabular-nums">
              {formatUgx(toUgx(totalPaid))}
            </dd>
            <dd className="text-text-muted text-xs">
              {paidPercent}% of {formatUgx(toUgx(totalExpectedRepayment))}
            </dd>
          </div>

          <div className="min-w-0">
            <dt className="text-text-muted text-sm">Due now</dt>
            <dd className="text-text text-2xl font-semibold tabular-nums">
              {formatUgx(toUgx(unpaidScheduledDue))}
            </dd>
            <dd className="text-text-muted text-xs">
              Scheduled on or before today and not yet covered
            </dd>
          </div>

          <div className="min-w-0">
            <dt className="text-text-muted text-sm">Payments</dt>
            <dd className="text-text text-2xl font-semibold tabular-nums">
              {postedPaymentCount}
            </dd>
            {reversedPaymentCount > 0 ? (
              <dd className="text-text-muted text-xs">
                {reversedPaymentCount} reversed, not counted
              </dd>
            ) : null}
          </div>
        </dl>

        {/* --- The split -------------------------------------------------- */}
        <div className="border-border mt-4 border-t pt-4">
          <dl className="grid min-w-0 gap-4 sm:grid-cols-2">
            <div className="min-w-0">
              <dt className="text-text-muted text-sm">Principal</dt>
              <dd className="text-text tabular-nums">
                {formatUgx(toUgx(principalPaid))} paid,{' '}
                <span className="font-medium">
                  {formatUgx(toUgx(principalRemaining))}
                </span>{' '}
                remaining
              </dd>
            </div>
            <div className="min-w-0">
              <dt className="text-text-muted text-sm">Interest</dt>
              <dd className="text-text tabular-nums">
                {formatUgx(toUgx(interestPaid))} paid,{' '}
                <span className="font-medium">{formatUgx(toUgx(interestRemaining))}</span>{' '}
                remaining
              </dd>
            </div>
          </dl>
        </div>
      </Card>
    </div>
  );
}
