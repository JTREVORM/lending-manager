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
  createFourThousandLoan,
  deleteTestPenalties,
  readBusinessDate,
  readDelinquency,
  readLoanDates,
  restoreSeededLendingTerms,
  shiftDate,
} from '../helpers/delinquency-fixtures';
import { closePool, hasDatabase, query, skipReason } from '../helpers/db';

/**
 * Delinquency, as the database derives it.
 *
 * ## Why every test fixes the business date
 *
 * Arrears are a comparison between a due date and today, so a suite that used
 * the real today would mean something different every morning. Each test sets
 * `app.business_now`, which the database honours only for a direct owner
 * connection — see `tests/helpers/delinquency-fixtures.ts` and migration
 * `20261007000200`.
 *
 * ## Why the figures are hard-coded
 *
 * Every expectation is a literal, with the arithmetic in a comment. The one
 * thing a delinquency suite must not do is compute its expectations the way
 * the code computes its answers.
 */
const describeDb = hasDatabase ? describe : describe.skip;

if (!hasDatabase) {
  describe('delinquency suite', () => {
    it.skip(`skipped — ${skipReason}`, () => undefined);
  });
}

describeDb('delinquency', () => {
  beforeAll(async () => {
    // Payments first: an allocation to a penalty references it, and
    // financial history is `on delete restrict` precisely so it cannot
    // cascade away.
    await deleteTestPayments();
    await deleteTestPenalties();
    await deleteTestLoans();
    await deleteTestUsers();
  });

  afterAll(async () => {
    // Payments first: an allocation to a penalty references it, and
    // financial history is `on delete restrict` precisely so it cannot
    // cascade away.
    await deleteTestPayments();
    await deleteTestPenalties();
    await deleteTestLoans();
    await deleteTestUsers();
    await restoreSeededLendingTerms();
    await closePool();
  });

  // =========================================================================
  describe('the business date', () => {
    it('reads today in the business timezone, not UTC', async () => {
      // 23:30 UTC on the 9th is already 02:30 on the 10th in Kampala. A
      // system that asked UTC would report the 9th and call a collection due
      // on the 10th "not yet due" for three hours after it was.
      expect(await readBusinessDate('2026-11-09 23:30:00+00')).toBe('2026-11-10');
      // And 00:30 UTC on the 10th is 03:30 the same day.
      expect(await readBusinessDate('2026-11-10 00:30:00+00')).toBe('2026-11-10');
      // While 21:30 UTC on the 9th is still the 9th in Kampala (00:30 on the
      // 10th is three hours later).
      expect(await readBusinessDate('2026-11-09 20:30:00+00')).toBe('2026-11-09');
    });

    it('follows the configured timezone when it changes', async () => {
      await query(`update public.company_settings set timezone = 'UTC' where id = 1`);

      try {
        // The same instant, read in UTC, is the 9th.
        expect(await readBusinessDate('2026-11-09 23:30:00+00')).toBe('2026-11-09');
      } finally {
        await query(
          `update public.company_settings set timezone = 'Africa/Kampala' where id = 1`,
        );
      }

      expect(await readBusinessDate('2026-11-09 23:30:00+00')).toBe('2026-11-10');
    });

    it('is not movable by a session role', async () => {
      // The override is gated on `session_user` owning the tables. A session
      // that has switched to `authenticated` still has the owner's
      // `session_user` in these tests — which is the point of the gate being
      // about the *connection* — so this asserts the other half: an
      // `authenticated` role cannot set the parameter at all through any
      // path the application exposes, and `set_config` is not among the
      // functions granted to it.
      const granted = await query<{ ok: boolean }>(
        `select has_function_privilege('authenticated',
                  'public.business_date()', 'execute') as ok`,
      );

      expect(granted[0]?.ok).toBe(true);

      const owner = await query<{ ok: boolean }>(
        `select has_function_privilege('authenticated',
                  'public.is_table_owner_session()', 'execute') as ok`,
      );

      // The gate itself is not callable by a session role.
      expect(owner[0]?.ok).toBe(false);
    });
  });

  // =========================================================================
  describe('arrears, due today and current due', () => {
    it('specification scenario A — one missed collection makes UGX 8,000 due', async () => {
      const scenario = await createLoanScenario();
      const loan = await createFourThousandLoan(scenario);

      // The day after the first collection, with nothing paid.
      const dayTwo = await shiftDate(loan.firstDue, 1);
      const position = await readDelinquency(loan.loanId, businessInstant(dayTwo));

      expect(position.businessDate).toBe(dayTwo);
      // The first collection, uncovered.
      expect(position.arrearsAmount).toBe(4_000);
      expect(position.dueTodayAmount).toBe(4_000);
      // 4,000 + 4,000.
      expect(position.currentDue).toBe(8_000);
      expect(position.missedInstallmentCount).toBe(1);
      expect(position.daysPastDue).toBe(1);
      expect(position.oldestPastDueDate).toBe(loan.firstDue);
      expect(position.oldestUnpaidDueDate).toBe(loan.firstDue);
      expect(position.state).toBe('in_arrears');
    });

    it('does not rewrite either scheduled row to produce that figure', async () => {
      const scenario = await createLoanScenario();
      const loan = await createFourThousandLoan(scenario);

      const dayTwo = await shiftDate(loan.firstDue, 1);
      await readDelinquency(loan.loanId, businessInstant(dayTwo));

      const rows = await query<{ n: string; amount: string; due: string }>(
        `select installment_number::text as n, expected_amount::text as amount,
                due_date::text as due
           from public.loan_installments
          where loan_id = $1 and installment_number <= 2
          order by installment_number`,
        [loan.loanId],
      );

      // Both stay at 4,000, on their own dates. The 8,000 is derived.
      expect(rows.map((row) => row.amount)).toEqual(['4000', '4000']);
      expect(rows[0]?.due).toBe(loan.firstDue);
      expect(rows[1]?.due).toBe(dayTwo);
    });

    it('specification scenario C — two missed collections make UGX 12,000', async () => {
      const scenario = await createLoanScenario();
      const loan = await createFourThousandLoan(scenario);

      const dayThree = await shiftDate(loan.firstDue, 2);
      const position = await readDelinquency(loan.loanId, businessInstant(dayThree));

      // 4,000 + 4,000 behind, 4,000 today.
      expect(position.arrearsAmount).toBe(8_000);
      expect(position.dueTodayAmount).toBe(4_000);
      expect(position.currentDue).toBe(12_000);
      expect(position.missedInstallmentCount).toBe(2);
      expect(position.daysPastDue).toBe(2);
    });

    it('specification scenario B — paying UGX 8,000 clears the demand', async () => {
      const scenario = await createLoanScenario();
      const loan = await createFourThousandLoan(scenario);

      const dayTwo = await shiftDate(loan.firstDue, 1);

      await postPayment(loan.loanId, scenario.secretary, {
        amount: 8_000,
        businessNow: businessInstant(dayTwo),
      });

      const position = await readDelinquency(loan.loanId, businessInstant(dayTwo));

      expect(position.arrearsAmount).toBe(0);
      expect(position.dueTodayAmount).toBe(0);
      expect(position.currentDue).toBe(0);
      expect(position.missedInstallmentCount).toBe(0);
      expect(position.daysPastDue).toBe(0);
      expect(position.oldestPastDueDate).toBeNull();
      expect(position.state).toBe('current');

      // And the third collection is still ahead, untouched.
      const third = await shiftDate(loan.firstDue, 2);
      expect(position.oldestUnpaidDueDate).toBe(third);
    });

    it('specification §50 — paying more than the arrears covers a future collection', async () => {
      const scenario = await createLoanScenario();
      const loan = await createFourThousandLoan(scenario);

      const dayTwo = await shiftDate(loan.firstDue, 1);

      await postPayment(loan.loanId, scenario.secretary, {
        amount: 10_000,
        businessNow: businessInstant(dayTwo),
      });

      const onDayTwo = await readDelinquency(loan.loanId, businessInstant(dayTwo));
      expect(onDayTwo.currentDue).toBe(0);

      // The next day needs only 2,000: 4,000 less the 2,000 that spilled on.
      const dayThree = await shiftDate(loan.firstDue, 2);
      const onDayThree = await readDelinquency(loan.loanId, businessInstant(dayThree));

      expect(onDayThree.arrearsAmount).toBe(0);
      expect(onDayThree.dueTodayAmount).toBe(2_000);
      expect(onDayThree.currentDue).toBe(2_000);
      expect(onDayThree.state).toBe('due_today');
    });

    it('reports nothing due before the first collection', async () => {
      const scenario = await createLoanScenario();
      const loan = await createFourThousandLoan(scenario);

      const dayBefore = await shiftDate(loan.firstDue, -1);
      const position = await readDelinquency(loan.loanId, businessInstant(dayBefore));

      expect(position.arrearsAmount).toBe(0);
      expect(position.dueTodayAmount).toBe(0);
      expect(position.currentDue).toBe(0);
      expect(position.state).toBe('current');
      expect(position.scheduledDueToDate).toBe(0);
    });

    it('treats the due date itself as on time', async () => {
      const scenario = await createLoanScenario();
      const loan = await createFourThousandLoan(scenario);

      const position = await readDelinquency(loan.loanId, businessInstant(loan.firstDue));

      expect(position.arrearsAmount).toBe(0);
      expect(position.dueTodayAmount).toBe(4_000);
      expect(position.missedInstallmentCount).toBe(0);
      expect(position.daysPastDue).toBe(0);
      expect(position.state).toBe('due_today');
    });

    it('reports the schedule-to-date figures alongside the arrears', async () => {
      const scenario = await createLoanScenario();
      const loan = await createFourThousandLoan(scenario);

      const dayThree = await shiftDate(loan.firstDue, 2);

      await postPayment(loan.loanId, scenario.secretary, {
        amount: 4_000,
        businessNow: businessInstant(dayThree),
      });

      const position = await readDelinquency(loan.loanId, businessInstant(dayThree));

      // Three collections have fallen due; one is covered.
      expect(position.scheduledDueToDate).toBe(12_000);
      expect(position.paidAgainstSchedule).toBe(4_000);
      expect(position.currentDue).toBe(8_000);
    });
  });

  // =========================================================================
  describe('partial coverage after a reversal', () => {
    it('counts only the uncovered remainder of a part-covered collection', async () => {
      // Phase 6 refuses a below-minimum payment, so the way a historical
      // collection ends up partly covered is a reversal: an overpayment
      // spills onto a later collection, and the payment that covered the
      // earlier ones is then withdrawn.
      const scenario = await createLoanScenario();
      const loan = await createFourThousandLoan(scenario);

      const dayTwo = await shiftDate(loan.firstDue, 1);
      const dayThree = await shiftDate(loan.firstDue, 2);

      // 4,000 covers collection one.
      const first = await postPayment(loan.loanId, scenario.secretary, {
        amount: 4_000,
        businessNow: businessInstant(loan.firstDue),
      });

      // 6,000 covers collection two and 2,000 of collection three.
      await postPayment(loan.loanId, scenario.secretary, {
        amount: 6_000,
        businessNow: businessInstant(dayTwo),
      });

      // Withdrawing the first payment leaves collection one wholly uncovered
      // and collection three still part-covered, which is the honest record:
      // the second payment was applied when the first still stood.
      const { reversePayment } = await import('../helpers/payment-fixtures');
      await reversePayment(
        first,
        scenario.owner,
        'testing partial historical coverage',
        businessInstant(dayThree),
      );

      const position = await readDelinquency(loan.loanId, businessInstant(dayThree));

      // Collection one 4,000 uncovered; collection two covered; collection
      // three 2,000 covered of 4,000, and it is today.
      expect(position.arrearsAmount).toBe(4_000);
      expect(position.dueTodayAmount).toBe(2_000);
      expect(position.currentDue).toBe(6_000);
      expect(position.missedInstallmentCount).toBe(1);
    });

    it('never reports more due now than the loan owes', async () => {
      const scenario = await createLoanScenario();
      const loan = await createFourThousandLoan(scenario);

      const late = await shiftDate(loan.finalDue, 1);
      const position = await readDelinquency(loan.loanId, businessInstant(late));

      expect(position.currentDue).toBeLessThanOrEqual(position.contractualOutstanding);
      // Everything has fallen due by now, so they are equal.
      expect(position.currentDue).toBe(position.contractualOutstanding);
    });
  });

  // =========================================================================
  describe('non-daily cadences', () => {
    it('reports missed collections and days late separately on every-3-days', async () => {
      await configureLendingTerms({ monthlyRateBps: 1_500, minLoanAmount: 100_000 });

      const scenario = await createLoanScenario();
      const loanId = await createDraftLoan(scenario.clientId, {
        principal: 300_000,
        termMonths: 1,
        frequency: 'every_3_days',
      });
      await disburseLoan(loanId, scenario);

      const dates = await readLoanDates(loanId);
      // Three collections have passed by nine days after the first.
      const nineDaysOn = await shiftDate(dates.firstDue, 9);

      const position = await readDelinquency(loanId, businessInstant(nineDaysOn));

      // Collections on days 3, 6, 9 of the window — the first three are at
      // firstDue, +3 and +6, all before +9, and +9 itself is due today.
      expect(position.missedInstallmentCount).toBe(3);
      // Nine calendar days since the oldest uncovered collection.
      expect(position.daysPastDue).toBe(9);
      // And the two figures are deliberately different numbers.
      expect(position.missedInstallmentCount).not.toBe(position.daysPastDue);
    });

    it('does not imply a collection was due on every calendar day', async () => {
      await configureLendingTerms({ monthlyRateBps: 1_500, minLoanAmount: 100_000 });

      const scenario = await createLoanScenario();
      const loanId = await createDraftLoan(scenario.clientId, {
        principal: 300_000,
        termMonths: 1,
        frequency: 'every_2_days',
      });
      await disburseLoan(loanId, scenario);

      const dates = await readLoanDates(loanId);
      // One day after the first collection: one missed, one day late, and
      // nothing due today, because the cadence skips a day.
      const dayAfter = await shiftDate(dates.firstDue, 1);
      const position = await readDelinquency(loanId, businessInstant(dayAfter));

      expect(position.missedInstallmentCount).toBe(1);
      expect(position.daysPastDue).toBe(1);
      expect(position.dueTodayAmount).toBe(0);
      // Due now is the one missed collection and nothing more.
      expect(position.currentDue).toBe(position.arrearsAmount);
    });
  });

  // =========================================================================
  describe('expiry and the grace period', () => {
    it('derives the completion date from the final collection, not the term', async () => {
      const scenario = await createLoanScenario();
      const loan = await createFourThousandLoan(scenario);

      const position = await readDelinquency(loan.loanId, businessInstant(loan.firstDue));

      const maxDue = await query<{ due: string }>(
        `select max(due_date)::text as due from public.loan_installments
          where loan_id = $1`,
        [loan.loanId],
      );

      expect(position.scheduledCompletionDate).toBe(maxDue[0]?.due);
      expect(position.scheduledCompletionDate).toBe(loan.finalDue);
    });

    it('walks the grace boundary day by day', async () => {
      const scenario = await createLoanScenario();
      const loan = await createFourThousandLoan(scenario, { graceDays: 3 });

      const days = [
        await shiftDate(loan.finalDue, -1),
        loan.finalDue,
        await shiftDate(loan.finalDue, 1),
        await shiftDate(loan.finalDue, 2),
        await shiftDate(loan.finalDue, 3),
        await shiftDate(loan.finalDue, 4),
        await shiftDate(loan.finalDue, 5),
      ];

      const walked = [];

      for (const day of days) {
        const position = await readDelinquency(loan.loanId, businessInstant(day));
        walked.push({
          day,
          past: position.pastFinalDueDate,
          grace: position.withinGracePeriod,
          eligible: position.penaltyEligible,
          state: position.state,
        });
      }

      expect(walked).toEqual([
        // The day before the end: ordinary arrears.
        { day: days[0], past: false, grace: false, eligible: false, state: 'in_arrears' },
        // The final due date: a payment today is on time, so still arrears
        // from the earlier collections but no grace and no penalty.
        { day: days[1], past: false, grace: false, eligible: false, state: 'in_arrears' },
        // Grace days one, two and three.
        { day: days[2], past: true, grace: true, eligible: false, state: 'grace_period' },
        { day: days[3], past: true, grace: true, eligible: false, state: 'grace_period' },
        { day: days[4], past: true, grace: true, eligible: false, state: 'grace_period' },
        // The penalty date, and after it.
        {
          day: days[5],
          past: true,
          grace: false,
          eligible: true,
          state: 'expired_unpaid',
        },
        {
          day: days[6],
          past: true,
          grace: false,
          eligible: true,
          state: 'expired_unpaid',
        },
      ]);

      // And the dates it reports are the arithmetic, stated once.
      const position = await readDelinquency(loan.loanId, businessInstant(loan.finalDue));
      expect(position.graceEndDate).toBe(await shiftDate(loan.finalDue, 3));
      expect(position.penaltyEffectiveDate).toBe(await shiftDate(loan.finalDue, 4));
      expect(position.graceDays).toBe(3);
    });

    it('uses the loan"s own snapshotted grace period, not today"s setting', async () => {
      const scenario = await createLoanScenario();
      // Approved under a ten-day grace period.
      const loan = await createFourThousandLoan(scenario, { graceDays: 10 });

      // The business then changes its mind.
      await configureLendingTerms({ graceDays: 1 });

      const position = await readDelinquency(
        loan.loanId,
        businessInstant(await shiftDate(loan.finalDue, 5)),
      );

      // Still ten days, from the loan's own snapshot. Under the new setting
      // this loan would already be penalised.
      expect(position.graceDays).toBe(10);
      expect(position.graceEndDate).toBe(await shiftDate(loan.finalDue, 10));
      expect(position.penaltyEffectiveDate).toBe(await shiftDate(loan.finalDue, 11));
      expect(position.withinGracePeriod).toBe(true);
      expect(position.penaltyEligible).toBe(false);
    });

    it('specification §77 — a loan paid off before expiry never reaches grace', async () => {
      const scenario = await createLoanScenario();
      const loan = await createFourThousandLoan(scenario);

      // Settle it in full on the first collection date.
      await postPayment(loan.loanId, scenario.secretary, {
        amount: loan.scheduledTotal,
        businessNow: businessInstant(loan.firstDue),
      });

      const ledger = await readLedger(loan.loanId);
      expect(ledger.status).toBe('cleared');

      // Long after the penalty date, there is still nothing to charge.
      const late = await shiftDate(loan.penaltyEffective, 30);
      const position = await readDelinquency(loan.loanId, businessInstant(late));

      expect(position.state).toBe('cleared');
      expect(position.penaltyEligible).toBe(false);
      expect(position.penaltyApplied).toBe(false);
      expect(position.totalOutstanding).toBe(0);
      expect(position.penaltyBasisAsOfGraceEnd).toBe(0);
    });

    it('specification §78 — paying on the final due date is on time', async () => {
      const scenario = await createLoanScenario();
      const loan = await createFourThousandLoan(scenario);

      const position = await readDelinquency(loan.loanId, businessInstant(loan.finalDue));

      expect(position.pastFinalDueDate).toBe(false);
      expect(position.withinGracePeriod).toBe(false);
      expect(position.penaltyEligible).toBe(false);
    });

    it('reports the basis as at the grace deadline, not as at today', async () => {
      const scenario = await createLoanScenario();
      const loan = await createFourThousandLoan(scenario);
      const total = loan.scheduledTotal;

      // Pay most of it inside the grace period.
      await postPayment(loan.loanId, scenario.secretary, {
        amount: total - 20_000,
        businessNow: businessInstant(await shiftDate(loan.finalDue, 1)),
      });

      const atDeadline = await readDelinquency(
        loan.loanId,
        businessInstant(loan.graceEnd),
      );
      expect(atDeadline.penaltyBasisAsOfGraceEnd).toBe(20_000);

      // Then pay 10,000 more, after the deadline.
      await postPayment(loan.loanId, scenario.secretary, {
        amount: 10_000,
        businessNow: businessInstant(await shiftDate(loan.penaltyEffective, 1)),
      });

      const afterwards = await readDelinquency(
        loan.loanId,
        businessInstant(await shiftDate(loan.penaltyEffective, 2)),
      );

      // Today's contractual balance is 10,000, but the basis was 20,000:
      // paying late must not shrink the charge.
      expect(afterwards.contractualOutstanding).toBe(10_000);
      expect(afterwards.penaltyBasisAsOfGraceEnd).toBe(20_000);

      // And that late payment did not escape the charge: posting it
      // materialised the penalty first, on the 20,000 basis. 20,000 x 50%.
      expect(afterwards.penaltyApplied).toBe(true);
      expect(afterwards.penaltyAmount).toBe(10_000);
      // Which is why nothing is projected: the charge exists.
      expect(afterwards.penaltyEligible).toBe(false);
      expect(afterwards.penaltyProjectedAmount).toBe(0);
      // 10,000 contract + 10,000 penalty.
      expect(afterwards.totalOutstanding).toBe(20_000);
    });
  });

  // =========================================================================
  describe('what the view refuses to be', () => {
    it('has no stored arrears column anywhere in the schema', async () => {
      // §76. If arrears are derived there is nothing to mutate, which is the
      // whole point. A column would be a number somebody could edit a
      // borrower into or out of.
      const columns = await query<{ table_name: string; column_name: string }>(
        `select table_name, column_name
           from information_schema.columns
          where table_schema = 'public'
            and (column_name like '%arrear%'
              or column_name like '%days_past%'
              or column_name like '%delinquen%'
              or column_name like '%missed%'
              or column_name like '%overdue%')
            and table_name in (
              select table_name from information_schema.tables
               where table_schema = 'public' and table_type = 'BASE TABLE'
            )`,
      );

      expect(columns).toEqual([]);
    });

    it('excludes loans that have no schedule', async () => {
      const scenario = await createLoanScenario();
      await configureLendingTerms({ monthlyRateBps: 1_500, minLoanAmount: 100_000 });
      const draftId = await createDraftLoan(scenario.clientId);

      const rows = await query(
        `select loan_id from public.loan_delinquency where loan_id = $1`,
        [draftId],
      );

      // A draft owes nothing because nothing was paid out, which is a
      // different thing from being up to date.
      expect(rows).toEqual([]);
    });

    it('reconciles every row it returns', async () => {
      // Stated over the whole view: current due is its parts, the total is
      // the contract plus the penalty, and nothing is negative.
      const broken = await atClock(undefined, async (exec) =>
        exec(
          `select loan_number from public.loan_delinquency
            where current_due <> arrears_amount + due_today_amount
               or arrears_amount < 0
               or due_today_amount < 0
               or current_due > contractual_outstanding
               or contractual_outstanding < 0
               or penalty_remaining < 0
               or total_outstanding <> contractual_outstanding + penalty_remaining
               or days_past_due < 0
               or missed_installment_count < 0
               or (oldest_past_due_date is null and days_past_due <> 0)
               or (arrears_amount > 0 and oldest_past_due_date is null)
               or (penalty_applied and penalty_eligible)
               or (not penalty_eligible and penalty_projected_amount <> 0)`,
        ),
      );

      expect(broken).toEqual([]);
    });

    it('never reports a cleared loan as owing anything', async () => {
      const broken = await query(
        `select loan_number from public.loan_delinquency
          where delinquency_state = 'cleared' and total_outstanding <> 0`,
      );

      expect(broken).toEqual([]);
    });
  });
});
