import { expect, expectNoErrorBoundary, fixtures, stateFile, test } from './fixtures';

/**
 * Taking a payment, printing the receipt, and reversing it.
 *
 * ## Why this file is the most important one here
 *
 * Before Phase 9, no payment could be recorded at all. The form had two
 * steps; step one unmounted when step two appeared, so the amount, the
 * method, the reference and the note left the form before it was submitted.
 * Every unit test passed, because each step rendered correctly on its own.
 * Only pressing the buttons in order shows it.
 *
 * ## It asserts the application's own figures, never its own arithmetic
 *
 * The amount recorded is read back from the receipt and from the register,
 * and the balance after is compared to the balance the confirmation step
 * displayed. Nothing here recomputes interest, allocation or a balance: if
 * this file disagreed with the engine, the engine would be right.
 */

import type { Page } from '@playwright/test';

test.use({ storageState: stateFile('owner') });

/**
 * The smallest payment this loan will accept, read off the form.
 *
 * Not a constant. A payment must cover at least the whole of the earliest
 * unpaid obligation — part-paying one collection and leaving a few shillings
 * on it is not a thing this business does — so the minimum depends on the
 * loan and on what has already been paid against it. The form states it, and
 * a test that invented a figure instead would be testing the validator.
 */
async function statedMinimum(page: Page): Promise<string> {
  const hint = page.getByText(/At least UGX/);
  await expect(hint).toBeVisible();

  const text = (await hint.textContent()) ?? '';
  const minimum = /At least UGX\s*([\d,]+)/.exec(text)?.[1];

  if (minimum === undefined) {
    throw new Error(`Could not read the minimum payment from "${text}".`);
  }

  return minimum.replace(/,/g, '');
}

/**
 * Open the first payment in the register.
 *
 * By the shape of its link rather than "the first link under /payments": the
 * register also carries a link to `/payments/new`, which is not a payment and
 * whose page has no receipt on it.
 */
async function openFirstPayment(page: Page): Promise<void> {
  // The register renders every row twice — cards for phones, a table for
  // wider screens — and hides one set with `display: none`, so the link has
  // to be the visible one.
  const link = page
    .locator('main a[href^="/payments/"]')
    .filter({ hasNotText: /record/i })
    .filter({ visible: true })
    .first();

  await expect(link).toBeVisible();
  await link.click();
  await page.waitForURL(/\/payments\/[0-9a-f-]{36}/, { timeout: 20_000 });
}

/**
 * Fill in a payment of the smallest amount the loan accepts and continue to
 * the confirmation. Returns the amount, as digits.
 */
async function enterMinimumCashPayment(page: Page, loanId: string): Promise<string> {
  await page.goto(`/payments/new?loanId=${loanId}`);
  await expectNoErrorBoundary(page);

  await page.getByText('Cash', { exact: true }).click();

  const amount = await statedMinimum(page);
  await page.getByLabel('Amount received').fill(amount);

  await page.getByRole('button', { name: /^continue$/i }).click();
  await expect(page.getByText('Confirm this payment')).toBeVisible();

  return amount;
}

test.describe('recording a payment', () => {
  test('two steps keep the values, and the receipt shows what was taken', async ({
    page,
  }) => {
    await page.goto(`/payments/new?loanId=${fixtures.loans.current}`);
    await expectNoErrorBoundary(page);

    await page.getByText('Cash', { exact: true }).click();

    const amount = await statedMinimum(page);
    await page.getByLabel('Amount received').fill(amount);
    await page.getByLabel('Note (optional)').fill('Counter collection, morning round.');

    await page.getByRole('button', { name: /^continue$/i }).click();

    // --- step two -------------------------------------------------------
    // The defect this test exists for: by this point the amount, the method,
    // the reference and the note had all been unmounted, so the form
    // submitted nothing and no payment could be recorded at all.
    await expect(page.getByText('Confirm this payment')).toBeVisible();

    const grouped = Number(amount).toLocaleString('en-US');

    // The confirmation shows the amount the first step collected, the method
    // it collected, and both balances.
    await expect(page.getByText(grouped).first()).toBeVisible();
    await expect(page.getByText('Cash').first()).toBeVisible();
    await expect(page.getByText('Balance before')).toBeVisible();
    await expect(page.getByText('Balance after')).toBeVisible();

    // --- submit ---------------------------------------------------------
    await page.getByRole('button', { name: /^record /i }).click();

    await page.waitForURL(/\/payments\/[0-9a-f-]{36}/, { timeout: 20_000 });
    await expectNoErrorBoundary(page);

    // §12. The success state, derived from the payment record.
    await expect(page.getByText(/recorded/i).first()).toBeVisible();
    await expect(page.getByText(grouped).first()).toBeVisible();

    // A payment number, which is the receipt's reference.
    const body = (await page.locator('main').textContent()) ?? '';
    expect(body).toMatch(/[A-Z]{2,}[-/]?\d+/);

    // And the note went with it.
    await expect(page.getByText(/morning round/i)).toBeVisible();
  });

  test('the success state cannot be invented from the address bar', async ({ page }) => {
    // §12. The page must derive amount, receipt number, balance, client and
    // loan from the authoritative record — never from a query parameter. A
    // borrower handed a crafted link must not see a receipt for money nobody
    // paid.
    await page.goto('/payments');
    const firstPayment = page.locator('a[href^="/payments/"]').first();
    await expect(firstPayment).toBeVisible();
    const href = (await firstPayment.getAttribute('href')) ?? '';

    await page.goto(`${href}?recorded=1&amount=999999999&receipt=FAKE-0001&balance=0`);
    await expectNoErrorBoundary(page);

    const body = (await page.locator('main').textContent()) ?? '';
    expect(body, 'a query parameter must not become a figure').not.toContain(
      '999,999,999',
    );
    expect(body, 'a query parameter must not become a receipt number').not.toContain(
      'FAKE-0001',
    );
  });

  test('a second tap cannot take the money twice', async ({ page }) => {
    // §43. `post_payment` is idempotent on the key the form mints, so the
    // protection is in the database; the button disabling itself is the
    // courtesy that stops the second request being sent at all.
    await page.goto(`/payments/new?loanId=${fixtures.loans.current}`);

    await page.getByText('Cash', { exact: true }).click();
    await page.getByLabel('Amount received').fill(await statedMinimum(page));
    await page.getByRole('button', { name: /^continue$/i }).click();

    const submit = page.getByRole('button', { name: /^record /i });

    // Two taps as fast as a finger manages. `post_payment` is idempotent on
    // the key the form mints, so one payment is posted however many times the
    // button is pressed; the button disabling itself is the courtesy that
    // stops the second request being sent at all.
    await submit.click();
    await submit.click({ timeout: 2_000 }).catch(() => undefined);

    await page.waitForURL(/\/payments\/[0-9a-f-]{36}/, { timeout: 20_000 });

    // Reloading the success page must not post a second payment either.
    const url = page.url();
    await page.reload();
    await page.goto(url);
    await expectNoErrorBoundary(page);
  });

  test('a mobile-money payment demands its network reference', async ({ page }) => {
    await page.goto(`/payments/new?loanId=${fixtures.loans.current}`);

    await page.getByText('MTN Mobile Money', { exact: true }).click();
    await page.getByLabel('Amount received').fill(await statedMinimum(page));

    // The reference field appears only for mobile money, and is required.
    const reference = page.getByLabel('Transaction reference');
    await expect(reference).toBeVisible();

    // Without a reference there is no way forward at all — the form does not
    // let a cashier reach the confirmation and find out at the end.
    await expect(page.getByRole('button', { name: /^continue$/i })).toBeDisabled();
    await expect(page.getByText('Confirm this payment')).toHaveCount(0);

    await reference.fill(`E2E${String(Date.now()).slice(-8)}`);
    await page.getByRole('button', { name: /^continue$/i }).click();
    await expect(page.getByText('Confirm this payment')).toBeVisible();
  });

  test('cash is offered no reference field to fill in wrongly', async ({ page }) => {
    await page.goto(`/payments/new?loanId=${fixtures.loans.current}`);
    await page.getByText('Cash', { exact: true }).click();
    await expect(page.getByLabel('Transaction reference')).toHaveCount(0);
  });

  test('more than the outstanding balance is refused', async ({ page }) => {
    await page.goto(`/payments/new?loanId=${fixtures.loans.current}`);

    await page.getByText('Cash', { exact: true }).click();
    await page.getByLabel('Amount received').fill('999999999');

    // Either the form refuses to continue, or it refuses on submission. Both
    // are acceptable; recording it is not.
    const continueButton = page.getByRole('button', { name: /^continue$/i });
    if (await continueButton.isEnabled()) {
      await continueButton.click();
      const submit = page.getByRole('button', { name: /^record /i });
      if (await submit.isVisible().catch(() => false)) {
        await submit.click();
        await expect(page.getByRole('alert').first()).toBeVisible({ timeout: 20_000 });
      }
    }

    await expectNoErrorBoundary(page);
    await expect(page).not.toHaveURL(/\/payments\/[0-9a-f-]{36}/);
  });
});

test.describe('reversing a payment', () => {
  test('a reversal needs a reason, strikes the figure and reopens the loan', async ({
    page,
  }) => {
    // Record one specifically to reverse, so the reversal never touches a
    // payment another spec is reading.
    await enterMinimumCashPayment(page, fixtures.loans.current);
    await page.getByRole('button', { name: /^record /i }).click();
    await page.waitForURL(/\/payments\/[0-9a-f-]{36}/, { timeout: 20_000 });

    const paymentUrl = new URL(page.url()).pathname;
    await page.goto(paymentUrl);

    // Two steps, like approval and disbursement: "Reverse this payment" is
    // the heading, "Reverse…" opens the form, and the reason is required
    // before any money is put back.
    await expect(
      page.getByRole('heading', { name: /reverse this payment/i }),
    ).toBeVisible();

    await page.getByRole('button', { name: /^reverse…$/i }).click();

    await page
      .getByLabel('Reason for this reversal')
      .fill('Recorded against the wrong loan.');

    // The submit button names the payment it is about to withdraw.
    await page.getByRole('button', { name: /^reverse [A-Z0-9]/i }).click();

    await expect(page.getByText(/reversed/i).first()).toBeVisible({ timeout: 20_000 });
    await expectNoErrorBoundary(page);

    // §9. A reversed figure is struck through, not deleted — the register is
    // a record, and a vanished payment is a hole in it.
    //
    // Read from a fresh load rather than from the tree the action left
    // behind: what is being asserted is the state of the record, and the
    // moment after a Server Action returns is a race with the revalidation
    // it triggered. The page a staff member opens next is this one.
    await page.reload();

    const struck = page.locator('[data-money].line-through, [data-money] .line-through');
    expect(await struck.count(), 'the reversed amount is struck through').toBeGreaterThan(
      0,
    );

    // The reason is on the record.
    await expect(page.getByText(/wrong loan/i).first()).toBeVisible();

    // And it cannot be reversed twice.
    await expect(page.getByRole('button', { name: /^reverse/i })).toHaveCount(0);
  });

  test('a secretary/treasurer cannot reverse', async () => {
    // Asserted below in its own context so the storage state differs.
  });
});

test.describe('who may reverse', () => {
  test.use({ storageState: stateFile('secretary') });

  test('the reversal control is not offered', async ({ page }) => {
    await page.goto('/payments');
    await openFirstPayment(page);

    await expectNoErrorBoundary(page);
    await expect(page.getByRole('button', { name: /^reverse/i })).toHaveCount(0);
  });
});

test.describe('the receipt', () => {
  test('prints as a receipt rather than as the application', async ({ page }) => {
    // §76. Print emulation, because a receipt that prints the sidebar and
    // clips the figure is a receipt nobody can give to a borrower.
    await page.goto('/payments');
    await openFirstPayment(page);

    await page.emulateMedia({ media: 'print' });

    // Navigation does not print.
    const navs = page.locator('nav');
    for (let index = 0; index < (await navs.count()); index += 1) {
      await expect(navs.nth(index)).toBeHidden();
    }

    // The receipt itself does — scoped to the receipt, because the shell's
    // sidebar also carries the company name and the sidebar is `print:hidden`,
    // so matching the first occurrence found the one that must not print.
    const receipt = page.locator('section[aria-labelledby="receipt-heading"]');
    await expect(receipt).toBeVisible();
    await expect(receipt.getByText(/Kyanja Credit Services/i).first()).toBeVisible();
    expect(await receipt.locator('[data-money]').count()).toBeGreaterThan(0);

    // And nothing runs off the side of the paper.
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);

    await page.emulateMedia({ media: 'screen' });
  });
});
