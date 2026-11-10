import type { Browser, Page } from '@playwright/test';

import {
  expect,
  expectNoErrorBoundary,
  queryHarness,
  queryHarnessOne,
  stateFile,
  test,
} from './fixtures';

/**
 * The agency counter, driven through the browser, verified in the ledger.
 *
 * ## Why this file is separate from `agency.spec.ts`
 *
 * That one proves the fourteen screens render, carry the database's figures
 * and refuse the wrong role. It posts nothing, and it runs on both the
 * desktop and the mobile profile - which is exactly why it must post
 * nothing, or every financial flow would run twice against one seeded
 * counter.
 *
 * This file posts. It is a `.write.spec.ts`, which the Playwright config
 * runs on the desktop project only, and every test builds its own
 * transaction through the interface rather than consuming a seeded one. The
 * harness's own fixtures - the pending transaction, the open float
 * statement, the recorded settlement - are read by the other suite and are
 * never touched here.
 *
 * ## What it asserts that a browser alone cannot
 *
 * After every financial action it reads the database: the journal entry and
 * its lines, the transaction's status and revision, the audit row and who
 * wrote it. A screen saying "Verified and posted" is not evidence that one
 * balanced journal exists, and one journal is the whole claim.
 *
 * ## Why the amounts are small
 *
 * Every deposit recorded here takes value out of the MTN demonstration till,
 * which the harness funds with 1,500,000 and the seed has already spent part
 * of. The figures below are a counter's real ones and leave the till with
 * room for the suite to run twice.
 */

/** One suite run's worth of unique references. */
const run = Math.random().toString(36).slice(2, 8).toUpperCase();
let sequence = 0;
function reference(): string {
  sequence += 1;
  return `W${run}${String(sequence).padStart(3, '0')}`;
}

interface Recorded {
  readonly id: string;
  readonly reference: string;
}

/** Signs nobody in: it reuses the storage state `auth.setup.ts` wrote. */
async function asRole(browser: Browser, who: 'owner' | 'manager' | 'secretary') {
  const context = await browser.newContext({ storageState: stateFile(who) });
  return { context, page: await context.newPage() };
}

/**
 * Records one transaction through the form and returns what the database
 * then holds for it.
 *
 * The page is left where it is, so a caller can record a second customer
 * from the same open form - which is the thing Phase 4D-F exists to fix.
 */
async function recordOne(
  page: Page,
  details: { amount: number; customer: string },
): Promise<Recorded> {
  const ref = reference();

  await page
    .getByLabel('Service', { exact: true })
    .selectOption({ label: await optionFor(page) });
  // The branch, then the till, both by name.
  //
  // The branch because Phase 4E's correction removed the fallback that used
  // to pick one: the seeded Secretary is a Head Office account, and such an
  // officer now names the branch — and until they do there is no till list
  // at all, because a till belongs to a branch.
  //
  // The till because Phase 4E opens agent lines of its own against this
  // provider, which is what a branch with two SIMs looks like and what
  // decision OD-3 exists for. The form's default is the first till in the
  // list, so leaving it alone recorded these customers against whichever line
  // happened to sort first, and five tests in this file failed for
  // insufficient float on a line they had never heard of.
  await page
    .getByLabel('Branch', { exact: true })
    .selectOption({ label: await branchOptionFor(page) });
  await page
    .getByLabel('Float till', { exact: true })
    .selectOption({ label: await tillOptionFor(page) });
  await page.getByLabel(/amount \(ugx\)/i).fill(String(details.amount));
  await page.getByLabel(/customer identifier/i).fill(details.customer);
  await page.getByLabel(/provider reference/i).fill(ref);
  await page.getByRole('button', { name: /record transaction/i }).click();

  // Waiting on the success alert alone would be a trap, and this suite fell
  // into it: the alert from the previous customer is still on screen when
  // the next submission starts, so it matches instantly and the assertion
  // passes before the server has done anything. The cleared reference is a
  // signal that only a confirmed success produces.
  await expect(page.getByLabel(/provider reference/i)).toHaveValue('');
  await expect(
    page
      .getByText(/transaction recorded/i)
      .filter({ visible: true })
      .first(),
  ).toBeVisible();

  const row = await queryHarnessOne<{ id: string }>(
    `select id::text as id from public.agency_transactions where provider_reference = $1`,
    [ref],
  );
  return { id: row.id, reference: ref };
}

/**
 * The service this suite posts against, as the recording form lists it.
 *
 * Airtel rather than MTN, deliberately. The harness seeds an open float
 * statement for the MTN till, and `agency.spec.ts` asserts that a Manager is
 * offered its certification - which the database refuses, correctly, once
 * the till's balance has moved since the reading was taken. Every deposit
 * recorded here moves a till, so posting against MTN would quietly invalidate
 * another suite's fixture and leave it failing for a reason that had nothing
 * to do with it.
 *
 * Nothing reads the Airtel till's balance as a fixture, so it is this
 * suite's to spend.
 */
const AIRTEL_DEPOSIT = 'Airtel Money (demonstration) — Cash in to a wallet';

/**
 * The exact option label for the branch the harness seeds.
 *
 * `BR2601` is the branch every seeded record belongs to, created by the
 * `20261010000200` backfill. The label carries its name, so it is read off
 * the select rather than written here.
 */
async function branchOptionFor(page: Page): Promise<string> {
  const labels = await page
    .getByLabel('Branch', { exact: true })
    .locator('option')
    .allTextContents();
  const match = labels.find((label) => label.startsWith('BR2601'));
  if (match === undefined) {
    throw new Error(`No seeded branch in: ${labels.join(' | ')}`);
  }
  return match;
}

/**
 * The exact option label for the seeded Airtel till.
 *
 * The label carries the balance it holds, so it cannot be written in advance;
 * `main` is the name `ensure_agency_float_account()` gives the first till of
 * a provider at a branch, and it is the one the harness funds.
 */
async function tillOptionFor(page: Page): Promise<string> {
  const labels = await page
    .getByLabel('Float till', { exact: true })
    .locator('option')
    .allTextContents();
  const match = labels.find((label) => label.startsWith('main —'));
  if (match === undefined) {
    throw new Error(`No seeded "main" till in: ${labels.join(' | ')}`);
  }
  return match;
}

/** The exact option label for the demonstration deposit service. */
async function optionFor(page: Page): Promise<string> {
  const labels = await page
    .getByLabel('Service', { exact: true })
    .locator('option')
    .allTextContents();
  const match = labels.find((label) => label.includes(AIRTEL_DEPOSIT));
  if (match === undefined) {
    throw new Error(`No Airtel demonstration deposit service in: ${labels.join(' | ')}`);
  }
  return match;
}

/** The lines of one transaction's journal, by account code. */
async function linesOf(transactionId: string) {
  return queryHarness<{ code: string; debit: string; credit: string }>(
    `select a.code, l.debit::text as debit, l.credit::text as credit
       from public.agency_transactions t
       join public.journal_lines l on l.entry_id = t.journal_entry_id
       join public.ledger_accounts a on a.id = l.account_id
      where t.id = $1
      order by a.code`,
    [transactionId],
  );
}

async function statusOf(transactionId: string) {
  return queryHarnessOne<{
    status: string;
    revision: string;
    journal: string | null;
    commission: string;
  }>(
    `select status, revision::text as revision,
            journal_entry_id::text as journal, commission_amount::text as commission
       from public.agency_transactions where id = $1`,
    [transactionId],
  );
}

async function auditActions(transactionId: string): Promise<string[]> {
  const rows = await queryHarness<{ action: string }>(
    `select action from public.agency_transaction_audit_log
      where transaction_id = $1 order by created_at, action`,
    [transactionId],
  );
  return rows.map((r) => r.action);
}

// ===========================================================================
test.describe('recording two customers from one open form', () => {
  test.use({ storageState: stateFile('secretary') });

  test('records them as two transactions, not one returned twice', async ({ page }) => {
    // The Phase 4D-F defect, end to end. The form used to mint one
    // idempotency key per mounted page, so this second customer came back as
    // the first customer's transaction and the screen said "Recorded".
    await page.goto('/agency/record');
    await expectNoErrorBoundary(page);

    const first = await recordOne(page, { amount: 12_000, customer: '+256770090001' });
    const second = await recordOne(page, { amount: 34_000, customer: '+256770090002' });

    expect(second.id).not.toBe(first.id);

    const rows = await queryHarness<{
      id: string;
      amount: string;
      customer: string;
      key: string;
    }>(
      `select id::text as id, principal_amount::text as amount,
              customer_identifier as customer, idempotency_key as key
         from public.agency_transactions
        where provider_reference in ($1, $2)
        order by principal_amount`,
      [first.reference, second.reference],
    );

    expect(rows).toHaveLength(2);
    expect(rows.map((r) => Number(r.amount))).toEqual([12_000, 34_000]);
    expect(rows[0]?.customer).toBe('+256770090001');
    expect(rows[1]?.customer).toBe('+256770090002');
    // Two submissions, two keys. One key would mean the database had been
    // asked the same question twice.
    expect(rows[0]?.key).not.toBe(rows[1]?.key);
  });

  test('clears the customer between transactions', async ({ page }) => {
    await page.goto('/agency/record');
    await recordOne(page, { amount: 11_000, customer: '+256770090003' });

    // A form still holding the last customer is how the same person gets
    // recorded twice.
    await expect(page.getByLabel(/customer identifier/i)).toHaveValue('');
    await expect(page.getByLabel(/provider reference/i)).toHaveValue('');
    await expect(page.getByLabel(/amount \(ugx\)/i)).toHaveValue('');
  });
});

// ===========================================================================
test.describe('submitting and verifying', () => {
  test('a second officer posts it, and exactly one journal exists', async ({
    browser,
  }) => {
    const secretary = await asRole(browser, 'secretary');
    const manager = await asRole(browser, 'manager');

    try {
      await secretary.page.goto('/agency/record');
      const recorded = await recordOne(secretary.page, {
        amount: 20_000,
        customer: '+256770090010',
      });

      // Submit, as the officer who recorded it.
      await secretary.page.goto(`/agency/history/${recorded.id}`);
      await secretary.page
        .getByRole('button', { name: /send for verification/i })
        .click();
      // Not the success alert: submitting moves the transaction on, the page
      // revalidates, and the control that carried the message is replaced by
      // the next one. What persists - and what actually matters - is the
      // status.
      await expect(
        secretary.page
          .getByText(/awaiting verification/i)
          .filter({ visible: true })
          .first(),
      ).toBeVisible();

      const submitted = await statusOf(recorded.id);
      expect(submitted.status).toBe('awaiting_verification');
      expect(submitted.journal).toBeNull();

      // The recorder is offered no way to verify their own.
      await secretary.page.reload();
      await expect(
        secretary.page.getByRole('button', { name: /verify and post/i }),
      ).toHaveCount(0);
      await expect(
        secretary.page
          .getByText(/second officer|cannot verify/i)
          .filter({ visible: true })
          .first(),
      ).toBeVisible();

      // The second officer posts it.
      await manager.page.goto(`/agency/history/${recorded.id}`);
      await manager.page.getByRole('button', { name: /verify and post/i }).click();
      // Same again: the posted transaction renders the reversal control, so
      // the proof is that the journal is no longer absent.
      await expect(manager.page.getByText('Not posted')).toHaveCount(0);

      const posted = await statusOf(recorded.id);
      expect(posted.status).toBe('posted');
      expect(posted.journal).not.toBeNull();

      // One journal, and it balances. 1.20% of 20,000, half-up, is 240.
      const lines = await linesOf(recorded.id);
      const debits = lines.reduce((t, l) => t + Number(l.debit), 0);
      const credits = lines.reduce((t, l) => t + Number(l.credit), 0);
      expect(debits).toBe(credits);
      expect(Number(posted.commission)).toBe(240);
      expect(lines.some((l) => l.code === '1310' && Number(l.debit) === 240)).toBe(true);

      const entries = await queryHarness(
        `select 1 from public.journal_entries e
           join public.agency_transactions t on t.journal_entry_id = e.id
          where t.id = $1`,
        [recorded.id],
      );
      expect(entries).toHaveLength(1);

      // Two 'submit' rows: one for recording the draft and one for handing
      // it to a second officer, which is how the engine has always named
      // them. Then the verification, then the posting itself.
      expect(await auditActions(recorded.id)).toEqual([
        'submit',
        'submit',
        'post',
        'verify',
      ]);
    } finally {
      await secretary.context.close();
      await manager.context.close();
    }
  });

  test('a stale screen is refused, and the reload posts once', async ({ browser }) => {
    const secretary = await asRole(browser, 'secretary');
    const manager = await asRole(browser, 'manager');
    const owner = await asRole(browser, 'owner');

    try {
      await secretary.page.goto('/agency/record');
      const recorded = await recordOne(secretary.page, {
        amount: 100_000,
        customer: '+256770090011',
      });
      await secretary.page.goto(`/agency/history/${recorded.id}`);
      await secretary.page
        .getByRole('button', { name: /send for verification/i })
        .click();
      // Not the success alert: submitting moves the transaction on, the page
      // revalidates, and the control that carried the message is replaced by
      // the next one. What persists - and what actually matters - is the
      // status.
      await expect(
        secretary.page
          .getByText(/awaiting verification/i)
          .filter({ visible: true })
          .first(),
      ).toBeVisible();

      // The manager opens the transaction and leaves it open.
      await manager.page.goto(`/agency/history/${recorded.id}`);
      await expect(
        manager.page.getByRole('button', { name: /verify and post/i }),
      ).toBeVisible();
      const before = await statusOf(recorded.id);

      // The Owner authorises a different commission behind them.
      await owner.page.goto(`/agency/history/${recorded.id}`);
      await owner.page.getByLabel(/commission to authorise/i).fill('2500');

      // Scoped to the exception form and addressed by field name: three
      // controls on this page have a Reason, and `Label` appends a visually
      // hidden "(required)" to the accessible name, so an anchored
      // /^reason$/ matches none of them.
      const exception = owner.page.locator('form', {
        has: owner.page.locator('input[name="proposedAmount"]'),
      });
      await exception.locator('input[name="reason"]').fill('Promotional rate this week');
      await exception.locator('input[name="evidence"]').fill('MTN statement 4D-F');
      await exception.getByRole('button', { name: /authorise/i }).click();
      await expect(
        owner.page
          .getByText(/difference authorised/i)
          .filter({ visible: true })
          .first(),
      ).toBeVisible();

      const changed = await statusOf(recorded.id);
      expect(Number(changed.revision)).toBeGreaterThan(Number(before.revision));

      // The manager presses Verify on the screen they already had.
      await manager.page.getByRole('button', { name: /verify and post/i }).click();
      await expect(
        manager.page
          .getByText(/changed|reload/i)
          .filter({ visible: true })
          .first(),
      ).toBeVisible();

      const refused = await statusOf(recorded.id);
      expect(refused.status).toBe('awaiting_verification');
      expect(refused.journal).toBeNull();

      // Reloaded, the same manager sees the new figure and posts it.
      await manager.page.reload();
      await manager.page.getByRole('button', { name: /verify and post/i }).click();
      await expect(manager.page.getByText('Not posted')).toHaveCount(0);

      const posted = await statusOf(recorded.id);
      expect(posted.status).toBe('posted');
      expect(Number(posted.commission)).toBe(2_500);

      const lines = await linesOf(recorded.id);
      expect(lines.reduce((t, l) => t + Number(l.debit), 0)).toBe(
        lines.reduce((t, l) => t + Number(l.credit), 0),
      );
      expect(lines.some((l) => l.code === '1310' && Number(l.debit) === 2_500)).toBe(
        true,
      );

      const entries = await queryHarness(
        `select 1 from public.journal_entries e
           join public.agency_transactions t on t.journal_entry_id = e.id
          where t.id = $1`,
        [recorded.id],
      );
      expect(entries).toHaveLength(1);

      expect(await auditActions(recorded.id)).toContain('commission_exception');
    } finally {
      await secretary.context.close();
      await manager.context.close();
      await owner.context.close();
    }
  });
});

// ===========================================================================
test.describe('authorising a commission difference', () => {
  test('will not be submitted without evidence', async ({ browser }) => {
    const secretary = await asRole(browser, 'secretary');
    const owner = await asRole(browser, 'owner');

    try {
      await secretary.page.goto('/agency/record');
      const recorded = await recordOne(secretary.page, {
        amount: 60_000,
        customer: '+256770090020',
      });

      await owner.page.goto(`/agency/history/${recorded.id}`);
      await owner.page.getByLabel(/commission to authorise/i).fill('1500');
      const exception = owner.page.locator('form', {
        has: owner.page.locator('input[name="proposedAmount"]'),
      });
      await exception.locator('input[name="reason"]').fill('No evidence attached');
      await exception.getByRole('button', { name: /authorise/i }).click();

      // The field is required, so the browser never submits — and nothing
      // was written. The database refuses a blank evidence string too; that
      // is asserted in tests/db/agency-transaction-engine.test.ts, where a
      // caller can actually send one.
      await expect(owner.page.getByLabel(/external evidence/i)).toHaveAttribute(
        'required',
        '',
      );
      const row = await queryHarnessOne<{ reason: string | null }>(
        `select commission_exception_reason as reason
           from public.agency_transactions where id = $1`,
        [recorded.id],
      );
      expect(row.reason).toBeNull();
    } finally {
      await secretary.context.close();
      await owner.context.close();
    }
  });
});

// ===========================================================================
test.describe('settling and reversing', () => {
  test.use({ storageState: stateFile('owner') });

  test('records a commission remittance and then reverses it', async ({ page }) => {
    const outstandingBefore = await commissionOutstanding();
    expect(outstandingBefore).toBeGreaterThan(0);

    const amount = Math.min(1_000, outstandingBefore);
    const statementRef = `STMT-${reference()}`;

    await page.goto('/agency/commission');
    await expectNoErrorBoundary(page);
    await page.getByLabel(/amount received/i).fill(String(amount));
    await page.getByLabel(/provider statement reference/i).fill(statementRef);
    await page.getByRole('button', { name: /record remittance/i }).click();
    await expect(
      page
        .getByText(/commission settlement recorded/i)
        .filter({ visible: true })
        .first(),
    ).toBeVisible();

    const settlement = await queryHarnessOne<{
      id: string;
      status: string;
      journal: string | null;
      amount: string;
    }>(
      `select id::text as id, status, journal_entry_id::text as journal,
              settlement_amount::text as amount
         from public.agency_commission_settlements
        where provider_statement_ref = $1`,
      [statementRef],
    );
    expect(settlement.status).toBe('posted');
    expect(settlement.journal).not.toBeNull();
    expect(Number(settlement.amount)).toBe(amount);

    // Receiving commission reduces what is outstanding.
    expect(await commissionOutstanding()).toBe(outstandingBefore - amount);

    // And reversing it puts the receivable back, as a contra entry rather
    // than a deletion.
    await page.reload();
    const row = page.locator('tr', { hasText: statementRef });
    await row
      .locator('input[name="reason"]')
      .fill('Recorded against the wrong statement.');
    await row.getByRole('button', { name: /^reverse$/i }).click();
    // The reversal replaces the form in that cell with the reason, so the
    // success alert it carried is gone by the time it could be read. The
    // row's own status is what persists.
    await expect(row.getByText(/^Reversed$/)).toBeVisible();

    const reversed = await queryHarnessOne<{
      status: string;
      journal: string | null;
      contra: string | null;
    }>(
      `select status, journal_entry_id::text as journal,
              reversal_entry_id::text as contra
         from public.agency_commission_settlements where id = $1`,
      [settlement.id],
    );
    expect(reversed.status).toBe('reversed');
    expect(reversed.journal).not.toBeNull();
    expect(reversed.contra).not.toBeNull();
    expect(reversed.contra).not.toBe(reversed.journal);
    expect(await commissionOutstanding()).toBe(outstandingBefore);
  });
});

/** What the database says is outstanding, summed over the demonstration providers. */
async function commissionOutstanding(): Promise<number> {
  const rows = await queryHarness<{ outstanding: string }>(
    `select commission_outstanding::text as outstanding
       from public.agency_commission_summary`,
  );
  return rows.reduce((total, r) => total + Number(r.outstanding), 0);
}

// ===========================================================================
test.describe('reconciling the drawer', () => {
  test('a manager counts it and an Owner certifies, never the same officer', async ({
    browser,
  }) => {
    const manager = await asRole(browser, 'manager');
    const owner = await asRole(browser, 'owner');

    try {
      // A date of its own: one count per account per day is a unique index,
      // the harness already counted this drawer today, and a stack that has
      // run this suite before has taken a day or two more. So the free one
      // is looked up rather than assumed - which also keeps the test
      // re-runnable against a long-lived local stack.
      const when = await freeCountDate();
      const date = when.toISOString().slice(0, 10);
      // The register has no notes column, so the date is what identifies
      // this count in it. Rendered the way `DateValue` renders it.
      const shown = when.toLocaleDateString('en-GB', {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
        timeZone: 'UTC',
      });

      const booksSay = await cashAtHand();

      await manager.page.goto('/agency/reconciliation/cash');
      await expectNoErrorBoundary(manager.page);
      await manager.page.getByLabel(/counted \(ugx\)/i).fill(String(booksSay));
      await manager.page.getByLabel(/date counted/i).fill(date);
      await manager.page.getByLabel(/notes/i).fill('Counted for the write suite.');
      await manager.page.getByRole('button', { name: /record count/i }).click();
      await expect(
        manager.page.getByText(/count recorded/i).filter({ visible: true }),
      ).toBeVisible();

      const count = await queryHarnessOne<{
        id: string;
        status: string;
        variance: string;
        created_by: string;
      }>(
        `select id::text as id, status, variance::text as variance,
                created_by::text as created_by
           from public.agency_cash_reconciliations
          where reconciliation_date = $1`,
        [date],
      );
      expect(count.status).toBe('open');
      expect(Number(count.variance)).toBe(0);

      // The officer who counted is told they may not certify it.
      await manager.page.reload();
      const ownRow = manager.page.locator('tr', { hasText: shown });
      await expect(
        ownRow.getByText(/you recorded this reading/i).filter({ visible: true }),
      ).toBeVisible();
      await expect(ownRow.getByRole('button', { name: /^certify$/i })).toHaveCount(0);

      // A second officer does.
      await owner.page.goto('/agency/reconciliation/cash');
      const row = owner.page.locator('tr', { hasText: shown });
      await row.getByRole('button', { name: /^certify$/i }).click();
      // The badge, not the alert: certifying replaces the control that
      // carried the message, which is the third time this suite has had to
      // learn that a revalidated screen keeps its state and loses its
      // sentence.
      await expect(row.getByText(/^Certified$/)).toBeVisible();

      const certified = await queryHarnessOne<{
        status: string;
        reconciled_by: string | null;
        entry: string | null;
      }>(
        `select status, reconciled_by::text as reconciled_by,
                variance_journal_entry_id::text as entry
           from public.agency_cash_reconciliations where id = $1`,
        [count.id],
      );
      expect(certified.status).toBe('reconciled');
      expect(certified.reconciled_by).not.toBeNull();
      expect(certified.reconciled_by).not.toBe(count.created_by);
      // A count that agrees writes no journal. Nothing moved, so nothing posts.
      expect(certified.entry).toBeNull();
    } finally {
      await manager.context.close();
      await owner.context.close();
    }
  });
});

/**
 * The most recent day this drawer has not been counted on.
 *
 * Walks back from yesterday. Twenty tries is far more than a test run needs
 * and still fails loudly rather than looping if something is wrong.
 */
async function freeCountDate(): Promise<Date> {
  const taken = new Set(
    (
      await queryHarness<{ on: string }>(
        `select to_char(reconciliation_date, 'YYYY-MM-DD') as on
           from public.agency_cash_reconciliations`,
      )
    ).map((r) => r.on),
  );

  for (let back = 1; back <= 20; back += 1) {
    const candidate = new Date();
    candidate.setUTCDate(candidate.getUTCDate() - back);
    if (!taken.has(candidate.toISOString().slice(0, 10))) return candidate;
  }
  throw new Error('No uncounted day in the last twenty; the harness needs reseeding.');
}

/** The branch drawer's balance, as the books hold it right now. */
async function cashAtHand(): Promise<number> {
  const row = await queryHarnessOne<{ balance: string }>(
    `select coalesce(b.balance, 0)::text as balance
       from public.ledger_accounts a
       left join public.ledger_account_balances b on b.account_id = a.id
      where a.cash_kind = 'cash_at_hand' and a.branch_id is not null
      order by a.code limit 1`,
  );
  return Number(row.balance);
}

// ===========================================================================
test.describe('reconciling a provider float statement', () => {
  test('an Owner records it, a Manager certifies it, and neither does both', async ({
    browser,
  }) => {
    const owner = await asRole(browser, 'owner');
    const manager = await asRole(browser, 'manager');

    try {
      const till = await demonstrationTill();
      const booksSay = await floatBalance(till.ledgerAccountId);
      const date = (await freeStatementDate(till.id)).toISOString().slice(0, 10);
      const statementRef = `AIRSTMT-${reference()}`;

      // A statement 3,000 short of our books. A reconciliation that agreed
      // would prove the screen works and nothing about what it is for.
      await owner.page.goto('/agency/reconciliation/float');
      await expectNoErrorBoundary(owner.page);
      await owner.page
        .getByLabel('Float till', { exact: true })
        .selectOption({ label: till.option });
      await owner.page
        .getByLabel(/provider statement balance/i)
        .fill(String(booksSay - 3_000));
      await owner.page.getByLabel(/statement reference/i).fill(statementRef);
      await owner.page.getByLabel(/statement date/i).fill(date);
      await owner.page.getByLabel(/notes/i).fill('Recorded by the write suite.');
      await owner.page.getByRole('button', { name: /record statement/i }).click();
      await expect(
        owner.page
          .getByText(/statement recorded/i)
          .filter({ visible: true })
          .first(),
      ).toBeVisible();

      const recorded = await queryHarnessOne<{
        id: string;
        status: string;
        variance: string;
        system: string;
        statement: string;
        created_by: string;
        entry: string | null;
      }>(
        `select id::text as id, status, variance::text as variance,
                system_closing_balance::text as system,
                provider_statement_balance::text as statement,
                created_by::text as created_by,
                variance_journal_entry_id::text as entry
           from public.agency_float_reconciliations
          where provider_statement_ref = $1`,
        [statementRef],
      );
      expect(recorded.status).toBe('open');
      expect(Number(recorded.system)).toBe(booksSay);
      expect(Number(recorded.statement)).toBe(booksSay - 3_000);
      // The float convention: the books less the provider's figure. The
      // opposite sign to a cash count, which is why both registers carry the
      // database's own sentence about it rather than one written here.
      expect(Number(recorded.variance)).toBe(3_000);
      expect(recorded.entry).toBeNull();

      // Recording a reading moves no money.
      expect(await floatBalance(till.ledgerAccountId)).toBe(booksSay);

      // Error handling: the same till, the same day, twice.
      await owner.page.reload();
      await owner.page
        .getByLabel('Float till', { exact: true })
        .selectOption({ label: till.option });
      await owner.page
        .getByLabel(/provider statement balance/i)
        .fill(String(booksSay - 4_000));
      await owner.page.getByLabel(/statement date/i).fill(date);
      await owner.page.getByRole('button', { name: /record statement/i }).click();
      await expect(
        owner.page
          .getByText(/has already been reconciled for/i)
          .filter({ visible: true })
          .first(),
      ).toBeVisible();
      expect(await countStatements(statementRef)).toBe(1);

      // Maker-checker, said in words rather than by a missing control.
      const ownRow = owner.page.locator('tr', { hasText: statementRef });
      await expect(
        ownRow.getByText(/you recorded this reading/i).filter({ visible: true }),
      ).toBeVisible();
      await expect(ownRow.getByRole('button', { name: /^certify$/i })).toHaveCount(0);

      // The second officer. A Manager holds no `agency:variance_adjustment`,
      // so the screen offers certification and explains that the difference
      // itself is the Owner's to write off.
      await manager.page.goto('/agency/reconciliation/float');
      const row = manager.page.locator('tr', { hasText: statementRef });
      await expect(
        row.getByText(/Writing a difference off is the Owner/i).filter({
          visible: true,
        }),
      ).toBeVisible();
      await row.getByRole('button', { name: /^certify$/i }).click();
      await expect(row.getByText(/^Certified$/)).toBeVisible();

      const certified = await queryHarnessOne<{
        status: string;
        reconciled_by: string | null;
        entry: string | null;
        written_off: string;
      }>(
        `select status, reconciled_by::text as reconciled_by,
                variance_journal_entry_id::text as entry,
                variance_written_off::text as written_off
           from public.agency_float_reconciliations where id = $1`,
        [recorded.id],
      );
      expect(certified.status).toBe('reconciled');
      expect(certified.reconciled_by).not.toBeNull();
      expect(certified.reconciled_by).not.toBe(recorded.created_by);

      // Certifying without writing off posts nothing and leaves the
      // difference outstanding - which is what puts it on the end-of-day
      // exceptions screen.
      expect(certified.entry).toBeNull();
      expect(Number(certified.written_off)).toBe(0);
      expect(await floatBalance(till.ledgerAccountId)).toBe(booksSay);

      await manager.page.goto('/agency/exceptions');
      await expect(
        manager.page
          .getByText(/Unexplained difference/i)
          .filter({ visible: true })
          .first(),
      ).toBeVisible();
    } finally {
      await owner.context.close();
      await manager.context.close();
    }
  });
});

// ===========================================================================
test.describe('remitting collections to a provider', () => {
  test('records the remittance, then reverses it without deleting it', async ({
    page,
    browser,
  }) => {
    await page.context().addCookies([]); // no-op: keeps the fixture page in scope
    const owner = await asRole(browser, 'owner');

    try {
      const provider = await providerWithPayable();
      const heldBefore = await payableOutstanding(provider.id);
      const cashBefore = await cashAtHand();
      expect(heldBefore).toBeGreaterThan(2_000);

      const amount = 1_000;
      const receiptRef = `NWREC-${reference()}`;

      await owner.page.goto('/agency/payables');
      await expectNoErrorBoundary(owner.page);
      await owner.page
        .getByLabel('Provider and branch', { exact: true })
        .selectOption({ label: provider.option });
      await owner.page.getByLabel(/amount handed over/i).fill(String(amount));
      await owner.page.getByLabel(/receipt reference/i).fill(receiptRef);
      await owner.page.getByRole('button', { name: /record remittance/i }).click();
      await expect(
        owner.page
          .getByText(/remittance recorded/i)
          .filter({ visible: true })
          .first(),
      ).toBeVisible();

      const settlement = await queryHarnessOne<{
        id: string;
        status: string;
        journal: string | null;
        amount: string;
      }>(
        `select id::text as id, status, journal_entry_id::text as journal,
                settlement_amount::text as amount
           from public.agency_payable_settlements
          where provider_receipt_ref = $1`,
        [receiptRef],
      );
      expect(settlement.status).toBe('posted');
      expect(settlement.journal).not.toBeNull();
      expect(Number(settlement.amount)).toBe(amount);

      // The journal: the liability down, the drawer down, and balanced.
      const lines = await entryLines(settlement.journal);
      expect(lines.reduce((t, l) => t + Number(l.debit), 0)).toBe(
        lines.reduce((t, l) => t + Number(l.credit), 0),
      );
      expect(lines.some((l) => Number(l.debit) === amount)).toBe(true);
      expect(lines.some((l) => Number(l.credit) === amount)).toBe(true);

      expect(await payableOutstanding(provider.id)).toBe(heldBefore - amount);
      expect(await cashAtHand()).toBe(cashBefore - amount);

      // Error handling, twice over: the same receipt reference again, and
      // more than is actually held.
      await owner.page.reload();
      await owner.page
        .getByLabel('Provider and branch', { exact: true })
        .selectOption({ label: await payableOptionFor(owner.page, provider.id) });
      await owner.page.getByLabel(/amount handed over/i).fill('1000');
      await owner.page.getByLabel(/receipt reference/i).fill(receiptRef);
      await owner.page.getByRole('button', { name: /record remittance/i }).click();
      await expect(
        owner.page
          .getByText(/already records receipt reference/i)
          .filter({ visible: true })
          .first(),
      ).toBeVisible();

      await owner.page.reload();
      await owner.page
        .getByLabel('Provider and branch', { exact: true })
        .selectOption({ label: await payableOptionFor(owner.page, provider.id) });
      await owner.page
        .getByLabel(/amount handed over/i)
        .fill(String(heldBefore + 1_000_000));
      await owner.page.getByRole('button', { name: /record remittance/i }).click();
      await expect(
        owner.page
          .getByText(/may not go into net debit/i)
          .filter({ visible: true })
          .first(),
      ).toBeVisible();

      // Neither refusal wrote anything.
      expect(await payableOutstanding(provider.id)).toBe(heldBefore - amount);

      // The reversal: a contra entry, not a deletion.
      await owner.page.reload();
      const row = owner.page.locator('tr', { hasText: receiptRef });
      await row.locator('input[name="reason"]').fill('Paid against the wrong receipt.');
      await row.getByRole('button', { name: /^reverse$/i }).click();
      await expect(row.getByText(/^Reversed$/)).toBeVisible();

      const reversed = await queryHarnessOne<{
        status: string;
        journal: string | null;
        contra: string | null;
        reason: string | null;
      }>(
        `select status, journal_entry_id::text as journal,
                reversal_entry_id::text as contra, reversal_reason as reason
           from public.agency_payable_settlements where id = $1`,
        [settlement.id],
      );
      expect(reversed.status).toBe('reversed');
      expect(reversed.journal).not.toBeNull();
      expect(reversed.contra).not.toBeNull();
      expect(reversed.contra).not.toBe(reversed.journal);
      expect(reversed.reason).toBe('Paid against the wrong receipt.');

      const contra = await entryLines(reversed.contra);
      expect(contra.reduce((t, l) => t + Number(l.debit), 0)).toBe(
        contra.reduce((t, l) => t + Number(l.credit), 0),
      );

      expect(await payableOutstanding(provider.id)).toBe(heldBefore);
      expect(await cashAtHand()).toBe(cashBefore);
    } finally {
      await owner.context.close();
    }
  });

  test('a Secretary may read it and settle nothing', async ({ browser }) => {
    const secretary = await asRole(browser, 'secretary');
    try {
      const response = await secretary.page.goto('/agency/payables');
      expect(response?.status()).toBe(200);
      await expectNoErrorBoundary(secretary.page);

      // `agency:settlements` and `agency:reverse` are a manager's upward.
      await expect(
        secretary.page.getByRole('button', { name: /record remittance/i }),
      ).toHaveCount(0);
      await expect(
        secretary.page.getByRole('button', { name: /^reverse$/i }),
      ).toHaveCount(0);
      await expect(
        secretary.page
          .getByText(/needs the settlement capability/i)
          .filter({ visible: true })
          .first(),
      ).toBeVisible();
    } finally {
      await secretary.context.close();
    }
  });
});

// ===========================================================================
test.describe('topping up a float till', () => {
  test('moves the money, writes one balanced journal, and refuses a repeat', async ({
    browser,
  }) => {
    const owner = await asRole(browser, 'owner');

    try {
      const till = await demonstrationTill();
      const floatBefore = await floatBalance(till.ledgerAccountId);
      const cashBefore = await cashAtHand();
      const topUpRef = `AIRTOP-${reference()}`;
      const amount = 50_000;

      await owner.page.goto('/agency/float/replenish');
      await expectNoErrorBoundary(owner.page);
      await owner.page
        .getByLabel('Till', { exact: true })
        .selectOption({ label: till.topUpOption });
      await owner.page.getByLabel(/amount \(ugx\)/i).fill(String(amount));
      await owner.page.getByLabel(/provider reference/i).fill(topUpRef);
      await owner.page.getByRole('button', { name: /record top-up/i }).click();
      await expect(
        owner.page
          .getByText(/float replenished/i)
          .filter({ visible: true })
          .first(),
      ).toBeVisible();

      const topUp = await queryHarnessOne<{
        id: string;
        amount: string;
        journal: string | null;
      }>(
        `select id::text as id, amount::text as amount,
                journal_entry_id::text as journal
           from public.agency_float_replenishments
          where provider_reference = $1`,
        [topUpRef],
      );
      expect(Number(topUp.amount)).toBe(amount);
      expect(topUp.journal).not.toBeNull();

      // The company's own money moved from the drawer into the till. One
      // journal, balanced, touching exactly those two accounts.
      const lines = await entryLines(topUp.journal);
      expect(lines).toHaveLength(2);
      expect(lines.reduce((t, l) => t + Number(l.debit), 0)).toBe(amount);
      expect(lines.reduce((t, l) => t + Number(l.credit), 0)).toBe(amount);

      expect(await floatBalance(till.ledgerAccountId)).toBe(floatBefore + amount);
      expect(await cashAtHand()).toBe(cashBefore - amount);

      // Error handling: the same provider reference against the same till.
      await owner.page.reload();
      await owner.page
        .getByLabel('Till', { exact: true })
        .selectOption({ label: await topUpOptionFor(owner.page, till.id) });
      await owner.page.getByLabel(/amount \(ugx\)/i).fill('1000');
      await owner.page.getByLabel(/provider reference/i).fill(topUpRef);
      await owner.page.getByRole('button', { name: /record top-up/i }).click();
      await expect(
        owner.page
          .getByText(/already records reference/i)
          .filter({ visible: true })
          .first(),
      ).toBeVisible();

      // Refused, and nothing moved.
      expect(await floatBalance(till.ledgerAccountId)).toBe(floatBefore + amount);
      expect(await cashAtHand()).toBe(cashBefore - amount);
    } finally {
      await owner.context.close();
    }
  });

  test('is not a Secretary\u2019s to do', async ({ browser }) => {
    const secretary = await asRole(browser, 'secretary');
    try {
      await secretary.page.goto('/agency/float/replenish');
      expect(
        secretary.page.url(),
        'the top-up screen must not open to a Secretary',
      ).not.toContain('/agency/float/replenish');
    } finally {
      await secretary.context.close();
    }
  });
});

/**
 * The Airtel demonstration till: the one this suite is allowed to spend.
 *
 * Returned with the exact option labels the two forms render, because each
 * writes the till's balance into its own label and the balance moves as this
 * suite runs.
 */
async function demonstrationTill(): Promise<{
  readonly id: string;
  readonly ledgerAccountId: string;
  readonly option: string;
  readonly topUpOption: string;
}> {
  const row = await queryHarnessOne<{
    id: string;
    ledger: string;
    provider: string;
    till: string;
    branch: string;
    balance: string;
  }>(
    `select f.id::text as id, f.ledger_account_id::text as ledger,
            p.name as provider, f.till_name as till, b.branch_code as branch,
            coalesce(bal.balance, 0)::text as balance
       from public.agency_provider_float_accounts f
       join public.agency_service_providers p on p.id = f.provider_id
       join public.branches b on b.id = f.branch_id
       left join public.ledger_account_balances bal
              on bal.account_id = f.ledger_account_id
      where p.code = 'DEMO_AIRTEL'
        and f.till_name = 'main'`,
  );

  // Phase 4E. `and f.till_name = 'main'` is not a tidy-up: the seed opens one
  // till per provider, so "the Airtel till" used to be unambiguous, and
  // `agency-money.write.spec.ts` now opens agent lines of its own against the
  // same provider — which is what a branch with two SIMs looks like, and what
  // decision OD-3 exists for. This asks for the seeded till by name rather
  // than assuming a provider has exactly one.

  const held = Number(row.balance).toLocaleString('en-UG');
  return {
    id: row.id,
    ledgerAccountId: row.ledger,
    option: `${row.provider} — ${row.till} (${row.branch}), our books say ${held}`,
    topUpOption: `${row.provider} — ${row.till} (${row.branch}, holds ${held})`,
  };
}

/** The top-up form's current label for a till, read from the page itself. */
async function topUpOptionFor(page: Page, tillId: string): Promise<string> {
  const labels = await page
    .getByLabel('Till', { exact: true })
    .locator('option')
    .allTextContents();
  const values = await page
    .getByLabel('Till', { exact: true })
    .locator('option')
    .evaluateAll((options) =>
      options.map((option) => (option as HTMLOptionElement).value),
    );
  const at = values.indexOf(tillId);
  if (at < 0) throw new Error(`No till ${tillId} in: ${values.join(' | ')}`);
  return labels[at]!;
}

/** The payables form's current label for a provider, read from the page. */
async function payableOptionFor(page: Page, providerId: string): Promise<string> {
  const select = page.getByLabel('Provider and branch', { exact: true });
  const labels = await select.locator('option').allTextContents();
  const values = await select
    .locator('option')
    .evaluateAll((options) =>
      options.map((option) => (option as HTMLOptionElement).value),
    );
  const at = values.findIndex((value) => value.startsWith(providerId));
  if (at < 0) throw new Error(`No provider ${providerId} in: ${values.join(' | ')}`);
  return labels[at]!;
}

/** A provider the counter is holding money for, and its form label. */
async function providerWithPayable(): Promise<{
  readonly id: string;
  readonly option: string;
}> {
  const row = await queryHarnessOne<{
    id: string;
    name: string;
    branch: string;
    outstanding: string;
  }>(
    `select provider_id::text as id, provider_name as name,
            branch_code as branch, payable_outstanding::text as outstanding
       from public.agency_payable_summary
      where payable_outstanding > 0
      order by payable_outstanding desc limit 1`,
  );
  const held = Number(row.outstanding).toLocaleString('en-UG');
  return { id: row.id, option: `${row.name} — ${row.branch} (held ${held})` };
}

/** What is still owed to one provider, as the database totals it. */
async function payableOutstanding(providerId: string): Promise<number> {
  const rows = await queryHarness<{ outstanding: string }>(
    `select payable_outstanding::text as outstanding
       from public.agency_payable_summary where provider_id = $1`,
    [providerId],
  );
  return rows.reduce((total, r) => total + Number(r.outstanding), 0);
}

/** One ledger account's balance, right now. */
async function floatBalance(accountId: string): Promise<number> {
  const row = await queryHarnessOne<{ balance: string }>(
    `select coalesce(b.balance, 0)::text as balance
       from public.ledger_accounts a
       left join public.ledger_account_balances b on b.account_id = a.id
      where a.id = $1`,
    [accountId],
  );
  return Number(row.balance);
}

/** The lines of one journal entry, whichever document wrote it. */
async function entryLines(entryId: string | null) {
  if (entryId === null) throw new Error('No journal entry to read.');
  return queryHarness<{ code: string; debit: string; credit: string }>(
    `select a.code, l.debit::text as debit, l.credit::text as credit
       from public.journal_lines l
       join public.ledger_accounts a on a.id = l.account_id
      where l.entry_id = $1 order by a.code`,
    [entryId],
  );
}

async function countStatements(statementRef: string): Promise<number> {
  const rows = await queryHarness(
    `select 1 from public.agency_float_reconciliations
      where provider_statement_ref = $1`,
    [statementRef],
  );
  return rows.length;
}

/** The most recent day this till has no statement for. */
async function freeStatementDate(tillId: string): Promise<Date> {
  const taken = new Set(
    (
      await queryHarness<{ on: string }>(
        `select to_char(reconciliation_date, 'YYYY-MM-DD') as on
           from public.agency_float_reconciliations where float_account_id = $1`,
        [tillId],
      )
    ).map((r) => r.on),
  );

  for (let back = 0; back <= 20; back += 1) {
    const candidate = new Date();
    candidate.setUTCDate(candidate.getUTCDate() - back);
    if (!taken.has(candidate.toISOString().slice(0, 10))) return candidate;
  }
  throw new Error('No unreconciled day in the last twenty; the harness needs reseeding.');
}

// ===========================================================================
test.describe('a read that fails says so, and never shows a zero', () => {
  test.use({ storageState: stateFile('owner') });

  test('the commission screen reports an unreadable position', async ({ page }) => {
    // A real failure, not a stub: the grant is revoked for the duration of
    // one page load and restored immediately. Nothing else in this suite
    // reads that view while it is gone, because Playwright runs this project
    // with a single worker.
    await revoke('agency_commission_summary');
    try {
      await page.goto('/agency/commission');
      await expectNoErrorBoundary(page);

      await expect(
        page
          .getByText(/could not be read|may not read/i)
          .filter({ visible: true })
          .first(),
      ).toBeVisible();

      // And no figure at all. Before Phase 4D-F this screen rendered
      // "UGX 0 earned, UGX 0 received, UGX 0 outstanding" from a query that
      // never ran.
      await expect(page.getByText(/UGX 0\b/).filter({ visible: true })).toHaveCount(0);
    } finally {
      await restore('agency_commission_summary');
    }
  });

  test('the exceptions screen does not say the day is clear', async ({ page }) => {
    await revoke('agency_end_of_day_exceptions');
    try {
      await page.goto('/agency/exceptions');
      await expectNoErrorBoundary(page);

      await expect(
        page
          .getByText(/could not be read|may not read/i)
          .filter({ visible: true })
          .first(),
      ).toBeVisible();
      // The sentence that must never appear on a failed read.
      await expect(page.getByText(/Nothing outstanding/i)).toHaveCount(0);
    } finally {
      await restore('agency_end_of_day_exceptions');
    }
  });

  test('the float screen reports an unreadable balance', async ({ page }) => {
    await revoke('agency_float_balances');
    try {
      await page.goto('/agency/float');
      await expectNoErrorBoundary(page);

      await expect(
        page
          .getByText(/could not be read|may not read/i)
          .filter({ visible: true })
          .first(),
      ).toBeVisible();
      await expect(page.getByText(/No float till is registered/i)).toHaveCount(0);
    } finally {
      await restore('agency_float_balances');
    }
  });
});

/**
 * Take a view away from the signed-in role, briefly.
 *
 * This is the honest way to simulate a read failure: no test hook in
 * application code, no stubbed client, just the database refusing the same
 * request the page makes in production. `restore` runs in a `finally` so a
 * failing assertion cannot leave the grant off.
 */
function assertAgencyView(view: string): void {
  // An identifier cannot be a bound parameter, so it is checked instead.
  // Every caller passes a literal; this is what keeps that true.
  if (!/^agency_[a-z_]+$/.test(view)) throw new Error(`Not an agency view: ${view}`);
}

async function revoke(view: string): Promise<void> {
  assertAgencyView(view);
  await queryHarness(`revoke select on table public.${view} from authenticated`);
}

async function restore(view: string): Promise<void> {
  assertAgencyView(view);
  await queryHarness(`grant select on table public.${view} to authenticated`);
}
