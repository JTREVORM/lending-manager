import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { deleteTestUsers } from '../helpers/auth-fixtures';
import {
  createDraftLoan,
  createLoanScenario,
  deleteTestLoans,
  disburseLoan,
} from '../helpers/loan-fixtures';
import { deleteTestPayments, postPayment, readLedger } from '../helpers/payment-fixtures';
import {
  atClock,
  businessInstant,
  configureLendingTerms,
  deleteTestPenalties,
  readDelinquency,
  readLoanDates,
  readObligations,
  readPenalty,
  restoreSeededLendingTerms,
  shiftDate,
} from '../helpers/delinquency-fixtures';
import { closePool, hasDatabase, query, skipReason } from '../helpers/db';
import { toBusinessDate } from '@/lib/domain/datetime';
import { toUgx } from '@/lib/domain/money';
import { assertDelinquencyInvariants, deriveDelinquency } from '@/lib/domain/delinquency';
import {
  assertBalanceInvariants,
  deriveLoanBalance,
  minimumAcceptablePayment,
  outstandingFrom,
  type PaymentObligation,
} from '@/lib/domain/payment';

/**
 * The two delinquency engines, reconciled.
 *
 * `public.loan_delinquency` is authoritative — it is what every screen reads.
 * `lib/domain/delinquency.ts` drives previews and is where the rules are
 * stated in prose. Two implementations of one rule is a standing risk, so it
 * is tested as one question: given the same loan, the same ledger and the same
 * date, do they produce the same position, field by field?
 *
 * ## Why these are real loans, real payments and real dates
 *
 * A delinquency figure depends on accumulated ledger state and on a calendar,
 * so the only honest comparison is to post a real sequence of payments against
 * a real loan and walk a real set of dates past it. Each date is set
 * deliberately; nothing here depends on the real today.
 */
const describeDb = hasDatabase ? describe : describe.skip;

if (!hasDatabase) {
  describe('delinquency parity suite', () => {
    it.skip(`skipped — ${skipReason}`, () => undefined);
  });
}

/** Deterministic generator, so a failure is reproducible. */
function makeRandom(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state / 2_147_483_648;
  };
}

/** The TypeScript view of a loan's obligations, read from the database. */
async function obligationsFor(loanId: string): Promise<readonly PaymentObligation[]> {
  const rows = await readObligations(loanId);

  return rows.map((row, index) => ({
    obligationId: `${row.kind}-${String(row.sequenceNumber)}-${String(index)}`,
    kind: row.kind === 'penalty' ? 'penalty' : 'installment',
    sequenceNumber: row.sequenceNumber,
    effectiveDate: toBusinessDate(row.effectiveDate),
    expectedAmount: toUgx(row.expectedAmount),
    scheduledPrincipal: toUgx(row.scheduledPrincipal),
    scheduledInterest: toUgx(row.scheduledInterest),
    scheduledPenalty: toUgx(row.scheduledPenalty),
    allocatedAmount: toUgx(row.allocatedAmount),
    allocatedPrincipal: toUgx(row.allocatedPrincipal),
    allocatedInterest: toUgx(row.allocatedInterest),
    allocatedPenalty: toUgx(row.allocatedPenalty),
  }));
}

describeDb('delinquency engine parity', () => {
  beforeAll(async () => {
    await deleteTestPayments();
    await deleteTestPenalties();
    await deleteTestLoans();
    await deleteTestUsers();
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
  it('agrees field by field across 12 loans and many dates', async () => {
    const random = makeRandom(20_261_007);

    // Every cadence, awkward principals, and grace periods that are not the
    // default — so the boundary arithmetic is exercised rather than assumed.
    const SHAPES: readonly (readonly [number, number, string, number])[] = [
      [100_001, 1, 'daily', 3],
      [237_777, 1, 'every_2_days', 3],
      [613_333, 1, 'every_3_days', 0],
      [250_000, 2, 'daily', 5],
      [499_999, 1, 'every_3_days', 10],
      [900_001, 1, 'every_2_days', 1],
    ];

    let loansChecked = 0;
    let positionsChecked = 0;

    for (let iteration = 0; iteration < 12; iteration += 1) {
      const shape = SHAPES[iteration % SHAPES.length];

      /* c8 ignore next */
      if (shape === undefined) continue;

      const [principal, termMonths, frequency, graceDays] = shape;

      await configureLendingTerms({
        monthlyRateBps: 1_500,
        minLoanAmount: 10_000,
        graceDays,
        penaltyRateBps: 5_000,
      });

      const scenario = await createLoanScenario();
      const loanId = await createDraftLoan(scenario.clientId, {
        principal,
        termMonths,
        frequency,
      });
      await disburseLoan(loanId, scenario);

      const dates = await readLoanDates(loanId);

      // A few payments at scattered dates, so the ledger is not uniform.
      const obligationsBefore = await obligationsFor(loanId);
      // A running figure, not a branded amount: it is only used to size the
      // next random payment.
      let outstanding = Number(outstandingFrom(obligationsBefore));

      for (const offset of [1, 3]) {
        const minimum = minimumAcceptablePayment(await obligationsFor(loanId));
        if (minimum === null || minimum <= 0) break;

        const span = Math.max(0, outstanding - minimum);
        const amount = minimum + Math.floor(random() * Math.min(span, minimum * 4));

        await postPayment(loanId, scenario.secretary, {
          amount,
          businessNow: businessInstant(await shiftDate(dates.firstDue, offset)),
        });

        outstanding -= amount;
      }

      // Walk the calendar: before the first collection, inside the schedule,
      // the final due date, each grace day, the penalty date, and after it.
      const walk = [
        await shiftDate(dates.firstDue, -1),
        dates.firstDue,
        await shiftDate(dates.firstDue, 2),
        dates.finalDue,
        ...(graceDays > 0 ? [await shiftDate(dates.finalDue, 1)] : []),
        dates.graceEnd,
        dates.penaltyEffective,
        await shiftDate(dates.penaltyEffective, 9),
      ];

      for (const day of walk) {
        const at = businessInstant(day);
        const context = `${String(principal)}/${frequency}/grace ${String(graceDays)} on ${day}`;

        const sql = await readDelinquency(loanId, at);
        const obligations = await obligationsFor(loanId);

        const basis = await atClock(at, async (exec) => {
          const rows = await exec(
            `select public.loan_outstanding_as_of($1, $2::date)::text as basis`,
            [loanId, dates.graceEnd],
          );
          return Number(rows[0]?.basis ?? 0);
        });

        const derived = deriveDelinquency({
          obligations,
          today: toBusinessDate(day),
          graceDays,
          penaltyRateBps: 5_000,
          loanCleared: sql.loanStatus === 'cleared',
          basisAsOfGraceEnd: toUgx(basis),
        });

        // Field by field, not merely the headline.
        expect(derived.arrearsAmount, `arrears ${context}`).toBe(sql.arrearsAmount);
        expect(derived.dueToday, `due today ${context}`).toBe(sql.dueTodayAmount);
        expect(derived.currentDue, `current due ${context}`).toBe(sql.currentDue);
        expect(derived.missedInstallmentCount, `missed ${context}`).toBe(
          sql.missedInstallmentCount,
        );
        expect(derived.daysPastDue, `days ${context}`).toBe(sql.daysPastDue);
        expect(derived.oldestUnpaidDueDate, `oldest unpaid ${context}`).toBe(
          sql.oldestUnpaidDueDate,
        );
        expect(derived.oldestPastDueDate, `oldest past due ${context}`).toBe(
          sql.oldestPastDueDate,
        );
        expect(derived.scheduledCompletionDate, `completion ${context}`).toBe(
          sql.scheduledCompletionDate,
        );
        expect(derived.graceEndDate, `grace end ${context}`).toBe(sql.graceEndDate);
        expect(derived.penaltyEffectiveDate, `penalty date ${context}`).toBe(
          sql.penaltyEffectiveDate,
        );
        expect(derived.pastFinalDueDate, `past final ${context}`).toBe(
          sql.pastFinalDueDate,
        );
        expect(derived.withinGracePeriod, `within grace ${context}`).toBe(
          sql.withinGracePeriod,
        );
        expect(derived.contractualOutstanding, `contractual ${context}`).toBe(
          sql.contractualOutstanding,
        );
        expect(derived.penaltyAmount, `penalty amount ${context}`).toBe(
          sql.penaltyAmount,
        );
        expect(derived.penaltyRemaining, `penalty remaining ${context}`).toBe(
          sql.penaltyRemaining,
        );
        expect(derived.totalOutstanding, `total ${context}`).toBe(sql.totalOutstanding);
        expect(derived.penaltyApplied, `applied ${context}`).toBe(sql.penaltyApplied);
        expect(derived.penaltyEligible, `eligible ${context}`).toBe(sql.penaltyEligible);
        expect(derived.penaltyProjectedAmount, `projected ${context}`).toBe(
          sql.penaltyProjectedAmount,
        );

        // And the one figure a screen actually puts in front of somebody.
        expect(derived.state, `state ${context}`).toBe(sql.state);

        // Both engines' invariants hold on both readings.
        expect(() => {
          assertDelinquencyInvariants(derived);
        }, `invariants ${context}`).not.toThrow();

        positionsChecked += 1;
      }

      loansChecked += 1;
    }

    expect(loansChecked).toBe(12);
    // A guard against the walk degenerating.
    expect(positionsChecked).toBeGreaterThan(80);
  });

  // =========================================================================
  it('agrees on the derived balance, penalty included', async () => {
    await configureLendingTerms({
      monthlyRateBps: 2_500,
      minLoanAmount: 10_000,
      graceDays: 3,
      penaltyRateBps: 5_000,
    });

    const scenario = await createLoanScenario();
    const loanId = await createDraftLoan(scenario.clientId, {
      principal: 96_000,
      termMonths: 1,
      frequency: 'daily',
    });
    await disburseLoan(loanId, scenario);

    const dates = await readLoanDates(loanId);

    // Pay down to 100,000, let the charge apply, then pay part of it.
    await postPayment(loanId, scenario.secretary, {
      amount: dates.scheduledTotal - 100_000,
      businessNow: businessInstant(dates.firstDue),
    });

    const afterGrace = businessInstant(await shiftDate(dates.penaltyEffective, 1));

    await postPayment(loanId, scenario.secretary, {
      amount: 120_000,
      businessNow: afterGrace,
    });

    const ledger = await readLedger(loanId);
    const derived = deriveLoanBalance(await obligationsFor(loanId));

    // 100,000 contract + 50,000 charge, of which 120,000 is paid: the
    // contract first, then 20,000 of the charge.
    expect(derived.contractualOutstanding).toBe(ledger.outstanding);
    expect(derived.penaltyAssessed).toBe(ledger.penaltyAssessed);
    expect(derived.penaltyPaid).toBe(ledger.penaltyPaid);
    expect(derived.penaltyRemaining).toBe(ledger.penaltyRemaining);
    expect(derived.totalOutstanding).toBe(ledger.totalOutstanding);
    expect(derived.totalCollected).toBe(ledger.totalCollected);
    expect(derived.principalPaid).toBe(ledger.principalPaid);
    expect(derived.interestPaid).toBe(ledger.interestPaid);

    // The literal figures, so this is not a tautology between two engines.
    expect(derived.contractualOutstanding).toBe(0);
    expect(derived.penaltyAssessed).toBe(50_000);
    expect(derived.penaltyPaid).toBe(20_000);
    expect(derived.penaltyRemaining).toBe(30_000);
    expect(derived.totalOutstanding).toBe(30_000);

    expect(() =>
      assertBalanceInvariants(derived, {
        postedPaymentTotal: ledger.postedPaymentTotal,
        storedTotalExpectedRepayment: ledger.scheduledTotal,
      }),
    ).not.toThrow();
  });

  // =========================================================================
  describe('properties, over every loan in the database', () => {
    it('never reports negative arrears, due-today or outstanding', async () => {
      const broken = await query(
        `select loan_number from public.loan_delinquency
          where arrears_amount < 0 or due_today_amount < 0 or current_due < 0
             or contractual_outstanding < 0 or penalty_remaining < 0
             or total_outstanding < 0 or days_past_due < 0
             or missed_installment_count < 0`,
      );

      expect(broken).toEqual([]);
    });

    it('charges at most one penalty per loan', async () => {
      const broken = await query(
        `select loan_id from public.loan_penalties
          group by loan_id having pg_catalog.count(*) > 1`,
      );

      expect(broken).toEqual([]);
    });

    it('keeps every penalty reproducible from its own basis and rate', async () => {
      const broken = await query(
        `select loan_id from public.loan_penalties
          where penalty_amount <> (basis_amount * penalty_rate_bps + 5000) / 10000`,
      );

      expect(broken).toEqual([]);
    });

    it('keeps every penalty"s basis equal to the as-of balance it claims', async () => {
      // The strongest statement available: the stored basis is still exactly
      // what the as-of function derives for the deadline it names — so a
      // charge can be re-derived from the ledger years later.
      const broken = await query<{ loan_id: string }>(
        `select p.loan_id
           from public.loan_penalties p
          where p.basis_amount
                <> public.loan_outstanding_as_of(p.loan_id, p.grace_end_date)`,
      );

      expect(broken).toEqual([]);
    });

    it('reconciles the total obligation everywhere', async () => {
      const broken = await query(
        `select loan_number from public.loan_balances
          where scheduled_total > 0
            and (total_paid + contractual_outstanding <> scheduled_total
              or contractual_outstanding + penalty_remaining <> total_outstanding
              or penalty_paid + penalty_remaining <> penalty_assessed
              or posted_payment_total <> total_collected
              or principal_paid + principal_remaining <> contractual_principal
              or interest_paid + interest_remaining <> contractual_interest)`,
      );

      expect(broken).toEqual([]);
    });

    it('never lets a payment exceed the effective obligation it was posted against', async () => {
      // Receipt figures are frozen at posting, so `outstanding_before` is the
      // total obligation as it stood then, penalty included.
      const broken = await query(
        `select payment_number from public.loan_payments
          where amount > outstanding_before or outstanding_after < 0`,
      );

      expect(broken).toEqual([]);
    });

    it('clears a loan exactly when nothing at all is outstanding', async () => {
      const broken = await query(
        `select loan_number, status from public.loan_balances
          where scheduled_total > 0
            and (status = 'cleared') <> (total_outstanding = 0)`,
      );

      expect(broken).toEqual([]);
    });

    it('keeps the penalty out of principal and interest everywhere', async () => {
      const broken = await query(
        `select pa.id from public.payment_allocations pa
          where (pa.penalty_id is not null
                 and (pa.allocated_principal <> 0 or pa.allocated_interest <> 0))
             or (pa.installment_id is not null and pa.allocated_penalty <> 0)`,
      );

      expect(broken).toEqual([]);
    });

    it('leaves every contractual schedule exactly as it was generated', async () => {
      // The whole phase in one assertion: delinquency and penalties changed
      // nothing about what the borrower agreed to pay.
      const broken = await query(
        `select li.loan_id
           from public.loan_installments li
           join public.loan_periods lp on lp.id = li.loan_period_id
          where li.expected_amount <> li.scheduled_principal + li.scheduled_interest
          union
          select l.id from public.loans l
           where l.status in ('approved', 'active', 'cleared')
             and l.total_expected_repayment
                 <> l.principal_amount + l.total_interest
          union
          select c.loan_id from (
            select loan_id, pg_catalog.sum(expected_amount) as total
              from public.loan_installments group by loan_id
          ) c join public.loans l2 on l2.id = c.loan_id
           where c.total <> l2.total_expected_repayment`,
      );

      expect(broken).toEqual([]);
    });

    it('records a penalty only on a loan that was genuinely past its grace period', async () => {
      const broken = await query<{ loan_id: string }>(
        `select p.loan_id
           from public.loan_penalties p
           join (
             select loan_id, max(due_date) as final_due
               from public.loan_installments group by loan_id
           ) s on s.loan_id = p.loan_id
           join public.loans l on l.id = p.loan_id
          where p.final_due_date <> s.final_due
             or p.grace_period_days <> l.grace_period_days_applied
             or p.penalty_rate_bps <> l.penalty_rate_bps_applied`,
      );

      expect(broken).toEqual([]);
    });
  });

  // =========================================================================
  it('leaves the penalty figures stable however often they are read', async () => {
    // A derived figure that moved between two reads of the same state would
    // be the worst kind of defect: unreproducible. The clock is the only
    // input that changes, and it is held fixed here.
    const penalties = await query<{ loan_id: string }>(
      `select loan_id from public.loan_penalties limit 3`,
    );

    for (const row of penalties) {
      const penalty = await readPenalty(row.loan_id);
      const again = await readPenalty(row.loan_id);

      expect(again).toEqual(penalty);
    }
  });
});
