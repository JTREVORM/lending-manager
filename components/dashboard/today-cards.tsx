import { formatUgx } from '@/lib/domain/money';
import { StatCard, StatGrid } from '@/components/reports/stat-card';
import type { CollectionSummary } from '@/lib/data/dashboard';

/**
 * Today's collection figures.
 *
 * ## Three numbers that are not a subtraction
 *
 * Expected, collected and still-due are shown side by side, and the note under
 * them says explicitly that the first minus the second is not the third. It
 * genuinely is not: money taken today may settle a collection from last month
 * or run ahead into next week. Presenting them as a tidy sum would invent a
 * relationship the ledger does not have, and the first person to notice they
 * do not add up would stop trusting all three.
 *
 * ## The method split is not a cash position
 *
 * "Cash received" is cash that came in today. It is not cash at hand: the
 * business also spends and banks money, and this system records neither. The
 * labels say *received* for that reason, and the definitions under them say it
 * again.
 */
export function TodayCards({
  summary,
  canSeeMethods,
}: {
  readonly summary: CollectionSummary;
  /** The method split is a cash-handling figure; not every role needs it. */
  readonly canSeeMethods: boolean;
}) {
  return (
    <section aria-labelledby="today-heading" className="min-w-0 space-y-3">
      <h2 id="today-heading" className="text-base">
        Today
      </h2>

      <StatGrid>
        <StatCard
          label="Expected today"
          value={formatUgx(summary.expectedToday)}
          secondary={`${String(summary.loansDueToday)} ${summary.loansDueToday === 1 ? 'loan' : 'loans'} · ${String(summary.clientsDueToday)} ${summary.clientsDueToday === 1 ? 'client' : 'clients'}`}
          metric="expected_today"
        />
        <StatCard
          label="Collected today"
          value={formatUgx(summary.collectedToday)}
          secondary={`${String(summary.paymentsToday)} ${summary.paymentsToday === 1 ? 'payment' : 'payments'}`}
          metric="collected_today"
          tone={summary.collectedToday > 0 ? 'success' : 'neutral'}
        />
        <StatCard
          label="Still due today"
          value={formatUgx(summary.remainingToday)}
          secondary={`${String(summary.loansSettledToday)} of ${String(summary.loansDueToday)} settled`}
          metric="remaining_today"
          tone={summary.remainingToday > 0 ? 'warning' : 'success'}
        />
        {summary.reversedTodayCount > 0 ? (
          <StatCard
            label="Reversed today"
            value={formatUgx(summary.reversedTodayAmount)}
            secondary={`${String(summary.reversedTodayCount)} withdrawn`}
            metric="reversed_today_amount"
            tone="danger"
          />
        ) : null}
      </StatGrid>

      <p className="text-text-muted text-sm">
        Expected today is this morning&rsquo;s target. Collected today is every payment
        taken today, which may settle an older collection or run ahead, so{' '}
        <strong>expected minus collected is not the same as still due today</strong>.
      </p>

      {canSeeMethods ? (
        <>
          <h3 className="text-text pt-1 text-sm font-semibold">
            Payments received today, by method
          </h3>
          <StatGrid>
            <StatCard
              label="Cash received"
              value={formatUgx(summary.cashReceived)}
              metric="cash_received"
            />
            <StatCard
              label="MTN received"
              value={formatUgx(summary.mtnReceived)}
              metric="mtn_received"
            />
            <StatCard
              label="Airtel received"
              value={formatUgx(summary.airtelReceived)}
              metric="airtel_received"
            />
          </StatGrid>
        </>
      ) : null}
    </section>
  );
}
