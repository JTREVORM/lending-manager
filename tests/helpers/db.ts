import { Pool, type PoolClient, type QueryResultRow } from 'pg';

/**
 * Connection helper for the database test suite.
 *
 * These tests need a real PostgreSQL database with every migration applied.
 * Two ways to get one:
 *
 *   npm run db:local:setup     throwaway local cluster (no Docker needed)
 *   supabase start             the full Supabase stack (needs Docker)
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

function getPool(): Pool {
  if (pool === undefined) {
    if (!hasDatabase) throw new Error(skipReason);
    pool = new Pool({ connectionString: DATABASE_URL, max: 12 });
  }
  return pool;
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
}
