import { contextCan } from '@/lib/auth/context';
import { getCompanyBranding } from '@/lib/data/company';
import {
  getArrearsReport,
  latestRemarkByClient,
  type ClientRemarkSummary,
} from '@/lib/data/reports';
import { toCsv } from '@/lib/domain/reporting';
import { arrearsCsvColumns, csvResponse } from '@/lib/reports/csv';
import { guardExport } from '@/lib/reports/export-guard';
import {
  parseDelinquencyStates,
  parseOverdueSort,
  parseUuid,
  singleParam,
  type ParamRecord,
} from '@/lib/reports/filters';

/**
 * The arrears report as CSV.
 *
 * The remark columns are present only for a caller who may read remarks. Note
 * that the page attaches remarks to the visible page of rows; the export needs
 * them for the whole filtered set, so it reads them for the exported rows in
 * one query rather than per row.
 */
export async function GET(request: Request): Promise<Response> {
  const guard = await guardExport(['reports:view_operational', 'delinquency:view']);
  if (!guard.ok) return guard.response;

  const withRemarks = contextCan(guard.context, 'clients:remarks_view');

  const url = new URL(request.url);
  const params: ParamRecord = Object.fromEntries(url.searchParams.entries());

  const { branding } = await getCompanyBranding();

  const report = await getArrearsReport({
    states: parseDelinquencyStates(params),
    sort: parseOverdueSort(params),
    clientId: parseUuid(params, 'clientId'),
    query: singleParam(params, 'query'),
    pageSize: 1,
    withRemarks: false,
  });

  const remarks: ReadonlyMap<string, ClientRemarkSummary> = withRemarks
    ? await latestRemarkByClient(report.exportRows.map((row) => row.clientId))
    : new Map<string, ClientRemarkSummary>();

  const rows = report.exportRows.map((row) => ({
    ...row,
    latestRemark: remarks.get(row.clientId) ?? null,
  }));

  return csvResponse(
    toCsv(arrearsCsvColumns(branding.timezone, { withRemarks }), rows),
    'arrears.csv',
  );
}
