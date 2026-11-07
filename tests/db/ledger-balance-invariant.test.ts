import type { PoolClient } from 'pg';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { closePool, hasDatabase, inRollbackTransaction, skipReason } from '../helpers/db';

/**
 * Phase 4B-S, Task 6 — the ledger balance invariant, asserted against the
 * posting sources Phase 4 introduced.
 *
 * The review asked for a recommendation on making "debits equal credits" a
 * transaction-safe invariant covering every posting source. It already is
 * one, and has been since Phase 1: `journal_assert_balanced()` runs from two
 * DEFERRABLE INITIALLY DEFERRED constraint triggers, one on each ledger
 * table. Because they sit on the tables rather than inside `post_journal()`,
 * they bind every writer — the application, `service_role`, a SECURITY
 * DEFINER function, or a statement typed into psql — and because they are
 * deferred they tolerate the momentarily unbalanced state that inserting
 * lines one at a time necessarily produces.
 *
 * `tests/db/ledger.test.ts` already proves the rule itself. What nothing
 * proved was that the five source types Phase 4 added are subject to it. A
 * table-level trigger covers them structurally, but "structurally" is an
 * argument, and an argument is not a test. These are the tests.
 *
 * See docs/POLYTOS-LEDGER-BALANCE-INVARIANT-REVIEW.md for the evidence and
 * the recommendation.
 */
const describeDb = hasDatabase ? describe : describe.skip;

if (!hasDatabase) {
  describe('ledger balance invariant', () => {
    it.skip(`skipped — ${skipReason}`, () => undefined);
  });
}

afterAll(async () => {
  await closePool();
});

/** Every source type the ledger accepts, read from the live constraint. */
async function sourceTypes(client: PoolClient): Promise<string[]> {
  const r = await client.query<{ def: string }>(
    `select pg_get_constraintdef(oid) as def from pg_constraint
      where conname = 'journal_entries_source_valid'`,
  );
  return [...(r.rows[0]?.def ?? '').matchAll(/'([a-z_]+)'::text/g)].map(
    (m) => m[1]!,
  );
}

/** An entry of the given source type, with no lines yet. */
async function newEntry(
  client: PoolClient,
  source: string,
): Promise<{ id: string; payable: string; income: string }> {
  // Two non-branch accounts, so the fixture needs no per-branch cash account
  // and no chart scaffolding: 2220 Bank Agency Payable and 4510 Agency
  // Commission Income, both created by the Phase 4A chart migration.
  const acc = await client.query<{ code: string; id: string }>(
    `select code, id from public.ledger_accounts where code in ('2220', '4510')`,
  );
  const byCode = new Map(acc.rows.map((r) => [r.code, r.id]));
  const r = await client.query<{ id: string }>(
    `insert into public.journal_entries
       (entry_number, branch_id, entry_date, description, source_type)
     select public.next_reference('journal'), b.id, current_date,
            'Task 6 invariant probe', $1
       from public.branches b order by b.branch_code limit 1
     returning id`,
    [source],
  );
  return {
    id: r.rows[0]!.id,
    payable: byCode.get('2220')!,
    income: byCode.get('4510')!,
  };
}

async function line(
  client: PoolClient,
  entry: string,
  n: number,
  account: string,
  debit: number,
  credit: number,
): Promise<void> {
  await client.query(
    `insert into public.journal_lines
       (entry_id, line_number, account_id, debit, credit)
     values ($1, $2, $3, $4, $5)`,
    [entry, n, account, debit, credit],
  );
}

/** Force the deferred checks to run now; return their error, or null. */
async function settle(client: PoolClient): Promise<string | null> {
  try {
    await client.query('set constraints all immediate');
    return null;
  } catch (error) {
    return (error as { message?: string }).message ?? 'unknown error';
  }
}

describeDb('the balance invariant binds every Phase 4 posting source', () => {
  it('covers all five agency source types, and nothing is missing', async () => {
    await inRollbackTransaction(async (client) => {
      const all = await sourceTypes(client);
      expect(all).toEqual(expect.arrayContaining(['agency_transaction']));
      expect(all.filter((s) => s.startsWith('agency_'))).toEqual([
        'agency_transaction',
        'agency_transaction_reversal',
        'agency_commission_settlement',
        'agency_payable_settlement',
        'agency_payable_settlement_reversal',
      ]);
    });
  });

  // One test per source type, so a failure names the source that escaped.
  const agencySources = [
    'agency_transaction',
    'agency_transaction_reversal',
    'agency_commission_settlement',
    'agency_payable_settlement',
    'agency_payable_settlement_reversal',
  ] as const;

  for (const source of agencySources) {
    it(`refuses an unbalanced ${source} entry at commit`, async () => {
      await inRollbackTransaction(async (client) => {
        const e = await newEntry(client, source);
        await line(client, e.id, 1, e.payable, 300_000, 0);
        await line(client, e.id, 2, e.income, 0, 299_999);

        const error = await settle(client);
        expect(error).toContain('does not balance');
        expect(error).toContain('difference 1');
      });
    });

    it(`refuses a one-sided ${source} entry at commit`, async () => {
      await inRollbackTransaction(async (client) => {
        const e = await newEntry(client, source);
        await line(client, e.id, 1, e.payable, 300_000, 0);

        expect(await settle(client)).toContain('A posting has at least two sides');
      });
    });

    it(`accepts a balanced ${source} entry`, async () => {
      await inRollbackTransaction(async (client) => {
        const e = await newEntry(client, source);
        await line(client, e.id, 1, e.payable, 300_000, 0);
        await line(client, e.id, 2, e.income, 0, 300_000);

        expect(await settle(client)).toBeNull();
      });
    });
  }

  it('tolerates a momentarily unbalanced entry mid-transaction', async () => {
    // This is what makes the invariant transaction-safe rather than merely
    // present: after line 1 the entry is 300,000 out, and that state has to
    // be allowed to exist or multi-line posting could not work at all.
    await inRollbackTransaction(async (client) => {
      const e = await newEntry(client, 'agency_transaction');
      await line(client, e.id, 1, e.payable, 300_000, 0);

      const mid = await client.query<{ d: string; c: string }>(
        `select coalesce(sum(debit),0)::text as d, coalesce(sum(credit),0)::text as c
           from public.journal_lines where entry_id = $1`,
        [e.id],
      );
      expect(mid.rows[0]!.d).toBe('300000');
      expect(mid.rows[0]!.c).toBe('0');

      await line(client, e.id, 2, e.income, 0, 300_000);
      expect(await settle(client)).toBeNull();
    });
  });
});

describeDb('the invariant cannot be stepped around', () => {
  it('is enforced by constraint triggers on both ledger tables', async () => {
    await inRollbackTransaction(async (client) => {
      const r = await client.query<{ relname: string; tgname: string }>(
        `select c.relname, t.tgname from pg_trigger t
           join pg_class c on c.oid = t.tgrelid
          where t.tgname like '%assert_balanced'
            and not t.tgisinternal
            and t.tgconstraint <> 0
            and t.tgdeferrable
            and t.tginitdeferred
          order by c.relname`,
      );
      expect(r.rows).toEqual([
        {
          relname: 'journal_entries',
          tgname: 'journal_entries_assert_balanced',
        },
        { relname: 'journal_lines', tgname: 'journal_lines_assert_balanced' },
      ]);
    });
  });

  it('refuses to let authenticated disable the triggers', async () => {
    await inRollbackTransaction(async (client) => {
      await client.query('set local role authenticated');
      await expect(
        client.query(
          'alter table public.journal_lines disable trigger journal_lines_assert_balanced',
        ),
      ).rejects.toThrow(/must be owner of table journal_lines/);
    });
  });

  it('refuses to let authenticated set session_replication_role', async () => {
    await inRollbackTransaction(async (client) => {
      await client.query('set local role authenticated');
      await expect(
        client.query(`set local session_replication_role = 'replica'`),
      ).rejects.toThrow(/permission denied to set parameter/);
    });
  });

  it('has no migration that sets session_replication_role', () => {
    // The one residual bypass vector is a privileged session turning triggers
    // off wholesale. No migration may do that, and this fails if one starts.
    const dir = join(process.cwd(), 'supabase', 'migrations');
    const offenders = readdirSync(dir)
      .filter((f) => f.endsWith('.sql'))
      .filter((f) => {
        // Strip `--` line comments and `/* */` blocks first: several
        // migrations discuss `alter table ... disable trigger` in prose
        // precisely to explain why they do not use it, and matching a comment
        // would make this test fail on correct code.
        const sql = readFileSync(join(dir, f), 'utf8')
          .replace(/\/\*[\s\S]*?\*\//g, ' ')
          .replace(/--[^\n]*/g, ' ');
        return /session_replication_role|disable\s+trigger/i.test(sql);
      });
    expect(offenders).toEqual([]);
  });
});
