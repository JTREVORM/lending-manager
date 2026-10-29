import { expect, expectNoErrorBoundary, fixtures, stateFile, test } from './fixtures';

test.describe('advance absence review', () => {
  test.use({ storageState: stateFile('secretary') });

  test('records a real member notice and requires a different officer to review it', async ({
    page,
    browser,
  }) => {
    await page.goto('/meetings/' + fixtures.meetings.upcoming);
    await page
      .getByLabel('Member reporting absence')
      .selectOption(fixtures.memberships.applying);
    await page.getByLabel('Reason category').selectOption('illness');
    await page
      .getByLabel('Reason reported by the member')
      .fill('Browser test: scheduled clinic appointment');
    await page.getByLabel('How the notice arrived').selectOption('telephone');
    await page.getByRole('button', { name: 'Record advance absence notice' }).click();
    await expect(page.getByText('Recorded successfully.', { exact: true })).toBeVisible();
    await expect(
      page.getByText('Browser test: scheduled clinic appointment', { exact: false }),
    ).toBeVisible();
    await expectNoErrorBoundary(page);

    const context = await browser.newContext({ storageState: stateFile('owner') });
    try {
      const reviewer = await context.newPage();
      await reviewer.goto('/meetings/' + fixtures.meetings.upcoming);
      const notice = reviewer
        .getByRole('listitem')
        .filter({ hasText: 'Browser test: scheduled clinic appointment' });
      await notice.getByLabel('Excuse decision').selectOption('approved');
      await notice
        .getByLabel('Review reason')
        .fill('Clinic appointment accepted by independent reviewer');
      await notice.getByRole('button', { name: 'Record excuse decision' }).click();
      await expect(notice.getByText(/approved/).first()).toBeVisible();
      await expect(
        notice.getByRole('button', { name: 'Record excuse decision' }),
      ).toHaveCount(0);
      await expectNoErrorBoundary(reviewer);
    } finally {
      await context.close();
    }
  });
});

test.describe('fine receipt and contra correction', () => {
  test.use({ storageState: stateFile('owner') });

  test('collects a partial receipt and reverses it without deleting its history', async ({
    page,
  }) => {
    await page.goto('/meetings/fines/' + fixtures.fines.unpaid);
    await expectNoErrorBoundary(page);
    await expect(page.getByText('No money has been collected.')).toBeVisible();
    await page.getByLabel('Amount received (UGX)').fill('3000');
    await page.getByLabel('Payment method', { exact: true }).selectOption('cash');
    await page.getByRole('button', { name: 'Record fine payment', exact: true }).click();
    await expect(
      page.getByRole('button', { name: 'Reverse this receipt' }),
    ).toBeVisible();
    await page.reload();
    await page
      .getByLabel('Receipt reversal reason')
      .fill('Browser test: payment attributed to wrong member');
    await page.getByRole('button', { name: 'Reverse this receipt' }).click();
    await expect(
      page.getByText(/Browser test: payment attributed to wrong member/),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Reverse this receipt' })).toHaveCount(
      0,
    );
    await expect(
      page.getByRole('button', { name: 'Record fine payment', exact: true }),
    ).toBeVisible();
    await expectNoErrorBoundary(page);
    await page.goto('/meetings/fines');
    await expect(
      page.getByText('Fine collections reconcile to the General Ledger.'),
    ).toBeVisible();
  });
});
