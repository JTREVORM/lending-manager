import { getCompanyBranding } from '@/lib/data/company';
import { getGracePeriodReport } from '@/lib/data/reports';
import { toCsv } from '@/lib/domain/reporting';
import { csvResponse, portfolioCsvColumns } from '@/lib/reports/csv';
import { guardExport } from '@/lib/reports/export-guard';

/** Loans in their grace period, as CSV. */
export async function GET(): Promise<Response> {
  const guard = await guardExport(['reports:view_operational', 'delinquency:view']);
  if (!guard.ok) return guard.response;

  const { branding } = await getCompanyBranding();
  const report = await getGracePeriodReport({ pageSize: 1 });

  return csvResponse(
    toCsv(portfolioCsvColumns(branding.timezone), report.exportRows),
    'grace-period.csv',
  );
}
