import { Card } from '@/components/ui/card';
import { Money } from '@/components/ui/money';
import { type BusinessDate } from '@/lib/domain/datetime';
import { toUgx } from '@/lib/domain/money';
import { DateValue } from '@/components/ui/data-value';
import { MONTH_ANCHOR_LABELS, type MonthAnchor } from '@/lib/domain/repayment-schedule';

/**
 * The schedule at a glance.
 *
 * Every figure here is summed from the installment rows rather than stored, so
 * it cannot drift from the schedule it describes. `reconciles` reports whether
 * those rows add up to the loan's contractual total; when they do not, the
 * component says so plainly instead of presenting totals nobody can stand
 * behind. That state should be unreachable — the database reconciles before it
 * commits — which is exactly why it is worth surfacing if it ever appears.
 */
export function ScheduleSummary({
  installmentCount,
  firstDueDate,
  finalDueDate,
  totalScheduledPrincipal,
  totalScheduledInterest,
  totalScheduledAmount,
  frequencyLabel,
  intervalDays,
  monthAnchor,
  disbursementDate,
  reconciles,
}: {
  readonly installmentCount: number;
  readonly firstDueDate: BusinessDate;
  readonly finalDueDate: BusinessDate;
  readonly totalScheduledPrincipal: number;
  readonly totalScheduledInterest: number;
  readonly totalScheduledAmount: number;
  readonly frequencyLabel: string;
  /**
   * Polytos Phase 3. Null for a calendar-monthly schedule, where the step is a
   * month rather than a number of days — so the cadence is described by the
   * anchor convention instead.
   */
  readonly intervalDays: number | null;
  readonly monthAnchor?: MonthAnchor | null;
  readonly disbursementDate: BusinessDate;
  readonly reconciles: boolean;
}) {
  return (
    <div className="min-w-0 space-y-3">
      {reconciles ? null : (
        <p className="bg-danger-surface text-danger rounded-lg px-3 py-2 text-sm">
          <span className="font-medium">These totals do not reconcile.</span> The
          scheduled collections do not add up to the loan&rsquo;s contractual total. Do
          not collect against this schedule; report it immediately.
        </p>
      )}

      <Card>
        <dl className="grid min-w-0 gap-x-6 gap-y-3 sm:grid-cols-2 lg:grid-cols-3">
          <div className="min-w-0">
            <dt className="text-text-muted text-sm">Collections</dt>
            <dd className="text-text text-lg font-semibold tabular-nums">
              {installmentCount}
            </dd>
          </div>

          <div className="min-w-0">
            <dt className="text-text-muted text-sm">Frequency</dt>
            <dd className="text-text text-lg font-semibold">
              {frequencyLabel}
              <span className="text-text-muted ml-1 text-sm font-normal">
                {intervalDays === null
                  ? monthAnchor === null || monthAnchor === undefined
                    ? '(once a calendar month)'
                    : `(once a calendar month, ${MONTH_ANCHOR_LABELS[monthAnchor].toLowerCase()} where the day does not exist)`
                  : `(every ${intervalDays === 1 ? 'day' : `${String(intervalDays)} days`})`}
              </span>
            </dd>
          </div>

          <div className="min-w-0">
            <dt className="text-text-muted text-sm">Disbursed</dt>
            <dd className="text-text text-lg font-semibold">
              <DateValue value={disbursementDate} />
            </dd>
          </div>

          <div className="min-w-0">
            <dt className="text-text-muted text-sm">First collection</dt>
            <dd className="text-text text-lg font-semibold">
              <DateValue value={firstDueDate} />
            </dd>
          </div>

          <div className="min-w-0">
            <dt className="text-text-muted text-sm">Final collection</dt>
            <dd className="text-text text-lg font-semibold">
              <DateValue value={finalDueDate} />
            </dd>
            {/* Named for what a later phase will read it as. Phase 7 builds
                loan expiry, grace periods and penalties on this date. */}
            <dd className="text-text-muted text-xs">Scheduled completion</dd>
          </div>

          <div className="min-w-0">
            <dt className="text-text-muted text-sm">Total scheduled</dt>
            <dd className="text-text text-lg font-semibold tabular-nums">
              <Money amount={toUgx(totalScheduledAmount)} />
            </dd>
            <dd className="text-text-muted text-xs tabular-nums">
              <Money amount={toUgx(totalScheduledPrincipal)} /> principal +{' '}
              <Money amount={toUgx(totalScheduledInterest)} /> interest
            </dd>
          </div>
        </dl>
      </Card>
    </div>
  );
}
