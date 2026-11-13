/**
 * Workstream A — the shared Cash at Hand till, between lending and agency.
 *
 * Phase 4C-S closed three agency concurrency races and recorded one risk it
 * did not close: a branch till is shared between agency work and lending, and
 * `approve_agency_cash_reconciliation()` counts the **whole** till. The agency
 * paths now lock that account in either direction. The lending paths do not.
 *
 * So a certified cash count can still be measured against a balance that a
 * loan repayment, a savings deposit, a membership fee or a disbursement
 * changed underneath it.
 *
 * ## Why these tests assert locks rather than outcomes
 *
 * `post_journal()` calls `next_reference('journal')`, whose counter row lock
 * serialises every posting in the system until commit. Two sessions that both
 * post therefore appear ordered whatever their locking, which is exactly how
 * the Phase 4C payable race passed once and failed once on identical code.
 *
 * These tests hold only the account's advisory lock — posting nothing, taking
 * no reference — and then ask whether a lending path walks straight past it.
 * No journal-reference serialisation can make that pass.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestUser, type TestUser } from '../helpers/auth-fixtures';
import {
  closePool,
  getClient,
  hasDatabase,
  query,
  queryOne,
  skipReason,
} from '../helpers/db';
import {
  approveLoan,
  createDraftLoan,
  createLoanScenario,
  disburseApprovedLoan,
  submitLoan,
  type LoanScenario,
} from '../helpers/loan-fixtures';

const describeDb = hasDatabase ? describe : describe.skip;
if (!hasDatabase) {
  describe('shared till concurrency', () => {
    it.skip(`skipped - ${skipReason}`, () => undefined);
  });
}

describeDb('the shared Cash at Hand till (Workstream A)', () => {
  let owner: TestUser;
  let till: string;
  let tillCode: string;

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

  /**
   * Does `work` get through while another session holds the till's balance
   * lock? The holder posts nothing, so nothing but the lock itself can make
   * the answer no.
   */
  async function completesWhileTillLocked(
    work: (client: import('pg').PoolClient) => Promise<unknown>,
  ): Promise<{ walkedPast: boolean; error: string | null }> {
    const holder = await getClient();
    const worker = await getClient();
    let done = false;
    let error: string | null = null;
    try {
      await holder.query('begin');
      await holder.query(`select public.lock_ledger_balances(array[$1::uuid])`, [till]);

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
      // An error is not "walked past the lock": a path refused for an
      // unrelated reason never reached the lock at all, and reporting that as
      // a concurrency defect would be wrong. The caller asserts on `error`.
      const walkedPast = done && error === null;

      await holder.query('commit');
      await run;
      try {
        await worker.query('commit');
      } catch {
        await worker.query('rollback');
      }
      return { walkedPast, error };
    } finally {
      holder.release();
      worker.release();
    }
  }

  beforeAll(async () => {
    owner = await createTestUser('owner_admin');
    await query(`update public.profiles set branch_id = null where id = $1`, [
      owner.profileId,
    ]);
    tillCode = '1010-BR2601';
    till = (
      await queryOne<{ id: string }>(
        `select id from public.ledger_accounts where code = $1`,
        [tillCode],
      )
    ).id;

    // Opening cash, so no lending path fails for want of money.
    await query(
      `select public.post_journal(
          (select branch_id from public.ledger_accounts where code = $1),
          current_date, 'shared till fixture', 'opening_balance', null, null, null,
          jsonb_build_array(
            jsonb_build_object('account_id',
              (select id from public.ledger_accounts where code = $1),
              'debit', 500000000::bigint, 'credit', 0),
            jsonb_build_object('account_id', public.ledger_account_by_code('3000'),
              'debit', 0, 'credit', 500000000::bigint)),
          now(),
          (select p.id from public.profiles p
             join public.user_roles r on r.profile_id = p.id
            where r.role_key = 'owner_admin' order by p.created_at limit 1),
          'shared till fixture')`,
      [tillCode],
    );
    await query(
      `update public.finance_settings
          set low_balance_cash_at_hand = 0, low_balance_agency_float = 0
        where id = 1`,
    );
  });

  afterAll(async () => {
    await closePool();
  });

  // =========================================================================
  describe('A1 — the audit, as a certification', () => {
    it('every function that posts a journal reaches the account lock', async () => {
      // post_journal() is the single writer of every journal line in the
      // system. If the lock lives there, every posting path is covered by
      // construction - including paths added later, which is the part a list
      // of functions cannot promise.
      const def = await queryOne<{ def: string }>(
        `select pg_get_functiondef(p.oid) as def
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public' and p.proname = 'post_journal'`,
      );
      expect(def.def).toContain('lock_ledger_balances');
    });

    it('locks both accounts on a path that moves two tills at once', async () => {
      // A transfer debits one cash account and credits another. It locked only
      // the source, through assert_cash_available. Had post_journal started
      // locking both while a caller still held just one, two opposing
      // transfers could each hold one account and wait for the other - a
      // deadlock introduced by the fix rather than by the defect. Both
      // transfer paths now take both locks up front, sorted.
      for (const fn of ['post_transfer_journal', 'reverse_transfer']) {
        const r = await queryOne<{ def: string }>(
          `select pg_get_functiondef(p.oid) as def
             from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.proname = $1`,
          [fn],
        );
        expect(r.def, fn).toContain('lock_ledger_balances');
      }
    });
  });

  // =========================================================================
  describe('A2 — lending inflows cannot post into a locked till', () => {
    let scenario: LoanScenario;

    beforeAll(async () => {
      scenario = await createLoanScenario();
    });

    it('a loan repayment waits for the till lock', async () => {
      const loanId = await createDraftLoan(scenario.clientId, { principal: 1_000_000 });
      await submitLoan(loanId, scenario);
      await approveLoan(loanId, scenario);
      await disburseApprovedLoan(loanId, scenario);

      const before = await balance(tillCode);
      const r = await completesWhileTillLocked((client) =>
        client
          .query(`select set_config('request.jwt.claim.sub',$1,true)`, [
            scenario.secretary.authUserId,
          ])
          .then(() =>
            client.query(
              `select public.post_payment($1, 50000, 'cash', null, gen_random_uuid(), null)`,
              [loanId],
            ),
          ),
      );
      expect(r.error, 'the repayment should not fail for an unrelated reason').toBeNull();
      expect(
        r.walkedPast,
        r.walkedPast
          ? 'a loan repayment credited a till whose balance lock was held by another session'
          : 'the repayment waited for the till lock, as it must',
      ).toBe(false);
      expect(await balance(tillCode)).toBe(before + 50_000);
    });

    it('other income received in cash waits for the till lock', async () => {
      const before = await balance(tillCode);
      const r = await completesWhileTillLocked((client) =>
        client
          .query(`select set_config('request.jwt.claim.sub',$1,true)`, [owner.authUserId])
          .then(() =>
            client.query(
              `select public.record_other_income(
                 public.ledger_account_by_code('4590'), $1::uuid, 25000,
                 current_date, 'A2 other income', 'Payer', null, null, 'A2-INC')`,
              [till],
            ),
          ),
      );
      expect(
        r.walkedPast,
        r.walkedPast
          ? 'other income credited a till whose balance lock was held'
          : 'other income waited for the till lock, as it must',
      ).toBe(false);
      expect(await balance(tillCode)).toBe(before + 25_000);
    });

    it('a loan disbursement waits for the till lock on the way out', async () => {
      // A cash-out lending path. It takes no till sufficiency check at all,
      // which is recorded as a separate finding - but it must still not move
      // the balance while somebody is counting it.
      // Its own borrower: a client may hold only one active loan, and the
      // repayment test above left this scenario's client with one.
      const second = await createLoanScenario();
      const loanId = await createDraftLoan(second.clientId, { principal: 200_000 });
      await submitLoan(loanId, second);
      await approveLoan(loanId, second);

      const before = await balance(tillCode);
      const r = await completesWhileTillLocked((client) =>
        client
          .query(`select set_config('request.jwt.claim.sub',$1,true)`, [
            second.owner.authUserId,
          ])
          .then(() => client.query(`select public.disburse_loan($1)`, [loanId])),
      );
      expect(
        r.error,
        'the disbursement should not fail for an unrelated reason',
      ).toBeNull();
      expect(
        r.walkedPast,
        r.walkedPast
          ? 'a disbursement debited a till whose balance lock was held'
          : 'the disbursement waited for the till lock, as it must',
      ).toBe(false);
      expect(await balance(tillCode)).toBeLessThan(before);
    });
  });

  // =========================================================================
  describe('A2 — the reconciliation this protects', () => {
    it('serialises an agency cash count against a lending repayment', async () => {
      // The whole point: the count covers lending and agency cash together,
      // so a lending repayment must not land between the count's snapshot and
      // its approval.
      const scenario = await createLoanScenario();
      const loanId = await createDraftLoan(scenario.clientId, { principal: 1_000_000 });
      await submitLoan(loanId, scenario);
      await approveLoan(loanId, scenario);
      await disburseApprovedLoan(loanId, scenario);

      const mgr = await createTestUser('manager');
      await query(`update public.profiles set branch_id = null where id = $1`, [
        mgr.profileId,
      ]);

      const system = await balance(tillCode);
      const submitted = await queryOne<{ id: string }>(
        `select public.submit_agency_cash_reconciliation($1, $2) as id`,
        [till, system],
      ).catch(async () => {
        // submit requires a session; run it as the manager instead.
        const c = await getClient();
        try {
          await c.query('begin');
          await c.query(`select set_config('request.jwt.claim.sub',$1,true)`, [
            mgr.authUserId,
          ]);
          const r = await c.query<{ id: string }>(
            `select public.submit_agency_cash_reconciliation($1, $2) as id`,
            [till, system],
          );
          await c.query('commit');
          return r.rows[0]!;
        } finally {
          c.release();
        }
      });

      const a = await getClient();
      const b = await getClient();
      let repaymentWalkedPast = false;
      try {
        await a.query('begin');
        await a.query(`select set_config('request.jwt.claim.sub',$1,true)`, [
          owner.authUserId,
        ]);
        // The approval takes the till lock and holds it to commit.
        await a.query(`select public.approve_agency_cash_reconciliation($1,false,null)`, [
          submitted.id,
        ]);

        await b.query('begin');
        await b.query(`select set_config('request.jwt.claim.sub',$1,true)`, [
          scenario.secretary.authUserId,
        ]);
        const work = b
          .query(
            `select public.post_payment($1, 30000, 'cash', null, gen_random_uuid(), null)`,
            [loanId],
          )
          .then(() => {
            repaymentWalkedPast = true;
          })
          .catch(() => {
            repaymentWalkedPast = true;
          });
        await new Promise((resolve) => setTimeout(resolve, 2_000));
        const walked = repaymentWalkedPast;

        await a.query('commit');
        await work;
        await b.query('commit');

        expect(
          walked,
          walked
            ? 'a repayment posted into the till while its count was being certified'
            : 'the repayment waited for the certification to finish',
        ).toBe(false);
      } finally {
        a.release();
        b.release();
      }

      const row = await queryOne<{ status: string; variance: string }>(
        `select status, variance::text as variance
           from public.agency_cash_reconciliations where id = $1`,
        [submitted.id],
      );
      expect(row.status).toBe('reconciled');
      expect(Number(row.variance)).toBe(0);
    });
  });
});
