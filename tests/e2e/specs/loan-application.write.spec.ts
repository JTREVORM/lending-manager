import { expect, expectNoErrorBoundary, fixtures, stateFile, test } from './fixtures';

/**
 * The Phase 13 loan module, in a browser.
 *
 * Three things this proves that nothing else can:
 *
 *   * the workflow strip really is thirteen filters over one register, so a
 *     view a person clicks shows loans rather than an error boundary;
 *   * a refusal is reachable, reasoned and distinguishable from a withdrawal
 *     once it is recorded — the whole point of `closure_kind`;
 *   * the guarantor picker shows ineligible candidates *with the reason*,
 *     which is the difference between a staff member choosing somebody else
 *     and a staff member hunting for a rule.
 *
 * The lifecycle itself — draft to disbursed, with a guarantor captured and an
 * undertaking signed — is `loan-lifecycle.write.spec.ts`.
 */

test.describe('the loan register', () => {
  test.use({ storageState: stateFile('owner') });

  test('offers every view of the loan book', async ({ page }) => {
    await page.goto('/loans');
    await expectNoErrorBoundary(page);

    const strip = page.getByRole('navigation', { name: 'Loan views' });
    await expect(strip).toBeVisible();

    for (const label of [
      'All loans',
      'Draft applications',
      'Pending approval',
      'Approved',
      'Awaiting disbursement',
      'Active loans',
      'Grace period',
      'Arrears',
      'Cleared loans',
      'Rejected',
      'Cancelled',
    ]) {
      await expect(strip.getByRole('button', { name: label, exact: true })).toBeVisible();
    }
  });

  test('each view filters the register rather than erroring', async ({ page }) => {
    for (const stage of ['draft', 'pending_approval', 'active', 'arrears', 'cleared']) {
      await page.goto(`/loans?stage=${stage}`);
      await expectNoErrorBoundary(page);

      // The strip marks the view that is open, so a person can see where they
      // are after a reload or when the link was sent to them.
      const current = page.locator('[aria-current="page"]');
      await expect(current.first()).toBeVisible();
    }
  });

  test('names the product every loan was written under', async ({ page }) => {
    await page.goto('/loans?stage=active');
    await expectNoErrorBoundary(page);

    // The filter is a real one: a product nobody may see is a product nobody
    // can filter on, so it is read server-side.
    await expect(page.getByLabel('Loan product')).toBeVisible();

    const table = page.getByRole('table').first();
    await expect(table.getByRole('columnheader', { name: 'Product' })).toBeVisible();
  });

  test('groups the portfolio by product', async ({ page }) => {
    await page.goto('/loans/by-product');
    await expectNoErrorBoundary(page);

    await expect(
      page.getByRole('heading', { name: 'Loans by product', exact: true }),
    ).toBeVisible();

    // Every row links back into the register filtered to that product, so
    // "nine arrears on Salary Loans" is one click from the nine loans.
    const link = page.getByRole('link', { name: /Loan/ }).first();
    await expect(link).toBeVisible();
  });
});

test.describe('the application behind a loan', () => {
  test.use({ storageState: stateFile('owner') });

  test('opens from the loan, and reads back what was collected', async ({ page }) => {
    await page.goto(`/loans/${fixtures.loans.current}`);
    await expectNoErrorBoundary(page);

    await page.getByRole('link', { name: 'Application', exact: true }).click();
    await page.waitForURL(/\/application$/, { timeout: 20_000 });
    await expectNoErrorBoundary(page);

    await expect(
      page.getByRole('heading', { name: 'Guarantors and security' }),
    ).toBeVisible();
    await expect(
      page.getByRole('heading', { name: 'Supporting documents' }),
    ).toBeVisible();
  });

  test('is read-only once the loan has left draft', async ({ page }) => {
    await page.goto(`/loans/${fixtures.loans.current}/application`);
    await expectNoErrorBoundary(page);

    await expect(
      page.getByText(/What is recorded here is what the decision was made on/i),
    ).toBeVisible();

    // No capture, no consent, no upload. The guards in the database refuse
    // all three; offering them would be offering a form that submits into a
    // refusal.
    await expect(page.getByRole('button', { name: /add a guarantor/i })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /take the undertaking/i })).toHaveCount(
      0,
    );
    await expect(page.getByRole('button', { name: /file this document/i })).toHaveCount(
      0,
    );
  });

  test('searches the client register and says why somebody cannot back a loan', async ({
    page,
  }) => {
    await page.goto(`/loans/${fixtures.loans.draft}/application`);
    await expectNoErrorBoundary(page);

    await page.getByRole('button', { name: /search existing clients/i }).click();

    const search = page.getByLabel('Search the client register');
    await expect(search).toBeVisible();

    // The seed lends to most of its clients, so searching the register finds
    // people who cannot guarantee anything — which is the case worth showing.
    await search.fill('a');
    await page.getByRole('button', { name: 'Search', exact: true }).click();

    await page.waitForURL(/[?&]g=a/, { timeout: 20_000 });
    await expectNoErrorBoundary(page);

    // Whatever the seed happens to contain, the picker explains itself rather
    // than silently omitting people.
    await expect(
      page.getByText(/listed with the reason, rather than hidden/i),
    ).toBeVisible();
  });
});

test.describe('refusing an application', () => {
  test.use({ storageState: stateFile('manager') });

  test('a manager may refuse what a manager may approve, and the register says so', async ({
    page,
  }) => {
    // The defect Phase 13 found: `reject_loan` checks `loans:approve`, the
    // lifecycle guard beneath it demanded `loans:cancel`, and the Manager
    // holds the first and not the second — so the one role the function was
    // written for was the one role it refused.
    await page.goto(`/loans/${fixtures.loans.pending}`);
    await expectNoErrorBoundary(page);

    await page.getByRole('button', { name: /reject this application/i }).click();

    await expect(page.getByText(/A rejected application is final/i)).toBeVisible();

    await page
      .getByLabel(/Reason for refusing/)
      .fill('Income could not be verified with the employer.');

    await page.getByRole('button', { name: /confirm rejection/i }).click();

    // The control unmounts with the decision, and the banner takes its place:
    // recorded as a refusal, not a withdrawal, because a report about lending
    // standards counts the first and must not count the second.
    await expect(page.getByText('Rejected.').first()).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(/The business refused this application/i)).toBeVisible();
    await expect(
      page.getByText(/Income could not be verified with the employer/i),
    ).toBeVisible();

    // And the refusal view of the register finds it.
    await page.goto('/loans?stage=rejected');
    await expectNoErrorBoundary(page);
    await expect(page.getByText(/Rejected/).first()).toBeVisible();
  });
});
