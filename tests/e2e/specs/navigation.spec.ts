import { expect, stateFile, test } from './fixtures';

/**
 * Navigation, at the two widths it has to work at.
 *
 * The staff shell has one menu: the rail. From `md` up it is fixed down the
 * left of every page; below `md` the same rail is a drawer behind the
 * header's menu button. There is no bottom tab bar — there was, and it is
 * gone.
 *
 * The rail is now eight collapsible modules — Clients, Loan Management,
 * Collections, Debt & Security, Finance, Reports, Branch Network,
 * Administration — with the dashboard pinned above them and Notifications
 * pinned below. Every module starts closed, one is open at a time, and the
 * module holding the open page opens by itself. These are the assertions that
 * stop any of that regressing, plus the ones that stop the bottom bar coming
 * back and the drawer breaking.
 */

test.use({ storageState: stateFile('owner') });

/** The modules an Owner sees, in rail order. */
const MODULES = [
  'Clients',
  'Loan Management',
  'Collections',
  'Debt & Security',
  'Finance',
  'Reports',
  'Branch Network',
  'Administration',
] as const;

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

  test('the menu button opens the rail, with every module closed', async ({ page }) => {
    await page.goto('/');

    const rail = page.getByRole('navigation', { name: 'Main navigation' });
    // Closed, the rail is `invisible` rather than merely translated away, so
    // it is out of the accessibility tree and out of the tab order too.
    await expect(rail).toBeHidden();

    await page.getByRole('button', { name: /main menu/i }).click();
    await expect(rail).toBeVisible();

    await expect(rail.getByRole('link', { name: 'Dashboard' })).toBeVisible();
    await expect(rail.getByRole('link', { name: 'Notifications' })).toBeVisible();

    for (const block of MODULES) {
      const header = rail.getByRole('button', { name: block });
      await expect(header, block).toBeVisible();
      await expect(header, block).toHaveAttribute('aria-expanded', 'false');
    }
  });

  test('a module opens inside the drawer, with touch-sized rows', async ({ page }) => {
    await page.goto('/');
    const rail = page.getByRole('navigation', { name: 'Main navigation' });

    await page.getByRole('button', { name: /main menu/i }).click();

    const header = rail.getByRole('button', { name: 'Finance' });
    await header.click();
    await expect(header).toHaveAttribute('aria-expanded', 'true');

    const entry = rail.getByRole('link', { name: 'General Ledger', exact: true });
    await expect(entry).toBeVisible();

    // A thumb is the pointer at this width. 40px is the floor a 14px row
    // with `py-2.5` reaches; the header is taller again.
    for (const target of [header, entry]) {
      const box = await target.boundingBox();
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(40);
    }
  });

  test('opening one module closes the last', async ({ page }) => {
    await page.goto('/');
    const rail = page.getByRole('navigation', { name: 'Main navigation' });
    await page.getByRole('button', { name: /main menu/i }).click();

    await rail.getByRole('button', { name: 'Clients' }).click();
    await expect(rail.getByRole('link', { name: 'Client Register' })).toBeVisible();

    await rail.getByRole('button', { name: 'Finance' }).click();
    await expect(rail.getByRole('button', { name: 'Clients' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    await expect(rail.getByRole('link', { name: 'Client Register' })).toBeHidden();
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
    await rail.getByRole('button', { name: 'Collections' }).click();
    await rail.getByRole('link', { name: 'Payment History', exact: true }).click();

    await expect(page).toHaveURL(/\/payments/);
    // Leaving the menu sitting over the page you just asked for is the
    // failure this guards.
    await expect(rail).toBeHidden();
  });

  test('no destination label is clipped in the rail', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: /main menu/i }).click();

    const rail = page.getByRole('navigation', { name: 'Main navigation' });
    // The count below is a plain number, so `expect` cannot retry it. Closed,
    // the drawer is `invisible`, so every span inside it is invisible too and
    // a count taken mid-transition is legitimately zero. Wait for the rail
    // before measuring anything in it.
    await expect(rail).toBeVisible();

    const menu = page.locator('nav[aria-label="Main navigation"] .scroll-area');

    for (const block of MODULES) {
      await rail.getByRole('button', { name: block }).click();

      // The menu band only. The brand block clamps a long company name to two
      // lines and the footer truncates a long person's name on purpose, and
      // neither is a destination label.
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
        expect(clipped, `"${text}" is clipped in ${block}`).toBe(false);
        expect(text, 'label was truncated to an ellipsis').not.toMatch(/…$/);
      }
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
      '/clients?status=suspended',
      '/clients/new',
      '/guarantors',
      '/guarantors/register',
      '/loans',
      '/loans?stage=draft',
      '/loans?stage=awaiting_disbursement',
      '/loans/by-product',
      '/loans/new',
      '/payments',
      '/payments?status=reversed',
      '/payments/new',
      '/payments/summary',
      '/payments/summary?section=branch',
      '/overdue',
      '/notifications',
      '/recovery',
      '/recovery?view=risk',
      '/recovery?view=follow-ups',
      '/recovery?view=promises',
      '/recovery?view=security',
      '/reports',
      '/reports?group=behind',
      '/reports/collections',
      '/reports/arrears',
      '/reports/loans',
      '/reports/clients',
      '/reports/penalties',
      '/reports/grace',
      '/reports/aging',
      '/reports/recovery',
      '/reports/guarantors',
      '/reports/collateral',
      '/users',
      '/users/new',
      '/audit',
      '/audit?entity=client',
      '/settings',
      '/settings?section=finance',
      '/settings?section=branches',
      '/settings/products',
      '/finance',
      '/finance?section=cash',
      '/finance/ledger',
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

test.describe('the desktop rail', () => {
  test.skip(({ viewport }) => (viewport?.width ?? 0) <= 500, 'wide viewports only');

  test('shows the business modules, not fifty destinations', async ({ page }) => {
    await page.goto('/');
    const rail = page.getByRole('navigation', { name: 'Main navigation' });

    for (const block of MODULES) {
      await expect(rail.getByRole('button', { name: block }), block).toBeVisible();
    }

    // Collapsed, so the two pinned rows are the only links in the band.
    const links = rail.locator('.scroll-area a');
    await expect(links).toHaveCount(2);
    await expect(links.first()).toHaveAttribute('href', '/');
    await expect(links.last()).toHaveAttribute('href', '/notifications');
  });

  test('every module starts closed', async ({ page }) => {
    await page.goto('/');
    const rail = page.getByRole('navigation', { name: 'Main navigation' });

    for (const block of MODULES) {
      await expect(rail.getByRole('button', { name: block }), block).toHaveAttribute(
        'aria-expanded',
        'false',
      );
    }
  });

  test('clicking a module header unfolds it', async ({ page }) => {
    await page.goto('/');
    const rail = page.getByRole('navigation', { name: 'Main navigation' });

    const header = rail.getByRole('button', { name: 'Debt & Security' });
    await header.click();

    await expect(header).toHaveAttribute('aria-expanded', 'true');
    // Guarantors belongs to Debt & Security, not to Clients: a guarantor is
    // security on a loan.
    await expect(
      rail.getByRole('link', { name: 'Guarantors', exact: true }),
    ).toBeVisible();
  });

  test('opening one module closes the previous one', async ({ page }) => {
    await page.goto('/');
    const rail = page.getByRole('navigation', { name: 'Main navigation' });

    await rail.getByRole('button', { name: 'Clients' }).click();
    await expect(rail.getByRole('link', { name: 'Client Register' })).toBeVisible();

    await rail.getByRole('button', { name: 'Finance' }).click();

    await expect(rail.getByRole('button', { name: 'Clients' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    await expect(rail.getByRole('link', { name: 'Client Register' })).toBeHidden();
    await expect(rail.getByRole('link', { name: 'Cash Position' })).toBeVisible();
  });

  test('the module holding the open page expands by itself', async ({ page }) => {
    const cases = [
      { path: '/finance/expenses', opens: 'Finance', entry: 'Expenses' },
      { path: '/clients?status=suspended', opens: 'Clients', entry: 'Suspended Clients' },
      {
        path: '/loans?stage=awaiting_disbursement',
        opens: 'Loan Management',
        entry: 'Awaiting Disbursement',
      },
      { path: '/loans/by-product', opens: 'Loan Management', entry: 'Loans by Product' },
      {
        path: '/payments/summary?section=staff',
        opens: 'Collections',
        entry: 'Collections by Staff',
      },
      {
        path: '/recovery?view=promises',
        opens: 'Debt & Security',
        entry: 'Promise to Pay',
      },
      { path: '/recovery?view=risk', opens: 'Debt & Security', entry: 'Risk Monitoring' },
      {
        path: '/guarantors/register',
        opens: 'Debt & Security',
        entry: 'Guarantors',
      },
      {
        path: '/reports/recovery',
        opens: 'Debt & Security',
        entry: 'Recovery Notes',
      },
      {
        path: '/reports?group=behind',
        opens: 'Reports',
        entry: 'Arrears & Risk Reports',
      },
      { path: '/reports/aging', opens: 'Branch Network', entry: 'Branch Portfolio' },
      {
        path: '/settings?section=branches',
        opens: 'Branch Network',
        entry: 'Branches',
      },
      {
        path: '/settings?section=finance',
        opens: 'Administration',
        entry: 'Finance Settings',
      },
    ] as const;

    for (const { path, opens, entry } of cases) {
      await page.goto(path);
      const rail = page.getByRole('navigation', { name: 'Main navigation' });

      await expect(rail.getByRole('button', { name: opens }), path).toHaveAttribute(
        'aria-expanded',
        'true',
      );
      await expect(
        rail.getByRole('link', { name: entry, exact: true }),
        path,
      ).toHaveAttribute('aria-current', 'page');

      // And only that module.
      for (const other of MODULES.filter((name) => name !== opens)) {
        await expect(
          rail.getByRole('button', { name: other }),
          `${path} also opened ${other}`,
        ).toHaveAttribute('aria-expanded', 'false');
      }
    }
  });

  test('Reports is a module of its own, not a line in another', async ({ page }) => {
    await page.goto('/');
    const rail = page.getByRole('navigation', { name: 'Main navigation' });

    // No "Insights" block any more — reporting is its own module.
    await expect(rail.getByText('Insights', { exact: true })).toHaveCount(0);

    await rail.getByRole('button', { name: 'Reports' }).click();
    for (const entry of [
      'Reports Centre',
      'Collections Reports',
      'Loan Reports',
      'Arrears & Risk Reports',
      'Client Reports',
    ]) {
      await expect(
        rail.getByRole('link', { name: entry, exact: true }),
        entry,
      ).toBeVisible();
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

  test('marks the filtered view, not the register it filters', async ({ page }) => {
    await page.goto('/loans?stage=draft');

    const current = page.locator('nav a[aria-current="page"]:visible');
    await expect(current).toHaveCount(1);
    await expect(current).toHaveAttribute('href', '/loans?stage=draft');
  });

  test('shows no More button and no bottom bar', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('button', { name: /^more$/i })).toHaveCount(0);
    await expect(page.locator('nav[data-nav="bottom-bar"]')).toHaveCount(0);
  });

  test('every destination the rail offers actually loads', async ({ page }) => {
    // The whole point of reusing existing routes and their filters rather
    // than inventing a page per label: there is nothing in the rail that
    // 404s, errors, or lands on an error boundary.
    const rail = page.getByRole('navigation', { name: 'Main navigation' });
    await page.goto('/');

    const hrefs: string[] = ['/'];
    for (const block of MODULES) {
      await rail.getByRole('button', { name: block }).click();
      hrefs.push(
        ...(await rail
          .locator('.scroll-area ul a')
          .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('href') ?? ''))),
      );
    }

    // No destination appears twice: two rows on one href would both claim to
    // be the open page.
    expect(new Set(hrefs).size, 'the rail offers one href twice').toBe(hrefs.length);

    for (const href of hrefs) {
      const response = await page.goto(href);
      expect(response?.status() ?? 0, `${href} did not load`).toBeLessThan(400);
      await expect(page.locator('main'), href).toBeVisible();
      await expect(
        page.getByText(/something went wrong/i),
        `${href} rendered an error boundary`,
      ).toHaveCount(0);
    }
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

  test('a module header is reachable and operable from the keyboard', async ({
    page,
  }) => {
    await page.goto('/');
    const rail = page.getByRole('navigation', { name: 'Main navigation' });
    const header = rail.getByRole('button', { name: 'Finance' });

    await header.focus();
    await page.keyboard.press('Enter');

    await expect(header).toHaveAttribute('aria-expanded', 'true');
    await expect(rail.getByRole('link', { name: 'Cash Position' })).toBeVisible();
  });
});
