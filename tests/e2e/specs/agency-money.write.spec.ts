import type { Browser, Locator, Page } from '@playwright/test';

import {
  expect,
  expectNoErrorBoundary,
  queryHarness,
  queryHarnessOne,
  stateFile,
  test,
} from './fixtures';

/**
 * Phase 4E Mobile Money, driven through the browser and verified in the
 * ledger.
 *
 * ## What this suite is for
 *
 * The database tests prove the functions post the right journals; 114 of them
 * do, with exact lines. What they cannot prove is that the screens reach
 * those functions with the figures the officer typed, that a pending trade
 * really leaves every balance alone, and that certifying a statement writes
 * nothing. Those are claims about the chain from a form field to a journal
 * line, and only a browser against a real database can make them.
 *
 * ## Why every test opens its own agent line
 *
 * The harness seeds one till per demonstration provider, and two other suites
 * read those tills' balances as fixtures — `agency.spec.ts` asserts the MTN
 * float statement is certifiable, which stops being true the moment the till
 * moves. Phase 4E can open as many lines as it likes, so each test here works
 * on a line it created and spends nothing another suite is counting on.
 *
 * ## Why the amounts are modest
 *
 * A float purchase takes cash out of the branch drawer, which the lending seed
 * leaves at roughly four million and the agency seed has already spent part
 * of. The figures below are a counter's real ones and leave room for the suite
 * to run twice.
 */

/** One suite run's worth of unique names and references. */
const run = Math.random().toString(36).slice(2, 7).toUpperCase();
let sequence = 0;
function unique(prefix: string): string {
  sequence += 1;
  return `${prefix}${run}${String(sequence).padStart(2, '0')}`;
}

/**
 * Picks the option whose label contains `needle`.
 *
 * Playwright's `selectOption` matches a label exactly, and these labels carry
 * live figures — "Line E2EAB01 — BR0001 (holds 60,000)" — so an exact string
 * cannot be written in advance. Reading the options and failing with all of
 * them named is also how a renamed option produces a diagnosis rather than a
 * timeout.
 *
 * The scope is a form rather than the page. Both of these screens carry
 * several forms, and "Provider" or "Agent line" names a field on more than one
 * of them — which is why every form Phase 4E added has an accessible name, and
 * why this takes one.
 */
async function chooseOption(scope: Locator, field: RegExp | string, needle: string) {
  const select =
    typeof field === 'string'
      ? scope.getByLabel(field, { exact: true })
      : scope.getByLabel(field);
  const labels = await select.locator('option').allTextContents();
  const match = labels.find((label) => label.includes(needle));
  if (match === undefined) {
    throw new Error(`No option containing "${needle}" in: ${labels.join(' | ')}`);
  }
  await select.selectOption({ label: match });
}

/** The float-trade recording form, on a provider's Mobile Money screen. */
function tradeForm(page: Page): Locator {
  return page.getByRole('form', { name: 'Record a float trade' });
}

async function asRole(browser: Browser, who: 'owner' | 'manager' | 'secretary') {
  const context = await browser.newContext({ storageState: stateFile(who) });
  return { context, page: await context.newPage() };
}

/** The demonstration provider this suite trades float on. */
const PROVIDER = 'DEMO_AIRTEL';

interface Line {
  readonly tillName: string;
  readonly floatAccountId: string;
  readonly ledgerAccountId: string;
}

/**
 * Opens an agent line through `/agency/lines` and returns what the database
 * then holds for it.
 *
 * The screen is the subject here, not a shortcut: a line created by SQL would
 * not prove the Owner's form reaches `register_agency_agent_line` with the
 * branch, the till name and the identifiers it was given.
 */
async function openLine(page: Page): Promise<Line> {
  // Lower case: a till name names a ledger account, and the validator and
  // the column's CHECK both hold it to lower-case letters, digits, hyphens
  // and underscores.
  const tillName = unique('e2e').toLowerCase();

  await page.goto('/agency/lines');
  await expectNoErrorBoundary(page);

  const form = page.getByRole('form', { name: 'Open an agent line' });
  await chooseOption(form, 'Provider', 'Airtel Money (demonstration)');
  await form.getByLabel(/^till name/i).fill(tillName);
  await form.getByLabel(/^label/i).fill(`Line ${tillName}`);
  // A line number is unique across every line (`agency_float_msisdn_unique`),
  // so each line this suite opens needs its own. Reusing one is how the
  // second test in the file came back "Unique constraint violated on record."
  await form.getByLabel(/line number/i).fill(`+2567${String(70000000 + sequence)}`);
  await form.getByRole('button', { name: /open the line/i }).click();

  await expect(form.getByLabel(/^till name/i)).toHaveValue('');

  const row = await queryHarnessOne<{ id: string; ledger: string; status: string }>(
    `select f.id::text as id, f.ledger_account_id::text as ledger, f.status
       from public.agency_provider_float_accounts f
      where f.till_name = $1`,
    [tillName],
  );

  expect(row.status).toBe('active');

  return { tillName, floatAccountId: row.id, ledgerAccountId: row.ledger };
}

/** The ledger balance of one account, as the balances table holds it. */
async function balanceOf(accountId: string): Promise<number> {
  const row = await queryHarnessOne<{ balance: string }>(
    `select coalesce(
              (select balance::text from public.ledger_account_balances
                where account_id = $1),
              '0') as balance`,
    [accountId],
  );
  return Number(row.balance);
}

/** The lines of one journal entry, by account code. */
async function linesOf(entryId: string) {
  return queryHarness<{ code: string; debit: string; credit: string }>(
    `select a.code, l.debit::text as debit, l.credit::text as credit
       from public.journal_lines l
       join public.ledger_accounts a on a.id = l.account_id
      where l.entry_id = $1
      order by a.code`,
    [entryId],
  );
}

async function tradeByReference(reference: string) {
  return queryHarnessOne<{
    id: string;
    status: string;
    revision: string;
    journal: string | null;
    floatAmount: string;
    cashAmount: string | null;
  }>(
    `select id::text as id, status, revision::text as revision,
            journal_entry_id::text as journal,
            float_amount::text as "floatAmount",
            cash_amount::text as "cashAmount"
       from public.agency_float_trades where reference = $1`,
    [reference],
  );
}

/** Records a float purchase through the form, as a cashier. */
async function recordPurchase(
  page: Page,
  line: Line,
  amounts: { readonly float: number; readonly paid: number },
  reference: string,
): Promise<Locator> {
  const form = tradeForm(page);
  await chooseOption(form, /what happened/i, 'We bought float');
  await chooseOption(form, /float received into/i, `Line ${line.tillName}`);
  await form.getByLabel(/^float \(ugx\)/i).fill(String(amounts.float));
  await form.getByLabel(/^paid \(ugx\)/i).fill(String(amounts.paid));
  await form.getByLabel(/^reference/i).fill(reference);
  await form.getByRole('button', { name: /record, for checking/i }).click();
  return form;
}

/** Checks a pending trade, as a Manager, and asserts the screen agreed. */
async function verifyTrade(page: Page, reference: string): Promise<void> {
  const row = page.getByRole('row').filter({ hasText: reference });
  await row.getByRole('button', { name: /check and post/i }).click();
  await expect(
    page
      .getByText(/posted|verified/i)
      .filter({ visible: true })
      .first(),
  ).toBeVisible();
}

/** Funds a line through the screens: recorded by a cashier, checked by a Manager. */
async function buyFloat(
  browser: Browser,
  line: Line,
  amounts: { readonly float: number; readonly paid: number },
): Promise<string> {
  const reference = unique('BUY');

  const cashier = await asRole(browser, 'secretary');
  try {
    await cashier.page.goto(`/agency/money/${PROVIDER}`);
    await expectNoErrorBoundary(cashier.page);
    const form = await recordPurchase(cashier.page, line, amounts, reference);
    await expect(form.getByLabel(/^reference/i)).toHaveValue('');
  } finally {
    await cashier.context.close();
  }

  const checker = await asRole(browser, 'manager');
  try {
    await checker.page.goto(`/agency/money/${PROVIDER}`);
    await expectNoErrorBoundary(checker.page);
    await verifyTrade(checker.page, reference);
  } finally {
    await checker.context.close();
  }

  const trade = await tradeByReference(reference);
  expect(trade.status).toBe('posted');
  return reference;
}

// ===========================================================================
test.describe('a float purchase at a premium', () => {
  test('moves nothing until it is checked, then posts one balanced journal', async ({
    browser,
  }) => {
    const owner = await asRole(browser, 'owner');
    let line: Line;
    try {
      line = await openLine(owner.page);
    } finally {
      await owner.context.close();
    }

    const before = await balanceOf(line.ledgerAccountId);
    const reference = unique('BUY');

    // ---- recorded, and deliberately left alone ----------------------------
    const cashier = await asRole(browser, 'secretary');
    try {
      await cashier.page.goto(`/agency/money/${PROVIDER}`);
      await expectNoErrorBoundary(cashier.page);
      const form = await recordPurchase(
        cashier.page,
        line,
        { float: 200_000, paid: 205_000 },
        reference,
      );
      await expect(form.getByLabel(/^reference/i)).toHaveValue('');

      // The claim the screen makes in four places, now tested: a recorded
      // trade has touched no balance and written no journal.
      const pending = await tradeByReference(reference);
      expect(pending.status).toBe('pending');
      expect(pending.journal).toBeNull();
      expect(await balanceOf(line.ledgerAccountId)).toBe(before);

      // And the cashier is not offered the decision on their own figures.
      await cashier.page.reload();
      const row = cashier.page.getByRole('row').filter({ hasText: reference });
      await expect(row.getByRole('button', { name: /check and post/i })).toHaveCount(0);
      await expect(row).toContainText(/waiting/i);
    } finally {
      await cashier.context.close();
    }

    // ---- checked by somebody else, and posted -----------------------------
    const checker = await asRole(browser, 'manager');
    try {
      await checker.page.goto(`/agency/money/${PROVIDER}`);
      await expectNoErrorBoundary(checker.page);
      await verifyTrade(checker.page, reference);
    } finally {
      await checker.context.close();
    }

    const posted = await tradeByReference(reference);
    expect(posted.status).toBe('posted');
    expect(posted.journal).not.toBeNull();
    expect(Number(posted.floatAmount)).toBe(200_000);
    expect(Number(posted.cashAmount)).toBe(205_000);

    // The journal the premium produces: the float at face value, the 5,000
    // difference as an expense, and the cash that actually left.
    const journal = await linesOf(posted.journal!);
    const debits = journal.reduce((sum, l) => sum + Number(l.debit), 0);
    const credits = journal.reduce((sum, l) => sum + Number(l.credit), 0);
    expect(debits).toBe(credits);
    expect(debits).toBe(205_000);

    const premium = journal.find((l) => l.code === '5970');
    expect(premium).toBeDefined();
    expect(Number(premium!.debit)).toBe(5_000);

    expect(await balanceOf(line.ledgerAccountId)).toBe(before + 200_000);
  });
});

// ===========================================================================
test.describe('a suspended agent line', () => {
  test('stops new float going in and says why, and keeps what it holds', async ({
    browser,
  }) => {
    const owner = await asRole(browser, 'owner');
    let line: Line;
    try {
      line = await openLine(owner.page);
    } finally {
      await owner.context.close();
    }

    await buyFloat(browser, line, { float: 60_000, paid: 60_000 });
    const held = await balanceOf(line.ledgerAccountId);
    expect(held).toBeGreaterThanOrEqual(60_000);

    // ---- suspended --------------------------------------------------------
    const suspending = await asRole(browser, 'owner');
    try {
      await suspending.page.goto('/agency/lines');
      await expectNoErrorBoundary(suspending.page);
      const form = suspending.page
        .getByRole('group', { name: `Agent line Line ${line.tillName}` })
        .getByRole('form', { name: `Suspend Line ${line.tillName}` });
      await form.getByLabel(/^reason/i).fill('E2E: emergency suspension');
      await form.getByRole('button', { name: /suspend this line/i }).click();
      await expect(
        suspending.page
          .getByText(/suspend/i)
          .filter({ visible: true })
          .first(),
      ).toBeVisible();
    } finally {
      await suspending.context.close();
    }

    const after = await queryHarnessOne<{
      status: string;
      reason: string | null;
      active: boolean;
    }>(
      `select status, status_reason as reason, is_active as active
         from public.agency_provider_float_accounts where id = $1`,
      [line.floatAccountId],
    );
    expect(after.status).toBe('suspended');
    expect(after.active).toBe(false);
    expect(after.reason).toContain('emergency suspension');

    // Decision OD-4: the float stays on the line. Suspension stops activity;
    // it does not take money off the books.
    expect(await balanceOf(line.ledgerAccountId)).toBe(held);

    // ---- and the counter will not buy into it -----------------------------
    const cashier = await asRole(browser, 'secretary');
    try {
      await cashier.page.goto(`/agency/money/${PROVIDER}`);
      await expectNoErrorBoundary(cashier.page);
      const form = tradeForm(cashier.page);
      await chooseOption(form, /what happened/i, 'We bought float');
      await chooseOption(form, /float received into/i, `Line ${line.tillName}`);
      await expect(form.getByText(/this line is suspended/i)).toBeVisible();

      const reference = unique('SUS');
      await form.getByLabel(/^float \(ugx\)/i).fill('10000');
      await form.getByLabel(/^paid \(ugx\)/i).fill('10000');
      await form.getByLabel(/^reference/i).fill(reference);
      await form.getByRole('button', { name: /record, for checking/i }).click();

      // Refused by the database, reported on the screen, and — the part that
      // matters at a counter — the typed figures are still there.
      await expect(
        form
          .getByText(/suspended|not active/i)
          .filter({ visible: true })
          .first(),
      ).toBeVisible();
      await expect(form.getByLabel(/^reference/i)).toHaveValue(reference);

      const rows = await queryHarness<{ id: string }>(
        `select id::text as id from public.agency_float_trades where reference = $1`,
        [reference],
      );
      expect(rows).toHaveLength(0);
    } finally {
      await cashier.context.close();
    }
  });
});

// ===========================================================================
test.describe('certifying a provider statement', () => {
  test('records the difference and writes no journal line at all', async ({
    browser,
  }) => {
    const owner = await asRole(browser, 'owner');
    let line: Line;
    try {
      line = await openLine(owner.page);
    } finally {
      await owner.context.close();
    }

    const statement = unique('STMT');
    const today = new Date().toISOString().slice(0, 10);

    // A Manager submits: our books recognised nothing on a line opened a
    // moment ago, and the provider's statement claims 7,500. That difference
    // is the whole point — it must survive certification.
    const submitting = await asRole(browser, 'manager');
    try {
      await submitting.page.goto(`/agency/money/${PROVIDER}/statements`);
      await expectNoErrorBoundary(submitting.page);
      const form = submitting.page.getByRole('form', {
        name: 'Reconcile a provider statement',
      });
      await chooseOption(form, /agent line/i, `Line ${line.tillName}`);
      await form.getByLabel(/statement period starts/i).fill(today);
      await form.getByLabel(/statement period ends/i).fill(today);
      await form.getByLabel(/commission the provider reports/i).fill('7500');
      await form.getByLabel(/statement reference/i).fill(statement);
      await form.getByRole('button', { name: /submit for certification/i }).click();
      await expect(form.getByLabel(/statement reference/i)).toHaveValue('');
    } finally {
      await submitting.context.close();
    }

    const open = await queryHarnessOne<{
      id: string;
      status: string;
      system: string;
      reported: string;
      variance: string;
    }>(
      `select id::text as id, status,
              system_commission_earned::text as system,
              provider_reported_commission::text as reported,
              variance::text as variance
         from public.agency_commission_reconciliations where statement_ref = $1`,
      [statement],
    );
    expect(open.status).toBe('open');
    expect(Number(open.system)).toBe(0);
    expect(Number(open.reported)).toBe(7_500);
    expect(Number(open.variance)).toBe(7_500);

    // Every journal entry in the books, counted before the certification.
    const entriesBefore = await queryHarnessOne<{ count: string }>(
      `select count(*)::text as count from public.journal_entries`,
    );

    const certifying = await asRole(browser, 'owner');
    try {
      await certifying.page.goto(`/agency/money/${PROVIDER}/statements`);
      await expectNoErrorBoundary(certifying.page);
      const form = certifying.page.getByRole('form', {
        name: `Certify ${statement}`,
      });
      await form.getByRole('button', { name: /certify/i }).click();
      await expect(
        certifying.page
          .getByText(/certified/i)
          .filter({ visible: true })
          .first(),
      ).toBeVisible();
    } finally {
      await certifying.context.close();
    }

    const certified = await queryHarnessOne<{
      status: string;
      variance: string;
      reconciler: string | null;
    }>(
      `select status, variance::text as variance, reconciled_by::text as reconciler
         from public.agency_commission_reconciliations where statement_ref = $1`,
      [statement],
    );
    expect(certified.status).toBe('certified');
    expect(certified.reconciler).not.toBeNull();

    // Decision OD-2, end to end: certification settles nothing. The variance
    // is unchanged and not one journal entry was written.
    expect(Number(certified.variance)).toBe(7_500);

    const entriesAfter = await queryHarnessOne<{ count: string }>(
      `select count(*)::text as count from public.journal_entries`,
    );
    expect(entriesAfter.count).toBe(entriesBefore.count);

    // And the screen keeps saying so, rather than showing the row as settled.
    const reader = await asRole(browser, 'manager');
    try {
      await reader.page.goto(`/agency/money/${PROVIDER}/statements`);
      await expectNoErrorBoundary(reader.page);
      const row = reader.page.getByRole('row').filter({ hasText: statement });
      await expect(row).toContainText(/still different/i);
    } finally {
      await reader.context.close();
    }
  });
});

// ===========================================================================
test.describe('closing an agent line', () => {
  test('is offered while it holds nothing, and withdrawn once it holds float', async ({
    browser,
  }) => {
    const owner = await asRole(browser, 'owner');
    let line: Line;
    try {
      line = await openLine(owner.page);

      // A line with nothing on it: `agency_agent_line_obligations()` comes
      // back empty, so the screen offers the close.
      await owner.page.goto('/agency/lines');
      await expectNoErrorBoundary(owner.page);
      await expect(
        owner.page.getByRole('form', { name: `Close Line ${line.tillName}` }),
      ).toBeVisible();
    } finally {
      await owner.context.close();
    }

    // ---- fund it, and closing stops being offered -------------------------
    await buyFloat(browser, line, { float: 40_000, paid: 40_000 });

    const blocked = await asRole(browser, 'owner');
    try {
      await blocked.page.goto('/agency/lines');
      await expectNoErrorBoundary(blocked.page);
      const card = blocked.page.getByRole('group', {
        name: `Agent line Line ${line.tillName}`,
      });
      await expect(
        card.getByRole('form', { name: `Close Line ${line.tillName}` }),
      ).toHaveCount(0);
      await expect(card).toContainText(/closing this line is blocked by/i);
      await expect(card).toContainText(/float/i);
    } finally {
      await blocked.context.close();
    }

    // The obligation the screen shows is the function's own answer, not a
    // second opinion computed in the page.
    const obligations = await queryHarnessOne<{ obligations: string[] }>(
      `select public.agency_agent_line_obligations($1) as obligations`,
      [line.floatAccountId],
    );
    expect(obligations.obligations.length).toBeGreaterThan(0);
  });
});
