import type { PoolClient } from 'pg';
import { afterAll, describe, expect, it } from 'vitest';

import { closePool, hasDatabase, inRollbackTransaction, skipReason } from '../helpers/db';

/**
 * The double-entry ledger's invariants, asserted where they are enforced.
 *
 * A ledger is only worth having if it cannot be made to lie. These are the
 * rules that make that true, and every one of them is a database constraint
 * rather than an application check — so they hold for the application, for
 * `service_role`, and for anything typed straight into psql.
 *
 * ## Why `set constraints all immediate`
 *
 * The balance rule is a *deferred* constraint trigger: lines arrive one
 * INSERT at a time, so the rule is about the set of them and can only be
 * evaluated once they are all in. That normally means at COMMIT, which a test
 * running inside a rolled-back transaction never reaches. `set constraints
 * all immediate` forces the check to run at that point instead, which raises
 * exactly the error a commit would have raised, while the surrounding
 * rollback still cleans up.
 */
const describeDb = hasDatabase ? describe : describe.skip;

if (!hasDatabase) {
  describe('ledger suite', () => {
    it.skip(`skipped — ${skipReason}`, () => undefined);
  });
}

afterAll(async () => {
  await closePool();
});

/**
 * A branch, its four cash accounts and the handful of chart rows these tests
 * post against. Created inside the caller's transaction, so nothing survives.
 */
async function scaffold(client: PoolClient): Promise<{
  branchId: string;
  accounts: Readonly<Record<string, string>>;
}> {
  const branch = await client.query<{ id: string }>(
    `insert into public.branches (branch_code, name, location, district, opened_on)
     values ('BRTEST', 'Test Branch', 'Somewhere', 'Kampala', date '2025-01-06')
     returning id`,
  );
  const branchId = branch.rows[0]!.id;

  const rows = await client.query<{ code: string; id: string }>(
    `insert into public.ledger_accounts
       (code, name, account_type, normal_side, cash_kind, branch_id)
     values
       ('T-CASH', 'Cash at Hand', 'asset', 'debit', 'cash_at_hand', $1),
       ('T-BANK', 'Cash at Bank', 'asset', 'debit', 'bank', $1)
     returning code, id`,
    [branchId],
  );

  const plain = await client.query<{ code: string; id: string }>(
    `insert into public.ledger_accounts (code, name, account_type, normal_side)
     values
       ('T-RECV', 'Loans Receivable', 'asset', 'debit'),
       ('T-CAP', 'Owner Capital', 'equity', 'credit'),
       ('T-INT', 'Interest Income', 'income', 'credit')
     returning code, id`,
  );

  const accounts: Record<string, string> = {};
  for (const row of [...rows.rows, ...plain.rows]) accounts[row.code] = row.id;

  return { branchId, accounts };
}

async function newEntry(
  client: PoolClient,
  branchId: string,
  description: string,
): Promise<string> {
  const entry = await client.query<{ id: string }>(
    `insert into public.journal_entries
       (entry_number, branch_id, entry_date, description, source_type)
     values (public.next_reference('journal'), $1, current_date, $2, 'adjustment')
     returning id`,
    [branchId, description],
  );
  return entry.rows[0]!.id;
}

async function line(
  client: PoolClient,
  entryId: string,
  lineNumber: number,
  accountId: string,
  debit: number,
  credit: number,
): Promise<void> {
  await client.query(
    `insert into public.journal_lines
       (entry_id, line_number, account_id, debit, credit)
     values ($1, $2, $3, $4, $5)`,
    [entryId, lineNumber, accountId, debit, credit],
  );
}

/**
 * Run a statement that is expected to fail, inside a savepoint.
 *
 * Postgres aborts the whole transaction when a statement raises, and every
 * later statement then fails with "current transaction is aborted" rather
 * than with the error the test is about. A savepoint confines the damage, so
 * a test can assert two refusals in a row and mean both of them.
 */
async function refusal(
  client: PoolClient,
  sql: string,
  params: readonly unknown[] = [],
): Promise<string> {
  await client.query('savepoint attempt');
  try {
    await client.query(sql, [...params]);
    await client.query('release savepoint attempt');
    return '';
  } catch (error) {
    await client.query('rollback to savepoint attempt');
    return (error as { message?: string }).message ?? 'unknown error';
  }
}

/** Run the deferred checks now, and return the error they raise, or null. */
async function settle(client: PoolClient): Promise<string | null> {
  try {
    await client.query('set constraints all immediate');
    return null;
  } catch (error) {
    return (error as { message?: string }).message ?? 'unknown error';
  }
}

describeDb('a journal must balance', () => {
  it('accepts an entry whose debits equal its credits', async () => {
    await inRollbackTransaction(async (client) => {
      const { branchId, accounts } = await scaffold(client);
      const entry = await newEntry(client, branchId, 'Capital introduced');
      await line(client, entry, 1, accounts['T-BANK']!, 30_000_000, 0);
      await line(client, entry, 2, accounts['T-CAP']!, 0, 30_000_000);

      expect(await settle(client)).toBeNull();
    });
  });

  it('refuses an entry whose sides differ, naming the difference', async () => {
    await inRollbackTransaction(async (client) => {
      const { branchId, accounts } = await scaffold(client);
      const entry = await newEntry(client, branchId, 'Lopsided');
      await line(client, entry, 1, accounts['T-RECV']!, 500, 0);
      await line(client, entry, 2, accounts['T-INT']!, 0, 400);

      const error = await settle(client);
      expect(error).toContain('does not balance');
      expect(error).toContain('difference 100');
    });
  });

  it('refuses an entry with a single line', async () => {
    await inRollbackTransaction(async (client) => {
      const { branchId, accounts } = await scaffold(client);
      const entry = await newEntry(client, branchId, 'One leg');
      await line(client, entry, 1, accounts['T-RECV']!, 100, 0);

      expect(await settle(client)).toContain('A posting has at least two sides');
    });
  });

  it('refuses an entry with no lines at all', async () => {
    await inRollbackTransaction(async (client) => {
      const { branchId } = await scaffold(client);
      await newEntry(client, branchId, 'Empty');

      expect(await settle(client)).toContain('has no lines');
    });
  });

  it('refuses a line that carries a debit and a credit at once', async () => {
    await inRollbackTransaction(async (client) => {
      const { branchId, accounts } = await scaffold(client);
      const entry = await newEntry(client, branchId, 'Both sides');

      expect(
        await refusal(
          client,
          `insert into public.journal_lines (entry_id, line_number, account_id, debit, credit)
           values ($1, 1, $2, 5, 5)`,
          [entry, accounts['T-RECV']!],
        ),
      ).toContain('journal_lines_one_side');
    });
  });

  it('refuses a line that moves nothing', async () => {
    await inRollbackTransaction(async (client) => {
      const { branchId, accounts } = await scaffold(client);
      const entry = await newEntry(client, branchId, 'Zero');

      expect(
        await refusal(
          client,
          `insert into public.journal_lines (entry_id, line_number, account_id, debit, credit)
           values ($1, 1, $2, 0, 0)`,
          [entry, accounts['T-RECV']!],
        ),
      ).toContain('journal_lines_one_side');
    });
  });

  it('refuses a negative amount rather than treating it as the other side', async () => {
    await inRollbackTransaction(async (client) => {
      const { branchId, accounts } = await scaffold(client);
      const entry = await newEntry(client, branchId, 'Negative');

      expect(
        await refusal(
          client,
          `insert into public.journal_lines (entry_id, line_number, account_id, debit, credit)
           values ($1, 1, $2, -100, 0)`,
          [entry, accounts['T-RECV']!],
        ),
      ).toContain('journal_lines_debit_not_negative');
    });
  });
});

describeDb('a posted journal is history', () => {
  it('refuses to edit the substance of an entry', async () => {
    await inRollbackTransaction(async (client) => {
      const { branchId, accounts } = await scaffold(client);
      const entry = await newEntry(client, branchId, 'Original');
      await line(client, entry, 1, accounts['T-BANK']!, 100, 0);
      await line(client, entry, 2, accounts['T-CAP']!, 0, 100);

      expect(
        await refusal(
          client,
          `update public.journal_entries set description = 'edited' where id = $1`,
          [entry],
        ),
      ).toContain('Reverse it with a contra entry');
    });
  });

  it('refuses to delete an entry or a line', async () => {
    await inRollbackTransaction(async (client) => {
      const { branchId, accounts } = await scaffold(client);
      const entry = await newEntry(client, branchId, 'Permanent');
      await line(client, entry, 1, accounts['T-BANK']!, 100, 0);
      await line(client, entry, 2, accounts['T-CAP']!, 0, 100);

      expect(
        await refusal(client, `delete from public.journal_lines where entry_id = $1`, [
          entry,
        ]),
      ).toContain('append-only');
      expect(
        await refusal(client, `delete from public.journal_entries where id = $1`, [
          entry,
        ]),
      ).toContain('append-only');
    });
  });

  it('refuses to edit a line', async () => {
    await inRollbackTransaction(async (client) => {
      const { branchId, accounts } = await scaffold(client);
      const entry = await newEntry(client, branchId, 'Permanent line');
      await line(client, entry, 1, accounts['T-BANK']!, 100, 0);
      await line(client, entry, 2, accounts['T-CAP']!, 0, 100);

      expect(
        await refusal(
          client,
          `update public.journal_lines set debit = 1 where entry_id = $1`,
          [entry],
        ),
      ).toContain('append-only');
    });
  });

  it('permits exactly one update: stamping the contra entry', async () => {
    await inRollbackTransaction(async (client) => {
      const { branchId, accounts } = await scaffold(client);

      const original = await newEntry(client, branchId, 'Original');
      await line(client, original, 1, accounts['T-BANK']!, 100, 0);
      await line(client, original, 2, accounts['T-CAP']!, 0, 100);

      const contra = await newEntry(client, branchId, 'Reversal of the above');
      await line(client, contra, 1, accounts['T-CAP']!, 100, 0);
      await line(client, contra, 2, accounts['T-BANK']!, 0, 100);

      await client.query(
        `update public.journal_entries set reversed_by_entry_id = $2 where id = $1`,
        [original, contra],
      );

      expect(await settle(client)).toBeNull();

      // And only once. A second reversal of the same entry would mean the
      // original had been cancelled twice.
      expect(
        await refusal(
          client,
          `update public.journal_entries set reversed_by_entry_id = $2 where id = $1`,
          [original, original],
        ),
      ).toContain('already been reversed');
    });
  });
});

describeDb('the chart of accounts', () => {
  it('holds one Cash at Hand, one MTN float and one Airtel float per branch', async () => {
    await inRollbackTransaction(async (client) => {
      const { branchId } = await scaffold(client);

      expect(
        await refusal(
          client,
          `insert into public.ledger_accounts
             (code, name, account_type, normal_side, cash_kind, branch_id)
           values ('T-CASH2', 'Second till', 'asset', 'debit', 'cash_at_hand', $1)`,
          [branchId],
        ),
      ).toContain('ledger_accounts_one_wallet_per_branch');
    });
  });

  it('allows a branch more than one bank account', async () => {
    await inRollbackTransaction(async (client) => {
      const { branchId } = await scaffold(client);

      await client.query(
        `insert into public.ledger_accounts
           (code, name, account_type, normal_side, cash_kind, branch_id, institution)
         values ('T-BANK2', 'Second bank account', 'asset', 'debit', 'bank', $1, 'Centenary')`,
        [branchId],
      );

      expect(await settle(client)).toBeNull();
    });
  });

  it('refuses a cash account that is not an asset', async () => {
    await inRollbackTransaction(async (client) => {
      const { branchId } = await scaffold(client);

      expect(
        await refusal(
          client,
          `insert into public.ledger_accounts
             (code, name, account_type, normal_side, cash_kind, branch_id)
           values ('T-BAD', 'Cash income', 'income', 'credit', 'cash_at_hand', $1)`,
          [branchId],
        ),
      ).toContain('ledger_accounts_cash_is_asset');
    });
  });

  it('refuses cash that belongs to no branch, and a branch-held non-cash account', async () => {
    await inRollbackTransaction(async (client) => {
      const { branchId } = await scaffold(client);

      expect(
        await refusal(
          client,
          `insert into public.ledger_accounts (code, name, account_type, normal_side, cash_kind)
           values ('T-ORPHAN', 'Homeless cash', 'asset', 'debit', 'cash_at_hand')`,
        ),
      ).toContain('ledger_accounts_cash_is_branch_held');

      expect(
        await refusal(
          client,
          `insert into public.ledger_accounts
             (code, name, account_type, normal_side, branch_id)
           values ('T-ODD', 'Branch interest', 'income', 'credit', $1)`,
          [branchId],
        ),
      ).toContain('ledger_accounts_cash_is_branch_held');
    });
  });

  it('refuses a normal side that contradicts the account type', async () => {
    await inRollbackTransaction(async (client) => {
      expect(
        await refusal(
          client,
          `insert into public.ledger_accounts (code, name, account_type, normal_side)
           values ('T-WRONG', 'Backwards asset', 'asset', 'credit')`,
        ),
      ).toContain('ledger_accounts_side_matches_type');
    });
  });
});

describeDb('balances are derived, never stored', () => {
  it('signs each account the way it is read, and foots the trial balance', async () => {
    await inRollbackTransaction(async (client) => {
      const { branchId, accounts } = await scaffold(client);

      // Capital introduced, then a disbursement out of the bank.
      const capital = await newEntry(client, branchId, 'Capital introduced');
      await line(client, capital, 1, accounts['T-BANK']!, 5_000_000, 0);
      await line(client, capital, 2, accounts['T-CAP']!, 0, 5_000_000);

      const disbursement = await newEntry(client, branchId, 'Loan paid out');
      await line(client, disbursement, 1, accounts['T-RECV']!, 1_200_000, 0);
      await line(client, disbursement, 2, accounts['T-BANK']!, 0, 1_200_000);

      expect(await settle(client)).toBeNull();

      const balances = await client.query<{ code: string; balance: string }>(
        `select code, balance::text from public.ledger_account_balances
          where balance <> 0 order by code`,
      );
      expect(Object.fromEntries(balances.rows.map((r) => [r.code, r.balance]))).toEqual({
        'T-BANK': '3800000',
        'T-CAP': '5000000',
        'T-RECV': '1200000',
      });

      const trial = await client.query<{ debits: string; credits: string }>(
        `select sum(total_debit)::text as debits, sum(total_credit)::text as credits
           from public.trial_balance`,
      );
      expect(trial.rows[0]!.debits).toBe(trial.rows[0]!.credits);
    });
  });

  it('reports the branch cash position across the four kinds', async () => {
    await inRollbackTransaction(async (client) => {
      const { branchId, accounts } = await scaffold(client);

      const entry = await newEntry(client, branchId, 'Float placed');
      await line(client, entry, 1, accounts['T-CASH']!, 400_000, 0);
      await line(client, entry, 2, accounts['T-BANK']!, 1_600_000, 0);
      await line(client, entry, 3, accounts['T-CAP']!, 0, 2_000_000);

      expect(await settle(client)).toBeNull();

      const position = await client.query<{
        cash_at_hand: string;
        cash_at_bank: string;
        total_liquidity: string;
      }>(
        `select cash_at_hand::text, cash_at_bank::text, total_liquidity::text
           from public.branch_cash_position where branch_id = $1`,
        [branchId],
      );

      expect(position.rows[0]).toEqual({
        cash_at_hand: '400000',
        cash_at_bank: '1600000',
        total_liquidity: '2000000',
      });
    });
  });
});
