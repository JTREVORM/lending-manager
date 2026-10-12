import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { deleteTestUsers } from '../helpers/auth-fixtures';
import { createLoanScenario, deleteTestLoans } from '../helpers/loan-fixtures';
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
  restoreSeededLendingTerms,
  shiftDate,
  type FourThousandLoan,
} from '../helpers/delinquency-fixtures';
import { closePool, hasDatabase, query, queryOne, skipReason } from '../helpers/db';

/**
 * The Phase 8 reporting views.
 *
 * ## What this suite is for
 *
 * Two things that cannot be checked anywhere else.
 *
 * **The structure.** Five views, every one `security_invoker`, SELECT only,
 * nothing granted to `anon`, and none of them materialised. A reporting view
 * that ran as its owner would be the most valuable single object in the schema
 * to an attacker: one SELECT returning every borrower's position regardless of
 * who asked.
 *
 * **The semantics the reports depend on.** `expected_today` as at the start of
 * the day rather than now; a prepaid collection absent from the sheet; gross
 * and effective amounts diverging the moment a payment is reversed. Each of
 * these is a sentence in the specification that a report would otherwise
 * quietly get wrong.
 *
 * Every expected figure is a literal. The daily loan is UGX 4,000 a
 * collection, which is the Phase 7 fixture's shape, and nothing here calls a
 * production function to work out what it should see.
 */
const describeDb = hasDatabase ? describe : describe.skip;

if (!hasDatabase) {
  describe('reporting views suite', () => {
    it.skip(`skipped — ${skipReason}`, () => undefined);
  });
}

const REPORTING_VIEWS = [
  'collections_today',
  'dashboard_collection_summary',
  'dashboard_portfolio_summary',
  'loan_portfolio_report',
  'payment_register',
] as const;

describeDb('the reporting views', () => {
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
  describe('structure', () => {
    it('creates all five as views, never as tables', async () => {
      const rows = await query<{ relname: string; relkind: string }>(
        `select c.relname, c.relkind::text
           from pg_class c join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'public' and c.relname = any($1::text[])
          order by c.relname`,
        [[...REPORTING_VIEWS]],
      );

      expect(rows.map((row) => row.relname)).toEqual([...REPORTING_VIEWS]);

      // 'v' is a view. 'm' would be a materialised view — owned data with no
      // caller to be read on behalf of, which Row Level Security cannot apply
      // to at all. Phase 7 noted one might help a larger portfolio; Phase 8
      // declines it, and this is the assertion that keeps the decision.
      for (const row of rows) {
        expect(row.relkind, row.relname).toBe('v');
      }
    });

    it('sets security_invoker on every one', async () => {
      const rows = await query<{ relname: string; invoker: string | null }>(
        `select c.relname,
                (select option_value from pg_options_to_table(c.reloptions)
                  where option_name = 'security_invoker') as invoker
           from pg_class c join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'public' and c.relname = any($1::text[])`,
        [[...REPORTING_VIEWS]],
      );

      expect(rows).toHaveLength(REPORTING_VIEWS.length);

      for (const row of rows) {
        expect(row.invoker, row.relname).toBe('true');
      }
    });

    it('grants authenticated nothing but SELECT, and anon nothing at all', async () => {
      const rows = await query<{
        grantee: string;
        table_name: string;
        privilege_type: string;
      }>(
        `select grantee, table_name, privilege_type
           from information_schema.role_table_grants
          where table_schema = 'public'
            and table_name = any($1::text[])
            and grantee in ('anon', 'authenticated', 'public')
          order by table_name, grantee, privilege_type`,
        [[...REPORTING_VIEWS]],
      );

      // Supabase's ALTER DEFAULT PRIVILEGES grants every privilege on a new
      // object in `public` to both `anon` and `authenticated`, and
      // `revoke all from public` does not remove them. Phase 6 shipped this
      // wrong once.
      expect(
        rows.map((row) => `${row.grantee}:${row.table_name}:${row.privilege_type}`),
      ).toEqual(REPORTING_VIEWS.map((view) => `authenticated:${view}:SELECT`));
    });

    it('carries a comment on every one, so a reader knows what it means', async () => {
      const rows = await query<{ relname: string; description: string | null }>(
        `select c.relname, pg_catalog.obj_description(c.oid, 'pg_class') as description
           from pg_class c join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'public' and c.relname = any($1::text[])`,
        [[...REPORTING_VIEWS]],
      );

      for (const row of rows) {
        expect(row.description, row.relname).not.toBeNull();
        expect((row.description ?? '').length, row.relname).toBeGreaterThan(40);
      }
    });

    it('keeps every money column an integer type', async () => {
      // `sum(bigint)` returns `numeric` in PostgreSQL, so a widening is
      // invisible in the SQL. A money figure in an arbitrary-precision decimal
      // is one implicit cast away from a fractional shilling — the defect the
      // Phase 4 guard was written for and Phase 6 found again.
      const rows = await query<{
        table_name: string;
        column_name: string;
        data_type: string;
      }>(
        `select table_name, column_name, data_type
           from information_schema.columns
          where table_schema = 'public'
            and table_name = any($1::text[])
            and (column_name like '%amount%' or column_name like '%_paid'
                 or column_name like '%outstanding%' or column_name like '%collected%'
                 or column_name like '%_total' or column_name like '%assessed%'
                 or column_name like '%remaining%' or column_name like '%received%'
                 or column_name like '%disbursed' or column_name like '%_due'
                 or column_name like '%principal%' or column_name like '%interest%')
            and column_name not like '%date%'
            and column_name not like '%_at'
            and column_name not like '%method%'
            -- fully_repaid is a boolean that happens to contain "paid"; this
            -- assertion is about money, so the data type filter belongs in the
            -- selection rather than in the expectation.
            and data_type <> 'boolean'
          order by table_name, column_name`,
        [[...REPORTING_VIEWS]],
      );

      expect(rows.length).toBeGreaterThan(20);

      for (const row of rows) {
        expect(
          ['bigint', 'integer', 'smallint'],
          `${row.table_name}.${row.column_name}`,
        ).toContain(row.data_type);
      }
    });
  });

  // =========================================================================
  describe('an empty portfolio', () => {
    it('reports zero rather than null', async () => {
      // A dashboard of nulls renders as blank cards, which reads as "broken"
      // rather than "nothing has been lent yet". Both summary views are built
      // so that an empty database answers zero.
      const summary = await queryOne<Record<string, string>>(
        `select total_clients::text, loans_total::text, principal_disbursed::text,
                total_collected::text, total_outstanding::text, arrears_total::text,
                loans_with_schedule::text
           from public.dashboard_portfolio_summary`,
      );

      for (const [column, value] of Object.entries(summary)) {
        expect(value, column).not.toBeNull();
      }

      const today = await queryOne<Record<string, string>>(
        `select expected_today::text, collected_today::text, remaining_today::text,
                cash_received::text, mtn_received::text, airtel_received::text,
                bank_received::text,
                loans_due_today::text, clients_due_today::text
           from public.dashboard_collection_summary`,
      );

      for (const [column, value] of Object.entries(today)) {
        expect(value, column).toBe('0');
      }
    });

    it('returns exactly one row from each summary, always', async () => {
      // A dashboard reading `maybeSingle()` would show nothing at all if the
      // aggregate ever returned no row, so the views are built from
      // aggregates without GROUP BY rather than from joins that could miss.
      for (const view of [
        'dashboard_portfolio_summary',
        'dashboard_collection_summary',
      ]) {
        const rows = await query(`select 1 from public.${view}`);
        expect(rows, view).toHaveLength(1);
      }
    });
  });

  // =========================================================================
  describe("today's collection sheet", () => {
    let scenario: Awaited<ReturnType<typeof createLoanScenario>>;
    let loan: FourThousandLoan;

    beforeAll(async () => {
      scenario = await createLoanScenario();
      loan = await createFourThousandLoan(scenario);
    });

    it('shows the collection due today as the day started', async () => {
      const row = await atClock(
        businessInstant(loan.firstDue),
        async (exec) =>
          (
            await exec(
              `select expected_today::text, collected_today::text,
                      remaining_today::text, collection_status
                 from public.collections_today where loan_id = $1`,
              [loan.loanId],
            )
          )[0],
      );

      expect(row).toBeDefined();
      expect(row?.expected_today).toBe('4000');
      expect(row?.collected_today).toBe('0');
      expect(row?.remaining_today).toBe('4000');
      expect(row?.collection_status).toBe('unpaid');
    });

    it('keeps expected_today at the start-of-day figure after a payment', async () => {
      // This is the distinction Phase 8 had to introduce. `due_today_amount`
      // nets off today's payment, which is the right answer to "what is still
      // owed" and the wrong answer to "what were we expecting to collect".
      // Both are reported, and they diverge the moment somebody pays.
      await postPayment(loan.loanId, scenario.secretary, {
        amount: 4_000,
        businessNow: businessInstant(loan.firstDue, '11:00:00'),
      });

      const row = await atClock(
        businessInstant(loan.firstDue, '12:00:00'),
        async (exec) =>
          (
            await exec(
              `select expected_today::text, collected_today::text,
                      remaining_today::text, collection_status, payments_today::text
                 from public.collections_today where loan_id = $1`,
              [loan.loanId],
            )
          )[0],
      );

      expect(row?.expected_today).toBe('4000');
      expect(row?.collected_today).toBe('4000');
      expect(row?.remaining_today).toBe('0');
      expect(row?.payments_today).toBe('1');
      expect(row?.collection_status).toBe('paid');
    });

    it('drops a collection that was already covered before today', async () => {
      // §130. The borrower paid ahead; the sheet must not send anybody to
      // their door, and the loan is absent from the view entirely rather than
      // present with a zero.
      const secondDue = await shiftDate(loan.firstDue, 1);

      const rows = await atClock(businessInstant(secondDue), async (exec) =>
        exec(`select loan_id from public.collections_today where loan_id = $1`, [
          loan.loanId,
        ]),
      );

      // The UGX 4,000 paid on day one covered day one, not day two, so day two
      // is still due — this asserts the view is working, before the prepayment
      // case below.
      expect(rows).toHaveLength(1);

      // Now pay two collections ahead on day two, and day three is covered.
      await postPayment(loan.loanId, scenario.secretary, {
        amount: 8_000,
        businessNow: businessInstant(secondDue, '11:00:00'),
      });

      const thirdDue = await shiftDate(loan.firstDue, 2);

      const prepaid = await atClock(businessInstant(thirdDue), async (exec) =>
        exec(
          `select loan_id, expected_today::text
             from public.collections_today where loan_id = $1`,
          [loan.loanId],
        ),
      );

      expect(prepaid).toHaveLength(0);
    });

    it('keeps the day target in step with the sheet it summarises', async () => {
      // The summary is portfolio-wide and this suite creates several loans, so
      // the assertion that matters is not a literal total — it is that the
      // summary counts exactly the rows the sheet shows, and that a prepaid
      // loan is in neither. A summary that disagreed with its own detail is
      // the §124 defect.
      const thirdDue = await shiftDate(loan.firstDue, 2);
      const at = businessInstant(thirdDue);

      const { summary, sheet } = await atClock(at, async (exec) => {
        const summaryRows = await exec(
          `select expected_today::text, loans_due_today::text,
                  clients_due_today::text
             from public.dashboard_collection_summary`,
        );
        const sheetRows = await exec(
          `select loan_id::text, client_id::text, expected_today::text
             from public.collections_today`,
        );
        return { summary: summaryRows[0], sheet: sheetRows };
      });

      expect(summary?.loans_due_today).toBe(String(sheet.length));
      expect(summary?.clients_due_today).toBe(
        String(new Set(sheet.map((row) => row.client_id)).size),
      );
      expect(summary?.expected_today).toBe(
        String(sheet.reduce((total, row) => total + Number(row.expected_today), 0)),
      );

      // And the prepaid loan is in neither.
      expect(sheet.map((row) => row.loan_id)).not.toContain(loan.loanId);
    });
  });

  // =========================================================================
  describe('the payment register', () => {
    let scenario: Awaited<ReturnType<typeof createLoanScenario>>;
    let loan: FourThousandLoan;
    let paymentId: string;

    beforeAll(async () => {
      scenario = await createLoanScenario();
      loan = await createFourThousandLoan(scenario);

      paymentId = await postPayment(loan.loanId, scenario.secretary, {
        amount: 4_000,
        businessNow: businessInstant(loan.firstDue, '09:30:00'),
        method: 'mtn_mobile_money',
        externalReference: `RPT${Date.now().toString().slice(-9)}`,
      });
    });

    it('splits the payment into its components, and they sum to the amount', async () => {
      const row = await queryOne<Record<string, string>>(
        `select amount::text, effective_amount::text, is_effective::text,
                allocated_principal::text, allocated_interest::text,
                allocated_penalty::text, principal_collected::text,
                interest_collected::text, penalty_collected::text,
                business_date::text, payment_method, status
           from public.payment_register where payment_id = $1`,
        [paymentId],
      );

      expect(row.amount).toBe('4000');
      expect(row.effective_amount).toBe('4000');
      expect(row.is_effective).toBe('true');
      expect(row.status).toBe('posted');
      expect(row.payment_method).toBe('mtn_mobile_money');
      expect(row.business_date).toBe(loan.firstDue);

      const components =
        Number(row.principal_collected) +
        Number(row.interest_collected) +
        Number(row.penalty_collected);
      expect(components).toBe(4_000);
    });

    it('zeroes the effective figures when the payment is reversed, and keeps the row', async () => {
      // Reversed later the same business day. The clock matters: a reversal
      // stamped before the payment it reverses is refused by
      // `loan_payments_reversed_after_received`, which is the Phase 7 defect
      // that found the mutation guard using the wrong clock.
      await reversePayment(
        paymentId,
        scenario.owner,
        'Recorded against the wrong loan',
        businessInstant(loan.firstDue, '15:00:00'),
      );

      const row = await queryOne<Record<string, string>>(
        `select amount::text, effective_amount::text, is_effective::text, status,
                allocated_principal::text, principal_collected::text,
                interest_collected::text, penalty_collected::text, reversal_reason
           from public.payment_register where payment_id = $1`,
        [paymentId],
      );

      // The row stays: financial history does not disappear.
      expect(row.status).toBe('reversed');
      expect(row.is_effective).toBe('false');
      // Gross is what was recorded; effective is what counts.
      expect(row.amount).toBe('4000');
      expect(row.effective_amount).toBe('0');
      // The allocation is still visible — it is what happened — but it no
      // longer counts towards anything collected.
      expect(Number(row.allocated_principal)).toBeGreaterThan(0);
      expect(row.principal_collected).toBe('0');
      expect(row.interest_collected).toBe('0');
      expect(row.penalty_collected).toBe('0');
      expect(row.reversal_reason).toContain('wrong loan');
    });

    it('leaves this loan contributing nothing to the day it was received', async () => {
      // Scoped to the loan, because the summary is portfolio-wide and this
      // suite creates several loans on the same dates. What matters is that a
      // withdrawn payment contributes zero.
      const row = await queryOne<Record<string, string>>(
        `select coalesce(sum(effective_amount), 0)::text as effective,
                coalesce(sum(amount), 0)::text as gross,
                pg_catalog.count(*)::text as rows
           from public.payment_register
          where loan_id = $1 and business_date = $2::date`,
        [loan.loanId, loan.firstDue],
      );

      expect(row.rows).toBe('1');
      expect(row.gross).toBe('4000');
      expect(row.effective).toBe('0');
    });

    it('keeps the day summary in step with the register it summarises', async () => {
      // §124: a card that disagreed with its own detail report is the defect.
      // The summary is built from the register, so this asserts they are the
      // same arithmetic rather than two guesses.
      const at = businessInstant(loan.firstDue, '18:00:00');

      const { summary, register } = await atClock(at, async (exec) => {
        const summaryRows = await exec(
          `select collected_today::text, payments_today::text,
                  mtn_received::text, cash_received::text, airtel_received::text,
                  bank_received::text
             from public.dashboard_collection_summary`,
        );
        const registerRows = await exec(
          `select coalesce(sum(effective_amount), 0)::text as effective,
                  pg_catalog.count(*) filter (where is_effective)::text as effective_rows
             from public.payment_register
            where business_date = public.business_date()`,
        );
        return { summary: summaryRows[0], register: registerRows[0] };
      });

      expect(summary?.collected_today).toBe(register?.effective);
      expect(summary?.payments_today).toBe(register?.effective_rows);

      // And the method figures add up to the collected total, because every
      // payment has exactly one method. Phase 10 added a fourth — `bank` —
      // and this sum is what would have caught its omission: before
      // 20261010000400 the view split three ways, so a bank transfer counted
      // in `collected_today` and in none of the method columns.
      const methods =
        Number(summary?.cash_received) +
        Number(summary?.mtn_received) +
        Number(summary?.airtel_received) +
        Number(summary?.bank_received);
      expect(methods).toBe(Number(summary?.collected_today));
    });

    it('reports a reversal on the day of the reversal, not of the payment', async () => {
      // A payment from last week withdrawn this morning is this morning's
      // correction, so the reversal figure is keyed on the reversal date.
      const at = businessInstant(loan.firstDue, '18:00:00');

      const summary = await atClock(
        at,
        async (exec) =>
          (
            await exec(
              `select reversed_today_count::text, reversed_today_amount::text
               from public.dashboard_collection_summary`,
            )
          )[0],
      );

      expect(Number(summary?.reversed_today_count)).toBeGreaterThanOrEqual(1);
      expect(Number(summary?.reversed_today_amount)).toBeGreaterThanOrEqual(4_000);
    });
  });

  // =========================================================================
  describe('the loan portfolio report', () => {
    it('includes a draft loan with no derived position rather than zeroes', async () => {
      const { createDraftLoan } = await import('../helpers/loan-fixtures');
      const scenario = await createLoanScenario();
      const draftId = await createDraftLoan(scenario.clientId, {
        principal: 500_000,
        termMonths: 1,
        frequency: 'daily',
      });

      const row = await queryOne<Record<string, string | null>>(
        `select loan_status, delinquency_state, scheduled_completion_date::text,
                total_outstanding::text, disbursed_at::text
           from public.loan_portfolio_report where loan_id = $1`,
        [draftId],
      );

      expect(row.loan_status).toBe('draft');
      // Null, not zero. A draft is not "up to date" — it has not been paid out,
      // which is a different thing, and inventing a status would make the
      // dashboard's state counts disagree with its lifecycle counts.
      expect(row.delinquency_state).toBeNull();
      expect(row.scheduled_completion_date).toBeNull();
      expect(row.disbursed_at).toBeNull();
    });

    it('carries the borrower as they were at origination and as they are now', async () => {
      const scenario = await createLoanScenario();
      const loan = await createFourThousandLoan(scenario);

      const before = await queryOne<Record<string, string>>(
        `select client_name, client_name_at_origination
           from public.loan_portfolio_report where loan_id = $1`,
        [loan.loanId],
      );

      expect(before.client_name_at_origination).toBe(before.client_name);

      // Rename the borrower. The snapshot must not follow: a statement is a
      // historical document, and the person who signed in March did not change
      // because they married in April.
      await query(`update public.clients set full_name = $2 where id = $1`, [
        scenario.clientId,
        'Renamed Borrower',
      ]);

      const after = await queryOne<Record<string, string>>(
        `select client_name, client_name_at_origination
           from public.loan_portfolio_report where loan_id = $1`,
        [loan.loanId],
      );

      expect(after.client_name).toBe('Renamed Borrower');
      expect(after.client_name_at_origination).toBe(before.client_name_at_origination);
      expect(after.client_name_at_origination).not.toBe('Renamed Borrower');
    });
  });

  // =========================================================================
  describe('reading a report', () => {
    it('writes nothing — not a penalty, not anything', async () => {
      // §108, and the Phase 7 rule it restates. A SELECT may run in a
      // read-only transaction, as a borrower, or under a role with no
      // privileges on `loan_penalties`; a read that wrote would break all
      // three and would be a surprise nobody asked for.
      const scenario = await createLoanScenario();
      const loan = await createFourThousandLoan(scenario, { graceDays: 3 });

      const afterPenaltyDate = businessInstant(loan.penaltyEffective, '10:00:00');

      const before = await queryOne<{ n: string }>(
        `select pg_catalog.count(*)::text as n from public.loan_penalties
          where loan_id = $1`,
        [loan.loanId],
      );
      expect(before.n).toBe('0');

      const eligible = await atClock(afterPenaltyDate, async (exec) => {
        // Read every reporting view that touches this loan, repeatedly.
        for (let pass = 0; pass < 3; pass += 1) {
          await exec(`select * from public.dashboard_portfolio_summary`);
          await exec(`select * from public.dashboard_collection_summary`);
          await exec(`select * from public.collections_today`);
          await exec(`select * from public.loan_portfolio_report where loan_id = $1`, [
            loan.loanId,
          ]);
          await exec(`select * from public.payment_register where loan_id = $1`, [
            loan.loanId,
          ]);
        }

        const rows = await exec(
          `select penalty_eligible::text, penalty_applied::text,
                  penalty_projected_amount::text
             from public.loan_portfolio_report where loan_id = $1`,
          [loan.loanId],
        );
        return rows[0];
      });

      // The charge is due and the report says so — as pending.
      expect(eligible?.penalty_eligible).toBe('true');
      expect(eligible?.penalty_applied).toBe('false');
      expect(Number(eligible?.penalty_projected_amount)).toBeGreaterThan(0);

      const after = await queryOne<{ n: string }>(
        `select pg_catalog.count(*)::text as n from public.loan_penalties
          where loan_id = $1`,
        [loan.loanId],
      );

      // Fifteen reads later, still no charge on the ledger.
      expect(after.n).toBe('0');
    });
  });
});
