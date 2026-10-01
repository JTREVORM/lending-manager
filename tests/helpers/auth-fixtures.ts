import type { PoolClient } from 'pg';

import { query, queryOne } from './db';

/**
 * Database-level role impersonation for the authorization tests.
 *
 * ## Why this has to run as the `authenticated` role
 *
 * Row Level Security does not apply to a table's owner. A test that connects
 * as the migration user and checks a policy proves nothing — every query
 * succeeds regardless of what the policy says.
 *
 * So each helper does what PostgREST does on a real request: sets the JWT
 * `sub` claim, then switches to the `authenticated` (or `anon`) role. From
 * that point the session is subject to exactly the grants and policies a real
 * signed-in user would meet.
 *
 * Everything runs inside a transaction that is always rolled back, so one test
 * cannot leave state for the next.
 */

export interface TestUser {
  readonly profileId: string;
  readonly authUserId: string;
  readonly fullName: string;
  readonly phone: string;
  readonly role: string;
}

let sequence = 0;

/**
 * A phone prefix no real Ugandan subscriber holds, so a fixture can never
 * collide with seeded or production-shaped data.
 */
const TEST_PHONE_PREFIX = '+2567000';

/**
 * Create a profile with a login and a role, as a trusted server path.
 *
 * Committed rather than rolled back, because the impersonation helpers open
 * their own transactions and need the fixture visible from them.
 */
export async function createTestUser(role: string, status = 'active'): Promise<TestUser> {
  sequence += 1;
  // Sequence plus the process id: two test files sharing a worker, or a rerun
  // against a database that was not reset, still get distinct numbers.
  const suffix = String((process.pid % 100) * 1000 + (sequence % 1000)).padStart(5, '0');
  const phone = `${TEST_PHONE_PREFIX}${suffix}`;
  const fullName = `Test ${role} ${suffix}`;

  const authUser = await queryOne<{ id: string }>(
    `insert into auth.users (email) values ($1) returning id`,
    [`${role}.${suffix}@test.invalid`],
  );

  const profile = await queryOne<{ id: string }>(
    `insert into public.profiles (full_name, phone, auth_user_id, status)
     values ($1, $2, $3, $4) returning id`,
    [fullName, phone, authUser.id, status],
  );

  await query(`insert into public.user_roles (profile_id, role_key) values ($1, $2)`, [
    profile.id,
    role,
  ]);

  return { profileId: profile.id, authUserId: authUser.id, fullName, phone, role };
}

/**
 * Remove every fixture this suite created.
 *
 * ## Why this has to disable triggers
 *
 * The schema is doing its job and refuses all three steps:
 *
 *   - `audit_log` is append-only, so the rows the fixtures generated cannot be
 *     deleted;
 *   - `audit_log.actor_profile_id` references `profiles` with ON DELETE
 *     RESTRICT, so the profiles cannot be removed while those rows exist;
 *   - the last-owner guard refuses to revoke the final `owner_admin`.
 *
 * Those are exactly the protections the tests elsewhere in this directory
 * assert, so working around them here is not a weakening — it is the
 * documented caveat in docs/SECURITY.md made concrete: a role with ownership
 * of the tables can disable a trigger, and no in-database design prevents
 * that. It is safe here only because this runs against a throwaway database,
 * as the owner, with no application code involved.
 *
 * It must never be reachable from the application. It is not: `authenticated`
 * has no privilege to alter a table, which `rls-identity.test.ts` asserts.
 */
export async function deleteTestUsers(): Promise<void> {
  const GUARDS: readonly { readonly table: string; readonly trigger: string }[] = [
    { table: 'audit_log', trigger: 'audit_log_reject_delete' },
    { table: 'user_roles', trigger: 'user_roles_assert_owner_remains' },
    { table: 'user_roles', trigger: 'audit_user_role_change' },
    { table: 'user_roles', trigger: 'user_roles_guard_assignment' },
    { table: 'profiles', trigger: 'audit_profile_change' },
    { table: 'profiles', trigger: 'profiles_assert_owner_remains' },
    { table: 'profiles', trigger: 'profiles_guard_privileged_columns' },
  ];

  for (const { table, trigger } of GUARDS) {
    await query(`alter table public.${table} disable trigger ${trigger}`);
  }

  try {
    await query(`delete from public.audit_log`);
    await query(
      `delete from public.user_roles where profile_id in (
         select id from public.profiles where phone like $1)`,
      [`${TEST_PHONE_PREFIX}%`],
    );
    await query(`delete from public.profiles where phone like $1`, [
      `${TEST_PHONE_PREFIX}%`,
    ]);
    await query(`delete from auth.users where email like '%@test.invalid'`);
  } finally {
    for (const { table, trigger } of GUARDS) {
      await query(`alter table public.${table} enable trigger ${trigger}`);
    }
  }
}

/** The outcome of a statement run as an impersonated user. */
export interface AttemptResult {
  readonly ok: boolean;
  readonly code?: string;
  readonly message?: string;
  readonly rows: readonly Record<string, unknown>[];
  /** Rows the statement reported affecting. Zero means RLS filtered it out. */
  readonly rowCount: number;
}

/**
 * Run SQL as a signed-in user, inside a transaction that is rolled back.
 *
 * A zero `rowCount` on a write is a denial too — RLS filters rows out rather
 * than raising — so tests must assert on it rather than only on errors.
 */
export async function asUser(
  user: Pick<TestUser, 'authUserId'>,
  sql: string,
  params: readonly unknown[] = [],
): Promise<AttemptResult> {
  return runImpersonated('authenticated', user.authUserId, sql, params);
}

/**
 * Run several statements as one signed-in user, in a single transaction.
 *
 * Needed where a test must observe the effect of a function call: `asUser`
 * rolls back after each call, so a separate read would never see the write.
 * Returns the result of the last statement.
 */
export async function asUserScript(
  user: Pick<TestUser, 'authUserId'>,
  statements: readonly { readonly sql: string; readonly params?: readonly unknown[] }[],
): Promise<AttemptResult> {
  const { getClient } = await import('./db');
  const client = await getClient();

  try {
    await client.query('begin');
    await client.query(`select set_config('request.jwt.claim.sub', $1, true)`, [
      user.authUserId,
    ]);
    await client.query('set local role authenticated');

    let last: AttemptResult = { ok: true, rows: [], rowCount: 0 };

    for (const statement of statements) {
      const result = await client.query(statement.sql, [...(statement.params ?? [])]);
      last = {
        ok: true,
        rows: result.rows as Record<string, unknown>[],
        rowCount: result.rowCount ?? 0,
      };
    }

    return last;
  } catch (error) {
    const pgError = error as { code?: string; message?: string };
    return {
      ok: false,
      code: pgError.code,
      message: pgError.message,
      rows: [],
      rowCount: 0,
    };
  } finally {
    try {
      await client.query('rollback');
    } finally {
      client.release();
    }
  }
}

/** Run SQL as an anonymous visitor. */
export async function asAnon(
  sql: string,
  params: readonly unknown[] = [],
): Promise<AttemptResult> {
  return runImpersonated('anon', null, sql, params);
}

/** Run SQL as `service_role`, which bypasses RLS. */
export async function asServiceRole(
  sql: string,
  params: readonly unknown[] = [],
): Promise<AttemptResult> {
  return runImpersonated('service_role', null, sql, params);
}

async function runImpersonated(
  role: 'authenticated' | 'anon' | 'service_role',
  authUserId: string | null,
  sql: string,
  params: readonly unknown[],
): Promise<AttemptResult> {
  const { getClient } = await import('./db');
  const client: PoolClient = await getClient();

  try {
    await client.query('begin');

    if (authUserId !== null) {
      await client.query(`select set_config('request.jwt.claim.sub', $1, true)`, [
        authUserId,
      ]);
    }

    // After this, the session is subject to the same grants and policies as a
    // real request. Nothing below runs with owner privileges.
    await client.query(`set local role ${role}`);

    const result = await client.query(sql, [...params]);

    return {
      ok: true,
      rows: result.rows as Record<string, unknown>[],
      rowCount: result.rowCount ?? 0,
    };
  } catch (error) {
    const pgError = error as { code?: string; message?: string };
    return {
      ok: false,
      code: pgError.code,
      message: pgError.message,
      rows: [],
      rowCount: 0,
    };
  } finally {
    try {
      await client.query('rollback');
    } finally {
      client.release();
    }
  }
}
