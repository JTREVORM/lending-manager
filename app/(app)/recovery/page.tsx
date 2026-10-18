import { ShieldAlert } from 'lucide-react';

import { Alert } from '@/components/ui/alert';
import { RetryButton } from '@/components/ui/retry-button';
import { Card } from '@/components/ui/card';
import { ActionLink, PageHeader } from '@/components/ui/page-header';
import { AgingRegister } from '@/components/delinquency/aging-register';
import { RecoveryTabs } from '@/components/delinquency/recovery-tabs';
import { RiskBreakdown, RiskSummary } from '@/components/delinquency/risk-summary';
import {
  CollateralRegister,
  FollowUpWorklist,
  PromiseRegister,
} from '@/components/delinquency/recovery-worklist';
import { ROUTES } from '@/config/app';
import { contextCan } from '@/lib/auth/context';
import { guardPermission } from '@/lib/auth/guard';
import { getCompanyBranding } from '@/lib/data/company';
import {
  getPortfolioAtRisk,
  listAging,
  listCollateral,
  listFollowUps,
  listPromises,
} from '@/lib/data/security';
import { isRecoveryView } from '@/lib/domain/debt-views';
import { businessToday } from '@/lib/domain/datetime';
import { isAgingBucket } from '@/lib/domain/risk';
import {
  COLLATERAL_ITEM_TYPE_LABELS,
  COLLATERAL_STATUS_LABELS,
} from '@/lib/domain/security';

export const metadata = { title: 'Debt & Security' };

/**
 * Debt & Security.
 *
 * ## Why this is a hub and `/overdue` stays as it is
 *
 * `/overdue` is the morning worklist: who is behind, what to ask for, which
 * number to call. It is opened standing up, often outdoors, and it should not
 * have to load a portfolio aggregate to show itself. This page is the other
 * job — supervising the chase — and it reads a portfolio summary by design.
 * Two routes, two capabilities, because a business may want the first open to
 * the counter while the second stays with the people who work it.
 *
 * ## One view is queried at a time
 *
 * The tab is in the URL, so the server fetches the view being read and nothing
 * else. Five registers fetched for a screen showing one of them would be four
 * wasted round trips on every visit — and this page's registers include a
 * grouping-sets aggregate over the whole active book.
 *
 * The exception is the aging view, which reads the risk summary as well: the
 * bucket chips carry counts, and those counts come from the same aggregate the
 * risk view shows. One read serving both is why the chips can afford to say
 * "9" where the loan register's stage tabs deliberately do not.
 */
export default async function RecoveryPage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const context = await guardPermission(ROUTES.recovery, 'recovery:view');

  const params = await searchParams;

  const single = (key: string): string | undefined => {
    const value = params[key];
    return Array.isArray(value) ? value[0] : value;
  };

  const rawView = single('view');
  const view = isRecoveryView(rawView) ? rawView : '';

  const rawPage = Number(single('page'));
  const page = Number.isInteger(rawPage) && rawPage > 0 ? rawPage : 1;

  const header = (
    <PageHeader
      eyebrow="Collections"
      icon={ShieldAlert}
      title="Debt & Security"
      description="How late the book is, what is being done about it, and what stands behind it."
      primaryAction={
        contextCan(context, 'delinquency:view') ? (
          <ActionLink href={ROUTES.overdue} variant="secondary" prefetch={false}>
            Overdue worklist
          </ActionLink>
        ) : null
      }
      secondaryActions={
        contextCan(context, 'guarantors:view') ? (
          <ActionLink
            href={ROUTES.guarantorRegister}
            variant="secondary"
            prefetch={false}
          >
            Guarantor register
          </ActionLink>
        ) : null
      }
    />
  );

  if (view === 'risk') {
    const risk = await getPortfolioAtRisk();

    // Phase 19. `getPortfolioAtRisk` used to answer a failed read with a slice
    // of zeroes, so a cancelled query (57014) drew a book with no arrears in
    // it — on the one screen whose entire purpose is to show arrears. It now
    // reports the failure, and the screen says so rather than inventing a
    // clean portfolio.
    if (risk === null) {
      return (
        <div className="min-w-0 space-y-6">
          {header}
          <RecoveryTabs view={view} />
          <Alert tone="warning" title="Portfolio at risk could not be read">
            The risk figures are derived from the live loan book and could not be read
            just now. Nothing is lost. They are deliberately not shown as nil, because nil
            would read as a book with no arrears in it.
            <span className="mt-3 block">
              <RetryButton label="Read the risk figures again" />
            </span>
          </Alert>
        </div>
      );
    }

    const { portfolio, byBranch, byProduct } = risk;

    return (
      <div className="min-w-0 space-y-6">
        {header}
        <RecoveryTabs view={view} />
        <RiskSummary slice={portfolio} />
        <RiskBreakdown
          heading="By branch"
          caption="Portfolio at risk by branch: loans, principal, arrears and the five PAR ratios"
          slices={byBranch}
          nameOf={(slice) => slice.branchName ?? 'No branch'}
        />
        <RiskBreakdown
          heading="By loan product"
          caption="Portfolio at risk by loan product: loans, principal, arrears and the five PAR ratios"
          slices={byProduct}
          nameOf={(slice) => slice.productName ?? 'No product'}
        />
      </div>
    );
  }

  if (view === 'follow-ups') {
    const rows = await listFollowUps();

    return (
      <div className="min-w-0 space-y-6">
        {header}
        <RecoveryTabs view={view} />
        <Card className="min-w-0">
          <p className="text-text-muted text-sm">
            Loans whose follow-up date has passed without another action being recorded. A
            follow-up is set when a recovery action is recorded on a loan — it is not
            derived from arrears, so a loan appears here because somebody said they would
            come back to it and has not.
          </p>
        </Card>
        <FollowUpWorklist rows={rows} />
      </div>
    );
  }

  if (view === 'promises') {
    const { promises } = await listPromises({ page });

    return (
      <div className="min-w-0 space-y-6">
        {header}
        <RecoveryTabs view={view} />
        <PromiseRegister promises={promises} />
      </div>
    );
  }

  if (view === 'security') {
    const { items } = await listCollateral({ page });

    return (
      <div className="min-w-0 space-y-6">
        {header}
        <RecoveryTabs view={view} />
        <CollateralRegister
          items={items.map((item) => ({
            id: item.id,
            loanId: item.loanId,
            loanNumber: item.loanNumber,
            clientName: item.clientName,
            productCode: item.productCode,
            itemTypeLabel: COLLATERAL_ITEM_TYPE_LABELS[item.itemType],
            description: item.description,
            estimatedValue: item.estimatedValue,
            valuedOn: item.valuedOn,
            statusLabel: COLLATERAL_STATUS_LABELS[item.status],
            totalOutstanding: item.totalOutstanding,
          }))}
        />
      </div>
    );
  }

  // The aging register, which is the default view.
  const rawBucket = single('bucket');
  const bucket = isAgingBucket(rawBucket) ? rawBucket : null;

  const [aging, risk, { branding }] = await Promise.all([
    listAging({ bucket, query: single('query'), page }),
    getPortfolioAtRisk(),
    getCompanyBranding(),
  ]);

  return (
    <div className="min-w-0 space-y-6">
      {header}
      <RecoveryTabs view={view} />
      {risk === null ? (
        <Alert tone="warning" title="Portfolio at risk could not be read">
          The register below is accurate. The risk summary above it could not be read just
          now and is left out rather than shown as nil.
          <span className="mt-3 block">
            <RetryButton label="Read the risk figures again" />
          </span>
        </Alert>
      ) : null}
      <AgingRegister
        rows={aging.rows}
        page={aging.page}
        hasMore={aging.hasMore}
        slice={risk === null ? null : risk.portfolio}
        businessDate={businessToday(new Date(), branding.timezone)}
      />
    </div>
  );
}
