import { HeartHandshake } from 'lucide-react';

import { BenefitSummaryPanel } from '@/components/benefits/benefit-summary-panel';
import { BenefitStageBreakdown } from '@/components/benefits/benefit-stage-breakdown';
import { Alert } from '@/components/ui/alert';
import { ActionLink, PageHeader } from '@/components/ui/page-header';
import { ROUTES } from '@/config/app';
import { contextCan } from '@/lib/auth/context';
import { guardPermission } from '@/lib/auth/guard';
import { getBenefitSummary } from '@/lib/data/benefits';

export const metadata = { title: 'Benefits' };

/**
 * The benefits dashboard.
 *
 * Guarded three times in the shape every section here uses: the proxy refuses
 * an anonymous request, the layout applies the route requirement, and this
 * page states `benefits:view` again so the requirement stays visible at the
 * surface that depends on it. Beneath all of it, Row Level Security decides
 * the rows — a caller without the capability gets none however they ask.
 *
 * ## The banner names the exact undecided rule
 *
 * `benefit_summary` carries `blocked_reason`, built by
 * `benefits_blocked_reason()` from the policy row itself — so when the medical
 * rate, the condolence amount or the bereavement amount has not been
 * approved, this screen says *which*, and stops saying it the moment the
 * client decides. The alternative, a hard-coded "benefits are not configured",
 * is both less useful and guaranteed to go stale.
 *
 * It is deliberately scoped to benefits and nothing else. Phase 1 learned
 * that a banner announcing the whole membership programme was paralysed while
 * any of nine questions was open taught readers to scroll past it.
 *
 * ## Why the two queues are secondary actions rather than tabs
 *
 * They are different people's work. A Secretary spends the day on the
 * register; a Manager assesses; an Owner approves; a Treasurer pays. Each
 * route is guarded by its own capability, so offering all four to everybody
 * would put most people one tap from a screen that refuses them. Each appears
 * only for the person who holds the capability it needs.
 */
export default async function BenefitsPage() {
  const context = await guardPermission(ROUTES.benefits, 'benefits:view');
  const summary = await getBenefitSummary();

  return (
    <div className="min-w-0 space-y-6">
      <PageHeader
        eyebrow="Membership Benefits"
        icon={HeartHandshake}
        title="Benefits"
        description="What the membership scheme has promised its members, what it has paid, and which claims are waiting on somebody."
        primaryAction={
          contextCan(context, 'benefits:claim') ? (
            <ActionLink href={ROUTES.newBenefitClaim}>Open a claim</ActionLink>
          ) : undefined
        }
        secondaryActions={
          <>
            <ActionLink href={ROUTES.benefitClaims} variant="secondary">
              Claim register
            </ActionLink>
            {contextCan(context, 'benefits:approve') ? (
              <ActionLink href={ROUTES.benefitApprovals} variant="secondary">
                Approval queue
              </ActionLink>
            ) : null}
            {contextCan(context, 'benefits:pay') ? (
              <ActionLink href={ROUTES.benefitPayments} variant="secondary">
                Payments
              </ActionLink>
            ) : null}
            <ActionLink href={ROUTES.benefitReports} variant="secondary">
              Reports
            </ActionLink>
          </>
        }
      />

      {summary?.blockedReason === undefined || summary.blockedReason === null ? null : (
        <Alert tone="warning" title="Benefits are not open yet">
          {summary.blockedReason} A claim can still be recorded and its evidence checked;
          what is held up is assessing an amount, approving one and paying it.
        </Alert>
      )}

      <BenefitSummaryPanel summary={summary} />
      <BenefitStageBreakdown summary={summary} />
    </div>
  );
}
