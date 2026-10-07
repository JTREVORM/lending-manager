import { Receipt } from 'lucide-react';

import { Alert } from '@/components/ui/alert';
import { CollectionReportView } from '@/components/reports/collection-report-view';
import { ExportLink } from '@/components/reports/export-link';
import { PrintButton } from '@/components/reports/print-button';
import { ReportFilters } from '@/components/reports/report-filters';
import { PageHeader } from '@/components/ui/page-header';
import { ReportPagination } from '@/components/reports/report-pagination';
import { ROUTES } from '@/config/app';
import { guardReportPage } from '@/lib/auth/guard';
import { getCompanyBranding } from '@/lib/data/company';
import { getCollectionReport } from '@/lib/data/reports';
import { formatBusinessDate } from '@/lib/domain/datetime';
import { PAYMENT_METHODS, PAYMENT_METHOD_LABELS } from '@/lib/domain/payment';
import { describeRange } from '@/lib/domain/reporting';
import {
  exportQuery,
  parsePaymentMethod,
  parseUuid,
  resolveReportRange,
  singleParam,
  type ParamRecord,
} from '@/lib/reports/filters';

export const metadata = { title: 'Collection report' };

/** The filters this report carries into its export link. */
const FILTER_KEYS = ['period', 'from', 'to', 'method', 'clientId', 'loanId', 'query'];

/**
 * The collection report.
 *
 * ## Defaults to today
 *
 * Not to "everything". A report that opens on an unbounded query is slow the
 * first time anybody visits and answers a question nobody asked; the question
 * a collection report answers is almost always about the day it is run on.
 * §50.
 *
 * ## Today comes from the business timezone
 *
 * `resolveReportRange` reads the company's configured zone, never the
 * browser's clock or the server's. At 23:30 UTC it is already tomorrow in
 * Kampala, and a report that disagreed with the ledger about which day it is
 * would disagree about which payments belong in it.
 *
 * ## An unusable date range is explained, not silently replaced
 *
 * A reversed custom range is refused with a sentence and the default range is
 * shown instead, labelled. Quietly swapping the dates would answer a different
 * question than the one asked, and quietly showing nothing would look like a
 * day with no takings.
 */
export default async function CollectionReportPage({
  searchParams,
}: {
  readonly searchParams: Promise<ParamRecord>;
}) {
  await guardReportPage(`${ROUTES.reports}/collections`, [
    'reports:view_operational',
    'payments:view',
  ]);

  const params = await searchParams;
  const { branding } = await getCompanyBranding();
  const { range, error } = resolveReportRange(params, branding.timezone, 'today');

  const report = await getCollectionReport({
    range,
    timeZone: branding.timezone,
    method: parsePaymentMethod(params),
    clientId: parseUuid(params, 'clientId'),
    loanId: parseUuid(params, 'loanId'),
    query: singleParam(params, 'query'),
    page: singleParam(params, 'page'),
  });

  const query = exportQuery(params, FILTER_KEYS);
  const rangeLabel = describeRange(range, formatBusinessDate);

  return (
    <div className="min-w-0 space-y-5">
      <PageHeader
        eyebrow="Collections Report"
        icon={Receipt}
        back={{ href: ROUTES.reports, label: 'All reports' }}
        title="Collections"
        description={
          <>
            {rangeLabel} · {branding.companyName}
            <span className="mt-1.5 block">
              Payments as recorded. Reversed payments are listed and marked; no total
              includes them.
            </span>
          </>
        }
        secondaryActions={
          <>
            <PrintButton />
            <ExportLink
              href={`${ROUTES.reports}/collections/export${query === '' ? '' : `?${query}`}`}
            />
          </>
        }
      />

      {error !== null ? (
        <Alert tone="warning" title="That range could not be used">
          {error} Showing {rangeLabel} instead.
        </Alert>
      ) : null}

      <ReportFilters
        filters={[
          { kind: 'period' },
          {
            kind: 'select',
            name: 'method',
            label: 'Method',
            options: PAYMENT_METHODS.map((method) => ({
              value: method,
              label: PAYMENT_METHOD_LABELS[method],
            })),
          },
          {
            kind: 'search',
            name: 'query',
            label: 'Search',
            placeholder: 'Receipt, loan, client',
          },
        ]}
        resultSummary={`${String(report.matchedRows)} ${report.matchedRows === 1 ? 'payment' : 'payments'} in ${rangeLabel}`}
      />

      <CollectionReportView report={report} timeZone={branding.timezone} />

      <ReportPagination
        page={report.page.page}
        hasMore={report.page.hasMore}
        rowsShown={report.page.rows.length}
      />
    </div>
  );
}
