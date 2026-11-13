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
 * It truncates 72 tables and deletes every profile but one. That is global
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
  classifySequences,
  countBusinessRows,
  describeResidue,
  EMPTY_APPEND_ONLY,
  PRESERVE_PARTIAL,
  PRESERVE_SEQUENCES,
  PRESERVE_WHOLE,
  projectRefFromConnectionString,
  RESET_SEQUENCES,
  runCleanSlate,
  TRUNCATE_TABLES,
} from '../../scripts/lib/clean-slate.mjs';
import {
  asAnon,
  asUser,
  asUserCommitted,
  createTestUser,
} from '../helpers/auth-fixtures';
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
  /** Enough of a TestUser for `asUser`: the Auth id the session presents. */
  let ownerSession: { authUserId: string };
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

    const authed = await queryOne<{ auth_user_id: string }>(
      'select auth_user_id from public.profiles where id = $1',
      [ownerProfileId],
    );
    ownerSession = { authUserId: authed.auth_user_id };

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
  // The same guard, for the numbering counters
  // --------------------------------------------------------------------

  it('classifies every reference counter the database actually has', async () => {
    // Against `reference_formats`, which is migration-managed and is the list
    // of scopes that exist. `reference_sequences` is not the specification:
    // `next_reference` creates its rows on demand, one per scope per year, so
    // a scope has no row at all until a document of that kind is issued.
    const rows = await query<{ scope: string }>(
      `select scope from public.reference_formats order by scope`,
    );
    const { unclassified, missing } = classifySequences(rows.map((r) => r.scope));
    expect(unclassified, 'counters in the database that no list names').toEqual([]);
    expect(missing, 'counters named by a list but absent from reference_formats').toEqual(
      [],
    );
  });

  it('refuses a counter it has never been told about', () => {
    const { unclassified } = classifySequences([
      ...RESET_SEQUENCES,
      ...PRESERVE_SEQUENCES,
      'invoice',
    ]);
    expect(unclassified).toEqual(['invoice']);
  });

  it('keeps the reset list and the preserve list disjoint', () => {
    const overlap = RESET_SEQUENCES.filter((scope) => PRESERVE_SEQUENCES.includes(scope));
    expect(overlap, 'a counter cannot be both reset and preserved').toEqual([]);
  });

  it('resets a counter for every table it empties, and no others', () => {
    // A counter whose table is emptied must restart; one whose table survives
    // must not, or the next record would reuse a reference somebody holds.
    expect(PRESERVE_WHOLE, 'branches is reference data').toContain('branches');
    expect(PRESERVE_SEQUENCES).toContain('branch');
    expect(RESET_SEQUENCES).not.toContain('branch');

    // Every scope that is reset must number a table being emptied. The
    // mapping is spelled out so that a new numbered document type has to be
    // placed deliberately rather than inherited from a pattern.
    const scopeTables: Record<string, string> = {
      client: 'clients',
      loan: 'loans',
      payment: 'loan_payments',
      journal: 'journal_entries',
      expense: 'expenses',
      other_income: 'other_income',
      transfer: 'account_transfers',
      reconciliation: 'account_reconciliations',
      membership: 'memberships',
      membership_fee: 'membership_fee_receipts',
      membership_card: 'membership_cards',
      membership_meeting: 'membership_meetings',
      membership_policy_transition: 'membership_policy_transitions',
      savings_account: 'savings_accounts',
      savings_transaction: 'savings_transactions',
      savings_withdrawal: 'savings_withdrawal_requests',
      beneficiary: 'member_beneficiaries',
      benefit_claim: 'benefit_claims',
      benefit_payment: 'benefit_payments',
      meeting_fine: 'meeting_fines',
      meeting_fine_payment: 'meeting_fine_payments',
    };
    for (const scope of RESET_SEQUENCES) {
      const table = scopeTables[scope];
      expect(table, `no table mapped for the ${scope} counter`).toBeDefined();
      expect(TRUNCATE_TABLES, `the ${scope} counter numbers ${String(table)}`).toContain(
        table,
      );
    }

    // And the preserved one numbers a table that survives.
    for (const scope of PRESERVE_SEQUENCES) {
      expect(scope).toBe('branch');
    }
  });

  // --------------------------------------------------------------------
  // Which database is this? The phrase does not say.
  // --------------------------------------------------------------------

  it('reads the Supabase project reference out of a connection string', () => {
    // The direct host and the pooler spell it differently; both are used.
    expect(
      projectRefFromConnectionString(
        'postgresql://postgres:pw@db.fszgwemtgyrbhngajpzm.supabase.co:5432/postgres',
      ),
    ).toBe('fszgwemtgyrbhngajpzm');
    expect(
      projectRefFromConnectionString(
        'postgresql://postgres.fszgwemtgyrbhngajpzm:pw@aws-0-eu-west-1.pooler.supabase.com:6543/postgres',
      ),
    ).toBe('fszgwemtgyrbhngajpzm');
  });

  it('cannot name a project for a local cluster, and says so rather than guessing', () => {
    // null is what makes a hosted run without --expect-project a refusal: an
    // unconfirmable target is not treated as the intended one.
    expect(
      projectRefFromConnectionString('postgresql://lending@localhost:5433/lending_test'),
    ).toBeNull();
    expect(
      projectRefFromConnectionString('postgresql://lending@127.0.0.1:5433/db'),
    ).toBeNull();
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

  it('refuses an Owner with no Auth identity to preserve', async () => {
    // A profile with no `auth_user_id` presents no credential, so it could
    // not sign in afterwards — and step 5 keeps exactly the Auth user this
    // column names, so with it NULL there is no user to keep and every one of
    // them goes. The end state passes a count of "at most one" while nobody
    // at all can sign in, which is why this is refused up front.
    //
    // Checked through a stub connection rather than by inserting a profile:
    // `runCleanSlate` takes the connection as an argument, and a real insert
    // here would write to the append-only audit log, which no later test
    // could undo and the dry-run assertion below would see.
    const tables = await query<{ tablename: string }>(
      `select tablename from pg_tables where schemaname = 'public' order by tablename`,
    );
    const unlinkedOwner = {
      query: (sql: string) => {
        if (sql.includes('pg_tables')) return Promise.resolve({ rows: tables });
        if (sql.includes('from public.profiles p where p.id')) {
          return Promise.resolve({
            rows: [
              {
                id: '00000000-0000-4000-8000-00000000dead',
                full_name: 'Unlinked Owner',
                status: 'active',
                auth_user_id: null,
                roles: 'owner_admin',
              },
            ],
          });
        }
        throw new Error(`the refusal should have come before: ${sql}`);
      },
    };

    await expect(
      runCleanSlate(unlinkedOwner, {
        ownerProfileId: '00000000-0000-4000-8000-00000000dead',
        dryRun: true,
      }),
    ).rejects.toThrow(/has no auth_user_id/);
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
  // The agency audit trail is never erased
  // --------------------------------------------------------------------

  /**
   * The real connection, except that the agency audit trail reports entries.
   * Fabricating a genuine agency transaction would need a provider, an agent
   * line and a funded till; the property under test is only what the
   * procedure does once it sees a non-empty trail.
   */
  function withAgencyAuditEntries(entriesOnCall: (call: number) => number) {
    let calls = 0;
    return {
      query: (sql: string, params?: readonly unknown[]) => {
        if (sql.includes('count(*) as n from public.agency_transaction_audit_log')) {
          calls += 1;
          return Promise.resolve({ rows: [{ n: entriesOnCall(calls) }] });
        }
        return db.query(sql, params);
      },
    };
  }

  it('treats the agency audit trail as an immutable table, not a business one', () => {
    expect(EMPTY_APPEND_ONLY.map((entry) => entry.table)).toEqual([
      'agency_transaction_audit_log',
    ]);
    expect(TRUNCATE_TABLES).not.toContain('agency_transaction_audit_log');
    expect(PRESERVE_WHOLE).not.toContain('agency_transaction_audit_log');
  });

  it('refuses a dry run while the agency audit trail holds an entry', async () => {
    await expect(
      runCleanSlate(
        withAgencyAuditEntries(() => 1),
        { ownerProfileId, dryRun: true },
      ),
    ).rejects.toThrow(/append-only audit trail and the clean slate never erases one/);
    expect(await countBusinessRows(db)).toEqual(before);
  });

  it('re-checks under lock, and changes nothing when an entry appears', async () => {
    // Empty at the first look, one entry by the time the table is locked.
    await expect(
      runCleanSlate(
        withAgencyAuditEntries((call) => (call === 1 ? 0 : 1)),
        { ownerProfileId, dryRun: false },
      ),
    ).rejects.toThrow(/Nothing was changed/);
    expect(await countBusinessRows(db)).toEqual(before);

    const guard = await queryOne<{ enabled: string }>(
      `select tgenabled as enabled from pg_catalog.pg_trigger
        where tgname = 'agency_transaction_audit_log_reject_truncate'`,
    );
    expect(guard.enabled, 'the TRUNCATE guard must be in force').toBe('O');
  }, 60_000);

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

  it('leaves the agency audit trail guarded after emptying the books', async () => {
    // The execute above set the TRUNCATE guard aside for one statement on a
    // table it had proved empty under lock. It must be back in force.
    const guard = await queryOne<{ enabled: string }>(
      `select tgenabled as enabled from pg_catalog.pg_trigger
        where tgname = 'agency_transaction_audit_log_reject_truncate'`,
    );
    expect(guard.enabled).toBe('O');

    let refused = false;
    try {
      await query('truncate public.agency_transaction_audit_log');
    } catch {
      refused = true;
    }
    expect(refused, 'the agency audit trail must still refuse TRUNCATE').toBe(true);

    const agency = await queryOne<{ transactions: string; providers: string }>(
      `select (select count(*) from public.agency_transactions)::text as transactions,
              (select count(*) from public.agency_service_providers)::text as providers`,
    );
    expect(Number(agency.transactions)).toBe(0);
    expect(Number(agency.providers), 'the provider catalogue is kept').toBeGreaterThan(0);
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

    // Exactly one Auth user remains, and it is the Owner's. "At most one"
    // would also be satisfied by none, which is a database nobody can sign
    // in to — a failed cleanup with the appearance of a thorough one.
    const users = await queryOne<{ n: string }>(
      'select count(*)::text as n from auth.users',
    );
    expect(Number(users.n)).toBe(1);

    const survivor = await queryOne<{ id: string }>('select id from auth.users');
    const ownerAuth = await queryOne<{ auth_user_id: string | null }>(
      'select auth_user_id from public.profiles where id = $1',
      [ownerProfileId],
    );
    expect(ownerAuth.auth_user_id).not.toBeNull();
    expect(survivor.id).toBe(ownerAuth.auth_user_id);
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
    // Every counter whose table was emptied, not just the three the first
    // version of this procedure reset. A counter left at its demonstration
    // value numbers the client's first real document after a history that no
    // longer exists: the first journal voucher would be JV2600598.
    // Every row a reset scope has, across every period year. A scope with no
    // row yet needs none: `next_reference` creates it at 1 on first use.
    const counters = await query<{ scope: string; last_value: string }>(
      `select scope, last_value from public.reference_sequences
        where scope = any ($1::text[]) order by scope`,
      [RESET_SEQUENCES],
    );
    expect(counters.length, 'some reset counter must have existed').toBeGreaterThan(0);
    for (const row of counters) {
      expect(Number(row.last_value), `the ${row.scope} counter`).toBe(0);
    }

    // Nothing in a reset scope is left carrying a demonstration value.
    const stragglers = await query<{ scope: string }>(
      `select scope from public.reference_sequences
        where scope = any ($1::text[]) and last_value <> 0`,
      [RESET_SEQUENCES],
    );
    expect(stragglers.map((r) => r.scope)).toEqual([]);

    // And the one that must NOT restart has not: `branches` survives, so its
    // codes are still taken.
    const branch = await queryOne<{ last_value: string }>(
      `select last_value from public.reference_sequences where scope = 'branch'`,
    );
    expect(
      Number(branch.last_value),
      'the branch counter must not restart',
    ).toBeGreaterThan(0);

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

  it('can retire an approved demonstration policy without breaking immutability', async () => {
    // Launch item A-1. The hosted database carries version 999.0,
    // "DEMONSTRATION ONLY", approved and active. The cleanup leaves it alone
    // on purpose, so the question this proves is whether the schema offers a
    // sanctioned way to retire it — because the alternative suggested in the
    // Phase 2 notes was a whole new Supabase project.
    //
    // It does: `membership_policy_versions_guard` permits the one-way step
    // active -> superseded, and `status` is not one of the contractual
    // columns it freezes once a version is approved. So the demonstration
    // terms stop governing anything without a trigger being disabled, a
    // constraint dropped or a row deleted.
    // Cloned from the version the migrations seed, so every contractual
    // column this table requires is carried over rather than enumerated here.
    const demo = await queryOne<{ id: string }>(
      `insert into public.membership_policy_versions
         (version, title, effective_from, status,
          registration_fee, monthly_savings_minimum, savings_qualifying_months,
          member_loan_interest_rate_bps, member_loan_max_term_months,
          member_loan_weekly_cadence_max_months, non_member_loan_max_term_months,
          medical_benefit_rate_bps, medical_benefit_min_admission_days,
          family_condolence_benefit, member_bereavement_benefit)
       select '999.1',
              'DEMONSTRATION ONLY — retirement rehearsal',
              public.business_date(),
              'draft',
              v.registration_fee, v.monthly_savings_minimum,
              v.savings_qualifying_months, v.member_loan_interest_rate_bps,
              v.member_loan_max_term_months,
              v.member_loan_weekly_cadence_max_months,
              v.non_member_loan_max_term_months, v.medical_benefit_rate_bps,
              v.medical_benefit_min_admission_days,
              v.family_condolence_benefit, v.member_bereavement_benefit
         from public.membership_policy_versions v
        where v.version = '1.0'
       returning id`,
    );

    // draft -> active, which stamps the approval from the session.
    await query(
      `update public.membership_policy_versions
          set status = 'active', approved_at = pg_catalog.now() where id = $1`,
      [demo.id],
    );
    const active = await queryOne<{ status: string; approved_at: string | null }>(
      `select status, approved_at::text from public.membership_policy_versions where id = $1`,
      [demo.id],
    );
    expect(active.status).toBe('active');
    expect(active.approved_at).not.toBeNull();

    // DELETE is refused outright, which is why retiring is the only route.
    await expect(
      query(`delete from public.membership_policy_versions where id = $1`, [demo.id]),
    ).rejects.toThrow();

    // A contractual column is still frozen, so this is not a way in.
    await expect(
      query(
        `update public.membership_policy_versions set registration_fee = 1 where id = $1`,
        [demo.id],
      ),
    ).rejects.toThrow(/approved/i);

    // Neither of the two steps the launch checklist originally prescribed can
    // run, which is why this test exists and why that checklist was corrected.
    //
    // active -> draft is not in the guard's one-way sequence.
    await expect(
      query(
        `update public.membership_policy_versions set status = 'draft' where id = $1`,
        [demo.id],
      ),
    ).rejects.toThrow(/cannot move from active to draft/);

    // And the readiness flags are GENERATED ALWAYS: they are derived from the
    // policy's own figures, so there is no value to write to turn a module
    // off. Postgres refuses the write itself.
    await expect(
      query(
        `update public.membership_policy_versions
            set is_enrolment_enabled = false where id = $1`,
        [demo.id],
      ),
    ).rejects.toThrow(/can only be updated to DEFAULT/i);

    // The sanctioned step.
    await query(
      `update public.membership_policy_versions set status = 'superseded' where id = $1`,
      [demo.id],
    );
    const retired = await queryOne<{ status: string }>(
      `select status from public.membership_policy_versions where id = $1`,
      [demo.id],
    );
    expect(retired.status).toBe('superseded');

    // And it no longer governs anything: the enrolment gate reads the version
    // in force, which is now nothing, and fails shut.
    const governing = await queryOne<{ id: string | null }>(
      `select public.active_membership_policy_id() as id`,
    );
    expect(governing.id).toBeNull();
    const allows = await queryOne<{ allowed: boolean }>(
      `select public.membership_policy_allows(public.active_membership_policy_id(), 'enrolment') as allowed`,
    );
    expect(allows.allowed).toBe(false);

    // The row is still there, still readable, still carrying what it promised.
    const residue = await describeResidue(db);
    expect(residue.demonstration_policies).toBeGreaterThan(0);
    expect(residue.active_demonstration_policies).toBe(0);
  });

  it('is repeatable: running it again on an empty database is a no-op', async () => {
    const first = await countBusinessRows(db);
    await runCleanSlate(db, { ownerProfileId, dryRun: false });
    const second = await countBusinessRows(db);
    expect(second).toEqual(first);
  }, 120_000);

  // ======================================================================
  // The business, started from scratch on the database the cleanup left
  // ======================================================================
  //
  // The point of a clean slate is that somebody can work on it. These run
  // after the cleanup, against the emptied database, as the one Owner — so
  // they prove the end state is not merely tidy but operable.

  describe('the Owner starts the business on the cleaned database', () => {
    let clientId: string;
    let loanId: string;
    let firstReceipt: string;

    it('registers a client with identity, guarantor and the relationship', async () => {
      // Next of kin is not a column on `clients`: for a borrower it is the
      // guarantor's `relationship_to_client`, and for a member it is a
      // beneficiary row. V1 lends, so the guarantor and the relationship are
      // what a loan is actually assessed against.
      const branch = await queryOne<{ id: string }>(
        'select id from public.branches order by created_at limit 1',
      );

      const registered = await asUserCommitted(ownerSession, [
        {
          sql: `insert into public.clients
                  (full_name, sex, date_of_birth, phone, occupation,
                   village_area, district, status, branch_id)
                values ('Launch Borrower', 'female', '1992-04-11', $1, 'Trader',
                        'Kalerwe', 'Kampala', 'active', $2)
                returning id`,
          params: ['+256772900001', branch.id],
        },
      ]);
      expect(registered.ok, registered.message).toBe(true);
      clientId = registered.rows?.[0]?.id as string;

      // Identity, guarantor and the link, each as the Owner.
      const rest = await asUserCommitted(ownerSession, [
        {
          sql: `insert into public.client_identities (client_id, nin) values ($1, $2)`,
          params: [clientId, 'CF90123456LAUN'],
        },
        {
          sql: `insert into public.guarantors
                  (full_name, sex, date_of_birth, phone, occupation, location, photo_path)
                values ('Launch Guarantor', 'male', '1986-02-02', $1, 'Teacher',
                        'Bweyogerere', 'guarantors/00000000-0000-4000-8000-00000000090a/photo/a.jpg')
                returning id`,
          params: ['+256772900003'],
        },
      ]);
      expect(rest.ok, rest.message).toBe(true);
      const guarantorId = rest.rows?.[0]?.id as string;

      const linked = await asUserCommitted(ownerSession, [
        {
          sql: `insert into public.guarantor_identities (guarantor_id, nin) values ($1, $2)`,
          params: [guarantorId, 'CM86020212GUAR'],
        },
        {
          sql: `insert into public.client_guarantors
                  (client_id, guarantor_id, relationship_to_client)
                values ($1, $2, 'Brother')`,
          params: [clientId, guarantorId],
        },
      ]);
      expect(linked.ok, linked.message).toBe(true);

      // The client number comes from the reset counter: the first one.
      const client = await queryOne<{ client_number: string }>(
        'select client_number from public.clients where id = $1',
        [clientId],
      );
      expect(client.client_number).toMatch(/1$/);

      // The guarantor is linked, with the relationship recorded.
      const link = await queryOne<{ relationship_to_client: string }>(
        `select relationship_to_client from public.client_guarantors
          where client_id = $1 and active`,
        [clientId],
      );
      expect(link.relationship_to_client).toBe('Brother');
    });

    it('creates, approves and disburses a loan, and gets a schedule', async () => {
      loanId = await createDraftLoan(clientId, { principal: 600_000 });
      const actors = {
        secretary: { authUserId: ownerSession.authUserId },
        manager: { authUserId: ownerSession.authUserId },
        owner: { authUserId: ownerSession.authUserId },
      } as never;

      await submitLoan(loanId, actors);
      await approveLoan(loanId, actors);
      await disburseApprovedLoan(loanId, actors);

      const loan = await queryOne<{ status: string; loan_number: string }>(
        'select status, loan_number from public.loans where id = $1',
        [loanId],
      );
      expect(loan.status).toBe('active');
      expect(loan.loan_number).toMatch(/1$/);

      const schedule = await queryOne<{ n: string }>(
        'select count(*)::text as n from public.loan_schedules where loan_id = $1',
        [loanId],
      );
      expect(Number(schedule.n)).toBeGreaterThan(0);
    });

    it('takes a partial repayment, issues a receipt and reduces the balance', async () => {
      const owed = await readLedger(loanId);
      expect(owed.totalOutstanding).toBeGreaterThan(0);

      const part = Math.floor(owed.totalOutstanding / 3);
      const posted = await asUserCommitted(ownerSession, [
        {
          sql: 'select public.post_payment($1, $2, $3, null, $4) as id',
          params: [loanId, part, 'cash', newIdempotencyKey()],
        },
      ]);
      expect(posted.ok, posted.message).toBe(true);

      const receipt = await queryOne<{ payment_number: string }>(
        'select payment_number from public.loan_payments where id = $1',
        [posted.rows?.[0]?.id],
      );
      expect(receipt.payment_number).toMatch(/1$/);
      firstReceipt = receipt.payment_number;

      // Still owing, and owing exactly what it was less the payment.
      const after = await readLedger(loanId);
      expect(after.status).toBe('active');
      expect(after.totalOutstanding).toBe(owed.totalOutstanding - part);
      expect(after.totalCollected).toBe(part);
    });

    it('refuses a duplicate repayment without taking the money twice', async () => {
      const before = await readLedger(loanId);
      const key = newIdempotencyKey();

      const first = await asUserCommitted(ownerSession, [
        {
          sql: 'select public.post_payment($1, $2, $3, null, $4) as id',
          params: [loanId, 10_000, 'cash', key],
        },
      ]);
      expect(first.ok, first.message).toBe(true);

      // The same key again: the existing payment comes back, no second row.
      const replay = await asUserCommitted(ownerSession, [
        {
          sql: 'select public.post_payment($1, $2, $3, null, $4) as id',
          params: [loanId, 10_000, 'cash', key],
        },
      ]);
      expect(replay.ok, replay.message).toBe(true);
      expect(replay.rows?.[0]?.id).toBe(first.rows?.[0]?.id);

      const after = await readLedger(loanId);
      expect(after.totalCollected).toBe(before.totalCollected + 10_000);
      expect(after.postedPaymentCount).toBe(before.postedPaymentCount + 1);
    });

    it('refuses an invalid repayment', async () => {
      const owed = await readLedger(loanId);

      // More than the loan owes.
      const tooMuch = await asUser(
        ownerSession,
        'select public.post_payment($1, $2, $3, null, $4)',
        [loanId, owed.totalOutstanding + 500_000, 'cash', newIdempotencyKey()],
      );
      expect(tooMuch.ok).toBe(false);

      // Nothing at all.
      const zero = await asUser(
        ownerSession,
        'select public.post_payment($1, $2, $3, null, $4)',
        [loanId, 0, 'cash', newIdempotencyKey()],
      );
      expect(zero.ok).toBe(false);

      // The loan is untouched by either refusal.
      const after = await readLedger(loanId);
      expect(after.totalCollected).toBe(owed.totalCollected);
    });

    it('reports balances and arrears, and the figures agree with the loan', async () => {
      const ledger = await readLedger(loanId);

      // The portfolio view and the loan agree on what is owed.
      const portfolio = await queryOne<{ outstanding: string }>(
        `select coalesce(sum(total_outstanding), 0)::text as outstanding
           from public.loan_balances where loan_id = $1`,
        [loanId],
      );
      expect(Number(portfolio.outstanding)).toBe(ledger.totalOutstanding);

      // And the books balance, with real postings in them now.
      const books = await queryOne<{ debits: string; credits: string; entries: string }>(
        `select coalesce(sum(debit), 0)::text as debits,
                coalesce(sum(credit), 0)::text as credits,
                (select count(*)::text from public.journal_entries) as entries
           from public.journal_lines`,
      );
      expect(Number(books.entries)).toBeGreaterThan(0);
      expect(Number(books.debits)).toBe(Number(books.credits));
    });

    it('closes the loan on the final repayment', async () => {
      const owed = await readLedger(loanId);
      const settled = await asUserCommitted(ownerSession, [
        {
          sql: 'select public.post_payment($1, $2, $3, null, $4) as id',
          params: [loanId, owed.totalOutstanding, 'cash', newIdempotencyKey()],
        },
      ]);
      expect(settled.ok, settled.message).toBe(true);

      const closed = await readLedger(loanId);
      expect(closed.status).toBe('cleared');
      expect(closed.totalOutstanding).toBe(0);
      expect(closed.fullyRepaid).toBe(true);

      // Every receipt issued is still readable, including the first.
      const receipts = await query<{ payment_number: string }>(
        `select payment_number from public.loan_payments
          where loan_id = $1 order by payment_number`,
        [loanId],
      );
      expect(receipts.map((r) => r.payment_number)).toContain(firstReceipt);
    });

    it('refuses an unauthorised session everything it should', async () => {
      // A borrower with no capability over this loan.
      const borrower = await createTestUser('client');

      const readLoan = await asUser(
        borrower,
        'select count(*)::int as n from public.loans where id = $1',
        [loanId],
      );
      expect(readLoan.ok).toBe(true);
      expect(readLoan.rows?.[0]?.n).toBe(0);

      const pay = await asUser(
        borrower,
        'select public.post_payment($1, $2, $3, null, $4)',
        [loanId, 1_000, 'cash', newIdempotencyKey()],
      );
      expect(pay.ok).toBe(false);

      const anonymous = await asAnon('select count(*)::int as n from public.clients');
      expect(anonymous.ok === false || anonymous.rows?.[0]?.n === 0).toBe(true);
    });
  });
});
