import {
  expect,
  expectNoErrorBoundary,
  fixtures,
  stateFile,
  test,
  watchForBrowserErrors,
} from './fixtures';

/**
 * The benefit and next-of-kin screens, in a browser, against the production
 * build.
 *
 * ## What only a browser can say about these
 *
 * The same three things every screen suite here asserts, and they are the
 * same three because the defects they catch keep happening:
 *
 *   1. **The screens render at all.** "Something went wrong" is a heading,
 *      and a page returning 200 with an error boundary looks fine to
 *      anything that checks status alone. So each page is asserted three
 *      ways: status, no boundary, and its own content.
 *
 *   2. **They survive a phone.** The claim register is an eight-column table.
 *      At 390px it either scrolls the page sideways or crushes a member's
 *      name, and the person recording a claim is often standing at a counter
 *      with a bereaved family in front of them.
 *
 *   3. **Nobody who should not reach a screen, does.** The rail hides the
 *      approval queue from a Secretary, and hiding is not protection — so the
 *      Secretary is pointed straight at the URL.
 *
 * ## And one thing specific to this phase
 *
 * That a **held** claim says which decision it is waiting on. Four of the
 * benefit rules are undecided, and the difference between "this claim cannot
 * be assessed" and "nobody has defined which relatives the condolence benefit
 * covers" is the difference between a screen a member can be shown and one
 * that makes the business look broken. The harness seeds exactly that claim.
 *
 * ## `.filter({ visible: true })`, everywhere
 *
 * Every register renders twice: cards below `md` and a table above it, with
 * the other half hidden by CSS rather than unmounted. A locator for a claim
 * number therefore resolves two elements, and `.first()` is as likely to be
 * the hidden one.
 *
 * ## What this file does *not* do
 *
 * It approves nothing and pays nothing. Those live in
 * `benefits.write.spec.ts`, which runs on the desktop project only — the
 * mobile project would otherwise pay the same claim twice.
 */

interface Screen {
  readonly name: string;
  readonly path: string;
  /** Text that only this page's own content produces. */
  readonly proves: RegExp;
}

const BENEFIT_SCREENS: readonly Screen[] = [
  { name: 'the benefits dashboard', path: '/benefits', proves: /The benefits position/ },
  { name: 'the claim register', path: '/benefits/claims', proves: /Benefit claims/ },
  {
    name: 'the claim register, filtered to one stage',
    path: '/benefits/claims?status=assessed',
    proves: /Benefit claims/,
  },
  {
    name: 'a paid claim',
    path: `/benefits/claims/${fixtures.benefitClaims.paid}`,
    proves: /The claim/,
  },
  {
    name: 'a claim awaiting approval',
    path: `/benefits/claims/${fixtures.benefitClaims.awaiting}`,
    proves: /The assessment, as it was frozen/,
  },
  {
    name: 'a claim held on an undecided rule',
    path: `/benefits/claims/${fixtures.benefitClaims.held}`,
    proves: /cannot be assessed yet/,
  },
  {
    name: 'the approval queue',
    path: '/benefits/approvals',
    proves: /Benefit approvals/,
  },
  {
    name: 'the payment register',
    path: '/benefits/payments',
    proves: /Benefit payments/,
  },
  { name: 'the benefits report', path: '/benefits/reports', proves: /Benefits paid/ },
  { name: 'the new claim screen', path: '/benefits/claims/new', proves: /Which member/ },
  { name: 'the next of kin register', path: '/beneficiaries', proves: /Next of kin/ },
  {
    name: 'a verified beneficiary record',
    path: `/beneficiaries/${fixtures.beneficiaries.verified}`,
    proves: /The record/,
  },
  {
    name: 'a beneficiary nobody has checked',
    path: `/beneficiaries/${fixtures.beneficiaries.pending}`,
    proves: /The record/,
  },
  {
    name: 'the beneficiary registration screen',
    path: '/beneficiaries/new',
    proves: /Whose next of kin/,
  },
];

// ===========================================================================
test.describe('the benefit screens render', () => {
  test.use({ storageState: stateFile('owner') });

  for (const screen of BENEFIT_SCREENS) {
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
test.describe('the dashboard reports the position', () => {
  test.use({ storageState: stateFile('owner') });

  test('reports the gap in next of kin rather than the coverage', async ({ page }) => {
    await page.goto('/benefits');

    // A member with no verified next of kin is a bereavement benefit that
    // cannot be paid on the day it is needed, so the panel reports the gap:
    // "41 of 120 have none" is actionable where "66% covered" is a slide.
    await expect(
      page
        .getByText(/Members with no next of kin/i)
        .filter({ visible: true })
        .first(),
    ).toBeVisible();
  });

  test('shows what is waiting on somebody, and links into the register', async ({
    page,
  }) => {
    await page.goto('/benefits');

    await expect(
      page
        .getByText(/Waiting on somebody/i)
        .filter({ visible: true })
        .first(),
    ).toBeVisible();

    // The stage breakdown is a way in rather than a thing to read: every
    // non-empty stage links to the register filtered to it.
    await expect(
      page.locator('main a[href*="/benefits/claims?status="]').first(),
    ).toBeVisible();
  });

  test('says nothing about benefits being shut, because they are open here', async ({
    page,
  }) => {
    await page.goto('/benefits');

    // The harness answers the three rules `is_benefits_enabled` waits on, so
    // the banner must be absent. A banner that appeared anyway would be the
    // Phase 1 mistake again: a warning that overstates its scope teaches the
    // reader to scroll past it.
    await expect(page.getByText(/Benefits are not open yet/i)).toHaveCount(0);
  });
});

// ===========================================================================
test.describe('a claim says where it has got to', () => {
  test.use({ storageState: stateFile('owner') });

  test('pays 5% of the bill, and shows the figure', async ({ page }) => {
    await page.goto(`/benefits/claims/${fixtures.benefitClaims.paid}`);

    // 5% of 400,000 is exactly 20,000 — the figure the brief quotes, computed
    // in whole shillings by the database and rendered here.
    await expect(
      page
        .getByText(fixtures.benefitClaims.paidAmount.toLocaleString('en-US'))
        .filter({ visible: true })
        .first(),
    ).toBeVisible();

    await expect(
      page
        .getByText(/This benefit has been paid/i)
        .filter({ visible: true })
        .first(),
    ).toBeVisible();
  });

  test('shows the three readings of the admission on the claim itself', async ({
    page,
  }) => {
    await page.goto(`/benefits/claims/${fixtures.benefitClaims.paid}`);

    // Stored on the row rather than recomputed, so a change in how the code
    // counts can never alter what was assessed — and shown, because the
    // assessment turns on them.
    await expect(
      page
        .getByText(/nights · .* ward days · .* clock days/)
        .filter({ visible: true })
        .first(),
    ).toBeVisible();
  });

  test('names the decision a held claim is waiting on', async ({ page }) => {
    await page.goto(`/benefits/claims/${fixtures.benefitClaims.held}`);

    // The assertion this suite exists for. Not "not available", not a
    // constraint name: the rule nobody has decided, in words, separated from
    // the refusals a member can be told.
    await expect(
      page
        .getByText(/Who counts as family is undecided/i)
        .filter({ visible: true })
        .first(),
    ).toBeVisible();

    await expect(
      page
        .getByText(/not been decided by the client/i)
        .filter({ visible: true })
        .first(),
    ).toBeVisible();

    // And it is not presented as a refusal, because the member has not been
    // turned down. Scoped to `main` for the reason the meeting suite scopes
    // its own: the shell is not this screen.
    await expect(
      page
        .locator('main')
        .getByText(/Refused/)
        .filter({ visible: true }),
    ).toHaveCount(0);
  });

  test('shows the frozen assessment behind a decided claim', async ({ page }) => {
    await page.goto(`/benefits/claims/${fixtures.benefitClaims.awaiting}`);

    await expect(
      page
        .getByText(/Written once and never updated/i)
        .filter({ visible: true })
        .first(),
    ).toBeVisible();

    // The period the cap was measured over, which is one of the inputs the
    // snapshot exists to keep.
    await expect(
      page
        .getByText(/Annual ceiling then/i)
        .filter({ visible: true })
        .first(),
    ).toBeVisible();
  });

  test('counts checked evidence rather than attached evidence', async ({ page }) => {
    await page.goto(`/benefits/claims/${fixtures.benefitClaims.paid}`);

    // A document existing is not a fact being established. The progress line
    // says how many were *checked*, which is the condition
    // `assess_benefit_claim` enforces.
    await expect(
      page
        .getByText(/checked/)
        .filter({ visible: true })
        .first(),
    ).toBeVisible();
  });
});

// ===========================================================================
test.describe('the registers find what somebody is looking for', () => {
  test.use({ storageState: stateFile('owner') });

  test('finds a claim by its number', async ({ page }) => {
    await page.goto('/benefits/claims');

    await page.getByRole('searchbox').first().fill(fixtures.benefitClaims.paidNumber);
    await page.keyboard.press('Enter');

    await expect(
      page.getByText(fixtures.benefitClaims.paidNumber).filter({ visible: true }).first(),
    ).toBeVisible();
  });

  test('shows no beneficiary name in the claim register', async ({ page }) => {
    await page.goto('/benefits/claims');

    // A beneficiary's name is the business's payment instruction and lives
    // behind `membership:view_sensitive` in another table. The register view
    // carries none, so none can appear here however the page is edited.
    await expect(page.locator('main').getByText('Hadija Nakato')).toHaveCount(0);
  });

  test('opens the approval queue on what is waiting for an approver', async ({
    page,
  }) => {
    await page.goto('/benefits/approvals');

    // Opens on `assessed` rather than on everything, because this screen
    // exists to be worked through.
    await expect(
      page
        .getByText(fixtures.benefitClaims.awaitingNumber)
        .filter({ visible: true })
        .first(),
    ).toBeVisible();
  });

  test('names the accounts a payment was posted to', async ({ page }) => {
    // Asserted on the claim, where the posting is always rendered, rather
    // than on the register, where the account column is hidden below `xl` —
    // the question is whether the screen names the accounts at all, not which
    // breakpoint shows the column.
    await page.goto(`/benefits/claims/${fixtures.benefitClaims.paid}`);

    // A reconciliation needs both sides: the expense account the benefit was
    // charged to, and the cash account it came out of.
    await expect(page.getByText('5210').filter({ visible: true }).first()).toBeVisible();
    await expect(
      page
        .getByText(/against/)
        .filter({ visible: true })
        .first(),
    ).toBeVisible();
  });

  test('lists the payment on the payment register', async ({ page }) => {
    await page.goto('/benefits/payments');

    // The claim number travels with the payment, so a reconciliation can get
    // from a journal line back to the claim that caused it.
    await expect(
      page.getByText(fixtures.benefitClaims.paidNumber).filter({ visible: true }).first(),
    ).toBeVisible();
  });

  test('reconciles the payments against the General Ledger on the report', async ({
    page,
  }) => {
    await page.goto('/benefits/reports');

    // Two independent paths to one number, side by side. A report reading one
    // source could not tell anybody when they disagreed.
    await expect(
      page
        .getByText(/payment records and the General Ledger agree/i)
        .filter({ visible: true })
        .first(),
    ).toBeVisible();
  });
});

// ===========================================================================
test.describe('next of kin', () => {
  test.use({ storageState: stateFile('owner') });

  test('marks the record nobody has checked', async ({ page }) => {
    await page.goto('/beneficiaries?verification=pending_verification');

    await expect(
      page
        .getByText(/Not yet checked/i)
        .filter({ visible: true })
        .first(),
    ).toBeVisible();
  });

  test('shows the name to a reader holding the sensitive-detail capability', async ({
    page,
  }) => {
    await page.goto(`/beneficiaries/${fixtures.beneficiaries.verified}`);

    // The Owner holds `membership:view_sensitive`, so the identity read
    // returns a row and the name is rendered.
    await expect(
      page.getByText('Hadija Nakato').filter({ visible: true }).first(),
    ).toBeVisible();
    await expect(
      page
        .getByText(/Verified/)
        .filter({ visible: true })
        .first(),
    ).toBeVisible();
  });

  test('says a bereavement benefit cannot be paid on an unchecked record', async ({
    page,
  }) => {
    await page.goto(`/beneficiaries/${fixtures.beneficiaries.pending}`);

    await expect(
      page
        .getByText(/Not yet checked/i)
        .filter({ visible: true })
        .first(),
    ).toBeVisible();
  });
});

// ===========================================================================
test.describe('who may reach what', () => {
  test.describe('as a Secretary', () => {
    test.use({ storageState: stateFile('secretary') });

    test('records claims and beneficiaries, and approves neither', async ({ page }) => {
      const register = await page.goto('/benefits/claims');
      expect(register?.status()).toBe(200);
      await expectNoErrorBoundary(page);

      // The rail does not offer the queues.
      await expect(page.getByRole('link', { name: /approval queue/i })).toHaveCount(0);

      // And the URL does not open them. The route guard redirects rather than
      // rendering, so what matters is where the browser ends up.
      for (const path of ['/benefits/approvals', '/benefits/payments']) {
        await page.goto(path);
        expect(page.url(), `${path} must not open to a Secretary`).not.toContain(path);
      }
    });

    test('may open a claim and register a beneficiary', async ({ page }) => {
      for (const path of ['/benefits/claims/new', '/beneficiaries/new']) {
        const response = await page.goto(path);
        expect(response?.status(), path).toBe(200);
        await expectNoErrorBoundary(page);
      }
    });

    test('reads no beneficiary name, because that needs another capability', async ({
      page,
    }) => {
      await page.goto(`/beneficiaries/${fixtures.beneficiaries.verified}`);
      await expectNoErrorBoundary(page);

      // The record opens — a Secretary records next of kin all day — and the
      // name does not, because it lives in another table behind
      // `membership:view_sensitive`. The page says so rather than rendering
      // an empty field.
      await expect(page.getByText('Hadija Nakato')).toHaveCount(0);
      await expect(
        page
          .getByText(/Restricted/i)
          .filter({ visible: true })
          .first(),
      ).toBeVisible();
    });
  });

  test.describe('as a borrower', () => {
    test.use({ storageState: stateFile('borrower') });

    test('reaches no staff benefit screen', async ({ page }) => {
      for (const path of [
        '/benefits',
        '/benefits/claims',
        '/benefits/approvals',
        '/benefits/payments',
        '/benefits/reports',
        '/beneficiaries',
        `/benefits/claims/${fixtures.benefitClaims.paid}`,
      ]) {
        await page.goto(path);
        expect(page.url(), `${path} must not open to a borrower`).not.toContain(path);
      }
    });

    test('sees their own claim in the portal, with the reason and not the reasoning', async ({
      page,
    }) => {
      await page.goto('/portal');
      await expectNoErrorBoundary(page);

      // The portal reads the view whose column list is the disclosure policy.
      // A member is entitled to be told what was decided; the assessor's note
      // is what the business *suspected*, and it is not in the view at all.
      await expect(
        page.getByText('My benefit claims').filter({ visible: true }).first(),
      ).toBeVisible();

      await expect(
        page.getByText(/invoice and admission record both checked/i),
      ).toHaveCount(0);

      // And no control to claim: a claim is recorded at a counter, against
      // documents somebody has looked at.
      for (const name of [/open a claim/i, /new claim/i]) {
        await expect(page.getByRole('button', { name }), String(name)).toHaveCount(0);
        await expect(page.getByRole('link', { name }), String(name)).toHaveCount(0);
      }
    });
  });
});

// ===========================================================================
test.describe('the phone', () => {
  test.use({ storageState: stateFile('owner') });

  const NARROW: readonly string[] = [
    '/benefits',
    '/benefits/claims',
    `/benefits/claims/${fixtures.benefitClaims.paid}`,
    '/benefits/approvals',
    '/benefits/payments',
    '/benefits/reports',
    '/beneficiaries',
    `/beneficiaries/${fixtures.beneficiaries.verified}`,
  ];

  for (const path of NARROW) {
    test(`${path} does not scroll sideways`, async ({ page }) => {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(path);
      await expectNoErrorBoundary(page);

      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );

      expect(overflow, `${path} overflows by ${String(overflow)}px`).toBeLessThanOrEqual(
        1,
      );
    });
  }
});
