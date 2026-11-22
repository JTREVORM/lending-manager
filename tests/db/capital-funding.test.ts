/**
 * Capital introduced into the business — operational task 3.
 *
 * ## What was missing
 *
 * POLYTOS could account for every shilling that moved through it and not for
 * the shillings it began with. `3000 Owner Capital` has existed since Phase
 * 10 and exactly one thing ever credited it: the Phase 10 backfill, which
 * *derived* an opening balance by finding the deepest the cash position ever
 * reached. Its own memo says so. There was no document, no function and no
 * screen — so an Owner who put 50,000,000 into the business had nowhere to
 * say so, and a lender who advanced 20,000,000 was indistinguishable from an
 * owner who contributed it.
 *
 * ## What this file measures
 *
 * Three things, with the ledger as the arbiter throughout:
 *
 *   1. **Equity is not borrowing.** An equity contribution credits the 3000
 *      series and raises net worth; a borrowing credits a 2300-series
 *      liability and does not. Neither can touch the other's accounts.
 *   2. **Recording posts nothing.** The journal is written by a second
 *      officer's verification, and the officer who recorded it may not be
 *      the one who verifies, rejects or — having verified — reverses.
 *   3. **The entries balance, and keep balancing.** Every posting is checked
 *      debit against credit, and the whole book's trial balance is checked
 *      after the destructive cases.
 *
 * ## The three dates, and why the test cares
 *
 * `funded_on` is what the evidence says and may be years old — that is how an
 * opening balance is recorded. The journal is dated the business date,
 * always. A test that let those two be the same date would not notice if the
 * posting function started trusting the evidence date, which is the one thing
 * that would let somebody post into a closed period.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  asUser,
  asUserCommitted,
  createTestUser,
  type TestUser,
} from '../helpers/auth-fixtures';
import { closePool, hasDatabase, query, queryOne, skipReason } from '../helpers/db';

const describeDb = hasDatabase ? describe : describe.skip;
if (!hasDatabase) {
  describe('capital funding', () => {
    it.skip(`skipped - ${skipReason}`, () => undefined);
  });
}

interface Line {
  readonly code: string;
  readonly debit: string;
  readonly credit: string;
}

describeDb('capital introduced into the business', () => {
  /** Records capital. Never verifies it. */
  let recorder: TestUser;
  /** Verifies it. Never reverses what they verified. */
  let verifier: TestUser;
  /** A Manager: may record and read, may not verify or reverse. */
  let manager: TestUser;
  /** A front-office account: holds none of the four capabilities. */
  let clerk: TestUser;

  let branch: string;
  let bankAccountId: string;
  let tillAccountId: string;
  let equityAccountId: string;
  let borrowingAccountId: string;
  let savingsAccountId: string;

  let seq = 0;
  const ref = (stem: string): string =>
    `${stem}-${String((process.pid % 100) * 1000 + ++seq).padStart(6, '0')}`;

  /** The ledger lines of one entry, in order. */
  async function linesOf(entryId: string): Promise<readonly Line[]> {
    return query<Line>(
      `select a.code, jl.debit::text as debit, jl.credit::text as credit
         from public.journal_lines jl
         join public.ledger_accounts a on a.id = jl.account_id
        where jl.entry_id = $1 order by jl.line_number`,
      [entryId],
    );
  }

  async function balanceOf(accountId: string): Promise<number> {
    const row = await queryOne<{ balance: string }>(
      `select coalesce(balance, 0)::text as balance
         from public.ledger_account_balances where account_id = $1`,
      [accountId],
    );
    return Number(row.balance);
  }

  /** Record a funding as the recorder, returning its id. */
  async function record(opts: {
    readonly kind: 'equity' | 'borrowing';
    readonly amount: number;
    readonly destination?: string;
    readonly capital?: string;
    readonly fundedOn?: string;
    readonly rateBps?: number | null;
    readonly dueOn?: string | null;
    readonly actor?: TestUser;
  }): Promise<string> {
    const result = await asUserCommitted(opts.actor ?? recorder, [
      {
        sql: `select public.record_capital_funding(
                $1, $2::bigint, $3, $4, $5, $6::date, 'bank_transfer', $7,
                gen_random_uuid(), $8, $9::date)::text as id`,
        params: [
          opts.kind,
          opts.amount,
          opts.destination ?? bankAccountId,
          opts.capital ?? (opts.kind === 'equity' ? equityAccountId : borrowingAccountId),
          'Jane Trevor',
          opts.fundedOn ?? '2026-01-04',
          ref('EFT'),
          opts.rateBps ?? null,
          opts.dueOn ?? null,
        ],
      },
    ]);
    expect(result.ok, result.message).toBe(true);
    return String(result.rows[0]?.id);
  }

  beforeAll(async () => {
    recorder = await createTestUser('owner_admin');
    verifier = await createTestUser('owner_admin');
    manager = await createTestUser('manager');
    clerk = await createTestUser('secretary_treasurer');

    const b = await queryOne<{ id: string }>(
      `select id::text as id from public.branches order by branch_code limit 1`,
    );
    branch = b.id;

    await query(`update public.profiles set branch_id = $1 where id = any($2::uuid[])`, [
      branch,
      [recorder.profileId, verifier.profileId, manager.profileId, clerk.profileId],
    ]);

    const account = async (code: string): Promise<string> => {
      const row = await queryOne<{ id: string }>(
        `select id::text as id from public.ledger_accounts where code = $1`,
        [code],
      );
      return row.id;
    };

    const bank = await queryOne<{ id: string }>(
      `select id::text as id from public.ledger_accounts
        where cash_kind = 'bank' and branch_id = $1 limit 1`,
      [branch],
    );
    bankAccountId = bank.id;

    const till = await queryOne<{ id: string }>(
      `select id::text as id from public.ledger_accounts
        where cash_kind = 'cash_at_hand' and branch_id = $1 limit 1`,
      [branch],
    );
    tillAccountId = till.id;

    equityAccountId = await account('3000');
    borrowingAccountId = await account('2320');
    savingsAccountId = await account('2100');
  });

  afterAll(async () => {
    // Deliberately no `deleteTestUsers()`. This suite posts journals, and a
    // journal entry names the profile that made it with ON DELETE RESTRICT —
    // deleting the officers would mean deleting the entries they posted,
    // which is the one thing a financial system must not offer. Every agency
    // suite that posts money ends the same way: the project has a database of
    // its own and is thrown away with it.
    await closePool();
  });

  // =========================================================================
  // The chart has somewhere to put a borrowing
  // =========================================================================

  describe('the chart of accounts', () => {
    it('carries a 2300 series for money the business itself borrowed', async () => {
      const rows = await query<{
        code: string;
        account_type: string;
        is_postable: boolean;
      }>(
        `select code, account_type, is_postable from public.ledger_accounts
          where code like '23%' order by code`,
      );
      expect(rows.map((r) => r.code)).toEqual(['2300', '2310', '2320', '2330']);
      for (const row of rows) expect(row.account_type).toBe('liability');
      // 2300 is a heading; its three children are what entries land on.
      expect(rows.find((r) => r.code === '2300')?.is_postable).toBe(false);
      expect(rows.filter((r) => r.is_postable)).toHaveLength(3);
    });

    it('parents them under 2000 Liabilities, beside savings and agency payables', async () => {
      const row = await queryOne<{ parent: string }>(
        `select p.code as parent from public.ledger_accounts a
           join public.ledger_accounts p on p.id = a.parent_id
          where a.code = '2300'`,
      );
      expect(row.parent).toBe('2000');
    });
  });

  // =========================================================================
  // Recording
  // =========================================================================

  describe('recording', () => {
    it('is refused to a front-office account', async () => {
      const attempt = await asUser(
        clerk,
        `select public.record_capital_funding('equity', 1000000::bigint, $1, $2,
           'Someone', current_date, 'cash_deposit', 'X-1', gen_random_uuid())`,
        [bankAccountId, equityAccountId],
      );
      expect(attempt.ok).toBe(false);
      expect(attempt.code).toBe('42501');
    });

    it('posts nothing: the balance sheet does not move', async () => {
      const before = await balanceOf(bankAccountId);
      const id = await record({ kind: 'equity', amount: 50_000_000 });

      const row = await queryOne<{ status: string; journal: string | null }>(
        `select status, journal_entry_id::text as journal
           from public.capital_fundings where id = $1`,
        [id],
      );
      expect(row.status).toBe('submitted');
      expect(row.journal).toBeNull();
      expect(await balanceOf(bankAccountId)).toBe(before);
    });

    it('numbers the document from the counter, as CF', async () => {
      const id = await record({ kind: 'equity', amount: 1_000_000 });
      const row = await queryOne<{ funding_number: string }>(
        `select funding_number from public.capital_fundings where id = $1`,
        [id],
      );
      expect(row.funding_number).toMatch(/^CF\d{2}\d{5}$/);
    });

    it('refuses an equity contribution that carries repayment terms', async () => {
      const attempt = await asUser(
        recorder,
        `select public.record_capital_funding('equity', 1000000::bigint, $1, $2,
           'Someone', current_date, 'bank_transfer', 'X-2', gen_random_uuid(), 1200, '2027-01-01'::date)`,
        [bankAccountId, equityAccountId],
      );
      expect(attempt.ok).toBe(false);
      expect(attempt.message).toMatch(/not repayable and carries no interest/i);
    });

    it('refuses a borrowing credited to equity, and to member savings', async () => {
      for (const [account, label] of [
        [equityAccountId, 'equity'],
        [savingsAccountId, 'member savings'],
      ] as const) {
        const attempt = await asUser(
          recorder,
          `select public.record_capital_funding('borrowing', 1000000::bigint, $1, $2,
             'A Lender', current_date, 'bank_transfer', 'X-3', gen_random_uuid())`,
          [bankAccountId, account],
        );
        expect(attempt.ok, `a borrowing must not credit ${label}`).toBe(false);
        expect(attempt.message).toMatch(/2300-series borrowing/i);
      }
    });

    it('refuses an equity contribution credited to a liability', async () => {
      const attempt = await asUser(
        recorder,
        `select public.record_capital_funding('equity', 1000000::bigint, $1, $2,
           'Someone', current_date, 'bank_transfer', 'X-4', gen_random_uuid())`,
        [bankAccountId, borrowingAccountId],
      );
      expect(attempt.ok).toBe(false);
      expect(attempt.message).toMatch(/credits the 3000 series/i);
    });

    it('refuses money landing anywhere but a cash or bank account', async () => {
      // Cash in Transit, not a receivable: it is branch-held, so the
      // destination passes the branch check and the *kind* is what refuses
      // it. A receivable has no branch at all and would be turned away one
      // step earlier, which would prove the wrong thing.
      const transit = await queryOne<{ id: string }>(
        `select id::text as id from public.ledger_accounts
          where cash_kind = 'in_transit' and branch_id = $1 limit 1`,
        [branch],
      );
      const attempt = await asUser(
        recorder,
        `select public.record_capital_funding('equity', 1000000::bigint, $1, $2,
           'Someone', current_date, 'bank_transfer', 'X-5', gen_random_uuid())`,
        [transit.id, equityAccountId],
      );
      expect(attempt.ok).toBe(false);
      expect(attempt.message).toMatch(/must land in a cash or bank account/i);
    });

    it('refuses evidence dated in the future', async () => {
      const attempt = await asUser(
        recorder,
        `select public.record_capital_funding('equity', 1000000::bigint, $1, $2,
           'Someone', current_date + 1, 'bank_transfer', 'X-6', gen_random_uuid())`,
        [bankAccountId, equityAccountId],
      );
      expect(attempt.ok).toBe(false);
      expect(attempt.message).toMatch(/in the future/i);
    });

    it('requires somebody to have provided it, and a reference to the evidence', async () => {
      const noFunder = await asUser(
        recorder,
        `select public.record_capital_funding('equity', 1000000::bigint, $1, $2,
           '  ', current_date, 'bank_transfer', 'X-7', gen_random_uuid())`,
        [bankAccountId, equityAccountId],
      );
      expect(noFunder.ok).toBe(false);
      expect(noFunder.message).toMatch(/who provided this money/i);

      const noEvidence = await asUser(
        recorder,
        `select public.record_capital_funding('equity', 1000000::bigint, $1, $2,
           'Someone', current_date, 'bank_transfer', '  ', gen_random_uuid())`,
        [bankAccountId, equityAccountId],
      );
      expect(noEvidence.ok).toBe(false);
      expect(noEvidence.message).toMatch(/reference of the evidence/i);
    });

    it('is idempotent on the receipt key', async () => {
      const key = await queryOne<{ k: string }>(`select gen_random_uuid()::text as k`);
      const once = await asUserCommitted(recorder, [
        {
          sql: `select public.record_capital_funding('equity', 7000000::bigint, $1, $2,
                  'Twice', current_date, 'bank_transfer', $3, $4::uuid)::text as id`,
          params: [bankAccountId, equityAccountId, ref('IDEM'), key.k],
        },
      ]);
      const twice = await asUserCommitted(recorder, [
        {
          sql: `select public.record_capital_funding('equity', 7000000::bigint, $1, $2,
                  'Twice', current_date, 'bank_transfer', $3, $4::uuid)::text as id`,
          params: [bankAccountId, equityAccountId, ref('IDEM'), key.k],
        },
      ]);
      expect(twice.rows[0]?.id).toBe(once.rows[0]?.id);

      const count = await queryOne<{ count: string }>(
        `select count(*)::text as count from public.capital_fundings
          where idempotency_key = $1::uuid`,
        [key.k],
      );
      expect(count.count).toBe('1');
    });

    it('is write-once in what it claims: the figures cannot be edited', async () => {
      const id = await record({ kind: 'equity', amount: 3_000_000 });
      const attempt = await query(
        `update public.capital_fundings set amount = 9000000 where id = $1`,
        [id],
      ).then(
        () => 'allowed',
        (error: Error) => error.message,
      );
      expect(attempt).not.toBe('allowed');
      expect(attempt).toMatch(/is the thing being verified/i);
    });

    it('cannot be deleted', async () => {
      const id = await record({ kind: 'equity', amount: 2_000_000 });
      const attempt = await query(`delete from public.capital_fundings where id = $1`, [
        id,
      ]).then(
        () => 'allowed',
        (error: Error) => error.message,
      );
      expect(attempt).not.toBe('allowed');
    });

    it('is open to a Manager, who may read the register but not verify', async () => {
      const id = await record({ kind: 'equity', amount: 4_000_000, actor: manager });
      expect(id).toBeTruthy();

      const attempt = await asUser(manager, `select public.verify_capital_funding($1)`, [
        id,
      ]);
      expect(attempt.ok).toBe(false);
      expect(attempt.code).toBe('42501');
    });
  });

  // =========================================================================
  // Verification is what posts
  // =========================================================================

  describe('verification', () => {
    it('refuses the officer who recorded it, with SD001', async () => {
      const id = await record({ kind: 'equity', amount: 5_000_000 });
      const attempt = await asUser(recorder, `select public.verify_capital_funding($1)`, [
        id,
      ]);
      expect(attempt.ok).toBe(false);
      expect(attempt.code).toBe('SD001');
      expect(attempt.message).toMatch(/cannot verify it/i);
    });

    it('posts an equity contribution as a debit to the bank and a credit to 3000', async () => {
      const before = await balanceOf(bankAccountId);
      const beforeEquity = await balanceOf(equityAccountId);
      const id = await record({ kind: 'equity', amount: 50_000_000 });

      const posted = await asUserCommitted(verifier, [
        {
          sql: `select public.verify_capital_funding($1, 'Checked against the statement')::text as entry`,
          params: [id],
        },
      ]);
      expect(posted.ok, posted.message).toBe(true);
      const entry = String(posted.rows[0]?.entry);

      const lines = await linesOf(entry);
      expect(lines).toHaveLength(2);
      expect(lines[0]?.debit).toBe('50000000');
      expect(lines[1]?.code).toBe('3000');
      expect(lines[1]?.credit).toBe('50000000');

      expect(await balanceOf(bankAccountId)).toBe(before + 50_000_000);
      expect(await balanceOf(equityAccountId)).toBe(beforeEquity + 50_000_000);
    });

    it('posts a borrowing as a debit to the bank and a credit to 2320', async () => {
      const beforeBorrowings = await balanceOf(borrowingAccountId);
      const beforeEquity = await balanceOf(equityAccountId);

      const id = await record({
        kind: 'borrowing',
        amount: 20_000_000,
        rateBps: 1800,
        dueOn: '2027-02-01',
      });
      const posted = await asUserCommitted(verifier, [
        {
          sql: `select public.verify_capital_funding($1, 'Checked against the facility letter')::text as entry`,
          params: [id],
        },
      ]);
      expect(posted.ok, posted.message).toBe(true);

      const lines = await linesOf(String(posted.rows[0]?.entry));
      expect(lines[1]?.code).toBe('2320');
      expect(lines[1]?.credit).toBe('20000000');

      expect(await balanceOf(borrowingAccountId)).toBe(beforeBorrowings + 20_000_000);
      // The distinction the whole table exists to make: borrowing does not
      // raise the owner's capital.
      expect(await balanceOf(equityAccountId)).toBe(beforeEquity);
    });

    it('dates the journal today, whatever the evidence says', async () => {
      const id = await record({
        kind: 'equity',
        amount: 1_500_000,
        fundedOn: '2024-03-15',
      });
      const posted = await asUserCommitted(verifier, [
        {
          sql: `select public.verify_capital_funding($1)::text as entry`,
          params: [id],
        },
      ]);
      const row = await queryOne<{
        entry_date: string;
        funded_on: string;
        business: string;
      }>(
        `select je.entry_date::text as entry_date, f.funded_on::text as funded_on,
                public.business_date()::text as business
           from public.journal_entries je
           join public.capital_fundings f on f.journal_entry_id = je.id
          where je.id = $1`,
        [String(posted.rows[0]?.entry)],
      );
      expect(row.funded_on).toBe('2024-03-15');
      expect(row.entry_date).toBe(row.business);
      expect(row.entry_date).not.toBe(row.funded_on);
    });

    it('is idempotent: a second verification returns the same journal', async () => {
      const id = await record({ kind: 'equity', amount: 6_000_000 });
      const first = await asUserCommitted(verifier, [
        { sql: `select public.verify_capital_funding($1)::text as entry`, params: [id] },
      ]);
      const second = await asUserCommitted(verifier, [
        { sql: `select public.verify_capital_funding($1)::text as entry`, params: [id] },
      ]);
      expect(second.rows[0]?.entry).toBe(first.rows[0]?.entry);

      const count = await queryOne<{ count: string }>(
        `select count(*)::text as count from public.journal_entries
          where source_type = 'capital_funding' and source_id = $1`,
        [id],
      );
      expect(count.count).toBe('1');
    });

    it('records who verified it and when, and that cannot be edited afterwards', async () => {
      const id = await record({ kind: 'equity', amount: 1_200_000 });
      await asUserCommitted(verifier, [
        { sql: `select public.verify_capital_funding($1, 'checked')`, params: [id] },
      ]);

      const row = await queryOne<{ verified_by: string; label: string }>(
        `select verified_by::text as verified_by, verified_by_label as label
           from public.capital_fundings where id = $1`,
        [id],
      );
      expect(row.verified_by).toBe(verifier.profileId);
      expect(row.label).not.toBe('');

      const attempt = await query(
        `update public.capital_fundings set verified_by = $2 where id = $1`,
        [id, recorder.profileId],
      ).then(
        () => 'allowed',
        (error: Error) => error.message,
      );
      expect(attempt).not.toBe('allowed');
      expect(attempt).toMatch(/once recorded, cannot be edited/i);
    });
  });

  // =========================================================================
  // Rejection and reversal
  // =========================================================================

  describe('rejection', () => {
    it('refuses the recorder, needs a reason, posts nothing, and is terminal', async () => {
      const id = await record({ kind: 'equity', amount: 900_000 });

      const own = await asUser(
        recorder,
        `select public.reject_capital_funding($1, 'cheque bounced')`,
        [id],
      );
      expect(own.ok).toBe(false);
      expect(own.code).toBe('SD001');

      const silent = await asUser(
        verifier,
        `select public.reject_capital_funding($1, '')`,
        [id],
      );
      expect(silent.ok).toBe(false);
      expect(silent.message).toMatch(/why this capital funding is being rejected/i);

      const done = await asUserCommitted(verifier, [
        {
          sql: `select public.reject_capital_funding($1, 'The cheque was returned unpaid.')`,
          params: [id],
        },
      ]);
      expect(done.ok, done.message).toBe(true);

      const row = await queryOne<{ status: string; journal: string | null }>(
        `select status, journal_entry_id::text as journal
           from public.capital_fundings where id = $1`,
        [id],
      );
      expect(row.status).toBe('rejected');
      expect(row.journal).toBeNull();

      const revive = await asUser(verifier, `select public.verify_capital_funding($1)`, [
        id,
      ]);
      expect(revive.ok).toBe(false);
      expect(revive.message).toMatch(/cannot be verified/i);
    });
  });

  describe('reversal', () => {
    it('refuses the officer who verified it', async () => {
      const id = await record({ kind: 'equity', amount: 2_500_000 });
      await asUserCommitted(verifier, [
        { sql: `select public.verify_capital_funding($1)`, params: [id] },
      ]);

      const attempt = await asUser(
        verifier,
        `select public.reverse_capital_funding($1, 'recorded twice in error')`,
        [id],
      );
      expect(attempt.ok).toBe(false);
      expect(attempt.code).toBe('SD001');
    });

    it('posts the contra, and the account returns to where it was', async () => {
      const before = await balanceOf(bankAccountId);
      const beforeEquity = await balanceOf(equityAccountId);

      const id = await record({ kind: 'equity', amount: 4_400_000 });
      await asUserCommitted(verifier, [
        { sql: `select public.verify_capital_funding($1)`, params: [id] },
      ]);
      expect(await balanceOf(bankAccountId)).toBe(before + 4_400_000);

      const reversed = await asUserCommitted(recorder, [
        {
          sql: `select public.reverse_capital_funding($1, 'EFT was a duplicate.')::text as entry`,
          params: [id],
        },
      ]);
      expect(reversed.ok, reversed.message).toBe(true);

      const lines = await linesOf(String(reversed.rows[0]?.entry));
      expect(lines[0]?.code).toBe('3000');
      expect(lines[0]?.debit).toBe('4400000');
      expect(lines[1]?.credit).toBe('4400000');

      expect(await balanceOf(bankAccountId)).toBe(before);
      expect(await balanceOf(equityAccountId)).toBe(beforeEquity);

      const row = await queryOne<{ status: string }>(
        `select status from public.capital_fundings where id = $1`,
        [id],
      );
      expect(row.status).toBe('reversed');
    });

    it('refuses when the money has already been spent, rather than going negative', async () => {
      // Into the till, which starts empty in this suite, so the whole of this
      // contribution can be moved out again and nothing else interferes.
      const id = await record({
        kind: 'equity',
        amount: 5_000_000,
        destination: tillAccountId,
      });
      await asUserCommitted(verifier, [
        { sql: `select public.verify_capital_funding($1)`, params: [id] },
      ]);

      // Lend it out, as a disbursement would.
      await query(
        `select public.post_journal($1, current_date, 'Lent out', 'adjustment',
           null, null, null,
           jsonb_build_array(
             jsonb_build_object('account_id', public.ledger_account_by_code('1200'),
               'debit', 5000000, 'credit', 0),
             jsonb_build_object('account_id', $2::uuid, 'debit', 0, 'credit', 5000000)),
           now(), $3, 'capital fixture')`,
        [branch, tillAccountId, recorder.profileId],
      );

      const attempt = await asUser(
        recorder,
        `select public.reverse_capital_funding($1, 'tried after lending it out')`,
        [id],
      );
      expect(attempt.ok).toBe(false);
      expect(attempt.message).toMatch(/less than the 5000000 being taken out/i);
    });
  });

  // =========================================================================
  // The register, and the book
  // =========================================================================

  describe('the register and the ledger', () => {
    it('reports both ledger accounts, the evidence and the whole trail', async () => {
      const id = await record({ kind: 'borrowing', amount: 8_000_000, rateBps: 1500 });
      await asUserCommitted(verifier, [
        { sql: `select public.verify_capital_funding($1, 'checked')`, params: [id] },
      ]);

      const row = await queryOne<{
        funding_kind: string;
        capital_account_code: string;
        destination_account_code: string;
        status: string;
        interest_rate_bps: number;
        journal_entry_number: string;
        verified_by_label: string;
      }>(
        `select funding_kind, capital_account_code, destination_account_code, status,
                interest_rate_bps, journal_entry_number, verified_by_label
           from public.capital_funding_register where funding_id = $1`,
        [id],
      );
      expect(row.funding_kind).toBe('borrowing');
      expect(row.capital_account_code).toBe('2320');
      expect(row.destination_account_code).not.toBe('2320');
      expect(row.status).toBe('verified');
      expect(row.interest_rate_bps).toBe(1500);
      expect(row.journal_entry_number).toMatch(/^JV/);
      expect(row.verified_by_label).not.toBe('');
    });

    it('leaves every capital entry balanced, and the whole book with it', async () => {
      const unbalanced = await query<{ entry_number: string }>(
        `select je.entry_number
           from public.journal_entries je
           join public.journal_lines jl on jl.entry_id = je.id
          where je.source_type in ('capital_funding', 'capital_funding_reversal')
          group by je.id, je.entry_number
         having sum(jl.debit) <> sum(jl.credit)`,
      );
      expect(unbalanced).toEqual([]);

      const book = await queryOne<{ difference: string }>(
        `select (sum(debit) - sum(credit))::text as difference from public.journal_lines`,
      );
      expect(book.difference).toBe('0');
    });

    it('names its entries so a reader knows which half of the sheet moved', async () => {
      const rows = await query<{ description: string; source_type: string }>(
        `select description, source_type from public.journal_entries
          where source_type = 'capital_funding' order by entry_number`,
      );
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        expect(row.description).toMatch(/^(Capital contributed by|Borrowing from) /);
      }
    });
  });
});
