/**
 * The Agency redesign — an agent banks collected physical cash.
 *
 * ## The claim this file has to make good on
 *
 * Client Rule 5: a cash banking is a movement from Cash at Hand to a bank
 * account, and it "must not be counted as a customer deposit, new revenue or
 * electronic float top-up". Three of these tests are therefore negative: after
 * a banking posts, there is no `agency_transaction`, no income line and no
 * movement on any `1320` float account. A rule that is only enforced by the
 * absence of a form is not enforced; these assert the absence in the book.
 *
 * ## And the exact lines
 *
 * A banking without a charge is two lines. A banking with one is three, and
 * the shape of those three is the whole accounting question: the credit to the
 * till is the **full** amount, because that is what physically left it, while
 * the debit to the bank is the amount net of the charge and the charge goes to
 * 5080 as an expense. Netting the charge off the credit instead would balance
 * just as well and would quietly claim the cashier carried less money than
 * they did.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PoolClient } from 'pg';

import {
  asUserCommitted,
  asUserScript,
  createTestUser,
  type TestUser,
} from '../helpers/auth-fixtures';
import { closePool, getClient, hasDatabase, query, queryOne, skipReason } from '../helpers/db';

const describeDb = hasDatabase ? describe : describe.skip;
if (!hasDatabase) {
  describe('agency cash banking', () => {
    it.skip(`skipped - ${skipReason}`, () => undefined);
  });
}

interface Line {
  readonly code: string;
  readonly debit: number;
  readonly credit: number;
}

describeDb('Agency redesign — cash banking', () => {
  let owner: TestUser;
  let mgr: TestUser;
  let mgr2: TestUser;
  let sec: TestUser;
  let branch: string;
  let cashCode: string;
  let bankCode: string;
  let bankId: string;

  let seq = 0;
  const ref = (): string => `DEP-${String(++seq).padStart(4, '0')}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;

  async function fund(code: string, amount: number): Promise<void> {
    await query(
      `select public.post_journal(
          (select branch_id from public.ledger_accounts where code = $1),
          current_date, $3, 'opening_balance', null, null, null,
          jsonb_build_array(
            jsonb_build_object('account_id',
              (select id from public.ledger_accounts where code = $1),
              'debit', $2::bigint, 'credit', 0),
            jsonb_build_object('account_id', public.ledger_account_by_code('3000'),
              'debit', 0, 'credit', $2::bigint)),
          now(),
          (select p.id from public.profiles p
             join public.user_roles r on r.profile_id = p.id
            where r.role_key = 'owner_admin' order by p.created_at limit 1),
          'cash banking fixture')`,
      [code, amount, `fixture ${code} ${Math.random().toString(36).slice(2, 8)}`],
    );
  }

  async function balance(code: string): Promise<number> {
    const r = await queryOne<{ v: string }>(
      `select coalesce(b.balance, 0)::text as v
         from public.ledger_accounts a
         left join public.ledger_account_balances b on b.account_id = a.id
        where a.code = $1`,
      [code],
    );
    return Number(r.v);
  }

  async function linesOf(entryId: string): Promise<Line[]> {
    const rows = await query<{ code: string; debit: string; credit: string }>(
      `select a.code, l.debit::text, l.credit::text
         from public.journal_lines l
         join public.ledger_accounts a on a.id = l.account_id
        where l.entry_id = $1 order by l.line_number`,
      [entryId],
    );
    return rows.map((r) => ({ code: r.code, debit: Number(r.debit), credit: Number(r.credit) }));
  }

  async function entryCount(): Promise<number> {
    const r = await queryOne<{ n: string }>(
      `select count(*)::text as n from public.journal_entries`,
    );
    return Number(r.n);
  }

  async function row(id: string) {
    return queryOne<{
      status: string;
      revision: number;
      journal_entry_id: string | null;
      reversal_entry_id: string | null;
      rejected_reason: string | null;
      banked_by: string;
    }>(
      `select status, revision, journal_entry_id::text as journal_entry_id,
              reversal_entry_id::text as reversal_entry_id, rejected_reason,
              banked_by::text as banked_by
         from public.agency_cash_bankings where id = $1`,
      [id],
    );
  }

  /** Record as `as`, defaulting to the Owner. Returns the new row's id. */
  async function record(
    args: {
      amount: number;
      reference?: string;
      charge?: number;
      bankedBy?: string;
      date?: string;
      bankAccountId?: string;
    },
    as: TestUser = owner,
  ): Promise<string> {
    const result = await asUserCommitted(as, [
      {
        sql: `select public.record_agency_cash_banking($1, $2, $3, $4, $5, $6, 'slip filed', null, $7) as id`,
        params: [
          args.bankAccountId ?? bankId,
          args.amount,
          args.reference ?? ref(),
          args.bankedBy ?? null,
          args.charge ?? 0,
          args.date ?? null,
          branch,
        ],
      },
    ]);
    if (!result.ok) throw new Error(`recording refused: ${result.message}`);
    const first = result.rows[0];
    if (first === undefined) throw new Error('recording returned no row');
    return String(first.id);
  }

  beforeAll(async () => {
    owner = await createTestUser('owner_admin');
    mgr = await createTestUser('manager');
    mgr2 = await createTestUser('manager');
    sec = await createTestUser('secretary_treasurer');

    branch = (
      await queryOne<{ id: string }>(
        `select id from public.branches where status = 'active' order by branch_code limit 1`,
      )
    ).id;

    cashCode = (
      await queryOne<{ code: string }>(
        `select code from public.ledger_accounts
          where branch_id = $1 and cash_kind = 'cash_at_hand'`,
        [branch],
      )
    ).code;

    const bank = await queryOne<{ id: string; code: string }>(
      `select id::text as id, code from public.ledger_accounts
        where branch_id = $1 and cash_kind = 'bank' order by code limit 1`,
      [branch],
    );
    bankId = bank.id;
    bankCode = bank.code;

    // Plenty of physical cash to bank, and enough already at the bank that a
    // reversal has somewhere to come back out of.
    await fund(cashCode, 500_000_000);
    await fund(bankCode, 100_000_000);
  });

  afterAll(async () => {
    await closePool();
  });

  // -------------------------------------------------------------------------
  // Recording posts nothing
  // -------------------------------------------------------------------------

  it('records a pending banking and moves no money at all', async () => {
    const before = { cash: await balance(cashCode), bank: await balance(bankCode), n: await entryCount() };

    const id = await record({ amount: 2_000_000 });
    const r = await row(id);

    expect(r.status).toBe('pending');
    expect(r.journal_entry_id).toBeNull();
    expect(await balance(cashCode)).toBe(before.cash);
    expect(await balance(bankCode)).toBe(before.bank);
    expect(await entryCount()).toBe(before.n);
  });

  it('defaults the banker to the person recording, and accepts a named one', async () => {
    const mine = await row(await record({ amount: 10_000 }));
    expect(mine.banked_by).toBe(owner.profileId);

    const theirs = await row(await record({ amount: 10_000, bankedBy: sec.profileId }));
    expect(theirs.banked_by).toBe(sec.profileId);
  });

  // -------------------------------------------------------------------------
  // The posting, and its exact lines
  // -------------------------------------------------------------------------

  it('posts two lines with no charge: Dr bank, Cr cash, for the same amount', async () => {
    const id = await record({ amount: 3_000_000 });
    const before = { cash: await balance(cashCode), bank: await balance(bankCode) };

    const posted = await asUserCommitted(mgr, [
      { sql: `select public.verify_agency_cash_banking($1) as entry`, params: [id] },
    ]);
    expect(posted.ok).toBe(true);

    const r = await row(id);
    expect(r.status).toBe('posted');
    expect(r.journal_entry_id).not.toBeNull();

    const lines = await linesOf(r.journal_entry_id as string);
    expect(lines).toHaveLength(2);
    expect(lines).toEqual(
      expect.arrayContaining([
        { code: bankCode, debit: 3_000_000, credit: 0 },
        { code: cashCode, debit: 0, credit: 3_000_000 },
      ]),
    );

    expect(await balance(cashCode)).toBe(before.cash - 3_000_000);
    expect(await balance(bankCode)).toBe(before.bank + 3_000_000);
  });

  it('posts three lines with a charge: the till is credited the FULL amount and 5080 takes the fee', async () => {
    const id = await record({ amount: 1_000_000, charge: 5_000 });
    const before = {
      cash: await balance(cashCode),
      bank: await balance(bankCode),
      charges: await balance('5080'),
    };

    await asUserCommitted(mgr, [
      { sql: `select public.verify_agency_cash_banking($1) as entry`, params: [id] },
    ]);

    const r = await row(id);
    const lines = await linesOf(r.journal_entry_id as string);

    expect(lines).toHaveLength(3);
    expect(lines).toEqual(
      expect.arrayContaining([
        { code: bankCode, debit: 995_000, credit: 0 },
        { code: cashCode, debit: 0, credit: 1_000_000 },
        { code: '5080', debit: 5_000, credit: 0 },
      ]),
    );

    // The whole amount left the till; only the net reached the bank.
    expect(await balance(cashCode)).toBe(before.cash - 1_000_000);
    expect(await balance(bankCode)).toBe(before.bank + 995_000);
    expect(await balance('5080')).toBe(before.charges + 5_000);

    const debits = lines.reduce((s, l) => s + l.debit, 0);
    const credits = lines.reduce((s, l) => s + l.credit, 0);
    expect(debits).toBe(credits);
  });

  // -------------------------------------------------------------------------
  // Rule 5's three negatives
  // -------------------------------------------------------------------------

  it('is not a customer transaction: no agency_transaction row exists for it', async () => {
    const before = Number(
      (await queryOne<{ n: string }>(`select count(*)::text as n from public.agency_transactions`)).n,
    );

    const id = await record({ amount: 400_000 });
    await asUserCommitted(mgr, [
      { sql: `select public.verify_agency_cash_banking($1)`, params: [id] },
    ]);

    const after = Number(
      (await queryOne<{ n: string }>(`select count(*)::text as n from public.agency_transactions`)).n,
    );
    expect(after).toBe(before);
  });

  it('is not revenue: the entry touches no income account', async () => {
    const id = await record({ amount: 700_000, charge: 2_000 });
    await asUserCommitted(mgr, [
      { sql: `select public.verify_agency_cash_banking($1)`, params: [id] },
    ]);
    const r = await row(id);

    const income = await query<{ code: string }>(
      `select a.code from public.journal_lines l
         join public.ledger_accounts a on a.id = l.account_id
        where l.entry_id = $1 and a.account_type = 'income'`,
      [r.journal_entry_id],
    );
    expect(income).toHaveLength(0);
  });

  it('is not a float top-up: no 1320-series account moves', async () => {
    const id = await record({ amount: 650_000 });
    await asUserCommitted(mgr, [
      { sql: `select public.verify_agency_cash_banking($1)`, params: [id] },
    ]);
    const r = await row(id);

    const float = await query<{ code: string }>(
      `select a.code from public.journal_lines l
         join public.ledger_accounts a on a.id = l.account_id
        where l.entry_id = $1 and a.cash_kind = 'agency_float'`,
      [r.journal_entry_id],
    );
    expect(float).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Maker-checker
  // -------------------------------------------------------------------------

  it('refuses the person who recorded it', async () => {
    const id = await record({ amount: 120_000 });
    const attempt = await asUserScript(owner, [
      { sql: `select public.verify_agency_cash_banking($1)`, params: [id] },
    ]);
    expect(attempt.ok).toBe(false);
    expect(attempt.message).toContain('cannot be posted by the person who recorded it');
    expect((await row(id)).status).toBe('pending');
  });

  it('refuses a Secretary/Treasurer, who may record but not post', async () => {
    const id = await record({ amount: 130_000 });
    const attempt = await asUserScript(sec, [
      { sql: `select public.verify_agency_cash_banking($1)`, params: [id] },
    ]);
    expect(attempt.ok).toBe(false);
    expect((await row(id)).status).toBe('pending');
  });

  it('lets a Secretary/Treasurer record one', async () => {
    const id = await record({ amount: 55_000 }, sec);
    expect((await row(id)).status).toBe('pending');
  });

  it('keeps a rejected banking, with its reason, and posts nothing', async () => {
    const before = await entryCount();
    const id = await record({ amount: 90_000 });

    const rejected = await asUserCommitted(mgr, [
      {
        sql: `select public.reject_agency_cash_banking($1, 'the slip does not match the count')`,
        params: [id],
      },
    ]);
    expect(rejected.ok).toBe(true);

    const r = await row(id);
    expect(r.status).toBe('rejected');
    expect(r.rejected_reason).toBe('the slip does not match the count');
    expect(r.journal_entry_id).toBeNull();
    expect(await entryCount()).toBe(before);
  });

  it('refuses to reject without a reason', async () => {
    const id = await record({ amount: 91_000 });
    const attempt = await asUserScript(mgr, [
      { sql: `select public.reject_agency_cash_banking($1, '   ')`, params: [id] },
    ]);
    expect(attempt.ok).toBe(false);
    expect(attempt.message).toContain('Say why');
  });

  // -------------------------------------------------------------------------
  // Idempotency
  // -------------------------------------------------------------------------

  it('refuses the same deposit reference on the same bank account twice', async () => {
    const reference = ref();
    await record({ amount: 200_000, reference });

    const attempt = await asUserScript(owner, [
      {
        sql: `select public.record_agency_cash_banking($1, $2, $3, null, 0, null, null, null, $4)`,
        params: [bankId, 200_000, reference, branch],
      },
    ]);
    expect(attempt.ok).toBe(false);
    expect(attempt.message).toContain('already been banked');
  });

  it('verifying twice returns the same entry and posts once', async () => {
    const id = await record({ amount: 300_000 });

    const first = await asUserCommitted(mgr, [
      { sql: `select public.verify_agency_cash_banking($1) as entry`, params: [id] },
    ]);
    const countAfterFirst = await entryCount();

    const second = await asUserCommitted(mgr, [
      { sql: `select public.verify_agency_cash_banking($1) as entry`, params: [id] },
    ]);

    expect(second.rows[0]?.entry).toBe(first.rows[0]?.entry);
    expect(await entryCount()).toBe(countAfterFirst);
  });

  it('refuses a stale revision', async () => {
    const id = await record({ amount: 410_000 });
    const before = (await row(id)).revision;

    await query(`update public.agency_cash_bankings set amount = 420000 where id = $1`, [id]);

    const bumped = (await row(id)).revision;
    expect(bumped).toBe(before + 1);

    const attempt = await asUserScript(mgr, [
      { sql: `select public.verify_agency_cash_banking($1, $2)`, params: [id, before] },
    ]);
    expect(attempt.ok).toBe(false);
    expect(attempt.message).toContain('has changed since you read it');
  });

  // -------------------------------------------------------------------------
  // Refusals on the figures and the accounts
  // -------------------------------------------------------------------------

  it('refuses a non-positive amount, a charge at or above it, and a future date', async () => {
    for (const [params, fragment] of [
      [[bankId, 0, ref(), 0, null], 'positive number of shillings'],
      [[bankId, 100_000, ref(), 100_000, null], 'less than the amount banked'],
      [[bankId, 100_000, ref(), -1, null], 'zero or more'],
      [[bankId, 100_000, ref(), 0, '2999-01-01'], 'dated in the future'],
    ] as const) {
      const attempt = await asUserScript(owner, [
        {
          sql: `select public.record_agency_cash_banking($1, $2, $3, null, $4, $5, null, null, $6)`,
          params: [...params, branch],
        },
      ]);
      expect(attempt.ok, fragment).toBe(false);
      expect(attempt.message).toContain(fragment);
    }
  });

  it('refuses a destination that is not a bank account', async () => {
    const notBank = await queryOne<{ id: string }>(
      `select id::text as id from public.ledger_accounts
        where branch_id = $1 and cash_kind = 'cash_at_hand'`,
      [branch],
    );

    const attempt = await asUserScript(owner, [
      {
        sql: `select public.record_agency_cash_banking($1, 50000::bigint, $2, null, 0, null, null, null, $3)`,
        params: [notBank.id, ref(), branch],
      },
    ]);
    expect(attempt.ok).toBe(false);
    expect(attempt.message).toContain('must go into a bank account');
  });

  it('refuses a float account as the destination, naming the float top-up instead', async () => {
    const providerId = (
      await queryOne<{ id: string }>(
        `insert into public.agency_service_providers
           (code, name, category, float_model, payable_account_id, income_account_id,
            commission_model, commission_source, commission_rate_bps, commission_fixed,
            is_provisional, is_active)
         values ('CBTESTBANK', 'Cash banking fixture bank', 'agency_banking', 'provider_float',
                 null, (select id from public.ledger_accounts where code = '4520'),
                 'deferred', 'reported', null, null, false, true)
         returning id::text as id`,
      )
    ).id;

    // Two statements rather than one: `ensure_agency_float_account` is a
    // volatile DEFINER function, and calling it from a WHERE clause left the
    // join with nothing to match.
    const till = await queryOne<{ id: string }>(
      `select public.ensure_agency_float_account($1, $2, 'main')::text as id`,
      [providerId, branch],
    );
    const tillLedger = await queryOne<{ id: string }>(
      `select l.id::text as id
         from public.agency_provider_float_accounts f
         join public.ledger_accounts l on l.id = f.ledger_account_id
        where f.id = $1`,
      [till.id],
    );

    const attempt = await asUserScript(owner, [
      {
        sql: `select public.record_agency_cash_banking($1, 50000::bigint, $2, null, 0, null, null, null, $3)`,
        params: [tillLedger.id, ref(), branch],
      },
    ]);
    expect(attempt.ok).toBe(false);
    expect(attempt.message).toContain('float top-up');
  });

  it('refuses more cash than the till holds', async () => {
    const held = await balance(cashCode);
    const id = await record({ amount: held + 1_000_000 });

    const attempt = await asUserScript(mgr, [
      { sql: `select public.verify_agency_cash_banking($1)`, params: [id] },
    ]);
    expect(attempt.ok).toBe(false);
    expect((await row(id)).status).toBe('pending');
  });

  // -------------------------------------------------------------------------
  // Reversal
  // -------------------------------------------------------------------------

  it('reverses by contra entries, leaving the original journal untouched', async () => {
    const id = await record({ amount: 800_000, charge: 3_000 });
    await asUserCommitted(mgr, [
      { sql: `select public.verify_agency_cash_banking($1)`, params: [id] },
    ]);
    const posted = await row(id);
    const originalLines = await linesOf(posted.journal_entry_id as string);

    const before = {
      cash: await balance(cashCode),
      bank: await balance(bankCode),
      charges: await balance('5080'),
    };

    const reversed = await asUserCommitted(mgr2, [
      {
        sql: `select public.reverse_agency_cash_banking($1, 'banked to the wrong account') as entry`,
        params: [id],
      },
    ]);
    expect(reversed.ok).toBe(true);

    const r = await row(id);
    expect(r.status).toBe('reversed');
    expect(r.reversal_entry_id).not.toBeNull();
    // The original entry is byte-for-byte what it was.
    expect(await linesOf(posted.journal_entry_id as string)).toEqual(originalLines);

    const contra = await linesOf(r.reversal_entry_id as string);
    expect(contra).toEqual(
      expect.arrayContaining([
        { code: cashCode, debit: 800_000, credit: 0 },
        { code: bankCode, debit: 0, credit: 797_000 },
        { code: '5080', debit: 0, credit: 3_000 },
      ]),
    );

    // Every balance is back where it started.
    expect(await balance(cashCode)).toBe(before.cash + 800_000);
    expect(await balance(bankCode)).toBe(before.bank - 797_000);
    expect(await balance('5080')).toBe(before.charges - 3_000);
  });

  it('reversing twice returns the same contra entry', async () => {
    const id = await record({ amount: 150_000 });
    await asUserCommitted(mgr, [
      { sql: `select public.verify_agency_cash_banking($1)`, params: [id] },
    ]);

    const first = await asUserCommitted(mgr2, [
      { sql: `select public.reverse_agency_cash_banking($1, 'duplicate slip') as entry`, params: [id] },
    ]);
    const n = await entryCount();
    const second = await asUserCommitted(mgr2, [
      { sql: `select public.reverse_agency_cash_banking($1, 'duplicate slip') as entry`, params: [id] },
    ]);

    expect(second.rows[0]?.entry).toBe(first.rows[0]?.entry);
    expect(await entryCount()).toBe(n);
  });

  it('refuses to reverse a pending banking, and refuses a reversal with no reason', async () => {
    const pending = await record({ amount: 160_000 });
    const onPending = await asUserScript(mgr2, [
      { sql: `select public.reverse_agency_cash_banking($1, 'nope')`, params: [pending] },
    ]);
    expect(onPending.ok).toBe(false);
    expect(onPending.message).toContain('Only a posted cash banking can be reversed');

    const id = await record({ amount: 170_000 });
    await asUserCommitted(mgr, [
      { sql: `select public.verify_agency_cash_banking($1)`, params: [id] },
    ]);
    const noReason = await asUserScript(mgr2, [
      { sql: `select public.reverse_agency_cash_banking($1, '')`, params: [id] },
    ]);
    expect(noReason.ok).toBe(false);
    expect(noReason.message).toContain('Say why');
  });

  it('refuses a cross-day reversal without the wider capability', async () => {
    const id = await record({ amount: 180_000, date: '2026-01-05' });
    await asUserCommitted(mgr, [
      { sql: `select public.verify_agency_cash_banking($1)`, params: [id] },
    ]);

    // A Manager holds agency:reverse but not agency:reverse_cross_day.
    const attempt = await asUserScript(mgr2, [
      { sql: `select public.reverse_agency_cash_banking($1, 'wrong day')`, params: [id] },
    ]);
    expect(attempt.ok).toBe(false);
    expect(attempt.message).toContain('wider permission');

    // The Owner holds it.
    const allowed = await asUserCommitted(owner, [
      { sql: `select public.reverse_agency_cash_banking($1, 'wrong day') as entry`, params: [id] },
    ]);
    expect(allowed.ok).toBe(true);
    expect((await row(id)).status).toBe('reversed');
  });

  it('refuses to edit a posted banking', async () => {
    const id = await record({ amount: 190_000 });
    await asUserCommitted(mgr, [
      { sql: `select public.verify_agency_cash_banking($1)`, params: [id] },
    ]);

    await expect(
      query(`update public.agency_cash_bankings set amount = 1 where id = $1`, [id]),
    ).rejects.toThrow(/can no longer be edited/);
  });

  it('never deletes a banking', async () => {
    const id = await record({ amount: 195_000 });
    await expect(
      query(`delete from public.agency_cash_bankings where id = $1`, [id]),
    ).rejects.toThrow();
  });

  // -------------------------------------------------------------------------
  // Concurrency: two verifiers, one row
  // -------------------------------------------------------------------------

  it('posts once when two verifiers race the same banking', async () => {
    const id = await record({ amount: 250_000 });
    const before = await entryCount();

    let a: PoolClient | undefined;
    let b: PoolClient | undefined;
    try {
      a = await getClient();
      b = await getClient();

      for (const [client, user] of [
        [a, mgr],
        [b, mgr2],
      ] as const) {
        await client.query('begin');
        await client.query(`select set_config('request.jwt.claim.sub', $1, true)`, [
          user.authUserId,
        ]);
      }

      // A takes the row and holds it.
      await a.query(`select public.verify_agency_cash_banking($1)`, [id]);

      // B blocks on `for update` until A commits, then finds it posted and
      // returns A's entry rather than writing a second one.
      const raced = b.query<{ entry: string }>(
        `select public.verify_agency_cash_banking($1) as entry`,
        [id],
      );

      await a.query('commit');
      const result = await raced;
      await b.query('commit');

      expect(await entryCount()).toBe(before + 1);
      const r = await row(id);
      expect(result.rows[0]?.entry).toBe(r.journal_entry_id);
    } finally {
      a?.release();
      b?.release();
    }
  });

  // -------------------------------------------------------------------------
  // The register, and what a reader may see
  // -------------------------------------------------------------------------

  it('shows the banking in the register with both accounts and both people', async () => {
    const id = await record({ amount: 260_000, bankedBy: sec.profileId });
    await asUserCommitted(mgr, [
      { sql: `select public.verify_agency_cash_banking($1)`, params: [id] },
    ]);

    const seen = await asUserScript(mgr, [
      {
        sql: `select status, amount::text as amount, charge::text as charge,
                     net_banked::text as net_banked, bank_account_code,
                     cash_account_code, banked_by_name, created_by_name,
                     verified_by_name
                from public.agency_cash_banking_register where id = $1`,
        params: [id],
      },
    ]);

    expect(seen.ok).toBe(true);
    const r = seen.rows[0];
    expect(r?.status).toBe('posted');
    expect(r?.net_banked).toBe('260000');
    expect(r?.bank_account_code).toBe(bankCode);
    expect(r?.cash_account_code).toBe(cashCode);
    expect(r?.banked_by_name).toBe(sec.fullName);
    expect(r?.created_by_name).toBe(owner.fullName);
    expect(r?.verified_by_name).toBe(mgr.fullName);
  });

  it('shows a reader with no agency capability nothing', async () => {
    const client = await createTestUser('client');
    const id = await record({ amount: 270_000 });

    const seen = await asUserScript(client, [
      {
        sql: `select count(*)::text as n from public.agency_cash_bankings where id = $1`,
        params: [id],
      },
    ]);
    expect(seen.ok).toBe(true);
    expect(seen.rows[0]?.n).toBe('0');
  });

  it('refuses a client the recording function outright', async () => {
    const client = await createTestUser('client');
    const attempt = await asUserScript(client, [
      {
        sql: `select public.record_agency_cash_banking($1, 10000::bigint, $2, null, 0, null, null, null, $3)`,
        params: [bankId, ref(), branch],
      },
    ]);
    expect(attempt.ok).toBe(false);
  });
});
