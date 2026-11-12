/**
 * The clean slate, rehearsed on a disposable database.
 *
 * The business launches on a database that holds demonstration records. This
 * suite builds a representative book — clients, guarantors, loans driven to
 * disbursement, payments, journals — then empties it with the real procedure
 * and asserts the end state rather than the statements that produced it.
 *
 * ## Why it has a vitest project of its own
 *
 * It truncates 62 tables and deletes every profile but one. That is global
 * state no other suite could survive sharing, for the same reason the four
 * seeder suites have projects of their own: see the header of
 * `vitest.config.mts`. The `db` project excludes this file.
 *
 * ## What is actually being checked
 *
 * Not "did the deletes run" but "is the result a database the client can
 * start on": no business rows, both sides of the journal at zero, reference
 * data and settings still present, the Owner still active and still holding
 * `owner_admin`, no preserved row left pointing at a deleted profile, and the
 * reference counters back to zero so the first real client is CL26001.
 *
 * The classification guard is checked as a pure function, because the thing
 * worth proving is that an unclassified table stops the procedure — and the
 * only way to show that is to hand it a table list it has not seen.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  classify,
  countBusinessRows,
  describeResidue,
  PRESERVE_PARTIAL,
  PRESERVE_WHOLE,
  runCleanSlate,
  TRUNCATE_TABLES,
} from '../../scripts/lib/clean-slate.mjs';
import { asUserCommitted } from '../helpers/auth-fixtures';
import { closePool, hasDatabase, query, queryOne, skipReason } from '../helpers/db';
import {
  approveLoan,
  createDraftLoan,
  createLoanScenario,
  disburseApprovedLoan,
  submitLoan,
} from '../helpers/loan-fixtures';
import { newIdempotencyKey, readLedger } from '../helpers/payment-fixtures';

const describeDb = hasDatabase ? describe : describe.skip;
if (!hasDatabase) {
  describe('clean slate', () => {
    it.skip(`skipped - ${skipReason}`, () => undefined);
  });
}

/** The procedure takes a connection; here it is the suite's own pool. */
const db = {
  query: async (sql: string, params?: readonly unknown[]) => ({
    rows: await query<Record<string, unknown>>(sql, params),
  }),
};

describeDb('the clean slate', () => {
  let ownerProfileId: string;
  let before: Record<string, number>;

  beforeAll(async () => {
    // --- a representative book ------------------------------------------
    const scenario = await createLoanScenario();
    const actors = {
      secretary: scenario.owner,
      manager: scenario.owner,
      owner: scenario.owner,
    };

    // Two loans, one settled and one part-paid, so the book holds cleared and
    // active lending, real schedules, allocations and journals.
    for (const settle of [true, false]) {
      const loanId = await createDraftLoan(scenario.clientId, { principal: 400_000 });
      await submitLoan(loanId, actors);
      await approveLoan(loanId, actors);
      await disburseApprovedLoan(loanId, actors);

      const owed = await readLedger(loanId);
      const amount = settle
        ? owed.totalOutstanding
        : Math.floor(owed.totalOutstanding / 2);
      // `post_payment` refuses an unattributable session — a payment is always
      // recorded by somebody — so this goes through the Owner, not the
      // table-owner path the loan fixtures use.
      const posted = await asUserCommitted(scenario.owner, [
        {
          sql: 'select public.post_payment($1, $2, $3, null, $4)',
          params: [loanId, amount, 'cash', newIdempotencyKey()],
        },
      ]);
      if (!posted.ok)
        throw new Error(`could not post a payment: ${posted.message ?? ''}`);

      // One active loan per client, so clear the part-paid one before the next.
      if (!settle) break;
      const rest = await readLedger(loanId);
      if (rest.totalOutstanding > 0) {
        const settled = await asUserCommitted(scenario.owner, [
          {
            sql: 'select public.post_payment($1, $2, $3, null, $4)',
            params: [loanId, rest.totalOutstanding, 'cash', newIdempotencyKey()],
          },
        ]);
        if (!settled.ok) throw new Error(`could not settle: ${settled.message ?? ''}`);
      }
    }

    // --- the Owner the cleanup must preserve ------------------------------
    const owner = await queryOne<{ id: string }>(
      `with u as (
         insert into auth.users (email) values ('clean.slate.owner@test.invalid')
         returning id
       ), p as (
         insert into public.profiles (full_name, phone, auth_user_id, status)
         select 'Clean Slate Owner', '+256700000009', u.id, 'active' from u
         returning id
       )
       insert into public.user_roles (profile_id, role_key)
       select p.id, 'owner_admin' from p
       returning profile_id as id`,
    );
    ownerProfileId = owner.id;

    before = await countBusinessRows(db);
  }, 120_000);

  afterAll(async () => {
    await closePool();
  });

  // --------------------------------------------------------------------
  // The guard: an unclassified table stops the procedure
  // --------------------------------------------------------------------

  it('classifies every table the database actually has', async () => {
    const rows = await query<{ tablename: string }>(
      `select tablename from pg_tables where schemaname = 'public' order by tablename`,
    );
    const { unclassified, missing } = classify(rows.map((r) => r.tablename));

    // If this fails, a migration added or renamed a table and the cleanup's
    // lists need a decision — which is the point of the guard.
    expect(
      unclassified,
      'tables in the database that the cleanup classifies nowhere',
    ).toEqual([]);
    expect(missing, 'tables the cleanup names that the database does not have').toEqual(
      [],
    );
  });

  it('refuses a table it has never been told about', () => {
    const { unclassified } = classify([
      ...PRESERVE_WHOLE,
      'some_table_a_later_migration_added',
    ]);
    expect(unclassified).toEqual(['some_table_a_later_migration_added']);
  });

  it('keeps the keep-list and the empty-list disjoint', () => {
    const kept = new Set([...PRESERVE_WHOLE, ...PRESERVE_PARTIAL.map((e) => e.table)]);
    const both = TRUNCATE_TABLES.filter((t) => kept.has(t));
    expect(both, 'a table cannot be both preserved and emptied').toEqual([]);
  });

  // --------------------------------------------------------------------
  // The refusals that protect the Owner
  // --------------------------------------------------------------------

  it('refuses to run without an Owner to keep', async () => {
    await expect(runCleanSlate(db, { ownerProfileId: '', dryRun: true })).rejects.toThrow(
      /ownerProfileId is required/,
    );
  });

  it('refuses a profile that does not exist', async () => {
    await expect(
      runCleanSlate(db, {
        ownerProfileId: '00000000-0000-4000-8000-000000000000',
        dryRun: true,
      }),
    ).rejects.toThrow(/No profile/);
  });

  it('refuses a profile that does not hold owner_admin', async () => {
    const other = await queryOne<{ id: string }>(
      `select p.id from public.profiles p
         join public.user_roles ur on ur.profile_id = p.id
        where ur.role_key <> 'owner_admin' limit 1`,
    );
    await expect(
      runCleanSlate(db, { ownerProfileId: other.id, dryRun: true }),
    ).rejects.toThrow(/does not hold owner_admin/);
  });

  // --------------------------------------------------------------------
  // The dry run changes nothing
  // --------------------------------------------------------------------

  it('reports without touching anything', async () => {
    const result = await runCleanSlate(db, { ownerProfileId, dryRun: true });
    expect(result.dryRun).toBe(true);

    const now = await countBusinessRows(db);
    expect(now).toEqual(before);
    expect(now.loans).toBeGreaterThan(0);
    expect(now.payments).toBeGreaterThan(0);
    expect(now.journal_entries).toBeGreaterThan(0);
  });

  // --------------------------------------------------------------------
  // The real thing
  // --------------------------------------------------------------------

  it('empties the books and leaves a database the client can start on', async () => {
    const result = await runCleanSlate(db, { ownerProfileId, dryRun: false });
    expect(result.dryRun).toBe(false);

    const after = result.after as Record<string, number>;

    // Nothing of the demonstration business survives.
    for (const key of [
      'clients',
      'loans',
      'payments',
      'journal_entries',
      'journal_lines',
      'memberships',
      'savings_accounts',
      'guarantors',
      'storage_objects',
    ]) {
      expect(after[key], `${key} must be empty`).toBe(0);
    }

    // The books are not merely empty, they are consistent: both sides zero.
    expect(after.total_debits).toBe(0);
    expect(after.total_credits).toBe(0);

    // Exactly one profile can still work. Others may linger as audit actors.
    expect(after.active_profiles).toBe(1);
    expect(after.auth_users).toBeLessThanOrEqual(1);

    // Reference data the application cannot run without.
    expect(after.roles).toBeGreaterThan(0);
    expect(after.permissions).toBeGreaterThan(0);
    expect(after.ledger_accounts).toBeGreaterThan(0);
    expect(after.cadences).toBeGreaterThan(0);
    expect(after.loan_products).toBeGreaterThan(0);
  }, 120_000);

  it('cannot empty the audit log, and says so by leaving it intact', async () => {
    // Not an oversight. `20261001000600_audit_log` rejects UPDATE, DELETE and
    // TRUNCATE at statement level, and `actor_profile_id` references profiles
    // ON DELETE RESTRICT. So the demonstration trail survives, and with it the
    // profiles that produced it. The cleanup works around that rather than
    // disabling the guards, because a cleanup that can erase an audit trail is
    // the capability an attacker would want most.
    const entries = await queryOne<{ n: string }>(
      'select count(*)::text as n from public.audit_log',
    );
    expect(Number(entries.n)).toBeGreaterThan(0);

    // And the guards are still in force afterwards.
    let refused = false;
    try {
      await query('delete from public.audit_log');
    } catch {
      refused = true;
    }
    expect(refused, 'the audit log must still refuse deletion').toBe(true);
  });

  it('leaves every demonstration profile unable to sign in or act', async () => {
    const others = await query<{
      status: string;
      auth_user_id: string | null;
      roles: string | null;
    }>(
      `select p.status, p.auth_user_id,
              (select pg_catalog.string_agg(ur.role_key, ',')
                 from public.user_roles ur where ur.profile_id = p.id) as roles
         from public.profiles p where p.id <> $1`,
      [ownerProfileId],
    );

    for (const row of others) {
      // Inactive, so `current_profile_id()` resolves nothing and every
      // capability check and RLS policy refuses the session.
      expect(row.status).toBe('inactive');
      // Unlinked, so there is no credential to present in the first place.
      expect(row.auth_user_id).toBeNull();
      // And holding nothing even if the other two were somehow bypassed.
      expect(row.roles).toBeNull();
    }

    // Exactly one Auth user remains: the Owner's.
    const users = await queryOne<{ n: string }>(
      'select count(*)::text as n from auth.users',
    );
    expect(Number(users.n)).toBeLessThanOrEqual(1);
  });

  it('leaves the Owner active and able to work', async () => {
    const owner = await queryOne<{ status: string; roles: string }>(
      `select p.status,
              (select pg_catalog.string_agg(ur.role_key, ',')
                 from public.user_roles ur where ur.profile_id = p.id) as roles
         from public.profiles p where p.id = $1`,
      [ownerProfileId],
    );
    expect(owner.status).toBe('active');
    expect(owner.roles).toContain('owner_admin');

    // And the capability lookup still answers, so the matrix survived.
    const held = await queryOne<{ held: boolean }>(
      `select exists (
         select 1 from public.user_roles ur
           join public.role_permissions rp on rp.role_key = ur.role_key
          where ur.profile_id = $1 and rp.permission_key = 'loans:approve'
       ) as held`,
      [ownerProfileId],
    );
    expect(held.held).toBe(true);
  });

  it('leaves no preserved row pointing at a deleted profile', async () => {
    const orphans = await query<{ t: string; n: string }>(`
      select 'company_settings' as t, count(*)::text as n from public.company_settings
        where updated_by is not null and updated_by not in (select id from public.profiles)
      union all select 'business_settings', count(*)::text from public.business_settings
        where updated_by is not null and updated_by not in (select id from public.profiles)
      union all select 'finance_settings', count(*)::text from public.finance_settings
        where updated_by is not null and updated_by not in (select id from public.profiles)
    `);
    for (const row of orphans) {
      expect(Number(row.n), `${row.t} must hold no orphaned updated_by`).toBe(0);
    }
  });

  it('resets the reference counters, so the first real client is number one', async () => {
    const counters = await query<{ scope: string; last_value: string }>(
      `select scope, last_value from public.reference_sequences
        where scope in ('client','loan','payment') order by scope`,
    );
    expect(counters.length).toBe(3);
    for (const row of counters) {
      expect(Number(row.last_value), `the ${row.scope} counter`).toBe(0);
    }

    // Proven by issuing one rather than by reading the column.
    const next = await queryOne<{ reference: string }>(
      `select public.next_reference('client') as reference`,
    );
    expect(next.reference).toMatch(/^CL\d+1$/);
  });

  it('keeps the settings singletons, so the business is still configured', async () => {
    const settings = await queryOne<{
      company: string;
      currency: string;
      min_loan: string;
      cadences: string;
    }>(`
      select (select company_name from public.company_settings where id = 1) as company,
             (select currency_code from public.company_settings where id = 1) as currency,
             (select min_loan_amount::text from public.business_settings where id = 1) as min_loan,
             (select count(*)::text from public.repayment_frequencies where is_active) as cadences
    `);
    expect(settings.company).toBeTruthy();
    expect(settings.currency).toBe('UGX');
    expect(Number(settings.min_loan)).toBeGreaterThan(0);
    expect(Number(settings.cadences)).toBeGreaterThan(0);
  });

  it('reports what the schema will not let it remove', async () => {
    // Three deliberate immutability guarantees, and the procedure respects
    // all three rather than disabling them. What matters is that the report
    // says so, instead of implying a clean sweep.
    const residue = await describeResidue(db);

    // The audit trail survives, and the profiles it names survive with it.
    expect(residue.audit_entries).toBeGreaterThan(0);
    expect(residue.deactivated_profiles).toBeGreaterThan(0);

    // Whatever remains is reported as a number the operator can act on.
    expect(residue).toHaveProperty('demonstration_policies');
    expect(residue).toHaveProperty('active_demonstration_policies');
  });

  it('leaves no policy version governing lending by accident', async () => {
    // Nothing in a freshly migrated database publishes a policy, and the
    // cleanup publishes none. If a demonstration version is ever active on a
    // real database, retiring it is launch item A-1 and not this procedure's
    // job — but on a clean slate there must be nothing active at all.
    const active = await queryOne<{ n: string }>(
      `select count(*)::text as n from public.membership_policy_versions
        where status = 'active'`,
    );
    expect(Number(active.n)).toBe(0);
  });

  it('is repeatable: running it again on an empty database is a no-op', async () => {
    const first = await countBusinessRows(db);
    await runCleanSlate(db, { ownerProfileId, dryRun: false });
    const second = await countBusinessRows(db);
    expect(second).toEqual(first);
  }, 120_000);
});
