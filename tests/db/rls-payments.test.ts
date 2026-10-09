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
  createDraftLoan,
  createLoanScenario,
  deleteTestLoans,
  disburseLoan,
  type LoanScenario,
} from '../helpers/loan-fixtures';
import {
  deleteTestPayments,
  postPayment,
  reversePayment,
} from '../helpers/payment-fixtures';
import { closePool, hasDatabase, query, queryOne, skipReason } from '../helpers/db';

/**
 * Payment Row Level Security, attacked directly.
 *
 * Every statement runs as a real database role with a real JWT subject, as a
 * request arriving at PostgREST would. Nothing goes through the application,
 * so nothing here depends on a screen hiding a button.
 *
 * The questions are concrete. Can an anonymous visitor read the ledger? Can a
 * borrower read another borrower's receipt? Can a borrower post their own
 * payment? Does the balance a borrower reads agree with the one staff read —
 * and does it agree for the *right* reason, rather than because allocations
 * were silently filtered out from under the aggregate?
 */
const describeDb = hasDatabase ? describe : describe.skip;

if (!hasDatabase) {
  describe('payment RLS suite', () => {
    it.skip(`skipped — ${skipReason}`, () => undefined);
  });
}

describeDb('payment row level security', () => {
  let scenario: LoanScenario;
  let borrower: TestUser;
  let otherBorrower: TestUser;

  let ownLoan: string;
  let otherLoan: string;
  let ownPayment: string;
  let otherPayment: string;
  let reversedPayment: string;

  beforeAll(async () => {
    await deleteTestPayments();
    await deleteTestLoans();
    await deleteTestUsers();

    scenario = await createLoanScenario();
    borrower = await createTestUser('client');
    otherBorrower = await createTestUser('client');

    await query(`select public.link_client_profile($1, $2)`, [
      scenario.clientId,
      borrower.profileId,
    ]);

    ownLoan = await createDraftLoan(scenario.clientId, {
      principal: 100_000,
      termMonths: 1,
      frequency: 'every_3_days',
    });
    await disburseLoan(ownLoan, scenario);

    ownPayment = await postPayment(ownLoan, scenario.secretary, { amount: 11_500 });
    reversedPayment = await postPayment(ownLoan, scenario.secretary, {
      amount: 11_500,
    });
    await reversePayment(reversedPayment, scenario.owner, 'reversed for the RLS suite');

    // A second borrower, with their own loan and payment, belonging to nobody
    // in this test's client role.
    const otherScenario = await createLoanScenario();
    otherLoan = await createDraftLoan(otherScenario.clientId, {
      principal: 100_000,
      termMonths: 1,
      frequency: 'every_3_days',
    });
    await disburseLoan(otherLoan, otherScenario);
    otherPayment = await postPayment(otherLoan, otherScenario.secretary, {
      amount: 11_500,
    });
  });

  afterAll(async () => {
    await deleteTestPayments();
    await deleteTestLoans();
    await deleteTestUsers();
    await closePool();
  });

  // =========================================================================
  describe('an anonymous visitor', () => {
    it.each([
      'loan_payments',
      'payment_allocations',
      'loan_balances',
      'loan_installment_coverage',
      'payment_collection_totals',
    ])('reads nothing from %s', async (relation) => {
      const result = await asAnon(`select * from public.${relation}`);

      // Either refused outright or filtered to nothing. Both are closed; what
      // must never happen is a row coming back.
      expect(result.rows, relation).toEqual([]);
    });

    it('cannot reach a payment by naming it', async () => {
      const result = await asAnon(`select * from public.loan_payments where id = $1`, [
        ownPayment,
      ]);

      expect(result.rows).toEqual([]);
    });

    it('cannot count what it cannot read', async () => {
      // A count leaks the size of the business's book even when no row comes
      // back, so it is checked separately.
      const result = await asAnon(`select count(*)::text as n from public.loan_payments`);

      expect(result.ok ? Number(result.rows[0]?.n ?? 0) : 0).toBe(0);
    });

    it('cannot call the ledger functions', async () => {
      for (const statement of [
        `select public.post_payment(gen_random_uuid(), 1, 'cash', null, gen_random_uuid(), null)`,
        `select public.reverse_payment(gen_random_uuid(), 'because')`,
      ]) {
        const result = await asAnon(statement);
        expect(result.ok, statement.slice(0, 32)).toBe(false);
      }
    });
  });

  // =========================================================================
  describe('a borrower', () => {
    it('reads their own payments', async () => {
      const result = await asUser(
        borrower,
        `select payment_number, amount, status from public.loan_payments
          order by received_at`,
      );

      expect(result.ok).toBe(true);
      // Both of theirs: the posted one and the reversed one.
      expect(result.rows).toHaveLength(2);
    });

    it('reads their own reversed payment, marked as such', async () => {
      // The worst possible outcome for a borrower holding a withdrawn receipt
      // is a portal showing no trace of it.
      const result = await asUser(
        borrower,
        `select status, reversal_reason from public.loan_payments where id = $1`,
        [reversedPayment],
      );

      expect(result.rows).toHaveLength(1);
      expect(result.rows[0]?.status).toBe('reversed');
    });

    it('reads nothing of another borrower"s payments', async () => {
      const result = await asUser(
        borrower,
        `select * from public.loan_payments where id = $1`,
        [otherPayment],
      );

      expect(result.rows).toEqual([]);
    });

    it('cannot widen the query to see the whole ledger', async () => {
      // The attack a borrower would actually try: drop the WHERE clause.
      const result = await asUser(
        borrower,
        `select distinct loan_id::text as loan_id from public.loan_payments`,
      );

      expect(result.rows.map((row) => row.loan_id)).toEqual([ownLoan]);
    });

    it('reads their own allocations, and only those', async () => {
      const result = await asUser(
        borrower,
        `select distinct loan_id::text as loan_id from public.payment_allocations`,
      );

      expect(result.rows.map((row) => row.loan_id)).toEqual([ownLoan]);
    });

    it('reads their own balance, and it agrees with what staff read', async () => {
      // This is the assertion that makes the allocation delegation
      // load-bearing. The balance views aggregate allocations, so if a
      // borrower could read a payment but not its allocations, their balance
      // would be silently *higher* than the truth — and they would be asked
      // for money they had already paid.
      const theirs = await asUser(
        borrower,
        `select total_outstanding::text as outstanding, total_paid::text as total_paid
           from public.loan_balances where loan_id = $1`,
        [ownLoan],
      );

      const staff = await asUser(
        scenario.secretary,
        `select total_outstanding::text as outstanding, total_paid::text as total_paid
           from public.loan_balances where loan_id = $1`,
        [ownLoan],
      );

      expect(theirs.rows).toHaveLength(1);
      expect(theirs.rows[0]).toEqual(staff.rows[0]);
      // And it is the right figure: one posted payment of 11,500 counts, the
      // reversed one does not.
      expect(theirs.rows[0]?.total_paid).toBe('11500');
      expect(theirs.rows[0]?.outstanding).toBe('103500');
    });

    it('reads no other borrower"s balance', async () => {
      const result = await asUser(
        borrower,
        `select loan_id::text as loan_id from public.loan_balances
          where loan_id = $1`,
        [otherLoan],
      );

      expect(result.rows).toEqual([]);
    });

    it('is not admitted by an unrelated login', async () => {
      // `otherBorrower` has a login but no linked client, so the self-clause
      // has nothing to match and must not fall open.
      const result = await asUser(otherBorrower, `select * from public.loan_payments`);

      expect(result.rows).toEqual([]);
    });

    it('cannot post a payment of their own', async () => {
      const result = await asUser(
        borrower,
        `select public.post_payment($1, 11500, 'cash', null, gen_random_uuid(), null)`,
        [ownLoan],
      );

      expect(result.ok).toBe(false);
      expect(result.message).toMatch(/payments:create/i);
    });

    it('cannot reverse a payment', async () => {
      const result = await asUser(
        borrower,
        `select public.reverse_payment($1, 'I would rather not have paid')`,
        [ownPayment],
      );

      expect(result.ok).toBe(false);
      expect(result.message).toMatch(/payments:reverse/i);
    });

    it('cannot write anything to the ledger', async () => {
      for (const statement of [
        `update public.loan_payments set amount = 1 where id = $1`,
        `delete from public.loan_payments where id = $1`,
        `update public.payment_allocations set allocated_amount = 1 where payment_id = $1`,
        `delete from public.payment_allocations where payment_id = $1`,
      ]) {
        const result = await asUser(borrower, statement, [ownPayment]);
        expect(result.ok, statement.slice(0, 44)).toBe(false);
      }
    });

    it('cannot read the collection totals for the whole business', async () => {
      // Their own payments are theirs; the day's takings are not. The view
      // aggregates every posted payment, so under `security_invoker` a
      // borrower sees only rows their own payments contribute to.
      const result = await asUser(
        borrower,
        `select total_amount::text as total from public.payment_collection_totals`,
      );

      const total = result.rows.reduce((sum, row) => sum + Number(row.total ?? 0), 0);

      // At most their own posted payment, never the other borrower's.
      expect(total).toBeLessThanOrEqual(11_500);
    });
  });

  // =========================================================================
  describe('a signed-in user without the capability', () => {
    it('reads no payment at all', async () => {
      const result = await asUser(otherBorrower, `select * from public.loan_payments`);

      expect(result.rows).toEqual([]);
    });

    it('cannot reach one by naming its loan', async () => {
      const result = await asUser(
        otherBorrower,
        `select * from public.loan_payments where loan_id = $1`,
        [ownLoan],
      );

      expect(result.rows).toEqual([]);
    });
  });

  // =========================================================================
  describe('the Secretary/Treasurer', () => {
    it('reads the whole register', async () => {
      const result = await asUser(
        scenario.secretary,
        `select distinct loan_id::text as loan_id from public.loan_payments`,
      );

      const loans = result.rows.map((row) => row.loan_id);
      expect(loans).toContain(ownLoan);
      expect(loans).toContain(otherLoan);
    });

    it('may post a payment', async () => {
      const other = await createLoanScenario();
      const loanId = await createDraftLoan(other.clientId, {
        principal: 100_000,
        termMonths: 1,
        frequency: 'every_3_days',
      });
      await disburseLoan(loanId, other);

      const result = await asUser(
        other.secretary,
        `select public.post_payment($1, 11500, 'cash', null, gen_random_uuid(), null)`,
        [loanId],
      );

      expect(result.ok).toBe(true);
    });

    it('may not reverse one', async () => {
      const result = await asUser(
        scenario.secretary,
        `select public.reverse_payment($1, 'should not be permitted')`,
        [ownPayment],
      );

      expect(result.ok).toBe(false);
      expect(result.message).toMatch(/payments:reverse/i);
    });

    it('reads every balance', async () => {
      const result = await asUser(
        scenario.secretary,
        `select count(*)::text as n from public.loan_balances where scheduled_total > 0`,
      );

      expect(Number(result.rows[0]?.n ?? 0)).toBeGreaterThan(1);
    });
  });

  // =========================================================================
  describe('the Manager', () => {
    it('reads the whole register', async () => {
      const result = await asUser(
        scenario.manager,
        `select distinct loan_id::text as loan_id from public.loan_payments`,
      );

      expect(result.rows.map((row) => row.loan_id)).toContain(otherLoan);
    });

    it('may post a payment', async () => {
      const other = await createLoanScenario();
      const loanId = await createDraftLoan(other.clientId, {
        principal: 100_000,
        termMonths: 1,
        frequency: 'every_3_days',
      });
      await disburseLoan(loanId, other);

      const result = await asUser(
        other.manager,
        `select public.post_payment($1, 11500, 'cash', null, gen_random_uuid(), null)`,
        [loanId],
      );

      expect(result.ok).toBe(true);
    });

    it('may not reverse one — the phase"s central control', async () => {
      const result = await asUser(
        scenario.manager,
        `select public.reverse_payment($1, 'should not be permitted')`,
        [ownPayment],
      );

      expect(result.ok).toBe(false);
      expect(result.message).toMatch(/payments:reverse/i);
    });
  });

  // =========================================================================
  describe('the Owner/Administrator', () => {
    it('reads the whole register', async () => {
      const result = await asUser(
        scenario.owner,
        `select distinct loan_id::text as loan_id from public.loan_payments`,
      );

      expect(result.rows.map((row) => row.loan_id)).toContain(otherLoan);
    });

    it('may reverse a payment', async () => {
      const other = await createLoanScenario();
      const loanId = await createDraftLoan(other.clientId, {
        principal: 100_000,
        termMonths: 1,
        frequency: 'every_3_days',
      });
      await disburseLoan(loanId, other);
      const target = await postPayment(loanId, other.secretary, { amount: 11_500 });

      const result = await asUser(
        other.owner,
        `select public.reverse_payment($1, 'reversed in the RLS suite')`,
        [target],
      );

      expect(result.ok).toBe(true);
    });

    it('still cannot edit or delete history', async () => {
      for (const statement of [
        `update public.loan_payments set amount = 1 where id = $1`,
        `delete from public.loan_payments where id = $1`,
        `update public.payment_allocations set allocated_amount = 1 where payment_id = $1`,
      ]) {
        const result = await asUser(scenario.owner, statement, [ownPayment]);
        expect(result.ok, statement.slice(0, 44)).toBe(false);
      }
    });
  });

  // =========================================================================
  describe('privileges and policies, stated exhaustively', () => {
    it('grants authenticated nothing but SELECT on the ledger', async () => {
      const rows = await query<{ table_name: string; privilege_type: string }>(
        `select table_name, privilege_type
           from information_schema.role_table_grants
          where table_schema = 'public'
            and grantee = 'authenticated'
            and table_name in ('loan_payments', 'payment_allocations')
          order by table_name, privilege_type`,
      );

      expect(rows.map((row) => `${row.table_name}:${row.privilege_type}`)).toEqual([
        'loan_payments:SELECT',
        'payment_allocations:SELECT',
      ]);
    });

    it('grants anon nothing at all', async () => {
      const rows = await query<{ table_name: string }>(
        `select table_name from information_schema.role_table_grants
          where table_schema = 'public' and grantee = 'anon'
            and table_name in ('loan_payments', 'payment_allocations',
                               'loan_balances', 'loan_installment_coverage',
                               'payment_collection_totals')`,
      );

      expect(rows).toEqual([]);
    });

    it('defines exactly one SELECT policy per table and no write policy', async () => {
      const rows = await query<{ tablename: string; cmd: string }>(
        `select tablename, cmd from pg_policies
          where schemaname = 'public'
            and tablename in ('loan_payments', 'payment_allocations')
          order by tablename, cmd`,
      );

      expect(rows.map((row) => `${row.tablename}:${row.cmd}`)).toEqual([
        'loan_payments:SELECT',
        'payment_allocations:SELECT',
      ]);
    });

    it('gates the payment policy on the capability and delegates to the loan', async () => {
      const row = await queryOne<{ qual: string }>(
        `select qual from pg_policies
          where schemaname = 'public' and tablename = 'loan_payments'`,
      );

      expect(row.qual).toMatch(/FROM \(?loans l\b/);
      expect(row.qual).toContain('payments:view');
      expect(row.qual).toContain('current_profile_id');
    });

    it('delegates the allocation policy entirely to the payment", with no capability of its own', async () => {
      // Load-bearing rather than lax: the balance views aggregate
      // allocations, so making the two visibilities one visibility is what
      // stops a role reading an under-reported balance.
      const row = await queryOne<{ qual: string }>(
        `select qual from pg_policies
          where schemaname = 'public' and tablename = 'payment_allocations'`,
      );

      expect(row.qual).toMatch(/FROM loan_payments lp\b/);
      expect(row.qual).not.toContain('user_has_permission');
    });

    it('has row level security enabled on both tables', async () => {
      const rows = await query<{ relname: string; relrowsecurity: boolean }>(
        `select c.relname, c.relrowsecurity
           from pg_class c join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'public'
            and c.relname in ('loan_payments', 'payment_allocations')
          order by c.relname`,
      );

      expect(rows).toEqual([
        { relname: 'loan_payments', relrowsecurity: true },
        { relname: 'payment_allocations', relrowsecurity: true },
      ]);
    });

    it('sets security_invoker on every balance view', async () => {
      // Without it a view runs as its owner and hands every row to anybody who
      // can select from it — a complete bypass of every policy above.
      const rows = await query<{ relname: string; invoker: string | null }>(
        `select c.relname,
                (select option_value from pg_options_to_table(c.reloptions)
                  where option_name = 'security_invoker') as invoker
           from pg_class c join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'public' and c.relkind = 'v'
          order by c.relname`,
      );

      // Phase 6 added three; Phase 7 adds `loan_penalty_coverage`,
      // `loan_obligations` and `loan_delinquency`; Phase 8 adds the five
      // reporting views; Phase 9 adds `company_identity`; Phase 10 adds the
      // three ledger views; Phase 11 adds four document registers and the
      // general ledger. Named rather than
      // counted, so a new view cannot be waved through by bumping a number —
      // and the loop below requires every one that touches a borrower or a
      // figure to set `security_invoker`, which is what keeps a reporting view
      // from becoming a complete Row Level Security bypass.
      //
      // `company_identity` is the one exception and is excluded from the
      // loop, not from the list: it holds the company's own name, locale and
      // logo, no borrower, no money and no row choice. The reason is stated
      // in full in tests/db/security.test.ts, which asserts its column list.
      expect(rows.map((row) => row.relname)).toEqual([
        // Phase 10 adds the three ledger views.
        'branch_cash_position',
        'collections_today',
        'company_identity',
        'dashboard_collection_summary',
        'dashboard_portfolio_summary',
        'expense_register',
        'general_ledger',
        'income_register',
        'ledger_account_balances',
        'loan_balances',
        'loan_delinquency',
        'loan_installment_coverage',
        'loan_obligations',
        'loan_penalty_coverage',
        'loan_portfolio_report',
        'payment_collection_totals',
        'payment_register',
        'reconciliation_register',
        'transfer_register',
        'trial_balance',
      ]);

      for (const row of rows) {
        if (row.relname === 'company_identity') continue;
        expect(row.invoker, row.relname).toBe('true');
      }
    });
  });

  // =========================================================================
  describe('the privileged client', () => {
    it('can read everything, which is why nothing reaches it from a browser', async () => {
      const result = await asServiceRole(
        `select count(*)::text as count from public.loan_payments`,
      );

      expect(result.ok).toBe(true);
    });

    it('still cannot rewrite a payment', async () => {
      const result = await asServiceRole(
        `update public.loan_payments set amount = 1 where id = $1`,
        [ownPayment],
      );

      expect(result.ok).toBe(false);
      expect(result.message).toMatch(/cannot be altered/i);
    });

    it('still cannot record a payment, because it is nobody', async () => {
      const result = await asServiceRole(
        `select public.post_payment($1, 11500, 'cash', null, gen_random_uuid(), null)`,
        [ownLoan],
      );

      expect(result.ok).toBe(false);
      expect(result.message).toMatch(/signed-in member of staff/i);
    });
  });
});
