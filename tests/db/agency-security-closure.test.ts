/**
 * Phase 4B-S: the security closure, proved by attacking the engine.
 *
 * Each block here began as a reproduction. The cross-branch tests were written
 * against the code *before* the fix and passed in the sense that the attack
 * succeeded: a branch-A manager could update, submit, return, verify, cancel,
 * reverse and correct a branch-B transaction — seven of seven, two of them
 * moving money. The concurrency tests likewise drove a float to −20,000 and a
 * till to −24,000 before the serialization existed.
 *
 * They are kept as regressions, so the fixes cannot quietly come undone.
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

import { staffAgentAccount } from '../helpers/agency';

const describeDb = hasDatabase ? describe : describe.skip;
if (!hasDatabase) {
  describe('agency security closure', () => {
    it.skip(`skipped - ${skipReason}`, () => undefined);
  });
}

interface Svc {
  readonly providerId: string;
  readonly typeId: string;
  readonly tillId: string | null;
  readonly floatCode: string | null;
}

describeDb('Phase 4B-S — security and financial control closure', () => {
  let ownerHO: TestUser; // no branch: Head Office
  let mgrA: TestUser;
  let secA: TestUser;
  let mgrB: TestUser;
  let secB: TestUser;
  let branchA: string;
  let branchB: string;
  let cashA: string;

  let svcA: Svc;
  let svcB: Svc;

  async function fund(code: string, amount: number): Promise<void> {
    await query(
      `select public.post_journal(
          (select id from public.branches order by branch_code limit 1),
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
          'security fixture')`,
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

  async function service(
    code: string,
    branch: string,
    opts: {
      direction?: 'deposit' | 'withdrawal';
      model?: 'provider_float' | 'cash_payable';
      payable?: string;
    } = {},
  ): Promise<Svc> {
    const model = opts.model ?? 'provider_float';
    const pr = await queryOne<{ id: string }>(
      `insert into public.agency_service_providers
         (code, name, category, float_model, payable_account_id, income_account_id,
          commission_model, commission_fixed, is_provisional, is_active)
       values ($1, $1, $2, $3,
               (select id from public.ledger_accounts where code = $4),
               (select id from public.ledger_accounts where code = '4510'),
               'deferred', 0, false, true)
       returning id`,
      [
        code,
        model === 'cash_payable' ? 'agency_banking' : 'mobile_money',
        model,
        opts.payable ?? null,
      ],
    );
    const ty = await queryOne<{ id: string }>(
      `insert into public.agency_transaction_types
         (provider_id, code, name, direction, max_single_transaction)
       values ($1, 'OP', 'op', $2, 50000000) returning id`,
      [pr.id, opts.direction ?? 'deposit'],
    );
    let tillId: string | null = null;
    let floatCode: string | null = null;
    if (model === 'provider_float') {
      const till = await queryOne<{ id: string }>(
        `select public.ensure_agency_float_account($1, $2) as id`,
        [pr.id, branch],
      );
      await staffAgentAccount(till.id);
      tillId = till.id;
      floatCode = (
        await queryOne<{ code: string }>(
          `select a.code from public.agency_provider_float_accounts f
             join public.ledger_accounts a on a.id = f.ledger_account_id where f.id = $1`,
          [tillId],
        )
      ).code;
    }
    return { providerId: pr.id, typeId: ty.id, tillId, floatCode };
  }

  /** A committed transaction at a chosen state, recorded by `who`. */
  async function txAt(
    svc: Svc,
    who: TestUser,
    verifier: TestUser,
    state: 'draft' | 'submitted' | 'posted',
    amount = 50_000,
  ): Promise<string> {
    const key = `S-${Math.random().toString(36).slice(2, 12)}`;
    const c = await asUserCommitted(who, [
      {
        sql: `select public.create_agency_transaction($1,$2,$3,'+256770005000','C',$4,0,null,null,null,$4) as id`,
        params: [svc.typeId, amount, svc.tillId, key],
      },
    ]);
    expect(c.ok, c.message).toBe(true);
    const id = (c.rows[0] as { id: string }).id;
    if (state === 'draft') return id;
    const s = await asUserCommitted(who, [
      { sql: `select public.submit_agency_transaction($1)`, params: [id] },
    ]);
    expect(s.ok, s.message).toBe(true);
    if (state === 'submitted') return id;
    const v = await asUserCommitted(verifier, [
      { sql: `select public.verify_agency_transaction($1)`, params: [id] },
    ]);
    expect(v.ok, v.message).toBe(true);
    return id;
  }

  beforeAll(async () => {
    ownerHO = await createTestUser('owner_admin');
    mgrA = await createTestUser('manager');
    secA = await createTestUser('secretary_treasurer');
    mgrB = await createTestUser('manager');
    secB = await createTestUser('secretary_treasurer');

    branchA = (
      await queryOne<{ id: string }>(
        `select id from public.branches order by branch_code limit 1`,
      )
    ).id;
    branchB = (
      await queryOne<{ id: string }>(
        `insert into public.branches (branch_code, name, location, status, opened_on)
         values ('BRSEC9', 'Closure Branch B', 'Testing', 'active', current_date)
         returning id`,
      )
    ).id;

    // Branch B needs its own till of cash, or a posting there fails for an
    // incidental reason and hides the authorization question.
    await query(
      `insert into public.ledger_accounts
         (code, name, account_type, normal_side, cash_kind, branch_id, is_postable, status)
       values ('1010-BRSEC9','Cash at Hand — Closure Branch B','asset','debit',
               'cash_at_hand',$1,true,'active')`,
      [branchB],
    );

    await query(`update public.profiles set branch_id = $1 where id = any($2::uuid[])`, [
      branchA,
      [mgrA.profileId, secA.profileId],
    ]);
    await query(`update public.profiles set branch_id = $1 where id = any($2::uuid[])`, [
      branchB,
      [mgrB.profileId, secB.profileId],
    ]);
    // Head Office carries no branch, which is the established policy.
    await query(`update public.profiles set branch_id = null where id = $1`, [
      ownerHO.profileId,
    ]);

    cashA = (
      await queryOne<{ code: string }>(
        `select code from public.ledger_accounts
          where branch_id = $1 and cash_kind = 'cash_at_hand'`,
        [branchA],
      )
    ).code;

    svcA = await service('SECCLOSA', branchA);
    svcB = await service('SECCLOSB', branchB);
    await fund(svcA.floatCode!, 200_000_000);
    await fund(svcB.floatCode!, 200_000_000);
    await fund(cashA, 200_000_000);
    await fund('1010-BRSEC9', 200_000_000);
  });

  afterAll(async () => {
    // No deleteTestUsers: these fixtures post journals, and
    // agency_transactions.journal_entry_id is ON DELETE RESTRICT. The project
    // rebuilds its own database.
    await closePool();
  });

  // =========================================================================
  describe('cross-branch authorization (Task 1)', () => {
    /**
     * The eight externally callable operations, each attempted by branch-A
     * staff against a branch-B transaction. Before the fix, seven succeeded.
     */
    const cases: readonly {
      name: string;
      state: 'draft' | 'submitted' | 'posted';
      sql: string;
      extra?: unknown[];
    }[] = [
      {
        name: 'update',
        state: 'draft',
        sql: `select public.update_agency_transaction($1, 99000)`,
      },
      {
        name: 'submit',
        state: 'draft',
        sql: `select public.submit_agency_transaction($1)`,
      },
      {
        name: 'return',
        state: 'submitted',
        sql: `select public.return_agency_transaction($1,'xb')`,
      },
      {
        name: 'verify',
        state: 'submitted',
        sql: `select public.verify_agency_transaction($1)`,
      },
      {
        name: 'cancel',
        state: 'draft',
        sql: `select public.cancel_agency_transaction($1,'xb')`,
      },
      {
        name: 'reverse',
        state: 'posted',
        sql: `select public.reverse_agency_transaction($1,'xb')`,
      },
      {
        name: 'correct reference',
        state: 'posted',
        sql: `select public.update_agency_transaction_reference($1,'XBFIX','xb')`,
      },
      {
        name: 'authorise commission exception',
        state: 'submitted',
        sql: `select public.authorise_agency_commission_exception($1,'r','e')`,
      },
    ];

    for (const c of cases) {
      it(`refuses ${c.name} on another branch's transaction`, async () => {
        const id = await txAt(svcB, secB, mgrB, c.state);

        const before = await queryOne<{ s: string }>(
          `select md5(string_agg(t.id::text || t.status || t.principal_amount::text, '|' order by t.id)) as s
             from public.agency_transactions t`,
        );
        const entriesBefore = await queryOne<{ n: string }>(
          `select count(*)::text as n from public.journal_entries`,
        );
        const auditBefore = await queryOne<{ n: string }>(
          `select count(*)::text as n from public.agency_transaction_audit_log`,
        );

        // The owner holds every capability, so a refusal here is about branch
        // and nothing else. `mgrA` is used for the capability-bearing cases.
        const actor = c.name === 'authorise commission exception' ? ownerHO : mgrA;
        if (actor === ownerHO) {
          // Head Office may act anywhere; the branch-scoped probe is mgrA.
          const probe = await asUser(mgrA, c.sql, [id]);
          expect(probe.ok, c.name).toBe(false);
          expect(probe.code, c.name).toBe('42501');
        } else {
          const probe = await asUser(mgrA, c.sql, [id]);
          expect(probe.ok, c.name).toBe(false);
          expect(probe.code, c.name).toBe('42501');
          expect(probe.message, c.name).toBe(
            'No agency transaction with that identifier is available to you.',
          );
        }

        // Nothing moved: no record change, no journal, no audit row.
        const after = await queryOne<{ s: string }>(
          `select md5(string_agg(t.id::text || t.status || t.principal_amount::text, '|' order by t.id)) as s
             from public.agency_transactions t`,
        );
        expect(after.s, c.name).toBe(before.s);
        expect(
          (
            await queryOne<{ n: string }>(
              `select count(*)::text as n from public.journal_entries`,
            )
          ).n,
          c.name,
        ).toBe(entriesBefore.n);
        expect(
          (
            await queryOne<{ n: string }>(
              `select count(*)::text as n from public.agency_transaction_audit_log`,
            )
          ).n,
          c.name,
        ).toBe(auditBefore.n);
      });
    }

    it('gives the identical refusal for an identifier that does not exist', async () => {
      // Non-disclosing: a caller cannot tell a real transaction in another
      // branch from a fabricated identifier, so probing reveals nothing.
      const unknown = await asUser(mgrA, `select public.verify_agency_transaction($1)`, [
        '00000000-0000-0000-0000-000000000000',
      ]);
      const other = await asUser(mgrA, `select public.verify_agency_transaction($1)`, [
        await txAt(svcB, secB, mgrB, 'submitted'),
      ]);
      expect(unknown.ok || other.ok).toBe(false);
      expect(unknown.code).toBe(other.code);
      expect(unknown.message).toBe(other.message);
    });

    it('refuses an idempotency key held by another branch, without disclosing it', async () => {
      // Before the fix this returned branch B's transaction UUID — the one
      // identifier every other function then accepted.
      const key = `XKEY-${Math.random().toString(36).slice(2, 10)}`;
      const mine = await asUserCommitted(secB, [
        {
          sql: `select public.create_agency_transaction($1,5000,$2,'+256770005001','C',$3,0,null,null,null,$4) as id`,
          params: [svcB.typeId, svcB.tillId, `R-${key}`, key],
        },
      ]);
      expect(mine.ok, mine.message).toBe(true);
      const theirs = (mine.rows[0] as { id: string }).id;

      const probe = await asUser(
        secA,
        `select public.create_agency_transaction($1,1000,$2,'+256770005002','C','PROBE',0,null,null,null,$3) as id`,
        [svcA.typeId, svcA.tillId, key],
      );
      expect(probe.ok).toBe(false);
      expect(probe.code).toBe('42501');
      expect(probe.message).not.toContain(theirs);
    });

    it('still lets the owning branch and Head Office act', async () => {
      const own = await txAt(svcB, secB, mgrB, 'submitted');
      const byBranch = await asUserCommitted(mgrB, [
        { sql: `select public.verify_agency_transaction($1)`, params: [own] },
      ]);
      expect(byBranch.ok, byBranch.message).toBe(true);

      const ho = await txAt(svcB, secB, mgrB, 'submitted');
      const byHeadOffice = await asUserCommitted(ownerHO, [
        { sql: `select public.verify_agency_transaction($1)`, params: [ho] },
      ]);
      expect(byHeadOffice.ok, byHeadOffice.message).toBe(true);
    });

    it('still returns its own transaction for a same-branch retry', async () => {
      const key = `RETRY-${Math.random().toString(36).slice(2, 10)}`;
      const call = {
        sql: `select public.create_agency_transaction($1,6000,$2,'+256770005003','C',$3,0,null,null,null,$4) as id`,
        params: [svcB.typeId, svcB.tillId, `Y-${key}`, key],
      };
      const first = await asUserCommitted(secB, [call]);
      const again = await asUserCommitted(secB, [call]);
      expect(first.ok && again.ok).toBe(true);
      expect((again.rows[0] as { id: string }).id).toBe(
        (first.rows[0] as { id: string }).id,
      );
    });
  });

  // =========================================================================
  describe('shared balance concurrency (Task 2)', () => {
    /**
     * Two DISTINCT transactions, both reading the balance before either
     * commits.
     *
     * `post_journal()` already serialises on `next_reference('journal')`, but
     * that lock is taken after the balance check, so it orders the writes
     * without preventing an overdraft. The race is staged around it: A runs
     * and holds, B is issued and blocks at its own insert having already
     * checked, A commits, B proceeds. Awaiting B before committing A would
     * simply hang.
     *
     * The low-balance notification is switched off for the duration: its
     * dedupe key is identical for both racers and
     * `notifications_dedupe_unique` would serialise them for an unrelated
     * reason.
     */
    async function race(
      idA: string,
      idB: string,
    ): Promise<{ a: boolean; b: boolean; bMsg: string }> {
      await query(
        `update public.finance_settings
            set low_balance_agency_float = 0, low_balance_cash_at_hand = 0 where id = 1`,
      );
      const a = await getClient();
      const b = await getClient();
      try {
        await a.query('begin');
        await b.query('begin');
        await a.query(`select set_config('request.jwt.claim.sub',$1,true)`, [
          mgrA.authUserId,
        ]);
        await b.query(`select set_config('request.jwt.claim.sub',$1,true)`, [
          ownerHO.authUserId,
        ]);

        let aOk = true;
        try {
          await a.query(`select public.verify_agency_transaction($1)`, [idA]);
        } catch {
          aOk = false;
        }

        const pending = b
          .query(`select public.verify_agency_transaction($1)`, [idB])
          .then(
            () => ({ ok: true, m: '' }),
            (e: Error) => ({ ok: false, m: e.message }),
          );
        await new Promise((r) => setTimeout(r, 150));

        await a.query('commit');
        const rb = await pending;
        await b.query('commit').catch(() => undefined);
        return { a: aOk, b: rb.ok, bMsg: rb.m };
      } finally {
        a.release();
        b.release();
        await query(
          `update public.finance_settings
              set low_balance_agency_float = 200000, low_balance_cash_at_hand = 200000 where id = 1`,
        );
      }
    }

    it('refuses the second of two deposits one float cannot fund', async () => {
      // Before the fix both posted and the float ended at −20,000.
      const svc = await service('SECRACE1', branchA);
      await fund(svc.floatCode!, 100_000);
      const d1 = await txAt(svc, secA, mgrA, 'submitted', 60_000);
      const d2 = await txAt(svc, secA, mgrA, 'submitted', 60_000);

      const r = await race(d1, d2);
      expect(r.a).toBe(true);
      expect(r.b).toBe(false);
      // The refusal quotes the balance left after A, so B re-read it after
      // taking the lock rather than trusting its earlier read.
      expect(r.bMsg).toMatch(/holds 40000 shillings of float/);
      expect(await balance(svc.floatCode!)).toBe(40_000);
    });

    it('refuses the second of two withdrawals one till cannot pay', async () => {
      const svc = await service('SECRACE2', branchA, { direction: 'withdrawal' });
      await fund(svc.floatCode!, 200_000_000);

      // A dedicated branch and till, so the shared Cash at Hand of branch A is
      // not drained for the other tests.
      const br = (
        await queryOne<{ id: string }>(
          `insert into public.branches (branch_code,name,location,status,opened_on)
           values ('BRSEC8','Race Branch','T','active',current_date) returning id`,
        )
      ).id;
      await query(
        `insert into public.ledger_accounts
           (code,name,account_type,normal_side,cash_kind,branch_id,is_postable,status)
         values ('1010-BRSEC8','Cash at Hand — Race Branch','asset','debit',
                 'cash_at_hand',$1,true,'active')`,
        [br],
      );
      await fund('1010-BRSEC8', 100_000);

      const svc2 = await service('SECRACE3', br, { direction: 'withdrawal' });
      await fund(svc2.floatCode!, 200_000_000);
      const raceSec = await createTestUser('secretary_treasurer');
      const raceMgr = await createTestUser('manager');
      await query(
        `update public.profiles set branch_id = $1 where id = any($2::uuid[])`,
        [br, [raceSec.profileId, raceMgr.profileId]],
      );
      // Staffed after the people exist. `service()` rosters whoever is on
      // the books when the till is made, and these two are made afterwards.
      await staffAgentAccount(svc2.tillId!);

      const w1 = await txAt(svc2, raceSec, raceMgr, 'submitted', 60_000);
      const w2 = await txAt(svc2, raceSec, raceMgr, 'submitted', 60_000);

      // Head Office verifies both, so neither is refused for branch reasons.
      await query(
        `update public.finance_settings
            set low_balance_agency_float = 0, low_balance_cash_at_hand = 0 where id = 1`,
      );
      const a = await getClient();
      const b = await getClient();
      let bOk = true;
      let bMsg = '';
      try {
        await a.query('begin');
        await b.query('begin');
        await a.query(`select set_config('request.jwt.claim.sub',$1,true)`, [
          ownerHO.authUserId,
        ]);
        await b.query(`select set_config('request.jwt.claim.sub',$1,true)`, [
          ownerHO.authUserId,
        ]);
        await a.query(`select public.verify_agency_transaction($1)`, [w1]);
        const pending = b.query(`select public.verify_agency_transaction($1)`, [w2]).then(
          () => ({ ok: true, m: '' }),
          (e: Error) => ({ ok: false, m: e.message }),
        );
        await new Promise((r) => setTimeout(r, 150));
        await a.query('commit');
        const rb = await pending;
        bOk = rb.ok;
        bMsg = rb.m;
        await b.query('commit').catch(() => undefined);
      } finally {
        a.release();
        b.release();
        await query(
          `update public.finance_settings
              set low_balance_agency_float = 200000, low_balance_cash_at_hand = 200000 where id = 1`,
        );
      }

      expect(bOk).toBe(false);
      expect(bMsg).toMatch(/holds 40000 shillings, which is less than/);
      expect(await balance('1010-BRSEC8')).toBe(40_000);
    });

    it('leaves no account negative and the trial balance footing', async () => {
      const negative = await query<{ code: string }>(
        `select a.code from public.ledger_account_balances b
           join public.ledger_accounts a on a.id = b.account_id
          where a.cash_kind is not null and b.balance < 0`,
      );
      expect(negative).toEqual([]);

      const tb = await queryOne<{ d: string; c: string }>(
        `select sum(total_debit)::text as d, sum(total_credit)::text as c from public.trial_balance`,
      );
      expect(tb.d).toBe(tb.c);
    });
  });

  // =========================================================================
  describe('bank agency payable floor (Task 3)', () => {
    it('keeps the withdrawal direction: Dr payable, Cr cash', async () => {
      const bank = await service('SECBANK1', branchA, {
        model: 'cash_payable',
        payable: '2220',
        direction: 'withdrawal',
      });
      const dep = await queryOne<{ id: string }>(
        `insert into public.agency_transaction_types
           (provider_id, code, name, direction, max_single_transaction)
         values ($1,'DEP','dep','deposit',50000000) returning id`,
        [bank.providerId],
      );

      // Collect 500,000 first, so there is something to pay back out.
      const collected = await txAt(
        { ...bank, typeId: dep.id },
        secA,
        mgrA,
        'posted',
        500_000,
      );
      expect(collected).toBeTruthy();

      const out = await txAt(bank, secA, mgrA, 'posted', 300_000);
      const entry = await queryOne<{ e: string }>(
        `select journal_entry_id::text as e from public.agency_transactions where id = $1`,
        [out],
      );
      const lines = await query<{ code: string; debit: string; credit: string }>(
        `select a.code, l.debit::text, l.credit::text
           from public.journal_lines l join public.ledger_accounts a on a.id = l.account_id
          where l.entry_id = $1 order by l.line_number`,
        [entry.e],
      );
      expect(
        lines.map((l) => ({
          code: l.code,
          debit: Number(l.debit),
          credit: Number(l.credit),
        })),
      ).toEqual([
        { code: '2220', debit: 300_000, credit: 0 },
        { code: cashA, debit: 0, credit: 300_000 },
      ]);
    });

    it('refuses a withdrawal that would take the payable into net debit', async () => {
      const bank = await service('SECBANK2', branchA, {
        model: 'cash_payable',
        payable: '2220',
        direction: 'withdrawal',
      });
      const dep = await queryOne<{ id: string }>(
        `insert into public.agency_transaction_types
           (provider_id, code, name, direction, max_single_transaction)
         values ($1,'DEP','dep','deposit',50000000) returning id`,
        [bank.providerId],
      );

      await txAt({ ...bank, typeId: dep.id }, secA, mgrA, 'posted', 100_000);

      // Exactly the balance is allowed; one shilling more is not.
      const exact = await txAt(bank, secA, mgrA, 'submitted', 100_000);
      const okExact = await asUserCommitted(mgrA, [
        { sql: `select public.verify_agency_transaction($1)`, params: [exact] },
      ]);
      expect(okExact.ok, okExact.message).toBe(true);
      expect(
        Number(
          (
            await queryOne<{ v: string }>(
              `select public.agency_payable_outstanding($1,$2)::text as v`,
              [bank.providerId, branchA],
            )
          ).v,
        ),
      ).toBe(0);

      const over = await txAt(bank, secA, mgrA, 'submitted', 1);
      const refused = await asUserCommitted(mgrA, [
        { sql: `select public.verify_agency_transaction($1)`, params: [over] },
      ]);
      expect(refused.ok).toBe(false);
      expect(refused.message).toMatch(/may not go into net debit/i);
      expect(refused.message).toMatch(/Only 0 shillings are held/);
    });

    it('attributes the payable per provider, not per shared account', async () => {
      // Two banks share 2220. One bank's collections must not fund the
      // other's withdrawals.
      const b1 = await service('SECBANK3', branchA, {
        model: 'cash_payable',
        payable: '2220',
        direction: 'withdrawal',
      });
      const b2 = await service('SECBANK4', branchA, {
        model: 'cash_payable',
        payable: '2220',
        direction: 'withdrawal',
      });
      const dep1 = await queryOne<{ id: string }>(
        `insert into public.agency_transaction_types (provider_id,code,name,direction,max_single_transaction)
         values ($1,'DEP','dep','deposit',50000000) returning id`,
        [b1.providerId],
      );

      await txAt({ ...b1, typeId: dep1.id }, secA, mgrA, 'posted', 400_000);

      expect(
        Number(
          (
            await queryOne<{ v: string }>(
              `select public.agency_payable_outstanding($1,$2)::text as v`,
              [b1.providerId, branchA],
            )
          ).v,
        ),
      ).toBe(400_000);
      expect(
        Number(
          (
            await queryOne<{ v: string }>(
              `select public.agency_payable_outstanding($1,$2)::text as v`,
              [b2.providerId, branchA],
            )
          ).v,
        ),
      ).toBe(0);

      const other = await txAt(b2, secA, mgrA, 'submitted', 50_000);
      const r = await asUserCommitted(mgrA, [
        { sql: `select public.verify_agency_transaction($1)`, params: [other] },
      ]);
      expect(r.ok).toBe(false);
      expect(r.message).toMatch(/Only 0 shillings are held/);
    });
  });

  // =========================================================================
  describe('historical reversal safeguards (Task 5)', () => {
    it('reverses after deactivation, and the provider stays inactive', async () => {
      const svc = await service('SECREV1', branchA);
      await fund(svc.floatCode!, 5_000_000);
      const id = await txAt(svc, secA, mgrA, 'posted', 40_000);

      await query(
        `update public.agency_service_providers
            set is_active = false, is_provisional = true where id = $1`,
        [svc.providerId],
      );

      const r = await asUserCommitted(mgrA, [
        {
          sql: `select public.reverse_agency_transaction($1,'posted in error') as e`,
          params: [id],
        },
      ]);
      expect(r.ok, r.message).toBe(true);

      const after = await queryOne<{ a: boolean; p: boolean }>(
        `select is_active as a, is_provisional as p
           from public.agency_service_providers where id = $1`,
        [svc.providerId],
      );
      expect(after.a).toBe(false);
      expect(after.p).toBe(true);

      // The contra mirrors the original exactly.
      const t = await queryOne<{ j: string; rv: string }>(
        `select journal_entry_id::text as j, reversal_entry_id::text as rv
           from public.agency_transactions where id = $1`,
        [id],
      );
      const orig = await query<{ code: string; debit: string; credit: string }>(
        `select a.code, l.debit::text, l.credit::text from public.journal_lines l
           join public.ledger_accounts a on a.id = l.account_id
          where l.entry_id = $1 order by l.line_number`,
        [t.j],
      );
      const contra = await query<{ code: string; debit: string; credit: string }>(
        `select a.code, l.debit::text, l.credit::text from public.journal_lines l
           join public.ledger_accounts a on a.id = l.account_id
          where l.entry_id = $1 order by l.line_number`,
        [t.rv],
      );
      expect(contra.map((l) => ({ c: l.code, d: l.credit, r: l.debit }))).toEqual(
        orig.map((l) => ({ c: l.code, d: l.debit, r: l.credit })),
      );
    });

    it('refuses to reach reversed from any state but posted', async () => {
      // The exemption from the readiness gate exists for a posted transaction
      // being corrected. Phase 4B exempted anything already labelled reversed,
      // which also exempted an INSERT arriving reversed and an UPDATE from any
      // other state. Neither is a correction of a posting.
      const svc = await service('SECREV2', branchA);
      await fund(svc.floatCode!, 1_000_000);
      const draft = await txAt(svc, secA, mgrA, 'draft', 10_000);

      const err = await query<{ ok: boolean }>(`select true as ok`).then(async () => {
        try {
          await query(
            `update public.agency_transactions set status = 'reversed' where id = $1`,
            [draft],
          );
          return null;
        } catch (e) {
          return e as { message: string };
        }
      });
      expect(err).not.toBeNull();
      expect(err?.message).toMatch(
        /only become reversed from a posted state|reversed_is_complete/i,
      );
    });

    it('still refuses a reversal across branches and without the capability', async () => {
      const id = await txAt(svcB, secB, mgrB, 'posted');
      const crossBranch = await asUser(
        mgrA,
        `select public.reverse_agency_transaction($1,'x')`,
        [id],
      );
      expect(crossBranch.code).toBe('42501');

      const noCapability = await asUser(
        secB,
        `select public.reverse_agency_transaction($1,'x')`,
        [id],
      );
      expect(noCapability.code).toBe('42501');
    });
  });
});
