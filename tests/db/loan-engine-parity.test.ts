import { afterAll, describe, expect, it } from 'vitest';

import { closePool, hasDatabase, query, queryOne, skipReason } from '../helpers/db';
import {
  assertLoanInvariants,
  calculateLoan,
  calculationFromPeriods,
} from '@/lib/domain/loan';
import { toUgx } from '@/lib/domain/money';

/**
 * The two loan engines, compared.
 *
 * There are two implementations of the loan arithmetic by design:
 * `public.calculate_loan_breakdown` in the database, which is authoritative
 * and computes what gets stored, and `lib/domain/loan.ts`, which computes the
 * preview staff see while entering a loan.
 *
 * The split exists because `approve_loan` must not accept figures from its
 * caller — an approver who could supply the breakdown could approve a loan at
 * zero interest. But two implementations that must agree is a real risk: the
 * failure mode is a borrower being quoted one figure at the counter and
 * charged another, which is the worst class of bug this system can have.
 *
 * This file is what makes that risk manageable. It runs several hundred cases
 * through both and compares them period by period, field by field. If they
 * ever diverge, this fails rather than a borrower being misquoted.
 *
 * The generator is deterministic — a fixed seed, not `Math.random()` — so a
 * failure is reproducible rather than a flake somebody reruns until it passes.
 */
const describeDb = hasDatabase ? describe : describe.skip;

if (!hasDatabase) {
  describe('loan engine parity suite', () => {
    it.skip(`skipped — ${skipReason}`, () => undefined);
  });
}

interface SqlPeriod {
  period_number: number;
  opening_principal: string;
  principal_portion: string;
  interest: string;
  total_obligation: string;
  closing_principal: string;
}

/** The database's breakdown, as numbers. `bigint` arrives as a string. */
async function sqlBreakdown(
  principal: number,
  bps: number,
  termMonths: number,
): Promise<
  readonly {
    periodNumber: number;
    openingPrincipal: number;
    principalPortion: number;
    interest: number;
    totalObligation: number;
    closingPrincipal: number;
  }[]
> {
  const rows = await query<SqlPeriod>(
    `select period_number, opening_principal::text as opening_principal,
            principal_portion::text as principal_portion,
            interest::text as interest,
            total_obligation::text as total_obligation,
            closing_principal::text as closing_principal
       from public.calculate_loan_breakdown($1::bigint, $2::integer, $3::smallint)
      order by period_number`,
    [principal, bps, termMonths],
  );

  return rows.map((row) => ({
    periodNumber: Number(row.period_number),
    openingPrincipal: Number(row.opening_principal),
    principalPortion: Number(row.principal_portion),
    interest: Number(row.interest),
    totalObligation: Number(row.total_obligation),
    closingPrincipal: Number(row.closing_principal),
  }));
}

/** Deterministic spread of inputs. */
function* generatedCases(): Generator<{
  principal: number;
  bps: number;
  termMonths: number;
}> {
  let seed = 20_261_004;

  const next = (bound: number): number => {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
    return seed % bound;
  };

  for (let index = 0; index < 300; index += 1) {
    yield {
      principal: next(80_000_000) + 1,
      bps: next(4_000),
      termMonths: next(12) + 1,
    };
  }
}

describeDb('the database and TypeScript loan engines agree', () => {
  afterAll(async () => {
    await closePool();
  });

  // -------------------------------------------------------------------------
  describe('the three confirmed business examples', () => {
    it.each([
      ['Case A — 100,000 / 1 month', 100_000, 1, 15_000, 115_000],
      ['Case B — 200,000 / 2 months', 200_000, 2, 45_000, 245_000],
      ['Case C — 600,000 / 3 months', 600_000, 3, 180_000, 780_000],
    ])(
      '%s produces the agreed figures in the database',
      async (_label, principal, termMonths, expectedInterest, expectedTotal) => {
        const periods = await sqlBreakdown(principal, 1_500, termMonths);

        const interest = periods.reduce((total, period) => total + period.interest, 0);

        // The expected values are the agreed business figures, written as
        // literals. Nothing here derives them from either implementation.
        expect(interest).toBe(expectedInterest);
        expect(principal + interest).toBe(expectedTotal);
      },
    );

    it.each([
      ['Case A', 100_000, 1],
      ['Case B', 200_000, 2],
      ['Case C', 600_000, 3],
    ])(
      '%s is identical in both engines, period by period',
      async (_label, principal, termMonths) => {
        const fromSql = await sqlBreakdown(principal, 1_500, termMonths);
        const fromTs = calculateLoan({
          principal: toUgx(principal),
          monthlyInterestRateBps: 1_500,
          termMonths,
        });

        expect(fromSql).toEqual(fromTs.periods);
      },
    );
  });

  // -------------------------------------------------------------------------
  describe('across 300 generated loans', () => {
    it('produces byte-identical breakdowns', async () => {
      let compared = 0;

      for (const { principal, bps, termMonths } of generatedCases()) {
        const fromSql = await sqlBreakdown(principal, bps, termMonths);
        const fromTs = calculateLoan({
          principal: toUgx(principal),
          monthlyInterestRateBps: bps,
          termMonths,
        });

        const label = `${String(principal)} @ ${String(bps)}bps over ${String(termMonths)}mo`;

        expect(fromSql, label).toEqual(fromTs.periods);

        compared += 1;
      }

      expect(compared).toBe(300);
    });

    it('satisfies every invariant on the database figures too', async () => {
      // The invariants are applied to rows that came out of PostgreSQL, not
      // to the TypeScript engine's own output. That is the point: a stored
      // breakdown is checked by the same rules, so corruption in the SQL
      // implementation is caught rather than mirrored.
      for (const { principal, bps, termMonths } of generatedCases()) {
        const fromSql = await sqlBreakdown(principal, bps, termMonths);

        const periods = fromSql.map((period) => ({
          periodNumber: period.periodNumber,
          openingPrincipal: toUgx(period.openingPrincipal),
          principalPortion: toUgx(period.principalPortion),
          interest: toUgx(period.interest),
          totalObligation: toUgx(period.totalObligation),
          closingPrincipal: toUgx(period.closingPrincipal),
        }));

        expect(
          () => {
            assertLoanInvariants(calculationFromPeriods(periods, bps));
          },
          `${String(principal)} @ ${String(bps)}bps over ${String(termMonths)}mo`,
        ).not.toThrow();
      }
    });
  });

  // -------------------------------------------------------------------------
  describe('rounding agrees at the boundaries', () => {
    it.each([
      // principal, bps, exact fraction, expected half-up result
      [10_004, 1_000, '.4', 1_000],
      [10_005, 1_000, '.5', 1_001],
      [10_006, 1_000, '.6', 1_001],
      [333, 5_000, '.5', 167],
      // 222.5 → 223 under half-up. Banker's rounding would give 222, because
      // 222 is even — so this case is what proves the mode in both engines.
      [445, 5_000, '.5 with an even integer part', 223],
      [20_010, 500, '.5', 1_001],
    ])(
      '%i at %i bps (ending %s) rounds to %i in both',
      async (principal, bps, _fraction, expected) => {
        const [sqlPeriod] = await sqlBreakdown(principal, bps, 1);
        const tsResult = calculateLoan({
          principal: toUgx(principal),
          monthlyInterestRateBps: bps,
          termMonths: 1,
        });

        expect(sqlPeriod?.interest).toBe(expected);
        expect(tsResult.periods[0]?.interest).toBe(expected);
      },
    );
  });

  // -------------------------------------------------------------------------
  describe('uneven principal division agrees', () => {
    it.each([
      [200_001, 2],
      [100_000, 3],
      [200_000, 3],
      [1, 1],
      [7, 3],
      [99_999_999, 7],
      [1_000_001, 12],
    ])('splits %i over %i periods identically', async (principal, termMonths) => {
      const fromSql = await sqlBreakdown(principal, 1_500, termMonths);
      const fromTs = calculateLoan({
        principal: toUgx(principal),
        monthlyInterestRateBps: 1_500,
        termMonths,
      });

      expect(fromSql.map((period) => period.principalPortion)).toEqual(
        fromTs.periods.map((period) => period.principalPortion),
      );

      // And nothing is lost by either.
      expect(fromSql.reduce((total, period) => total + period.principalPortion, 0)).toBe(
        principal,
      );
    });

    it('places the remainder in the final periods, in both engines', async () => {
      const fromSql = await sqlBreakdown(200_001, 1_500, 2);

      // The documented deterministic rule: the last period absorbs it.
      expect(fromSql.map((period) => period.principalPortion)).toEqual([
        100_000, 100_001,
      ]);
    });
  });

  // -------------------------------------------------------------------------
  describe('both engines refuse the same invalid input', () => {
    it.each([
      ['zero principal', 0, 1_500, 1],
      ['a negative principal', -100_000, 1_500, 1],
      ['a negative rate', 100_000, -1_500, 1],
      ['a zero term', 100_000, 1_500, 0],
      ['a term beyond the supported range', 100_000, 1_500, 121],
    ])('refuses %s', async (_label, principal, bps, termMonths) => {
      await expect(sqlBreakdown(principal, bps, termMonths)).rejects.toThrow();

      // The *same* invalid value goes to both engines. An earlier version of
      // this test clamped the principal to 1 before handing it over, which
      // made the TypeScript half assert nothing at all.
      //
      // The cast is needed because `toUgx` would reject these on the way in,
      // and the point is to prove `calculateLoan` validates its own input
      // rather than trusting the brand — it is reachable from a Server Action
      // with whatever a loosened schema let through.
      expect(() =>
        calculateLoan({
          principal: principal as never,
          monthlyInterestRateBps: bps,
          termMonths,
        }),
      ).toThrow();
    });
  });

  // -------------------------------------------------------------------------
  describe('zero interest', () => {
    it('agrees that the loan is worth its principal', async () => {
      const fromSql = await sqlBreakdown(300_000, 0, 3);
      const fromTs = calculateLoan({
        principal: toUgx(300_000),
        monthlyInterestRateBps: 0,
        termMonths: 3,
      });

      expect(fromSql).toEqual(fromTs.periods);
      expect(fromSql.every((period) => period.interest === 0)).toBe(true);
      expect(fromSql.reduce((total, period) => total + period.totalObligation, 0)).toBe(
        300_000,
      );
    });
  });

  // -------------------------------------------------------------------------
  describe('no floating point reached the database', () => {
    it('returns whole shillings for every figure', async () => {
      const row = await queryOne<{ non_integers: string }>(
        `select pg_catalog.count(*)::text as non_integers
           from public.calculate_loan_breakdown(1234567::bigint, 1500, 12::smallint) b
          where b.interest <> pg_catalog.trunc(b.interest)
             or b.principal_portion <> pg_catalog.trunc(b.principal_portion)
             or b.opening_principal <> pg_catalog.trunc(b.opening_principal)`,
      );

      // `bigint` columns cannot hold a fraction, so this is belt and braces —
      // it would catch a future change to `numeric` that introduced one.
      expect(row.non_integers).toBe('0');
    });

    it('is declared immutable, so the planner may rely on it', async () => {
      const row = await queryOne<{ provolatile: string }>(
        `select p.provolatile
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public' and p.proname = 'calculate_loan_breakdown'`,
      );

      // A pure function of its arguments. If it ever stopped being one — by
      // reading settings, say — this would fail, and that would be the right
      // moment to notice.
      expect(row.provolatile).toBe('i');
    });
  });
});
