import { Layers, ShieldAlert } from 'lucide-react';

import { StatCard, StatGrid } from '@/components/reports/stat-card';
import { Money } from '@/components/ui/money';
import { RowLink } from '@/components/ui/row-link';
import { ROUTES } from '@/config/app';
import type { ParSlice } from '@/lib/data/security';
import { AGING_BUCKET_LABELS, formatRatioBps, ratioSeverity } from '@/lib/domain/risk';

/**
 * Portfolio at risk, on the page a person opens first.
 *
 * ## Why PAR 30 and not all five
 *
 * Phase 14 computes PAR at 1, 7, 30, 60 and 90 days, and Debt & Security shows
 * all five with the principal behind each. Five ratios on a dashboard is a
 * table, and a reader who has to compare five numbers to form an impression
 * has not been given an impression.
 *
 * PAR 30 is the one figure. It is the threshold the industry reports on, it is
 * past the point where a late payment is a missed collection rather than a
 * slow week, and it is the number a lender would be asked for. The other four
 * are a click away, and the card says so.
 *
 * ## The denominator is on the card
 *
 * A percentage on its own invites a reader to compare it with a figure from
 * somewhere else that was computed differently. So the tile carries the
 * principal at risk beneath it, and the definition says what the ratio divides
 * by: outstanding principal on loans past due, over outstanding principal. The
 * two substitutions that quietly break that are using *total* outstanding,
 * which includes interest not yet earned, and using the arrears figure, which
 * is a fraction of the exposure rather than the exposure.
 *
 * ## An empty book has no PAR
 *
 * `null` renders as a dash, not `0.0%`. A business with no active loans is not
 * a business in perfect health, and a tile reading zero says the second thing.
 */
export function RiskHeadline({ slice }: { readonly slice: ParSlice }) {
  const par30 = slice.parBps[30];
  const severity = ratioSeverity(par30);

  const worst = slice.loansByBucket['90_plus'];
  const worstPrincipal = slice.principalByBucket['90_plus'];

  return (
    <section aria-labelledby="risk-headline-heading" className="min-w-0 space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="risk-headline-heading" className="text-base">
          Portfolio at risk
        </h2>
        <RowLink
          href={`${ROUTES.reports}/aging`}
          className="text-brand-700 text-sm font-medium underline-offset-2 hover:underline"
        >
          Aging and all five ratios
        </RowLink>
      </div>

      <StatGrid>
        <StatCard
          label="PAR 30"
          value={formatRatioBps(par30)}
          secondary={
            <>
              <Money amount={slice.principalAtRisk[30]} /> of principal
            </>
          }
          definition="Outstanding principal on loans at least thirty days past due, over outstanding principal. Not total outstanding, which would include interest not yet earned, and not the arrears figure, which is a fraction of the exposure rather than the exposure."
          icon={ShieldAlert}
          tone={
            severity === 'bad' ? 'danger' : severity === 'watch' ? 'warning' : 'neutral'
          }
          href={`${ROUTES.reports}/aging`}
        />
        <StatCard
          label={AGING_BUCKET_LABELS['90_plus']}
          value={String(worst)}
          secondary={
            worst === 0 ? (
              'Nothing has gone this far'
            ) : (
              <>
                <Money amount={worstPrincipal} /> of principal
              </>
            )
          }
          definition="Loans more than ninety days past due. This is the bucket a loan does not come back from on its own, and the one the recovery file exists for."
          icon={Layers}
          tone={worst > 0 ? 'danger' : 'neutral'}
          href={`${ROUTES.reports}/aging?bucket=90_plus`}
        />
        <StatCard
          label="Live book"
          value={String(slice.loanCount)}
          secondary={
            <>
              <Money amount={slice.principalOutstanding} /> of principal
            </>
          }
          definition="Loans with a balance. This is the denominator every ratio above divides by, shown so the percentages can be read against something."
          icon={Layers}
          href={ROUTES.loans}
        />
      </StatGrid>
    </section>
  );
}
