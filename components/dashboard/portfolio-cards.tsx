import { ROUTES } from '@/config/app';
import { formatUgx } from '@/lib/domain/money';
import { StatCard, StatGrid } from '@/components/reports/stat-card';
import { DELINQUENCY_STATE_LABELS } from '@/lib/domain/delinquency';
import type { PortfolioSummary } from '@/lib/data/dashboard';

/**
 * The loan book: how many loans, what is owed, and who is behind.
 *
 * ## Lifecycle counts and delinquency counts are shown apart
 *
 * "Active loans" is a lifecycle fact — disbursed and not settled. "In arrears"
 * is a delinquency fact about the same loans. A penalised loan is *both*, so
 * adding the two families together double-counts, and the two are given
 * separate headings for exactly that reason (§112).
 *
 * Within delinquency, the state breakdown uses Phase 7's mutually exclusive
 * states, so the counts partition the disbursed book and sum to its size. The
 * overlapping measures — loans with arrears, penalised, penalty pending —
 * appear separately and say in their definitions that they overlap.
 */
export function PortfolioCards({
  summary,
  canSeeReports,
}: {
  readonly summary: PortfolioSummary;
  readonly canSeeReports: boolean;
}) {
  const states = [
    'in_arrears',
    'grace_period',
    'expired_unpaid',
    'penalty_due',
    'due_today',
    'current',
    'cleared',
  ] as const;

  return (
    <section aria-labelledby="portfolio-heading" className="min-w-0 space-y-3">
      <h2 id="portfolio-heading" className="text-base">
        The loan book
      </h2>

      <StatGrid>
        <StatCard
          label="Active loans"
          value={String(summary.loansActive)}
          secondary={`${String(summary.clientsWithActiveLoan)} ${summary.clientsWithActiveLoan === 1 ? 'client' : 'clients'} borrowing`}
          metric="loans_active"
          href={canSeeReports ? `${ROUTES.reports}/loans?status=active` : undefined}
        />
        <StatCard
          label="Cleared loans"
          value={String(summary.loansCleared)}
          metric="loans_cleared"
          href={canSeeReports ? `${ROUTES.reports}/loans?status=cleared` : undefined}
        />
        <StatCard
          label="Outstanding portfolio"
          value={formatUgx(summary.totalOutstanding)}
          secondary={`${formatUgx(summary.contractualOutstanding)} contract · ${formatUgx(summary.penaltyOutstanding)} charges`}
          metric="total_outstanding"
        />
        <StatCard
          label="Arrears"
          value={formatUgx(summary.arrearsTotal)}
          secondary={`${String(summary.loansWithArrears)} ${summary.loansWithArrears === 1 ? 'loan' : 'loans'} behind`}
          metric="arrears_total"
          tone={summary.arrearsTotal > 0 ? 'warning' : 'neutral'}
          href={ROUTES.overdue}
        />
      </StatGrid>

      <h3 className="text-text pt-1 text-sm font-semibold">Disbursed loans by status</h3>
      <p className="text-text-muted text-sm">
        Each loan appears in exactly one of these, so the {String(states.length)} counts
        add up to the {String(summary.loansWithSchedule)} disbursed{' '}
        {summary.loansWithSchedule === 1 ? 'loan' : 'loans'}.
      </p>

      <StatGrid>
        {states.map((state) => (
          <StatCard
            key={state}
            label={DELINQUENCY_STATE_LABELS[state]}
            value={String(summary.byState[state])}
            definition={`Loans whose current status is "${DELINQUENCY_STATE_LABELS[state]}". Mutually exclusive with the other statuses.`}
            tone={
              state === 'penalty_due' || state === 'expired_unpaid'
                ? 'danger'
                : state === 'in_arrears' || state === 'grace_period'
                  ? 'warning'
                  : state === 'cleared'
                    ? 'success'
                    : 'neutral'
            }
            href={canSeeReports ? `${ROUTES.reports}/loans?state=${state}` : undefined}
          />
        ))}
      </StatGrid>

      <p className="text-text-muted text-sm">
        Separately, {String(summary.loansWithArrears)}{' '}
        {summary.loansWithArrears === 1 ? 'loan has' : 'loans have'} a past-due amount.
        That count <strong>overlaps</strong> the statuses above — a penalised loan usually
        has arrears too — so it is never added to them.
      </p>

      <h3 className="text-text pt-1 text-sm font-semibold">Late-payment charges</h3>
      <StatGrid>
        <StatCard
          label="Penalties charged"
          value={formatUgx(summary.penaltyAssessed)}
          secondary={`${String(summary.loansPenalised)} ${summary.loansPenalised === 1 ? 'loan' : 'loans'}`}
          metric="penalty_assessed"
          href={canSeeReports ? `${ROUTES.reports}/penalties` : undefined}
        />
        <StatCard
          label="Penalties unpaid"
          value={formatUgx(summary.penaltyOutstanding)}
          metric="penalty_outstanding"
          tone={summary.penaltyOutstanding > 0 ? 'warning' : 'neutral'}
        />
        <StatCard
          label="Penalty pending"
          value={String(summary.loansPenaltyPending)}
          metric="loans_penalty_pending"
          tone={summary.loansPenaltyPending > 0 ? 'danger' : 'neutral'}
        />
      </StatGrid>
    </section>
  );
}
