import {
  expect,
  expectNoErrorBoundary,
  fixtures,
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
 * ## Phase 1's premise, and what replaced it
 *
 * These tests were written when no member could be enrolled, and they asserted
 * that the register said so honestly and offered no control for a workflow
 * that did not exist. That was the right assertion to make, and it is why
 * nothing here ever invited a clerk to collect savings before the module
 * existed.
 *
 * Polytos Phase 2 built enrolment and savings, so the premise is gone: the
 * register has members in it and the primary action is there. The assertions
 * below were rewritten to the new truth rather than deleted — a register with
 * members still has to say which members, and an action that appears has to
 * appear only to somebody who may use it.
 *
 * What is *still* asserted as absent: a control for a benefit claim, a
 * meeting or a profit share. All three wait on rules the client has not
 * decided, so a screen offering any of them would be the same lie this file
 * was written to prevent.
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
test.describe('the register is honest about what exists', () => {
  test.use({ storageState: stateFile('owner') });

  test('lists the members who have been enrolled', async ({ page }) => {
    await page.goto('/membership');

    // The Phase 1 version of this test asserted the opposite — that the
    // register said nobody had been enrolled — and it was right to, because
    // nobody could be. Enrolment exists now, so the honest assertion is that
    // the members are listed and the "nobody yet" sentence is gone.
    await expect(page.getByText('No members have been enrolled yet')).toHaveCount(0);

    await expect(
      page
        .getByText(fixtures.membershipNumbers.qualified)
        .filter({ visible: true })
        .first(),
    ).toBeVisible();
  });

  test('no longer says enrolment is closed, because it is open', async ({ page }) => {
    await page.goto('/membership');

    // The banner is read from the policy row rather than hard-coded, which is
    // what makes it disappear the day a version that opens enrolment is in
    // force. The harness publishes one, so it is gone — and that is the
    // behaviour, not an absence of the test.
    await expect(page.getByText(/Enrolment is not open yet/i)).toHaveCount(0);
  });

  test('offers enrolment to somebody who may enrol', async ({ page }) => {
    await page.goto('/membership');

    // The page's primary action, visible at every width — because that is how
    // somebody standing at a counter with a phone reaches enrolment.
    await expect(
      page.locator('main').getByRole('link', { name: /enrol a member/i }),
    ).toBeVisible();

    // The rail entry is **not** asserted here, and the reason is worth
    // recording so it is not added back. Below `md` the rail is a drawer, and
    // a drawer renders a module's links only once that module is expanded —
    // so there is nothing in the document to find without driving the menu,
    // and driving the menu is `navigation.spec.ts`'s job.
    //
    // The entry itself is pinned where it belongs:
    // `tests/integration/membership-ui.test.tsx` asserts it exists and
    // carries `requires: ['membership:create']`, against the navigation
    // definition rather than against a rendering of it. That the action is
    // gated rather than merely present is the Secretary block below.
  });

  test('offers no control for a workflow that still does not exist', async ({ page }) => {
    await page.goto('/membership');

    // The profit share still waits on a rule the client has not decided, and
    // nothing anywhere in the application may offer it. That is the lie Phase
    // 1 wrote this test to prevent, and it is asserted across the whole
    // document — the navigation included.
    for (const name of [/profit share/i]) {
      await expect(page.getByRole('button', { name }), String(name)).toHaveCount(0);
      await expect(page.getByRole('link', { name }), String(name)).toHaveCount(0);
    }

    // Benefits and meetings used to be on that list and are **not** any more,
    // because Phase 4 built them: the rail now carries a "Member Benefits"
    // module and a "Meetings" one, and an assertion that no control anywhere
    // mentions a meeting became an assertion that Phase 4 was never
    // delivered. CI caught it the first time the browser suite ran against
    // the new shell, which is the test doing its job in the other direction.
    //
    // What survives is the narrower claim this test was always about: the
    // **membership register** offers no benefit or meeting control of its
    // own. A claim is opened from the benefits section or from a member's
    // profile, where the policy gate and the member's own status are in view;
    // a register of members is neither of those places.
    const main = page.locator('main');
    for (const name of [/pay benefit/i, /record a claim/i, /mark the register/i]) {
      await expect(main.getByRole('button', { name }), String(name)).toHaveCount(0);
      await expect(main.getByRole('link', { name }), String(name)).toHaveCount(0);
    }
  });
});

// ===========================================================================
test.describe('a Secretary is not offered enrolment', () => {
  test.use({ storageState: stateFile('secretary') });

  test('reads the register, and is turned away from the enrolment screen', async ({
    page,
  }) => {
    await page.goto('/membership');
    await expectNoErrorBoundary(page);

    // `membership:create` is the Manager's and the Owner's. The rail and the
    // register both withhold the action, and the route refuses the URL —
    // which is the one that matters, because hiding is not protection.
    await expect(page.getByRole('link', { name: /enrol a member/i })).toHaveCount(0);

    await page.goto('/membership/enrol');
    expect(
      page.url(),
      'enrolment must not open to somebody who may not enrol',
    ).not.toContain('/membership/enrol');
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

    // The count comes from the manifest, which the seeder read back out of the
    // generated columns — so this asserts that the screen agrees with the
    // database rather than with a number typed into a test.
    //
    // Phase 1 asserted nine, because the only version was the seeded draft
    // with every question open. The harness now publishes a version that
    // answers the two savings rules, so the figure is smaller and the
    // assertion follows the data instead of being edited to match.
    const undecided = fixtures.policy.undecidedRules;
    expect(undecided, 'the harness policy leaves questions open').toBeGreaterThan(0);

    await expect(page.getByText('Not decided')).toHaveCount(undecided);

    await expect(
      page.getByText(
        new RegExp(
          `${String(undecided)} of the programme's rules have not been settled`,
          'i',
        ),
      ),
    ).toBeVisible();
  });

  test('answers the five activities separately, in a real browser', async ({ page }) => {
    await page.goto('/membership/policies');

    const readiness = page.getByRole('table', {
      name: /whether this version opens them/i,
    });
    await expect(readiness).toBeVisible();

    // Phase 1 asserted five Closed and no Open, because the only version was
    // an unapproved draft. The harness now publishes a version that opens
    // enrolment and savings and leaves lending, benefits and profit sharing
    // shut — which is the activity-specific gate doing exactly what it is
    // for, and the figures come from the generated columns via the manifest.
    await expect(readiness.getByText('Closed')).toHaveCount(
      fixtures.policy.activitiesClosed,
    );
    await expect(readiness.getByText('Open', { exact: true })).toHaveCount(
      fixtures.policy.activitiesOpen,
    );

    expect(
      fixtures.policy.activitiesOpen,
      'enrolment and savings are open, so the gate is not all-or-nothing',
    ).toBeGreaterThan(0);
    expect(
      fixtures.policy.activitiesClosed,
      'and lending, benefits and profit sharing are not',
    ).toBeGreaterThan(0);

    // Each activity named, so a reader can tell which is which.
    for (const activity of [
      'Enrolment and registration fees',
      'Member savings',
      'Member loans',
      'Benefit payments',
      'Year-end profit sharing',
    ]) {
      await expect(readiness.getByText(activity, { exact: true })).toBeVisible();
    }

    // And the sentence that was false: one switch claiming nothing at all can
    // run. Enrolment waits on none of the nine.
    await expect(page.getByText(/no membership transaction can run/i)).toHaveCount(0);
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
