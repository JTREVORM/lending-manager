import { getCompanyBranding } from '@/lib/data/company';
import { getPortfolioReport } from '@/lib/data/reports';
import { exportFilename, toCsv } from '@/lib/domain/reporting';
import { csvResponse, portfolioCsvColumns } from '@/lib/reports/csv';
import { guardExport } from '@/lib/reports/export-guard';
import {
  parseDelinquencyStates,
  parseLoanStatuses,
  parseUuid,
  resolveReportRange,
  singleParam,
  type ParamRecord,
} from '@/lib/reports/filters';

/** The loan portfolio report as CSV. Same filters, same rows, checked again. */
export async function GET(request: Request): Promise<Response> {
  const guard = await guardExport(['reports:view_financial', 'loans:view']);
  if (!guard.ok) return guard.response;

  const url = new URL(request.url);
  const params: ParamRecord = Object.fromEntries(url.searchParams.entries());

  const { branding } = await getCompanyBranding();
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
    pageSize: 1,
  });

  const body = toCsv(portfolioCsvColumns(branding.timezone), report.exportRows);

  return csvResponse(
    body,
    resolved === null
      ? 'loan-portfolio.csv'
      : exportFilename('loan-portfolio', resolved.range),
  );
}
