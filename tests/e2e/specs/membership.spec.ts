import {
  expect,
  expectNoErrorBoundary,
  stateFile,
  test,
  watchForBrowserErrors,
} from './fixtures';

/**
 * The membership screens, in a browser, against the production build.
 *
 * ## What only a browser can say about these
 *
 * Three things, and all three are the kind that pass every unit test:
 *
 *   1. The screens render at all. The Phase 8 review found every
 *      authenticated page showing an error boundary while returning 200 with
 *      a heading — "Something went wrong" is a heading. So each page here is
 *      asserted three ways: status, no boundary, and its own content.
 *
 *   2. The register survives a phone. The membership register is a
 *      seven-column table, and a table at 390px either scrolls the page
 *      sideways or crushes a member's name. Both are asserted directly, by
 *      measuring the document.
 *
 *   3. Nobody who should not reach it, does. The sidebar hides the module
 *      from a borrower, but hiding is not protection — so the borrower is
 *      pointed straight at the URL.
 *
 * ## The empty state is the point of this phase
 *
 * No member has been enrolled, because enrolment is Polytos Phase 2. So the
 * register is empty, and these tests assert that it says so honestly and
 * offers no control for a workflow that does not exist. A screen that invited
 * a clerk to collect savings today would be the single worst defect this
 * phase could ship, and it is cheaper to assert its absence than to discover
 * it.
 */

interface Screen {
  readonly name: string;
  readonly path: string;
  /** Text that only this page's own content produces. */
  readonly proves: RegExp;
}

const MEMBERSHIP_SCREENS: readonly Screen[] = [
  { name: 'membership register', path: '/membership', proves: /Membership/ },
  {
    name: 'membership register, filtered to active',
    path: '/membership?status=active',
    proves: /Membership/,
  },
  {
    name: 'membership policy',
    path: '/membership/policies',
    proves: /Membership policy/,
  },
];

// ===========================================================================
test.describe('the membership screens render', () => {
  test.use({ storageState: stateFile('owner') });

  for (const screen of MEMBERSHIP_SCREENS) {
    test(screen.name, async ({ page }) => {
      const watcher = watchForBrowserErrors(page);

      const response = await page.goto(screen.path);
      expect(response?.status(), `${screen.path} status`).toBe(200);

      await expectNoErrorBoundary(page);

      await expect(
        page.locator('main').getByText(screen.proves).filter({ visible: true }).first(),
      ).toBeVisible();

      expect(watcher.errors, `${screen.path} console`).toEqual([]);
    });
  }
});

// ===========================================================================
test.describe('the empty register is honest', () => {
  test.use({ storageState: stateFile('owner') });

  test('says no member has been enrolled, and why', async ({ page }) => {
    await page.goto('/membership');

    await expect(page.getByText('No members have been enrolled yet')).toBeVisible();

    // The banner that explains it, read from the policy row rather than
    // hard-coded — so it disappears the day the policy is approved.
    await expect(page.getByRole('alert').first()).toContainText(
      /Enrolment is not open yet/i,
    );
  });

  test('offers no control for a workflow that does not exist', async ({ page }) => {
    await page.goto('/membership');

    for (const name of [
      /enrol member/i,
      /register member/i,
      /collect savings/i,
      /withdraw savings/i,
      /pay benefit/i,
    ]) {
      await expect(page.getByRole('button', { name }), String(name)).toHaveCount(0);
      await expect(page.getByRole('link', { name }), String(name)).toHaveCount(0);
    }
  });

  test('renders no money figure at all on an empty register', async ({ page }) => {
    await page.goto('/membership');

    // `Money` marks every rendered sum with `data-money`. An empty programme
    // has no savings balance, and a `UGX 0` here would be a statement about
    // the software rather than about the members.
    await expect(page.locator('[data-money]')).toHaveCount(0);
  });
});

// ===========================================================================
test.describe('the membership policy screen', () => {
  test.use({ storageState: stateFile('owner') });

  test('shows the confirmed figures the client’s documents state', async ({ page }) => {
    await page.goto('/membership/policies');

    const main = page.locator('main');

    await expect(main.getByText('UGX 5,000').first()).toBeVisible();
    await expect(main.getByText('UGX 50,000').first()).toBeVisible();
    await expect(main.getByText('UGX 100,000').first()).toBeVisible();
    await expect(main.getByText('UGX 200,000').first()).toBeVisible();
  });

  test('marks every undecided rule as not decided, and counts them', async ({ page }) => {
    await page.goto('/membership/policies');

    // Nine outstanding decisions, each said in words rather than left blank.
    await expect(page.getByText('Not decided')).toHaveCount(9);

    await expect(
      page.getByText(/9 of the programme's rules have not been settled/i),
    ).toBeVisible();
  });

  test('keeps every rendered amount whole, with its currency on the same line', async ({
    page,
  }) => {
    await page.goto('/membership/policies');

    // The Phase 9 defect, which appeared on every row of the payments
    // register: `UGX` on one line and the figure on the next. `Money` sets
    // `whitespace-nowrap`, and this asks the browser whether it held.
    const amounts = page.locator('[data-money]');
    const count = await amounts.count();
    expect(count).toBeGreaterThan(0);

    for (let index = 0; index < count; index += 1) {
      const lines = await amounts.nth(index).evaluate((element) => {
        const text = element.textContent ?? '';
        const boxes = element.getClientRects().length;
        return { text, boxes };
      });

      // One client rect means one line.
      expect(
        lines.boxes,
        `"${lines.text}" wrapped across ${String(lines.boxes)} lines`,
      ).toBe(1);
    }
  });

  test('offers no control that would publish or approve a version', async ({ page }) => {
    await page.goto('/membership/policies');

    for (const name of [/approve/i, /publish/i, /^edit$/i, /save/i]) {
      await expect(page.getByRole('button', { name }), String(name)).toHaveCount(0);
    }
  });
});

// ===========================================================================
test.describe('who may reach membership', () => {
  test('is open to the Secretary/Treasurer, who will take the savings', async ({
    browser,
  }) => {
    const context = await browser.newContext({ storageState: stateFile('secretary') });
    const page = await context.newPage();

    try {
      const response = await page.goto('/membership');
      expect(response?.status()).toBe(200);
      await expectNoErrorBoundary(page);
      await expect(
        page
          .locator('main')
          .getByText(/Membership/)
          .first(),
      ).toBeVisible();
    } finally {
      await context.close();
    }
  });

  test('is closed to a borrower pointed straight at the URL', async ({ browser }) => {
    const context = await browser.newContext({ storageState: stateFile('borrower') });
    const page = await context.newPage();

    try {
      await page.goto('/membership');

      // The route guard sends a borrower to the place they belong rather
      // than showing a dead end. What must not happen is the register
      // rendering.
      await expect(page).toHaveURL(/\/portal/);
      await expect(page.getByText('No members have been enrolled yet')).toHaveCount(0);
    } finally {
      await context.close();
    }
  });

  test('is closed to an anonymous visitor', async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();

    try {
      await page.goto('/membership');
      await expect(page).toHaveURL(/\/login/);
    } finally {
      await context.close();
    }
  });
});

// ===========================================================================
test.describe('membership is reachable from the client record', () => {
  test.use({ storageState: stateFile('owner') });

  test('says a client who is not a member is not a problem', async ({ page }) => {
    const { fixtures } = await import('./fixtures');

    await page.goto(`/clients/${fixtures.clients.current}`);
    await expectNoErrorBoundary(page);

    await expect(
      page.getByText(/not a member of the savings and benefits programme/i),
    ).toBeVisible();
  });

  test('leaves the client register working exactly as before', async ({ page }) => {
    const response = await page.goto('/clients');
    expect(response?.status()).toBe(200);
    await expectNoErrorBoundary(page);

    // The register still lists clients, which is the assertion that matters:
    // the membership section was added to the client *detail* page and must
    // not have touched the directory.
    //
    // Asserted on a client number rather than on the `<table>`: below `md`
    // the directory renders cards instead, because ten columns of a register
    // cannot be read on a 390px screen and a horizontally scrolling one is
    // worse. Both renderings carry the same data, so the assertion is about
    // the data. The first draft asked for the table and failed on the mobile
    // project — correctly, and against the test rather than the application.
    //
    // `filter({ visible: true })` is not optional, and it is the same lesson
    // `app-shell.spec.ts` records: both renderings are in the DOM at every
    // width and the wrong one is `display: none`, so an unscoped `.first()`
    // finds the hidden card and reports the register as invisible. That is
    // what the second draft did.
    await expect(
      page
        .locator('main')
        .getByText(/^CL\d+/)
        .filter({ visible: true })
        .first(),
    ).toBeVisible();
    await expect(page.getByText('No clients registered yet')).toHaveCount(0);
  });
});

// ===========================================================================
test.describe('the membership screens at every width', () => {
  test.use({ storageState: stateFile('owner') });

  const VIEWPORTS = [
    { name: 'desktop', width: 1440, height: 900 },
    { name: 'laptop', width: 1366, height: 768 },
    { name: 'tablet', width: 820, height: 1180 },
    { name: 'mobile', width: 390, height: 844 },
  ] as const;

  for (const viewport of VIEWPORTS) {
    for (const path of ['/membership', '/membership/policies']) {
      test(`${path} does not scroll the page sideways at ${viewport.name}`, async ({
        page,
      }) => {
        await page.setViewportSize({ width: viewport.width, height: viewport.height });
        await page.goto(path);
        await expectNoErrorBoundary(page);

        // A page-wide horizontal scrollbar is the failure mode a grid item's
        // default `min-width: auto` produces, and it is invisible to every
        // other kind of test. A table may scroll; the document may not.
        const overflow = await page.evaluate(
          () =>
            document.documentElement.scrollWidth - document.documentElement.clientWidth,
        );

        // One pixel of slack for sub-pixel rounding at fractional device
        // ratios; anything more is a real overflow.
        expect(overflow, `${path} at ${viewport.name}`).toBeLessThanOrEqual(1);
      });
    }
  }

  test('keeps the membership rail entry reachable on a phone', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/');

    const menu = page.getByRole('button', { name: /main menu/i });
    await expect(menu).toBeVisible();
    await menu.click();

    const nav = page.getByRole('navigation', { name: 'Main navigation' });
    await expect(nav).toBeVisible();

    const header = nav.getByRole('button', { name: 'Membership' });
    await expect(header).toBeVisible();
    await header.click();

    const link = nav.getByRole('link', { name: 'Membership Register' });
    await expect(link).toBeVisible();

    // A control that is visible and not clickable is the defect; following
    // it is the assertion.
    await link.click();
    await expect(page).toHaveURL(/\/membership/);
  });

  test('breaks no word on the register or the policy screen', async ({ page }) => {
    for (const path of ['/membership', '/membership/policies']) {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(path);

      // `break-all` and `hyphens: auto` are what split a word mid-letter.
      // Neither belongs on a label, a member's name or a figure.
      const offenders = await page.evaluate(() => {
        const bad: string[] = [];
        for (const element of document.querySelectorAll('main *')) {
          const style = getComputedStyle(element);
          const text = (element.textContent ?? '').trim().slice(0, 40);
          if (text === '') continue;
          if (style.wordBreak === 'break-all' || style.hyphens === 'auto') {
            bad.push(text);
          }
        }
        return bad;
      });

      expect(offenders, path).toEqual([]);
    }
  });
});
