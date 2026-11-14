import { BUSINESS_TIMEZONE } from '@/config/app';
import { getDocumentBranding } from '@/lib/data/company';
import {
  getAgencyAgentAccounts,
  getAgencyCashBankings,
  getAgencyCashCounts,
  getAgencyCommission,
  getAgencyCommissionSettlements,
  getAgencyPayables,
  getAgencyTransactions,
  getAgencyVariances,
} from '@/lib/data/agency';
import { formatUgx, toUgx } from '@/lib/domain/money';
import { toCsv } from '@/lib/domain/reporting';
import {
  agencyCashBankingFields,
  agencyCashCountFields,
  agencyCommissionFields,
  agencyCommissionSettlementFields,
  agencyFloatFields,
  agencyPayableFields,
  agencyPerformanceFields,
  agencyTransactionFields,
  agencyVarianceFields,
} from '@/lib/reports/agency-fields';
import { csvColumns } from '@/lib/reports/columns';
import { csvResponse } from '@/lib/reports/csv';
import { letterheadMark, pdfResponse } from '@/lib/reports/export';
import { guardExport } from '@/lib/reports/export-guard';
import { renderReportPdf, type ReportTotal } from '@/lib/reports/pdf-report';
import type { ReportField } from '@/lib/reports/columns';
import {
  AGENCY_REPORT_SECTION_META,
  agencyPeriodLabel,
  agencyScopeLabel,
  readAgencyReportFilter,
  tallyAgentPerformance,
} from '@/lib/agency/reporting';

/**
 * Any Agency report, as a spreadsheet-compatible CSV or a letterheaded PDF.
 *
 * ## Why this route and not a registry entry
 *
 * `reportExportRoute(id)` serves the ten lending reports in
 * `lib/reports/registry.ts` from one declaration each. An Agency report has a
 * different filter — a scope, a provider, an account, a staff member — and
 * seven different row types behind one URL, so it reuses the pipeline's
 * *parts* rather than its router: the same `guardExport`, the same fields the
 * screen renders, the same CSV writer, the same PDF renderer, the same
 * letterhead and the same response headers. The trial balance made the same
 * choice for the same reason.
 *
 * ## It reads the same filter the page read
 *
 * Through `readAgencyReportFilter`, the one the screen uses. That is what
 * makes the file *be* the report: a reader who narrowed to one bank and one
 * month gets a file covering one bank and one month, and if the two functions
 * were separate they would eventually disagree about what `?scope=banking`
 * means.
 *
 * ## It checks for itself, per request
 *
 * `guardExport(['agency:reports'])` — the same capability the page requires,
 * because a download is a separate request to a URL that can be typed,
 * copied, or kept after a role has changed. It brings the export rate limit
 * and the forced-password-change refusal with it. Row Level Security then
 * decides which rows are counted, through each view's `security_invoker`, so
 * one handler serves a branch officer and an Owner and gives each a file that
 * foots on their own rows.
 *
 * ## Why a bad date range is a refusal and not a file
 *
 * A file is kept, filed and acted on long after the screen is closed. A
 * download that silently covered a different period from the one asked for is
 * worse than no download, and there is nothing on a saved file to say which
 * happened.
 */
export async function GET(request: Request): Promise<Response> {
  const guard = await guardExport(['agency:reports']);
  if (!guard.ok) return guard.response;

  // Lifted out of `guard` here rather than read inside `respond`: narrowing
  // from the early return does not survive into a closure, so the closure
  // would see the union again.
  const { context } = guard;

  const url = new URL(request.url);
  const params: Record<string, string> = {};
  for (const [key, value] of url.searchParams.entries()) params[key] = value;

  const filter = readAgencyReportFilter(params, BUSINESS_TIMEZONE);

  if (filter.error !== null) {
    return new Response(
      `${filter.error} No file was produced, because a file covering a different period would be worse than none.`,
      {
        status: 400,
        headers: {
          'content-type': 'text/plain; charset=utf-8',
          'cache-control': 'no-store',
        },
      },
    );
  }

  const scope = {
    categories: filter.categories,
    ...(filter.providerCode === null ? {} : { providerCode: filter.providerCode }),
    ...(filter.accountId === null ? {} : { floatAccountId: filter.accountId }),
    ...(filter.branchId === null ? {} : { branchId: filter.branchId }),
  };

  const format = url.searchParams.get('format') === 'pdf' ? 'pdf' : 'csv';

  /**
   * One report, as the requested format.
   *
   * Generic over the row, so the fields and the rows are tied together at the
   * point each is produced and the handler never holds a mismatched pair. The
   * CSV and the PDF are the same rows through the same fields, which is the
   * point of the field abstraction: a column cannot appear in one and be
   * missing from the other.
   */
  async function respond<Row>(
    stem: string,
    fields: readonly ReportField<Row>[],
    rows: readonly Row[],
    totals: readonly ReportTotal[],
  ): Promise<Response> {
    const name = `${stem}-${filter.range.from}-to-${filter.range.to}`;

    if (format === 'csv') {
      return csvResponse(toCsv(csvColumns(fields), rows), `${name}.csv`);
    }

    const branding = await getDocumentBranding();

    return pdfResponse(
      renderReportPdf({
        branding,
        title: `Agency — ${AGENCY_REPORT_SECTION_META[filter.section].label}`,
        coverage: `${agencyPeriodLabel(filter)} · ${filter.range.from} to ${filter.range.to}`,
        // Said in the document rather than left to be inferred. A reader
        // holding a printout should not have to wonder which filters produced
        // it.
        filters: [
          agencyScopeLabel(filter),
          filter.providerCode === null
            ? 'Every provider'
            : `Provider ${filter.providerCode}`,
          filter.accountId === null ? 'Every account' : 'One agent account',
          'Every branch the reader may see',
        ],
        fields,
        rows,
        totals,
        capped: false,
        generatedBy: context.fullName,
        generatedAt: new Date(),
        logo: await letterheadMark(branding.logoPath),
        orientation: 'landscape',
      }),
      `${name}.pdf`,
    );
  }

  const money = (label: string, value: number): ReportTotal => ({
    label,
    value: formatUgx(toUgx(value)),
  });

  // The section decides what is read. Reading all eleven sources for a file
  // that needs one would be the page's trade-off, not a download's: a page
  // shows several sections' figures at once and a file is one report.
  switch (filter.section) {
    case 'transactions': {
      const result = await getAgencyTransactions({
        ...scope,
        from: filter.range.from,
        to: filter.range.to,
        limit: 5000,
      });
      if (!result.ok) return unavailable(result.what);
      const posted = result.rows.filter((r) => r.status === 'posted');
      return respond('agency-transactions', agencyTransactionFields(), result.rows, [
        money(
          'Posted principal',
          posted.reduce((t, r) => t + r.principalAmount, 0),
        ),
        money(
          'Charges collected',
          posted.reduce((t, r) => t + r.customerFee, 0),
        ),
        money(
          'Commission recognised',
          posted.reduce((t, r) => t + (r.commissionAmount ?? 0), 0),
        ),
      ]);
    }

    case 'cash-float': {
      const result = await getAgencyAgentAccounts(scope);
      if (!result.ok) return unavailable(result.what);
      return respond('agency-cash-and-float', agencyFloatFields(), result.rows, [
        money(
          'Float held',
          result.rows.reduce((t, r) => t + r.floatBalance, 0),
        ),
        money(
          'Commission receivable',
          result.rows.reduce((t, r) => t + r.commissionOutstanding, 0),
        ),
      ]);
    }

    case 'commission': {
      const result = await getAgencyCommission();
      if (!result.ok) return unavailable(result.what);
      return respond('agency-commission', agencyCommissionFields(), result.rows, [
        money(
          'Earned',
          result.rows.reduce((t, r) => t + r.earned, 0),
        ),
        money(
          'Received',
          result.rows.reduce((t, r) => t + r.received, 0),
        ),
        money(
          'Outstanding',
          result.rows.reduce((t, r) => t + r.outstanding, 0),
        ),
      ]);
    }

    case 'settlements': {
      const [settlements, payables] = await Promise.all([
        getAgencyCommissionSettlements({ limit: 5000 }),
        getAgencyPayables(),
      ]);
      // Two reports under one section on the screen; a file is one report, so
      // the commission settlements are the file and the payable position is
      // offered through its own section rather than appended underneath with
      // different columns.
      if (!settlements.ok) return unavailable(settlements.what);
      void payables;
      return respond(
        'agency-settlements',
        agencyCommissionSettlementFields(),
        settlements.rows,
        [
          money(
            'Settled',
            settlements.rows
              .filter((r) => r.status === 'posted')
              .reduce((t, r) => t + r.settlementAmount, 0),
          ),
        ],
      );
    }

    case 'reconciliation': {
      const result = await getAgencyVariances({ limit: 5000 });
      if (!result.ok) return unavailable(result.what);
      return respond('agency-reconciliation', agencyVarianceFields(), result.rows, [
        money(
          'Net variance',
          result.rows.reduce((t, r) => t + r.variance, 0),
        ),
        money(
          'Written off',
          result.rows.reduce((t, r) => t + r.varianceWrittenOff, 0),
        ),
      ]);
    }

    case 'performance': {
      const result = await getAgencyTransactions({
        ...scope,
        from: filter.range.from,
        to: filter.range.to,
        limit: 5000,
      });
      if (!result.ok) return unavailable(result.what);
      const rows = tallyAgentPerformance(result.rows);
      return respond('agency-agent-performance', agencyPerformanceFields(), rows, [
        money(
          'Deposit service volume',
          rows.reduce((t, r) => t + r.depositValue, 0),
        ),
        money(
          'Withdrawal service volume',
          rows.reduce((t, r) => t + r.withdrawalValue, 0),
        ),
      ]);
    }

    // `overview` and `export` are the hub's own screens rather than reports:
    // the overview is a dashboard of figures drawn from the six above, and the
    // export centre is the page of links that reaches this route. Neither is a
    // table, so neither is a file. The two remaining readers are offered here
    // because a reader asking for them by hand should get them rather than a
    // 404.
    case 'overview':
    case 'export':
    default: {
      const which = url.searchParams.get('report');
      if (which === 'cash-banking') {
        const result = await getAgencyCashBankings({
          from: filter.range.from,
          to: filter.range.to,
          limit: 5000,
        });
        if (!result.ok) return unavailable(result.what);
        return respond('agency-cash-banking', agencyCashBankingFields(), result.rows, [
          money(
            'Net banked',
            result.rows
              .filter((r) => r.status === 'posted')
              .reduce((t, r) => t + r.netBanked, 0),
          ),
        ]);
      }
      if (which === 'cash-counts') {
        const result = await getAgencyCashCounts({ limit: 5000 });
        if (!result.ok) return unavailable(result.what);
        return respond('agency-cash-counts', agencyCashCountFields(), result.rows, [
          money(
            'Net variance',
            result.rows.reduce((t, r) => t + r.variance, 0),
          ),
        ]);
      }
      if (which === 'payables') {
        const result = await getAgencyPayables();
        if (!result.ok) return unavailable(result.what);
        return respond('agency-payables', agencyPayableFields(), result.rows, [
          money(
            'Outstanding',
            result.rows.reduce((t, r) => t + r.outstanding, 0),
          ),
        ]);
      }

      return new Response(
        'Choose a report to download. The overview and the export centre are screens rather than reports, so neither is a file.',
        {
          status: 400,
          headers: {
            'content-type': 'text/plain; charset=utf-8',
            'cache-control': 'no-store',
          },
        },
      );
    }
  }
}

/**
 * A read that failed is a 503, not an empty file.
 *
 * An empty report is a document somebody could file as evidence that there
 * was nothing to report, and a timed-out query is not that.
 */
function unavailable(what: string): Response {
  return new Response(
    `${what} could not be read, so no file was produced. Try again in a moment.`,
    {
      status: 503,
      headers: {
        'content-type': 'text/plain; charset=utf-8',
        'cache-control': 'no-store',
      },
    },
  );
}
