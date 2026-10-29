import {
  expect,
  expectNoErrorBoundary,
  fixtures,
  stateFile,
  test,
  watchForBrowserErrors,
} from './fixtures';

test.describe('policy implementation screens', () => {
  test.use({ storageState: stateFile('owner') });

  test('shows an undated draft and a read-only transition preview', async ({ page }) => {
    const browser = watchForBrowserErrors(page);
    await page.goto('/membership/policies/transitions');
    await expectNoErrorBoundary(page);
    await expect(page.getByRole('heading', { name: 'Policy transitions' })).toBeVisible();
    await expect(
      page.getByText('Activation date awaiting authorization.', { exact: true }),
    ).toBeVisible();
    await page.getByLabel('Target policy').selectOption({ label: 'Version 2.0 · draft' });
    await page.getByLabel('Proposed transition date').fill('2099-01-01');
    await page.getByRole('button', { name: 'Preview transition', exact: true }).click();
    await expect(
      page.getByText(/Preview only: this target is not approved/),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Open controlled transition batch' }),
    ).toHaveCount(0);
    await expect(
      page.getByRole('button', { name: "Apply this member's verified transition" }),
    ).toHaveCount(0);
    expect(browser.errors).toEqual([]);
  });

  test('shows live savings, loan restrictions and separate benefit gates', async ({
    page,
  }) => {
    await page.goto('/membership/' + fixtures.memberships.borrowing);
    await expectNoErrorBoundary(page);
    await expect(
      page.getByRole('heading', { name: 'Savings and borrowing position' }),
    ).toBeVisible();
    await expect(
      page.getByRole('heading', { name: 'Benefit eligibility and verification' }),
    ).toBeVisible();
    await expect(page.getByText('Outstanding loans', { exact: true })).toBeVisible();
    await expect(
      page.getByText(/Death confirmations required: 3 distinct other members/),
    ).toBeVisible();
  });

  test('keeps contractual dates visible beside collection periods', async ({ page }) => {
    await page.goto('/loans/' + fixtures.memberLoans.active);
    await expectNoErrorBoundary(page);
    await expect(
      page.getByRole('heading', { name: 'Installment carry-forward report' }),
    ).toBeVisible();
    await expect(
      page.getByRole('columnheader', { name: 'Contractual due date', exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole('columnheader', { name: 'Collection month', exact: true }),
    ).toBeVisible();
  });

  test('renders fine reporting and advance notices without viewport overflow', async ({
    page,
  }) => {
    await page.goto('/meetings/fines');
    await expectNoErrorBoundary(page);
    await expect(
      page.getByRole('heading', { name: /meeting fines/i }).first(),
    ).toBeVisible();
    await page.goto('/meetings/' + fixtures.meetings.upcoming);
    await expectNoErrorBoundary(page);
    await expect(
      page.getByRole('heading', { name: 'Advance absence notifications' }),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Record advance absence notice' }),
    ).toBeVisible();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);
  });
});

test.describe('policy management authorization', () => {
  test.use({ storageState: stateFile('secretary') });

  test('denies direct transition management access', async ({ page }) => {
    await page.goto('/membership/policies/transitions');
    await expectNoErrorBoundary(page);
    await expect(
      page.getByRole('button', { name: 'Record authorized date' }),
    ).toHaveCount(0);
    await expect(
      page.getByRole('heading', { name: 'Policy transitions', exact: true }),
    ).toHaveCount(0);
  });
});
