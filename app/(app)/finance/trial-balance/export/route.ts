import { getDocumentBranding } from '@/lib/data/company';
import { getTrialBalance } from '@/lib/data/finance';
import { businessToday, formatBusinessDate } from '@/lib/domain/datetime';
import { formatUgx } from '@/lib/domain/money';
import { toCsv } from '@/lib/domain/reporting';
import { csvColumns } from '@/lib/reports/columns';
import { csvResponse } from '@/lib/reports/csv';
import { guardExport } from '@/lib/reports/export-guard';
import { letterheadMark, pdfResponse } from '@/lib/reports/export';
import { trialBalanceFields } from '@/lib/reports/fields';
import { renderReportPdf, type ReportTotal } from '@/lib/reports/pdf-report';

/**
 * The trial balance, as CSV or as a letterheaded PDF.
 *
 * ## Why this route exists rather than a registry entry
 *
 * `reportExportRoute(id)` serves the ten reports in `lib/reports/registry.ts`,
 * and it reads that entry's filters, loader, fields and capability list. The
 * trial balance has no filters and no loader of its own — it is one read of
 * one view — and it belongs under `/finance`, beside the ledger it
 * aggregates, rather than in the Reports Centre.
 *
 * So it reuses the pipeline's *parts* instead of its router: the same
 * `guardExport`, the same fields the screen renders, the same CSV writer, the
 * same PDF renderer, the same letterhead and the same response headers. The
 * only thing not shared is the handler, and that is twenty lines.
 *
 * ## It checks for itself
 *
 * `guardExport(['ledger:view'])`, per request — the same capability the page
 * requires, because a download is a separate request to a URL that can be
 * typed, copied, or kept after a role has changed. It also brings the export
 * rate limit with it. Row Level Security then decides which postings are
 * counted, through the view's `security_invoker`, so this one handler serves
 * a Treasurer and an Owner and gives each a statement that foots on their own
 * rows.
 *
 * ## One read, two formats
 *
 * The CSV and the PDF are the same rows through the same fields, which is the
 * point of the field abstraction: a column cannot appear in one and be
 * missing from the other, and money cannot be grouped in the file somebody
 * wants to total.
 */
export async function GET(request: Request): Promise<Response> {
  const guard = await guardExport(['ledger:view']);
  if (!guard.ok) return guard.response;

  const branding = await getDocumentBranding();
  const summary = await getTrialBalance();

  if (summary === null) {
    // Not an empty file. A trial balance of nothing, footing to zero, is a
    // document somebody could file as evidence that the books balanced.
    return new Response('The trial balance could not be read. Try again in a moment.', {
      status: 503,
      headers: {
        'content-type': 'text/plain; charset=utf-8',
        'cache-control': 'no-store',
      },
    });
  }

  const asAt = businessToday(new Date(), branding.timezone);
  const fields = trialBalanceFields();
  const stem = `trial-balance-${asAt}`;

  if (new URL(request.url).searchParams.get('format') !== 'pdf') {
    return csvResponse(toCsv(csvColumns(fields), summary.lines), `${stem}.csv`);
  }

  const totals: readonly ReportTotal[] = [
    { label: 'Total debits', value: formatUgx(summary.totalDebit) },
    { label: 'Total credits', value: formatUgx(summary.totalCredit) },
    { label: 'Debit balances', value: formatUgx(summary.debitBalanceTotal) },
    { label: 'Credit balances', value: formatUgx(summary.creditBalanceTotal) },
    { label: 'Difference', value: formatUgx(summary.movementDifference) },
  ];

  const bytes = renderReportPdf({
    branding,
    title: 'Trial balance',
    coverage: `Every posting to date · ${formatBusinessDate(asAt)}`,
    // Said in the document, not left to be inferred: this statement has no
    // date filter and no branch filter, and a reader holding a printout
    // should not have to wonder which it was run with.
    filters: [
      'Every ledger account',
      'Every branch the reader may see',
      summary.balanced ? 'Debits and credits foot' : 'OUT OF BALANCE',
    ],
    fields,
    rows: summary.lines,
    totals,
    capped: false,
    generatedBy: guard.context.fullName,
    generatedAt: new Date(),
    logo: await letterheadMark(branding.logoPath),
    orientation: 'landscape',
  });

  return pdfResponse(bytes, `${stem}.pdf`);
}
