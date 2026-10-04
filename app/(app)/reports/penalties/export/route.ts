import { getCompanyBranding } from '@/lib/data/company';
import { getPenaltyReport } from '@/lib/data/reports';
import { toCsv } from '@/lib/domain/reporting';
import { csvResponse, penaltyCsvColumns } from '@/lib/reports/csv';
import { guardExport } from '@/lib/reports/export-guard';

/** Recorded late-payment charges, as CSV. */
export async function GET(): Promise<Response> {
  const guard = await guardExport(['reports:view_financial', 'penalties:view']);
  if (!guard.ok) return guard.response;

  const { branding } = await getCompanyBranding();
  const report = await getPenaltyReport({ pageSize: 1 });

  return csvResponse(
    toCsv(penaltyCsvColumns(branding.timezone), report.exportRows),
    'late-payment-charges.csv',
  );
}
