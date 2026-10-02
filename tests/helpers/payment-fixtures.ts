import { randomUUID } from 'node:crypto';

import { getClient, query, queryOne } from './db';
import type { TestUser } from './auth-fixtures';

/**
 * Payment fixtures.
 *
 * ## Why these impersonate a real user
 *
 * `post_payment` derives its actor from `public.current_profile_id()` and
 * refuses when there is none, and `loan_payments.recorded_by` is NOT NULL. As
 * the table owner there is no session, so every posting is refused.
 *
 * That is the schema working as intended rather than an obstacle. **There is
 * no such thing as a system-recorded payment**: money arrives at a counter and
 * a person writes it down, and a financial record that cannot name who
 * received the money is not worth keeping. The same reasoning ADR-025 applied
 * to approvals.
 *
 * So these helpers sign in as a real user, which also makes them a more honest
 * reflection of how the application drives the ledger.
 */

export interface PostPaymentOptions {
  readonly amount: number;
  readonly method?: 'cash' | 'mtn_mobile_money' | 'airtel_money';
  readonly externalReference?: string | null;
  /** Reuse a key to exercise the idempotent replay path. */
  readonly idempotencyKey?: string;
  readonly notes?: string | null;
}

export interface PaymentOutcome {
  readonly ok: boolean;
  readonly paymentId: string | null;
  readonly message: string;
}

/**
 * Run statements as a real signed-in user, committed, on their own connection.
 *
 * Committed rather than rolled back because a payment's effects have to be
 * visible to the next read — the balance views, the loan status, a following
 * payment's minimum.
 */
async function runAsCommitted<T>(
  user: Pick<TestUser, 'authUserId'>,
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
    await client.query(`select set_config('request.jwt.claim.sub', $1, true)`, [
      user.authUserId,
    ]);
    await client.query('set local role authenticated');

    const result = await run(async (sql, params = []) => {
      const rows = await client.query(sql, [...params]);
      return rows.rows as Record<string, unknown>[];
    });

    // Back to the owner before committing, so the transaction is not left in a
    // restricted role for the pool's next borrower.
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

/** Record a payment, throwing on refusal. */
export async function postPayment(
  loanId: string,
  actor: Pick<TestUser, 'authUserId'>,
  options: PostPaymentOptions,
): Promise<string> {
  return runAsCommitted(actor, async (exec) => {
    const rows = await exec(`select public.post_payment($1, $2, $3, $4, $5, $6) as id`, [
      loanId,
      options.amount,
      options.method ?? 'cash',
      options.externalReference ?? null,
      options.idempotencyKey ?? randomUUID(),
      options.notes ?? null,
    ]);

    return String(rows[0]?.id);
  });
}

/** Record a payment, reporting a refusal rather than throwing. */
export async function tryPostPayment(
  loanId: string,
  actor: Pick<TestUser, 'authUserId'>,
  options: PostPaymentOptions,
): Promise<PaymentOutcome> {
  try {
    const paymentId = await postPayment(loanId, actor, options);
    return { ok: true, paymentId, message: '' };
  } catch (error) {
    return {
      ok: false,
      paymentId: null,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Reverse a payment, throwing on refusal. */
export async function reversePayment(
  paymentId: string,
  actor: Pick<TestUser, 'authUserId'>,
  reason = 'recorded in error during testing',
): Promise<void> {
  await runAsCommitted(actor, async (exec) => {
    await exec(`select public.reverse_payment($1, $2)`, [paymentId, reason]);
  });
}

/** Reverse a payment, reporting a refusal rather than throwing. */
export async function tryReversePayment(
  paymentId: string,
  actor: Pick<TestUser, 'authUserId'>,
  reason = 'recorded in error during testing',
): Promise<PaymentOutcome> {
  try {
    await reversePayment(paymentId, actor, reason);
    return { ok: true, paymentId, message: '' };
  } catch (error) {
    return {
      ok: false,
      paymentId: null,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

export interface LoanLedger {
  readonly status: string;
  readonly scheduledTotal: number;
  readonly totalPaid: number;
  readonly outstanding: number;
  readonly principalPaid: number;
  readonly principalRemaining: number;
  readonly interestPaid: number;
  readonly interestRemaining: number;
  readonly fullyRepaid: boolean;
  readonly postedPaymentTotal: number;
  readonly postedPaymentCount: number;
  readonly reversedPaymentCount: number;
  readonly clearedAt: string | null;
}

/** The loan's derived position, read from the database's own views. */
export async function readLedger(loanId: string): Promise<LoanLedger> {
  const row = await queryOne<Record<string, string | null>>(
    `select b.status,
            b.scheduled_total::text        as scheduled_total,
            b.total_paid::text             as total_paid,
            b.outstanding::text            as outstanding,
            b.principal_paid::text         as principal_paid,
            b.principal_remaining::text    as principal_remaining,
            b.interest_paid::text          as interest_paid,
            b.interest_remaining::text     as interest_remaining,
            b.fully_repaid::text           as fully_repaid,
            b.posted_payment_total::text   as posted_payment_total,
            b.posted_payment_count::text   as posted_payment_count,
            b.reversed_payment_count::text as reversed_payment_count,
            l.cleared_at::text             as cleared_at
       from public.loan_balances b
       join public.loans l on l.id = b.loan_id
      where b.loan_id = $1`,
    [loanId],
  );

  return {
    status: String(row.status),
    scheduledTotal: Number(row.scheduled_total),
    totalPaid: Number(row.total_paid),
    outstanding: Number(row.outstanding),
    principalPaid: Number(row.principal_paid),
    principalRemaining: Number(row.principal_remaining),
    interestPaid: Number(row.interest_paid),
    interestRemaining: Number(row.interest_remaining),
    fullyRepaid: row.fully_repaid === 'true',
    postedPaymentTotal: Number(row.posted_payment_total),
    postedPaymentCount: Number(row.posted_payment_count),
    reversedPaymentCount: Number(row.reversed_payment_count),
    clearedAt: row.cleared_at ?? null,
  };
}

/** The smallest payment the database will accept against this loan now. */
export async function readMinimum(loanId: string): Promise<number | null> {
  const rows = await query<{ remaining: string }>(
    `select remaining_amount::text as remaining
       from public.loan_installment_coverage
      where loan_id = $1 and remaining_amount > 0
      order by due_date, installment_number
      limit 1`,
    [loanId],
  );

  const first = rows[0];
  return first === undefined ? null : Number(first.remaining);
}

export interface CoverageRow {
  readonly installmentNumber: number;
  readonly dueDate: string;
  readonly expectedAmount: number;
  readonly scheduledPrincipal: number;
  readonly scheduledInterest: number;
  readonly allocatedAmount: number;
  readonly allocatedPrincipal: number;
  readonly allocatedInterest: number;
  readonly remainingAmount: number;
}

/** Each collection and what posted payments have covered. */
export async function readCoverage(loanId: string): Promise<readonly CoverageRow[]> {
  const rows = await query<Record<string, string>>(
    `select installment_number::text      as n,
            due_date::text                as due_date,
            expected_amount::text         as expected,
            scheduled_principal::text     as sched_principal,
            scheduled_interest::text      as sched_interest,
            allocated_amount::text        as alloc,
            allocated_principal::text     as alloc_principal,
            allocated_interest::text      as alloc_interest,
            remaining_amount::text        as remaining
       from public.loan_installment_coverage
      where loan_id = $1
      order by installment_number`,
    [loanId],
  );

  return rows.map((row) => ({
    installmentNumber: Number(row.n),
    dueDate: row.due_date ?? '',
    expectedAmount: Number(row.expected),
    scheduledPrincipal: Number(row.sched_principal),
    scheduledInterest: Number(row.sched_interest),
    allocatedAmount: Number(row.alloc),
    allocatedPrincipal: Number(row.alloc_principal),
    allocatedInterest: Number(row.alloc_interest),
    remainingAmount: Number(row.remaining),
  }));
}

export interface AllocationRow {
  readonly installmentNumber: number;
  readonly allocatedAmount: number;
  readonly allocatedPrincipal: number;
  readonly allocatedInterest: number;
}

/** How one payment was applied, oldest collection first. */
export async function readAllocations(
  paymentId: string,
): Promise<readonly AllocationRow[]> {
  const rows = await query<Record<string, string>>(
    `select li.installment_number::text   as n,
            pa.allocated_amount::text     as amount,
            pa.allocated_principal::text  as principal,
            pa.allocated_interest::text   as interest
       from public.payment_allocations pa
       join public.loan_installments li on li.id = pa.installment_id
      where pa.payment_id = $1
      order by li.installment_number`,
    [paymentId],
  );

  return rows.map((row) => ({
    installmentNumber: Number(row.n),
    allocatedAmount: Number(row.amount),
    allocatedPrincipal: Number(row.principal),
    allocatedInterest: Number(row.interest),
  }));
}

/** A fresh idempotency key, for tests that need to reuse one deliberately. */
export function newIdempotencyKey(): string {
  return randomUUID();
}

/**
 * Remove every payment fixture.
 *
 * The ledger is append-only, so clearing it needs the same documented
 * owner-level trigger exemption `deleteTestUsers` uses for `audit_log`. Safe
 * only because this runs against a throwaway database, as the owner, with no
 * application code involved.
 */
export async function deleteTestPayments(): Promise<void> {
  const GUARDS: readonly { readonly table: string; readonly trigger: string }[] = [
    { table: 'payment_allocations', trigger: 'payment_allocations_no_delete' },
    { table: 'loan_payments', trigger: 'loan_payments_no_delete' },
  ];

  for (const { table, trigger } of GUARDS) {
    await query(`alter table public.${table} disable trigger ${trigger}`);
  }

  try {
    await query(`delete from public.payment_allocations`);
    await query(`delete from public.loan_payments`);
  } finally {
    for (const { table, trigger } of GUARDS) {
      await query(`alter table public.${table} enable trigger ${trigger}`);
    }
  }
}
