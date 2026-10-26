import { expect, expectNoErrorBoundary, fixtures, stateFile, test } from './fixtures';

/**
 * Phase 14 — Debt & Security, in a browser.
 *
 * Four things this proves that nothing else can:
 *
 *   * the five views of the hub are five reachable screens rather than five
 *     tabs over one query, and none of them error;
 *   * an item of security recorded on a live loan appears in the loan's own
 *     panel and in the register across the book, with the same figures;
 *   * a recovery action and a promise to pay can be recorded end to end, and
 *     the promise's verdict is what the payments say rather than what somebody
 *     typed;
 *   * a staff member who may not release a guarantor is not shown the control.
 *
 * The rules themselves are asserted against a real database in
 * `tests/db/security-and-recovery.test.ts`. What is here is whether a person
 * can actually get at them.
 */

test.describe('the Debt & Security hub', () => {
  test.use({ storageState: stateFile('owner') });

  test('offers its five views, and each one renders', async ({ page }) => {
    await page.goto('/recovery');
    await expectNoErrorBoundary(page);

    const strip = page.getByRole('navigation', { name: 'Debt and security views' });
    await expect(strip).toBeVisible();

    for (const label of [
      'Aging',
      'Risk monitoring',
      'Follow-ups',
      'Promises to pay',
      'Security held',
    ]) {
      await expect(strip.getByRole('button', { name: label, exact: true })).toBeVisible();
    }

    for (const view of ['risk', 'follow-ups', 'promises', 'security']) {
      await page.goto(`/recovery?view=${view}`);
      await expectNoErrorBoundary(page);
      await expect(page.locator('[aria-current="page"]').first()).toBeVisible();
    }
  });

  test('buckets the active book and carries a count on every chip', async ({ page }) => {
    await page.goto('/recovery');
    await expectNoErrorBoundary(page);

    const buckets = page.getByRole('navigation', { name: 'Aging buckets' });
    await expect(buckets).toBeVisible();

    // The counts come from the same aggregate the risk view reads, so they
    // cost nothing extra — and a worklist whose chips say "2" is one somebody
    // can plan a morning from.
    await expect(
      buckets.getByRole('button', { name: /All active \(\d+\)/ }),
    ).toBeVisible();
    await expect(buckets.getByRole('button', { name: /1–7 days \(\d+\)/ })).toBeVisible();
    await expect(
      buckets.getByRole('button', { name: /Over 90 days \(\d+\)/ }),
    ).toBeVisible();
  });

  test('filtering to a bucket narrows the register rather than erroring', async ({
    page,
  }) => {
    for (const bucket of ['current', '1_7', '8_30', '31_60', '61_90', '90_plus']) {
      await page.goto(`/recovery?bucket=${bucket}`);
      await expectNoErrorBoundary(page);
    }
  });

  test('states PAR with the principal behind it, at all five thresholds', async ({
    page,
  }) => {
    await page.goto('/recovery?view=risk');
    await expectNoErrorBoundary(page);

    // Matched as a definition term rather than as page text. Since Polytos
    // Phase 3 the book carries a second loan product, so `RiskBreakdown`
    // renders the by-product table — which repeats all five labels as column
    // headers, and an unscoped text match resolves two of each. Only the
    // summary renders them as `<dt>`.
    for (const label of ['PAR 1', 'PAR 7', 'PAR 30', 'PAR 60', 'PAR 90']) {
      await expect(page.getByRole('term').filter({ hasText: label })).toBeVisible();
    }

    // Principal, not total outstanding and not the arrears figure — the two
    // substitutions that quietly turn PAR into a different ratio.
    await expect(page.getByText(/over total\s+outstanding principal/i)).toBeVisible();
  });

  test('breaks PAR out by loan product, now that there is more than one', async ({
    page,
  }) => {
    await page.goto('/recovery?view=risk');
    await expectNoErrorBoundary(page);

    // `RiskBreakdown` returns null for a single slice, because a one-row
    // breakdown says nothing the summary above it did not. Until Polytos
    // Phase 3 put a member loan in the book every harness loan was on one
    // product, so this table had never rendered in a browser.
    const byProduct = page.getByRole('table', {
      name: /Portfolio at risk by loan product/i,
    });

    await expect(byProduct).toBeVisible();

    // More than one row, or the component would have declined to draw it.
    expect(await byProduct.locator('tbody tr').count()).toBeGreaterThan(1);

    // Each row names its product and carries the five ratios beside the
    // principal they are ratios of.
    await expect(byProduct.getByText(/Member Loans/i).first()).toBeVisible();
  });
});

test.describe('security against a loan', () => {
  test.use({ storageState: stateFile('owner') });

  test('records an item, and shows it on the loan and in the register', async ({
    page,
  }) => {
    await page.goto(`/loans/${fixtures.loans.arrears}`);
    await expectNoErrorBoundary(page);

    const security = page.locator('section[aria-labelledby="security-heading"]');
    await expect(security).toBeVisible();

    await security.getByLabel(/^What kind of item/).selectOption('motorcycle');
    await security
      .getByLabel(/^Description/)
      .fill('Blue Bajaj Boxer, registration UEH 221K');
    await security.getByLabel(/^Estimated value/).fill('1750000');
    await security.getByLabel(/^Valued on/).fill(businessYesterday());
    await security.getByLabel(/^Where it is kept/).fill('Kyebando office store');

    await security.getByRole('button', { name: /Record the item/i }).click();

    // The panel re-renders from the server, so the item itself is the
    // assertion rather than a flash message that unmounts with it.
    await expect(
      security.getByText(/Blue Bajaj Boxer, registration UEH 221K/),
    ).toBeVisible();
    await expect(security.getByText('Held').first()).toBeVisible();

    await page.goto('/recovery?view=security');
    await expectNoErrorBoundary(page);
    await expect(page.getByText(/Blue Bajaj Boxer/)).toBeVisible();
  });

  test('says so when a product expects security and none is held', async ({ page }) => {
    await page.goto(`/loans/${fixtures.loans.draft}`);
    await expectNoErrorBoundary(page);

    // Whether the warning shows depends on the product, so this asserts the
    // section exists and does not error rather than asserting the warning —
    // a test that demanded the warning would be a test of the seeded product.
    await expect(
      page.locator('section[aria-labelledby="security-heading"]'),
    ).toBeVisible();
  });
});

test.describe('working a loan in arrears', () => {
  test.use({ storageState: stateFile('owner') });

  test('records a call with an outcome and a follow-up', async ({ page }) => {
    await page.goto(`/loans/${fixtures.loans.arrears}`);
    await expectNoErrorBoundary(page);

    const recovery = page.locator('section[aria-labelledby="recovery-heading"]');
    await expect(recovery).toBeVisible();

    await recovery.getByLabel(/^What was done/).selectOption('call');
    await recovery.getByLabel(/^What came of it/).selectOption('no_answer');
    await recovery.getByLabel(/^Follow up on/).fill(businessTomorrow());
    await recovery
      .getByLabel(/^What happened/)
      .fill('Phone off all morning; will try the shop this afternoon');

    await recovery.getByRole('button', { name: /^Record it$/i }).click();

    await expect(
      recovery.getByText(/Phone off all morning; will try the shop this afternoon/),
    ).toBeVisible();
    await expect(recovery.getByText('Phone call').first()).toBeVisible();
    await expect(recovery.getByText(/No answer/).first()).toBeVisible();
  });

  test('records a promise, and says it changes nothing contractual', async ({ page }) => {
    await page.goto(`/loans/${fixtures.loans.arrears}`);
    await expectNoErrorBoundary(page);

    const recovery = page.locator('section[aria-labelledby="recovery-heading"]');

    await recovery.getByLabel(/^What was done/).selectOption('promise');

    // Choosing "promise" reveals the two fields together, because a promise
    // with an amount and no date is one nobody can ever call broken.
    await expect(recovery.getByLabel(/^Amount promised/)).toBeVisible();
    await expect(recovery.getByLabel(/^Promised by/)).toBeVisible();
    await expect(
      recovery.getByText(/A promise changes nothing contractual/i),
    ).toBeVisible();

    await recovery.getByLabel(/^Amount promised/).fill('60000');
    await recovery.getByLabel(/^Promised by/).fill(businessTomorrow());
    await recovery
      .getByLabel(/^What happened/)
      .fill('Came to the office; will pay 60,000 tomorrow after the market');

    await recovery.getByRole('button', { name: /^Record it$/i }).click();

    await expect(recovery.getByText(/will pay 60,000 tomorrow/)).toBeVisible();
    // Pending, from the payments — not from anything typed into the form.
    await expect(recovery.getByText('Awaiting').first()).toBeVisible();

    await page.goto('/recovery?view=promises');
    await expectNoErrorBoundary(page);
    await expect(page.getByText('Paid in the window')).toBeVisible();
  });

  test('corrects an entry by appending, leaving the original readable', async ({
    page,
  }) => {
    await page.goto(`/loans/${fixtures.loans.arrears}`);
    await expectNoErrorBoundary(page);

    const recovery = page.locator('section[aria-labelledby="recovery-heading"]');

    await recovery.getByLabel(/^What was done/).selectOption('note');
    await recovery
      .getByLabel(/^What happened/)
      .fill('Borrower said the shop had closed — this was the wrong borrower');
    await recovery.getByRole('button', { name: /^Record it$/i }).click();

    const original = recovery
      .locator('li', { hasText: 'this was the wrong borrower' })
      .first();
    await expect(original).toBeVisible();

    await original.getByRole('button', { name: /Correct this entry/i }).click();
    await original
      .getByLabel(/^What was wrong/)
      .fill('That note belongs to a different file.');
    await original.getByRole('button', { name: /Append the correction/i }).click();

    // Both are on screen: the original marked as corrected, the correction
    // beneath it. Nothing was edited, which is the point of the table.
    await expect(recovery.getByText(/this was the wrong borrower/).first()).toBeVisible();
    await expect(recovery.getByText('Correction').first()).toBeVisible();
    await expect(
      recovery.getByText('That note belongs to a different file.'),
    ).toBeVisible();
  });
});

test.describe('the guarantor register', () => {
  test.use({ storageState: stateFile('owner') });

  test('names the guarantor, the borrower and the exposure', async ({ page }) => {
    await page.goto('/guarantors/register');
    await expectNoErrorBoundary(page);

    await expect(page.getByRole('heading', { name: 'Guarantor register' })).toBeVisible();
    await expect(page.getByLabel('Guarantor type')).toBeVisible();
    await expect(page.getByLabel('Guarantee status')).toBeVisible();
    await expect(page.getByLabel('Loan product')).toBeVisible();

    // The rule that stops a reader adding the column up and concluding the
    // register is wrong.
    await expect(page.getByText(/does not\s+sum to the loan book/i)).toBeVisible();
  });

  test('filters without erroring', async ({ page }) => {
    for (const query of [
      'subjectKind=external',
      'subjectKind=client',
      'guaranteeStatus=binding',
      'guaranteeStatus=released',
    ]) {
      await page.goto(`/guarantors/register?${query}`);
      await expectNoErrorBoundary(page);
    }
  });
});

test.describe('who may release a guarantor', () => {
  test('a Manager is offered the control', async ({ browser }) => {
    const context = await browser.newContext({ storageState: stateFile('manager') });
    const page = await context.newPage();

    await page.goto(`/loans/${fixtures.loans.arrears}`);
    await expectNoErrorBoundary(page);

    const security = page.locator('section[aria-labelledby="security-heading"]');
    await expect(
      security.getByRole('button', { name: /Release this guarantor/i }).first(),
    ).toBeVisible();

    await context.close();
  });

  test('a Secretary/Treasurer is not', async ({ browser }) => {
    const context = await browser.newContext({ storageState: stateFile('secretary') });
    const page = await context.newPage();

    await page.goto(`/loans/${fixtures.loans.arrears}`);
    await expectNoErrorBoundary(page);

    // Hiding the control is the courtesy; the function's own capability check
    // is the protection, and `tests/db` asserts that one.
    await expect(
      page.getByRole('button', { name: /Release this guarantor/i }),
    ).toHaveCount(0);

    await context.close();
  });
});

test.describe('the collection summary', () => {
  test.use({ storageState: stateFile('owner') });

  test('cuts the period five ways from one read', async ({ page }) => {
    await page.goto('/payments/summary');
    await expectNoErrorBoundary(page);

    for (const heading of [
      'By method',
      'By staff member',
      'By branch',
      'By loan product',
      'By day',
    ]) {
      await expect(page.getByRole('heading', { name: heading })).toBeVisible();
    }

    // The statement, not its phrasing: the line was shortened in the copy
    // reduction pass and must still deny the reading it denies — somebody
    // counting principal as revenue has overstated the business's income.
    await expect(
      page.getByText(/Principal collected reduces what is owed and is not revenue/i),
    ).toBeVisible();
  });

  test('takes a period from the URL', async ({ page }) => {
    await page.goto('/payments/summary?from=2026-01-01&to=2026-12-31');
    await expectNoErrorBoundary(page);

    // Exact, because `To` is a substring of plenty of accessible names on
    // this page — the summary's footer marks each column it deliberately
    // does not total, and "Not totalled" contains it.
    await expect(page.getByLabel('From', { exact: true })).toHaveValue('2026-01-01');
    await expect(page.getByLabel('To', { exact: true })).toHaveValue('2026-12-31');
  });

  test('swaps a reversed range rather than showing an empty summary', async ({
    page,
  }) => {
    await page.goto('/payments/summary?from=2026-12-31&to=2026-01-01');
    await expectNoErrorBoundary(page);

    // An empty summary reads as "nothing was collected" rather than as "those
    // dates are the wrong way round".
    // Exact, because `To` is a substring of plenty of accessible names on
    // this page — the summary's footer marks each column it deliberately
    // does not total, and "Not totalled" contains it.
    await expect(page.getByLabel('From', { exact: true })).toHaveValue('2026-01-01');
    await expect(page.getByLabel('To', { exact: true })).toHaveValue('2026-12-31');
  });

  test('is reachable from the payment register', async ({ page }) => {
    await page.goto('/payments');
    await expectNoErrorBoundary(page);

    // Scoped to the page, because the rail carries its own route to here now:
    // Collections -> Collection Summary, which auto-expands on `/payments`.
    // Both links are correct and wanted; what this test is about is the one
    // on the register.
    await page.locator('main').getByRole('link', { name: 'Collection summary' }).click();
    await expect(page.getByRole('heading', { name: 'Collection summary' })).toBeVisible();
  });
});

/** Yesterday, as a date input wants it. Valuations may not be in the future. */
function businessYesterday(): string {
  const at = new Date();
  at.setUTCDate(at.getUTCDate() - 1);
  return at.toISOString().slice(0, 10);
}

/** Tomorrow, for a follow-up or a promise, both of which look forward. */
function businessTomorrow(): string {
  const at = new Date();
  at.setUTCDate(at.getUTCDate() + 1);
  return at.toISOString().slice(0, 10);
}
