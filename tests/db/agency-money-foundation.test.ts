/**
 * Phase 4E — the Mobile Money foundation: configuration, and the counter.
 *
 * ## What this file proves
 *
 * Four of the approved decisions change something a cashier or an Owner can
 * reach, and each is asserted here by doing the thing rather than by reading
 * the migration:
 *
 *   OD-1  three new accounts exist with the classifications the treatments
 *         need — a liability for commission we must give back, income for a
 *         discount, an expense for a premium;
 *   OD-4  an agent line has an identity that can be edited and an identity
 *         that cannot, and suspension stops new business **without** stopping
 *         the recovery of what is already there;
 *   OD-5  a withdrawal fee is either deducted from the payout or collected as
 *         its own movement of cash, and the ledger can tell which happened;
 *   OD-11 the Owner sets a service's ceiling, and nothing posts without one;
 *   plus  commission reported per transaction instead of computed from a rate.
 *
 * ## The two assertions that matter most
 *
 * `relaxes the rate requirement for a reported provider` and `still refuses a
 * configured provider with no rate` are a pair. The first is the feature; the
 * second is the proof that the relaxation is as narrow as it claims, because
 * a relaxation that leaked would let every other provider go live with its
 * commission undecided.
 *
 * And `keeps a suspended line's reversal possible` is the one that would be
 * easy to get wrong in the comfortable direction: a suspension implemented as
 * "refuse everything" would trap the float it was invoked to protect.
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
  expectError,
  hasDatabase,
  query,
  queryOne,
  skipReason,
} from '../helpers/db';

import { staffAgentAccount } from '../helpers/agency';

const describeDb = hasDatabase ? describe : describe.skip;
if (!hasDatabase) {
  describe('agency mobile money foundation', () => {
    it.skip(`skipped - ${skipReason}`, () => undefined);
  });
}

interface Line {
  readonly code: string;
  readonly debit: number;
  readonly credit: number;
}

describeDb('Phase 4E — Mobile Money foundation', () => {
  let owner: TestUser;
  let mgr: TestUser;
  let sec: TestUser;
  let branch: string;
  let cashCode: string;

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
          'phase 4e fixture')`,
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

  /**
   * A provider and one service, live. `source: 'reported'` carries no rate at
   * all, which is the configuration the relaxation is for.
   */
  async function liveProvider(opts: {
    code: string;
    source: 'configured' | 'reported';
    direction: 'deposit' | 'withdrawal';
    rateBps?: number;
    ceiling?: number | null;
    openingFloat?: number;
  }): Promise<{ providerId: string; typeId: string; tillId: string; floatCode: string }> {
    const pr = await queryOne<{ id: string }>(
      `insert into public.agency_service_providers
         (code, name, category, float_model, income_account_id,
          commission_model, commission_source,
          commission_rate_bps, commission_fixed, is_provisional, is_active)
       values ($1, $1, 'mobile_money', 'provider_float',
               (select id from public.ledger_accounts where code = '4510'),
               'deferred', $2, $3, null, false, true)
       returning id`,
      [opts.code, opts.source, opts.rateBps ?? null],
    );
    const ty = await queryOne<{ id: string }>(
      `insert into public.agency_transaction_types
         (provider_id, code, name, direction, max_single_transaction)
       values ($1, 'OP', $2, $3, $4) returning id`,
      [
        pr.id,
        `${opts.code} op`,
        opts.direction,
        opts.ceiling === undefined ? 500_000_000 : opts.ceiling,
      ],
    );
    const till = await queryOne<{ id: string }>(
      `select public.ensure_agency_float_account($1, $2) as id`,
      [pr.id, branch],
    );
    await staffAgentAccount(till.id);
    const code = await queryOne<{ code: string }>(
      `select a.code from public.agency_provider_float_accounts f
         join public.ledger_accounts a on a.id = f.ledger_account_id
        where f.id = $1`,
      [till.id],
    );
    // Opening float, here rather than in each test: a line with none refuses
    // every deposit, and "insufficient float" is not what any test below is
    // about.
    await fund(code.code, opts.openingFloat ?? 20_000_000);
    return {
      providerId: pr.id,
      typeId: ty.id,
      tillId: till.id,
      floatCode: code.code,
    };
  }

  /** Records, submits and verifies one transaction; returns its entry id. */
  async function post(
    svc: { typeId: string; tillId: string },
    amount: number,
    extra: {
      fee?: number;
      feeMode?: string | null;
      commission?: number | null;
      transactedAt?: string | null;
    } = {},
  ): Promise<{ id: string; entry: string }> {
    const key = `E4-${Math.random().toString(36).slice(2, 12)}`;
    const c = await asUserCommitted(sec, [
      {
        sql: `select public.create_agency_transaction(
                $1, $2, $3, '+256770009000', 'Counter customer', $4,
                $5, $6, null, null, $4, $7, $8) as id`,
        params: [
          svc.typeId,
          amount,
          svc.tillId,
          key,
          extra.fee ?? 0,
          extra.commission ?? null,
          extra.feeMode ?? null,
          extra.transactedAt ?? null,
        ],
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

    const row = await queryOne<{ entry: string }>(
      `select journal_entry_id::text as entry from public.agency_transactions where id = $1`,
      [id],
    );
    return { id, entry: row.entry };
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
    // No user cleanup, as in every other posting suite: this project owns its
    // database and rebuilds it from the migrations on each run, and the rows
    // these tests commit — posted transactions, a reversal, suspended lines —
    // are referenced by journal entries that a cascade cannot unpick.
    await closePool();
  });

  // =========================================================================
  // OD-1 — the three accounts, and what they are
  // =========================================================================
  describe('the accounts the new treatments need', () => {
    for (const a of [
      {
        code: '2230',
        type: 'liability',
        side: 'credit',
        parent: '2200',
        what: 'commission we have been paid and must give back',
      },
      {
        code: '4580',
        type: 'income',
        side: 'credit',
        parent: '4500',
        what: 'a discount received on a float purchase',
      },
      {
        code: '5970',
        type: 'expense',
        side: 'debit',
        parent: '5000',
        what: 'a premium paid on a float purchase',
      },
    ]) {
      it(`${a.code} is a postable ${a.side}-side ${a.type} for ${a.what}`, async () => {
        const row = await queryOne<{
          account_type: string;
          normal_side: string;
          is_postable: boolean;
          parent: string | null;
          status: string;
        }>(
          `select a.account_type, a.normal_side, a.is_postable, a.status,
                  (select p.code from public.ledger_accounts p where p.id = a.parent_id) as parent
             from public.ledger_accounts a where a.code = $1`,
          [a.code],
        );
        expect(row.account_type).toBe(a.type);
        expect(row.normal_side).toBe(a.side);
        expect(row.is_postable).toBe(true);
        expect(row.status).toBe('active');
        expect(row.parent).toBe(a.parent);
      });
    }

    it('keeps a float premium out of the float, and a discount out of customer fees', async () => {
      // The classification is the point of having them: 5970 is not 1320 and
      // 4580 is not 4570. A reader asking "what did customers pay us" must
      // not be handed a trading gain against another agent.
      const rows = await query<{ code: string; cash_kind: string | null }>(
        `select code, cash_kind from public.ledger_accounts
          where code in ('5970', '4580') order by code`,
      );
      expect(rows.map((r) => r.cash_kind)).toEqual([null, null]);
    });
  });

  // =========================================================================
  // OD-4 — an agent line's identity, and the parts of it that cannot move
  // =========================================================================
  describe('agent line identity', () => {
    let lineId: string;
    let ledgerCode: string;

    beforeAll(async () => {
      const svc = await liveProvider({
        code: 'E4IDENT',
        source: 'configured',
        direction: 'deposit',
        rateBps: 150,
      });
      lineId = svc.tillId;
      ledgerCode = svc.floatCode;
      await query(
        `update public.agency_provider_float_accounts
            set label = 'Counter one', line_msisdn = '+256772000111',
                agent_code = 'AG-0001', opened_on = current_date
          where id = $1`,
        [lineId],
      );
    });

    it('stores the label, the line number, the provider agent code and the opening date', async () => {
      const row = await queryOne<{
        label: string;
        line_msisdn: string;
        agent_code: string;
        opened_on: string;
      }>(
        `select label, line_msisdn, agent_code, opened_on::text
           from public.agency_provider_float_accounts where id = $1`,
        [lineId],
      );
      expect(row.label).toBe('Counter one');
      expect(row.line_msisdn).toBe('+256772000111');
      expect(row.agent_code).toBe('AG-0001');
      expect(row.opened_on).not.toBe('');
    });

    it('refuses a line number that is not a Ugandan mobile number', async () => {
      const err = await expectError(
        `update public.agency_provider_float_accounts set line_msisdn = '0772000111' where id = $1`,
        [lineId],
      );
      expect(err?.constraint).toBe('agency_float_msisdn_shape');
    });

    it('refuses two lines claiming the same number', async () => {
      const other = await liveProvider({
        code: 'E4IDENT2',
        source: 'configured',
        direction: 'deposit',
        rateBps: 100,
      });
      const err = await expectError(
        `update public.agency_provider_float_accounts set line_msisdn = '+256772000111' where id = $1`,
        [other.tillId],
      );
      expect(err?.message).toMatch(/agency_float_msisdn_unique/i);
    });

    it('allows two providers to use the same agent code, but not one provider twice', async () => {
      // A provider's own numbering is its own: MTN's AG-0001 and Airtel's
      // AG-0001 are different lines. Within one provider it is an identity.
      const second = await queryOne<{ id: string }>(
        `select public.ensure_agency_float_account(
            (select provider_id from public.agency_provider_float_accounts where id = $1),
            $2, 'second') as id`,
        [lineId, branch],
      );
      const err = await expectError(
        `update public.agency_provider_float_accounts set agent_code = 'AG-0001' where id = $1`,
        [second.id],
      );
      expect(err?.message).toMatch(/agency_float_agent_code_unique/i);
    });

    it('cannot be renamed, and says which account code the name is part of', async () => {
      const err = await expectError(
        `update public.agency_provider_float_accounts set till_name = 'renamed' where id = $1`,
        [lineId],
      );
      expect(err?.message).toMatch(/part of its ledger account code/i);
      expect(err?.message).toContain(ledgerCode);
    });

    it('cannot be re-pointed at another ledger account', async () => {
      const err = await expectError(
        `update public.agency_provider_float_accounts
            set ledger_account_id = (select id from public.ledger_accounts where code = $2)
          where id = $1`,
        [lineId, '1310'],
      );
      expect(err?.message).toMatch(/posted history belongs to the account it has/i);
    });

    it('cannot be moved to another provider or branch', async () => {
      const err = await expectError(
        `update public.agency_provider_float_accounts
            set provider_id = (select id from public.agency_service_providers where code = 'E4IDENT2')
          where id = $1`,
        [lineId],
      );
      expect(err?.message).toMatch(/cannot be moved to another provider or branch/i);
    });

    it('refuses a closing date before the opening date', async () => {
      const err = await expectError(
        `update public.agency_provider_float_accounts
            set closed_on = current_date - 400 where id = $1`,
        [lineId],
      );
      // Either ordering or the closed-state rule may fire first; both are the
      // schema refusing an impossible line.
      expect(err?.constraint).toMatch(/agency_float_(dates_in_order|closed_has_date)/);
    });

    it('writes every administrative change to the general audit log, with both values', async () => {
      await query(
        `update public.agency_provider_float_accounts set label = 'Counter one (renamed)' where id = $1`,
        [lineId],
      );
      const row = await queryOne<{
        action: string;
        old_label: string | null;
        new_label: string | null;
      }>(
        `select action,
                old_values->>'label' as old_label,
                new_values->>'label' as new_label
           from public.audit_log
          where entity_type = 'agency_agent_line' and entity_id = $1
            and action = 'agency_agent_line.updated'
          order by id desc limit 1`,
        [lineId],
      );
      expect(row.action).toBe('agency_agent_line.updated');
      expect(row.old_label).toBe('Counter one');
      expect(row.new_label).toBe('Counter one (renamed)');
    });
  });

  // =========================================================================
  // OD-4 — suspension stops new business, not recovery
  // =========================================================================
  describe('suspension and closure', () => {
    it('refuses an is_active that disagrees with the status', async () => {
      const svc = await liveProvider({
        code: 'E4SUSP0',
        source: 'configured',
        direction: 'deposit',
        rateBps: 150,
      });
      const err = await expectError(
        `update public.agency_provider_float_accounts set is_active = false where id = $1`,
        [svc.tillId],
      );
      expect(err?.constraint).toBe('agency_float_status_matches_is_active');
    });

    it('refuses a suspension with no reason, actor or time', async () => {
      const svc = await liveProvider({
        code: 'E4SUSP1',
        source: 'configured',
        direction: 'deposit',
        rateBps: 150,
      });
      const err = await expectError(
        `update public.agency_provider_float_accounts
            set status = 'suspended', is_active = false where id = $1`,
        [svc.tillId],
      );
      expect(err?.constraint).toBe('agency_float_inactive_states_reason');
    });

    it('accepts a reasoned suspension, and the line reads as inactive', async () => {
      const svc = await liveProvider({
        code: 'E4SUSP2',
        source: 'configured',
        direction: 'deposit',
        rateBps: 150,
      });
      await query(
        `update public.agency_provider_float_accounts
            set status = 'suspended', is_active = false,
                status_reason = 'SIM swap reported to the provider',
                status_changed_by = $2, status_changed_at = now()
          where id = $1`,
        [svc.tillId, owner.profileId],
      );
      const row = await queryOne<{ status: string; is_active: boolean; reason: string }>(
        `select status, is_active, status_reason as reason
           from public.agency_provider_float_accounts where id = $1`,
        [svc.tillId],
      );
      expect(row.status).toBe('suspended');
      expect(row.is_active).toBe(false);
      expect(row.reason).toMatch(/SIM swap/);
    });

    it('stops new business on a suspended line', async () => {
      const svc = await liveProvider({
        code: 'E4SUSP3',
        source: 'configured',
        direction: 'deposit',
        rateBps: 150,
      });
      await query(
        `update public.agency_provider_float_accounts
            set status = 'suspended', is_active = false,
                status_reason = 'float withheld by the provider',
                status_changed_by = $2, status_changed_at = now()
          where id = $1`,
        [svc.tillId, owner.profileId],
      );
      const r = await asUser(
        sec,
        `select public.create_agency_transaction($1, 50000, $2, '+256770009001', 'C', 'R1')`,
        [svc.typeId, svc.tillId],
      );
      expect(r.ok).toBe(false);
      expect(r.message).toMatch(/not active|suspend/i);
    });

    it('keeps a suspended line’s reversal possible, which is what the float is recovered through', async () => {
      // OD-4: "Emergency suspension immediately stops new activity while
      // retaining balances, histories and authorized recovery operations."
      // A suspension implemented as "refuse everything" would trap the float
      // it was invoked to protect.
      const svc = await liveProvider({
        code: 'E4SUSP4',
        source: 'configured',
        direction: 'deposit',
        rateBps: 150,
      });

      const posted = await post({ typeId: svc.typeId, tillId: svc.tillId }, 60_000);

      await query(
        `update public.agency_provider_float_accounts
            set status = 'suspended', is_active = false,
                status_reason = 'agent line compromised',
                status_changed_by = $2, status_changed_at = now()
          where id = $1`,
        [svc.tillId, owner.profileId],
      );

      const rev = await asUserCommitted(owner, [
        {
          sql: `select public.reverse_agency_transaction($1, 'recovering the line')`,
          params: [posted.id],
        },
      ]);
      expect(rev.ok, rev.message).toBe(true);
    });

    it('requires a closing date to close, and forbids one while active', async () => {
      const svc = await liveProvider({
        code: 'E4CLOSE',
        source: 'configured',
        direction: 'deposit',
        rateBps: 150,
      });
      const noDate = await expectError(
        `update public.agency_provider_float_accounts
            set status = 'closed', is_active = false, status_reason = 'line retired',
                status_changed_by = $2, status_changed_at = now()
          where id = $1`,
        [svc.tillId, owner.profileId],
      );
      expect(noDate?.constraint).toBe('agency_float_closed_has_date');

      const dateWhileActive = await expectError(
        `update public.agency_provider_float_accounts
            set closed_on = current_date where id = $1`,
        [svc.tillId],
      );
      expect(dateWhileActive?.constraint).toBe('agency_float_closed_has_date');
    });
  });

  // =========================================================================
  // OD-11 — the Owner sets a service's ceiling
  // =========================================================================
  describe('service ceilings', () => {
    let typeId: string;

    beforeAll(async () => {
      const svc = await liveProvider({
        code: 'E4LIMIT',
        source: 'configured',
        direction: 'deposit',
        rateBps: 150,
        ceiling: null,
      });
      typeId = svc.typeId;
    });

    it('refuses a manager, because configuration is the Owner’s', async () => {
      const r = await asUser(mgr, `select public.set_agency_service_limit($1, 1000000)`, [
        typeId,
      ]);
      expect(r.ok).toBe(false);
      expect(r.code).toBe('42501');
    });

    it('refuses NULL, which is what "nobody decided" already says', async () => {
      const r = await asUser(owner, `select public.set_agency_service_limit($1, null)`, [
        typeId,
      ]);
      expect(r.ok).toBe(false);
      expect(r.message).toMatch(/must be a positive amount/i);
    });

    it('refuses zero, which is not "no limit" but "nothing may be transacted"', async () => {
      const r = await asUser(owner, `select public.set_agency_service_limit($1, 0)`, [
        typeId,
      ]);
      expect(r.ok).toBe(false);
      expect(r.message).toMatch(/positive amount/i);
    });

    it('sets the ceiling and records the Owner’s reason in the audit trail', async () => {
      const r = await asUserCommitted(owner, [
        {
          sql: `select public.set_agency_service_limit($1, 2000000, 'board minute 14')`,
          params: [typeId],
        },
      ]);
      expect(r.ok, r.message).toBe(true);

      const row = await queryOne<{ ceiling: string }>(
        `select max_single_transaction::text as ceiling
           from public.agency_transaction_types where id = $1`,
        [typeId],
      );
      expect(Number(row.ceiling)).toBe(2_000_000);

      const audit = await queryOne<{ reason: string; old: string | null; neu: string }>(
        `select metadata->>'reason' as reason,
                old_values->>'max_single_transaction' as old,
                new_values->>'max_single_transaction' as neu
           from public.audit_log
          where entity_type = 'agency_service_type' and entity_id = $1
            and action = 'agency_service_type.limit_set'
          order by id desc limit 1`,
        [typeId],
      );
      expect(audit.reason).toBe('board minute 14');
      expect(audit.old).toBeNull();
      expect(audit.neu).toBe('2000000');
    });

    it('is what makes the service postable at all', async () => {
      // Before the ceiling the readiness guard refuses; after it, the same
      // transaction records and posts. OD-11's "provider activation requires
      // an approved ceiling", asserted rather than described.
      const svc = await liveProvider({
        code: 'E4LIMIT2',
        source: 'configured',
        direction: 'deposit',
        rateBps: 150,
        ceiling: null,
      });

      const key = `E4L-${Math.random().toString(36).slice(2, 10)}`;
      const created = await asUserCommitted(sec, [
        {
          sql: `select public.create_agency_transaction($1, 40000, $2, '+256770009002', 'C', $3, 0, null, null, null, $3) as id`,
          params: [svc.typeId, svc.tillId, key],
        },
      ]);
      expect(created.ok, created.message).toBe(true);
      const id = (created.rows[0] as { id: string }).id;

      const blocked = await asUserCommitted(sec, [
        { sql: `select public.submit_agency_transaction($1)`, params: [id] },
      ]);
      expect(blocked.ok).toBe(false);
      expect(blocked.message).toMatch(/states no maximum single transaction/i);

      const set = await asUserCommitted(owner, [
        {
          sql: `select public.set_agency_service_limit($1, 1000000, 'launch ceiling')`,
          params: [svc.typeId],
        },
      ]);
      expect(set.ok, set.message).toBe(true);

      const submitted = await asUserCommitted(sec, [
        { sql: `select public.submit_agency_transaction($1)`, params: [id] },
      ]);
      expect(submitted.ok, submitted.message).toBe(true);
    });
  });

  // =========================================================================
  // Commission reported per transaction, instead of computed from a rate
  // =========================================================================
  describe('commission the provider reports', () => {
    it('refuses a provider that both reports and configures a commission', async () => {
      const err = await expectError(
        `insert into public.agency_service_providers
           (code, name, category, float_model, income_account_id,
            commission_model, commission_source, commission_rate_bps, is_provisional, is_active)
         values ('E4BOTH', 'E4BOTH', 'mobile_money', 'provider_float',
                 (select id from public.ledger_accounts where code = '4510'),
                 'deferred', 'reported', 150, false, true)`,
      );
      expect(err?.constraint).toBe('agency_providers_reported_states_no_rate');
    });

    it('relaxes the rate requirement for a reported provider', async () => {
      // The feature. A confirmed, active, reported-commission provider with
      // no rate and no fixed amount posts, where Phase 4A refused it.
      const svc = await liveProvider({
        code: 'E4REP1',
        source: 'reported',
        direction: 'deposit',
      });

      const posted = await post({ typeId: svc.typeId, tillId: svc.tillId }, 100_000, {
        commission: 700,
      });

      const lines = await linesOf(posted.entry);
      expect(lines).toEqual([
        { code: cashCode, debit: 100_000, credit: 0 },
        { code: svc.floatCode, debit: 0, credit: 100_000 },
        { code: '1310', debit: 700, credit: 0 },
        { code: '4510', debit: 0, credit: 700 },
      ]);
    });

    it('still refuses a configured provider with no rate, so the relaxation is narrow', async () => {
      // The pair to the test above. If the relaxation leaked, every provider
      // could go live with its commission undecided.
      const err = await expectError(
        `insert into public.agency_service_providers
           (code, name, category, float_model, income_account_id,
            commission_model, commission_source, is_provisional, is_active)
         values ('E4CFG0', 'E4CFG0', 'mobile_money', 'provider_float',
                 (select id from public.ledger_accounts where code = '4510'),
                 'deferred', 'configured', false, true)`,
      );
      expect(err?.constraint).toBe('agency_providers_confirmed_states_commission');
    });

    it('snapshots the basis as reported, so a later change cannot restate it', async () => {
      const svc = await liveProvider({
        code: 'E4REP2',
        source: 'reported',
        direction: 'deposit',
      });
      const posted = await post({ typeId: svc.typeId, tillId: svc.tillId }, 50_000, {
        commission: 0,
      });
      const row = await queryOne<{
        basis: string;
        amount: string;
        computed: string;
        exception: string | null;
      }>(
        `select commission_basis_applied as basis, commission_amount::text as amount,
                commission_computed::text as computed, commission_exception_reason as exception
           from public.agency_transactions where id = $1`,
        [posted.id],
      );
      expect(row.basis).toBe('reported');
      // A stated zero is an answer, and it needs no Owner authorisation
      // because there is no configured figure for it to differ from.
      expect(row.amount).toBe('0');
      expect(row.computed).toBe('0');
      expect(row.exception).toBeNull();
    });

    it('requires the figure, because a missing one is not a zero', async () => {
      const svc = await liveProvider({
        code: 'E4REP3',
        source: 'reported',
        direction: 'deposit',
      });
      const key = `E4R-${Math.random().toString(36).slice(2, 10)}`;
      const created = await asUserCommitted(sec, [
        {
          sql: `select public.create_agency_transaction($1, 10000, $2, '+256770009003', 'C', $3, 0, null, null, null, $3) as id`,
          params: [svc.typeId, svc.tillId, key],
        },
      ]);
      expect(created.ok, created.message).toBe(true);
      const id = (created.rows[0] as { id: string }).id;
      const submitted = await asUserCommitted(sec, [
        { sql: `select public.submit_agency_transaction($1)`, params: [id] },
      ]);
      expect(submitted.ok, submitted.message).toBe(true);
      const verified = await asUserCommitted(mgr, [
        { sql: `select public.verify_agency_transaction($1)`, params: [id] },
      ]);
      expect(verified.ok).toBe(false);
      expect(verified.message).toMatch(
        /amount from the confirmation message is required/i,
      );
    });

    it('refuses a reported commission larger than its own principal', async () => {
      const svc = await liveProvider({
        code: 'E4REP4',
        source: 'reported',
        direction: 'deposit',
      });
      // Revoked from `authenticated` by design — the engine calls it, a
      // session never does — so it is probed here as the schema owner.
      const err = await expectError(
        `select * from public.agency_commission_reconcile($1, 1000, 1001)`,
        [svc.providerId],
      );
      expect(err?.message).toMatch(/cannot exceed the principal/i);
    });

    it('tells a caller plainly that there is no configured figure to compute', async () => {
      const svc = await liveProvider({
        code: 'E4REP5',
        source: 'reported',
        direction: 'deposit',
      });
      const err = await expectError(`select public.agency_commission_for($1, 100000)`, [
        svc.providerId,
      ]);
      expect(err?.message).toMatch(/no configured figure to compute/i);
    });

    it('leaves a configured provider computing exactly as it did', async () => {
      const svc = await liveProvider({
        code: 'E4CFG1',
        source: 'configured',
        direction: 'deposit',
        rateBps: 150,
      });
      const row = await queryOne<{ amount: string; basis: string }>(
        `select amount::text, basis from public.agency_commission_for($1, 100000)`,
        [svc.providerId],
      );
      expect(row.amount).toBe('1500');
      expect(row.basis).toBe('rate');
    });

    it('is the Owner\u2019s to set, and only while the provider is still provisional', async () => {
      const pr = await queryOne<{ id: string }>(
        `insert into public.agency_service_providers
           (code, name, category, float_model, income_account_id,
            commission_model, commission_source, is_provisional, is_active)
         values ('E4SRC', 'E4SRC', 'mobile_money', 'provider_float',
                 (select id from public.ledger_accounts where code = '4510'),
                 'deferred', 'configured', true, false)
         returning id`,
      );

      const asManager = await asUser(
        mgr,
        `select public.set_agency_provider_commission_source($1, 'reported')`,
        [pr.id],
      );
      expect(asManager.ok).toBe(false);
      expect(asManager.code).toBe('42501');

      const set = await asUserCommitted(owner, [
        {
          sql: `select public.set_agency_provider_commission_source($1, 'reported', 'MoMo commission arrives per transaction')`,
          params: [pr.id],
        },
      ]);
      expect(set.ok, set.message).toBe(true);

      const row = await queryOne<{ source: string }>(
        `select commission_source as source from public.agency_service_providers where id = $1`,
        [pr.id],
      );
      expect(row.source).toBe('reported');

      await query(
        `update public.agency_service_providers set is_provisional = false where id = $1`,
        [pr.id],
      );
      const afterConfirm = await asUser(
        owner,
        `select public.set_agency_provider_commission_source($1, 'configured')`,
        [pr.id],
      );
      expect(afterConfirm.ok).toBe(false);
      expect(afterConfirm.message).toMatch(/already confirmed/i);
    });

    it('leaves MTN and Airtel configured and provisional, deciding nothing for the business', async () => {
      const rows = await query<{
        code: string;
        source: string;
        provisional: boolean;
        active: boolean;
      }>(
        `select code, commission_source as source, is_provisional as provisional,
                is_active as active
           from public.agency_service_providers
          where code in ('MTN_MOMO', 'AIRTEL_MONEY') order by code`,
      );
      expect(rows).toHaveLength(2);
      for (const r of rows) {
        expect(r.source).toBe('configured');
        expect(r.provisional).toBe(true);
        expect(r.active).toBe(false);
      }
    });
  });

  // =========================================================================
  // OD-5 — a withdrawal fee deducted, or collected
  // =========================================================================
  describe('the customer fee on a withdrawal', () => {
    async function withdrawalLine(code: string) {
      const svc = await liveProvider({
        code,
        source: 'reported',
        direction: 'withdrawal',
      });
      return svc;
    }

    it('refuses a fee mode on a deposit, where the fee is always on top', async () => {
      const svc = await liveProvider({
        code: 'E4FEE0',
        source: 'reported',
        direction: 'deposit',
      });
      const r = await asUser(
        sec,
        `select public.create_agency_transaction($1, 10000, $2, '+256770009010', 'C', 'FM0', 500, 0, null, null, 'FM0', 'collect_separately')`,
        [svc.typeId, svc.tillId],
      );
      expect(r.ok).toBe(false);
      expect(r.message).toMatch(/always collected on top/i);
    });

    it('refuses a fee mode with no fee to apply it to', async () => {
      const svc = await withdrawalLine('E4FEE1');
      const r = await asUser(
        sec,
        `select public.create_agency_transaction($1, 10000, $2, '+256770009011', 'C', 'FM1', 0, 0, null, null, 'FM1', 'collect_separately')`,
        [svc.typeId, svc.tillId],
      );
      expect(r.ok).toBe(false);
      expect(r.message).toMatch(/no fee to apply it to/i);
    });

    it('deducts the fee from the payout by default, exactly as Phase 4B did', async () => {
      const svc = await withdrawalLine('E4FEE2');
      const before = await balance(cashCode);
      const posted = await post({ typeId: svc.typeId, tillId: svc.tillId }, 50_000, {
        fee: 500,
        commission: 300,
      });
      expect(await linesOf(posted.entry)).toEqual([
        { code: svc.floatCode, debit: 50_000, credit: 0 },
        { code: cashCode, debit: 0, credit: 49_500 },
        { code: '4570', debit: 0, credit: 500 },
        { code: '1310', debit: 300, credit: 0 },
        { code: '4510', debit: 0, credit: 300 },
      ]);
      expect(await balance(cashCode)).toBe(before - 49_500);
    });

    it('collects it as its own movement of cash when told to, and the entry says so', async () => {
      // 50,000 goes out and 500 comes in: two lines on the same cash account,
      // in opposite directions. A day of fees collected this way but booked as
      // deductions would understate both the cash paid out and the cash
      // received by the same amount, and a physical count reconciles against
      // movements.
      const svc = await withdrawalLine('E4FEE3');
      const before = await balance(cashCode);
      const posted = await post({ typeId: svc.typeId, tillId: svc.tillId }, 50_000, {
        fee: 500,
        feeMode: 'collect_separately',
        commission: 300,
      });
      expect(await linesOf(posted.entry)).toEqual([
        { code: svc.floatCode, debit: 50_000, credit: 0 },
        { code: cashCode, debit: 0, credit: 50_000 },
        { code: cashCode, debit: 500, credit: 0 },
        { code: '4570', debit: 0, credit: 500 },
        { code: '1310', debit: 300, credit: 0 },
        { code: '4510', debit: 0, credit: 300 },
      ]);
      // The net is identical to the deducted presentation, which is the
      // point: the same transaction, told truthfully.
      expect(await balance(cashCode)).toBe(before - 49_500);
    });

    it('recognises the same fee income either way', async () => {
      const svc = await withdrawalLine('E4FEE4');
      const before = await balance('4570');
      await post({ typeId: svc.typeId, tillId: svc.tillId }, 20_000, {
        fee: 400,
        commission: 100,
      });
      await post({ typeId: svc.typeId, tillId: svc.tillId }, 20_000, {
        fee: 400,
        feeMode: 'collect_separately',
        commission: 100,
      });
      expect(await balance('4570')).toBe(before + 800);
    });

    it('treats a change of fee mode as a different transaction, not a retry', async () => {
      const svc = await withdrawalLine('E4FEE5');
      const key = `E4F-${Math.random().toString(36).slice(2, 10)}`;
      const first = await asUserCommitted(sec, [
        {
          sql: `select public.create_agency_transaction($1, 10000, $2, '+256770009012', 'C', $3, 500, 0, null, null, $3, 'deduct_from_payout') as id`,
          params: [svc.typeId, svc.tillId, key],
        },
      ]);
      expect(first.ok, first.message).toBe(true);

      const retried = await asUser(
        sec,
        `select public.create_agency_transaction($1, 10000, $2, '+256770009012', 'C', $3, 500, 0, null, null, $3, 'collect_separately')`,
        [svc.typeId, svc.tillId, key],
      );
      expect(retried.ok).toBe(false);
      expect(retried.message).toMatch(/already recorded for a different transaction/i);
    });
  });

  // =========================================================================
  // OD-12 — three timestamps, each answering a different question
  // =========================================================================
  describe('the provider\u2019s own timestamp', () => {
    it('is optional, stored, and does not decide the business date', async () => {
      const svc = await liveProvider({
        code: 'E4TIME',
        source: 'reported',
        direction: 'deposit',
      });
      const posted = await post({ typeId: svc.typeId, tillId: svc.tillId }, 10_000, {
        commission: 50,
        transactedAt: '2026-11-08T21:45:00Z',
      });
      const row = await queryOne<{
        business_date: string;
        transacted: string;
        entered: string;
      }>(
        `select transaction_date::text as business_date,
                transacted_at::text    as transacted,
                created_at::text       as entered
           from public.agency_transactions where id = $1`,
        [posted.id],
      );
      // The business date is today in Africa/Kampala, whatever instant the
      // provider's system stamped.
      const today = await queryOne<{ d: string }>(
        `select public.business_date()::text as d`,
      );
      expect(row.business_date).toBe(today.d);
      expect(row.transacted).toContain('2026-11-08');
      expect(row.entered).not.toBe('');
    });

    it('is not required, and its absence changes nothing', async () => {
      const svc = await liveProvider({
        code: 'E4TIME2',
        source: 'reported',
        direction: 'deposit',
      });
      const posted = await post({ typeId: svc.typeId, tillId: svc.tillId }, 10_000, {
        commission: 50,
      });
      const row = await queryOne<{ transacted: string | null }>(
        `select transacted_at::text as transacted from public.agency_transactions where id = $1`,
        [posted.id],
      );
      expect(row.transacted).toBeNull();
    });
  });

  // =========================================================================
  // OD-4 — the Owner's five controls over a line
  // =========================================================================
  describe('agent line administration', () => {
    async function obligations(tillId: string): Promise<string[]> {
      const r = await queryOne<{ v: string[] }>(
        `select public.agency_agent_line_obligations($1) as v`,
        [tillId],
      );
      return r.v;
    }

    async function register(
      providerId: string,
      till: string,
      who: TestUser = owner,
      label = 'Counter',
    ) {
      return asUserCommitted(who, [
        {
          sql: `select public.register_agency_agent_line($1, $2, $3, $4, $5, $6) as id`,
          params: [providerId, branch, till, label, null, null],
        },
      ]);
    }

    /** A provider with no lines, so registration is the first thing done to it. */
    async function bareProvider(code: string): Promise<string> {
      const pr = await queryOne<{ id: string }>(
        `insert into public.agency_service_providers
           (code, name, category, float_model, income_account_id,
            commission_model, commission_source, is_provisional, is_active)
         values ($1, $1, 'mobile_money', 'provider_float',
                 (select id from public.ledger_accounts where code = '4510'),
                 'deferred', 'reported', false, true)
         returning id`,
        [code],
      );
      return pr.id;
    }

    it('registers a line, mints its ledger account and records its identity', async () => {
      const providerId = await bareProvider('E4ADM1');
      const r = await asUserCommitted(owner, [
        {
          sql: `select public.register_agency_agent_line(
                  $1, $2, 'counter1', 'Counter one', '+256772777001', 'AG-7001',
                  current_date, 'opened for the pilot') as id`,
          params: [providerId, branch],
        },
      ]);
      expect(r.ok, r.message).toBe(true);
      const id = (r.rows[0] as { id: string }).id;

      const row = await queryOne<{
        till_name: string;
        label: string;
        msisdn: string;
        agent_code: string;
        status: string;
        code: string;
        opened: string;
      }>(
        `select f.till_name, f.label, f.line_msisdn as msisdn, f.agent_code,
                f.status, a.code, f.opened_on::text as opened
           from public.agency_provider_float_accounts f
           join public.ledger_accounts a on a.id = f.ledger_account_id
          where f.id = $1`,
        [id],
      );
      expect(row.till_name).toBe('counter1');
      expect(row.label).toBe('Counter one');
      expect(row.msisdn).toBe('+256772777001');
      expect(row.agent_code).toBe('AG-7001');
      expect(row.status).toBe('active');
      expect(row.code).toMatch(/^1320\.E4ADM1\./);
      expect(row.opened).not.toBe('');
    });

    it('is the Owner\u2019s to do, not a Manager\u2019s', async () => {
      const providerId = await bareProvider('E4ADM2');
      const r = await register(providerId, 'counter1', mgr);
      expect(r.ok).toBe(false);
      expect(r.code).toBe('42501');
    });

    it('refuses a till name the provider already uses at that branch', async () => {
      // `ensure_agency_float_account()` is idempotent, which is right for a
      // seed and wrong for a form: the Owner would be told a line was created
      // while their details were discarded.
      const providerId = await bareProvider('E4ADM3');
      expect((await register(providerId, 'counter1')).ok).toBe(true);
      const again = await register(providerId, 'counter1');
      expect(again.ok).toBe(false);
      expect(again.message).toMatch(/already has a line called counter1/i);
    });

    it('refuses a blank till name', async () => {
      const providerId = await bareProvider('E4ADM4');
      const r = await register(providerId, '   ');
      expect(r.ok).toBe(false);
      expect(r.message).toMatch(/needs a till name/i);
    });

    it('edits the identity, leaves a NULL alone and clears an empty string', async () => {
      const providerId = await bareProvider('E4ADM5');
      const id = ((await register(providerId, 'counter1')).rows[0] as { id: string }).id;
      await asUserCommitted(owner, [
        {
          sql: `select public.update_agency_agent_line($1, 'Renamed', '+256772777005', 'AG-7005', 'a note')`,
          params: [id],
        },
      ]);

      // A NULL leaves the label alone while the note changes.
      const partial = await asUserCommitted(owner, [
        {
          sql: `select public.update_agency_agent_line($1, null, null, null, 'a different note')`,
          params: [id],
        },
      ]);
      expect(partial.ok, partial.message).toBe(true);

      let row = await queryOne<{ label: string; notes: string; msisdn: string }>(
        `select label, notes, line_msisdn as msisdn
           from public.agency_provider_float_accounts where id = $1`,
        [id],
      );
      expect(row.label).toBe('Renamed');
      expect(row.notes).toBe('a different note');
      expect(row.msisdn).toBe('+256772777005');

      // An empty string clears.
      await asUserCommitted(owner, [
        {
          sql: `select public.update_agency_agent_line($1, null, '', null, null)`,
          params: [id],
        },
      ]);
      row = await queryOne(
        `select label, notes, line_msisdn as msisdn
           from public.agency_provider_float_accounts where id = $1`,
        [id],
      );
      expect(row.msisdn).toBeNull();
    });

    it('suspends with a reason, and refuses a second suspension', async () => {
      const providerId = await bareProvider('E4ADM6');
      const id = ((await register(providerId, 'counter1')).rows[0] as { id: string }).id;

      const noReason = await asUser(
        owner,
        `select public.set_agency_agent_line_suspended($1, true, '  ')`,
        [id],
      );
      expect(noReason.ok).toBe(false);
      expect(noReason.message).toMatch(/each need a reason/i);

      const done = await asUserCommitted(owner, [
        {
          sql: `select public.set_agency_agent_line_suspended($1, true, 'SIM swap reported')`,
          params: [id],
        },
      ]);
      expect(done.ok, done.message).toBe(true);

      const row = await queryOne<{ status: string; active: boolean; reason: string }>(
        `select status, is_active as active, status_reason as reason
           from public.agency_provider_float_accounts where id = $1`,
        [id],
      );
      expect(row.status).toBe('suspended');
      expect(row.active).toBe(false);
      expect(row.reason).toMatch(/SIM swap/);

      const twice = await asUser(
        owner,
        `select public.set_agency_agent_line_suspended($1, true, 'again')`,
        [id],
      );
      expect(twice.ok).toBe(false);
      expect(twice.message).toMatch(/already suspended/i);
    });

    it('lifts a suspension, and puts that reason where the row cannot keep it', async () => {
      const providerId = await bareProvider('E4ADM7');
      const id = ((await register(providerId, 'counter1')).rows[0] as { id: string }).id;
      await asUserCommitted(owner, [
        {
          sql: `select public.set_agency_agent_line_suspended($1, true, 'reported stolen')`,
          params: [id],
        },
      ]);

      const back = await asUserCommitted(owner, [
        {
          sql: `select public.set_agency_agent_line_suspended($1, false, 'handset recovered')`,
          params: [id],
        },
      ]);
      expect(back.ok, back.message).toBe(true);

      const row = await queryOne<{
        status: string;
        active: boolean;
        reason: string | null;
      }>(
        `select status, is_active as active, status_reason as reason
           from public.agency_provider_float_accounts where id = $1`,
        [id],
      );
      expect(row.status).toBe('active');
      expect(row.active).toBe(true);
      expect(row.reason).toBeNull();

      // The row's columns are cleared when a suspension is lifted, so the
      // reason it was lifted lives in the audit log or nowhere.
      const audit = await queryOne<{ action: string; reason: string }>(
        `select action, new_values->>'reason' as reason
           from public.audit_log
          where entity_type = 'agency_agent_line' and entity_id = $1
            and action = 'agency_agent_line.reinstated'
          order by id desc limit 1`,
        [id],
      );
      expect(audit.reason).toBe('handset recovered');

      const notSuspended = await asUser(
        owner,
        `select public.set_agency_agent_line_suspended($1, false, 'again')`,
        [id],
      );
      expect(notSuspended.ok).toBe(false);
      expect(notSuspended.message).toMatch(/is not suspended/i);
    });

    it('closes a clean line, with a reason and a closing date', async () => {
      const providerId = await bareProvider('E4ADM8');
      const id = ((await register(providerId, 'counter1')).rows[0] as { id: string }).id;
      expect(await obligations(id)).toEqual([]);

      const r = await asUserCommitted(owner, [
        {
          sql: `select public.close_agency_agent_line($1, 'provider withdrew the line')`,
          params: [id],
        },
      ]);
      expect(r.ok, r.message).toBe(true);

      const row = await queryOne<{ status: string; closed: string; reason: string }>(
        `select status, closed_on::text as closed, status_reason as reason
           from public.agency_provider_float_accounts where id = $1`,
        [id],
      );
      expect(row.status).toBe('closed');
      expect(row.closed).not.toBe('');
      expect(row.reason).toMatch(/provider withdrew/i);
    });

    it('refuses to close a line that still holds float, and says how much', async () => {
      const svc = await liveProvider({
        code: 'E4ADM9',
        source: 'reported',
        direction: 'deposit',
      });
      expect(await obligations(svc.tillId)).toEqual([
        expect.stringMatching(/still holds 20000000 shillings of float/),
      ]);

      const r = await asUser(
        owner,
        `select public.close_agency_agent_line($1, 'tidy up')`,
        [svc.tillId],
      );
      expect(r.ok).toBe(false);
      expect(r.message).toMatch(/cannot be closed yet/i);
      expect(r.message).toMatch(/still holds 20000000 shillings of float/i);
      expect(r.message).toMatch(/suspend the line instead/i);
    });

    it('refuses to close a line that is owed commission, or has work in flight', async () => {
      const svc = await liveProvider({
        code: 'E4ADMA',
        source: 'reported',
        direction: 'deposit',
      });
      // One posted transaction leaves commission outstanding, and one draft
      // leaves work in flight.
      await post({ typeId: svc.typeId, tillId: svc.tillId }, 50_000, {
        commission: 400,
      });
      const key = `E4A-${Math.random().toString(36).slice(2, 10)}`;
      const draft = await asUserCommitted(sec, [
        {
          sql: `select public.create_agency_transaction($1, 10000, $2, '+256770009100', 'C', $3, 0, 0, null, null, $3)`,
          params: [svc.typeId, svc.tillId, key],
        },
      ]);
      expect(draft.ok, draft.message).toBe(true);

      const blockers = await obligations(svc.tillId);
      expect(blockers).toEqual(
        expect.arrayContaining([
          expect.stringMatching(/shillings of float/),
          expect.stringMatching(/400 shillings of commission are still owed to it/),
          expect.stringMatching(/1 transaction\(s\) are still in flight/),
        ]),
      );

      const r = await asUser(
        owner,
        `select public.close_agency_agent_line($1, 'tidy up')`,
        [svc.tillId],
      );
      expect(r.ok).toBe(false);
      expect(r.message).toMatch(/still owed to it/i);
      expect(r.message).toMatch(/still in flight/i);
    });

    it('needs a reason to close, and is the Owner\u2019s to do', async () => {
      const providerId = await bareProvider('E4ADMB');
      const id = ((await register(providerId, 'counter1')).rows[0] as { id: string }).id;

      const noReason = await asUser(
        owner,
        `select public.close_agency_agent_line($1, '   ')`,
        [id],
      );
      expect(noReason.ok).toBe(false);
      expect(noReason.message).toMatch(/needs a reason/i);

      const notOwner = await asUser(
        mgr,
        `select public.close_agency_agent_line($1, 'because')`,
        [id],
      );
      expect(notOwner.ok).toBe(false);
      expect(notOwner.code).toBe('42501');
    });

    it('will not edit or suspend a closed line', async () => {
      const providerId = await bareProvider('E4ADMC');
      const id = ((await register(providerId, 'counter1')).rows[0] as { id: string }).id;
      expect(
        (
          await asUserCommitted(owner, [
            {
              sql: `select public.close_agency_agent_line($1, 'retired')`,
              params: [id],
            },
          ])
        ).ok,
      ).toBe(true);

      const edit = await asUser(
        owner,
        `select public.update_agency_agent_line($1, 'New name')`,
        [id],
      );
      expect(edit.ok).toBe(false);
      expect(edit.message).toMatch(/closed, so its details are history/i);

      const suspend = await asUser(
        owner,
        `select public.set_agency_agent_line_suspended($1, true, 'why')`,
        [id],
      );
      expect(suspend.ok).toBe(false);
      expect(suspend.message).toMatch(/closed. A closed line is not suspended/i);

      const again = await asUser(
        owner,
        `select public.close_agency_agent_line($1, 'again')`,
        [id],
      );
      expect(again.ok).toBe(false);
      expect(again.message).toMatch(/already closed/i);
    });
  });
});
