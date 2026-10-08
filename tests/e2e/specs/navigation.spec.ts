import { expect, stateFile, test } from './fixtures';

/**
 * Navigation, at the two widths it has to work at.
 *
 * The staff shell has one menu: the rail. From `md` up it is fixed down the
 * left of every page; below `md` the same rail is a drawer behind the
 * header's menu button. There is no bottom tab bar — there was, and it is
 * gone: two navigations for one product meant a phone showed four of eleven
 * destinations under a thumb and the other seven behind a "More" sheet, while
 * reserving 96px of every page for the privilege. These are the assertions
 * that stop both halves of that regressing — that the bar stays gone and the
 * space it reserved with it, and that the drawer it was replaced by actually
 * opens, closes and navigates.
 */

test.use({ storageState: stateFile('owner') });

test.describe('the phone and tablet drawer', () => {
  test.skip(({ viewport }) => (viewport?.width ?? 0) > 500, 'narrow viewports only');

  test('there is no bottom navigation bar', async ({ page }) => {
    for (const path of ['/', '/clients', '/loans', '/payments', '/reports']) {
      await page.goto(path);
      await expect(page.locator('nav[data-nav="bottom-bar"]')).toHaveCount(0);
    }
  });

  test('nothing is reserved at the foot of the page for it', async ({ page }) => {
    // The bar was 96px of `padding-bottom` on `main` at every narrow width.
    // With the bar gone that padding is a strip of nothing under the last row
    // of every list, which is the half of the removal that is easy to forget.
    await page.goto('/clients');

    const padding = await page.locator('main').evaluate((element) => {
      const style = getComputedStyle(element);
      return Number.parseFloat(style.paddingBottom) || 0;
    });

    expect(padding, 'main still reserves room for a bar that is gone').toBeLessThan(48);
  });

  test('the menu button opens the rail, and it carries every destination', async ({
    page,
  }) => {
    await page.goto('/');

    const rail = page.getByRole('navigation', { name: 'Main navigation' });
    // Closed, the rail is `invisible` rather than merely translated away, so
    // it is out of the accessibility tree and out of the tab order too.
    await expect(rail).toBeHidden();

    await page.getByRole('button', { name: /main menu/i }).click();
    await expect(rail).toBeVisible();

    // The Owner's full menu, all of it, in one place — not four under a thumb
    // and seven behind a sheet.
    for (const label of [
      'Dashboard',
      'Clients',
      'Guarantors',
      'Loans',
      'Payments',
      'Overdue',
      'Reports',
      'Users',
      'Audit trail',
      'Settings',
      'My account',
    ]) {
      await expect(rail.getByRole('link', { name: label, exact: true })).toBeVisible();
    }
  });

  test('the overlay closes it', async ({ page }) => {
    await page.goto('/clients');
    const rail = page.getByRole('navigation', { name: 'Main navigation' });

    await page.getByRole('button', { name: /main menu/i }).click();
    await expect(rail).toBeVisible();

    // The scrim's own name. The control inside the drawer answers to
    // "Close menu", so this cannot click that one by accident.
    //
    // The position is not decoration. The scrim is `inset-0`, so it spans the
    // whole viewport and its centre sits *underneath* the 256px drawer, which
    // is above it in the stack — a default click aims at that centre and is
    // intercepted by the rail. What a person taps is the strip of overlay
    // beside the drawer, so that is what this taps.
    await page
      .getByRole('button', { name: 'Close navigation' })
      .click({ position: { x: 330, y: 400 } });
    await expect(rail).toBeHidden();
    await expect(page).toHaveURL(/\/clients/);
  });

  test('the close control inside the drawer closes it', async ({ page }) => {
    await page.goto('/clients');
    const rail = page.getByRole('navigation', { name: 'Main navigation' });

    await page.getByRole('button', { name: /main menu/i }).click();
    await expect(rail).toBeVisible();

    await rail.getByRole('button', { name: 'Close menu' }).click();
    await expect(rail).toBeHidden();
    await expect(page).toHaveURL(/\/clients/);
  });

  test('Escape closes it', async ({ page }) => {
    await page.goto('/clients');
    const rail = page.getByRole('navigation', { name: 'Main navigation' });

    await page.getByRole('button', { name: /main menu/i }).click();
    await expect(rail).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(rail).toBeHidden();
  });

  test('choosing a destination navigates and closes it', async ({ page }) => {
    await page.goto('/');
    const rail = page.getByRole('navigation', { name: 'Main navigation' });

    await page.getByRole('button', { name: /main menu/i }).click();
    await rail.getByRole('link', { name: 'Payments', exact: true }).click();

    await expect(page).toHaveURL(/\/payments/);
    // Leaving the menu sitting over the page you just asked for is the
    // failure this guards.
    await expect(rail).toBeHidden();
  });

  test('no destination label is clipped in the rail', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: /main menu/i }).click();

    // The menu band only. The brand block clamps a long company name to two
    // lines and the footer truncates a long person's name on purpose, and
    // neither is a destination label.
    const menu = page.locator('nav[aria-label="Main navigation"] .scroll-area');
    const labels = menu.locator('a span, button span').filter({ visible: true });
    const count = await labels.count();
    expect(count).toBeGreaterThan(0);

    for (let index = 0; index < count; index += 1) {
      const label = labels.nth(index);
      const text = (await label.textContent())?.trim() ?? '';
      if (text === '') continue;

      const clipped = await label.evaluate(
        (element) => element.scrollWidth > element.clientWidth + 1,
      );
      expect(clipped, `"${text}" is clipped in the rail`).toBe(false);
      expect(text, 'label was truncated to an ellipsis').not.toMatch(/…$/);
    }
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

    // One menu, so exactly one entry may claim to be the open page. `:visible`
    // rather than a plain count because a reader reaches what is displayed,
    // and an element that is not displayed is not in the accessibility tree.
    const current = page.locator('nav a[aria-current="page"]:visible');
    await expect(current).toHaveCount(1);
    await expect(current).toHaveAttribute('href', '/clients');
  });

  test('shows no More button and no bottom bar', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('button', { name: /^more$/i })).toHaveCount(0);
    await expect(page.locator('nav[data-nav="bottom-bar"]')).toHaveCount(0);
  });

  test('the rail opens its groups rather than showing three shut doors', async ({
    page,
  }) => {
    await page.goto('/');

    const rail = page.getByRole('navigation', { name: 'Main navigation' });
    for (const group of ['Operations', 'Insights', 'Administration']) {
      await expect(rail.getByRole('button', { name: group })).toHaveAttribute(
        'aria-expanded',
        'true',
      );
    }

    // And the space left between the last thing in the menu and the
    // signed-in person at the foot is a margin, not half the rail.
    const gap = await page.evaluate(() => {
      const nav = document.querySelector('nav[aria-label="Main navigation"]');
      if (nav === null) return null;
      const band = nav.querySelector('.scroll-area');
      const footer = nav.lastElementChild;
      if (band === null || footer === null) return null;
      const last = band.lastElementChild;
      if (last === null) return null;
      return footer.getBoundingClientRect().top - last.getBoundingClientRect().bottom;
    });

    expect(gap).not.toBeNull();
    expect(gap ?? 0, 'the rail is mostly empty navy again').toBeLessThan(320);
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
