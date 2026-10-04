/**
 * Reporting: date ranges, pagination, CSV, and what each figure means.
 *
 * ## This module computes no money
 *
 * Not one function here adds a shilling to another. That is the point. Phase 8
 * reads figures that the database already decided — `loan_balances`,
 * `loan_delinquency`, `payment_register` — and a second opinion in TypeScript
 * about what a borrower owes would be a second ledger. The engines in
 * `lib/domain/{loan,repayment-schedule,payment,delinquency}.ts` exist because
 * a screen must be able to *preview* a calculation before it is committed; a
 * report previews nothing, so it calculates nothing.
 *
 * What a report genuinely needs is here: which days a range covers, how to
 * page through rows, how to turn rows into a CSV that a spreadsheet cannot be
 * tricked by, and a written definition of every figure a dashboard shows.
 *
 * ## Why the definitions live in code
 *
 * `METRIC_DEFINITIONS` is not documentation that happens to compile. A
 * dashboard card renders its definition from it, the documentation is checked
 * against it, and a test asserts every metric a dashboard shows has one. A
 * number on a financial screen with no stated meaning is how two people end up
 * acting on the same figure for different reasons.
 */

import {
  addBusinessDays,
  compareBusinessDates,
  daysBetween,
  daysInMonth,
  toBusinessDate,
  type BusinessDate,
} from '@/lib/domain/datetime';

export class ReportingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReportingError';
  }
}

// ---------------------------------------------------------------------------
// Date ranges
// ---------------------------------------------------------------------------

/**
 * The periods a report offers.
 *
 * `today` is the default everywhere collections are concerned, because the
 * question a collection report answers is almost always about the day it is
 * asked on, and because a default of "everything" hands somebody an unbounded
 * query on their first visit.
 */
export const REPORT_PERIODS = ['today', 'week', 'month', 'year', 'custom'] as const;
export type ReportPeriod = (typeof REPORT_PERIODS)[number];

export function isReportPeriod(value: unknown): value is ReportPeriod {
  return (
    typeof value === 'string' && (REPORT_PERIODS as readonly string[]).includes(value)
  );
}

export const REPORT_PERIOD_LABELS: Readonly<Record<ReportPeriod, string>> = {
  today: 'Today',
  week: 'This week',
  month: 'This month',
  year: 'This year',
  custom: 'Custom range',
};

/** An inclusive range of business dates. `from` is never after `to`. */
export interface DateRange {
  readonly from: BusinessDate;
  readonly to: BusinessDate;
}

function parts(date: BusinessDate): { year: number; month: number; day: number } {
  const [year, month, day] = date.split('-').map(Number);
  // `noUncheckedIndexedAccess` is on, and a BusinessDate is already validated
  // to be `YYYY-MM-DD`, so these are present — but the fallback keeps the
  // types honest rather than asserting.
  return { year: year ?? 1970, month: month ?? 1, day: day ?? 1 };
}

function build(year: number, month: number, day: number): BusinessDate {
  const pad = (value: number, width: number): string =>
    String(value).padStart(width, '0');
  return toBusinessDate(`${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}`);
}

/** The first day of `date`'s month. */
export function startOfBusinessMonth(date: BusinessDate): BusinessDate {
  const { year, month } = parts(date);
  return build(year, month, 1);
}

/** The last day of `date`'s month — 28, 29, 30 or 31 as the calendar decides. */
export function endOfBusinessMonth(date: BusinessDate): BusinessDate {
  const { year, month } = parts(date);
  return build(year, month, daysInMonth(year, month));
}

export function startOfBusinessYear(date: BusinessDate): BusinessDate {
  return build(parts(date).year, 1, 1);
}

export function endOfBusinessYear(date: BusinessDate): BusinessDate {
  return build(parts(date).year, 12, 31);
}

/**
 * Day of the week, 0 = Monday.
 *
 * Monday-first because that is how a Ugandan working week is counted and how
 * the business thinks about a collection week. A Sunday-first week would put
 * the quietest day at the front of every report.
 */
export function businessWeekday(date: BusinessDate): number {
  const { year, month, day } = parts(date);
  // Date.UTC avoids the local-timezone shift that `new Date(y, m, d)` applies.
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return (weekday + 6) % 7;
}

/** The Monday of `date`'s week. */
export function startOfBusinessWeek(date: BusinessDate): BusinessDate {
  return addBusinessDays(date, -businessWeekday(date));
}

/** The Sunday of `date`'s week. */
export function endOfBusinessWeek(date: BusinessDate): BusinessDate {
  return addBusinessDays(date, 6 - businessWeekday(date));
}

/**
 * Turn a chosen period into a concrete range.
 *
 * `today` is always the business date the caller passed in, never
 * `new Date()` read in the browser. A viewer whose phone is set to London
 * would otherwise see a different "today" from the ledger, and at 23:30 UTC
 * the two are a day apart — the Phase 7 rule, applied to reports.
 *
 * A custom range with `from` after `to` is rejected rather than quietly
 * swapped. Swapping would answer a question nobody asked and hide a typo that
 * the person needs to see.
 */
export function resolveDateRange(
  period: ReportPeriod,
  today: BusinessDate,
  custom: { readonly from?: string; readonly to?: string } = {},
): DateRange {
  switch (period) {
    case 'today':
      return { from: today, to: today };
    case 'week':
      return { from: startOfBusinessWeek(today), to: endOfBusinessWeek(today) };
    case 'month':
      return { from: startOfBusinessMonth(today), to: endOfBusinessMonth(today) };
    case 'year':
      return { from: startOfBusinessYear(today), to: endOfBusinessYear(today) };
    case 'custom': {
      const from = custom.from === undefined ? today : toBusinessDate(custom.from);
      const to = custom.to === undefined ? today : toBusinessDate(custom.to);

      if (compareBusinessDates(from, to) > 0) {
        throw new ReportingError('The start of the range must not be after its end.');
      }

      return { from, to };
    }
  }
}

/**
 * Inclusive day count. A single day is 1, not 0.
 *
 * Built on `daysBetween` rather than on millisecond arithmetic of its own. A
 * second day-counting implementation is the mistake this project has already
 * recorded twice — once about date validators, once about the collection
 * window — and it would have been the one piece of arithmetic in this module.
 */
export function rangeLength(range: DateRange): number {
  return daysBetween(range.from, range.to) + 1;
}

/** `4 Oct 2026` for one day, `1 – 31 Oct 2026` for a range. */
export function describeRange(
  range: DateRange,
  format: (date: BusinessDate) => string,
): string {
  return range.from === range.to
    ? format(range.from)
    : `${format(range.from)} – ${format(range.to)}`;
}

/**
 * The largest range a report will accept.
 *
 * Five years, which is far beyond any question this business asks and still
 * short of the accidental unbounded scan a blank filter would produce. The
 * limit exists so that a mistyped year cannot ask the database for everything.
 */
export const MAX_RANGE_DAYS = 1_827;

export function assertRangeWithinLimit(range: DateRange): void {
  if (rangeLength(range) > MAX_RANGE_DAYS) {
    throw new ReportingError(
      `A report covers at most ${String(MAX_RANGE_DAYS)} days. Narrow the range.`,
    );
  }
}

/** Every date in the range, ascending. Used to fill gaps in day-by-day summaries. */
export function eachBusinessDate(range: DateRange): readonly BusinessDate[] {
  const dates: BusinessDate[] = [];
  let cursor = range.from;

  while (compareBusinessDates(cursor, range.to) <= 0) {
    dates.push(cursor);
    cursor = addBusinessDays(cursor, 1);
  }

  return dates;
}

/** `2026-10` — the bucket key for a monthly summary. */
export function monthKey(date: BusinessDate): string {
  const { year, month } = parts(date);
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}`;
}

/** The Monday of the week a date falls in, as the bucket key for a weekly summary. */
export function weekKey(date: BusinessDate): string {
  return startOfBusinessWeek(date);
}

// ---------------------------------------------------------------------------
// Collection status
// ---------------------------------------------------------------------------

/**
 * Whether a collection due today has been paid.
 *
 * Declared here rather than beside the query that produces it, for the same
 * reason the loan lifecycle lives in `lib/domain/loan.ts`: a vocabulary a URL
 * can carry must be checkable by the layer that reads the URL, and that layer
 * should not have to import the data access layer to do it.
 */
export const COLLECTION_STATUSES = ['unpaid', 'part_paid', 'paid'] as const;
export type CollectionStatus = (typeof COLLECTION_STATUSES)[number];

export function isCollectionStatus(value: unknown): value is CollectionStatus {
  return (
    typeof value === 'string' &&
    (COLLECTION_STATUSES as readonly string[]).includes(value)
  );
}

export const COLLECTION_STATUS_LABELS: Readonly<Record<CollectionStatus, string>> = {
  unpaid: 'Not paid',
  part_paid: 'Part paid',
  paid: 'Settled',
};

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------

export const DEFAULT_PAGE_SIZE = 25;
export const MAX_PAGE_SIZE = 100;

export interface PageRequest {
  readonly page: number;
  readonly pageSize: number;
}

/**
 * Clamp a page request arriving from a query string.
 *
 * Anything unusable becomes the first page at the default size. A report that
 * threw on `?page=abc` would turn a stray link into an error screen, and one
 * that honoured `?pageSize=1000000` would let a URL ask for the whole table.
 */
export function resolvePageRequest(
  input: { readonly page?: unknown; readonly pageSize?: unknown } = {},
): PageRequest {
  const rawPage = Number(input.page);
  const rawSize = Number(input.pageSize);

  const page = Number.isInteger(rawPage) && rawPage > 0 ? rawPage : 1;
  const pageSize =
    Number.isInteger(rawSize) && rawSize > 0
      ? Math.min(rawSize, MAX_PAGE_SIZE)
      : DEFAULT_PAGE_SIZE;

  return { page, pageSize };
}

/**
 * The zero-based row window for a page request, asking for one extra row.
 *
 * The extra row is how "is there a next page" is answered without a second
 * `count` query over the whole table — the Phase 7 overdue list's approach,
 * kept because an exact total is of no use to anybody clicking Next.
 */
export function pageWindow(request: PageRequest): { from: number; to: number } {
  const from = (request.page - 1) * request.pageSize;
  return { from, to: from + request.pageSize };
}

export interface Paged<Row> {
  readonly rows: readonly Row[];
  readonly page: number;
  readonly pageSize: number;
  readonly hasMore: boolean;
}

/** Split an over-fetched result into the page and the knowledge of more. */
export function takePage<Row>(rows: readonly Row[], request: PageRequest): Paged<Row> {
  const hasMore = rows.length > request.pageSize;

  return {
    rows: hasMore ? rows.slice(0, request.pageSize) : rows,
    page: request.page,
    pageSize: request.pageSize,
    hasMore,
  };
}

/**
 * The hard ceiling on an export.
 *
 * An export is a single file a browser downloads, so it cannot page. 5,000
 * rows is several years of this business's collections and small enough that
 * the file arrives rather than times out. Hitting the ceiling is reported to
 * the person, never silently truncated — a CSV quietly missing its last rows
 * is worse than one that refuses.
 */
export const MAX_EXPORT_ROWS = 5_000;

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

/**
 * Characters that make a spreadsheet treat a cell as a formula.
 *
 * `=` and `@` are the obvious ones. `+` and `-` are formulas too, which is why
 * a cell of `-1+1` evaluates. Tab and carriage return are included because
 * some spreadsheet versions strip leading whitespace before deciding, which
 * turns `\t=cmd` back into a formula.
 */
const FORMULA_PREFIXES = ['=', '+', '-', '@', '\t', '\r'];

/**
 * Make a text value safe to put in a spreadsheet cell.
 *
 * A leading formula character is neutralised with a single quote, which
 * spreadsheets read as "this is text" and show nothing for. The value is not
 * stripped or rejected: a client genuinely named `=Mukasa` should appear in the
 * report as `=Mukasa`, not vanish from it.
 *
 * This is applied to **text** only. Numbers go through `csvNumber`, which
 * emits plain digits, because prefixing a negative number would corrupt a
 * figure to defend against an attack that figures cannot carry.
 */
export function sanitizeCsvText(value: string): string {
  const text = value.replace(/\r\n?/g, ' ').replace(/\n/g, ' ');

  // The *first non-space* character decides, not the first character. Some
  // spreadsheet versions strip leading whitespace before working out whether a
  // cell is a formula, so `  =cmd` is a formula to them and looks harmless to a
  // check that only inspects position zero.
  const first = text.trimStart().charAt(0);

  return FORMULA_PREFIXES.includes(first) ? `'${text}` : text;
}

/** Quote a cell if it contains a comma, a quote or a newline. */
function quote(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export function csvText(value: string | null | undefined): string {
  if (value === null || value === undefined || value === '') return '';
  return quote(sanitizeCsvText(value));
}

/**
 * A number for a spreadsheet: plain digits, no separators, no currency.
 *
 * `UGX 1,250,000` is correct on a screen and useless in a column somebody
 * wants to total, so the export carries `1250000` and the column heading
 * carries the currency.
 */
export function csvNumber(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '';
  return String(value);
}

export interface CsvColumn<Row> {
  readonly header: string;
  readonly cell: (row: Row) => string;
}

/**
 * Render rows as CSV, prefixed with a byte-order mark.
 *
 * The BOM is what makes a spreadsheet open the file as UTF-8 rather than as
 * the machine's local code page. Without it, a client called Nakimuli Zaïnabu
 * arrives as mojibake — which is a correctness problem in a document somebody
 * may rely on to identify a borrower.
 *
 * CRLF line endings, because that is what RFC 4180 specifies and what the
 * spreadsheet software this office uses expects.
 */
export function toCsv<Row>(
  columns: readonly CsvColumn<Row>[],
  rows: readonly Row[],
): string {
  const header = columns.map((column) => quote(column.header)).join(',');
  const body = rows.map((row) => columns.map((column) => column.cell(row)).join(','));

  return `﻿${[header, ...body].join('\r\n')}\r\n`;
}

/** A filename stem that is safe on every filesystem and in a header. */
export function exportFilename(report: string, range: DateRange): string {
  const stem = report.replace(/[^a-z0-9-]/gi, '-').toLowerCase();
  return range.from === range.to
    ? `${stem}-${range.from}.csv`
    : `${stem}-${range.from}-to-${range.to}.csv`;
}

/**
 * Make a search term safe to put inside a PostgREST filter expression.
 *
 * A term from a query string reaches `or(...)`, whose syntax is a string:
 * `payment_number.ilike.%x%,client_name.ilike.%x%`. A term containing a comma,
 * a parenthesis or a dot would therefore not be *escaped* into that
 * expression — it would be *parsed* as part of it, and could name a column or
 * add a filter the caller was never offered. That is filter injection, and the
 * fix is a whitelist rather than an escape: letters, digits, spaces, hyphens,
 * slashes and apostrophes are what a name, a client number or a reference
 * actually contains.
 *
 * `%` and `_` are stripped too. They are `ilike` wildcards, so leaving them in
 * would let a search of `%` match every row — not a security hole, but a way
 * to turn a search box into an unbounded scan.
 *
 * Returns `null` when nothing usable is left, which the callers read as "no
 * search" rather than as "search for the empty string".
 */
export function safeSearchTerm(value: unknown): string | null {
  if (typeof value !== 'string') return null;

  const cleaned = value
    .replace(/[^\p{L}\p{N}\s'/-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);

  return cleaned === '' ? null : cleaned;
}

// ---------------------------------------------------------------------------
// Sorting
// ---------------------------------------------------------------------------

/**
 * How an overdue list may be ordered.
 *
 * A whitelist, not a column name from the query string. The sort reaches a
 * query builder's `order()`, and a value taken from a URL and passed to it is
 * one layer of escaping away from being a way to name any column in the
 * database. Every allowed sort is listed with the column it means.
 */
export const OVERDUE_SORTS = {
  arrears: { label: 'Largest arrears', column: 'arrears_amount', ascending: false },
  days: { label: 'Longest overdue', column: 'days_past_due', ascending: false },
  outstanding: {
    label: 'Largest outstanding',
    column: 'total_outstanding',
    ascending: false,
  },
  oldest: {
    label: 'Oldest missed collection',
    column: 'oldest_past_due_date',
    ascending: true,
  },
} as const satisfies Readonly<
  Record<string, { label: string; column: string; ascending: boolean }>
>;

export type OverdueSort = keyof typeof OVERDUE_SORTS;

export function isOverdueSort(value: unknown): value is OverdueSort {
  return typeof value === 'string' && Object.hasOwn(OVERDUE_SORTS, value);
}

// ---------------------------------------------------------------------------
// What every figure means
// ---------------------------------------------------------------------------

export interface MetricDefinition {
  /** What a card or column header calls it. */
  readonly label: string;
  /** Exactly what it is, in one sentence, with its source named. */
  readonly definition: string;
  /** Which authoritative view or table the figure is read from. */
  readonly source: string;
}

/**
 * Every figure Phase 8 displays, defined once.
 *
 * Three rules shaped these sentences.
 *
 * **Nothing is called profit.** Interest collected is interest collected. The
 * system models no expenses — no staff costs, no bad debt, no cost of
 * capital — so a figure labelled profit would be an accounting claim it cannot
 * support.
 *
 * **Nothing is called a balance.** `cash_received` is money that came in by
 * cash today. It is not cash at hand, because the business also spends and
 * banks money and this system records neither. The same for the mobile money
 * figures: they are payments received, not wallet balances.
 *
 * **Assessed is not collected.** A penalty assessed is a charge raised against
 * a borrower; a penalty collected is money in the door. Reporting the first as
 * income would book revenue the business has not seen.
 */
export const METRIC_DEFINITIONS = {
  // --- Borrowers -----------------------------------------------------------
  total_clients: {
    label: 'Clients',
    definition: 'Every client record, whatever its status.',
    source: 'clients',
  },
  active_clients: {
    label: 'Active clients',
    definition: "Client records whose status is 'active'.",
    source: 'clients.status',
  },
  clients_with_active_loan: {
    label: 'Clients borrowing',
    definition: 'Clients with at least one loan currently in the active state.',
    source: 'loans.status',
  },

  // --- The loan book -------------------------------------------------------
  loans_active: {
    label: 'Active loans',
    definition:
      "Loans whose lifecycle status is 'active' — disbursed and not yet settled. A penalised loan is still an active loan.",
    source: 'loans.status',
  },
  loans_cleared: {
    label: 'Cleared loans',
    definition:
      "Loans whose lifecycle status is 'cleared', which the database permits only when the contract and any penalty are fully paid.",
    source: 'loans.status',
  },
  principal_disbursed: {
    label: 'Principal disbursed',
    definition:
      'Sum of the principal of every loan actually paid out, settled loans included. Measured by the disbursement timestamp, not the current status.',
    source: 'loans.principal_amount where disbursed_at is not null',
  },
  contractual_interest: {
    label: 'Interest charged',
    definition:
      'Sum of the contractual interest agreed on every disbursed loan. What was charged, not what has been received.',
    source: 'loans.total_interest where disbursed_at is not null',
  },

  // --- Collected -----------------------------------------------------------
  total_collected: {
    label: 'Total collected',
    definition:
      'Money actually received: the amount of every posted payment, excluding reversals. Never a sum of scheduled amounts.',
    source: 'loan_balances.total_collected',
  },
  principal_collected: {
    label: 'Principal collected',
    definition:
      'The principal component of posted payment allocations. Derived from the allocations, not apportioned by a ratio.',
    source: 'loan_balances.principal_paid',
  },
  interest_collected: {
    label: 'Interest collected',
    definition:
      'The interest component of posted payment allocations. Different from interest charged, and never called profit.',
    source: 'loan_balances.interest_paid',
  },
  penalty_collected: {
    label: 'Penalty collected',
    definition:
      'The penalty component of posted payment allocations. Money received against late-payment charges.',
    source: 'loan_balances.penalty_paid',
  },

  // --- Owed ----------------------------------------------------------------
  total_outstanding: {
    label: 'Outstanding portfolio',
    definition:
      'What borrowers owe in total: the uncovered contractual schedule plus unpaid penalties.',
    source: 'loan_balances.total_outstanding',
  },
  contractual_outstanding: {
    label: 'Contract outstanding',
    definition:
      'The uncovered part of the agreed repayment schedules. Excludes penalties.',
    source: 'loan_balances.contractual_outstanding',
  },
  penalty_assessed: {
    label: 'Penalties charged',
    definition:
      'Late-payment charges raised against borrowers. A charge, not cash received.',
    source: 'loan_balances.penalty_assessed',
  },
  penalty_outstanding: {
    label: 'Penalties unpaid',
    definition: 'The part of raised late-payment charges that remains unpaid.',
    source: 'loan_balances.penalty_remaining',
  },
  arrears_total: {
    label: 'Arrears',
    definition:
      'Uncovered scheduled collections whose due date has already passed, across every loan.',
    source: 'loan_delinquency.arrears_amount',
  },

  // --- Delinquency counts --------------------------------------------------
  loans_with_arrears: {
    label: 'Loans in arrears',
    definition:
      'Loans with any past-due uncovered collection. Overlaps the grace and penalty counts, because a penalised loan usually has arrears too.',
    source: 'loan_delinquency.arrears_amount > 0',
  },
  loans_state_grace_period: {
    label: 'In grace period',
    definition:
      'Loans past their final collection date, still inside the grace period the loan was approved under, and still owing.',
    source: "loan_delinquency.delinquency_state = 'grace_period'",
  },
  loans_penalised: {
    label: 'Penalised loans',
    definition: 'Loans with a late-payment charge recorded against them.',
    source: 'loan_delinquency.penalty_applied',
  },
  loans_penalty_pending: {
    label: 'Penalty pending',
    definition:
      'Loans past the penalty date whose charge has not been written to the ledger yet. It is raised by the next transaction that touches the loan; reading a report never raises it.',
    source: 'loan_delinquency.penalty_eligible',
  },

  // --- Today ---------------------------------------------------------------
  expected_today: {
    label: 'Expected today',
    definition:
      "Today's scheduled collections less whatever earlier payments had already covered of them — the day's target as it stood this morning. A collection paid ahead is not expected again.",
    source: 'collections_today.expected_today',
  },
  collected_today: {
    label: 'Collected today',
    definition:
      'Posted payments received today in the business timezone, reversals excluded. Includes money applied to arrears or to future collections.',
    source: 'dashboard_collection_summary.collected_today',
  },
  remaining_today: {
    label: 'Still due today',
    definition:
      "The uncovered part of today's scheduled collections, right now. Not expected minus collected: a payment today may settle an older collection instead.",
    source: 'loan_delinquency.due_today_amount',
  },
  clients_due_today: {
    label: 'Clients due today',
    definition:
      'Distinct borrowers with a collection due today that was not already covered before today.',
    source: 'collections_today',
  },
  cash_received: {
    label: 'Cash received',
    definition:
      'Cash payments posted today. Money received by that method — not cash at hand, which this system does not track.',
    source: "payment_register where payment_method = 'cash'",
  },
  mtn_received: {
    label: 'MTN received',
    definition: 'MTN Mobile Money payments posted today. Not a wallet balance.',
    source: "payment_register where payment_method = 'mtn_mobile_money'",
  },
  airtel_received: {
    label: 'Airtel received',
    definition: 'Airtel Money payments posted today. Not a wallet balance.',
    source: "payment_register where payment_method = 'airtel_money'",
  },
  reversed_today_amount: {
    label: 'Reversed today',
    definition:
      'Payments withdrawn today, by the date of the reversal rather than of the payment. Excluded from every collection total.',
    source: 'payment_register where status = reversed',
  },
} as const satisfies Readonly<Record<string, MetricDefinition>>;

export type MetricKey = keyof typeof METRIC_DEFINITIONS;

export function isMetricKey(value: unknown): value is MetricKey {
  return typeof value === 'string' && Object.hasOwn(METRIC_DEFINITIONS, value);
}

export function metricDefinition(key: MetricKey): MetricDefinition {
  return METRIC_DEFINITIONS[key];
}
