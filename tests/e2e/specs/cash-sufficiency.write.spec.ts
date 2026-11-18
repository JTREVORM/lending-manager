import {
  expect,
  expectNoErrorBoundary,
  queryHarness,
  queryHarnessOne,
  stateFile,
  test,
} from './fixtures';

/**
 * Decision A, through the buttons an officer actually presses.
 *
 * ## Why this file exists
 *
 * `tests/db/cash-sufficiency.test.ts` proves the rules: thirty tests, every
 * scenario the Owner's ruling of 2026-11-16 names, against a real PostgreSQL
 * cluster. What it cannot prove is that a person can reach any of them. The
 * full-system certification said so in recommendation **L5**, and said it
 * about this exact pair of screens:
 *
 *   > The full 1,151-test browser suite passed without touching either
 *   > screen. A suite that is green is not a suite that looked.
 *
 * Both screens were then added to the accessibility, sideways-scroll and
 * navigation sweeps. Those prove the pages *render*. They prove nothing about
 * whether confirming a receipt releases money, whether clearing a deposit
 * moves it, or whether the maker-checker refusals reach a screen at all —
 * and a rendering test that was mistaken for one of those is how L5 came to
 * be written in the first place. So this file deliberately presses buttons
 * and reads money.
 *
 * ## It asserts the ledger, never its own arithmetic
 *
 * Every figure is checked twice and computed never:
 *
 *   1. the figure on screen is compared to `cash_account_availability`, the
 *      view the database derives — so the screen and the ledger must agree;
 *   2. the *change* in that figure is compared to the sum of the receipt
 *      amounts recorded in `cash_receipt_confirmations`, which is what the
 *      counter took in. That is an independent identity — available rises by
 *      what was counted — rather than a number copied out of the thing under
 *      test.
 *
 * If this file ever disagreed with the engine, the engine would be right.
 *
 * ## Why it writes money, and why that is in the name
 *
 * `.write.spec.ts`, so it runs on desktop only and nobody mistakes it for a
 * read-only sweep. It confirms receipts, banks cash and reverses a clearance
 * in the demonstration book, which is what the seed exists for.
 *
 * ## It needs a freshly seeded stack, and that is not a flaw
 *
 * These journeys spend the seed's money: they count this morning's uncounted
 * takings and then bank some of what they released. Run twice against the
 * same stack without re-seeding, the second run finds the drawer already
 * counted and the till already spent down, and the first journey rightly
 * fails its own precondition.
 *
 * That is how the suite is run — `npm run e2e:up` rebuilds the database and
 * re-seeds before Playwright starts, in CI and locally — and it is the same
 * contract every other `.write.` spec here works under. Said out loud only
 * because the failure mode looks alarming and is not: if you re-run this file
 * alone and the first journey complains the drawer has nothing to count,
 * rebuild the stack rather than hunting a regression.
 */

import type { Page } from '@playwright/test';

const TILL = 'Cash at Hand — Head Office';
const BANK = 'Cash at Bank — Head Office';
const TRANSIT = 'Cash in Transit — Head Office';

interface Availability {
  readonly booked: number;
  readonly pending: number;
  readonly available: number;
}

/** What the database says one account can pay out. The authority. */
async function inLedger(accountName: string): Promise<Availability> {
  const row = await queryHarnessOne<{
    booked: string;
    pending: string;
    available: string;
  }>(
    `select booked::text, pending_confirmation::text as pending, available::text
       from public.cash_account_availability where name = $1`,
    [accountName],
  );
  return {
    booked: Number(row.booked),
    pending: Number(row.pending),
    available: Number(row.available),
  };
}

/**
 * What the availability card on screen says that account can pay out.
 *
 * Located by the account's own name rather than by position: the card renders
 * one per account with money in it, in a responsive grid, and "the first
 * card" is whichever account sorts first today.
 */
async function onScreen(page: Page, accountName: string): Promise<number> {
  const region = page.getByRole('region', { name: /What each account can pay out/i });
  await expect(region).toBeVisible();

  // The name is its own paragraph; the card is that paragraph's parent, and
  // the first money in the card is the available figure — the large one the
  // card leads with. The booked and restricted figures come after it.
  const card = region.locator('p', { hasText: accountName }).first().locator('xpath=..');
  const text = (await card.locator('[data-money]').first().textContent()) ?? '';

  const amount = /UGX\s*([\d,]+)/.exec(text)?.[1];
  if (amount === undefined) {
    throw new Error(
      `Could not read an available figure for ${accountName} from "${text}".`,
    );
  }
  return Number(amount.replace(/,/g, ''));
}

/** The pending receipts on one account, as the database holds them. */
async function pendingOn(
  accountName: string,
): Promise<readonly { readonly id: string; readonly amount: number }[]> {
  const rows = await queryHarness<{ id: string; amount: string }>(
    `select c.id, c.amount::text
       from public.cash_receipt_confirmations c
       join public.ledger_accounts a on a.id = c.account_id
      where c.state = 'pending' and a.name = $1
      order by c.amount desc, c.id`,
    [accountName],
  );
  return rows.map((r) => ({ id: r.id, amount: Number(r.amount) }));
}

/** The row for one pending receipt, found by the id its checkbox carries. */
function receiptRow(page: Page, id: string) {
  return page.locator('label').filter({ has: page.locator(`input[value="${id}"]`) });
}

/**
 * Count the whole drawer through the screen, as a Manager.
 *
 * Several journeys below need a till with money in it, and the honest way to
 * get one is the way a branch gets one: somebody counts the drawer. Doing it
 * through the form rather than in SQL also means the deposit journeys stand
 * on a balance this suite released itself.
 */
async function countTheDrawer(page: Page, accountName: string): Promise<void> {
  const waiting = await pendingOn(accountName);
  if (waiting.length === 0) return;

  await page.goto('/finance/receipts');
  await expectNoErrorBoundary(page);

  for (const receipt of waiting) {
    await receiptRow(page, receipt.id).locator('input[type="checkbox"]').check();
  }

  await page.getByRole('button', { name: /^Confirm \d+ receipts?$/ }).click();

  // Verified against the ledger rather than against a sentence on screen.
  // This helper exists to produce a till with money in it, so the thing to
  // wait for is the money — and if the batch were refused, waiting on the
  // word "confirmed" would pass while the drawer stayed uncounted.
  await expect
    .poll(async () => (await pendingOn(accountName)).length, { timeout: 30_000 })
    .toBe(0);
}

/** The id the account's <option> carries, so a select is driven by value. */
async function accountId(accountName: string): Promise<string> {
  const row = await queryHarnessOne<{ id: string }>(
    `select id::text from public.ledger_accounts where name = $1`,
    [accountName],
  );
  return row.id;
}

/**
 * The date the database recorded for a deposit, as `YYYY-MM-DD`.
 *
 * This is the one value date a clearance journey can always submit.
 * `verify_bank_deposit` refuses a bank value date that precedes the deposit
 * (`p_bank_value_date < d.deposit_date`) or that lies in the future, and
 * `record_bank_deposit` stamps `deposit_date = public.business_date()`. A
 * value date equal to the deposit's own date therefore satisfies both bounds
 * on the day the deposit was banked and on every later day, including when
 * midnight in the business timezone falls between recording and clearing.
 *
 * It replaces a literal `'2026-11-17'`. That was the business date on the day
 * the journeys were written, so they passed that day and on every CI run
 * before midnight in Kampala, and failed from the 18th onward with the
 * database refusing — correctly — a value date before the deposit existed.
 * The refusal reached the screen only as "That action is not permitted on
 * this record.", so the browser saw nothing to tell it why.
 *
 * Read from the database rather than computed in the test: the test must not
 * carry its own opinion of what "today" is, because the clock is exactly what
 * went wrong.
 */
async function bankValueDateFor(depositNumber: string): Promise<string> {
  const row = await queryHarnessOne<{ deposit_date: string }>(
    `select to_char(deposit_date, 'YYYY-MM-DD') as deposit_date
       from public.bank_deposits where deposit_number = $1`,
    [depositNumber],
  );
  return row.deposit_date;
}

/**
 * Fill in the banking form.
 *
 * The two selects are driven by the account's id rather than by its label:
 * each option reads "Cash at Hand — Head Office — 183637 available", so the
 * label carries a balance that changes as this suite spends it, and matching
 * on it would make the test depend on the figure it is about to move.
 */
async function recordDeposit(
  page: Page,
  amount: number,
  description: string,
): Promise<string> {
  // Scoped to the banking form, and the two selects addressed by their field
  // names. `getByLabel('To')` also matches the section itself, whose
  // accessible name is "Take cash **to** the bank" — an ambiguity that is the
  // page being readable rather than the page being wrong.
  const form = page
    .locator('form')
    .filter({ has: page.getByRole('button', { name: /Record deposit/i }) });

  await form.locator('select[name="fromAccountId"]').selectOption(await accountId(TILL));
  await form.locator('select[name="bankAccountId"]').selectOption(await accountId(BANK));
  await form.getByLabel('Amount').fill(String(amount));
  await form.getByLabel('Description').fill(description);
  await form.getByRole('button', { name: /Record deposit/i }).click();

  // Waited for in the ledger rather than in a flash message: the deposit
  // existing is the thing the next step depends on.
  await expect
    .poll(
      async () =>
        (
          await queryHarness<{ id: string }>(
            `select id::text from public.bank_deposits where description = $1`,
            [description],
          )
        ).length,
      { timeout: 30_000 },
    )
    .toBe(1);

  // Its reference number, because that — not the description — is what the
  // register puts on screen, and a journey has to find its own subject among
  // whatever else the book holds.
  const row = await queryHarnessOne<{ deposit_number: string }>(
    `select deposit_number from public.bank_deposits where description = $1`,
    [description],
  );
  return row.deposit_number;
}

// ===========================================================================
test.describe('counting the drawer', () => {
  test.use({ storageState: stateFile('manager') });

  test('a batch of receipts is confirmed, and exactly that much becomes available', async ({
    page,
  }) => {
    // The seed leaves this morning's takings uncounted on purpose, so the
    // till opens with money in the ledger and nothing it may spend. That is
    // the state this screen exists to clear.
    const before = await inLedger(TILL);
    expect(before.pending, 'the seed should leave takings to count').toBeGreaterThan(0);
    expect(before.available).toBe(before.booked - before.pending);

    const waiting = await pendingOn(TILL);
    expect(waiting.length).toBeGreaterThanOrEqual(2);

    await page.goto('/finance/receipts');
    await expectNoErrorBoundary(page);

    // The screen and the ledger agree before anything is pressed.
    expect(await onScreen(page, TILL)).toBe(before.available);
    await expect(
      page.getByRole('heading', { name: /Awaiting confirmation/i }),
    ).toBeVisible();

    // Two of them, chosen by name rather than "the first two", so the
    // expected release is the amount of the receipts this test selected.
    const chosen = waiting.slice(0, 2);
    const released = chosen.reduce((sum, r) => sum + r.amount, 0);

    for (const receipt of chosen) {
      await receiptRow(page, receipt.id).locator('input[type="checkbox"]').check();
    }

    // The form states what it is about to release, before it is pressed.
    const button = page.getByRole('button', { name: /^Confirm 2 receipts$/ });
    await expect(button).toBeEnabled();
    await button.click();

    // Wait for the batch to have **committed**, not for the page to contain a
    // word.
    //
    // This read `page.getByText(/confirmed/i).first()`, and it could not
    // fail. This screen renders the availability card, whose own copy reads
    // "Available is the ledger balance less the receipts nobody has
    // confirmed yet." — so `/confirmed/i` matched static text on every
    // render, before the button was pressed, and the ledger read below raced
    // the Server Action's commit.
    //
    // Losing that race reads a change of **exactly zero**, because the
    // confirmation is one transaction: either all of it is visible or none of
    // it is. That is the fingerprint, and it is what CI run 44088627144
    // reported — expected 77,000, received 0 — on a stack it had seeded
    // itself, so nothing about the seed explains it. The third instance of
    // the mistake L5 was written about, in L5's own file.
    //
    // Two real waits instead, in order:
    //
    //   1. the action's own sentence, which names the count. A partial batch
    //      — "1 confirmed, 1 refused", which is what a receipt the confirmer
    //      recorded themselves produces — fails here, loudly, instead of
    //      arriving below as an arithmetic mismatch nobody can read;
    //   2. the chosen rows leaving the queue, which is the screen agreeing
    //      the transaction committed rather than the test hoping it did.
    await expect(
      page.getByText(
        `${String(chosen.length)} receipts confirmed. The money is now available.`,
      ),
    ).toBeVisible({ timeout: 20_000 });

    for (const receipt of chosen) {
      await expect(receiptRow(page, receipt.id)).toHaveCount(0, { timeout: 20_000 });
    }

    await expectNoErrorBoundary(page);

    // --- the identity, two ways -------------------------------------------
    const after = await inLedger(TILL);

    // 1. Available rose by exactly what was counted. Nothing else moved.
    expect(after.available - before.available).toBe(released);
    expect(after.booked, 'confirming money is not receiving money').toBe(before.booked);
    expect(after.pending).toBe(before.pending - released);

    // 2. And the screen reports the ledger's figure, not its own. Polled:
    //    the card is a server component that the action revalidates, so it
    //    catches up a moment after the confirmation returns.
    await expect
      .poll(async () => onScreen(page, TILL), { timeout: 20_000 })
      .toBe(after.available);

    // The two rows are gone from the queue; the rest are still waiting.
    for (const receipt of chosen) {
      await expect(receiptRow(page, receipt.id)).toHaveCount(0);
    }
    expect((await pendingOn(TILL)).length).toBe(waiting.length - 2);
  });
});

// ===========================================================================
test.describe('who may count it', () => {
  test.use({ storageState: stateFile('secretary') });

  test('a Secretary sees the drawer and is not offered the count', async ({ page }) => {
    // `receipts:view` without `receipts:confirm`. The separation is the
    // control: the person who takes money over the counter is not the person
    // who certifies how much of it is there.
    const before = await pendingOn(TILL);
    expect(before.length, 'this test needs something still waiting').toBeGreaterThan(0);

    await page.goto('/finance/receipts');
    await expectNoErrorBoundary(page);

    // They can see what is waiting — that is the point of the view
    // capability — and the figure agrees with the ledger.
    await expect(
      page.getByRole('heading', { name: /Awaiting confirmation/i }),
    ).toBeVisible();
    expect(await onScreen(page, TILL)).toBe((await inLedger(TILL)).available);

    // But there is no button, and the screen says whose act it is.
    await expect(page.getByRole('button', { name: /^Confirm/ })).toHaveCount(0);
    await expect(page.getByText(/Counting the drawer is a Manager/i)).toBeVisible();

    // Every checkbox is disabled, so nothing can be selected and posted by
    // hand either.
    const boxes = page.locator('input[name="confirmationIds"]');
    expect(await boxes.count()).toBeGreaterThan(0);
    for (let i = 0; i < (await boxes.count()); i += 1) {
      await expect(boxes.nth(i)).toBeDisabled();
    }

    // And nothing changed.
    expect((await pendingOn(TILL)).length).toBe(before.length);
  });
});

// ===========================================================================
test.describe('banking the takings', () => {
  test('a Secretary banks it, a Manager clears it, and the money moves once', async ({
    browser,
  }) => {
    // --- the drawer is counted first, as a Manager -------------------------
    const managerContext = await browser.newContext({
      storageState: stateFile('manager'),
    });
    const manager = await managerContext.newPage();
    await countTheDrawer(manager, TILL);

    const tillBefore = await inLedger(TILL);
    const bankBefore = await inLedger(BANK);
    const transitBefore = await inLedger(TRANSIT);
    expect(tillBefore.pending, 'the drawer is counted, so nothing is restricted').toBe(0);
    expect(tillBefore.available).toBeGreaterThan(0);

    // A round amount the till can cover, well inside it.
    const amount = Math.min(50_000, Math.floor(tillBefore.available / 2));
    expect(amount).toBeGreaterThan(0);

    // --- the Secretary takes it to the bank --------------------------------
    const secretaryContext = await browser.newContext({
      storageState: stateFile('secretary'),
    });
    const secretary = await secretaryContext.newPage();

    await secretary.goto('/finance/deposits');
    await expectNoErrorBoundary(secretary);

    await expect(
      secretary.getByRole('heading', { name: /Take cash to the bank/i }),
    ).toBeVisible();

    const reference = await recordDeposit(
      secretary,
      amount,
      'Banking the morning takings',
    );
    await expectNoErrorBoundary(secretary);

    // The money has left the drawer and is spendable by nobody: in transit,
    // not yet at the bank. Owner instruction 7.
    const tillAfterBanking = await inLedger(TILL);
    const bankAfterBanking = await inLedger(BANK);
    const transitAfterBanking = await inLedger(TRANSIT);

    expect(tillBefore.available - tillAfterBanking.available).toBe(amount);
    expect(bankAfterBanking.available, 'the bank does not have it yet').toBe(
      bankBefore.available,
    );
    expect(transitAfterBanking.booked - transitBefore.booked).toBe(amount);

    // And the Secretary is not offered the clearance: `deposits:verify` is a
    // Manager's capability.
    await expect(
      secretary.getByRole('button', { name: /Verify clearance/i }),
    ).toHaveCount(0);

    await secretaryContext.close();

    // --- the Manager clears it against the bank's own record ---------------
    await manager.goto('/finance/deposits');
    await expectNoErrorBoundary(manager);

    // Scoped to this deposit by its own reference number, so the clearance
    // lands on the one the Secretary just banked rather than on whichever
    // row the register happens to render first.
    const subject = manager.locator('article').filter({ hasText: reference });
    await expect(subject).toHaveCount(1);
    await expect(subject.getByText(/In transit/i).first()).toBeVisible();

    const verify = subject.locator('form').filter({
      has: manager.getByRole('button', { name: /Verify clearance/i }),
    });
    await verify.getByLabel('Bank reference').fill('STAN-CLR-70414');
    await verify.getByLabel('Value date').fill(await bankValueDateFor(reference));
    await verify.getByRole('button', { name: /Verify clearance/i }).click();

    await expect(
      manager
        .locator('article')
        .filter({ hasText: reference })
        .getByText(/Cleared by the bank/i),
    ).toBeVisible({ timeout: 20_000 });
    await expectNoErrorBoundary(manager);

    // Now the bank has it, transit is empty of it, and the till did not move
    // a second time. The money moved once, in two steps.
    const bankAfterClearing = await inLedger(BANK);
    const transitAfterClearing = await inLedger(TRANSIT);
    const tillAfterClearing = await inLedger(TILL);

    expect(bankAfterClearing.available - bankBefore.available).toBe(amount);
    expect(transitAfterClearing.booked).toBe(transitBefore.booked);
    expect(tillAfterClearing.available).toBe(tillAfterBanking.available);

    // The register names both people and the bank's own reference, which is
    // what makes a clearance auditable rather than merely recorded.
    const cleared = manager.locator('article').filter({ hasText: reference });
    await expect(cleared.getByText(/recorded by Namirembe Grace Atim/i)).toBeVisible();
    await expect(cleared.getByText(/verified by Okello Daniel Omara/i)).toBeVisible();
    await expect(cleared.getByText(/STAN-CLR-70414/)).toBeVisible();

    await managerContext.close();
  });
});

// ===========================================================================
test.describe('the second officer', () => {
  test.use({ storageState: stateFile('manager') });

  test('whoever banked the cash cannot be the one who clears it', async ({ page }) => {
    // The maker-checker refusal, reached through the screen rather than
    // asserted in SQL. A Manager holds both `deposits:create` and
    // `deposits:verify`, so the capability check cannot refuse them — only
    // the rule that the verifier may not be the recorder can, and it is
    // enforced twice: by the function, legibly, and by a CHECK constraint
    // that binds `service_role` too.
    await countTheDrawer(page, TILL);

    const till = await inLedger(TILL);
    const amount = Math.min(20_000, Math.floor(till.available / 2));
    expect(amount).toBeGreaterThan(0);

    await page.goto('/finance/deposits');
    await expectNoErrorBoundary(page);

    const reference = await recordDeposit(
      page,
      amount,
      'Banked and cleared by one person',
    );

    // The deposit this Manager just recorded. Found by its description, so
    // the attempt is made against their own and not against somebody else's.
    const own = page.locator('article').filter({ hasText: reference });
    await expect(own).toHaveCount(1);

    const beforeTransit = await inLedger(TRANSIT);
    const beforeBank = await inLedger(BANK);

    const verify = own.locator('form').filter({
      has: page.getByRole('button', { name: /Verify clearance/i }),
    });
    await verify.getByLabel('Bank reference').fill('SELF-CLEARED-0001');
    await verify.getByLabel('Value date').fill(await bankValueDateFor(reference));
    await verify.getByRole('button', { name: /Verify clearance/i }).click();

    // Refused, and the refusal reaches the screen as an alert rather than
    // being swallowed into a silent no-op.
    //
    // Asserted on the alert, not on a loose text match. An earlier draft of
    // this test matched /cannot|recorded/ anywhere on the page — which every
    // register row satisfies with "recorded by …", so it passed without the
    // refusal ever happening. That is precisely the mistake recommendation
    // L5 exists to catch, made inside L5's own fix, and it is why the real
    // evidence below is the ledger rather than a sentence.
    //
    // The sentence, since L7 — this is the fix that recommendation read as a
    // finding when this file was first written.
    //
    // It used to say "Privilege denied on record.", because
    // `verify_bank_deposit` raised `42501` and that is also what a Row Level
    // Security denial raises, so `mapDatabaseError` could not tell a
    // maker-checker refusal from a missing capability. It now raises `SD001`,
    // which means one thing, and the Manager is told the useful thing: find a
    // colleague. Asserted on the alert and on the words, because the words
    // are what L7 was about.
    const refusal = page.getByRole('alert').filter({
      hasText: /A different authorized officer must complete this action/i,
    });
    await expect(refusal.first()).toBeVisible({ timeout: 20_000 });
    await expect(refusal.first()).toContainText(
      /You cannot approve or verify your own work/i,
    );

    // And it is not the old sentence, which named the wrong cause: this
    // Manager holds `deposits:verify`.
    await expect(page.getByText(/Privilege denied/i)).toHaveCount(0);

    // Nor does the screen carry anything from the database. The raised
    // sentence, the constraint behind it and the deposit's own number stay in
    // the log; none of them is shown.
    const alertText = (await refusal.first().textContent()) ?? '';
    for (const leak of [
      'bank_deposits',
      'verifier_not_recorder',
      'SD001',
      'SQLSTATE',
      'recorded_by',
      'its clearance',
    ]) {
      expect(alertText, `the alert must not contain ${leak}`).not.toContain(leak);
    }

    await expectNoErrorBoundary(page);

    // And nothing moved: the deposit is still in transit, the bank still
    // does not have it, and no clearance was recorded against it.
    await expect(own.getByText(/In transit/i).first()).toBeVisible();

    expect((await inLedger(TRANSIT)).booked).toBe(beforeTransit.booked);
    expect((await inLedger(BANK)).available).toBe(beforeBank.available);

    const stored = await queryHarnessOne<{ status: string; verified_by: string | null }>(
      `select status, verified_by::text
         from public.bank_deposits
        where description = 'Banked and cleared by one person'`,
    );
    expect(stored.status).toBe('submitted');
    expect(stored.verified_by).toBeNull();
  });
});

// ===========================================================================
test.describe('a deposit the bank has no record of', () => {
  test('an investigation is opened, and it posts nothing at all', async ({ browser }) => {
    // Blocker B-1. A bounced or unacknowledged deposit is a question, not an
    // accounting treatment, so the product records the question and posts
    // nothing. This asserts the "nothing" — which is the part that would be
    // easy to get wrong by inventing a write-off.
    const secretaryContext = await browser.newContext({
      storageState: stateFile('secretary'),
    });
    const secretary = await secretaryContext.newPage();

    const managerContext = await browser.newContext({
      storageState: stateFile('manager'),
    });
    const manager = await managerContext.newPage();

    await countTheDrawer(manager, TILL);

    const till = await inLedger(TILL);
    const amount = Math.min(15_000, Math.floor(till.available / 2));
    expect(amount).toBeGreaterThan(0);

    await secretary.goto('/finance/deposits');
    const reference = await recordDeposit(
      secretary,
      amount,
      'Never credited by the bank',
    );
    await secretaryContext.close();

    // Count the journal before, so "posted nothing" is measured rather than
    // believed.
    const entriesBefore = await queryHarnessOne<{ n: string }>(
      `select count(*)::text as n from public.journal_entries`,
    );
    const transitBefore = await inLedger(TRANSIT);

    await manager.goto('/finance/deposits');
    await expectNoErrorBoundary(manager);

    const subject = manager.locator('article').filter({ hasText: reference });
    await expect(subject).toHaveCount(1);

    const investigation = subject.locator('form').filter({
      has: manager.getByRole('button', { name: /^Investigate$/i }),
    });
    await investigation
      .getByLabel(/Open an investigation/i)
      .fill('The bank has no record of the slip');
    await investigation.getByRole('button', { name: /^Investigate$/i }).click();

    await expect(subject.getByText(/Under investigation/i).first()).toBeVisible({
      timeout: 20_000,
    });
    await expect(
      manager.getByText(/The bank has no record of the slip/).first(),
    ).toBeVisible();
    await expectNoErrorBoundary(manager);

    // Not one journal entry was written, and the money is exactly where it
    // was: in transit, spendable by nobody.
    const entriesAfter = await queryHarnessOne<{ n: string }>(
      `select count(*)::text as n from public.journal_entries`,
    );
    expect(entriesAfter.n, 'an investigation is a question, not a posting').toBe(
      entriesBefore.n,
    );
    expect((await inLedger(TRANSIT)).booked).toBe(transitBefore.booked);

    await managerContext.close();
  });
});

// ===========================================================================
test.describe('reversing a clearance', () => {
  test('only the Owner may, and it is undone by contra-entry', async ({ browser }) => {
    // Owner instruction 11: historical journals are never altered or
    // reclassified. A clearance given in error is undone by posting its
    // opposite, so both the mistake and its correction stay on the record.
    const secretaryContext = await browser.newContext({
      storageState: stateFile('secretary'),
    });
    const secretary = await secretaryContext.newPage();

    const managerContext = await browser.newContext({
      storageState: stateFile('manager'),
    });
    const manager = await managerContext.newPage();

    await countTheDrawer(manager, TILL);

    const till = await inLedger(TILL);
    const amount = Math.min(10_000, Math.floor(till.available / 2));
    expect(amount).toBeGreaterThan(0);

    // Banked by one person, cleared by another — the ordinary path.
    await secretary.goto('/finance/deposits');
    const reference = await recordDeposit(secretary, amount, 'Cleared on the wrong slip');
    await secretaryContext.close();

    await manager.goto('/finance/deposits');
    const subject = manager.locator('article').filter({ hasText: reference });
    const verify = subject.locator('form').filter({
      has: manager.getByRole('button', { name: /Verify clearance/i }),
    });
    await verify.getByLabel('Bank reference').fill('WRONG-SLIP-0001');
    await verify.getByLabel('Value date').fill(await bankValueDateFor(reference));
    await verify.getByRole('button', { name: /Verify clearance/i }).click();
    await expect(subject.getByText(/Cleared by the bank/i).first()).toBeVisible({
      timeout: 20_000,
    });

    // A Manager holds `deposits:verify` but not `deposits:reverse`, so the
    // reversal is not offered to the person who gave the clearance.
    await expect(subject.getByRole('button', { name: /Reverse clearance/i })).toHaveCount(
      0,
    );
    await managerContext.close();

    const bankBefore = await inLedger(BANK);
    const transitBefore = await inLedger(TRANSIT);
    const entriesBefore = await queryHarnessOne<{ n: string }>(
      `select count(*)::text as n from public.journal_entries`,
    );

    // --- the Owner reverses it ---------------------------------------------
    const ownerContext = await browser.newContext({ storageState: stateFile('owner') });
    const owner = await ownerContext.newPage();

    await owner.goto('/finance/deposits');
    await expectNoErrorBoundary(owner);

    const ownerSubject = owner.locator('article').filter({ hasText: reference });
    const reversal = ownerSubject.locator('form').filter({
      has: owner.getByRole('button', { name: /Reverse clearance/i }),
    });
    await expect(reversal).toHaveCount(1);

    await reversal
      .getByLabel(/Reverse the clearance/i)
      .fill('The slip belonged to another branch');
    await reversal.getByRole('button', { name: /Reverse clearance/i }).click();

    await expect(ownerSubject.getByText(/Clearance reversed/i).first()).toBeVisible({
      timeout: 20_000,
    });
    await expectNoErrorBoundary(owner);

    // The bank no longer holds it and transit does again — undone, not erased.
    expect(bankBefore.available - (await inLedger(BANK)).available).toBe(amount);
    expect((await inLedger(TRANSIT)).booked - transitBefore.booked).toBe(amount);

    // By contra-entry: a journal was *added*, and the original still stands
    // with its own lines untouched.
    const entriesAfter = await queryHarnessOne<{ n: string }>(
      `select count(*)::text as n from public.journal_entries`,
    );
    expect(
      Number(entriesAfter.n),
      'a reversal posts its opposite rather than deleting the original',
    ).toBeGreaterThan(Number(entriesBefore.n));

    const deposit = await queryHarnessOne<{
      status: string;
      clearance_entry_still_there: boolean;
    }>(
      `select d.status,
              exists (select 1 from public.journal_entries e
                       where e.id = d.clearance_journal_entry_id) as clearance_entry_still_there
         from public.bank_deposits d
        where d.description = 'Cleared on the wrong slip'`,
    );
    expect(deposit.status).toBe('reversed');
    expect(
      deposit.clearance_entry_still_there,
      'the journal that gave the clearance is history and stays',
    ).toBe(true);

    await ownerContext.close();
  });
});
