import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { deleteTestUsers } from '../helpers/auth-fixtures';
import {
  attachExtraGuarantorToLoan,
  createDraftLoan,
  createLoanScenario,
  deleteTestLoans,
  disburseLoan,
} from '../helpers/loan-fixtures';
import { deleteTestPayments } from '../helpers/payment-fixtures';
import { closePool, hasDatabase, query, queryOne, skipReason } from '../helpers/db';

/**
 * The three exclusions the Phase 16 security reports make, reconciled.
 *
 * ## Why these three and not the columns
 *
 * The columns are reconciled already: `reporting-parity.test.ts` checks every
 * reported figure against the ledger it came from, and
 * `security-and-recovery.test.ts` checks the bucket boundaries, the promise
 * verdicts and the release rules. What Phase 16 *added* is three totals, and
 * each one deliberately leaves rows out:
 *
 *   1. **Live cover** sums only guarantees that have not been released. A
 *      released guarantor was told they are out, so counting their amount
 *      among what the business is covered for would overstate the cover by
 *      every guarantee ever let go — and that figure gets quoted in a lending
 *      decision.
 *   2. **Held, valued at** sums only items still held. An item released is
 *      back with the borrower and an item sold is gone; a total that included
 *      them would say the business is secured against things it has handed
 *      back.
 *   3. **Sold for** sums only realised items' proceeds, which is not the same
 *      as their valuations — what an item fetched and what it was valued at
 *      are different numbers and a report that confused them would overstate
 *      recovery.
 *
 * An exclusion is the easiest kind of total to get wrong and the hardest to
 * notice, because the figure still looks plausible. So each one is written
 * here in SQL against the base tables, independently of the view the report
 * reads, which is this suite's whole method.
 */
const describeDb = hasDatabase ? describe : describe.skip;

if (!hasDatabase) {
  describe('security report totals suite', () => {
    it.skip(`skipped — ${skipReason}`, () => undefined);
  });
}

/** Add an item of security to a loan, as the table owner. */
async function addCollateral(
  loanId: string,
  values: {
    readonly description: string;
    readonly value: number;
    readonly status?: 'held' | 'released' | 'realised';
    readonly realised?: number;
  },
): Promise<string> {
  const row = await queryOne<{ id: string }>(
    `insert into public.loan_collateral
       (loan_id, item_type, description, estimated_value, valued_on)
     values ($1, 'other', $2, $3, current_date)
     returning id`,
    [loanId, values.description, values.value],
  );

  const status = values.status ?? 'held';

  if (status === 'released') {
    await query(
      `update public.loan_collateral
          set status = 'released', released_at = pg_catalog.now(),
              release_reason = 'Borrower settled early'
        where id = $1`,
      [row.id],
    );
  }

  if (status === 'realised') {
    await query(
      `update public.loan_collateral
          set status = 'realised', realised_at = pg_catalog.now(),
              realised_amount = $2
        where id = $1`,
      [row.id, values.realised ?? values.value],
    );
  }

  return row.id;
}

describeDb('the security reports’ totals', () => {
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
  describe('live guarantee cover', () => {
    /*
     * `guarantor_exposure.guaranteed_amount` is the **loan's** principal, not
     * a per-guarantor share of it: the view's framing is that a guarantor
     * stands behind the whole loan. That makes the obvious total wrong in two
     * ways, and this is where both are pinned.
     */

    it('counts each guaranteed loan once, however many guarantors it has', async () => {
      const scenario = await createLoanScenario();
      const loanId = await createDraftLoan(scenario.clientId);
      await attachExtraGuarantorToLoan(loanId);
      await disburseLoan(loanId, scenario);

      const rows = await query<{ guaranteed_amount: string }>(
        `select guaranteed_amount::text
           from public.guarantor_exposure
          where loan_id = $1 and not is_released`,
        [loanId],
      );

      // Two live guarantees, both carrying the same principal. Summing the
      // column would report twice the cover that exists — and on a product
      // that requires two guarantors it would double the whole book.
      expect(rows.length).toBeGreaterThanOrEqual(2);
      expect(new Set(rows.map((row) => row.guaranteed_amount)).size).toBe(1);

      const principal = await queryOne<{ principal_amount: string }>(
        `select principal_amount::text from public.loans where id = $1`,
        [loanId],
      );

      expect(rows[0]?.guaranteed_amount).toBe(principal.principal_amount);

      // The figure the report shows: one principal per distinct loan with a
      // live guarantee, which is what `getGuarantorExposureExport` computes.
      const perLoan = await queryOne<{ cover: string; loans: string }>(
        `select coalesce(sum(principal_amount), 0)::text as cover,
                count(*)::text as loans
           from (
             select distinct loan_id, guaranteed_amount as principal_amount
               from public.guarantor_exposure
              where loan_id = $1 and not is_released
           ) s`,
        [loanId],
      );

      expect(perLoan.loans).toBe('1');
      expect(perLoan.cover).toBe(principal.principal_amount);

      // And the naive total really is different, so the rule is not academic.
      const naive = await queryOne<{ cover: string }>(
        `select coalesce(sum(guaranteed_amount), 0)::text as cover
           from public.guarantor_exposure
          where loan_id = $1 and not is_released`,
        [loanId],
      );

      expect(Number(naive.cover)).toBeGreaterThan(Number(perLoan.cover));
    });

    it('excludes a released guarantee from the cover', async () => {
      const scenario = await createLoanScenario();
      const loanId = await createDraftLoan(scenario.clientId);
      await attachExtraGuarantorToLoan(loanId);
      await disburseLoan(loanId, scenario);

      const guarantees = await query<{ id: string }>(
        `select id from public.loan_guarantors where loan_id = $1 order by created_at`,
        [loanId],
      );

      expect(guarantees.length).toBeGreaterThanOrEqual(2);

      // Released through the real function, so the capability check and the
      // product's guarantor floor apply the way they do in the application.
      await query(`select public.release_loan_guarantor($1, $2)`, [
        guarantees[0]?.id ?? '',
        'Replaced by a closer relative',
      ]);

      const counts = await queryOne<{ live: string; released: string }>(
        `select count(*) filter (where not is_released)::text as live,
                count(*) filter (where is_released)::text as released
           from public.guarantor_exposure
          where loan_id = $1`,
        [loanId],
      );

      const direct = await queryOne<{ live: string; released: string }>(
        `select count(*) filter (where released_at is null)::text as live,
                count(*) filter (where released_at is not null)::text as released
           from public.loan_guarantors
          where loan_id = $1`,
        [loanId],
      );

      // The view's flag against the column, written independently.
      expect(counts.live).toBe(direct.live);
      expect(counts.released).toBe(direct.released);
      expect(counts.released).toBe('1');
    });

    it('leaves the released guarantee in the rows, with its reason', async () => {
      const scenario = await createLoanScenario();
      const loanId = await createDraftLoan(scenario.clientId);
      await attachExtraGuarantorToLoan(loanId);
      await disburseLoan(loanId, scenario);

      const first = await queryOne<{ id: string }>(
        `select id from public.loan_guarantors where loan_id = $1 order by created_at limit 1`,
        [loanId],
      );

      await query(`select public.release_loan_guarantor($1, $2)`, [
        first.id,
        'Moved out of the district',
      ]);

      const row = await queryOne<{
        is_released: boolean;
        release_reason: string;
        guarantee_status: string;
      }>(
        `select is_released, release_reason, guarantee_status
           from public.guarantor_exposure where loan_guarantor_id = $1`,
        [first.id],
      );

      // Excluded from the cover total, present in the register. A decision to
      // let somebody out of a guarantee should be visible, not absent.
      expect(row.is_released).toBe(true);
      expect(row.release_reason).toBe('Moved out of the district');
      expect(row.guarantee_status).toBe('released');
    });
  });

  // =========================================================================
  describe('the valuation of security held', () => {
    it('counts what is held and not what was released or sold', async () => {
      const scenario = await createLoanScenario();
      const loanId = await createDraftLoan(scenario.clientId);
      await disburseLoan(loanId, scenario);

      await addCollateral(loanId, { description: 'Still here', value: 3_000_000 });
      await addCollateral(loanId, { description: 'Also here', value: 500_000 });
      await addCollateral(loanId, {
        description: 'Handed back',
        value: 2_000_000,
        status: 'released',
      });
      await addCollateral(loanId, {
        description: 'Sold',
        value: 1_000_000,
        status: 'realised',
        realised: 800_000,
      });

      const reported = await queryOne<{
        held_value: string;
        held_count: string;
        realised: string;
        realised_count: string;
        items: string;
      }>(
        `select coalesce(sum(estimated_value) filter (where status = 'held'), 0)::text as held_value,
                count(*) filter (where status = 'held')::text as held_count,
                coalesce(sum(realised_amount) filter (where status = 'realised'), 0)::text as realised,
                count(*) filter (where status = 'realised')::text as realised_count,
                count(*)::text as items
           from public.loan_collateral_register
          where loan_id = $1`,
        [loanId],
      );

      // Two items held, 3,500,000 between them. The 2,000,000 handed back and
      // the 1,000,000 sold are not cover any more.
      expect(reported.held_value).toBe('3500000');
      expect(reported.held_count).toBe('2');
      expect(reported.items).toBe('4');

      // What it fetched, not what it was valued at. Confusing the two would
      // overstate recovery by 200,000 on this loan alone.
      expect(reported.realised).toBe('800000');
      expect(reported.realised_count).toBe('1');

      const direct = await queryOne<{ held: string }>(
        `select coalesce(sum(estimated_value), 0)::text as held
           from public.loan_collateral
          where loan_id = $1 and status = 'held'`,
        [loanId],
      );

      expect(reported.held_value).toBe(direct.held);
    });

    it('keeps a released or sold item in the register with its outcome', async () => {
      const scenario = await createLoanScenario();
      const loanId = await createDraftLoan(scenario.clientId);
      await disburseLoan(loanId, scenario);

      const soldId = await addCollateral(loanId, {
        description: 'Bajaj Boxer, red',
        value: 3_500_000,
        status: 'realised',
        realised: 2_900_000,
      });

      const row = await queryOne<{
        status: string;
        estimated_value: string;
        realised_amount: string;
        realised_at: string | null;
      }>(
        `select status, estimated_value::text, realised_amount::text, realised_at::text
           from public.loan_collateral_register where id = $1`,
        [soldId],
      );

      // Both numbers stay: the valuation is what the business lent against,
      // the proceeds are what it recovered, and the gap between them is the
      // thing somebody reviewing the sale wants to see.
      expect(row.status).toBe('realised');
      expect(row.estimated_value).toBe('3500000');
      expect(row.realised_amount).toBe('2900000');
      expect(row.realised_at).not.toBeNull();
    });
  });

  // =========================================================================
  describe('the aging report’s own rows', () => {
    it('carries the branch and product a slice needs, for every row', async () => {
      const scenario = await createLoanScenario();
      const loanId = await createDraftLoan(scenario.clientId);
      await disburseLoan(loanId, scenario);

      const row = await queryOne<{
        aging_bucket: string;
        branch_name: string | null;
        product_name: string | null;
        total_outstanding: string;
      }>(
        `select aging_bucket, branch_name, product_name, total_outstanding::text
           from public.loan_aging where loan_id = $1`,
        [loanId],
      );

      // The report filters by branch and by product, so a null in either
      // would make a slice silently drop the loan rather than report it.
      expect(row.branch_name).not.toBeNull();
      expect(row.product_name).not.toBeNull();
      expect(row.aging_bucket).toBe('current');
      expect(Number(row.total_outstanding)).toBeGreaterThan(0);
    });

    it('reports the same outstanding figure as the delinquency engine', async () => {
      const scenario = await createLoanScenario();
      const loanId = await createDraftLoan(scenario.clientId);
      await disburseLoan(loanId, scenario);

      const aging = await queryOne<{
        total_outstanding: string;
        arrears_amount: string;
        days_past_due: string | null;
      }>(
        `select total_outstanding::text, arrears_amount::text, days_past_due::text
           from public.loan_aging where loan_id = $1`,
        [loanId],
      );

      const engine = await queryOne<{
        total_outstanding: string;
        arrears_amount: string;
        days_past_due: string | null;
      }>(
        `select total_outstanding::text, arrears_amount::text, days_past_due::text
           from public.loan_delinquency where loan_id = $1`,
        [loanId],
      );

      // Not a re-derivation of the arithmetic — `reporting-parity.test.ts`
      // reconciles the delinquency engine against the ledger, and doing it a
      // second time here would only assert whatever this file believed the
      // rule was. What matters for *this* report is that it does not become a
      // second opinion: the aging view reads the engine, and if the two ever
      // disagreed about one loan, two screens in this application would show
      // different outstanding balances for it.
      expect(aging.total_outstanding).toBe(engine.total_outstanding);
      expect(aging.arrears_amount).toBe(engine.arrears_amount);
      expect(aging.days_past_due).toBe(engine.days_past_due);
    });

    it('puts a loan in the bucket its days past due imply, and only that one', async () => {
      const scenario = await createLoanScenario();
      const loanId = await createDraftLoan(scenario.clientId);
      await disburseLoan(loanId, scenario);

      const row = await queryOne<{
        aging_bucket: string;
        days_past_due: number | null;
        at_risk_1: boolean;
        at_risk_30: boolean;
      }>(
        `select aging_bucket, days_past_due, at_risk_1, at_risk_30
           from public.loan_aging where loan_id = $1`,
        [loanId],
      );

      // A freshly disbursed loan is current, and a current loan is at risk at
      // no threshold. The buckets are exclusive by construction — one `case`
      // over `days_past_due` — so a loan cannot be counted in two of them,
      // which is what would make the bucket counts sum to more than the book.
      expect(row.aging_bucket).toBe('current');
      expect(row.days_past_due ?? 0).toBeLessThanOrEqual(0);
      expect(row.at_risk_1).toBe(false);
      expect(row.at_risk_30).toBe(false);
    });
  });
});
