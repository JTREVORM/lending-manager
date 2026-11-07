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
});
