import { Alert } from '@/components/ui/alert';
import { Card } from '@/components/ui/card';
import { formatBusinessDate, formatInstant } from '@/lib/domain/datetime';
import { formatUgx } from '@/lib/domain/money';
import { formatBps, toBps } from '@/lib/domain/rate';
import type { LoanPenalty } from '@/lib/data/delinquency';

/**
 * A penalty, with the arithmetic that produced it.
 *
 * ## Why the whole derivation is on screen
 *
 * A borrower asked to pay an extra UGX 50,000 will ask why, and a staff member
 * needs to be able to answer from this panel alone: the loan's final
 * collection date, the grace period it was given, the date the charge took
 * effect, the balance it was charged on, and the rate. Every one of those is
 * stored on the penalty row itself rather than looked up, so this panel is a
 * rendering of a record and not a re-derivation that could disagree with it.
 *
 * The basis deserves its own line and its own sentence, because it is the
 * figure people get wrong: it is what was owed **when the grace period ran
 * out**, not what is owed today. A borrower who paid late after the deadline
 * has a smaller balance now, and the charge was already fixed.
 */
export function PenaltyCard({
  penalty,
  timeZone,
}: {
  readonly penalty: LoanPenalty;
  readonly timeZone: string;
}) {
  const settled = penalty.remainingAmount === 0;

  return (
    <Card className="min-w-0">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-text text-base font-semibold">Expiry penalty</h3>
        <span
          className={
            settled
              ? 'text-success text-sm font-medium'
              : 'text-danger text-sm font-medium'
          }
        >
          {settled ? 'Paid in full' : `${formatUgx(penalty.remainingAmount)} outstanding`}
        </span>
      </div>

      <dl className="grid min-w-0 gap-3 sm:grid-cols-2">
        <Line label="Charge">
          <span className="text-lg font-semibold tabular-nums">
            {formatUgx(penalty.penaltyAmount)}
          </span>
        </Line>
        <Line label="Paid">
          <span className="tabular-nums">{formatUgx(penalty.allocatedAmount)}</span>
        </Line>
        <Line label="Charged on balance of">
          <span className="tabular-nums">{formatUgx(penalty.basisAmount)}</span>
        </Line>
        <Line label="Rate">{formatBps(toBps(penalty.penaltyRateBps))}</Line>
        <Line label="Final collection was due">
          {formatBusinessDate(penalty.finalDueDate)}
        </Line>
        <Line label="Grace period">
          {penalty.graceDays === 1 ? '1 day' : `${String(penalty.graceDays)} days`}, to{' '}
          {formatBusinessDate(penalty.graceEndDate)}
        </Line>
        <Line label="Charge took effect">
          {formatBusinessDate(penalty.effectiveDate)}
        </Line>
        <Line label="Recorded">{formatInstant(penalty.appliedAt, { timeZone })}</Line>
      </dl>

      <p className="text-text-muted mt-3 text-sm">
        {formatUgx(penalty.basisAmount)} is what this loan owed when its grace period ran
        out on {formatBusinessDate(penalty.graceEndDate)} — not what it owes now. The
        charge was fixed on that date and does not change if the balance falls afterwards.
      </p>

      <Alert tone="info" className="mt-3">
        This charge was applied by the system from the loan&rsquo;s own agreed terms. It
        is not entered by staff, cannot be edited, and is recorded once.
      </Alert>
    </Card>
  );
}

function Line({
  label,
  children,
}: {
  readonly label: string;
  readonly children: React.ReactNode;
}) {
  return (
    <div className="min-w-0">
      <dt className="text-text-muted text-sm">{label}</dt>
      <dd className="text-text mt-0.5 break-words">{children}</dd>
    </div>
  );
}
