import { Alert } from '@/components/ui/alert';
import { Card } from '@/components/ui/card';
import { DelinquencyBadge } from '@/components/delinquency/delinquency-badge';
import { Money } from '@/components/ui/money';
import { formatBusinessDate } from '@/lib/domain/datetime';
import { formatUgx } from '@/lib/domain/money';
import { DELINQUENCY_STATE_DESCRIPTIONS } from '@/lib/domain/delinquency';
import type { LoanDelinquency } from '@/lib/data/delinquency';
import { DateValue } from '@/components/ui/data-value';
import type { ReactNode } from 'react';

/**
 * A loan's delinquency position, for staff.
 *
 * ## Why the demand is itemised rather than summed
 *
 * The specification is explicit that the screen must not simply say "payment
 * doubled". It would be wrong as soon as two collections are missed, wrong
 * again when one is partly covered, and it tells a staff member nothing they
 * can repeat to a borrower.
 *
 * So the panel shows the parts and then the total:
 *
 *     Previous unpaid    UGX 4,000
 *     Due today          UGX 4,000
 *     ----------------------------
 *     Due now            UGX 8,000
 *
 * which stays correct after any number of misses and any amount of partial
 * coverage, and which a borrower can check against their own receipts.
 *
 * ## Two measures of lateness, both labelled
 *
 * "3 collections missed" and "9 days late" are different facts about an
 * every-3-days loan, and the panel says both rather than picking one. Calling
 * a count of collections "days" would overstate a borrower's lateness
 * threefold, which on a collections list is the difference between a phone
 * call and a visit.
 *
 * ## A pending penalty is labelled as pending
 *
 * When a loan is past its grace deadline the charge is due as a matter of the
 * agreement, but it is only written to the ledger when something touches the
 * loan — the next payment materialises it first, so it cannot be escaped. In
 * between, the panel shows what will be charged and says plainly that it is
 * not yet in the balance. Showing it inside the outstanding figure would make
 * the panel disagree with the receipt the borrower would get.
 */
export function DelinquencyPanel({ position }: { readonly position: LoanDelinquency }) {
  const nothingDue = position.currentDue === 0;

  return (
    <div className="min-w-0 space-y-3">
      {position.reconciles ? null : (
        <Alert tone="danger" title="This delinquency position does not hold together">
          {position.reconciliationProblem ?? 'The figures are inconsistent.'} Do not quote
          any figure on this panel to the borrower. Report it immediately.
        </Alert>
      )}

      {position.penaltyEligible ? (
        <Alert tone="danger" title="A penalty is due on this loan">
          The grace period ended on{' '}
          {position.graceEndDate === null ? (
            'its grace deadline'
          ) : (
            <DateValue value={position.graceEndDate} />
          )}{' '}
          with <Money amount={position.penaltyBasisAsOfGraceEnd} /> unpaid. A charge of{' '}
          <span className="font-semibold">
            <Money amount={position.penaltyProjectedAmount} />
          </span>{' '}
          applies and will be added to this loan the moment any payment is recorded
          against it. It is not included in the balance below yet.
        </Alert>
      ) : null}

      <Card>
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-text text-base font-semibold">Collection position</h3>
          <DelinquencyBadge state={position.state} />
        </div>

        <p className="text-text-muted mb-4 text-sm">
          {DELINQUENCY_STATE_DESCRIPTIONS[position.state]} As at{' '}
          <DateValue value={position.businessDate} />.
        </p>

        {/* --- What is being asked for, itemised --------------------------- */}
        <dl className="border-border min-w-0 rounded-lg border">
          <Row
            label="Previous unpaid"
            hint="Collections dated before today that are still uncovered"
            amount={position.arrearsAmount}
          />
          <Row
            label="Due today"
            hint="Today's scheduled collection, less anything already covering it"
            amount={position.dueToday}
          />
          <Row
            label="Due now"
            hint="What the borrower is asked for today"
            amount={position.currentDue}
            emphasis
          />
        </dl>

        {nothingDue ? (
          <p className="text-success mt-3 text-sm font-medium">
            Nothing is due today or earlier on this loan.
          </p>
        ) : null}

        {/* --- How late ----------------------------------------------------- */}
        <dl className="mt-4 grid min-w-0 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Figure
            label="Collections missed"
            value={String(position.missedInstallmentCount)}
            hint="Past collections still uncovered"
          />
          <Figure
            label="Days late"
            value={
              position.daysPastDue === 0
                ? 'None'
                : position.daysPastDue === 1
                  ? '1 day'
                  : `${String(position.daysPastDue)} days`
            }
            hint={
              position.oldestPastDueDate === null
                ? 'Nothing is overdue'
                : `Since ${formatBusinessDate(position.oldestPastDueDate)}`
            }
          />
          <Figure
            label="Oldest unpaid collection"
            value={
              position.oldestUnpaidDueDate === null ? (
                'None'
              ) : (
                <DateValue value={position.oldestUnpaidDueDate} />
              )
            }
            hint="What the next payment is applied to first"
          />
          <Figure
            label="Final collection"
            value={
              position.scheduledCompletionDate === null ? (
                'Unknown'
              ) : (
                <DateValue value={position.scheduledCompletionDate} />
              )
            }
            hint={
              position.graceEndDate === null
                ? undefined
                : `Grace to ${formatBusinessDate(position.graceEndDate)}`
            }
          />
        </dl>

        {/* --- The balance, with the penalty apart -------------------------- */}
        <div className="border-border mt-4 border-t pt-4">
          <dl className="grid min-w-0 gap-4 sm:grid-cols-3">
            <Figure
              label="Contract outstanding"
              value={<Money amount={position.contractualOutstanding} />}
              hint="Principal and interest still uncovered"
            />
            <Figure
              label="Penalty outstanding"
              value={
                position.penaltyApplied
                  ? formatUgx(position.penaltyRemaining)
                  : 'None charged'
              }
              hint={
                position.penaltyApplied
                  ? `Charged ${formatUgx(position.penaltyAmount)}`
                  : 'No expiry penalty on this loan'
              }
            />
            <Figure
              label="Total outstanding"
              value={<Money amount={position.totalOutstanding} />}
              hint="Contract plus any unpaid penalty"
              emphasis
            />
          </dl>
        </div>

        {position.withinGracePeriod ? (
          <Alert tone="warning" className="mt-4">
            This loan is past its final collection date and inside its{' '}
            {position.graceDays === 1 ? '1-day' : `${String(position.graceDays)}-day`}{' '}
            grace period, which ends on{' '}
            {position.graceEndDate === null ? (
              'its grace deadline'
            ) : (
              <DateValue value={position.graceEndDate} />
            )}
            . Settling in full before then means no penalty.
          </Alert>
        ) : null}
      </Card>
    </div>
  );
}

function Row({
  label,
  hint,
  amount,
  emphasis = false,
}: {
  readonly label: string;
  readonly hint: string;
  readonly amount: number;
  readonly emphasis?: boolean;
}) {
  return (
    <div
      className={`border-border flex min-w-0 flex-wrap items-baseline justify-between gap-x-3 border-b p-3 last:border-b-0 ${
        emphasis ? 'bg-surface-raised' : ''
      }`}
    >
      <div className="min-w-0">
        <dt className={emphasis ? 'text-text font-semibold' : 'text-text'}>{label}</dt>
        <dd className="text-text-muted text-xs">{hint}</dd>
      </div>
      <dd
        className={
          emphasis
            ? 'text-text text-lg font-semibold tabular-nums'
            : 'text-text tabular-nums'
        }
      >
        <Money amount={amount} />
      </dd>
    </div>
  );
}

function Figure({
  label,
  value,
  hint,
  emphasis = false,
}: {
  readonly label: string;
  readonly value: ReactNode;
  readonly hint?: string;
  readonly emphasis?: boolean;
}) {
  return (
    <div className="min-w-0">
      <dt className="text-text-muted text-sm">{label}</dt>
      <dd
        className={
          emphasis
            ? 'text-text text-xl font-semibold tabular-nums'
            : 'text-text font-medium tabular-nums'
        }
      >
        {value}
      </dd>
      {hint === undefined ? null : <dd className="text-text-muted text-xs">{hint}</dd>}
    </div>
  );
}
