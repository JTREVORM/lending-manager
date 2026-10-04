import { getClient, query, queryOne } from './db';
import type { TestUser } from './auth-fixtures';

/**
 * Delinquency and penalty fixtures.
 *
 * ## The business clock
 *
 * Phase 7's rules are all comparisons against a date, and a loan disbursed
 * today cannot reach its final collection date, let alone its grace deadline.
 * So these helpers set `app.business_now`, which `public.business_now()`
 * honours **only** when `session_user` owns the tables — a direct connection,
 * which these tests have and no application path does.
 *
 * `set local role authenticated` does not change `session_user`, which is what
 * lets a test act as a real application role at a chosen instant.
 *
 * One clock, not two: the same override fixes the business date, a payment's
 * `received_at` and a penalty's `applied_at`, so a test cannot place a payment
 * on a different day from the one it is reasoning about. The threat profile is
 * the documented owner-level caveat in docs/SECURITY.md — somebody who can
 * connect as the table owner can do anything to the data, and no in-database
 * design changes that.
 *
 * ## Why penalties are materialised through the function
 *
 * `ensure_penalty_applied` is the only writer of `loan_penalties`, and no
 * session role may call it. These helpers call it as the owner, which is both
 * the only way and an honest reflection of how it is reached in production:
 * from inside `post_payment`, which runs as the table owner.
 */

/** An instant in the business timezone, as the override expects it. */
export function businessInstant(date: string, time = '10:00:00'): string {
  return `${date} ${time}+03`;
}

/**
 * Run queries as the table owner at a chosen business instant.
 *
 * Committed, because the effects of a materialised penalty have to be visible
 * to the next read.
 */
export async function atClock<T>(
  businessNow: string | undefined,
  run: (
    exec: (
      sql: string,
      params?: readonly unknown[],
    ) => Promise<Record<string, unknown>[]>,
  ) => Promise<T>,
): Promise<T> {
  const client = await getClient();

  try {
    await client.query('begin');

    if (businessNow !== undefined) {
      await client.query(`select set_config('app.business_now', $1, true)`, [
        businessNow,
      ]);
    }

    const result = await run(async (sql, params = []) => {
      const rows = await client.query(sql, [...params]);
      return rows.rows as Record<string, unknown>[];
    });

    await client.query('commit');
    return result;
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** Run queries as a signed-in user at a chosen business instant. */
export async function atClockAsUser<T>(
  user: Pick<TestUser, 'authUserId'>,
  businessNow: string | undefined,
  run: (
    exec: (
      sql: string,
      params?: readonly unknown[],
    ) => Promise<Record<string, unknown>[]>,
  ) => Promise<T>,
): Promise<T> {
  const client = await getClient();

  try {
    await client.query('begin');

    if (businessNow !== undefined) {
      await client.query(`select set_config('app.business_now', $1, true)`, [
        businessNow,
      ]);
    }

    await client.query(`select set_config('request.jwt.claim.sub', $1, true)`, [
      user.authUserId,
    ]);
    await client.query('set local role authenticated');

    const result = await run(async (sql, params = []) => {
      const rows = await client.query(sql, [...params]);
      return rows.rows as Record<string, unknown>[];
    });

    await client.query('reset role');
    await client.query('commit');
    return result;
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** The business date the database reports at a chosen instant. */
export async function readBusinessDate(businessNow?: string): Promise<string> {
  return atClock(businessNow, async (exec) => {
    const rows = await exec(`select public.business_date()::text as today`);
    return String(rows[0]?.today);
  });
}

export interface DelinquencyRow {
  readonly loanNumber: string;
  readonly loanStatus: string;
  readonly businessDate: string;
  readonly scheduledCompletionDate: string;
  readonly firstDueDate: string;
  readonly installmentCount: number;
  readonly scheduledTotal: number;
  readonly scheduledDueToDate: number;
  readonly paidAgainstSchedule: number;
  readonly arrearsAmount: number;
  readonly dueTodayAmount: number;
  readonly currentDue: number;
  readonly missedInstallmentCount: number;
  readonly oldestUnpaidDueDate: string | null;
  readonly oldestPastDueDate: string | null;
  readonly daysPastDue: number;
  readonly graceDays: number;
  readonly graceEndDate: string;
  readonly penaltyEffectiveDate: string;
  readonly pastFinalDueDate: boolean;
  readonly withinGracePeriod: boolean;
  readonly contractualOutstanding: number;
  readonly penaltyAmount: number;
  readonly penaltyPaid: number;
  readonly penaltyRemaining: number;
  readonly totalOutstanding: number;
  readonly penaltyApplied: boolean;
  readonly penaltyEligible: boolean;
  readonly penaltyProjectedAmount: number;
  readonly penaltyBasisAsOfGraceEnd: number;
  readonly penaltyRateBps: number;
  readonly state: string;
}

/** One loan's derived delinquency position, as at a chosen instant. */
export async function readDelinquency(
  loanId: string,
  businessNow?: string,
): Promise<DelinquencyRow> {
  return atClock(businessNow, async (exec) => {
    const rows = await exec(
      `select loan_number, loan_status, business_date::text as business_date,
              scheduled_completion_date::text as completion,
              first_due_date::text as first_due,
              installment_count::text as installment_count,
              scheduled_total::text as scheduled_total,
              scheduled_due_to_date::text as due_to_date,
              paid_against_schedule::text as paid_to_date,
              arrears_amount::text as arrears,
              due_today_amount::text as due_today,
              current_due::text as current_due,
              missed_installment_count::text as missed,
              oldest_unpaid_due_date::text as oldest_unpaid,
              oldest_past_due_date::text as oldest_past_due,
              days_past_due::text as days_past_due,
              grace_period_days::text as grace_days,
              grace_end_date::text as grace_end,
              penalty_effective_date::text as penalty_effective,
              past_final_due_date::text as past_final,
              within_grace_period::text as within_grace,
              contractual_outstanding::text as contractual,
              penalty_amount::text as penalty_amount,
              penalty_paid::text as penalty_paid,
              penalty_remaining::text as penalty_remaining,
              total_outstanding::text as total_outstanding,
              penalty_applied::text as penalty_applied,
              penalty_eligible::text as penalty_eligible,
              penalty_projected_amount::text as projected,
              penalty_basis_as_of_grace_end::text as basis,
              penalty_rate_bps::text as rate,
              delinquency_state
         from public.loan_delinquency where loan_id = $1`,
      [loanId],
    );

    const row = rows[0];

    if (row === undefined) {
      throw new Error(`No delinquency row for loan ${loanId}.`);
    }

    // The view casts every column to text, so anything that is not a string
    // is a mistake in the query rather than a value to coerce.
    const text = (key: string): string => {
      const value = row[key];
      return typeof value === 'string' ? value : '';
    };
    const nullable = (key: string): string | null => {
      const value = row[key];
      return typeof value === 'string' ? value : null;
    };

    return {
      loanNumber: text('loan_number'),
      loanStatus: text('loan_status'),
      businessDate: text('business_date'),
      scheduledCompletionDate: text('completion'),
      firstDueDate: text('first_due'),
      installmentCount: Number(row.installment_count),
      scheduledTotal: Number(row.scheduled_total),
      scheduledDueToDate: Number(row.due_to_date),
      paidAgainstSchedule: Number(row.paid_to_date),
      arrearsAmount: Number(row.arrears),
      dueTodayAmount: Number(row.due_today),
      currentDue: Number(row.current_due),
      missedInstallmentCount: Number(row.missed),
      oldestUnpaidDueDate: nullable('oldest_unpaid'),
      oldestPastDueDate: nullable('oldest_past_due'),
      daysPastDue: Number(row.days_past_due),
      graceDays: Number(row.grace_days),
      graceEndDate: text('grace_end'),
      penaltyEffectiveDate: text('penalty_effective'),
      pastFinalDueDate: text('past_final') === 'true',
      withinGracePeriod: text('within_grace') === 'true',
      contractualOutstanding: Number(row.contractual),
      penaltyAmount: Number(row.penalty_amount),
      penaltyPaid: Number(row.penalty_paid),
      penaltyRemaining: Number(row.penalty_remaining),
      totalOutstanding: Number(row.total_outstanding),
      penaltyApplied: text('penalty_applied') === 'true',
      penaltyEligible: text('penalty_eligible') === 'true',
      penaltyProjectedAmount: Number(row.projected),
      penaltyBasisAsOfGraceEnd: Number(row.basis),
      penaltyRateBps: Number(row.rate),
      state: text('delinquency_state'),
    };
  });
}

export interface PenaltyRow {
  readonly penaltyId: string;
  readonly penaltyType: string;
  readonly finalDueDate: string;
  readonly graceDays: number;
  readonly graceEndDate: string;
  readonly effectiveDate: string;
  readonly basisAmount: number;
  readonly penaltyRateBps: number;
  readonly penaltyAmount: number;
  readonly allocatedAmount: number;
  readonly remainingAmount: number;
  readonly triggerRule: string;
}

/** A loan's penalty with its coverage, or `null`. */
export async function readPenalty(loanId: string): Promise<PenaltyRow | null> {
  const rows = await query<Record<string, string>>(
    `select penalty_id, penalty_type, final_due_date::text as final_due,
            grace_period_days::text as grace_days, grace_end_date::text as grace_end,
            effective_date::text as effective, basis_amount::text as basis,
            penalty_rate_bps::text as rate, penalty_amount::text as amount,
            allocated_amount::text as allocated, remaining_amount::text as remaining,
            trigger_rule
       from public.loan_penalty_coverage where loan_id = $1`,
    [loanId],
  );

  const row = rows[0];
  if (row === undefined) return null;

  return {
    penaltyId: String(row.penalty_id),
    penaltyType: String(row.penalty_type),
    finalDueDate: String(row.final_due),
    graceDays: Number(row.grace_days),
    graceEndDate: String(row.grace_end),
    effectiveDate: String(row.effective),
    basisAmount: Number(row.basis),
    penaltyRateBps: Number(row.rate),
    penaltyAmount: Number(row.amount),
    allocatedAmount: Number(row.allocated),
    remainingAmount: Number(row.remaining),
    triggerRule: String(row.trigger_rule),
  };
}

/** Materialise a loan's penalty if it is eligible, as the owner would. */
export async function ensurePenalty(
  loanId: string,
  businessNow?: string,
): Promise<string | null> {
  return atClock(businessNow, async (exec) => {
    const rows = await exec(`select public.ensure_penalty_applied($1) as id`, [loanId]);
    const id = rows[0]?.id;
    return typeof id === 'string' ? id : null;
  });
}

export interface PenaltyOutcome {
  readonly ok: boolean;
  readonly penaltyId: string | null;
  readonly message: string;
}

/** Materialise a penalty, reporting a refusal rather than throwing. */
export async function tryEnsurePenalty(
  loanId: string,
  businessNow?: string,
): Promise<PenaltyOutcome> {
  try {
    const penaltyId = await ensurePenalty(loanId, businessNow);
    return { ok: true, penaltyId, message: '' };
  } catch (error) {
    return {
      ok: false,
      penaltyId: null,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

/** The optional sweep, as a scheduled job would run it. */
export async function applyEligiblePenalties(businessNow?: string): Promise<number> {
  return atClock(businessNow, async (exec) => {
    const rows = await exec(`select public.apply_eligible_penalties() as applied`);
    return Number(rows[0]?.applied ?? 0);
  });
}

export interface ObligationRow {
  readonly kind: string;
  readonly sequenceNumber: number;
  readonly effectiveDate: string;
  readonly expectedAmount: number;
  readonly scheduledPrincipal: number;
  readonly scheduledInterest: number;
  readonly scheduledPenalty: number;
  readonly allocatedAmount: number;
  readonly allocatedPrincipal: number;
  readonly allocatedInterest: number;
  readonly allocatedPenalty: number;
  readonly remainingAmount: number;
}

/** Every obligation on a loan, in allocation order. */
export async function readObligations(loanId: string): Promise<readonly ObligationRow[]> {
  const rows = await query<Record<string, string>>(
    `select obligation_kind, sequence_number::text as n, effective_date::text as due,
            expected_amount::text as expected,
            scheduled_principal::text as sched_principal,
            scheduled_interest::text as sched_interest,
            scheduled_penalty::text as sched_penalty,
            allocated_amount::text as alloc,
            allocated_principal::text as alloc_principal,
            allocated_interest::text as alloc_interest,
            allocated_penalty::text as alloc_penalty,
            remaining_amount::text as remaining
       from public.loan_obligations
      where loan_id = $1
      order by effective_date, obligation_rank, sequence_number`,
    [loanId],
  );

  return rows.map((row) => ({
    kind: String(row.obligation_kind),
    sequenceNumber: Number(row.n),
    effectiveDate: String(row.due),
    expectedAmount: Number(row.expected),
    scheduledPrincipal: Number(row.sched_principal),
    scheduledInterest: Number(row.sched_interest),
    scheduledPenalty: Number(row.sched_penalty),
    allocatedAmount: Number(row.alloc),
    allocatedPrincipal: Number(row.alloc_principal),
    allocatedInterest: Number(row.alloc_interest),
    allocatedPenalty: Number(row.alloc_penalty),
    remainingAmount: Number(row.remaining),
  }));
}

/** The final collection date, the grace deadline and the penalty date. */
export async function readLoanDates(loanId: string): Promise<{
  readonly firstDue: string;
  readonly finalDue: string;
  readonly graceEnd: string;
  readonly penaltyEffective: string;
  readonly graceDays: number;
  readonly scheduledTotal: number;
}> {
  const row = await queryOne<Record<string, string>>(
    `select min(li.due_date)::text as first_due,
            max(li.due_date)::text as final_due,
            (max(li.due_date) + l.grace_period_days_applied::integer)::text as grace_end,
            (max(li.due_date) + l.grace_period_days_applied::integer + 1)::text
              as penalty_effective,
            l.grace_period_days_applied::text as grace_days,
            pg_catalog.sum(li.expected_amount)::text as scheduled_total
       from public.loan_installments li
       join public.loans l on l.id = li.loan_id
      where li.loan_id = $1
      group by l.grace_period_days_applied`,
    [loanId],
  );

  return {
    firstDue: String(row.first_due),
    finalDue: String(row.final_due),
    graceEnd: String(row.grace_end),
    penaltyEffective: String(row.penalty_effective),
    graceDays: Number(row.grace_days),
    scheduledTotal: Number(row.scheduled_total),
  };
}

/** Shift a business date by whole days, using the database's own arithmetic. */
export async function shiftDate(date: string, days: number): Promise<string> {
  const row = await queryOne<{ shifted: string }>(
    `select ($1::date + $2::integer)::text as shifted`,
    [date, days],
  );
  return row.shifted;
}

/**
 * Set the lending terms a loan will be approved under.
 *
 * `approve_loan` snapshots the business settings onto the loan, so these have
 * to be in place **before** approval. Setting them afterwards changes nothing
 * about an existing loan, which is the ADR-023 guarantee and something the
 * tests assert in its own right.
 */
export async function configureLendingTerms(
  options: {
    readonly monthlyRateBps?: number;
    readonly minLoanAmount?: number;
    readonly graceDays?: number;
    readonly penaltyRateBps?: number;
  } = {},
): Promise<void> {
  await query(
    `update public.business_settings
        set default_monthly_interest_rate_bps = $1,
            min_loan_amount = $2,
            grace_period_days = $3,
            penalty_rate_bps = $4`,
    [
      options.monthlyRateBps ?? 2_500,
      options.minLoanAmount ?? 10_000,
      options.graceDays ?? 3,
      options.penaltyRateBps ?? 5_000,
    ],
  );
}

/**
 * The lending terms the business seeded, restored.
 *
 * Called after a suite that changed them, so a later suite reading
 * `business_settings` sees what migration `…0800` installed rather than
 * whatever the last test needed.
 */
export async function restoreSeededLendingTerms(): Promise<void> {
  await query(
    `update public.business_settings
        set default_monthly_interest_rate_bps = 1500,
            min_loan_amount = 100000,
            grace_period_days = 3,
            penalty_rate_bps = 5000`,
  );
}

/**
 * A loan whose collections are each exactly UGX 4,000.
 *
 * The specification's examples are written in UGX 4,000 collections, and
 * getting them requires both the principal **and** the interest to divide
 * evenly across the collections — the schedule divides them separately, so a
 * total that divides evenly is not enough.
 *
 *     principal = 3,200N   interest = 800N   (a monthly rate of 2,500 bps)
 *
 * gives every collection 3,200 + 800 = 4,000 and a contractual total of
 * 4,000N. N is the number of daily collections in a one-month window, which
 * depends on the month this runs in, so the caller asks for the shape and the
 * helper reports what it got.
 */
export interface FourThousandLoan {
  readonly loanId: string;
  readonly installments: number;
  readonly scheduledTotal: number;
  readonly firstDue: string;
  readonly finalDue: string;
  readonly graceEnd: string;
  readonly penaltyEffective: string;
}

/**
 * How many daily collections a one-month loan disbursed today has.
 *
 * Measured once, from a real loan generated by the real generator, rather than
 * recomputed here: a second implementation of the window rule would be a
 * second thing to get wrong. Memoised, because it depends only on today's
 * date and because the one-active-loan rule means a probe needs its own
 * borrower.
 */
let dailyInstallmentCount: number | undefined;

export async function dailyInstallmentsInOneMonth(): Promise<number> {
  if (dailyInstallmentCount !== undefined) return dailyInstallmentCount;

  const { createDraftLoan, createLoanScenario, disburseLoan } =
    await import('./loan-fixtures');

  await configureLendingTerms({ monthlyRateBps: 2_500, minLoanAmount: 10_000 });

  const probeScenario = await createLoanScenario();
  const probeId = await createDraftLoan(probeScenario.clientId, {
    principal: 100_000,
    termMonths: 1,
    frequency: 'daily',
  });
  await disburseLoan(probeId, probeScenario);

  const probe = await queryOne<{ n: string }>(
    `select pg_catalog.count(*)::text as n from public.loan_installments
      where loan_id = $1`,
    [probeId],
  );

  dailyInstallmentCount = Number(probe.n);
  return dailyInstallmentCount;
}

export async function createFourThousandLoan(
  scenario: {
    readonly clientId: string;
    readonly secretary: Pick<TestUser, 'authUserId'>;
    readonly owner: Pick<TestUser, 'authUserId'>;
  },
  options: { readonly graceDays?: number; readonly penaltyRateBps?: number } = {},
): Promise<FourThousandLoan> {
  const { createDraftLoan, disburseLoan } = await import('./loan-fixtures');

  const installments = await dailyInstallmentsInOneMonth();

  await configureLendingTerms({
    monthlyRateBps: 2_500,
    minLoanAmount: 10_000,
    graceDays: options.graceDays ?? 3,
    penaltyRateBps: options.penaltyRateBps ?? 5_000,
  });

  const loanId = await createDraftLoan(scenario.clientId, {
    principal: 3_200 * installments,
    termMonths: 1,
    frequency: 'daily',
  });
  await disburseLoan(loanId, scenario);

  const dates = await readLoanDates(loanId);

  if (dates.scheduledTotal !== 4_000 * installments) {
    throw new Error(
      `expected ${String(4_000 * installments)} scheduled, got ${String(dates.scheduledTotal)}`,
    );
  }

  return {
    loanId,
    installments,
    scheduledTotal: dates.scheduledTotal,
    firstDue: dates.firstDue,
    finalDue: dates.finalDue,
    graceEnd: dates.graceEnd,
    penaltyEffective: dates.penaltyEffective,
  };
}

/** Remove every penalty fixture, with the documented owner-level exemption. */
export async function deleteTestPenalties(): Promise<void> {
  await query(
    `alter table public.loan_penalties disable trigger loan_penalties_no_delete`,
  );

  try {
    await query(`delete from public.loan_penalties`);
  } finally {
    await query(
      `alter table public.loan_penalties enable trigger loan_penalties_no_delete`,
    );
  }
}
