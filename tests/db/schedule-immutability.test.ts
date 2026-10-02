import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { asAnon, asServiceRole, asUser, deleteTestUsers } from '../helpers/auth-fixtures';
import {
  createDraftLoan,
  createLoanScenario,
  deleteTestLoans,
  disburseLoan,
  type LoanScenario,
} from '../helpers/loan-fixtures';
import { closePool, hasDatabase, query, queryOne, skipReason } from '../helpers/db';

/**
 * The collection schedule is contractual history.
 *
 * Phase 7 will treat an unpaid collection as arrears. The temptation at that
 * point is to rewrite the row — a missed Monday of UGX 4,000 becoming a
 * Tuesday of UGX 8,000. That would destroy the only record of what the
 * borrower actually agreed to collect on, in exactly the dispute the record
 * exists for. So the schedule is append-only now, before anything needs to
 * rewrite it, and these tests are what stop a later phase quietly finding a
 * way.
 *
 * Every attempt below runs as a real database role. The privileged client is
 * included deliberately: a leaked `service_role` key is the threat model the
 * statement-level triggers exist for, and "the application would never do
 * that" is not a control.
 */
const describeDb = hasDatabase ? describe : describe.skip;

if (!hasDatabase) {
  describe('schedule immutability suite', () => {
    it.skip(`skipped — ${skipReason}`, () => undefined);
  });
}

describeDb('repayment schedule immutability', () => {
  let scenario: LoanScenario;
  let activeLoan: string;
  let installmentId: string;
  let originalDueDate: string;
  let originalAmount: string;

  beforeAll(async () => {
    await deleteTestLoans();
    await deleteTestUsers();

    scenario = await createLoanScenario();
    activeLoan = await createDraftLoan(scenario.clientId, {
      principal: 600_000,
      termMonths: 3,
      frequency: 'daily',
    });

    await disburseLoan(activeLoan, scenario);

    const row = await queryOne<{
      id: string;
      due_date: string;
      expected_amount: string;
    }>(
      `select id, due_date::text as due_date, expected_amount::text as expected_amount
         from public.loan_installments
        where loan_id = $1 order by installment_number limit 1`,
      [activeLoan],
    );

    installmentId = row.id;
    originalDueDate = row.due_date;
    originalAmount = row.expected_amount;
  });

  afterAll(async () => {
    await deleteTestLoans();
    await deleteTestUsers();
    await closePool();
  });

  // =========================================================================
  describe('the contractual fields cannot be changed', () => {
    it.each([
      ['due_date', `due_date = due_date + 1`],
      ['expected_amount', `expected_amount = 1`],
      ['scheduled_principal', `scheduled_principal = 1`],
      ['scheduled_interest', `scheduled_interest = 1`],
      ['loan_period_id', `loan_period_id = gen_random_uuid()`],
      ['loan_period_number', `loan_period_number = 9`],
      ['installment_number', `installment_number = 999`],
      ['loan_id', `loan_id = gen_random_uuid()`],
    ])('refuses to change %s, even as the privileged client', async (_, setClause) => {
      const result = await asServiceRole(
        `update public.loan_installments set ${setClause} where id = $1`,
        [installmentId],
      );

      expect(result.ok).toBe(false);
      expect(result.message).toMatch(/append-only/i);
    });

    it('refuses an update whose WHERE clause matches nothing', async () => {
      // Statement-level, so the refusal does not depend on the attacker's
      // predicate finding a row. A row-level trigger would let
      // `update ... where loan_id = <wrong id>` succeed silently and look
      // like it had worked.
      const result = await asServiceRole(
        `update public.loan_installments set expected_amount = 0
          where loan_id = '00000000-0000-4000-8000-00000000dead'`,
      );

      expect(result.ok).toBe(false);
      expect(result.message).toMatch(/append-only/i);
    });

    it('refuses a blanket update across the whole table', async () => {
      const result = await asServiceRole(
        `update public.loan_installments set expected_amount = 0`,
      );

      expect(result.ok).toBe(false);
    });

    it('leaves the row genuinely unchanged after every attempt', async () => {
      // The attempts above were *reported* as refused. This checks they
      // actually were.
      const row = await queryOne<{ due_date: string; expected_amount: string }>(
        `select due_date::text as due_date, expected_amount::text as expected_amount
           from public.loan_installments where id = $1`,
        [installmentId],
      );

      expect(row.due_date).toBe(originalDueDate);
      expect(row.expected_amount).toBe(originalAmount);
    });
  });

  // =========================================================================
  describe('the generation record cannot be changed', () => {
    it.each([
      ['interval_days', `interval_days = 3`],
      ['disbursement_date', `disbursement_date = current_date`],
      ['repayment_frequency', `repayment_frequency = 'every_3_days'`],
      ['frequency_label', `frequency_label = 'Rewritten'`],
      ['generated_by', `generated_by = null`],
      ['generator_version', `generator_version = 2`],
    ])('refuses to change %s', async (_, setClause) => {
      const result = await asServiceRole(
        `update public.loan_schedules set ${setClause} where loan_id = $1`,
        [activeLoan],
      );

      expect(result.ok).toBe(false);
      expect(result.message).toMatch(/append-only/i);
    });
  });

  // =========================================================================
  describe('nothing can be deleted', () => {
    it('refuses to delete one installment, as the privileged client', async () => {
      const result = await asServiceRole(
        `delete from public.loan_installments where id = $1`,
        [installmentId],
      );

      expect(result.ok).toBe(false);
      expect(result.message).toMatch(/append-only/i);
    });

    it('refuses to delete a whole loan"s schedule', async () => {
      const result = await asServiceRole(
        `delete from public.loan_installments where loan_id = $1`,
        [activeLoan],
      );

      expect(result.ok).toBe(false);
    });

    it('refuses to delete every schedule in the system', async () => {
      const result = await asServiceRole(`delete from public.loan_installments`);
      expect(result.ok).toBe(false);
    });

    it('refuses to delete the generation record', async () => {
      const result = await asServiceRole(
        `delete from public.loan_schedules where loan_id = $1`,
        [activeLoan],
      );

      expect(result.ok).toBe(false);
    });

    it('leaves every row in place after every deletion attempt', async () => {
      const row = await queryOne<{ n: string }>(
        `select count(*)::text as n from public.loan_installments where loan_id = $1`,
        [activeLoan],
      );

      // A three-month daily loan: 90 or 91, depending on which months it
      // spans. The point is that nothing went.
      expect(Number(row.n)).toBeGreaterThan(85);
    });
  });

  // =========================================================================
  describe('no application role can write a schedule at all', () => {
    it.each([
      ['secretary', 'secretary'],
      ['manager', 'manager'],
      ['owner', 'owner'],
    ] as const)('refuses an insert by the %s', async (_, role) => {
      const actor = scenario[role];

      const result = await asUser(
        actor,
        `insert into public.loan_installments
           (loan_id, loan_period_id, loan_period_number, installment_number,
            period_installment_number, due_date, scheduled_principal,
            scheduled_interest, expected_amount)
         select $1, lp.id, 1, 9999, 9999, current_date + 400, 1, 0, 1
           from public.loan_periods lp where lp.loan_id = $1 limit 1`,
        [activeLoan],
      );

      expect(result.ok).toBe(false);
    });

    it.each([
      ['secretary', 'secretary'],
      ['manager', 'manager'],
      ['owner', 'owner'],
    ] as const)('refuses an update by the %s', async (_, role) => {
      const result = await asUser(
        scenario[role],
        `update public.loan_installments set expected_amount = 1 where id = $1`,
        [installmentId],
      );

      expect(result.ok).toBe(false);
    });

    it.each([
      ['secretary', 'secretary'],
      ['manager', 'manager'],
      ['owner', 'owner'],
    ] as const)('refuses a delete by the %s', async (_, role) => {
      const result = await asUser(
        scenario[role],
        `delete from public.loan_installments where id = $1`,
        [installmentId],
      );

      expect(result.ok).toBe(false);
    });

    it('refuses everything from an anonymous visitor', async () => {
      for (const statement of [
        `insert into public.loan_installments
           (loan_id, loan_period_id, loan_period_number, installment_number,
            period_installment_number, due_date, scheduled_principal,
            scheduled_interest, expected_amount)
         values (gen_random_uuid(), gen_random_uuid(), 1, 1, 1, current_date, 1, 0, 1)`,
        `update public.loan_installments set expected_amount = 0`,
        `delete from public.loan_installments`,
        `insert into public.loan_schedules
           (loan_id, repayment_frequency, frequency_label, interval_days,
            disbursement_date, business_timezone)
         values (gen_random_uuid(), 'daily', 'Daily', 1, current_date, 'Africa/Kampala')`,
      ]) {
        const result = await asAnon(statement);
        expect(result.ok, statement.slice(0, 50)).toBe(false);
      }
    });

    it('gives no session role the privilege to generate a schedule directly', async () => {
      // Not a narrow grant guarded by a capability check — no grant at all.
      // The only legitimate caller is `disburse_loan`, which runs as the
      // table owner.
      for (const role of ['anon', 'authenticated']) {
        const row = await queryOne<{ can_execute: boolean }>(
          `select coalesce(
                    bool_or(has_function_privilege($1, p.oid, 'execute')), false
                  ) as can_execute
             from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.proname = 'generate_loan_schedule'`,
          [role],
        );

        expect(row.can_execute, role).toBe(false);
      }
    });

    it('refuses the owner calling the generator directly over the API', async () => {
      // Even the Owner, who holds every loan capability including
      // `loans:disburse`. The privilege simply is not there.
      const result = await asUser(
        scenario.owner,
        `select public.generate_loan_schedule($1)`,
        [activeLoan],
      );

      expect(result.ok).toBe(false);
      expect(result.message).toMatch(/permission denied|does not exist/i);
    });
  });

  // =========================================================================
  describe('the structural guards', () => {
    it('refuses two collections on the same day for one loan', async () => {
      // The upper-exclusive period boundary exists to stop a date belonging
      // to two adjacent months. This constraint is the backstop: a future
      // change that reintroduced that bug would fail here rather than
      // silently doubling a borrower's Monday.
      const existing = await queryOne<{
        loan_period_id: string;
        due_date: string;
      }>(
        `select loan_period_id, due_date::text as due_date
           from public.loan_installments where loan_id = $1
          order by installment_number limit 1`,
        [activeLoan],
      );

      await expect(
        query(
          `insert into public.loan_installments
             (loan_id, loan_period_id, loan_period_number, installment_number,
              period_installment_number, due_date, scheduled_principal,
              scheduled_interest, expected_amount)
           values ($1, $2, 1, 9001, 9001, $3, 1, 0, 1)`,
          [activeLoan, existing.loan_period_id, existing.due_date],
        ),
      ).rejects.toThrow(/loan_installments_unique_due_date/);
    });

    it('refuses a duplicate installment number within a loan', async () => {
      const existing = await queryOne<{ loan_period_id: string }>(
        `select loan_period_id from public.loan_installments where loan_id = $1 limit 1`,
        [activeLoan],
      );

      await expect(
        query(
          `insert into public.loan_installments
             (loan_id, loan_period_id, loan_period_number, installment_number,
              period_installment_number, due_date, scheduled_principal,
              scheduled_interest, expected_amount)
           values ($1, $2, 1, 1, 9002, current_date + 500, 1, 0, 1)`,
          [activeLoan, existing.loan_period_id],
        ),
      ).rejects.toThrow(/loan_installments_unique_number/);
    });

    it('refuses an expected amount that is not its two components', async () => {
      const existing = await queryOne<{ loan_period_id: string }>(
        `select loan_period_id from public.loan_installments where loan_id = $1 limit 1`,
        [activeLoan],
      );

      await expect(
        query(
          `insert into public.loan_installments
             (loan_id, loan_period_id, loan_period_number, installment_number,
              period_installment_number, due_date, scheduled_principal,
              scheduled_interest, expected_amount)
           values ($1, $2, 1, 9003, 9003, current_date + 501, 100, 50, 999)`,
          [activeLoan, existing.loan_period_id],
        ),
      ).rejects.toThrow(/loan_installments_expected_follows/);
    });

    it('refuses a negative component', async () => {
      const existing = await queryOne<{ loan_period_id: string }>(
        `select loan_period_id from public.loan_installments where loan_id = $1 limit 1`,
        [activeLoan],
      );

      await expect(
        query(
          `insert into public.loan_installments
             (loan_id, loan_period_id, loan_period_number, installment_number,
              period_installment_number, due_date, scheduled_principal,
              scheduled_interest, expected_amount)
           values ($1, $2, 1, 9004, 9004, current_date + 502, -1, 2, 1)`,
          [activeLoan, existing.loan_period_id],
        ),
      ).rejects.toThrow(/loan_installments_principal_non_negative/);
    });

    it('refuses a second schedule for one loan', async () => {
      await expect(
        query(
          `insert into public.loan_schedules
             (loan_id, repayment_frequency, frequency_label, interval_days,
              disbursement_date, business_timezone)
           values ($1, 'daily', 'Daily', 1, current_date, 'Africa/Kampala')`,
          [activeLoan],
        ),
      ).rejects.toThrow(/loan_schedules_pkey/);
    });
  });

  // =========================================================================
  describe('no payment state exists to be faked', () => {
    it('carries no amount_paid, balance, arrears or status column', async () => {
      // Phase 5 knows nothing about payments. A column holding zero would be
      // a fact about this phase written where a reader would take it as a
      // fact about a borrower.
      const columns = await query<{ column_name: string }>(
        `select column_name from information_schema.columns
          where table_schema = 'public'
            and table_name in ('loan_installments', 'loan_schedules')`,
      );

      const names = columns.map((row) => row.column_name);

      for (const forbidden of [
        'amount_paid',
        'paid_amount',
        'remaining_balance',
        'outstanding',
        'balance',
        'arrears',
        'arrears_amount',
        'is_paid',
        'paid_at',
        'status',
      ]) {
        expect(names, `${forbidden} must not exist yet`).not.toContain(forbidden);
      }
    });
  });
});
