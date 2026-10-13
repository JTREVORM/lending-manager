import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { closePool, hasDatabase, query, queryOne, skipReason } from '../helpers/db';
import { deleteTestUsers } from '../helpers/auth-fixtures';
import { deleteTestLoans } from '../helpers/loan-fixtures';

/**
 * `public.trial_balance`, the one source the trial balance screen reads.
 *
 * ## What is actually at risk
 *
 * The screen computes nothing: it arranges this view and foots it. So the
 * thing worth proving in a database is the property the screen then claims —
 * that the debit column and the credit column sum to the same figure, over
 * real postings, whatever those postings were.
 *
 * That is not a tautology about the view. It holds because every journal
 * entry balances, which a deferred constraint trigger enforces over the whole
 * entry at commit — so these tests post real entries through `post_journal`
 * and then check the statement, rather than asserting arithmetic the view
 * itself performs.
 *
 * ## And the shape the loader depends on
 *
 * One row per account, ordered by code, with the six columns
 * `lib/data/finance.ts` selects. A migration that renamed one would break the
 * page at request time rather than at build time, because PostgREST answers a
 * missing column with an error rather than a type failure.
 */
const describeDb = hasDatabase ? describe : describe.skip;

if (!hasDatabase) {
  describe('trial balance suite', () => {
    it.skip(`skipped — ${skipReason}`, () => undefined);
  });
}

afterAll(async () => {
  await closePool();
});

beforeEach(async () => {
  // Every figure below is asserted absolutely, so a journal left over from
  // another test would shift it.
  await deleteTestLoans();
  await deleteTestUsers();
});

async function accountIdByCode(code: string): Promise<string> {
  const row = await queryOne<{ id: string }>(
    `select id from public.ledger_accounts where code = $1`,
    [code],
  );
  return row.id;
}

async function cashAccountId(): Promise<string> {
  const row = await queryOne<{ id: string }>(
    `select id from public.ledger_accounts where cash_kind = 'cash_at_hand' limit 1`,
  );
  return row.id;
}

/** Post one balanced entry: debit one account, credit another. */
async function post(
  debitAccount: string,
  creditAccount: string,
  amount: number,
  memo: string,
): Promise<void> {
  const branch = await queryOne<{ id: string }>(
    `select id from public.branches order by branch_code limit 1`,
  );

  await query(
    `select public.post_journal(
       $1, current_date, $2, 'opening_balance', null, null, null,
       jsonb_build_array(
         jsonb_build_object('account_id', $3::uuid, 'debit', $5::bigint, 'credit', 0),
         jsonb_build_object('account_id', $4::uuid, 'debit', 0, 'credit', $5::bigint)
       ))`,
    [branch.id, memo, debitAccount, creditAccount, amount],
  );
}

interface TrialRow {
  code: string;
  name: string;
  account_type: string;
  normal_side: string;
  total_debit: string;
  total_credit: string;
}

async function trialBalance(): Promise<readonly TrialRow[]> {
  return query<TrialRow>(
    `select code, name, account_type, normal_side,
            total_debit::text as total_debit, total_credit::text as total_credit
       from public.trial_balance`,
  );
}

describeDb('the trial balance view', () => {
  it('returns the six columns the page selects, ordered by account code', async () => {
    const rows = await trialBalance();

    expect(rows.length).toBeGreaterThan(0);

    for (const row of rows) {
      expect(typeof row.code).toBe('string');
      expect(row.code).not.toBe('');
      expect(typeof row.name).toBe('string');
      expect(['asset', 'liability', 'equity', 'income', 'expense']).toContain(
        row.account_type,
      );
      expect(['debit', 'credit']).toContain(row.normal_side);
      expect(Number.isInteger(Number(row.total_debit))).toBe(true);
      expect(Number.isInteger(Number(row.total_credit))).toBe(true);
    }

    const codes = rows.map((row) => row.code);
    expect(codes).toEqual([...codes].sort());
  });

  it('lists one row per account in the chart, including unused ones', async () => {
    // A left join, not an inner one. A trial balance's row count is the
    // chart's size, and an account that saw no postings this period is still
    // a line on the statement.
    const chart = await queryOne<{ n: string }>(
      `select pg_catalog.count(*)::text as n from public.ledger_accounts`,
    );
    const rows = await trialBalance();

    expect(rows).toHaveLength(Number(chart.n));
  });

  it('foots to the same figure on both sides over real postings', async () => {
    const cash = await cashAccountId();
    const equity = await accountIdByCode('3000');

    await post(cash, equity, 2_000_000, 'Owner funds the till');
    await post(equity, cash, 750_000, 'Owner draws some back');

    const rows = await trialBalance();

    const debits = rows.reduce((sum, row) => sum + Number(row.total_debit), 0);
    const credits = rows.reduce((sum, row) => sum + Number(row.total_credit), 0);

    // Exactly. These are whole shillings in `bigint`, so there is no
    // tolerance to apply.
    expect(debits).toBe(credits);
    expect(debits).toBe(2_750_000);
  });

  it('keeps movement on both sides of one account distinct from its balance', async () => {
    // The distinction the screen's two pairs of columns exist for: this
    // account moved 2,750,000 and holds 1,250,000.
    const cash = await cashAccountId();
    const equity = await accountIdByCode('3000');

    await post(cash, equity, 2_000_000, 'In');
    await post(equity, cash, 750_000, 'Out');

    const row = await queryOne<{ d: string; c: string }>(
      `select tb.total_debit::text as d, tb.total_credit::text as c
         from public.trial_balance tb
         join public.ledger_accounts a on a.code = tb.code
        where a.id = $1`,
      [cash],
    );

    expect(Number(row.d)).toBe(2_000_000);
    expect(Number(row.c)).toBe(750_000);
    expect(Number(row.d) - Number(row.c)).toBe(1_250_000);
  });

  it('still foots after a payment posts through the loan machinery', async () => {
    // Not a hand-written entry this time. Whatever the application posts, the
    // statement foots — which is the claim the screen makes.
    const before = await trialBalance();
    const beforeDebits = before.reduce((sum, row) => sum + Number(row.total_debit), 0);

    const cash = await cashAccountId();
    const income = await accountIdByCode('4000');
    await post(cash, income, 125_000, 'Interest collected');

    const after = await trialBalance();
    const debits = after.reduce((sum, row) => sum + Number(row.total_debit), 0);
    const credits = after.reduce((sum, row) => sum + Number(row.total_credit), 0);

    expect(debits).toBe(credits);
    expect(debits).toBe(beforeDebits + 125_000);
  });

  it('gives the application nothing but SELECT', async () => {
    // A statement that could be written to would not be a statement.
    //
    // `authenticated` is the role every request runs as — the one the
    // anon/publishable key becomes after sign-in — so this is the privilege
    // set that matters. The owner and `service_role` keep the full default
    // set that PostgreSQL gives a table's owner, which is not revokable in
    // any meaningful sense and is why the assertion names the role rather
    // than scanning every grant on the view.
    const grants = await query<{ privilege_type: string }>(
      `select privilege_type
         from information_schema.role_table_grants
        where table_schema = 'public'
          and table_name = 'trial_balance'
          and grantee = 'authenticated'
        order by privilege_type`,
    );

    expect(grants.map((grant) => grant.privilege_type)).toEqual(['SELECT']);
  });

  it('refuses a write even from the owner, because of what it is', async () => {
    // The structural half of the guarantee, and the stronger one: a view over
    // a GROUP BY is not automatically updatable, so PostgreSQL rejects the
    // statement regardless of privilege. Adding an INSTEAD OF trigger is what
    // it would take to make this page writable, and this test is what would
    // notice somebody doing it.
    await expect(
      query(
        `insert into public.trial_balance
           (code, name, account_type, normal_side, total_debit, total_credit)
         values ('ZZZZ', 'Nowhere', 'asset', 'debit', 1, 1)`,
      ),
    ).rejects.toThrow(/cannot insert into view/i);
  });

  it('runs as the caller, so Row Level Security decides what it counts', async () => {
    // `security_invoker = true` is what keeps a reader's branch visibility
    // and capabilities intact without the page containing a single branch or
    // role condition. Without it the view would run as its owner and show
    // everybody everything.
    const row = await queryOne<{ options: string | null }>(
      `select pg_catalog.array_to_string(c.reloptions, ',') as options
         from pg_catalog.pg_class c
         join pg_catalog.pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relname = 'trial_balance'`,
    );

    expect(row.options ?? '').toContain('security_invoker=true');
  });
});
