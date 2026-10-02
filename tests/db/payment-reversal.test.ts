import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { asServiceRole, asUser, deleteTestUsers } from '../helpers/auth-fixtures';
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
  readAllocations,
  readCoverage,
  readLedger,
  readMinimum,
  reversePayment,
  tryReversePayment,
} from '../helpers/payment-fixtures';
import { closePool, hasDatabase, query, queryOne, skipReason } from '../helpers/db';

/**
 * Reversing payments.
 *
 * ## A reversal is not a deletion
 *
 * That claim is what this file exists to verify. After a reversal the payment
 * row, its amount, its receipt figures and every one of its allocations must
 * still be exactly as posted — and the balance must have risen by precisely
 * the reversed amount, because the balance views stop counting a payment that
 * is no longer posted.
 *
 * If a future change ever made a reversal delete rows, the balance assertions
 * here would still pass and the preservation assertions would fail. Both are
 * needed.
 */
const describeDb = hasDatabase ? describe : describe.skip;

if (!hasDatabase) {
  describe('payment reversal suite', () => {
    it.skip(`skipped — ${skipReason}`, () => undefined);
  });
}

/** An active loan of ten UGX 11,500 collections. */
async function tenCollectionLoan(): Promise<{
  readonly scenario: LoanScenario;
  readonly loanId: string;
}> {
  const scenario = await createLoanScenario();
  const loanId = await createDraftLoan(scenario.clientId, {
    principal: 100_000,
    termMonths: 1,
    frequency: 'every_3_days',
  });
  await disburseLoan(loanId, scenario);
  return { scenario, loanId };
}

describeDb('reversing payments', () => {
  beforeAll(async () => {
    await deleteTestPayments();
    await deleteTestLoans();
    await deleteTestUsers();
  });

  afterAll(async () => {
    await deleteTestPayments();
    await deleteTestLoans();
    await deleteTestUsers();
    await closePool();
  });

  // =========================================================================
  describe('the balance effect', () => {
    it('restores the balance by exactly the reversed amount', async () => {
      const { scenario, loanId } = await tenCollectionLoan();

      await postPayment(loanId, scenario.secretary, { amount: 23_000 });
      const paymentId = await postPayment(loanId, scenario.secretary, {
        amount: 11_500,
      });

      const before = await readLedger(loanId);
      expect(before.outstanding).toBe(80_500);
      expect(before.totalPaid).toBe(34_500);

      await reversePayment(paymentId, scenario.owner);

      const after = await readLedger(loanId);

      expect(after.outstanding).toBe(92_000);
      expect(after.totalPaid).toBe(23_000);
      expect(after.postedPaymentCount).toBe(1);
      expect(after.reversedPaymentCount).toBe(1);
    });

    it('makes the affected collections uncovered again', async () => {
      const { scenario, loanId } = await tenCollectionLoan();

      const paymentId = await postPayment(loanId, scenario.secretary, {
        amount: 28_000,
      });

      const covered = await readCoverage(loanId);
      expect(covered[0]?.remainingAmount).toBe(0);
      expect(covered[2]?.remainingAmount).toBe(6_500);

      await reversePayment(paymentId, scenario.owner);

      const uncovered = await readCoverage(loanId);

      // Every collection is effectively unpaid again.
      expect(uncovered.every((row) => row.allocatedAmount === 0)).toBe(true);
      expect(uncovered.every((row) => row.remainingAmount === row.expectedAmount)).toBe(
        true,
      );
    });

    it('does not change one date or amount in the schedule', async () => {
      // The whole point of keeping the schedule separate from the ledger.
      const { scenario, loanId } = await tenCollectionLoan();

      const scheduleBefore = await query<Record<string, string>>(
        `select installment_number::text n, due_date::text d,
                expected_amount::text e, scheduled_principal::text p,
                scheduled_interest::text i
           from public.loan_installments where loan_id = $1
          order by installment_number`,
        [loanId],
      );

      const paymentId = await postPayment(loanId, scenario.secretary, {
        amount: 115_000,
      });
      await reversePayment(paymentId, scenario.owner);

      const scheduleAfter = await query<Record<string, string>>(
        `select installment_number::text n, due_date::text d,
                expected_amount::text e, scheduled_principal::text p,
                scheduled_interest::text i
           from public.loan_installments where loan_id = $1
          order by installment_number`,
        [loanId],
      );

      expect(scheduleAfter).toEqual(scheduleBefore);
    });

    it('restores the minimum payment to the first collection"s full amount', async () => {
      const { scenario, loanId } = await tenCollectionLoan();

      const paymentId = await postPayment(loanId, scenario.secretary, {
        amount: 28_000,
      });

      expect(await readMinimum(loanId)).toBe(6_500);

      await reversePayment(paymentId, scenario.owner);

      expect(await readMinimum(loanId)).toBe(11_500);
    });

    it('reverses a payment that is not the latest one', async () => {
      // Regression. The first draft of `reverse_payment` reconciled against
      // `outstanding_before + amount` from the *receipt*, which is only the
      // current balance if nothing has happened since. Reversing the first of
      // two payments compared against a figure one payment out of date and
      // refused a legitimate reversal — the live-balance-versus-receipt
      // confusion ADR-029 exists to prevent, made inside the function itself.
      const { scenario, loanId } = await tenCollectionLoan();

      const first = await postPayment(loanId, scenario.secretary, { amount: 23_000 });
      const second = await postPayment(loanId, scenario.secretary, { amount: 11_500 });

      expect((await readLedger(loanId)).outstanding).toBe(80_500);

      await reversePayment(first, scenario.owner, 'posted against the wrong loan');

      const ledger = await readLedger(loanId);

      // Restored by exactly the reversed amount, from wherever the balance
      // had got to.
      expect(ledger.outstanding).toBe(80_500 + 23_000);
      expect(ledger.totalPaid).toBe(11_500);

      // And the later payment is untouched and still posted.
      const survivor = await queryOne<{ status: string; amount: string }>(
        `select status, amount::text from public.loan_payments where id = $1`,
        [second],
      );
      expect(survivor.status).toBe('posted');
      expect(survivor.amount).toBe('11500');

      // The surviving payment's allocations are **not** re-allocated. They
      // are a record of where that money actually went — collection 3, which
      // was the earliest unpaid one when it was received — and a reversal of
      // an earlier payment does not rewrite them.
      //
      // So the loan is left with a gap: collections 1 and 2 uncovered while 3
      // is covered. That is the truthful state, and every figure still
      // reconciles around it.
      const coverage = await readCoverage(loanId);

      expect(coverage[0]?.allocatedAmount).toBe(0);
      expect(coverage[1]?.allocatedAmount).toBe(0);
      expect(coverage[2]?.allocatedAmount).toBe(11_500);

      // The next payment fills the gap, oldest first, and the minimum is
      // collection 1's full amount again.
      expect(await readMinimum(loanId)).toBe(11_500);

      const next = await postPayment(loanId, scenario.secretary, { amount: 11_500 });
      expect(await readAllocations(next)).toEqual([
        {
          installmentNumber: 1,
          allocatedAmount: 11_500,
          allocatedPrincipal: 10_000,
          allocatedInterest: 1_500,
        },
      ]);
    });

    it('lets the money be re-paid afterwards', async () => {
      // The ordinary correction: reverse the wrong entry, record the right one.
      const { scenario, loanId } = await tenCollectionLoan();

      const wrong = await postPayment(loanId, scenario.secretary, { amount: 23_000 });
      await reversePayment(wrong, scenario.owner, 'amount keyed wrongly at the counter');

      const right = await postPayment(loanId, scenario.secretary, { amount: 11_500 });

      expect(right).not.toBe(wrong);

      const ledger = await readLedger(loanId);
      expect(ledger.totalPaid).toBe(11_500);
      expect(ledger.outstanding).toBe(103_500);
    });
  });

  // =========================================================================
  describe('nothing is deleted', () => {
    it('keeps the payment row with every figure intact', async () => {
      const { scenario, loanId } = await tenCollectionLoan();

      const paymentId = await postPayment(loanId, scenario.secretary, {
        amount: 23_000,
        method: 'mtn_mobile_money',
        externalReference: 'KEEP-REF-0001',
      });

      const before = await queryOne<Record<string, string | null>>(
        `select payment_number, amount::text, payment_method, external_reference,
                outstanding_before::text, outstanding_after::text,
                client_name_at_payment, recorded_by_label, received_at::text,
                recorded_by::text
           from public.loan_payments where id = $1`,
        [paymentId],
      );

      await reversePayment(paymentId, scenario.owner, 'duplicate of an earlier entry');

      const after = await queryOne<Record<string, string | null>>(
        `select payment_number, amount::text, payment_method, external_reference,
                outstanding_before::text, outstanding_after::text,
                client_name_at_payment, recorded_by_label, received_at::text,
                recorded_by::text
           from public.loan_payments where id = $1`,
        [paymentId],
      );

      // Not one field moved.
      expect(after).toEqual(before);
    });

    it('keeps every allocation attached to the payment', async () => {
      const { scenario, loanId } = await tenCollectionLoan();

      const paymentId = await postPayment(loanId, scenario.secretary, {
        amount: 28_000,
      });

      const before = await readAllocations(paymentId);
      expect(before).toHaveLength(3);

      await reversePayment(paymentId, scenario.owner);

      // Still there, unchanged, still traceable to where the money went.
      expect(await readAllocations(paymentId)).toEqual(before);
    });

    it('records the reversal with its actor, time and reason', async () => {
      const { scenario, loanId } = await tenCollectionLoan();

      const paymentId = await postPayment(loanId, scenario.secretary, {
        amount: 11_500,
      });

      await reversePayment(
        paymentId,
        scenario.owner,
        'borrower disputed the receipt and the cash was returned',
      );

      const row = await queryOne<Record<string, string | null>>(
        `select status, reversed_at::text, reversed_by::text, reversal_reason
           from public.loan_payments where id = $1`,
        [paymentId],
      );

      expect(row.status).toBe('reversed');
      expect(row.reversed_at).not.toBeNull();
      expect(row.reversed_by).toBe(scenario.owner.profileId);
      expect(row.reversal_reason).toBe(
        'borrower disputed the receipt and the cash was returned',
      );
    });

    it('keeps the payment visible in the register', async () => {
      const { scenario, loanId } = await tenCollectionLoan();

      const paymentId = await postPayment(loanId, scenario.secretary, {
        amount: 11_500,
      });
      await reversePayment(paymentId, scenario.owner);

      const visible = await asUser(
        scenario.secretary,
        `select payment_number, status from public.loan_payments where id = $1`,
        [paymentId],
      );

      expect(visible.rows).toHaveLength(1);
      expect(visible.rows[0]?.status).toBe('reversed');
    });

    it('records an audit event naming the amount restored', async () => {
      const { scenario, loanId } = await tenCollectionLoan();

      const paymentId = await postPayment(loanId, scenario.secretary, {
        amount: 23_000,
      });
      await reversePayment(paymentId, scenario.owner, 'posted against the wrong loan');

      const event = await queryOne<{
        new_values: Record<string, unknown>;
        old_values: Record<string, unknown>;
        actor_profile_id: string;
      }>(
        `select new_values, old_values, actor_profile_id::text from public.audit_log
          where entity_type = 'payment' and entity_id = $1
            and action = 'payment.reversed'`,
        [paymentId],
      );

      expect(event.old_values).toMatchObject({ status: 'posted', amount: 23_000 });
      expect(event.new_values).toMatchObject({
        status: 'reversed',
        amount: 23_000,
        amount_restored: 23_000,
        reversal_reason: 'posted against the wrong loan',
      });
      expect(event.actor_profile_id).toBe(scenario.owner.profileId);
    });
  });

  // =========================================================================
  describe('reopening a cleared loan', () => {
    it('returns the loan to active and restores the balance', async () => {
      const { scenario, loanId } = await tenCollectionLoan();

      const paymentId = await postPayment(loanId, scenario.secretary, {
        amount: 115_000,
      });

      const cleared = await readLedger(loanId);
      expect(cleared.status).toBe('cleared');
      expect(cleared.outstanding).toBe(0);
      expect(cleared.clearedAt).not.toBeNull();

      await reversePayment(paymentId, scenario.owner, 'the cheque did not clear');

      const reopened = await readLedger(loanId);

      expect(reopened.status).toBe('active');
      expect(reopened.outstanding).toBe(115_000);
      expect(reopened.totalPaid).toBe(0);
      expect(reopened.fullyRepaid).toBe(false);
      // The stamp is cleared, so the column keeps meaning "currently cleared".
      expect(reopened.clearedAt).toBeNull();
    });

    it('audits the reopening as a reopening, never as a disbursement', async () => {
      // The defect this assertion exists for: Phase 4 mapped every transition
      // into `active` to `loan.disbursed`, which on a reopening would be a
      // false record that the business paid the money out a second time.
      const { scenario, loanId } = await tenCollectionLoan();

      const paymentId = await postPayment(loanId, scenario.secretary, {
        amount: 115_000,
      });
      await reversePayment(paymentId, scenario.owner);

      const actions = await query<{ action: string }>(
        `select action from public.audit_log
          where entity_type = 'loan' and entity_id = $1
          order by id`,
        [loanId],
      );

      const names = actions.map((row) => row.action);

      expect(names).toContain('loan.reopened');
      expect(names).toContain('loan.cleared');
      // Exactly one disbursement, ever: the real one.
      expect(names.filter((name) => name === 'loan.disbursed')).toHaveLength(1);
    });

    it('records the balance that justified the reopening', async () => {
      const { scenario, loanId } = await tenCollectionLoan();

      const paymentId = await postPayment(loanId, scenario.secretary, {
        amount: 115_000,
      });
      await reversePayment(paymentId, scenario.owner);

      const event = await queryOne<{
        new_values: Record<string, unknown>;
        old_values: Record<string, unknown>;
      }>(
        `select new_values, old_values from public.audit_log
          where entity_type = 'loan' and entity_id = $1 and action = 'loan.reopened'`,
        [loanId],
      );

      expect(event.old_values).toMatchObject({ status: 'cleared' });
      expect(event.new_values).toMatchObject({
        status: 'active',
        outstanding: 115_000,
      });
    });

    it('does not reopen when the loan still owes nothing', async () => {
      // Two payments settle the loan; reversing one leaves money owed, so it
      // reopens. Reversing a payment on a loan that is *not* cleared must not
      // touch the status at all.
      const { scenario, loanId } = await tenCollectionLoan();

      const first = await postPayment(loanId, scenario.secretary, { amount: 23_000 });
      await postPayment(loanId, scenario.secretary, { amount: 11_500 });

      expect((await readLedger(loanId)).status).toBe('active');

      await reversePayment(first, scenario.owner);

      expect((await readLedger(loanId)).status).toBe('active');
    });

    it('clears the loan again when the money is genuinely re-paid', async () => {
      const { scenario, loanId } = await tenCollectionLoan();

      const paymentId = await postPayment(loanId, scenario.secretary, {
        amount: 115_000,
      });
      await reversePayment(paymentId, scenario.owner, 'recorded against the wrong loan');

      expect((await readLedger(loanId)).status).toBe('active');

      await postPayment(loanId, scenario.secretary, { amount: 115_000 });

      const final = await readLedger(loanId);
      expect(final.status).toBe('cleared');
      expect(final.outstanding).toBe(0);
      // One posted payment, one reversed.
      expect(final.postedPaymentCount).toBe(1);
      expect(final.reversedPaymentCount).toBe(1);
    });

    it('never reopens a cancelled loan', async () => {
      // `cancelled` is terminal. No payment can be posted against one, so no
      // reversal can reach one — and the transition is not in the machine.
      const attempt = await asServiceRole(
        `update public.loans set status = 'active' where status = 'cancelled'`,
      );

      // Either refused by the state machine, or there was no cancelled loan to
      // try it on. Both are closed; what must never happen is a success that
      // moved one.
      const revived = await query<{ id: string }>(
        `select id from public.loans
          where status = 'active' and cancelled_at is not null`,
      );

      expect(revived).toEqual([]);
      if (attempt.ok) {
        expect(attempt.rows).toEqual([]);
      }
    });
  });

  // =========================================================================
  describe('a reversal cannot be repeated', () => {
    it('refuses a second reversal of the same payment', async () => {
      const { scenario, loanId } = await tenCollectionLoan();

      const paymentId = await postPayment(loanId, scenario.secretary, {
        amount: 11_500,
      });

      await reversePayment(paymentId, scenario.owner);

      const second = await tryReversePayment(paymentId, scenario.owner);

      expect(second.ok).toBe(false);
      expect(second.message).toMatch(/already reversed/i);
    });

    it('refuses it at the database, not only in the function', async () => {
      const { scenario, loanId } = await tenCollectionLoan();

      const paymentId = await postPayment(loanId, scenario.secretary, {
        amount: 11_500,
      });
      await reversePayment(paymentId, scenario.owner);

      // Direct UPDATE as the privileged client: the guard trigger refuses
      // above the trusted-path exemption, so a leaked key gains nothing.
      const direct = await asServiceRole(
        `update public.loan_payments
            set reversal_reason = 'a second attempt'
          where id = $1`,
        [paymentId],
      );

      expect(direct.ok).toBe(false);
      expect(direct.message).toMatch(/already been reversed/i);
    });

    it('leaves the balance restored exactly once', async () => {
      const { scenario, loanId } = await tenCollectionLoan();

      const paymentId = await postPayment(loanId, scenario.secretary, {
        amount: 23_000,
      });
      await reversePayment(paymentId, scenario.owner);

      for (let attempt = 0; attempt < 3; attempt += 1) {
        await tryReversePayment(paymentId, scenario.owner);
      }

      const ledger = await readLedger(loanId);

      // Restored once, not three times over.
      expect(ledger.outstanding).toBe(115_000);
      expect(ledger.totalPaid).toBe(0);
      expect(ledger.reversedPaymentCount).toBe(1);
    });

    it('records exactly one reversal event', async () => {
      const { scenario, loanId } = await tenCollectionLoan();

      const paymentId = await postPayment(loanId, scenario.secretary, {
        amount: 11_500,
      });
      await reversePayment(paymentId, scenario.owner);
      await tryReversePayment(paymentId, scenario.owner);
      await tryReversePayment(paymentId, scenario.owner);

      const events = await query<{ action: string }>(
        `select action from public.audit_log
          where entity_type = 'payment' and entity_id = $1
            and action = 'payment.reversed'`,
        [paymentId],
      );

      expect(events).toHaveLength(1);
    });
  });

  // =========================================================================
  describe('what reversal requires', () => {
    it('requires a reason', async () => {
      const { scenario, loanId } = await tenCollectionLoan();

      const paymentId = await postPayment(loanId, scenario.secretary, {
        amount: 11_500,
      });

      for (const reason of ['', '   ']) {
        const attempt = await tryReversePayment(paymentId, scenario.owner, reason);
        expect(attempt.ok, JSON.stringify(reason)).toBe(false);
        expect(attempt.message).toMatch(/requires a reason/i);
      }

      // And the payment is untouched.
      const row = await queryOne<{ status: string }>(
        `select status from public.loan_payments where id = $1`,
        [paymentId],
      );
      expect(row.status).toBe('posted');
    });

    it('refuses a payment that does not exist', async () => {
      const scenario = await createLoanScenario();

      const attempt = await tryReversePayment(
        '00000000-0000-4000-8000-00000000dead',
        scenario.owner,
      );

      expect(attempt.ok).toBe(false);
      expect(attempt.message).toMatch(/No such payment/i);
    });
  });

  // =========================================================================
  describe('who may reverse', () => {
    it('refuses the Secretary/Treasurer', async () => {
      // The phase's central control. A staff member who could both post and
      // reverse could pocket a cash payment, hand over a receipt, and withdraw
      // the record — with the only trace being an entry they made themselves.
      const { scenario, loanId } = await tenCollectionLoan();

      const paymentId = await postPayment(loanId, scenario.secretary, {
        amount: 11_500,
      });

      const attempt = await tryReversePayment(paymentId, scenario.secretary);

      expect(attempt.ok).toBe(false);
      expect(attempt.message).toMatch(/payments:reverse/i);

      const row = await queryOne<{ status: string }>(
        `select status from public.loan_payments where id = $1`,
        [paymentId],
      );
      expect(row.status).toBe('posted');
    });

    it('refuses the Manager', async () => {
      const { scenario, loanId } = await tenCollectionLoan();

      const paymentId = await postPayment(loanId, scenario.manager, {
        amount: 11_500,
      });

      const attempt = await tryReversePayment(paymentId, scenario.manager);

      expect(attempt.ok).toBe(false);
      expect(attempt.message).toMatch(/payments:reverse/i);
    });

    it('allows the Owner/Administrator', async () => {
      const { scenario, loanId } = await tenCollectionLoan();

      const paymentId = await postPayment(loanId, scenario.secretary, {
        amount: 11_500,
      });

      const attempt = await tryReversePayment(paymentId, scenario.owner);

      expect(attempt.ok).toBe(true);
    });

    it('refuses a direct UPDATE by the Secretary even with every field right', async () => {
      // Bypassing the function gains nothing: the guard trigger checks the
      // capability itself.
      const { scenario, loanId } = await tenCollectionLoan();

      const paymentId = await postPayment(loanId, scenario.secretary, {
        amount: 11_500,
      });

      const attempt = await asUser(
        scenario.secretary,
        `update public.loan_payments
            set status = 'reversed',
                reversed_at = now(),
                reversed_by = $2,
                reversal_reason = 'a plausible looking reason'
          where id = $1`,
        [paymentId, scenario.secretary.profileId],
      );

      expect(attempt.ok).toBe(false);
    });
  });

  // =========================================================================
  describe('reconciliation after reversals, over the whole database', () => {
    it('still allocates exactly the amount of every posted payment', async () => {
      const mismatched = await query<{ payment_number: string }>(
        `select lp.payment_number
           from public.loan_payments lp
           left join (
             select payment_id, sum(allocated_amount) as allocated
               from public.payment_allocations group by payment_id
           ) a on a.payment_id = lp.id
          where coalesce(a.allocated, 0) <> lp.amount`,
      );

      // True of reversed payments too: their allocations are preserved and
      // still sum to the amount that was taken.
      expect(mismatched).toEqual([]);
    });

    it('still keeps paid plus outstanding equal to the contractual total', async () => {
      const broken = await query<{ loan_number: string }>(
        `select loan_number from public.loan_balances
          where scheduled_total > 0
            and total_paid + outstanding <> scheduled_total`,
      );

      expect(broken).toEqual([]);
    });

    it('leaves no negative balance and no over-allocated collection', async () => {
      const negative = await query<{ loan_id: string }>(
        `select loan_id from public.loan_balances where outstanding < 0`,
      );
      const over = await query<{ installment_id: string }>(
        `select installment_id from public.loan_installment_coverage
          where remaining_amount < 0`,
      );

      expect(negative).toEqual([]);
      expect(over).toEqual([]);
    });

    it('leaves no cleared loan owing money, and no active loan owing nothing', async () => {
      const broken = await query<{ loan_number: string; status: string }>(
        `select loan_number, status from public.loan_balances
          where scheduled_total > 0
            and ((status = 'cleared' and outstanding <> 0)
              or (status = 'active' and outstanding = 0))`,
      );

      expect(broken).toEqual([]);
    });
  });
});
