import { formatUgx } from '@/lib/domain/money';
import { StatCard, StatGrid } from '@/components/reports/stat-card';
import type { PortfolioSummary } from '@/lib/data/dashboard';
import { Money } from '@/components/ui/money';

/**
 * The executive summary: what the business has lent, and what it has received.
 *
 * ## Three claims it does not make
 *
 * **Profit.** No staff costs, no bad debt, no cost of capital, no tax are
 * modelled, so a figure labelled profit would be an accounting claim this
 * system cannot support.
 *
 * **Penalties charged as income.** Charged and collected are separate cards.
 * Booking an assessed penalty as revenue would recognise money that may never
 * arrive.
 *
 * **Cash at hand.** That is the Finance module's figure, read from the
 * ledger. Nothing here is a balance.
 *
 * Interest charged and interest collected sit side by side because they are
 * rarely equal and the difference is meaningful, so neither stands in for the
 * other.
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
          value={<Money amount={summary.principalDisbursed} />}
          secondary={`${String(summary.loansActive + summary.loansCleared)} ${summary.loansActive + summary.loansCleared === 1 ? 'loan' : 'loans'} paid out`}
          metric="principal_disbursed"
        />
        <StatCard
          label="Total collected"
          value={<Money amount={summary.totalCollected} />}
          secondary="Reversed payments excluded"
          metric="total_collected"
          tone="success"
        />
        <StatCard
          label="Outstanding portfolio"
          value={<Money amount={summary.totalOutstanding} />}
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
          value={<Money amount={summary.principalCollected} />}
          secondary={`${formatUgx(summary.principalOutstanding)} still owed`}
          metric="principal_collected"
        />
        <StatCard
          label="Interest charged"
          value={<Money amount={summary.contractualInterest} />}
          metric="contractual_interest"
        />
        <StatCard
          label="Interest collected"
          value={<Money amount={summary.interestCollected} />}
          secondary={`${formatUgx(summary.interestOutstanding)} still owed`}
          metric="interest_collected"
        />
        <StatCard
          label="Penalty collected"
          value={<Money amount={summary.penaltyCollected} />}
          secondary={`${formatUgx(summary.penaltyAssessed)} charged`}
          metric="penalty_collected"
        />
      </StatGrid>

      {/*
        Kept, and shortened to one line.

        Everything else explanatory on this screen moved behind an info
        control, but not this: "interest collected" invites the reading
        "profit", and a figure a reader silently converts into profit is worse
        than no figure. The claim has to be denied where the figures are, not
        one click away.
      */}
      <p className="text-text-muted text-xs">
        Neither is profit — this system records no costs.
      </p>
    </section>
  );
}
