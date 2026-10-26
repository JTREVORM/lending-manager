import {
  expect,
  expectNoErrorBoundary,
  fixtures,
  stateFile,
  test,
  watchForBrowserErrors,
} from './fixtures';

/**
 * The member loan screens, in a browser, against the production build.
 *
 * ## What only a browser can say about these
 *
 * Phase 3 added nine migrations, a domain module and eight components, and
 * the database suite proves every rule in them. What it cannot prove is
 * whether the screens that read those rules render at all, whether they
 * render on a phone, and whether somebody without the capability is actually
 * stopped. Those are the three things that have broken in this project before
 * and the three things asserted here.
 *
 *   1. **The screens render rather than fall over.** Every page is asserted
 *      three ways — status, no error boundary, and its own content. "Something
 *      went wrong" is a heading too.
 *
 *   2. **They survive 390px.** The member loan register is a nine-column
 *      table and the eligibility register is seven. Measured by asking the
 *      document for its own overflow, not by looking at a screenshot.
 *
 *   3. **The capability is the control, not the sidebar.** The Secretary may
 *      read eligibility — that is counter work — and may not open an
 *      application, which commits the business to lend. So the Secretary is
 *      pointed straight at `/member-loans/new`.
 *
 * ## What the harness has decided, and what it has not
 *
 * The harness answers the three **policy** questions (basis, method,
 * multiplier) with illustrative figures and leaves the fourth — the monthly
 * collection anchor — open. So these specs meet a *partially* open
 * programme: weekly member loans of one and two months are approvable and a
 * three-month one is not, which is exactly the consequence of answering three
 * of four. The status banner is asserted against that, so a harness that
 * quietly decided the fourth would fail here rather than pass silently.
 *
 * ## `.filter({ visible: true })`, everywhere
 *
 * Both registers render twice — cards below `md`, a table above — with the
 * other half hidden by CSS rather than unmounted. A locator for a loan number
 * therefore resolves two elements, and `.first()` is as likely to be the
 * hidden one. Filtering to visible is what makes these tests pass on data
 * they can see.
 *
 * ## What this file does not do
 *
 * It writes nothing. Opening an application, submitting it and approving it
 * live in `member-loans.write.spec.ts`, which runs on the desktop project
 * only — the mobile project would otherwise open a second application against
 * the same member and the second one would be refused for the first one's
 * existence.
 */

test.use({ storageState: stateFile('owner') });

interface Screen {
  readonly name: string;
  readonly path: string;
  /** Text only this page's own content produces. */
  readonly proves: RegExp;
}

const SCREENS: readonly Screen[] = [
  { name: 'who can borrow', path: '/member-loans', proves: /Who can borrow/ },
  {
    name: 'the eligibility register, qualified only',
    path: '/member-loans?qualified=qualified',
    proves: /Who can borrow/,
  },
  {
    name: 'the member loan register',
    path: '/member-loans?tab=loans',
    proves: /Member Loans/,
  },
  {
    name: 'the member loan register, active only',
    path: '/member-loans?tab=loans&status=active',
    proves: /Member Loans/,
  },
  {
    name: 'a member loan application',
    path: `/member-loans/new?client=${fixtures.memberClients.applying}`,
    proves: /What the member is asking for/,
  },
  {
    name: 'a member loan, on the loan it is',
    path: `/loans/${fixtures.memberLoans.active}`,
    proves: /Lent against a membership/,
  },
  {
    name: "the member's record, with the eligibility panel",
    path: `/membership/${fixtures.memberships.applying}`,
    proves: /Member loan eligibility/,
  },
];

test.describe('every member loan screen renders', () => {
  for (const screen of SCREENS) {
    test(`${screen.name} renders, with no console error`, async ({ page }) => {
      const watcher = watchForBrowserErrors(page);

      const response = await page.goto(screen.path);

      expect(response?.status(), `${screen.path} returned a non-200`).toBe(200);
      await expectNoErrorBoundary(page);

      // Filtered to visible because the sidebar carries "Member Loans" too,
      // and below `md` the rail is a closed drawer — so the first match is
      // the hidden one and `.first()` alone fails on a page it can see.
      await expect(
        page.getByText(screen.proves).filter({ visible: true }).first(),
      ).toBeVisible();

      expect(watcher.errors, `${screen.path} logged browser errors`).toEqual([]);
    });
  }
});

test.describe('the dashboard reports the book it actually has', () => {
  test('names the one decision still outstanding, and only that one', async ({
    page,
  }) => {
    await page.goto('/member-loans');

    // Three of the four are answered in the harness, so exactly one is named.
    // Asserted against the manifest rather than against the number one, so a
    // harness that decided the anchor would fail here instead of drifting.
    const openDecisions = fixtures.memberLending.monthAnchor === null ? 1 : 0;

    expect(openDecisions, 'the harness leaves the month anchor open').toBe(1);

    await expect(
      page.getByText(/One decision is holding member lending up/i),
    ).toBeVisible();

    // And the column it lives in, which is what a reader has to change.
    await expect(page.getByText('repayment_frequencies.month_anchor')).toBeVisible();

    // The consequence, stated rather than implied: short loans work, long
    // ones do not. A banner that said "nothing can be approved" while a
    // weekly loan was running would be a banner people stop reading.
    await expect(page.getByText(/only where it is collected weekly/i)).toBeVisible();
  });

  test('reports the outstanding principal and the savings pledged against it', async ({
    page,
  }) => {
    await page.goto('/member-loans');

    const seeded = fixtures.memberLoans.pledged;
    expect(seeded, 'the harness pledged something').toBeGreaterThan(0);

    await expect(page.getByText(/Secured against savings/i)).toBeVisible();
    await expect(
      page.getByText(/Members' savings restricted by a live member loan/i),
    ).toBeVisible();

    // Read off the panel and compared as a number, not matched as a string.
    //
    // The figure is the *sum* of live pledges, and `member-loans.write.spec.ts`
    // approves another member loan in the same stack — so asserting the seeded
    // pledge exactly would make this test depend on which spec file ran first.
    // What is true either way is that the panel reports at least what the
    // seeded loan pledged, and that it is derived rather than stored: the
    // per-loan figure is asserted exactly on the loan's own screen below.
    const text = await page.evaluate(() => document.body.innerText);
    const shown = /Secured against savings\s*\n\s*UGX\s*([\d,]+)/.exec(text)?.[1] ?? null;

    expect(shown, 'the panel printed a figure').not.toBeNull();
    expect(Number((shown ?? '0').replaceAll(',', ''))).toBeGreaterThanOrEqual(seeded);

    // Outstanding principal, which must be below the amount lent: two of the
    // eight weekly collections have been made.
    await expect(page.getByText(/Outstanding principal/i).first()).toBeVisible();

    const outstanding =
      /Outstanding principal\s*\n\s*UGX\s*([\d,]+)/.exec(text)?.[1] ?? null;

    expect(outstanding).not.toBeNull();
    expect(Number((outstanding ?? '0').replaceAll(',', ''))).toBeGreaterThan(0);
  });

  test('offers no total ceiling, because nobody committed to one', async ({ page }) => {
    await page.goto('/member-loans');

    // Summing what the business *could* lend across every member would be
    // read as a commitment nobody made. The counts are the useful version of
    // the same question, and they are what the panel carries instead.
    // Scoped to the panel's own definition list: the register's qualification
    // filter carries an option of the same name, and matching the page would
    // match both.
    await expect(
      page.getByRole('term').filter({ hasText: 'Qualified on savings' }),
    ).toBeVisible();
    await expect(
      page.getByRole('term').filter({ hasText: 'Not yet qualified' }),
    ).toBeVisible();
    await expect(page.getByText(/total ceiling/i)).toHaveCount(0);
  });

  test('lists the member loan, and keeps the status readable at the width it is used at', async ({
    page,
    isMobile,
  }) => {
    await page.goto('/member-loans?tab=loans');

    await expect(
      page.getByText(fixtures.memberLoans.activeNumber).filter({ visible: true }).first(),
    ).toBeVisible();

    if (isMobile === true) {
      // Below `md` the register is cards rather than a table, and the card
      // carries the four figures a counter needs — the savings pledged among
      // them, because it is this phase's column.
      await expect(
        page.getByText('Savings pledged').filter({ visible: true }).first(),
      ).toBeVisible();
      return;
    }

    // Weekly, because the term is inside the programme's weekly boundary —
    // and not a choice the counter made.
    await expect(
      page.getByText('weekly').filter({ visible: true }).first(),
    ).toBeVisible();

    // The status is the column a reader scans, and at 1,440px — the counter
    // laptop — it has to be readable without scrolling the table sideways.
    // Nine columns did not fit and the badge was clipped at the table's right
    // edge; the membership number and the pledge now drop below `2xl`, and
    // both are on the loan's own screen one tap away.
    const status = page.getByText('Active', { exact: true }).filter({ visible: true });
    await expect(status.first()).toBeVisible();

    const table = page.getByRole('table', { name: /Member loans, newest first/i });
    const clipped = await table.evaluate((element) => {
      const scroller = element.parentElement;
      return scroller === null ? 0 : scroller.scrollWidth - scroller.clientWidth;
    });

    expect(clipped, `the register overflows its own box by ${String(clipped)}px`).toBe(0);
  });
});

test.describe('the eligibility assessment', () => {
  test('shows a qualified member their ceiling, derived from their own savings', async ({
    page,
  }) => {
    await page.goto(`/membership/${fixtures.memberships.applying}`);

    await expect(page.getByText('Member loan eligibility').first()).toBeVisible();
    await expect(page.getByText(/MAY BORROW/i).first()).toBeVisible();

    // Six of six, and the arm of the rule this policy version chose, said out
    // loud — because which arm applies is still an open question elsewhere in
    // the programme and a reader needs to know which one they are looking at.
    await expect(page.getByText('6 of 6')).toBeVisible();

    // The multiplier restated as a percentage, from the manifest. 15,000bp is
    // 150%, and the panel says so rather than printing a basis-point figure
    // at somebody who has to act on it.
    const percent = fixtures.memberLending.multiplierBps / 100;
    await expect(
      page.getByText(new RegExp(`${String(percent)}% of the available savings`)),
    ).toBeVisible();
  });

  test('refuses the member who already holds a live loan, and says why', async ({
    page,
  }) => {
    await page.goto(`/membership/${fixtures.memberships.borrowing}`);

    await expect(page.getByText(/CANNOT BORROW YET/i).first()).toBeVisible();

    // One live loan at a time, and the reason names the rule rather than
    // saying "not eligible". This member's live loan is the member loan the
    // harness wrote, so the refusal is the system's own rule applied to its
    // own data.
    await expect(page.getByText(/active loan/i).first()).toBeVisible();

    // And the ceiling is still shown, lower by what the pledge took: a
    // refusal is not a reason to stop telling somebody where they stand.
    await expect(page.getByText(/Available to secure a loan/i)).toBeVisible();
    await expect(
      page.getByText(/Balance less what secures a live loan/i).first(),
    ).toBeVisible();
  });

  test('tells a member who is still saving how far they have got', async ({ page }) => {
    await page.goto(`/membership/${fixtures.memberships.saving}`);

    await expect(page.getByText('Member loan eligibility').first()).toBeVisible();
    await expect(page.getByText(/CANNOT BORROW YET/i).first()).toBeVisible();

    // The months they have, against the months they need. A refusal that did
    // not say how close they were would send them away without knowing when
    // to come back.
    await expect(page.getByText(/of 6/).first()).toBeVisible();
  });
});

test.describe('the application form', () => {
  test('prices the loan the member is asking for, month by month', async ({ page }) => {
    await page.goto(`/member-loans/new?client=${fixtures.memberClients.applying}`);
    await expectNoErrorBoundary(page);

    // Nothing is priced before an amount is entered, and the form says so
    // rather than showing a table of zeros.
    await expect(
      page.getByText(/Enter an amount to see the repayment schedule/i),
    ).toBeVisible();

    await page.getByLabel('Amount applied for').fill('200000');
    await page.getByLabel('Loan term').selectOption('2');

    // The contract, month by month. Generated in the browser from the same
    // domain module the database agrees with — `tests/db/loan-engine-parity`
    // is what proves they agree; this proves the screen shows it.
    const preview = page.getByRole('table', {
      name: /What the member would owe, month by month/i,
    });
    await expect(preview).toBeVisible();

    // Two months, so two rows and a total.
    await expect(preview.getByRole('row')).toHaveCount(4);
    await expect(page.getByText(/collected weekly/i).first()).toBeVisible();
  });

  test('warns before an amount above the ceiling is submitted', async ({ page }) => {
    await page.goto(`/member-loans/new?client=${fixtures.memberClients.applying}`);

    await page.getByLabel('Amount applied for').fill('5000000');

    // The warning is the point: the application can still be opened and the
    // approval will be refused, so saying it now saves the member a trip.
    // The control is `validate_loan_for_approval`; this is the courtesy.
    await expect(
      page.getByText(/Above what this member's savings support/i),
    ).toBeVisible();
  });

  test('refuses to schedule a term that needs the undecided cadence', async ({
    page,
  }) => {
    await page.goto(`/member-loans/new?client=${fixtures.memberClients.applying}`);

    await page.getByLabel('Amount applied for').fill('200000');
    await page.getByLabel('Loan term').selectOption('3');

    // Three months is collected calendar-monthly, and the monthly anchor is
    // the decision the harness left open. So the form says what cannot be
    // done and why — and the database would refuse the approval regardless.
    await expect(page.getByText(/cannot be scheduled yet/i).first()).toBeVisible();

    // The cadence named, not left to be inferred from the term.
    await expect(page.getByText(/Monthly \(calendar\)/i)).toBeVisible();
  });

  test('names the terms it is pricing from, and whose policy version they are', async ({
    page,
  }) => {
    await page.goto(`/member-loans/new?client=${fixtures.memberClients.applying}`);

    await expect(
      page
        .getByText(new RegExp(`policy version ${fixtures.policy.version}`, 'i'))
        .first(),
    ).toBeVisible();

    // The two decisions the harness answered, shown as what they are rather
    // than as blanks: a reader has to be able to see which basis and which
    // method this loan would be priced on.
    await expect(page.getByText('Per month').first()).toBeVisible();
    await expect(page.getByText(/Reducing balance, monthly/i).first()).toBeVisible();
  });
});

test.describe('the member loan on the loan it is', () => {
  test('carries the assessment the approval was made on, frozen', async ({ page }) => {
    await page.goto(`/loans/${fixtures.memberLoans.active}`);

    await expect(page.getByText(/Lent against a membership/i)).toBeVisible();
    await expect(page.getByText(/frozen at approval/i).first()).toBeVisible();

    await expect(
      page.getByText(fixtures.membershipNumbers.borrowing).first(),
    ).toBeVisible();
    await expect(page.getByText(/Qualifying months served/i)).toBeVisible();
  });

  test('says in so many words that the pledge moved no money', async ({ page }) => {
    await page.goto(`/loans/${fixtures.memberLoans.active}`);

    await expect(page.getByText(/Savings securing this loan/i)).toBeVisible();

    const pledged = fixtures.memberLoans.pledged;
    await expect(
      page.getByText(new RegExp(`UGX\\s*${pledged.toLocaleString('en-US')}`)).first(),
    ).toBeVisible();

    // The sentence that stops a reader concluding the savings were taken. It
    // is the single most misreadable thing on the screen, so it is asserted.
    await expect(
      page.getByText(/restricts what the member may withdraw; it does not move money/i),
    ).toBeVisible();
    await expect(
      page.getByText(/2100 Member Savings liability is unchanged/i),
    ).toBeVisible();
  });

  test('is reached from the member loan register, in the loan module', async ({
    page,
  }) => {
    await page.goto('/member-loans?tab=loans');

    await page
      .getByRole('link', { name: fixtures.memberLoans.activeNumber })
      .filter({ visible: true })
      .first()
      .click();

    // A member loan is a loan: it opens where every loan opens, rather than
    // in a second detail screen with a second set of controls over one
    // agreement.
    await expect(page).toHaveURL(new RegExp(`/loans/${fixtures.memberLoans.active}`));
    await expect(page.getByText(/Lent against a membership/i)).toBeVisible();
  });
});

test.describe('non-member lending is untouched', () => {
  test('an ordinary loan shows no membership panel', async ({ page }) => {
    await page.goto(`/loans/${fixtures.loans.current}`);
    await expectNoErrorBoundary(page);

    // The regression that matters most in this phase: the business lends to
    // people who are not members, and Phase 3 must not have made a membership
    // a precondition for reading or running an ordinary loan.
    await expect(page.getByText(/Lent against a membership/i)).toHaveCount(0);
    await expect(page.getByText(/Savings securing this loan/i)).toHaveCount(0);
  });

  test('the ordinary loan register still lists the whole book', async ({ page }) => {
    await page.goto('/loans');
    await expectNoErrorBoundary(page);

    // The member loan is in here too, because it is a loan. A register that
    // hid it would be a register that did not add up against the ledger.
    await expect(
      page.getByText(fixtures.memberLoans.activeNumber).filter({ visible: true }).first(),
    ).toBeVisible();
  });
});

test.describe('the capability is the control', () => {
  test('a Secretary may read eligibility', async ({ browser }) => {
    const context = await browser.newContext({ storageState: stateFile('secretary') });
    const page = await context.newPage();

    try {
      const response = await page.goto('/member-loans');

      // Counter work: answering "do I qualify yet?" does not commit the
      // business to anything.
      expect(response?.status()).toBe(200);
      await expectNoErrorBoundary(page);
      await expect(page.getByText(/Who can borrow/).first()).toBeVisible();
    } finally {
      await context.close();
    }
  });

  test('and may not open an application, by URL or otherwise', async ({ browser }) => {
    const context = await browser.newContext({ storageState: stateFile('secretary') });
    const page = await context.newPage();

    try {
      // No link is offered — but hiding a link is not protection, so the
      // Secretary is pointed straight at the route.
      await page.goto('/member-loans');
      await expect(page.getByRole('link', { name: /new application/i })).toHaveCount(0);

      await page.goto(`/member-loans/new?client=${fixtures.memberClients.applying}`);

      // Redirected or refused — not the form. The route requirement in
      // lib/auth/routing.ts lists the longer prefix first precisely so this
      // page does not inherit the section's floor.
      await expect(page.getByText(/What the member is asking for/i)).toHaveCount(0);
    } finally {
      await context.close();
    }
  });

  test('a borrower reaches none of it', async ({ browser }) => {
    const context = await browser.newContext({ storageState: stateFile('borrower') });
    const page = await context.newPage();

    try {
      await page.goto('/member-loans');

      // The portal is a different application to the same database. A
      // borrower who reached the staff register would be reading every other
      // member's savings position.
      await expect(page.getByText(/Who can borrow/)).toHaveCount(0);
    } finally {
      await context.close();
    }
  });
});

test.describe('on a phone', () => {
  test.skip(({ isMobile }) => !isMobile, 'measured on the mobile project only');

  for (const path of [
    '/member-loans',
    '/member-loans?tab=loans',
    `/loans/${fixtures.memberLoans.active}`,
  ]) {
    test(`${path} does not scroll sideways at 390px`, async ({ page }) => {
      await page.goto(path);
      await expectNoErrorBoundary(page);

      // Asked of the document rather than judged from a screenshot. A counter
      // uses this one-handed, and a page that scrolls sideways hides the
      // column the figure is in.
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );

      expect(overflow, `${path} overflows by ${String(overflow)}px`).toBeLessThanOrEqual(
        1,
      );
    });
  }

  test('the member loan register becomes cards, with the figures kept', async ({
    page,
  }) => {
    await page.goto('/member-loans?tab=loans');

    // The table is hidden by CSS below `md` and the cards are shown. Both are
    // in the document, so the assertion is about which one is visible.
    await expect(
      page.getByText(fixtures.memberLoans.activeNumber).filter({ visible: true }).first(),
    ).toBeVisible();

    // And the figures a counter needs are still on the card, not dropped to
    // make it fit.
    await expect(
      page.getByText('Savings pledged').filter({ visible: true }).first(),
    ).toBeVisible();
    await expect(
      page.getByText('Outstanding').filter({ visible: true }).first(),
    ).toBeVisible();
  });

  test('the eligibility panel is readable on the membership record', async ({ page }) => {
    await page.goto(`/membership/${fixtures.memberships.applying}`);

    await expect(page.getByText('Member loan eligibility').first()).toBeVisible();
    await expect(page.getByText(/MAY BORROW/i).first()).toBeVisible();

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);
  });
});
