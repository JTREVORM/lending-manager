import { expect, stateFile, test } from './fixtures';

/**
 * What a page actually costs, measured in a browser.
 *
 * ## Why in a browser, and why gzipped
 *
 * The people using this system are on phones, on mobile data, in Uganda.
 * Every kilobyte is somebody's airtime. Only a browser knows which chunks a
 * route pulls, and `transferSize` is the figure that crossed the network —
 * compressed, including headers — rather than the size on disk, which is
 * roughly three times larger and means nothing to a bill.
 *
 * `tests/integration/bundle.test.ts` guards the chunks themselves; this
 * guards the thing a person pays for.
 *
 * ## The budgets
 *
 * Measured on this build: 167-197 KB total per page, of which 153-164 KB is
 * JavaScript and 9 KB is CSS, over 14-32 requests. The ceilings are those
 * figures with working room, not round numbers.
 *
 * A budget that fails is not automatically a reason to raise the budget.
 */

/** Pages a member of staff opens in an ordinary morning. */
const PAGES = [
  '/',
  '/clients',
  '/loans',
  '/payments',
  '/payments/new',
  '/overdue',
  // Phase 14. The supervising screen, which reads a grouping-sets aggregate
  // over the whole active book — so it is the one most likely to drift, and
  // the one worth a budget.
  '/recovery',
  '/reports',
] as const;

interface PageCost {
  readonly wireKb: number;
  readonly jsKb: number;
  readonly cssKb: number;
  readonly requests: number;
  readonly ttfbMs: number;
  readonly fcpMs: number;
}

async function measure(page: import('@playwright/test').Page, path: string) {
  await page.goto(path, { waitUntil: 'networkidle' });

  return page.evaluate((): PageCost => {
    const resources = performance.getEntriesByType(
      'resource',
    ) as PerformanceResourceTiming[];
    const navigation = performance.getEntriesByType('navigation')[0] as
      PerformanceNavigationTiming | undefined;
    const paint = performance.getEntriesByName('first-contentful-paint')[0];

    const sum = (predicate: (r: PerformanceResourceTiming) => boolean): number =>
      resources.filter(predicate).reduce((total, r) => total + (r.transferSize || 0), 0);

    const resourceBytes = resources.reduce(
      (total, r) => total + (r.transferSize || 0),
      0,
    );

    return {
      wireKb: Math.round((resourceBytes + (navigation?.transferSize ?? 0)) / 1024),
      jsKb: Math.round(sum((r) => r.name.endsWith('.js')) / 1024),
      cssKb: Math.round(sum((r) => r.name.endsWith('.css')) / 1024),
      requests: resources.length + 1,
      ttfbMs: Math.round(navigation?.responseStart ?? 0),
      fcpMs: Math.round(paint?.startTime ?? 0),
    };
  });
}

test.describe('what a page costs a phone', () => {
  test.use({ storageState: stateFile('owner') });

  for (const path of PAGES) {
    test(path, async ({ page }) => {
      const cost = await measure(page, path);

      // Reported in the failure message, so a regression says by how much.
      const summary =
        `${path}: ${String(cost.wireKb)}KB wire, ${String(cost.jsKb)}KB js, ` +
        `${String(cost.cssKb)}KB css, ${String(cost.requests)} requests, ` +
        `ttfb ${String(cost.ttfbMs)}ms, fcp ${String(cost.fcpMs)}ms`;

      expect(cost.jsKb, summary).toBeLessThanOrEqual(220);
      expect(cost.cssKb, summary).toBeLessThanOrEqual(24);
      expect(cost.wireKb, summary).toBeLessThanOrEqual(320);

      // A request is a round trip, and a round trip on a slow connection
      // costs more than the bytes in it.
      //
      // 55 at this width, which is the counter laptop on the office line.
      // Most of it is Next.js prefetching the sidebar's eleven fixed
      // destinations plus whatever cards the page offers — a trade that is
      // worth it there, because those destinations do get used and the page
      // then opens instantly.
      //
      // The phone is the metered connection, and it is cheaper by
      // construction rather than by luck: the bottom bar holds four links and
      // the other seven sit inside a closed `<dialog>`, which is
      // `display: none` and so never enters the viewport that triggers a
      // prefetch. The same pages measure 25-32 requests there, and the mobile
      // project asserts this same ceiling.
      //
      // What was *not* a worthwhile trade was prefetching a link per row:
      // `/clients` was fetching twenty client pages nobody had asked for. See
      // `RowLink`.
      expect(cost.requests, summary).toBeLessThanOrEqual(55);
    });
  }
});

test.describe('the sign-in page, which is the first thing anybody downloads', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('is the smallest page in the application', async ({ page }) => {
    // Nobody has a cache yet, and somebody signing in on a borrowed phone
    // is paying for all of it. It carries no application data at all, so it
    // should cost less than any signed-in screen.
    const cost = await measure(page, '/login');

    const summary = `${String(cost.wireKb)}KB wire, ${String(cost.jsKb)}KB js, fcp ${String(cost.fcpMs)}ms`;

    expect(cost.jsKb, summary).toBeLessThanOrEqual(200);
    expect(cost.wireKb, summary).toBeLessThanOrEqual(260);
    expect(cost.requests, summary).toBeLessThanOrEqual(20);
  });

  test('paints quickly, because the alternative is a blank screen', async ({ page }) => {
    const cost = await measure(page, '/login');

    // Measured at 124ms on a local stack. The ceiling is generous because
    // this runs on whatever machine CI gives it; a regression into
    // seconds is what it is there to catch.
    expect(cost.fcpMs, `fcp ${String(cost.fcpMs)}ms`).toBeLessThanOrEqual(3_000);
  });
});
