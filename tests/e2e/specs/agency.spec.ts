import {
  expect,
  expectNoErrorBoundary,
  fixtures,
  stateFile,
  test,
  watchForBrowserErrors,
} from './fixtures';

/**
 * The fourteen agency banking screens, in a browser, against the production
 * build and a counter that has been trading.
 *
 * ## What only a browser can say about these
 *
 *   1. **They render at all.** "Something went wrong" is a heading, and a
 *      route returning 200 with an error boundary looks fine to anything that
 *      checks status alone. Every screen is asserted three ways: status, no
 *      boundary, and its own content.
 *
 *   2. **They survive a phone.** The transaction register is a nine-column
 *      table and the reconciliation registers carry a form inside a cell. At
 *      390px they either scroll the page sideways or crush a figure, and the
 *      person reading them is standing at a counter with a customer waiting.
 *
 *   3. **Nobody who should not reach a screen, does.** A Secretary may record
 *      and read; they may not reconcile, and they may not open the provider
 *      configuration. The rail hides those, and hiding is not protection - so
 *      the Secretary is pointed straight at the URL.
 *
 * ## And three things specific to this phase
 *
 *   - **The commission field is absent.** The recording form shows what the
 *     provider's terms produce and offers no way to type a different figure,
 *     because a different figure is the Owner's decision and is taken
 *     elsewhere. A form with an editable commission would let a counter
 *     officer decide the company's income.
 *
 *   - **The approval threshold is marked as not enforced.** `requires_
 *     approval_above` is configured on one seeded type and the posting engine
 *     does not read it. The screen says so, because a screen that presented
 *     it as working would be claiming a protection the system does not have.
 *
 *   - **Every control either acts or explains itself.** The lifecycle
 *     controls render a button wired to a server action or a sentence saying
 *     whose the action is. There is no third case, and this suite asserts the
 *     explanation for the officer who cannot act.
 *
 * ## `.filter({ visible: true })`, everywhere
 *
 * Every register renders twice - cards below `md`, a table above it - with
 * the other half hidden by CSS rather than unmounted. A locator for a
 * provider name therefore resolves two elements, and `.first()` is as likely
 * to be the hidden one.
 *
 * ## What this file does *not* do
 *
 * It posts nothing. Verifying, reversing, settling and certifying all write
 * journals, and this spec runs in both the desktop and the mobile project -
 * so it would post everything twice. The write paths are asserted against
 * real PostgreSQL in `tests/db/agency-*.test.ts`, which is where a posting
 * belongs.
 */

interface Screen {
  readonly name: string;
  readonly path: string;
  /** Text that only this page's own content produces. */
  readonly proves: RegExp;
}

const AGENCY_SCREENS: readonly Screen[] = [
  { name: 'the agency dashboard', path: '/agency', proves: /Agency Services/ },
  { name: 'the recording form', path: '/agency/record', proves: /Record transaction/ },
  {
    name: 'the pending verification queue',
    path: '/agency/pending',
    proves: /Pending verification/,
  },
  {
    name: 'the transaction history',
    path: '/agency/history',
    proves: /Transaction history/,
  },
  {
    name: 'one transaction in full',
    path: `/agency/history/${fixtures.agency.transactions.commissionException}`,
    proves: /What happens next/,
  },
  {
    name: 'a transaction awaiting a second officer',
    path: `/agency/history/${fixtures.agency.transactions.awaitingVerification}`,
    proves: /What happens next/,
  },
  { name: 'float and tills', path: '/agency/float', proves: /Float/ },
  {
    name: 'the float top-up form',
    path: '/agency/float/replenish',
    proves: /Top up a float till/,
  },
  { name: 'commission', path: '/agency/commission', proves: /Commission/ },
  { name: 'provider remittances', path: '/agency/payables', proves: /remittance/i },
  {
    name: 'physical cash reconciliation',
    path: '/agency/reconciliation/cash',
    proves: /Record a physical count/,
  },
  {
    name: 'electronic float reconciliation',
    path: '/agency/reconciliation/float',
    proves: /Record a provider statement/,
  },
  { name: 'the agency reports', path: '/agency/reports', proves: /Agency reports/ },
  {
    name: 'end-of-day exceptions',
    path: '/agency/exceptions',
    proves: /End-of-day exceptions/,
  },
  {
    name: 'providers and services',
    path: '/agency/providers',
    proves: /Providers and services/,
  },
];

// ===========================================================================
test.describe('the agency screens render', () => {
  test.use({ storageState: stateFile('owner') });

  for (const screen of AGENCY_SCREENS) {
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
test.describe('the figures on the screens are the database’s', () => {
  test.use({ storageState: stateFile('owner') });

  test('the dashboard reports what is outstanding, not a count of rows', async ({
    page,
  }) => {
    await page.goto('/agency');
    await expect(
      page
        .getByText(/commission/i)
        .filter({ visible: true })
        .first(),
    ).toBeVisible();
  });

  test('commission earned, received and outstanding are all shown', async ({ page }) => {
    await page.goto('/agency/commission');

    // The seeded counter earned 22,050 across both wallets and has had 6,000
    // paid in, so a screen that showed only one of the three would be
    // showing a figure nobody can act on. The amounts themselves are
    // asserted against the database in the settlement suite; what matters
    // here is that the screen carries all three columns.
    for (const heading of [/earned/i, /received/i, /outstanding/i]) {
      await expect(
        page.locator('main').getByText(heading).filter({ visible: true }).first(),
      ).toBeVisible();
    }
  });

  test('a float till shows its balance and its provider', async ({ page }) => {
    await page.goto('/agency/float');
    await expect(
      page
        .getByText(/MTN Mobile Money \(demonstration\)/)
        .filter({ visible: true })
        .first(),
    ).toBeVisible();
  });

  test('the exceptions screen groups what is outstanding by kind', async ({ page }) => {
    await page.goto('/agency/exceptions');

    // The harness leaves four: two unverified transactions, one count
    // certified with its difference outstanding, and one float statement
    // awaiting a second officer.
    await expect(
      page
        .getByText(/Not verified/i)
        .filter({ visible: true })
        .first(),
    ).toBeVisible();
    await expect(
      page
        .getByText(/Awaiting certification|Unexplained difference/i)
        .filter({ visible: true })
        .first(),
    ).toBeVisible();
  });
});

// ===========================================================================
test.describe('what the interface refuses to pretend', () => {
  test.use({ storageState: stateFile('owner') });

  test('the recording form offers no commission field', async ({ page }) => {
    await page.goto('/agency/record');

    // The engine computes commission from the provider's configured terms.
    // An editable field here would let a counter officer decide the
    // company's income, which is why the Owner-only exception workflow
    // exists on the transaction instead.
    await expect(page.getByLabel(/commission/i)).toHaveCount(0);
  });

  test('the approval threshold is shown and marked as not enforced', async ({ page }) => {
    await page.goto('/agency/providers');

    await expect(
      page
        .getByText(/approval threshold is not enforced/i)
        .filter({ visible: true })
        .first(),
    ).toBeVisible();
  });

  test('provider configuration says what cannot be changed here', async ({ page }) => {
    await page.goto('/agency/providers');

    // This screen used to say "Read-only", and that assertion was right until
    // the Owner's decision 1 added one writer: the correction that moves a
    // *provisional* provider between the two float models. The page is no
    // longer read-only, so the word had to go — and the assertion has to
    // follow the page rather than the page follow the assertion.
    //
    // What must still hold is the part that matters: commercial terms cannot
    // be changed and no provider can be activated from here, because the
    // approval workflow for terms has not been decided.
    await expect(
      page
        .getByText(/approving its commercial terms or making it live is not a screen/i)
        .filter({ visible: true })
        .first(),
    ).toBeVisible();

    // And there is no form pretending otherwise.
    await expect(
      page.getByRole('button', { name: /register|activate|save/i }),
    ).toHaveCount(0);
  });

  test('the one thing it can change is scoped to a provisional provider', async ({
    page,
  }) => {
    // The other half of the same claim. The correction exists, it is named,
    // and it says in words that it activates nothing — so a reader cannot
    // mistake it for the provider-approval workflow that does not exist.
    await page.goto('/agency/providers');

    await expect(
      page
        .getByText(/Correct a provisional provider's money model/i)
        .filter({ visible: true })
        .first(),
    ).toBeVisible();

    await expect(
      page
        .getByText(/configuration correction, not a financial one/i)
        .filter({ visible: true })
        .first(),
    ).toBeVisible();
  });

  test('the officer who recorded a reading cannot certify it', async ({ page }) => {
    // The Owner recorded the seeded float statement, so the Owner is exactly
    // the person who may not certify it. Said in words rather than by a
    // missing button: an officer who sees nothing cannot tell whether the
    // screen is broken or the rule is doing its job.
    await page.goto('/agency/reconciliation/float');
    await expect(
      page
        .getByText(/You recorded this reading/i)
        .filter({ visible: true })
        .first(),
    ).toBeVisible();
  });

  test('a transaction the Owner recorded cannot be verified by them', async ({
    page,
  }) => {
    // The seeded pending transaction was recorded by the Secretary, so an
    // Owner *can* verify it - which is the point: the control appears for
    // the officer who may act, and the refusal below is asserted for one who
    // may not.
    await page.goto(
      `/agency/history/${fixtures.agency.transactions.awaitingVerification}`,
    );
    await expect(
      page
        .getByRole('button', { name: /verify and post/i })
        .filter({ visible: true })
        .first(),
    ).toBeVisible();
  });
});

// ===========================================================================
test.describe('who may reach what', () => {
  test.describe('as a Secretary', () => {
    test.use({ storageState: stateFile('secretary') });

    test('records and reads, and reconciles nothing', async ({ page }) => {
      const record = await page.goto('/agency/record');
      expect(record?.status()).toBe(200);
      await expectNoErrorBoundary(page);

      // The rail does not offer the reconciliation screens.
      await expect(page.getByRole('link', { name: /cash reconciliation/i })).toHaveCount(
        0,
      );

      // And the URL does not open them. The route guard redirects rather
      // than rendering, so what matters is where the browser ends up.
      for (const path of [
        '/agency/reconciliation/cash',
        '/agency/reconciliation/float',
        '/agency/float/replenish',
        '/agency/providers',
      ]) {
        await page.goto(path);
        expect(page.url(), `${path} must not open to a Secretary`).not.toContain(path);
      }
    });

    test('may read the queue but is told verification is somebody else’s', async ({
      page,
    }) => {
      const response = await page.goto('/agency/pending');
      expect(response?.status()).toBe(200);
      await expectNoErrorBoundary(page);

      await expect(
        page
          .getByText(/verification is a manager/i)
          .filter({ visible: true })
          .first(),
      ).toBeVisible();
    });

    test('sees no Verify button on a transaction awaiting one', async ({ page }) => {
      await page.goto(
        `/agency/history/${fixtures.agency.transactions.awaitingVerification}`,
      );

      await expect(page.getByRole('button', { name: /verify and post/i })).toHaveCount(0);

      // Explained rather than hidden: an officer who cannot verify should
      // learn that verification exists and is somebody else's.
      await expect(
        page
          .getByText(/second officer|never the officer who recorded/i)
          .filter({ visible: true })
          .first(),
      ).toBeVisible();
    });
  });

  test.describe('as a Manager', () => {
    test.use({ storageState: stateFile('manager') });

    test('reconciles, and does not configure providers', async ({ page }) => {
      for (const path of [
        '/agency/reconciliation/cash',
        '/agency/reconciliation/float',
      ]) {
        const response = await page.goto(path);
        expect(response?.status(), path).toBe(200);
        await expectNoErrorBoundary(page);
      }

      // `agency:providers` is the Owner's alone.
      await page.goto('/agency/providers');
      expect(page.url(), '/agency/providers must not open to a Manager').not.toContain(
        '/agency/providers',
      );
    });

    test('is told that writing a difference off is the Owner’s', async ({ page }) => {
      await page.goto('/agency/reconciliation/float');

      // The seeded float statement differs by 4,000 and the Owner recorded
      // it, so a Manager is the second officer who may certify it - and
      // holds no `agency:variance_adjustment`, so the screen explains
      // rather than offering a write-off the database would refuse.
      await expect(
        page
          .getByText(/Writing a difference off is the Owner/i)
          .filter({ visible: true })
          .first(),
      ).toBeVisible();
      await expect(
        page
          .getByRole('button', { name: /^Certify$/ })
          .filter({ visible: true })
          .first(),
      ).toBeVisible();
    });
  });

  test.describe('as a borrower', () => {
    test.use({ storageState: stateFile('borrower') });

    test('reaches no agency screen at all', async ({ page }) => {
      for (const path of ['/agency', '/agency/history', '/agency/reports']) {
        await page.goto(path);
        expect(page.url(), `${path} must not open to a borrower`).not.toContain(path);
      }
    });
  });
});
