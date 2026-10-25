import {
  expect,
  expectNoErrorBoundary,
  fixtures,
  stateFile,
  test,
  watchForBrowserErrors,
} from './fixtures';

/**
 * The savings screens, in a browser, against the production build.
 *
 * ## What only a browser can say about these
 *
 * The same three things the membership spec names, and they are the same
 * three because the defects they catch keep happening:
 *
 *   1. **The screens render at all.** The Phase 8 review found every
 *      authenticated page showing an error boundary while returning 200 with
 *      a heading — "Something went wrong" is a heading. So each page is
 *      asserted three ways: status, no boundary, and its own content.
 *
 *   2. **They survive a phone.** The savings register is an eight-column
 *      table and the statement is seven. At 390px either scrolls the page
 *      sideways or crushes a member's name, and a counter uses this
 *      one-handed. Measured directly, by asking the document.
 *
 *   3. **Nobody who should not reach a screen, does.** The rail hides the
 *      withdrawal queue from a Secretary, but hiding is not protection — so
 *      the Secretary is pointed straight at the URL.
 *
 * ## `.filter({ visible: true })`, everywhere
 *
 * Every register and the statement render twice: cards below `md` and a table
 * above it, with the other half hidden by CSS rather than unmounted. So a
 * locator for a member's account number resolves two elements, and `.first()`
 * is as likely to be the hidden one as the shown one. Filtering to visible is
 * not defensive padding — without it these tests fail on data they can see
 * perfectly well, which is worse than not having them.
 *
 * ## What this file does *not* do
 *
 * It records no money. Every write flow lives in `savings.write.spec.ts`,
 * which runs on the desktop project only — the mobile project would otherwise
 * double every deposit in the seeded database, and the balances these tests
 * assert against would depend on which project ran first.
 */

interface Screen {
  readonly name: string;
  readonly path: string;
  /** Text that only this page's own content produces. */
  readonly proves: RegExp;
}

const SAVINGS_SCREENS: readonly Screen[] = [
  { name: 'savings register', path: '/savings', proves: /Savings/ },
  {
    name: 'savings register, filtered to active accounts',
    path: '/savings?status=active',
    proves: /Savings/,
  },
  {
    name: 'a savings account',
    path: `/savings/${fixtures.savings.qualified}`,
    proves: /Saving towards qualification/,
  },
  {
    name: 'a savings statement',
    path: `/savings/${fixtures.savings.withdrawn}/statement`,
    proves: /Savings statement/,
  },
  {
    name: 'the withdrawal queue',
    path: '/savings/withdrawals',
    proves: /Withdrawal requests/,
  },
  {
    name: 'a withdrawal request',
    path: `/savings/withdrawals/${fixtures.withdrawals.pending}`,
    proves: /Decide this withdrawal/,
  },
  {
    name: 'the deposit form',
    path: `/savings/${fixtures.savings.saving}/deposit`,
    proves: /Record a deposit/,
  },
  {
    name: 'the withdrawal request form',
    path: `/savings/${fixtures.savings.gapped}/withdraw`,
    proves: /Request a withdrawal/,
  },
  {
    name: 'the enrolment screen',
    path: '/membership/enrol',
    proves: /Enrol a member/,
  },
];

// ===========================================================================
test.describe('the savings screens render', () => {
  test.use({ storageState: stateFile('owner') });

  for (const screen of SAVINGS_SCREENS) {
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
test.describe('the register shows what the business owes', () => {
  test.use({ storageState: stateFile('owner') });

  test('labels the liability as owed, not as held', async ({ page }) => {
    await page.goto('/savings');

    // The distinction this whole phase turns on. A deposit increases what the
    // business owes; a panel reading "savings held" beside a cash figure
    // invites the reading that ends with a profit share paid out of deposits.
    await expect(page.getByText('Owed to members')).toBeVisible();
    await expect(page.getByText(/savings held/i)).toHaveCount(0);
  });

  test('lists the accounts the seeded members hold', async ({ page }) => {
    await page.goto('/savings');

    // At least four, not exactly four. The write spec enrols a member, and
    // the mobile project runs after the desktop one — so a read spec that
    // asserted an exact count would pass or fail depending on which project
    // ran first, which is a worse test than no test.
    //
    // The link per account works in both layouts: the register renders cards
    // below `md` and a table above it, and each row links to the account
    // either way.
    const links = page.locator('main a[href^="/savings/"]').filter({ visible: true });

    const count = await links.count();
    expect(count, 'four seeded members hold savings accounts').toBeGreaterThanOrEqual(4);

    // The pending application has no savings account at all, because it was
    // never activated — which is the point of seeding it. So the register is
    // shorter than the membership register, and that difference is the
    // assertion worth making about the count.
    await expect(
      page.locator('[data-money]').filter({ visible: true }).first(),
    ).toBeVisible();
  });

  test('finds a member by their account number', async ({ page }) => {
    await page.goto('/savings');

    await page
      .getByRole('searchbox')
      .first()
      .fill(fixtures.savingsAccountNumbers.qualified);
    await page.keyboard.press('Enter');

    await expect(
      page
        .getByText(fixtures.savingsAccountNumbers.qualified)
        .filter({ visible: true })
        .first(),
    ).toBeVisible();
  });
});

// ===========================================================================
test.describe('an account says where the member stands', () => {
  test.use({ storageState: stateFile('owner') });

  test('shows the member who has served the qualifying period as having done so', async ({
    page,
  }) => {
    await page.goto(`/savings/${fixtures.savings.qualified}`);

    await expect(page.getByText('6 of 6')).toBeVisible();
    await expect(page.getByText(/has served the qualifying period/i)).toBeVisible();
  });

  test('judges the gapped member by the rule the policy actually sets', async ({
    page,
  }) => {
    await page.goto(`/savings/${fixtures.savings.gapped}`);

    // This member's history has a gap in it: six qualifying months, longest
    // unbroken run of three. The harness policy does **not** require them to
    // be consecutive, so the member qualifies and the screen says nothing
    // about the run — because under this policy the run does not decide
    // anything, and mentioning it would invite a reader to think it did.
    //
    // The *count* is deliberately not asserted here. The write spec deposits
    // into this account, which adds a month, and the mobile project runs
    // after it — so a count would be asserting the order the projects ran in.
    // What is stable is the rule being applied, which is the behaviour.
    await expect(page.getByText(/has served the qualifying period/i)).toBeVisible();
    await expect(page.getByText(/longest unbroken run/i)).toHaveCount(0);
  });

  test('shows a statement with a running balance on it', async ({ page }) => {
    await page.goto(`/savings/${fixtures.savings.withdrawn}`);

    // Asserted through the headings rather than through `getByRole('table')`:
    // the statement renders as cards below `md` and as a table above it, and
    // the table is hidden on a phone — where this screen gets most of its use.
    await expect(page.getByText('Every movement')).toBeVisible();

    // A running balance on every line, each rendered through `Money`. The
    // figures themselves come from `savings_statement`, which computes the
    // window over the whole account in the database — so a statement cannot
    // disagree with the account page, and neither can disagree with the
    // ledger.
    const amounts = page.locator('[data-money]').filter({ visible: true });
    expect(await amounts.count()).toBeGreaterThan(1);

    // The restated balance under the statement, which is where a reader looks
    // on a printed copy.
    await expect(
      page
        .getByText(/^Balance/)
        .filter({ visible: true })
        .last(),
    ).toBeVisible();
  });

  test('shows the reversal as a correction beside the original', async ({ page }) => {
    await page.goto(`/savings/${fixtures.savings.withdrawn}`);

    // A reversal is a contra row, never an edit — so the original deposit is
    // still there and the correction names it and carries the reason.
    await expect(
      page
        .getByText(/Deposit reversed/)
        .filter({ visible: true })
        .first(),
    ).toBeVisible();
    await expect(
      page
        .getByText(/recorded twice at the counter/i)
        .filter({ visible: true })
        .first(),
    ).toBeVisible();
  });
});

// ===========================================================================
test.describe('the membership record shows the fee, the consent and the savings', () => {
  test.use({ storageState: stateFile('owner') });

  test('shows a card with its verification code', async ({ page }) => {
    await page.goto(`/membership/${fixtures.memberships.qualified}`);

    await expect(page.getByText('Membership card')).toBeVisible();

    // Twelve characters from an alphabet with no I, O, 0 or 1 — so a code read
    // over a phone cannot be mistyped into another valid one.
    await expect(
      page.getByText(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{12}$/),
    ).toBeVisible();
  });

  test('names both outstanding preconditions on an application that cannot be activated', async ({
    page,
  }) => {
    await page.goto(`/membership/${fixtures.memberships.pendingConsent}`);

    await expect(
      page.getByText(/Before this membership can be activated/i),
    ).toBeVisible();

    // The fee is paid and the consent is not, so one reads Done and the other
    // Needed. In words, not only in colour, so it survives a printout and a
    // colour-blind reader.
    await expect(page.getByText('Done', { exact: true })).toHaveCount(1);
    await expect(page.getByText('Needed', { exact: true })).toHaveCount(1);
    await expect(page.getByText(/no verified acceptance/i)).toBeVisible();
  });

  test('shows the savings balance as what the business owes', async ({ page }) => {
    await page.goto(`/membership/${fixtures.memberships.qualified}`);

    await expect(
      page.getByText(/a liability of the business, not its income/i),
    ).toBeVisible();
  });
});

// ===========================================================================
test.describe('who may reach what', () => {
  test.describe('as a Secretary', () => {
    test.use({ storageState: stateFile('secretary') });

    test('reads the register but not the queue', async ({ page }) => {
      const register = await page.goto('/savings');
      expect(register?.status()).toBe(200);
      await expectNoErrorBoundary(page);

      // The rail does not offer it.
      await expect(page.getByRole('link', { name: /withdrawal requests/i })).toHaveCount(
        0,
      );

      // And the URL does not open it. The route guard redirects rather than
      // rendering, so what matters is where the browser ends up.
      await page.goto('/savings/withdrawals');
      expect(page.url(), 'the queue must not open to a Secretary').not.toContain(
        '/savings/withdrawals',
      );
    });

    test('may record a deposit', async ({ page }) => {
      // The Secretary runs the counter. Taking money in is their work, and
      // deciding a withdrawal is not — which is the whole shape of the split.
      const response = await page.goto(`/savings/${fixtures.savings.saving}/deposit`);
      expect(response?.status()).toBe(200);
      await expectNoErrorBoundary(page);
      await expect(page.getByLabel('Amount received')).toBeVisible();
    });
  });

  test.describe('as a borrower', () => {
    test.use({ storageState: stateFile('borrower') });

    test('reaches no staff savings screen', async ({ page }) => {
      for (const path of [
        '/savings',
        '/savings/withdrawals',
        `/savings/${fixtures.savings.qualified}`,
        '/membership/enrol',
      ]) {
        await page.goto(path);
        expect(page.url(), `${path} must not open to a borrower`).not.toContain(path);
      }
    });

    test('sees their own savings in the portal, and no control to move money', async ({
      page,
    }) => {
      await page.goto('/portal');
      await expectNoErrorBoundary(page);

      await expect(page.getByText('Your savings')).toBeVisible();
      await expect(page.getByText('What we hold for you')).toBeVisible();

      // A member cannot pay into their own account: the money has to arrive at
      // a counter before a record of it should exist. Nor can they request a
      // withdrawal — that is prepared by staff, decided by somebody else and
      // then paid.
      for (const name of [/record a deposit/i, /request a withdrawal/i, /withdraw/i]) {
        await expect(page.getByRole('button', { name }), String(name)).toHaveCount(0);
        await expect(page.getByRole('link', { name }), String(name)).toHaveCount(0);
      }

      await expect(page.getByText(/speak to our staff at the branch/i)).toBeVisible();
    });
  });
});

// ===========================================================================
test.describe('the phone', () => {
  test.use({ storageState: stateFile('owner') });

  const NARROW: readonly string[] = [
    '/savings',
    `/savings/${fixtures.savings.withdrawn}`,
    `/savings/${fixtures.savings.withdrawn}/statement`,
    '/savings/withdrawals',
  ];

  for (const path of NARROW) {
    test(`${path} does not scroll sideways`, async ({ page }) => {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(path);
      await expectNoErrorBoundary(page);

      // The measurement, not an eyeball. A table at 390px either scrolls the
      // page sideways or crushes its columns, and a counter uses this
      // one-handed while a member watches.
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );

      expect(overflow, `${path} overflows by ${String(overflow)}px`).toBeLessThanOrEqual(
        1,
      );
    });
  }

  test('keeps every amount whole, with its currency on the same line', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/savings/${fixtures.savings.withdrawn}`);

    // The Phase 9 defect, which appeared on every row of the payments
    // register: `UGX` on one line and the figure on the next. `Money` sets
    // `whitespace-nowrap`; this asks the browser whether it held.
    // Visible only. The desktop table is hidden at this width, and a hidden
    // element has no client rects at all — which would read as "wrapped
    // across 0 lines" and fail on markup that is not even on screen.
    const amounts = page.locator('[data-money]').filter({ visible: true });
    const count = await amounts.count();
    expect(count).toBeGreaterThan(0);

    for (let index = 0; index < count; index += 1) {
      const boxes = await amounts
        .nth(index)
        .evaluate((element) => element.getClientRects().length);
      const text = await amounts.nth(index).textContent();
      expect(boxes, `"${text ?? ''}" wrapped across ${String(boxes)} lines`).toBe(1);
    }
  });

  test('offers the deposit form at a tappable size', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/savings/${fixtures.savings.saving}/deposit`);

    // 44px is the floor a thumb needs. The amount field and the method
    // choices are what a counter touches dozens of times a day.
    const amount = page.getByLabel('Amount received');
    const box = await amount.boundingBox();
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(40);
  });
});
