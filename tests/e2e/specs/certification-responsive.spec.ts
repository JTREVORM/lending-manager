import {
  expect,
  expectNoErrorBoundary,
  fixtures,
  stateFile,
  test,
  watchForBrowserErrors,
} from './fixtures';

test.describe('operational certification responsive routes', () => {
  test.use({ storageState: stateFile('owner') });

  const routes = [
    '/membership/enrol',
    '/membership/' + fixtures.memberships.borrowing,
    '/membership/policies/transitions',
    '/savings/' + fixtures.savings.qualified,
    '/member-loans',
    '/loans/' + fixtures.memberLoans.active,
    '/benefits/claims/new',
    '/benefits/claims/' + fixtures.benefitClaims.paid,
    '/meetings/' + fixtures.meetings.upcoming,
    '/meetings/fines/' + fixtures.fines.unpaid,
    '/finance/ledger',
    '/finance/trial-balance',
    '/finance/reconciliation',
  ];

  for (const path of routes) {
    test('renders without page overflow or runtime errors: ' + path, async ({ page }) => {
      const browser = watchForBrowserErrors(page);
      const response = await page.goto(path);
      expect(response?.status()).toBe(200);
      await expect(page).toHaveURL(path);
      await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
      await expectNoErrorBoundary(page);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow).toBeLessThanOrEqual(1);
      expect(browser.errors).toEqual([]);
    });
  }
});
