import {
  expect,
  expectNoErrorBoundary,
  resetRateLimits,
  stateFile,
  test,
} from './fixtures';

/**
 * The reports, their charts, their downloads and their printed form.
 *
 * §17's rule is the one worth testing here: a chart may not disagree with the
 * table beside it, and nothing may exist only as a picture. The parity is
 * asserted by reading the chart's own hidden table and the report's visible
 * table and comparing them — not by recomputing anything.
 */

test.use({ storageState: stateFile('owner') });

/**
 * Clear the export budget before each download.
 *
 * Exports are limited to ten in ten minutes per person, which is correct: a
 * CSV of the whole register is the most expensive thing this system does and
 * the most useful thing to steal. This file downloads twelve of them, twice
 * (once per viewport), as the same Owner — so by the second project the
 * limiter was refusing, and the failures looked like broken reports.
 *
 * This is not the limiter being weakened. That it refuses the eleventh export
 * is asserted in `security.spec.ts`, which is the file about limits. Clearing
 * the counter here only stops one spec file's spending from throttling the
 * next, which is an artefact of running a whole suite as one person and not a
 * thing any real cashier does.
 */
test.beforeEach(async () => {
  await resetRateLimits();
});

const REPORTS = [
  { name: 'collections', path: '/reports/collections', heading: /Collections/ },
  { name: 'arrears', path: '/reports/arrears', heading: /Arrears/ },
  { name: 'loan portfolio', path: '/reports/loans', heading: /Loan portfolio/ },
  { name: 'clients', path: '/reports/clients', heading: /Clients/ },
  { name: 'penalties', path: '/reports/penalties', heading: /Late-payment charges/ },
  { name: 'grace period', path: '/reports/grace', heading: /Grace period/ },
] as const;

test.describe('the reports hub', () => {
  test('groups the reports instead of listing six links', async ({ page }) => {
    await page.goto('/reports');
    await expectNoErrorBoundary(page);

    for (const report of REPORTS) {
      await expect(
        page.getByRole('link', { name: report.heading }).first(),
      ).toBeVisible();
    }

    // §16. The hub carries a few headline figures so the page is worth
    // opening, and the tables behind it remain the authority.
    expect(await page.locator('[data-money]').count()).toBeGreaterThan(0);
  });
});

for (const report of REPORTS) {
  test.describe(`the ${report.name} report`, () => {
    test('renders with a table and a download', async ({ page }) => {
      await page.goto(report.path);
      await expectNoErrorBoundary(page);

      await expect(
        page.getByRole('heading', { name: report.heading }).first(),
      ).toBeVisible();

      // Either rows, or an explicit statement that there are none. A blank
      // panel is the failure this catches.
      //
      // "Rows" is different markup at the two widths: a table from `md` up,
      // and a card list below it. Asserting on the table alone passed on the
      // laptop and failed on the phone, where the table is `hidden`.
      const rows = page
        .locator('main table tbody tr, main ul[class*="md:hidden"] > li')
        .filter({ visible: true });
      const empty = page.getByText(/no .*(found|match|recorded)|nothing/i).first();

      const rowCount = await rows.count();
      const hasEmpty = await empty.isVisible().catch(() => false);

      expect(rowCount > 0 || hasEmpty, 'rows, or a stated reason for none').toBe(true);

      if (rowCount > 0) {
        await expect(
          page.getByRole('link', { name: /download csv/i }).first(),
        ).toBeVisible();
      }
    });

    test('downloads a CSV of the rows on screen', async ({ page }) => {
      await page.goto(report.path);

      const link = page.getByRole('link', { name: /download csv/i }).first();
      if (!(await link.isVisible().catch(() => false))) {
        test.skip(true, 'this report has no rows in the seeded data');
        return;
      }

      const href = (await link.getAttribute('href')) ?? '';
      const response = await page.request.get(href);

      expect(response.status()).toBe(200);
      expect(response.headers()['content-type']).toMatch(/text\/csv/);
      // A download, not something a browser renders in place.
      expect(response.headers()['content-disposition']).toMatch(/attachment/);
      // And never cached by a shared proxy: this is somebody's money.
      expect(response.headers()['cache-control']).toMatch(/no-store|private/);

      const body = await response.text();
      expect(body.split('\n').length).toBeGreaterThan(1);
      // The header row names columns rather than database identifiers.
      expect(body.split('\n')[0]).not.toMatch(/_id|uuid/i);
    });

    test('prints without the application around it', async ({ page }) => {
      // §76.
      await page.goto(report.path);
      await page.emulateMedia({ media: 'print' });

      const navs = page.locator('nav');
      for (let index = 0; index < (await navs.count()); index += 1) {
        await expect(navs.nth(index)).toBeHidden();
      }
      await expect(page.getByRole('link', { name: /download csv/i })).toBeHidden();

      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow).toBeLessThanOrEqual(1);

      await page.emulateMedia({ media: 'screen' });
    });
  });
}

test.describe('the collections chart', () => {
  /**
   * A month, not the default single day.
   *
   * The chart is drawn only when there is more than one day to compare — one
   * bar is not a comparison — so the default period has no chart in it, and
   * pointing these tests at it meant the §17 parity assertion skipped itself
   * on every run. A test that skips when it finds nothing is a test that
   * reports success for a chart that was never drawn.
   */
  const CHARTED = '/reports/collections?period=month';

  test('says exactly what the report says', async ({ page }) => {
    // §17. Parity, read from the page rather than recomputed.
    await page.goto(CHARTED);

    const chart = page.locator('figure[data-chart="magnitude"]').first();
    await expect(chart, 'a month of collections is drawn').toBeAttached();

    // The chart's own table — the accessible equivalent §17 requires.
    const chartFigures = await chart
      .locator('table tbody tr td')
      .evaluateAll((cells) =>
        cells
          .map((cell) => (cell.textContent ?? '').replace(/[^\d]/g, ''))
          .filter((v) => v !== ''),
      );

    expect(chartFigures.length).toBeGreaterThan(0);

    // Every figure the chart draws appears in the report's own table.
    const pageText = ((await page.locator('main').textContent()) ?? '').replace(
      /[^\d]/g,
      '',
    );
    for (const figure of chartFigures) {
      expect(pageText, `chart figure ${figure} is not in the report`).toContain(figure);
    }
  });

  test('the bars are hidden from assistive technology', async ({ page }) => {
    // The bars say nothing a screen reader can use, and the table beside them
    // says it properly; two readings of the same rows would be read twice.
    await page.goto(CHARTED);

    const chart = page.locator('figure[data-chart="magnitude"]').first();
    await expect(chart).toBeAttached();
    await expect(chart.locator('ul[aria-hidden="true"]')).toHaveCount(1);
  });

  test('the chart table prints, so a printed report carries figures', async ({
    page,
  }) => {
    await page.goto(CHARTED);

    const chart = page.locator('figure[data-chart="magnitude"]').first();
    await expect(chart).toBeAttached();

    // On screen the table is visually hidden; in print it *is* the chart, so a
    // printed report carries the figures rather than a row of bars with no
    // axis.
    await page.emulateMedia({ media: 'print' });
    await expect(chart.locator('table')).toBeVisible();
    await page.emulateMedia({ media: 'screen' });
  });

  test('is drawn only when there is more than one day to compare', async ({ page }) => {
    // One bar is not a comparison. The default period is a single day and the
    // view renders no chart for it — which is why the tests above ask for a
    // month rather than skipping themselves when they find nothing.
    await page.goto('/reports/collections?period=today');
    await expect(page.locator('figure[data-chart="magnitude"]')).toHaveCount(0);
  });
});

test.describe('a filter cannot be used to read somebody else’s data', () => {
  test('a crafted range is refused, and the page says so', async ({ page }) => {
    // Three ways to hand-write a range that must not be honoured: a date that
    // is not a date, a range that runs backwards, and one longer than the
    // reporting limit. Each falls back to a coherent period *and says so* —
    // silently substituting a different range would hand somebody figures for
    // a period they did not ask for.
    for (const query of [
      'period=custom&from=not-a-date&to=2026-10-01',
      'period=custom&from=2026-10-10&to=2026-10-01',
      'period=custom&from=1990-01-01&to=2026-10-01',
    ]) {
      await page.goto(`/reports/collections?${query}`);
      await expectNoErrorBoundary(page);
      await expect(page.getByText(/could not be used/i).first(), query).toBeVisible();
    }
  });

  test('from and to are ignored unless the period is custom', async ({ page }) => {
    // The period selector decides, and the page labels the period it actually
    // used — so an incomplete request reads honestly rather than quietly
    // becoming a custom range.
    await page.goto('/reports/collections?from=1990-01-01&to=2026-10-01');
    await expectNoErrorBoundary(page);

    const body = (await page.locator('main').textContent()) ?? '';
    expect(body, 'a range nobody asked for was applied').not.toContain('1990');
  });
});

test.describe('what a secretary/treasurer may read', () => {
  test.use({ storageState: stateFile('secretary') });

  test('the hub offers only the reports they hold', async ({ page }) => {
    await page.goto('/reports');
    await expectNoErrorBoundary(page);

    // Operational reports, yes. The page must render rather than refuse,
    // because every staff role holds `reports:view_operational`.
    await expect(page.getByRole('heading', { name: /Reports/ }).first()).toBeVisible();
  });
});
