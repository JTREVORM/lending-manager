import type { Browser, Locator, Page } from '@playwright/test';

import {
  expect,
  expectNoErrorBoundary,
  PASSWORD,
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
 * of. Every purchase in this file together comes to 175,000, so the suite can
 * run against one seeded database twenty times over — which matters, because
 * the first draft spent 570,000 a run and ran the drawer down to 25,803 in an
 * afternoon of local re-runs. The figures are still a counter's real ones.
 */

/** `count` random decimal digits, with no leading zero. */
function randomDigits(count: number): string {
  let digits = String(1 + Math.floor(Math.random() * 9));
  while (digits.length < count) digits += String(Math.floor(Math.random() * 10));
  return digits;
}

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
async function chooseOption(
  scope: Page | Locator,
  field: RegExp | string,
  needle: string,
) {
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

/**
 * The branch the harness seeds, and the one every seeded record belongs to.
 *
 * Named rather than left to the form's default. The branch select is ordered
 * by branch code, and the second branch the cross-branch test creates sorts
 * ahead of this one — which silently moved every other test's agent line to
 * a branch with no seeded drawer behind it.
 */
const HEAD_OFFICE = 'BR2601';

interface Line {
  readonly tillName: string;
  readonly floatAccountId: string;
  readonly ledgerAccountId: string;
  readonly branchCode: string;
}

/**
 * Opens an agent line through `/agency/lines` and returns what the database
 * then holds for it.
 *
 * The screen is the subject here, not a shortcut: a line created by SQL would
 * not prove the Owner's form reaches `register_agency_agent_line` with the
 * branch, the till name and the identifiers it was given.
 */
async function openLine(
  page: Page,
  options: { readonly branchCode?: string } = {},
): Promise<Line> {
  const branchCode = options.branchCode ?? HEAD_OFFICE;
  // Lower case: a till name names a ledger account, and the validator and
  // the column's CHECK both hold it to lower-case letters, digits, hyphens
  // and underscores.
  const tillName = unique('e2e').toLowerCase();

  await page.goto('/agency/lines');
  await expectNoErrorBoundary(page);

  const form = page.getByRole('form', { name: 'Open an agent line' });
  await chooseOption(form, 'Provider', 'Airtel Money (demonstration)');
  await chooseOption(form, 'Branch', branchCode);
  await form.getByLabel(/^till name/i).fill(tillName);
  await form.getByLabel(/^label/i).fill(`Line ${tillName}`);
  // A line number is unique across every line (`agency_float_msisdn_unique`),
  // so each line this suite opens needs its own. Random digits rather than a
  // counter: Playwright replaces the worker process after a failing test,
  // which reloads this module and restarts `sequence` at zero — and the
  // reloaded worker then collided with the lines the previous one had opened.
  await form.getByLabel(/line number/i).fill(`+2567${randomDigits(8)}`);
  await form.getByRole('button', { name: /open the line/i }).click();

  await expect(form.getByLabel(/^till name/i)).toHaveValue('');

  const row = await queryHarnessOne<{
    id: string;
    ledger: string;
    status: string;
    branch: string;
  }>(
    `select f.id::text as id, f.ledger_account_id::text as ledger, f.status,
            b.branch_code as branch
       from public.agency_provider_float_accounts f
       join public.branches b on b.id = f.branch_id
      where f.till_name = $1`,
    [tillName],
  );

  expect(row.status).toBe('active');
  expect(row.branch).toBe(branchCode);

  return {
    tillName,
    floatAccountId: row.id,
    ledgerAccountId: row.ledger,
    branchCode: row.branch,
  };
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
        { float: 20_000, paid: 25_000 },
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
    expect(Number(posted.floatAmount)).toBe(20_000);
    expect(Number(posted.cashAmount)).toBe(25_000);

    // The journal the premium produces: the float at face value, the 5,000
    // difference as an expense, and the cash that actually left.
    const journal = await linesOf(posted.journal!);
    const debits = journal.reduce((sum, l) => sum + Number(l.debit), 0);
    const credits = journal.reduce((sum, l) => sum + Number(l.credit), 0);
    expect(debits).toBe(credits);
    expect(debits).toBe(25_000);

    const premium = journal.find((l) => l.code === '5970');
    expect(premium).toBeDefined();
    expect(Number(premium!.debit)).toBe(5_000);

    expect(await balanceOf(line.ledgerAccountId)).toBe(before + 20_000);
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

    await buyFloat(browser, line, { float: 20_000, paid: 20_000 });
    const held = await balanceOf(line.ledgerAccountId);
    expect(held).toBeGreaterThanOrEqual(20_000);

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
    await buyFloat(browser, line, { float: 10_000, paid: 10_000 });

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

// ===========================================================================
// Decision OD-8 and the payout journal, driven from the counter
// ===========================================================================

/**
 * The ledger balance of one account, by code.
 *
 * `1310` and `4510` are each one account shared by every provider and every
 * line, so these are read as deltas across a step rather than as absolutes.
 */
async function accountBalance(code: string): Promise<number> {
  const row = await queryHarnessOne<{ balance: string }>(
    `select coalesce(bal.balance, 0)::text as balance
       from public.ledger_accounts a
       left join public.ledger_account_balances bal on bal.account_id = a.id
      where a.code = $1`,
    [code],
  );
  return Number(row.balance);
}

/** The commission one agent line is still owed, as the screens read it. */
async function lineCommission(floatAccountId: string): Promise<number> {
  const row = await queryHarnessOne<{ owed: string }>(
    `select commission_outstanding::text as owed
       from public.agency_commission_line_balances
      where float_account_id = $1`,
    [floatAccountId],
  );
  return Number(row.owed);
}

/**
 * Earns commission on one agent line by putting a real customer transaction
 * through the counter.
 *
 * Deliberately the long way round. A payout clears a receivable, and a
 * receivable this test created with an `insert` would prove the payout screen
 * posts *something* rather than that it clears what the counter earned. So
 * the deposit is recorded on the recording screen, submitted by the officer
 * who recorded it, and posted by a second one — the Phase 4B lifecycle,
 * unchanged by this phase — and the commission it accrues is what the payout
 * then pays in.
 *
 * Returns the commission the database recognised, read back rather than
 * recomputed here: the rate is the provider's configuration and this test is
 * not the place to restate it.
 */
async function earnCommission(
  browser: Browser,
  line: Line,
  amount: number,
): Promise<number> {
  const reference = unique('DEP');
  let transactionId = '';

  const cashier = await asRole(browser, 'secretary');
  try {
    await cashier.page.goto('/agency/record');
    await expectNoErrorBoundary(cashier.page);

    // At page level, as `agency.write.spec.ts` addresses the same two fields:
    // the recording screen carries one form and it has no accessible name, so
    // scoping to `form` matches nothing useful.
    await chooseOption(
      cashier.page,
      'Service',
      'Airtel Money (demonstration) — Cash in to a wallet',
    );
    // The branch first. The seeded Secretary is a Head Office account, and
    // Phase 4E's correction means such an officer names the branch before
    // there is a till list at all — a till belongs to a branch.
    await chooseOption(cashier.page, 'Branch', line.branchCode);
    await chooseOption(cashier.page, 'Float till', line.tillName);
    await cashier.page.getByLabel(/amount \(ugx\)/i).fill(String(amount));
    await cashier.page.getByLabel(/customer identifier/i).fill('+256770099500');
    await cashier.page.getByLabel(/provider reference/i).fill(reference);
    await cashier.page.getByRole('button', { name: /record transaction/i }).click();
    await expect(cashier.page.getByLabel(/provider reference/i)).toHaveValue('');

    const row = await queryHarnessOne<{ id: string }>(
      `select id::text as id from public.agency_transactions
        where provider_reference = $1`,
      [reference],
    );
    transactionId = row.id;

    await cashier.page.goto(`/agency/history/${transactionId}`);
    await cashier.page.getByRole('button', { name: /send for verification/i }).click();
    await expect(
      cashier.page
        .getByText(/awaiting verification/i)
        .filter({ visible: true })
        .first(),
    ).toBeVisible();
  } finally {
    await cashier.context.close();
  }

  const checker = await asRole(browser, 'manager');
  try {
    await checker.page.goto(`/agency/history/${transactionId}`);
    await expectNoErrorBoundary(checker.page);
    await checker.page.getByRole('button', { name: /verify and post/i }).click();
    await expect(
      checker.page
        .getByText(/posted/i)
        .filter({ visible: true })
        .first(),
    ).toBeVisible();
  } finally {
    await checker.context.close();
  }

  const posted = await queryHarnessOne<{ status: string; commission: string }>(
    `select status, commission_amount::text as commission
       from public.agency_transactions where id = $1`,
    [transactionId],
  );
  expect(posted.status).toBe('posted');
  expect(Number(posted.commission)).toBeGreaterThan(0);
  return Number(posted.commission);
}

test.describe('commission paid into an agent line', () => {
  test('raises the line’s float, clears the same receivable, and recognises no income twice', async ({
    browser,
  }) => {
    const owner = await asRole(browser, 'owner');
    let line: Line;
    try {
      line = await openLine(owner.page);
    } finally {
      await owner.context.close();
    }

    // Float first: a cash-in sends e-money to the customer, so the line has
    // to be holding some before it can earn anything.
    await buyFloat(browser, line, { float: 60_000, paid: 60_000 });

    const earned = await earnCommission(browser, line, 50_000);
    expect(await lineCommission(line.floatAccountId)).toBe(earned);

    const floatBefore = await balanceOf(line.ledgerAccountId);
    const receivableBefore = await accountBalance('1310');
    const incomeBefore = await accountBalance('4510');
    const reference = unique('PAY');

    // ---- a part payment ---------------------------------------------------
    const part = Math.max(1, Math.floor(earned / 2));

    const payer = await asRole(browser, 'manager');
    try {
      await payer.page.goto(`/agency/money/${PROVIDER}/commission`);
      await expectNoErrorBoundary(payer.page);

      const form = payer.page.getByRole('form', { name: 'Commission paid in' });
      await chooseOption(form, /agent line/i, `Line ${line.tillName}`);
      await form.getByLabel(/^amount \(ugx\)/i).fill(String(part));
      await form.getByLabel(/provider reference/i).fill(reference);
      await form.getByRole('button', { name: /record the payout/i }).click();
      await expect(form.getByLabel(/provider reference/i)).toHaveValue('');

      // ---- the exact journal ----------------------------------------------
      const settlement = await queryHarnessOne<{ id: string; journal: string }>(
        `select id::text as id, journal_entry_id::text as journal
           from public.agency_commission_settlements
          where provider_statement_ref = $1`,
        [reference],
      );

      const journal = await linesOf(settlement.journal);
      const lineCode = await queryHarnessOne<{ code: string }>(
        `select a.code from public.ledger_accounts a
           join public.agency_provider_float_accounts f
             on f.ledger_account_id = a.id
          where f.id = $1`,
        [line.floatAccountId],
      );

      // Two lines, and only two: the line's float debited, the receivable
      // credited. Nothing touches an income account, because the income was
      // recognised when the customer's transaction posted.
      expect(journal).toHaveLength(2);
      // `linesOf` orders by account code, so the receivable comes first.
      expect(journal.map((l) => [l.code, Number(l.debit), Number(l.credit)])).toEqual([
        ['1310', 0, part],
        [lineCode.code, part, 0],
      ]);

      expect(await balanceOf(line.ledgerAccountId)).toBe(floatBefore + part);
      expect(await accountBalance('1310')).toBe(receivableBefore - part);
      expect(await lineCommission(line.floatAccountId)).toBe(earned - part);

      // Decision OD-8's point, and the one a balanced journal would hide:
      // commission income is recognised once, per transaction. A payout that
      // credited 4510 again would double-count it and still balance.
      expect(await accountBalance('4510')).toBe(incomeBefore);

      // ---- the same reference twice ----------------------------------------
      await chooseOption(form, /agent line/i, `Line ${line.tillName}`);
      await form.getByLabel(/^amount \(ugx\)/i).fill('1');
      await form.getByLabel(/provider reference/i).fill(reference);
      await form.getByRole('button', { name: /record the payout/i }).click();
      await expect(
        form
          .getByText(/already|duplicate|recorded/i)
          .filter({ visible: true })
          .first(),
      ).toBeVisible();

      const duplicates = await queryHarness<{ id: string }>(
        `select id::text as id from public.agency_commission_settlements
          where provider_statement_ref = $1`,
        [reference],
      );
      expect(duplicates).toHaveLength(1);
      expect(await balanceOf(line.ledgerAccountId)).toBe(floatBefore + part);

      // ---- more than the line is owed --------------------------------------
      await chooseOption(form, /agent line/i, `Line ${line.tillName}`);
      await form.getByLabel(/^amount \(ugx\)/i).fill(String(earned * 10));
      await form.getByLabel(/provider reference/i).fill(unique('OVER'));
      await form.getByRole('button', { name: /record the payout/i }).click();
      await expect(
        form
          .getByText(/more than|outstanding|owed/i)
          .filter({ visible: true })
          .first(),
      ).toBeVisible();

      // Refused without posting: the float, the receivable and the per-line
      // figure are all where the part payment left them.
      expect(await balanceOf(line.ledgerAccountId)).toBe(floatBefore + part);
      expect(await accountBalance('1310')).toBe(receivableBefore - part);
      expect(await lineCommission(line.floatAccountId)).toBe(earned - part);
      expect(await accountBalance('4510')).toBe(incomeBefore);
    } finally {
      await payer.context.close();
    }
  });
});

// ===========================================================================
// Decision OD-3: a transfer between two branches' lines
// ===========================================================================

/**
 * A second branch, and a Manager who can see only that one.
 *
 * ## Why this is fixture SQL rather than a screen
 *
 * The application has no branch-creation screen: the one branch every seeded
 * record belongs to is created by the `20261010000200` backfill, and opening
 * another is not something this system lets anybody do yet. So the second
 * branch is set up directly, exactly as the harness's own seeder sets up the
 * first — and everything this test is actually about, the lines, the
 * transfer, the authorisation and the posting, goes through the interface.
 *
 * The branch-scoped Manager exists for one assertion that cannot be made any
 * other way: that a Manager at one branch is not shown another branch's
 * float trade. The password hash is the same `scrypt$salt$hash` the harness
 * writes, so this account signs in through the real login form.
 */
async function secondBranch(): Promise<{
  readonly branchId: string;
  readonly branchCode: string;
  readonly managerPhone: string;
}> {
  // `Z…` deliberately, so this branch sorts *after* Head Office.
  //
  // `create_agency_transaction()` stamps a transaction with the recording
  // officer's own branch, and for an officer who has none — Head Office, whose
  // `profiles.branch_id` is null — it falls back to "the alphabetically first
  // active branch". That is harmless while a business has one branch and
  // wrong as soon as it has two: a Head Office cashier naming a Head Office
  // till is told "That till belongs to a different branch", because the
  // transaction was stamped with the other one.
  //
  // It is a real finding and it is recorded as one (§6 and §8 of the delivery
  // report). It is not this phase's to fix: `create_agency_transaction()` is
  // shared with Agent Banking, whose posting behaviour this workstream was
  // told to leave alone. So the fixture avoids provoking it rather than
  // papering over it, and the finding is written down where the Product Owner
  // will see it before a second branch opens.
  const branchCode = `Z${run}${randomDigits(2)}`;
  const branch = await queryHarnessOne<{ id: string }>(
    `insert into public.branches
       (branch_code, name, location, district, status, opened_on, notes)
     values ($1, 'Ntinda Agency Branch', 'Plot 2, Ntinda Road', 'Kampala',
             'active', current_date - 30,
             'Opened by the Phase 4E browser suite for the cross-branch transfer test.')
     returning id::text as id`,
    [branchCode],
  );

  // The four places money sits at a branch. The backfill creates these for
  // the first branch; a transfer needs none of them, but a branch without
  // them is not a branch, and leaving them out would make this fixture a
  // different thing from the one the application knows.
  await queryHarness(
    `insert into public.ledger_accounts
       (code, name, account_type, normal_side, cash_kind, branch_id, parent_id, status)
     select a.code || '-' || $2, a.name || ' (' || $2 || ')', a.account_type,
            a.normal_side, a.cash_kind, $1::uuid, a.parent_id, 'active'
       from public.ledger_accounts a
      where a.cash_kind in ('cash_at_hand', 'bank')
        and a.branch_id is not null
        and a.branch_id = (select id from public.branches
                            where branch_code <> $2 order by created_at limit 1)`,
    [branch.id, branchCode],
  );

  const phone = `+2567721${randomDigits(5)}`;
  const { randomBytes, scryptSync } = await import('node:crypto');
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(PASSWORD, salt, 64).toString('hex');

  const user = await queryHarnessOne<{ id: string }>(
    `insert into auth.users (email, encrypted_password)
     values ($1, $2) returning id::text as id`,
    [`${phone.slice(1)}@phone.lending.invalid`, `scrypt$${salt}$${hash}`],
  );
  const profile = await queryHarnessOne<{ id: string }>(
    `insert into public.profiles (auth_user_id, full_name, phone, email, status, branch_id)
     values ($1, $5, $2, $3, 'active', $4)
     returning id::text as id`,
    [
      user.id,
      phone,
      // Unique per branch, not per run: two tests open a branch of their own
      // now, and `profiles.email` is unique.
      `${branchCode.toLowerCase()}@kyanja.invalid`,
      branch.id,
      `${branchCode} Branch Manager`,
    ],
  );
  await queryHarness(
    `insert into public.user_roles (profile_id, role_key) values ($1, 'manager')`,
    [profile.id],
  );

  return { branchId: branch.id, branchCode, managerPhone: phone };
}

/** The provider's consolidated position, which a transfer must not change. */
async function consolidated(): Promise<{
  held: number;
  out: number;
  in: number;
  purchased: number;
  sold: number;
}> {
  const row = await queryHarnessOne<{
    held: string;
    out: string;
    inward: string;
    purchased: string;
    sold: string;
  }>(
    `select coalesce(sum(float_held), 0)::text             as held,
            coalesce(sum(float_transferred_out), 0)::text  as out,
            coalesce(sum(float_transferred_in), 0)::text   as inward,
            coalesce(sum(float_purchased), 0)::text        as purchased,
            coalesce(sum(float_sold), 0)::text             as sold
       from public.agency_mobile_money_consolidated
      where provider_code = $1`,
    [PROVIDER],
  );
  return {
    held: Number(row.held),
    out: Number(row.out),
    in: Number(row.inward),
    purchased: Number(row.purchased),
    sold: Number(row.sold),
  };
}

/** Records a transfer between two of one provider's lines, as a cashier. */
async function recordTransfer(
  page: Page,
  from: Line,
  to: Line,
  amount: number,
  reference: string,
): Promise<Locator> {
  const form = tradeForm(page);
  await chooseOption(form, /what happened/i, 'We moved float between our own lines');
  await chooseOption(form, /float taken from/i, `Line ${from.tillName}`);
  await chooseOption(form, /float moved into/i, `Line ${to.tillName}`);
  await form.getByLabel(/^float \(ugx\)/i).fill(String(amount));
  await form.getByLabel(/^reference/i).fill(reference);
  await form.getByRole('button', { name: /record, for checking/i }).click();
  return form;
}

test.describe('a float transfer across two branches', () => {
  test('moves nothing until a cross-branch officer checks it, then moves it exactly', async ({
    browser,
  }) => {
    const second = await secondBranch();

    const owner = await asRole(browser, 'owner');
    let source: Line;
    let destination: Line;
    try {
      source = await openLine(owner.page, { branchCode: HEAD_OFFICE });
      destination = await openLine(owner.page, { branchCode: second.branchCode });
    } finally {
      await owner.context.close();
    }

    expect(source.branchCode).not.toBe(destination.branchCode);

    await buyFloat(browser, source, { float: 60_000, paid: 60_000 });

    const sourceBefore = await balanceOf(source.ledgerAccountId);
    const destinationBefore = await balanceOf(destination.ledgerAccountId);
    const groupBefore = await consolidated();
    const reference = unique('XFER');

    // ---- recorded by a cashier, and moving nothing -------------------------
    const cashier = await asRole(browser, 'secretary');
    try {
      await cashier.page.goto(`/agency/money/${PROVIDER}`);
      await expectNoErrorBoundary(cashier.page);
      const form = await recordTransfer(
        cashier.page,
        source,
        destination,
        30_000,
        reference,
      );
      await expect(form.getByLabel(/^reference/i)).toHaveValue('');
    } finally {
      await cashier.context.close();
    }

    const pending = await tradeByReference(reference);
    expect(pending.status).toBe('pending');
    expect(pending.journal).toBeNull();
    expect(await balanceOf(source.ledgerAccountId)).toBe(sourceBefore);
    expect(await balanceOf(destination.ledgerAccountId)).toBe(destinationBefore);

    // ---- a Manager at the other branch is shown none of it -----------------
    const outsider = await browser.newContext();
    try {
      const page = await outsider.newPage();
      await page.goto('/login');
      await page.getByLabel('Phone number').fill(second.managerPhone);
      await page.getByLabel('Password').fill(PASSWORD);
      await page.getByRole('button', { name: /sign in/i }).click();
      await page.waitForURL((url) => !url.pathname.startsWith('/login'), {
        timeout: 20_000,
      });

      await page.goto(`/agency/money/${PROVIDER}`);
      await expectNoErrorBoundary(page);

      // The trade belongs to the sending branch, which this Manager cannot
      // see: the row is not on their register, so there is no button to
      // refuse. `agency-money-float.test.ts` asserts the function's own
      // refusal when the call is made anyway.
      await expect(page.getByRole('row').filter({ hasText: reference })).toHaveCount(0);
      await expect(
        page.getByRole('row').filter({ hasText: source.tillName }),
      ).toHaveCount(0);
      // Their own branch's line is there, so this is branch isolation and
      // not an empty screen.
      await expect(
        page.getByRole('row').filter({ hasText: destination.tillName }).first(),
      ).toBeVisible();
    } finally {
      await outsider.close();
    }

    expect((await tradeByReference(reference)).status).toBe('pending');

    // ---- checked by an officer with authority over both --------------------
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

    // One journal, two lines, no cash: the destination debited, the source
    // credited, the same 50,000 on both sides.
    const journal = await linesOf(posted.journal!);
    expect(journal).toHaveLength(2);
    expect(journal.reduce((t, l) => t + Number(l.debit), 0)).toBe(30_000);
    expect(journal.reduce((t, l) => t + Number(l.credit), 0)).toBe(30_000);

    expect(await balanceOf(source.ledgerAccountId)).toBe(sourceBefore - 30_000);
    expect(await balanceOf(destination.ledgerAccountId)).toBe(destinationBefore + 30_000);

    // The trap decision OD-3 names: consolidated float is unchanged, because
    // the money never left the provider. The transfer shows in its own two
    // columns and in neither the purchase nor the sale total.
    const groupAfter = await consolidated();
    expect(groupAfter.held).toBe(groupBefore.held);
    expect(groupAfter.out).toBe(groupBefore.out + 30_000);
    expect(groupAfter.in).toBe(groupBefore.in + 30_000);
    expect(groupAfter.purchased).toBe(groupBefore.purchased);
    expect(groupAfter.sold).toBe(groupBefore.sold);

    // ---- and a transfer the line cannot cover ------------------------------
    const tooMuch = unique('XOVR');
    const sourceNow = await balanceOf(source.ledgerAccountId);

    const secondCashier = await asRole(browser, 'secretary');
    try {
      await secondCashier.page.goto(`/agency/money/${PROVIDER}`);
      await expectNoErrorBoundary(secondCashier.page);
      await recordTransfer(
        secondCashier.page,
        source,
        destination,
        sourceNow + 10_000,
        tooMuch,
      );
    } finally {
      await secondCashier.context.close();
    }

    expect((await tradeByReference(tooMuch)).status).toBe('pending');

    const refuser = await asRole(browser, 'manager');
    try {
      await refuser.page.goto(`/agency/money/${PROVIDER}`);
      await expectNoErrorBoundary(refuser.page);
      const row = refuser.page.getByRole('row').filter({ hasText: tooMuch });
      await row.getByRole('button', { name: /check and post/i }).click();
      await expect(
        refuser.page
          .getByText(/float|cover|enough/i)
          .filter({ visible: true })
          .first(),
      ).toBeVisible();
    } finally {
      await refuser.context.close();
    }

    // Refused at the point of posting, which is where the float is read under
    // lock. Nothing moved and the record stays for somebody to decide on.
    const refused = await tradeByReference(tooMuch);
    expect(refused.status).toBe('pending');
    expect(refused.journal).toBeNull();
    expect(await balanceOf(source.ledgerAccountId)).toBe(sourceNow);
    expect(await balanceOf(destination.ledgerAccountId)).toBe(destinationBefore + 30_000);
  });
});

// ===========================================================================
// The operating branch, through the counter screen
// ===========================================================================

/**
 * Records one deposit at the counter and returns the page, so a refusal can
 * be read off the screen the officer is looking at.
 *
 * `branch` is the label to pick in the Branch select, or null for an officer
 * who has one of their own and is therefore not offered the choice.
 */
async function recordDeposit(
  page: Page,
  options: {
    readonly branchCode: string | null;
    readonly tillName: string | null;
    readonly amount: number;
    readonly reference: string;
    readonly service?: string;
  },
): Promise<void> {
  await page.goto('/agency/record');
  await expectNoErrorBoundary(page);

  await chooseOption(
    page,
    'Service',
    options.service ?? 'Airtel Money (demonstration) — Cash in to a wallet',
  );
  if (options.branchCode !== null) {
    await chooseOption(page, 'Branch', options.branchCode);
  }
  if (options.tillName !== null) {
    await chooseOption(page, 'Float till', options.tillName);
  }
  await page.getByLabel(/amount \(ugx\)/i).fill(String(options.amount));
  await page.getByLabel(/customer identifier/i).fill('+256770099600');
  await page.getByLabel(/provider reference/i).fill(options.reference);
  await page.getByRole('button', { name: /record transaction/i }).click();
}

/** The branch a recorded transaction landed at, by its reference. */
async function transactionBranch(reference: string): Promise<string | null> {
  const rows = await queryHarness<{ branch: string }>(
    `select b.branch_code as branch
       from public.agency_transactions t
       join public.branches b on b.id = t.branch_id
      where t.provider_reference = $1`,
    [reference],
  );
  return rows[0]?.branch ?? null;
}

/**
 * Puts float on a line directly, as fixture setup.
 *
 * `buyFloat` drives the float-trade screens, which is the right thing when
 * the trade is what is being tested. It is the wrong thing here: a purchase
 * settles from a cash account, the counter screen's branch rule is what this
 * test is about, and a refusal about settlement accounts would say nothing
 * either way. So this posts an opening balance the way the database tests'
 * own fixtures do — one balanced journal, against equity.
 */
async function fundLine(line: Line, amount: number): Promise<void> {
  await queryHarness(
    `select public.post_journal(
        (select branch_id from public.agency_provider_float_accounts where id = $1),
        current_date, $3, 'opening_balance', null, null, null,
        jsonb_build_array(
          jsonb_build_object('account_id', $2::uuid, 'debit', $4::bigint, 'credit', 0),
          jsonb_build_object('account_id', public.ledger_account_by_code('3000'),
            'debit', 0, 'credit', $4::bigint)),
        now(),
        (select p.id from public.profiles p
           join public.user_roles r on r.profile_id = p.id
          where r.role_key = 'owner_admin' order by p.created_at limit 1),
        'browser suite fixture')`,
    [line.floatAccountId, line.ledgerAccountId, `Fixture: fund ${line.tillName}`, amount],
  );
}

test.describe('the operating branch', () => {
  test('is named by a Head Office officer, fixed for a branch one, and never guessed', async ({
    browser,
  }) => {
    const second = await secondBranch();

    const owner = await asRole(browser, 'owner');
    let lineA: Line;
    let lineB: Line;
    try {
      lineA = await openLine(owner.page, { branchCode: HEAD_OFFICE });
      lineB = await openLine(owner.page, { branchCode: second.branchCode });
    } finally {
      await owner.context.close();
    }

    await fundLine(lineA, 30_000);
    await fundLine(lineB, 30_000);

    // ---- the seeded Secretary is a Head Office account ---------------------
    const cashier = await asRole(browser, 'secretary');
    try {
      // Branch A, named.
      const refA = unique('BRA');
      await recordDeposit(cashier.page, {
        branchCode: HEAD_OFFICE,
        tillName: lineA.tillName,
        amount: 10_000,
        reference: refA,
      });
      await expect(cashier.page.getByLabel(/provider reference/i)).toHaveValue('');
      expect(await transactionBranch(refA)).toBe(HEAD_OFFICE);

      // Branch B, named — the same account, a different branch. Under the
      // fallback this was impossible: every one of this officer's
      // transactions went to whichever branch sorted first by code.
      const refB = unique('BRB');
      await recordDeposit(cashier.page, {
        branchCode: second.branchCode,
        tillName: lineB.tillName,
        amount: 10_000,
        reference: refB,
      });
      await expect(cashier.page.getByLabel(/provider reference/i)).toHaveValue('');
      expect(await transactionBranch(refB)).toBe(second.branchCode);

      // ---- no branch chosen -----------------------------------------------
      await cashier.page.goto('/agency/record');
      await expectNoErrorBoundary(cashier.page);
      await chooseOption(
        cashier.page,
        'Service',
        'Airtel Money (demonstration) — Cash in to a wallet',
      );
      // The select opens on no branch at all. A pre-selected first option
      // would be the silent default this correction removed, and the officer
      // would never see the choice they were making.
      await expect(cashier.page.getByLabel('Branch', { exact: true })).toHaveValue('');
      // And with no branch there is no till list, because a till belongs to
      // a branch.
      await expect(cashier.page.getByLabel('Float till', { exact: true })).toHaveCount(0);

      const refNone = unique('BRN');
      await cashier.page.getByLabel(/amount \(ugx\)/i).fill('10000');
      await cashier.page.getByLabel(/customer identifier/i).fill('+256770099601');
      await cashier.page.getByLabel(/provider reference/i).fill(refNone);
      await cashier.page.getByRole('button', { name: /record transaction/i }).click();

      // The browser's own required-field validation stops it before the
      // server is asked, which is the right place for it — and nothing was
      // written either way.
      expect(await transactionBranch(refNone)).toBeNull();

      // ---- the branch and the till disagree -------------------------------
      //
      // The screen will not offer branch A's till while branch B is chosen,
      // so this is driven past the screen: the select is set directly, which
      // is what a stale page or a hand-made request would do. The database
      // refuses it.
      const refMix = unique('BRM');
      await cashier.page.goto('/agency/record');
      await expectNoErrorBoundary(cashier.page);
      await chooseOption(
        cashier.page,
        'Service',
        'Airtel Money (demonstration) — Cash in to a wallet',
      );
      await chooseOption(cashier.page, 'Branch', second.branchCode);
      await chooseOption(cashier.page, 'Float till', lineB.tillName);
      await cashier.page.getByLabel(/amount \(ugx\)/i).fill('10000');
      await cashier.page.getByLabel(/customer identifier/i).fill('+256770099602');
      await cashier.page.getByLabel(/provider reference/i).fill(refMix);
      // Now move the branch back to Head Office without touching the till,
      // which React would normally re-render away.
      await cashier.page
        .getByLabel('Branch', { exact: true })
        .evaluate((select, value) => {
          const field = select as HTMLSelectElement;
          const option = [...field.options].find((o) => o.text.startsWith(value));
          if (option !== undefined) field.value = option.value;
        }, HEAD_OFFICE);
      await cashier.page.getByRole('button', { name: /record transaction/i }).click();

      await expect(
        cashier.page
          .getByText(/different branch|no active till/i)
          .filter({ visible: true })
          .first(),
      ).toBeVisible();
      expect(await transactionBranch(refMix)).toBeNull();
    } finally {
      await cashier.context.close();
    }

    // ---- a branch-assigned cashier is not offered the choice --------------
    const assigned = await browser.newContext();
    try {
      const page = await assigned.newPage();
      await page.goto('/login');
      await page.getByLabel('Phone number').fill(second.managerPhone);
      await page.getByLabel('Password').fill(PASSWORD);
      await page.getByRole('button', { name: /sign in/i }).click();
      await page.waitForURL((url) => !url.pathname.startsWith('/login'), {
        timeout: 20_000,
      });

      await page.goto('/agency/record');
      await expectNoErrorBoundary(page);

      // No select: the branch is theirs and the screen says so.
      await expect(page.getByLabel('Branch', { exact: true })).toHaveCount(0);
      await expect(page.getByText(/recording at/i).first()).toBeVisible();
      await expect(page.getByText(second.branchCode).first()).toBeVisible();

      // And the only tills offered are their own branch's.
      await chooseOption(
        page,
        'Service',
        'Airtel Money (demonstration) — Cash in to a wallet',
      );
      const tills = await page
        .getByLabel('Float till', { exact: true })
        .locator('option')
        .allTextContents();
      expect(tills.some((t) => t.includes(lineB.tillName))).toBe(true);
      expect(tills.some((t) => t.includes(lineA.tillName))).toBe(false);

      const refOwn = unique('BRO');
      await chooseOption(page, 'Float till', lineB.tillName);
      await page.getByLabel(/amount \(ugx\)/i).fill('10000');
      await page.getByLabel(/customer identifier/i).fill('+256770099603');
      await page.getByLabel(/provider reference/i).fill(refOwn);
      await page.getByRole('button', { name: /record transaction/i }).click();
      await expect(page.getByLabel(/provider reference/i)).toHaveValue('');
      expect(await transactionBranch(refOwn)).toBe(second.branchCode);
    } finally {
      await assigned.close();
    }
  });

  test('is required for a bill payment, which has no till at all', async ({
    browser,
  }) => {
    // Rule 5. A water bill is collected into a payable and never touches a
    // float account, so nothing downstream would notice the branch being
    // wrong — which is why the check sits before the float-or-payable split.
    const second = await secondBranch();

    const cashier = await asRole(browser, 'secretary');
    try {
      await cashier.page.goto('/agency/record');
      await expectNoErrorBoundary(cashier.page);
      await chooseOption(
        cashier.page,
        'Service',
        'National Water bills (demonstration) — Water bill',
      );

      // No till for this provider, and still a branch to choose.
      await expect(cashier.page.getByLabel('Float till', { exact: true })).toHaveCount(0);
      await expect(cashier.page.getByLabel('Branch', { exact: true })).toHaveValue('');

      const reference = unique('BIL');
      await chooseOption(cashier.page, 'Branch', second.branchCode);
      await cashier.page.getByLabel(/amount \(ugx\)/i).fill('15000');
      await cashier.page.getByLabel(/customer identifier/i).fill('+256770099604');
      await cashier.page.getByLabel(/provider reference/i).fill(reference);
      await cashier.page.getByRole('button', { name: /record transaction/i }).click();
      await expect(cashier.page.getByLabel(/provider reference/i)).toHaveValue('');

      expect(await transactionBranch(reference)).toBe(second.branchCode);
    } finally {
      await cashier.context.close();
    }
  });
});
