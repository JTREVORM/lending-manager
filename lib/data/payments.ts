import 'server-only';

import { logger } from '@/lib/logger';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { toBusinessDate, type BusinessDate } from '@/lib/domain/datetime';
import { toUgx, type UgxAmount } from '@/lib/domain/money';
import {
  assertBalanceInvariants,
  isPaymentMethod,
  isPaymentStatus,
  minimumAcceptablePayment,
  unpaidScheduledDue,
  type ObligationKind,
  type PaymentObligation,
  type LoanBalance,
  type PaymentMethod,
  type PaymentStatus,
} from '@/lib/domain/payment';
import type { PaymentSearchInput } from '@/lib/validation/payment';

/**
 * Reading the payment ledger.
 *
 * Every query runs as the signed-in caller, so Row Level Security decides what
 * comes back. Nothing here uses the privileged client.
 *
 * ## There is no write function in this module
 *
 * Deliberately. `post_payment` and `reverse_payment` are the only writers, and
 * they are reached through the Server Actions in `lib/payments/actions.ts`.
 * There is no helper here that inserts a payment or an allocation, because
 * there is no path to the ledger that bypasses those two functions — see
 * migration `20261006000700`.
 *
 * ## Balances are read, never computed here
 *
 * `loan_balances` and `loan_installment_coverage` are database views. This
 * module reads them rather than summing rows in TypeScript, so the figure the
 * screen shows and the figure `post_payment` validates against come from one
 * definition. `assertBalanceInvariants` then re-checks what came back, so a
 * corrupt ledger is caught at the point it is read rather than believed.
 */

export const PAYMENTS_PAGE_SIZE = 25;

export interface PaymentSummary {
  readonly id: string;
  readonly paymentNumber: string;
  readonly loanId: string;
  readonly loanNumber: string;
  readonly clientId: string;
  readonly clientName: string;
  readonly clientNumber: string;
  readonly amount: UgxAmount;
  readonly paymentMethod: PaymentMethod;
  readonly externalReference: string | null;
  readonly status: PaymentStatus;
  readonly receivedAt: string;
  readonly recordedByLabel: string;
}

export interface PaymentDetail extends PaymentSummary {
  readonly outstandingBefore: UgxAmount;
  readonly outstandingAfter: UgxAmount;
  readonly clientNameAtPayment: string;
  readonly notes: string | null;
  readonly reversedAt: string | null;
  readonly reversalReason: string | null;
  readonly reversedByLabel: string | null;
}

export interface PaymentAllocationRow {
  readonly id: string;
  readonly kind: ObligationKind;
  /** The installment's id, or the penalty's. Exactly one target is set. */
  readonly obligationId: string;
  /** The collection number. Zero for a penalty, which has no number. */
  readonly installmentNumber: number;
  /** The collection's due date, or the penalty's effective date. */
  readonly dueDate: BusinessDate;
  readonly allocatedAmount: UgxAmount;
  readonly allocatedPrincipal: UgxAmount;
  readonly allocatedInterest: UgxAmount;
  readonly allocatedPenalty: UgxAmount;
}

export interface PaymentPage {
  readonly payments: readonly PaymentSummary[];
  readonly page: number;
  readonly hasMore: boolean;
}

/** A loan's position, as the database derives it. */
export interface LoanPosition extends LoanBalance {
  readonly loanId: string;
  readonly loanNumber: string;
  readonly status: string;
  readonly postedPaymentTotal: UgxAmount;
  readonly postedPaymentCount: number;
  readonly reversedPaymentCount: number;
  readonly lastPaymentAt: string | null;
  /** Scheduled amounts dated today or earlier that remain uncovered. */
  readonly unpaidScheduledDue: UgxAmount;
  /** The smallest payment the business will accept now, or null if settled. */
  readonly minimumPayment: UgxAmount | null;
  /** Did every derived figure reconcile when it was read? */
  readonly reconciles: boolean;
  readonly reconciliationProblem: string | null;
}

const SUMMARY_COLUMNS = `
  id, payment_number, loan_id, client_id, amount, payment_method,
  external_reference, status, received_at, recorded_by_label,
  loans!inner ( loan_number ),
  clients!inner ( full_name, client_number )
`;

interface RawSummary {
  readonly id: unknown;
  readonly payment_number: unknown;
  readonly loan_id: unknown;
  readonly client_id: unknown;
  readonly amount: unknown;
  readonly payment_method: unknown;
  readonly external_reference: unknown;
  readonly status: unknown;
  readonly received_at: unknown;
  readonly recorded_by_label: unknown;
  readonly loans: { readonly loan_number: unknown } | null;
  readonly clients: {
    readonly full_name: unknown;
    readonly client_number: unknown;
  } | null;
}

/**
 * String columns, read without coercion.
 *
 * `String(value)` on an `unknown` would render an unexpected object as the
 * literal text `[object Object]` into the interface — on a receipt number or a
 * transaction reference, worse than showing nothing. Mirrors the helpers in
 * `lib/data/loans.ts`, and the lint rule that forbids the coercion is the
 * reason they exist in both places.
 */
function textField(fields: Record<string, unknown>, key: string): string {
  const value = fields[key];
  return typeof value === 'string' ? value : '';
}

function nullableText(fields: Record<string, unknown>, key: string): string | null {
  const value = fields[key];
  return typeof value === 'string' ? value : null;
}

/** A relation Supabase embedded in the row, as a plain record. */
function relation(fields: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = fields[key];
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

function toSummary(raw: RawSummary): PaymentSummary {
  const row = raw as unknown as Record<string, unknown>;
  const loan = relation(row, 'loans');
  const client = relation(row, 'clients');

  const method = textField(row, 'payment_method');
  const status = textField(row, 'status');

  return {
    id: textField(row, 'id'),
    paymentNumber: textField(row, 'payment_number'),
    loanId: textField(row, 'loan_id'),
    loanNumber: textField(loan, 'loan_number'),
    clientId: textField(row, 'client_id'),
    clientName: textField(client, 'full_name'),
    clientNumber: textField(client, 'client_number'),
    amount: toUgx(Number(row.amount)),
    // Fall back rather than throw: an unknown value here means the database
    // vocabulary moved ahead of the code, and a register that refuses to
    // render is worse than one row reading oddly.
    paymentMethod: isPaymentMethod(method) ? method : 'cash',
    externalReference: nullableText(row, 'external_reference'),
    status: isPaymentStatus(status) ? status : 'posted',
    receivedAt: textField(row, 'received_at'),
    recordedByLabel: textField(row, 'recorded_by_label'),
  };
}

/**
 * The payment register, filtered and paginated.
 *
 * Paginated rather than fetched whole: the ledger grows without bound, and a
 * screen that loads every payment is a screen that stops working in a year.
 */
export async function listPayments(filter: PaymentSearchInput): Promise<PaymentPage> {
  const supabase = await createSupabaseServerClient();
  const page = filter.page ?? 1;
  const from = (page - 1) * PAYMENTS_PAGE_SIZE;

  let request = supabase
    .from('loan_payments')
    .select(SUMMARY_COLUMNS)
    .order('received_at', { ascending: false })
    // One extra row, to learn whether there is a next page without counting.
    .range(from, from + PAYMENTS_PAGE_SIZE);

  if (filter.method !== undefined && filter.method !== 'all') {
    request = request.eq('payment_method', filter.method);
  }

  if (filter.status !== undefined && filter.status !== 'all') {
    request = request.eq('status', filter.status);
  }

  if (filter.clientId !== undefined && filter.clientId !== '') {
    request = request.eq('client_id', filter.clientId);
  }

  if (filter.from !== undefined && filter.from !== '') {
    request = request.gte('received_at', `${filter.from}T00:00:00Z`);
  }

  if (filter.to !== undefined && filter.to !== '') {
    // Inclusive of the whole day: the bound is the start of the next one.
    request = request.lt('received_at', `${filter.to}T23:59:59.999Z`);
  }

  const search = filter.query ?? null;

  if (search !== null) {
    // Escaped, so a comma or a parenthesis in the search text cannot break
    // out of the `or` filter's own syntax.
    const safe = search.replace(/[,()\\]/g, ' ').trim();

    if (safe !== '') {
      request = request.or(
        [`payment_number.ilike.%${safe}%`, `external_reference.ilike.%${safe}%`].join(
          ',',
        ),
      );
    }
  }

  const { data, error } = await request;

  if (error !== null) {
    logger.warn('Could not read the payment register.', { code: error.code });
    return { payments: [], page, hasMore: false };
  }

  const rows = (data ?? []) as unknown as RawSummary[];
  const hasMore = rows.length > PAYMENTS_PAGE_SIZE;

  return {
    payments: rows.slice(0, PAYMENTS_PAGE_SIZE).map(toSummary),
    page,
    hasMore,
  };
}

/** Every payment against one loan, newest first. */
export async function listLoanPayments(
  loanId: string,
): Promise<readonly PaymentSummary[]> {
  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase
    .from('loan_payments')
    .select(SUMMARY_COLUMNS)
    .eq('loan_id', loanId)
    .order('received_at', { ascending: false });

  if (error !== null) {
    logger.warn('Could not read a loan"s payments.', { code: error.code });
    return [];
  }

  return ((data ?? []) as unknown as RawSummary[]).map(toSummary);
}

/** Every payment a client has made, across their loans, newest first. */
export async function listClientPayments(
  clientId: string,
): Promise<readonly PaymentSummary[]> {
  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase
    .from('loan_payments')
    .select(SUMMARY_COLUMNS)
    .eq('client_id', clientId)
    .order('received_at', { ascending: false });

  if (error !== null) {
    logger.warn('Could not read a client"s payments.', { code: error.code });
    return [];
  }

  return ((data ?? []) as unknown as RawSummary[]).map(toSummary);
}

export async function getPayment(paymentId: string): Promise<PaymentDetail | null> {
  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase
    .from('loan_payments')
    .select(
      `${SUMMARY_COLUMNS}, outstanding_before, outstanding_after,
       client_name_at_payment, notes, reversed_at, reversal_reason,
       reversed_by_profile:profiles!loan_payments_reversed_by_fkey ( full_name )`,
    )
    .eq('id', paymentId)
    .maybeSingle();

  if (error !== null || data === null) {
    if (error !== null) {
      logger.warn('Could not read a payment.', { code: error.code });
    }
    return null;
  }

  const row = data as unknown as Record<string, unknown>;
  const reverser = relation(row, 'reversed_by_profile');

  return {
    ...toSummary(data as unknown as RawSummary),
    outstandingBefore: toUgx(Number(row.outstanding_before)),
    outstandingAfter: toUgx(Number(row.outstanding_after)),
    clientNameAtPayment: textField(row, 'client_name_at_payment'),
    notes: nullableText(row, 'notes'),
    reversedAt: nullableText(row, 'reversed_at'),
    reversalReason: nullableText(row, 'reversal_reason'),
    reversedByLabel: nullableText(reverser, 'full_name'),
  };
}

/** How one payment was applied, oldest collection first. */
export async function getPaymentAllocations(
  paymentId: string,
): Promise<readonly PaymentAllocationRow[]> {
  const supabase = await createSupabaseServerClient();

  // Phase 7: `!inner` becomes a plain embed, because a penalty allocation has
  // no installment. An inner join would silently drop exactly the rows a
  // penalty receipt needs to show.
  const { data, error } = await supabase
    .from('payment_allocations')
    .select(
      `id, installment_id, penalty_id, allocated_amount, allocated_principal,
       allocated_interest, allocated_penalty,
       loan_installments ( installment_number, due_date ),
       loan_penalties ( effective_date )`,
    )
    .eq('payment_id', paymentId);

  if (error !== null) {
    logger.warn('Could not read payment allocations.', { code: error.code });
    return [];
  }

  const rows = (data ?? []) as unknown as Record<string, unknown>[];

  return (
    rows
      .map((row) => {
        const installment = relation(row, 'loan_installments');
        const penalty = relation(row, 'loan_penalties');
        const penaltyId = nullableText(row, 'penalty_id');
        const kind: ObligationKind = penaltyId === null ? 'installment' : 'penalty';

        return {
          id: textField(row, 'id'),
          kind,
          obligationId: penaltyId ?? textField(row, 'installment_id'),
          installmentNumber:
            kind === 'penalty' ? 0 : Number(installment.installment_number ?? 0),
          // A malformed date throws out of `toBusinessDate`, which on a receipt
          // would fail the whole page over one row. The epoch is visibly wrong
          // instead, which is what a reader needs.
          dueDate: toBusinessDate(
            (kind === 'penalty'
              ? nullableText(penalty, 'effective_date')
              : nullableText(installment, 'due_date')) ?? '1970-01-01',
          ),
          allocatedAmount: toUgx(Number(row.allocated_amount)),
          allocatedPrincipal: toUgx(Number(row.allocated_principal)),
          allocatedInterest: toUgx(Number(row.allocated_interest)),
          allocatedPenalty: toUgx(Number(row.allocated_penalty)),
        };
      })
      // Collections in order, then the penalty, which is how the money was
      // applied and therefore how a receipt should read.
      .sort((left, right) => {
        if (left.kind !== right.kind) return left.kind === 'penalty' ? 1 : -1;
        return left.installmentNumber - right.installmentNumber;
      })
  );
}

/**
 * Each of a loan's collections with what posted payments have covered.
 *
 * Read from `loan_installment_coverage`, so the allocation order and the
 * minimum-payment rule are computed from the same figures `post_payment` uses.
 */
export async function getLoanObligations(
  loanId: string,
): Promise<readonly PaymentObligation[]> {
  const supabase = await createSupabaseServerClient();

  // `loan_obligations` rather than `loan_installment_coverage`: it is the same
  // collections plus any penalty, in the order money is applied to them. The
  // preview and the minimum-payment rule both need the penalty in the list,
  // and reading two sources and merging them in TypeScript is exactly how the
  // two engines would come to disagree.
  const { data, error } = await supabase
    .from('loan_obligations')
    .select(
      `obligation_kind, installment_id, penalty_id, sequence_number, effective_date,
       expected_amount, scheduled_principal, scheduled_interest, scheduled_penalty,
       allocated_amount, allocated_principal, allocated_interest, allocated_penalty`,
    )
    .eq('loan_id', loanId)
    .order('effective_date', { ascending: true })
    .order('obligation_rank', { ascending: true })
    .order('sequence_number', { ascending: true });

  if (error !== null) {
    logger.warn('Could not read loan obligations.', { code: error.code });
    return [];
  }

  return (data ?? []).map((row) => {
    const kind = row.obligation_kind === 'penalty' ? 'penalty' : 'installment';

    return {
      // Exactly one target is set, which the database guarantees; the
      // obligation's identity is whichever it is.
      obligationId: String(kind === 'penalty' ? row.penalty_id : row.installment_id),
      kind,
      sequenceNumber: Number(row.sequence_number),
      effectiveDate: toBusinessDate(String(row.effective_date)),
      expectedAmount: toUgx(Number(row.expected_amount)),
      scheduledPrincipal: toUgx(Number(row.scheduled_principal)),
      scheduledInterest: toUgx(Number(row.scheduled_interest)),
      scheduledPenalty: toUgx(Number(row.scheduled_penalty)),
      allocatedAmount: toUgx(Number(row.allocated_amount)),
      allocatedPrincipal: toUgx(Number(row.allocated_principal)),
      allocatedInterest: toUgx(Number(row.allocated_interest)),
      allocatedPenalty: toUgx(Number(row.allocated_penalty)),
    };
  });
}

/**
 * A loan's financial position, with every reconciliation re-checked.
 *
 * Returns `null` when the loan has no schedule — a draft, a submitted or an
 * approved loan — because there is nothing to owe yet, which is a different
 * thing from owing zero.
 */
export async function getLoanPosition(
  loanId: string,
  today: BusinessDate,
): Promise<LoanPosition | null> {
  const supabase = await createSupabaseServerClient();

  const [balanceResult, obligations] = await Promise.all([
    supabase
      .from('loan_balances')
      .select(
        `loan_id, loan_number, status, contractual_principal, contractual_interest,
         total_expected_repayment, scheduled_total, total_paid, principal_paid,
         interest_paid, contractual_outstanding, principal_remaining,
         interest_remaining, penalty_assessed, penalty_paid, penalty_remaining,
         total_outstanding, total_collected, fully_repaid, posted_payment_total,
         posted_payment_count, reversed_payment_count, last_payment_at`,
      )
      .eq('loan_id', loanId)
      .maybeSingle(),
    getLoanObligations(loanId),
  ]);

  const { data, error } = balanceResult;

  if (error !== null || data === null) {
    if (error !== null) {
      logger.warn('Could not read a loan balance.', { code: error.code });
    }
    return null;
  }

  // No schedule means the loan has not been disbursed. Reporting a zero
  // balance would read as "fully repaid".
  if (Number(data.scheduled_total) === 0) return null;

  const balance: LoanBalance = {
    contractualPrincipal: toUgx(Number(data.contractual_principal)),
    contractualInterest: toUgx(Number(data.contractual_interest)),
    totalExpectedRepayment: toUgx(Number(data.scheduled_total)),
    totalPaid: toUgx(Number(data.total_paid)),
    contractualOutstanding: toUgx(Number(data.contractual_outstanding)),
    principalPaid: toUgx(Number(data.principal_paid)),
    principalRemaining: toUgx(Number(data.principal_remaining)),
    interestPaid: toUgx(Number(data.interest_paid)),
    interestRemaining: toUgx(Number(data.interest_remaining)),
    penaltyAssessed: toUgx(Number(data.penalty_assessed)),
    penaltyPaid: toUgx(Number(data.penalty_paid)),
    penaltyRemaining: toUgx(Number(data.penalty_remaining)),
    totalOutstanding: toUgx(Number(data.total_outstanding)),
    totalCollected: toUgx(Number(data.total_collected)),
    fullyRepaid: Boolean(data.fully_repaid),
  };

  // Re-checked at the point of reading, on the same reasoning the loan detail
  // page re-checks a stored breakdown: a ledger that does not reconcile must
  // announce itself rather than render as a plausible figure.
  let reconciliationProblem: string | null = null;

  try {
    assertBalanceInvariants(balance, {
      storedTotalExpectedRepayment: Number(data.total_expected_repayment),
      postedPaymentTotal: Number(data.posted_payment_total),
    });
  } catch (problem) {
    reconciliationProblem =
      problem instanceof Error ? problem.message : 'The ledger does not reconcile.';
    logger.error('A loan balance failed reconciliation.', {
      loanId,
      problem: reconciliationProblem,
    });
  }

  return {
    ...balance,
    loanId: String(data.loan_id),
    loanNumber: String(data.loan_number),
    status: String(data.status),
    postedPaymentTotal: toUgx(Number(data.posted_payment_total)),
    postedPaymentCount: Number(data.posted_payment_count),
    reversedPaymentCount: Number(data.reversed_payment_count),
    lastPaymentAt: data.last_payment_at === null ? null : String(data.last_payment_at),
    unpaidScheduledDue: unpaidScheduledDue(obligations, today),
    minimumPayment: minimumAcceptablePayment(obligations),
    reconciles: reconciliationProblem === null,
    reconciliationProblem,
  };
}

/** Posted collections for one business day, by method. */
export interface CollectionTotal {
  readonly paymentMethod: PaymentMethod;
  readonly paymentCount: number;
  readonly totalAmount: UgxAmount;
}

/**
 * What was collected on a given business day, by method.
 *
 * Posted payments only, so a reversal removes its payment from the day's
 * figure. Deliberately not compared against what was due: naming a gap
 * between the two is arrears interpretation, and Phase 7 owns it.
 */
export async function getCollectionTotals(
  businessDate: BusinessDate,
): Promise<readonly CollectionTotal[]> {
  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase
    .from('payment_collection_totals')
    .select('payment_method, payment_count, total_amount')
    .eq('collection_date', businessDate);

  if (error !== null) {
    logger.warn('Could not read collection totals.', { code: error.code });
    return [];
  }

  return (data ?? [])
    .map((row) => {
      const method = row.payment_method;
      return {
        paymentMethod: isPaymentMethod(method) ? method : 'cash',
        paymentCount: Number(row.payment_count),
        totalAmount: toUgx(Number(row.total_amount)),
      };
    })
    .sort((left, right) => left.paymentMethod.localeCompare(right.paymentMethod));
}
