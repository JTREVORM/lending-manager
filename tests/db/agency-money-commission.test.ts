/**
 * Phase 4E — commission from accrual to payout to recovery.
 *
 * ## The three facts this file is about
 *
 * A deferred commission is recognised when the transaction posts, as a
 * receivable in 1310. The provider pays it later, into the agent line's own
 * electronic float. And sometimes a transaction is reversed after that payment
 * has arrived, which leaves the company holding money that is no longer its
 * own — a liability in 2230, not a negative receivable.
 *
 * ## What is asserted, and why it is asserted this way
 *
 * Every money-moving case asserts the **exact journal lines**, in order, not a
 * total: a payout booked against the wrong account can balance perfectly and
 * still be a lie about where the money went. Two further assertions run beside
 * them because they are the ones that catch the errors a reader cannot see:
 *
 *   * **no income account moves** on a payout or a recovery. The income was
 *     recognised once, per transaction. A payout that credited 4510 again
 *     would double-count it and the entry would still balance;
 *   * **the subsidiary ledger ties to the general ledger.** 1310 and 2230 are
 *     each one account shared by every provider and every line, so the
 *     per-line figures are derived rather than stored. After each scenario the
 *     sum of the per-line figures is checked against the account's own
 *     balance. That is the single assertion that catches a payout posted
 *     against the wrong line.
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
  describe('agency mobile money commission', () => {
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
  readonly typeId: string;
  readonly tillId: string;
  readonly floatCode: string;
}

/** The nth line a fixture made, asserted present so the tests read plainly. */
function at(lines: readonly Svc[], index = 0): Svc {
  const line = lines[index];
  if (line === undefined) {
    throw new Error(`the fixture made no line at index ${index}`);
  }
  return line;
}

describeDb('Phase 4E — commission payout and recovery', () => {
  let owner: TestUser;
  let mgr: TestUser;
  let sec: TestUser;
  let branch: string;
  let cashCode: string;

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
          'phase 4e commission fixture')`,
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

  async function entryOf(settlementId: string): Promise<string> {
    const r = await queryOne<{ e: string }>(
      `select journal_entry_id::text as e
         from public.agency_commission_settlements where id = $1`,
      [settlementId],
    );
    return r.e;
  }

  async function lineOutstanding(tillId: string): Promise<number> {
    const r = await queryOne<{ v: string }>(
      `select public.agency_commission_outstanding_by_line($1)::text as v`,
      [tillId],
    );
    return Number(r.v);
  }

  async function providerOutstanding(providerId: string): Promise<number> {
    const r = await queryOne<{ v: string }>(
      `select public.agency_commission_outstanding($1, $2)::text as v`,
      [providerId, branch],
    );
    return Number(r.v);
  }

  async function recoveryOwed(tillId: string): Promise<number> {
    const r = await queryOne<{ v: string }>(
      `select public.agency_commission_recovery_outstanding_by_line($1)::text as v`,
      [tillId],
    );
    return Number(r.v);
  }

  /**
   * The assertion that catches a figure posted against the wrong line: the
   * per-line subsidiary figures must add up to the general-ledger account.
   * Scoped to the lines this suite creates, because 1310 and 2230 are shared
   * with every other provider in the database.
   */
  async function subsidiaryTiesToLedger(tills: readonly string[]): Promise<void> {
    const receivable = await Promise.all(tills.map(lineOutstanding));
    const owed = await Promise.all(tills.map(recoveryOwed));

    const glReceivable = await queryOne<{ v: string }>(
      `select coalesce(sum(l.debit - l.credit), 0)::text as v
         from public.journal_lines l
         join public.journal_entries e on e.id = l.entry_id
         join public.ledger_accounts a on a.id = l.account_id
        where a.code = '1310'
          and (
            (e.source_type in ('agency_transaction', 'agency_transaction_reversal')
              and exists (select 1 from public.agency_transactions t
                           where t.id = e.source_id
                             and t.float_account_id = any($1::uuid[])))
            or (e.source_type like 'agency_commission_%'
              and exists (select 1 from public.agency_commission_settlements s
                           where s.id = e.source_id
                             and s.float_account_id = any($1::uuid[])))
            or (e.source_type = 'agency_commission_recovery'
              and exists (select 1 from public.agency_commission_recoveries rc
                           where rc.id = e.source_id
                             and rc.float_account_id = any($1::uuid[])))
          )`,
      [tills],
    );
    const glOwed = await queryOne<{ v: string }>(
      `select coalesce(sum(l.credit - l.debit), 0)::text as v
         from public.journal_lines l
         join public.journal_entries e on e.id = l.entry_id
         join public.ledger_accounts a on a.id = l.account_id
        where a.code = '2230'
          and (
            (e.source_type = 'agency_transaction_reversal'
              and exists (select 1 from public.agency_transactions t
                           where t.id = e.source_id
                             and t.float_account_id = any($1::uuid[])))
            or (e.source_type = 'agency_commission_recovery'
              and exists (select 1 from public.agency_commission_recoveries rc
                           where rc.id = e.source_id
                             and rc.float_account_id = any($1::uuid[])))
          )`,
      [tills],
    );

    expect(receivable.reduce((a, b) => a + b, 0)).toBe(Number(glReceivable.v));
    expect(owed.reduce((a, b) => a + b, 0)).toBe(Number(glOwed.v));
  }

  async function liveProvider(opts: {
    code: string;
    direction?: 'deposit' | 'withdrawal';
    model?: 'deferred' | 'immediate';
    tills?: readonly string[];
    openingFloat?: number;
  }): Promise<{ providerId: string; typeId: string; lines: Svc[] }> {
    const model = opts.model ?? 'deferred';
    const pr = await queryOne<{ id: string }>(
      `insert into public.agency_service_providers
         (code, name, category, float_model, income_account_id,
          commission_model, commission_source, commission_rate_bps,
          commission_fixed, is_provisional, is_active)
       values ($1, $1, 'mobile_money', 'provider_float',
               (select id from public.ledger_accounts where code = '4510'),
               $2, 'reported', null, null, false, true)
       returning id`,
      [opts.code, model],
    );
    const ty = await queryOne<{ id: string }>(
      `insert into public.agency_transaction_types
         (provider_id, code, name, direction, max_single_transaction)
       values ($1, 'OP', $2, $3, 500000000) returning id`,
      [pr.id, `${opts.code} op`, opts.direction ?? 'deposit'],
    );

    const lines: Svc[] = [];
    for (const till of opts.tills ?? ['main']) {
      const id = await queryOne<{ id: string }>(
        `select public.ensure_agency_float_account($1, $2, $3) as id`,
        [pr.id, branch, till],
      );
      const code = await queryOne<{ code: string }>(
        `select a.code from public.agency_provider_float_accounts f
           join public.ledger_accounts a on a.id = f.ledger_account_id
          where f.id = $1`,
        [id.id],
      );
      await fund(code.code, opts.openingFloat ?? 20_000_000);
      lines.push({
        providerId: pr.id,
        typeId: ty.id,
        tillId: id.id,
        floatCode: code.code,
      });
    }
    return { providerId: pr.id, typeId: ty.id, lines };
  }

  /** Records, submits and verifies one transaction. Returns its id. */
  async function post(svc: Svc, amount: number, commission: number): Promise<string> {
    const key = `EC-${Math.random().toString(36).slice(2, 12)}`;
    const c = await asUserCommitted(sec, [
      {
        sql: `select public.create_agency_transaction(
                $1, $2, $3, '+256770008000', 'Counter customer', $4, 0, $5,
                null, null, $4) as id`,
        params: [svc.typeId, amount, svc.tillId, key, commission],
      },
    ]);
    expect(c.ok, c.message).toBe(true);
    const id = (c.rows[0] as { id: string }).id;
    const s = await asUserCommitted(sec, [
      { sql: `select public.submit_agency_transaction($1)`, params: [id] },
    ]);
    expect(s.ok, s.message).toBe(true);
    const v = await asUserCommitted(mgr, [
      { sql: `select public.verify_agency_transaction($1)`, params: [id] },
    ]);
    expect(v.ok, v.message).toBe(true);
    return id;
  }

  async function payout(
    tillId: string,
    amount: number,
    ref: string,
    who: TestUser = mgr,
  ) {
    return asUserCommitted(who, [
      {
        sql: `select public.record_agency_commission_payout($1, $2, $3) as id`,
        params: [tillId, amount, ref],
      },
    ]);
  }

  beforeAll(async () => {
    owner = await createTestUser('owner_admin');
    mgr = await createTestUser('manager');
    sec = await createTestUser('secretary_treasurer');

    branch = (
      await queryOne<{ id: string }>(
        `select id from public.branches where status = 'active' order by branch_code limit 1`,
      )
    ).id;
    await query(`update public.profiles set branch_id = $1 where id = any($2::uuid[])`, [
      branch,
      [mgr.profileId, sec.profileId],
    ]);
    await query(`update public.profiles set branch_id = null where id = $1`, [
      owner.profileId,
    ]);

    cashCode = (
      await queryOne<{ code: string }>(
        `select code from public.ledger_accounts
          where branch_id = $1 and cash_kind = 'cash_at_hand' limit 1`,
        [branch],
      )
    ).code;
    await fund(cashCode, 500_000_000);
    await query(
      `update public.finance_settings set allow_negative_cash = false,
              allow_negative_agency_float = false where id = 1`,
    );
  });

  afterAll(async () => {
    // No user cleanup: this project owns its database and rebuilds it from the
    // migrations, and these rows are referenced by journal entries.
    await closePool();
  });

  // =========================================================================
  // The payout
  // =========================================================================
  describe('commission paid into the line’s float', () => {
    it('debits the line and credits the receivable, and recognises no income again', async () => {
      const { lines } = await liveProvider({ code: 'ECPAY1' });
      const line = at(lines);
      await post(line, 100_000, 700);
      await post(line, 50_000, 300);
      expect(await lineOutstanding(line.tillId)).toBe(1_000);

      const incomeBefore = await balance('4510');
      const floatBefore = await balance(line.floatCode);

      const r = await payout(line.tillId, 1_000, 'MTNCOM-2026-10');
      expect(r.ok, r.message).toBe(true);
      const entry = await entryOf((r.rows[0] as { id: string }).id);

      expect(await linesOf(entry)).toEqual([
        { code: line.floatCode, debit: 1_000, credit: 0 },
        { code: '1310', debit: 0, credit: 1_000 },
      ]);
      // The income was recognised when each transaction posted. A payout that
      // credited 4510 again would double-count it, and the entry would still
      // balance.
      expect(await balance('4510')).toBe(incomeBefore);
      expect(await balance(line.floatCode)).toBe(floatBefore + 1_000);
      expect(await lineOutstanding(line.tillId)).toBe(0);
      await subsidiaryTiesToLedger([line.tillId]);
    });

    it('takes partial payments, and leaves the rest outstanding', async () => {
      const { lines } = await liveProvider({ code: 'ECPAY2' });
      const line = at(lines);
      await post(line, 200_000, 1_400);

      expect((await payout(line.tillId, 400, 'PART-1')).ok).toBe(true);
      expect(await lineOutstanding(line.tillId)).toBe(1_000);
      expect((await payout(line.tillId, 600, 'PART-2')).ok).toBe(true);
      expect(await lineOutstanding(line.tillId)).toBe(400);
      await subsidiaryTiesToLedger([line.tillId]);
    });

    it('refuses more than the line is owed, naming both figures', async () => {
      const { lines } = await liveProvider({ code: 'ECPAY3' });
      const line = at(lines);
      await post(line, 100_000, 500);

      const r = await payout(line.tillId, 501, 'TOOMUCH');
      expect(r.ok).toBe(false);
      expect(r.message).toMatch(/500 shillings of commission are outstanding/i);
      expect(r.message).toMatch(/less than the 501/i);
      expect(await lineOutstanding(line.tillId)).toBe(500);
    });

    it('requires the provider’s reference, so the same payment cannot post twice', async () => {
      const { lines } = await liveProvider({ code: 'ECPAY4' });
      const line = at(lines);
      await post(line, 100_000, 800);

      const blank = await payout(line.tillId, 100, '   ');
      expect(blank.ok).toBe(false);
      expect(blank.message).toMatch(/transaction ID or statement reference/i);

      expect((await payout(line.tillId, 100, 'DUP-1')).ok).toBe(true);
      const again = await payout(line.tillId, 100, 'DUP-1');
      expect(again.ok).toBe(false);
      expect(again.message).toMatch(/already been recorded against this agent line/i);
      expect(await lineOutstanding(line.tillId)).toBe(700);
    });

    it('is attributed to one line, not to the provider at the branch', async () => {
      // The error this catches: paying 1,000 into the first line when the
      // second earned it leaves the provider total right and both line
      // figures wrong, which is the hardest kind of mistake to find.
      const { lines } = await liveProvider({
        code: 'ECPAY5',
        tills: ['main', 'second'],
      });
      const a = at(lines, 0);
      const b = at(lines, 1);
      await post(a, 100_000, 600);
      await post(b, 100_000, 900);

      expect(await lineOutstanding(a.tillId)).toBe(600);
      expect(await lineOutstanding(b.tillId)).toBe(900);

      expect((await payout(b.tillId, 900, 'LINE-B')).ok).toBe(true);

      expect(await lineOutstanding(a.tillId)).toBe(600);
      expect(await lineOutstanding(b.tillId)).toBe(0);
      expect(await providerOutstanding(a.providerId)).toBe(600);
      await subsidiaryTiesToLedger([a.tillId, b.tillId]);
    });

    it('needs agency:settlements, which a cashier does not hold', async () => {
      const { lines } = await liveProvider({ code: 'ECPAY6' });
      const line = at(lines);
      await post(line, 100_000, 500);

      const r = await asUser(
        sec,
        `select public.record_agency_commission_payout($1, 100, 'NOPE')`,
        [line.tillId],
      );
      expect(r.ok).toBe(false);
      expect(r.code).toBe('42501');
    });

    it('reaches a suspended line, because what it earned is still owed to it', async () => {
      const { lines } = await liveProvider({ code: 'ECPAY7' });
      const line = at(lines);
      await post(line, 100_000, 500);
      await query(
        `update public.agency_provider_float_accounts
            set status = 'suspended', is_active = false,
                status_reason = 'line under investigation',
                status_changed_by = $2, status_changed_at = now()
          where id = $1`,
        [line.tillId, owner.profileId],
      );
      const r = await payout(line.tillId, 500, 'SUSP-OK');
      expect(r.ok, r.message).toBe(true);
    });

    it('does not reach a closed line', async () => {
      const { lines } = await liveProvider({ code: 'ECPAY8' });
      const line = at(lines);
      await post(line, 100_000, 500);
      expect((await payout(line.tillId, 500, 'CLEAR-IT')).ok).toBe(true);
      await query(
        `update public.agency_provider_float_accounts
            set status = 'closed', is_active = false, closed_on = current_date,
                status_reason = 'line retired',
                status_changed_by = $2, status_changed_at = now()
          where id = $1`,
        [line.tillId, owner.profileId],
      );
      const r = await payout(line.tillId, 1, 'TOO-LATE');
      expect(r.ok).toBe(false);
      expect(r.message).toMatch(/closed, so nothing may be paid into it/i);
    });

    it('refuses a provider that recognises commission at the point of sale', async () => {
      const { lines } = await liveProvider({ code: 'ECPAY9', model: 'immediate' });
      const line = at(lines);
      const r = await payout(line.tillId, 100, 'IMMED');
      expect(r.ok).toBe(false);
      expect(r.message).toMatch(/no receivable to pay out/i);
    });
  });

  // =========================================================================
  // OD-10 — the reversal after the payout
  // =========================================================================
  describe('a transaction reversed after its commission arrived', () => {
    it('credits the receivable as far as it goes and the rest to 2230', async () => {
      const { lines } = await liveProvider({ code: 'ECREV1' });
      const line = at(lines);
      const txId = await post(line, 100_000, 1_000);
      expect((await payout(line.tillId, 1_000, 'REV-PAID')).ok).toBe(true);
      expect(await lineOutstanding(line.tillId)).toBe(0);

      const owedBefore = await recoveryOwed(line.tillId);
      const incomeBefore = await balance('4510');

      const rev = await asUserCommitted(mgr, [
        {
          sql: `select public.reverse_agency_transaction($1, 'customer never received it') as e`,
          params: [txId],
        },
      ]);
      expect(rev.ok, rev.message).toBe(true);
      const entry = (rev.rows[0] as { e: string }).e;

      // The mirror walks the original entry in line order — cash, the counter
      // leg, then the commission pair as it was posted — so the receivable's
      // replacement comes before the income it is given back from.
      expect(await linesOf(entry)).toEqual([
        { code: cashCode, debit: 0, credit: 100_000 },
        { code: line.floatCode, debit: 100_000, credit: 0 },
        { code: '2230', debit: 0, credit: 1_000 },
        { code: '4510', debit: 1_000, credit: 0 },
      ]);

      // The receivable did not go below zero, and the income is given back.
      expect(await lineOutstanding(line.tillId)).toBe(0);
      expect(await balance('4510')).toBe(incomeBefore - 1_000);
      expect(await recoveryOwed(line.tillId)).toBe(owedBefore + 1_000);
      await subsidiaryTiesToLedger([line.tillId]);
    });

    it('splits the credit when only part of the commission had been paid', async () => {
      const { lines } = await liveProvider({ code: 'ECREV2' });
      const line = at(lines);
      const txId = await post(line, 100_000, 1_000);
      expect((await payout(line.tillId, 400, 'PART-PAID')).ok).toBe(true);
      expect(await lineOutstanding(line.tillId)).toBe(600);

      const rev = await asUserCommitted(mgr, [
        {
          sql: `select public.reverse_agency_transaction($1, 'wrong amount keyed') as e`,
          params: [txId],
        },
      ]);
      expect(rev.ok, rev.message).toBe(true);

      // 600 back to the receivable, 400 owed back to the provider.
      expect(await lineOutstanding(line.tillId)).toBe(0);
      expect(await recoveryOwed(line.tillId)).toBe(400);
      expect(await linesOf((rev.rows[0] as { e: string }).e)).toEqual([
        { code: cashCode, debit: 0, credit: 100_000 },
        { code: line.floatCode, debit: 100_000, credit: 0 },
        { code: '1310', debit: 0, credit: 600 },
        { code: '2230', debit: 0, credit: 400 },
        { code: '4510', debit: 1_000, credit: 0 },
      ]);
      await subsidiaryTiesToLedger([line.tillId]);
    });

    it('leaves an unpaid commission exactly as Phase 4C posted it', async () => {
      // The ordinary case, and every case the existing suites cover: nothing
      // has been paid out, so the 2230 leg is absent entirely.
      const { lines } = await liveProvider({ code: 'ECREV3' });
      const line = at(lines);
      const txId = await post(line, 100_000, 1_000);

      const rev = await asUserCommitted(mgr, [
        {
          sql: `select public.reverse_agency_transaction($1, 'plain correction') as e`,
          params: [txId],
        },
      ]);
      expect(rev.ok, rev.message).toBe(true);
      expect(await linesOf((rev.rows[0] as { e: string }).e)).toEqual([
        { code: cashCode, debit: 0, credit: 100_000 },
        { code: line.floatCode, debit: 100_000, credit: 0 },
        { code: '1310', debit: 0, credit: 1_000 },
        { code: '4510', debit: 1_000, credit: 0 },
      ]);
      expect(await recoveryOwed(line.tillId)).toBe(0);
    });
  });

  // =========================================================================
  // OD-10 — and then it is recovered
  // =========================================================================
  describe('recovering what is owed back', () => {
    async function owedLine(code: string): Promise<Svc> {
      const { lines } = await liveProvider({ code });
      const line = at(lines);
      const txId = await post(line, 100_000, 1_000);
      expect((await payout(line.tillId, 1_000, `${code}-PAID`)).ok).toBe(true);
      const rev = await asUserCommitted(mgr, [
        {
          sql: `select public.reverse_agency_transaction($1, 'reversed after payout')`,
          params: [txId],
        },
      ]);
      expect(rev.ok, rev.message).toBe(true);
      expect(await recoveryOwed(line.tillId)).toBe(1_000);
      return line;
    }

    async function recover(
      tillId: string,
      amount: number,
      method: string,
      ref: string,
      who: TestUser = mgr,
    ) {
      return asUserCommitted(who, [
        {
          sql: `select public.record_agency_commission_recovery($1, $2, $3, $4) as id`,
          params: [tillId, amount, method, ref],
        },
      ]);
    }

    it('takes it out of the float when the provider deducts it', async () => {
      const line = await owedLine('ECRC1');
      const floatBefore = await balance(line.floatCode);
      const incomeBefore = await balance('4510');

      const r = await recover(line.tillId, 1_000, 'float_deduction', 'DEDUCT-1');
      expect(r.ok, r.message).toBe(true);

      const entry = await queryOne<{ e: string }>(
        `select journal_entry_id::text as e from public.agency_commission_recoveries where id = $1`,
        [(r.rows[0] as { id: string }).id],
      );
      expect(await linesOf(entry.e)).toEqual([
        { code: '2230', debit: 1_000, credit: 0 },
        { code: line.floatCode, debit: 0, credit: 1_000 },
      ]);
      expect(await balance(line.floatCode)).toBe(floatBefore - 1_000);
      expect(await balance('4510')).toBe(incomeBefore);
      expect(await recoveryOwed(line.tillId)).toBe(0);
      await subsidiaryTiesToLedger([line.tillId]);
    });

    it('sets it against commission owed when the provider withholds it', async () => {
      const line = await owedLine('ECRC2');
      // Earn some more, so there is a receivable to offset against.
      await post(line, 200_000, 1_500);
      expect(await lineOutstanding(line.tillId)).toBe(1_500);

      const floatBefore = await balance(line.floatCode);
      const r = await recover(line.tillId, 1_000, 'commission_offset', 'OFFSET-1');
      expect(r.ok, r.message).toBe(true);

      const entry = await queryOne<{ e: string }>(
        `select journal_entry_id::text as e from public.agency_commission_recoveries where id = $1`,
        [(r.rows[0] as { id: string }).id],
      );
      expect(await linesOf(entry.e)).toEqual([
        { code: '2230', debit: 1_000, credit: 0 },
        { code: '1310', debit: 0, credit: 1_000 },
      ]);
      // An offset moves no money: it lowers two balances that already exist.
      expect(await balance(line.floatCode)).toBe(floatBefore);
      expect(await recoveryOwed(line.tillId)).toBe(0);
      expect(await lineOutstanding(line.tillId)).toBe(500);
      await subsidiaryTiesToLedger([line.tillId]);
    });

    it('refuses more than is owed back', async () => {
      const line = await owedLine('ECRC3');
      const r = await recover(line.tillId, 1_001, 'float_deduction', 'TOOMUCH');
      expect(r.ok).toBe(false);
      expect(r.message).toMatch(/1000 shillings of commission are owed back/i);
      expect(await recoveryOwed(line.tillId)).toBe(1_000);
    });

    it('refuses a float deduction the line cannot cover', async () => {
      const { lines } = await liveProvider({ code: 'ECRC4', openingFloat: 150_000 });
      const line = at(lines);
      const txId = await post(line, 100_000, 1_000);
      expect((await payout(line.tillId, 1_000, 'ECRC4-PAID')).ok).toBe(true);
      const rev = await asUserCommitted(mgr, [
        {
          sql: `select public.reverse_agency_transaction($1, 'reversed')`,
          params: [txId],
        },
      ]);
      expect(rev.ok, rev.message).toBe(true);

      // The reversal put the 100,000 back into the float and took it out of
      // cash, so the float is well funded. Drain it to force the refusal.
      await query(
        `select public.post_journal(
            $1, current_date, $3, 'adjustment', null, null, null,
            jsonb_build_array(
              jsonb_build_object('account_id', public.ledger_account_by_code('3000'),
                'debit', $4::bigint, 'credit', 0),
              jsonb_build_object('account_id',
                (select id from public.ledger_accounts where code = $2),
                'debit', 0, 'credit', $4::bigint)),
            now(),
            (select p.id from public.profiles p join public.user_roles r on r.profile_id = p.id
              where r.role_key = 'owner_admin' order by p.created_at limit 1),
            'drain the line')`,
        [branch, line.floatCode, `drain ${Date.now()}`, await balance(line.floatCode)],
      );
      expect(await balance(line.floatCode)).toBe(0);

      const r = await recover(line.tillId, 1_000, 'float_deduction', 'NO-FLOAT');
      expect(r.ok).toBe(false);
      expect(r.message).toMatch(/less than the 1000 being sent out of it/i);
      expect(await recoveryOwed(line.tillId)).toBe(1_000);
    });

    it('requires a reference, refuses a repeat of one, and refuses an invented method', async () => {
      const line = await owedLine('ECRC5');

      const blank = await recover(line.tillId, 100, 'float_deduction', '  ');
      expect(blank.ok).toBe(false);
      expect(blank.message).toMatch(/needs the provider's reference/i);

      const bogus = await recover(line.tillId, 100, 'write_it_off', 'WO-1');
      expect(bogus.ok).toBe(false);
      expect(bogus.message).toMatch(/float deduction or an offset/i);

      expect((await recover(line.tillId, 100, 'float_deduction', 'RC-1')).ok).toBe(true);
      const again = await recover(line.tillId, 100, 'float_deduction', 'RC-1');
      expect(again.ok).toBe(false);
      expect(again.message).toMatch(/already been recorded as a recovery/i);
      expect(await recoveryOwed(line.tillId)).toBe(900);
    });

    it('needs agency:settlements, which a cashier does not hold', async () => {
      const line = await owedLine('ECRC6');
      const r = await asUser(
        sec,
        `select public.record_agency_commission_recovery($1, 100, 'float_deduction', 'NOPE')`,
        [line.tillId],
      );
      expect(r.ok).toBe(false);
      expect(r.code).toBe('42501');
    });

    it('cannot be deleted, so a recovery is corrected by recording another', async () => {
      const line = await owedLine('ECRC7');
      const r = await recover(line.tillId, 500, 'float_deduction', 'KEEP-1');
      expect(r.ok, r.message).toBe(true);
      const err = await asUser(
        owner,
        `delete from public.agency_commission_recoveries where id = $1`,
        [(r.rows[0] as { id: string }).id],
      );
      expect(err.ok).toBe(false);
    });
  });
});
