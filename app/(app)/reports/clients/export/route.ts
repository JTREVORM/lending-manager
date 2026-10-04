import { getCompanyBranding } from '@/lib/data/company';
import { getClientReport } from '@/lib/data/reports';
import { toCsv } from '@/lib/domain/reporting';
import { clientCsvColumns, csvResponse } from '@/lib/reports/csv';
import { guardExport } from '@/lib/reports/export-guard';
import { parseClientStatus, singleParam, type ParamRecord } from '@/lib/reports/filters';

/**
 * The client directory as CSV.
 *
 * No National Identification Number column exists in `clientCsvColumns`, so
 * there is nothing here to gate. A file of identification numbers is not a
 * thing this application produces. §76.
 */
export async function GET(request: Request): Promise<Response> {
  const guard = await guardExport(['reports:view_operational', 'clients:view']);
  if (!guard.ok) return guard.response;

  const url = new URL(request.url);
  const params: ParamRecord = Object.fromEntries(url.searchParams.entries());

  const { branding } = await getCompanyBranding();

  const report = await getClientReport({
    status: parseClientStatus(params),
    query: singleParam(params, 'query'),
    pageSize: 1,
  });

  return csvResponse(
    toCsv(clientCsvColumns(branding.timezone), report.exportRows),
    'clients.csv',
  );
}
