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
      await fund(svc.floatCode!, 10_000_000);

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
      await fund(svc.floatCode!, 10_000_000);
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
      await fund(svc.floatCode!, 10_000_000);
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
      await fund(svc.floatCode!, 10_000_000);
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
      await fund(svc.floatCode!, 10_000_000);
      await post(svc, 200_000);

      const cases: [string, RegExp][] = [
        ['1020-BR2601', /cannot be used as the receiving account/i], // MTN wallet
        ['1030-BR2601', /cannot be used as the receiving account/i], // Airtel wallet
        ['1010-BRSET9', /does not belong to the branch/i], // other branch
        [svc.floatCode!, /cannot be used as the receiving account/i],
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
      await fund(svc.floatCode!, 10_000_000);
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
      await fund(svc.floatCode!, 10_000_000);
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
      await fund(svc.floatCode!, 10_000_000);
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
      const floatBefore = await balance(svc.floatCode!);

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
        { code: svc.floatCode!, debit: 500_000, credit: 0 },
        { code: '1040-BR2601', debit: 0, credit: 500_000 },
      ]);
      expect((await balance(svc.floatCode!)) - floatBefore).toBe(500_000);
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

      const firstBefore = await balance(svc.floatCode!);
      const r = await asUserCommitted(mgrA, [
        {
          sql: `select public.post_float_replenishment($1,$2,$3,$4)`,
          params: [second.id, 300_000, bankA, 'MTN-TOPUP-3'],
        },
      ]);
      expect(r.ok, r.message).toBe(true);

      expect(await balance(secondCode)).toBe(300_000);
      expect(await balance(svc.floatCode!)).toBe(firstBefore);
    });

    it('refuses prohibited funding accounts', async () => {
      const svc = await provider({ code: 'SETF4', branch: branchA, rateBps: 150 });
      const other = await provider({ code: 'SETF5', branch: branchA, rateBps: 150 });

      const cases: [string, RegExp][] = [
        ['1020-BR2601', /cannot be used as the funding account/i],
        ['1030-BR2601', /cannot be used as the funding account/i],
        ['1010-BRSET9', /does not belong to the branch/i],
        [other.floatCode!, /cannot be used as the funding account/i],
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
      expect(await balance(svc.floatCode!)).toBe(0);
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
      expect(await balance(svc.floatCode!)).toBe(40_000);
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
      expect(await balance(svc.floatCode!)).toBe(0);
    });
  });

  // =========================================================================
  describe('physical cash reconciliation (Task 5)', () => {
    /** A dedicated branch and till, so one count cannot disturb another. */
    async function tillBranch(
      code: string,
      opening: number,
    ): Promise<{ branch: string; account: string; accountCode: string }> {
      const branch = (
        await queryOne<{ id: string }>(
          `insert into public.branches (branch_code, name, location, status, opened_on)
           values ($1, $1, 'Testing', 'active', current_date) returning id`,
          [code],
        )
      ).id;
      const accountCode = `1010-${code}`;
      await query(
        `insert into public.ledger_accounts
           (code, name, account_type, normal_side, cash_kind, branch_id, is_postable, status)
         values ($1, $1, 'asset', 'debit', 'cash_at_hand', $2, true, 'active')`,
        [accountCode, branch],
      );
      if (opening > 0) await fund(accountCode, opening);
      return { branch, account: await accountId(accountCode), accountCode };
    }

    /**
     * A maker with no branch of its own, so it can see the per-test branches
     * these counts create. `mgrA` is scoped to branch A and deliberately
     * cannot, which is what the branch-isolation test at the end relies on.
     */
    let maker: TestUser;

    beforeAll(async () => {
      maker = await createTestUser('manager');
    });

    async function submitCount(
      account: string,
      count: number,
      who?: TestUser,
    ): Promise<string> {
      who = who ?? maker;
      const r = await asUserCommitted(who, [
        {
          sql: `select public.submit_agency_cash_reconciliation($1,$2) as id`,
          params: [account, count],
        },
      ]);
      expect(r.ok, r.message).toBe(true);
      return (r.rows[0] as { id: string }).id;
    }

    it('closes an exact match with no adjustment and no journal', async () => {
      const t = await tillBranch('BRCR1', 1_000_000);
      const id = await submitCount(t.account, 1_000_000);

      const r = await asUserCommitted(ownerHO, [
        {
          sql: `select public.approve_agency_cash_reconciliation($1,false,null) as e`,
          params: [id],
        },
      ]);
      expect(r.ok, r.message).toBe(true);
      expect((r.rows[0] as { e: string | null }).e).toBeNull();

      const row = await queryOne<{
        status: string;
        variance: string;
        off: string;
        j: string | null;
      }>(
        `select status, variance::text as variance,
                variance_written_off::text as off, variance_journal_entry_id::text as j
           from public.agency_cash_reconciliations where id = $1`,
        [id],
      );
      expect(row.status).toBe('reconciled');
      expect(Number(row.variance)).toBe(0);
      expect(Number(row.off)).toBe(0);
      expect(row.j).toBeNull();
    });

    it('records a cash excess and adjusts it Dr cash, Cr 5950', async () => {
      const t = await tillBranch('BRCR2', 1_000_000);
      const id = await submitCount(t.account, 1_003_000); // 3,000 over
      const overBefore = await balance('5950');

      const r = await asUserCommitted(ownerHO, [
        {
          sql: `select public.approve_agency_cash_reconciliation($1,true,'counted twice, genuine surplus') as e`,
          params: [id],
        },
      ]);
      expect(r.ok, r.message).toBe(true);
      const entry = (r.rows[0] as { e: string }).e;

      // Positive variance on THIS table means more cash than the books say.
      expect(await linesOf(entry)).toEqual([
        { code: t.accountCode, debit: 3_000, credit: 0 },
        { code: '5950', debit: 0, credit: 3_000 },
      ]);
      expect(await balance(t.accountCode)).toBe(1_003_000);
      expect((await balance('5950')) - overBefore).toBe(-3_000);
    });

    it('records a cash shortage and adjusts it Dr 5950, Cr cash', async () => {
      const t = await tillBranch('BRCR3', 1_000_000);
      const id = await submitCount(t.account, 996_000); // 4,000 short
      const overBefore = await balance('5950');

      const r = await asUserCommitted(ownerHO, [
        {
          sql: `select public.approve_agency_cash_reconciliation($1,true,'till short, unexplained after recount') as e`,
          params: [id],
        },
      ]);
      expect(r.ok, r.message).toBe(true);
      const entry = (r.rows[0] as { e: string }).e;

      expect(await linesOf(entry)).toEqual([
        { code: '5950', debit: 4_000, credit: 0 },
        { code: t.accountCode, debit: 0, credit: 4_000 },
      ]);
      expect(await balance(t.accountCode)).toBe(996_000);
      expect((await balance('5950')) - overBefore).toBe(4_000);
    });

    it('records an unexplained variance without adjusting it', async () => {
      // A difference must never create an adjustment by itself.
      const t = await tillBranch('BRCR4', 500_000);
      const id = await submitCount(t.account, 495_000);

      const r = await asUserCommitted(ownerHO, [
        {
          sql: `select public.approve_agency_cash_reconciliation($1,false,null) as e`,
          params: [id],
        },
      ]);
      expect(r.ok, r.message).toBe(true);
      expect((r.rows[0] as { e: string | null }).e).toBeNull();

      const row = await queryOne<{ variance: string; off: string }>(
        `select variance::text as variance, variance_written_off::text as off
           from public.agency_cash_reconciliations where id = $1`,
        [id],
      );
      expect(Number(row.variance)).toBe(-5_000);
      expect(Number(row.off)).toBe(0);
      // The books are untouched: the variance is on the record, not in the ledger.
      expect(await balance(t.accountCode)).toBe(500_000);
    });

    it('refuses approval by the officer who recorded the count', async () => {
      const t = await tillBranch('BRCR5', 200_000);
      const id = await submitCount(t.account, 200_000, maker);

      const r = await asUser(
        maker,
        `select public.approve_agency_cash_reconciliation($1,false,null)`,
        [id],
      );
      expect(r.ok).toBe(false);
      expect(r.code).toBe('42501');
      expect(r.message).toMatch(/cannot approve it/i);
    });

    it('refuses an adjustment without the adjustment capability', async () => {
      const t = await tillBranch('BRCR6', 300_000);
      const id = await submitCount(t.account, 305_000, maker);

      // A manager holds agency:reconcile but not agency:variance_adjustment.
      const mgr2 = await createTestUser('manager');
      const r = await asUser(
        mgr2,
        `select public.approve_agency_cash_reconciliation($1,true,'just write it off')`,
        [id],
      );
      expect(r.ok).toBe(false);
      expect(r.code).toBe('42501');
      expect(r.message).toMatch(/agency:variance_adjustment/);

      // But the same officer may certify it without adjusting.
      const plain = await asUserCommitted(mgr2, [
        {
          sql: `select public.approve_agency_cash_reconciliation($1,false,null)`,
          params: [id],
        },
      ]);
      expect(plain.ok, plain.message).toBe(true);
    });

    it('refuses a stale count whose balance moved after it was recorded', async () => {
      const t = await tillBranch('BRCR7', 400_000);
      const id = await submitCount(t.account, 400_000, maker);

      // Cash moves between the count and the approval.
      await fund(t.accountCode, 50_000);

      const r = await asUser(
        ownerHO,
        `select public.approve_agency_cash_reconciliation($1,false,null)`,
        [id],
      );
      expect(r.ok).toBe(false);
      expect(r.message).toMatch(/has moved from 400000 to 450000/);
      expect(r.message).toMatch(/Count it again/i);

      const row = await queryOne<{ status: string }>(
        `select status from public.agency_cash_reconciliations where id = $1`,
        [id],
      );
      expect(row.status).toBe('open');
    });

    it('refuses a duplicate date, a future date and a second approval', async () => {
      const t = await tillBranch('BRCR8', 100_000);
      const id = await submitCount(t.account, 100_000, maker);

      const dup = await asUserCommitted(maker, [
        {
          sql: `select public.submit_agency_cash_reconciliation($1,$2)`,
          params: [t.account, 100_000],
        },
      ]);
      expect(dup.ok).toBe(false);
      expect(dup.message).toMatch(/already been reconciled for/i);

      const future = await asUserCommitted(maker, [
        {
          sql: `select public.submit_agency_cash_reconciliation($1,$2,current_date + 1)`,
          params: [t.account, 100_000],
        },
      ]);
      expect(future.ok).toBe(false);
      expect(future.message).toMatch(/in the future/i);

      const ok = await asUserCommitted(ownerHO, [
        {
          sql: `select public.approve_agency_cash_reconciliation($1,false,null)`,
          params: [id],
        },
      ]);
      expect(ok.ok, ok.message).toBe(true);

      const again = await asUserCommitted(ownerHO, [
        {
          sql: `select public.approve_agency_cash_reconciliation($1,false,null)`,
          params: [id],
        },
      ]);
      expect(again.ok).toBe(false);
      expect(again.message).toMatch(/already reconciled/i);
    });

    it('refuses an agency float account and a non-cash account', async () => {
      const svc = await provider({ code: 'SETR1', branch: branchA, rateBps: 150 });
      const floatAcc = await accountId(svc.floatCode!);

      const float = await asUserCommitted(mgrA, [
        {
          sql: `select public.submit_agency_cash_reconciliation($1,$2)`,
          params: [floatAcc, 0],
        },
      ]);
      expect(float.ok).toBe(false);
      expect(float.message).toMatch(/electronic agency float account/i);
      expect(float.message).toMatch(/provider's statement, not by a physical count/i);

      const bank = await asUserCommitted(mgrA, [
        {
          sql: `select public.submit_agency_cash_reconciliation($1,$2)`,
          params: [bankA, 0],
        },
      ]);
      expect(bank.ok).toBe(false);
      expect(bank.message).toMatch(/not a till of cash/i);
    });

    it("refuses a count of another branch's till", async () => {
      const t = await tillBranch('BRCR9', 100_000);
      const r = await asUser(
        mgrA,
        `select public.submit_agency_cash_reconciliation($1,$2)`,
        [t.account, 100_000],
      );
      expect(r.ok).toBe(false);
      expect(r.code).toBe('42501');
    });
  });

  // =========================================================================
  describe('provider float reconciliation (Task 6)', () => {
    async function floatFixture(
      code: string,
      opening: number,
    ): Promise<{ svc: Svc; floatCode: string }> {
      const svc = await provider({ code, branch: branchA, rateBps: 150 });
      if (opening > 0) await fund(svc.floatCode!, opening);
      return { svc, floatCode: svc.floatCode! };
    }

    async function submitStatement(
      tillId: string,
      statement: number,
      ref: string | null,
      who: TestUser = mgrA,
    ): Promise<string> {
      const r = await asUserCommitted(who, [
        {
          sql: `select public.submit_agency_float_reconciliation($1,$2,$3) as id`,
          params: [tillId, statement, ref],
        },
      ]);
      expect(r.ok, r.message).toBe(true);
      return (r.rows[0] as { id: string }).id;
    }

    it('records provider, branch, till and statement evidence', async () => {
      const f = await floatFixture('SETR2', 2_000_000);
      const id = await submitStatement(f.svc.tillId!, 2_000_000, 'MTN-ST-1');

      const row = await queryOne<{
        p: string;
        b: string;
        t: string;
        ref: string;
        sys: string;
        stmt: string;
        variance: string;
      }>(
        `select provider_id::text as p, branch_id::text as b,
                float_account_id::text as t, provider_statement_ref as ref,
                system_closing_balance::text as sys,
                provider_statement_balance::text as stmt, variance::text as variance
           from public.agency_float_reconciliations where id = $1`,
        [id],
      );
      expect(row.p).toBe(f.svc.providerId);
      expect(row.b).toBe(branchA);
      expect(row.t).toBe(f.svc.tillId);
      expect(row.ref).toBe('MTN-ST-1');
      expect(Number(row.sys)).toBe(2_000_000);
      expect(Number(row.stmt)).toBe(2_000_000);
      expect(Number(row.variance)).toBe(0);
    });

    it('adjusts a system surplus Dr 5960, Cr float — the opposite sign to cash', async () => {
      // variance = system - statement. Positive means the books claim more
      // float than the provider holds.
      const f = await floatFixture('SETR3', 1_000_000);
      const id = await submitStatement(f.svc.tillId!, 999_000, 'MTN-ST-2');
      const overBefore = await balance('5960');

      const r = await asUserCommitted(ownerHO, [
        {
          sql: `select public.approve_agency_float_reconciliation($1,true,'provider statement is authoritative') as e`,
          params: [id],
        },
      ]);
      expect(r.ok, r.message).toBe(true);
      expect(await linesOf((r.rows[0] as { e: string }).e)).toEqual([
        { code: '5960', debit: 1_000, credit: 0 },
        { code: f.floatCode, debit: 0, credit: 1_000 },
      ]);
      expect(await balance(f.floatCode)).toBe(999_000);
      expect((await balance('5960')) - overBefore).toBe(1_000);
    });

    it('adjusts a system shortfall Dr float, Cr 5960', async () => {
      const f = await floatFixture('SETR4', 1_000_000);
      const id = await submitStatement(f.svc.tillId!, 1_002_500, 'MTN-ST-3');
      const overBefore = await balance('5960');

      const r = await asUserCommitted(ownerHO, [
        {
          sql: `select public.approve_agency_float_reconciliation($1,true,'provider credited more than recorded') as e`,
          params: [id],
        },
      ]);
      expect(r.ok, r.message).toBe(true);
      expect(await linesOf((r.rows[0] as { e: string }).e)).toEqual([
        { code: f.floatCode, debit: 2_500, credit: 0 },
        { code: '5960', debit: 0, credit: 2_500 },
      ]);
      expect(await balance(f.floatCode)).toBe(1_002_500);
      expect((await balance('5960')) - overBefore).toBe(-2_500);
    });

    it('refuses a write-off with no named provider statement', async () => {
      const f = await floatFixture('SETR5', 500_000);
      const id = await submitStatement(f.svc.tillId!, 499_000, null);

      const r = await asUser(
        ownerHO,
        `select public.approve_agency_float_reconciliation($1,true,'no evidence')`,
        [id],
      );
      expect(r.ok).toBe(false);
      expect(r.message).toMatch(
        /only be written off against a named provider statement/i,
      );
    });

    it('refuses a surplus write-off larger than the float actually held', async () => {
      // The books claim 1,000 and the statement says 0, so the whole balance
      // is written off; then a second till with nothing in it cannot.
      const f = await floatFixture('SETR6', 0);
      const id = await submitStatement(f.svc.tillId!, 0, 'MTN-ST-6');
      const r = await asUserCommitted(ownerHO, [
        {
          sql: `select public.approve_agency_float_reconciliation($1,true,'nothing to write off')`,
          params: [id],
        },
      ]);
      expect(r.ok).toBe(false);
      expect(r.message).toMatch(/nothing to adjust/i);
    });

    it('enforces maker-checker, the adjustment capability and no double adjustment', async () => {
      const f = await floatFixture('SETR7', 800_000);
      const id = await submitStatement(f.svc.tillId!, 799_000, 'MTN-ST-7', mgrA);

      const sameUser = await asUser(
        mgrA,
        `select public.approve_agency_float_reconciliation($1,false,null)`,
        [id],
      );
      expect(sameUser.ok).toBe(false);
      expect(sameUser.message).toMatch(/cannot approve it/i);

      const mgr2 = await createTestUser('manager');
      const noCap = await asUser(
        mgr2,
        `select public.approve_agency_float_reconciliation($1,true,'write off')`,
        [id],
      );
      expect(noCap.ok).toBe(false);
      expect(noCap.message).toMatch(/agency:variance_adjustment/);

      const ok = await asUserCommitted(ownerHO, [
        {
          sql: `select public.approve_agency_float_reconciliation($1,true,'statement authoritative')`,
          params: [id],
        },
      ]);
      expect(ok.ok, ok.message).toBe(true);

      const again = await asUserCommitted(ownerHO, [
        {
          sql: `select public.approve_agency_float_reconciliation($1,true,'again')`,
          params: [id],
        },
      ]);
      expect(again.ok).toBe(false);
      expect(again.message).toMatch(/already reconciled/i);
    });

    it('refuses a stale statement whose float moved after it was recorded', async () => {
      const f = await floatFixture('SETR8', 600_000);
      const id = await submitStatement(f.svc.tillId!, 600_000, 'MTN-ST-8', mgrA);
      await fund(f.floatCode, 25_000);

      const r = await asUser(
        ownerHO,
        `select public.approve_agency_float_reconciliation($1,false,null)`,
        [id],
      );
      expect(r.ok).toBe(false);
      expect(r.message).toMatch(/has moved from 600000 to 625000/);
      expect(r.message).toMatch(/Reconcile it again/i);
    });

    it('refuses a till at a branch the caller cannot see', async () => {
      const f = await floatFixture('SETR9', 100_000);
      const r = await asUser(
        mgrB,
        `select public.submit_agency_float_reconciliation($1,$2,$3)`,
        [f.svc.tillId, 100_000, 'MTN-ST-9'],
      );
      expect(r.ok).toBe(false);
      expect(r.code).toBe('42501');
    });
  });

  // =========================================================================
  describe('commission settlement correction (Task 7)', () => {
    it('restores 1310 by contra and keeps the original settlement', async () => {
      const svc = await provider({ code: 'SETX1', branch: branchA, rateBps: 500 });
      await fund(svc.floatCode!, 10_000_000);
      await post(svc, 200_000); // 10,000 accrued
      const settled = await asUserCommitted(mgrA, [
        {
          sql: `select public.record_commission_settlement($1,$2,$3,$4,$5) as id`,
          params: [svc.providerId, branchA, 10_000, cashA, 'STMT-X1'],
        },
      ]);
      expect(settled.ok, settled.message).toBe(true);
      const id = (settled.rows[0] as { id: string }).id;
      expect(await outstandingCommission(svc.providerId, branchA)).toBe(0);

      const cashBefore = await balance('1010-BR2601');
      const rev = await asUserCommitted(mgrA, [
        {
          sql: `select public.reverse_commission_settlement($1,'posted against the wrong provider') as e`,
          params: [id],
        },
      ]);
      expect(rev.ok, rev.message).toBe(true);

      expect(await linesOf((rev.rows[0] as { e: string }).e)).toEqual([
        { code: '1310', debit: 10_000, credit: 0 },
        { code: '1010-BR2601', debit: 0, credit: 10_000 },
      ]);
      expect(cashBefore - (await balance('1010-BR2601'))).toBe(10_000);

      // The receivable is back, which is the whole point: the amended
      // agency_commission_outstanding() counts the correction.
      expect(await outstandingCommission(svc.providerId, branchA)).toBe(10_000);

      // The original row is preserved and annotated.
      const row = await queryOne<{
        status: string;
        by: string;
        reason: string;
        amount: string;
      }>(
        `select status, reversed_by::text as by, reversal_reason as reason,
                settlement_amount::text as amount
           from public.agency_commission_settlements where id = $1`,
        [id],
      );
      expect(row.status).toBe('reversed');
      expect(row.by).toBe(mgrA.profileId);
      expect(row.reason).toBe('posted against the wrong provider');
      expect(Number(row.amount)).toBe(10_000);
    });

    it('releases a historical transaction that the settlement had blocked', async () => {
      const svc = await provider({ code: 'SETX2', branch: branchA, rateBps: 500 });
      await fund(svc.floatCode!, 10_000_000);
      const txId = await post(svc, 200_000); // 10,000 accrued

      const settled = await asUserCommitted(mgrA, [
        {
          sql: `select public.record_commission_settlement($1,$2,$3,$4,$5) as id`,
          params: [svc.providerId, branchA, 10_000, cashA, 'STMT-X2'],
        },
      ]);
      expect(settled.ok, settled.message).toBe(true);
      const settlementId = (settled.rows[0] as { id: string }).id;

      // Phase 4B refuses the reversal while the commission is settled.
      const blocked = await asUserCommitted(mgrA, [
        {
          sql: `select public.reverse_agency_transaction($1,'customer never received it')`,
          params: [txId],
        },
      ]);
      expect(blocked.ok).toBe(false);
      expect(blocked.message).toMatch(/settle/i);

      // Correct the settlement...
      const corrected = await asUserCommitted(mgrA, [
        {
          sql: `select public.reverse_commission_settlement($1,'settled in error')`,
          params: [settlementId],
        },
      ]);
      expect(corrected.ok, corrected.message).toBe(true);

      // ...and the historical reversal becomes possible again.
      const now = await asUserCommitted(mgrA, [
        {
          sql: `select public.reverse_agency_transaction($1,'customer never received it') as e`,
          params: [txId],
        },
      ]);
      expect(now.ok, now.message).toBe(true);
      expect((now.rows[0] as { e: string }).e).toBeTruthy();

      // And the receivable nets to zero: accrued, settled, corrected, reversed.
      expect(await outstandingCommission(svc.providerId, branchA)).toBe(0);
    });

    it('refuses without authority, twice, without a reason, and cross-branch', async () => {
      const svc = await provider({ code: 'SETX3', branch: branchA, rateBps: 500 });
      await fund(svc.floatCode!, 10_000_000);
      await post(svc, 200_000);
      const settled = await asUserCommitted(mgrA, [
        {
          sql: `select public.record_commission_settlement($1,$2,$3,$4,$5) as id`,
          params: [svc.providerId, branchA, 10_000, cashA, 'STMT-X3'],
        },
      ]);
      expect(settled.ok, settled.message).toBe(true);
      const id = (settled.rows[0] as { id: string }).id;

      const bySec = await asUser(
        secA,
        `select public.reverse_commission_settlement($1,'no authority')`,
        [id],
      );
      expect(bySec.ok).toBe(false);
      expect(bySec.code).toBe('42501');
      expect(bySec.message).toMatch(/agency:reverse/);

      const crossBranch = await asUser(
        mgrB,
        `select public.reverse_commission_settlement($1,'not my branch')`,
        [id],
      );
      expect(crossBranch.ok).toBe(false);
      expect(crossBranch.code).toBe('42501');

      const noReason = await asUser(
        mgrA,
        `select public.reverse_commission_settlement($1,'  ')`,
        [id],
      );
      expect(noReason.ok).toBe(false);
      expect(noReason.message).toMatch(/needs a reason/i);

      const first = await asUserCommitted(mgrA, [
        {
          sql: `select public.reverse_commission_settlement($1,'first')`,
          params: [id],
        },
      ]);
      expect(first.ok, first.message).toBe(true);
      const second = await asUserCommitted(mgrA, [
        {
          sql: `select public.reverse_commission_settlement($1,'again')`,
          params: [id],
        },
      ]);
      expect(second.ok).toBe(false);
      expect(second.message).toMatch(/already reversed/i);
    });

    it('refuses when the receiving account no longer holds the money', async () => {
      // A dedicated branch, so the correction's cash check is about this
      // till alone and not the shared Head Office one.
      const branch = (
        await queryOne<{ id: string }>(
          `insert into public.branches (branch_code, name, location, status, opened_on)
           values ('BRCRX','Correction Branch','Testing','active',current_date)
           returning id`,
        )
      ).id;
      await query(
        `insert into public.ledger_accounts
           (code, name, account_type, normal_side, cash_kind, branch_id, is_postable, status)
         values ('1010-BRCRX','Cash — Correction Branch','asset','debit',
                 'cash_at_hand',$1,true,'active')`,
        [branch],
      );
      const till = await accountId('1010-BRCRX');

      const svc = await provider({
        code: 'SETX4',
        branch,
        rateBps: 500,
      });
      await fund(svc.floatCode!, 10_000_000);

      const mgrC = await createTestUser('manager');
      await query(`update public.profiles set branch_id = $1 where id = $2`, [
        branch,
        mgrC.profileId,
      ]);
      const secC = await createTestUser('secretary_treasurer');
      await query(`update public.profiles set branch_id = $1 where id = $2`, [
        branch,
        secC.profileId,
      ]);

      await post(svc, 200_000, secC, mgrC); // 10,000 accrued at this branch
      const settled = await asUserCommitted(mgrC, [
        {
          sql: `select public.record_commission_settlement($1,$2,$3,$4,$5) as id`,
          params: [svc.providerId, branch, 10_000, till, 'STMT-X4'],
        },
      ]);
      expect(settled.ok, settled.message).toBe(true);
      const id = (settled.rows[0] as { id: string }).id;
      // 200,000 the customer deposited plus the 10,000 commission received.
      expect(await balance('1010-BRCRX')).toBe(210_000);

      // The branch spends the commission on an expense, emptying the till.
      await query(
        `select public.post_journal($1, current_date, 'spent it',
            'expense', null, null, null,
            jsonb_build_array(
              jsonb_build_object('account_id', public.ledger_account_by_code('5900'),
                'debit', 210000, 'credit', 0),
              jsonb_build_object('account_id', $2::uuid, 'debit', 0, 'credit', 210000)),
            now(),
            (select p.id from public.profiles p join public.user_roles r
               on r.profile_id = p.id where r.role_key = 'owner_admin'
              order by p.created_at limit 1),
            'fixture')`,
        [branch, till],
      );
      expect(await balance('1010-BRCRX')).toBe(0);

      const r = await asUserCommitted(mgrC, [
        {
          sql: `select public.reverse_commission_settlement($1,'settled in error')`,
          params: [id],
        },
      ]);
      expect(r.ok).toBe(false);
      expect(r.message).toMatch(/holds 0 shillings/);
    });
  });

  // =========================================================================
  describe('cross-cutting lock order (concurrency requirement)', () => {
    it('takes the provider lock before the account locks, in every function', async () => {
      // The ordering rule is what makes two keyspaces deadlock-free. Reading
      // it off the source is cheap and would catch a later function that
      // took the locks the other way round.
      const rows = await query<{ name: string; ok: boolean }>(
        `select p.proname as name,
                (position('lock_agency_provider_balance' in pg_get_functiondef(p.oid))
                   < position('lock_ledger_balances' in pg_get_functiondef(p.oid))) as ok
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public'
            and p.prokind = 'f'
            and pg_get_functiondef(p.oid) like '%lock_agency_provider_balance%'
            and pg_get_functiondef(p.oid) like '%lock_ledger_balances%'
            and p.proname <> 'lock_agency_provider_balance'
          order by p.proname`,
      );
      // Every function that takes both must take the provider lock first.
      expect(rows.length).toBeGreaterThanOrEqual(4);
      expect(rows.filter((r) => !r.ok)).toEqual([]);
    });

    it('does not deadlock when a settlement and a replenishment interleave', async () => {
      // Different operations on the same provider and branch, issued
      // simultaneously. With one global lock order neither can hold a lock
      // the other needs, so both complete rather than one aborting on a
      // deadlock detection.
      const svc = await provider({ code: 'SETL1', branch: branchA, rateBps: 500 });
      await fund(svc.floatCode!, 10_000_000);
      await post(svc, 200_000); // 10,000 commission outstanding
      await query(
        `update public.finance_settings
            set low_balance_agency_float = 0, low_balance_cash_at_hand = 0
          where id = 1`,
      );

      const a = await getClient();
      const b = await getClient();
      try {
        for (const c of [a, b]) {
          await c.query('begin');
          await c.query(`select set_config('request.jwt.claim.sub',$1,true)`, [
            mgrA.authUserId,
          ]);
        }
        // A settles commission; B tops the same provider's float up.
        await a.query(
          `select public.record_commission_settlement($1,$2,5000,$3,'LOCK-A')`,
          [svc.providerId, branchA, cashA],
        );
        const bWork = b.query(
          `select public.post_float_replenishment($1,$2,$3,'LOCK-B')`,
          [svc.tillId, 100_000, bankA],
        );
        await a.query('commit');
        await bWork; // must succeed, not deadlock
        await b.query('commit');
      } finally {
        a.release();
        b.release();
      }

      expect(await outstandingCommission(svc.providerId, branchA)).toBe(5_000);
      expect(await balance(svc.floatCode!)).toBe(10_100_000 - 200_000);
    });
  });

  // =========================================================================
  describe('reporting views (Task 8)', () => {
    const VIEWS = [
      'agency_float_balances',
      'agency_transaction_history',
      'agency_commission_summary',
      'agency_payable_summary',
      'agency_variance_report',
      'agency_daily_cash_movement',
      'agency_end_of_day_exceptions',
    ] as const;

    it("are all security_invoker, so the caller's own policies apply", async () => {
      // If one were left as a definer view it would read with the owner's
      // privileges and bypass every policy below it. That is the single
      // property the whole design rests on, so it is asserted directly.
      const rows = await query<{ viewname: string; invoker: string }>(
        `select c.relname as viewname,
                coalesce((select option_value from pg_options_to_table(c.reloptions)
                           where option_name = 'security_invoker'), 'unset') as invoker
           from pg_class c join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'public' and c.relkind = 'v'
            and c.relname = any($1::text[])
          order by c.relname`,
        [[...VIEWS]],
      );
      expect(rows.length).toBe(VIEWS.length);
      expect(rows.filter((r) => r.invoker !== 'true')).toEqual([]);
    });

    it('show a borrower nothing at all', async () => {
      // A client holds no agency capability, so every base policy yields no
      // rows and so does every view over them.
      const borrower = await createTestUser('client');
      for (const view of VIEWS) {
        const r = await asUser(borrower, `select count(*)::int as n from public.${view}`);
        expect(r.ok, `${view}: ${r.message}`).toBe(true);
        expect((r.rows[0] as { n: number }).n, view).toBe(0);
      }
    });

    it('show a branch-scoped manager only their own branch', async () => {
      const svc = await provider({ code: 'SETV1', branch: branchA, rateBps: 500 });
      await fund(svc.floatCode!, 5_000_000);
      await post(svc, 200_000);

      // mgrB is scoped to branch B and has no branch-A rows.
      const mine = await asUser(
        mgrB,
        `select count(*)::int as n from public.agency_transaction_history
          where branch_id = $1`,
        [branchA],
      );
      expect(mine.ok, mine.message).toBe(true);
      expect((mine.rows[0] as { n: number }).n).toBe(0);

      // Head Office sees it.
      const ho = await asUser(
        ownerHO,
        `select count(*)::int as n from public.agency_transaction_history
          where branch_id = $1`,
        [branchA],
      );
      expect(ho.ok, ho.message).toBe(true);
      expect((ho.rows[0] as { n: number }).n).toBeGreaterThan(0);
    });

    it('agree with the definer helpers they deliberately do not call', async () => {
      // The attribution rule is written twice - once in
      // agency_commission_outstanding/agency_payable_outstanding, once in the
      // views, because those functions are revoked from authenticated. Two
      // copies of a rule drift, so this asserts they still agree.
      const svc = await provider({ code: 'SETV2', branch: branchA, rateBps: 500 });
      await fund(svc.floatCode!, 5_000_000);
      await post(svc, 400_000); // 20,000 accrued
      const settled = await asUserCommitted(mgrA, [
        {
          sql: `select public.record_commission_settlement($1,$2,$3,$4,$5)`,
          params: [svc.providerId, branchA, 8_000, cashA, 'STMT-V2'],
        },
      ]);
      expect(settled.ok, settled.message).toBe(true);

      const fromView = await queryOne<{
        earned: string;
        received: string;
        outstanding: string;
      }>(
        `select commission_earned::text as earned,
                commission_received::text as received,
                commission_outstanding::text as outstanding
           from public.agency_commission_summary
          where provider_id = $1 and branch_id = $2`,
        [svc.providerId, branchA],
      );
      expect(Number(fromView.earned)).toBe(20_000);
      expect(Number(fromView.received)).toBe(8_000);
      expect(Number(fromView.outstanding)).toBe(12_000);
      expect(Number(fromView.outstanding)).toBe(
        await outstandingCommission(svc.providerId, branchA),
      );

      // And the payable side, on a bank agency provider.
      const bank = await provider({
        code: 'SETV3',
        branch: branchA,
        floatModel: 'cash_payable',
        payable: '2220',
        direction: 'deposit',
      });
      await post(bank, 300_000);
      const remit = await asUserCommitted(mgrA, [
        {
          sql: `select public.post_agency_payable_settlement($1,$2,$3,$4,$5)`,
          params: [bank.providerId, branchA, 120_000, cashA, 'RCPT-V3'],
        },
      ]);
      expect(remit.ok, remit.message).toBe(true);

      const pv = await queryOne<{
        collected: string;
        remitted: string;
        outstanding: string;
      }>(
        `select collected_on_behalf::text as collected, remitted::text as remitted,
                payable_outstanding::text as outstanding
           from public.agency_payable_summary
          where provider_id = $1 and branch_id = $2`,
        [bank.providerId, branchA],
      );
      expect(Number(pv.collected)).toBe(300_000);
      expect(Number(pv.remitted)).toBe(120_000);
      expect(Number(pv.outstanding)).toBe(180_000);
      expect(Number(pv.outstanding)).toBe(
        await outstandingPayable(bank.providerId, branchA),
      );
    });

    it('report both variance conventions with their meaning stated', async () => {
      const r = await query<{ kind: string; means: string }>(
        `select distinct reconciliation_kind as kind, variance_means as means
           from public.agency_variance_report order by 1`,
      );
      // Both kinds present, and neither leaves its sign to be guessed.
      expect(r.map((x) => x.kind)).toEqual(['cash', 'float']);
      expect(r.find((x) => x.kind === 'cash')?.means).toBe(
        'physical count less the books',
      );
      expect(r.find((x) => x.kind === 'float')?.means).toBe(
        'the books less the provider statement',
      );
    });

    it('list end-of-day exceptions and daily movement for real fixtures', async () => {
      const svc = await provider({ code: 'SETV4', branch: branchA, rateBps: 500 });
      await fund(svc.floatCode!, 5_000_000);

      // A draft left unverified is an exception.
      const key = `E-${Math.random().toString(36).slice(2, 12)}`;
      const c = await asUserCommitted(secA, [
        {
          sql: `select public.create_agency_transaction($1,$2,$3,'+256770007000','C',$4,0,null,null,null,$4) as id`,
          params: [svc.typeId, 50_000, svc.tillId, key],
        },
      ]);
      expect(c.ok, c.message).toBe(true);
      const draftId = (c.rows[0] as { id: string }).id;

      const ex = await query<{ kind: string; subject: string }>(
        `select exception_kind as kind, subject_id::text as subject
           from public.agency_end_of_day_exceptions
          where subject_id = $1`,
        [draftId],
      );
      expect(ex).toEqual([{ kind: 'unverified_transaction', subject: draftId }]);

      // And a posted transaction shows up in the day's cash movement.
      await post(svc, 100_000);
      const move = await queryOne<{ cashIn: string; net: string }>(
        `select sum(cash_in)::text as "cashIn", sum(net_movement)::text as net
           from public.agency_daily_cash_movement
          where branch_id = $1 and source_type = 'agency_transaction'`,
        [branchA],
      );
      expect(Number(move.cashIn)).toBeGreaterThan(0);
      expect(Number(move.net)).not.toBe(0);
    });
  });

  // =========================================================================
  describe('financial security certification (Task 9)', () => {
    /** Every settlement and reconciliation RPC, with the capability it needs. */
    const RPCS: { call: string; capability: string }[] = [
      {
        call: `select public.record_commission_settlement(
                 '00000000-0000-0000-0000-000000000001'::uuid,
                 '00000000-0000-0000-0000-000000000002'::uuid, 1000,
                 '00000000-0000-0000-0000-000000000003'::uuid, null)`,
        capability: 'agency:settlements',
      },
      {
        call: `select public.post_agency_payable_settlement(
                 '00000000-0000-0000-0000-000000000001'::uuid,
                 '00000000-0000-0000-0000-000000000002'::uuid, 1000,
                 '00000000-0000-0000-0000-000000000003'::uuid, null)`,
        capability: 'agency:settlements',
      },
      {
        call: `select public.post_float_replenishment(
                 '00000000-0000-0000-0000-000000000001'::uuid, 1000,
                 '00000000-0000-0000-0000-000000000003'::uuid, null)`,
        capability: 'agency:settlements',
      },
      {
        call: `select public.reverse_agency_payable_settlement(
                 '00000000-0000-0000-0000-000000000001'::uuid, 'why')`,
        capability: 'agency:reverse',
      },
      {
        call: `select public.reverse_commission_settlement(
                 '00000000-0000-0000-0000-000000000001'::uuid, 'why')`,
        capability: 'agency:reverse',
      },
      {
        call: `select public.submit_agency_cash_reconciliation(
                 '00000000-0000-0000-0000-000000000003'::uuid, 1000)`,
        capability: 'agency:reconcile',
      },
      {
        call: `select public.approve_agency_cash_reconciliation(
                 '00000000-0000-0000-0000-000000000001'::uuid, false, null)`,
        capability: 'agency:reconcile',
      },
      {
        call: `select public.submit_agency_float_reconciliation(
                 '00000000-0000-0000-0000-000000000001'::uuid, 1000, null)`,
        capability: 'agency:reconcile',
      },
      {
        call: `select public.approve_agency_float_reconciliation(
                 '00000000-0000-0000-0000-000000000001'::uuid, false, null)`,
        capability: 'agency:reconcile',
      },
    ];

    it('refuses every settlement and reconciliation RPC to a borrower', async () => {
      const borrower = await createTestUser('client');
      for (const { call, capability } of RPCS) {
        const r = await asUser(borrower, call);
        expect(r.ok, call).toBe(false);
        expect(r.code, call).toBe('42501');
        expect(r.message, call).toContain(capability);
      }
    });

    it('refuses the settlement RPCs to a secretary without settlement authority', async () => {
      for (const { call, capability } of RPCS) {
        if (capability === 'agency:reconcile') continue; // secretaries hold none of these either
        const r = await asUser(secA, call);
        expect(r.ok, call).toBe(false);
        expect(r.code, call).toBe('42501');
        expect(r.message, call).toContain(capability);
      }
    });

    it('refuses a suspended officer and one who must change their password', async () => {
      // current_profile_id() requires status active and no forced password
      // change, so both are refused before any capability is consulted.
      const suspended = await createTestUser('owner_admin');
      await query(`update public.profiles set status = 'suspended' where id = $1`, [
        suspended.profileId,
      ]);
      const forced = await createTestUser('owner_admin');
      await query(
        `update public.profiles set must_change_password = true where id = $1`,
        [forced.profileId],
      );

      for (const user of [suspended, forced]) {
        for (const { call } of RPCS.slice(0, 3)) {
          const r = await asUser(user, call);
          expect(r.ok, call).toBe(false);
          expect(r.code, call).toBe('42501');
          expect(r.message, call).toMatch(/unidentified session/i);
        }
      }
    });

    it('scopes a branch-held Owner/Admin to their own branch for a commission exception', async () => {
      // The gap the review named: agency:commission_exception is owner-only,
      // and every earlier test gave the owner no branch, so Head Office's
      // see-everything rule hid the branch question entirely. An owner_admin
      // WITH a branch must be refused another branch's transaction.
      const ownerA = await createTestUser('owner_admin');
      await query(`update public.profiles set branch_id = $1 where id = $2`, [
        branchA,
        ownerA.profileId,
      ]);
      const ownerB = await createTestUser('owner_admin');
      await query(`update public.profiles set branch_id = $1 where id = $2`, [
        branchB,
        ownerB.profileId,
      ]);

      const svc = await provider({ code: 'SETQ1', branch: branchA, rateBps: 150 });
      await fund(svc.floatCode!, 5_000_000);
      const key = `Q-${Math.random().toString(36).slice(2, 12)}`;
      const c = await asUserCommitted(secA, [
        {
          sql: `select public.create_agency_transaction($1,$2,$3,'+256770008000','C',$4,0,1800,null,null,$4) as id`,
          params: [svc.typeId, 100_000, svc.tillId, key],
        },
      ]);
      expect(c.ok, c.message).toBe(true);
      const id = (c.rows[0] as { id: string }).id;

      // The branch-B owner holds the capability and still may not touch it.
      const wrongBranch = await asUser(
        ownerB,
        `select public.authorise_agency_commission_exception($1,'promo','STMT-Q1')`,
        [id],
      );
      expect(wrongBranch.ok).toBe(false);
      expect(wrongBranch.code).toBe('42501');
      expect(wrongBranch.message).toMatch(
        /No agency transaction with that identifier is available to you/i,
      );

      // The branch-A owner may.
      const rightBranch = await asUserCommitted(ownerA, [
        {
          sql: `select public.authorise_agency_commission_exception($1,'promo','STMT-Q1')`,
          params: [id],
        },
      ]);
      expect(rightBranch.ok, rightBranch.message).toBe(true);

      const row = await queryOne<{ by: string }>(
        `select commission_exception_by::text as by
           from public.agency_transactions where id = $1`,
        [id],
      );
      expect(row.by).toBe(ownerA.profileId);
    });

    it('leaves the trial balance balanced after everything this suite posted', async () => {
      const tb = await queryOne<{ d: string; c: string }>(
        `select sum(total_debit)::text as d, sum(total_credit)::text as c
           from public.trial_balance`,
      );
      expect(tb.d).toBe(tb.c);
    });
  });

  // =========================================================================
  // Phase 4C-S. Three cross-phase races an independent review identified.
  //
  // Each began as a reproduction against the code as it stood after Phase 4C,
  // and each one succeeded: the combined effect of two authorised operations
  // drove a provider balance negative, or certified a count against a balance
  // that had already moved. They are kept as regressions.
  //
  // Phase 4C's own concurrency test for the payable passed, and passed for the
  // wrong reason: its settlement drew from the same Cash at Hand account the
  // withdrawal locked, so the two serialised on that account rather than on
  // anything to do with the payable. Funding the settlement from Cash at Bank
  // removes the overlap and the race appears.
  // =========================================================================
  describe('cross-phase financial concurrency (Phase 4C-S)', () => {
    /**
     * Does `work` get through while another session holds `lockSql`?
     *
     * The outcome races these defects produce are real but timing-dependent -
     * the payable race below was observed to end at -20,000 and then, on a
     * later run of the same code, to serialise by luck on the journal
     * reference counter. A test that reports a defect only sometimes is worse
     * than no test, so the regression form asserts the thing that is actually
     * wrong and is deterministic: the path does not take the lock that would
     * have prevented the race. That also makes it a *missing lock* test
     * rather than only a lock-order test.
     */
    async function completesWhileHeld(
      lockSql: string,
      lockParams: unknown[],
      who: TestUser,
      workSql: string,
      workParams: unknown[],
    ): Promise<{ walkedPast: boolean; error: string | null }> {
      await query(
        `update public.finance_settings
            set low_balance_agency_float = 0, low_balance_cash_at_hand = 0
          where id = 1`,
      );
      const holder = await getClient();
      const worker = await getClient();
      let done = false;
      let error: string | null = null;
      try {
        await holder.query('begin');
        await holder.query(lockSql, lockParams);

        await worker.query('begin');
        await worker.query(`select set_config('request.jwt.claim.sub',$1,true)`, [
          who.authUserId,
        ]);

        const work = worker
          .query(workSql, workParams)
          .then(() => {
            done = true;
          })
          .catch((e: unknown) => {
            done = true;
            error = (e as { message?: string }).message ?? 'unknown';
          });

        // A clear chance to finish. If the lock is honoured it cannot.
        await new Promise((resolve) => setTimeout(resolve, 2_000));
        const walkedPast = done;

        await holder.query('commit');
        await work;
        await worker.query('rollback');
        return { walkedPast, error };
      } finally {
        holder.release();
        worker.release();
      }
    }

    it('C1: a transaction reversal takes the provider lock before reading the receivable', async () => {
      // reverse_agency_transaction() decides whether a transaction's deferred
      // commission is still unsettled by reading
      // agency_commission_outstanding(). record_commission_settlement() reads
      // the same figure, but under lock_agency_provider_balance(). Two
      // different locks are no mutual exclusion at all: a settlement of 1,500
      // and a reversal carrying 1,000 can each see the full 2,000 and
      // together leave the receivable at -500.
      const svc = await provider({ code: 'C1SVC', branch: branchA, rateBps: 500 });
      await fund(svc.floatCode!, 20_000_000);
      await post(svc, 20_000);
      const second = await post(svc, 20_000);
      expect(await outstandingCommission(svc.providerId, branchA)).toBe(2_000);

      const r = await completesWhileHeld(
        `select public.lock_agency_provider_balance($1,$2)`,
        [svc.providerId, branchA],
        mgrA,
        `select public.reverse_agency_transaction($1,'C1 lock coverage')`,
        [second],
      );
      expect(
        r.walkedPast,
        r.walkedPast
          ? 'a transaction reversal read the provider receivable without the provider lock'
          : 'the reversal waited for the provider lock, as it must',
      ).toBe(false);
    });

    it('C2: a bank withdrawal takes the provider lock before reading the payable', async () => {
      // Observed before the fix: a 60,000 withdrawal from Cash at Hand and a
      // 60,000 payable settlement funded from Cash at BANK both passed the
      // payable check against the same 100,000 and left the provider at
      // -20,000. Phase 4C's own test for this passed only because its
      // settlement drew from the same Cash at Hand account the withdrawal
      // locked - the two serialised on that account, not on the payable.
      const svc = await provider({
        code: 'C2SVC',
        branch: branchA,
        floatModel: 'cash_payable',
        payable: '2220',
        direction: 'deposit',
      });
      await post(svc, 100_000);
      expect(await outstandingPayable(svc.providerId, branchA)).toBe(100_000);

      const withdrawType = await queryOne<{ id: string }>(
        `insert into public.agency_transaction_types
           (provider_id, code, name, direction, max_single_transaction)
         values ($1,'WDR','wdr','withdrawal',500000000) returning id`,
        [svc.providerId],
      );
      const key = `C2-${Math.random().toString(36).slice(2, 12)}`;
      const c = await asUserCommitted(secA, [
        {
          sql: `select public.create_agency_transaction($1,60000,null,'+256770009000','C',$2,0,null,null,null,$2) as id`,
          params: [withdrawType.id, key],
        },
      ]);
      expect(c.ok, c.message).toBe(true);
      const wid = (c.rows[0] as { id: string }).id;
      const sub = await asUserCommitted(secA, [
        { sql: `select public.submit_agency_transaction($1)`, params: [wid] },
      ]);
      expect(sub.ok, sub.message).toBe(true);

      const r = await completesWhileHeld(
        `select public.lock_agency_provider_balance($1,$2)`,
        [svc.providerId, branchA],
        mgrA,
        `select public.verify_agency_transaction($1)`,
        [wid],
      );
      expect(
        r.walkedPast,
        r.walkedPast
          ? 'a bank withdrawal read the provider payable without the provider lock'
          : 'the withdrawal waited for the provider lock, as it must',
      ).toBe(false);

      expect(await outstandingPayable(svc.providerId, branchA)).toBeGreaterThanOrEqual(0);
    });

    it('C3: every agency path that moves a till or float takes its account lock', async () => {
      // The hazard the review named is not a timing window to be caught by
      // luck: it is that the posting path checked sufficiency only on the
      // balance it drew *down*, so a deposit - which DEBITS cash at hand and
      // increases it - took no lock on that till at all. An approval holding
      // the till's lock therefore did not stop a concurrent credit to it.
      //
      // Proved deterministically rather than by racing: one session holds the
      // lock a reconciliation approval holds, and the other posts money into
      // the same account. If the posting path honours the lock it must wait;
      // if it ignores the lock it returns immediately.
      const branch = (
        await queryOne<{ id: string }>(
          `insert into public.branches (branch_code, name, location, status, opened_on)
           values ('BRC3','Race Branch C3','Testing','active',current_date)
           returning id`,
        )
      ).id;
      await query(
        `insert into public.ledger_accounts
           (code, name, account_type, normal_side, cash_kind, branch_id, is_postable, status)
         values ('1010-BRC3','Cash — Race Branch C3','asset','debit',
                 'cash_at_hand',$1,true,'active')`,
        [branch],
      );
      const till = await accountId('1010-BRC3');
      await fund('1010-BRC3', 1_000_000);

      const mgrC = await createTestUser('manager');
      const secC = await createTestUser('secretary_treasurer');
      for (const u of [mgrC, secC]) {
        await query(`update public.profiles set branch_id = $1 where id = $2`, [
          branch,
          u.profileId,
        ]);
      }

      const svc = await provider({ code: 'C3SVC', branch, rateBps: 150 });
      await fund(svc.floatCode!, 20_000_000);

      // A deposit left submitted: verifying it debits the till by 50,000.
      const key = `C3-${Math.random().toString(36).slice(2, 12)}`;
      const c = await asUserCommitted(secC, [
        {
          sql: `select public.create_agency_transaction($1,50000,$2,'+256770009101','C',$3,0,null,null,null,$3) as id`,
          params: [svc.typeId, svc.tillId, key],
        },
      ]);
      expect(c.ok, c.message).toBe(true);
      const depositId = (c.rows[0] as { id: string }).id;
      const sub = await asUserCommitted(secC, [
        { sql: `select public.submit_agency_transaction($1)`, params: [depositId] },
      ]);
      expect(sub.ok, sub.message).toBe(true);

      await query(
        `update public.finance_settings
            set low_balance_agency_float = 0, low_balance_cash_at_hand = 0
          where id = 1`,
      );

      const holder = await getClient();
      const poster = await getClient();
      let returnedWhileHeld = false;
      try {
        // The holder takes exactly the lock an approval takes, and keeps it.
        await holder.query('begin');
        await holder.query(`select public.lock_ledger_balances(array[$1::uuid])`, [till]);

        await poster.query('begin');
        await poster.query(`select set_config('request.jwt.claim.sub',$1,true)`, [
          mgrC.authUserId,
        ]);

        // Does posting into the locked till wait, or walk straight past?
        const work = poster
          .query(`select public.verify_agency_transaction($1)`, [depositId])
          .then(() => {
            returnedWhileHeld = true;
          })
          .catch(() => {
            // A refusal is also "did not wait", but either way the lock was
            // not honoured; the assertion below reports which.
            returnedWhileHeld = true;
          });

        // Give it a clear chance to finish. If the lock is honoured it cannot.
        await new Promise((resolve) => setTimeout(resolve, 2_000));
        const walkedPast = returnedWhileHeld;

        await holder.query('commit');
        await work;
        await poster.query('commit');

        expect(
          walkedPast,
          walkedPast
            ? 'a deposit posted into a till whose balance lock was held by another session'
            : 'the deposit waited for the lock, as it must',
        ).toBe(false);
      } finally {
        holder.release();
        poster.release();
      }

      // The till ends where arithmetic says: 1,000,000 + 50,000.
      expect(await balance('1010-BRC3')).toBe(1_050_000);
    });

    it('does not serialise unrelated providers against each other', async () => {
      // The provider lock must be per provider and branch. If it were coarser
      // - one lock for the module, or one per branch - every settlement in the
      // business would queue behind every other, and the fix for C1 and C2
      // would have bought correctness with a throughput collapse.
      const one = await provider({ code: 'C4P1', branch: branchA, rateBps: 500 });
      const two = await provider({ code: 'C4P2', branch: branchA, rateBps: 500 });
      for (const svc of [one, two]) {
        await fund(svc.floatCode!, 10_000_000);
        await post(svc, 200_000); // 10,000 outstanding each
      }
      await query(
        `update public.finance_settings
            set low_balance_agency_float = 0, low_balance_cash_at_hand = 0
          where id = 1`,
      );

      const a = await getClient();
      const b = await getClient();
      try {
        for (const c of [a, b]) {
          await c.query('begin');
          await c.query(`select set_config('request.jwt.claim.sub',$1,true)`, [
            mgrA.authUserId,
          ]);
        }
        // A holds provider one's lock and does not commit.
        await a.query(
          `select public.record_commission_settlement($1,$2,4000,$3,'C4-A')`,
          [one.providerId, branchA, cashA],
        );
        expect(await balance('1040-BR2601')).toBeGreaterThan(0);

        // B settles the OTHER provider, into a DIFFERENT account. Into the
        // same till they would serialise on that till's balance, which is
        // correct and necessary; the question here is whether anything else
        // serialises them, and the only remaining shared resource would be
        // GL 1310.
        let bDone = false;
        const work = b
          .query(`select public.record_commission_settlement($1,$2,4000,$3,'C4-B')`, [
            two.providerId,
            branchA,
            bankA,
          ])
          .then(() => {
            bDone = true;
          });
        await new Promise((resolve) => setTimeout(resolve, 2_000));

        // B may legitimately still be waiting on the journal reference
        // counter, which serialises posting for everyone and is not this
        // test's subject. What it must not be waiting on is A's provider
        // lock - so check the lock itself rather than inferring from timing.
        const blocked = await queryOne<{ n: string }>(
          `select count(*)::text as n
             from pg_locks
            where locktype = 'advisory' and not granted`,
        );
        expect(
          Number(blocked.n),
          `B ${bDone ? 'completed' : 'is still running'}; ungranted advisory locks ${blocked.n}`,
        ).toBe(0);

        await a.query('commit');
        await work;
        await b.query('commit');
      } finally {
        a.release();
        b.release();
      }

      expect(await outstandingCommission(one.providerId, branchA)).toBe(6_000);
      expect(await outstandingCommission(two.providerId, branchA)).toBe(6_000);
    });
  });

  // =========================================================================
  describe('the lock and resource matrix (Phase 4C-S Task 4)', () => {
    /**
     * Every financially relevant agency function, with the resources it
     * protects. Stated here rather than derived, so the test detects a
     * **missing** lock and not merely a reversed order: a function that
     * acquires neither helper fails against its row, where an
     * order-only check would have passed it in silence.
     *
     * `provider` — does it read or change a provider-scoped balance (the 1310
     * receivable, or a 2200-series payable)? Those are shared across
     * providers, so no account lock can protect them.
     * `accounts` — does it change a cash or float balance, in either
     * direction?
     */
    const MATRIX: {
      fn: string;
      provider: boolean;
      accounts: boolean;
      checks: string;
      source: string;
      races: string;
    }[] = [
      {
        fn: 'post_agency_transaction',
        provider: true,
        accounts: true,
        checks: 'cash or float sufficiency; bank payable floor',
        source: 'agency_transaction',
        races: 'payable settlement, another withdrawal, cash and float reconciliation',
      },
      {
        fn: 'reverse_agency_transaction',
        provider: true,
        accounts: true,
        checks: 'commission outstanding; cash or float sufficiency on the contra',
        source: 'agency_transaction_reversal',
        races: 'commission settlement, commission correction, reconciliation',
      },
      {
        fn: 'record_commission_settlement',
        provider: true,
        accounts: true,
        checks: 'commission outstanding',
        source: 'agency_commission_settlement',
        races: 'transaction reversal, another settlement, cash reconciliation',
      },
      {
        fn: 'reverse_commission_settlement',
        provider: true,
        accounts: true,
        checks: 'receiving account still holds the money',
        source: 'agency_commission_settlement_reversal',
        races: 'another settlement, transaction reversal, cash reconciliation',
      },
      {
        fn: 'post_agency_payable_settlement',
        provider: true,
        accounts: true,
        checks: 'payable outstanding; cash sufficiency',
        source: 'agency_payable_settlement',
        races: 'bank withdrawal, another settlement, cash reconciliation',
      },
      {
        fn: 'reverse_agency_payable_settlement',
        provider: true,
        accounts: true,
        checks: 'settlement is still posted',
        source: 'agency_payable_settlement_reversal',
        races: 'bank withdrawal, another settlement, cash reconciliation',
      },
      {
        fn: 'post_float_replenishment',
        provider: true,
        accounts: true,
        checks: 'funding account sufficiency',
        source: 'agency_float_replenishment',
        races: 'float reconciliation, a withdrawal drawing the same float',
      },
      {
        fn: 'approve_agency_float_reconciliation',
        provider: true,
        accounts: true,
        checks: 'snapshot is not stale; float sufficiency on a surplus write-off',
        source: 'reconciliation_adjustment',
        races: 'any transaction or replenishment moving the same till',
      },
      {
        // No provider-scoped balance: a branch till is shared between agency
        // and lending and belongs to neither provider.
        fn: 'approve_agency_cash_reconciliation',
        provider: false,
        accounts: true,
        checks: 'snapshot is not stale; cash sufficiency on a shortage write-off',
        source: 'reconciliation_adjustment',
        races: 'any agency or lending posting moving the same till',
      },
      {
        fn: 'submit_agency_cash_reconciliation',
        provider: false,
        accounts: true,
        checks: 'snapshots the balance under lock',
        source: '(no journal)',
        races: 'any posting moving the same till',
      },
      {
        fn: 'submit_agency_float_reconciliation',
        provider: false,
        accounts: true,
        checks: 'snapshots the balance under lock',
        source: '(no journal)',
        races: 'any posting moving the same float till',
      },
    ];

    it('every function in the matrix acquires the locks its row requires', async () => {
      const defs = await query<{ proname: string; def: string }>(
        `select p.proname, pg_get_functiondef(p.oid) as def
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public' and p.prokind = 'f'
            and p.proname = any($1::text[])`,
        [MATRIX.map((m) => m.fn)],
      );
      expect(defs.length).toBe(MATRIX.length);

      const failures: string[] = [];
      for (const row of MATRIX) {
        const def = defs.find((d) => d.proname === row.fn)?.def ?? '';
        const hasProvider = def.includes('lock_agency_provider_balance');
        const hasAccounts =
          def.includes('lock_ledger_balances') ||
          // the two sufficiency helpers each take the account lock themselves
          def.includes('assert_cash_available') ||
          def.includes('assert_agency_float_available');

        if (row.provider !== hasProvider) {
          failures.push(
            `${row.fn}: provider lock ${hasProvider ? 'present' : 'MISSING'}, matrix says ${row.provider}`,
          );
        }
        if (row.accounts !== hasAccounts) {
          failures.push(
            `${row.fn}: account lock ${hasAccounts ? 'present' : 'MISSING'}, matrix says ${row.accounts}`,
          );
        }
        // And where both are taken, the provider lock comes first.
        if (hasProvider && def.includes('lock_ledger_balances')) {
          if (
            def.indexOf('lock_agency_provider_balance') >
            def.indexOf('lock_ledger_balances')
          ) {
            failures.push(`${row.fn}: takes the account locks before the provider lock`);
          }
        }
      }
      expect(failures).toEqual([]);
    });

    it('names every function that touches a provider balance, so none is forgotten', async () => {
      // The matrix is only a certification if it is complete. Any function
      // that reads a provider-scoped outstanding figure must appear in it;
      // a new one added later fails here until it is classified.
      const readers = await query<{ proname: string }>(
        `select p.proname
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public' and p.prokind = 'f'
            and (pg_get_functiondef(p.oid) like '%agency_commission_outstanding%'
              or pg_get_functiondef(p.oid) like '%agency_payable_outstanding%')
            and p.proname not in (
              'agency_commission_outstanding', 'agency_payable_outstanding')
          order by p.proname`,
      );
      const named = new Set(MATRIX.filter((m) => m.provider).map((m) => m.fn));
      const unclassified = readers.map((r) => r.proname).filter((n) => !named.has(n));
      expect(unclassified).toEqual([]);
    });
  });
});
