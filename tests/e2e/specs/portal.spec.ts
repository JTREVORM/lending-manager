import { expect, expectNoErrorBoundary, stateFile, test } from './fixtures';

/**
 * The borrower's portal.
 *
 * A borrower reads their own record and nothing else. That is enforced by Row
 * Level Security rather than by the shell, so the assertions worth making in a
 * browser are about the shell: that the page is usable on a phone, that it
 * says who the lender is, that it shows the borrower their own figures, and
 * that it offers no staff control.
 */

test.use({ storageState: stateFile('borrower') });

test.describe('the portal', () => {
  test('opens on the borrower’s own page', async ({ page }) => {
    await page.goto('/portal');
    await expectNoErrorBoundary(page);

    // Their own name and their own money.
    expect(await page.locator('[data-money]').count()).toBeGreaterThan(0);
  });

  test('carries the lender’s identity, not a generic shell', async ({ page }) => {
    // §37 of the review: a borrower looking at a balance needs to know whose
    // balance it is. The company name comes from `company_identity`, a view
    // whose only columns are the ones a borrower may read.
    await page.goto('/portal');
    await expect(page.getByText(/Kyanja Credit Services/i).first()).toBeVisible();
  });

  test('offers no staff control at all', async ({ page }) => {
    await page.goto('/portal');

    for (const label of [
      /record a payment/i,
      /approve/i,
      /disburse/i,
      /release the money/i,
      /reverse/i,
      /register client/i,
    ]) {
      await expect(page.getByRole('button', { name: label })).toHaveCount(0);
      await expect(page.getByRole('link', { name: label })).toHaveCount(0);
    }
  });

  test('every figure goes through the shared money primitive', async ({ page }) => {
    // §9. One way for money to reach a screen, including this one — the
    // portal was the screen the review found rendering a bare number.
    await page.goto('/portal');

    const bareFigures = await page.evaluate(() => {
      const moneyNodes = new Set(Array.from(document.querySelectorAll('[data-money]')));
      const suspects: string[] = [];

      const walk = (node: Node) => {
        if (node.nodeType === Node.TEXT_NODE) {
          const text = node.textContent ?? '';
          // A grouped figure of four digits or more that is not inside a
          // `Money` element and is not a year.
          if (/\d{1,3}(,\d{3})+/.test(text)) {
            let parent = node.parentElement;
            while (parent !== null) {
              if (moneyNodes.has(parent)) return;
              parent = parent.parentElement;
            }
            suspects.push(text.trim().slice(0, 60));
          }
          return;
        }
        for (const child of Array.from(node.childNodes)) walk(child);
      };

      const main = document.querySelector('main');
      if (main !== null) walk(main);
      return suspects;
    });

    expect(bareFigures).toEqual([]);
  });

  test('reads on a phone without scrolling sideways', async ({ page }) => {
    for (const path of ['/portal', '/account']) {
      await page.goto(path);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow, `${path} scrolls sideways`).toBeLessThanOrEqual(1);
    }
  });

  test('does not fill the whole width of a laptop with one column', async ({
    page,
    viewport,
  }) => {
    // §36 of the review: the portal was a phone layout stretched across
    // 1440px. A measured line length is the fix; this asserts the content is
    // bounded rather than edge to edge.
    test.skip((viewport?.width ?? 0) < 1000, 'wide viewports only');

    await page.goto('/portal');

    const contentWidth = await page
      .locator('main > *')
      .first()
      .evaluate((element) => element.getBoundingClientRect().width);

    expect(contentWidth).toBeLessThan(viewport!.width - 40);
  });

  test('the statement prints as a statement', async ({ page }) => {
    await page.goto('/portal');
    await page.emulateMedia({ media: 'print' });

    const navs = page.locator('nav');
    for (let index = 0; index < (await navs.count()); index += 1) {
      await expect(navs.nth(index)).toBeHidden();
    }

    await page.emulateMedia({ media: 'screen' });
  });
});
