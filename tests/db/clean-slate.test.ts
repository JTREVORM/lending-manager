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
