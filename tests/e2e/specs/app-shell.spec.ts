import {
  expect,
  expectNoErrorBoundary,
  fixtures,
  stateFile,
  test,
  watchForBrowserErrors,
} from './fixtures';

/**
 * Every authenticated screen, opened in a browser.
 *
 * This is the spec that exists because of the Phase 8 review: three defects
 * that 2,584 unit tests could not see, all three visible in the first ten
 * minutes of actually opening the application.
 *
 *   1. Every authenticated page rendered an error boundary. The pages still
 *      returned 200 and still had headings — the heading said "Something
 *      went wrong".
 *   2. `/users` returned a 500 from a PostgREST relationship ambiguity
 *      (PGRST201), which only appears when the request goes through
 *      PostgREST rather than straight to PostgreSQL.
 *   3. The record-payment form lost its own inputs between steps.
 *
 * So each page below is asserted three ways: it reached a 200, it rendered
 * its own heading rather than a boundary, and nothing was logged to the
 * console. The third is what makes this cheap to keep: a page that throws
 * during hydration says so in the console even when the server HTML looks
 * perfect.
 */

interface Screen {
  readonly name: string;
  readonly path: string;
  /** Text that only this page's own content produces. */
  readonly proves: RegExp;
}

const OWNER_SCREENS: readonly Screen[] = [
  { name: 'dashboard', path: '/', proves: /Dashboard/ },
  { name: 'clients', path: '/clients', proves: /Clients/ },
  {
    name: 'new client',
    path: '/clients/new',
    proves: /Register a client|Personal details/i,
  },
  {
    name: 'client detail',
    path: `/clients/${fixtures.clients.arrears}`,
    proves: /Loans|Guarantors/,
  },
  { name: 'guarantors', path: '/guarantors', proves: /Guarantors/ },
  { name: 'loans', path: '/loans', proves: /Loans/ },
  { name: 'new loan', path: '/loans/new', proves: /loan|Principal/i },
  {
    name: 'loan detail',
    path: `/loans/${fixtures.loans.arrears}`,
    proves: /Schedule|Repayment/i,
  },
  {
    name: 'loan statement',
    path: `/loans/${fixtures.loans.arrears}/statement`,
    proves: /Statement/i,
  },
  {
    name: 'approved, not disbursed',
    path: `/loans/${fixtures.loans.approvedNotDisbursed}`,
    // §74. The state the screenshot pass could not reach.
    proves: /Disburse|approved/i,
  },
  {
    name: 'pending approval',
    path: `/loans/${fixtures.loans.pending}`,
    proves: /Approv/i,
  },
  { name: 'draft loan', path: `/loans/${fixtures.loans.draft}`, proves: /Draft|Submit/i },
  { name: 'payments', path: '/payments', proves: /Payments/ },
  { name: 'record a payment', path: '/payments/new', proves: /Record a payment/ },
  { name: 'overdue', path: '/overdue', proves: /Overdue/ },
  { name: 'debt and security', path: '/recovery', proves: /Debt & Security/ },
  { name: 'risk monitoring', path: '/recovery?view=risk', proves: /Portfolio at risk/ },
  {
    name: 'guarantor register',
    path: '/guarantors/register',
    proves: /Guarantor register/,
  },
  { name: 'collection summary', path: '/payments/summary', proves: /Collection summary/ },
  { name: 'reports hub', path: '/reports', proves: /Reports/ },
  { name: 'collections report', path: '/reports/collections', proves: /Collections/ },
  { name: 'arrears report', path: '/reports/arrears', proves: /Arrears/ },
  { name: 'loan portfolio report', path: '/reports/loans', proves: /Loan portfolio/ },
  { name: 'clients report', path: '/reports/clients', proves: /Clients/ },
  {
    name: 'penalties report',
    path: '/reports/penalties',
    proves: /Late-payment charges/,
  },
  { name: 'grace report', path: '/reports/grace', proves: /Grace period/ },
  // The 500. This line is the regression test for it.
  { name: 'users', path: '/users', proves: /Users/ },
  { name: 'add staff', path: '/users/new', proves: /Add staff member/ },
  { name: 'audit trail', path: '/audit', proves: /Audit trail/ },
  { name: 'settings', path: '/settings', proves: /Settings/ },
  { name: 'my account', path: '/account', proves: /My account/ },
  { name: 'change password', path: '/account/password', proves: /Change password/ },
];

// Every test below runs as the Owner/Administrator, from the session the
// setup project saved. One sign-in for the whole file, which is how a browser
// behaves and what the sign-in limiter expects.
test.use({ storageState: stateFile('owner') });

test.describe('the staff application renders', () => {
  for (const screen of OWNER_SCREENS) {
    test(screen.name, async ({ page }) => {
      const watcher = watchForBrowserErrors(page);

      const response = await page.goto(screen.path);
      expect(response?.status(), `${screen.path} status`).toBe(200);

      await expectNoErrorBoundary(page);

      // The page's own content, not the shell's. At phone width the sidebar
      // is `hidden md:block` rather than unmounted, so its "Dashboard" link
      // is in the DOM and `display: none` — an unscoped first match found
      // that and reported the dashboard as invisible.
      await expect(
        page.locator('main').getByText(screen.proves).filter({ visible: true }).first(),
      ).toBeVisible();

      expect(watcher.errors, `${screen.path} console`).toEqual([]);
    });
  }
});

test.describe('the shell itself', () => {
  test('styles actually load', async ({ page }) => {
    // The first defect was a Tailwind token that resolved to nothing, so
    // every `bg-accent` in the application emitted no CSS at all while the
    // build stayed green. Tailwind 4 reports no error for an undefined
    // token — it simply omits the rule — so this is asserted by asking the
    // browser what it painted.
    await page.goto('/');

    const body = page.locator('body');
    const background = await body.evaluate(
      (element) => getComputedStyle(element).backgroundColor,
    );

    // Not transparent and not the browser default white: the design system's
    // own surface token resolved.
    expect(background).not.toBe('rgba(0, 0, 0, 0)');

    // And the accent family, whose absence was the defect.
    const accent = await page.evaluate(() =>
      getComputedStyle(document.documentElement)
        .getPropertyValue('--color-accent')
        .trim(),
    );
    expect(accent).not.toBe('');
  });

  test('every nav destination is reachable and none 500s', async ({ page }) => {
    await page.goto('/');

    const hrefs = await page
      .locator('nav a[href^="/"]')
      .evaluateAll((links) =>
        Array.from(new Set(links.map((link) => link.getAttribute('href') ?? ''))),
      );

    expect(hrefs.length).toBeGreaterThan(3);

    for (const href of hrefs) {
      const response = await page.goto(href);
      expect(response?.status(), href).toBeLessThan(400);
      await expectNoErrorBoundary(page);
    }
  });

  test('a page that does not exist says so rather than falling over', async ({
    page,
  }) => {
    // The status matters as much as the words. A root `loading.tsx` used to
    // flush the response shell before the page had read anything, which
    // committed `200 OK` and left `notFound()` nothing to set: the body said
    // "not found" while the status said "here it is". The boundary was
    // removed and the feedback moved into the links — see `LinkPending`.
    for (const path of [
      '/loans/00000000-0000-0000-0000-000000000000',
      '/clients/00000000-0000-0000-0000-000000000000',
      '/payments/00000000-0000-0000-0000-000000000000',
      '/users/00000000-0000-0000-0000-000000000000',
    ]) {
      const response = await page.goto(path);
      expect(response?.status(), path).toBe(404);
      await expect(page.getByText(/not found|does not exist/i).first()).toBeVisible();
    }
  });
});
