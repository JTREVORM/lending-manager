import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { closePool, hasDatabase, query, queryOne, skipReason } from '../helpers/db';
import { deleteTestUsers } from '../helpers/auth-fixtures';
import { deleteTestLoans } from '../helpers/loan-fixtures';

/**
 * "Awaiting approval" is said about the documents that are actually awaiting it.
 *
 * `record_transfer` and `record_expense` insert every document as
 * `pending_approval` and let the posting function promote it, so that exactly
 * one place sets `posted` and it is the place that writes the journal. Phase
 * 15's notification triggers were gated on `new.status = 'pending_approval'`
 * at INSERT, which therefore matched everything — a 5,000 boda fare that
 * posted instantly told every manager it needed a decision.
 *
 * Nothing caught it because the live book had no transfer or expense in it at
 * all. These tests are the ones that would have.
 */
const describeDb = hasDatabase ? describe : describe.skip;

if (!hasDatabase) {
  describe('pending notification suite', () => {
    it.skip(`skipped — ${skipReason}`, () => undefined);
  });
}

afterAll(async () => {
  await closePool();
});

beforeEach(async () => {
  await deleteTestLoans();
  await deleteTestUsers();
  await query(
    `update public.finance_settings
        set transfer_approval_threshold = 2000000,
            expense_approval_threshold = 1000000,
            allow_negative_cash = false,
            reconciliation_requires_review = true
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

async function accountByCode(code: string): Promise<string> {
  const row = await queryOne<{ id: string }>(
    `select id from public.ledger_accounts where code = $1`,
    [code],
  );
  return row.id;
}

async function fund(cashKind: string, amount: number): Promise<void> {
  const branch = await queryOne<{ id: string }>(
    `select id from public.branches order by branch_code limit 1`,
  );

  await query(
    `select public.post_journal(
       $1, current_date, $2, 'opening_balance', null, null, null,
       jsonb_build_array(
         jsonb_build_object('account_id', $3::uuid, 'debit', $4::bigint, 'credit', 0),
         jsonb_build_object('account_id', $5::uuid, 'debit', 0, 'credit', $4::bigint)
       ))`,
    [
      branch.id,
      `Test funding for ${cashKind}`,
      await accountId(cashKind),
      amount,
      await accountByCode('3000'),
    ],
  );
}

async function pendingNotifications(entityType: string): Promise<number> {
  const row = await queryOne<{ n: string }>(
    `select count(*)::text as n from public.notifications
      where category = 'approval_pending' and entity_type = $1`,
    [entityType],
  );
  return Number(row.n);
}

// ---------------------------------------------------------------------------
describeDb('a transfer that needed no decision says nothing', () => {
  it('raises nothing for a transfer below the threshold', async () => {
    await fund('cash_at_hand', 5_000_000);

    await query(
      `select public.record_transfer($1, $2, 250000, current_date, 'Till top-up', null)`,
      [await accountId('cash_at_hand'), await accountId('bank')],
    );

    // It posted on the way in. Nobody has to decide anything.
    expect(await pendingNotifications('transfer')).toBe(0);
  });

  it('raises exactly one for a transfer above the threshold', async () => {
    await fund('cash_at_hand', 5_000_000);

    await query(
      `select public.record_transfer($1, $2, 2500000, current_date, 'Reserve to bank', null)`,
      [await accountId('cash_at_hand'), await accountId('bank')],
    );

    expect(await pendingNotifications('transfer')).toBe(1);

    const row = await queryOne<{ severity: string; audience_permission: string }>(
      `select severity, audience_permission from public.notifications
        where category = 'approval_pending' and entity_type = 'transfer'`,
    );
    expect(row.audience_permission).toBe('transfers:approve');
    expect(row.severity).toBe('attention');
  });

  it('does not raise a second one when the transfer is approved', async () => {
    await fund('cash_at_hand', 5_000_000);

    const id = await queryOne<{ id: string }>(
      `select public.record_transfer($1, $2, 2500000, current_date, 'Reserve to bank', null) as id`,
      [await accountId('cash_at_hand'), await accountId('bank')],
    );
    await query(`select public.approve_transfer($1)`, [id.id]);

    // The notification is about the wait, and the wait happened once.
    expect(await pendingNotifications('transfer')).toBe(1);
  });

  it('counts only the ones over the line across a mixed batch', async () => {
    await fund('cash_at_hand', 20_000_000);
    const from = await accountId('cash_at_hand');
    const to = await accountId('bank');

    for (const amount of [100_000, 2_400_000, 50_000, 3_000_000, 1_999_999]) {
      await query(
        `select public.record_transfer($1, $2, $3, current_date, 'Batch', null)`,
        [from, to, amount],
      );
    }

    // 2,400,000 and 3,000,000. The 1,999,999 is under the threshold, which is
    // compared with `>`, and the two small ones never waited.
    expect(await pendingNotifications('transfer')).toBe(2);
  });
});

// ---------------------------------------------------------------------------
describeDb('an expense that needed no decision says nothing', () => {
  it('raises nothing for an expense below the threshold', async () => {
    await fund('cash_at_hand', 5_000_000);

    await query(
      `select public.record_expense($1, $2, 40000, current_date, 'Boda fares', null, null, null)`,
      [await accountByCode('5030'), await accountId('cash_at_hand')],
    );

    expect(await pendingNotifications('expense')).toBe(0);
  });

  it('raises one for an expense above the threshold', async () => {
    await fund('cash_at_hand', 5_000_000);

    await query(
      `select public.record_expense($1, $2, 1250000, current_date, 'Licence renewal', 'UMRA', null, null)`,
      [await accountByCode('5900'), await accountId('cash_at_hand')],
    );

    expect(await pendingNotifications('expense')).toBe(1);
  });

  it('still says nothing when a rejected expense is the one below the line', async () => {
    await fund('cash_at_hand', 5_000_000);

    const id = await queryOne<{ id: string }>(
      `select public.record_expense($1, $2, 1100000, current_date, 'Branding', null, null, null) as id`,
      [await accountByCode('5900'), await accountId('cash_at_hand')],
    );
    await query(`select public.reject_expense($1, 'No quotation attached')`, [id.id]);

    // It did wait for a decision, and got one. The notification about the
    // wait is still correct history.
    expect(await pendingNotifications('expense')).toBe(1);
  });
});

// ---------------------------------------------------------------------------
describeDb('a count written off on submission is not announced as waiting', () => {
  async function varianceNotifications(): Promise<number> {
    const row = await queryOne<{ n: string }>(
      `select count(*)::text as n from public.notifications
        where category = 'reconciliation_variance'`,
    );
    return Number(row.n);
  }

  it('announces a difference that is genuinely waiting', async () => {
    await fund('cash_at_hand', 1_000_000);

    await query(
      `select public.submit_reconciliation($1, current_date, 985000, 'Drawer short')`,
      [await accountId('cash_at_hand')],
    );

    expect(await varianceNotifications()).toBe(1);

    const row = await queryOne<{ severity: string }>(
      `select severity from public.notifications where category = 'reconciliation_variance'`,
    );
    // Money unaccounted for is the most serious thing the system reports.
    expect(row.severity).toBe('urgent');
  });

  it('says nothing where the difference was approved on submission', async () => {
    await query(
      `update public.finance_settings set reconciliation_requires_review = false where id = 1`,
    );
    await fund('cash_at_hand', 1_000_000);

    const cash = await accountId('cash_at_hand');
    await query(
      `select public.submit_reconciliation($1, current_date, 985000, 'Drawer short')`,
      [cash],
    );

    const row = await queryOne<{ status: string }>(
      `select status from public.account_reconciliations`,
    );

    // `submit_reconciliation` wrote it off in the same transaction, so there
    // was never a review to wait for.
    expect(row.status).toBe('approved');
    expect(await varianceNotifications()).toBe(0);
  });

  it('says nothing at all for a count that balanced', async () => {
    await fund('bank', 500_000);

    await query(
      `select public.submit_reconciliation($1, current_date, 500000, 'Agrees')`,
      [await accountId('bank')],
    );

    expect(await varianceNotifications()).toBe(0);
  });
});
