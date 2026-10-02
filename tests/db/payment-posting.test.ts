import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { deleteTestUsers } from '../helpers/auth-fixtures';
import {
  createDraftLoan,
  createLoanScenario,
  deleteTestLoans,
  disburseLoan,
  approveLoan,
  cancelLoan,
  type LoanScenario,
} from '../helpers/loan-fixtures';
import {
  deleteTestPayments,
  newIdempotencyKey,
  postPayment,
  readAllocations,
  readCoverage,
  readLedger,
  readMinimum,
  tryPostPayment,
} from '../helpers/payment-fixtures';
import { closePool, hasDatabase, query, queryOne, skipReason } from '../helpers/db';

/**
 * Recording payments against the real database.
 *
 * ## How expectations are derived
 *
 * Hard-coded, with the arithmetic written out. Nothing here compares the
 * database against `lib/domain/payment.ts` — that is
 * `payment-parity.test.ts`, and it is a separate question. Two
 * implementations agreeing proves they agree, not that either is right. Every
 * figure below was independently reproduced with a Python implementation
 * sharing no code with either engine before it was written here.
 *
 * ## The loan used throughout
 *
 * UGX 100,000 over one month at 15%, collected every three days: ten
 * collections of UGX 11,500 each (principal 10,000, interest 1,500), totalling
 * UGX 115,000. Round figures, so a wrong allocation is obvious on sight.
 */
const describeDb = hasDatabase ? describe : describe.skip;

if (!hasDatabase) {
  describe('payment posting suite', () => {
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

describeDb('recording payments', () => {
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
  describe('the fixture loan', () => {
    it('starts with ten UGX 11,500 collections and nothing paid', async () => {
      const { loanId } = await tenCollectionLoan();

      const coverage = await readCoverage(loanId);

      expect(coverage).toHaveLength(10);
      expect(coverage.every((row) => row.expectedAmount === 11_500)).toBe(true);
      expect(coverage.every((row) => row.scheduledPrincipal === 10_000)).toBe(true);
      expect(coverage.every((row) => row.scheduledInterest === 1_500)).toBe(true);
      expect(coverage.every((row) => row.allocatedAmount === 0)).toBe(true);

      const ledger = await readLedger(loanId);
      expect(ledger.scheduledTotal).toBe(115_000);
      expect(ledger.outstanding).toBe(115_000);
      expect(ledger.totalPaid).toBe(0);
      expect(ledger.status).toBe('active');
    });
  });

  // =========================================================================
  describe('scenario A — exactly one collection', () => {
    it('allocates UGX 11,500 interest-first and leaves nothing on that collection', async () => {
      const { scenario, loanId } = await tenCollectionLoan();

      const paymentId = await postPayment(loanId, scenario.secretary, {
        amount: 11_500,
      });

      const allocations = await readAllocations(paymentId);

      // Interest first: the full 1,500 of interest, then 10,000 of principal.
      expect(allocations).toEqual([
        {
          installmentNumber: 1,
          allocatedAmount: 11_500,
          allocatedPrincipal: 10_000,
          allocatedInterest: 1_500,
        },
      ]);

      const coverage = await readCoverage(loanId);
      expect(coverage[0]?.remainingAmount).toBe(0);
      expect(coverage[1]?.remainingAmount).toBe(11_500);

      const ledger = await readLedger(loanId);
      expect(ledger.totalPaid).toBe(11_500);
      expect(ledger.outstanding).toBe(103_500);
      expect(ledger.principalPaid).toBe(10_000);
      expect(ledger.interestPaid).toBe(1_500);
      expect(ledger.status).toBe('active');
    });

    it('mints a receipt number and freezes the receipt figures', async () => {
      const { scenario, loanId } = await tenCollectionLoan();

      const paymentId = await postPayment(loanId, scenario.secretary, {
        amount: 11_500,
      });

      const payment = await queryOne<Record<string, string | null>>(
        `select payment_number,
                outstanding_before::text as before,
                outstanding_after::text  as after,
                client_name_at_payment,
                recorded_by_label,
                status,
                external_reference,
                received_at::text        as received_at
           from public.loan_payments where id = $1`,
        [paymentId],
      );

      expect(payment.payment_number).toMatch(/^PAY\d{6,}$/);
      expect(payment.before).toBe('115000');
      expect(payment.after).toBe('103500');
      // The specification's receipt invariant: before − amount = after.
      expect(Number(payment.before) - 11_500).toBe(Number(payment.after));
      expect(payment.client_name_at_payment).toBe('Loan Borrower');
      expect(payment.recorded_by_label).not.toBeNull();
      expect(payment.status).toBe('posted');
      // Cash carries no network reference.
      expect(payment.external_reference).toBeNull();
      expect(payment.received_at).not.toBeNull();
    });
  });

  // =========================================================================
  describe('scenario B — pays two collections at once', () => {
    it('covers the first collection and the whole of the next', async () => {
      const { scenario, loanId } = await tenCollectionLoan();

      const paymentId = await postPayment(loanId, scenario.secretary, {
        amount: 23_000,
      });

      expect(await readAllocations(paymentId)).toEqual([
        {
          installmentNumber: 1,
          allocatedAmount: 11_500,
          allocatedPrincipal: 10_000,
          allocatedInterest: 1_500,
        },
        {
          installmentNumber: 2,
          allocatedAmount: 11_500,
          allocatedPrincipal: 10_000,
          allocatedInterest: 1_500,
        },
      ]);

      const ledger = await readLedger(loanId);
      expect(ledger.outstanding).toBe(92_000);
      expect(ledger.totalPaid).toBe(23_000);
    });
  });

  // =========================================================================
  describe('scenario C — overpayment into a future collection', () => {
    it('covers two collections in full and part of the third', async () => {
      const { scenario, loanId } = await tenCollectionLoan();

      // 23,000 covers two collections; 5,000 spills into the third.
      const paymentId = await postPayment(loanId, scenario.secretary, {
        amount: 28_000,
      });

      const allocations = await readAllocations(paymentId);

      expect(allocations.map((entry) => entry.allocatedAmount)).toEqual([
        11_500, 11_500, 5_000,
      ]);

      // The third collection takes 5,000: interest 1,500 first, then 3,500 of
      // principal.
      expect(allocations[2]).toEqual({
        installmentNumber: 3,
        allocatedAmount: 5_000,
        allocatedPrincipal: 3_500,
        allocatedInterest: 1_500,
      });

      const ledger = await readLedger(loanId);
      // Outstanding falls by exactly the payment. The excess is never
      // discarded and never left unallocated.
      expect(ledger.outstanding).toBe(115_000 - 28_000);
      expect(ledger.totalPaid).toBe(28_000);

      // And the future collection keeps its own date and amount — only its
      // coverage changed.
      const coverage = await readCoverage(loanId);
      expect(coverage[2]?.expectedAmount).toBe(11_500);
      expect(coverage[2]?.remainingAmount).toBe(6_500);
      expect(coverage).toHaveLength(10);
    });

    it('accepts the remainder of a part-covered collection next time', async () => {
      // The specification's section 26: a collection with only part of it left
      // accepts that part, even though its nominal amount is larger.
      const { scenario, loanId } = await tenCollectionLoan();

      await postPayment(loanId, scenario.secretary, { amount: 28_000 });

      expect(await readMinimum(loanId)).toBe(6_500);

      const second = await postPayment(loanId, scenario.secretary, {
        amount: 6_500,
      });

      // Collection 3's interest was already covered, so this is all principal.
      expect(await readAllocations(second)).toEqual([
        {
          installmentNumber: 3,
          allocatedAmount: 6_500,
          allocatedPrincipal: 6_500,
          allocatedInterest: 0,
        },
      ]);

      const coverage = await readCoverage(loanId);
      expect(coverage[2]?.remainingAmount).toBe(0);
      expect(coverage[2]?.allocatedPrincipal).toBe(10_000);
      expect(coverage[2]?.allocatedInterest).toBe(1_500);
    });
  });

  // =========================================================================
  describe('scenario D — paying the whole balance clears the loan', () => {
    it('settles every collection, zeroes the balance and clears the loan', async () => {
      const { scenario, loanId } = await tenCollectionLoan();

      const paymentId = await postPayment(loanId, scenario.secretary, {
        amount: 115_000,
      });

      const allocations = await readAllocations(paymentId);

      // One allocation per collection, all ten.
      expect(allocations).toHaveLength(10);
      expect(allocations.every((entry) => entry.allocatedAmount === 11_500)).toBe(true);

      const ledger = await readLedger(loanId);

      expect(ledger.outstanding).toBe(0);
      expect(ledger.totalPaid).toBe(115_000);
      expect(ledger.principalPaid).toBe(100_000);
      expect(ledger.principalRemaining).toBe(0);
      expect(ledger.interestPaid).toBe(15_000);
      expect(ledger.interestRemaining).toBe(0);
      expect(ledger.fullyRepaid).toBe(true);

      // Clearance is automatic and stamped by the database.
      expect(ledger.status).toBe('cleared');
      expect(ledger.clearedAt).not.toBeNull();
    });

    it('records exactly one clearance event', async () => {
      const { scenario, loanId } = await tenCollectionLoan();

      await postPayment(loanId, scenario.secretary, { amount: 115_000 });

      const events = await query<{ action: string }>(
        `select action from public.audit_log
          where entity_type = 'loan' and entity_id = $1 and action = 'loan.cleared'`,
        [loanId],
      );

      expect(events).toHaveLength(1);
    });

    it('names the person who took the final payment as the clearer', async () => {
      // Clearing is a consequence of posting, so the Secretary who received
      // the money is the actor — not a system account, and not the Owner.
      const { scenario, loanId } = await tenCollectionLoan();

      await postPayment(loanId, scenario.secretary, { amount: 115_000 });

      const loan = await queryOne<{ cleared_by: string }>(
        `select cleared_by::text from public.loans where id = $1`,
        [loanId],
      );

      expect(loan.cleared_by).toBe(scenario.secretary.profileId);
    });

    it('refuses any further payment on a cleared loan', async () => {
      const { scenario, loanId } = await tenCollectionLoan();

      await postPayment(loanId, scenario.secretary, { amount: 115_000 });

      const attempt = await tryPostPayment(loanId, scenario.secretary, {
        amount: 1_000,
      });

      expect(attempt.ok).toBe(false);
      expect(attempt.message).toMatch(/fully repaid/i);
    });

    it('clears a loan reached by a sequence of payments, not only one', async () => {
      const { scenario, loanId } = await tenCollectionLoan();

      // Ten collections paid one at a time. Only the last clears it.
      for (let index = 0; index < 10; index += 1) {
        await postPayment(loanId, scenario.secretary, { amount: 11_500 });

        const ledger = await readLedger(loanId);
        const expectedPaid = 11_500 * (index + 1);

        expect(ledger.totalPaid, `after payment ${String(index + 1)}`).toBe(expectedPaid);
        expect(ledger.outstanding).toBe(115_000 - expectedPaid);
        expect(ledger.status).toBe(index === 9 ? 'cleared' : 'active');
      }
    });
  });

  // =========================================================================
  describe('the minimum payment rule', () => {
    it('reports the first collection"s full amount on a fresh loan', async () => {
      const { loanId } = await tenCollectionLoan();
      expect(await readMinimum(loanId)).toBe(11_500);
    });

    it('refuses less than the minimum', async () => {
      const { scenario, loanId } = await tenCollectionLoan();

      const attempt = await tryPostPayment(loanId, scenario.secretary, {
        amount: 11_499,
      });

      expect(attempt.ok).toBe(false);
      expect(attempt.message).toMatch(/smallest payment accepted now is 11500/i);

      // And nothing was recorded.
      const ledger = await readLedger(loanId);
      expect(ledger.postedPaymentCount).toBe(0);
      expect(ledger.outstanding).toBe(115_000);
    });

    it('accepts exactly the minimum', async () => {
      const { scenario, loanId } = await tenCollectionLoan();

      const attempt = await tryPostPayment(loanId, scenario.secretary, {
        amount: 11_500,
      });

      expect(attempt.ok).toBe(true);
    });

    it('lets a borrower settle a balance smaller than one nominal collection', async () => {
      const { scenario, loanId } = await tenCollectionLoan();

      // Pay everything but 500.
      await postPayment(loanId, scenario.secretary, { amount: 114_500 });

      const ledger = await readLedger(loanId);
      expect(ledger.outstanding).toBe(500);
      // The minimum is the remainder, not a nominal 11,500 the borrower does
      // not owe.
      expect(await readMinimum(loanId)).toBe(500);

      const final = await tryPostPayment(loanId, scenario.secretary, { amount: 500 });
      expect(final.ok).toBe(true);
      expect((await readLedger(loanId)).status).toBe('cleared');
    });
  });

  // =========================================================================
  describe('the outstanding cap', () => {
    it('refuses more than the loan still owes', async () => {
      const { scenario, loanId } = await tenCollectionLoan();

      const attempt = await tryPostPayment(loanId, scenario.secretary, {
        amount: 115_001,
      });

      expect(attempt.ok).toBe(false);
      expect(attempt.message).toMatch(/outstanding balance is 115000/i);
    });

    it('refuses an overpayment after part of the loan is paid', async () => {
      const { scenario, loanId } = await tenCollectionLoan();

      await postPayment(loanId, scenario.secretary, { amount: 23_000 });

      const attempt = await tryPostPayment(loanId, scenario.secretary, {
        amount: 92_001,
      });

      expect(attempt.ok).toBe(false);
      expect(attempt.message).toMatch(/92000/);
    });

    it('never leaves a negative balance, across the whole database', async () => {
      // Stated over every loan rather than one, so a path that somehow
      // over-allocated would be caught whichever test created it.
      const negative = await query<{ loan_id: string }>(
        `select loan_id from public.loan_balances where outstanding < 0`,
      );

      expect(negative).toEqual([]);
    });

    it('never leaves an over-allocated collection, across the whole database', async () => {
      const over = await query<{ installment_id: string }>(
        `select installment_id from public.loan_installment_coverage
          where remaining_amount < 0
             or remaining_principal < 0
             or remaining_interest < 0`,
      );

      expect(over).toEqual([]);
    });
  });

  // =========================================================================
  describe('amount validation', () => {
    it.each([0, -1, -11_500])('refuses an amount of %i', async (amount) => {
      const { scenario, loanId } = await tenCollectionLoan();

      const attempt = await tryPostPayment(loanId, scenario.secretary, { amount });

      expect(attempt.ok).toBe(false);
      expect(attempt.message).toMatch(/more than zero/i);
    });
  });

  // =========================================================================
  describe('payment methods and references', () => {
    it('records a Mobile Money payment with its reference, normalised', async () => {
      const { scenario, loanId } = await tenCollectionLoan();

      const paymentId = await postPayment(loanId, scenario.secretary, {
        amount: 11_500,
        method: 'mtn_mobile_money',
        // Whitespace and lower case, as a staff member would paste it.
        externalReference: '  mtn-abc-123  ',
      });

      const payment = await queryOne<{ external_reference: string }>(
        `select external_reference from public.loan_payments where id = $1`,
        [paymentId],
      );

      // Trimmed and upper-cased; nothing internal stripped.
      expect(payment.external_reference).toBe('MTN-ABC-123');
    });

    it('refuses a Mobile Money payment with no reference', async () => {
      const { scenario, loanId } = await tenCollectionLoan();

      const attempt = await tryPostPayment(loanId, scenario.secretary, {
        amount: 11_500,
        method: 'mtn_mobile_money',
        externalReference: null,
      });

      expect(attempt.ok).toBe(false);
      expect(attempt.message).toMatch(/transaction reference/i);
    });

    it('refuses a Mobile Money reference too short to identify anything', async () => {
      const { scenario, loanId } = await tenCollectionLoan();

      const attempt = await tryPostPayment(loanId, scenario.secretary, {
        amount: 11_500,
        method: 'airtel_money',
        externalReference: 'AB',
      });

      expect(attempt.ok).toBe(false);
      expect(attempt.message).toMatch(/too short/i);
    });

    it('refuses a reference on a cash payment rather than ignoring it', async () => {
      // Silently dropping it would lose information a staff member believed
      // they had recorded.
      const { scenario, loanId } = await tenCollectionLoan();

      const attempt = await tryPostPayment(loanId, scenario.secretary, {
        amount: 11_500,
        method: 'cash',
        externalReference: 'RECEIPT-BOOK-42',
      });

      expect(attempt.ok).toBe(false);
      expect(attempt.message).toMatch(/cash payment has no network reference/i);
    });

    it('refuses an unknown method', async () => {
      const { scenario, loanId } = await tenCollectionLoan();

      const attempt = await tryPostPayment(loanId, scenario.secretary, {
        amount: 11_500,
        method: 'bank_transfer' as never,
      });

      expect(attempt.ok).toBe(false);
      expect(attempt.message).toMatch(/Unknown payment method/i);
    });

    it('refuses a duplicate reference on the same network', async () => {
      const { scenario, loanId } = await tenCollectionLoan();

      await postPayment(loanId, scenario.secretary, {
        amount: 11_500,
        method: 'mtn_mobile_money',
        externalReference: 'DUP-REF-0001',
      });

      const attempt = await tryPostPayment(loanId, scenario.secretary, {
        amount: 11_500,
        method: 'mtn_mobile_money',
        externalReference: 'DUP-REF-0001',
      });

      expect(attempt.ok).toBe(false);
      expect(attempt.message).toMatch(/already been recorded/i);
    });

    it('refuses a duplicate that differs only by case or whitespace', async () => {
      // Normalisation is what makes the uniqueness rule mean something.
      const { scenario, loanId } = await tenCollectionLoan();

      await postPayment(loanId, scenario.secretary, {
        amount: 11_500,
        method: 'mtn_mobile_money',
        externalReference: 'CASE-REF-0001',
      });

      const attempt = await tryPostPayment(loanId, scenario.secretary, {
        amount: 11_500,
        method: 'mtn_mobile_money',
        externalReference: '  case-ref-0001 ',
      });

      expect(attempt.ok).toBe(false);
      expect(attempt.message).toMatch(/already been recorded/i);
    });

    it('allows the same reference shape on a different network', async () => {
      // MTN and Airtel number their transactions independently, so a format
      // collision across the two is a coincidence rather than a duplicate.
      const { scenario, loanId } = await tenCollectionLoan();

      await postPayment(loanId, scenario.secretary, {
        amount: 11_500,
        method: 'mtn_mobile_money',
        externalReference: 'SHARED-REF-99',
      });

      const other = await tryPostPayment(loanId, scenario.secretary, {
        amount: 11_500,
        method: 'airtel_money',
        externalReference: 'SHARED-REF-99',
      });

      expect(other.ok).toBe(true);
    });

    it('allows two genuine cash payments of the same amount on one loan', async () => {
      // The case that makes cash different: without a reference there is
      // nothing to distinguish them, and they are both real.
      const { scenario, loanId } = await tenCollectionLoan();

      const first = await postPayment(loanId, scenario.secretary, { amount: 11_500 });
      const second = await postPayment(loanId, scenario.secretary, { amount: 11_500 });

      expect(second).not.toBe(first);

      const ledger = await readLedger(loanId);
      expect(ledger.postedPaymentCount).toBe(2);
      expect(ledger.totalPaid).toBe(23_000);
    });
  });

  // =========================================================================
  describe('idempotency', () => {
    it('returns the same payment when the key is replayed', async () => {
      const { scenario, loanId } = await tenCollectionLoan();
      const key = newIdempotencyKey();

      const first = await postPayment(loanId, scenario.secretary, {
        amount: 11_500,
        idempotencyKey: key,
      });

      const second = await postPayment(loanId, scenario.secretary, {
        amount: 11_500,
        idempotencyKey: key,
      });

      expect(second).toBe(first);

      // The money was recorded once.
      const ledger = await readLedger(loanId);
      expect(ledger.postedPaymentCount).toBe(1);
      expect(ledger.totalPaid).toBe(11_500);
    });

    it('records no second allocation or audit event on a replay', async () => {
      const { scenario, loanId } = await tenCollectionLoan();
      const key = newIdempotencyKey();

      const paymentId = await postPayment(loanId, scenario.secretary, {
        amount: 28_000,
        idempotencyKey: key,
      });

      const before = await readAllocations(paymentId);

      for (let attempt = 0; attempt < 3; attempt += 1) {
        await postPayment(loanId, scenario.secretary, {
          amount: 28_000,
          idempotencyKey: key,
        });
      }

      expect(await readAllocations(paymentId)).toEqual(before);

      const events = await query<{ action: string }>(
        `select action from public.audit_log
          where entity_type = 'payment' and entity_id = $1`,
        [paymentId],
      );

      // One `payment.posted` and one `payment.allocated`, however many times
      // the submission was replayed.
      expect(events.map((row) => row.action).sort()).toEqual([
        'payment.allocated',
        'payment.posted',
      ]);
    });

    it('returns the original payment even when the replay differs', async () => {
      // A retry is a retry. The key identifies the submission, so a replay
      // that somehow carried a different amount must not create a second
      // payment — and must not silently apply the different amount either.
      const { scenario, loanId } = await tenCollectionLoan();
      const key = newIdempotencyKey();

      const first = await postPayment(loanId, scenario.secretary, {
        amount: 11_500,
        idempotencyKey: key,
      });

      const second = await postPayment(loanId, scenario.secretary, {
        amount: 23_000,
        idempotencyKey: key,
      });

      expect(second).toBe(first);

      const ledger = await readLedger(loanId);
      expect(ledger.totalPaid).toBe(11_500);
    });

    it('enforces key uniqueness at the database, not only in the function', async () => {
      const { scenario, loanId } = await tenCollectionLoan();
      const key = newIdempotencyKey();

      await postPayment(loanId, scenario.secretary, {
        amount: 11_500,
        idempotencyKey: key,
      });

      // A direct insert bypassing the function still cannot reuse the key.
      await expect(
        query(
          `insert into public.loan_payments
             (loan_id, client_id, amount, payment_method, idempotency_key,
              recorded_by, outstanding_before, outstanding_after,
              client_name_at_payment, recorded_by_label)
           select l.id, l.client_id, 1, 'cash', $2, $3, 1, 0, 'X', 'Y'
             from public.loans l where l.id = $1`,
          [loanId, key, scenario.secretary.profileId],
        ),
      ).rejects.toThrow(/idempotency_key/);
    });
  });

  // =========================================================================
  describe('which loans can receive a payment', () => {
    it('refuses a draft', async () => {
      const scenario = await createLoanScenario();
      const loanId = await createDraftLoan(scenario.clientId);

      const attempt = await tryPostPayment(loanId, scenario.secretary, {
        amount: 1_000,
      });

      expect(attempt.ok).toBe(false);
      expect(attempt.message).toMatch(/only be recorded against an active loan/i);
    });

    it('refuses an approved loan that has not been disbursed', async () => {
      const scenario = await createLoanScenario();
      const loanId = await createDraftLoan(scenario.clientId);
      await approveLoan(loanId, scenario);

      const attempt = await tryPostPayment(loanId, scenario.secretary, {
        amount: 1_000,
      });

      expect(attempt.ok).toBe(false);
      expect(attempt.message).toMatch(/only be recorded against an active loan/i);
    });

    it('refuses a cancelled loan', async () => {
      const scenario = await createLoanScenario();
      const loanId = await createDraftLoan(scenario.clientId);
      await approveLoan(loanId, scenario);
      await cancelLoan(loanId, scenario, 'withdrawn by the borrower');

      const attempt = await tryPostPayment(loanId, scenario.secretary, {
        amount: 1_000,
      });

      expect(attempt.ok).toBe(false);
      expect(attempt.message).toMatch(/active loan/i);
    });

    it('refuses a loan that does not exist', async () => {
      const scenario = await createLoanScenario();

      const attempt = await tryPostPayment(
        '00000000-0000-4000-8000-00000000dead',
        scenario.secretary,
        { amount: 1_000 },
      );

      expect(attempt.ok).toBe(false);
      expect(attempt.message).toMatch(/No such loan/i);
    });

    it('accepts a payment from a blacklisted borrower', async () => {
      // Eligibility gates *lending*, not repayment. Refusing a suspended
      // borrower's money would be commercially absurd and a way to
      // manufacture arrears.
      const scenario = await createLoanScenario();
      const loanId = await createDraftLoan(scenario.clientId, {
        principal: 100_000,
        termMonths: 1,
        frequency: 'every_3_days',
      });
      await disburseLoan(loanId, scenario);

      await query(
        `update public.clients
            set status = 'blacklisted', status_reason = 'test'
          where id = $1`,
        [scenario.clientId],
      );

      const attempt = await tryPostPayment(loanId, scenario.secretary, {
        amount: 11_500,
      });

      expect(attempt.ok).toBe(true);
    });
  });

  // =========================================================================
  describe('reconciliation, stated over the whole database', () => {
    it('allocates exactly the amount of every posted payment', async () => {
      // The specification's headline invariant.
      const mismatched = await query<{ payment_number: string }>(
        `select lp.payment_number
           from public.loan_payments lp
           left join (
             select payment_id, sum(allocated_amount) as allocated
               from public.payment_allocations group by payment_id
           ) a on a.payment_id = lp.id
          where coalesce(a.allocated, 0) <> lp.amount`,
      );

      expect(mismatched).toEqual([]);
    });

    it('keeps every allocation"s components summing to its amount', async () => {
      const broken = await query<{ id: string }>(
        `select id from public.payment_allocations
          where allocated_amount <> allocated_principal + allocated_interest`,
      );

      expect(broken).toEqual([]);
    });

    it('keeps paid plus outstanding equal to the contractual total', async () => {
      const broken = await query<{ loan_number: string }>(
        `select loan_number from public.loan_balances
          where scheduled_total > 0
            and total_paid + outstanding <> scheduled_total`,
      );

      expect(broken).toEqual([]);
    });

    it('keeps posted payments equal to posted allocations, per loan', async () => {
      const broken = await query<{ loan_number: string }>(
        `select loan_number from public.loan_balances
          where posted_payment_total <> total_paid`,
      );

      expect(broken).toEqual([]);
    });

    it('keeps the principal and interest splits reconciling', async () => {
      const broken = await query<{ loan_number: string }>(
        `select loan_number from public.loan_balances
          where scheduled_total > 0
            and (principal_paid + principal_remaining <> contractual_principal
              or interest_paid + interest_remaining <> contractual_interest
              or principal_paid + interest_paid <> total_paid)`,
      );

      expect(broken).toEqual([]);
    });

    it('matches every cleared loan to a zero balance, and no other', async () => {
      const broken = await query<{ loan_number: string; status: string }>(
        `select loan_number, status from public.loan_balances
          where (status = 'cleared') <> (scheduled_total > 0 and outstanding = 0)
            and scheduled_total > 0`,
      );

      expect(broken).toEqual([]);
    });
  });

  // =========================================================================
  describe('the audit trail', () => {
    it('records the posting with its figures and no network reference', async () => {
      const { scenario, loanId } = await tenCollectionLoan();

      const paymentId = await postPayment(loanId, scenario.secretary, {
        amount: 23_000,
        method: 'mtn_mobile_money',
        externalReference: 'AUDIT-REF-7777',
      });

      const event = await queryOne<{
        new_values: Record<string, unknown>;
        actor_profile_id: string;
      }>(
        `select new_values, actor_profile_id::text from public.audit_log
          where entity_type = 'payment' and entity_id = $1
            and action = 'payment.posted'`,
        [paymentId],
      );

      expect(event.new_values).toMatchObject({
        amount: 23_000,
        payment_method: 'mtn_mobile_money',
        outstanding_before: 115_000,
        outstanding_after: 92_000,
        status: 'posted',
        // Whether a reference was captured, not what it was.
        has_external_reference: true,
      });

      expect(event.actor_profile_id).toBe(scenario.secretary.profileId);

      // The reference itself is a handle on the borrower's transaction with a
      // third party, and `audit:view` is broader than `payments:view`.
      expect(JSON.stringify(event.new_values)).not.toContain('AUDIT-REF-7777');
    });

    it('records one allocation event per payment, with the split and no rows', async () => {
      const { scenario, loanId } = await tenCollectionLoan();

      const paymentId = await postPayment(loanId, scenario.secretary, {
        amount: 28_000,
      });

      const event = await queryOne<{ new_values: Record<string, unknown> }>(
        `select new_values from public.audit_log
          where entity_type = 'payment' and entity_id = $1
            and action = 'payment.allocated'`,
        [paymentId],
      );

      expect(event.new_values).toMatchObject({
        allocation_count: 3,
        allocated_amount: 28_000,
        // 10,000 + 10,000 + 3,500 principal; 1,500 × 3 interest.
        allocated_principal: 23_500,
        allocated_interest: 4_500,
        first_collection: 1,
        last_collection: 3,
      });

      const serialised = JSON.stringify(event.new_values);
      expect(serialised).not.toMatch(/installment_id/);
      expect(serialised.length).toBeLessThan(600);
    });

    it('records no borrower identity in a payment event', async () => {
      const { scenario, loanId } = await tenCollectionLoan();

      const nin = await queryOne<{ nin: string }>(
        `select nin from public.client_identities where client_id = $1`,
        [scenario.clientId],
      );

      const paymentId = await postPayment(loanId, scenario.secretary, {
        amount: 11_500,
      });

      const events = await query<{ new_values: Record<string, unknown> }>(
        `select new_values from public.audit_log
          where entity_type = 'payment' and entity_id = $1`,
        [paymentId],
      );

      expect(events.length).toBeGreaterThan(0);

      for (const event of events) {
        const serialised = JSON.stringify(event.new_values);
        expect(serialised).not.toContain(nin.nin);
        expect(serialised).not.toContain('Loan Borrower');
      }
    });

    it('records the balance that justified a clearance', async () => {
      const { scenario, loanId } = await tenCollectionLoan();

      await postPayment(loanId, scenario.secretary, { amount: 115_000 });

      const event = await queryOne<{
        new_values: Record<string, unknown>;
        old_values: Record<string, unknown>;
      }>(
        `select new_values, old_values from public.audit_log
          where entity_type = 'loan' and entity_id = $1 and action = 'loan.cleared'`,
        [loanId],
      );

      expect(event.old_values).toMatchObject({ status: 'active' });
      expect(event.new_values).toMatchObject({
        status: 'cleared',
        outstanding: 0,
        total_expected_repayment: 115_000,
      });
      expect(event.new_values.cleared_at).not.toBeNull();
    });
  });
});
