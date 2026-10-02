import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { closePool, hasDatabase, query, queryOne, skipReason } from '../helpers/db';
import { toBusinessDate, type BusinessDate } from '@/lib/domain/datetime';
import { calculateLoan } from '@/lib/domain/loan';
import { toUgx } from '@/lib/domain/money';
import {
  generateRepaymentSchedule,
  type SchedulePeriodInput,
} from '@/lib/domain/repayment-schedule';

/**
 * The two schedule engines, reconciled.
 *
 * `public.generate_loan_schedule` is authoritative — it writes the rows that
 * a borrower is collected against. `lib/domain/repayment-schedule.ts` drives
 * the preview staff see before disbursement. Two implementations of one rule
 * is a standing risk, so it is tested as one question: do they produce
 * identical output, date by date and shilling by shilling?
 *
 * ## Why this does not disburse hundreds of loans
 *
 * Driving several hundred full lifecycles would take minutes and would mostly
 * re-test Phase 4. The arithmetic and calendar rules under test live in the
 * SQL expression itself, so this exercises that expression directly against a
 * generated contract — the same CTE, the same window join, the same integer
 * allocation, the same `date + interval 'n months'`.
 *
 * `schedule-generation.test.ts` covers the real path end to end. This covers
 * the rules exhaustively. Both are needed: neither alone would catch a
 * divergence that only appears on a leap-year February.
 */
const describeDb = hasDatabase ? describe : describe.skip;

if (!hasDatabase) {
  describe('schedule parity suite', () => {
    it.skip(`skipped — ${skipReason}`, () => undefined);
  });
}

interface SqlRow {
  readonly installment_number: string;
  readonly period_number: string;
  readonly period_installment_number: string;
  readonly due_date: string;
  readonly scheduled_principal: string;
  readonly scheduled_interest: string;
  readonly expected_amount: string;
}

/**
 * The database's schedule for a given contract, cadence and anchor date.
 *
 * This is `generate_loan_schedule`'s own query, with the contract supplied as
 * a literal set rather than read from `loan_periods`. Everything that decides
 * a date or an amount — the anchored month boundaries, the window join, the
 * remainder placement — is character-for-character the expression the
 * function uses.
 */
async function sqlSchedule(
  disbursementDate: string,
  periods: readonly { principal: number; interest: number }[],
  intervalDays: number,
): Promise<readonly SqlRow[]> {
  const periodValues = periods
    .map(
      (period, index) =>
        `(${String(index + 1)}::smallint, ${String(period.principal)}::bigint, ${String(period.interest)}::bigint)`,
    )
    .join(', ');

  return query<SqlRow>(
    `with
       anchor as (select $1::date as start_date, $2::integer as interval_days),
       contract (period_number, principal_portion, interest) as (values ${periodValues}),
       cadence as (
         select (a.start_date + (step * a.interval_days))::date as due_date
         from anchor a,
              pg_catalog.generate_series(
                1,
                ((a.start_date + ($3 || ' months')::interval)::date - a.start_date)
                  / a.interval_days
              ) as step
       ),
       windows as (
         select c.period_number, c.principal_portion, c.interest,
                (a.start_date + ((c.period_number - 1) || ' months')::interval)::date
                  as win_start,
                (a.start_date + (c.period_number || ' months')::interval)::date
                  as win_end
         from contract c, anchor a
       ),
       assigned as (
         select w.period_number, w.principal_portion, w.interest, c.due_date,
                pg_catalog.row_number() over (
                  partition by w.period_number order by c.due_date
                ) as period_position,
                pg_catalog.count(*) over (partition by w.period_number) as period_count,
                pg_catalog.row_number() over (order by c.due_date) as loan_position
         from windows w
         join cadence c on c.due_date >= w.win_start and c.due_date < w.win_end
       )
     select
       a.loan_position::text              as installment_number,
       a.period_number::text              as period_number,
       a.period_position::text            as period_installment_number,
       a.due_date::text                   as due_date,
       ((a.principal_portion / a.period_count)
         + case when a.period_position
                     > a.period_count - (a.principal_portion % a.period_count)
                then 1 else 0 end)::text  as scheduled_principal,
       ((a.interest / a.period_count)
         + case when a.period_position
                     > a.period_count - (a.interest % a.period_count)
                then 1 else 0 end)::text  as scheduled_interest,
       ((a.principal_portion / a.period_count)
         + case when a.period_position
                     > a.period_count - (a.principal_portion % a.period_count)
                then 1 else 0 end
        + (a.interest / a.period_count)
         + case when a.period_position
                     > a.period_count - (a.interest % a.period_count)
                then 1 else 0 end)::text  as expected_amount
     from assigned a
     order by a.loan_position`,
    [disbursementDate, intervalDays, String(periods.length)],
  );
}

/** Deterministic generator, so a failure is reproducible. */
function makeRandom(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state / 2_147_483_648;
  };
}

function addDays(date: BusinessDate, days: number): BusinessDate {
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];
  const shifted = new Date(Date.UTC(year, month - 1, day + days));
  return toBusinessDate(shifted.toISOString().slice(0, 10));
}

describeDb('schedule engine parity', () => {
  beforeAll(async () => {
    // Touch the pool before the loop, so a connection failure reports itself
    // once rather than three hundred times.
    await queryOne<{ ok: boolean }>(`select true as ok`);
  });

  afterAll(async () => {
    await closePool();
  });

  it('agrees with the TypeScript engine on 300 generated schedules', async () => {
    const random = makeRandom(20_261_005);
    let checked = 0;
    let totalInstallments = 0;

    for (let iteration = 0; iteration < 300; iteration += 1) {
      // Awkward principals on purpose: amounts that do not divide cleanly by
      // any plausible collection count.
      const principal = toUgx(50_001 + Math.floor(random() * 4_949_999));
      const termMonths = 1 + Math.floor(random() * 3);
      const bps = Math.floor(random() * 3_001); // 0% to 30%
      const intervalDays = 1 + Math.floor(random() * 3);

      // Four years of anchors, sweeping every month length, both month-end
      // clamps and two leap years.
      const disbursementDate = addDays(
        toBusinessDate('2026-01-01'),
        Math.floor(random() * 1_461),
      );

      const contract = calculateLoan({
        principal,
        monthlyInterestRateBps: bps,
        termMonths,
      });

      const periods: readonly SchedulePeriodInput[] = contract.periods.map((period) => ({
        periodNumber: period.periodNumber,
        principalPortion: period.principalPortion,
        interest: period.interest,
        totalObligation: period.totalObligation,
      }));

      const typescript = generateRepaymentSchedule({
        disbursementDate,
        periods,
        intervalDays,
      });

      const sql = await sqlSchedule(
        disbursementDate,
        contract.periods.map((period) => ({
          principal: period.principalPortion,
          interest: period.interest,
        })),
        intervalDays,
      );

      const context = `principal ${String(principal)}, term ${String(termMonths)}, bps ${String(bps)}, interval ${String(intervalDays)}, disbursed ${disbursementDate}`;

      expect(sql.length, `${context}: installment count`).toBe(
        typescript.installments.length,
      );

      // Compared row by row rather than on totals. Two schedules can share a
      // total and disagree about every date in it.
      for (const [index, expected] of typescript.installments.entries()) {
        const actual = sql[index];

        expect(actual, `${context}: row ${String(index + 1)} missing`).toBeDefined();

        expect(
          {
            installmentNumber: Number(actual?.installment_number),
            loanPeriodNumber: Number(actual?.period_number),
            periodInstallmentNumber: Number(actual?.period_installment_number),
            dueDate: actual?.due_date,
            scheduledPrincipal: Number(actual?.scheduled_principal),
            scheduledInterest: Number(actual?.scheduled_interest),
            expectedAmount: Number(actual?.expected_amount),
          },
          `${context}: row ${String(index + 1)}`,
        ).toEqual({
          installmentNumber: expected.installmentNumber,
          loanPeriodNumber: expected.loanPeriodNumber,
          periodInstallmentNumber: expected.periodInstallmentNumber,
          dueDate: expected.dueDate,
          scheduledPrincipal: expected.scheduledPrincipal,
          scheduledInterest: expected.scheduledInterest,
          expectedAmount: expected.expectedAmount,
        });
      }

      totalInstallments += sql.length;
      checked += 1;
    }

    expect(checked).toBe(300);
    // A guard against the loop silently degenerating into empty comparisons:
    // 300 schedules of one to three months cannot be fewer than this.
    expect(totalInstallments).toBeGreaterThan(5_000);
  });

  it('agrees on every month-end and leap-year anchor the specification names', async () => {
    const ANCHORS = [
      '2027-01-28',
      '2027-01-29',
      '2027-01-30',
      '2027-01-31',
      '2027-02-28',
      '2028-01-28',
      '2028-01-29',
      '2028-01-30',
      '2028-01-31',
      '2028-02-28',
      '2028-02-29',
      '2027-04-30',
      '2027-08-31',
      '2027-12-31',
      '2026-11-30',
    ] as const;

    for (const anchor of ANCHORS) {
      for (const termMonths of [1, 2, 3]) {
        for (const intervalDays of [1, 2, 3]) {
          const contract = calculateLoan({
            principal: toUgx(600_001),
            monthlyInterestRateBps: 1_500,
            termMonths,
          });

          const typescript = generateRepaymentSchedule({
            disbursementDate: toBusinessDate(anchor),
            periods: contract.periods,
            intervalDays,
          });

          const sql = await sqlSchedule(
            anchor,
            contract.periods.map((period) => ({
              principal: period.principalPortion,
              interest: period.interest,
            })),
            intervalDays,
          );

          const context = `${anchor}, ${String(termMonths)}m, every ${String(intervalDays)}d`;

          expect(
            sql.map((row) => row.due_date),
            `${context}: dates`,
          ).toEqual(typescript.installments.map((row) => row.dueDate));

          expect(
            sql.map((row) => Number(row.expected_amount)),
            `${context}: amounts`,
          ).toEqual(typescript.installments.map((row) => row.expectedAmount));
        }
      }
    }
  });

  it('agrees that PostgreSQL and addBusinessMonths clamp and anchor alike', async () => {
    // The single most load-bearing shared assumption. If these two ever
    // disagreed about 31 January, every schedule anchored on a month end
    // would differ between preview and record.
    const { addBusinessMonths } = await import('@/lib/domain/datetime');

    const CASES = [
      ['2027-01-31', 1],
      ['2027-01-31', 2],
      ['2027-01-31', 3],
      ['2028-01-31', 1],
      ['2028-01-29', 1],
      ['2026-08-31', 1],
      ['2026-08-31', 2],
      ['2026-11-30', 3],
      ['2028-02-29', 12],
      ['2026-12-31', 2],
    ] as const;

    for (const [date, months] of CASES) {
      const row = await queryOne<{ result: string }>(
        `select ($1::date + ($2 || ' months')::interval)::date::text as result`,
        [date, String(months)],
      );

      expect(row.result, `${date} + ${String(months)} months`).toBe(
        addBusinessMonths(toBusinessDate(date), months),
      );
    }
  });

  it('agrees on the integer allocation rule, including the awkward cases', async () => {
    // `divideEvenly(amount, parts, 'last')` against the SQL CASE expression,
    // over the remainder shapes that matter: none, one, almost all, and an
    // amount smaller than the number of parts.
    const { divideEvenly } = await import('@/lib/domain/money');

    const CASES = [
      [100_000, 30],
      [100_001, 3],
      [100_000, 7],
      [1, 30],
      [7, 30],
      [29, 30],
      [30, 30],
      [31, 30],
      [0, 10],
      [999_999, 91],
      [245_001, 60],
    ] as const;

    for (const [amount, parts] of CASES) {
      const rows = await query<{ part: string }>(
        `select ((($1::bigint / $2::bigint)
                  + case when position > $2::bigint - ($1::bigint % $2::bigint)
                         then 1 else 0 end))::text as part
           from pg_catalog.generate_series(1, $2::bigint) as position
          order by position`,
        [String(amount), String(parts)],
      );

      const sqlParts = rows.map((row) => Number(row.part));
      const tsParts = [...divideEvenly(toUgx(amount), parts, { remainder: 'last' })];

      expect(sqlParts, `${String(amount)} over ${String(parts)}`).toEqual(tsParts);
      // And, whichever engine, nothing is lost.
      expect(sqlParts.reduce((total, part) => total + part, 0)).toBe(amount);
    }
  });
});
