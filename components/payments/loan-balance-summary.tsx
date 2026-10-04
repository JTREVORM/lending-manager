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
 * ## The contract and the penalty are shown apart
 *
 * `outstanding` is what remains on the agreement; `penaltyRemaining` is an
 * expiry charge, which is neither principal nor contractual interest. Folding
 * the two together would make `principal + interest` stop adding up to the
 * contractual total, and would hide from a borrower which part of their debt
 * is the loan they took and which part is a charge for being late.
 *
 * `totalOutstanding` is the pair of them, and it is the figure to quote: it is
 * what a payment is capped at and what must reach zero before the loan clears.
 *
 * ## "Due now" versus arrears
 *
 * This panel's "due now" is the sum of scheduled amounts dated today or
 * earlier that remain uncovered. The delinquency panel beside it is where that
 * figure is broken into past-due arrears and today's collection, and where
 * lateness and grace are interpreted. Two panels rather than one, because
 * "what does this loan owe" and "how far behind is this borrower" are
 * different questions that staff ask at different moments.
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
  penaltyAssessed,
  penaltyPaid,
  penaltyRemaining,
  totalOutstanding,
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
  readonly penaltyAssessed: number;
  readonly penaltyPaid: number;
  readonly penaltyRemaining: number;
  readonly totalOutstanding: number;
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
          {penaltyAssessed > 0 ? ' and the penalty have' : ' has'} been covered and the
          loan is settled.
        </Alert>
      ) : null}

      <Card>
        <dl className="grid min-w-0 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <div className="min-w-0">
            <dt className="text-text-muted text-sm">Total outstanding</dt>
            <dd className="text-text text-2xl font-semibold tabular-nums">
              {formatUgx(toUgx(totalOutstanding))}
            </dd>
            {penaltyRemaining > 0 ? (
              <dd className="text-text-muted text-xs">
                {formatUgx(toUgx(outstanding))} on the contract plus{' '}
                {formatUgx(toUgx(penaltyRemaining))} penalty
              </dd>
            ) : (
              <dd className="text-text-muted text-xs">On the contract</dd>
            )}
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
            {penaltyAssessed > 0 ? (
              <div className="min-w-0">
                <dt className="text-text-muted text-sm">Penalty</dt>
                <dd className="text-text tabular-nums">
                  {formatUgx(toUgx(penaltyPaid))} paid,{' '}
                  <span className="font-medium">
                    {formatUgx(toUgx(penaltyRemaining))}
                  </span>{' '}
                  remaining
                </dd>
                <dd className="text-text-muted text-xs">
                  A charge for late settlement. Not part of the loan&rsquo;s principal or
                  interest.
                </dd>
              </div>
            ) : null}
          </dl>
        </div>
      </Card>
    </div>
  );
}
