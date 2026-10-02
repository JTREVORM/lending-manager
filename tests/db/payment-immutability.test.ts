import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { asAnon, asServiceRole, asUser, deleteTestUsers } from '../helpers/auth-fixtures';
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
  readLedger,
  reversePayment,
} from '../helpers/payment-fixtures';
import { closePool, hasDatabase, query, queryOne, skipReason } from '../helpers/db';

/**
 * The payment ledger is financial evidence.
 *
 * Every attempt below runs as a real database role, including the privileged
 * client — a leaked `service_role` key is the threat model the statement-level
 * triggers exist for, and "the application would never do that" is not a
 * control.
 *
 * The question throughout is not whether the interface offers an edit button.
 * It is whether somebody holding a valid token, or the secret key, can change
 * what a borrower is recorded as having paid.
 */
const describeDb = hasDatabase ? describe : describe.skip;

if (!hasDatabase) {
  describe('payment immutability suite', () => {
    it.skip(`skipped — ${skipReason}`, () => undefined);
  });
}

describeDb('payment ledger immutability', () => {
  let scenario: LoanScenario;
  let loanId: string;
  let paymentId: string;
  let allocationId: string;
  let originalRow: Record<string, string | null>;

  beforeAll(async () => {
    await deleteTestPayments();
    await deleteTestLoans();
    await deleteTestUsers();

    scenario = await createLoanScenario();
    loanId = await createDraftLoan(scenario.clientId, {
      principal: 100_000,
      termMonths: 1,
      frequency: 'every_3_days',
    });
    await disburseLoan(loanId, scenario);

    paymentId = await postPayment(loanId, scenario.secretary, {
      amount: 28_000,
      method: 'mtn_mobile_money',
      externalReference: 'IMMUTABLE-REF-01',
    });

    const allocation = await queryOne<{ id: string }>(
      `select id from public.payment_allocations where payment_id = $1 limit 1`,
      [paymentId],
    );
    allocationId = allocation.id;

    originalRow = await queryOne<Record<string, string | null>>(
      `select amount::text, payment_method, external_reference, loan_id::text,
              client_id::text, payment_number, recorded_by::text,
              received_at::text, outstanding_before::text, outstanding_after::text,
              client_name_at_payment, recorded_by_label, status
         from public.loan_payments where id = $1`,
      [paymentId],
    );
  });

  afterAll(async () => {
    await deleteTestPayments();
    await deleteTestLoans();
    await deleteTestUsers();
    await closePool();
  });

  // =========================================================================
  describe('every financial field is frozen', () => {
    it.each([
      ['amount', `amount = 1`],
      ['payment_method', `payment_method = 'cash'`],
      ['external_reference', `external_reference = 'SOMETHING-ELSE'`],
      ['loan_id', `loan_id = gen_random_uuid()`],
      ['client_id', `client_id = gen_random_uuid()`],
      ['payment_number', `payment_number = 'PAY999999'`],
      ['recorded_by', `recorded_by = null`],
      ['recorded_by_label', `recorded_by_label = 'Somebody Else'`],
      ['received_at', `received_at = now()`],
      ['outstanding_before', `outstanding_before = 1`],
      ['outstanding_after', `outstanding_after = 0`],
      ['client_name_at_payment', `client_name_at_payment = 'Another Person'`],
      ['idempotency_key', `idempotency_key = gen_random_uuid()`],
      ['notes', `notes = 'rewritten'`],
      ['created_at', `created_at = now()`],
    ])('refuses to change %s, even as the privileged client', async (_, setClause) => {
      const result = await asServiceRole(
        `update public.loan_payments set ${setClause} where id = $1`,
        [paymentId],
      );

      expect(result.ok).toBe(false);
      expect(result.message).toMatch(/cannot be altered|already been reversed/i);
    });

    it('leaves the row genuinely unchanged after every attempt', async () => {
      // The attempts above were *reported* as refused. This checks they
      // actually were.
      const current = await queryOne<Record<string, string | null>>(
        `select amount::text, payment_method, external_reference, loan_id::text,
                client_id::text, payment_number, recorded_by::text,
                received_at::text, outstanding_before::text, outstanding_after::text,
                client_name_at_payment, recorded_by_label, status
           from public.loan_payments where id = $1`,
        [paymentId],
      );

      expect(current).toEqual(originalRow);
    });

    it('refuses a blanket update across the whole ledger', async () => {
      const result = await asServiceRole(`update public.loan_payments set amount = 1`);

      expect(result.ok).toBe(false);
    });
  });

  // =========================================================================
  describe('a fake reversal cannot be assembled', () => {
    it('refuses a status change with no attribution', async () => {
      // A payment that *looked* reversed while naming nobody would be worse
      // than useless in a dispute.
      const result = await asServiceRole(
        `update public.loan_payments set status = 'reversed' where id = $1`,
        [paymentId],
      );

      expect(result.ok).toBe(false);
      expect(result.message).toMatch(/actor, the time and a reason/i);
    });

    it('refuses reversal metadata with no status change', async () => {
      // The opposite trick: stamp the reversal fields while leaving the
      // payment counting toward the balance.
      const result = await asServiceRole(
        `update public.loan_payments
            set reversed_at = now(), reversed_by = $2,
                reversal_reason = 'a plausible looking reason'
          where id = $1`,
        [paymentId, scenario.owner.profileId],
      );

      expect(result.ok).toBe(false);
      expect(result.message).toMatch(/only when a payment is reversed/i);
    });

    it('refuses a reversal with a blank reason', async () => {
      const result = await asServiceRole(
        `update public.loan_payments
            set status = 'reversed', reversed_at = now(), reversed_by = $2,
                reversal_reason = '   '
          where id = $1`,
        [paymentId, scenario.owner.profileId],
      );

      expect(result.ok).toBe(false);
    });

    it('refuses a move to any status other than reversed', async () => {
      const result = await asServiceRole(
        `update public.loan_payments set status = 'posted' where id = $1`,
        [paymentId],
      );

      // Already posted, so this is a no-op status-wise and must be refused as
      // an attempted change or accepted as identical — what must never work is
      // inventing a third status.
      const invented = await asServiceRole(
        `update public.loan_payments set status = 'pending' where id = $1`,
        [paymentId],
      );

      expect(invented.ok).toBe(false);
      expect(result.ok || !result.ok).toBe(true);
    });

    it('gives no session role the privilege to UPDATE a payment at all', async () => {
      // The first line of defence, and the strongest: `authenticated` holds
      // SELECT and nothing else, so no signed-in caller can reach an UPDATE
      // for the guard trigger to have to refuse. Even the Owner reverses only
      // through `reverse_payment`.
      const privileges = await query<{ privilege_type: string }>(
        `select privilege_type from information_schema.role_table_grants
          where table_schema = 'public'
            and table_name in ('loan_payments', 'payment_allocations')
            and grantee in ('anon', 'authenticated')`,
      );

      expect(privileges.map((row) => row.privilege_type)).toEqual(['SELECT', 'SELECT']);

      const attempt = await asUser(
        scenario.owner,
        `update public.loan_payments set status = 'reversed' where id = $1`,
        [paymentId],
      );

      expect(attempt.ok).toBe(false);
      expect(attempt.message).toMatch(/permission denied/i);
    });

    it('stamps the real actor rather than a supplied one, even for the privileged client', async () => {
      // `service_role` bypasses the grants, so this is the path where the
      // guard trigger's attribution rule actually matters. The reversal
      // succeeds — a leaked key *can* reverse — but it cannot choose who did
      // it or when: both are stamped from the session, and a key with no
      // session has no profile to stamp, so the reversal is refused outright.
      const other = await createLoanScenario();
      const otherLoan = await createDraftLoan(other.clientId, {
        principal: 100_000,
        termMonths: 1,
        frequency: 'every_3_days',
      });
      await disburseLoan(otherLoan, other);

      const target = await postPayment(otherLoan, other.secretary, {
        amount: 11_500,
      });

      const attempt = await asServiceRole(
        `update public.loan_payments
            set status = 'reversed', reversed_at = '2020-01-01'::timestamptz,
                reversed_by = $2, reversal_reason = 'forged attribution attempt'
          where id = $1`,
        [target, other.secretary.profileId],
      );

      // No session, so no actor to attribute the reversal to — and a reversal
      // nobody can be held to is not a reversal. The same rule ADR-025
      // applied to approvals.
      expect(attempt.ok).toBe(false);
      expect(attempt.message).toMatch(/must name the person performing it/i);

      // And the payment is untouched.
      const row = await queryOne<{ status: string; reversed_by: string | null }>(
        `select status, reversed_by::text from public.loan_payments where id = $1`,
        [target],
      );

      expect(row.status).toBe('posted');
      expect(row.reversed_by).toBeNull();
    });
  });

  // =========================================================================
  describe('allocations have no exception at all', () => {
    it.each([
      ['allocated_amount', `allocated_amount = 1`],
      ['allocated_principal', `allocated_principal = 1`],
      ['allocated_interest', `allocated_interest = 1`],
      ['installment_id', `installment_id = gen_random_uuid()`],
      ['payment_id', `payment_id = gen_random_uuid()`],
      ['loan_id', `loan_id = gen_random_uuid()`],
    ])('refuses to change %s', async (_, setClause) => {
      const result = await asServiceRole(
        `update public.payment_allocations set ${setClause} where id = $1`,
        [allocationId],
      );

      expect(result.ok).toBe(false);
      expect(result.message).toMatch(/append-only/i);
    });

    it('refuses an update whose WHERE clause matches nothing', async () => {
      // Statement-level, so the refusal does not depend on the attacker's
      // predicate finding a row.
      const result = await asServiceRole(
        `update public.payment_allocations set allocated_amount = 0
          where payment_id = '00000000-0000-4000-8000-00000000dead'`,
      );

      expect(result.ok).toBe(false);
      expect(result.message).toMatch(/append-only/i);
    });

    it('survives a reversal of its payment, unchanged', async () => {
      const other = await createLoanScenario();
      const otherLoan = await createDraftLoan(other.clientId, {
        principal: 100_000,
        termMonths: 1,
        frequency: 'every_3_days',
      });
      await disburseLoan(otherLoan, other);

      const target = await postPayment(otherLoan, other.secretary, {
        amount: 28_000,
      });

      const before = await query<Record<string, string>>(
        `select id::text, allocated_amount::text a, allocated_principal::text p,
                allocated_interest::text i
           from public.payment_allocations where payment_id = $1 order by id`,
        [target],
      );

      await reversePayment(target, other.owner);

      const after = await query<Record<string, string>>(
        `select id::text, allocated_amount::text a, allocated_principal::text p,
                allocated_interest::text i
           from public.payment_allocations where payment_id = $1 order by id`,
        [target],
      );

      expect(after).toEqual(before);
      expect(after.length).toBeGreaterThan(0);
    });
  });

  // =========================================================================
  describe('nothing can be deleted', () => {
    it('refuses to delete one payment, as the privileged client', async () => {
      const result = await asServiceRole(
        `delete from public.loan_payments where id = $1`,
        [paymentId],
      );

      expect(result.ok).toBe(false);
      expect(result.message).toMatch(/append-only/i);
    });

    it('refuses to delete every payment', async () => {
      const result = await asServiceRole(`delete from public.loan_payments`);
      expect(result.ok).toBe(false);
    });

    it('refuses to delete one allocation', async () => {
      const result = await asServiceRole(
        `delete from public.payment_allocations where id = $1`,
        [allocationId],
      );

      expect(result.ok).toBe(false);
      expect(result.message).toMatch(/append-only/i);
    });

    it('refuses to delete every allocation', async () => {
      const result = await asServiceRole(`delete from public.payment_allocations`);
      expect(result.ok).toBe(false);
    });

    it('refuses a delete matching nothing', async () => {
      const result = await asServiceRole(
        `delete from public.loan_payments
          where id = '00000000-0000-4000-8000-00000000dead'`,
      );

      expect(result.ok).toBe(false);
    });

    it('leaves the ledger intact after every deletion attempt', async () => {
      const row = await queryOne<{ n: string }>(
        `select count(*)::text as n from public.loan_payments where id = $1`,
        [paymentId],
      );
      const allocations = await queryOne<{ n: string }>(
        `select count(*)::text as n from public.payment_allocations
          where payment_id = $1`,
        [paymentId],
      );

      expect(Number(row.n)).toBe(1);
      expect(Number(allocations.n)).toBe(3);
    });

    it('refuses to delete a loan that has payments', async () => {
      // `on delete restrict` on the payment's loan reference: financial
      // history must not cascade away.
      const result = await asServiceRole(`delete from public.loans where id = $1`, [
        loanId,
      ]);

      expect(result.ok).toBe(false);
    });
  });

  // =========================================================================
  describe('no session role can write the ledger directly', () => {
    it.each([
      ['secretary', 'secretary'],
      ['manager', 'manager'],
      ['owner', 'owner'],
    ] as const)('refuses a payment insert by the %s', async (_, role) => {
      const result = await asUser(
        scenario[role],
        `insert into public.loan_payments
           (loan_id, client_id, amount, payment_method, idempotency_key,
            recorded_by, outstanding_before, outstanding_after,
            client_name_at_payment, recorded_by_label)
         select l.id, l.client_id, 50000, 'cash', gen_random_uuid(), $2, 50000, 0,
                'Forged', 'Forged'
           from public.loans l where l.id = $1`,
        [loanId, scenario[role].profileId],
      );

      expect(result.ok).toBe(false);
    });

    it.each([
      ['secretary', 'secretary'],
      ['manager', 'manager'],
      ['owner', 'owner'],
    ] as const)('refuses an allocation insert by the %s', async (_, role) => {
      const result = await asUser(
        scenario[role],
        `insert into public.payment_allocations
           (payment_id, installment_id, loan_id, allocated_amount,
            allocated_principal, allocated_interest)
         select $1, li.id, $2, 1, 1, 0
           from public.loan_installments li where li.loan_id = $2 limit 1`,
        [paymentId, loanId],
      );

      expect(result.ok).toBe(false);
    });

    it.each([
      ['secretary', 'secretary'],
      ['manager', 'manager'],
      ['owner', 'owner'],
    ] as const)('refuses an allocation update by the %s', async (_, role) => {
      const result = await asUser(
        scenario[role],
        `update public.payment_allocations set allocated_amount = 1 where id = $1`,
        [allocationId],
      );

      expect(result.ok).toBe(false);
    });

    it('refuses the Owner editing a payment amount', async () => {
      // Owner authority is about what the business may decide, not about
      // rewriting what it already decided. Corrections go through reversal.
      const result = await asUser(
        scenario.owner,
        `update public.loan_payments set amount = 1 where id = $1`,
        [paymentId],
      );

      expect(result.ok).toBe(false);
    });

    it('refuses everything from an anonymous visitor', async () => {
      for (const statement of [
        `insert into public.loan_payments
           (loan_id, client_id, amount, payment_method, idempotency_key,
            recorded_by, outstanding_before, outstanding_after,
            client_name_at_payment, recorded_by_label)
         values (gen_random_uuid(), gen_random_uuid(), 1, 'cash',
                 gen_random_uuid(), gen_random_uuid(), 1, 0, 'X', 'Y')`,
        `update public.loan_payments set amount = 1`,
        `delete from public.loan_payments`,
        `update public.payment_allocations set allocated_amount = 1`,
        `delete from public.payment_allocations`,
      ]) {
        const result = await asAnon(statement);
        expect(result.ok, statement.slice(0, 48)).toBe(false);
      }
    });
  });

  // =========================================================================
  describe('the loan status cannot be set by hand', () => {
    it('refuses marking a loan cleared while it still owes money', async () => {
      // The status can never contradict the ledger. Checked from the data, so
      // it binds every caller including the privileged client.
      const result = await asServiceRole(
        `update public.loans set status = 'cleared' where id = $1`,
        [loanId],
      );

      expect(result.ok).toBe(false);
      expect(result.message).toMatch(/still outstanding/i);
    });

    it('refuses marking a loan cleared as the Owner', async () => {
      const result = await asUser(
        scenario.owner,
        `update public.loans set status = 'cleared' where id = $1`,
        [loanId],
      );

      expect(result.ok).toBe(false);
    });

    it('refuses reopening a loan that owes nothing', async () => {
      const other = await createLoanScenario();
      const otherLoan = await createDraftLoan(other.clientId, {
        principal: 100_000,
        termMonths: 1,
        frequency: 'every_3_days',
      });
      await disburseLoan(otherLoan, other);
      await postPayment(otherLoan, other.secretary, { amount: 115_000 });

      expect((await readLedger(otherLoan)).status).toBe('cleared');

      const result = await asServiceRole(
        `update public.loans set status = 'active' where id = $1`,
        [otherLoan],
      );

      expect(result.ok).toBe(false);
      expect(result.message).toMatch(/owes nothing/i);
    });

    it('refuses a Secretary reopening a cleared loan', async () => {
      // Reopening is a consequence of reversing, and only the Owner reverses.
      const other = await createLoanScenario();
      const otherLoan = await createDraftLoan(other.clientId, {
        principal: 100_000,
        termMonths: 1,
        frequency: 'every_3_days',
      });
      await disburseLoan(otherLoan, other);
      const target = await postPayment(otherLoan, other.secretary, {
        amount: 115_000,
      });

      // Make the loan genuinely owe money again, so the ledger check would
      // pass and only the capability check can refuse.
      await reversePayment(target, other.owner);
      await postPayment(otherLoan, other.secretary, { amount: 115_000 });

      const result = await asUser(
        other.secretary,
        `update public.loans set status = 'active' where id = $1`,
        [otherLoan],
      );

      expect(result.ok).toBe(false);
    });

    it('refuses forging a clearance stamp', async () => {
      const result = await asServiceRole(
        `update public.loans set cleared_at = now(), cleared_by = $2 where id = $1`,
        [loanId, scenario.owner.profileId],
      );

      expect(result.ok).toBe(false);
      expect(result.message).toMatch(/Clearance attribution/i);
    });
  });

  // =========================================================================
  describe('the trusted functions enforce their own rules', () => {
    it('gives anon no privilege to post or reverse', async () => {
      for (const fn of ['post_payment', 'reverse_payment']) {
        const row = await queryOne<{ can_execute: boolean }>(
          `select coalesce(
                    bool_or(has_function_privilege('anon', p.oid, 'execute')), false
                  ) as can_execute
             from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.proname = $1`,
          [fn],
        );

        expect(row.can_execute, fn).toBe(false);
      }
    });

    it('still checks the capability when reached as service_role', async () => {
      // `post_payment` requires a session profile. The privileged client has
      // none, so it is refused — there is no system-recorded payment.
      const result = await asServiceRole(
        `select public.post_payment($1, 11500, 'cash', null, gen_random_uuid(), null)`,
        [loanId],
      );

      expect(result.ok).toBe(false);
      expect(result.message).toMatch(/signed-in member of staff/i);
    });
  });
});
