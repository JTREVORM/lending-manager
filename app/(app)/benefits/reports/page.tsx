import { BarChart3 } from 'lucide-react';

import { BenefitReportView } from '@/components/benefits/benefit-report-view';
import { PrintButton } from '@/components/reports/print-button';
import { ReportFilters } from '@/components/reports/report-filters';
import { Alert } from '@/components/ui/alert';
import { PageHeader } from '@/components/ui/page-header';
import { ROUTES } from '@/config/app';
import { guardReportPage } from '@/lib/auth/guard';
import { getCompanyBranding } from '@/lib/data/company';
import { getBenefitExpenseByType, getBenefitSummary } from '@/lib/data/benefits';
import { formatBusinessDate } from '@/lib/domain/datetime';
import { describeRange } from '@/lib/domain/reporting';
import { resolveReportRange, type ParamRecord } from '@/lib/reports/filters';

export const metadata = { title: 'Benefits report' };

/**
 * What the benefits scheme has cost, over a period.
 *
 * ## Guarded by `benefits:view`, and the ledger half by its own capability
 *
 * The screen's own figures come from `benefit_summary`, which is a benefits
 * question. The General Ledger half comes from `benefit_expense_by_type`,
 * which returns `null` without `reports:view_financial` — so a Manager who
 * runs the benefits scheme sees what it paid, and reading the company's
 * expense accounts stays a financial-reporting permission.
 *
 * Through `guardReportPage` rather than `guardPermission`, because this is a
 * report: it carries the reports rate budget, which fails open when the
 * counter is unreachable since refusing a read would be an outage caused by a
 * safety mechanism.
 *
 * ## Defaults to the current month
 *
 * Not to "everything". The question a benefits report answers is almost always
 * about a period somebody is closing, and an unbounded query is slow the first
 * time anybody opens the page.
 *
 * "This month" comes from the company's configured timezone, never the
 * browser's clock: at 23:30 UTC it is already tomorrow in Kampala, and a
 * report that disagreed with the ledger about which day it is would disagree
 * about which payments belong in the period.
 */
export default async function BenefitsReportPage({
  searchParams,
}: {
  readonly searchParams: Promise<ParamRecord>;
}) {
  await guardReportPage(ROUTES.benefitReports, ['benefits:view']);

  const params = await searchParams;
  const { branding } = await getCompanyBranding();
  const { range, error } = resolveReportRange(params, branding.timezone, 'month');

  const [summary, expense] = await Promise.all([
    getBenefitSummary({ from: range.from, to: range.to }),
    getBenefitExpenseByType(range.from, range.to),
  ]);

  const periodLabel = describeRange(range, (date) =>
    formatBusinessDate(date, { locale: 'en-GB' }),
  );

  return (
    <div className="min-w-0 space-y-6">
      <PageHeader
        eyebrow="Membership Benefits"
        icon={BarChart3}
        title="Benefits report"
        description="What the scheme promised, what it paid, and whether the payment records and the General Ledger agree."
        back={{ href: ROUTES.benefits, label: 'Benefits' }}
        secondaryActions={<PrintButton />}
      />

      {error === null ? null : (
        <Alert tone="warning" title="That date range could not be used">
          {error} The figures below cover {periodLabel} instead.
        </Alert>
      )}

      <ReportFilters filters={[{ kind: 'period' }]} resultSummary={periodLabel} />

      {summary === null ? (
        <Alert tone="warning" title="No figures to show">
          The benefits summary could not be read for this period.
        </Alert>
      ) : (
        <BenefitReportView
          summary={summary}
          expense={expense}
          periodLabel={periodLabel}
        />
      )}
    </div>
  );
}
