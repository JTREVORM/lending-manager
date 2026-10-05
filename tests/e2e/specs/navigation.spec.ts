import { expect, stateFile, test } from './fixtures';

/**
 * Navigation, at the two widths it has to work at.
 *
 * §5 exists because the phone bar was never looked at: ten destinations
 * across 390px produced labels reading `H…`, `Cli…`, `B…` — seven of ten
 * unreadable. The fix is four destinations and a More sheet, and these are
 * the assertions that stop it regressing: the bar holds five controls, every
 * label is fully rendered rather than clipped, and everything that left the
 * bar is still reachable.
 */

test.use({ storageState: stateFile('owner') });

test.describe('the phone bottom bar', () => {
  test.skip(({ viewport }) => (viewport?.width ?? 0) > 500, 'narrow viewports only');

  test('holds four destinations and a More button', async ({ page }) => {
    await page.goto('/');

    const bar = page.locator('nav[data-nav="bottom-bar"]');
    await expect(bar).toBeVisible();

    // Four links plus More. Not ten. Counted among the bar's own children:
    // the More sheet lives inside this element too, so all eleven
    // destinations are in its subtree and only four are under a thumb.
    await expect(bar.locator(':scope > a')).toHaveCount(4);
    await expect(bar.getByRole('button', { name: /^more$/i })).toBeVisible();
  });

  test('no label is clipped', async ({ page }) => {
    await page.goto('/');

    const bar = page.locator('nav[data-nav="bottom-bar"]');
    const labels = bar.locator(':scope > a span, :scope > button span');
    const count = await labels.count();
    expect(count).toBeGreaterThan(0);

    for (let index = 0; index < count; index += 1) {
      const label = labels.nth(index);
      if (!(await label.isVisible())) continue;

      const clipped = await label.evaluate(
        (element) => element.scrollWidth > element.clientWidth + 1,
      );
      const text = (await label.textContent())?.trim() ?? '';
      if (text === '') continue;

      expect(clipped, `"${text}" is clipped in the bottom bar`).toBe(false);
      // And an ellipsis in the label itself is the same failure written down.
      expect(text, 'label was truncated to an ellipsis').not.toMatch(/…$/);
    }
  });

  test('every destination that left the bar is behind More', async ({ page }) => {
    await page.goto('/');

    await page.getByRole('button', { name: /^more$/i }).click();

    const sheet = page.getByRole('dialog');
    await expect(sheet).toBeVisible();

    // The Owner's full menu. Reports, Users, Settings and the audit trail are
    // the ones the four-slot bar cannot hold.
    for (const label of ['Reports', 'Users', 'Settings', 'Audit trail', 'Guarantors']) {
      await expect(
        sheet.getByRole('link', { name: new RegExp(label, 'i') }),
      ).toBeVisible();
    }

    // Signing out belongs here too, on a phone.
    await expect(sheet.getByRole('button', { name: /sign out/i })).toBeVisible();
  });

  test('the sheet closes without navigating', async ({ page }) => {
    await page.goto('/clients');
    await page.getByRole('button', { name: /^more$/i }).click();
    await expect(page.getByRole('dialog')).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toBeHidden();
    await expect(page).toHaveURL(/\/clients/);
  });

  test('content is not hidden behind the bar', async ({ page }) => {
    // A fixed bar over the last row of a table is how a cashier misses the
    // bottom entry of a list.
    await page.goto('/clients');

    const bar = page.locator('nav[data-nav="bottom-bar"]');
    const barBox = await bar.boundingBox();
    expect(barBox).not.toBeNull();

    const padding = await page.locator('main').evaluate((element) => {
      const style = getComputedStyle(element);
      return Number.parseFloat(style.paddingBottom) || 0;
    });

    expect(padding, 'main leaves room for the fixed bar').toBeGreaterThan(40);
  });

  test('there is no horizontal page scroll, on any screen', async ({ page }) => {
    // Every staff screen, because the one that was sideways was the one
    // nobody thought to check: `/overdue`, by 227px, from a `<table>` wearing
    // `sr-only` — which cannot clip, because `overflow` does nothing to
    // `display: table`.
    for (const path of [
      '/',
      '/clients',
      '/clients/new',
      '/guarantors',
      '/loans',
      '/loans/new',
      '/payments',
      '/payments/new',
      '/overdue',
      '/reports',
      '/reports/collections',
      '/reports/arrears',
      '/reports/loans',
      '/reports/clients',
      '/reports/penalties',
      '/reports/grace',
      '/users',
      '/users/new',
      '/audit',
      '/settings',
      '/account',
      '/account/password',
    ]) {
      await page.goto(path);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      // One pixel of rounding is not a layout failure; a sideways page is.
      expect(
        overflow,
        `${path} scrolls sideways by ${String(overflow)}px`,
      ).toBeLessThanOrEqual(1);
    }
  });
});

test.describe('the desktop sidebar', () => {
  test.skip(({ viewport }) => (viewport?.width ?? 0) <= 500, 'wide viewports only');

  test('groups the destinations rather than listing eleven', async ({ page }) => {
    await page.goto('/');

    for (const group of ['Operations', 'Insights', 'Administration']) {
      await expect(page.getByText(group, { exact: true }).first()).toBeVisible();
    }
  });

  test('marks the current page for a screen reader, not only in colour', async ({
    page,
  }) => {
    await page.goto('/clients');

    // The bottom bar is `md:hidden` rather than unmounted, so its copy of
    // the link is in the DOM at this width but `display: none` — and an
    // element that is not displayed is not in the accessibility tree. The
    // claim worth asserting is therefore about what a reader can reach.
    const current = page.locator('nav a[aria-current="page"]:visible');
    await expect(current).toHaveCount(1);
    await expect(current).toHaveAttribute('href', '/clients');
  });

  test('shows no More button, because there is room', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('button', { name: /^more$/i })).toHaveCount(0);
  });
});

test.describe('keyboard reach', () => {
  test.skip(({ viewport }) => (viewport?.width ?? 0) <= 500, 'wide viewports only');

  test('the first tab stop skips to the content', async ({ page }) => {
    await page.goto('/');
    await page.keyboard.press('Tab');

    const focused = page.locator(':focus');
    await expect(focused).toContainText(/skip to (main )?content/i);

    await focused.press('Enter');
    await expect(page.locator('main')).toBeVisible();
  });
});
