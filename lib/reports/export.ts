import 'server-only';

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { contextCan } from '@/lib/auth/context';
import { getDocumentBranding } from '@/lib/data/company';
import {
  getArrearsReport,
  getClientReport,
  getCollectionReport,
  getGracePeriodReport,
  getPenaltyReport,
  getPortfolioReport,
  latestRemarkByClient,
  type ArrearsReportRow,
  type ClientRemarkSummary,
  type PortfolioRow,
} from '@/lib/data/reports';
import type { DocumentBranding } from '@/lib/data/company';
import {
  getAgingExport,
  getCollateralExport,
  getGuarantorExposureExport,
  getRecoveryExport,
} from '@/lib/data/security';
import { AGING_BUCKET_LABELS } from '@/lib/domain/risk';
import {
  COLLATERAL_STATUS_LABELS,
  GUARANTEE_STATUS_LABELS,
  PROMISE_STATUS_LABELS,
  RECOVERY_ACTION_KIND_LABELS,
} from '@/lib/domain/security';
import { formatUgx, type UgxAmount } from '@/lib/domain/money';
import { formatBusinessDate } from '@/lib/domain/datetime';
import { describeRange, exportFilename, toCsv } from '@/lib/domain/reporting';
import { logger } from '@/lib/logger';

import { csvColumns } from './columns';
import { csvResponse } from './csv';
import { guardExport } from './export-guard';
import { letterheadJpegPath } from './letterhead';
import {
  parseAgingBucket,
  parseClientStatus,
  parseCollateralStatusFilter,
  parseDelinquencyStates,
  parseGuaranteeStatus,
  parseLoanStatuses,
  parseOverdueSort,
  parsePaymentMethod,
  parsePromiseStatus,
  parseRecoveryKind,
  parseSubjectKind,
  parseUuid,
  resolveReportRange,
  singleParam,
  type ParamRecord,
} from './filters';
import { renderReportPdf, type ReportTotal } from './pdf-report';
import { readJpegSize, type PdfImage } from './pdf-writer';
import { REPORTS, type ReportDefinition, type ReportId } from './registry';

/**
 * The one handler every report's export route delegates to.
 *
 * ## Why six near-identical routes became one function
 *
 * Each route used to parse its own filters, call its own loader, pick its own
 * column builder and repeat its own capability list. Four of those are now
 * read from the registry, so a route is a single line — and the thing that
 * actually mattered is now structural rather than remembered: the capability
 * list an export checks is *the same object* the page checks, so the two
 * cannot drift. A route whose `needs` had quietly fallen behind its page's
 * would have been a security defect that looked like a typo.
 *
 * ## The route still checks for itself
 *
 * `guardExport` runs here, per request, exactly as before. A download is a
 * separate request to a URL that can be typed, copied, or kept after a role
 * changes; hiding the link is presentation and this is the control. Row Level
 * Security then decides which rows come back, so the same handler serves a
 * Secretary/Treasurer and an Owner and gives them files of different lengths.
 *
 * ## One query, two formats
 *
 * The CSV and the PDF are the same rows through the same fields. That is the
 * point of the field abstraction: a figure cannot be grouped in one and plain
 * in the other by accident, and a column cannot appear in one and not the
 * other at all.
 */

/** What a loader has to produce for either format. */
interface LoadedReport<Row> {
  readonly rows: readonly Row[];
  readonly totals: readonly ReportTotal[];
  /** The filtered set hit the export ceiling. ADR-042. */
  readonly capped: boolean;
  /** What the report covers, in the words the screen used. */
  readonly coverage: string;
  /** The filters that were applied, each a fragment a person can read. */
  readonly filters: readonly string[];
  /** The filename stem's date suffix, where the report has a range. */
  readonly filename: string;
  /** Whether the remark columns are present, for the arrears fields. */
  readonly withRemarks: boolean;
}

interface LoadContext {
  readonly params: ParamRecord;
  readonly branding: DocumentBranding;
  readonly canReadRemarks: boolean;
}

/**
 * A total, for a card or a PDF's totals band.
 *
 * Every figure handed to this has already come out of `sumUgx`, so it is a
 * `UgxAmount` by construction; the parameter is widened to `number` only
 * because the totals interfaces that produce them are a mix of branded amounts
 * and plain counts. Nothing is computed here — `formatUgx` groups the digits
 * and nothing else, which is the rule the whole reporting layer is built on.
 */
function money(value: UgxAmount | number): string {
  return formatUgx(value as UgxAmount);
}

/** The row type a given report's fields are written against. */
type RowOf<Id extends ReportId> =
  (typeof REPORTS)[Id] extends ReportDefinition<infer Row> ? Row : never;

/**
 * Every report's loader, keyed by id and typed by that report's own rows.
 *
 * A mapped type over `ReportId` rather than a lookup with a fallback, so two
 * mistakes are compile errors rather than runtime ones: adding a report to the
 * registry without a loader, and writing a loader that returns rows the
 * report's fields cannot read.
 */
const LOADERS: {
  [Id in ReportId]: (context: LoadContext) => Promise<LoadedReport<RowOf<Id>>>;
} = {
  collections: async ({ params, branding }) => {
    const { range } = resolveReportRange(params, branding.timezone, 'today');
    const method = parsePaymentMethod(params);
    const search = singleParam(params, 'query');

    const report = await getCollectionReport({
      range,
      timeZone: branding.timezone,
      method,
      clientId: parseUuid(params, 'clientId'),
      loanId: parseUuid(params, 'loanId'),
      query: search,
      pageSize: 1,
    });

    return {
      rows: report.exportRows,
      totals: [
        { label: 'Payments', value: String(report.totals.paymentCount) },
        { label: 'Collected', value: money(report.totals.collected) },
      ],
      capped: report.truncated,
      coverage: describeRange(range, formatBusinessDate),
      filters: [
        method === undefined ? null : `Method: ${method}`,
        search === undefined ? null : `Search: ${search}`,
      ].filter((value): value is string => value !== null),
      filename: exportFilename(REPORTS.collections.fileStem, range),
      withRemarks: false,
    };
  },

  loans: async ({ params, branding }) => {
    // A range is optional here: the portfolio is a register first and a
    // period report second, so no `period` parameter means the whole book.
    const hasRange = singleParam(params, 'period') !== undefined;
    const resolved = hasRange
      ? resolveReportRange(params, branding.timezone, 'month')
      : null;

    const statuses = parseLoanStatuses(params);
    const states = parseDelinquencyStates(params);
    const search = singleParam(params, 'query');

    const report = await getPortfolioReport({
      statuses,
      states,
      clientId: parseUuid(params, 'clientId'),
      range: resolved?.range,
      query: search,
      pageSize: 1,
    });

    return {
      rows: report.exportRows,
      totals: [
        { label: 'Loans', value: String(report.totals.loanCount) },
        { label: 'Outstanding', value: money(report.totals.totalOutstanding) },
        { label: 'Arrears', value: money(report.totals.arrears) },
      ],
      capped: report.truncated,
      coverage:
        resolved === null
          ? 'The whole book, as at today'
          : `Disbursed ${describeRange(resolved.range, formatBusinessDate)}`,
      filters: [
        statuses.length === 0 ? null : `Loan status: ${statuses.join(', ')}`,
        states.length === 0 ? null : `Delinquency: ${states.join(', ')}`,
        search === undefined ? null : `Search: ${search}`,
      ].filter((value): value is string => value !== null),
      filename:
        resolved === null
          ? `${REPORTS.loans.fileStem}.csv`
          : exportFilename(REPORTS.loans.fileStem, resolved.range),
      withRemarks: false,
    };
  },

  arrears: async ({ params, canReadRemarks }) => {
    const states = parseDelinquencyStates(params);
    const search = singleParam(params, 'query');

    const report = await getArrearsReport({
      states,
      sort: parseOverdueSort(params),
      clientId: parseUuid(params, 'clientId'),
      query: search,
      pageSize: 1,
      withRemarks: false,
    });

    return {
      rows: await attachRemarks(report.exportRows, canReadRemarks),
      totals: [
        { label: 'Loans behind', value: String(report.totals.loanCount) },
        { label: 'Arrears', value: money(report.totals.arrears) },
        { label: 'Outstanding', value: money(report.totals.totalOutstanding) },
      ],
      capped: report.truncated,
      coverage: 'Every loan behind, as at today',
      filters: [
        states.length === 0 ? null : `State: ${states.join(', ')}`,
        search === undefined ? null : `Search: ${search}`,
      ].filter((value): value is string => value !== null),
      filename: `${REPORTS.arrears.fileStem}.csv`,
      withRemarks: canReadRemarks,
    };
  },

  grace: async ({ canReadRemarks }) => {
    const report = await getGracePeriodReport({ pageSize: 1 });

    return {
      rows: await attachRemarks(report.exportRows, canReadRemarks),
      totals: [
        { label: 'Loans in grace', value: String(report.totals.loanCount) },
        { label: 'Arrears', value: money(report.totals.arrears) },
      ],
      capped: report.truncated,
      coverage: 'Loans that can still settle with no charge, as at today',
      filters: [],
      filename: `${REPORTS.grace.fileStem}.csv`,
      withRemarks: canReadRemarks,
    };
  },

  penalties: async () => {
    const report = await getPenaltyReport({ pageSize: 1 });

    return {
      rows: report.exportRows,
      totals: [
        { label: 'Charges', value: String(report.totals.penaltyCount) },
        { label: 'Charged', value: money(report.totals.assessed) },
        { label: 'Collected', value: money(report.totals.collected) },
      ],
      capped: report.truncated,
      coverage: 'Every charge raised, as at today',
      filters: [],
      filename: `${REPORTS.penalties.fileStem}.csv`,
      withRemarks: false,
    };
  },

  clients: async ({ params }) => {
    const status = parseClientStatus(params);
    const search = singleParam(params, 'query');

    const report = await getClientReport({
      status,
      query: search,
      pageSize: 1,
    });

    return {
      rows: report.exportRows,
      totals: [{ label: 'Borrowers', value: String(report.matchedRows) }],
      capped: report.truncated,
      coverage: 'The borrower directory, as at today',
      filters: [
        status === undefined ? null : `Status: ${status}`,
        search === undefined ? null : `Search: ${search}`,
      ].filter((value): value is string => value !== null),
      filename: `${REPORTS.clients.fileStem}.csv`,
      withRemarks: false,
    };
  },
  aging: async ({ params }) => {
    const bucket = parseAgingBucket(params);
    const search = singleParam(params, 'query');

    const report = await getAgingExport({
      bucket,
      productId: parseUuid(params, 'productId'),
      branchId: parseUuid(params, 'branchId'),
      query: search,
    });

    return {
      rows: report.rows,
      totals: [
        { label: 'Loans', value: String(report.totals.loanCount) },
        {
          label: 'Principal outstanding',
          value: money(report.totals.principalOutstanding),
        },
        { label: 'Arrears', value: money(report.totals.arrears) },
      ],
      capped: report.truncated,
      coverage: 'The live book, bucketed by how late it is, as at today',
      filters: [
        bucket === undefined ? null : `Bucket: ${AGING_BUCKET_LABELS[bucket]}`,
        search === undefined ? null : `Search: ${search}`,
      ].filter((value): value is string => value !== null),
      filename: `${REPORTS.aging.fileStem}.csv`,
      withRemarks: false,
    };
  },

  recovery: async ({ params }) => {
    const kind = parseRecoveryKind(params);
    const promiseStatus = parsePromiseStatus(params);
    const search = singleParam(params, 'query');

    const report = await getRecoveryExport({ kind, promiseStatus, query: search });

    return {
      rows: report.rows,
      totals: [
        { label: 'Actions', value: String(report.totals.actionCount) },
        { label: 'Promised', value: money(report.totals.promised) },
        { label: 'Paid against', value: money(report.totals.promisePaid) },
        {
          label: 'Kept / broken',
          value: `${String(report.totals.keptCount)} / ${String(report.totals.brokenCount)}`,
        },
      ],
      capped: report.truncated,
      coverage: 'Everything recorded against a loan in recovery, newest first',
      filters: [
        kind === undefined ? null : `Action: ${RECOVERY_ACTION_KIND_LABELS[kind]}`,
        promiseStatus === undefined
          ? null
          : `Promise: ${PROMISE_STATUS_LABELS[promiseStatus]}`,
        search === undefined ? null : `Search: ${search}`,
      ].filter((value): value is string => value !== null),
      filename: `${REPORTS.recovery.fileStem}.csv`,
      withRemarks: false,
    };
  },

  guarantors: async ({ params }) => {
    const subjectKind = parseSubjectKind(params);
    const guaranteeStatus = parseGuaranteeStatus(params);
    const search = singleParam(params, 'query');

    const report = await getGuarantorExposureExport({
      subjectKind,
      guaranteeStatus,
      productId: parseUuid(params, 'productId'),
      query: search,
    });

    return {
      rows: report.rows,
      totals: [
        { label: 'Guarantees', value: String(report.totals.guaranteeCount) },
        // Live cover, counted per loan. A released guarantee is history, and
        // `guaranteed_amount` is the *loan's* principal — so summing the
        // column would both count guarantees nobody is on the hook for and
        // double every loan that has two guarantors.
        {
          label: `Live cover (${String(report.totals.guaranteedLoanCount)} loans)`,
          value: money(report.totals.guaranteed),
        },
        { label: 'Outstanding behind it', value: money(report.totals.outstanding) },
        { label: 'Released', value: String(report.totals.releasedCount) },
      ],
      capped: report.truncated,
      coverage: 'Every guarantee given, as at today',
      filters: [
        subjectKind === undefined
          ? null
          : `Guarantor: ${subjectKind === 'client' ? 'existing client' : 'external'}`,
        guaranteeStatus === undefined
          ? null
          : `Status: ${GUARANTEE_STATUS_LABELS[guaranteeStatus]}`,
        search === undefined ? null : `Search: ${search}`,
      ].filter((value): value is string => value !== null),
      filename: `${REPORTS.guarantors.fileStem}.csv`,
      withRemarks: false,
    };
  },

  collateral: async ({ params }) => {
    const status = parseCollateralStatusFilter(params);

    const report = await getCollateralExport({ status });

    return {
      rows: report.rows,
      totals: [
        { label: 'Items', value: String(report.totals.itemCount) },
        // The valuation of what is *held*. An item released or sold is not
        // cover any more, so including it would say the business is secured
        // against things it has handed back.
        { label: 'Held, valued at', value: money(report.totals.valuedAt) },
        { label: 'Sold', value: String(report.totals.realisedCount) },
        { label: 'Sold for', value: money(report.totals.realised) },
      ],
      capped: report.truncated,
      coverage: 'Every item taken as security, as at today',
      filters: [
        status === undefined ? null : `Status: ${COLLATERAL_STATUS_LABELS[status]}`,
      ].filter((value): value is string => value !== null),
      filename: `${REPORTS.collateral.fileStem}.csv`,
      withRemarks: false,
    };
  },
};

/**
 * Attach the latest remark to every exported row, in one query.
 *
 * The page attaches remarks to the visible page of rows; an export needs them
 * for the whole filtered set, and one query for the set beats one per row by
 * the margin that matters at five thousand.
 */
async function attachRemarks(
  rows: readonly PortfolioRow[],
  canReadRemarks: boolean,
): Promise<readonly ArrearsReportRow[]> {
  if (!canReadRemarks) return rows.map((row) => ({ ...row, latestRemark: null }));

  const remarks: ReadonlyMap<string, ClientRemarkSummary> = await latestRemarkByClient(
    rows.map((row) => row.clientId),
  );

  return rows.map((row) => ({ ...row, latestRemark: remarks.get(row.clientId) ?? null }));
}

/**
 * The letterhead mark, read off disk once per process.
 *
 * Which file, and why it is a JPEG beside the configured asset rather than the
 * configured asset itself, is in `letterhead.ts` — along with the whitelist on
 * the stored path, which lives there because it is a security control and a
 * control that cannot be unit-tested is a control nobody can be sure of.
 *
 * ## A missing mark is not a failed report
 *
 * A letterhead with the company's name, tagline, numbers and addresses but no
 * mark is still a valid letterhead. Refusing a download because an asset was
 * unreadable would be the wrong trade, so every failure here returns
 * `undefined` and the document is drawn without it.
 */
const logoCache = new Map<string, PdfImage | null>();

async function letterheadMark(logoPath: string | null): Promise<PdfImage | undefined> {
  const path = letterheadJpegPath(logoPath);
  if (path === null) {
    logger.warn('The configured logo path is not a usable file name.');
    return undefined;
  }

  const cached = logoCache.get(path);
  if (cached !== undefined) return cached ?? undefined;

  try {
    const bytes = await readFile(join(process.cwd(), 'public', path));
    const size = readJpegSize(bytes);

    if (size === null) {
      // `readJpegSize` refuses a progressive JPEG as well as a non-JPEG,
      // because a PDF reader is not guaranteed to decode one through
      // `DCTDecode` — it would produce a file that opens with a blank box.
      logger.warn('The letterhead mark is not a baseline JPEG; drawing without it.');
      logoCache.set(path, null);
      return undefined;
    }

    const image = { bytes, width: size.width, height: size.height };
    logoCache.set(path, image);
    return image;
  } catch {
    logger.warn('The letterhead mark could not be read; drawing without it.');
    logoCache.set(path, null);
    return undefined;
  }
}

/** The response a PDF export returns. One place, so every route agrees. */
function pdfResponse(body: Buffer, filename: string): Response {
  return new Response(new Uint8Array(body), {
    headers: {
      'content-type': 'application/pdf',
      // `attachment`, not `inline`: a report is a document somebody is saving
      // or printing, and a PDF opened in the browser's own viewer is the one
      // that gets lost when the tab is closed.
      'content-disposition': `attachment; filename="${filename}"`,
      'x-content-type-options': 'nosniff',
      'cache-control': 'no-store',
    },
  });
}

/**
 * Build a report route's `GET`.
 *
 * Each report folder's `export/route.ts` is one line calling this. The
 * routes still exist as files because Next resolves a static segment before a
 * dynamic one — `/reports/collections/export` would never reach a
 * `[report]/export` handler while `collections/` is a real folder — so one
 * file per report is the shape the router requires, not duplication.
 */
export function reportExportRoute<Id extends ReportId>(id: Id) {
  return async function GET(request: Request): Promise<Response> {
    // The one cast in this module, and the only place it is needed. `REPORTS`
    // is a heterogeneous object — each entry is written against its own row
    // type — so indexing it with a type parameter widens to the union of all
    // of them. `RowOf<Id>` is the row type that entry actually has, and the
    // loaders are already checked against it, so this re-states what the
    // mapped type above has established rather than asserting anything new.
    const definition = REPORTS[id] as ReportDefinition<RowOf<Id>>;

    const guard = await guardExport(definition.needs);
    if (!guard.ok) return guard.response;

    const url = new URL(request.url);
    const params: ParamRecord = Object.fromEntries(url.searchParams.entries());
    const format = url.searchParams.get('format') === 'pdf' ? 'pdf' : 'csv';

    // `getDocumentBranding` never returns null: it falls back to
    // `config/defaults.ts` internally, the same way the receipt and the loan
    // statement get a letterhead on a deployment whose `company_settings` row
    // is not readable yet. So there is nothing to guard here, and nothing to
    // write the company's name into — a letterhead that named the business in
    // code would be the one surface that did not follow the row.
    const branding = await getDocumentBranding();

    const loaded = await LOADERS[id]({
      params,
      branding,
      canReadRemarks: contextCan(guard.context, 'clients:remarks_view'),
    });

    const fields = definition.fields(branding.timezone, {
      withRemarks: loaded.withRemarks,
    });

    if (format === 'csv') {
      return csvResponse(toCsv(csvColumns(fields), loaded.rows), loaded.filename);
    }

    const bytes = renderReportPdf({
      branding,
      title: definition.title,
      coverage: loaded.coverage,
      filters: loaded.filters,
      fields,
      rows: loaded.rows,
      totals: loaded.totals,
      capped: loaded.capped,
      generatedBy: guard.context.fullName,
      generatedAt: new Date(),
      logo: await letterheadMark(branding.logoPath),
      orientation: definition.orientation,
    });

    return pdfResponse(bytes, loaded.filename.replace(/\.csv$/, '.pdf'));
  };
}
