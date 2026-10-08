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
    // Phase 3. `client_remarks` is append-only in the same way `audit_log`
    // is, so clearing it needs the same documented owner-level exemption.
    { table: 'client_remarks', trigger: 'client_remarks_no_delete' },
    { table: 'clients', trigger: 'clients_guard_privileged_columns' },
    { table: 'clients', trigger: 'audit_client_change' },
    // Phase 5. The collection schedule is append-only in the same way, and
    // the installments reference `loan_periods`, so they are cleared first.
    // Phase 6. The payment ledger is append-only, and its allocations
    // reference `loan_installments` with `on delete restrict` — financial
    // history must not cascade away — so the ledger goes before the schedule.
    { table: 'payment_allocations', trigger: 'payment_allocations_no_delete' },
    { table: 'loan_payments', trigger: 'loan_payments_no_delete' },
    // Phase 7. A penalty is append-only too, and `payment_allocations`
    // references it with `on delete restrict` — a charge's payment history
    // must not cascade away — so the ledger goes before the penalties.
    { table: 'loan_penalties', trigger: 'loan_penalties_no_delete' },
    // Phase 10. The journals reference loans and clients with
    // `on delete restrict`, on purpose: in production nothing deletes a loan
    // that has been posted against. A test database still has to come apart,
    // so they are cleared here through the same owner-level exemption the
    // rest of this list uses.
    { table: 'journal_lines', trigger: 'journal_lines_no_delete' },
    { table: 'journal_entries', trigger: 'journal_entries_no_delete' },
    { table: 'journal_entries', trigger: 'journal_entries_guard_update' },
    { table: 'loan_installments', trigger: 'loan_installments_no_delete' },
    { table: 'loan_schedules', trigger: 'loan_schedules_no_delete' },
    // Phase 4. The loan snapshots and the contractual breakdown are
    // append-only in the same way, so clearing them needs the same exemption.
    { table: 'loan_periods', trigger: 'loan_periods_no_delete' },
    { table: 'loan_client_snapshots', trigger: 'loan_client_snapshots_no_delete' },
    { table: 'loan_guarantor_snapshots', trigger: 'loan_guarantor_snapshots_no_delete' },
    { table: 'loan_identity_snapshots', trigger: 'loan_identity_snapshots_no_delete' },
    { table: 'loans', trigger: 'loans_guard_transition' },
    { table: 'loans', trigger: 'audit_loan_change' },
  ];

  for (const { table, trigger } of GUARDS) {
    await query(`alter table public.${table} disable trigger ${trigger}`);
  }

  try {
    await query(`delete from public.audit_log`);

    // The reversal pointer self-references with `on delete restrict`, so an
    // entry and its contra cannot both go in one statement. Unstamping first
    // is why the update guard is suspended above.
    await query(`update public.journal_entries set reversed_by_entry_id = null`);
    await query(`delete from public.journal_entries`);

    // Phase 4 rows first: `loans.client_id` is `on delete restrict`, so loans
    // go before the clients they belong to, and the snapshots before the
    // loans they hang off.
    await query(`delete from public.payment_allocations`);
    await query(`delete from public.loan_payments`);
    await query(`delete from public.loan_penalties`);
    await query(`delete from public.loan_installments`);
    await query(`delete from public.loan_schedules`);
    await query(`delete from public.loan_periods`);
    await query(`delete from public.loan_client_snapshots`);
    await query(`delete from public.loan_guarantor_snapshots`);
    await query(`delete from public.loan_identity_snapshots`);
    await query(`delete from public.loans`);

    // Phase 3 rows, innermost first. `client_remarks.created_by` is
    // `on delete restrict`, so remarks go before the profiles that wrote
    // them; clients reference profiles too, through `created_by`.
    await query(`delete from public.client_remarks`);
    await query(`delete from public.client_guarantors`);
    await query(`delete from public.guarantor_identities`);
    await query(`delete from public.guarantors`);
    await query(`delete from public.client_identities`);
    await query(`delete from public.clients`);

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
