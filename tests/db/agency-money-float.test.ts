/**
 * Phase 4E — float bought, sold and moved, under a maker-checker control.
 *
 * ## The claim this file has to make good on
 *
 * Decision OD-7 lets a cashier record a float purchase, sale or transfer, and
 * requires a different Manager or Owner to post it. The strongest part of that
 * decision is the sentence that sounds like a detail: *"Pending transactions
 * must not affect financial balances."*
 *
 * So the first test here records a trade and then asserts that **nothing
 * moved** — not the float, not the cash, not the count of journal entries.
 * That is true by construction rather than by rule, because nothing writes a
 * journal until verification and every balance in this schema is derived from
 * `journal_lines`. The test exists because "by construction" is a claim about
 * code, and this is the database saying it.
 *
 * ## And the exact lines, every time
 *
 * A purchase at a premium, a purchase at a discount, a sale with a fee and a
 * sale without one all balance whichever account the difference lands in. Only
 * the lines tell you whether a premium was recognised as an expense or quietly
 * added to the float, where it would overstate a balance the provider will
 * never confirm and produce a reconciliation variance that is not one.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  asUser,
  asUserCommitted,
  createTestUser,
  type TestUser,
} from '../helpers/auth-fixtures';
import type { PoolClient } from 'pg';

import {
  closePool,
  getClient,
  hasDatabase,
  query,
  queryOne,
  skipReason,
} from '../helpers/db';

const describeDb = hasDatabase ? describe : describe.skip;
if (!hasDatabase) {
  describe('agency mobile money float trades', () => {
    it.skip(`skipped - ${skipReason}`, () => undefined);
  });
}

interface Line {
  readonly code: string;
  readonly debit: number;
  readonly credit: number;
}

interface Svc {
  readonly providerId: string;
  readonly tillId: string;
  readonly floatCode: string;
  readonly branchId: string;
}

function at(lines: readonly Svc[], index = 0): Svc {
  const line = lines[index];
  if (line === undefined) {
    throw new Error(`the fixture made no line at index ${index}`);
  }
  return line;
}

describeDb('Phase 4E — float trades', () => {
  let owner: TestUser;
  let mgr: TestUser;
  let mgr2: TestUser;
  let hoMgr: TestUser;
  let sec: TestUser;
  let branch: string;
  let branchB: string;
  let cashCode: string;
  let cashId: string;
  let bankCode: string;

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
          'phase 4e float fixture')`,
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
    return rows.map((r) => ({
      code: r.code,
      debit: Number(r.debit),
      credit: Number(r.credit),
    }));
  }

  async function entryCount(): Promise<number> {
    const r = await queryOne<{ n: string }>(
      `select count(*)::text as n from public.journal_entries`,
    );
    return Number(r.n);
  }

  async function tradeRow(id: string) {
    return queryOne<{
      status: string;
      revision: number;
      journal_entry_id: string | null;
      rejected_reason: string | null;
    }>(
      `select status, revision, journal_entry_id::text as journal_entry_id,
              rejected_reason
         from public.agency_float_trades where id = $1`,
      [id],
    );
  }

  async function provider(opts: {
    code: string;
    tills?: readonly { name: string; branch?: 'A' | 'B' }[];
    openingFloat?: number;
    floatModel?: 'provider_float' | 'cash_payable';
  }): Promise<{ providerId: string; lines: Svc[] }> {
    const model = opts.floatModel ?? 'provider_float';
    const pr = await queryOne<{ id: string }>(
      `insert into public.agency_service_providers
         (code, name, category, float_model, payable_account_id, income_account_id,
          commission_model, commission_source, commission_rate_bps,
          commission_fixed, is_provisional, is_active)
       values ($1, $1, 'mobile_money', $2,
               case when $2 = 'cash_payable'
                 then (select id from public.ledger_accounts where code = '2290') end,
               (select id from public.ledger_accounts where code = '4510'),
               'deferred', 'reported', null, null, false, true)
       returning id`,
      [opts.code, model],
    );
    const lines: Svc[] = [];
    for (const till of opts.tills ?? [{ name: 'main' }]) {
      const branchId = till.branch === 'B' ? branchB : branch;
      const id = await queryOne<{ id: string }>(
        `select public.ensure_agency_float_account($1, $2, $3) as id`,
        [pr.id, branchId, till.name],
      );
      const code = await queryOne<{ code: string }>(
        `select a.code from public.agency_provider_float_accounts f
           join public.ledger_accounts a on a.id = f.ledger_account_id
          where f.id = $1`,
        [id.id],
      );
      await fund(code.code, opts.openingFloat ?? 5_000_000);
      lines.push({
        providerId: pr.id,
        tillId: id.id,
        floatCode: code.code,
        branchId,
      });
    }
    return { providerId: pr.id, lines };
  }

  async function suspend(tillId: string, reason: string): Promise<void> {
    await query(
      `update public.agency_provider_float_accounts
          set status = 'suspended', is_active = false, status_reason = $2,
              status_changed_by = $3, status_changed_at = now()
        where id = $1`,
      [tillId, reason, owner.profileId],
    );
  }

  async function record(
    args: {
      kind: 'purchase' | 'sale' | 'transfer';
      tillId: string;
      amount: number;
      reference: string;
      counterTillId?: string | null;
      settlement?: string | null;
      cash?: number | null;
      fee?: number | null;
      source?: string | null;
      party?: string | null;
    },
    who: TestUser = sec,
  ) {
    return asUserCommitted(who, [
      {
        sql: `select public.record_agency_float_trade(
                $1, $2, $3, $4, $5, $6, $7, $8, $9, $10) as id`,
        params: [
          args.kind,
          args.tillId,
          args.amount,
          args.reference,
          args.counterTillId ?? null,
          args.settlement ?? null,
          args.cash ?? null,
          args.fee ?? null,
          args.source ?? null,
          args.party ?? null,
        ],
      },
    ]);
  }

  async function verify(tradeId: string, who: TestUser = mgr, revision?: number) {
    return asUserCommitted(who, [
      {
        sql: `select public.verify_agency_float_trade($1, $2) as e`,
        params: [tradeId, revision ?? null],
      },
    ]);
  }

  beforeAll(async () => {
    owner = await createTestUser('owner_admin');
    mgr = await createTestUser('manager');
    mgr2 = await createTestUser('manager');
    // Head Office: the only authority that spans both branches, and a
    // different person from the Owner who records the cross-branch work.
    hoMgr = await createTestUser('manager');
    sec = await createTestUser('secretary_treasurer');

    branch = (
      await queryOne<{ id: string }>(
        `select id from public.branches where status = 'active' order by branch_code limit 1`,
      )
    ).id;

    const second = await queryOne<{ id: string }>(
      `insert into public.branches
         (branch_code, name, location, district, status, opened_on)
       values ('BR4E02', 'Phase 4E second branch', 'Nakawa', 'Kampala', 'active',
               current_date)
       on conflict (branch_code) do update set name = excluded.name
       returning id`,
    );
    branchB = second.id;

    await query(`update public.profiles set branch_id = $1 where id = any($2::uuid[])`, [
      branch,
      [mgr.profileId, mgr2.profileId, sec.profileId],
    ]);
    // The Owner is Head Office: a cross-branch transfer needs authority at
    // both ends, which only a null branch has.
    await query(
      `update public.profiles set branch_id = null where id = any($1::uuid[])`,
      [[owner.profileId, hoMgr.profileId]],
    );

    const cash = await queryOne<{ id: string; code: string }>(
      `select id, code from public.ledger_accounts
        where branch_id = $1 and cash_kind = 'cash_at_hand' limit 1`,
      [branch],
    );
    cashId = cash.id;
    cashCode = cash.code;

    const bank = await queryOne<{ code: string }>(
      `select code from public.ledger_accounts
        where branch_id = $1 and cash_kind = 'bank' limit 1`,
      [branch],
    );
    bankCode = bank.code;

    // The second branch needs its own cash account for the cross-branch work.
    await query(
      `insert into public.ledger_accounts
         (code, name, account_type, normal_side, cash_kind, branch_id, is_postable, status)
       values ('1010-BR4E02', 'Cash at Hand — Phase 4E second branch', 'asset',
               'debit', 'cash_at_hand', $1, true, 'active')
       on conflict (code) do nothing`,
      [branchB],
    );

    await fund(cashCode, 200_000_000);
    await fund(bankCode, 200_000_000);
    await query(
      `update public.finance_settings set allow_negative_cash = false,
              allow_negative_agency_float = false where id = 1`,
    );
  });

  afterAll(async () => {
    await closePool();
  });

  // =========================================================================
  // Recording moves nothing
  // =========================================================================
  describe('a pending trade', () => {
    it('writes a row and moves no balance at all', async () => {
      const { lines } = await provider({ code: 'FTPEND' });
      const line = at(lines);
      const floatBefore = await balance(line.floatCode);
      const cashBefore = await balance(cashCode);
      const entriesBefore = await entryCount();

      const r = await record({
        kind: 'purchase',
        tillId: line.tillId,
        amount: 500_000,
        reference: 'PEND-1',
        settlement: cashId,
        cash: 500_000,
        source: 'provider_service_centre',
      });
      expect(r.ok, r.message).toBe(true);

      const row = await tradeRow((r.rows[0] as { id: string }).id);
      expect(row.status).toBe('pending');
      expect(row.journal_entry_id).toBeNull();
      expect(await balance(line.floatCode)).toBe(floatBefore);
      expect(await balance(cashCode)).toBe(cashBefore);
      expect(await entryCount()).toBe(entriesBefore);
    });

    it('is recorded by a cashier, who holds agency:float_trade', async () => {
      const { lines } = await provider({ code: 'FTCASH' });
      const r = await record({
        kind: 'sale',
        tillId: at(lines).tillId,
        amount: 100_000,
        reference: 'CASH-1',
        settlement: cashId,
        fee: 0,
      });
      expect(r.ok, r.message).toBe(true);
    });

    it('refuses a repeated reference on the same line, and a blank one', async () => {
      const { lines } = await provider({ code: 'FTREF' });
      const line = at(lines);
      expect(
        (
          await record({
            kind: 'sale',
            tillId: line.tillId,
            amount: 10_000,
            reference: 'REF-1',
            settlement: cashId,
            fee: 0,
          })
        ).ok,
      ).toBe(true);

      const again = await record({
        kind: 'sale',
        tillId: line.tillId,
        amount: 10_000,
        reference: 'REF-1',
        settlement: cashId,
        fee: 0,
      });
      expect(again.ok).toBe(false);
      expect(again.message).toMatch(/already been recorded against this agent line/i);

      const blank = await record({
        kind: 'sale',
        tillId: line.tillId,
        amount: 10_000,
        reference: '  ',
        settlement: cashId,
        fee: 0,
      });
      expect(blank.ok).toBe(false);
      expect(blank.message).toMatch(/needs a reference/i);
    });

    it('asks a purchase where the float came from and what was paid', async () => {
      const { lines } = await provider({ code: 'FTPSHAPE' });
      const line = at(lines);

      const noCash = await record({
        kind: 'purchase',
        tillId: line.tillId,
        amount: 100_000,
        reference: 'PS-1',
        settlement: cashId,
        source: 'external_agent',
      });
      expect(noCash.ok).toBe(false);
      expect(noCash.message).toMatch(/what was actually paid/i);

      const noSource = await record({
        kind: 'purchase',
        tillId: line.tillId,
        amount: 100_000,
        reference: 'PS-2',
        settlement: cashId,
        cash: 100_000,
      });
      expect(noSource.ok).toBe(false);
      expect(noSource.message).toMatch(/where the float came from/i);
    });

    it('asks a sale to state its fee, and takes zero as an answer', async () => {
      const { lines } = await provider({ code: 'FTSSHAPE' });
      const line = at(lines);

      const noFee = await record({
        kind: 'sale',
        tillId: line.tillId,
        amount: 100_000,
        reference: 'SS-1',
        settlement: cashId,
      });
      expect(noFee.ok).toBe(false);
      expect(noFee.message).toMatch(/must state its fee.*Enter 0/is);

      const zero = await record({
        kind: 'sale',
        tillId: line.tillId,
        amount: 100_000,
        reference: 'SS-2',
        settlement: cashId,
        fee: 0,
      });
      expect(zero.ok, zero.message).toBe(true);
    });

    it('refuses a transfer between providers, and to the same line', async () => {
      const a = await provider({ code: 'FTX1' });
      const b = await provider({ code: 'FTX2' });

      const cross = await record({
        kind: 'transfer',
        tillId: at(a.lines).tillId,
        amount: 10_000,
        reference: 'X-1',
        counterTillId: at(b.lines).tillId,
      });
      expect(cross.ok).toBe(false);
      expect(cross.message).toMatch(/cannot be transferred between providers/i);

      const self = await record({
        kind: 'transfer',
        tillId: at(a.lines).tillId,
        amount: 10_000,
        reference: 'X-2',
        counterTillId: at(a.lines).tillId,
      });
      expect(self.ok).toBe(false);
      expect(self.message).toMatch(/two different lines|same line/i);
    });

    it('refuses a transfer into a branch the officer does not administer', async () => {
      const { lines } = await provider({
        code: 'FTXB',
        tills: [{ name: 'main' }, { name: 'other', branch: 'B' }],
      });
      const r = await record({
        kind: 'transfer',
        tillId: at(lines, 0).tillId,
        amount: 10_000,
        reference: 'XB-1',
        counterTillId: at(lines, 1).tillId,
      });
      expect(r.ok).toBe(false);
      expect(r.code).toBe('42501');
    });

    it('refuses a provider that holds no float', async () => {
      // A cash_payable provider has no till to trade from, and
      // ensure_agency_float_account() says so before a trade is even
      // attempted — which is the earlier and better place to refuse.
      const pr = await queryOne<{ id: string }>(
        `insert into public.agency_service_providers
           (code, name, category, float_model, payable_account_id, income_account_id,
            commission_model, commission_source, is_provisional, is_active)
         values ('FTPAYABLE', 'FTPAYABLE', 'agency_banking', 'cash_payable',
                 (select id from public.ledger_accounts where code = '2290'),
                 (select id from public.ledger_accounts where code = '4520'),
                 'deferred', 'reported', false, true)
         returning id`,
      );
      const err = await asUser(
        owner,
        `select public.ensure_agency_float_account($1, $2)`,
        [pr.id, branch],
      );
      expect(err.ok).toBe(false);
      expect(err.message).toMatch(/payable account, not float/i);
    });
  });

  // =========================================================================
  // Verifying is what posts
  // =========================================================================
  describe('verification', () => {
    it('refuses the person who recorded it, and a cashier', async () => {
      const { lines } = await provider({ code: 'FTMAKER' });
      const r = await record(
        {
          kind: 'sale',
          tillId: at(lines).tillId,
          amount: 50_000,
          reference: 'MK-1',
          settlement: cashId,
          fee: 0,
        },
        mgr,
      );
      expect(r.ok, r.message).toBe(true);
      const id = (r.rows[0] as { id: string }).id;

      const self = await verify(id, mgr);
      expect(self.ok).toBe(false);
      expect(self.message).toMatch(/cannot be posted by the person who recorded it/i);

      const cashier = await verify(id, sec);
      expect(cashier.ok).toBe(false);
      expect(cashier.code).toBe('42501');

      const other = await verify(id, mgr2);
      expect(other.ok, other.message).toBe(true);
    });

    it('refuses a revision the verifier has not seen', async () => {
      const { lines } = await provider({ code: 'FTREV' });
      const r = await record({
        kind: 'sale',
        tillId: at(lines).tillId,
        amount: 50_000,
        reference: 'RV-1',
        settlement: cashId,
        fee: 0,
      });
      const id = (r.rows[0] as { id: string }).id;

      await query(
        `update public.agency_float_trades set float_amount = 60000 where id = $1`,
        [id],
      );
      expect((await tradeRow(id)).revision).toBe(2);

      const stale = await verify(id, mgr, 1);
      expect(stale.ok).toBe(false);
      expect(stale.message).toMatch(/has changed since you read it/i);

      const fresh = await verify(id, mgr, 2);
      expect(fresh.ok, fresh.message).toBe(true);
    });

    it('posts a purchase at face value', async () => {
      const { lines } = await provider({ code: 'FTBUY1' });
      const line = at(lines);
      const r = await record({
        kind: 'purchase',
        tillId: line.tillId,
        amount: 500_000,
        reference: 'BUY-1',
        settlement: cashId,
        cash: 500_000,
        source: 'provider_service_centre',
      });
      const v = await verify((r.rows[0] as { id: string }).id);
      expect(v.ok, v.message).toBe(true);

      expect(await linesOf((v.rows[0] as { e: string }).e)).toEqual([
        { code: line.floatCode, debit: 500_000, credit: 0 },
        { code: cashCode, debit: 0, credit: 500_000 },
      ]);
    });

    it('recognises a premium as an expense, not as float', async () => {
      // 500,500 paid for 500,000 of float. Putting the 500 into 1320 would
      // overstate the float by money the provider will never confirm.
      const { lines } = await provider({ code: 'FTBUY2' });
      const line = at(lines);
      const premiumBefore = await balance('5970');

      const r = await record({
        kind: 'purchase',
        tillId: line.tillId,
        amount: 500_000,
        reference: 'BUY-2',
        settlement: cashId,
        cash: 500_500,
        source: 'external_agent',
        party: 'Kalerwe Agent Services',
      });
      const v = await verify((r.rows[0] as { id: string }).id);
      expect(v.ok, v.message).toBe(true);

      expect(await linesOf((v.rows[0] as { e: string }).e)).toEqual([
        { code: line.floatCode, debit: 500_000, credit: 0 },
        { code: cashCode, debit: 0, credit: 500_500 },
        { code: '5970', debit: 500, credit: 0 },
      ]);
      expect(await balance('5970')).toBe(premiumBefore + 500);
    });

    it('recognises a discount as income, and not as a customer fee', async () => {
      const { lines } = await provider({ code: 'FTBUY3' });
      const line = at(lines);
      const discountBefore = await balance('4580');
      const feesBefore = await balance('4570');

      const r = await record({
        kind: 'purchase',
        tillId: line.tillId,
        amount: 500_000,
        reference: 'BUY-3',
        settlement: cashId,
        cash: 499_500,
        source: 'external_agent',
      });
      const v = await verify((r.rows[0] as { id: string }).id);
      expect(v.ok, v.message).toBe(true);

      expect(await linesOf((v.rows[0] as { e: string }).e)).toEqual([
        { code: line.floatCode, debit: 500_000, credit: 0 },
        { code: cashCode, debit: 0, credit: 499_500 },
        { code: '4580', debit: 0, credit: 500 },
      ]);
      expect(await balance('4580')).toBe(discountBefore + 500);
      // 4570 is what a customer pays at the counter. A trading gain against
      // another agent is not that.
      expect(await balance('4570')).toBe(feesBefore);
    });

    it('buys float with bank funds', async () => {
      const { lines } = await provider({ code: 'FTBUY4' });
      const line = at(lines);
      const bankId = (
        await queryOne<{ id: string }>(
          `select id from public.ledger_accounts where code = $1`,
          [bankCode],
        )
      ).id;
      const r = await record({
        kind: 'purchase',
        tillId: line.tillId,
        amount: 1_000_000,
        reference: 'BUY-4',
        settlement: bankId,
        cash: 1_000_000,
        source: 'bank',
      });
      const v = await verify((r.rows[0] as { id: string }).id);
      expect(v.ok, v.message).toBe(true);
      expect(await linesOf((v.rows[0] as { e: string }).e)).toEqual([
        { code: line.floatCode, debit: 1_000_000, credit: 0 },
        { code: bankCode, debit: 0, credit: 1_000_000 },
      ]);
    });

    it('sells float without a fee', async () => {
      const { lines } = await provider({ code: 'FTSELL1' });
      const line = at(lines);
      const r = await record({
        kind: 'sale',
        tillId: line.tillId,
        amount: 200_000,
        reference: 'SELL-1',
        settlement: cashId,
        fee: 0,
      });
      const v = await verify((r.rows[0] as { id: string }).id);
      expect(v.ok, v.message).toBe(true);
      expect(await linesOf((v.rows[0] as { e: string }).e)).toEqual([
        { code: cashCode, debit: 200_000, credit: 0 },
        { code: line.floatCode, debit: 0, credit: 200_000 },
      ]);
    });

    it('sells float with a fee, computing the proceeds and recognising the fee separately', async () => {
      const { lines } = await provider({ code: 'FTSELL2' });
      const line = at(lines);
      const feesBefore = await balance('4570');

      const r = await record({
        kind: 'sale',
        tillId: line.tillId,
        amount: 200_000,
        reference: 'SELL-2',
        settlement: cashId,
        fee: 2_000,
        party: 'Bwaise Agent',
      });
      const v = await verify((r.rows[0] as { id: string }).id);
      expect(v.ok, v.message).toBe(true);

      expect(await linesOf((v.rows[0] as { e: string }).e)).toEqual([
        { code: cashCode, debit: 202_000, credit: 0 },
        { code: line.floatCode, debit: 0, credit: 200_000 },
        { code: '4570', debit: 0, credit: 2_000 },
      ]);
      expect(await balance('4570')).toBe(feesBefore + 2_000);
    });

    it('refuses a sale the line cannot cover, and posts nothing', async () => {
      const { lines } = await provider({ code: 'FTSELL3', openingFloat: 100_000 });
      const line = at(lines);
      const r = await record({
        kind: 'sale',
        tillId: line.tillId,
        amount: 150_000,
        reference: 'SELL-3',
        settlement: cashId,
        fee: 0,
      });
      const id = (r.rows[0] as { id: string }).id;
      const v = await verify(id);
      expect(v.ok).toBe(false);
      expect(v.message).toMatch(/less than the 150000 being sent out of it/i);

      const row = await tradeRow(id);
      expect(row.status).toBe('pending');
      expect(row.journal_entry_id).toBeNull();
      expect(await balance(line.floatCode)).toBe(100_000);
    });

    it('moves float between two lines of one provider in one branch', async () => {
      const { lines } = await provider({
        code: 'FTMOVE1',
        tills: [{ name: 'main' }, { name: 'second' }],
      });
      const from = at(lines, 0);
      const to = at(lines, 1);
      const fromBefore = await balance(from.floatCode);
      const toBefore = await balance(to.floatCode);
      const cashBefore = await balance(cashCode);

      const r = await record({
        kind: 'transfer',
        tillId: from.tillId,
        amount: 300_000,
        reference: 'MOVE-1',
        counterTillId: to.tillId,
      });
      const v = await verify((r.rows[0] as { id: string }).id);
      expect(v.ok, v.message).toBe(true);

      expect(await linesOf((v.rows[0] as { e: string }).e)).toEqual([
        { code: to.floatCode, debit: 300_000, credit: 0 },
        { code: from.floatCode, debit: 0, credit: 300_000 },
      ]);
      expect(await balance(from.floatCode)).toBe(fromBefore - 300_000);
      expect(await balance(to.floatCode)).toBe(toBefore + 300_000);
      // No cash moves, and no income arises: consolidated float is unchanged.
      expect(await balance(cashCode)).toBe(cashBefore);
    });

    it('moves float across branches when the officer administers both', async () => {
      const { lines } = await provider({
        code: 'FTMOVE2',
        tills: [{ name: 'main' }, { name: 'other', branch: 'B' }],
      });
      const from = at(lines, 0);
      const to = at(lines, 1);

      const r = await record(
        {
          kind: 'transfer',
          tillId: from.tillId,
          amount: 250_000,
          reference: 'MOVE-2',
          counterTillId: to.tillId,
        },
        owner,
      );
      expect(r.ok, r.message).toBe(true);
      const v = await verify((r.rows[0] as { id: string }).id, mgr);
      expect(v.ok, v.message).toBe(true);

      expect(await linesOf((v.rows[0] as { e: string }).e)).toEqual([
        { code: to.floatCode, debit: 250_000, credit: 0 },
        { code: from.floatCode, debit: 0, credit: 250_000 },
      ]);
    });

    it('is idempotent, so a verifier who presses twice gets the same entry', async () => {
      const { lines } = await provider({ code: 'FTIDEM' });
      const r = await record({
        kind: 'sale',
        tillId: at(lines).tillId,
        amount: 50_000,
        reference: 'IDEM-1',
        settlement: cashId,
        fee: 0,
      });
      const id = (r.rows[0] as { id: string }).id;
      const first = await verify(id);
      expect(first.ok, first.message).toBe(true);
      const second = await verify(id);
      expect(second.ok, second.message).toBe(true);
      expect((second.rows[0] as { e: string }).e).toBe(
        (first.rows[0] as { e: string }).e,
      );
    });
  });

  // =========================================================================
  // Rejecting, which is the other half of the control
  // =========================================================================
  describe('rejection', () => {
    it('keeps the row, states the reason and posts nothing', async () => {
      const { lines } = await provider({ code: 'FTREJ' });
      const line = at(lines);
      const r = await record({
        kind: 'purchase',
        tillId: line.tillId,
        amount: 100_000,
        reference: 'REJ-1',
        settlement: cashId,
        cash: 120_000,
        source: 'external_agent',
      });
      const id = (r.rows[0] as { id: string }).id;
      const entriesBefore = await entryCount();

      const rej = await asUserCommitted(mgr, [
        {
          sql: `select public.reject_agency_float_trade($1, 'premium far above the agreed rate')`,
          params: [id],
        },
      ]);
      expect(rej.ok, rej.message).toBe(true);

      const row = await tradeRow(id);
      expect(row.status).toBe('rejected');
      expect(row.rejected_reason).toMatch(/premium far above/i);
      expect(row.journal_entry_id).toBeNull();
      expect(await entryCount()).toBe(entriesBefore);
    });

    it('needs a reason, and will not touch a posted trade', async () => {
      const { lines } = await provider({ code: 'FTREJ2' });
      const r = await record({
        kind: 'sale',
        tillId: at(lines).tillId,
        amount: 50_000,
        reference: 'REJ-2',
        settlement: cashId,
        fee: 0,
      });
      const id = (r.rows[0] as { id: string }).id;

      const noReason = await asUser(
        mgr,
        `select public.reject_agency_float_trade($1, '  ')`,
        [id],
      );
      expect(noReason.ok).toBe(false);
      expect(noReason.message).toMatch(/needs a reason/i);

      expect((await verify(id)).ok).toBe(true);
      const tooLate = await asUser(
        mgr,
        `select public.reject_agency_float_trade($1, 'changed my mind')`,
        [id],
      );
      expect(tooLate.ok).toBe(false);
      expect(tooLate.message).toMatch(/only a pending float trade can be rejected/i);
    });
  });

  // =========================================================================
  // Reversal
  // =========================================================================
  describe('reversal', () => {
    it('restores the balances a sale moved, and keeps both entries', async () => {
      const { lines } = await provider({ code: 'FTRVS' });
      const line = at(lines);
      const floatBefore = await balance(line.floatCode);
      const cashBefore = await balance(cashCode);
      const feesBefore = await balance('4570');

      const r = await record({
        kind: 'sale',
        tillId: line.tillId,
        amount: 100_000,
        reference: 'RVS-1',
        settlement: cashId,
        fee: 1_000,
      });
      const id = (r.rows[0] as { id: string }).id;
      const v = await verify(id);
      expect(v.ok, v.message).toBe(true);

      const rev = await asUserCommitted(mgr, [
        {
          sql: `select public.reverse_agency_float_trade($1, 'buyer returned the float') as e`,
          params: [id],
        },
      ]);
      expect(rev.ok, rev.message).toBe(true);

      expect(await linesOf((rev.rows[0] as { e: string }).e)).toEqual([
        { code: cashCode, debit: 0, credit: 101_000 },
        { code: line.floatCode, debit: 100_000, credit: 0 },
        { code: '4570', debit: 1_000, credit: 0 },
      ]);
      expect(await balance(line.floatCode)).toBe(floatBefore);
      expect(await balance(cashCode)).toBe(cashBefore);
      expect(await balance('4570')).toBe(feesBefore);

      const row = await tradeRow(id);
      expect(row.status).toBe('reversed');
      expect(row.journal_entry_id).not.toBeNull();
    });

    it('restores both lines a transfer moved', async () => {
      const { lines } = await provider({
        code: 'FTRVT',
        tills: [{ name: 'main' }, { name: 'second' }],
      });
      const from = at(lines, 0);
      const to = at(lines, 1);
      const fromBefore = await balance(from.floatCode);
      const toBefore = await balance(to.floatCode);

      const r = await record({
        kind: 'transfer',
        tillId: from.tillId,
        amount: 150_000,
        reference: 'RVT-1',
        counterTillId: to.tillId,
      });
      const id = (r.rows[0] as { id: string }).id;
      expect((await verify(id)).ok).toBe(true);

      const rev = await asUserCommitted(mgr, [
        {
          sql: `select public.reverse_agency_float_trade($1, 'moved the wrong way')`,
          params: [id],
        },
      ]);
      expect(rev.ok, rev.message).toBe(true);
      expect(await balance(from.floatCode)).toBe(fromBefore);
      expect(await balance(to.floatCode)).toBe(toBefore);
    });

    it('needs a reason, and only a posted trade', async () => {
      const { lines } = await provider({ code: 'FTRVN' });
      const r = await record({
        kind: 'sale',
        tillId: at(lines).tillId,
        amount: 50_000,
        reference: 'RVN-1',
        settlement: cashId,
        fee: 0,
      });
      const id = (r.rows[0] as { id: string }).id;

      const pending = await asUser(
        mgr,
        `select public.reverse_agency_float_trade($1, 'no')`,
        [id],
      );
      expect(pending.ok).toBe(false);
      expect(pending.message).toMatch(/only a posted float trade can be reversed/i);

      expect((await verify(id)).ok).toBe(true);
      const noReason = await asUser(
        mgr,
        `select public.reverse_agency_float_trade($1, '   ')`,
        [id],
      );
      expect(noReason.ok).toBe(false);
      expect(noReason.message).toMatch(/needs a reason/i);
    });
  });

  // =========================================================================
  // OD-4 — a suspended line can be emptied, not filled
  // =========================================================================
  describe('a suspended line', () => {
    it('can still have its float moved off, which is how it is recovered', async () => {
      const { lines } = await provider({
        code: 'FTSUS1',
        tills: [{ name: 'main' }, { name: 'safe' }],
      });
      const from = at(lines, 0);
      const to = at(lines, 1);
      await suspend(from.tillId, 'agent line compromised');

      const r = await record({
        kind: 'transfer',
        tillId: from.tillId,
        amount: 400_000,
        reference: 'SUS-1',
        counterTillId: to.tillId,
      });
      expect(r.ok, r.message).toBe(true);
      const v = await verify((r.rows[0] as { id: string }).id);
      expect(v.ok, v.message).toBe(true);
    });

    it('can still be sold down', async () => {
      const { lines } = await provider({ code: 'FTSUS2' });
      const line = at(lines);
      await suspend(line.tillId, 'provider withdrew the line');

      const r = await record({
        kind: 'sale',
        tillId: line.tillId,
        amount: 100_000,
        reference: 'SUS-2',
        settlement: cashId,
        fee: 0,
      });
      expect(r.ok, r.message).toBe(true);
      expect((await verify((r.rows[0] as { id: string }).id)).ok).toBe(true);
    });

    it('cannot be bought into, nor transferred into', async () => {
      const { lines } = await provider({
        code: 'FTSUS3',
        tills: [{ name: 'main' }, { name: 'dead' }],
      });
      const live = at(lines, 0);
      const dead = at(lines, 1);
      await suspend(dead.tillId, 'under investigation');

      const buy = await record({
        kind: 'purchase',
        tillId: dead.tillId,
        amount: 100_000,
        reference: 'SUS-3',
        settlement: cashId,
        cash: 100_000,
        source: 'external_agent',
      });
      expect(buy.ok).toBe(false);
      expect(buy.message).toMatch(/float may not be bought into it/i);

      const move = await record({
        kind: 'transfer',
        tillId: live.tillId,
        amount: 100_000,
        reference: 'SUS-4',
        counterTillId: dead.tillId,
      });
      expect(move.ok).toBe(false);
      expect(move.message).toMatch(/receiving agent line is suspended/i);
    });
  });

  // =========================================================================
  // Concurrency — the races the lock order exists for
  // =========================================================================
  describe('two officers at once', () => {
    /**
     * Stages a race by holding the lock the work under test must take, then
     * asserting that the work did not walk past it.
     *
     * An error is not "walked past the lock": a path refused for an unrelated
     * reason never reached the lock at all, and reporting that as a
     * concurrency defect would be wrong. The caller asserts on the error.
     */
    async function blockedBy(
      lockAccounts: readonly string[],
      work: (client: PoolClient) => Promise<unknown>,
    ): Promise<{ walkedPast: boolean; error: string | null }> {
      const holder = await getClient();
      const worker = await getClient();
      let done = false;
      let error: string | null = null;
      try {
        await holder.query('begin');
        await holder.query(`select public.lock_ledger_balances($1::uuid[])`, [
          lockAccounts,
        ]);

        await worker.query('begin');
        const run = work(worker)
          .then(() => {
            done = true;
          })
          .catch((e: unknown) => {
            done = true;
            error = (e as { message?: string }).message ?? 'unknown';
          });

        await new Promise((resolve) => setTimeout(resolve, 2_000));
        const walkedPast = done && error === null;

        await holder.query('commit');
        await run;
        try {
          await worker.query('commit');
        } catch {
          await worker.query('rollback').catch(() => undefined);
        }
        return { walkedPast, error };
      } finally {
        holder.release();
        worker.release();
      }
    }

    async function ledgerIdOf(tillId: string): Promise<string> {
      const r = await queryOne<{ id: string }>(
        `select ledger_account_id::text as id
           from public.agency_provider_float_accounts where id = $1`,
        [tillId],
      );
      return r.id;
    }

    it('serialises a sale behind whoever holds the line', async () => {
      const { lines } = await provider({ code: 'FTRACE1' });
      const line = at(lines);
      const r = await record({
        kind: 'sale',
        tillId: line.tillId,
        amount: 100_000,
        reference: 'RACE-1',
        settlement: cashId,
        fee: 0,
      });
      const id = (r.rows[0] as { id: string }).id;

      const staged = await blockedBy([await ledgerIdOf(line.tillId)], async (c) => {
        await c.query(`select set_config('request.jwt.claims', $1, true)`, [
          JSON.stringify({ sub: mgr.authUserId, role: 'authenticated' }),
        ]);
        await c.query(`select public.verify_agency_float_trade($1)`, [id]);
      });

      expect(staged.walkedPast, 'the sale posted while the line was locked').toBe(false);
    });

    it('lets only one of two sales of the same float succeed', async () => {
      // 100,000 of float, two sales of 80,000 recorded. Whichever verifies
      // first takes the float; the second must be refused for insufficient
      // float rather than both posting and leaving the line at -60,000.
      const { lines } = await provider({ code: 'FTRACE2', openingFloat: 100_000 });
      const line = at(lines);

      const ids: string[] = [];
      for (const ref of ['RACE-2A', 'RACE-2B']) {
        const r = await record({
          kind: 'sale',
          tillId: line.tillId,
          amount: 80_000,
          reference: ref,
          settlement: cashId,
          fee: 0,
        });
        expect(r.ok, r.message).toBe(true);
        ids.push((r.rows[0] as { id: string }).id);
      }

      const results = await Promise.all(ids.map((id) => verify(id, mgr)));
      const posted = results.filter((r) => r.ok);
      const refused = results.filter((r) => !r.ok);

      expect(posted).toHaveLength(1);
      expect(refused).toHaveLength(1);
      expect(refused[0]?.message).toMatch(/less than the 80000 being sent out of it/i);
      expect(await balance(line.floatCode)).toBe(20_000);
    });

    it('does not deadlock when two cross-branch transfers oppose each other', async () => {
      // The case the branch-id lock order exists for. Two transfers between
      // the same pair of branches, in opposite directions, verified at the
      // same moment: taking the two provider-balance locks in the order each
      // call's own arguments arrive would have one holding A and waiting for
      // B while the other holds B and waits for A.
      const { lines } = await provider({
        code: 'FTRACE3',
        tills: [{ name: 'main' }, { name: 'other', branch: 'B' }],
      });
      const a = at(lines, 0);
      const b = at(lines, 1);

      const outbound = await record(
        {
          kind: 'transfer',
          tillId: a.tillId,
          amount: 50_000,
          reference: 'RACE-3A',
          counterTillId: b.tillId,
        },
        owner,
      );
      expect(outbound.ok, outbound.message).toBe(true);

      const inbound = await record(
        {
          kind: 'transfer',
          tillId: b.tillId,
          amount: 40_000,
          reference: 'RACE-3B',
          counterTillId: a.tillId,
        },
        owner,
      );
      expect(inbound.ok, inbound.message).toBe(true);

      // Verified by Head Office, because one of the two trades belongs to the
      // other branch and a branch manager may not post it — which the
      // branch check refuses before the locks are reached.
      const both = await Promise.all([
        verify((outbound.rows[0] as { id: string }).id, hoMgr),
        verify((inbound.rows[0] as { id: string }).id, hoMgr),
      ]);

      // Both succeed, and neither reports a deadlock. A deadlock would be
      // PostgreSQL's own 40P01, which no amount of retrying in the test would
      // make correct.
      for (const r of both) {
        expect(r.ok, r.message).toBe(true);
        expect(r.message ?? '').not.toMatch(/deadlock/i);
      }

      // Net: A sent 50,000 and received 40,000.
      expect(await balance(a.floatCode)).toBe(5_000_000 - 50_000 + 40_000);
      expect(await balance(b.floatCode)).toBe(5_000_000 + 50_000 - 40_000);
    });

    it('serialises a commission payout behind the line it pays into', async () => {
      // Not a float trade, but the same lock and the same hazard: a payout and
      // a sale on one line must not both read the same float.
      const { lines } = await provider({ code: 'FTRACE4' });
      const line = at(lines);

      const staged = await blockedBy([await ledgerIdOf(line.tillId)], async (c) => {
        await c.query(`select set_config('request.jwt.claims', $1, true)`, [
          JSON.stringify({ sub: mgr.authUserId, role: 'authenticated' }),
        ]);
        await c.query(`select public.record_agency_commission_payout($1, 1, 'RACE-4')`, [
          line.tillId,
        ]);
      });

      // It is refused or it waits; what it must not do is complete while
      // another session holds the line.
      expect(staged.walkedPast, 'the payout completed while the line was locked').toBe(
        false,
      );
    });
  });
});
