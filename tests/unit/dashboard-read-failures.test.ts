import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Phase 19 — a cancelled query is reported, never rendered as a figure.
 *
 * ## What went wrong
 *
 * Production cancelled every dashboard query on `/` with PostgreSQL `57014`
 * (`query_canceled`): the `authenticated` role carries an eight-second
 * `statement_timeout`, the dashboard fires its reads in one `Promise.all`, and
 * under that concurrency each whole-book aggregate crossed the budget.
 *
 * The cancellation was handled. That was the problem. Six of the readers
 * answered a failed query with an empty list or a zero:
 *
 *   * the collection sheet became "nobody owes anything today"
 *   * recent payments became "no payments have been taken"
 *   * the three lifecycle cards became "no loans paid out, settled or charged"
 *   * `getPendingApprovals` became "nothing is waiting for your decision"
 *   * `getPortfolioAtRisk` became a book with **no arrears in it**
 *
 * Every one of those is a statement about the business, none of them was true,
 * and the last is the most dangerous sentence this product can say. A lending
 * dashboard that cannot read the ledger has to say so.
 *
 * ## What these tests pin
 *
 * That each reader returns `null` — "I could not read this" — rather than a
 * shape that a screen would draw as fact. The page's own handling of `null` is
 * covered separately; this file covers the contract the page relies on, which
 * is where the defect actually lived.
 */

// `lib/data/*` is server-only, which refuses to load outside a React Server
// Component. The readers themselves are plain async functions; the guard is
// what stops them being imported here, so it is stubbed rather than worked
// around.
vi.mock('server-only', () => ({}));

/** The error PostgREST relays when Postgres cancels a statement. */
const CANCELLED = {
  code: '57014',
  message: 'canceling statement due to statement timeout',
};

/**
 * A Supabase query builder that fails.
 *
 * Every method returns the same object, so any chain the readers build —
 * `.select().eq().order().limit()`, `.range()`, `.not()`, `.gt()` — lands on
 * the same awaited result. `maybeSingle()` and `then()` both resolve to the
 * failure, because the readers use both shapes.
 */
/** What the next builder resolves to. Switched by the success-path tests. */
let nextResult: { data: unknown; error: unknown; count: number | null } = {
  data: null,
  error: CANCELLED,
  count: null,
};

/** Every `.order()` and `.limit()` the readers asked for, in order. */
const shape: { table: string; order: unknown[]; limit: number | null }[] = [];

function failingBuilder(_error: unknown): unknown {
  const result = nextResult;
  const builder: Record<string, unknown> = {};

  for (const method of [
    'select',
    'eq',
    'neq',
    'gt',
    'gte',
    'lt',
    'lte',
    'not',
    'is',
    'in',
    'range',
    'filter',
    'match',
    'or',
  ]) {
    builder[method] = () => builder;
  }

  // Recorded rather than merely chained: whether the *database* does the
  // ordering, and whether the read is bounded, is the property under test.
  builder.order = (...args: unknown[]) => {
    shape[shape.length - 1]?.order.push(args);
    return builder;
  };
  builder.limit = (rows: number) => {
    const current = shape[shape.length - 1];
    if (current !== undefined) current.limit = rows;
    return builder;
  };

  builder.maybeSingle = () => Promise.resolve(result);
  builder.single = () => Promise.resolve(result);
  // Awaiting the builder itself resolves to the failure.
  builder.then = (
    resolve: (value: typeof result) => unknown,
    reject?: (reason: unknown) => unknown,
  ) => Promise.resolve(result).then(resolve, reject);

  return builder;
}

const fromMock = vi.fn((table: string) => {
  shape.push({ table, order: [], limit: null });
  return failingBuilder(CANCELLED);
});

vi.mock('@/lib/supabase/server', () => ({
  createSupabaseServerClient: () => Promise.resolve({ from: fromMock }),
}));

// The readers log a warning on failure, which is correct and not under test.
vi.mock('@/lib/logger', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

const {
  getCollectionSummary,
  getPendingApprovals,
  getPortfolioSummary,
  getRecoveryWorkload,
  listCollectionSheet,
  listRecentLoanActivity,
  listRecentPayments,
  listUpcomingCollections,
} = await import('@/lib/data/dashboard');

const { getPortfolioAtRisk } = await import('@/lib/data/security');

describe('a cancelled dashboard query is reported, not rendered', () => {
  beforeEach(() => {
    fromMock.mockClear();
    shape.length = 0;
    nextResult = { data: null, error: CANCELLED, count: null };
  });

  it('the portfolio summary reports failure', async () => {
    await expect(getPortfolioSummary()).resolves.toBeNull();
  });

  it("today's collection summary reports failure", async () => {
    await expect(getCollectionSummary()).resolves.toBeNull();
  });

  it("today's collection sheet does not become an empty sheet", async () => {
    // The regression: `{ rows: [], hasMore: false }`. A clerk reads that as
    // "nobody is due today" and goes home.
    await expect(listCollectionSheet({ pageSize: 8 })).resolves.toBeNull();
  });

  it('recent payments does not become "no payments taken"', async () => {
    await expect(listRecentPayments(6)).resolves.toBeNull();
  });

  it('upcoming collections does not become "nothing due this week"', async () => {
    const today = '2026-10-14' as never;
    await expect(
      listUpcomingCollections({ after: today, through: today }),
    ).resolves.toBeNull();
  });

  it('the three lifecycle cards report failure together', async () => {
    // One read now feeds all three cards, so one failure is one answer and the
    // three cards cannot disagree about whether the book could be read.
    await expect(listRecentLoanActivity(4)).resolves.toBeNull();
  });

  it('the recovery workload reports failure', async () => {
    await expect(getRecoveryWorkload('2026-10-14' as never)).resolves.toBeNull();
  });

  it('approvals awaiting a decision does not become zero', async () => {
    // The worst of the counts: an approver's only prompt is this card, and a
    // zero on it means "go home", not "the queue could not be read".
    await expect(
      getPendingApprovals({ transfers: true, expenses: true, reconciliations: true }),
    ).resolves.toBeNull();
  });

  it('portfolio at risk does not become a book with no arrears', async () => {
    // `EMPTY_PAR` has a zero in every ageing bucket and a zero PAR ratio. On
    // the risk screen that is indistinguishable from a clean portfolio.
    await expect(getPortfolioAtRisk()).resolves.toBeNull();
  });

  it('reached the database rather than short-circuiting', async () => {
    // Guards the tests above rather than the code: a reader that returned
    // `null` without ever querying would satisfy every assertion in this file,
    // so at least one of them is pinned to the table it must read.
    await getPortfolioSummary();
    expect(fromMock).toHaveBeenCalledWith('dashboard_portfolio_summary');
  });
});

describe('the lifecycle cards are selected by the database', () => {
  beforeEach(() => {
    fromMock.mockClear();
    shape.length = 0;
  });

  it('orders and bounds every selection in the database', async () => {
    // Phase 19 read `limit(2000)` with no ordering and sorted in JavaScript,
    // so past the cap the "most recent" lists were ranked within an arbitrary
    // subset. The fix is that the database chooses the rows. These assertions
    // are what stop that regressing: every selection must carry a descending
    // `order` and a bounded `limit`.
    nextResult = { data: [], error: null, count: null };

    await listRecentLoanActivity(4);

    const selections = shape.filter(
      (q) => q.table === 'loans' || q.table === 'loan_penalties',
    );

    expect(selections.length).toBeGreaterThanOrEqual(3);

    for (const selection of selections) {
      expect(
        selection.order,
        `${selection.table} must order in the database`,
      ).not.toEqual([]);
      expect(selection.order[0]).toEqual([expect.any(String), { ascending: false }]);
      expect(selection.limit, `${selection.table} must bound its read`).not.toBeNull();
      expect(selection.limit).toBeLessThanOrEqual(50);
    }
  });

  it('orders on the stored, indexable columns', async () => {
    nextResult = { data: [], error: null, count: null };

    await listRecentLoanActivity(4);

    const columns = shape
      .filter((q) => q.table === 'loans' || q.table === 'loan_penalties')
      .map((q) => (q.order[0] as unknown[] | undefined)?.[0]);

    // `disbursed_at` and `cleared_at` are columns on `loans`;
    // `effective_date` is a column on `loan_penalties` with its own index.
    // None of them is computed by a view, which is what makes the ordering
    // answerable without scanning the book.
    expect(columns).toContain('disbursed_at');
    expect(columns).toContain('cleared_at');
    expect(columns).toContain('effective_date');
  });

  it('never reads the whole-book view more than once', async () => {
    // Three separate ordered reads of `loan_portfolio_report` were what
    // Phase 19 removed, each costing a scan of the book. The enrichment read
    // is filtered to the ids already chosen, so there is at most one.
    nextResult = { data: [], error: null, count: null };

    await listRecentLoanActivity(4);

    const views = shape.filter((q) => q.table === 'loan_portfolio_report');
    expect(views.length).toBeLessThanOrEqual(1);
  });

  it('reports failure when a selection cannot be read', async () => {
    nextResult = { data: null, error: CANCELLED, count: null };
    await expect(listRecentLoanActivity(4)).resolves.toBeNull();
  });
});
