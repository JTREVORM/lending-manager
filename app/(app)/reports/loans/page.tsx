import { Alert } from '@/components/ui/alert';
import { ExportLink } from '@/components/reports/export-link';
import { PortfolioReportView } from '@/components/reports/portfolio-report-view';
import { PrintButton } from '@/components/reports/print-button';
import { ReportFilters } from '@/components/reports/report-filters';
import { ReportPagination } from '@/components/reports/report-pagination';
import { ROUTES } from '@/config/app';
import { guardReportPage } from '@/lib/auth/guard';
import { getCompanyBranding } from '@/lib/data/company';
import { getPortfolioReport } from '@/lib/data/reports';
import { LOAN_STATUSES } from '@/lib/domain/loan';
import { DELINQUENCY_STATES, DELINQUENCY_STATE_LABELS } from '@/lib/domain/delinquency';
import { formatBusinessDate } from '@/lib/domain/datetime';
import { describeRange } from '@/lib/domain/reporting';
import {
  exportQuery,
  parseDelinquencyStates,
  parseLoanStatuses,
  parseUuid,
  resolveReportRange,
  singleParam,
  type ParamRecord,
} from '@/lib/reports/filters';

export const metadata = { title: 'Loan portfolio' };

const FILTER_KEYS = ['period', 'from', 'to', 'status', 'state', 'clientId', 'query'];

/**
 * The loan portfolio report, which is also the active and cleared registers.
 *
 * ## `reports:view_financial`, not `reports:view_operational`
 *
 * This page shows what every borrower owes the business at once. That is the
 * figure §42 asks to be an explicit decision rather than something the counter
 * role inherits along with the collection sheet, and the decision is that it
 * belongs to the Manager and the Owner.
 *
 * ## The date filter is on the disbursement date
 *
 * Not on "created", which for a draft means when somebody started typing, and
 * not on the loan's own term dates. A portfolio question about a period is
 * about money that left the business in that period.
 *
 * ## It is current, never as-at
 *
 * The outstanding figures are today's, whatever the date filter says: the
 * filter selects *which loans* appear, not a historical balance. Phase 8
 * deliberately builds no as-at reporting (§106), so the page says "as at
 * today" rather than letting a date range imply a snapshot it is not.
 */
export default async function LoanPortfolioPage({
  searchParams,
}: {
  readonly searchParams: Promise<ParamRecord>;
}) {
  await guardReportPage(`${ROUTES.reports}/loans`, [
    'reports:view_financial',
    'loans:view',
  ]);

  const params = await searchParams;
  const { branding } = await getCompanyBranding();

  // No date filter unless one is asked for. A portfolio question is "what does
  // the book look like now", and defaulting to today's disbursements would show
  // an almost always empty report. §50.
  const hasRange = singleParam(params, 'period') !== undefined;
  const resolved = hasRange
    ? resolveReportRange(params, branding.timezone, 'month')
    : null;

  const report = await getPortfolioReport({
    statuses: parseLoanStatuses(params),
    states: parseDelinquencyStates(params),
    clientId: parseUuid(params, 'clientId'),
    range: resolved?.range,
    query: singleParam(params, 'query'),
    page: singleParam(params, 'page'),
  });

  const query = exportQuery(params, FILTER_KEYS);

  return (
    <div className="min-w-0 space-y-5">
      <header className="min-w-0 space-y-2">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-text text-2xl font-semibold">Loan portfolio</h1>
            <p className="text-text-muted mt-1 text-sm">
              {resolved === null
                ? 'Every loan'
                : `Paid out ${describeRange(resolved.range, formatBusinessDate)}`}{' '}
              · balances as at today
            </p>
          </div>
          <div className="flex shrink-0 gap-2">
            <PrintButton />
            <ExportLink
              href={`${ROUTES.reports}/loans/export${query === '' ? '' : `?${query}`}`}
            />
          </div>
        </div>
      </header>

      {resolved?.error !== undefined && resolved.error !== null ? (
        <Alert tone="warning" title="That range could not be used">
          {resolved.error}
        </Alert>
      ) : null}

      <ReportFilters
        filters={[
          { kind: 'period' },
          {
            kind: 'select',
            name: 'status',
            label: 'Loan status',
            options: LOAN_STATUSES.map((status) => ({
              value: status,
              label: status.replace(/_/g, ' '),
            })),
          },
          {
            kind: 'select',
            name: 'state',
            label: 'Delinquency status',
            options: DELINQUENCY_STATES.map((state) => ({
              value: state,
              label: DELINQUENCY_STATE_LABELS[state],
            })),
          },
          {
            kind: 'search',
            name: 'query',
            label: 'Search',
            placeholder: 'Loan or client',
          },
        ]}
        resultSummary={`${String(report.matchedRows)} ${report.matchedRows === 1 ? 'loan' : 'loans'}`}
      />

      <PortfolioReportView
        report={report}
        timeZone={branding.timezone}
        emptyTitle="No loans match these filters"
        emptyDescription="Try clearing the status or the date range."
      />

      <ReportPagination
        page={report.page.page}
        hasMore={report.page.hasMore}
        rowsShown={report.page.rows.length}
      />
    </div>
  );
}
