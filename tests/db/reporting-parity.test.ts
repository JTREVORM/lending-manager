import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { deleteTestUsers } from '../helpers/auth-fixtures';
import {
  createDraftLoan,
  createLoanScenario,
  deleteTestLoans,
} from '../helpers/loan-fixtures';
import {
  deleteTestPayments,
  postPayment,
  reversePayment,
} from '../helpers/payment-fixtures';
import {
  atClock,
  businessInstant,
  createFourThousandLoan,
  deleteTestPenalties,
  ensurePenalty,
  restoreSeededLendingTerms,
  shiftDate,
} from '../helpers/delinquency-fixtures';
import { closePool, hasDatabase, query, queryOne, skipReason } from '../helpers/db';

/**
 * Reporting parity: every reported figure against the ledger it came from.
 *
 * ## Why this suite exists
 *
 * A dashboard that looks right and shows the wrong number is a financial
 * defect, and the way that happens is not a typo in a formula — it is a report
 * that aggregates slightly different rows from the ones the ledger counts. So
 * each assertion here reconciles a *reported* figure against a figure computed
 * directly from the base tables, in SQL written independently of the views.
 *
 * The generated portfolio deliberately contains one of everything (§129): a
 * loan up to date, one in arrears, one in its grace period, one charged a
 * penalty, one settled, one with a reversed payment, and one paid ahead. A
 * report that categorises any of them wrongly fails here rather than in front
 * of a user.
 */
const describeDb = hasDatabase ? describe : describe.skip;

if (!hasDatabase) {
  describe('reporting parity suite', () => {
    it.skip(`skipped — ${skipReason}`, () => undefined);
  });
}

interface Portfolio {
  readonly current: string;
  readonly inArrears: string;
  readonly inGrace: string;
  readonly penalised: string;
  readonly settled: string;
  readonly reversed: string;
  readonly prepaid: string;
  readonly draft: string;
  /** The business instant every assertion reads at. */
  readonly at: string;
  readonly today: string;
}

describeDb('reporting parity', () => {
  let portfolio: Portfolio;

  beforeAll(async () => {
    await deleteTestPayments();
    await deleteTestPenalties();
    await deleteTestLoans();
    await deleteTestUsers();

    portfolio = await buildPortfolio();
  }, 180_000);

  afterAll(async () => {
    await deleteTestPayments();
    await deleteTestPenalties();
    await deleteTestLoans();
    await deleteTestUsers();
    await restoreSeededLendingTerms();
    await closePool();
  });

  /**
   * One loan of every shape the reports have to categorise.
   *
   * Each gets its own borrower, because the one-active-loan rule means a
   * client may hold only one live loan at a time — which is itself a Phase 4
   * guarantee this suite relies on rather than works around.
   */
  async function buildPortfolio(): Promise<Portfolio> {
    // --- up to date: nothing paid, nothing due yet ------------------------
    const currentScenario = await createLoanScenario();
    const current = await createFourThousandLoan(currentScenario);

    // --- in arrears: two collections missed ------------------------------
    const arrearsScenario = await createLoanScenario();
    const arrears = await createFourThousandLoan(arrearsScenario);

    // --- in grace: past the final due date, inside grace, still owing -----
    const graceScenario = await createLoanScenario();
    const grace = await createFourThousandLoan(graceScenario, { graceDays: 3 });

    // --- penalised: past the charge date, charge materialised -------------
    const penalisedScenario = await createLoanScenario();
    const penalised = await createFourThousandLoan(penalisedScenario, { graceDays: 3 });

    // --- settled: paid in full on its first day ---------------------------
    const settledScenario = await createLoanScenario();
    const settled = await createFourThousandLoan(settledScenario);
    await postPayment(settled.loanId, settledScenario.secretary, {
      amount: settled.scheduledTotal,
      businessNow: businessInstant(settled.firstDue, '09:00:00'),
    });

    // --- reversed: a payment taken and withdrawn --------------------------
    const reversedScenario = await createLoanScenario();
    const reversed = await createFourThousandLoan(reversedScenario);
    const reversedPaymentId = await postPayment(
      reversed.loanId,
      reversedScenario.secretary,
      { amount: 4_000, businessNow: businessInstant(reversed.firstDue, '09:00:00') },
    );
    await reversePayment(
      reversedPaymentId,
      reversedScenario.owner,
      'Credited to the wrong borrower',
      businessInstant(reversed.firstDue, '16:00:00'),
    );

    // --- prepaid: three collections paid on the first day -----------------
    const prepaidScenario = await createLoanScenario();
    const prepaid = await createFourThousandLoan(prepaidScenario);
    await postPayment(prepaid.loanId, prepaidScenario.secretary, {
      amount: 12_000,
      businessNow: businessInstant(prepaid.firstDue, '09:00:00'),
    });

    // --- a draft, which has no schedule and no position -------------------
    const draftScenario = await createLoanScenario();
    const draftId = await createDraftLoan(draftScenario.clientId, {
      principal: 300_000,
      termMonths: 1,
      frequency: 'daily',
    });

    // The reading instant: two days past the penalised loan's charge date, so
    // every shape is in its intended state at once.
    const at = businessInstant(
      await shiftDate(penalised.penaltyEffective, 1),
      '10:00:00',
    );
    const today = await shiftDate(penalised.penaltyEffective, 1);

    // Materialise the penalty exactly as a payment would, at a date after the
    // charge became due. Nothing a report does could have created it.
    await ensurePenalty(penalised.loanId, businessInstant(penalised.penaltyEffective));

    void arrears;
    void grace;

    return {
      current: current.loanId,
      inArrears: arrears.loanId,
      inGrace: grace.loanId,
      penalised: penalised.loanId,
      settled: settled.loanId,
      reversed: reversed.loanId,
      prepaid: prepaid.loanId,
      draft: draftId,
      at,
      today,
    };
  }

  // =========================================================================
  describe('collection totals against the ledger', () => {
    it('reports total collected as the posted payments themselves', async () => {
      // §66: never a sum of scheduled amounts. Computed here straight from
      // `loan_payments`, with no view involved on the expected side.
      const [summary, ledger] = await Promise.all([
        queryOne<{ total_collected: string; posted_payment_total: string }>(
          `select total_collected::text, posted_payment_total::text
             from public.dashboard_portfolio_summary`,
        ),
        queryOne<{ total: string }>(
          `select coalesce(sum(amount), 0)::text as total
             from public.loan_payments where status = 'posted'`,
        ),
      ]);

      expect(summary.total_collected).toBe(ledger.total);
      expect(summary.posted_payment_total).toBe(ledger.total);
    });

    it('excludes reversed payments from every collected figure', async () => {
      const gross = await queryOne<{ total: string }>(
        `select coalesce(sum(amount), 0)::text as total from public.loan_payments`,
      );
      const effective = await queryOne<{ total: string }>(
        `select coalesce(sum(amount), 0)::text as total
           from public.loan_payments where status = 'posted'`,
      );

      // The portfolio contains a reversal, so these must differ — otherwise
      // the test below would pass trivially.
      expect(Number(gross.total)).toBeGreaterThan(Number(effective.total));

      const summary = await queryOne<{ total_collected: string }>(
        `select total_collected::text from public.dashboard_portfolio_summary`,
      );
      expect(summary.total_collected).toBe(effective.total);
    });

    it('reconciles principal, interest and penalty collected to the total', async () => {
      // §70. Every shilling received is applied to exactly one of the three,
      // so the components must sum to the collected total with nothing over.
      const summary = await queryOne<Record<string, string>>(
        `select principal_collected::text, interest_collected::text,
                penalty_collected::text, total_collected::text
           from public.dashboard_portfolio_summary`,
      );

      const components =
        Number(summary.principal_collected) +
        Number(summary.interest_collected) +
        Number(summary.penalty_collected);

      expect(components).toBe(Number(summary.total_collected));
      // And the figures come from the allocations, not from a ratio.
      const allocations = await queryOne<Record<string, string>>(
        `select coalesce(sum(pa.allocated_principal), 0)::text as principal,
                coalesce(sum(pa.allocated_interest), 0)::text as interest,
                coalesce(sum(pa.allocated_penalty), 0)::text as penalty
           from public.payment_allocations pa
           join public.loan_payments lp on lp.id = pa.payment_id
          where lp.status = 'posted'`,
      );

      expect(summary.principal_collected).toBe(allocations.principal);
      expect(summary.interest_collected).toBe(allocations.interest);
      expect(summary.penalty_collected).toBe(allocations.penalty);
    });

    it('splits a range by method so the three add up to the whole', async () => {
      // §149. Every payment has exactly one method, so this is an identity the
      // register cannot violate — unless a method were added without the
      // reports learning about it, which is what this catches.
      const rows = await query<{ payment_method: string; total: string }>(
        `select payment_method, coalesce(sum(effective_amount), 0)::text as total
           from public.payment_register
          group by payment_method
          order by payment_method`,
      );

      const byMethod = rows.reduce((sum, row) => sum + Number(row.total), 0);

      const total = await queryOne<{ total: string }>(
        `select coalesce(sum(effective_amount), 0)::text as total
           from public.payment_register`,
      );

      expect(byMethod).toBe(Number(total.total));

      // And the methods really are only the three the business accepts.
      expect(rows.map((row) => row.payment_method).sort()).toEqual(
        ['airtel_money', 'cash', 'mtn_mobile_money'].filter((method) =>
          rows.some((row) => row.payment_method === method),
        ),
      );
    });
  });

  // =========================================================================
  describe('outstanding totals', () => {
    it('reconciles contract plus penalty to the total outstanding', async () => {
      // §71.
      const summary = await queryOne<Record<string, string>>(
        `select contractual_outstanding::text, penalty_outstanding::text,
                total_outstanding::text
           from public.dashboard_portfolio_summary`,
      );

      expect(
        Number(summary.contractual_outstanding) + Number(summary.penalty_outstanding),
      ).toBe(Number(summary.total_outstanding));
    });

    it('matches the sum of every loan balance', async () => {
      const [summary, balances] = await Promise.all([
        queryOne<Record<string, string>>(
          `select total_outstanding::text, contractual_outstanding::text,
                  penalty_assessed::text, penalty_outstanding::text
             from public.dashboard_portfolio_summary`,
        ),
        queryOne<Record<string, string>>(
          `select coalesce(sum(total_outstanding), 0)::text as total_outstanding,
                  coalesce(sum(contractual_outstanding), 0)::text as contractual_outstanding,
                  coalesce(sum(penalty_assessed), 0)::text as penalty_assessed,
                  coalesce(sum(penalty_remaining), 0)::text as penalty_outstanding
             from public.loan_balances`,
        ),
      ]);

      expect(summary).toEqual(balances);
    });

    it('never reports a negative outstanding on any loan', async () => {
      const rows = await query<{ loan_id: string }>(
        `select loan_id from public.loan_portfolio_report
          where total_outstanding < 0 or contractual_outstanding < 0
             or penalty_remaining < 0`,
      );

      expect(rows).toEqual([]);
    });

    it('reports principal disbursed from the disbursement, not the status', async () => {
      // §12, and it matters: measuring by `status = 'active'` would drop every
      // settled loan and understate the book's history. The portfolio contains
      // a settled loan, so this would fail if it did.
      const [summary, loans] = await Promise.all([
        queryOne<{ principal_disbursed: string }>(
          `select principal_disbursed::text from public.dashboard_portfolio_summary`,
        ),
        queryOne<{ total: string; active_only: string }>(
          `select coalesce(sum(principal_amount), 0)::text as total,
                  coalesce(sum(principal_amount) filter (where status = 'active'), 0)::text
                    as active_only
             from public.loans where disbursed_at is not null`,
        ),
      ]);

      expect(summary.principal_disbursed).toBe(loans.total);
      expect(Number(loans.total)).toBeGreaterThan(Number(loans.active_only));
    });
  });

  // =========================================================================
  describe('the loan portfolio report against the authoritative views', () => {
    it('repeats loan_balances exactly, loan by loan', async () => {
      const rows = await query<{ loan_id: string }>(
        `select r.loan_id
           from public.loan_portfolio_report r
           join public.loan_balances b on b.loan_id = r.loan_id
          where r.total_outstanding is distinct from b.total_outstanding
             or r.contractual_outstanding is distinct from b.contractual_outstanding
             or r.penalty_assessed is distinct from b.penalty_assessed
             or r.penalty_remaining is distinct from b.penalty_remaining
             or r.total_collected is distinct from b.total_collected
             or r.total_paid is distinct from b.total_paid`,
      );

      expect(rows).toEqual([]);
    });

    it('repeats loan_delinquency exactly, loan by loan', async () => {
      // §15 and §127: there is one definition of overdue in this system.
      const rows = await atClock(portfolio.at, async (exec) =>
        exec(
          `select r.loan_id
             from public.loan_portfolio_report r
             join public.loan_delinquency d on d.loan_id = r.loan_id
            where r.arrears_amount is distinct from d.arrears_amount
               or r.due_today_amount is distinct from d.due_today_amount
               or r.current_due is distinct from d.current_due
               or r.days_past_due is distinct from d.days_past_due
               or r.missed_installment_count is distinct from d.missed_installment_count
               or r.delinquency_state is distinct from d.delinquency_state
               or r.grace_end_date is distinct from d.grace_end_date
               or r.penalty_effective_date is distinct from d.penalty_effective_date`,
        ),
      );

      expect(rows).toEqual([]);
    });

    it('shows a draft with no delinquency status rather than inventing one', async () => {
      const row = await queryOne<{
        loan_status: string;
        delinquency_state: string | null;
      }>(
        `select loan_status, delinquency_state
           from public.loan_portfolio_report where loan_id = $1`,
        [portfolio.draft],
      );

      expect(row.loan_status).toBe('draft');
      expect(row.delinquency_state).toBeNull();
    });
  });

  // =========================================================================
  describe('delinquency counts', () => {
    it('partitions the disbursed book exactly, with no loan counted twice', async () => {
      // §111. The seven states are mutually exclusive by construction, so they
      // must sum to the number of loans with a schedule. A dashboard that
      // claimed more loans than it has is the defect this prevents.
      const summary = await atClock(
        portfolio.at,
        async (exec) =>
          (
            await exec(
              `select loans_with_schedule::text, loans_state_current::text,
                    loans_state_due_today::text, loans_state_in_arrears::text,
                    loans_state_grace_period::text, loans_state_expired_unpaid::text,
                    loans_state_penalty_due::text, loans_state_cleared::text
               from public.dashboard_portfolio_summary`,
            )
          )[0] as Record<string, string>,
      );

      const sum =
        Number(summary.loans_state_current) +
        Number(summary.loans_state_due_today) +
        Number(summary.loans_state_in_arrears) +
        Number(summary.loans_state_grace_period) +
        Number(summary.loans_state_expired_unpaid) +
        Number(summary.loans_state_penalty_due) +
        Number(summary.loans_state_cleared);

      expect(sum).toBe(Number(summary.loans_with_schedule));
      expect(Number(summary.loans_with_schedule)).toBeGreaterThanOrEqual(7);
    });

    it('matches the delinquency view state by state', async () => {
      const { summary, view } = await atClock(portfolio.at, async (exec) => {
        const summaryRows = await exec(
          `select loans_state_in_arrears::text as in_arrears,
                  loans_state_grace_period::text as grace_period,
                  loans_state_penalty_due::text as penalty_due,
                  loans_state_cleared::text as cleared,
                  loans_with_arrears::text, loans_penalised::text,
                  arrears_total::text
             from public.dashboard_portfolio_summary`,
        );
        const viewRows = await exec(
          `select count(*) filter (where delinquency_state = 'in_arrears')::text as in_arrears,
                  count(*) filter (where delinquency_state = 'grace_period')::text as grace_period,
                  count(*) filter (where delinquency_state = 'penalty_due')::text as penalty_due,
                  count(*) filter (where delinquency_state = 'cleared')::text as cleared,
                  count(*) filter (where arrears_amount > 0)::text as loans_with_arrears,
                  count(*) filter (where penalty_applied)::text as loans_penalised,
                  coalesce(sum(arrears_amount), 0)::text as arrears_total
             from public.loan_delinquency`,
        );
        return { summary: summaryRows[0], view: viewRows[0] };
      });

      expect(summary).toEqual(view);
    });

    it('keeps the overlapping measures apart from the exclusive ones', async () => {
      // A penalised loan is in `penalty_due` *and* has arrears, so
      // `loans_with_arrears` legitimately exceeds `loans_state_in_arrears`.
      // Adding the two families would double-count, which is why they are
      // named differently and asserted to differ here.
      const summary = await atClock(
        portfolio.at,
        async (exec) =>
          (
            await exec(
              `select loans_state_in_arrears::text, loans_with_arrears::text
               from public.dashboard_portfolio_summary`,
            )
          )[0] as Record<string, string>,
      );

      expect(Number(summary.loans_with_arrears)).toBeGreaterThan(
        Number(summary.loans_state_in_arrears),
      );
    });

    it('counts a penalised loan as active in the lifecycle', async () => {
      // §112. Lifecycle and delinquency are separate axes.
      const row = await atClock(
        portfolio.at,
        async (exec) =>
          (
            await exec(
              `select loan_status, delinquency_state
               from public.loan_portfolio_report where loan_id = $1`,
              [portfolio.penalised],
            )
          )[0] as Record<string, string>,
      );

      expect(row.loan_status).toBe('active');
      expect(row.delinquency_state).toBe('penalty_due');
    });
  });

  // =========================================================================
  describe('the penalty report', () => {
    it('matches the penalty ledger exactly', async () => {
      // §128.
      const rows = await query<{ penalty_id: string }>(
        `select c.penalty_id
           from public.loan_penalty_coverage c
           join public.loan_penalties p on p.id = c.penalty_id
          where c.penalty_amount is distinct from p.penalty_amount
             or c.basis_amount is distinct from p.basis_amount
             or c.penalty_rate_bps is distinct from p.penalty_rate_bps
             or c.effective_date is distinct from p.effective_date`,
      );

      expect(rows).toEqual([]);
    });

    it('reconciles assessed, paid and remaining on every charge', async () => {
      const rows = await query<{ penalty_id: string }>(
        `select penalty_id from public.loan_penalty_coverage
          where penalty_amount <> allocated_amount + remaining_amount
             or remaining_amount < 0`,
      );

      expect(rows).toEqual([]);
    });

    it('reports a charge only once it is on the ledger', async () => {
      // §109. The penalised loan has a charge; the loan in its grace period
      // does not, however close its deadline is.
      const charged = await query<{ loan_id: string }>(
        `select loan_id from public.loan_penalty_coverage where loan_id = $1`,
        [portfolio.penalised],
      );
      expect(charged).toHaveLength(1);

      const inGrace = await query<{ loan_id: string }>(
        `select loan_id from public.loan_penalty_coverage where loan_id = $1`,
        [portfolio.inGrace],
      );
      expect(inGrace).toHaveLength(0);
    });

    it('sums assessed and collected to the portfolio figures', async () => {
      const [summary, coverage] = await Promise.all([
        queryOne<Record<string, string>>(
          `select penalty_assessed::text, penalty_collected::text,
                  penalty_outstanding::text
             from public.dashboard_portfolio_summary`,
        ),
        queryOne<Record<string, string>>(
          `select coalesce(sum(penalty_amount), 0)::text as penalty_assessed,
                  coalesce(sum(allocated_amount), 0)::text as penalty_collected,
                  coalesce(sum(remaining_amount), 0)::text as penalty_outstanding
             from public.loan_penalty_coverage`,
        ),
      ]);

      expect(summary).toEqual(coverage);
    });
  });

  // =========================================================================
  describe('prepayment and reversal in the reports', () => {
    it('keeps a prepaid loan off the collection sheet on a day it has covered', async () => {
      // §130. The prepaid loan paid three collections on day one, so day two
      // is covered and it must not appear as due.
      const secondDue = await queryOne<{ due: string }>(
        `select min(due_date)::text as due from public.loan_installments
          where loan_id = $1 and due_date > (
            select min(due_date) from public.loan_installments where loan_id = $1)`,
        [portfolio.prepaid],
      );

      const rows = await atClock(businessInstant(secondDue.due), async (exec) =>
        exec(`select loan_id from public.collections_today where loan_id = $1`, [
          portfolio.prepaid,
        ]),
      );

      expect(rows).toHaveLength(0);
    });

    it('still lists a reversed payment, and still excludes it from the total', async () => {
      // §131.
      const row = await queryOne<Record<string, string>>(
        `select count(*)::text as rows,
                coalesce(sum(amount), 0)::text as gross,
                coalesce(sum(effective_amount), 0)::text as effective
           from public.payment_register
          where loan_id = $1`,
        [portfolio.reversed],
      );

      expect(row.rows).toBe('1');
      expect(Number(row.gross)).toBe(4_000);
      expect(row.effective).toBe('0');
    });

    it('leaves the reversed loan owing its whole contract', async () => {
      const row = await queryOne<Record<string, string>>(
        `select b.scheduled_total::text, b.total_paid::text,
                b.contractual_outstanding::text
           from public.loan_balances b where b.loan_id = $1`,
        [portfolio.reversed],
      );

      expect(row.total_paid).toBe('0');
      expect(row.contractual_outstanding).toBe(row.scheduled_total);
    });
  });

  // =========================================================================
  describe('archived and blacklisted borrowers', () => {
    it('keeps their loans and payments in every financial report', async () => {
      // §132 and §133: a status describes whether the business will lend
      // again. It says nothing about the money already owed, and hiding those
      // borrowers would make the portfolio total disagree with itself.
      const clientId = await queryOne<{ client_id: string }>(
        `select client_id::text from public.loans where id = $1`,
        [portfolio.inArrears],
      );

      const before = await queryOne<{ total: string }>(
        `select total_outstanding::text as total from public.dashboard_portfolio_summary`,
      );

      await query(
        `update public.clients
            set status = 'blacklisted',
                status_reason = 'Test fixture: asserting history is not erased'
          where id = $1`,
        [clientId.client_id],
      );

      const after = await queryOne<{ total: string }>(
        `select total_outstanding::text as total from public.dashboard_portfolio_summary`,
      );

      expect(after.total).toBe(before.total);

      const stillListed = await query<{ loan_id: string }>(
        `select loan_id from public.loan_portfolio_report where loan_id = $1`,
        [portfolio.inArrears],
      );
      expect(stillListed).toHaveLength(1);

      await query(`update public.clients set status = 'archived' where id = $1`, [
        clientId.client_id,
      ]);

      const archived = await queryOne<{ total: string }>(
        `select total_outstanding::text as total from public.dashboard_portfolio_summary`,
      );
      expect(archived.total).toBe(before.total);
    });
  });

  // =========================================================================
  describe('the whole table, after everything', () => {
    it('leaves every reported loan reconciling', async () => {
      const rows = await query<{ loan_id: string; problem: string }>(
        `select loan_id::text,
                case
                  when total_paid + contractual_outstanding <> scheduled_total
                    then 'contract does not reconcile'
                  when principal_paid + principal_remaining <> contractual_principal
                    then 'principal does not reconcile'
                  when penalty_paid + penalty_remaining <> penalty_assessed
                    then 'penalty does not reconcile'
                  when total_collected <> posted_payment_total
                    then 'collected does not match the payments'
                  when total_outstanding <> contractual_outstanding + penalty_remaining
                    then 'total outstanding does not reconcile'
                  else ''
                end as problem
           from public.loan_balances
          where status in ('approved', 'active', 'cleared')`,
      );

      expect(rows.filter((row) => row.problem !== '')).toEqual([]);
      expect(rows.length).toBeGreaterThanOrEqual(7);
    });
  });
});
