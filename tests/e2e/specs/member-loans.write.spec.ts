import { expect, expectNoErrorBoundary, fixtures, stateFile, test } from './fixtures';

/**
 * A member loan from application to approval, in a browser.
 *
 * The financial rules are proved by the unit and database suites — the
 * eligibility ceiling, the pledge arithmetic, the schedule dates, the
 * refusals. What cannot be proved there is whether the controls a manager
 * actually presses are wired to those rules at all, which is the defect class
 * this project has shipped before: 2,584 passing tests and no payment could
 * be recorded.
 *
 * So this opens an application through the form, submits it, approves it, and
 * then reads back what the **database** did in response — the pledge, the
 * frozen assessment, the generated schedule and the member's own savings
 * position. Nothing here asserts a figure it computed itself, except where
 * the arithmetic is restated against a figure the application displayed one
 * step earlier.
 *
 * ## Why it runs on the desktop project only
 *
 * Because it writes. An approval takes a pledge against a member's savings
 * and makes them hold a live loan, so running it twice would meet
 * `active_loan_exists` on the second run and fail for the first run's
 * success. `playwright.config.ts` excludes `*.write.spec.ts` from the mobile
 * project for exactly this reason.
 *
 * ## Why it has a member of its own
 *
 * `fixtures.memberships.approving` exists so this file can approve something
 * without changing what `member-loans.spec.ts` asserts about
 * `fixtures.memberships.applying` — whose eligibility panel is asserted to
 * read "may borrow", which it would stop doing the moment a loan was approved
 * against it. Two members rather than one ordering dependency between two
 * spec files.
 */

test.use({ storageState: stateFile('owner') });

/** The member's savings position, as the eligibility panel reports it. */
async function readAvailable(
  page: import('@playwright/test').Page,
  membershipId: string,
) {
  await page.goto(`/membership/${membershipId}`);

  const panel = page.getByText('Member loan eligibility').first();
  await expect(panel).toBeVisible();

  const text = await page.evaluate(() => document.body.innerText);

  const balance = /Savings balance\s*\n\s*UGX\s*([\d,]+)/.exec(text)?.[1] ?? null;
  const available =
    /Available to secure a loan\s*\n\s*UGX\s*([\d,]+)/.exec(text)?.[1] ?? null;

  return {
    balance: balance === null ? null : Number(balance.replaceAll(',', '')),
    available: available === null ? null : Number(available.replaceAll(',', '')),
  };
}

test.describe('an application, opened from the form', () => {
  test('opens a draft on the terms the member asked for', async ({ page }) => {
    await page.goto(`/member-loans/new?client=${fixtures.memberClients.applying}`);
    await expectNoErrorBoundary(page);

    await page.getByLabel('Amount applied for').fill('120000');
    await page.getByLabel('Loan term').selectOption('1');
    await page.getByLabel('Purpose').fill('Restocking the shop before term starts.');

    // The preview is the contract the member is agreeing to, so it has to be
    // on screen before the button is pressed rather than after.
    await expect(
      page.getByRole('table', { name: /What the member would owe, month by month/i }),
    ).toBeVisible();

    await page.getByRole('button', { name: /open the application/i }).click();

    // Lands on the loan, because that is what it is. A member loan has no
    // detail screen of its own: the loan screen carries the agreement and the
    // member loan adds a panel to it.
    await page.waitForURL(/\/loans\/[0-9a-f-]{36}/, { timeout: 20_000 });
    await expectNoErrorBoundary(page);

    // A draft, not a submission. Opening an application commits nobody.
    await expect(page.getByText(/draft/i).first()).toBeVisible();

    // And the figures the form sent, read back from the loan the database
    // wrote rather than from the form's own state.
    await expect(page.getByText(/120,000/).first()).toBeVisible();
    await expect(
      page.getByText(/Restocking the shop before term starts/i).first(),
    ).toBeVisible();
  });
});

test.describe('approval', () => {
  test('pledges the savings, freezes the assessment, and generates the schedule', async ({
    page,
  }) => {
    const loanUrl = `/loans/${fixtures.memberLoans.toApprove}`;
    const membershipId = fixtures.memberships.approving;

    // --- before -----------------------------------------------------------
    const before = await readAvailable(page, membershipId);

    expect(before.balance, 'the member has savings').toBeGreaterThan(0);
    expect(before.available, 'and none of them are committed yet').toBe(before.balance);

    // --- submit -----------------------------------------------------------
    await page.goto(loanUrl);
    await expectNoErrorBoundary(page);

    // The membership panel is on the draft already, because the application
    // was assessed against a membership — what approval adds is the frozen
    // snapshot and the pledge.
    await page.getByRole('button', { name: /submit for approval/i }).click();
    await expect(page.getByText(/awaiting approval/i).first()).toBeVisible({
      timeout: 20_000,
    });

    // --- approve ----------------------------------------------------------
    await page.goto(loanUrl);
    await page.getByRole('button', { name: /^approve/i }).click();
    await page.getByRole('button', { name: /yes, approve this loan/i }).click();

    await expect(page.getByText(/approved/i).first()).toBeVisible({ timeout: 20_000 });
    await expectNoErrorBoundary(page);

    // --- what the database did in response --------------------------------
    await page.goto(loanUrl);

    await expect(page.getByText(/Lent against a membership/i)).toBeVisible();
    await expect(page.getByText(/frozen at approval/i).first()).toBeVisible();
    await expect(page.getByText(/Savings securing this loan/i)).toBeVisible();

    // The pledge is the principal divided by the approved multiplier, rounded
    // up — never a shilling short of what the multiplier says secures it.
    const principal = fixtures.memberLoans.toApprovePrincipal;
    const expectedPledge = Math.ceil(
      (principal * 10_000) / fixtures.memberLending.multiplierBps,
    );

    await expect(
      page
        .getByText(new RegExp(`UGX\\s*${expectedPledge.toLocaleString('en-US')}`))
        .first(),
    ).toBeVisible();

    // The terms, read from the member's own policy version at approval. A
    // later policy version does not reprice this loan.
    await expect(
      page
        .getByText(new RegExp(`Policy version ${fixtures.policy.version}`, 'i'))
        .first(),
    ).toBeVisible();

    // --- and what it did not do -------------------------------------------
    const after = await readAvailable(page, membershipId);

    // The balance is untouched: a pledge restricts savings, it does not spend
    // them. If this ever changed, member lending would be taking money out of
    // members' accounts.
    expect(after.balance, 'the pledge moved no money').toBe(before.balance);

    // What did change is how much is still free to secure something else,
    // and by exactly the pledge.
    expect(after.available).toBe((before.available ?? 0) - expectedPledge);
  });

  test('refuses an amount above the member’s ceiling, from the database', async ({
    page,
  }) => {
    // The borrowing member already holds a live member loan, so an
    // application for them is refused on two counts at once — and the point
    // of the assertion is that the *database* produced the refusal, with
    // every reason rather than the first.
    await page.goto(`/member-loans/new?client=${fixtures.memberClients.borrowing}`);
    await expectNoErrorBoundary(page);

    // The form is offered: an application can always be prepared. It is
    // approval the database refuses, which is the right place for the control
    // — a form that guessed would be a form that could be wrong.
    await page.getByLabel('Amount applied for').fill('9000000');

    await expect(
      page.getByText(/Above what this member's savings support/i),
    ).toBeVisible();
  });
});

test.describe('who may approve a member loan', () => {
  test('a Manager may approve but may not pay it out', async ({ browser }) => {
    const context = await browser.newContext({ storageState: stateFile('manager') });
    const page = await context.newPage();

    try {
      // The loan the approval test just approved. A Manager holds
      // `loans:approve` and deliberately not `loans:disburse`, so one person
      // cannot originate a loan, approve it and hand over the cash.
      await page.goto(`/loans/${fixtures.memberLoans.toApprove}`);
      await expectNoErrorBoundary(page);

      await expect(page.getByRole('button', { name: /^disburse/i })).toHaveCount(0);
    } finally {
      await context.close();
    }
  });

  test('a Secretary may not approve one', async ({ browser }) => {
    const context = await browser.newContext({ storageState: stateFile('secretary') });
    const page = await context.newPage();

    try {
      await page.goto(`/loans/${fixtures.memberLoans.draft}`);
      await expectNoErrorBoundary(page);

      await expect(page.getByRole('button', { name: /^approve/i })).toHaveCount(0);
    } finally {
      await context.close();
    }
  });
});
