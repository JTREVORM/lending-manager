import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { closePool, hasDatabase, query, queryOne, skipReason } from '../helpers/db';
import { deleteTestUsers } from '../helpers/auth-fixtures';
import { deleteTestLoans } from '../helpers/loan-fixtures';

/**
 * A count is compared against the books as they stood on the day of the count.
 *
 * `submit_reconciliation` has always taken a business date, because counting a
 * till on Friday and entering it on Monday is ordinary bookkeeping. Until
 * Phase 13 it then read the balance with `ledger_account_balance`, which sums
 * every line ever written to the account with no date bound — so the stored
 * variance was the real difference on the day *plus* every movement since, and
 * `approve_reconciliation` would write that whole figure off to Cash Over and
 * Short as a loss the business never had.
 *
 * The weekend is what makes it visible: two days of collections between the
 * count and the keystroke, and the arithmetic is out by two days of
 * collections. These tests put a movement in that gap on purpose.
 */
const describeDb = hasDatabase ? describe : describe.skip;

if (!hasDatabase) {
  describe('reconciliation as-of suite', () => {
    it.skip(`skipped — ${skipReason}`, () => undefined);
  });
}

afterAll(async () => {
  await closePool();
});

beforeEach(async () => {
  // `deleteTestLoans` clears the ledger and the four money-movement documents
  // with it, which is what these tests need: every balance below is asserted
  // absolutely, so a journal left over from the previous test would shift it.
  await deleteTestLoans();
  await deleteTestUsers();
  await query(
    `update public.finance_settings
        set reconciliation_requires_review = true, allow_negative_cash = false
      where id = 1`,
  );
});

async function accountId(cashKind: string): Promise<string> {
  const row = await queryOne<{ id: string }>(
    `select id from public.ledger_accounts where cash_kind = $1 limit 1`,
    [cashKind],
  );
  return row.id;
}

/** Put money into a cash account on a chosen business date. */
async function fundOn(cashKind: string, amount: number, daysAgo: number): Promise<void> {
  const branch = await queryOne<{ id: string }>(
    `select id from public.branches order by branch_code limit 1`,
  );
  const equity = await queryOne<{ id: string }>(
    `select id from public.ledger_accounts where code = '3000'`,
  );

  await query(
    `select public.post_journal(
       $1, current_date - $6::int, $2, 'opening_balance', null, null, null,
       jsonb_build_array(
         jsonb_build_object('account_id', $3::uuid, 'debit', $4::bigint, 'credit', 0),
         jsonb_build_object('account_id', $5::uuid, 'debit', 0, 'credit', $4::bigint)
       ))`,
    [branch.id, `Funding ${cashKind}`, await accountId(cashKind), amount, equity.id, daysAgo],
  );
}

async function balance(accountIdValue: string): Promise<number> {
  const row = await queryOne<{ b: string }>(
    `select public.ledger_account_balance($1)::text as b`,
    [accountIdValue],
  );
  return Number(row.b);
}

// ---------------------------------------------------------------------------
describeDb('the as-of reading itself', () => {
  it('includes the cut-off day and excludes everything after it', async () => {
    await fundOn('bank', 600_000, 10);
    await fundOn('bank', 250_000, 3);
    const bank = await accountId('bank');

    const row = await queryOne<{ before: string; on: string; after: string; now: string }>(
      `select public.ledger_account_balance_as_of($1, current_date - 4)::text  as before,
              public.ledger_account_balance_as_of($1, current_date - 3)::text  as on,
              public.ledger_account_balance_as_of($1, current_date)::text      as after,
              public.ledger_account_balance($1)::text                          as now`,
      [bank],
    );

    expect(Number(row.before)).toBe(600_000);
    // The day's own entries are in it. A cut-off that excluded them would put
    // every count one day behind its own evidence.
    expect(Number(row.on)).toBe(850_000);
    expect(Number(row.after)).toBe(850_000);
    // And with no cut-off it is the same reading, which is what every
    // can-this-money-leave-now check still uses.
    expect(Number(row.now)).toBe(850_000);
  });

  it('reads a credit-side account the right way round', async () => {
    await fundOn('bank', 400_000, 5);
    const equity = await queryOne<{ id: string }>(
      `select id from public.ledger_accounts where code = '3000'`,
    );

    const row = await queryOne<{ b: string }>(
      `select public.ledger_account_balance_as_of($1, current_date)::text as b`,
      [equity.id],
    );

    // Equity is a credit-normal account, so funding leaves it positive, not
    // negative. The sign convention is the one `ledger_account_balance` uses.
    expect(Number(row.b)).toBe(400_000);
  });

  it('refuses an account that does not exist', async () => {
    await expect(
      query(`select public.ledger_account_balance_as_of(gen_random_uuid(), current_date)`),
    ).rejects.toThrow(/No such ledger account/);
  });
});

// ---------------------------------------------------------------------------
describeDb('a count entered after the fact', () => {
  it('is compared against the balance on the day it was made', async () => {
    await fundOn('cash_at_hand', 1_000_000, 10);
    // Two days of collections arrive between the count and the keystroke.
    await fundOn('cash_at_hand', 400_000, 2);
    const cash = await accountId('cash_at_hand');

    // Counted 995,000 on the day the books said 1,000,000: a 5,000 shortage.
    await query(
      `select public.submit_reconciliation($1, current_date - 10, 995000, 'Counted Friday, entered Monday')`,
      [cash],
    );

    const row = await queryOne<{ system: string; variance: string; status: string }>(
      `select system_balance::text as system, variance::text as variance, status
         from public.account_reconciliations`,
    );

    expect(Number(row.system)).toBe(1_000_000);
    // Before the fix this was -405,000: the real 5,000 shortage plus the
    // 400,000 that arrived afterwards.
    expect(Number(row.variance)).toBe(-5_000);
    expect(row.status).toBe('submitted');
  });

  it('writes off only the shortage that was actually there', async () => {
    await fundOn('cash_at_hand', 1_000_000, 10);
    await fundOn('cash_at_hand', 400_000, 2);
    const cash = await accountId('cash_at_hand');

    const submitted = await queryOne<{ id: string }>(
      `select public.submit_reconciliation($1, current_date - 10, 995000, 'Drawer short') as id`,
      [cash],
    );
    await query(`select public.approve_reconciliation($1, 'Signed off')`, [submitted.id]);

    // 1,400,000 on the books, 5,000 written off.
    expect(await balance(cash)).toBe(1_395_000);

    const shortage = await queryOne<{ b: string }>(
      `select public.ledger_account_balance(id)::text as b
         from public.ledger_accounts where code = '5950'`,
    );
    expect(Number(shortage.b)).toBe(5_000);
  });

  it('dates the adjustment to the count, not to the day it was approved', async () => {
    await fundOn('cash_at_hand', 1_000_000, 10);
    const cash = await accountId('cash_at_hand');

    const submitted = await queryOne<{ id: string }>(
      `select public.submit_reconciliation($1, current_date - 10, 990000, 'Short') as id`,
      [cash],
    );
    await query(`select public.approve_reconciliation($1, 'Signed off')`, [submitted.id]);

    const entry = await queryOne<{ same: boolean }>(
      `select e.entry_date = current_date - 10 as same
         from public.journal_entries e
         join public.account_reconciliations r on r.adjustment_entry_id = e.id`,
    );

    // The shortage happened on the day of the count. Dating it to the day
    // somebody signed it would move the loss into the wrong period.
    expect(entry.same).toBe(true);
  });

  it('calls a past count balanced when it agreed on its own day', async () => {
    await fundOn('bank', 700_000, 8);
    await fundOn('bank', 120_000, 1);
    const bank = await accountId('bank');

    await query(
      `select public.submit_reconciliation($1, current_date - 8, 700000, 'Statement agrees')`,
      [bank],
    );

    const row = await queryOne<{ status: string; adj: boolean }>(
      `select status, adjustment_entry_id is not null as adj
         from public.account_reconciliations`,
    );

    // A count that agreed on its day needs nobody's approval, and the 120,000
    // that arrived since is not a discrepancy.
    expect(row.status).toBe('balanced');
    expect(row.adj).toBe(false);
  });

  it('leaves a same-day count behaving exactly as it did', async () => {
    await fundOn('cash_at_hand', 1_000_000, 0);
    const cash = await accountId('cash_at_hand');

    await query(
      `select public.submit_reconciliation($1, current_date, 985000, 'Drawer short')`,
      [cash],
    );

    const row = await queryOne<{ system: string; variance: string; status: string }>(
      `select system_balance::text as system, variance::text as variance, status
         from public.account_reconciliations`,
    );

    // As of today is today, so every count the application submits is read
    // the way it always was.
    expect(Number(row.system)).toBe(1_000_000);
    expect(Number(row.variance)).toBe(-15_000);
    expect(row.status).toBe('submitted');
  });

  it('still refuses a count dated in the future', async () => {
    const bank = await accountId('bank');

    await expect(
      query(`select public.submit_reconciliation($1, current_date + 1, 0, null)`, [bank]),
    ).rejects.toThrow(/future/);
  });
});
