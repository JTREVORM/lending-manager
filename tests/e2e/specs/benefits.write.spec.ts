import { expect, expectNoErrorBoundary, fixtures, stateFile, test } from './fixtures';

/**
 * Approving a benefit, paying it, and marking a register — by pressing the
 * buttons, in order, in a browser.
 *
 * ## Why this file is the one that matters
 *
 * Phase 9 found that no payment could be recorded at all: the form had two
 * steps, step one unmounted when step two appeared, and every field left the
 * form before it was submitted. Every unit test passed, because each step
 * rendered correctly on its own.
 *
 * The screens here are built from the same pieces — a collapsed form revealed
 * on request, a hidden field carrying an idempotency key minted when the page
 * rendered — so this file exists to catch that shape of defect before
 * somebody tells a bereaved family their benefit was paid and nothing was.
 *
 * ## It asserts the application's own figures, never its own arithmetic
 *
 * Every amount is read back from a screen the database rendered. Nothing here
 * computes 5% of anything: if this file disagreed with the ledger, the ledger
 * would be right. What it checks is that the figure the claim showed before
 * the approval is the figure the payment shows afterwards.
 *
 * ## Desktop only
 *
 * Playwright's mobile project ignores `*.write.spec.ts`. Running these twice
 * would pay the same benefit twice — or rather, it would try, and
 * `post_benefit_payment` would refuse the second: the claim is `paid` by
 * then. Either way the read specs' figures would depend on which project ran
 * first.
 */

// ===========================================================================
test.describe('approving and paying a benefit', () => {
  test.use({ storageState: stateFile('owner') });

  test('approves the assessed figure, then pays it, and the ledger agrees', async ({
    page,
  }) => {
    // --- Before -------------------------------------------------------------
    await page.goto('/benefits/reports');
    await expectNoErrorBoundary(page);

    const paidBefore = await readTotalPaid(page);

    // --- Approve ------------------------------------------------------------
    await page.goto(`/benefits/claims/${fixtures.benefitClaims.toApprove}`);
    await expectNoErrorBoundary(page);

    // An approver agrees to the assessed figure or refuses the claim. There is
    // no amount field, by design — a partial approval would be a second
    // assessment performed by somebody who did not assess.
    await expect(page.getByText(/Waiting for approval/).first()).toBeVisible();

    await page.getByRole('button', { name: /^Approve the assessed amount/ }).click();
    await page.getByRole('button', { name: /^Approve the assessed amount/ }).click();

    await expect(page.getByText(/Waiting for payment/).first()).toBeVisible();

    // --- Pay ----------------------------------------------------------------
    //
    // As the Owner, who holds `benefits:pay` as well — the separation this
    // phase enforces is between assessing and approving, and the Manager
    // assessed this claim in the harness.
    await expect(page.getByText(/Pay this benefit/)).toBeVisible();

    // The payee is shown and cannot be changed: `post_benefit_payment` reads
    // the recipient from the assessment snapshot the approver agreed to.
    await expect(page.getByText(/Read from the assessment/)).toBeVisible();
    await expect(page.getByLabel(/payee/i)).toHaveCount(0);

    await page.getByRole('button', { name: /Record the payment/ }).click();

    await expect(page.getByText(/This benefit has been paid/).first()).toBeVisible();

    // --- After --------------------------------------------------------------
    await page.goto('/benefits/reports');
    await expectNoErrorBoundary(page);

    const paidAfter = await readTotalPaid(page);

    expect(
      paidAfter - paidBefore,
      'the report must have grown by exactly the approved amount',
    ).toBe(fixtures.benefitClaims.toApproveAmount);

    // And the two independent paths to that figure still agree: the payment
    // records on one side, the General Ledger on the other.
    await expect(
      page.getByText(/payment records and the General Ledger agree/i).first(),
    ).toBeVisible();
  });

  test('refuses to pay the same claim twice', async ({ page }) => {
    // The claim paid above. A second payment is refused by state, and the
    // screen no longer offers the control at all — the key minted when the
    // form rendered is what makes a retry safe, and the absent button is the
    // courtesy on top of it.
    await page.goto(`/benefits/claims/${fixtures.benefitClaims.toApprove}`);
    await expectNoErrorBoundary(page);

    await expect(page.getByRole('button', { name: /Record the payment/ })).toHaveCount(0);
  });
});

// ===========================================================================
test.describe('a held claim cannot be approved without its required evidence', () => {
  test.use({ storageState: stateFile('owner') });

  test('offers no approval, because nothing has been assessed', async ({ page }) => {
    await page.goto(`/benefits/claims/${fixtures.benefitClaims.held}`);
    await expectNoErrorBoundary(page);

    // The claim is complete and checked and still cannot be assessed, so
    // there is nothing to approve. The screen says which decision it waits
    // on rather than offering a control that would refuse.
    await expect(page.getByText(/The deceased was not listed as next of kin/i)).toBeVisible();
    await expect(
      page.getByRole('button', { name: /^Approve the assessed amount/ }),
    ).toHaveCount(0);
  });
});

// ===========================================================================
test.describe('registering and checking next of kin', () => {
  test('a Secretary records one, and cannot check their own record', async ({
    browser,
  }) => {
    const secretaryContext = await browser.newContext({
      storageState: stateFile('secretary'),
    });
    const secretary = await secretaryContext.newPage();

    await secretary.goto(
      `/beneficiaries/new?membershipId=${fixtures.memberships.gapped}`,
    );
    await expectNoErrorBoundary(secretary);

    await secretary.getByLabel(/beneficiary's full name/i).fill('Esther Nabirye');
    await secretary.getByLabel(/Relationship to the member/i).selectOption('sibling');
    await secretary.getByLabel(/^Telephone number/i).fill('0772120031');

    await secretary.getByRole('button', { name: /Register this beneficiary/ }).click();

    // The record opens, unverified, and the Secretary cannot check it: the
    // verification form is not offered to them at all, because
    // `beneficiaries:verify` is a Manager's capability — and the database
    // refuses a check from whoever recorded it in any case.
    await expect(secretary.getByText(/Beneficiary registered/)).toBeVisible();
    await expect(secretary.getByText(/Not yet checked/).first()).toBeVisible();
    await expect(
      secretary.getByRole('button', { name: /Verify this beneficiary/ }),
    ).toHaveCount(0);

    const url = secretary.url();
    await secretaryContext.close();

    // --- And a Manager checks it -------------------------------------------
    const managerContext = await browser.newContext({
      storageState: stateFile('manager'),
    });
    const manager = await managerContext.newPage();

    await manager.goto(url);
    await expectNoErrorBoundary(manager);

    await manager
      .getByLabel(/What does the check rest on/i)
      .selectOption('witnessed_in_branch');

    await manager.getByRole('button', { name: /Verify this beneficiary/ }).click();

    await expect(manager.getByText(/Verified/).first()).toBeVisible();

    await managerContext.close();
  });
});

// ===========================================================================
test.describe('marking a register', () => {
  test.use({ storageState: stateFile('secretary') });

  test('records an answer, and asks for a reason when one changes', async ({ page }) => {
    await page.goto(`/meetings/${fixtures.meetings.toWorkOn}`);
    await expectNoErrorBoundary(page);

    // Marking the first member present is what moves a meeting to `held` —
    // the status is derived from the register rather than set by hand.
    await page
      .getByRole('button', { name: /^Mark$/ })
      .first()
      .click();
    await page.getByRole('button', { name: /^Record it$/ }).click();

    await expect(page.getByText(/^Present$/).first()).toBeVisible();
    await expect(page.getByText('Held').first()).toBeVisible();

    // Changing that answer is a correction, and a correction needs a reason:
    // the previous entry is kept, append-only, with the reason beside it.
    await page
      .getByRole('button', { name: /^Change$/ })
      .first()
      .click();

    // The radio itself is `sr-only` and the label carries the word, which is
    // what a person taps.
    await page.getByText('Apologies', { exact: true }).first().click();

    await expect(page.getByLabel(/Why is this being changed/i)).toBeVisible();

    await page
      .getByLabel(/Why is this being changed/i)
      .fill('Rang in before the meeting started; recorded as present in error.');

    await page.getByRole('button', { name: /Record the correction/ }).click();

    await expect(page.getByText(/^Apologies$/).first()).toBeVisible();
    await expect(page.getByText(/recorded as present in error/i).first()).toBeVisible();
  });

  test('writes minutes and records what somebody will do', async ({ page }) => {
    await page.goto(`/meetings/${fixtures.meetings.toWorkOn}`);
    await expectNoErrorBoundary(page);

    await page.getByRole('button', { name: /Write the minutes/ }).click();

    await page
      .getByLabel(/What was decided/i)
      .fill('The meeting agreed to put the four undecided benefit rules to the Owner.');

    await page.getByRole('button', { name: /Save the minutes/ }).click();

    await expect(page.getByText(/four undecided benefit rules/i).first()).toBeVisible();

    // A draft until somebody finalises it. Afterwards an edit is an amendment
    // that has to say what changed.
    await expect(page.getByText(/A draft\. Nobody has finalised it/)).toBeVisible();

    await page.getByRole('button', { name: /Add an action item/ }).click();
    await page
      .getByLabel(/What is to be done/i)
      .fill('Put the four undecided benefit rules to the Owner in writing.');
    await page.getByRole('button', { name: /^Add it$/ }).click();

    await expect(
      page.getByText(/Put the four undecided benefit rules/i).first(),
    ).toBeVisible();
  });
});

/** The total paid figure the benefits report shows, in shillings. */
async function readTotalPaid(page: import('@playwright/test').Page): Promise<number> {
  // The "Total paid" row of the payments table, located by its own label
  // rather than by position: the report has a second table beneath it, read
  // from the General Ledger, and "the last money cell on the page" would be
  // whichever of the two happened to render last.
  const cell = page
    .locator('tr', { hasText: /Total paid/ })
    .locator('[data-money]')
    .filter({ visible: true })
    .first();

  const text = (await cell.textContent()) ?? '';
  const amount = /UGX\s*([\d,]+)/.exec(text)?.[1];

  if (amount === undefined) {
    throw new Error(`Could not read a total from "${text}".`);
  }

  return Number(amount.replace(/,/g, ''));
}
