import { Clock } from 'lucide-react';

import { PageHeader } from '@/components/ui/page-header';
import { ExportLink } from '@/components/reports/export-link';
import { PortfolioReportView } from '@/components/reports/portfolio-report-view';
import { PrintButton } from '@/components/reports/print-button';
import { ReportPagination } from '@/components/reports/report-pagination';
import type { ReportColumn } from '@/components/reports/report-table';
import { ROUTES } from '@/config/app';
import { guardReportPage } from '@/lib/auth/guard';
import { getCompanyBranding } from '@/lib/data/company';
import { getGracePeriodReport, type PortfolioRow } from '@/lib/data/reports';
import { businessToday, daysBetween } from '@/lib/domain/datetime';
import { singleParam, type ParamRecord } from '@/lib/reports/filters';
import { DateValue } from '@/components/ui/data-value';

export const metadata = { title: 'Grace period' };

/**
 * Loans inside their grace period.
 *
 * ## Penalised loans are deliberately absent
 *
 * §29, and it matters operationally rather than cosmetically. This is the list
 * of borrowers who can *still* settle with no charge, which is what a
 * collections officer rings them to say. A loan that has already been charged
 * has no such offer left, and putting it here would have somebody promising a
 * deadline that passed. Those loans are on the arrears and penalty reports.
 *
 * ## Days remaining is a date subtraction, not a new rule
 *
 * `grace_end_date` comes from Phase 7, computed from the loan's own
 * snapshotted grace period. This page subtracts today from it to say how long
 * is left. No grace rule is reimplemented here, and the figure cannot disagree
 * with the delinquency engine because it is the engine's own date.
 */
export default async function GracePeriodPage({
  searchParams,
}: {
  readonly searchParams: Promise<ParamRecord>;
}) {
  await guardReportPage(`${ROUTES.reports}/grace`, [
    'reports:view_operational',
    'delinquency:view',
  ]);

  const params = await searchParams;
  const { branding } = await getCompanyBranding();
  const today = businessToday(new Date(), branding.timezone);

  const report = await getGracePeriodReport({ page: singleParam(params, 'page') });

  const graceColumns: readonly ReportColumn<PortfolioRow>[] = [
    {
      key: 'graceEnd',
      header: 'Grace ends',
      cell: (row) =>
        row.graceEndDate === null ? '—' : <DateValue value={row.graceEndDate} />,
    },
    {
      key: 'penaltyFrom',
      header: 'Charge applies from',
      cell: (row) =>
        row.penaltyEffectiveDate === null ? (
          '—'
        ) : (
          <DateValue value={row.penaltyEffectiveDate} />
        ),
    },
    {
      key: 'daysLeft',
      header: 'Days left',
      numeric: true,
      cell: (row) =>
        row.graceEndDate === null
          ? '—'
          : String(Math.max(0, daysBetween(today, row.graceEndDate))),
    },
  ];

  return (
    <div className="min-w-0 space-y-5">
      <PageHeader
        eyebrow="Grace Period"
        icon={Clock}
        back={{ href: ROUTES.reports, label: 'All reports' }}
        title="Grace period"
        description={
          <>
            As at <DateValue value={today} /> · {branding.companyName}
            <span className="mt-1.5 block">
              These loans are past their final collection date and can still be settled in
              full with no late-payment charge. Loans that have already been charged are
              on the arrears and charges reports, not here.
            </span>
          </>
        }
        secondaryActions={
          <>
            <PrintButton />
            <ExportLink href={`${ROUTES.reports}/grace/export`} />
          </>
        }
      />

      <PortfolioReportView
        report={report}
        timeZone={branding.timezone}
        columns={graceColumns}
        emptyTitle="No loans are in their grace period"
        emptyDescription="Every loan is either within its schedule, already charged, or settled."
      />

      <ReportPagination
        page={report.page.page}
        hasMore={report.page.hasMore}
        rowsShown={report.page.rows.length}
      />
    </div>
  );
}
