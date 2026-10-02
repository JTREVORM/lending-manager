import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  asAnon,
  asServiceRole,
  asUser,
  createTestUser,
  deleteTestUsers,
  type TestUser,
} from '../helpers/auth-fixtures';
import {
  approveLoan,
  createDraftLoan,
  createLoanScenario,
  deleteTestLoans,
  disburseLoan,
  type LoanScenario,
} from '../helpers/loan-fixtures';
import { closePool, hasDatabase, query, queryOne, skipReason } from '../helpers/db';

/**
 * Schedule Row Level Security, attacked directly.
 *
 * Every statement runs as a real database role with a real JWT subject, as a
 * request arriving at PostgREST would. Nothing goes through the application,
 * so nothing here depends on a screen hiding a button.
 *
 * The questions are concrete. Can an anonymous visitor read a collection
 * schedule? Can a borrower read another borrower's? Can a Secretary change a
 * due date? Can the Owner rewrite history? Can a schedule be reached by a
 * staff member whose capability was deliberately withheld?
 */
const describeDb = hasDatabase ? describe : describe.skip;

if (!hasDatabase) {
  describe('schedule RLS suite', () => {
    it.skip(`skipped — ${skipReason}`, () => undefined);
  });
}

describeDb('repayment schedule row level security', () => {
  let scenario: LoanScenario;
  let borrower: TestUser;
  let otherBorrower: TestUser;
  let noCapability: TestUser;

  let ownLoan: string;
  let otherLoan: string;
  let approvedLoan: string;

  beforeAll(async () => {
    await deleteTestLoans();
    await deleteTestUsers();

    scenario = await createLoanScenario();
    borrower = await createTestUser('client');
    otherBorrower = await createTestUser('client');

    // A staff login with no schedule capability, to prove the policy gates on
    // the capability rather than merely on being signed in. The `client` role
    // holds no loan capability either, which is the closest the fixed role
    // set gets to "signed in but not entitled".
    noCapability = await createTestUser('client');

    await query(`select public.link_client_profile($1, $2)`, [
      scenario.clientId,
      borrower.profileId,
    ]);

    ownLoan = await createDraftLoan(scenario.clientId, {
      principal: 200_000,
      termMonths: 2,
    });
    await disburseLoan(ownLoan, scenario);

    // A second client, with their own schedule, belonging to nobody in this
    // test's client role.
    const otherScenario = await createLoanScenario();
    otherLoan = await createDraftLoan(otherScenario.clientId, {
      principal: 300_000,
      termMonths: 1,
    });
    await disburseLoan(otherLoan, otherScenario);

    // Approved but not disbursed: no schedule should exist at all.
    const approvedScenario = await createLoanScenario();
    approvedLoan = await createDraftLoan(approvedScenario.clientId);
    await approveLoan(approvedLoan, approvedScenario);
  });

  afterAll(async () => {
    await deleteTestLoans();
    await deleteTestUsers();
    await closePool();
  });

  // =========================================================================
  describe('an anonymous visitor', () => {
    it.each(['loan_installments', 'loan_schedules'])(
      'reads nothing from %s',
      async (table) => {
        const result = await asAnon(`select * from public.${table}`);

        // Either refused outright or filtered to nothing. Both are closed;
        // what must never happen is a row coming back.
        expect(result.rows, table).toEqual([]);
      },
    );

    it('cannot reach a schedule by naming its loan', async () => {
      const result = await asAnon(
        `select * from public.loan_installments where loan_id = $1`,
        [ownLoan],
      );

      expect(result.rows).toEqual([]);
    });

    it('cannot count what it cannot read', async () => {
      // A count leaks the existence and size of a schedule even when the rows
      // do not come back, so it is checked separately.
      const result = await asAnon(
        `select count(*)::text as n from public.loan_installments`,
      );

      expect(result.ok ? Number(result.rows[0]?.n ?? 0) : 0).toBe(0);
    });
  });

  // =========================================================================
  describe('a borrower', () => {
    it('reads their own schedule', async () => {
      const result = await asUser(
        borrower,
        `select installment_number, due_date, expected_amount
           from public.loan_installments where loan_id = $1
          order by installment_number`,
        [ownLoan],
      );

      expect(result.ok).toBe(true);
      // 200,000 over two months daily is 59 to 61 collections depending on
      // which months it spans. The point is that they see it.
      expect(result.rows.length).toBeGreaterThan(50);
    });

    it('reads their own generation record', async () => {
      const result = await asUser(
        borrower,
        `select interval_days from public.loan_schedules where loan_id = $1`,
        [ownLoan],
      );

      expect(result.rows).toHaveLength(1);
    });

    it('reads nothing of another borrower"s schedule', async () => {
      const result = await asUser(
        borrower,
        `select * from public.loan_installments where loan_id = $1`,
        [otherLoan],
      );

      expect(result.rows).toEqual([]);
    });

    it('cannot widen the query to see everything', async () => {
      // The attack a borrower would actually try: drop the WHERE clause.
      const result = await asUser(
        borrower,
        `select distinct loan_id from public.loan_installments`,
      );

      expect(result.rows.map((row) => row.loan_id)).toEqual([ownLoan]);
    });

    it('is not admitted to an unrelated borrower"s schedule by their own linkage', async () => {
      // `otherBorrower` has a login but is linked to no client, so the
      // self-clause has nothing to match and must not fall open.
      const result = await asUser(
        otherBorrower,
        `select * from public.loan_installments`,
      );

      expect(result.rows).toEqual([]);
    });

    it('cannot write anything', async () => {
      for (const statement of [
        `update public.loan_installments set expected_amount = 1 where loan_id = $1`,
        `delete from public.loan_installments where loan_id = $1`,
        `update public.loan_schedules set interval_days = 3 where loan_id = $1`,
        `delete from public.loan_schedules where loan_id = $1`,
      ]) {
        const result = await asUser(borrower, statement, [ownLoan]);
        expect(result.ok, statement.slice(0, 45)).toBe(false);
      }
    });

    it('sees no internal field that is not theirs to see', async () => {
      // A borrower reading their own schedule must not reach staff
      // attribution through it.
      const result = await asUser(
        borrower,
        `select generated_by from public.loan_schedules where loan_id = $1`,
        [ownLoan],
      );

      // The column is readable — hiding a column is not something PostgreSQL
      // can do per role — so what matters is that it names a profile the
      // borrower cannot resolve to a person. The identity policies from
      // Phase 2 are what enforce that, and this asserts they still do.
      expect(result.ok).toBe(true);

      const staffProfiles = await asUser(
        borrower,
        `select id from public.profiles where id = $1`,
        [scenario.owner.profileId],
      );

      expect(staffProfiles.rows).toEqual([]);
    });
  });

  // =========================================================================
  describe('a signed-in user without the capability', () => {
    it('reads no schedule at all', async () => {
      const result = await asUser(noCapability, `select * from public.loan_installments`);

      expect(result.rows).toEqual([]);
    });

    it('cannot reach one by naming its loan', async () => {
      const result = await asUser(
        noCapability,
        `select * from public.loan_installments where loan_id = $1`,
        [ownLoan],
      );

      expect(result.rows).toEqual([]);
    });
  });

  // =========================================================================
  describe('the Secretary/Treasurer', () => {
    it('reads every operational schedule, which is the document they collect from', async () => {
      const result = await asUser(
        scenario.secretary,
        `select distinct loan_id from public.loan_installments`,
      );

      expect(result.ok).toBe(true);
      const loans = result.rows.map((row) => row.loan_id);
      expect(loans).toContain(ownLoan);
      expect(loans).toContain(otherLoan);
    });

    it('cannot change a due date', async () => {
      const result = await asUser(
        scenario.secretary,
        `update public.loan_installments set due_date = due_date + 1 where loan_id = $1`,
        [ownLoan],
      );

      expect(result.ok).toBe(false);
    });

    it('cannot change an amount', async () => {
      const result = await asUser(
        scenario.secretary,
        `update public.loan_installments set expected_amount = 1 where loan_id = $1`,
        [ownLoan],
      );

      expect(result.ok).toBe(false);
    });

    it('cannot insert a collection of their own', async () => {
      const result = await asUser(
        scenario.secretary,
        `insert into public.loan_installments
           (loan_id, loan_period_id, loan_period_number, installment_number,
            period_installment_number, due_date, scheduled_principal,
            scheduled_interest, expected_amount)
         select $1, lp.id, 1, 8001, 8001, current_date + 900, 1, 0, 1
           from public.loan_periods lp where lp.loan_id = $1 limit 1`,
        [ownLoan],
      );

      expect(result.ok).toBe(false);
    });

    it('cannot delete a collection', async () => {
      const result = await asUser(
        scenario.secretary,
        `delete from public.loan_installments where loan_id = $1`,
        [ownLoan],
      );

      expect(result.ok).toBe(false);
    });
  });

  // =========================================================================
  describe('the Manager', () => {
    it('reads every schedule', async () => {
      const result = await asUser(
        scenario.manager,
        `select distinct loan_id from public.loan_installments`,
      );

      const loans = result.rows.map((row) => row.loan_id);
      expect(loans).toContain(ownLoan);
      expect(loans).toContain(otherLoan);
    });

    it('cannot rewrite an amount', async () => {
      const result = await asUser(
        scenario.manager,
        `update public.loan_installments set expected_amount = 99 where loan_id = $1`,
        [ownLoan],
      );

      expect(result.ok).toBe(false);
    });
  });

  // =========================================================================
  describe('the Owner/Administrator', () => {
    it('reads every schedule', async () => {
      const result = await asUser(
        scenario.owner,
        `select distinct loan_id from public.loan_installments`,
      );

      const loans = result.rows.map((row) => row.loan_id);
      expect(loans).toContain(ownLoan);
      expect(loans).toContain(otherLoan);
    });

    it('cannot silently edit history either', async () => {
      // Owner authority is about what the business may decide, not about
      // rewriting what it already decided. There is no application path to
      // amending a schedule for anybody.
      for (const statement of [
        `update public.loan_installments set due_date = due_date + 7 where loan_id = $1`,
        `update public.loan_installments set expected_amount = 0 where loan_id = $1`,
        `delete from public.loan_installments where loan_id = $1`,
        `update public.loan_schedules set interval_days = 3 where loan_id = $1`,
        `delete from public.loan_schedules where loan_id = $1`,
      ]) {
        const result = await asUser(scenario.owner, statement, [ownLoan]);
        expect(result.ok, statement.slice(0, 50)).toBe(false);
      }
    });
  });

  // =========================================================================
  describe('an approved loan with no schedule', () => {
    it('has none, for anybody', async () => {
      for (const actor of [scenario.secretary, scenario.manager, scenario.owner]) {
        const result = await asUser(
          actor,
          `select * from public.loan_installments where loan_id = $1`,
          [approvedLoan],
        );

        expect(result.rows).toEqual([]);
      }

      const header = await queryOne<{ n: string }>(
        `select count(*)::text as n from public.loan_schedules where loan_id = $1`,
        [approvedLoan],
      );

      expect(Number(header.n)).toBe(0);
    });
  });

  // =========================================================================
  describe('privileges and policies, stated exhaustively', () => {
    it('grants authenticated nothing but SELECT on either table', async () => {
      const rows = await query<{ table_name: string; privilege_type: string }>(
        `select table_name, privilege_type
           from information_schema.role_table_grants
          where table_schema = 'public'
            and grantee = 'authenticated'
            and table_name in ('loan_installments', 'loan_schedules')
          order by table_name, privilege_type`,
      );

      expect(rows.map((row) => `${row.table_name}:${row.privilege_type}`)).toEqual([
        'loan_installments:SELECT',
        'loan_schedules:SELECT',
      ]);
    });

    it('grants anon nothing at all', async () => {
      const rows = await query<{ table_name: string }>(
        `select table_name from information_schema.role_table_grants
          where table_schema = 'public' and grantee = 'anon'
            and table_name in ('loan_installments', 'loan_schedules')`,
      );

      expect(rows).toEqual([]);
    });

    it('defines exactly one SELECT policy per table and no write policy', async () => {
      const rows = await query<{ tablename: string; cmd: string; policyname: string }>(
        `select tablename, cmd, policyname from pg_policies
          where schemaname = 'public'
            and tablename in ('loan_installments', 'loan_schedules')
          order by tablename, cmd`,
      );

      expect(rows.map((row) => `${row.tablename}:${row.cmd}`)).toEqual([
        'loan_installments:SELECT',
        'loan_schedules:SELECT',
      ]);
    });

    it('gates both policies on the capability and delegates to the loan', async () => {
      // Delegation rather than restatement: a second copy of the loans rule
      // could drift from the original and quietly widen access. Asserted
      // explicitly rather than left to a regex.
      const rows = await query<{ tablename: string; qual: string }>(
        `select tablename, qual from pg_policies
          where schemaname = 'public'
            and tablename in ('loan_installments', 'loan_schedules')`,
      );

      expect(rows).toHaveLength(2);

      for (const row of rows) {
        // PostgreSQL normalises `public.loans` to `loans` and parenthesises
        // the join, so the stored text reads `FROM (loans l JOIN clients c`.
        expect(row.qual, `${row.tablename} delegates to loans`).toMatch(
          /FROM \(?loans l\b/,
        );
        expect(row.qual, `${row.tablename} checks the capability`).toContain(
          'schedules:view',
        );
        expect(row.qual, `${row.tablename} admits the borrower`).toContain(
          'current_profile_id',
        );
      }
    });

    it('has row level security enabled on both tables', async () => {
      const rows = await query<{ relname: string; relrowsecurity: boolean }>(
        `select c.relname, c.relrowsecurity
           from pg_class c join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'public'
            and c.relname in ('loan_installments', 'loan_schedules')
          order by c.relname`,
      );

      expect(rows).toEqual([
        { relname: 'loan_installments', relrowsecurity: true },
        { relname: 'loan_schedules', relrowsecurity: true },
      ]);
    });
  });

  // =========================================================================
  describe('the privileged client', () => {
    it('can read everything, which is why nothing reaches it from a browser', async () => {
      const result = await asServiceRole(
        `select count(*)::text as count from public.loan_installments`,
      );

      expect(result.ok).toBe(true);
    });

    it('still cannot rewrite a collection plan', async () => {
      // The threat model the statement-level triggers exist for. A leaked
      // secret key reads; it does not rewrite what a borrower owes.
      const result = await asServiceRole(
        `update public.loan_installments set expected_amount = 0 where loan_id = $1`,
        [ownLoan],
      );

      expect(result.ok).toBe(false);
      expect(result.message).toMatch(/append-only/i);
    });
  });
});
