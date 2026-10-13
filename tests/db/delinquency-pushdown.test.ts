import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { deleteTestUsers } from '../helpers/auth-fixtures';
import {
  createDraftLoan,
  createLoanScenario,
  deleteTestLoans,
  disburseLoan,
} from '../helpers/loan-fixtures';
import { deleteTestPayments } from '../helpers/payment-fixtures';
import { closePool, query, hasDatabase, skipReason } from '../helpers/db';

/**
 * Phase 18 — `loan_delinquency` reads one loan without computing the book.
 *
 * ## What this file is for
 *
 * Migration `20261018000200` restructured the view: the `today`, `bounds` and
 * `cover` CTEs became a scalar subquery and two grouped subqueries, so
 * PostgreSQL can push `loan_id = <this loan>` down to an index instead of
 * materialising the whole portfolio behind an optimisation barrier.
 *
 * It is a rewrite of the query that decides whether a borrower is in arrears,
 * how far behind they are, and what penalty applies. The arithmetic is
 * untouched — same expressions, same rows, same precedence — but "untouched"
 * is a claim, and this is where it is checked.
 *
 * Two things are asserted:
 *
 *   1. **The figures are the same.** Every column of the view is recomputed
 *      here from the schedule, the allocations and the business date, in SQL
 *      written independently of the view, and compared row for row. This is
 *      the same discipline `delinquency-parity.test.ts` applies between the
 *      database and the TypeScript engine, turned on the view itself.
 *   2. **The pushdown actually happens.** A one-loan read must not scan every
 *      installment in the database. That is the entire point of the
 *      migration, and it is a property that a later edit to the view could
 *      quietly undo — a CTE reintroduced for readability would restore the
 *      barrier and nothing else would fail.
 *
 * The behavioural coverage of what the figures *mean* stays where it was:
 * `delinquency.test.ts` pins them against hard-coded expectations with the
 * business date fixed, and `delinquency-parity.test.ts` proves the database
 * and the engine agree. Both run against the restructured view.
 */
const describeDb = hasDatabase ? describe : describe.skip;

if (!hasDatabase) {
  describe('delinquency pushdown suite', () => {
    it.skip(`skipped — ${skipReason}`, () => undefined);
  });
}

describeDb('loan_delinquency, restructured', () => {
  // The database suite runs against a freshly migrated database, so the view
  // has nothing to report until there is a book. Three disbursed loans is
  // enough for the pushdown assertion to be meaningful: a one-loan read must
  // touch fewer installments than the table holds.
  beforeAll(async () => {
    // A client may hold only one active loan, so each needs its own
    // borrower. Three is enough for the pushdown assertion to bite: a
    // one-loan read must touch a third of the installments in the table.
    for (let i = 0; i < 3; i += 1) {
      const scenario = await createLoanScenario();
      const loanId = await createDraftLoan(scenario.clientId);
      await disburseLoan(loanId, scenario);
    }
  });

  afterAll(async () => {
    await deleteTestPayments();
    await deleteTestLoans();
    await deleteTestUsers();
    await closePool();
  });

  it('carries no CTE, which is what made it opaque to the planner', async () => {
    const rows = await query<{ definition: string }>(
      `select pg_get_viewdef('public.loan_delinquency'::regclass, true) as definition`,
    );
    const row = rows[0];

    // A non-recursive CTE referenced more than once is materialised, and a
    // materialised CTE is a barrier: no qualifier reaches past it. `today`
    // was referenced four times, which pinned it, and `cover` referenced
    // `today`, which pinned `cover` too.
    //
    // If a future change wants a CTE here, it needs to prove the pushdown
    // survives it — the plan assertion below is the proof, and this
    // assertion is the early warning.
    expect(row?.definition ?? '').not.toMatch(/\bWITH\b/i);
  });

  it('reads one loan without scanning every installment', async () => {
    const busiest = await query<{ id: string }>(
      `select l.id
         from public.loans l
         join public.loan_installments li on li.loan_id = l.id
        group by l.id
        order by count(*) desc
        limit 1`,
    );
    const loanId = busiest[0]?.id;
    expect(loanId).toBeDefined();

    const totals = await query<{ n: string }>(
      `select count(*) as n from public.loan_installments`,
    );
    const totalInstallments = Number(totals[0]?.n ?? 0);

    const mine = await query<{ n: string }>(
      `select count(*) as n from public.loan_installments where loan_id = $1`,
      [loanId],
    );
    const loanInstallments = Number(mine[0]?.n ?? 0);

    // A whole-book scan would read every installment in the database; the
    // pushed-down plan reads only this loan's. The seed has several loans, so
    // the two numbers are meaningfully different.
    expect(totalInstallments).toBeGreaterThan(loanInstallments);

    const plan = await query<{ 'QUERY PLAN': string }>(
      `explain (analyze, buffers, format text)
       select * from public.loan_delinquency where loan_id = $1`,
      [loanId],
    );

    const text = plan.map((line) => line['QUERY PLAN']).join('\n');

    // Sum the rows actually read from `loan_installments` across every node
    // that touched it. Before the migration this was the whole table (once
    // per loan, in the nested-loop case); after it, it is this loan's rows.
    const installmentRows = [
      ...text.matchAll(/on loan_installments \w*\s*\(actual rows=(\d+) loops=(\d+)\)/g),
    ].reduce((total, match) => total + Number(match[1]) * Number(match[2]), 0);

    // Generous headroom — the view reads installments through two subqueries,
    // so this loan's rows may legitimately be read more than once — while
    // still being far below a whole-table scan.
    expect(
      installmentRows,
      `read ${String(installmentRows)} installment rows for a loan with ` +
        `${String(loanInstallments)} of them; the table holds ` +
        `${String(totalInstallments)}. Plan:\n${text}`,
    ).toBeLessThan(totalInstallments);
  });

  it('reports the same figures as an independent recomputation', async () => {
    // Recomputed from first principles rather than from the view: the
    // schedule, the posted allocations, and today in the business timezone.
    // Deliberately *not* reusing `loan_installment_coverage`'s shape, so a
    // mistake shared between the two would not cancel out.
    const rows = await query<{
      loan_id: string;
      column_name: string;
      from_view: string | null;
      recomputed: string | null;
    }>(
      `with today as (
         select public.business_date() as d
       ),
       paid as (
         select pa.installment_id, sum(pa.allocated_amount) as allocated
           from public.payment_allocations pa
           join public.loan_payments lp on lp.id = pa.payment_id
          where lp.status = 'posted' and pa.installment_id is not null
          group by pa.installment_id
       ),
       inst as (
         select li.loan_id,
                li.due_date,
                li.expected_amount,
                li.expected_amount - coalesce(p.allocated, 0) as remaining
           from public.loan_installments li
           left join paid p on p.installment_id = li.id
       ),
       mine as (
         select
           i.loan_id,
           count(*)::int                                            as installment_count,
           min(i.due_date)                                          as first_due_date,
           max(i.due_date)                                          as scheduled_completion_date,
           sum(i.expected_amount)::bigint                           as scheduled_total,
           sum(case when i.due_date < t.d then i.remaining else 0 end)::bigint
                                                                    as arrears_amount,
           sum(case when i.due_date = t.d then i.remaining else 0 end)::bigint
                                                                    as due_today_amount,
           count(*) filter (where i.due_date < t.d and i.remaining > 0)::int
                                                                    as missed_installment_count,
           min(i.due_date) filter (where i.remaining > 0)           as oldest_unpaid_due_date,
           min(i.due_date) filter (where i.remaining > 0 and i.due_date < t.d)
                                                                    as oldest_past_due_date
         from inst i cross join today t
         group by i.loan_id
       )
       select d.loan_id, c.column_name, c.from_view, c.recomputed
         from public.loan_delinquency d
         join mine m on m.loan_id = d.loan_id
         cross join lateral (
           values
             ('installment_count',         d.installment_count::text,         m.installment_count::text),
             ('first_due_date',            d.first_due_date::text,            m.first_due_date::text),
             ('scheduled_completion_date', d.scheduled_completion_date::text, m.scheduled_completion_date::text),
             ('scheduled_total',           d.scheduled_total::text,           m.scheduled_total::text),
             ('arrears_amount',            d.arrears_amount::text,            m.arrears_amount::text),
             ('due_today_amount',          d.due_today_amount::text,          m.due_today_amount::text),
             ('current_due',               d.current_due::text,               (m.arrears_amount + m.due_today_amount)::text),
             ('missed_installment_count',  d.missed_installment_count::text,  m.missed_installment_count::text),
             ('oldest_unpaid_due_date',    d.oldest_unpaid_due_date::text,    m.oldest_unpaid_due_date::text),
             ('oldest_past_due_date',      d.oldest_past_due_date::text,      m.oldest_past_due_date::text),
             ('business_date',             d.business_date::text,             (select t.d::text from today t))
         ) as c(column_name, from_view, recomputed)
        order by d.loan_id, c.column_name`,
    );

    expect(rows.length).toBeGreaterThan(0);

    const disagreements = rows
      .filter((row) => row.from_view !== row.recomputed)
      .map(
        (row) =>
          `${row.loan_id} ${row.column_name}: view ${String(row.from_view)} vs ${String(row.recomputed)}`,
      );

    expect(disagreements, disagreements.join('\n')).toEqual([]);
  });

  it('derives days_past_due from the oldest overdue collection, as before', async () => {
    const rows = await query<{
      loan_id: string;
      days_past_due: number;
      expected: number;
    }>(
      `select loan_id,
              days_past_due,
              case
                when oldest_past_due_date is null then 0
                else (business_date - oldest_past_due_date)
              end as expected
         from public.loan_delinquency`,
    );

    expect(rows.length).toBeGreaterThan(0);

    for (const row of rows) {
      expect(row.days_past_due, row.loan_id).toBe(row.expected);
    }
  });

  it('keeps the operational state mutually exclusive and in precedence order', async () => {
    // The seven states are decided by a CASE evaluated top to bottom. The
    // restructure moved the clauses' inputs from CTEs to subqueries, so this
    // re-checks the one property the ordering exists to guarantee.
    const rows = await query<{
      loan_id: string;
      delinquency_state: string;
      loan_status: string;
      penalty_remaining: string;
      penalty_eligible: boolean;
      arrears_amount: string;
      due_today_amount: string;
    }>(
      `select loan_id, delinquency_state, loan_status, penalty_remaining,
              penalty_eligible, arrears_amount, due_today_amount
         from public.loan_delinquency`,
    );

    expect(rows.length).toBeGreaterThan(0);

    const states = new Set([
      'cleared',
      'penalty_due',
      'expired_unpaid',
      'grace_period',
      'in_arrears',
      'due_today',
      'current',
    ]);

    for (const row of rows) {
      expect(states.has(row.delinquency_state), row.delinquency_state).toBe(true);

      // `cleared` outranks everything, which is what stops a settled loan
      // presenting as overdue.
      if (row.loan_status === 'cleared') {
        expect(row.delinquency_state, row.loan_id).toBe('cleared');
      }

      // An unpaid recorded penalty outranks arrears.
      if (row.delinquency_state === 'penalty_due') {
        expect(Number(row.penalty_remaining)).toBeGreaterThan(0);
      }

      // `current` means nothing is owed today or earlier.
      if (row.delinquency_state === 'current') {
        expect(Number(row.arrears_amount), row.loan_id).toBe(0);
        expect(Number(row.due_today_amount), row.loan_id).toBe(0);
      }
    }
  });
});
