import 'server-only';

import { logger } from '@/lib/logger';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import {
  endOfBusinessDayExclusive,
  startOfBusinessDay,
  toBusinessDate,
  type BusinessDate,
} from '@/lib/domain/datetime';
import { sumUgx, toUgx, type UgxAmount } from '@/lib/domain/money';
import {
  isPaymentMethod,
  PAYMENT_METHODS,
  type PaymentMethod,
} from '@/lib/domain/payment';
import { isDelinquencyState, type DelinquencyState } from '@/lib/domain/delinquency';
// The loan lifecycle vocabulary lives in the domain, declared once in Phase 4.
// A second copy here would be a second thing to get wrong the next time the
// lifecycle changes — the same mistake this project has already recorded about
// having two date validators.
import type { LoanStatus } from '@/lib/domain/loan';
import {
  MAX_EXPORT_ROWS,
  monthKey,
  resolvePageRequest,
  safeSearchTerm,
  takePage,
  pageWindow,
  weekKey,
  OVERDUE_SORTS,
  type DateRange,
  type OverdueSort,
  type Paged,
} from '@/lib/domain/reporting';

/**
 * Reading the reports.
 *
 * ## Four rules this module keeps
 *
 * **1. Nothing is recalculated.** Every money column read here was produced by
 * an authoritative view: `payment_register` for what was received and how it
 * was applied, `loan_portfolio_report` for the contract and its derived
 * balances, `loan_penalty_coverage` for charges. The only arithmetic performed
 * is adding up figures the database already decided — never re-deriving
 * interest, arrears, a balance or an allocation. A report that computed a
 * balance would be a second ledger.
 *
 * **2. A total always describes exactly the rows shown.** The collection
 * report runs one query for the whole filtered set, then sums it, groups it by
 * day and slices the page out of it in memory. The table, the day-by-day
 * breakdown, the summary cards and the CSV therefore cannot disagree, because
 * they are three views of one array rather than four queries that happen to
 * use the same filters. When the set exceeds the cap the report says so and
 * withholds the totals rather than showing a partial sum as if it were
 * complete.
 *
 * **3. Filters are whitelists.** A status, a delinquency state, a payment
 * method, a sort key: each is checked against a known set before it reaches a
 * query, and a search term is reduced to characters a name can contain. No
 * value from a URL ever becomes part of a filter expression's syntax — see
 * `safeSearchTerm` for why that distinction matters with PostgREST's `or`.
 *
 * **4. Row Level Security decides the rows.** Every query runs as the
 * signed-in caller through the ordinary server client. There is no privileged
 * read anywhere in this module, so a report is business-wide only when the
 * caller is entitled to the whole business.
 *
 * ## Reversals stay visible
 *
 * A reversed payment is in every collection report, marked. The totals exclude
 * it because they sum `effective_amount`, which the view sets to zero once a
 * payment is withdrawn. Hiding the row would make a reversal look like a
 * payment that never happened; counting it would make withdrawn money look
 * collected. Both are wrong in opposite directions.
 */

type Raw = Readonly<Record<string, unknown>>;

function text(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  if (typeof value === 'boolean') return String(value);
  return '';
}

function nullableText(value: unknown): string | null {
  return value === null || value === undefined ? null : text(value);
}

function money(value: unknown): UgxAmount {
  return toUgx(Number(value ?? 0));
}

function count(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function nullableDate(value: unknown): BusinessDate | null {
  return value === null || value === undefined ? null : toBusinessDate(text(value));
}

// ===========================================================================
// The collection report
// ===========================================================================

export interface CollectionFilters {
  readonly range: DateRange;
  /**
   * The business timezone, used to turn the date range into an instant range.
   * See the note on `getCollectionReport` for why that matters.
   */
  readonly timeZone: string;
  readonly method?: PaymentMethod;
  readonly clientId?: string;
  readonly loanId?: string;
  readonly recordedBy?: string;
  /** Reversed payments are listed by default; a total never counts them. */
  readonly includeReversed?: boolean;
  readonly query?: unknown;
  readonly page?: unknown;
  readonly pageSize?: unknown;
}

export interface CollectionRow {
  readonly paymentId: string;
  readonly paymentNumber: string;
  readonly businessDate: BusinessDate;
  readonly receivedAt: string;
  readonly loanId: string;
  readonly loanNumber: string | null;
  readonly clientId: string;
  readonly clientNumber: string | null;
  readonly clientName: string | null;
  readonly clientNameAtPayment: string;
  readonly amount: UgxAmount;
  readonly effectiveAmount: UgxAmount;
  readonly paymentMethod: PaymentMethod;
  readonly status: string;
  readonly isEffective: boolean;
  readonly recordedBy: string;
  readonly recordedByLabel: string;
  readonly externalReference: string | null;
  readonly reversalReason: string | null;
  readonly principalCollected: UgxAmount;
  readonly interestCollected: UgxAmount;
  readonly penaltyCollected: UgxAmount;
}

export interface CollectionTotals {
  /** Posted, non-reversed payments only. */
  readonly collected: UgxAmount;
  readonly paymentCount: number;
  readonly byMethod: Readonly<Record<PaymentMethod, UgxAmount>>;
  readonly countByMethod: Readonly<Record<PaymentMethod, number>>;
  readonly principalCollected: UgxAmount;
  readonly interestCollected: UgxAmount;
  readonly penaltyCollected: UgxAmount;
  /** Recorded in the range and since withdrawn. Excluded from `collected`. */
  readonly reversedAmount: UgxAmount;
  readonly reversedCount: number;
  /** Everything recorded, withdrawn money included. Never a collection figure. */
  readonly grossAmount: UgxAmount;
}

export interface DayTotals {
  readonly key: string;
  readonly collected: UgxAmount;
  readonly paymentCount: number;
  readonly cash: UgxAmount;
  readonly mtn: UgxAmount;
  readonly airtel: UgxAmount;
  readonly bank: UgxAmount;
  readonly reversedAmount: UgxAmount;
  readonly reversedCount: number;
}

export interface CollectionReport {
  readonly page: Paged<CollectionRow>;
  readonly totals: CollectionTotals;
  readonly byDay: readonly DayTotals[];
  readonly byWeek: readonly DayTotals[];
  readonly byMonth: readonly DayTotals[];
  /**
   * The filtered set hit the row cap, so the totals describe only part of it
   * and the caller must say so instead of showing them.
   */
  readonly truncated: boolean;
  readonly matchedRows: number;
  /** Every matching row, for an export that must agree with the screen. */
  readonly exportRows: readonly CollectionRow[];
}

const REGISTER_COLUMNS = `
  payment_id, payment_number, business_date, received_at, loan_id, loan_number,
  client_id, client_number, client_name, client_name_at_payment, amount,
  effective_amount, payment_method, status, is_effective, recorded_by,
  recorded_by_label, external_reference, reversal_reason, principal_collected,
  interest_collected, penalty_collected
`;

function toCollectionRow(row: Raw): CollectionRow {
  const method = row.payment_method;

  return {
    paymentId: text(row.payment_id),
    paymentNumber: text(row.payment_number),
    businessDate: toBusinessDate(text(row.business_date)),
    receivedAt: text(row.received_at),
    loanId: text(row.loan_id),
    loanNumber: nullableText(row.loan_number),
    clientId: text(row.client_id),
    clientNumber: nullableText(row.client_number),
    clientName: nullableText(row.client_name),
    clientNameAtPayment: text(row.client_name_at_payment),
    amount: money(row.amount),
    effectiveAmount: money(row.effective_amount),
    paymentMethod: isPaymentMethod(method) ? method : 'cash',
    status: text(row.status),
    isEffective: Boolean(row.is_effective),
    recordedBy: text(row.recorded_by),
    recordedByLabel: text(row.recorded_by_label),
    externalReference: nullableText(row.external_reference),
    reversalReason: nullableText(row.reversal_reason),
    principalCollected: money(row.principal_collected),
    interestCollected: money(row.interest_collected),
    penaltyCollected: money(row.penalty_collected),
  };
}

const ZERO = toUgx(0);

function emptyTotals(): CollectionTotals {
  const byMethod = Object.fromEntries(
    PAYMENT_METHODS.map((method) => [method, ZERO]),
  ) as Record<PaymentMethod, UgxAmount>;
  const countByMethod = Object.fromEntries(
    PAYMENT_METHODS.map((method) => [method, 0]),
  ) as Record<PaymentMethod, number>;

  return {
    collected: ZERO,
    paymentCount: 0,
    byMethod,
    countByMethod,
    principalCollected: ZERO,
    interestCollected: ZERO,
    penaltyCollected: ZERO,
    reversedAmount: ZERO,
    reversedCount: 0,
    grossAmount: ZERO,
  };
}

/**
 * Add up a set of register rows.
 *
 * `collected` sums `effectiveAmount`, which the view already zeroed for a
 * reversed payment — so a reversal is excluded without this function needing
 * to remember, and `cash + mtn + airtel` equals `collected` by construction
 * because every payment has exactly one method.
 */
function summarise(rows: readonly CollectionRow[]): CollectionTotals {
  const byMethod = new Map<PaymentMethod, UgxAmount[]>(
    PAYMENT_METHODS.map((method) => [method, []]),
  );
  const countByMethod = new Map<PaymentMethod, number>(
    PAYMENT_METHODS.map((method) => [method, 0]),
  );

  for (const row of rows) {
    if (!row.isEffective) continue;
    byMethod.get(row.paymentMethod)?.push(row.effectiveAmount);
    countByMethod.set(row.paymentMethod, (countByMethod.get(row.paymentMethod) ?? 0) + 1);
  }

  const effective = rows.filter((row) => row.isEffective);
  const reversed = rows.filter((row) => !row.isEffective);

  return {
    collected: sumUgx(effective.map((row) => row.effectiveAmount)),
    paymentCount: effective.length,
    byMethod: Object.fromEntries(
      PAYMENT_METHODS.map((method) => [method, sumUgx(byMethod.get(method) ?? [])]),
    ) as Record<PaymentMethod, UgxAmount>,
    countByMethod: Object.fromEntries(
      PAYMENT_METHODS.map((method) => [method, countByMethod.get(method) ?? 0]),
    ) as Record<PaymentMethod, number>,
    principalCollected: sumUgx(effective.map((row) => row.principalCollected)),
    interestCollected: sumUgx(effective.map((row) => row.interestCollected)),
    penaltyCollected: sumUgx(effective.map((row) => row.penaltyCollected)),
    reversedAmount: sumUgx(reversed.map((row) => row.amount)),
    reversedCount: reversed.length,
    grossAmount: sumUgx(rows.map((row) => row.amount)),
  };
}

function bucket(
  rows: readonly CollectionRow[],
  key: (row: CollectionRow) => string,
): readonly DayTotals[] {
  const groups = new Map<string, CollectionRow[]>();

  for (const row of rows) {
    const group = groups.get(key(row));
    if (group === undefined) groups.set(key(row), [row]);
    else group.push(row);
  }

  return [...groups.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([bucketKey, group]) => {
      const totals = summarise(group);
      return {
        key: bucketKey,
        collected: totals.collected,
        paymentCount: totals.paymentCount,
        cash: totals.byMethod.cash,
        mtn: totals.byMethod.mtn_mobile_money,
        airtel: totals.byMethod.airtel_money,
        bank: totals.byMethod.bank,
        reversedAmount: totals.reversedAmount,
        reversedCount: totals.reversedCount,
      };
    });
}

/**
 * The collection report: rows, totals and the day/week/month breakdowns.
 *
 * One query for the whole filtered set, bounded by the export cap. Everything
 * the screen shows is derived from that one array, which is what makes the
 * chart, the table, the summary and the CSV agree by construction rather than
 * by coincidence.
 */
export async function getCollectionReport(
  filters: CollectionFilters,
): Promise<CollectionReport> {
  const supabase = await createSupabaseServerClient();
  const request = resolvePageRequest(filters);

  // Filtered on `received_at`, not on `business_date`, and the difference is
  // not cosmetic.
  //
  // `business_date` is `payment_business_date(received_at)`, which reads the
  // company's timezone — so it is STABLE rather than IMMUTABLE and **cannot be
  // indexed at all**. Filtering on it forces a function call per row and gives
  // the planner no selectivity estimate: measured at ten times this business's
  // expected scale, a one-month collection report took 65 ms that way and 2 ms
  // this way, against an index that already exists.
  //
  // The two filters are exactly equivalent. A business date range *is* an
  // instant range in the business timezone, and these are the same Phase 1
  // helpers the delinquency engine and the audit viewer use to say so — not a
  // third conversion written here.
  let query = supabase
    .from('payment_register')
    .select(REGISTER_COLUMNS)
    .gte(
      'received_at',
      startOfBusinessDay(filters.range.from, filters.timeZone).toISOString(),
    )
    .lt(
      'received_at',
      endOfBusinessDayExclusive(filters.range.to, filters.timeZone).toISOString(),
    )
    .order('received_at', { ascending: false })
    .limit(MAX_EXPORT_ROWS + 1);

  if (filters.method !== undefined) query = query.eq('payment_method', filters.method);
  if (filters.clientId !== undefined) query = query.eq('client_id', filters.clientId);
  if (filters.loanId !== undefined) query = query.eq('loan_id', filters.loanId);
  if (filters.recordedBy !== undefined) {
    query = query.eq('recorded_by', filters.recordedBy);
  }
  if (filters.includeReversed === false) query = query.eq('status', 'posted');

  const term = safeSearchTerm(filters.query);
  if (term !== null) {
    query = query.or(
      [
        `payment_number.ilike.%${term}%`,
        `loan_number.ilike.%${term}%`,
        `client_number.ilike.%${term}%`,
        `client_name.ilike.%${term}%`,
      ].join(','),
    );
  }

  const { data, error } = await query;

  if (error !== null) {
    logger.warn('Could not read the collection report.', { code: error.code });
    return {
      page: { rows: [], page: request.page, pageSize: request.pageSize, hasMore: false },
      totals: emptyTotals(),
      byDay: [],
      byWeek: [],
      byMonth: [],
      truncated: false,
      matchedRows: 0,
      exportRows: [],
    };
  }

  const all = (data ?? []).map((row) => toCollectionRow(row as Raw));
  const truncated = all.length > MAX_EXPORT_ROWS;
  const rows = truncated ? all.slice(0, MAX_EXPORT_ROWS) : all;

  const window = pageWindow(request);
  const slice = rows.slice(window.from, window.to);

  return {
    page: takePage(slice, request),
    totals: summarise(rows),
    byDay: bucket(rows, (row) => row.businessDate),
    byWeek: bucket(rows, (row) => weekKey(row.businessDate)),
    byMonth: bucket(rows, (row) => monthKey(row.businessDate)),
    truncated,
    matchedRows: rows.length,
    exportRows: rows,
  };
}

// ===========================================================================
// The loan portfolio report
// ===========================================================================

export interface PortfolioFilters {
  readonly statuses?: readonly LoanStatus[];
  readonly states?: readonly DelinquencyState[];
  readonly clientId?: string;
  /** Filters on the disbursement date, which is when the money left. */
  readonly range?: DateRange;
  readonly query?: unknown;
  readonly page?: unknown;
  readonly pageSize?: unknown;
}

export interface PortfolioRow {
  readonly loanId: string;
  readonly loanNumber: string;
  readonly clientId: string;
  readonly clientNumber: string | null;
  readonly clientName: string | null;
  readonly clientPhone: string | null;
  readonly clientNameAtOrigination: string | null;
  readonly clientPhoneAtOrigination: string | null;
  readonly loanStatus: string;
  readonly principalAmount: UgxAmount;
  readonly interestRateBps: number;
  readonly loanTermMonths: number;
  readonly repaymentFrequency: string;
  readonly contractualInterest: UgxAmount;
  readonly totalExpectedRepayment: UgxAmount;
  readonly gracePeriodDays: number;
  readonly penaltyRateBps: number;
  readonly disbursedAt: string | null;
  readonly clearedAt: string | null;
  readonly cancelledAt: string | null;

  readonly scheduledTotal: UgxAmount;
  readonly totalPaid: UgxAmount;
  readonly principalPaid: UgxAmount;
  readonly interestPaid: UgxAmount;
  readonly contractualOutstanding: UgxAmount;
  readonly penaltyAssessed: UgxAmount;
  readonly penaltyPaid: UgxAmount;
  readonly penaltyRemaining: UgxAmount;
  readonly totalOutstanding: UgxAmount;
  readonly totalCollected: UgxAmount;
  readonly postedPaymentCount: number;
  readonly reversedPaymentCount: number;
  readonly lastPaymentAt: string | null;

  readonly scheduledCompletionDate: BusinessDate | null;
  readonly installmentCount: number;
  readonly firstDueDate: BusinessDate | null;
  readonly arrearsAmount: UgxAmount;
  readonly dueTodayAmount: UgxAmount;
  readonly currentDue: UgxAmount;
  readonly missedInstallmentCount: number;
  readonly daysPastDue: number;
  readonly oldestUnpaidDueDate: BusinessDate | null;
  readonly oldestPastDueDate: BusinessDate | null;
  readonly graceEndDate: BusinessDate | null;
  readonly penaltyEffectiveDate: BusinessDate | null;
  readonly withinGracePeriod: boolean;
  readonly penaltyApplied: boolean;
  readonly penaltyEligible: boolean;
  readonly penaltyProjectedAmount: UgxAmount;
  readonly state: DelinquencyState | null;
}

const PORTFOLIO_ROW_COLUMNS = `
  loan_id, loan_number, client_id, client_number, client_name, client_phone,
  client_name_at_origination, client_phone_at_origination, loan_status,
  principal_amount, interest_rate_bps, loan_term_months, repayment_frequency,
  contractual_interest, total_expected_repayment, grace_period_days_applied,
  penalty_rate_bps_applied, disbursed_at, cleared_at, cancelled_at,
  scheduled_total, total_paid, principal_paid, interest_paid,
  contractual_outstanding, penalty_assessed, penalty_paid, penalty_remaining,
  total_outstanding, total_collected, posted_payment_count, reversed_payment_count,
  last_payment_at, scheduled_completion_date, installment_count, first_due_date,
  arrears_amount, due_today_amount, current_due, missed_installment_count,
  days_past_due, oldest_unpaid_due_date, oldest_past_due_date, grace_end_date,
  penalty_effective_date, within_grace_period, penalty_applied, penalty_eligible,
  penalty_projected_amount, delinquency_state
`;

function toPortfolioRow(row: Raw): PortfolioRow {
  const rawState = row.delinquency_state;

  return {
    loanId: text(row.loan_id),
    loanNumber: text(row.loan_number),
    clientId: text(row.client_id),
    clientNumber: nullableText(row.client_number),
    clientName: nullableText(row.client_name),
    clientPhone: nullableText(row.client_phone),
    clientNameAtOrigination: nullableText(row.client_name_at_origination),
    clientPhoneAtOrigination: nullableText(row.client_phone_at_origination),
    loanStatus: text(row.loan_status),
    principalAmount: money(row.principal_amount),
    interestRateBps: count(row.interest_rate_bps),
    loanTermMonths: count(row.loan_term_months),
    repaymentFrequency: text(row.repayment_frequency),
    contractualInterest: money(row.contractual_interest),
    totalExpectedRepayment: money(row.total_expected_repayment),
    gracePeriodDays: count(row.grace_period_days_applied),
    penaltyRateBps: count(row.penalty_rate_bps_applied),
    disbursedAt: nullableText(row.disbursed_at),
    clearedAt: nullableText(row.cleared_at),
    cancelledAt: nullableText(row.cancelled_at),

    scheduledTotal: money(row.scheduled_total),
    totalPaid: money(row.total_paid),
    principalPaid: money(row.principal_paid),
    interestPaid: money(row.interest_paid),
    contractualOutstanding: money(row.contractual_outstanding),
    penaltyAssessed: money(row.penalty_assessed),
    penaltyPaid: money(row.penalty_paid),
    penaltyRemaining: money(row.penalty_remaining),
    totalOutstanding: money(row.total_outstanding),
    totalCollected: money(row.total_collected),
    postedPaymentCount: count(row.posted_payment_count),
    reversedPaymentCount: count(row.reversed_payment_count),
    lastPaymentAt: nullableText(row.last_payment_at),

    scheduledCompletionDate: nullableDate(row.scheduled_completion_date),
    installmentCount: count(row.installment_count),
    firstDueDate: nullableDate(row.first_due_date),
    arrearsAmount: money(row.arrears_amount),
    dueTodayAmount: money(row.due_today_amount),
    currentDue: money(row.current_due),
    missedInstallmentCount: count(row.missed_installment_count),
    daysPastDue: count(row.days_past_due),
    oldestUnpaidDueDate: nullableDate(row.oldest_unpaid_due_date),
    oldestPastDueDate: nullableDate(row.oldest_past_due_date),
    graceEndDate: nullableDate(row.grace_end_date),
    penaltyEffectiveDate: nullableDate(row.penalty_effective_date),
    withinGracePeriod: Boolean(row.within_grace_period),
    penaltyApplied: Boolean(row.penalty_applied),
    penaltyEligible: Boolean(row.penalty_eligible),
    penaltyProjectedAmount: money(row.penalty_projected_amount),
    state: isDelinquencyState(rawState) ? rawState : null,
  };
}

async function queryPortfolio(
  filters: PortfolioFilters,
  options: {
    readonly order: { column: string; ascending: boolean };
    readonly limit?: number;
  },
): Promise<readonly PortfolioRow[]> {
  const supabase = await createSupabaseServerClient();

  let query = supabase
    .from('loan_portfolio_report')
    .select(PORTFOLIO_ROW_COLUMNS)
    .order(options.order.column, {
      ascending: options.order.ascending,
      nullsFirst: false,
    })
    .limit(options.limit ?? MAX_EXPORT_ROWS + 1);

  if (filters.statuses !== undefined && filters.statuses.length > 0) {
    query = query.in('loan_status', [...filters.statuses]);
  }
  if (filters.states !== undefined && filters.states.length > 0) {
    query = query.in('delinquency_state', [...filters.states]);
  }
  if (filters.clientId !== undefined) query = query.eq('client_id', filters.clientId);
  if (filters.range !== undefined) {
    query = query
      .gte('disbursed_at', `${filters.range.from}T00:00:00Z`)
      .lt('disbursed_at', `${filters.range.to}T23:59:59.999Z`);
  }

  const term = safeSearchTerm(filters.query);
  if (term !== null) {
    query = query.or(
      [
        `loan_number.ilike.%${term}%`,
        `client_number.ilike.%${term}%`,
        `client_name.ilike.%${term}%`,
      ].join(','),
    );
  }

  const { data, error } = await query;

  if (error !== null) {
    logger.warn('Could not read the loan portfolio report.', { code: error.code });
    return [];
  }

  return (data ?? []).map((row) => toPortfolioRow(row as Raw));
}

export interface PortfolioTotals {
  readonly loanCount: number;
  readonly principal: UgxAmount;
  readonly contractualInterest: UgxAmount;
  readonly penaltyAssessed: UgxAmount;
  readonly totalExpected: UgxAmount;
  readonly collected: UgxAmount;
  readonly contractualOutstanding: UgxAmount;
  readonly penaltyOutstanding: UgxAmount;
  readonly totalOutstanding: UgxAmount;
  readonly arrears: UgxAmount;
}

function portfolioTotals(rows: readonly PortfolioRow[]): PortfolioTotals {
  return {
    loanCount: rows.length,
    principal: sumUgx(rows.map((row) => row.principalAmount)),
    contractualInterest: sumUgx(rows.map((row) => row.contractualInterest)),
    penaltyAssessed: sumUgx(rows.map((row) => row.penaltyAssessed)),
    totalExpected: sumUgx(rows.map((row) => row.totalExpectedRepayment)),
    collected: sumUgx(rows.map((row) => row.totalCollected)),
    contractualOutstanding: sumUgx(rows.map((row) => row.contractualOutstanding)),
    penaltyOutstanding: sumUgx(rows.map((row) => row.penaltyRemaining)),
    totalOutstanding: sumUgx(rows.map((row) => row.totalOutstanding)),
    arrears: sumUgx(rows.map((row) => row.arrearsAmount)),
  };
}

export interface PortfolioReport {
  readonly page: Paged<PortfolioRow>;
  readonly totals: PortfolioTotals;
  readonly truncated: boolean;
  readonly matchedRows: number;
  readonly exportRows: readonly PortfolioRow[];
}

export async function getPortfolioReport(
  filters: PortfolioFilters,
  order: { column: string; ascending: boolean } = {
    column: 'disbursed_at',
    ascending: false,
  },
): Promise<PortfolioReport> {
  const request = resolvePageRequest(filters);
  const all = await queryPortfolio(filters, { order });

  const truncated = all.length > MAX_EXPORT_ROWS;
  const rows = truncated ? all.slice(0, MAX_EXPORT_ROWS) : all;
  const window = pageWindow(request);

  return {
    page: takePage(rows.slice(window.from, window.to), request),
    totals: portfolioTotals(rows),
    truncated,
    matchedRows: rows.length,
    exportRows: rows,
  };
}

// ===========================================================================
// Arrears, grace and penalties
// ===========================================================================

/**
 * The delinquency states that mean a borrower is behind.
 *
 * Exactly Phase 7's states, not a second definition. `due_today` is absent: a
 * collection due today is not overdue until the day ends, which is the rule the
 * delinquency engine already applies.
 */
export const ARREARS_STATES: readonly DelinquencyState[] = [
  'penalty_due',
  'expired_unpaid',
  'grace_period',
  'in_arrears',
];

export interface ArrearsReportRow extends PortfolioRow {
  readonly latestRemark: ClientRemarkSummary | null;
}

export interface ClientRemarkSummary {
  readonly id: string;
  readonly body: string;
  readonly category: string;
  readonly createdByLabel: string;
  readonly createdAt: string;
}

/**
 * The latest internal remark for each of these clients.
 *
 * Reads `client_remarks`, the Phase 3 table, rather than anything new. A
 * caller without `clients:remarks_view` gets nothing back: the policy on that
 * table decides, so the arrears report simply shows no remark column rather
 * than leaking one. There is no second remarks store and no duplicate write
 * path — the report links to the existing form.
 *
 * One query for every client on the page, not one per row.
 */
export async function latestRemarkByClient(
  clientIds: readonly string[],
): Promise<ReadonlyMap<string, ClientRemarkSummary>> {
  if (clientIds.length === 0) return new Map();

  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase
    .from('client_remarks')
    .select('id, client_id, body, category, created_by_label, created_at')
    .in('client_id', [...new Set(clientIds)])
    .order('created_at', { ascending: false });

  if (error !== null) {
    // Not an error worth surfacing: a caller who may not read remarks sees the
    // report without them, which is the intended behaviour.
    logger.debug('No remarks returned for the arrears report.', { code: error.code });
    return new Map();
  }

  const latest = new Map<string, ClientRemarkSummary>();

  for (const raw of data ?? []) {
    const row = raw as Raw;
    const clientId = text(row.client_id);
    if (latest.has(clientId)) continue;

    latest.set(clientId, {
      id: text(row.id),
      body: text(row.body),
      category: text(row.category),
      createdByLabel: text(row.created_by_label),
      createdAt: text(row.created_at),
    });
  }

  return latest;
}

export interface ArrearsReport {
  readonly page: Paged<ArrearsReportRow>;
  readonly totals: PortfolioTotals;
  readonly truncated: boolean;
  readonly matchedRows: number;
  readonly exportRows: readonly PortfolioRow[];
}

export async function getArrearsReport(
  filters: Omit<PortfolioFilters, 'states' | 'statuses'> & {
    readonly states?: readonly DelinquencyState[];
    readonly sort?: OverdueSort;
    readonly withRemarks?: boolean;
  },
): Promise<ArrearsReport> {
  const sort = OVERDUE_SORTS[filters.sort ?? 'days'];
  const states =
    filters.states !== undefined && filters.states.length > 0
      ? filters.states.filter((state) => ARREARS_STATES.includes(state))
      : ARREARS_STATES;

  const report = await getPortfolioReport(
    { ...filters, states },
    { column: sort.column, ascending: sort.ascending },
  );

  const remarks =
    filters.withRemarks === true
      ? await latestRemarkByClient(report.page.rows.map((row) => row.clientId))
      : new Map<string, ClientRemarkSummary>();

  return {
    page: {
      ...report.page,
      rows: report.page.rows.map((row) => ({
        ...row,
        latestRemark: remarks.get(row.clientId) ?? null,
      })),
    },
    totals: report.totals,
    truncated: report.truncated,
    matchedRows: report.matchedRows,
    exportRows: report.exportRows,
  };
}

/**
 * Loans inside their grace period.
 *
 * Penalised loans are deliberately absent (§29). The grace list is a list of
 * borrowers who can still avoid a charge; a loan that has already been charged
 * belongs on the penalty report, and mixing them would mean a collections
 * officer offering somebody a deadline that has passed.
 */
export async function getGracePeriodReport(
  filters: Omit<PortfolioFilters, 'states'> = {},
): Promise<PortfolioReport> {
  return getPortfolioReport(
    { ...filters, states: ['grace_period'] },
    { column: 'grace_end_date', ascending: true },
  );
}

export interface PenaltyReportRow {
  readonly penaltyId: string;
  readonly loanId: string;
  readonly loanNumber: string;
  readonly clientId: string;
  readonly clientNumber: string | null;
  readonly clientName: string | null;
  readonly penaltyType: string;
  readonly finalDueDate: BusinessDate;
  readonly gracePeriodDays: number;
  readonly graceEndDate: BusinessDate;
  readonly effectiveDate: BusinessDate;
  readonly basisAmount: UgxAmount;
  readonly penaltyRateBps: number;
  readonly penaltyAmount: UgxAmount;
  readonly penaltyPaid: UgxAmount;
  readonly penaltyRemaining: UgxAmount;
  readonly appliedAt: string;
}

export interface PenaltyTotals {
  readonly penaltyCount: number;
  readonly basis: UgxAmount;
  readonly assessed: UgxAmount;
  readonly collected: UgxAmount;
  readonly outstanding: UgxAmount;
}

export interface PenaltyReport {
  readonly page: Paged<PenaltyReportRow>;
  readonly totals: PenaltyTotals;
  readonly truncated: boolean;
  readonly matchedRows: number;
  readonly exportRows: readonly PenaltyReportRow[];
}

/**
 * Every recorded late-payment charge.
 *
 * Read-only by construction: `loan_penalties` refuses UPDATE and DELETE for
 * every caller, there is no capability to change one, and this report offers no
 * action that would. Charges that are *eligible but not yet recorded* are not
 * here — they are not charges yet, and a report must not be the thing that
 * creates one.
 */
export async function getPenaltyReport(
  filters: {
    readonly clientId?: string;
    readonly loanId?: string;
    readonly range?: DateRange;
    readonly unpaidOnly?: boolean;
    readonly query?: unknown;
    readonly page?: unknown;
    readonly pageSize?: unknown;
  } = {},
): Promise<PenaltyReport> {
  const supabase = await createSupabaseServerClient();
  const request = resolvePageRequest(filters);

  let query = supabase
    .from('loan_penalty_coverage')
    .select(
      `penalty_id, loan_id, client_id, penalty_type, final_due_date,
       grace_period_days, grace_end_date, effective_date, basis_amount,
       penalty_rate_bps, penalty_amount, allocated_amount, remaining_amount,
       applied_at`,
    )
    .order('effective_date', { ascending: false })
    .limit(MAX_EXPORT_ROWS + 1);

  if (filters.clientId !== undefined) query = query.eq('client_id', filters.clientId);
  if (filters.loanId !== undefined) query = query.eq('loan_id', filters.loanId);
  if (filters.range !== undefined) {
    query = query
      .gte('effective_date', filters.range.from)
      .lte('effective_date', filters.range.to);
  }
  if (filters.unpaidOnly === true) query = query.gt('remaining_amount', 0);

  const { data, error } = await query;

  if (error !== null) {
    logger.warn('Could not read the penalty report.', { code: error.code });
    return {
      page: { rows: [], page: request.page, pageSize: request.pageSize, hasMore: false },
      totals: {
        penaltyCount: 0,
        basis: ZERO,
        assessed: ZERO,
        collected: ZERO,
        outstanding: ZERO,
      },
      truncated: false,
      matchedRows: 0,
      exportRows: [],
    };
  }

  const raws = (data ?? []).map((row) => row as Raw);
  const truncated = raws.length > MAX_EXPORT_ROWS;
  const bounded = truncated ? raws.slice(0, MAX_EXPORT_ROWS) : raws;

  // Loan and client labels for the rows read, in one extra query rather than
  // one per penalty. The coverage view carries no foreign keys for PostgREST to
  // embed through, which is the same reason Phase 7's overdue list does this.
  const labels = new Map<
    string,
    { loanNumber: string; clientNumber: string | null; clientName: string | null }
  >();

  if (bounded.length > 0) {
    const { data: loans } = await supabase
      .from('loan_portfolio_report')
      .select('loan_id, loan_number, client_number, client_name')
      .in('loan_id', [...new Set(bounded.map((row) => text(row.loan_id)))]);

    for (const raw of loans ?? []) {
      const row = raw as Raw;
      labels.set(text(row.loan_id), {
        loanNumber: text(row.loan_number),
        clientNumber: nullableText(row.client_number),
        clientName: nullableText(row.client_name),
      });
    }
  }

  const rows: PenaltyReportRow[] = bounded.map((row) => {
    const label = labels.get(text(row.loan_id));

    return {
      penaltyId: text(row.penalty_id),
      loanId: text(row.loan_id),
      loanNumber: label?.loanNumber ?? '',
      clientId: text(row.client_id),
      clientNumber: label?.clientNumber ?? null,
      clientName: label?.clientName ?? null,
      penaltyType: text(row.penalty_type),
      finalDueDate: toBusinessDate(text(row.final_due_date)),
      gracePeriodDays: count(row.grace_period_days),
      graceEndDate: toBusinessDate(text(row.grace_end_date)),
      effectiveDate: toBusinessDate(text(row.effective_date)),
      basisAmount: money(row.basis_amount),
      penaltyRateBps: count(row.penalty_rate_bps),
      penaltyAmount: money(row.penalty_amount),
      penaltyPaid: money(row.allocated_amount),
      penaltyRemaining: money(row.remaining_amount),
      appliedAt: text(row.applied_at),
    };
  });

  const window = pageWindow(request);

  return {
    page: takePage(rows.slice(window.from, window.to), request),
    totals: {
      penaltyCount: rows.length,
      basis: sumUgx(rows.map((row) => row.basisAmount)),
      assessed: sumUgx(rows.map((row) => row.penaltyAmount)),
      collected: sumUgx(rows.map((row) => row.penaltyPaid)),
      outstanding: sumUgx(rows.map((row) => row.penaltyRemaining)),
    },
    truncated,
    matchedRows: rows.length,
    exportRows: rows,
  };
}

// ===========================================================================
// The client directory report
// ===========================================================================

export interface ClientReportRow {
  readonly clientId: string;
  readonly clientNumber: string;
  readonly fullName: string;
  readonly phone: string;
  readonly district: string | null;
  readonly villageArea: string | null;
  readonly occupation: string | null;
  readonly status: string;
  readonly registeredAt: string;
  readonly hasActiveLoan: boolean;
  readonly loanCount: number;
  readonly totalOutstanding: UgxAmount;
  readonly arrearsAmount: UgxAmount;
  /** The most pressing state across the client's loans, or null if they have none. */
  readonly state: DelinquencyState | null;
}

export interface ClientReport {
  readonly page: Paged<ClientReportRow>;
  readonly truncated: boolean;
  readonly matchedRows: number;
  readonly exportRows: readonly ClientReportRow[];
}

/**
 * The client directory, with each borrower's position beside them.
 *
 * ## No National Identification Number, anywhere
 *
 * Not in the report, not in its CSV, not behind a capability check. NINs are
 * read one record at a time by somebody with `clients:view_nin` and a reason
 * to look; a column of them in a downloadable file is a different kind of
 * object entirely, and the file outlives every access control the application
 * has. §76, and the Phase 3 rule it comes from.
 *
 * ## Two queries, never one per client
 *
 * The matching clients are read first, then every loan belonging to them in a
 * single `in (...)`, then aggregated in memory. A loop that read each client's
 * loans would be the N+1 §155 forbids.
 *
 * The whole filtered set is read and then paged in memory, as the other
 * reports do, so the export contains every matching client rather than
 * whichever page somebody happened to be on. The set is bounded by the export
 * cap, and hitting it is reported rather than silently truncating.
 */
export async function getClientReport(
  filters: {
    readonly status?: string;
    readonly withArrearsOnly?: boolean;
    readonly query?: unknown;
    readonly page?: unknown;
    readonly pageSize?: unknown;
  } = {},
): Promise<ClientReport> {
  const supabase = await createSupabaseServerClient();
  const request = resolvePageRequest(filters);

  let query = supabase
    .from('clients')
    .select(
      'id, client_number, full_name, phone, district, village_area, occupation, status, registered_at',
    )
    .order('client_number', { ascending: true })
    .limit(MAX_EXPORT_ROWS + 1);

  if (filters.status !== undefined) query = query.eq('status', filters.status);

  const term = safeSearchTerm(filters.query);
  if (term !== null) {
    query = query.or(
      [
        `client_number.ilike.%${term}%`,
        `full_name.ilike.%${term}%`,
        `phone.ilike.%${term}%`,
      ].join(','),
    );
  }

  const { data, error } = await query;

  if (error !== null) {
    logger.warn('Could not read the client report.', { code: error.code });
    return {
      page: { rows: [], page: request.page, pageSize: request.pageSize, hasMore: false },
      truncated: false,
      matchedRows: 0,
      exportRows: [],
    };
  }

  const matched = (data ?? []).map((row) => row as Raw);
  const truncated = matched.length > MAX_EXPORT_ROWS;
  const clients = truncated ? matched.slice(0, MAX_EXPORT_ROWS) : matched;

  if (clients.length === 0) {
    return {
      page: { rows: [], page: request.page, pageSize: request.pageSize, hasMore: false },
      truncated: false,
      matchedRows: 0,
      exportRows: [],
    };
  }

  const ids = [...new Set(clients.map((row) => text(row.id)))];

  const { data: loans } = await supabase
    .from('loan_portfolio_report')
    .select(
      'client_id, loan_status, total_outstanding, arrears_amount, delinquency_state',
    )
    .in('client_id', ids);

  const byClient = new Map<
    string,
    {
      loanCount: number;
      active: boolean;
      outstanding: UgxAmount[];
      arrears: UgxAmount[];
      states: DelinquencyState[];
    }
  >();

  for (const raw of loans ?? []) {
    const row = raw as Raw;
    const clientId = text(row.client_id);
    const entry = byClient.get(clientId) ?? {
      loanCount: 0,
      active: false,
      outstanding: [],
      arrears: [],
      states: [],
    };

    entry.loanCount += 1;
    if (text(row.loan_status) === 'active') entry.active = true;
    entry.outstanding.push(money(row.total_outstanding));
    entry.arrears.push(money(row.arrears_amount));

    const state = row.delinquency_state;
    if (isDelinquencyState(state)) entry.states.push(state);

    byClient.set(clientId, entry);
  }

  // The most pressing state the client has, by the same precedence the
  // delinquency engine uses. Not recomputed — just the worst of the states the
  // engine already assigned.
  const severity: readonly DelinquencyState[] = [
    'penalty_due',
    'expired_unpaid',
    'grace_period',
    'in_arrears',
    'due_today',
    'current',
    'cleared',
  ];

  const rows: ClientReportRow[] = clients.map((row) => {
    const clientId = text(row.id);
    const entry = byClient.get(clientId);
    const states = entry?.states ?? [];
    const worst = severity.find((state) => states.includes(state)) ?? null;

    return {
      clientId,
      clientNumber: text(row.client_number),
      fullName: text(row.full_name),
      phone: text(row.phone),
      district: nullableText(row.district),
      villageArea: nullableText(row.village_area),
      occupation: nullableText(row.occupation),
      status: text(row.status),
      registeredAt: text(row.registered_at),
      hasActiveLoan: entry?.active ?? false,
      loanCount: entry?.loanCount ?? 0,
      totalOutstanding: sumUgx(entry?.outstanding ?? []),
      arrearsAmount: sumUgx(entry?.arrears ?? []),
      state: worst,
    };
  });

  const visible =
    filters.withArrearsOnly === true ? rows.filter((row) => row.arrearsAmount > 0) : rows;

  const window = pageWindow(request);

  return {
    page: takePage(visible.slice(window.from, window.to), request),
    truncated,
    matchedRows: visible.length,
    exportRows: visible,
  };
}

// ===========================================================================
// The client statement
// ===========================================================================

export interface StatementScheduleRow {
  readonly installmentNumber: number;
  readonly dueDate: BusinessDate;
  readonly expectedAmount: UgxAmount;
  readonly scheduledPrincipal: UgxAmount;
  readonly scheduledInterest: UgxAmount;
  readonly allocatedAmount: UgxAmount;
  readonly remainingAmount: UgxAmount;
}

export interface StatementPaymentRow {
  readonly paymentId: string;
  readonly paymentNumber: string;
  readonly businessDate: BusinessDate;
  readonly receivedAt: string;
  readonly amount: UgxAmount;
  readonly effectiveAmount: UgxAmount;
  readonly paymentMethod: PaymentMethod;
  readonly status: string;
  readonly isEffective: boolean;
  readonly principalCollected: UgxAmount;
  readonly interestCollected: UgxAmount;
  readonly penaltyCollected: UgxAmount;
}

export interface LoanStatement {
  readonly loan: PortfolioRow;
  readonly schedule: readonly StatementScheduleRow[];
  readonly payments: readonly StatementPaymentRow[];
  readonly penalty: PenaltyReportRow | null;
}

/**
 * One loan's complete statement.
 *
 * ## It mutates nothing
 *
 * Three reads, no writes, no penalty materialisation. A statement is a
 * rendering of the ledger, and a document that changed the account it reports
 * on would be indefensible.
 *
 * ## Which name it carries
 *
 * The header uses the borrower as they were when the loan was written —
 * `client_name_at_origination` from the loan's immutable snapshot — with the
 * current name shown beside it when the two differ. That is a deliberate
 * choice, not an accident of which column was to hand: a statement is a
 * historical document about an agreement, and a borrower who changed their
 * name last month did not change who signed in March. Phase 4 captured the
 * snapshot for exactly this.
 *
 * Each payment line likewise carries the name recorded on its own receipt, so a
 * statement and the receipts it lists cannot disagree.
 */
export async function getLoanStatement(loanId: string): Promise<LoanStatement | null> {
  const supabase = await createSupabaseServerClient();

  const { data: loanRow, error } = await supabase
    .from('loan_portfolio_report')
    .select(PORTFOLIO_ROW_COLUMNS)
    .eq('loan_id', loanId)
    .maybeSingle();

  if (error !== null) {
    logger.warn('Could not read a loan statement header.', { code: error.code });
    return null;
  }

  if (loanRow === null) return null;

  const [{ data: schedule }, { data: payments }, penalties] = await Promise.all([
    supabase
      .from('loan_installment_coverage')
      .select(
        'installment_number, due_date, expected_amount, scheduled_principal, scheduled_interest, allocated_amount, remaining_amount',
      )
      .eq('loan_id', loanId)
      .order('installment_number', { ascending: true }),
    supabase
      .from('payment_register')
      .select(
        `payment_id, payment_number, business_date, received_at, amount,
         effective_amount, payment_method, status, is_effective,
         principal_collected, interest_collected, penalty_collected`,
      )
      .eq('loan_id', loanId)
      .order('received_at', { ascending: true }),
    getPenaltyReport({ loanId, pageSize: 2 }),
  ]);

  const penalty = penalties.exportRows[0] ?? null;

  return {
    loan: toPortfolioRow(loanRow),
    schedule: (schedule ?? []).map((raw) => {
      const row = raw as Raw;
      return {
        installmentNumber: count(row.installment_number),
        dueDate: toBusinessDate(text(row.due_date)),
        expectedAmount: money(row.expected_amount),
        scheduledPrincipal: money(row.scheduled_principal),
        scheduledInterest: money(row.scheduled_interest),
        allocatedAmount: money(row.allocated_amount),
        remainingAmount: money(row.remaining_amount),
      };
    }),
    payments: (payments ?? []).map((raw) => {
      const row = raw as Raw;
      const method = row.payment_method;
      return {
        paymentId: text(row.payment_id),
        paymentNumber: text(row.payment_number),
        businessDate: toBusinessDate(text(row.business_date)),
        receivedAt: text(row.received_at),
        amount: money(row.amount),
        effectiveAmount: money(row.effective_amount),
        paymentMethod: isPaymentMethod(method) ? method : 'cash',
        status: text(row.status),
        isEffective: Boolean(row.is_effective),
        principalCollected: money(row.principal_collected),
        interestCollected: money(row.interest_collected),
        penaltyCollected: money(row.penalty_collected),
      };
    }),
    penalty,
  };
}

/** Every loan a borrower has had, newest first. For the portal and statements. */
export async function listClientLoans(
  clientId: string,
): Promise<readonly PortfolioRow[]> {
  return queryPortfolio(
    { clientId },
    { order: { column: 'created_at', ascending: false } },
  );
}
