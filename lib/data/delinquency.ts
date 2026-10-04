import 'server-only';

import { createSupabaseServerClient } from '@/lib/supabase/server';
import { logger } from '@/lib/logger';
import { toBusinessDate, type BusinessDate } from '@/lib/domain/datetime';
import { toUgx, type UgxAmount } from '@/lib/domain/money';
import {
  assertDelinquencyInvariants,
  isDelinquencyState,
  type DelinquencyPosition,
  type DelinquencyState,
} from '@/lib/domain/delinquency';

/**
 * Reading delinquency.
 *
 * ## Why these read a view and do not recompute
 *
 * `loan_delinquency` is authoritative. It computes arrears, due-today,
 * lateness, grace and penalty eligibility from the immutable schedule, the
 * allocations of posted payments and the business date — inside the database,
 * under the reader's own Row Level Security policies.
 *
 * The TypeScript engine in `lib/domain/delinquency.ts` exists for previews and
 * for tests, and a parity test reconciles the two. What it must not become is
 * a second opinion that a screen quietly prefers: a borrower told they are
 * four days late by one page and six by another has no reason to believe
 * either. So the screens read this module, and this module reads the view.
 *
 * ## The invariants are re-checked here
 *
 * Every position is passed through `assertDelinquencyInvariants` as it is
 * read, on the same reasoning Phase 6 re-checks balances: a figure that cannot
 * be true must announce itself at the point of reading rather than render as a
 * plausible number somebody acts on.
 */

export interface LoanDelinquency extends DelinquencyPosition {
  readonly loanId: string;
  readonly loanNumber: string;
  readonly clientId: string;
  readonly loanStatus: string;
  readonly installmentCount: number;
  readonly firstDueDate: BusinessDate;
  readonly scheduledTotal: UgxAmount;
  readonly scheduledDueToDate: UgxAmount;
  readonly paidAgainstSchedule: UgxAmount;
  readonly penaltyRateBps: number;
  readonly penaltyBasisAsOfGraceEnd: UgxAmount;
  readonly penaltyId: string | null;
  readonly penaltyBasisAmount: UgxAmount | null;
  readonly penaltyAppliedEffectiveDate: BusinessDate | null;
  /** Did every derived figure hold together when it was read? */
  readonly reconciles: boolean;
  readonly reconciliationProblem: string | null;
}

export interface DelinquentLoanRow extends LoanDelinquency {
  readonly clientName: string;
  readonly clientNumber: string;
  readonly clientPhone: string;
}

const DELINQUENCY_COLUMNS = `
  loan_id, loan_number, client_id, loan_status, business_date, installment_count,
  first_due_date, scheduled_completion_date, scheduled_total, scheduled_due_to_date,
  paid_against_schedule, arrears_amount, due_today_amount, current_due,
  missed_installment_count, oldest_unpaid_due_date, oldest_past_due_date,
  days_past_due, grace_period_days, grace_end_date, penalty_effective_date,
  past_final_due_date, within_grace_period, contractual_outstanding, penalty_amount,
  penalty_paid, penalty_remaining, total_outstanding, penalty_applied, penalty_id,
  penalty_applied_effective_date, penalty_basis_amount, penalty_rate_bps,
  penalty_basis_as_of_grace_end, penalty_eligible, penalty_projected_amount,
  delinquency_state
`;

type RawDelinquency = Readonly<Record<string, unknown>>;

/**
 * A database value as text.
 *
 * Every column this module reads comes back as a string or a number, because
 * the view casts its money and its dates. Anything else is a mistake in the
 * query rather than a value to coerce, so it reads as empty instead of as
 * `[object Object]`.
 */
function text(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  if (typeof value === 'boolean') return String(value);
  return '';
}

function nullableDate(value: unknown): BusinessDate | null {
  return value === null || value === undefined ? null : toBusinessDate(text(value));
}

function state(value: unknown): DelinquencyState {
  // A state the application does not know is a bug in one of the two
  // definitions, so it is logged and read as the safest non-claim rather than
  // asserted into the type.
  if (isDelinquencyState(value)) return value;

  logger.error('A loan reported an unknown delinquency state.', { state: text(value) });
  return 'current';
}

function toPosition(row: RawDelinquency): LoanDelinquency {
  const position: LoanDelinquency = {
    loanId: text(row.loan_id),
    loanNumber: text(row.loan_number),
    clientId: text(row.client_id),
    loanStatus: text(row.loan_status),

    businessDate: toBusinessDate(text(row.business_date)),
    installmentCount: Number(row.installment_count),
    firstDueDate: toBusinessDate(text(row.first_due_date)),
    scheduledCompletionDate: nullableDate(row.scheduled_completion_date),
    scheduledTotal: toUgx(Number(row.scheduled_total)),
    scheduledDueToDate: toUgx(Number(row.scheduled_due_to_date)),
    paidAgainstSchedule: toUgx(Number(row.paid_against_schedule)),

    arrearsAmount: toUgx(Number(row.arrears_amount)),
    dueToday: toUgx(Number(row.due_today_amount)),
    currentDue: toUgx(Number(row.current_due)),
    missedInstallmentCount: Number(row.missed_installment_count),
    oldestUnpaidDueDate: nullableDate(row.oldest_unpaid_due_date),
    oldestPastDueDate: nullableDate(row.oldest_past_due_date),
    daysPastDue: Number(row.days_past_due),

    graceDays: Number(row.grace_period_days),
    graceEndDate: nullableDate(row.grace_end_date),
    penaltyEffectiveDate: nullableDate(row.penalty_effective_date),
    pastFinalDueDate: Boolean(row.past_final_due_date),
    withinGracePeriod: Boolean(row.within_grace_period),

    contractualOutstanding: toUgx(Number(row.contractual_outstanding)),
    penaltyAmount: toUgx(Number(row.penalty_amount)),
    penaltyPaid: toUgx(Number(row.penalty_paid)),
    penaltyRemaining: toUgx(Number(row.penalty_remaining)),
    totalOutstanding: toUgx(Number(row.total_outstanding)),

    penaltyApplied: Boolean(row.penalty_applied),
    penaltyEligible: Boolean(row.penalty_eligible),
    penaltyProjectedAmount: toUgx(Number(row.penalty_projected_amount)),
    penaltyId: row.penalty_id === null ? null : text(row.penalty_id),
    penaltyBasisAmount:
      row.penalty_basis_amount === null ? null : toUgx(Number(row.penalty_basis_amount)),
    penaltyAppliedEffectiveDate: nullableDate(row.penalty_applied_effective_date),
    penaltyRateBps: Number(row.penalty_rate_bps),
    penaltyBasisAsOfGraceEnd: toUgx(Number(row.penalty_basis_as_of_grace_end)),

    state: state(row.delinquency_state),

    reconciles: true,
    reconciliationProblem: null,
  };

  let problem: string | null = null;

  try {
    assertDelinquencyInvariants(position);
  } catch (error) {
    problem = error instanceof Error ? error.message : 'The position does not hold.';
    logger.error('A delinquency position failed its invariants.', {
      loanId: position.loanId,
      problem,
    });
  }

  return { ...position, reconciles: problem === null, reconciliationProblem: problem };
}

/** One loan's delinquency position, or `null` when it has no schedule. */
export async function getLoanDelinquency(
  loanId: string,
): Promise<LoanDelinquency | null> {
  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase
    .from('loan_delinquency')
    .select(DELINQUENCY_COLUMNS)
    .eq('loan_id', loanId)
    .maybeSingle();

  if (error !== null) {
    logger.warn('Could not read a loan delinquency position.', { code: error.code });
    return null;
  }

  // A loan with no schedule is absent from the view, which is the honest
  // answer: a draft owes nothing because nothing has been paid out, which is
  // a different thing from being up to date.
  if (data === null) return null;

  return toPosition(data);
}

/**
 * Every delinquency position on one borrower's loans.
 *
 * For the client portal. No capability is involved and none could be:
 * `delinquency:view` means "read the overdue directory" everywhere else, and
 * a borrower reaches their own loans through the ownership clause in the
 * policy on `loans` — the arrangement every phase since Phase 4 has used.
 *
 * Returns every state, settled loans included, because a borrower looking at
 * their own account should see a loan they have finished paying rather than
 * find it missing.
 */
export async function listClientDelinquency(
  clientId: string,
): Promise<readonly LoanDelinquency[]> {
  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase
    .from('loan_delinquency')
    .select(DELINQUENCY_COLUMNS)
    .eq('client_id', clientId)
    .order('scheduled_completion_date', { ascending: false });

  if (error !== null) {
    logger.warn('Could not read a borrower"s delinquency positions.', {
      code: error.code,
    });
    return [];
  }

  return (data ?? []).map((row) => toPosition(row as RawDelinquency));
}

export interface DelinquencyFilters {
  /** Restrict to these operational states. Empty means every state but settled. */
  readonly states?: readonly DelinquencyState[];
  readonly minDaysPastDue?: number;
  readonly query?: string;
  readonly page?: number;
  readonly pageSize?: number;
}

export interface DelinquentLoanPage {
  readonly loans: readonly DelinquentLoanRow[];
  readonly page: number;
  readonly hasMore: boolean;
}

/**
 * The overdue list.
 *
 * Settled loans are excluded unless explicitly asked for: an overdue list that
 * showed cleared loans would be unusable, and a collection officer acting on
 * one would be chasing somebody who has already paid.
 *
 * The client's name and phone come from a second query rather than an embedded
 * join, because a view carries no foreign keys for PostgREST to embed through.
 * Both queries run under the caller's own policies.
 */
export async function listDelinquentLoans(
  filters: DelinquencyFilters = {},
): Promise<DelinquentLoanPage> {
  const supabase = await createSupabaseServerClient();

  const page = Math.max(1, filters.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, filters.pageSize ?? 25));
  const from = (page - 1) * pageSize;

  let request = supabase
    .from('loan_delinquency')
    .select(DELINQUENCY_COLUMNS)
    // Most pressing first: the longest overdue, then the largest arrears.
    .order('days_past_due', { ascending: false })
    .order('total_outstanding', { ascending: false })
    .range(from, from + pageSize);

  const states =
    filters.states !== undefined && filters.states.length > 0
      ? filters.states
      : (['penalty_due', 'expired_unpaid', 'grace_period', 'in_arrears'] as const);

  request = request.in('delinquency_state', [...states]);

  if (filters.minDaysPastDue !== undefined && filters.minDaysPastDue > 0) {
    request = request.gte('days_past_due', filters.minDaysPastDue);
  }

  if (filters.query !== undefined && filters.query.trim() !== '') {
    request = request.ilike('loan_number', `%${filters.query.trim()}%`);
  }

  const { data, error } = await request;

  if (error !== null) {
    logger.warn('Could not read the overdue list.', { code: error.code });
    return { loans: [], page, hasMore: false };
  }

  const rows = (data ?? []).map((row) => toPosition(row as RawDelinquency));
  const hasMore = rows.length > pageSize;
  const visible = hasMore ? rows.slice(0, pageSize) : rows;

  if (visible.length === 0) return { loans: [], page, hasMore: false };

  const { data: clients, error: clientError } = await supabase
    .from('clients')
    .select('id, full_name, client_number, phone')
    .in('id', [...new Set(visible.map((row) => row.clientId))]);

  if (clientError !== null) {
    logger.warn('Could not read borrowers for the overdue list.', {
      code: clientError.code,
    });
  }

  const byId = new Map(
    (clients ?? []).map((client) => [
      text(client.id),
      {
        name: text(client.full_name),
        number: text(client.client_number),
        phone: text(client.phone),
      },
    ]),
  );

  return {
    loans: visible.map((row) => {
      const client = byId.get(row.clientId);

      return {
        ...row,
        clientName: client?.name ?? 'Unknown borrower',
        clientNumber: client?.number ?? '',
        clientPhone: client?.phone ?? '',
      };
    }),
    page,
    hasMore,
  };
}

/** Counts by operational state, for the overdue page's own summary. */
export async function countByDelinquencyState(): Promise<
  Readonly<Record<DelinquencyState, number>>
> {
  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase
    .from('loan_delinquency')
    .select('delinquency_state');

  const counts: Record<DelinquencyState, number> = {
    current: 0,
    due_today: 0,
    in_arrears: 0,
    grace_period: 0,
    expired_unpaid: 0,
    penalty_due: 0,
    cleared: 0,
  };

  if (error !== null) {
    logger.warn('Could not count delinquency states.', { code: error.code });
    return counts;
  }

  for (const row of data ?? []) {
    const key = state(row.delinquency_state);
    counts[key] += 1;
  }

  return counts;
}

export interface LoanPenalty {
  readonly penaltyId: string;
  readonly loanId: string;
  readonly penaltyType: string;
  readonly finalDueDate: BusinessDate;
  readonly graceDays: number;
  readonly graceEndDate: BusinessDate;
  readonly effectiveDate: BusinessDate;
  readonly basisAmount: UgxAmount;
  readonly penaltyRateBps: number;
  readonly penaltyAmount: UgxAmount;
  readonly allocatedAmount: UgxAmount;
  readonly remainingAmount: UgxAmount;
  readonly triggerRule: string;
  readonly appliedAt: string;
}

/** A loan's penalty with its coverage, or `null` when it has none. */
export async function getLoanPenalty(loanId: string): Promise<LoanPenalty | null> {
  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase
    .from('loan_penalty_coverage')
    .select(
      `penalty_id, loan_id, penalty_type, final_due_date, grace_period_days,
       grace_end_date, effective_date, basis_amount, penalty_rate_bps,
       penalty_amount, allocated_amount, remaining_amount, trigger_rule, applied_at`,
    )
    .eq('loan_id', loanId)
    .maybeSingle();

  if (error !== null) {
    logger.warn('Could not read a loan penalty.', { code: error.code });
    return null;
  }

  if (data === null) return null;

  return {
    penaltyId: text(data.penalty_id),
    loanId: text(data.loan_id),
    penaltyType: text(data.penalty_type),
    finalDueDate: toBusinessDate(text(data.final_due_date)),
    graceDays: Number(data.grace_period_days),
    graceEndDate: toBusinessDate(text(data.grace_end_date)),
    effectiveDate: toBusinessDate(text(data.effective_date)),
    basisAmount: toUgx(Number(data.basis_amount)),
    penaltyRateBps: Number(data.penalty_rate_bps),
    penaltyAmount: toUgx(Number(data.penalty_amount)),
    allocatedAmount: toUgx(Number(data.allocated_amount)),
    remainingAmount: toUgx(Number(data.remaining_amount)),
    triggerRule: text(data.trigger_rule),
    appliedAt: text(data.applied_at),
  };
}
