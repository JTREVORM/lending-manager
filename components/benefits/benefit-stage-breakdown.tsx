import Link from 'next/link';

import { Card } from '@/components/ui/card';
import { ROUTES } from '@/config/app';
import type { BenefitSummary } from '@/lib/data/benefits';
import {
  BENEFIT_CLAIM_STATUS_DESCRIPTIONS,
  BENEFIT_CLAIM_STATUS_LABELS,
  type BenefitClaimStatus,
} from '@/lib/domain/benefits';

/**
 * Where the claims are, stage by stage.
 *
 * The dashboard's own tiles answer "how much" and this answers "who is it
 * with" — the question a supervisor actually opens the section for. Every row
 * is a link into the register filtered to that stage, so the dashboard is a
 * way in rather than a thing to read and then navigate away from.
 *
 * ## Six stages, not ten
 *
 * `draft` through `approved` are the stages a claim can still move out of,
 * and they are the ones that have somebody's name against them. The finished
 * ones — paid, refused, withdrawn, reversed — are history: the paid total and
 * the reversal line above carry them, and listing them here would make the
 * panel read as a report instead of a queue.
 *
 * A stage with nothing in it still appears, greyed and not a link. A row that
 * vanished when it emptied would make the panel's shape change between
 * visits, and somebody checking "is anything waiting for approval" would have
 * to notice an absence rather than read a zero.
 */
const QUEUE_STAGES: readonly {
  readonly status: BenefitClaimStatus;
  readonly count: (summary: BenefitSummary) => number;
}[] = [
  { status: 'draft', count: (s) => s.claimsDraft },
  { status: 'submitted', count: (s) => s.claimsSubmitted },
  { status: 'under_verification', count: (s) => s.claimsUnderVerification },
  { status: 'information_required', count: (s) => s.claimsInformationRequired },
  { status: 'assessed', count: (s) => s.claimsAssessed },
  { status: 'approved', count: (s) => s.claimsApproved },
];

export function BenefitStageBreakdown({
  summary,
}: {
  readonly summary: BenefitSummary | null;
}) {
  if (summary === null) return null;

  return (
    <Card>
      <h2 className="text-text text-sm font-semibold">Where the claims are</h2>
      <p className="text-text-muted mt-1 text-xs">
        Every stage a claim can still move out of. Finished claims are in the register.
      </p>

      <ul className="divide-border/60 mt-3 divide-y">
        {QUEUE_STAGES.map((stage) => {
          const count = stage.count(summary);
          const label = BENEFIT_CLAIM_STATUS_LABELS[stage.status];
          const description = BENEFIT_CLAIM_STATUS_DESCRIPTIONS[stage.status];

          const body = (
            <div className="flex min-w-0 items-center justify-between gap-3 py-2.5">
              <div className="min-w-0">
                <p className="text-text text-sm font-medium">{label}</p>
                <p className="text-text-muted text-xs">{description}</p>
              </div>
              <span
                className={
                  count === 0
                    ? 'text-text-muted shrink-0 text-lg tabular-nums'
                    : 'text-text shrink-0 text-lg font-semibold tabular-nums'
                }
              >
                {count}
              </span>
            </div>
          );

          return (
            <li key={stage.status} className="min-w-0">
              {count === 0 ? (
                body
              ) : (
                <Link
                  href={`${ROUTES.benefitClaims}?status=${stage.status}`}
                  className="hover:bg-surface-hover focus-visible:outline-accent -mx-2 block rounded-lg px-2 focus-visible:outline-2 focus-visible:outline-offset-2"
                >
                  {body}
                </Link>
              )}
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
