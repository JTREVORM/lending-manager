import { Pool, type PoolClient, type QueryResultRow } from 'pg';

import { assertTestDatabaseUrl } from './test-targets';

/**
 * Connection helper for the database test suite.
 *
 * These tests need a real PostgreSQL database with every migration applied.
 * Use the isolated local cluster, never hosted or shared databases:
 *
 *   npm run db:local:setup     throwaway local cluster (no Docker needed)
 *
 * Then export the connection string:
 *
 *   export DATABASE_URL="$(./scripts/pg-local.sh url)"
 *   npm run test:db
 *
 * Without `DATABASE_URL` the suite skips rather than failing. That is a
 * deliberate distinction: a missing database means "this check did not run",
 * which the Phase 1 report states explicitly, whereas a failing assertion
 * means the schema is wrong. The suite is never skipped to make a failure go
 * away — `npm run test:db` is part of the verification baseline.
 */

export const DATABASE_URL = process.env.DATABASE_URL?.trim();

export const hasDatabase = DATABASE_URL !== undefined && DATABASE_URL !== '';

export const skipReason =
  'DATABASE_URL is not set. Run `npm run db:local:setup` and export DATABASE_URL to run the database suite.';

let pool: Pool | undefined;
let testBusinessClock: string | undefined;

/** Pin one suite before opening its pool, using the existing owner-only clock. */
export async function setTestBusinessClock(instant: Date): Promise<void> {
  if (pool !== undefined)
    throw new Error('Set the fixture clock before opening the pool.');
  testBusinessClock = instant.toISOString();
  const row = await queryOne<{ matches: boolean }>(
    'select public.business_now() = $1::timestamptz as matches',
    [testBusinessClock],
  );
  if (!row.matches)
    throw new Error('The isolated owner-only business clock was not applied.');
}

function getPool(): Pool {
  if (pool === undefined) {
    if (!hasDatabase || DATABASE_URL === undefined) throw new Error(skipReason);
    assertTestDatabaseUrl(DATABASE_URL);
    pool = new Pool({
      connectionString: DATABASE_URL,
      max: 12,
      options:
        testBusinessClock === undefined
          ? undefined
          : `-c app.business_now=${testBusinessClock}`,
    });
  }
  return pool;
}

/**
 * The SQLSTATE an `ON DELETE RESTRICT` refusal arrives as.
 *
 * PostgreSQL 18 reports it as `23001 restrict_violation`. PostgreSQL 17 and
 * earlier reported the same refusal as `23503 foreign_key_violation`. Both
 * are class 23, integrity constraint violation, and both mean exactly what
 * these tests assert: the delete was refused because a row still points at
 * the target.
 *
 * Matched as either rather than pinned to one, so one suite certifies the
 * same behaviour on whichever server it meets — the `database` CI job takes
 * the newest PostgreSQL on the runner image, and that version moved under it.
 * `lib/db-errors.ts` maps both codes to the same user-facing message for the
 * same reason.
 */
export const RESTRICT_VIOLATION = /^(?:23001|23503)$/;

/**
 * The SQLSTATE a statement was refused with, or `null` if it succeeded.
 *
 * For assertions about a *class* of refusal rather than one exact code, where
 * `rejects.toMatchObject` cannot carry a pattern without an `any`.
 */
export async function sqlstateOf(attempt: Promise<unknown>): Promise<string | null> {
  try {
    await attempt;
    return null;
  } catch (error) {
    const code = (error as { readonly code?: unknown }).code;
    return typeof code === 'string' ? code : '';
  }
}

/**
 * Run a parameterised query.
 *
 * Values are always passed as parameters, never interpolated, so the tests
 * demonstrate the same discipline they verify.
 */
export async function query<Row extends QueryResultRow = QueryResultRow>(
  sql: string,
  params: readonly unknown[] = [],
): Promise<Row[]> {
  const result = await getPool().query<Row>(sql, [...params]);
  return result.rows;
}

/** Run a query expecting exactly one row. */
export async function queryOne<Row extends QueryResultRow = QueryResultRow>(
  sql: string,
  params: readonly unknown[] = [],
): Promise<Row> {
  const rows = await query<Row>(sql, params);
  if (rows.length !== 1) {
    throw new Error(`Expected exactly one row, received ${String(rows.length)}.`);
  }
  return rows[0]!;
}

/**
 * Run `work` inside a transaction that is always rolled back.
 *
 * Lets a test insert whatever it needs without leaving the database dirty for
 * the next one.
 */
export async function inRollbackTransaction<Result>(
  work: (client: PoolClient) => Promise<Result>,
): Promise<Result> {
  const client = await getPool().connect();
  try {
    await client.query('begin');
    return await work(client);
  } finally {
    await client.query('rollback');
    client.release();
  }
}

/** Capture the error a statement raises, or `null` if it succeeds. */
export async function expectError(
  sql: string,
  params: readonly unknown[] = [],
): Promise<{
  code: string | undefined;
  constraint: string | undefined;
  message: string;
} | null> {
  try {
    await inRollbackTransaction(async (client) => client.query(sql, [...params]));
    return null;
  } catch (error) {
    const pgError = error as { code?: string; constraint?: string; message?: string };
    return {
      code: pgError.code,
      constraint: pgError.constraint,
      message: pgError.message ?? '',
    };
  }
}

/** A raw pooled client, for the impersonation helpers. */
export async function getClient(): Promise<PoolClient> {
  return getPool().connect();
}

export async function closePool(): Promise<void> {
  if (pool !== undefined) {
    await pool.end();
    pool = undefined;
  }
  testBusinessClock = undefined;
}

/**
 * Count the money a fixture has just recorded as received.
 *
 * Decision A (migration `20261120000100`) restricts a cash receipt until a
 * second officer confirms it: the borrower's arrears fall immediately, and
 * the company may not spend the money until somebody has looked in the
 * drawer. That is the rule working, and it means a fixture that records a
 * receipt and then expects the business to spend it has to do what the
 * business does in between.
 *
 * Called from the receipt fixtures rather than from each test, so a test
 * whose subject is something else — a benefit payment, a savings withdrawal,
 * a reconciliation — reads the way it always did. The tests whose subject
 * *is* the confirmation rule confirm explicitly and do not use this.
 */
export async function confirmRecordedReceipts(): Promise<void> {
  if (!hasDatabase) return;

  await query(
    `update public.cash_receipt_confirmations
        set state = 'confirmed',
            confirmed_by_label = 'Fixture count',
            confirmed_at = now(),
            confirmation_note = 'Counted by the fixture that recorded it'
      where state = 'pending'`,
  );
}
