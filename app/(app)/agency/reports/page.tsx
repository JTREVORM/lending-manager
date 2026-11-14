import { FileBarChart } from 'lucide-react';

import { AgencyReportFilters } from '@/components/agency/report-filters';
import {
  AgencyReportSection,
  ReportScopeLine,
  type AgencyReportData,
} from '@/components/agency/report-sections';
import { Alert } from '@/components/ui/alert';
import { PageHeader } from '@/components/ui/page-header';
import { BUSINESS_TIMEZONE, ROUTES } from '@/config/app';
import { guardPermission } from '@/lib/auth/guard';
import {
  getAgencyAgentAccounts,
  getAgencyCashBankings,
  getAgencyCashCounts,
  getAgencyCashMovement,
  getAgencyCommission,
  getAgencyCommissionSettlements,
  getAgencyFloatStatements,
  getAgencyPayableSettlements,
  getAgencyPayables,
  getAgencyProvidersByCategory,
  getAgencyTransactions,
  getAgencyVariances,
} from '@/lib/data/agency';
import {
  AGENCY_REPORT_SECTION_META,
  readAgencyReportFilter,
  type ParamRecord,
} from '@/lib/agency/reporting';

export async function generateMetadata({
  searchParams,
}: {
  readonly searchParams: Promise<ParamRecord>;
}): Promise<{ readonly title: string }> {
  const filter = readAgencyReportFilter(await searchParams, BUSINESS_TIMEZONE);
  return { title: `Agency — ${AGENCY_REPORT_SECTION_META[filter.section].label}` };
}

/**
 * The Agency reporting hub: nine views of one filter.
 *
 * ## Why one screen and not twenty-one
 *
 * The client's §6 asks for seven reports at three levels — one account, one
 * provider, the whole business — plus an export centre. Twenty-one routes is
 * the arithmetic if each combination gets its own, and every one would
 * re-derive the same figures from the same views.
 *
 * They do not differ in what they read. A provider-level transaction report
 * and the consolidated one are the same query with one more equality; the
 * level *is* the filter. So the sections are declared once in
 * `lib/agency/reporting.ts`, the rail carries nine links to `?section=`, and
 * this page renders the one that is asked for.
 *
 * ## Why every read happens on every section
 *
 * The sections overlap — the overview shows a figure from almost every
 * reader, the cash section shows the counts and the reconciliation section
 * shows them again beside the variances — so reading them once and passing
 * the results down means each query runs once per request rather than once
 * per section that names it. The alternative, a read per section, would make
 * the overview the most expensive page in the application and would run the
 * same query twice whenever two sections wanted it.
 *
 * ## Why nothing on this page adds anything up that matters
 *
 * The figures come from the Phase 4C/4E views, which attribute GL 1310 and
 * the 2200-series **by source entity** rather than by account, because those
 * accounts are shared between providers. The headline tiles sum the rows the
 * database returned for this reader, which is why they sit above a table of
 * exactly those rows: a branch-scoped officer's "float held" is their
 * branch's, and a figure implying otherwise would be one nobody could
 * reconcile.
 *
 * ## Why a bad date range shows no figures at all
 *
 * `filter.error` is a sentence shown *instead of* the report. A page that
 * silently fell back to this month and showed numbers would be the worst
 * outcome available: the reader would act on figures for a period they did
 * not ask for and nothing would say so.
 */
export default async function AgencyReportsPage({
  searchParams,
}: {
  readonly searchParams: Promise<ParamRecord>;
}) {
  await guardPermission(ROUTES.agencyReports, 'agency:reports');

  const filter = readAgencyReportFilter(await searchParams, BUSINESS_TIMEZONE);

  const accountScope = {
    categories: filter.categories,
    ...(filter.providerCode === null ? {} : { providerCode: filter.providerCode }),
    ...(filter.accountId === null ? {} : { floatAccountId: filter.accountId }),
    ...(filter.branchId === null ? {} : { branchId: filter.branchId }),
  };

  const [
    providers,
    accounts,
    transactions,
    commission,
    payables,
    movement,
    variances,
    cashCounts,
    floatStatements,
    commissionSettlements,
    payableSettlements,
    bankings,
  ] = await Promise.all([
    getAgencyProvidersByCategory(filter.categories),
    getAgencyAgentAccounts(accountScope),
    getAgencyTransactions({
      ...accountScope,
      from: filter.range.from,
      to: filter.range.to,
      limit: 500,
    }),
    getAgencyCommission(),
    getAgencyPayables(),
    getAgencyCashMovement({ limit: 200 }),
    getAgencyVariances({ limit: 200 }),
    getAgencyCashCounts({ limit: 200 }),
    getAgencyFloatStatements({ limit: 200 }),
    getAgencyCommissionSettlements({ limit: 200 }),
    getAgencyPayableSettlements({ limit: 200 }),
    getAgencyCashBankings({
      from: filter.range.from,
      to: filter.range.to,
      limit: 200,
    }),
  ]);

  const data: AgencyReportData = {
    accounts,
    transactions,
    commission,
    payables,
    movement,
    variances,
    cashCounts,
    floatStatements,
    commissionSettlements,
    payableSettlements,
    bankings,
  };

  const meta = AGENCY_REPORT_SECTION_META[filter.section];

  return (
    <div className="min-w-0 space-y-4">
      <PageHeader
        eyebrow="Consolidated Agency Reports"
        icon={FileBarChart}
        title={meta.label}
        description={meta.description}
        back={{ href: ROUTES.agency, label: 'Agency Services' }}
      />

      <AgencyReportFilters
        filter={filter}
        providers={providers.ok ? providers.rows : []}
      />

      {filter.error === null ? (
        <>
          <ReportScopeLine filter={filter} />
          <AgencyReportSection filter={filter} data={data} />
        </>
      ) : (
        // No figures at all. See the note above: a silent fallback would be
        // worse than a refusal, because the reader would act on it.
        <Alert tone="danger" title="That date range could not be read">
          {filter.error} No figures are shown, because showing a different period&rsquo;s
          would be worse than showing none.
        </Alert>
      )}
    </div>
  );
}
