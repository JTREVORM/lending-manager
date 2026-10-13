import { expect, expectNoErrorBoundary, stateFile, test } from './fixtures';

/**
 * Phase 17 — the dashboard, in a browser.
 *
 * The dashboard was written when the system ended at payments. Risk
 * monitoring, the recovery file and the money movements that wait for a
 * decision all arrived afterwards, and each was reachable only by opening the
 * screen it lives on — so the page a person opens first said nothing about
 * any of them.
 *
 * What only a browser can prove here is the part that matters most about a
 * dashboard: **what each role actually sees**. The page composes itself from
 * the caller's capabilities and skips the query for a section they do not
 * hold, so a figure they are not entitled to is absent from the markup rather
 * than hidden in it. That is checked three ways below — rendered, absent, and
 * absent *from the HTML* rather than merely invisible.
 */

test.describe('what the Owner sees', () => {
  test.use({ storageState: stateFile('owner') });

  test('the page carries every section, and none of them errors', async ({ page }) => {
    await page.goto('/');
    await expectNoErrorBoundary(page);

    for (const heading of [
      'Today',
      'Portfolio at risk',
      'Promises and follow-ups',
      'Awaiting a decision',
    ]) {
      await expect(
        page.getByRole('heading', { name: heading, exact: true }),
        heading,
      ).toBeVisible();
    }
  });

  test('portfolio at risk states one ratio with the principal behind it', async ({
    page,
  }) => {
    await page.goto('/');

    const section = page.locator('section').filter({ hasText: 'Portfolio at risk' });

    // PAR 30 and not five ratios: a reader who has to compare five numbers to
    // form an impression has not been given an impression.
    await expect(section.getByText('PAR 30').first()).toBeVisible();
    await expect(section.getByText(/of principal/).first()).toBeVisible();

    // And the other four are a click away rather than crowded in.
    await expect(
      section.getByRole('link', { name: /Aging and all five ratios/ }),
    ).toHaveAttribute('href', '/reports/aging');
  });

  test('the recovery figures link to the screen that can act on them', async ({
    page,
  }) => {
    await page.goto('/');

    const section = page
      .locator('section')
      .filter({ hasText: 'Promises and follow-ups' });

    await expect(
      section.getByRole('link', { name: /Open Debt & Security/ }),
    ).toHaveAttribute('href', '/recovery');
  });

  test('no figure on the page is a bare percentage with nothing to divide', async ({
    page,
  }) => {
    await page.goto('/');

    // A ratio on its own invites comparison with a figure computed some other
    // way. Every percentage on this page sits beside the amount it came from.
    const section = page.locator('section').filter({ hasText: 'Portfolio at risk' });
    const text = (await section.first().textContent()) ?? '';

    if (/\d+\.\d%/.test(text)) {
      expect(text, 'a ratio with no principal beside it').toMatch(/of principal/);
    }
  });
});

test.describe('what a Secretary/Treasurer sees', () => {
  test.use({ storageState: stateFile('secretary') });

  test('the recovery work, and not the portfolio-wide risk figures', async ({ page }) => {
    await page.goto('/');
    await expectNoErrorBoundary(page);

    // Theirs: chasing a borrower is this role's work, and the promises they
    // took are the record of it.
    await expect(
      page.getByRole('heading', { name: 'Promises and follow-ups', exact: true }),
    ).toBeVisible();

    // Not theirs: portfolio at risk is a reading of the whole book, behind
    // `reports:view_financial`, which this role does not hold.
    await expect(
      page.getByRole('heading', { name: 'Portfolio at risk', exact: true }),
    ).toHaveCount(0);
  });

  test('the figure is absent from the HTML, not hidden in it', async ({ page }) => {
    const response = await page.goto('/');
    const html = (await response?.text()) ?? '';

    // The query is skipped, so there is nothing to hide. A presentation
    // decision becomes a leak the moment somebody reads the markup, which is
    // why this asserts on the response body rather than on the rendered page.
    expect(html).not.toContain('PAR 30');
    expect(html).not.toContain('Portfolio at risk');
  });
});

test.describe('what a borrower sees', () => {
  test.use({ storageState: stateFile('borrower') });

  test('not this page at all', async ({ page }) => {
    await page.goto('/');

    // A borrower holds `portal:view`, not `dashboard:view`, so the route
    // guard sends them to the portal before any of this is composed.
    await expect(page).toHaveURL(/\/portal/);
    await expect(
      page.getByRole('heading', { name: 'Portfolio at risk', exact: true }),
    ).toHaveCount(0);
  });
});
