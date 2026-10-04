import { getCompanyBranding } from '@/lib/data/company';
import { getCollectionReport } from '@/lib/data/reports';
import { exportFilename, toCsv } from '@/lib/domain/reporting';
import { collectionCsvColumns, csvResponse } from '@/lib/reports/csv';
import { guardExport } from '@/lib/reports/export-guard';
import {
  parsePaymentMethod,
  parseUuid,
  resolveReportRange,
  singleParam,
  type ParamRecord,
} from '@/lib/reports/filters';

/**
 * The collection report as CSV.
 *
 * ## It re-runs the report, with the same filters
 *
 * Not a second query with its own interpretation of the parameters: the same
 * `getCollectionReport` the page calls, parsed by the same functions. So the
 * file holds exactly the rows the screen showed — which is the whole point of
 * an export, and the thing that goes wrong when a download route grows its own
 * filter handling.
 *
 * Every row in the filtered set, not the page the person happened to be on. A
 * file containing page 3 of a report would be a subtle lie about what was
 * downloaded.
 *
 * ## It checks permission itself
 *
 * `guardExport` repeats the page's capability check, because this URL can be
 * typed and the link that normally produces it is only presentation. Row Level
 * Security then decides the rows, so a Secretary/Treasurer and an Owner
 * calling this route get files of different lengths from the same code.
 */
export async function GET(request: Request): Promise<Response> {
  const guard = await guardExport(['reports:view_operational', 'payments:view']);
  if (!guard.ok) return guard.response;

  const url = new URL(request.url);
  const params: ParamRecord = Object.fromEntries(url.searchParams.entries());

  const { branding } = await getCompanyBranding();
  const { range } = resolveReportRange(params, branding.timezone, 'today');

  const report = await getCollectionReport({
    range,
    timeZone: branding.timezone,
    method: parsePaymentMethod(params),
    clientId: parseUuid(params, 'clientId'),
    loanId: parseUuid(params, 'loanId'),
    query: singleParam(params, 'query'),
    pageSize: 1,
  });

  const body = toCsv(collectionCsvColumns(branding.timezone), report.exportRows);

  return csvResponse(body, exportFilename('collections', range));
}
