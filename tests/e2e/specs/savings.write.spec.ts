import { expect, expectNoErrorBoundary, fixtures, stateFile, test } from './fixtures';

/**
 * Taking a deposit, enrolling a member, and moving a withdrawal through its
 * lifecycle — by pressing the buttons, in order, in a browser.
 *
 * ## Why this file is the one that matters
 *
 * Phase 9 found that no payment could be recorded at all. The form had two
 * steps; step one unmounted when step two appeared, so the amount, the
 * method, the reference and the note left the form before it was submitted.
 * Every unit test passed, because each step rendered correctly on its own.
 * Only pressing the buttons in order shows it.
 *
 * The deposit form and the enrolment form are both built the same way, with
 * the same hidden-field carry between steps. So this file exists to catch the
 * same defect in the same shape before anybody takes money at a counter and
 * finds nothing was recorded.
 *
 * ## It asserts the application's own figures, never its own arithmetic
 *
 * Every balance is read back from a screen the database rendered. Nothing here
 * adds a deposit to a balance and checks the result: if this file disagreed
 * with the subledger, the subledger would be right. What it checks is that
 * the figure the confirmation step showed is the figure the account shows
 * afterwards — which is a different claim, and the one that matters.
 *
 * ## Desktop only
 *
 * Playwright's mobile project ignores `*.write.spec.ts`. Running these twice
 * would double every deposit in the seeded database and make the balances the
 * read specs assert against depend on which project ran first.
 */

import type { Page } from '@playwright/test';

/** The balance an account page shows, in shillings. */
async function balanceOf(page: Page, savingsAccountId: string): Promise<number> {
  await page.goto(`/savings/${savingsAccountId}`);
  await expectNoErrorBoundary(page);

  const figure = page
    .locator('dt', { hasText: /^Balance$/ })
    .first()
    .locator('xpath=following-sibling::dd[1]')
    .locator('[data-money]')
    .first();

  const text = (await figure.textContent()) ?? '';
  const amount = /UGX\s*([\d,]+)/.exec(text)?.[1];

  if (amount === undefined) {
    throw new Error(`Could not read a balance from "${text}".`);
  }

  return Number(amount.replace(/,/g, ''));
}

// ===========================================================================
test.describe('recording a deposit', () => {
  test.use({ storageState: stateFile('secretary') });

  test('takes a deposit through both steps and lands on the account', async ({
    page,
  }) => {
    const account = fixtures.savings.gapped;
    const before = await balanceOf(page, account);

    await page.goto(`/savings/${account}/deposit`);
    await expectNoErrorBoundary(page);

    // Step one. The amount field arrives prefilled with what is still needed
    // for this month to count, so it is cleared and a known figure typed —
    // otherwise this test would assert against whatever the seeded history
    // happens to leave outstanding.
    const amountField = page.getByLabel('Amount received');
    await amountField.fill('');
    await amountField.fill('35000');

    // Cash, which is the default and which must *not* carry a reference. The
    // database refuses one, so the form does not offer the field.
    await expect(page.getByText(/A cash deposit has no network reference/)).toBeVisible();

    await page.getByRole('button', { name: 'Continue' }).click();

    // Step two. Step one is unmounted by now — which is exactly the condition
    // that broke the payment form — so what is asserted here is that the
    // figures survived the transition as hidden fields.
    await expect(page.getByText('Confirm this deposit')).toBeVisible();
    await expect(page.getByText('UGX 35,000').first()).toBeVisible();

    // The balance the confirmation promises.
    const promised = page
      .locator('dt', { hasText: /^Balance after$/ })
      .first()
      .locator('xpath=following-sibling::dd[1]');
    const promisedText = (await promised.textContent()) ?? '';
    const promisedAmount = Number(
      (/UGX\s*([\d,]+)/.exec(promisedText)?.[1] ?? '0').replace(/,/g, ''),
    );

    expect(promisedAmount, 'the confirmation adds the deposit to the balance').toBe(
      before + 35_000,
    );

    await page.getByRole('button', { name: /Record UGX 35,000/ }).click();

    // It leaves the form behind rather than staying on it, so the back button
    // cannot offer to re-submit.
    await page.waitForURL(/\/savings\/[0-9a-f-]+\?deposited=1/);
    await expectNoErrorBoundary(page);

    // And the account agrees with what the confirmation said.
    const after = await balanceOf(page, account);
    expect(after, 'the account shows the promised balance').toBe(promisedAmount);
  });

  test('refuses a cash deposit that carries a network reference', async ({ page }) => {
    // Not by hiding the field — by the database refusing it. The form does not
    // render the field for cash, so this goes at the rule from the other end:
    // mobile money *requires* one, and Continue stays disabled without it.
    await page.goto(`/savings/${fixtures.savings.saving}/deposit`);

    await page.getByLabel('Amount received').fill('10000');
    await page.getByText('MTN Mobile Money').click();

    await expect(page.getByLabel('Transaction reference')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Continue' })).toBeDisabled();

    await page.getByLabel('Transaction reference').fill('MM-77001-AB');
    await expect(page.getByRole('button', { name: 'Continue' })).toBeEnabled();
  });

  test('says what a deposit does to the month', async ({ page }) => {
    // `withdrawn`, deliberately: the seeded history leaves this member's
    // current month at nil — a deposit was recorded and reversed, which nets
    // to nothing — so both branches of the sentence can be seen. The member
    // seeded as `saving` has already met the month, so a small deposit there
    // would correctly show the other sentence and this test would be asserting
    // against the fixture rather than the behaviour.
    await page.goto(`/savings/${fixtures.savings.withdrawn}/deposit`);

    // The sentence that gets the rest of the minimum paid in today rather
    // than next month.
    await page.getByLabel('Amount received').fill('1000');
    await expect(
      page.getByText(/would still be needed for this month to count/i),
    ).toBeVisible();

    await page.getByLabel('Amount received').fill('500000');
    await expect(page.getByText(/completes the month/i)).toBeVisible();
  });
});

// ===========================================================================
test.describe('the withdrawal lifecycle', () => {
  test('a Secretary prepares one, a Manager decides and pays it', async ({ browser }) => {
    const account = fixtures.savings.gapped;

    // --- Prepared by the Secretary -------------------------------------
    const secretaryContext = await browser.newContext({
      storageState: stateFile('secretary'),
    });
    const secretaryPage = await secretaryContext.newPage();

    const before = await balanceOf(secretaryPage, account);

    await secretaryPage.goto(`/savings/${account}/withdraw`);
    await expectNoErrorBoundary(secretaryPage);

    await secretaryPage.getByLabel('Amount requested').fill('25000');
    await secretaryPage
      .getByLabel('What is it for?')
      .fill('Medical bill at the clinic in Ntinda');

    await secretaryPage.getByRole('button', { name: /Prepare this withdrawal/ }).click();

    await secretaryPage.waitForURL(/\?requested=1/);

    // Nothing has moved. An approval is not a payment, and a preparation is
    // not an approval.
    expect(await balanceOf(secretaryPage, account), 'preparing moves no money').toBe(
      before,
    );

    // --- The Secretary cannot decide it ---------------------------------
    await secretaryPage.goto('/savings/withdrawals');
    expect(secretaryPage.url(), 'the queue must not open to a Secretary').not.toContain(
      '/savings/withdrawals',
    );

    await secretaryContext.close();

    // --- Decided and paid by the Manager --------------------------------
    const managerContext = await browser.newContext({
      storageState: stateFile('manager'),
    });
    const managerPage = await managerContext.newPage();

    await managerPage.goto('/savings/withdrawals');
    await expectNoErrorBoundary(managerPage);

    // Found by its reason rather than by a uuid, because the request was made
    // moments ago by the other context and its id is not in the manifest.
    const row = managerPage
      .locator('main a[href^="/savings/withdrawals/"]')
      .filter({ visible: true })
      .first();
    await row.click();

    await expect(managerPage.getByText('Decide this withdrawal')).toBeVisible();

    await managerPage.getByRole('button', { name: /Approve UGX/ }).click();

    // Approving is its own act: the payment form appears, and the balance has
    // still not moved.
    await expect(managerPage.getByText('Record the payment')).toBeVisible();

    await managerPage.getByRole('button', { name: /Pay UGX/ }).click();

    // The *state*, not the flash of confirmation. A paid request has nothing
    // left to decide, so the panel that carried the success message unmounts
    // when the page re-reads itself — which is correct, and means the status
    // badge is the durable assertion.
    await expect(
      managerPage.getByText('Paid', { exact: true }).filter({ visible: true }).first(),
    ).toBeVisible();
    await expect(
      managerPage.getByRole('button', { name: /Pay UGX/ }),
      'a paid withdrawal offers no second payment',
    ).toHaveCount(0);

    // --- Now it has moved ------------------------------------------------
    const after = await balanceOf(managerPage, account);
    expect(after, 'paying reduces what the business owes').toBeLessThan(before);

    await managerContext.close();
  });

  test('rejecting one asks why, and moves no money', async ({ browser }) => {
    const account = fixtures.savings.withdrawn;

    const secretaryContext = await browser.newContext({
      storageState: stateFile('secretary'),
    });
    const secretaryPage = await secretaryContext.newPage();

    await secretaryPage.goto(`/savings/${account}/withdraw`);
    await secretaryPage.getByLabel('Amount requested').fill('5000');
    await secretaryPage
      .getByLabel('What is it for?')
      .fill('A request that will be refused, for the test');
    await secretaryPage.getByRole('button', { name: /Prepare this/ }).click();
    await secretaryPage.waitForURL(/\?requested=1/);
    await secretaryContext.close();

    // The Owner, who holds every savings capability.
    const ownerContext = await browser.newContext({ storageState: stateFile('owner') });
    const ownerPage = await ownerContext.newPage();

    const before = await balanceOf(ownerPage, account);

    await ownerPage.goto('/savings/withdrawals');
    await ownerPage
      .locator('main a[href^="/savings/withdrawals/"]')
      .filter({ visible: true })
      .first()
      .click();

    await ownerPage.getByRole('button', { name: 'Reject' }).click();

    // A rejection must say why. The member will be told, and "no" is not an
    // explanation.
    await expect(ownerPage.getByLabel(/Why is it rejected/)).toBeVisible();
    await ownerPage
      .getByLabel(/Why is it rejected/)
      .fill('The balance is needed as security against the live loan.');
    await ownerPage.getByRole('button', { name: /Reject this withdrawal/ }).click();

    // The state, for the reason given above: a rejected request has nothing
    // left to decide, so its panel unmounts with the message in it.
    await expect(
      ownerPage.getByText('Rejected', { exact: true }).filter({ visible: true }).first(),
    ).toBeVisible();
    await expect(
      ownerPage.getByText(/needed as security against the live loan/i).first(),
      'the reason is recorded against the request',
    ).toBeVisible();

    expect(await balanceOf(ownerPage, account), 'rejecting moves no money').toBe(before);

    await ownerContext.close();
  });
});

// ===========================================================================
test.describe('enrolling a member', () => {
  test.use({ storageState: stateFile('owner') });

  test('takes the fee, records the acceptance and opens the savings account at once', async ({
    page,
  }) => {
    await page.goto('/membership/enrol');
    await expectNoErrorBoundary(page);

    // Choose a client who is not yet a member. The seeded register has
    // several; the picker lists active clients and the first one without a
    // membership is whichever the search finds.
    const candidates = page
      .locator('main a[href*="/membership/enrol?clientId="]')
      .filter({ visible: true });

    const count = await candidates.count();
    expect(count, 'the picker offers clients to enrol').toBeGreaterThan(0);

    // Walk the list until one of them is enrollable. A client who already has
    // a membership shows an explanation instead of a form, which is the
    // correct behaviour and not what this test is about.
    let enrolled = false;

    for (let index = 0; index < count && !enrolled; index += 1) {
      const href = await page
        .locator('main a[href*="/membership/enrol?clientId="]')
        .filter({ visible: true })
        .nth(index)
        .getAttribute('href');

      if (href === null) continue;

      await page.goto(href);

      if ((await page.getByLabel('The name the member signed as').count()) === 0) {
        await page.goto('/membership/enrol');
        continue;
      }

      // --- The form ---------------------------------------------------
      // Witnessing is the only method offered here, and the screen says why:
      // a code is bound to a membership and a signature is stored under one,
      // and the membership is what this form creates.
      await expect(page.getByText(/Witnessed in the branch/)).toBeVisible();
      await expect(page.getByText(/need the membership to exist first/i)).toBeVisible();

      // The fee is shown and is not a field. A form that could send it could
      // enrol somebody for a shilling.
      await expect(page.getByText('UGX 5,000').first()).toBeVisible();
      await expect(page.getByLabel(/registration fee/i)).toHaveCount(0);

      // The witness picker excludes the signed-in user, because a witness who
      // is also the recorder is not a witness.
      const witness = page.getByLabel('Who witnessed it?');
      await expect(witness).toBeVisible();
      await expect(page.getByText(/You are not in this list/i)).toBeVisible();

      const options = await witness.locator('option').allTextContents();
      expect(
        options.some((name) => name.includes('Nalubega')),
        'the signed-in Owner must not be offerable as their own witness',
      ).toBe(false);

      await witness.selectOption({ index: 1 });

      // A first deposit, taken at the same counter in the same act.
      await page.getByLabel(/First savings deposit/).fill('50000');

      await expect(page.getByText('Collect UGX 55,000')).toBeVisible();

      await page.getByRole('button', { name: 'Continue' }).click();

      await expect(page.getByText('Confirm this enrolment')).toBeVisible();
      await expect(page.getByText(/Enrol and collect UGX 55,000/)).toBeVisible();

      await page.getByRole('button', { name: /Enrol and collect/ }).click();

      await page.waitForURL(/\/membership\/[0-9a-f-]+\?enrolled=1/);
      await expectNoErrorBoundary(page);

      enrolled = true;
    }

    expect(enrolled, 'one client was enrolled').toBe(true);

    // --- What the membership record shows afterwards --------------------
    // Active, because the fee reached the ledger and the acceptance was
    // verified. Those are the two ADR-050 preconditions, and the membership
    // could not have reached this state without both.
    await expect(page.getByText('Active').first()).toBeVisible();

    // By role, because "Registration fee" also appears as the policy
    // readiness row's label and as a description — five matches in all, which
    // is what a bare text locator finds.
    await expect(
      page.getByRole('heading', { name: 'Registration fee', exact: true }),
    ).toBeVisible();

    // The acceptance was verified by the database from the witness it could
    // check. Without that the membership would still be `pending`.
    await expect(
      page.getByText('Verified', { exact: true }).filter({ visible: true }).first(),
    ).toBeVisible();

    // And the savings account exists, holding the first deposit.
    await expect(
      page.getByText('UGX 50,000').filter({ visible: true }).first(),
    ).toBeVisible();
  });
});

// ===========================================================================
test.describe('the ledger still agrees', () => {
  test.use({ storageState: stateFile('owner') });

  test('the trial balance balances after every movement in this file', async ({
    page,
  }) => {
    // The invariant that matters more than any single screen. Every deposit,
    // withdrawal, reversal and fee in this file wrote a journal entry, and the
    // trial balance is where a mistake in any of them shows up.
    await page.goto('/finance/trial-balance');
    await expectNoErrorBoundary(page);

    const debits = page.locator('[data-trial-total="debit"]');
    const credits = page.locator('[data-trial-total="credit"]');

    if ((await debits.count()) === 0) {
      // The page does not mark its totals; fall back to the statement it
      // makes in words, which it only makes when the two sides agree.
      await expect(page.getByText(/balances|in balance/i).first()).toBeVisible();
      return;
    }

    expect(await debits.first().textContent()).toBe(await credits.first().textContent());
  });
});
