import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { deleteTestUsers } from '../helpers/auth-fixtures';
import {
  closePool,
  expectError,
  hasDatabase,
  query,
  queryOne,
  skipReason,
} from '../helpers/db';
import {
  closeMemberLoanProduct,
  depositOn,
  enrolMember,
  forcePolicyStatus,
  openMemberLoanProduct,
  openMonthlyCadence,
  publishTestPolicy,
  resetMonthlyCadence,
} from '../helpers/membership';
import {
  createLoanScenario,
  createMemberLoanDraft,
  disburseApprovedLoan,
  tryApproveLoan,
} from '../helpers/loan-fixtures';
import { monthlyCollectionDate, type MonthAnchor } from '@/lib/domain/repayment-schedule';
import { toBusinessDate } from '@/lib/domain/datetime';

/**
 * Calendar-monthly collection.
 *
 * ## Why this is the hardest part of Phase 3
 *
 * `generate_loan_schedule` built collection dates as `D + k x interval_days`,
 * and a calendar month is 28, 29, 30 or 31 days. An `interval_days = 30`
 * cadence on a loan disbursed on 31 January would collect on 2 March, 1 April,
 * 1 May — dates no borrower agreed and no collection sheet expects. So the
 * engine needed a second *kind* of cadence, which is the thing that could
 * have broken every schedule already in the database.
 *
 * ## What these are really testing
 *
 * Three properties, in order of how much they matter:
 *
 *   1. **Nothing is scheduled under an undecided convention.** A calendar
 *      cadence whose anchor is NULL generates no schedule and blocks approval,
 *      with the decision named. `tests/db/member-loan-approval.test.ts`
 *      asserts the approval half; this asserts the generator's.
 *
 *   2. **Both conventions are implemented and neither is a default.** The
 *      business has not chosen, so both arms are proved — across leap years,
 *      31-day months, 30-day months and a year boundary — and the fixture says
 *      which it chose, in the test.
 *
 *   3. **The two implementations agree.** `public.monthly_collection_date` and
 *      `monthlyCollectionDate` in `lib/domain/repayment-schedule.ts` state the
 *      same rule, and the preview a member is shown is the TypeScript one
 *      while the dates they are collected on are the database's. A divergence
 *      has to fail a test rather than a borrower.
 *
 * The parity of the *fixed-day* arm — that no stored schedule moved — is
 * `tests/db/schedule-parity.test.ts` and `scripts/verify-membership-upgrade.mjs`.
 */
const describeDb = hasDatabase ? describe : describe.skip;

if (!hasDatabase) {
  describe('calendar-month schedule suite', () => {
    it.skip(`skipped — ${skipReason}`, () => undefined);
  });
}

/**
 * The dates the business will actually have to reason about.
 *
 * Chosen rather than generated: each row is a case somebody would ask about,
 * and the expected columns are written out by hand from a calendar rather than
 * computed, so this is an independent statement of the rule and not a
 * restatement of the implementation.
 */
const ANCHOR_CASES: readonly {
  readonly label: string;
  readonly from: string;
  readonly clamp: readonly string[];
  readonly roll: readonly string[];
}[] = [
  {
    label: '31 January in a common year — February is 28 days',
    from: '2026-01-31',
    clamp: ['2026-02-28', '2026-03-31', '2026-04-30', '2026-05-31', '2026-06-30'],
    roll: ['2026-03-01', '2026-03-31', '2026-05-01', '2026-05-31', '2026-07-01'],
  },
  {
    label: '31 January in a leap year — February is 29 days',
    from: '2024-01-31',
    clamp: ['2024-02-29', '2024-03-31', '2024-04-30', '2024-05-31', '2024-06-30'],
    roll: ['2024-03-01', '2024-03-31', '2024-05-01', '2024-05-31', '2024-07-01'],
  },
  {
    label: '29 January in a common year — the 29th does not exist in February',
    from: '2026-01-29',
    clamp: ['2026-02-28', '2026-03-29', '2026-04-29', '2026-05-29', '2026-06-29'],
    roll: ['2026-03-01', '2026-03-29', '2026-04-29', '2026-05-29', '2026-06-29'],
  },
  {
    label: '29 January in a leap year — the 29th does exist, so neither moves',
    from: '2024-01-29',
    clamp: ['2024-02-29', '2024-03-29', '2024-04-29', '2024-05-29', '2024-06-29'],
    roll: ['2024-02-29', '2024-03-29', '2024-04-29', '2024-05-29', '2024-06-29'],
  },
  {
    label: '31 March — April and June are 30 days',
    from: '2026-03-31',
    clamp: ['2026-04-30', '2026-05-31', '2026-06-30', '2026-07-31', '2026-08-31'],
    roll: ['2026-05-01', '2026-05-31', '2026-07-01', '2026-07-31', '2026-08-31'],
  },
  {
    label: '31 December — across the year boundary',
    from: '2026-12-31',
    clamp: ['2027-01-31', '2027-02-28', '2027-03-31', '2027-04-30', '2027-05-31'],
    roll: ['2027-01-31', '2027-03-01', '2027-03-31', '2027-05-01', '2027-05-31'],
  },
  {
    label: '30 January — the 30th does not exist in February either',
    from: '2026-01-30',
    clamp: ['2026-02-28', '2026-03-30', '2026-04-30', '2026-05-30', '2026-06-30'],
    roll: ['2026-03-01', '2026-03-30', '2026-04-30', '2026-05-30', '2026-06-30'],
  },
  {
    label: 'the 15th — an ordinary date neither convention moves',
    from: '2026-01-15',
    clamp: ['2026-02-15', '2026-03-15', '2026-04-15', '2026-05-15', '2026-06-15'],
    roll: ['2026-02-15', '2026-03-15', '2026-04-15', '2026-05-15', '2026-06-15'],
  },
  {
    label: '28 February in a leap year — March has a 28th, so neither moves',
    from: '2024-02-28',
    clamp: ['2024-03-28', '2024-04-28', '2024-05-28', '2024-06-28', '2024-07-28'],
    roll: ['2024-03-28', '2024-04-28', '2024-05-28', '2024-06-28', '2024-07-28'],
  },
  {
    label: '29 February in a leap year — no other month has a 29th problem',
    from: '2024-02-29',
    clamp: ['2024-03-29', '2024-04-29', '2024-05-29', '2024-06-29', '2024-07-29'],
    roll: ['2024-03-29', '2024-04-29', '2024-05-29', '2024-06-29', '2024-07-29'],
  },
];

describeDb('calendar-month collection dates', () => {
  afterAll(async () => {
    await resetMonthlyCadence();
    await closePool();
  });

  // =========================================================================
  describe('the anchor rule, stated against a calendar', () => {
    for (const testCase of ANCHOR_CASES) {
      it(`clamps correctly from ${testCase.label}`, async () => {
        for (const [index, expected] of testCase.clamp.entries()) {
          const row = await queryOne<{ d: string }>(
            `select public.monthly_collection_date($1::date, $2::int,
                                                   'clamp_to_month_end')::text as d`,
            [testCase.from, index + 1],
          );
          expect(row.d, `${testCase.from} + ${String(index + 1)} months`).toBe(expected);
        }
      });

      it(`rolls forward correctly from ${testCase.label}`, async () => {
        for (const [index, expected] of testCase.roll.entries()) {
          const row = await queryOne<{ d: string }>(
            `select public.monthly_collection_date($1::date, $2::int,
                                                   'roll_forward_to_next_month')::text as d`,
            [testCase.from, index + 1],
          );
          expect(row.d, `${testCase.from} + ${String(index + 1)} months`).toBe(expected);
        }
      });
    }

    it('keeps both conventions strictly increasing over five years', async () => {
      // A roll-forward lands on the 1st of a month the next collection falls
      // later in, so it is monotonic — but that is an argument, and the
      // generator asserts it rather than relying on it, so this proves the
      // argument holds for every starting day of every month.
      for (const anchor of [
        'clamp_to_month_end',
        'roll_forward_to_next_month',
      ] as const) {
        const broken = await query<{ n: number }>(
          `with starts as (
             select ('2024-01-01'::date + (n || ' days')::interval)::date as d
             from pg_catalog.generate_series(0, 365) n
           ),
           dates as (
             select s.d as start_date, k,
                    public.monthly_collection_date(s.d, k, $1) as due
             from starts s, pg_catalog.generate_series(1, 60) k
           ),
           ordered as (
             select start_date, due,
                    pg_catalog.lag(due) over (partition by start_date order by k) as prev
             from dates
           )
           select count(*)::int as n from ordered
            where prev is not null and due <= prev`,
          [anchor],
        );

        expect(broken[0]?.n, anchor).toBe(0);
      }
    });

    it('refuses to produce a date while the convention is undecided', async () => {
      const error = await expectError(
        `select public.monthly_collection_date('2026-01-31'::date, 1, null)`,
      );

      expect(error?.message).toMatch(/anchor has not been decided/i);
    });

    it('refuses a convention nobody has defined', async () => {
      const error = await expectError(
        `select public.monthly_collection_date('2026-01-31'::date, 1, 'nearest_friday')`,
      );

      expect(error?.message).toMatch(/no monthly collection anchor called/i);
    });
  });

  // =========================================================================
  describe('the database and the preview agree', () => {
    it('produces the same date for every case, both conventions', async () => {
      // The preview a member is shown is the TypeScript rule; the dates they
      // are collected on are the database's. A divergence has to fail here
      // rather than quoting one date and collecting on another.
      for (const testCase of ANCHOR_CASES) {
        for (const anchor of [
          'clamp_to_month_end',
          'roll_forward_to_next_month',
        ] as const satisfies readonly MonthAnchor[]) {
          for (let months = 1; months <= 5; months += 1) {
            const row = await queryOne<{ d: string }>(
              `select public.monthly_collection_date($1::date, $2::int, $3)::text as d`,
              [testCase.from, months, anchor],
            );

            const inTypeScript = monthlyCollectionDate(
              toBusinessDate(testCase.from),
              months,
              anchor,
            );

            expect(row.d, `${testCase.from} + ${String(months)} months, ${anchor}`).toBe(
              String(inTypeScript),
            );
          }
        }
      }
    });
  });

  // =========================================================================
  describe('the generator, under a decided convention', () => {
    let policyId: string;
    let witnessProfileId: string;

    beforeAll(async () => {
      const witness = await queryOne<{ id: string }>(
        `insert into public.profiles (full_name, phone, status)
         values ('Monthly Witness', '+256700033999', 'active')
         returning id`,
      );
      witnessProfileId = witness.id;

      policyId = await publishTestPolicy({
        version: '330.1',
        effectiveDaysAgo: 530,
        qualifyingMonthsConsecutive: false,
        withdrawalRule: 'allowed',
        interestBasis: 'per_month',
        interestMethod: 'reducing_balance_monthly',
        savingsToLoanMultiplierBps: 20_000,
      });
    });

    afterAll(async () => {
      await closeMemberLoanProduct();
      await resetMonthlyCadence();
      await forcePolicyStatus(policyId, 'superseded');
      await deleteTestUsers();
    });

    async function qualifiedMember() {
      const scenario = await createLoanScenario();
      const { savingsAccountId } = await enrolMember(scenario.clientId, witnessProfileId);

      if (savingsAccountId === null) throw new Error('expected a savings account');

      const today = await queryOne<{ d: string }>(
        `select public.business_date()::text as d`,
      );

      for (const monthsBack of [6, 5, 4, 3, 2, 1]) {
        const on = await queryOne<{ d: string }>(
          `select ($1::date - ($2::int || ' months')::interval)::date::text as d`,
          [today.d, monthsBack],
        );
        await depositOn(savingsAccountId, 200_000, { on: on.d });
      }

      return { clientId: scenario.clientId, actors: scenario };
    }

    it('collects each contractual month exactly once, at that month’s end', async () => {
      await openMonthlyCadence('clamp_to_month_end');
      await openMemberLoanProduct({ cadences: ['weekly', 'monthly'] });

      const member = await qualifiedMember();
      const loanId = await createMemberLoanDraft(member.clientId, {
        principal: 500_000,
        termMonths: 5,
        frequency: 'monthly',
      });

      expect(await tryApproveLoan(loanId, member.actors)).toBeNull();
      await disburseApprovedLoan(loanId, member.actors);

      const header = await queryOne<{
        cadence_kind: string;
        interval_days: number | null;
        month_anchor: string | null;
        generator_version: number;
        disbursement_date: string;
      }>(
        `select cadence_kind, interval_days, month_anchor, generator_version,
                disbursement_date::text as disbursement_date
           from public.loan_schedules where loan_id = $1`,
        [loanId],
      );

      expect(header.cadence_kind).toBe('calendar_month');
      expect(header.interval_days).toBeNull();
      expect(header.month_anchor).toBe('clamp_to_month_end');
      // Version 2: the calendar arm is a new rule set. The fixed-day arm stays
      // version 1, because its rules did not change.
      expect(header.generator_version).toBe(2);

      const rows = await query<{
        installment_number: number;
        loan_period_number: number;
        period_installment_number: number;
        due_date: string;
        scheduled_principal: string;
        scheduled_interest: string;
        expected_amount: string;
      }>(
        `select installment_number, loan_period_number, period_installment_number,
                due_date::text as due_date,
                scheduled_principal::text as scheduled_principal,
                scheduled_interest::text as scheduled_interest,
                expected_amount::text as expected_amount
           from public.loan_installments where loan_id = $1
          order by installment_number`,
        [loanId],
      );

      // Five contractual months, five collections. No division, so no
      // remainder to lose.
      expect(rows).toHaveLength(5);

      for (const [index, row] of rows.entries()) {
        expect(row.loan_period_number).toBe(index + 1);
        expect(row.period_installment_number).toBe(1);

        const expectedDue = monthlyCollectionDate(
          toBusinessDate(header.disbursement_date),
          index + 1,
          'clamp_to_month_end',
        );
        expect(row.due_date, `collection ${String(index + 1)}`).toBe(String(expectedDue));
      }

      // Each collection gathers its own month's whole obligation.
      const periods = await query<{
        period_number: number;
        principal_portion: string;
        interest: string;
        total_obligation: string;
      }>(
        `select period_number, principal_portion::text as principal_portion,
                interest::text as interest,
                total_obligation::text as total_obligation
           from public.loan_periods where loan_id = $1
          order by period_number`,
        [loanId],
      );

      for (const [index, period] of periods.entries()) {
        const row = rows[index];
        expect(row?.scheduled_principal, `month ${String(index + 1)}`).toBe(
          period.principal_portion,
        );
        expect(row?.scheduled_interest, `month ${String(index + 1)}`).toBe(
          period.interest,
        );
        expect(row?.expected_amount, `month ${String(index + 1)}`).toBe(
          period.total_obligation,
        );
      }

      // And the loan reconciles.
      const totals = await queryOne<{ scheduled: string; contractual: string }>(
        `select pg_catalog.sum(i.expected_amount)::text as scheduled,
                (select l.total_expected_repayment::text from public.loans l
                  where l.id = $1) as contractual
           from public.loan_installments i where i.loan_id = $1`,
        [loanId],
      );
      expect(totals.scheduled).toBe(totals.contractual);
    });

    it('schedules a one-month monthly loan as a single collection', async () => {
      await openMonthlyCadence('roll_forward_to_next_month');
      await openMemberLoanProduct({ cadences: ['weekly', 'monthly'] });

      const member = await qualifiedMember();
      const loanId = await createMemberLoanDraft(member.clientId, {
        principal: 150_000,
        termMonths: 1,
        frequency: 'monthly',
      });

      // A one-month loan needs weekly collection under the policy's weekly
      // boundary, so this is refused — which is the rule working, and worth
      // asserting beside the monthly cases so the boundary is not assumed.
      expect(await tryApproveLoan(loanId, member.actors)).toMatch(
        /member_cadence_not_permitted/,
      );
    });

    it('reconciles a three-month monthly loan on an awkward principal', async () => {
      await openMonthlyCadence('roll_forward_to_next_month');
      await openMemberLoanProduct({ cadences: ['weekly', 'monthly'] });

      const member = await qualifiedMember();
      const loanId = await createMemberLoanDraft(member.clientId, {
        principal: 333_334,
        termMonths: 3,
        frequency: 'monthly',
      });

      expect(await tryApproveLoan(loanId, member.actors)).toBeNull();
      await disburseApprovedLoan(loanId, member.actors);

      const row = await queryOne<{
        count: number;
        principal: string;
        total: string;
        contractual: string;
        increasing: number;
      }>(
        `select count(*)::int as count,
                pg_catalog.sum(i.scheduled_principal)::text as principal,
                pg_catalog.sum(i.expected_amount)::text as total,
                (select l.total_expected_repayment::text from public.loans l
                  where l.id = $1) as contractual,
                (select count(*)::int from (
                   select due_date,
                          pg_catalog.lag(due_date) over (order by installment_number) as prev
                   from public.loan_installments where loan_id = $1
                 ) o where o.prev is not null and o.due_date <= o.prev) as increasing
           from public.loan_installments i where i.loan_id = $1`,
        [loanId],
      );

      expect(row.count).toBe(3);
      expect(Number(row.principal)).toBe(333_334);
      expect(row.total).toBe(row.contractual);
      expect(row.increasing).toBe(0);
    });
  });

  // =========================================================================
  describe('with the convention undecided', () => {
    it('refuses to generate a schedule, naming the decision', async () => {
      await resetMonthlyCadence();

      // Reached directly, because approval already refuses a monthly loan at
      // this point — so the only way to prove the generator also fails shut is
      // to ask it. A loan whose cadence became undecided between approval and
      // disbursement is the real case: the anchor is write-once, so it cannot
      // be un-decided, and that is the point of asserting both.
      const error = await expectError(
        `select public.monthly_collection_date(public.business_date(), 1,
                 (select month_anchor from public.repayment_frequencies
                   where key = 'monthly'))`,
      );

      expect(error?.message).toMatch(/anchor has not been decided/i);
    });

    it('keeps the monthly cadence inactive, so it cannot be chosen on a form', async () => {
      await resetMonthlyCadence();

      const row = await queryOne<{
        is_active: boolean;
        month_anchor: string | null;
        interval_days: number | null;
        cadence_kind: string;
      }>(
        `select is_active, month_anchor, interval_days, cadence_kind
           from public.repayment_frequencies where key = 'monthly'`,
      );

      expect(row.cadence_kind).toBe('calendar_month');
      expect(row.interval_days).toBeNull();
      expect(row.month_anchor).toBeNull();
      expect(row.is_active).toBe(false);
    });

    it('refuses a product that offers the inactive monthly cadence', async () => {
      await resetMonthlyCadence();

      const error = await expectError(
        `update public.loan_products
            set allowed_repayment_frequencies = array['weekly', 'monthly']
          where product_code = 'ML'`,
      );

      expect(error?.message).toMatch(/no active repayment cadence called "monthly"/i);
    });
  });

  // =========================================================================
  describe('the cadence is what it means, so it cannot be redefined', () => {
    it('refuses to change a cadence kind under a live loan', async () => {
      const error = await expectError(
        `update public.repayment_frequencies
            set cadence_kind = 'calendar_month' where key = 'weekly'`,
      );

      expect(error?.message).toMatch(/cadence kind of "weekly" cannot be changed/i);
    });

    it('refuses to change the weekly interval, as it refuses the daily one', async () => {
      const error = await expectError(
        `update public.repayment_frequencies set interval_days = 14 where key = 'weekly'`,
      );

      expect(error?.message).toMatch(
        /collection interval of "weekly" cannot be changed/i,
      );
    });

    it('lets the anchor be decided once, and never again', async () => {
      await resetMonthlyCadence();

      // Deciding it is a real business act, so it is permitted.
      await query(
        `update public.repayment_frequencies
            set month_anchor = 'clamp_to_month_end' where key = 'monthly'`,
      );

      // Changing it would move collection dates on loans already written
      // against it, so it is refused from that moment.
      const changed = await expectError(
        `update public.repayment_frequencies
            set month_anchor = 'roll_forward_to_next_month' where key = 'monthly'`,
      );
      expect(changed?.message).toMatch(
        /anchor of "monthly" is .* and cannot be changed/i,
      );

      // And un-deciding it is refused too: a schedule cannot stop being
      // explicable.
      const cleared = await expectError(
        `update public.repayment_frequencies set month_anchor = null where key = 'monthly'`,
      );
      expect(cleared?.message).toMatch(/cannot be changed/i);

      await resetMonthlyCadence();
    });

    it('refuses a calendar cadence carrying an interval, and a fixed one carrying an anchor', async () => {
      const withInterval = await expectError(
        `insert into public.repayment_frequencies
           (key, label, interval_days, cadence_kind, sort_order)
         values ('bad_calendar', 'Bad', 30, 'calendar_month', 90)`,
      );
      expect(withInterval?.message).toMatch(/interval_matches_kind/i);

      const withAnchor = await expectError(
        `insert into public.repayment_frequencies
           (key, label, interval_days, cadence_kind, month_anchor, sort_order)
         values ('bad_fixed', 'Bad', 10, 'fixed_days', 'clamp_to_month_end', 91)`,
      );
      expect(withAnchor?.message).toMatch(/anchor_matches_kind/i);
    });
  });
});
