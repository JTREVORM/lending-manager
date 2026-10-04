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
  disburseLoan,
  submitLoan,
  type LoanScenario,
} from '../helpers/loan-fixtures';
import { closePool, hasDatabase, query, queryOne, skipReason } from '../helpers/db';

/**
 * Loan Row Level Security, attacked directly.
 *
 * Every statement runs as a real database role with a real JWT subject, as a
 * request arriving at PostgREST would. Nothing goes through the application.
 *
 * The question is not whether the interface hides a control. It is whether
 * somebody holding a valid token can approve their own loan, release money
 * they have no authority to release, read an identity number their role was
 * deliberately denied, or delete a financial record.
 */
const describeDb = hasDatabase ? describe : describe.skip;

if (!hasDatabase) {
  describe('loan RLS suite', () => {
    it.skip(`skipped — ${skipReason}`, () => undefined);
  });
}

describeDb('loan row level security', () => {
  let scenario: LoanScenario;
  let borrower: TestUser;
  let otherBorrower: TestUser;
  let draftLoan: string;
  let pendingLoan: string;
  let activeLoan: string;

  beforeAll(async () => {
    await deleteTestUsers();

    scenario = await createLoanScenario();
    borrower = await createTestUser('client');
    otherBorrower = await createTestUser('client');

    // The borrower's login is linked to the scenario's client, so the
    // self-clause in the policy has something to match.
    await query(`select public.link_client_profile($1, $2)`, [
      scenario.clientId,
      borrower.profileId,
    ]);

    draftLoan = await createDraftLoan(scenario.clientId, {
      principal: 300_000,
      termMonths: 1,
    });

    const pendingScenario = await createLoanScenario();
    pendingLoan = await createDraftLoan(pendingScenario.clientId);
    await submitLoan(pendingLoan, pendingScenario);

    activeLoan = await createDraftLoan(scenario.clientId);
    await disburseLoan(activeLoan, scenario);
  });

  afterAll(async () => {
    await deleteTestUsers();
    await closePool();
  });

  // =========================================================================
  describe('an anonymous visitor', () => {
    it.each([
      'loans',
      'loan_periods',
      'loan_client_snapshots',
      'loan_guarantor_snapshots',
      'loan_identity_snapshots',
    ])('reads nothing from %s', async (table) => {
      const result = await asAnon(`select * from public.${table}`);

      // Either refused outright or filtered to nothing. Both are closed; what
      // must never happen is a row coming back.
      expect(result.rows, table).toEqual([]);
    });

    it('writes nothing, and calls no lifecycle function', async () => {
      const attempts = [
        `insert into public.loans (client_id, principal_amount, interest_rate_bps,
            interest_method, loan_term_months, repayment_frequency,
            min_loan_amount_applied, grace_period_days_applied,
            penalty_rate_bps_applied, proposed_disbursement_date)
          values (gen_random_uuid(), 100000, 1500, 'reducing_balance_monthly', 1,
                  'daily', 100000, 3, 5000, current_date)`,
        `update public.loans set status = 'approved'`,
        `delete from public.loans`,
        `select public.approve_loan(gen_random_uuid())`,
        `select public.disburse_loan(gen_random_uuid())`,
        `select public.cancel_loan(gen_random_uuid(), 'x')`,
        `select public.validate_loan_for_approval(gen_random_uuid())`,
      ];

      for (const sql of attempts) {
        const result = await asAnon(sql);
        expect(result.ok, sql.slice(0, 60)).toBe(false);
      }
    });
  });

  // =========================================================================
  describe('a borrower', () => {
    it('reads their own disbursed loan', async () => {
      const result = await asUser(borrower, `select id from public.loans where id = $1`, [
        activeLoan,
      ]);

      // The policy clause is prepared for the later client portal. No client
      // capability is granted, so this is reachable only through the
      // self-clause and returns exactly their own loan.
      expect(result.rows).toHaveLength(1);
    });

    it('cannot read a draft on their own client record', async () => {
      const result = await asUser(borrower, `select id from public.loans where id = $1`, [
        draftLoan,
      ]);

      // A draft is the business thinking aloud. Showing it would let a
      // borrower watch a loan being considered, and read a review note
      // written about them.
      expect(result.rows).toEqual([]);
    });

    it('cannot read another client’s loan', async () => {
      const result = await asUser(borrower, `select id from public.loans where id = $1`, [
        pendingLoan,
      ]);

      expect(result.rows).toEqual([]);
    });

    it('reads no loans at all when their login is linked to nothing', async () => {
      const result = await asUser(otherBorrower, `select id from public.loans`);
      expect(result.rows).toEqual([]);
    });

    it('cannot create a loan', async () => {
      const result = await asUser(
        borrower,
        `insert into public.loans (client_id, principal_amount, interest_rate_bps,
            interest_method, loan_term_months, repayment_frequency,
            min_loan_amount_applied, grace_period_days_applied,
            penalty_rate_bps_applied, proposed_disbursement_date)
          values ($1, 100000, 1500, 'reducing_balance_monthly', 1, 'daily',
                  100000, 3, 5000, current_date)`,
        [scenario.clientId],
      );

      expect(result.ok).toBe(false);
    });

    it('cannot approve their own loan', async () => {
      const result = await asUser(borrower, `select public.approve_loan($1)`, [
        pendingLoan,
      ]);

      expect(result.ok).toBe(false);
      expect(result.message).toMatch(/loans:approve/);
    });

    it('cannot disburse their own loan', async () => {
      const own = await createLoanScenario();
      const loanId = await createDraftLoan(own.clientId);
      await approveLoan(loanId, own);

      const result = await asUser(borrower, `select public.disburse_loan($1)`, [loanId]);
      expect(result.ok).toBe(false);
    });

    it('cannot cancel their own loan', async () => {
      const result = await asUser(
        borrower,
        `select public.cancel_loan($1, 'I changed my mind')`,
        [activeLoan],
      );

      expect(result.ok).toBe(false);
    });

    it('cannot edit the terms of their own loan', async () => {
      const result = await asUser(
        borrower,
        `update public.loans set principal_amount = 1 where id = $1`,
        [activeLoan],
      );

      // No lifecycle capability, so the UPDATE policy never opens the row.
      expect(result.rowCount).toBe(0);
    });

    it('cannot delete a loan', async () => {
      const result = await asUser(borrower, `delete from public.loans where id = $1`, [
        activeLoan,
      ]);

      expect(result.ok).toBe(false);
      expect(result.code).toBe('42501');
    });

    it('reads their own client snapshot, which is their own details', async () => {
      const result = await asUser(
        borrower,
        `select full_name from public.loan_client_snapshots where loan_id = $1`,
        [activeLoan],
      );

      // Their own name and address as the business recorded it. Seeing it is
      // how an error gets reported.
      expect(result.rows).toHaveLength(1);
    });

    it('reads no guarantor snapshot', async () => {
      const result = await asUser(
        borrower,
        `select full_name from public.loan_guarantor_snapshots`,
      );

      // A guarantor's details are that person's data, disclosed to the lender
      // rather than to the borrower who named them — the same rule Phase 3
      // applied to the live guarantor records.
      expect(result.rows).toEqual([]);
    });

    it('reads no identity snapshot, not even their own number', async () => {
      const result = await asUser(
        borrower,
        `select nin from public.loan_identity_snapshots`,
      );

      expect(result.rows).toEqual([]);
    });

    it('reads the breakdown of their own loan but not of another', async () => {
      const own = await asUser(
        borrower,
        `select period_number from public.loan_periods where loan_id = $1`,
        [activeLoan],
      );
      expect(own.rows.length).toBeGreaterThan(0);

      const other = await asUser(
        borrower,
        `select period_number from public.loan_periods where loan_id = $1`,
        [pendingLoan],
      );
      expect(other.rows).toEqual([]);
    });
  });

  // =========================================================================
  describe('a secretary or treasurer', () => {
    it('reads the register', async () => {
      const result = await asUser(scenario.secretary, `select id from public.loans`);

      expect(result.ok).toBe(true);
      expect(result.rows.length).toBeGreaterThanOrEqual(2);
    });

    it('creates a draft', async () => {
      const own = await createLoanScenario();

      const result = await asUser(
        own.secretary,
        `insert into public.loans (client_id, principal_amount, interest_rate_bps,
            interest_method, loan_term_months, repayment_frequency,
            min_loan_amount_applied, grace_period_days_applied,
            penalty_rate_bps_applied, proposed_disbursement_date)
          values ($1, 300000, 1500, 'reducing_balance_monthly', 1, 'daily',
                  100000, 3, 5000, current_date)
          returning loan_number, status`,
        [own.clientId],
      );

      expect(result.ok).toBe(true);
      expect(result.rows[0]?.loan_number).toMatch(/^LN\d{6}$/);
      expect(result.rows[0]?.status).toBe('draft');
    });

    it('cannot create a loan that arrives already approved', async () => {
      const own = await createLoanScenario();

      const result = await asUser(
        own.secretary,
        `insert into public.loans (client_id, principal_amount, interest_rate_bps,
            interest_method, loan_term_months, repayment_frequency,
            min_loan_amount_applied, grace_period_days_applied,
            penalty_rate_bps_applied, proposed_disbursement_date, status)
          values ($1, 300000, 1500, 'reducing_balance_monthly', 1, 'daily',
                  100000, 3, 5000, current_date, 'approved')`,
        [own.clientId],
      );

      // Otherwise whoever can create a loan could also approve it, skipping
      // review entirely.
      expect(result.ok).toBe(false);
    });

    it('cannot approve', async () => {
      const result = await asUser(scenario.secretary, `select public.approve_loan($1)`, [
        pendingLoan,
      ]);

      expect(result.ok).toBe(false);
      expect(result.message).toMatch(/loans:approve/);
    });

    it('cannot approve by a direct UPDATE either', async () => {
      const result = await asUser(
        scenario.secretary,
        `update public.loans set status = 'approved' where id = $1`,
        [pendingLoan],
      );

      expect(result.ok).toBe(false);
    });

    it('cannot disburse', async () => {
      const own = await createLoanScenario();
      const loanId = await createDraftLoan(own.clientId);
      await approveLoan(loanId, own);

      const result = await asUser(own.secretary, `select public.disburse_loan($1)`, [
        loanId,
      ]);

      expect(result.ok).toBe(false);
      expect(result.message).toMatch(/loans:disburse/);
    });

    it('cannot cancel', async () => {
      const result = await asUser(
        scenario.secretary,
        `select public.cancel_loan($1, 'no longer needed')`,
        [draftLoan],
      );

      expect(result.ok).toBe(false);
      expect(result.message).toMatch(/loans:cancel/);
    });

    it('reads NOT ONE identity snapshot', async () => {
      const result = await asUser(
        scenario.secretary,
        `select nin from public.loan_identity_snapshots`,
      );

      // The reason the snapshots are split. A Secretary reads the register all
      // day; copying identity numbers onto a loan would have handed them every
      // one. There is no query, view or export through which they reach one.
      expect(result.rows).toEqual([]);
    });

    it('reads the breakdown and the non-sensitive snapshots', async () => {
      const periods = await asUser(
        scenario.secretary,
        `select period_number from public.loan_periods where loan_id = $1`,
        [activeLoan],
      );
      expect(periods.rows.length).toBe(3);

      const guarantors = await asUser(
        scenario.secretary,
        `select full_name from public.loan_guarantor_snapshots where loan_id = $1`,
        [activeLoan],
      );
      expect(guarantors.rows.length).toBe(1);
    });
  });

  // =========================================================================
  describe('a manager', () => {
    it('approves a submitted loan', async () => {
      const own = await createLoanScenario();
      const loanId = await createDraftLoan(own.clientId);
      await submitLoan(loanId, own);

      const result = await asUser(own.manager, `select public.approve_loan($1)`, [
        loanId,
      ]);

      expect(result.ok).toBe(true);
    });

    it('cannot disburse — the control that stops one person doing everything', async () => {
      const own = await createLoanScenario();
      const loanId = await createDraftLoan(own.clientId);
      await approveLoan(loanId, own);

      // A Manager also holds `loans:create`. Granting disbursement as well
      // would let one person originate a loan, approve it and hand over the
      // cash with nobody else involved.
      const result = await asUser(own.manager, `select public.disburse_loan($1)`, [
        loanId,
      ]);

      expect(result.ok).toBe(false);
      expect(result.message).toMatch(/loans:disburse/);
    });

    it('cannot cancel', async () => {
      const result = await asUser(
        scenario.manager,
        `select public.cancel_loan($1, 'reversing my own decision')`,
        [draftLoan],
      );

      expect(result.ok).toBe(false);
    });

    it('reads identity snapshots', async () => {
      const result = await asUser(
        scenario.manager,
        `select nin from public.loan_identity_snapshots where loan_id = $1`,
        [activeLoan],
      );

      expect(result.rows.length).toBeGreaterThan(0);
    });
  });

  // =========================================================================
  describe('an owner or administrator', () => {
    it('disburses an approved loan', async () => {
      const own = await createLoanScenario();
      const loanId = await createDraftLoan(own.clientId);
      await approveLoan(loanId, own);

      const result = await asUser(own.owner, `select public.disburse_loan($1)`, [loanId]);
      expect(result.ok).toBe(true);
    });

    it('cancels a pre-disbursement loan', async () => {
      const own = await createLoanScenario();
      const loanId = await createDraftLoan(own.clientId);

      const result = await asUser(
        own.owner,
        `select public.cancel_loan($1, 'client withdrew the application')`,
        [loanId],
      );

      expect(result.ok).toBe(true);
    });

    it('still cannot delete a loan', async () => {
      const result = await asUser(
        scenario.owner,
        `delete from public.loans where id = $1`,
        [activeLoan],
      );

      // No role has the privilege. Financial history persists.
      expect(result.ok).toBe(false);
      expect(result.code).toBe('42501');
    });

    it('still cannot edit the terms of a live loan', async () => {
      const result = await asUser(
        scenario.owner,
        `update public.loans set principal_amount = 1 where id = $1`,
        [activeLoan],
      );

      expect(result.ok).toBe(false);
    });
  });

  // =========================================================================
  describe('privileges and policies, stated exhaustively', () => {
    it('grants authenticated exactly what Phase 4 intends', async () => {
      const rows = await query<{ table_name: string; privilege_type: string }>(
        `select table_name, privilege_type
           from information_schema.role_table_grants
          where table_schema = 'public'
            and grantee = 'authenticated'
            and table_name like 'loan%'
          order by table_name, privilege_type`,
      );

      // The snapshots and the breakdown are read-only to every session: they
      // are written exclusively by `approve_loan`, which runs as the table
      // owner. The Phase 5 schedule tables are read-only for the same reason,
      // written only by `generate_loan_schedule`. The Phase 6 ledger likewise,
      // written only by `post_payment` and `reverse_payment`. DELETE appears
      // nowhere.
      expect(rows.map((row) => `${row.table_name}:${row.privilege_type}`)).toEqual([
        // Phase 6 adds derived balance views under this prefix. They carry no
        // policy of their own — a view cannot — and reach the loan through
        // `security_invoker`, so their access is the loans policy's.
        'loan_balances:SELECT',
        'loan_client_snapshots:SELECT',
        'loan_delinquency:SELECT',
        'loan_guarantor_snapshots:SELECT',
        'loan_identity_snapshots:SELECT',
        'loan_installment_coverage:SELECT',
        'loan_installments:SELECT',
        'loan_obligations:SELECT',
        'loan_payments:SELECT',
        // Phase 7. A penalty is read-only to every session: it is written
        // exclusively by `ensure_penalty_applied`, which runs as the table
        // owner. No INSERT, no UPDATE, no DELETE — not for the Owner either,
        // because a charge a staff member could type would not be a penalty.
        'loan_penalties:SELECT',
        'loan_penalty_coverage:SELECT',
        'loan_periods:SELECT',
        // Phase 8. The loan register for reports: a join of the loan, its
        // balances and its delinquency position. SELECT only, and
        // `security_invoker`, so it returns exactly the loans the reader's own
        // policies admit.
        'loan_portfolio_report:SELECT',
        'loan_schedules:SELECT',
        'loans:INSERT',
        'loans:SELECT',
        'loans:UPDATE',
      ]);
    });

    it('gives no session role EXECUTE it should not have', async () => {
      for (const [fn, expected] of [
        ['calculate_loan_breakdown', true],
        ['validate_loan_for_approval', true],
        ['approve_loan', true],
        ['disburse_loan', true],
        ['cancel_loan', true],
        // Trigger functions. Reachable only by the triggers that own them.
        ['loans_guard_transition', false],
        ['loans_enforce_active_limit', false],
        ['loans_assign_loan_number', false],
      ] as const) {
        const row = await queryOne<{ can_execute: boolean }>(
          `select coalesce(bool_or(has_function_privilege('authenticated', p.oid, 'execute')), false)
                    as can_execute
             from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.proname = $1`,
          [fn],
        );

        expect(row.can_execute, fn).toBe(expected);
      }
    });

    it('gives anon EXECUTE on nothing', async () => {
      for (const fn of [
        'calculate_loan_breakdown',
        'validate_loan_for_approval',
        'approve_loan',
        'disburse_loan',
        'cancel_loan',
      ]) {
        const row = await queryOne<{ can_execute: boolean }>(
          `select coalesce(bool_or(has_function_privilege('anon', p.oid, 'execute')), false)
                    as can_execute
             from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.proname = $1`,
          [fn],
        );

        expect(row.can_execute, fn).toBe(false);
      }
    });

    it('defines a policy for every Phase 4 table', async () => {
      const rows = await query<{ tablename: string; cmd: string }>(
        `select tablename, cmd from pg_policies
          where schemaname = 'public' and tablename like 'loan%'
          order by tablename, cmd`,
      );

      expect(rows.map((row) => `${row.tablename}:${row.cmd}`)).toEqual([
        'loan_client_snapshots:SELECT',
        'loan_guarantor_snapshots:SELECT',
        'loan_identity_snapshots:SELECT',
        // Phase 5 adds two more loan tables to this prefix, and Phase 6 a
        // third. SELECT only: none of them has a write policy or a write
        // grant, because only the trusted functions write them.
        'loan_installments:SELECT',
        'loan_payments:SELECT',
        // Phase 7 adds a fourth, on the same terms.
        'loan_penalties:SELECT',
        'loan_periods:SELECT',
        'loan_schedules:SELECT',
        'loans:INSERT',
        'loans:SELECT',
        'loans:UPDATE',
      ]);
    });
  });

  // =========================================================================
  describe('the privileged client', () => {
    it('can read everything, which is why nothing reaches it from a browser', async () => {
      const result = await asServiceRole(
        `select count(*)::text as count from public.loans`,
      );
      expect(result.ok).toBe(true);
    });

    it('still cannot edit the terms of a live loan', async () => {
      const result = await asServiceRole(
        `update public.loans set interest_rate_bps = 0 where id = $1`,
        [activeLoan],
      );

      expect(result.ok).toBe(false);
    });

    it('still cannot alter a stored breakdown', async () => {
      const result = await asServiceRole(
        `update public.loan_periods set interest = 0 where loan_id = $1`,
        [activeLoan],
      );

      expect(result.ok).toBe(false);
    });
  });
});
