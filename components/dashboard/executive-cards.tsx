import { formatUgx } from '@/lib/domain/money';
import { StatCard, StatGrid } from '@/components/reports/stat-card';
import type { PortfolioSummary } from '@/lib/data/dashboard';

/**
 * The executive summary: what the business has lent, and what it has received.
 *
 * ## Three things this deliberately does not say
 *
 * **It does not say "profit".** Interest collected is interest collected. The
 * system models no staff costs, no bad debt, no cost of capital and no tax, so
 * a figure labelled profit would be an accounting claim it cannot support. The
 * Owner can see what came in; what it was worth is a question this software is
 * not equipped to answer.
 *
 * **It does not treat a charge as income.** Penalties *charged* and penalties
 * *collected* are separate cards, and the first is labelled as a charge raised
 * against borrowers. Booking an assessed penalty as revenue would recognise
 * money that may never arrive.
 *
 * **It does not say "cash at hand".** There is no cash or bank accounting in
 * this system — no float, no banking, no expenses — so the method split lives
 * on the operational card as "received" and no balance is claimed anywhere.
 *
 * ## Charged and collected, side by side
 *
 * Interest charged is the contractual total on every disbursed loan; interest
 * collected is the interest component of posted allocations. They are rarely
 * equal and the difference is meaningful, so both appear with the outstanding
 * remainder beside them rather than one standing in for the other.
 */
export function ExecutiveCards({ summary }: { readonly summary: PortfolioSummary }) {
  return (
    <section aria-labelledby="executive-heading" className="min-w-0 space-y-3">
      <h2 id="executive-heading" className="text-base">
        Business summary
      </h2>

      <StatGrid>
        <StatCard
          label="Principal disbursed"
          value={formatUgx(summary.principalDisbursed)}
          secondary={`${String(summary.loansActive + summary.loansCleared)} ${summary.loansActive + summary.loansCleared === 1 ? 'loan' : 'loans'} paid out`}
          metric="principal_disbursed"
        />
        <StatCard
          label="Total collected"
          value={formatUgx(summary.totalCollected)}
          secondary="Reversed payments excluded"
          metric="total_collected"
          tone="success"
        />
        <StatCard
          label="Outstanding portfolio"
          value={formatUgx(summary.totalOutstanding)}
          metric="total_outstanding"
        />
        <StatCard
          label="Clients"
          value={String(summary.totalClients)}
          secondary={`${String(summary.activeClients)} active`}
          metric="total_clients"
        />
      </StatGrid>

      <h3 className="text-text pt-1 text-sm font-semibold">Charged against collected</h3>
      <StatGrid>
        <StatCard
          label="Principal collected"
          value={formatUgx(summary.principalCollected)}
          secondary={`${formatUgx(summary.principalOutstanding)} still owed`}
          metric="principal_collected"
        />
        <StatCard
          label="Interest charged"
          value={formatUgx(summary.contractualInterest)}
          metric="contractual_interest"
        />
        <StatCard
          label="Interest collected"
          value={formatUgx(summary.interestCollected)}
          secondary={`${formatUgx(summary.interestOutstanding)} still owed`}
          metric="interest_collected"
        />
        <StatCard
          label="Penalty collected"
          value={formatUgx(summary.penaltyCollected)}
          secondary={`${formatUgx(summary.penaltyAssessed)} charged`}
          metric="penalty_collected"
        />
      </StatGrid>

      <p className="text-text-muted text-sm">
        Interest charged is what the business agreed to charge; interest collected is what
        has been received. Neither is profit — this system records no costs, so it cannot
        tell you what the business earned.
      </p>
    </section>
  );
}
