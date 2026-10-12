import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { deleteTestUsers } from '../helpers/auth-fixtures';
import {
  addProbeFrequency,
  approveLoan,
  narrowLendingRules,
  createDraftLoan,
  createLoanScenario,
  deleteTestLoans,
  disburseApprovedLoan,
  disburseLoan,
  type LoanScenario,
} from '../helpers/loan-fixtures';
import { closePool, hasDatabase, query, queryOne, skipReason } from '../helpers/db';

/**
 * Schedule generation against the real database.
 *
 * ## How expectations are derived
 *
 * Hard-coded, or derived by hand in a comment from the calendar. Nothing here
 * compares the database against `lib/domain/repayment-schedule.ts` — that is
 * `schedule-parity.test.ts`, and it is a separate question. Two
 * implementations agreeing proves they agree; it does not prove either is
 * right. So the figures below were reproduced with an independent
 * exact-`Fraction` implementation sharing no code with either engine before
 * being written here.
 */
const describeDb = hasDatabase ? describe : describe.skip;

if (!hasDatabase) {
  describe('schedule generation suite', () => {
    it.skip(`skipped — ${skipReason}`, () => undefined);
  });
}

interface InstallmentRow {
  readonly installment_number: number;
  readonly loan_period_number: number;
  readonly period_installment_number: number;
  readonly due_date: string;
  readonly scheduled_principal: string;
  readonly scheduled_interest: string;
  readonly expected_amount: string;
}

/** Installments in order, as a plain object per row. */
async function installmentsFor(loanId: string): Promise<readonly InstallmentRow[]> {
  return query<InstallmentRow>(
    `select installment_number, loan_period_number, period_installment_number,
            due_date::text as due_date,
            scheduled_principal::text as scheduled_principal,
            scheduled_interest::text as scheduled_interest,
            expected_amount::text as expected_amount
       from public.loan_installments
      where loan_id = $1
      order by installment_number`,
    [loanId],
  );
}

function sum(rows: readonly InstallmentRow[], key: keyof InstallmentRow): number {
  return rows.reduce((total, row) => total + Number(row[key]), 0);
}

/**
 * Disburse at a chosen instant.
 *
 * `disbursed_at` is stamped by the transition trigger from `now()`, which a
 * test cannot choose. Postgres evaluates `now()` as the transaction start
 * time, so setting the transaction's clock would need superuser tricks that
 * would prove less than they cost.
 *
 * Instead the loan is disbursed normally and the *schedule* is then generated
 * from a chosen date — by moving the loan's `disbursed_at` with the guard
 * trigger briefly disabled, exactly the documented owner-level exemption the
 * other fixtures use, and only ever before a schedule exists. The generation
 * path under test is untouched.
 */
const REGENERATION_GUARDS = [
  ['loan_installments', 'loan_installments_no_delete'],
  ['loan_schedules', 'loan_schedules_no_delete'],
  ['loans', 'loans_guard_transition'],
] as const;

/**
 * Move an already-disbursed loan's `disbursed_at`, then regenerate.
 *
 * `setClause` is applied to `public.loans`. The guards are lifted only
 * around the rewrite, never around generation itself, so the code under test
 * runs exactly as it does in production.
 */
async function regenerateWith(loanId: string, setClause: string): Promise<void> {
  for (const [table, trigger] of REGENERATION_GUARDS) {
    await query(`alter table public.${table} disable trigger ${trigger}`);
  }

  try {
    await query(`delete from public.loan_installments where loan_id = $1`, [loanId]);
    await query(`delete from public.loan_schedules where loan_id = $1`, [loanId]);
    await query(`update public.loans set ${setClause} where id = $1`, [loanId]);
  } finally {
    for (const [table, trigger] of REGENERATION_GUARDS) {
      await query(`alter table public.${table} enable trigger ${trigger}`);
    }
  }

  await query(`select public.generate_loan_schedule($1)`, [loanId]);
}

async function disburseOnDate(
  loanId: string,
  actors: LoanScenario,
  businessDate: string,
): Promise<void> {
  // The ordinary path first, so every lifecycle rule actually runs.
  await disburseLoan(loanId, actors);

  // 12:00 local, clear of either midnight, so the business-date conversion is
  // unambiguous and the date under test is the date intended.
  await regenerateWith(
    loanId,
    `disbursed_at = ('${businessDate}'::date + time '12:00') at time zone 'Africa/Kampala'`,
  );
}

/** Disburse, then re-anchor on a precise UTC instant. */
async function disburseAtInstant(
  loanId: string,
  actors: LoanScenario,
  instantUtc: string,
): Promise<void> {
  await disburseLoan(loanId, actors);
  await regenerateWith(loanId, `disbursed_at = '${instantUtc}'::timestamptz`);
}

describeDb('repayment schedule generation', () => {
  beforeAll(async () => {
    await deleteTestLoans();
    await deleteTestUsers();
  });

  afterAll(async () => {
    await deleteTestLoans();
    await deleteTestUsers();
    await closePool();
  });

  // =========================================================================
  describe('the three confirmed loans, at every frequency', () => {
    // Contract totals from the approved Phase 4 figures.
    const CONFIRMED = [
      { principal: 100_000, termMonths: 1, contractTotal: 115_000 },
      { principal: 200_000, termMonths: 2, contractTotal: 245_000 },
      { principal: 600_000, termMonths: 3, contractTotal: 780_000 },
    ] as const;

    const FREQUENCIES = [
      { key: 'daily', intervalDays: 1 },
      { key: 'every_2_days', intervalDays: 2 },
      { key: 'every_3_days', intervalDays: 3 },
    ] as const;

    for (const { principal, termMonths, contractTotal } of CONFIRMED) {
      for (const { key, intervalDays } of FREQUENCIES) {
        it(`collects exactly ${String(contractTotal)} for ${String(principal)} over ${String(termMonths)} month(s) at ${key}`, async () => {
          const scenario = await createLoanScenario();
          const loanId = await createDraftLoan(scenario.clientId, {
            principal,
            termMonths,
            frequency: key,
          });

          await disburseOnDate(loanId, scenario, '2026-10-10');

          const rows = await installmentsFor(loanId);

          // The one assertion that matters most in Phase 5: whichever rhythm
          // the borrower collects on, the loan is worth the same.
          expect(sum(rows, 'expected_amount')).toBe(contractTotal);
          expect(sum(rows, 'scheduled_principal')).toBe(principal);
          expect(sum(rows, 'scheduled_interest')).toBe(contractTotal - principal);

          // And the header records the cadence that produced it.
          const header = await queryOne<{
            interval_days: number;
            disbursement_date: string;
            repayment_frequency: string;
          }>(
            `select interval_days, disbursement_date::text as disbursement_date,
                    repayment_frequency
               from public.loan_schedules where loan_id = $1`,
            [loanId],
          );

          expect(header.interval_days).toBe(intervalDays);
          expect(header.repayment_frequency).toBe(key);
          expect(header.disbursement_date).toBe('2026-10-10');
        });
      }
    }

    it('reconciles every contractual month independently, not just the loan total', async () => {
      // The stronger check: a loan total can balance while two months are
      // wrong in opposite directions.
      const scenario = await createLoanScenario();
      const loanId = await createDraftLoan(scenario.clientId, {
        principal: 600_000,
        termMonths: 3,
        frequency: 'daily',
      });

      await disburseOnDate(loanId, scenario, '2026-10-10');

      const mismatches = await query<{ period_number: number }>(
        `select lp.period_number
           from public.loan_periods lp
           join public.loan_installments li on li.loan_period_id = lp.id
          where lp.loan_id = $1
          group by lp.period_number, lp.principal_portion, lp.interest,
                   lp.total_obligation
         having sum(li.scheduled_principal) <> lp.principal_portion
             or sum(li.scheduled_interest)  <> lp.interest
             or sum(li.expected_amount)     <> lp.total_obligation`,
        [loanId],
      );

      expect(mismatches).toEqual([]);
    });

    it('matches the hand-computed daily schedule for 200,000 over 2 months', async () => {
      const scenario = await createLoanScenario();
      const loanId = await createDraftLoan(scenario.clientId, {
        principal: 200_000,
        termMonths: 2,
        frequency: 'daily',
      });

      await disburseOnDate(loanId, scenario, '2026-10-10');

      const rows = await installmentsFor(loanId);

      // Month 1: 10 Oct to 10 Nov is 31 days, so a daily cadence starting
      // 11 Oct fits 30 collections, 11 Oct .. 9 Nov.
      // Month 2: 10 Nov to 10 Dec is 30 days, cadence 10 Nov .. 9 Dec = 30.
      expect(rows).toHaveLength(60);

      // Month 1 carries 130,000: principal 100,000 / 30 = 3,333 remainder 10,
      // so the last ten collections carry 3,334; interest 30,000 / 30 = 1,000.
      expect(rows[0]).toMatchObject({
        installment_number: 1,
        loan_period_number: 1,
        period_installment_number: 1,
        due_date: '2026-10-11',
        scheduled_principal: '3333',
        scheduled_interest: '1000',
        expected_amount: '4333',
      });

      // The twenty-first collection is the first to carry a remainder
      // shilling: 21 > 30 - 10.
      expect(rows[20]?.scheduled_principal).toBe('3334');
      expect(rows[19]?.scheduled_principal).toBe('3333');

      // The last collection of month 1 is the day before the boundary.
      expect(rows[29]).toMatchObject({
        due_date: '2026-11-09',
        loan_period_number: 1,
        period_installment_number: 30,
      });

      // Month 2 opens on the boundary date itself: windows are
      // start-inclusive, so 10 November belongs to the month that starts.
      expect(rows[30]).toMatchObject({
        due_date: '2026-11-10',
        loan_period_number: 2,
        period_installment_number: 1,
        scheduled_principal: '3333',
        scheduled_interest: '500',
        expected_amount: '3833',
      });

      expect(rows.at(-1)?.due_date).toBe('2026-12-09');
    });

    it('gives the third month 31 collections for 600,000 daily, not 30', async () => {
      const scenario = await createLoanScenario();
      const loanId = await createDraftLoan(scenario.clientId, {
        principal: 600_000,
        termMonths: 3,
        frequency: 'daily',
      });

      await disburseOnDate(loanId, scenario, '2026-10-10');

      const counts = await query<{ loan_period_number: number; n: string }>(
        `select loan_period_number, count(*)::text as n
           from public.loan_installments where loan_id = $1
          group by loan_period_number order by loan_period_number`,
        [loanId],
      );

      // 10 Oct–10 Nov = 31 days, 10 Nov–10 Dec = 30, 10 Dec–10 Jan = 31. The
      // cadence starts the day after disbursement, giving 30, 30, 31 — 91 in
      // total, not the 90 that "daily means 30 a month" would predict.
      expect(counts.map((row) => Number(row.n))).toEqual([30, 30, 31]);
    });
  });

  // =========================================================================
  describe('the first collection date', () => {
    it.each([
      ['daily', '2026-10-11'],
      ['every_2_days', '2026-10-12'],
      ['every_3_days', '2026-10-13'],
    ])('for %s falls on %s after a 10 October disbursement', async (key, expected) => {
      const scenario = await createLoanScenario();
      const loanId = await createDraftLoan(scenario.clientId, {
        principal: 100_000,
        termMonths: 1,
        frequency: key,
      });

      await disburseOnDate(loanId, scenario, '2026-10-10');

      const row = await queryOne<{ first_due: string }>(
        `select min(due_date)::text as first_due from public.loan_installments
          where loan_id = $1`,
        [loanId],
      );

      expect(row.first_due).toBe(expected);
    });

    it('is never the disbursement date itself', async () => {
      const scenario = await createLoanScenario();
      const loanId = await createDraftLoan(scenario.clientId, {
        principal: 100_000,
        termMonths: 1,
      });

      await disburseOnDate(loanId, scenario, '2026-10-10');

      const row = await queryOne<{ n: string }>(
        `select count(*)::text as n from public.loan_installments li
           join public.loan_schedules ls on ls.loan_id = li.loan_id
          where li.loan_id = $1 and li.due_date <= ls.disbursement_date`,
        [loanId],
      );

      expect(Number(row.n)).toBe(0);
    });
  });

  // =========================================================================
  describe('month ends and leap years', () => {
    it.each([
      '2027-01-28',
      '2027-01-29',
      '2027-01-30',
      '2027-01-31',
      '2027-02-28',
      '2028-01-29',
      '2028-01-31',
      '2028-02-28',
      '2028-02-29',
      // April has 30 days and August 31; the year is chosen only so the date
      // is in the future, because `loans_disbursed_after_approved` rightly
      // refuses a disbursement stamped before its own approval.
      '2027-04-30',
      '2027-08-31',
      '2026-12-31',
    ])('reconciles a 3-month daily loan disbursed on %s', async (disbursedOn) => {
      const scenario = await createLoanScenario();
      const loanId = await createDraftLoan(scenario.clientId, {
        principal: 600_000,
        termMonths: 3,
        frequency: 'daily',
      });

      await disburseOnDate(loanId, scenario, disbursedOn);

      const rows = await installmentsFor(loanId);

      expect(sum(rows, 'expected_amount')).toBe(780_000);

      // Every contractual month got collections.
      const months = new Set(rows.map((row) => row.loan_period_number));
      expect([...months].sort()).toEqual([1, 2, 3]);

      // Dates strictly increasing, which also rules out duplicates.
      const dates = rows.map((row) => row.due_date);
      expect([...dates].sort()).toEqual(dates);
      expect(new Set(dates).size).toBe(dates.length);
    });

    it('clamps 31 January to 28 February and recovers the 31st in March', async () => {
      const scenario = await createLoanScenario();
      const loanId = await createDraftLoan(scenario.clientId, {
        principal: 600_000,
        termMonths: 3,
        frequency: 'daily',
      });

      await disburseOnDate(loanId, scenario, '2027-01-31');

      const counts = await query<{ loan_period_number: number; n: string }>(
        `select loan_period_number, count(*)::text as n
           from public.loan_installments where loan_id = $1
          group by loan_period_number order by loan_period_number`,
        [loanId],
      );

      // Windows anchored on 31 Jan: [31 Jan, 28 Feb) = 28 days → 27
      // collections; [28 Feb, 31 Mar) = 31 days → 31; [31 Mar, 30 Apr) = 30
      // days → 30. The 31st returns in March because every boundary is
      // computed from the disbursement date, not stepped from the last one.
      expect(counts.map((row) => Number(row.n))).toEqual([27, 31, 30]);
    });

    it('uses the leap day when it exists', async () => {
      const scenario = await createLoanScenario();
      const loanId = await createDraftLoan(scenario.clientId, {
        principal: 100_000,
        termMonths: 1,
        frequency: 'daily',
      });

      await disburseOnDate(loanId, scenario, '2028-01-31');

      const rows = await installmentsFor(loanId);

      // 31 Jan 2028 + 1 month clamps to 29 Feb 2028, a 29-day window, so the
      // cadence 1 Feb .. 28 Feb is 28 collections — one more than the
      // common-year case above.
      expect(rows).toHaveLength(28);
      expect(rows.at(-1)?.due_date).toBe('2028-02-28');
      expect(sum(rows, 'expected_amount')).toBe(115_000);
    });

    it('collects on 29 February when the schedule spans it', async () => {
      const scenario = await createLoanScenario();
      const loanId = await createDraftLoan(scenario.clientId, {
        principal: 300_000,
        termMonths: 1,
        frequency: 'daily',
      });

      await disburseOnDate(loanId, scenario, '2028-02-28');

      const rows = await installmentsFor(loanId);

      expect(rows.some((row) => row.due_date === '2028-02-29')).toBe(true);
    });
  });

  // =========================================================================
  describe('the business timezone', () => {
    it('anchors on the Kampala calendar date, not the UTC one', async () => {
      const scenario = await createLoanScenario();
      const loanId = await createDraftLoan(scenario.clientId, {
        principal: 100_000,
        termMonths: 1,
      });

      // 22:30 UTC on 10 October is 01:30 on 11 October in Kampala. Anchoring
      // on the UTC date would put every collection a day early.
      await disburseAtInstant(loanId, scenario, '2026-10-10T22:30:00Z');

      const header = await queryOne<{ disbursement_date: string; tz: string }>(
        `select disbursement_date::text as disbursement_date,
                business_timezone as tz
           from public.loan_schedules where loan_id = $1`,
        [loanId],
      );

      expect(header.disbursement_date).toBe('2026-10-11');
      expect(header.tz).toBe('Africa/Kampala');

      const first = await queryOne<{ first_due: string }>(
        `select min(due_date)::text as first_due from public.loan_installments
          where loan_id = $1`,
        [loanId],
      );

      // One day after the *local* disbursement date.
      expect(first.first_due).toBe('2026-10-12');
    });

    it('keeps an evening-UTC disbursement on the same Kampala day', async () => {
      const scenario = await createLoanScenario();
      const loanId = await createDraftLoan(scenario.clientId, {
        principal: 100_000,
        termMonths: 1,
      });

      // 20:59 UTC is 23:59 Kampala — still the 10th. One minute later it
      // rolls over, which the previous test covers.
      await disburseAtInstant(loanId, scenario, '2026-10-10T20:59:00Z');

      const header = await queryOne<{ disbursement_date: string }>(
        `select disbursement_date::text as disbursement_date
           from public.loan_schedules where loan_id = $1`,
        [loanId],
      );

      expect(header.disbursement_date).toBe('2026-10-10');
    });
  });

  // =========================================================================
  describe('disbursement and generation are one transaction', () => {
    it('produces a complete schedule as part of disbursing', async () => {
      const scenario = await createLoanScenario();
      const loanId = await createDraftLoan(scenario.clientId, {
        principal: 600_000,
        termMonths: 3,
      });

      await disburseLoan(loanId, scenario);

      const row = await queryOne<{ status: string; n: string; has_header: boolean }>(
        `select l.status,
                (select count(*)::text from public.loan_installments
                  where loan_id = l.id) as n,
                exists (select 1 from public.loan_schedules where loan_id = l.id)
                  as has_header
           from public.loans l where l.id = $1`,
        [loanId],
      );

      expect(row.status).toBe('active');
      expect(row.has_header).toBe(true);
      expect(Number(row.n)).toBeGreaterThan(0);
    });

    it('leaves no active loan without a schedule, anywhere in the database', async () => {
      // The invariant stated over the whole table rather than one loan, so a
      // path that somehow activated a loan without generating would be caught
      // whichever test created it.
      const orphans = await query<{ id: string }>(
        `select l.id from public.loans l
          where l.status = 'active'
            and not exists (select 1 from public.loan_schedules s where s.loan_id = l.id)`,
      );

      expect(orphans).toEqual([]);
    });

    it('rolls the whole disbursement back when generation fails', async () => {
      // A cadence of 200 days cannot fit inside a calendar month, so the
      // zero-installment guard refuses. The question is what survives.
      await addProbeFrequency('every_200_days_probe', 'Every 200 days (test)', 200, 950);

      const scenario = await createLoanScenario();
      const loanId = await createDraftLoan(scenario.clientId, {
        principal: 600_000,
        termMonths: 3,
        frequency: 'every_200_days_probe',
      });

      // Approve first and take the baseline there, so the comparison isolates
      // the failed disbursement. Submission and approval are separate
      // committed transactions in the fixture, exactly as they are separate
      // acts in the application, and their audit entries are legitimate.
      await approveLoan(loanId, scenario);

      const before = await queryOne<{ n: string }>(
        `select count(*)::text as n from public.audit_log
          where entity_type = 'loan' and entity_id = $1`,
        [loanId],
      );

      await expect(disburseApprovedLoan(loanId, scenario)).rejects.toThrow(
        /would receive no collection/i,
      );

      const after = await queryOne<{
        status: string;
        disbursed_at: string | null;
        installments: string;
        headers: string;
        audit: string;
      }>(
        `select l.status,
                l.disbursed_at::text as disbursed_at,
                (select count(*)::text from public.loan_installments
                  where loan_id = l.id) as installments,
                (select count(*)::text from public.loan_schedules
                  where loan_id = l.id) as headers,
                (select count(*)::text from public.audit_log
                  where entity_type = 'loan' and entity_id = l.id::text) as audit
           from public.loans l where l.id = $1`,
        [loanId],
      );

      // The loan never became active.
      expect(after.status).toBe('approved');
      expect(after.disbursed_at).toBeNull();
      // Not one installment survived.
      expect(Number(after.installments)).toBe(0);
      expect(Number(after.headers)).toBe(0);
      // And the failed disbursement left nothing at all in the trail: the
      // `loan.disbursed` row the UPDATE produced rolled back with the rest,
      // so the count is exactly what it was before the attempt.
      expect(Number(after.audit)).toBe(Number(before.n));

      const disbursedEvents = await query<{ action: string }>(
        `select action from public.audit_log
          where entity_type = 'loan' and entity_id = $1
            and action in ('loan.disbursed', 'loan.schedule_generated')`,
        [loanId],
      );

      expect(disbursedEvents).toEqual([]);
    });
  });

  // =========================================================================
  describe('idempotency', () => {
    it('generates one schedule however many times it is called', async () => {
      const scenario = await createLoanScenario();
      const loanId = await createDraftLoan(scenario.clientId, {
        principal: 200_000,
        termMonths: 2,
      });

      await disburseLoan(loanId, scenario);

      const first = await installmentsFor(loanId);

      // Direct repeated calls, as the table owner — the most privileged
      // caller there is, and the only one that can reach the function at all.
      for (let attempt = 0; attempt < 3; attempt += 1) {
        await query(`select public.generate_loan_schedule($1)`, [loanId]);
      }

      const second = await installmentsFor(loanId);

      // Not one extra row, and not one changed value.
      expect(second).toEqual(first);

      const headers = await queryOne<{ n: string }>(
        `select count(*)::text as n from public.loan_schedules where loan_id = $1`,
        [loanId],
      );
      expect(Number(headers.n)).toBe(1);
    });

    it('records exactly one generation event, not one per call', async () => {
      const scenario = await createLoanScenario();
      const loanId = await createDraftLoan(scenario.clientId, {
        principal: 200_000,
        termMonths: 2,
      });

      await disburseLoan(loanId, scenario);
      await query(`select public.generate_loan_schedule($1)`, [loanId]);
      await query(`select public.generate_loan_schedule($1)`, [loanId]);

      const events = await query<{ new_values: Record<string, unknown> }>(
        `select new_values from public.audit_log
          where entity_type = 'loan' and entity_id = $1
            and action = 'loan.schedule_generated'`,
        [loanId],
      );

      expect(events).toHaveLength(1);
    });

    it('returns the loan id rather than failing on a repeat call', async () => {
      const scenario = await createLoanScenario();
      const loanId = await createDraftLoan(scenario.clientId);

      await disburseLoan(loanId, scenario);

      const again = await queryOne<{ generate_loan_schedule: string }>(
        `select public.generate_loan_schedule($1)`,
        [loanId],
      );

      expect(again.generate_loan_schedule).toBe(loanId);
    });

    it('refuses a second disbursement, so a schedule cannot be re-derived', async () => {
      const scenario = await createLoanScenario();
      const loanId = await createDraftLoan(scenario.clientId);

      await disburseLoan(loanId, scenario);

      const second = await query<{ ok: boolean }>(`select true as ok`).then(async () => {
        try {
          await query(`select public.disburse_loan($1)`, [loanId]);
          return [{ ok: true }];
        } catch {
          return [{ ok: false }];
        }
      });

      expect(second[0]?.ok).toBe(false);
    });
  });

  // =========================================================================
  describe('what generation refuses', () => {
    it('refuses a loan that is not yet disbursed', async () => {
      const scenario = await createLoanScenario();
      const loanId = await createDraftLoan(scenario.clientId);
      await approveLoan(loanId, scenario);

      await expect(
        query(`select public.generate_loan_schedule($1)`, [loanId]),
      ).rejects.toThrow(/generated when a loan is disbursed/i);

      const rows = await installmentsFor(loanId);
      expect(rows).toEqual([]);
    });

    it('refuses a draft', async () => {
      const scenario = await createLoanScenario();
      const loanId = await createDraftLoan(scenario.clientId);

      await expect(
        query(`select public.generate_loan_schedule($1)`, [loanId]),
      ).rejects.toThrow(/generated when a loan is disbursed/i);
    });

    it('refuses a loan that does not exist', async () => {
      await expect(
        query(`select public.generate_loan_schedule($1)`, [
          '00000000-0000-4000-8000-00000000dead',
        ]),
      ).rejects.toThrow(/No such loan/i);
    });

    it('refuses rather than leaving a contractual month uncollected', async () => {
      await addProbeFrequency('every_40_days_probe', 'Every 40 days (test)', 40, 951);

      const scenario = await createLoanScenario();
      const loanId = await createDraftLoan(scenario.clientId, {
        principal: 600_000,
        termMonths: 2,
        frequency: 'every_40_days_probe',
      });

      await expect(disburseLoan(loanId, scenario)).rejects.toThrow(
        /would receive no collection at an interval of 40 days/i,
      );
    });
  });

  // =========================================================================
  describe('settings cannot rewrite a loan', () => {
    it('refuses to change what a frequency means, before disbursement', async () => {
      // The Phase 5 answer to "an administrator edits the cadence between
      // approval and disbursement". It is not that the change is ignored —
      // it is refused, because `daily` meaning two days is not an edited
      // setting, it is a false record of what borrowers agreed to.
      const scenario = await createLoanScenario();
      const loanId = await createDraftLoan(scenario.clientId, {
        principal: 200_000,
        termMonths: 2,
        frequency: 'daily',
      });

      await approveLoan(loanId, scenario);

      await expect(
        query(
          `update public.repayment_frequencies set interval_days = 3 where key = 'daily'`,
        ),
      ).rejects.toThrow(/cannot be changed from 1 to 3 days/);

      // So the loan still gets the cadence it agreed to. `disburseAfterApproval`
      // rather than `disburseLoan`, because this loan is already approved.
      await disburseApprovedLoan(loanId, scenario);

      const header = await queryOne<{ interval_days: number }>(
        `select interval_days from public.loan_schedules where loan_id = $1`,
        [loanId],
      );

      expect(header.interval_days).toBe(1);
    });

    it('leaves a generated schedule untouched when settings change afterwards', async () => {
      const scenario = await createLoanScenario();
      const loanId = await createDraftLoan(scenario.clientId, {
        principal: 200_000,
        termMonths: 2,
        frequency: 'every_2_days',
      });

      await disburseLoan(loanId, scenario);

      const before = await installmentsFor(loanId);
      const headerBefore = await queryOne<{
        interval_days: number;
        frequency_label: string;
      }>(
        `select interval_days, frequency_label from public.loan_schedules
          where loan_id = $1`,
        [loanId],
      );

      let restoreRules: (() => Promise<void>) | undefined;

      try {
        // Everything an administrator is still allowed to change.
        //
        // Inside the `try` as of Phase 12, because one of these changes can
        // now be refused: `business_settings_keep_products_valid` will not
        // let the business floor rise above what an active product lends
        // from. A refusal thrown before the `try` skipped the restore below
        // and left the cadence retired for every file that ran afterwards.
        await query(
          `update public.repayment_frequencies
              set label = 'Every two days (renamed)', is_active = false, sort_order = 80
            where key = 'every_2_days'`,
        );

        restoreRules = await narrowLendingRules({
          monthlyRateBps: 2_500,
          minLoanAmount: 250_000,
        });

        const after = await installmentsFor(loanId);
        const headerAfter = await queryOne<{
          interval_days: number;
          frequency_label: string;
        }>(
          `select interval_days, frequency_label from public.loan_schedules
            where loan_id = $1`,
          [loanId],
        );

        // Not one date and not one amount moved.
        expect(after).toEqual(before);
        // And the snapshot kept the label as it read at generation, so the
        // schedule is still explicable after the cadence was renamed.
        expect(headerAfter.frequency_label).toBe(headerBefore.frequency_label);
        expect(headerAfter.interval_days).toBe(headerBefore.interval_days);
      } finally {
        await query(
          `update public.repayment_frequencies
              set label = 'Every 2 days', is_active = true, sort_order = 2
            where key = 'every_2_days'`,
        );
        await restoreRules?.();
      }
    });

    it('still refuses to change the loan terms a schedule was built from', async () => {
      // Phase 4's immutability, re-checked now that a schedule hangs off it.
      const scenario = await createLoanScenario();
      const loanId = await createDraftLoan(scenario.clientId, {
        principal: 200_000,
        termMonths: 2,
      });

      await disburseLoan(loanId, scenario);

      for (const [column, value] of [
        ['loan_term_months', '3'],
        ['principal_amount', '999999'],
        ['repayment_frequency', `'every_3_days'`],
        ['interest_rate_bps', '0'],
        ['total_expected_repayment', '1'],
      ] as const) {
        await expect(
          query(`update public.loans set ${column} = ${value} where id = $1`, [loanId]),
          `${column} should be frozen`,
        ).rejects.toThrow();
      }

      // And the contractual breakdown underneath it.
      await expect(
        query(`update public.loan_periods set interest = 0 where loan_id = $1`, [loanId]),
      ).rejects.toThrow(/append-only/i);
    });
  });

  // =========================================================================
  describe('the audit trail', () => {
    it('records one event naming the shape of the schedule, not its rows', async () => {
      const scenario = await createLoanScenario();
      const loanId = await createDraftLoan(scenario.clientId, {
        principal: 600_000,
        termMonths: 3,
        frequency: 'every_3_days',
      });

      await disburseLoan(loanId, scenario);

      const event = await queryOne<{
        new_values: Record<string, unknown>;
        actor_profile_id: string | null;
      }>(
        `select new_values, actor_profile_id from public.audit_log
          where entity_type = 'loan' and entity_id = $1
            and action = 'loan.schedule_generated'`,
        [loanId],
      );

      // 10 Oct-style window arithmetic varies with today's date, so the
      // count is checked against the rows rather than hard-coded here.
      const rows = await installmentsFor(loanId);

      expect(event.new_values).toMatchObject({
        installment_count: rows.length,
        repayment_frequency: 'every_3_days',
        interval_days: 3,
        total_scheduled_amount: 780_000,
        generator_version: 1,
      });

      // The completion date is named, because Phase 7 reads it and an
      // auditor should not have to infer it.
      expect(event.new_values.scheduled_completion_date).toBe(rows.at(-1)?.due_date);
      expect(event.new_values.first_due_date).toBe(rows[0]?.due_date);

      // Attributed to the person who released the money.
      expect(event.actor_profile_id).toBe(scenario.owner.profileId);

      // The rows themselves are not in the trail: `audit:view` is a broader
      // capability than `schedules:view`, and a few hundred rows of JSON
      // would preserve nothing the append-only table does not already hold.
      const serialised = JSON.stringify(event.new_values);
      expect(serialised).not.toMatch(/scheduled_principal/);
      expect(serialised).not.toMatch(/installments/);
      expect(serialised.length).toBeLessThan(1_000);
    });

    it('records no identity data in a schedule event', async () => {
      const scenario = await createLoanScenario();
      const loanId = await createDraftLoan(scenario.clientId);

      await disburseLoan(loanId, scenario);

      const nin = await queryOne<{ nin: string }>(
        `select nin from public.client_identities where client_id = $1`,
        [scenario.clientId],
      );

      const events = await query<{ new_values: Record<string, unknown> }>(
        `select new_values from public.audit_log
          where entity_type = 'loan' and entity_id = $1
            and action = 'loan.schedule_generated'`,
        [loanId],
      );

      for (const event of events) {
        expect(JSON.stringify(event.new_values)).not.toContain(nin.nin);
      }
    });
  });
});
