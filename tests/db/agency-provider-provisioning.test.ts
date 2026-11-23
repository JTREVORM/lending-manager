/**
 * Registering a bank, and bringing it live — operational tasks 1, 2 and 5.
 *
 * ## What was missing, in the application's own words
 *
 * `app/(app)/agency/providers/page.tsx` said it plainly, and it was true:
 *
 *   > Registering a provider, approving its commercial terms or making it
 *   > live is not a screen in this release: the approval workflow for
 *   > commercial terms has not been decided.
 *
 * So `STANBIC` was the only bank POLYTOS could ever have, `requires_approval_above`
 * was configuration that nothing read, and a `cash_payable` partner could not
 * have an agent account at all — `ensure_agency_float_account()` refuses one,
 * and `agency_provider_float_accounts.ledger_account_id` was `NOT NULL`.
 *
 * This file measures the three controls that replace that, against the
 * database rather than against the migrations' comments.
 *
 * ## The order the assertions are in is the order the business works in
 *
 * One Owner registers Equity Bank. A *second* Owner approves its terms, then
 * its float facility. Services get a ceiling and a threshold, an agent
 * account is opened, and only then may the provider go live — authorized by
 * somebody who did not register it, against a named instrument. Every refusal
 * along that path is asserted, because the value of a gate is the things it
 * refuses, not the one path it allows.
 *
 * ## What is deliberately *not* asserted
 *
 * No test here activates a provider and then posts customer money through it
 * for its own sake — `agency-transaction-engine.test.ts` owns the posting
 * engine and asserts it far better. What this file posts is the minimum
 * needed to prove the two money-side controls operational task 5 added: that
 * float cannot exceed an approved facility, and that an amount above a
 * service's threshold cannot be verified by a Manager.
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
  describe('agency provider provisioning', () => {
    it.skip(`skipped - ${skipReason}`, () => undefined);
  });
}

describeDb('registering a bank, and bringing it live', () => {
  /** The Owner who registers. Never the one who approves anything. */
  let registrar: TestUser;
  /** The second Owner. Approves terms, the facility, and going live. */
  let approver: TestUser;
  /**
   * A Manager: holds `agency:verify` and, under the approved threshold
   * policy, `agency:verify_high_value` too. The clerk below is the account
   * that holds neither, which is what the capability refusals are measured
   * against now.
   */
  let manager: TestUser;
  /** A front-office account, to prove the capability is the gate. */
  let clerk: TestUser;
  /**
   * A second front-office account that records nothing.
   *
   * Needed because the capability trigger and
   * `agency_transactions_verifier_not_submitter` both refuse a bad verifier,
   * and a test about the first must not be answered by the second.
   */
  let bystander: TestUser;

  let branch: string;
  let branchCode: string;

  let seq = 0;
  const code = (stem: string): string =>
    `${stem}${String((process.pid % 100) * 100 + ++seq).padStart(5, '0')}`;

  /** Put money in a cash account, so float can actually be bought with it. */
  async function fund(accountCode: string, amount: number): Promise<void> {
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
          now(), $4, 'provisioning fixture')`,
      [accountCode, amount, `fixture ${accountCode} ${code('F')}`, registrar.profileId],
    );
  }

  /** Register a provider as the registrar, returning its id. */
  async function register(opts: {
    readonly code: string;
    readonly category?: string;
    readonly floatModel?: string;
    readonly rateBps?: number | null;
    readonly source?: string;
  }): Promise<string> {
    const result = await asUserCommitted(registrar, [
      {
        sql: `select public.register_agency_provider(
                $1, $1 || ' Bank', $2, $3, 'deferred', $4, $5, null, $6)::text as id`,
        params: [
          opts.code,
          opts.category ?? 'agency_banking',
          opts.floatModel ?? 'provider_float',
          opts.source ?? 'configured',
          opts.rateBps === undefined ? 120 : opts.rateBps,
          `${opts.code}-AGREEMENT-1`,
        ],
      },
    ]);
    expect(result.ok, result.message).toBe(true);
    return String(result.rows[0]?.id);
  }

  beforeAll(async () => {
    registrar = await createTestUser('owner_admin');
    approver = await createTestUser('owner_admin');
    manager = await createTestUser('manager');
    clerk = await createTestUser('secretary_treasurer');
    bystander = await createTestUser('secretary_treasurer');

    const b = await queryOne<{ id: string; branch_code: string }>(
      `select id::text as id, branch_code from public.branches order by branch_code limit 1`,
    );
    branch = b.id;
    branchCode = b.branch_code;

    // Everybody is put at the branch, because `create_agency_transaction`
    // refuses an officer with no branch rather than assuming one.
    await query(`update public.profiles set branch_id = $1 where id = any($2::uuid[])`, [
      branch,
      [
        registrar.profileId,
        approver.profileId,
        manager.profileId,
        clerk.profileId,
        bystander.profileId,
      ],
    ]);
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
  // Operational task 1 — registration, and the approval of commercial terms
  // =========================================================================

  describe('registration', () => {
    it('is the Owner’s, and a front-office account is refused', async () => {
      const attempt = await asUser(
        clerk,
        `select public.register_agency_provider('CLERKBANK', 'Clerk Bank',
           'agency_banking', 'provider_float', 'deferred')`,
      );
      expect(attempt.ok).toBe(false);
      expect(attempt.code).toBe('42501');
    });

    it('writes a provisional, inactive provider — never a live one', async () => {
      const id = await register({ code: code('EQ') });
      const row = await queryOne<{
        is_provisional: boolean;
        is_active: boolean;
        registered_by: string;
        terms_approved_by: string | null;
      }>(
        `select is_provisional, is_active, registered_by::text as registered_by,
                terms_approved_by::text as terms_approved_by
           from public.agency_service_providers where id = $1`,
        [id],
      );
      expect(row.is_provisional).toBe(true);
      expect(row.is_active).toBe(false);
      expect(row.registered_by).toBe(registrar.profileId);
      expect(row.terms_approved_by).toBeNull();
    });

    it('derives the ledger accounts from the category, so a bank’s commission cannot be filed under mobile money', async () => {
      const bank = await register({ code: code('CAT'), category: 'agency_banking' });
      const momo = await register({
        code: code('CAT'),
        category: 'mobile_money',
        floatModel: 'provider_float',
      });

      const codes = await query<{ id: string; income: string }>(
        `select p.id::text as id, a.code as income
           from public.agency_service_providers p
           join public.ledger_accounts a on a.id = p.income_account_id
          where p.id = any($1::uuid[])`,
        [[bank, momo]],
      );
      expect(codes.find((r) => r.id === bank)?.income).toBe('4520');
      expect(codes.find((r) => r.id === momo)?.income).toBe('4510');
    });

    it('gives a cash-payable partner its payable account, and a float partner none', async () => {
      const payable = await register({
        code: code('CP'),
        floatModel: 'cash_payable',
      });
      const float = await register({ code: code('FL') });

      const rows = await query<{ id: string; payable: string | null }>(
        `select p.id::text as id, a.code as payable
           from public.agency_service_providers p
           left join public.ledger_accounts a on a.id = p.payable_account_id
          where p.id = any($1::uuid[])`,
        [[payable, float]],
      );
      expect(rows.find((r) => r.id === payable)?.payable).toBe('2220');
      expect(rows.find((r) => r.id === float)?.payable).toBeNull();
    });

    it('refuses a category that is not one, before it looks up any account', async () => {
      const attempt = await asUser(
        registrar,
        `select public.register_agency_provider('BADCAT', 'Bad', 'bank',
           'provider_float', 'deferred')`,
      );
      expect(attempt.ok).toBe(false);
      expect(attempt.message).toMatch(/not a provider category/i);
    });

    it('refuses a duplicate code, and upper-cases what it is given', async () => {
      const stem = code('DUP');
      await register({ code: stem.toLowerCase() });
      const again = await asUser(
        registrar,
        `select public.register_agency_provider($1, 'Again', 'agency_banking',
           'provider_float', 'deferred')`,
        [stem.toLowerCase()],
      );
      expect(again.ok).toBe(false);
      expect(again.message).toMatch(/already registered/i);

      const row = await queryOne<{ code: string }>(
        `select code from public.agency_service_providers where code = $1`,
        [stem.toUpperCase()],
      );
      expect(row.code).toBe(stem.toUpperCase());
    });

    it('refuses a rate on a partner that reports its own commission', async () => {
      const attempt = await asUser(
        registrar,
        `select public.register_agency_provider($1, 'Reported', 'agency_banking',
           'provider_float', 'deferred', 'reported', 120)`,
        [code('RPT')],
      );
      expect(attempt.ok).toBe(false);
      expect(attempt.message).toMatch(/reports its own commission/i);
    });
  });

  describe('approving the commercial terms', () => {
    it('refuses the Owner who registered it, with SD001', async () => {
      const id = await register({ code: code('SELF') });
      const attempt = await asUser(
        registrar,
        `select public.approve_agency_provider_terms($1, null, 'checked')`,
        [id],
      );
      expect(attempt.ok).toBe(false);
      expect(attempt.code).toBe('SD001');
      expect(attempt.message).toMatch(/different Owner or Administrator/i);
    });

    it('refuses a Manager: approving a commercial agreement is not operational work', async () => {
      const id = await register({ code: code('MGR') });
      const attempt = await asUser(
        manager,
        `select public.approve_agency_provider_terms($1, null, 'checked')`,
        [id],
      );
      expect(attempt.ok).toBe(false);
      expect(attempt.code).toBe('42501');
    });

    it('refuses an approval with no agreement to have checked against', async () => {
      const id = await register({ code: code('NOREF') });
      await query(
        `update public.agency_service_providers set terms_reference = null where id = $1`,
        [id],
      );
      const attempt = await asUser(
        approver,
        `select public.approve_agency_provider_terms($1)`,
        [id],
      );
      expect(attempt.ok).toBe(false);
      expect(attempt.message).toMatch(/reference of the signed agreement/i);
    });

    it('refuses a provider that records no commission basis at all', async () => {
      const id = await register({ code: code('NOBASIS'), rateBps: null });
      const attempt = await asUser(
        approver,
        `select public.approve_agency_provider_terms($1, 'AGREEMENT-X')`,
        [id],
      );
      expect(attempt.ok).toBe(false);
      expect(attempt.message).toMatch(/nothing to approve/i);
    });

    it('clears provisional, records the trail, and leaves the provider NOT live', async () => {
      const id = await register({ code: code('OK') });
      const done = await asUserCommitted(approver, [
        {
          sql: `select public.approve_agency_provider_terms($1, null, 'Checked against clause 7')`,
          params: [id],
        },
      ]);
      expect(done.ok, done.message).toBe(true);

      const row = await queryOne<{
        is_provisional: boolean;
        is_active: boolean;
        approved_by: string;
        note: string;
      }>(
        `select is_provisional, is_active, terms_approved_by::text as approved_by,
                terms_approval_note as note
           from public.agency_service_providers where id = $1`,
        [id],
      );
      expect(row.is_provisional).toBe(false);
      expect(row.approved_by).toBe(approver.profileId);
      expect(row.note).toBe('Checked against clause 7');
      // The whole point of keeping the two decisions apart.
      expect(row.is_active).toBe(false);
    });

    it('cannot be done twice, and the terms cannot then be revised', async () => {
      const id = await register({ code: code('ONCE') });
      await asUserCommitted(approver, [
        { sql: `select public.approve_agency_provider_terms($1)`, params: [id] },
      ]);

      const again = await asUser(
        approver,
        `select public.approve_agency_provider_terms($1)`,
        [id],
      );
      expect(again.ok).toBe(false);
      expect(again.message).toMatch(/already approved/i);

      const revise = await asUser(
        registrar,
        `select public.revise_agency_provider_terms($1, null, null, 300)`,
        [id],
      );
      expect(revise.ok).toBe(false);
      expect(revise.message).toMatch(/re-negotiation/i);
    });

    it('may be corrected while unapproved, and the correction is what gets approved', async () => {
      const id = await register({ code: code('REV') });
      const revised = await asUserCommitted(registrar, [
        {
          sql: `select public.revise_agency_provider_terms($1, 'immediate', null, 250, null, 'AGREEMENT-REV-2')`,
          params: [id],
        },
      ]);
      expect(revised.ok, revised.message).toBe(true);

      await asUserCommitted(approver, [
        { sql: `select public.approve_agency_provider_terms($1)`, params: [id] },
      ]);

      const row = await queryOne<{
        model: string;
        rate: number;
        reference: string;
      }>(
        `select commission_model as model, commission_rate_bps as rate,
                terms_reference as reference
           from public.agency_service_providers where id = $1`,
        [id],
      );
      expect(row.model).toBe('immediate');
      expect(row.rate).toBe(250);
      expect(row.reference).toBe('AGREEMENT-REV-2');
    });

    it('cannot be bypassed by writing the column directly', async () => {
      const id = await register({ code: code('RAW') });

      const bare = await query(
        `update public.agency_service_providers set is_provisional = false where id = $1`,
        [id],
      ).then(
        () => 'allowed',
        (error: Error) => error.message,
      );
      expect(bare, 'a bare UPDATE must not confirm terms').not.toBe('allowed');
      expect(bare).toMatch(/must name who approved them/i);

      // And a forged trail naming the registrar is a separation-of-duties
      // failure, not a missing field.
      const forged = await query(
        `update public.agency_service_providers
            set is_provisional = false, terms_approved_by = $2,
                terms_approved_at = now(), terms_reference = 'FORGED'
          where id = $1`,
        [id, registrar.profileId],
      ).then(
        () => 'allowed',
        (error: Error) => error.message,
      );
      expect(forged).not.toBe('allowed');
      expect(forged).toMatch(/cannot also approve/i);
    });
  });

  // =========================================================================
  // Operational task 2 — agent accounts, on either model
  // =========================================================================

  describe('agent accounts', () => {
    it('mints a 1320 float account for a partner that advances float', async () => {
      const id = await register({ code: code('FLOATP') });
      const created = await asUserCommitted(registrar, [
        {
          sql: `select public.register_agency_agent_line(
                  $1, $2, 'main', 'Counter', null, 'AG-1', null, null, '1001234500001')::text as id`,
          params: [id, branch],
        },
      ]);
      expect(created.ok, created.message).toBe(true);

      const row = await queryOne<{
        holds_float: boolean;
        float_account_code: string;
        bank_account_number: string;
      }>(
        `select holds_float, float_account_code, bank_account_number
           from public.agency_agent_account_register where agent_account_id = $1`,
        [created.rows[0]?.id],
      );
      expect(row.holds_float).toBe(true);
      expect(row.float_account_code).toContain(`.${branchCode}`);
      // A bank's own account number is recorded even where float exists: the
      // partner identifies the outlet by it.
      expect(row.bank_account_number).toBe('1001234500001');
    });

    it('registers a cash-payable partner’s account and invents no float for it', async () => {
      const id = await register({ code: code('CASHP'), floatModel: 'cash_payable' });
      const created = await asUserCommitted(registrar, [
        {
          sql: `select public.register_agency_agent_line(
                  $1, $2, 'gate1', 'Main gate', null, 'SF-1', null, null, '0102003004005')::text as id`,
          params: [id, branch],
        },
      ]);
      expect(created.ok, created.message).toBe(true);

      const row = await queryOne<{
        holds_float: boolean;
        float_account_code: string | null;
        ledger_account_id: string | null;
      }>(
        `select holds_float, float_account_code, ledger_account_id::text as ledger_account_id
           from public.agency_agent_account_register where agent_account_id = $1`,
        [created.rows[0]?.id],
      );
      expect(row.holds_float).toBe(false);
      expect(row.float_account_code).toBeNull();
      expect(row.ledger_account_id).toBeNull();

      // And no 1320 account was created behind it, which is the thing that
      // would have put an asset on the balance sheet that does not exist.
      const minted = await queryOne<{ count: string }>(
        `select count(*)::text as count from public.ledger_accounts
          where code like '1320.' || (select code from public.agency_service_providers where id = $1) || '%'`,
        [id],
      );
      expect(minted.count).toBe('0');
    });

    it('requires the partner’s account number where there is no float account', async () => {
      const id = await register({ code: code('NONUM'), floatModel: 'cash_payable' });
      const attempt = await asUser(
        registrar,
        `select public.register_agency_agent_line($1, $2, 'gate1', 'No number')`,
        [id, branch],
      );
      expect(attempt.ok).toBe(false);
      expect(attempt.message).toMatch(/needs the account number/i);
    });

    it('supports several locations, and refuses one account number twice', async () => {
      const id = await register({ code: code('MULTI'), floatModel: 'cash_payable' });
      for (const [till, number] of [
        ['gate1', '0102003100001'],
        ['gate2', '0102003100002'],
      ] as const) {
        const made = await asUserCommitted(registrar, [
          {
            sql: `select public.register_agency_agent_line($1, $2, $3, $3, null, null, null, null, $4)`,
            params: [id, branch, till, number],
          },
        ]);
        expect(made.ok, made.message).toBe(true);
      }

      const count = await queryOne<{ count: string }>(
        `select count(*)::text as count from public.agency_agent_account_register
          where provider_id = $1`,
        [id],
      );
      expect(count.count).toBe('2');

      const duplicate = await asUser(
        registrar,
        `select public.register_agency_agent_line($1, $2, 'gate3', 'Dup', null, null, null, null, '0102003100001')`,
        [id, branch],
      );
      expect(duplicate.ok).toBe(false);
    });

    it('refuses a float operation against an account that holds no float', async () => {
      const id = await register({ code: code('NOFLOAT'), floatModel: 'cash_payable' });
      const made = await asUserCommitted(registrar, [
        {
          sql: `select public.register_agency_agent_line($1, $2, 'gate1', 'Gate', null, null, null, null, '0102003200001')::text as id`,
          params: [id, branch],
        },
      ]);
      const accountId = String(made.rows[0]?.id);

      // The trigger, not the function: asserted by writing the document
      // directly, so the refusal is proved to hold however the row arrives.
      const replenish = await query(
        `insert into public.agency_float_replenishments
           (float_account_id, provider_id, branch_id, amount, funding_account_id,
            provider_reference, replenishment_date, created_by)
         select $1, f.provider_id, f.branch_id, 100000,
                (select id from public.ledger_accounts
                  where cash_kind = 'cash_at_hand' and branch_id = f.branch_id limit 1),
                'DIRECT-1', current_date, $2
           from public.agency_provider_float_accounts f where f.id = $1`,
        [accountId, registrar.profileId],
      ).then(
        () => 'allowed',
        (error: Error) => error.message,
      );
      expect(replenish).not.toBe('allowed');
      expect(replenish).toMatch(/no float to purchase, replenish, trade or reconcile/i);

      const reconcile = await asUser(
        registrar,
        `select public.submit_agency_float_reconciliation($1, 100000::bigint, 'ST-1', current_date, null)`,
        [accountId],
      );
      expect(reconcile.ok).toBe(false);
    });

    it('keeps the two models apart, whichever way round the mistake is made', async () => {
      const floatP = await register({ code: code('SHAPEF') });
      const cashP = await register({ code: code('SHAPEC'), floatModel: 'cash_payable' });

      const floatWithout = await query(
        `insert into public.agency_provider_float_accounts
           (provider_id, branch_id, ledger_account_id, till_name, bank_account_number)
         values ($1, $2, null, 'sneaky', '123456')`,
        [floatP, branch],
      ).then(
        () => 'allowed',
        (error: Error) => error.message,
      );
      expect(floatWithout).not.toBe('allowed');
      expect(floatWithout).toMatch(/advances electronic float/i);

      const cashWith = await query(
        `insert into public.agency_provider_float_accounts
           (provider_id, branch_id, ledger_account_id, till_name)
         values ($1, $2,
           (select ledger_account_id from public.agency_provider_float_accounts
             where ledger_account_id is not null limit 1), 'sneaky2')`,
        [cashP, branch],
      ).then(
        () => 'allowed',
        (error: Error) => error.message,
      );
      expect(cashWith).not.toBe('allowed');
    });

    it('refuses a model change while an account is open, rather than stranding it', async () => {
      const id = await register({ code: code('FLIPOPEN'), floatModel: 'cash_payable' });
      await asUserCommitted(registrar, [
        {
          sql: `select public.register_agency_agent_line($1, $2, 'gate1', 'Gate', null, null, null, null, '0102003300001')`,
          params: [id, branch],
        },
      ]);

      const flip = await asUser(
        registrar,
        `select public.set_agency_provider_float_model($1, 'provider_float', null, 'try')`,
        [id],
      );
      expect(flip.ok).toBe(false);
      expect(flip.message).toMatch(/open agent account/i);
    });
  });

  // =========================================================================
  // Operational task 5 — limits, thresholds, the facility, and going live
  // =========================================================================

  describe('going live', () => {
    /** A provider with approved terms and nothing else. */
    async function approved(stem: string): Promise<string> {
      const id = await register({ code: code(stem) });
      const done = await asUserCommitted(approver, [
        { sql: `select public.approve_agency_provider_terms($1)`, params: [id] },
      ]);
      expect(done.ok, done.message).toBe(true);
      return id;
    }

    async function addService(provider: string): Promise<string> {
      const row = await queryOne<{ id: string }>(
        `insert into public.agency_transaction_types
           (provider_id, code, name, direction, is_active)
         values ($1, 'WITHDRAWAL', 'Cash out at the counter', 'withdrawal', true)
         returning id::text as id`,
        [provider],
      );
      return row.id;
    }

    it('refuses a provider whose terms are not approved', async () => {
      const id = await register({ code: code('LIVE1') });
      const attempt = await asUser(
        approver,
        `select public.activate_agency_provider($1, 'BOARD-MIN-1')`,
        [id],
      );
      expect(attempt.ok).toBe(false);
      expect(attempt.message).toMatch(/terms are not approved/i);
    });

    it('refuses a float partner with no approved facility', async () => {
      const id = await approved('LIVE2');
      const attempt = await asUser(
        approver,
        `select public.activate_agency_provider($1, 'BOARD-MIN-2')`,
        [id],
      );
      expect(attempt.ok).toBe(false);
      expect(attempt.message).toMatch(/no facility has been approved/i);
    });

    it('refuses the facility to the Owner who registered the provider', async () => {
      const id = await approved('LIVE3');
      const attempt = await asUser(
        registrar,
        `select public.set_agency_float_facility($1, 40000000::bigint, 'FAC-1')`,
        [id],
      );
      expect(attempt.ok).toBe(false);
      expect(attempt.code).toBe('SD001');
    });

    it('refuses a facility with no instrument behind it', async () => {
      const id = await approved('LIVE4');
      const attempt = await asUser(
        approver,
        `select public.set_agency_float_facility($1, 40000000::bigint, '  ')`,
        [id],
      );
      expect(attempt.ok).toBe(false);
      expect(attempt.message).toMatch(/instrument this facility is granted under/i);
    });

    it('refuses a facility on a partner that advances no float', async () => {
      const id = await register({ code: code('LIVE5'), floatModel: 'cash_payable' });
      await asUserCommitted(approver, [
        { sql: `select public.approve_agency_provider_terms($1)`, params: [id] },
      ]);
      const attempt = await asUser(
        approver,
        `select public.set_agency_float_facility($1, 40000000::bigint, 'FAC-5')`,
        [id],
      );
      expect(attempt.ok).toBe(false);
      expect(attempt.message).toMatch(/advances no float/i);
    });

    it('refuses a provider with no service that states a ceiling', async () => {
      const id = await approved('LIVE6');
      await asUserCommitted(approver, [
        {
          sql: `select public.set_agency_float_facility($1, 40000000::bigint, 'FAC-6')`,
          params: [id],
        },
      ]);
      const attempt = await asUser(
        approver,
        `select public.activate_agency_provider($1, 'BOARD-MIN-6')`,
        [id],
      );
      expect(attempt.ok).toBe(false);
      expect(attempt.message).toMatch(/no active service with an approved ceiling/i);
    });

    it('refuses a provider with no open agent account', async () => {
      const id = await approved('LIVE7');
      const type = await addService(id);
      await asUserCommitted(approver, [
        {
          sql: `select public.set_agency_float_facility($1, 40000000::bigint, 'FAC-7')`,
          params: [id],
        },
      ]);
      await asUserCommitted(registrar, [
        {
          sql: `select public.set_agency_service_limit($1, 5000000::bigint, 'board limit')`,
          params: [type],
        },
      ]);
      const attempt = await asUser(
        approver,
        `select public.activate_agency_provider($1, 'BOARD-MIN-7')`,
        [id],
      );
      expect(attempt.ok).toBe(false);
      expect(attempt.message).toMatch(/no open agent account/i);
    });

    /**
     * The full path, once, with every precondition met.
     *
     * Returned so the money-side tests below can use a provider that is
     * genuinely live rather than one forced into that state.
     */
    async function bringLive(
      stem: string,
      facility = 40_000_000,
    ): Promise<{
      readonly providerId: string;
      readonly typeId: string;
      readonly accountId: string;
      readonly floatCode: string;
    }> {
      const providerId = await approved(stem);
      const typeId = await addService(providerId);

      await asUserCommitted(approver, [
        {
          sql: `select public.set_agency_float_facility($1, $2::bigint, $3)`,
          params: [providerId, facility, `FAC-${stem}`],
        },
      ]);
      await asUserCommitted(registrar, [
        {
          sql: `select public.set_agency_service_limit($1, 5000000::bigint, 'board limit')`,
          params: [typeId],
        },
      ]);

      const made = await asUserCommitted(registrar, [
        {
          sql: `select public.register_agency_agent_line($1, $2, 'main', 'Counter', null, $3, null, null, $4)::text as id`,
          params: [
            providerId,
            branch,
            `AG-${stem}`,
            `10012345${String(++seq).padStart(5, '0')}`,
          ],
        },
      ]);
      const accountId = String(made.rows[0]?.id);

      const live = await asUserCommitted(approver, [
        {
          sql: `select public.activate_agency_provider($1, $2, 'Approved at the board')`,
          params: [providerId, `BOARD-MIN-${stem}`],
        },
      ]);
      expect(live.ok, live.message).toBe(true);

      const ledger = await queryOne<{ code: string }>(
        `select a.code from public.agency_provider_float_accounts f
           join public.ledger_accounts a on a.id = f.ledger_account_id
          where f.id = $1`,
        [accountId],
      );

      // Everybody who will touch this account is rostered: the roster guard
      // from client Rule 6 is enforced at the data layer and is not what this
      // file is about.
      await query(
        `insert into public.agency_account_staff
           (float_account_id, profile_id, assigned_by, notes)
         select $1, p.id, $2, 'provisioning fixture' from public.profiles p
          where p.id = any($3::uuid[])
         on conflict (float_account_id, profile_id) where status = 'active' do nothing`,
        [
          accountId,
          registrar.profileId,
          [registrar.profileId, approver.profileId, manager.profileId, clerk.profileId],
        ],
      );

      return { providerId, typeId, accountId, floatCode: ledger.code };
    }

    it('refuses the authorization to the Owner who registered the provider', async () => {
      const providerId = await approved('LIVE8');
      const typeId = await addService(providerId);
      await asUserCommitted(approver, [
        {
          sql: `select public.set_agency_float_facility($1, 40000000::bigint, 'FAC-8')`,
          params: [providerId],
        },
      ]);
      await asUserCommitted(registrar, [
        {
          sql: `select public.set_agency_service_limit($1, 5000000::bigint, 'limit')`,
          params: [typeId],
        },
      ]);
      await asUserCommitted(registrar, [
        {
          sql: `select public.register_agency_agent_line($1, $2, 'main', 'Counter', null, 'AG-8', null, null, '1001999900008')`,
          params: [providerId, branch],
        },
      ]);

      const attempt = await asUser(
        registrar,
        `select public.activate_agency_provider($1, 'BOARD-MIN-8')`,
        [providerId],
      );
      expect(attempt.ok).toBe(false);
      expect(attempt.code).toBe('SD001');
      expect(attempt.message).toMatch(/cannot also authorize it to go live/i);
    });

    it('refuses an authorization that names no instrument', async () => {
      const providerId = await approved('LIVE9');
      const attempt = await asUser(
        approver,
        `select public.activate_agency_provider($1, '   ')`,
        [providerId],
      );
      expect(attempt.ok).toBe(false);
      expect(attempt.message).toMatch(/is not an authorization/i);
    });

    it('goes live once every precondition holds, and records the instrument', async () => {
      const { providerId } = await bringLive('GOLIVE');
      const row = await queryOne<{
        is_active: boolean;
        reference: string;
        activated_by: string;
      }>(
        `select is_active, activation_reference as reference,
                activated_by::text as activated_by
           from public.agency_service_providers where id = $1`,
        [providerId],
      );
      expect(row.is_active).toBe(true);
      expect(row.reference).toBe('BOARD-MIN-GOLIVE');
      expect(row.activated_by).toBe(approver.profileId);
    });

    it('answers every precondition separately, for a screen to list', async () => {
      const { providerId } = await bringLive('READY');
      const row = await queryOne<{
        terms_approved: boolean;
        commission_decided: boolean;
        facility_approved: boolean;
        services_with_ceiling: string;
        open_agent_accounts: string;
        ready_to_activate: boolean;
      }>(
        `select terms_approved, commission_decided, facility_approved,
                services_with_ceiling::text as services_with_ceiling,
                open_agent_accounts::text as open_agent_accounts,
                ready_to_activate
           from public.agency_provider_readiness where provider_id = $1`,
        [providerId],
      );
      expect(row.terms_approved).toBe(true);
      expect(row.commission_decided).toBe(true);
      expect(row.facility_approved).toBe(true);
      expect(row.services_with_ceiling).toBe('1');
      expect(row.open_agent_accounts).toBe('1');
      expect(row.ready_to_activate).toBe(true);
    });

    it('cannot be switched on by writing the column, even once it has been live', async () => {
      const { providerId } = await bringLive('RAWLIVE');

      const off = await asUserCommitted(approver, [
        {
          sql: `select public.deactivate_agency_provider($1, 'testing the guard')`,
          params: [providerId],
        },
      ]);
      expect(off.ok, off.message).toBe(true);

      // Deactivation clears the trail, so the spent authorization cannot be
      // reused — which is the defect the first version of this had.
      const cleared = await queryOne<{ reference: string | null }>(
        `select activation_reference as reference
           from public.agency_service_providers where id = $1`,
        [providerId],
      );
      expect(cleared.reference).toBeNull();

      const bare = await query(
        `update public.agency_service_providers set is_active = true where id = $1`,
        [providerId],
      ).then(
        () => 'allowed',
        (error: Error) => error.message,
      );
      expect(bare).not.toBe('allowed');
      expect(bare).toMatch(/must name who gave it/i);
    });

    // -----------------------------------------------------------------------
    // The two money-side controls
    // -----------------------------------------------------------------------

    it('refuses float that would take a provider above its approved facility', async () => {
      const { floatCode, accountId, providerId } = await bringLive(
        'FACILITY',
        10_000_000,
      );
      const till = await queryOne<{ code: string; id: string }>(
        `select code, id::text as id from public.ledger_accounts
          where cash_kind = 'cash_at_hand' and branch_id = $1 limit 1`,
        [branch],
      );
      await fund(till.code, 50_000_000);

      const inside = await asUserCommitted(approver, [
        {
          sql: `select public.post_float_replenishment($1, 8000000::bigint, $2, 'RPL-IN', current_date)`,
          params: [accountId, till.id],
        },
      ]);
      expect(inside.ok, inside.message).toBe(true);

      const over = await asUser(
        approver,
        `select public.post_float_replenishment($1, 3000000::bigint, $2, 'RPL-OVER', current_date)`,
        [accountId, till.id],
      );
      expect(over.ok).toBe(false);
      expect(over.message).toMatch(/more than it agreed to advance/i);

      // Exactly filling it is allowed: the limit is a ceiling, not a margin.
      const exact = await asUserCommitted(approver, [
        {
          sql: `select public.post_float_replenishment($1, 2000000::bigint, $2, 'RPL-EXACT', current_date)`,
          params: [accountId, till.id],
        },
      ]);
      expect(exact.ok, exact.message).toBe(true);

      const held = await queryOne<{ balance: string }>(
        `select coalesce(balance, 0)::text as balance
           from public.ledger_account_balances
          where account_id = (select ledger_account_id from public.agency_provider_float_accounts where id = $1)`,
        [accountId],
      );
      expect(held.balance).toBe('10000000');
      expect(floatCode).toContain('1320.');

      // And the facility cannot then be cut below what is held, which would
      // make the next reconciliation read as a breach that never happened.
      const cut = await asUser(
        approver,
        `select public.set_agency_float_facility($1, 1000000::bigint, 'FAC-CUT')`,
        [providerId],
      );
      expect(cut.ok).toBe(false);
      expect(cut.message).toMatch(/more than the .* facility being approved/i);
    });

    it('counts a float purchase once, at the moment it actually posts', async () => {
      /*
        The case the first version of the facility guard got wrong.

        `post_float_replenishment()` inserts its document and *then* posts the
        journal, so at INSERT the float has not arrived and the guard must add
        the amount to what is held. `verify_agency_float_trade()` does the
        opposite: it posts the journal and *then* updates the trade to
        `posted`. By the time the guard sees that update the float is already
        in the balance, and adding the amount again refuses a purchase that
        exactly fills an empty facility — a 10,000,000 purchase against a
        10,000,000 facility computing 20,000,000.

        So this buys exactly the facility, in one trade, against a provider
        holding nothing. It passed the arithmetic the wrong way round too
        (8,000,000 + 2,000,000 never exceeds the limit from either reading),
        which is why the amount here is the whole facility.
      */
      const { providerId, accountId, floatCode } = await bringLive('PURCH', 10_000_000);
      const till = await queryOne<{ code: string; id: string }>(
        `select code, id::text as id from public.ledger_accounts
          where cash_kind = 'cash_at_hand' and branch_id = $1 limit 1`,
        [branch],
      );
      await fund(till.code, 30_000_000);

      // Both officers are on the roster already; the trade's checker must not
      // be its recorder, which is the engine's own rule.
      const recorded = await asUserCommitted(registrar, [
        {
          sql: `select public.record_agency_float_trade(
                  'purchase', $1, $2::bigint, $3, null, $4, $2::bigint, null,
                  'provider_service_centre', 'Service centre', current_date, null)::text as id`,
          params: [accountId, 10_000_000, `TRADE-${code('P')}`, till.id],
        },
      ]);
      expect(recorded.ok, recorded.message).toBe(true);

      const posted = await asUserCommitted(approver, [
        {
          sql: `select public.verify_agency_float_trade($1, null)`,
          params: [String(recorded.rows[0]?.id)],
        },
      ]);
      expect(posted.ok, posted.message).toBe(true);

      const held = await queryOne<{ balance: string }>(
        `select coalesce(balance, 0)::text as balance
           from public.ledger_account_balances
          where account_id = (select ledger_account_id
                                from public.agency_provider_float_accounts where id = $1)`,
        [accountId],
      );
      expect(held.balance).toBe('10000000');
      expect(floatCode).toContain('1320.');

      // And one shilling more is refused, from the posted reading.
      const over = await asUserCommitted(registrar, [
        {
          sql: `select public.record_agency_float_trade(
                  'purchase', $1, 1::bigint, $2, null, $3, 1::bigint, null,
                  'provider_service_centre', 'Service centre', current_date, null)::text as id`,
          params: [accountId, `TRADE-${code('P')}`, till.id],
        },
      ]);
      expect(over.ok).toBe(false);
      expect(over.message).toMatch(/more than it agreed to advance/i);

      expect(providerId).toBeTruthy();
    });

    it('lets an independent Manager or Owner verify above the threshold', async () => {
      const { providerId, typeId, accountId } = await bringLive('THRESH');
      const till = await queryOne<{ code: string; id: string }>(
        `select code, id::text as id from public.ledger_accounts
          where cash_kind = 'cash_at_hand' and branch_id = $1 limit 1`,
        [branch],
      );
      await fund(till.code, 50_000_000);
      await asUserCommitted(approver, [
        {
          sql: `select public.post_float_replenishment($1, 20000000::bigint, $2, $3, current_date)`,
          params: [accountId, till.id, `RPL-T-${code('X')}`],
        },
      ]);

      const threshold = await asUserCommitted(registrar, [
        {
          sql: `select public.set_agency_service_threshold($1, 1000000::bigint, 'owner looks above a million')`,
          params: [typeId],
        },
      ]);
      expect(threshold.ok, threshold.message).toBe(true);

      /** Record and submit a withdrawal as the clerk, returning its id. */
      const draft = async (amount: number, reference: string): Promise<string> => {
        const made = await asUserCommitted(clerk, [
          {
            sql: `select public.create_agency_transaction(
                    p_transaction_type_id => $1,
                    p_principal_amount => $2::bigint,
                    p_float_account_id => $3,
                    p_customer_identifier => $4,
                    p_customer_name => 'A Customer',
                    p_provider_reference => $4,
                    p_customer_fee => 0::bigint,
                    p_branch_id => $5)::text as id`,
            params: [typeId, amount, accountId, reference, branch],
          },
        ]);
        expect(made.ok, made.message).toBe(true);
        const id = String(made.rows[0]?.id);
        const submitted = await asUserCommitted(clerk, [
          { sql: `select public.submit_agency_transaction($1)`, params: [id] },
        ]);
        expect(submitted.ok, submitted.message).toBe(true);
        return id;
      };

      const below = await draft(900_000, `BELOW-${code('R')}`);
      const byManager = await asUserCommitted(manager, [
        { sql: `select public.verify_agency_transaction($1)`, params: [below] },
      ]);
      expect(byManager.ok, byManager.message).toBe(true);

      /*
        Above the threshold, a Manager may verify — and must not be the
        officer who recorded it.

        This asserted the opposite until migration 20261122000100. Operational
        task 5 implemented the threshold as Owner-only, which was a guess at
        decision L; the approved policy is an independent Manager or Owner,
        the rule this business already approved for bank deposits as Decision
        A rule 8. The test was wrong about the policy, not about the mechanism,
        so what changes here is who is allowed and not what is enforced.
      */
      const above = await draft(1_500_000, `ABOVE-${code('R')}`);
      const byManagerAbove = await asUserCommitted(manager, [
        { sql: `select public.verify_agency_transaction($1)`, params: [above] },
      ]);
      expect(byManagerAbove.ok, byManagerAbove.message).toBe(true);

      // And the Owner may too, which is the other half of "Manager or Owner".
      const ownerAbove = await draft(1_600_000, `OWNERABOVE-${code('R')}`);
      const byOwner = await asUserCommitted(approver, [
        { sql: `select public.verify_agency_transaction($1)`, params: [ownerAbove] },
      ]);
      expect(byOwner.ok, byOwner.message).toBe(true);

      /*
        Separation of duties is untouched by the policy change: the officer
        who recorded an above-threshold transaction still cannot verify it,
        whatever capabilities they hold. Recorded by the clerk and attempted
        by the clerk — who holds no verification capability at all — and then
        by a Manager who *is* the recorder, which is the case the policy could
        have quietly opened.
      */
      const mine = await asUserCommitted(manager, [
        {
          sql: `select public.create_agency_transaction(
                  p_transaction_type_id => $1,
                  p_principal_amount => 1700000::bigint,
                  p_float_account_id => $2,
                  p_customer_identifier => $3,
                  p_customer_name => 'Own Work',
                  p_provider_reference => $3,
                  p_customer_fee => 0::bigint,
                  p_branch_id => $4)::text as id`,
          params: [typeId, accountId, `OWN-${code('R')}`, branch],
        },
      ]);
      const mineId = String(mine.rows[0]?.id);
      await asUserCommitted(manager, [
        { sql: `select public.submit_agency_transaction($1)`, params: [mineId] },
      ]);
      const ownWork = await asUser(
        manager,
        `select public.verify_agency_transaction($1)`,
        [mineId],
      );
      expect(ownWork.ok).toBe(false);
      expect(ownWork.code).toBe('SD001');
      expect(ownWork.message).toMatch(
        /cannot be verified by the person who recorded it/i,
      );

      /*
        The capability gate itself still works, and the policy really is a
        grant rather than a rule welded into a posting path.

        Revoking the Manager's `agency:verify_high_value` — which is exactly
        how the Owner would return to Owner-only — makes the same Manager be
        refused above the threshold again. Rolled back, so the grant is intact
        for every other test. This is the assertion that would have been lost
        by simply deleting the old "Manager is refused" case.
      */
      const revoked = await draft(1_800_000, `REVOKED-${code('R')}`);

      /*
        Two things this probe has to get right, and the first version got both
        wrong.

        The DELETE is a privileged write that `authenticated` does not hold,
        so running it as the Manager is refused with 42501 before the policy
        is ever reached — which is what the first version measured. It
        therefore runs with the pooled client's own rights, and only
        `request.jwt.claim.sub` is set, so `auth.uid()` is the Manager while
        the statement itself is the owner's. Rolled back either way.

        And it needs a transaction that has *not* posted: an already-verified
        one returns its journal from the idempotent branch at the top of
        `verify_agency_transaction()` and never reaches the threshold check.
      */
      const probe = await getClient();
      let revokedCode: string | undefined;
      try {
        await probe.query('begin');
        await probe.query(`select set_config('request.jwt.claim.sub', $1, true)`, [
          manager.authUserId,
        ]);
        await probe.query(
          `delete from public.role_permissions
            where role_key = 'manager' and permission_key = 'agency:verify_high_value'`,
        );
        await probe.query(`select public.verify_agency_transaction($1)`, [revoked]);
      } catch (error) {
        revokedCode = (error as { code?: string }).code;
      } finally {
        await probe.query('rollback').catch(() => undefined);
        probe.release();
      }
      expect(revokedCode, 'the Manager must be refused once the grant is gone').toBe(
        'SD001',
      );

      const stillGranted = await queryOne<{ count: string }>(
        `select count(*)::text as count from public.role_permissions
          where role_key = 'manager' and permission_key = 'agency:verify_high_value'`,
      );
      expect(stillGranted.count, 'the revoke must have rolled back').toBe('1');

      /*
        The guarantee, not the courtesy: the trigger reads the authority
        recorded on the row, so a route that stamps somebody without the
        capability and posts directly is still refused.

        The stamp has to be a *bystander* rather than the clerk. The clerk
        records every draft here, and `agency_transactions_verifier_not_submitter`
        refuses a row whose verifier is its submitter — so stamping the clerk
        met that CHECK first and never reached the capability trigger. Both
        controls are real; this test is about the second one, so it needs
        somebody who neither recorded the transaction nor holds any agency
        verification capability.
      */
      const direct = await draft(2_000_000, `DIRECT-${code('R')}`);
      await query(
        `update public.agency_transactions set verified_by = $2 where id = $1`,
        [direct, bystander.profileId],
      );
      const posted = await query(`select public.post_agency_transaction($1)`, [
        direct,
      ]).then(
        () => 'allowed',
        (error: Error) => error.message,
      );
      expect(posted).not.toBe('allowed');
      expect(posted).toMatch(/authorized Manager or Owner/i);

      expect(providerId).toBeTruthy();
    });

    it('refuses a threshold at or above the service’s own ceiling', async () => {
      const { typeId } = await bringLive('CEILING');
      const attempt = await asUser(
        registrar,
        `select public.set_agency_service_threshold($1, 5000000::bigint, 'same as the ceiling')`,
        [typeId],
      );
      expect(attempt.ok).toBe(false);
      expect(attempt.message).toMatch(/could never be reached/i);
    });
  });

  // =========================================================================
  // The catalogue is untouched: nothing was activated by this work
  // =========================================================================

  it('leaves every catalogue provider provisional and inactive', async () => {
    const rows = await query<{ code: string }>(
      `select code from public.agency_service_providers
        where code in ('MTN_MOMO', 'AIRTEL_MONEY', 'STANBIC', 'SCHOOL_FEES',
                       'UEDCL', 'NWSC', 'DSTV', 'GOTV', 'LYCAMOBILE')
          and (is_active or not is_provisional)
        order by code`,
    );
    expect(rows).toEqual([]);
  });

  // =========================================================================
  // Operational task 4 — the two named banks, end to end
  //
  // Every control above is asserted one refusal at a time, against synthetic
  // codes. The Owner asked for something narrower and more useful: that
  // *Equity* and *Centenary* can actually be taken from nothing to live, in
  // the order an operator would do it, and that the two float models behave
  // differently at every step rather than only at registration.
  //
  // So these two walk the whole chain in one transaction each, asserting the
  // state after every step. They duplicate coverage on purpose — a chain can
  // be green link by link and still not join up, which is the failure mode a
  // per-refusal suite cannot see.
  // =========================================================================

  describe('the two named banks, end to end', () => {
    /** The cash drawer float is bought with. */
    async function till(): Promise<{ readonly id: string; readonly code: string }> {
      return queryOne<{ id: string; code: string }>(
        `select id::text as id, code from public.ledger_accounts
          where cash_kind = 'cash_at_hand' and branch_id = $1
          order by code limit 1`,
        [branch],
      );
    }

    /** What the general ledger says a float account holds. */
    async function floatBalance(accountId: string): Promise<string> {
      const row = await queryOne<{ balance: string }>(
        `select coalesce(sum(l.debit) - sum(l.credit), 0)::text as balance
           from public.journal_lines l
          where l.account_id = (
            select ledger_account_id from public.agency_provider_float_accounts
             where id = $1)`,
        [accountId],
      );
      return row.balance;
    }

    it('takes Equity Bank from registration to live, as a float partner', async () => {
      // --- 1. One Owner registers it. Provisional, inactive, no terms. ---
      const providerId = await register({
        code: code('EQUITY'),
        category: 'agency_banking',
        floatModel: 'provider_float',
        rateBps: 120,
      });
      const registered = await queryOne<{
        is_provisional: boolean;
        is_active: boolean;
        income: string;
        payable: string | null;
      }>(
        `select p.is_provisional, p.is_active, i.code as income,
                pa.code as payable
           from public.agency_service_providers p
           join public.ledger_accounts i on i.id = p.income_account_id
           left join public.ledger_accounts pa on pa.id = p.payable_account_id
          where p.id = $1`,
        [providerId],
      );
      expect(registered.is_provisional).toBe(true);
      expect(registered.is_active).toBe(false);
      // Agency banking commission, not mobile money commission.
      expect(registered.income).toBe('4520');
      // A float partner is owed nothing: the float is ours, bought up front.
      expect(registered.payable).toBeNull();

      // --- 2. A second Owner approves the commercial terms. ---
      const terms = await asUserCommitted(approver, [
        {
          sql: `select public.approve_agency_provider_terms($1, 'EQUITY-AGREEMENT-1',
                  'Signed schedule of charges')`,
          params: [providerId],
        },
      ]);
      expect(terms.ok, terms.message).toBe(true);

      const afterTerms = await queryOne<{
        is_provisional: boolean;
        is_active: boolean;
        approved_by: string;
      }>(
        `select is_provisional, is_active, terms_approved_by::text as approved_by
           from public.agency_service_providers where id = $1`,
        [providerId],
      );
      expect(afterTerms.is_provisional).toBe(false);
      // Approving terms is not switching a bank on.
      expect(afterTerms.is_active).toBe(false);
      expect(afterTerms.approved_by).toBe(approver.profileId);

      // --- 3. The float facility, against a named instrument. ---
      const facility = await asUserCommitted(approver, [
        {
          sql: `select public.set_agency_float_facility($1, 40000000::bigint,
                  'EQUITY-FACILITY-1', 'Approved at the board')`,
          params: [providerId],
        },
      ]);
      expect(facility.ok, facility.message).toBe(true);

      // --- 4. A service, its ceiling, and the threshold above which a
      //        second pair of eyes is required. ---
      const typeId = await queryOne<{ id: string }>(
        `insert into public.agency_transaction_types
           (provider_id, code, name, direction, is_active)
         values ($1, 'WITHDRAWAL', 'Cash out at the counter', 'withdrawal', true)
         returning id::text as id`,
        [providerId],
      ).then((r) => r.id);

      const ceiling = await asUserCommitted(registrar, [
        {
          sql: `select public.set_agency_service_limit($1, 5000000::bigint,
                  'per the signed schedule')`,
          params: [typeId],
        },
      ]);
      expect(ceiling.ok, ceiling.message).toBe(true);

      const threshold = await asUserCommitted(registrar, [
        {
          sql: `select public.set_agency_service_threshold($1, 1000000::bigint,
                  'second verification above a million')`,
          params: [typeId],
        },
      ]);
      expect(threshold.ok, threshold.message).toBe(true);

      // --- 5. Two locations, each with its own float account. ---
      const accounts: string[] = [];
      for (const tillName of ['counter1', 'counter2'] as const) {
        const made = await asUserCommitted(registrar, [
          {
            sql: `select public.register_agency_agent_line($1, $2, $3, $3, null, $4,
                    current_date, null, null)::text as id`,
            params: [providerId, branch, tillName, `AG-EQ-${tillName}`],
          },
        ]);
        expect(made.ok, made.message).toBe(true);
        accounts.push(String(made.rows[0]?.id));
      }

      const minted = await query<{ code: string; number: string | null }>(
        `select a.code, f.bank_account_number as number
           from public.agency_provider_float_accounts f
           join public.ledger_accounts a on a.id = f.ledger_account_id
          where f.provider_id = $1
          order by f.till_name`,
        [providerId],
      );
      expect(minted).toHaveLength(2);
      // A float partner's account is a 1320 asset of ours, and needs no
      // account number at the bank, because the float is not held there.
      for (const row of minted) {
        expect(row.code).toMatch(/^1320/);
        expect(row.number).toBeNull();
      }

      // --- 6. Float funding, inside the approved facility. ---
      const drawer = await till();
      await fund(drawer.code, 50_000_000);
      expect(await floatBalance(accounts[0]!)).toBe('0');

      const bought = await asUserCommitted(approver, [
        {
          sql: `select public.post_float_replenishment($1, 8000000::bigint, $2,
                  'EQUITY-RPL-1', current_date)`,
          params: [accounts[0], drawer.id],
        },
      ]);
      expect(bought.ok, bought.message).toBe(true);
      expect(await floatBalance(accounts[0]!)).toBe('8000000');

      // Beyond the facility it is refused, which is the point of approving one.
      const over = await asUser(
        approver,
        `select public.post_float_replenishment($1, 33000000::bigint, $2,
           'EQUITY-RPL-2', current_date)`,
        [accounts[0], drawer.id],
      );
      expect(over.ok).toBe(false);
      expect(over.message).toMatch(/facility/i);

      // --- 7. Every precondition answered, then live. ---
      const ready = await queryOne<{
        terms_approved: boolean;
        commission_decided: boolean;
        facility_approved: boolean;
        services_with_ceiling: string;
        open_agent_accounts: string;
        ready_to_activate: boolean;
      }>(
        `select terms_approved, commission_decided, facility_approved,
                services_with_ceiling::text as services_with_ceiling,
                open_agent_accounts::text as open_agent_accounts,
                ready_to_activate
           from public.agency_provider_readiness where provider_id = $1`,
        [providerId],
      );
      expect(ready.terms_approved).toBe(true);
      expect(ready.commission_decided).toBe(true);
      expect(ready.facility_approved).toBe(true);
      expect(ready.services_with_ceiling).toBe('1');
      expect(ready.open_agent_accounts).toBe('2');
      expect(ready.ready_to_activate).toBe(true);

      const live = await asUserCommitted(approver, [
        {
          sql: `select public.activate_agency_provider($1, 'BOARD-MIN-EQUITY-01',
                  'Approved at the board')`,
          params: [providerId],
        },
      ]);
      expect(live.ok, live.message).toBe(true);

      const final = await queryOne<{
        is_active: boolean;
        reference: string;
        activated_by: string;
      }>(
        `select is_active, activation_reference as reference,
                activated_by::text as activated_by
           from public.agency_service_providers where id = $1`,
        [providerId],
      );
      expect(final.is_active).toBe(true);
      expect(final.reference).toBe('BOARD-MIN-EQUITY-01');
      // Not the Owner who registered it.
      expect(final.activated_by).toBe(approver.profileId);
      expect(final.activated_by).not.toBe(registrar.profileId);
    });

    it('takes Centenary Bank live as a cash-payable partner, inventing no float', async () => {
      // --- 1. Registered against the bank's own settlement account. ---
      const providerId = await register({
        code: code('CENTENARY'),
        category: 'agency_banking',
        floatModel: 'cash_payable',
        rateBps: 95,
      });

      const registered = await queryOne<{
        income: string;
        payable: string | null;
        float_model: string;
      }>(
        `select i.code as income, pa.code as payable, p.float_model
           from public.agency_service_providers p
           join public.ledger_accounts i on i.id = p.income_account_id
           left join public.ledger_accounts pa on pa.id = p.payable_account_id
          where p.id = $1`,
        [providerId],
      );
      expect(registered.float_model).toBe('cash_payable');
      expect(registered.income).toBe('4520');
      // The whole difference between the two models: cash taken over the
      // counter for Centenary is money we owe Centenary, so it gets a
      // payable account and no float asset.
      expect(registered.payable).not.toBeNull();

      // --- 2. Terms approved by the second Owner. ---
      const terms = await asUserCommitted(approver, [
        {
          sql: `select public.approve_agency_provider_terms($1, 'CENTENARY-AGREEMENT-1',
                  'Signed agency agreement')`,
          params: [providerId],
        },
      ]);
      expect(terms.ok, terms.message).toBe(true);

      // --- 3. A service with a ceiling. No facility: there is no float to
      //        advance, and asking for one is refused. ---
      const typeId = await queryOne<{ id: string }>(
        `insert into public.agency_transaction_types
           (provider_id, code, name, direction, is_active)
         values ($1, 'DEPOSIT', 'Deposit at the counter', 'deposit', true)
         returning id::text as id`,
        [providerId],
      ).then((r) => r.id);
      await asUserCommitted(registrar, [
        {
          sql: `select public.set_agency_service_limit($1, 3000000::bigint, 'per the agreement')`,
          params: [typeId],
        },
      ]);

      const pointless = await asUser(
        approver,
        `select public.set_agency_float_facility($1, 10000000::bigint, 'CENT-FAC-1')`,
        [providerId],
      );
      expect(pointless.ok).toBe(false);

      // --- 4. Two locations, each naming the Centenary account number the
      //        takings are banked to. The number is required here, because
      //        there is no float account to identify the line instead. ---
      const missing = await asUser(
        registrar,
        `select public.register_agency_agent_line($1, $2, 'gate-a', 'Gate A')`,
        [providerId, branch],
      );
      expect(missing.ok).toBe(false);
      expect(missing.message).toMatch(/account number/i);

      const numbers = ['3100200100417', '3100200100418'] as const;
      const accounts: string[] = [];
      for (const [index, tillName] of (['gate-a', 'gate-b'] as const).entries()) {
        const made = await asUserCommitted(registrar, [
          {
            sql: `select public.register_agency_agent_line($1, $2, $3, $3, null, $4,
                    current_date, null, $5)::text as id`,
            params: [providerId, branch, tillName, `AG-CEN-${tillName}`, numbers[index]],
          },
        ]);
        expect(made.ok, made.message).toBe(true);
        accounts.push(String(made.rows[0]?.id));
      }

      const register_ = await query<{
        till_name: string;
        number: string;
        ledger_account_id: string | null;
      }>(
        `select f.till_name, f.bank_account_number as number,
                f.ledger_account_id::text as ledger_account_id
           from public.agency_provider_float_accounts f
          where f.provider_id = $1
          order by f.till_name`,
        [providerId],
      );
      expect(register_.map((r) => r.number)).toEqual([...numbers]);
      // The claim operational task 2 was written for: a cash-payable
      // partner's accounts exist without a float asset being conjured for
      // them. Nothing in the ledger pretends we hold electronic value here.
      for (const row of register_) {
        expect(row.ledger_account_id).toBeNull();
      }

      // And the same number cannot be registered at a second location.
      const duplicate = await asUser(
        registrar,
        `select public.register_agency_agent_line($1, $2, 'gate-c', 'Gate C', null, null,
           current_date, null, $3)`,
        [providerId, branch, numbers[0]],
      );
      expect(duplicate.ok).toBe(false);

      // --- 5. Live, without a facility, authorized by somebody else. ---
      const ready = await queryOne<{
        facility_approved: boolean;
        limit: string | null;
        ready_to_activate: boolean;
        open_agent_accounts: string;
      }>(
        `select facility_approved, float_facility_limit::text as limit,
                ready_to_activate,
                open_agent_accounts::text as open_agent_accounts
           from public.agency_provider_readiness where provider_id = $1`,
        [providerId],
      );
      // No facility was approved — and it is ready to go live anyway.
      expect(ready.limit).toBeNull();
      expect(ready.open_agent_accounts).toBe('2');
      expect(ready.ready_to_activate).toBe(true);
      // `facility_approved` is a *precondition* flag, not a record that a
      // facility exists: the view defines it as
      // `float_model <> 'provider_float' or limit is not null`, so for a
      // cash-payable partner it reads true vacuously, because no facility is
      // needed. Asserted rather than left implied, because reading the column
      // as "a facility has been approved" is the obvious mistake to make with
      // it, here and on the screen that lists it.
      expect(ready.facility_approved).toBe(true);

      const live = await asUserCommitted(approver, [
        {
          sql: `select public.activate_agency_provider($1, 'BOARD-MIN-CENTENARY-01',
                  'Approved at the board')`,
          params: [providerId],
        },
      ]);
      expect(live.ok, live.message).toBe(true);

      const final = await queryOne<{ is_active: boolean; reference: string }>(
        `select is_active, activation_reference as reference
           from public.agency_service_providers where id = $1`,
        [providerId],
      );
      expect(final.is_active).toBe(true);
      expect(final.reference).toBe('BOARD-MIN-CENTENARY-01');

      // Still no float account anywhere for this provider, after going live.
      const floats = await queryOne<{ count: string }>(
        `select count(*)::text as count
           from public.agency_provider_float_accounts
          where provider_id = $1 and ledger_account_id is not null`,
        [providerId],
      );
      expect(floats.count).toBe('0');
    });
  });
});
