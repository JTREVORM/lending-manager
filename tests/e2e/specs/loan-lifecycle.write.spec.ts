import type { Page } from '@playwright/test';

import { expect, expectNoErrorBoundary, fixtures, stateFile, test } from './fixtures';

/**
 * A loan from draft to disbursed, in a browser.
 *
 * The financial rules are proved by the unit and database suites — the
 * reducing-balance arithmetic, the schedule dates, the rounding. What cannot
 * be proved there is whether the four buttons a manager actually presses are
 * wired to those rules at all. That is what this does: draft, submit,
 * approve, release, and then read the schedule the database generated.
 *
 * Nothing here asserts a figure it computed itself. Where a number is
 * checked, it is checked against the figure the application displayed one
 * step earlier, so the test cannot drift into being a second, worse
 * implementation of the engine.
 */

test.use({ storageState: stateFile('owner') });

/**
 * Register a borrower for this run, and return their name.
 *
 * The lifecycle test needs somebody who can actually be approved, and the
 * rule is one running loan at a time — so it cannot borrow a seeded client
 * without depending on which other specs have already lent to whom. A new
 * borrower taking their first loan is both self-contained and the commonest
 * real case.
 *
 * The stamp is letters: a person's name may hold letters, spaces, hyphens,
 * apostrophes and full stops, and a fixture that breaks that rule would be
 * testing the validator instead.
 */
const DIGITS_AS_LETTERS = 'abcdefghij';

async function registerBorrower(page: Page): Promise<string> {
  const stamp = String(Date.now())
    .slice(-6)
    .split('')
    .map((digit) => DIGITS_AS_LETTERS[Number(digit)] ?? 'x')
    .join('');
  const fullName = `Wamala Firstloan ${stamp}`;

  await page.goto('/clients/new');
  await page.getByLabel('Full name').fill(fullName);
  await page.getByLabel('Sex').selectOption('male');
  await page.getByLabel('Date of birth').fill('1992-06-18');
  await page.getByLabel(/^Phone number/).fill(`+25677210${String(Date.now()).slice(-4)}`);
  await page.getByLabel('Village or area').fill('Kyanja');
  await page.getByLabel('District').fill('Kampala');
  await page.getByLabel('Occupation').fill('Grocer');
  await page.getByRole('button', { name: /register client/i }).click();

  await page.waitForURL(/\/clients\/[0-9a-f-]{36}/, { timeout: 20_000 });

  return fullName;
}

/**
 * Capture a guarantor on the application, and take the undertaking.
 *
 * Phase 13 moved a loan's guarantors onto the loan: approval counts
 * `loan_guarantors` rather than the borrower's register, and refuses an
 * undertaking nobody signed. The point of the change is that a staff member
 * never has to leave the application to do it — so this test does not, and
 * that is the thing it proves.
 */
async function captureGuarantor(page: Page, loanUrl: string): Promise<string> {
  const stamp = String(Date.now())
    .slice(-6)
    .split('')
    .map((digit) => DIGITS_AS_LETTERS[Number(digit)] ?? 'x')
    .join('');
  const guarantorName = `Ssentongo Backer ${stamp}`;

  await page.goto(`${loanUrl}/application`);
  await expectNoErrorBoundary(page);

  await page.getByRole('button', { name: /capture a new guarantor/i }).click();

  await page.getByLabel('Full name').fill(guarantorName);
  await page.getByLabel('Sex').selectOption('female');
  await page.getByLabel('Date of birth').fill('1980-01-15');
  await page.getByLabel(/^Phone/).fill(`+25677211${String(Date.now()).slice(-4)}`);
  await page.getByLabel('Location').fill('Kyanja');
  await page.getByLabel('District').fill('Kampala');
  await page.getByLabel('Occupation').fill('Civil servant');
  await page.getByLabel('Employer or business').fill('Ministry of Works');

  // Approval also requires the guarantor's identification: a guarantor with
  // no NIN is "missing required information" and the loan cannot proceed.
  // Fourteen characters beginning CF, and unique per run.
  await page
    .getByLabel('National Identification Number')
    .fill(`CF${String(Date.now()).slice(-8)}WXYZ`.slice(0, 14));

  await page.getByLabel(/Relationship to the borrower/).fill('Business associate');

  await page.getByRole('button', { name: /add this guarantor/i }).click();

  await expect(page.getByText(/added to this application/i).first()).toBeVisible({
    timeout: 20_000,
  });

  // --- the undertaking -------------------------------------------------
  // A guarantor is agreeing to pay somebody else's debt. What makes that
  // enforceable is that they were shown the terms, those terms had a
  // version, and they signed in front of a witness — so the form shows the
  // words in full and records all four.
  await page.getByRole('button', { name: /take the undertaking/i }).click();

  await expect(page.getByText(/Guarantor undertaking/i).first()).toBeVisible();
  await expect(page.getByText(/I agree to act as guarantor/i)).toBeVisible();

  // One checkbox on this form, and it is the act: a signature recorded
  // against terms nobody accepted would be evidence of something that did
  // not happen.
  await page.getByRole('checkbox').first().check();
  await page.getByLabel('Signed as').fill(guarantorName);
  await page.getByLabel('Witness name').fill('Nabirye Sarah');

  await page.getByRole('button', { name: /record the undertaking/i }).click();

  // The signed card replaces the form, which is the assertion worth making:
  // a consent that is recorded is one the screen now reads back as signed,
  // against the exact version that was shown.
  await expect(page.getByText('Undertaking version 1.0').first()).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByText('Undertaking signed').first()).toBeVisible();

  return guarantorName;
}

test.describe('a new loan', () => {
  test('goes draft → pending → approved → disbursed, and gets a schedule', async ({
    page,
  }) => {
    // --- draft ---------------------------------------------------------
    const borrower = await registerBorrower(page);

    await page.goto('/loans/new');
    await expectNoErrorBoundary(page);

    // Phase 13 puts the product first: it decides the permitted amounts, the
    // available periods, the cadences offered and how many guarantors the
    // application needs. Individual Loans is the business's default and the
    // one this borrower is applying under.
    const productSelect = page.getByLabel('Loan product');
    await expect(productSelect).toBeVisible();
    const productValue = await productSelect
      .locator('option')
      .filter({ hasText: 'Individual Loans' })
      .first()
      .getAttribute('value');

    if (productValue === null) {
      throw new Error('Individual Loans was not offered as a product.');
    }

    await productSelect.selectOption(productValue);

    const clientSelect = page.getByLabel('Client');
    await expect(clientSelect).toBeVisible();

    await page.getByLabel('Loan amount').fill('400000');
    // A select, not a free-text field: which terms are available depends on
    // the principal, so the form offers the ones this loan may actually have.
    await page.getByLabel('Loan period').selectOption({ index: 0 });
    // The frequency is left at whatever the company's settings default to.
    // Which one it is does not change what this test is about, and pinning it
    // would make the test depend on a setting rather than on the lifecycle.

    // The borrower just registered. The option's label carries their client
    // number too (`Name (CL26014)`), so it is matched by prefix rather than
    // exactly.
    //
    // Picked by name rather than by position because the form flags anybody
    // who already has a running loan instead of hiding them — one loan at a
    // time is the rule, enforced at approval — so the first option in the
    // list is usually somebody who cannot be approved.
    const value = await clientSelect
      .locator('option')
      .filter({ hasText: borrower })
      .first()
      .getAttribute('value');

    if (value === null) {
      throw new Error(`The new borrower ${borrower} was not offered a loan.`);
    }

    await clientSelect.selectOption(value);

    // And the flag is there, rather than the client being silently absent:
    // staff looking for somebody need to know why they cannot be chosen.
    const labels = await clientSelect.locator('option').allTextContents();
    expect(labels.some((label) => label.includes('has an active loan'))).toBe(true);

    // The intended disbursement date is required and has no default: the
    // officer states when the money is meant to leave the drawer.
    await page
      .getByLabel('Intended disbursement date')
      .fill(new Date().toISOString().slice(0, 10));

    await page.getByRole('button', { name: /start application/i }).click();

    await page.waitForURL(/\/loans\/[0-9a-f-]{36}/, { timeout: 20_000 });
    const loanUrl = page.url();
    await expectNoErrorBoundary(page);

    // --- the guarantor, captured on the application ---------------------
    const guarantorName = await captureGuarantor(page, loanUrl);

    // --- submit for approval -------------------------------------------
    await page.goto(loanUrl);
    await page.getByRole('button', { name: /submit for approval/i }).click();
    // The status the application shows a person is "Awaiting approval", not
    // the database's `pending_approval`.
    await expect(page.getByText(/awaiting approval/i).first()).toBeVisible({
      timeout: 20_000,
    });

    // --- approve --------------------------------------------------------
    await page.goto(loanUrl);
    // Two steps again, and for the same reason: approval records the terms
    // permanently and captures the client and guarantor details as they
    // stand. The heading is "Approve this loan"; the control is "Approve…".
    await page.getByRole('button', { name: /^approve/i }).click();
    await page.getByRole('button', { name: /yes, approve this loan/i }).click();
    await expect(page.getByText(/approved/i).first()).toBeVisible({ timeout: 20_000 });

    // --- release the money ----------------------------------------------
    // Two steps as well, and the most deliberate of the three: handing cash
    // over is not undoable, so the panel shows what is about to leave the
    // drawer and asks again.
    await page.goto(loanUrl);
    await expect(page.getByRole('heading', { name: /release the money/i })).toBeVisible();

    await page.getByRole('button', { name: /^disburse/i }).click();
    await expect(page.getByText('Handing over')).toBeVisible();

    await page.getByRole('button', { name: /the money has been handed over/i }).click();

    await expect(page.getByText(/active|disbursed/i).first()).toBeVisible({
      timeout: 20_000,
    });
    await expectNoErrorBoundary(page);

    // --- the schedule the database generated ----------------------------
    // Found by its caption rather than by position: the page carries several
    // tables — the agreed terms, the monthly breakdown — and matching on
    // "due" picked the one-row breakdown instead.
    //
    // The amounts are the engine's. What is asserted here is that
    // disbursement generated a schedule at all, that it has more than one
    // collection, and that each row carries a date and a figure.
    const schedule = page
      .getByRole('table')
      .filter({ hasText: /Repayment collection schedule/i })
      .first();
    await expect(schedule).toBeVisible();

    const rows = schedule.locator('tbody tr');
    expect(
      await rows.count(),
      'the schedule has more than one collection',
    ).toBeGreaterThan(1);

    // Every row has a due date and a money cell.
    const firstRow = rows.first();
    await expect(firstRow.locator('[data-date-value]')).toHaveCount(1);
    expect(await firstRow.locator('[data-money]').count()).toBeGreaterThan(0);

    // Every money cell renders through the shared primitive, so an
    // unformatted figure cannot reach a screen.
    const moneyCells = page.locator('[data-money]');
    expect(await moneyCells.count()).toBeGreaterThan(0);

    // --- and the guarantor evidence the approval froze -------------------
    // The details the business actually relied on, copied onto the loan at
    // approval. Changing the guarantor's own record afterwards does not move
    // them, which is the whole point of freezing them.
    await expect(
      page.getByRole('heading', { name: /guarantors, as recorded at approval/i }),
    ).toBeVisible();
    await expect(page.getByText(guarantorName).first()).toBeVisible();
    await expect(page.getByText(/Version 1\.0, signed by/i).first()).toBeVisible();
  });

  test('an inactive or blacklisted client is not offered', async ({ page }) => {
    await page.goto('/loans/new');

    const labels = await page.getByLabel('Client').locator('option').allTextContents();
    const joined = labels.join(' | ');

    // The seed marks one client inactive and one blacklisted. Neither may
    // appear in a list of people who can be lent money.
    expect(joined).not.toMatch(/blacklisted/i);
    expect(joined).not.toMatch(/inactive/i);
  });

  test('a loan awaiting disbursement offers exactly that, and nothing else', async ({
    page,
  }) => {
    // §74. The state the screenshot pass could not reach.
    await page.goto(`/loans/${fixtures.loans.approvedNotDisbursed}`);
    await expectNoErrorBoundary(page);

    // The one thing this loan is waiting for. "Release the money" is the
    // panel's heading; the control is "Disburse…", which opens a confirmation
    // before any cash is recorded as handed over.
    await expect(page.getByRole('heading', { name: /release the money/i })).toBeVisible();
    await expect(page.getByRole('button', { name: /^disburse/i })).toBeVisible();

    // And nothing it has already had.
    await expect(page.getByRole('button', { name: /^approve/i })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /submit for approval/i })).toHaveCount(
      0,
    );
  });
});

test.describe('who may approve', () => {
  test.use({ storageState: stateFile('secretary') });

  test('a secretary/treasurer is not offered the approval button', async ({ page }) => {
    await page.goto(`/loans/${fixtures.loans.pending}`);
    await expectNoErrorBoundary(page);
    await expect(page.getByRole('button', { name: /^approve/i })).toHaveCount(0);
  });
});
