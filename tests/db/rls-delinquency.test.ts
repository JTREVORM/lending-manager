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
  createLoanScenario,
  deleteTestLoans,
  type LoanScenario,
} from '../helpers/loan-fixtures';
import { deleteTestPayments, postPayment } from '../helpers/payment-fixtures';
import {
  businessInstant,
  createFourThousandLoan,
  deleteTestPenalties,
  ensurePenalty,
  readPenalty,
  restoreSeededLendingTerms,
  type FourThousandLoan,
} from '../helpers/delinquency-fixtures';
import { closePool, hasDatabase, query, skipReason } from '../helpers/db';

/**
 * Delinquency and penalty Row Level Security, attacked directly.
 *
 * Every statement runs as a real database role with a real JWT subject, as a
 * request arriving at PostgREST would. Nothing goes through the application,
 * so nothing here depends on a screen hiding a panel.
 *
 * The questions are concrete. Can an anonymous visitor read the overdue book?
 * Can a borrower read another borrower's arrears, or their charge? Can any
 * role create, edit or delete a penalty? Can a staff member without
 * `delinquency:view` browse the directory? And do the derived views agree
 * with the tables they are built from, for the right reason — because the
 * reader's own policies applied, rather than because an aggregate silently
 * summed rows it should not have seen?
 */
const describeDb = hasDatabase ? describe : describe.skip;

if (!hasDatabase) {
  describe('delinquency RLS suite', () => {
    it.skip(`skipped — ${skipReason}`, () => undefined);
  });
}

const VIEWS = [
  'loan_delinquency',
  'loan_penalty_coverage',
  'loan_obligations',
  'loan_balances',
] as const;

describeDb('delinquency row level security', () => {
  let scenario: LoanScenario;
  let otherScenario: LoanScenario;
  let borrower: TestUser;
  let otherBorrower: TestUser;
  let unprivileged: TestUser;

  let ownLoan: FourThousandLoan;
  let otherLoan: FourThousandLoan;
  let ownPenaltyId: string;

  beforeAll(async () => {
    await deleteTestPayments();
    await deleteTestPenalties();
    await deleteTestLoans();
    await deleteTestUsers();

    scenario = await createLoanScenario();
    otherScenario = await createLoanScenario();

    borrower = await createTestUser('client');
    otherBorrower = await createTestUser('client');
    // A signed-in person with a login and no capabilities at all.
    unprivileged = await createTestUser('client');

    await query(`select public.link_client_profile($1, $2)`, [
      scenario.clientId,
      borrower.profileId,
    ]);
    await query(`select public.link_client_profile($1, $2)`, [
      otherScenario.clientId,
      otherBorrower.profileId,
    ]);

    ownLoan = await createFourThousandLoan(scenario);
    otherLoan = await createFourThousandLoan(otherScenario);

    // The borrower's loan carries a real charge, so there is something to
    // attack rather than an empty table.
    await postPayment(ownLoan.loanId, scenario.secretary, {
      amount: ownLoan.scheduledTotal - 100_000,
      businessNow: businessInstant(ownLoan.firstDue),
    });
    await ensurePenalty(ownLoan.loanId, businessInstant(ownLoan.penaltyEffective));

    const penalty = await readPenalty(ownLoan.loanId);
    if (penalty === null) throw new Error('expected a penalty for the RLS suite');
    ownPenaltyId = penalty.penaltyId;

    await ensurePenalty(otherLoan.loanId, businessInstant(otherLoan.penaltyEffective));
  });

  afterAll(async () => {
    await deleteTestPayments();
    await deleteTestPenalties();
    await deleteTestLoans();
    await deleteTestUsers();
    await restoreSeededLendingTerms();
    await closePool();
  });

  // =========================================================================
  describe('an anonymous visitor', () => {
    it.each(['loan_penalties', ...VIEWS])('reads nothing from %s', async (relation) => {
      const result = await asAnon(`select * from public.${relation}`);

      // Either refused outright or filtered to nothing. Both are closed;
      // what must never happen is a row coming back.
      expect(result.rows, relation).toEqual([]);
    });

    it('cannot reach a penalty by naming it', async () => {
      const result = await asAnon(`select * from public.loan_penalties where id = $1`, [
        ownPenaltyId,
      ]);

      expect(result.rows).toEqual([]);
    });

    it('cannot count what it cannot read', async () => {
      // A count leaks the size of the overdue book even when no row comes
      // back, so it is checked separately.
      for (const relation of ['loan_penalties', 'loan_delinquency']) {
        const result = await asAnon(`select count(*)::text as n from public.${relation}`);

        expect(result.ok ? Number(result.rows[0]?.n ?? 0) : 0, relation).toBe(0);
      }
    });

    it('cannot call the delinquency functions', async () => {
      for (const statement of [
        `select public.ensure_penalty_applied(gen_random_uuid())`,
        `select public.apply_eligible_penalties()`,
        `select public.business_date()`,
        `select public.business_now()`,
        `select public.loan_total_outstanding(gen_random_uuid())`,
        `select public.loan_outstanding_as_of(gen_random_uuid(), current_date)`,
        `select public.is_table_owner_session()`,
      ]) {
        const result = await asAnon(statement);
        expect(result.ok, statement).toBe(false);
      }
    });
  });

  // =========================================================================
  describe('a borrower', () => {
    it('reads their own delinquency position', async () => {
      const result = await asUser(
        borrower,
        `select loan_number, arrears_amount::text as arrears,
                total_outstanding::text as total, delinquency_state
           from public.loan_delinquency`,
      );

      expect(result.ok).toBe(true);
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0]?.delinquency_state).toBe('penalty_due');
      // Their own loan, with the figures that belong to it.
      expect(result.rows[0]?.total).toBe('150000');
    });

    it('reads their own penalty, without any capability', async () => {
      // A charge against somebody's account that they cannot see is not a
      // position this system takes: it is the figure they are asked to pay.
      const result = await asUser(
        borrower,
        `select penalty_amount::text as amount, basis_amount::text as basis,
                penalty_rate_bps::text as rate
           from public.loan_penalties`,
      );

      expect(result.ok).toBe(true);
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0]?.amount).toBe('50000');
      expect(result.rows[0]?.basis).toBe('100000');
    });

    it('reads nothing of another borrower, even by naming it', async () => {
      const position = await asUser(
        borrower,
        `select * from public.loan_delinquency where loan_id = $1`,
        [otherLoan.loanId],
      );
      expect(position.rows).toEqual([]);

      const penalty = await asUser(
        borrower,
        `select * from public.loan_penalties where loan_id = $1`,
        [otherLoan.loanId],
      );
      expect(penalty.rows).toEqual([]);

      const coverage = await asUser(
        borrower,
        `select * from public.loan_penalty_coverage where loan_id = $1`,
        [otherLoan.loanId],
      );
      expect(coverage.rows).toEqual([]);
    });

    it('cannot widen the view by dropping the WHERE clause', async () => {
      for (const relation of VIEWS) {
        const result = await asUser(borrower, `select * from public.${relation}`);

        expect(result.ok, relation).toBe(true);
        // Exactly their own loan, whatever they select.
        for (const row of result.rows) {
          expect(row.loan_id, relation).toBe(ownLoan.loanId);
        }
      }
    });

    it('cannot aggregate across the book', async () => {
      // The attack a derived view invites: sum everything and read the
      // portfolio. `security_invoker` means the sum is over their own rows.
      const result = await asUser(
        borrower,
        `select count(*)::text as n,
                coalesce(sum(total_outstanding), 0)::text as total
           from public.loan_delinquency`,
      );

      expect(result.rows[0]?.n).toBe('1');
      expect(result.rows[0]?.total).toBe('150000');
    });

    it('cannot create, change or delete a penalty', async () => {
      const insert = await asUser(
        borrower,
        `insert into public.loan_penalties
           (loan_id, client_id, final_due_date, grace_period_days, grace_end_date,
            effective_date, basis_amount, penalty_rate_bps, penalty_amount)
         values ($1, $2, current_date, 3, current_date + 3, current_date + 4,
                 100000, 5000, 50000)`,
        [ownLoan.loanId, scenario.clientId],
      );
      expect(insert.ok).toBe(false);

      const update = await asUser(
        borrower,
        `update public.loan_penalties set penalty_amount = 0 where id = $1`,
        [ownPenaltyId],
      );
      expect(update.ok).toBe(false);

      const remove = await asUser(
        borrower,
        `delete from public.loan_penalties where id = $1`,
        [ownPenaltyId],
      );
      expect(remove.ok).toBe(false);

      // And the charge is exactly as it was.
      expect((await readPenalty(ownLoan.loanId))?.penaltyAmount).toBe(50_000);
    });

    it('cannot materialise a penalty on anybody"s loan', async () => {
      for (const loanId of [ownLoan.loanId, otherLoan.loanId]) {
        const result = await asUser(
          borrower,
          `select public.ensure_penalty_applied($1)`,
          [loanId],
        );

        expect(result.ok, loanId).toBe(false);
      }
    });

    it('cannot forge a business date to bring a charge forward', async () => {
      // The clock override is gated on the connection owning the tables.
      // Through PostgREST a caller cannot set a parameter at all; this
      // asserts the gate itself is closed to a session role.
      const result = await asUser(borrower, `select public.is_table_owner_session()`);

      expect(result.ok).toBe(false);
    });
  });

  // =========================================================================
  describe('a signed-in person with no delinquency capability', () => {
    it('reads no other borrower"s arrears', async () => {
      // `unprivileged` holds the client role and is linked to nothing, so
      // neither the capability clause nor the ownership clause admits them.
      const result = await asUser(unprivileged, `select * from public.loan_delinquency`);

      expect(result.ok).toBe(true);
      expect(result.rows).toEqual([]);
    });

    it('reads no penalty at all', async () => {
      const result = await asUser(unprivileged, `select * from public.loan_penalties`);

      expect(result.rows).toEqual([]);
    });
  });

  // =========================================================================
  describe('staff', () => {
    it.each([
      ['secretary_treasurer', 'secretary'],
      ['manager', 'manager'],
      ['owner_admin', 'owner'],
    ] as const)('reads the overdue book as %s', async (_role, key) => {
      const actor = scenario[key];

      const result = await asUser(
        actor,
        `select count(*)::text as n from public.loan_delinquency`,
      );

      expect(result.ok).toBe(true);
      // Both loans, not just their own: the capability admits the directory.
      expect(Number(result.rows[0]?.n ?? 0)).toBeGreaterThanOrEqual(2);
    });

    it.each([
      ['secretary_treasurer', 'secretary'],
      ['manager', 'manager'],
      ['owner_admin', 'owner'],
    ] as const)('reads penalties as %s', async (_role, key) => {
      const actor = scenario[key];

      const result = await asUser(
        actor,
        `select count(*)::text as n from public.loan_penalties`,
      );

      expect(result.ok).toBe(true);
      expect(Number(result.rows[0]?.n ?? 0)).toBeGreaterThanOrEqual(2);
    });

    it.each([
      ['secretary_treasurer', 'secretary'],
      ['manager', 'manager'],
      ['owner_admin', 'owner'],
    ] as const)('cannot write a penalty as %s', async (_role, key) => {
      const actor = scenario[key];

      const insert = await asUser(
        actor,
        `insert into public.loan_penalties
           (loan_id, client_id, final_due_date, grace_period_days, grace_end_date,
            effective_date, basis_amount, penalty_rate_bps, penalty_amount)
         values ($1, $2, current_date, 3, current_date + 3, current_date + 4,
                 100000, 5000, 50000)`,
        [otherLoan.loanId, otherScenario.clientId],
      );

      expect(insert.ok).toBe(false);

      const update = await asUser(
        actor,
        `update public.loan_penalties set penalty_amount = 1 where id = $1`,
        [ownPenaltyId],
      );
      expect(update.ok).toBe(false);

      const remove = await asUser(
        actor,
        `delete from public.loan_penalties where id = $1`,
        [ownPenaltyId],
      );
      expect(remove.ok).toBe(false);
    });

    it('cannot materialise a penalty, not even as the Owner', async () => {
      // The Owner may reverse a payment, which is the most consequential
      // financial act in the system — and still may not decide that a
      // borrower owes a charge. That is the rule's job.
      const result = await asUser(
        scenario.owner,
        `select public.ensure_penalty_applied($1)`,
        [otherLoan.loanId],
      );

      expect(result.ok).toBe(false);
    });

    it('reads a balance that agrees with the borrower"s own', async () => {
      // The two must agree, and for the right reason: the same derivation
      // over the same rows, not a staff view that counts something extra.
      const staffView = await asUser(
        scenario.secretary,
        `select total_outstanding::text as total, penalty_remaining::text as penalty,
                arrears_amount::text as arrears, days_past_due::text as days
           from public.loan_delinquency where loan_id = $1`,
        [ownLoan.loanId],
      );

      const borrowerView = await asUser(
        borrower,
        `select total_outstanding::text as total, penalty_remaining::text as penalty,
                arrears_amount::text as arrears, days_past_due::text as days
           from public.loan_delinquency where loan_id = $1`,
        [ownLoan.loanId],
      );

      expect(borrowerView.rows[0]).toEqual(staffView.rows[0]);
    });
  });

  // =========================================================================
  describe('the privileged client', () => {
    it('can read everything, which is why nothing depends on hiding it', async () => {
      const result = await asServiceRole(
        `select count(*)::text as n from public.loan_penalties`,
      );

      expect(result.ok).toBe(true);
      expect(Number(result.rows[0]?.n ?? 0)).toBeGreaterThanOrEqual(2);
    });

    it('still cannot change or delete a penalty', async () => {
      // The append-only triggers bind `service_role` too, which is the
      // leaked-key threat model these triggers exist for.
      const update = await asServiceRole(
        `update public.loan_penalties set penalty_amount = 1 where id = $1`,
        [ownPenaltyId],
      );

      expect(update.ok).toBe(false);
      expect(update.message).toMatch(/append-only/);

      const remove = await asServiceRole(
        `delete from public.loan_penalties where id = $1`,
        [ownPenaltyId],
      );

      expect(remove.ok).toBe(false);
      expect(remove.message).toMatch(/append-only/);
    });

    it('still cannot store a forged charge', async () => {
      const insert = await asServiceRole(
        `insert into public.loan_penalties
           (loan_id, client_id, final_due_date, grace_period_days, grace_end_date,
            effective_date, basis_amount, penalty_rate_bps, penalty_amount)
         values ($1, $2, current_date, 3, current_date + 3, current_date + 4,
                 100000, 5000, 999)`,
        [otherLoan.loanId, otherScenario.clientId],
      );

      expect(insert.ok).toBe(false);
      expect(insert.message).toMatch(/loan_penalties_amount_matches_basis/);
    });

    it('still cannot clear a loan with a charge outstanding', async () => {
      const result = await asServiceRole(
        `update public.loans set status = 'cleared' where id = $1`,
        [ownLoan.loanId],
      );

      expect(result.ok).toBe(false);
      expect(result.message).toMatch(/still outstanding, penalty included/);
    });
  });

  // =========================================================================
  describe('privileges and policies, stated exhaustively', () => {
    it('grants authenticated nothing but SELECT on the penalty table', async () => {
      const rows = await query<{ privilege_type: string }>(
        `select privilege_type from information_schema.role_table_grants
          where table_schema = 'public' and table_name = 'loan_penalties'
            and grantee = 'authenticated'
          order by privilege_type`,
      );

      expect(rows.map((row) => row.privilege_type)).toEqual(['SELECT']);
    });

    it('grants anon nothing on the penalty table or any delinquency view', async () => {
      const rows = await query<{ table_name: string; privilege_type: string }>(
        `select table_name, privilege_type from information_schema.role_table_grants
          where table_schema = 'public' and grantee = 'anon'
            and table_name in ('loan_penalties', 'loan_delinquency',
                               'loan_penalty_coverage', 'loan_obligations')`,
      );

      expect(rows).toEqual([]);
    });

    it('defines exactly one policy on the penalty table, for SELECT', async () => {
      const rows = await query<{ policyname: string; cmd: string }>(
        `select policyname, cmd from pg_policies
          where schemaname = 'public' and tablename = 'loan_penalties'
          order by policyname`,
      );

      expect(rows).toEqual([
        { policyname: 'loan_penalties_select_with_loan', cmd: 'SELECT' },
      ]);
    });

    it('has row level security enabled on the penalty table', async () => {
      const rows = await query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
        `select c.relrowsecurity, c.relforcerowsecurity
           from pg_class c join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'public' and c.relname = 'loan_penalties'`,
      );

      expect(rows[0]?.relrowsecurity).toBe(true);
    });

    it('sets security_invoker on every delinquency view', async () => {
      for (const view of VIEWS) {
        const rows = await query<{ invoker: string | null }>(
          `select (select option_value from pg_options_to_table(c.reloptions)
                    where option_name = 'security_invoker') as invoker
             from pg_class c join pg_namespace n on n.oid = c.relnamespace
            where n.nspname = 'public' and c.relname = $1`,
          [view],
        );

        // Without it a view runs as its owner and hands the whole portfolio
        // to anybody who can select from it.
        expect(rows[0]?.invoker, view).toBe('true');
      }
    });

    it('gives no session role EXECUTE on the penalty writers', async () => {
      for (const [fn, expected] of [
        ['ensure_penalty_applied', false],
        ['apply_eligible_penalties', false],
        ['is_table_owner_session', false],
        // The read-only helpers are granted, and take no date that could
        // change what is posted.
        ['business_date', true],
        ['business_now', true],
        ['business_timezone', true],
        ['loan_total_outstanding', true],
        ['loan_penalty_outstanding', true],
        ['loan_outstanding_as_of', true],
        ['payment_business_date', true],
      ] as const) {
        const rows = await query<{ can_execute: boolean }>(
          `select coalesce(bool_or(has_function_privilege('authenticated', p.oid, 'execute')),
                           false) as can_execute
             from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.proname = $1`,
          [fn],
        );

        expect(rows[0]?.can_execute, fn).toBe(expected);
      }
    });

    it('gives anon EXECUTE on nothing in this phase', async () => {
      for (const fn of [
        'ensure_penalty_applied',
        'apply_eligible_penalties',
        'is_table_owner_session',
        'business_date',
        'business_now',
        'business_timezone',
        'loan_total_outstanding',
        'loan_penalty_outstanding',
        'loan_outstanding_as_of',
        'payment_business_date',
      ]) {
        const rows = await query<{ can_execute: boolean }>(
          `select coalesce(bool_or(has_function_privilege('anon', p.oid, 'execute')),
                           false) as can_execute
             from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.proname = $1`,
          [fn],
        );

        expect(rows[0]?.can_execute, fn).toBe(false);
      }
    });
  });
});
