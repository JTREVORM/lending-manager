import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { closePool, hasDatabase, query, queryOne, skipReason } from '../helpers/db';
import { deleteTestUsers } from '../helpers/auth-fixtures';
import { deleteTestLoans } from '../helpers/loan-fixtures';

/**
 * Transfers, expenses, income and the daily count.
 *
 * Phase 11 added four ways money moves that are not a loan. What makes them
 * worth anything is not that each writes a journal — it is that a document
 * which *cannot* write one does not exist either, that nothing above the
 * approval threshold moves without a second person, and that a count which
 * disagrees with the ledger is never resolved by changing the ledger.
 *
 * Several tests below therefore break the posting on purpose — by draining
 * the source account, by deactivating the destination — and then assert that
 * the document did not appear.
 */
const describeDb = hasDatabase ? describe : describe.skip;

if (!hasDatabase) {
  describe('money movement suite', () => {
    it.skip(`skipped — ${skipReason}`, () => undefined);
  });
}

afterAll(async () => {
  await closePool();
});

beforeEach(async () => {
  await deleteTestLoans();
  await deleteTestUsers();
  // Thresholds and the overdraft rule are read from this row by the posting
  // functions, so a test that changed them must not leak into the next.
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

async function balance(accountIdValue: string): Promise<number> {
  const row = await queryOne<{ balance: string }>(
    `select public.ledger_account_balance($1)::text as balance`,
    [accountIdValue],
  );
  return Number(row.balance);
}

/** Put money into a cash account without going through a lending function. */
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

async function trialBalance(): Promise<{ debits: number; credits: number }> {
  const row = await queryOne<{ d: string; c: string }>(
    `select coalesce(sum(total_debit), 0)::text as d,
            coalesce(sum(total_credit), 0)::text as c
       from public.trial_balance`,
  );
  return { debits: Number(row.d), credits: Number(row.c) };
}

// ---------------------------------------------------------------------------
describeDb('a transfer moves money without creating or destroying any', () => {
  it('debits the destination, credits the source, and leaves liquidity unchanged', async () => {
    await fund('cash_at_hand', 5_000_000);

    const before = await queryOne<{ total: string }>(
      `select total_liquidity::text as total from public.branch_cash_position`,
    );

    const cash = await accountId('cash_at_hand');
    const bank = await accountId('bank');

    await query(
      `select public.record_transfer($1, $2, 500000, current_date, 'Banking the takings', 'DEP-1')`,
      [cash, bank],
    );

    expect(await balance(cash)).toBe(4_500_000);
    expect(await balance(bank)).toBe(500_000);

    const after = await queryOne<{ total: string }>(
      `select total_liquidity::text as total from public.branch_cash_position`,
    );

    // The whole point: a transfer is neither income nor an expense.
    expect(after.total).toBe(before.total);

    const { debits, credits } = await trialBalance();
    expect(debits).toBe(credits);
  });

  it('refuses to send money an account does not hold', async () => {
    const airtel = await accountId('airtel_money');
    const bank = await accountId('bank');

    await expect(
      query(`select public.record_transfer($1, $2, 100, current_date, 'Should fail')`, [
        airtel,
        bank,
      ]),
    ).rejects.toThrow(/less than/i);

    // And nothing was written: a refused transfer is not a pending one.
    const rows = await query(`select 1 from public.account_transfers`);
    expect(rows).toHaveLength(0);
  });

  it('permits an overdraft only when the business has said so', async () => {
    await query(
      `update public.finance_settings set allow_negative_cash = true where id = 1`,
    );

    const airtel = await accountId('airtel_money');
    const bank = await accountId('bank');

    await query(
      `select public.record_transfer($1, $2, 100000, current_date, 'Deliberate overdraft')`,
      [airtel, bank],
    );

    expect(await balance(airtel)).toBe(-100_000);
    const { debits, credits } = await trialBalance();
    expect(debits).toBe(credits);
  });

  it('refuses a leg that is not a cash account, and one that is the same account twice', async () => {
    await fund('cash_at_hand', 1_000_000);
    const cash = await accountId('cash_at_hand');
    const interest = await accountByCode('4100');

    await expect(
      query(`select public.record_transfer($1, $2, 1000, current_date, 'No')`, [
        cash,
        interest,
      ]),
    ).rejects.toThrow(/not a cash account/i);

    await expect(
      query(`select public.record_transfer($1, $1, 1000, current_date, 'No')`, [cash]),
    ).rejects.toThrow(/two different accounts/i);
  });
});

// ---------------------------------------------------------------------------
describeDb('approval is a control, not paperwork', () => {
  it('writes no journal at all while a transfer waits', async () => {
    await fund('cash_at_hand', 10_000_000);
    const cash = await accountId('cash_at_hand');
    const mtn = await accountId('mtn_mobile_money');

    const before = await balance(cash);

    await query(
      `select public.record_transfer($1, $2, 2500000, current_date, 'Large float top-up')`,
      [cash, mtn],
    );

    const row = await queryOne<{ status: string; has_journal: boolean }>(
      `select status, journal_entry_id is not null as has_journal
         from public.account_transfers`,
    );

    expect(row.status).toBe('pending_approval');
    expect(row.has_journal).toBe(false);
    // Nothing has moved, so nothing is posted. A journal written now and
    // reversed on rejection would put two entries in the books for an event
    // that never happened.
    expect(await balance(cash)).toBe(before);
  });

  it('posts on approval and moves the money then', async () => {
    await fund('cash_at_hand', 10_000_000);
    const cash = await accountId('cash_at_hand');
    const mtn = await accountId('mtn_mobile_money');

    const id = await queryOne<{ id: string }>(
      `select public.record_transfer($1, $2, 2500000, current_date, 'Float top-up') as id`,
      [cash, mtn],
    );

    await query(`select public.approve_transfer($1)`, [id.id]);

    expect(await balance(mtn)).toBe(2_500_000);
    expect(await balance(cash)).toBe(7_500_000);

    const row = await queryOne<{ status: string; approved: boolean }>(
      `select status, approved_at is not null as approved from public.account_transfers`,
    );
    expect(row.status).toBe('posted');
    expect(row.approved).toBe(true);
  });

  it('posts nothing when a waiting transfer is rejected', async () => {
    await fund('cash_at_hand', 10_000_000);
    const cash = await accountId('cash_at_hand');
    const mtn = await accountId('mtn_mobile_money');

    const id = await queryOne<{ id: string }>(
      `select public.record_transfer($1, $2, 2500000, current_date, 'Float top-up') as id`,
      [cash, mtn],
    );

    await query(`select public.reject_transfer($1, 'Not needed today')`, [id.id]);

    const row = await queryOne<{ status: string; reason: string; has_journal: boolean }>(
      `select status, decision_reason as reason, journal_entry_id is not null as has_journal
         from public.account_transfers`,
    );

    expect(row.status).toBe('rejected');
    expect(row.reason).toBe('Not needed today');
    expect(row.has_journal).toBe(false);
    expect(await balance(mtn)).toBe(0);
  });

  it('refuses a rejection with no reason', async () => {
    await fund('cash_at_hand', 10_000_000);
    const cash = await accountId('cash_at_hand');
    const mtn = await accountId('mtn_mobile_money');

    const id = await queryOne<{ id: string }>(
      `select public.record_transfer($1, $2, 2500000, current_date, 'Float top-up') as id`,
      [cash, mtn],
    );

    await expect(
      query(`select public.reject_transfer($1, '   ')`, [id.id]),
    ).rejects.toThrow(/reason/i);
  });

  it('posts immediately when the business sets no threshold', async () => {
    await query(
      `update public.finance_settings set transfer_approval_threshold = null where id = 1`,
    );
    await fund('cash_at_hand', 10_000_000);

    await query(
      `select public.record_transfer($1, $2, 9000000, current_date, 'No threshold set')`,
      [await accountId('cash_at_hand'), await accountId('bank')],
    );

    const row = await queryOne<{ status: string }>(
      `select status from public.account_transfers`,
    );
    expect(row.status).toBe('posted');
  });
});

// ---------------------------------------------------------------------------
describeDb('a reversal cancels, it does not erase', () => {
  it('mirrors the original leg for leg and stamps it reversed', async () => {
    await fund('cash_at_hand', 5_000_000);
    const cash = await accountId('cash_at_hand');
    const bank = await accountId('bank');

    const id = await queryOne<{ id: string }>(
      `select public.record_transfer($1, $2, 400000, current_date, 'Mistaken banking') as id`,
      [cash, bank],
    );

    await query(`select public.reverse_transfer($1, 'Banked the wrong drawer')`, [id.id]);

    expect(await balance(cash)).toBe(5_000_000);
    expect(await balance(bank)).toBe(0);

    const row = await queryOne<{ status: string; stamped: boolean }>(
      `select t.status,
              (select e.reversed_by_entry_id is not null
                 from public.journal_entries e where e.id = t.journal_entry_id) as stamped
         from public.account_transfers t`,
    );

    expect(row.status).toBe('reversed');
    expect(row.stamped).toBe(true);

    // Both entries survive. The ledger records that money moved and then
    // came back, which is what happened.
    const entries = await query<{ source_type: string }>(
      `select source_type from public.journal_entries
        where source_type in ('transfer', 'transfer_reversal') order by source_type`,
    );
    expect(entries.map((e) => e.source_type)).toEqual(['transfer', 'transfer_reversal']);

    const { debits, credits } = await trialBalance();
    expect(debits).toBe(credits);
  });

  it('will not reverse the same transfer twice', async () => {
    await fund('cash_at_hand', 5_000_000);
    const id = await queryOne<{ id: string }>(
      `select public.record_transfer($1, $2, 100000, current_date, 'One') as id`,
      [await accountId('cash_at_hand'), await accountId('bank')],
    );

    await query(`select public.reverse_transfer($1, 'First reversal')`, [id.id]);

    await expect(
      query(`select public.reverse_transfer($1, 'Second reversal')`, [id.id]),
    ).rejects.toThrow(/only a posted transfer/i);
  });

  it('will not reverse a transfer whose money has since been spent', async () => {
    await fund('cash_at_hand', 1_000_000);
    const cash = await accountId('cash_at_hand');
    const bank = await accountId('bank');

    const id = await queryOne<{ id: string }>(
      `select public.record_transfer($1, $2, 1000000, current_date, 'All of it') as id`,
      [cash, bank],
    );

    // The bank account pays a supplier, so the money to send back is gone.
    await query(`select public.record_expense($1, $2, 1000000, current_date, 'Rent')`, [
      await accountByCode('5010'),
      bank,
    ]);

    await expect(
      query(`select public.reverse_transfer($1, 'Too late')`, [id.id]),
    ).rejects.toThrow(/less than/i);
  });
});

// ---------------------------------------------------------------------------
describeDb('an expense consumes money; a loan does not', () => {
  it('debits the category and credits the account it was paid from', async () => {
    await fund('cash_at_hand', 2_000_000);
    const cash = await accountId('cash_at_hand');
    const rent = await accountByCode('5010');

    await query(
      `select public.record_expense($1, $2, 300000, current_date, 'October rent', 'Kyebando Properties')`,
      [rent, cash],
    );

    expect(await balance(rent)).toBe(300_000);
    expect(await balance(cash)).toBe(1_700_000);

    const { debits, credits } = await trialBalance();
    expect(debits).toBe(credits);
  });

  it('refuses a category that is a heading, or that is not an expense account', async () => {
    await fund('cash_at_hand', 1_000_000);
    const cash = await accountId('cash_at_hand');

    await expect(
      query(`select public.record_expense($1, $2, 1000, current_date, 'No')`, [
        await accountByCode('5000'),
        cash,
      ]),
    ).rejects.toThrow(/heading/i);

    await expect(
      query(`select public.record_expense($1, $2, 1000, current_date, 'No')`, [
        await accountByCode('4300'),
        cash,
      ]),
    ).rejects.toThrow(/not an expense account/i);
  });

  it('holds a large expense for approval and posts it when somebody agrees', async () => {
    await fund('cash_at_hand', 5_000_000);
    const cash = await accountId('cash_at_hand');
    const salaries = await accountByCode('5020');

    const id = await queryOne<{ id: string }>(
      `select public.record_expense($1, $2, 1500000, current_date, 'October salaries') as id`,
      [salaries, cash],
    );

    let row = await queryOne<{ status: string; has_journal: boolean }>(
      `select status, journal_entry_id is not null as has_journal from public.expenses`,
    );
    expect(row.status).toBe('pending_approval');
    expect(row.has_journal).toBe(false);
    expect(await balance(salaries)).toBe(0);

    await query(`select public.approve_expense($1)`, [id.id]);

    row = await queryOne<{ status: string; has_journal: boolean }>(
      `select status, journal_entry_id is not null as has_journal from public.expenses`,
    );
    expect(row.status).toBe('posted');
    expect(row.has_journal).toBe(true);
    expect(await balance(salaries)).toBe(1_500_000);
  });

  it('reverses an expense with a contra entry', async () => {
    await fund('cash_at_hand', 2_000_000);
    const cash = await accountId('cash_at_hand');
    const fuel = await accountByCode('5090');

    const id = await queryOne<{ id: string }>(
      `select public.record_expense($1, $2, 80000, current_date, 'Fuel') as id`,
      [fuel, cash],
    );

    await query(
      `select public.reverse_expense($1, 'Recorded against the wrong branch')`,
      [id.id],
    );

    expect(await balance(fuel)).toBe(0);
    expect(await balance(cash)).toBe(2_000_000);

    const effective = await queryOne<{ total: string }>(
      `select coalesce(sum(effective_amount), 0)::text as total from public.expense_register`,
    );
    // `effective_amount` is what was actually spent, which is nothing.
    expect(Number(effective.total)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
describeDb('fee income is income; recovered principal is not', () => {
  it('debits the receiving account and credits the fee account', async () => {
    const cash = await accountId('cash_at_hand');
    const applicationFees = await accountByCode('4300');

    await query(
      `select public.record_other_income($1, $2, 20000, current_date, 'Application fee')`,
      [applicationFees, cash],
    );

    expect(await balance(cash)).toBe(20_000);
    expect(await balance(applicationFees)).toBe(20_000);

    const { debits, credits } = await trialBalance();
    expect(debits).toBe(credits);
  });

  it('refuses to post a fee into Interest or Penalty Income', async () => {
    const cash = await accountId('cash_at_hand');

    for (const code of ['4100', '4200']) {
      await expect(
        query(
          `select public.record_other_income($1, $2, 5000, current_date, 'Should fail')`,
          [await accountByCode(code), cash],
        ),
        code,
      ).rejects.toThrow(/lending functions/i);
    }

    // Those two accounts are proved against the payment allocations by the
    // Phase 10 reconciliation. A hand-typed fee landing in either would break
    // it silently, which is why this is a refusal rather than a convention.
    expect(await balance(await accountByCode('4100'))).toBe(0);
  });

  it('reverses income and takes the money back out', async () => {
    const cash = await accountId('cash_at_hand');
    const fees = await accountByCode('4310');

    const id = await queryOne<{ id: string }>(
      `select public.record_other_income($1, $2, 50000, current_date, 'Processing fee') as id`,
      [fees, cash],
    );

    await query(`select public.reverse_other_income($1, 'Charged in error')`, [id.id]);

    expect(await balance(cash)).toBe(0);
    expect(await balance(fees)).toBe(0);

    const row = await queryOne<{ status: string }>(
      `select status from public.other_income`,
    );
    expect(row.status).toBe('reversed');
  });
});

// ---------------------------------------------------------------------------
describeDb('a count that disagrees is never resolved by moving the ledger', () => {
  it('records a count that agrees and posts nothing', async () => {
    await fund('bank', 500_000);
    const bank = await accountId('bank');

    await query(
      `select public.submit_reconciliation($1, current_date, 500000, 'Statement agrees')`,
      [bank],
    );

    const row = await queryOne<{ status: string; variance: string; adj: boolean }>(
      `select status, variance::text as variance, adjustment_entry_id is not null as adj
         from public.account_reconciliations`,
    );

    expect(row.status).toBe('balanced');
    expect(Number(row.variance)).toBe(0);
    expect(row.adj).toBe(false);
  });

  it('leaves the ledger alone while a difference is unresolved', async () => {
    await fund('cash_at_hand', 1_000_000);
    const cash = await accountId('cash_at_hand');

    await query(
      `select public.submit_reconciliation($1, current_date, 985000, 'Drawer short')`,
      [cash],
    );

    const row = await queryOne<{ status: string; variance: string }>(
      `select status, variance::text as variance from public.account_reconciliations`,
    );

    expect(row.status).toBe('submitted');
    expect(Number(row.variance)).toBe(-15_000);
    // The ledger still says what it said. This is the single most important
    // assertion in the module: a count is evidence, not an instruction.
    expect(await balance(cash)).toBe(1_000_000);
  });

  it('writes an approved shortage off to Cash Over and Short', async () => {
    await fund('cash_at_hand', 1_000_000);
    const cash = await accountId('cash_at_hand');

    const id = await queryOne<{ id: string }>(
      `select public.submit_reconciliation($1, current_date, 985000, 'Drawer short') as id`,
      [cash],
    );

    await query(`select public.approve_reconciliation($1, 'Till error')`, [id.id]);

    expect(await balance(cash)).toBe(985_000);
    expect(await balance(await accountByCode('5950'))).toBe(15_000);

    const { debits, credits } = await trialBalance();
    expect(debits).toBe(credits);
  });

  it('writes an approved overage off the other way', async () => {
    await fund('cash_at_hand', 1_000_000);
    const cash = await accountId('cash_at_hand');

    const id = await queryOne<{ id: string }>(
      `select public.submit_reconciliation($1, current_date, 1007000, 'Found extra') as id`,
      [cash],
    );

    await query(`select public.approve_reconciliation($1, 'Earlier payment missed')`, [
      id.id,
    ]);

    expect(await balance(cash)).toBe(1_007_000);
    // An overage credits the account, so its debit-normal balance is negative.
    expect(await balance(await accountByCode('5950'))).toBe(-7_000);
  });

  it('keeps a rejected difference visible and unposted', async () => {
    await fund('cash_at_hand', 1_000_000);
    const cash = await accountId('cash_at_hand');

    const id = await queryOne<{ id: string }>(
      `select public.submit_reconciliation($1, current_date, 900000, 'Unexplained') as id`,
      [cash],
    );

    await query(`select public.reject_reconciliation($1, 'Count again before I sign')`, [
      id.id,
    ]);

    const row = await queryOne<{ status: string; variance: string; adj: boolean }>(
      `select status, variance::text as variance, adjustment_entry_id is not null as adj
         from public.account_reconciliations`,
    );

    expect(row.status).toBe('rejected');
    expect(Number(row.variance)).toBe(-100_000);
    expect(row.adj).toBe(false);
    expect(await balance(cash)).toBe(1_000_000);
  });

  it('allows one count per account per day', async () => {
    await fund('bank', 100_000);
    const bank = await accountId('bank');

    await query(`select public.submit_reconciliation($1, current_date, 100000, null)`, [
      bank,
    ]);

    await expect(
      query(`select public.submit_reconciliation($1, current_date, 100000, null)`, [
        bank,
      ]),
    ).rejects.toThrow();
  });

  it('refuses a count for a date in the future', async () => {
    const bank = await accountId('bank');

    await expect(
      query(`select public.submit_reconciliation($1, current_date + 1, 0, null)`, [bank]),
    ).rejects.toThrow(/future/i);
  });
});

// ---------------------------------------------------------------------------
describeDb('every movement is in the books exactly once', () => {
  it('keeps the trial balance footing across every kind of movement', async () => {
    await fund('cash_at_hand', 8_000_000);
    const cash = await accountId('cash_at_hand');
    const bank = await accountId('bank');
    const mtn = await accountId('mtn_mobile_money');

    await query(
      `select public.record_transfer($1, $2, 1000000, current_date, 'Banking')`,
      [cash, bank],
    );
    await query(`select public.record_transfer($1, $2, 500000, current_date, 'Float')`, [
      cash,
      mtn,
    ]);
    await query(`select public.record_expense($1, $2, 250000, current_date, 'Rent')`, [
      await accountByCode('5010'),
      cash,
    ]);
    await query(`select public.record_other_income($1, $2, 30000, current_date, 'Fee')`, [
      await accountByCode('4300'),
      cash,
    ]);

    const { debits, credits } = await trialBalance();
    expect(debits).toBe(credits);

    // Assets equal equity plus income less expenses, which is the balance
    // sheet identity and the thing a trial balance footing does not prove on
    // its own.
    const sheet = await queryOne<{ assets: string; funding: string }>(
      `select
         (select coalesce(sum(balance), 0) from public.ledger_account_balances
           where account_type = 'asset')::text as assets,
         (select coalesce(sum(balance), 0) from public.ledger_account_balances
           where account_type in ('equity', 'income'))
         - (select coalesce(sum(balance), 0) from public.ledger_account_balances
             where account_type = 'expense')::bigint as funding`,
    );
    expect(sheet.assets).toBe(sheet.funding);
  });

  it('refuses a second journal for the same document', async () => {
    await fund('cash_at_hand', 2_000_000);
    const id = await queryOne<{ id: string }>(
      `select public.record_transfer($1, $2, 100000, current_date, 'One') as id`,
      [await accountId('cash_at_hand'), await accountId('bank')],
    );

    // The posting function is idempotent, and the unique index on
    // (source_type, source_id) is what makes that a guarantee rather than a
    // convention.
    const second = await queryOne<{ result: string | null }>(
      `select public.post_transfer_journal($1) as result`,
      [id.id],
    );
    expect(second.result).toBeNull();

    const count = await queryOne<{ n: string }>(
      `select count(*)::text as n from public.journal_entries where source_type = 'transfer'`,
    );
    expect(Number(count.n)).toBe(1);
  });

  it('refuses a hand-typed duplicate journal for a document', async () => {
    await fund('cash_at_hand', 2_000_000);
    const id = await queryOne<{ id: string }>(
      `select public.record_transfer($1, $2, 100000, current_date, 'One') as id`,
      [await accountId('cash_at_hand'), await accountId('bank')],
    );

    const branch = await queryOne<{ id: string }>(
      `select id from public.branches order by branch_code limit 1`,
    );

    await expect(
      query(
        `select public.post_journal(
           $1, current_date, 'Forged duplicate', 'transfer', $2, null, null,
           jsonb_build_array(
             jsonb_build_object('account_id', $3::uuid, 'debit', 1, 'credit', 0),
             jsonb_build_object('account_id', $4::uuid, 'debit', 0, 'credit', 1)
           ))`,
        [branch.id, id.id, await accountId('bank'), await accountId('cash_at_hand')],
      ),
    ).rejects.toThrow();
  });

  it('never lets a document exist without the journal that makes it true', async () => {
    await fund('cash_at_hand', 2_000_000);
    const cash = await accountId('cash_at_hand');
    const bank = await accountId('bank');

    // Deactivating the destination makes the posting impossible. The
    // document must go with it.
    await query(`update public.ledger_accounts set status = 'inactive' where id = $1`, [
      bank,
    ]);

    try {
      await expect(
        query(
          `select public.record_transfer($1, $2, 100000, current_date, 'Should roll back')`,
          [cash, bank],
        ),
      ).rejects.toThrow(/not active/i);

      const rows = await query(`select 1 from public.account_transfers`);
      expect(rows).toHaveLength(0);
    } finally {
      await query(`update public.ledger_accounts set status = 'active' where id = $1`, [
        bank,
      ]);
    }
  });
});

// ---------------------------------------------------------------------------
describeDb('the registers agree with the ledger', () => {
  it('reports every posted movement in the general ledger', async () => {
    await fund('cash_at_hand', 3_000_000);
    const cash = await accountId('cash_at_hand');

    await query(
      `select public.record_expense($1, $2, 120000, current_date, 'Stationery')`,
      [await accountByCode('5050'), cash],
    );

    const line = await queryOne<{
      account_code: string;
      debit: string;
      source_type: string;
    }>(
      `select account_code, debit::text as debit, source_type
         from public.general_ledger
        where source_type = 'expense' and debit > 0`,
    );

    expect(line.account_code).toBe('5050');
    expect(Number(line.debit)).toBe(120_000);
  });

  it('agrees with branch_cash_position after every movement', async () => {
    await fund('cash_at_hand', 4_000_000);
    const cash = await accountId('cash_at_hand');
    const mtn = await accountId('mtn_mobile_money');

    await query(`select public.record_transfer($1, $2, 600000, current_date, 'Float')`, [
      cash,
      mtn,
    ]);

    const position = await queryOne<{ cash: string; mtn: string }>(
      `select cash_at_hand::text as cash, mtn_mobile_money::text as mtn
         from public.branch_cash_position`,
    );

    expect(Number(position.cash)).toBe(await balance(cash));
    expect(Number(position.mtn)).toBe(await balance(mtn));
  });
});
