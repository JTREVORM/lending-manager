/**
 * Phase 4C — settlement, payable remittance and float replenishment.
 *
 * Every money-changing case asserts the **exact journal lines**, not a total:
 * a settlement booked against the wrong account can balance perfectly and
 * still be a lie about where the money went. The before/after balance of each
 * account the operation should NOT have touched is asserted too, because the
 * cheapest way to get a settlement wrong is to recognise income twice.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  asUser,
  asUserCommitted,
  createTestUser,
  type TestUser,
} from '../helpers/auth-fixtures';
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
  describe('agency settlement', () => {
    it.skip(`skipped - ${skipReason}`, () => undefined);
  });
}

interface Svc {
  readonly providerId: string;
  readonly typeId: string;
  readonly tillId: string | null;
  readonly floatCode: string | null;
  readonly payableCode: string | null;
}

describeDb('Phase 4C — agency settlement and reconciliation', () => {
  let ownerHO: TestUser;
  let mgrA: TestUser;
  let secA: TestUser;
  let mgrB: TestUser;
  let branchA: string;
  let branchB: string;
  let cashA: string;
  let bankA: string;

  /** An opening balance into one account, balanced against capital. */
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
          'settlement fixture')`,
      [code, amount, `fixture ${code}`],
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

  async function accountId(code: string): Promise<string> {
    return (
      await queryOne<{ id: string }>(
        `select id from public.ledger_accounts where code = $1`,
        [code],
      )
    ).id;
  }

  /** The exact lines of one entry, in line order. */
  async function linesOf(
    entryId: string,
  ): Promise<{ code: string; debit: number; credit: number }[]> {
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

  async function provider(opts: {
    code: string;
    branch: string;
    floatModel?: 'provider_float' | 'cash_payable';
    payable?: string;
    model?: 'deferred' | 'immediate';
    rateBps?: number;
    direction?: 'deposit' | 'withdrawal' | 'payment';
  }): Promise<Svc> {
    const floatModel = opts.floatModel ?? 'provider_float';
    const pr = await queryOne<{ id: string }>(
      `insert into public.agency_service_providers
         (code, name, category, float_model, payable_account_id, income_account_id,
          commission_model, commission_rate_bps, commission_fixed,
          is_provisional, is_active)
       values ($1, $1, $2, $3,
               (select id from public.ledger_accounts where code = $4),
               (select id from public.ledger_accounts where code = '4510'),
               $5, $6, case when $6::int is null then 0 else null end, false, true)
       returning id`,
      [
        opts.code,
        floatModel === 'cash_payable' ? 'agency_banking' : 'mobile_money',
        floatModel,
        opts.payable ?? null,
        opts.model ?? 'deferred',
        opts.rateBps ?? null,
      ],
    );
    const ty = await queryOne<{ id: string }>(
      `insert into public.agency_transaction_types
         (provider_id, code, name, direction, max_single_transaction)
       values ($1, 'OP', 'op', $2, 500000000) returning id`,
      [pr.id, opts.direction ?? 'deposit'],
    );
    let tillId: string | null = null;
    let floatCode: string | null = null;
    if (floatModel === 'provider_float') {
      tillId = (
        await queryOne<{ id: string }>(
          `select public.ensure_agency_float_account($1, $2) as id`,
          [pr.id, opts.branch],
        )
      ).id;
      floatCode = (
        await queryOne<{ code: string }>(
          `select a.code from public.agency_provider_float_accounts f
             join public.ledger_accounts a on a.id = f.ledger_account_id
            where f.id = $1`,
          [tillId],
        )
      ).code;
    }
    return {
      providerId: pr.id,
      typeId: ty.id,
      tillId,
      floatCode,
      payableCode: opts.payable ?? null,
    };
  }

  /** Posts one agency transaction, so commission accrues or a payable builds. */
  async function post(
    svc: Svc,
    amount: number,
    who: TestUser = secA,
    verifier: TestUser = mgrA,
  ): Promise<string> {
    const key = `C-${Math.random().toString(36).slice(2, 12)}`;
    const c = await asUserCommitted(who, [
      {
        sql: `select public.create_agency_transaction($1,$2,$3,'+256770006000','C',$4,0,null,null,null,$4) as id`,
        params: [svc.typeId, amount, svc.tillId, key],
      },
    ]);
    expect(c.ok, c.message).toBe(true);
    const id = (c.rows[0] as { id: string }).id;
    const s = await asUserCommitted(who, [
      { sql: `select public.submit_agency_transaction($1)`, params: [id] },
    ]);
    expect(s.ok, s.message).toBe(true);
    const v = await asUserCommitted(verifier, [
      { sql: `select public.verify_agency_transaction($1)`, params: [id] },
    ]);
    expect(v.ok, v.message).toBe(true);
    return id;
  }

  async function outstandingCommission(
    providerId: string,
    branch: string,
  ): Promise<number> {
    return Number(
      (
        await queryOne<{ v: string }>(
          `select public.agency_commission_outstanding($1,$2)::text as v`,
          [providerId, branch],
        )
      ).v,
    );
  }

  async function outstandingPayable(providerId: string, branch: string): Promise<number> {
    return Number(
      (
        await queryOne<{ v: string }>(
          `select public.agency_payable_outstanding($1,$2)::text as v`,
          [providerId, branch],
        )
      ).v,
    );
  }

  beforeAll(async () => {
    ownerHO = await createTestUser('owner_admin');
    mgrA = await createTestUser('manager');
    secA = await createTestUser('secretary_treasurer');
    mgrB = await createTestUser('manager');

    branchA = (
      await queryOne<{ id: string }>(
        `select id from public.branches order by branch_code limit 1`,
      )
    ).id;
    branchB = (
      await queryOne<{ id: string }>(
        `insert into public.branches (branch_code, name, location, status, opened_on)
         values ('BRSET9','Settlement Branch B','Testing','active',current_date)
         returning id`,
      )
    ).id;

    await query(
      `insert into public.ledger_accounts
         (code, name, account_type, normal_side, cash_kind, branch_id, is_postable, status)
       values ('1010-BRSET9','Cash at Hand — Settlement Branch B','asset','debit',
               'cash_at_hand',$1,true,'active')`,
      [branchB],
    );

    await query(`update public.profiles set branch_id = $1 where id = any($2::uuid[])`, [
      branchA,
      [mgrA.profileId, secA.profileId],
    ]);
    await query(`update public.profiles set branch_id = $1 where id = $2`, [
      branchB,
      mgrB.profileId,
    ]);
    await query(`update public.profiles set branch_id = null where id = $1`, [
      ownerHO.profileId,
    ]);

    cashA = await accountId('1010-BR2601');
    bankA = await accountId('1040-BR2601');

    await fund('1010-BR2601', 500_000_000);
    await fund('1040-BR2601', 500_000_000);
    await fund('1010-BRSET9', 50_000_000);
  });

  afterAll(async () => {
    await closePool();
  });

  // =========================================================================
  describe('deferred commission settlement (Task 2)', () => {
    it('posts Dr receiving account, Cr 1310, and recognises no income again', async () => {
      const svc = await provider({
        code: 'SETC1',
        branch: branchA,
        rateBps: 150,
      });
      await fund(svc.floatCode as string, 10_000_000);

      const incomeBefore = await balance('4510');
      await post(svc, 100_000); // accrues 1,500 commission
      const incomeAfterAccrual = await balance('4510');
      expect(incomeAfterAccrual - incomeBefore).toBe(1_500);
      expect(await outstandingCommission(svc.providerId, branchA)).toBe(1_500);

      const cashBefore = await balance('1010-BR2601');
      const r = await asUserCommitted(mgrA, [
        {
          sql: `select public.record_commission_settlement($1,$2,$3,$4,$5) as id`,
          params: [svc.providerId, branchA, 1_500, cashA, 'STMT-SETC1-1'],
        },
      ]);
      expect(r.ok, r.message).toBe(true);
      const id = (r.rows[0] as { id: string }).id;

      const s = await queryOne<{ e: string }>(
        `select journal_entry_id::text as e
           from public.agency_commission_settlements where id = $1`,
        [id],
      );
      expect(await linesOf(s.e)).toEqual([
        { code: '1010-BR2601', debit: 1_500, credit: 0 },
        { code: '1310', debit: 0, credit: 1_500 },
      ]);

      // The receivable is cleared, the cash arrived, and 4510 did NOT move:
      // the income was recognised at accrual and a settlement only converts
      // a receivable into cash.
      expect(await outstandingCommission(svc.providerId, branchA)).toBe(0);
      expect((await balance('1010-BR2601')) - cashBefore).toBe(1_500);
      expect(await balance('4510')).toBe(incomeAfterAccrual);

      const tb = await queryOne<{ d: string; c: string }>(
        `select sum(total_debit)::text as d, sum(total_credit)::text as c
           from public.trial_balance`,
      );
      expect(tb.d).toBe(tb.c);
    });

    it('settles partially and leaves the remainder outstanding', async () => {
      const svc = await provider({
        code: 'SETC2',
        branch: branchA,
        rateBps: 500,
      });
      await fund(svc.floatCode as string, 10_000_000);
      await post(svc, 200_000); // 10,000 commission
      expect(await outstandingCommission(svc.providerId, branchA)).toBe(10_000);

      const r = await asUserCommitted(mgrA, [
        {
          sql: `select public.record_commission_settlement($1,$2,$3,$4,$5)`,
          params: [svc.providerId, branchA, 4_000, cashA, 'STMT-SETC2-1'],
        },
      ]);
      expect(r.ok, r.message).toBe(true);
      expect(await outstandingCommission(svc.providerId, branchA)).toBe(6_000);

      // And the rest can follow.
      const r2 = await asUserCommitted(mgrA, [
        {
          sql: `select public.record_commission_settlement($1,$2,$3,$4,$5)`,
          params: [svc.providerId, branchA, 6_000, cashA, 'STMT-SETC2-2'],
        },
      ]);
      expect(r2.ok, r2.message).toBe(true);
      expect(await outstandingCommission(svc.providerId, branchA)).toBe(0);
    });

    it('refuses more than is outstanding, naming both figures', async () => {
      const svc = await provider({
        code: 'SETC3',
        branch: branchA,
        rateBps: 150,
      });
      await fund(svc.floatCode as string, 10_000_000);
      await post(svc, 100_000); // 1,500

      const r = await asUserCommitted(mgrA, [
        {
          sql: `select public.record_commission_settlement($1,$2,$3,$4,$5)`,
          params: [svc.providerId, branchA, 1_501, cashA, 'STMT-SETC3-1'],
        },
      ]);
      expect(r.ok).toBe(false);
      expect(r.message).toMatch(/1500 shillings of commission are outstanding/);
      expect(r.message).toContain('1501');
    });

    it('refuses zero and negative amounts', async () => {
      const svc = await provider({
        code: 'SETC4',
        branch: branchA,
        rateBps: 150,
      });
      for (const amount of [0, -5_000]) {
        const r = await asUserCommitted(mgrA, [
          {
            sql: `select public.record_commission_settlement($1,$2,$3,$4,null)`,
            params: [svc.providerId, branchA, amount, cashA],
          },
        ]);
        expect(r.ok, `amount ${amount}`).toBe(false);
        expect(r.message).toMatch(/positive number of shillings/i);
      }
    });

    it('refuses an immediate-commission provider outright', async () => {
      const svc = await provider({
        code: 'SETC5',
        branch: branchA,
        model: 'immediate',
        rateBps: 150,
      });
      const r = await asUserCommitted(mgrA, [
        {
          sql: `select public.record_commission_settlement($1,$2,$3,$4,null)`,
          params: [svc.providerId, branchA, 1_000, cashA],
        },
      ]);
      expect(r.ok).toBe(false);
      expect(r.message).toMatch(/settles its commission immediately/i);
    });

    it('refuses a duplicate provider statement reference', async () => {
      const svc = await provider({
        code: 'SETC6',
        branch: branchA,
        rateBps: 500,
      });
      await fund(svc.floatCode as string, 10_000_000);
      await post(svc, 200_000); // 10,000

      const first = await asUserCommitted(mgrA, [
        {
          sql: `select public.record_commission_settlement($1,$2,$3,$4,$5)`,
          params: [svc.providerId, branchA, 2_000, cashA, 'STMT-DUP-6'],
        },
      ]);
      expect(first.ok, first.message).toBe(true);

      const again = await asUserCommitted(mgrA, [
        {
          sql: `select public.record_commission_settlement($1,$2,$3,$4,$5)`,
          params: [svc.providerId, branchA, 2_000, cashA, 'STMT-DUP-6'],
        },
      ]);
      expect(again.ok).toBe(false);
      expect(again.message).toMatch(/already records statement reference/i);
      expect(await outstandingCommission(svc.providerId, branchA)).toBe(8_000);
    });

    it('refuses receiving accounts that are not the branch cash or bank', async () => {
      const svc = await provider({
        code: 'SETC7',
        branch: branchA,
        rateBps: 500,
      });
      await fund(svc.floatCode as string, 10_000_000);
      await post(svc, 200_000);

      const cases: [string, RegExp][] = [
        ['1020-BR2601', /cannot be used as the receiving account/i], // MTN wallet
        ['1030-BR2601', /cannot be used as the receiving account/i], // Airtel wallet
        ['1010-BRSET9', /does not belong to the branch/i], // other branch
        [svc.floatCode as string, /cannot be used as the receiving account/i],
      ];
      for (const [code, expected] of cases) {
        const r = await asUserCommitted(mgrA, [
          {
            sql: `select public.record_commission_settlement($1,$2,$3,
                    (select id from public.ledger_accounts where code = $4), null)`,
            params: [svc.providerId, branchA, 1_000, code],
          },
        ]);
        expect(r.ok, code).toBe(false);
        expect(r.message, code).toMatch(expected);
      }
      // 1310 untouched by any of them.
      expect(await outstandingCommission(svc.providerId, branchA)).toBe(10_000);
    });

    it('refuses a branch the caller cannot see, as it refuses an unknown provider', async () => {
      const svc = await provider({
        code: 'SETC8',
        branch: branchA,
        rateBps: 500,
      });
      await fund(svc.floatCode as string, 10_000_000);
      await post(svc, 200_000);

      const crossBranch = await asUser(
        mgrB,
        `select public.record_commission_settlement($1,$2,$3,$4,null)`,
        [svc.providerId, branchA, 1_000, cashA],
      );
      expect(crossBranch.ok).toBe(false);
      expect(crossBranch.code).toBe('42501');

      const unknown = await asUser(
        mgrB,
        `select public.record_commission_settlement(
           '00000000-0000-0000-0000-000000000000'::uuid,$1,$2,$3,null)`,
        [branchA, 1_000, cashA],
      );
      expect(unknown.ok).toBe(false);
      // Identical refusal, so neither discloses whether the provider exists.
      expect(unknown.message).toBe(crossBranch.message);
    });

    it('refuses a secretary, who holds no settlement authority', async () => {
      const svc = await provider({
        code: 'SETC9',
        branch: branchA,
        rateBps: 500,
      });
      const r = await asUser(
        secA,
        `select public.record_commission_settlement($1,$2,$3,$4,null)`,
        [svc.providerId, branchA, 1_000, cashA],
      );
      expect(r.ok).toBe(false);
      expect(r.code).toBe('42501');
      expect(r.message).toMatch(/agency:settlements/);
    });

    it('records audit evidence naming the outstanding before and after', async () => {
      const svc = await provider({
        code: 'SETC10',
        branch: branchA,
        rateBps: 500,
      });
      await fund(svc.floatCode as string, 10_000_000);
      await post(svc, 200_000);

      const r = await asUserCommitted(mgrA, [
        {
          sql: `select public.record_commission_settlement($1,$2,$3,$4,$5) as id`,
          params: [svc.providerId, branchA, 3_000, cashA, 'STMT-AUDIT-10'],
        },
      ]);
      expect(r.ok, r.message).toBe(true);
      const id = (r.rows[0] as { id: string }).id;

      const a = await queryOne<{
        action: string;
        before: string;
        after: string;
      }>(
        `select action,
                (old_values->>'outstanding_before') as before,
                (new_values->>'outstanding_after') as after
           from public.audit_log
          where entity_type = 'agency_commission_settlement' and entity_id = $1`,
        [id],
      );
      expect(a.action).toBe('agency.commission_settled');
      expect(Number(a.before)).toBe(10_000);
      expect(Number(a.after)).toBe(7_000);
    });

    it('refuses the second of two concurrent settlements that together overdraw', async () => {
      const svc = await provider({
        code: 'SETC11',
        branch: branchA,
        rateBps: 500,
      });
      await fund(svc.floatCode as string, 10_000_000);
      await post(svc, 200_000); // 10,000 outstanding
      expect(await outstandingCommission(svc.providerId, branchA)).toBe(10_000);

      // Both racers would otherwise raise the same low-balance notification
      // and collide on notifications_dedupe_unique rather than on the lock
      // under test.
      await query(
        `update public.finance_settings
            set low_balance_agency_float = 0, low_balance_cash_at_hand = 0
          where id = 1`,
      );

      // Two settlements of 6,000 each: either alone fits, together they do not.
      const a = await getClient();
      const b = await getClient();
      try {
        for (const c of [a, b]) {
          await c.query('begin');
          // The singular claim form the other agency races use; the JSON
          // `claims` object is not what current_profile_id() reads here.
          await c.query(`select set_config('request.jwt.claim.sub', $1, true)`, [
            mgrA.authUserId,
          ]);
        }
        await a.query(
          `select public.record_commission_settlement($1,$2,6000,$3,'RACE-A')`,
          [svc.providerId, branchA, cashA],
        );

        // B now blocks on the provider lock A holds.
        const blocked = b.query(
          `select public.record_commission_settlement($1,$2,6000,$3,'RACE-B')`,
          [svc.providerId, branchA, cashA],
        );
        await a.query('commit');

        let refusal: string | null = null;
        try {
          await blocked;
        } catch (error) {
          refusal = (error as { message?: string }).message ?? 'unknown';
        }
        await b.query('rollback');

        expect(refusal).not.toBeNull();
        // Quoting 4,000 proves the read happened after the lock was granted,
        // on the balance A's commit left behind — not on the 10,000 B saw
        // when it started.
        expect(refusal).toMatch(/4000 shillings of commission are outstanding/);
      } finally {
        a.release();
        b.release();
      }

      expect(await outstandingCommission(svc.providerId, branchA)).toBe(4_000);
    });
  });

  // =========================================================================
  describe('payable settlement and its reversal (Task 3)', () => {
    /** A bank agency provider that has collected `amount` at `branch`. */
    async function collected(
      code: string,
      amount: number,
      branch = branchA,
    ): Promise<Svc> {
      const svc = await provider({
        code,
        branch,
        floatModel: 'cash_payable',
        payable: '2220',
        direction: 'deposit',
      });
      await post(svc, amount, branch === branchA ? secA : mgrB, mgrA);
      return svc;
    }

    it('posts Dr payable, Cr cash on its exact lines', async () => {
      const svc = await collected('SETP1', 200_000);
      expect(await outstandingPayable(svc.providerId, branchA)).toBe(200_000);
      const cashBefore = await balance('1010-BR2601');

      const r = await asUserCommitted(mgrA, [
        {
          sql: `select public.post_agency_payable_settlement($1,$2,$3,$4,$5) as id`,
          params: [svc.providerId, branchA, 200_000, cashA, 'RCPT-SETP1'],
        },
      ]);
      expect(r.ok, r.message).toBe(true);
      const id = (r.rows[0] as { id: string }).id;

      const row = await queryOne<{ e: string; status: string }>(
        `select journal_entry_id::text as e, status
           from public.agency_payable_settlements where id = $1`,
        [id],
      );
      expect(row.status).toBe('posted');
      expect(await linesOf(row.e)).toEqual([
        { code: '2220', debit: 200_000, credit: 0 },
        { code: '1010-BR2601', debit: 0, credit: 200_000 },
      ]);
      expect(await outstandingPayable(svc.providerId, branchA)).toBe(0);
      expect(cashBefore - (await balance('1010-BR2601'))).toBe(200_000);
    });

    it('refuses more than the provider holds, preserving the no-advance rule', async () => {
      const svc = await collected('SETP2', 100_000);
      const r = await asUserCommitted(mgrA, [
        {
          sql: `select public.post_agency_payable_settlement($1,$2,$3,$4,null)`,
          params: [svc.providerId, branchA, 100_001, cashA],
        },
      ]);
      expect(r.ok).toBe(false);
      expect(r.message).toMatch(/may not go into net debit/i);
      expect(r.message).toMatch(/Only 100000 shillings are held/);
      expect(await outstandingPayable(svc.providerId, branchA)).toBe(100_000);
    });

    it("does not let one bank's collections fund another's settlement", async () => {
      const b1 = await collected('SETP3', 400_000);
      const b2 = await provider({
        code: 'SETP4',
        branch: branchA,
        floatModel: 'cash_payable',
        payable: '2220',
        direction: 'deposit',
      });
      // b2 has collected nothing, though it shares account 2220 with b1.
      expect(await outstandingPayable(b2.providerId, branchA)).toBe(0);
      expect(await outstandingPayable(b1.providerId, branchA)).toBe(400_000);

      const r = await asUserCommitted(mgrA, [
        {
          sql: `select public.post_agency_payable_settlement($1,$2,$3,$4,null)`,
          params: [b2.providerId, branchA, 50_000, cashA],
        },
      ]);
      expect(r.ok).toBe(false);
      expect(r.message).toMatch(/Only 0 shillings are held/);
    });

    it("refuses a branch settling another branch's payable", async () => {
      const svc = await collected('SETP5', 150_000);
      const r = await asUser(
        mgrB,
        `select public.post_agency_payable_settlement($1,$2,$3,$4,null)`,
        [svc.providerId, branchA, 50_000, cashA],
      );
      expect(r.ok).toBe(false);
      expect(r.code).toBe('42501');
      expect(await outstandingPayable(svc.providerId, branchA)).toBe(150_000);
    });

    it('refuses a provider_float provider, which holds no payable', async () => {
      const svc = await provider({ code: 'SETP6', branch: branchA, rateBps: 150 });
      const r = await asUserCommitted(mgrA, [
        {
          sql: `select public.post_agency_payable_settlement($1,$2,$3,$4,null)`,
          params: [svc.providerId, branchA, 1_000, cashA],
        },
      ]);
      expect(r.ok).toBe(false);
      expect(r.message).toMatch(/no payable to settle/i);
    });

    it('refuses a duplicate receipt reference', async () => {
      const svc = await collected('SETP7', 300_000);
      const first = await asUserCommitted(mgrA, [
        {
          sql: `select public.post_agency_payable_settlement($1,$2,$3,$4,$5)`,
          params: [svc.providerId, branchA, 100_000, cashA, 'RCPT-DUP-7'],
        },
      ]);
      expect(first.ok, first.message).toBe(true);

      const again = await asUserCommitted(mgrA, [
        {
          sql: `select public.post_agency_payable_settlement($1,$2,$3,$4,$5)`,
          params: [svc.providerId, branchA, 100_000, cashA, 'RCPT-DUP-7'],
        },
      ]);
      expect(again.ok).toBe(false);
      expect(again.message).toMatch(/already records receipt reference/i);
      expect(await outstandingPayable(svc.providerId, branchA)).toBe(200_000);
    });

    it('reverses by contra entry, restoring both the cash and the liability', async () => {
      const svc = await collected('SETP8', 250_000);
      const posted = await asUserCommitted(mgrA, [
        {
          sql: `select public.post_agency_payable_settlement($1,$2,$3,$4,$5) as id`,
          params: [svc.providerId, branchA, 250_000, cashA, 'RCPT-SETP8'],
        },
      ]);
      expect(posted.ok, posted.message).toBe(true);
      const id = (posted.rows[0] as { id: string }).id;
      expect(await outstandingPayable(svc.providerId, branchA)).toBe(0);

      const cashBefore = await balance('1010-BR2601');
      const rev = await asUserCommitted(mgrA, [
        {
          sql: `select public.reverse_agency_payable_settlement($1,'cash never handed over') as e`,
          params: [id],
        },
      ]);
      expect(rev.ok, rev.message).toBe(true);
      const entry = (rev.rows[0] as { e: string }).e;

      expect(await linesOf(entry)).toEqual([
        { code: '1010-BR2601', debit: 250_000, credit: 0 },
        { code: '2220', debit: 0, credit: 250_000 },
      ]);
      expect((await balance('1010-BR2601')) - cashBefore).toBe(250_000);
      expect(await outstandingPayable(svc.providerId, branchA)).toBe(250_000);

      // The original row is kept and annotated, never deleted or rewritten.
      const row = await queryOne<{
        status: string;
        by: string;
        reason: string;
        amount: string;
      }>(
        `select status, reversed_by::text as by, reversal_reason as reason,
                settlement_amount::text as amount
           from public.agency_payable_settlements where id = $1`,
        [id],
      );
      expect(row.status).toBe('reversed');
      expect(row.by).toBe(mgrA.profileId);
      expect(row.reason).toBe('cash never handed over');
      expect(Number(row.amount)).toBe(250_000);
    });

    it('refuses the reversal to a secretary and refuses reversing twice', async () => {
      const svc = await collected('SETP9', 120_000);
      const posted = await asUserCommitted(mgrA, [
        {
          sql: `select public.post_agency_payable_settlement($1,$2,$3,$4,$5) as id`,
          params: [svc.providerId, branchA, 120_000, cashA, 'RCPT-SETP9'],
        },
      ]);
      expect(posted.ok, posted.message).toBe(true);
      const id = (posted.rows[0] as { id: string }).id;

      const bySec = await asUser(
        secA,
        `select public.reverse_agency_payable_settlement($1,'no authority')`,
        [id],
      );
      expect(bySec.ok).toBe(false);
      expect(bySec.code).toBe('42501');
      expect(bySec.message).toMatch(/agency:reverse/);

      const first = await asUserCommitted(mgrA, [
        {
          sql: `select public.reverse_agency_payable_settlement($1,'first')`,
          params: [id],
        },
      ]);
      expect(first.ok, first.message).toBe(true);

      const second = await asUserCommitted(mgrA, [
        {
          sql: `select public.reverse_agency_payable_settlement($1,'again')`,
          params: [id],
        },
      ]);
      expect(second.ok).toBe(false);
      expect(second.message).toMatch(/already reversed/i);
    });

    it('requires a reason for the reversal', async () => {
      const svc = await collected('SETP10', 90_000);
      const posted = await asUserCommitted(mgrA, [
        {
          sql: `select public.post_agency_payable_settlement($1,$2,$3,$4,null) as id`,
          params: [svc.providerId, branchA, 90_000, cashA],
        },
      ]);
      expect(posted.ok, posted.message).toBe(true);
      const r = await asUserCommitted(mgrA, [
        {
          sql: `select public.reverse_agency_payable_settlement($1,'   ')`,
          params: [(posted.rows[0] as { id: string }).id],
        },
      ]);
      expect(r.ok).toBe(false);
      expect(r.message).toMatch(/needs a reason/i);
    });

    it('serialises a concurrent withdrawal and settlement against one payable', async () => {
      // 100,000 collected. A withdrawal of 60,000 and a settlement of 60,000
      // each fit; together they would drive the payable to -20,000.
      const svc = await collected('SETP11', 100_000);
      const withdrawType = await queryOne<{ id: string }>(
        `insert into public.agency_transaction_types
           (provider_id, code, name, direction, max_single_transaction)
         values ($1,'WDR','wdr','withdrawal',500000000) returning id`,
        [svc.providerId],
      );
      await query(
        `update public.finance_settings
            set low_balance_agency_float = 0, low_balance_cash_at_hand = 0
          where id = 1`,
      );

      // A withdrawal, left submitted so a verification can race the settlement.
      const key = `W-${Math.random().toString(36).slice(2, 12)}`;
      const c = await asUserCommitted(secA, [
        {
          sql: `select public.create_agency_transaction($1,$2,null,'+256770006001','C',$3,0,null,null,null,$3) as id`,
          params: [withdrawType.id, 60_000, key],
        },
      ]);
      expect(c.ok, c.message).toBe(true);
      const wid = (c.rows[0] as { id: string }).id;
      const sub = await asUserCommitted(secA, [
        { sql: `select public.submit_agency_transaction($1)`, params: [wid] },
      ]);
      expect(sub.ok, sub.message).toBe(true);

      const a = await getClient();
      const b = await getClient();
      try {
        for (const cl of [a, b]) {
          await cl.query('begin');
          await cl.query(`select set_config('request.jwt.claim.sub',$1,true)`, [
            mgrA.authUserId,
          ]);
        }
        // A verifies the withdrawal: payable 100,000 -> 40,000.
        await a.query(`select public.verify_agency_transaction($1)`, [wid]);

        // B settles 60,000, and must block until A commits.
        const blocked = b.query(
          `select public.post_agency_payable_settlement($1,$2,60000,$3,'RACE-P')`,
          [svc.providerId, branchA, cashA],
        );
        await a.query('commit');

        let refusal: string | null = null;
        try {
          await blocked;
        } catch (error) {
          refusal = (error as { message?: string }).message ?? 'unknown';
        }
        await b.query('rollback');

        expect(refusal).not.toBeNull();
        // 40,000 is the balance A's commit left, not the 100,000 B started on.
        expect(refusal).toMatch(/Only 40000 shillings are held/);
      } finally {
        a.release();
        b.release();
      }

      expect(await outstandingPayable(svc.providerId, branchA)).toBe(40_000);
    });
  });

  // =========================================================================
  describe('float replenishment (Task 4)', () => {
    it('posts Dr float, Cr funding account on its exact lines', async () => {
      const svc = await provider({ code: 'SETF1', branch: branchA, rateBps: 150 });
      const bankBefore = await balance('1040-BR2601');
      const floatBefore = await balance(svc.floatCode as string);

      const r = await asUserCommitted(mgrA, [
        {
          sql: `select public.post_float_replenishment($1,$2,$3,$4) as id`,
          params: [svc.tillId, 500_000, bankA, 'MTN-TOPUP-1'],
        },
      ]);
      expect(r.ok, r.message).toBe(true);
      const id = (r.rows[0] as { id: string }).id;

      const row = await queryOne<{ e: string; amount: string }>(
        `select journal_entry_id::text as e, amount::text as amount
           from public.agency_float_replenishments where id = $1`,
        [id],
      );
      expect(Number(row.amount)).toBe(500_000);
      expect(await linesOf(row.e)).toEqual([
        { code: svc.floatCode as string, debit: 500_000, credit: 0 },
        { code: '1040-BR2601', debit: 0, credit: 500_000 },
      ]);
      expect((await balance(svc.floatCode as string)) - floatBefore).toBe(500_000);
      expect(bankBefore - (await balance('1040-BR2601'))).toBe(500_000);
    });

    it('leaves lending income, loan receivables and the money wallets untouched', async () => {
      const svc = await provider({ code: 'SETF2', branch: branchA, rateBps: 150 });
      const before = {
        loanReceivable: await balance('1200'),
        mtnWallet: await balance('1020-BR2601'),
        airtelWallet: await balance('1030-BR2601'),
        interest: await balance('4100'),
      };

      const r = await asUserCommitted(mgrA, [
        {
          sql: `select public.post_float_replenishment($1,$2,$3,$4)`,
          params: [svc.tillId, 250_000, bankA, 'MTN-TOPUP-2'],
        },
      ]);
      expect(r.ok, r.message).toBe(true);

      expect(await balance('1200')).toBe(before.loanReceivable);
      expect(await balance('1020-BR2601')).toBe(before.mtnWallet);
      expect(await balance('1030-BR2601')).toBe(before.airtelWallet);
      expect(await balance('4100')).toBe(before.interest);
    });

    it('replenishes one provider several tills independently', async () => {
      const svc = await provider({ code: 'SETF3', branch: branchA, rateBps: 150 });
      const second = await queryOne<{ id: string }>(
        `select public.ensure_agency_float_account($1,$2,'second-till') as id`,
        [svc.providerId, branchA],
      );
      expect(second.id).not.toBe(svc.tillId);
      const secondCode = (
        await queryOne<{ code: string }>(
          `select a.code from public.agency_provider_float_accounts f
             join public.ledger_accounts a on a.id = f.ledger_account_id
            where f.id = $1`,
          [second.id],
        )
      ).code;

      const firstBefore = await balance(svc.floatCode as string);
      const r = await asUserCommitted(mgrA, [
        {
          sql: `select public.post_float_replenishment($1,$2,$3,$4)`,
          params: [second.id, 300_000, bankA, 'MTN-TOPUP-3'],
        },
      ]);
      expect(r.ok, r.message).toBe(true);

      expect(await balance(secondCode)).toBe(300_000);
      expect(await balance(svc.floatCode as string)).toBe(firstBefore);
    });

    it('refuses prohibited funding accounts', async () => {
      const svc = await provider({ code: 'SETF4', branch: branchA, rateBps: 150 });
      const other = await provider({ code: 'SETF5', branch: branchA, rateBps: 150 });

      const cases: [string, RegExp][] = [
        ['1020-BR2601', /cannot be used as the funding account/i],
        ['1030-BR2601', /cannot be used as the funding account/i],
        ['1010-BRSET9', /does not belong to the branch/i],
        [other.floatCode as string, /cannot be used as the funding account/i],
        ['1310', /cannot be used as the funding account/i],
      ];
      for (const [code, expected] of cases) {
        const r = await asUserCommitted(mgrA, [
          {
            sql: `select public.post_float_replenishment($1,$2,
                    (select id from public.ledger_accounts where code = $3), null)`,
            params: [svc.tillId, 10_000, code],
          },
        ]);
        expect(r.ok, code).toBe(false);
        expect(r.message, code).toMatch(expected);
      }
      expect(await balance(svc.floatCode as string)).toBe(0);
    });

    it('refuses a secretary, a non-positive amount and a duplicate reference', async () => {
      const svc = await provider({ code: 'SETF6', branch: branchA, rateBps: 150 });

      const bySec = await asUser(
        secA,
        `select public.post_float_replenishment($1,$2,$3,null)`,
        [svc.tillId, 10_000, bankA],
      );
      expect(bySec.ok).toBe(false);
      expect(bySec.code).toBe('42501');
      expect(bySec.message).toMatch(/agency:settlements/);

      for (const amount of [0, -10_000]) {
        const r = await asUserCommitted(mgrA, [
          {
            sql: `select public.post_float_replenishment($1,$2,$3,null)`,
            params: [svc.tillId, amount, bankA],
          },
        ]);
        expect(r.ok, `amount ${amount}`).toBe(false);
        expect(r.message).toMatch(/positive number of shillings/i);
      }

      const first = await asUserCommitted(mgrA, [
        {
          sql: `select public.post_float_replenishment($1,$2,$3,$4)`,
          params: [svc.tillId, 40_000, bankA, 'MTN-DUP-6'],
        },
      ]);
      expect(first.ok, first.message).toBe(true);
      const again = await asUserCommitted(mgrA, [
        {
          sql: `select public.post_float_replenishment($1,$2,$3,$4)`,
          params: [svc.tillId, 40_000, bankA, 'MTN-DUP-6'],
        },
      ]);
      expect(again.ok).toBe(false);
      expect(again.message).toMatch(/already records reference/i);
      expect(await balance(svc.floatCode as string)).toBe(40_000);
    });

    it('refuses a till at a branch the caller cannot see', async () => {
      const svc = await provider({ code: 'SETF7', branch: branchA, rateBps: 150 });
      const r = await asUser(
        mgrB,
        `select public.post_float_replenishment($1,$2,$3,null)`,
        [svc.tillId, 10_000, bankA],
      );
      expect(r.ok).toBe(false);
      expect(r.code).toBe('42501');
      expect(r.message).toMatch(/No agency float till with that identifier/i);
    });

    it('refuses more funding than the account holds', async () => {
      const svc = await provider({ code: 'SETF8', branch: branchA, rateBps: 150 });
      const available = await balance('1040-BR2601');
      const r = await asUserCommitted(mgrA, [
        {
          sql: `select public.post_float_replenishment($1,$2,$3,null)`,
          params: [svc.tillId, available + 1, bankA],
        },
      ]);
      expect(r.ok).toBe(false);
      expect(r.message).toMatch(/holds \d+ shillings/);
      expect(await balance(svc.floatCode as string)).toBe(0);
    });
  });
});
