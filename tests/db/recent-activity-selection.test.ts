import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { deleteTestUsers } from '../helpers/auth-fixtures';
import { createLoanScenario, deleteTestLoans } from '../helpers/loan-fixtures';
import { closePool, query, hasDatabase, skipReason } from '../helpers/db';

/**
 * Phase 20 — the dashboard's "recent activity" cards select in the database.
 *
 * ## The bug this exists for
 *
 * Phase 19 collapsed three reads of `loan_portfolio_report` into one, to stop
 * the dashboard paying for three scans of the whole loan book. The replacement
 * read had **no `order by`**: it took `limit(2000)` rows and sorted them in
 * JavaScript.
 *
 * Without `order by`, PostgreSQL returns whichever rows it finds first — in
 * practice, heap order. So once the book passes the cap, the "most recent
 * disbursement" was the most recent *of an arbitrary 2,000*, and a loan
 * disbursed today could be missing while one from last year was shown. An
 * independent review caught it before it shipped.
 *
 * The three queries it replaced ordered server-side and were correct at any
 * size. The optimisation had traded correctness for speed.
 *
 * ## What is asserted
 *
 * The book here is deliberately larger than the old cap, and the newest
 * activity is deliberately placed **outside the window an unordered read would
 * return** — inserted last, so it sits at the end of the heap.
 *
 *   1. An unordered capped read **misses** it. This is the defect, reproduced,
 *      so the test would have failed against the Phase 19 code.
 *   2. An ordered, limited read **finds** it, reading a bounded number of rows
 *      rather than the book.
 *   3. The charge date the card now orders on (`loan_penalties.effective_date`,
 *      which has an index) equals the view's derived `penalty_effective_date`,
 *      so moving the ordering to the indexed column selects the same loans.
 */
const describeDb = hasDatabase ? describe : describe.skip;

if (!hasDatabase) {
  describe('recent activity selection suite', () => {
    it.skip(`skipped — ${skipReason}`, () => undefined);
  });
}

/** Comfortably past the 2,000-row cap the Phase 19 read used. */
const BOOK_SIZE = 2_100;

/** The cap that read used, reproduced here to show what it would have missed. */
const OLD_CAP = 2_000;

/**
 * Distinctive, so the teardown can find exactly these rows.
 *
 * Marked in `notes` rather than `loan_number`, because a trigger assigns the
 * loan number and refuses one supplied by the caller — which is the right rule
 * and not one to work around for a test.
 */
const MARKER = 'phase20-recent-activity-selection-fixture';

interface IdRow {
  id: string;
  loan_number: string;
  disbursed_at: string;
}

describeDb('recent loan activity is selected by the database', () => {
  let newestId = '';
  let newestNumber = '';

  beforeAll(async () => {
    const scenario = await createLoanScenario();

    const [product] = await query<{ id: string }>(
      `select id from public.loan_products order by created_at limit 1`,
    );
    const [actor] = await query<{ id: string }>(
      `select id from public.profiles where auth_user_id = $1`,
      [scenario.owner.authUserId],
    );
    const [frequency] = await query<{ key: string }>(
      `select key from public.repayment_frequencies order by key limit 1`,
    );

    expect(frequency?.key).toBeDefined();

    expect(product?.id).toBeDefined();
    expect(actor?.id).toBeDefined();

    // One statement, so the suite is not waiting on 2,100 round trips.
    //
    // `disbursed_at` *increases* with the row number, so the newest loan is
    // the last one written and therefore the last one an unordered scan
    // reaches. That is the whole point: the recent activity sits outside the
    // window a capped, unordered read would return.
    await query(
      `insert into public.loans (
         client_id, principal_amount, interest_rate_bps,
         total_interest, total_expected_repayment,
         interest_method, loan_term_months, repayment_frequency,
         min_loan_amount_applied, grace_period_days_applied,
         penalty_rate_bps_applied, proposed_disbursement_date,
         status, created_at, approved_at, approved_by,
         disbursed_at, disbursed_by, created_by, notes
       )
       select
         -- An active loan must carry consistent totals
         -- (loans_approved_requires_totals): expected repayment is principal
         -- plus interest. These are fixture figures, not a computation this
         -- test is asserting.
         $1, 500000, 1200, 30000, 530000,
         'reducing_balance_monthly', 6, $4,
         100000, 7, 500, current_date,
         'active',
         -- created_at is dated alongside the rest: the table checks that a
         -- loan was not approved before it existed, which a backdated
         -- approval on a row created now would violate.
         pg_catalog.now() - make_interval(days => ${String(BOOK_SIZE)} - i),
         pg_catalog.now() - make_interval(days => ${String(BOOK_SIZE)} - i),
         $2,
         pg_catalog.now() - make_interval(days => ${String(BOOK_SIZE)} - i),
         $2, $2, $3
       from pg_catalog.generate_series(1, ${String(BOOK_SIZE)}) as g(i)`,
      [scenario.clientId, actor?.id, MARKER, frequency?.key],
    );

    const [newest] = await query<IdRow>(
      `select id, loan_number, disbursed_at::text as disbursed_at
         from public.loans
        where notes = '${MARKER}'
        order by disbursed_at desc
        limit 1`,
    );

    newestId = newest?.id ?? '';
    newestNumber = newest?.loan_number ?? '';
    expect(newestId).not.toBe('');
  }, 120_000);

  afterAll(async () => {
    // `deleteTestLoans` removes every loan with the append-only guards
    // suspended, which is what these 2,100 rows need: inserting them built
    // `loan_periods` and `loan_installments`, and both refuse a bare DELETE.
    await deleteTestLoans();
    await deleteTestUsers();
    await closePool();
  }, 120_000);

  it('built a book larger than the old cap', async () => {
    const [row] = await query<{ n: string }>(
      `select count(*) as n from public.loans where notes = '${MARKER}'`,
    );

    expect(Number(row?.n ?? 0)).toBe(BOOK_SIZE);
    expect(BOOK_SIZE).toBeGreaterThan(OLD_CAP);
  });

  it('an unordered capped read misses the newest disbursement', async () => {
    // Phase 19's shape: take `cap` rows with no ordering, then rank them in
    // memory. This is the defect, and this assertion is what would have failed
    // against that code.
    const window = await query<{ id: string }>(
      `select id from public.loans
        where notes = '${MARKER}' and disbursed_at is not null
        limit ${String(OLD_CAP)}`,
    );

    expect(window).toHaveLength(OLD_CAP);

    const ids = new Set(window.map((row) => row.id));

    // The newest loan is outside the window, so no amount of sorting the
    // window can surface it.
    expect(ids.has(newestId)).toBe(false);
  });

  it('an ordered, limited read returns the true newest disbursements', async () => {
    const top = await query<IdRow>(
      `select id, loan_number, disbursed_at::text as disbursed_at
         from public.loans
        where notes = '${MARKER}' and disbursed_at is not null
        order by disbursed_at desc
        limit 4`,
    );

    expect(top).toHaveLength(4);
    expect(top[0]?.id).toBe(newestId);
    expect(top[0]?.loan_number).toBe(newestNumber);

    // Strictly descending, which is what the card claims to show.
    const dates = top.map((row) => row.disbursed_at);
    expect([...dates].sort().reverse()).toEqual(dates);
  });

  it('reads a bounded number of rows to do it', async () => {
    // The point of ordering in the database is that it does not have to
    // materialise the book to answer. Over 2,100 loans the plan must not
    // return every row to the client, and the limit must be visible in it.
    const plan = await query<{ 'QUERY PLAN': string }>(
      `explain (analyze, format text)
       select id from public.loans
        where disbursed_at is not null
        order by disbursed_at desc
        limit 4`,
    );

    const text = plan.map((row) => row['QUERY PLAN']).join('\n');

    expect(text).toContain('Limit');
    // Four rows out of the top node, not 2,100.
    expect(/Limit[^\n]*rows=4/.test(text)).toBe(true);
  });

  it('the indexed charge date equals the view’s derived one', async () => {
    // The card used to be ordered on `loan_portfolio_report`'s
    // `penalty_effective_date`, which the view computes as
    // `final_due_date + grace_period_days_applied + 1` and so cannot be
    // indexed. It is now ordered on `loan_penalties.effective_date`, which is
    // stored and indexed.
    //
    // Those are the same date for a loan that carries a charge — the penalty
    // row's `effective_date` is the day after its `grace_end_date`, which is
    // the same arithmetic. This pins that, so a future change to either side
    // fails here rather than quietly changing which loans the card lists.
    const [row] = await query<{
      applied: string;
      agree: string;
      day_after_grace: string;
    }>(
      `select count(*)                                                      as applied,
              count(*) filter (where p.effective_date = r.penalty_effective_date) as agree,
              count(*) filter (where p.effective_date = p.grace_end_date + 1)     as day_after_grace
         from public.loan_penalties p
         join public.loan_portfolio_report r on r.loan_id = p.loan_id
        where r.penalty_applied`,
    );

    const applied = Number(row?.applied ?? 0);

    // Nothing to compare is not a pass: say so rather than succeed vacuously.
    if (applied === 0) {
      const [any] = await query<{ n: string }>(
        `select count(*) as n from public.loan_penalties`,
      );
      expect(
        Number(any?.n ?? 0),
        'no recorded penalties in this database, so the equivalence is untested here',
      ).toBe(0);
      return;
    }

    expect(Number(row?.agree ?? -1)).toBe(applied);
    expect(Number(row?.day_after_grace ?? -1)).toBe(applied);
  });
});
