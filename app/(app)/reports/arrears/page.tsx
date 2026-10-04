import { ArrearsReportView } from '@/components/reports/arrears-report-view';
import { ExportLink } from '@/components/reports/export-link';
import { PrintButton } from '@/components/reports/print-button';
import { ReportFilters } from '@/components/reports/report-filters';
import { ReportPagination } from '@/components/reports/report-pagination';
import { ROUTES } from '@/config/app';
import { contextCan } from '@/lib/auth/context';
import { guardPermission } from '@/lib/auth/guard';
import { getCompanyBranding } from '@/lib/data/company';
import { ARREARS_STATES, getArrearsReport } from '@/lib/data/reports';
import { DELINQUENCY_STATE_LABELS } from '@/lib/domain/delinquency';
import { businessToday } from '@/lib/domain/datetime';
import { OVERDUE_SORTS } from '@/lib/domain/reporting';
import {
  exportQuery,
  parseDelinquencyStates,
  parseOverdueSort,
  parseUuid,
  singleParam,
  type ParamRecord,
} from '@/lib/reports/filters';
import { DateValue } from '@/components/ui/data-value';

export const metadata = { title: 'Arrears report' };

const FILTER_KEYS = ['state', 'sort', 'clientId', 'query'];

/**
 * The arrears report.
 *
 * ## No date range, and that is deliberate
 *
 * Arrears are a fact about today, not about a period. "Arrears in March" would
 * need an as-at balance, which Phase 8 does not build (§106) and which would
 * be a different and much heavier thing than this. The page says "as at
 * today" and offers sorting instead, because the real question is which
 * borrower to visit first.
 *
 * ## Sorting is a whitelist
 *
 * Four orders, each mapped to a column in `OVERDUE_SORTS`. The value from the
 * query string selects one of the four; it never becomes a column name. A
 * `?sort=` of anything else falls back to longest-overdue.
 */
export default async function ArrearsReportPage({
  searchParams,
}: {
  readonly searchParams: Promise<ParamRecord>;
}) {
  const context = await guardPermission(
    `${ROUTES.reports}/arrears`,
    'reports:view_operational',
  );
  await guardPermission(`${ROUTES.reports}/arrears`, 'delinquency:view');

  const params = await searchParams;
  const { branding } = await getCompanyBranding();
  const today = businessToday(new Date(), branding.timezone);

  const mayReadRemarks = contextCan(context, 'clients:remarks_view');
  const mayAddRemark = contextCan(context, 'clients:remarks_create');

  const report = await getArrearsReport({
    states: parseDelinquencyStates(params),
    sort: parseOverdueSort(params),
    clientId: parseUuid(params, 'clientId'),
    query: singleParam(params, 'query'),
    page: singleParam(params, 'page'),
    withRemarks: mayReadRemarks,
  });

  const query = exportQuery(params, FILTER_KEYS);

  return (
    <div className="min-w-0 space-y-5">
      <header className="min-w-0 space-y-2">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-text text-2xl font-semibold">Arrears</h1>
            <p className="text-text-muted mt-1 text-sm">
              As at <DateValue value={today} /> · {branding.companyName}
            </p>
          </div>
          <div className="flex shrink-0 gap-2">
            <PrintButton />
            <ExportLink
              href={`${ROUTES.reports}/arrears/export${query === '' ? '' : `?${query}`}`}
            />
          </div>
        </div>
        <p className="text-text-muted text-sm">
          Past unpaid is what was due before today. Current due adds today&rsquo;s
          collection. Missed collections and days late are different measures: three
          missed collections on an every-three-days loan are nine days.
        </p>
      </header>

      <ReportFilters
        filters={[
          {
            kind: 'select',
            name: 'state',
            label: 'Status',
            options: ARREARS_STATES.map((state) => ({
              value: state,
              label: DELINQUENCY_STATE_LABELS[state],
            })),
          },
          {
            kind: 'select',
            name: 'sort',
            label: 'Order by',
            options: Object.entries(OVERDUE_SORTS).map(([value, sort]) => ({
              value,
              label: sort.label,
            })),
          },
          {
            kind: 'search',
            name: 'query',
            label: 'Search',
            placeholder: 'Loan or client',
          },
        ]}
        resultSummary={`${String(report.matchedRows)} ${report.matchedRows === 1 ? 'loan' : 'loans'} behind`}
      />

      <ArrearsReportView
        report={report}
        timeZone={branding.timezone}
        showRemarks={mayReadRemarks}
        canAddRemark={mayAddRemark}
      />

      <ReportPagination
        page={report.page.page}
        hasMore={report.page.hasMore}
        rowsShown={report.page.rows.length}
      />
    </div>
  );
}
