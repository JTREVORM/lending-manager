/**
 * Commission by day — the Owner's decision 3, client Rule 3.
 *
 * ## What Rule 3 actually demands
 *
 * "Commission is earned daily. Recognition and receipt are separate events."
 * A report that shows one figure called "commission" satisfies neither half.
 * So the tests here are about keeping two facts apart: that a day's earning
 * appears on the day it was earned, that a receipt appears on the day it was
 * received, and that neither moves the other.
 *
 * ## Why there is a test asserting a column does *not* exist
 *
 * Because the obvious column is the wrong one. Outstanding is a position — what
 * a provider owes at a moment — and a column headed "outstanding" against a
 * Tuesday reads as "still owed for Tuesday", which no figure can mean. The
 * assertion exists so that nobody adds it later in good faith: a daily
 * outstanding would be arithmetic that looks right and answers a question
 * nobody asked.
 *
 * ## The attribution limit, tested rather than hoped for
 *
 * `commission_settled` counts only receipts that name an agent account. A
 * provider paying one sum against a branch's whole position names no account,
 * and apportioning it across counters would invent a split the provider never
 * stated. That limit is deliberate and it is a limit, so it is asserted in
 * both directions: a payout attributes, and a provider-level settlement does
 * not — while still reaching the provider-level summary, which is where it
 * belongs.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { asUserCommitted, createTestUser, type TestUser } from '../helpers/auth-fixtures';
import { closePool, hasDatabase, query, queryOne, skipReason } from '../helpers/db';

const describeDb = hasDatabase ? describe : describe.skip;
if (!hasDatabase) {
  describe('agency commission daily', () => {
    it.skip(`skipped - ${skipReason}`, () => undefined);
  });
}

interface DailyRow {
  readonly business_date: string;
  readonly provider_code: string;
  readonly provider_category: string;
  readonly float_account_id: string;
  readonly transactions: string;
  readonly commission_earned: string;
  readonly commission_at_point_of_sale: string;
  readonly commission_settled: string;
  readonly commission_movement: string;
}

describeDb('Agency redesign — commission by day', () => {
  let owner: TestUser;
  let cashier: TestUser;
  let checker: TestUser;
  let branch: string;

  /** A deferred provider: commission becomes a receivable on 1310. */
  let deferredId: string;
  let deferredType: string;
  let deferredAccount: string;

  /** An immediate provider: commission is taken at the counter. */
  let immediateId: string;
  let immediateType: string;
  let immediateAccount: string;

  let seq = 0;
  const key = (): string => `CD-${String(++seq).padStart(3, '0')}-${Date.now() % 100000}`;

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
          'commission daily fixture')`,
      [code, amount, `fixture ${code} ${Math.random().toString(36).slice(2, 8)}`],
    );
  }

  async function makeProvider(code: string, model: string): Promise<string> {
    const pr = await queryOne<{ id: string }>(
      `insert into public.agency_service_providers
         (code, name, category, float_model, payable_account_id, income_account_id,
          commission_model, commission_source, commission_rate_bps, commission_fixed,
          is_provisional, is_active)
       values ($1, $1, 'agency_banking', 'provider_float', null,
               (select id from public.ledger_accounts where code = '4520'),
               $2, 'configured', 1000, null, false, true)
       returning id::text as id`,
      [code, model],
    );
    return pr.id;
  }

  async function makeType(provider: string): Promise<string> {
    const t = await queryOne<{ id: string }>(
      `insert into public.agency_transaction_types
         (provider_id, code, name, direction, requires_account_number, max_single_transaction)
       values ($1, 'DEPOSIT', 'Daily Deposit', 'deposit', true, 50000000)
       returning id::text as id`,
      [provider],
    );
    return t.id;
  }

  async function makeAccount(provider: string, name: string): Promise<string> {
    const account = await queryOne<{ id: string }>(
      `select public.ensure_agency_float_account($1, $2, $3)::text as id`,
      [provider, branch, name],
    );
    const ledger = await queryOne<{ code: string }>(
      `select a.code from public.agency_provider_float_accounts f
         join public.ledger_accounts a on a.id = f.ledger_account_id
        where f.id = $1`,
      [account.id],
    );
    await fund(ledger.code, 30_000_000);
    await query(
      `insert into public.agency_account_staff
         (float_account_id, profile_id, assigned_by) values ($1, $2, $3)`,
      [account.id, cashier.profileId, owner.profileId],
    );
    return account.id;
  }

  /**
   * Record a deposit and post it, on a given business date.
   *
   * Two sessions, because the engine refuses a transaction posted by whoever
   * recorded it. Committed, because the checker cannot see a document still
   * inside the maker's transaction.
   */
  async function deposit(
    type: string,
    account: string,
    amount: number,
    date: string,
  ): Promise<void> {
    const recorded = await asUserCommitted(cashier, [
      {
        sql: `select public.create_agency_transaction(
                 $1, $2, $3, '+256770000901', 'Customer', $4, 0, null, null, $5::date, $4)::text as id`,
        params: [type, amount, account, key(), date],
      },
    ]);
    expect(recorded.ok, recorded.message).toBe(true);
    const id = (recorded.rows[0] as { id: string }).id;

    const submitted = await asUserCommitted(cashier, [
      { sql: `select public.submit_agency_transaction($1::uuid)`, params: [id] },
    ]);
    expect(submitted.ok, submitted.message).toBe(true);

    const posted = await asUserCommitted(checker, [
      { sql: `select public.verify_agency_transaction($1::uuid, null)`, params: [id] },
    ]);
    expect(posted.ok, posted.message).toBe(true);
  }

  async function daily(code: string): Promise<readonly DailyRow[]> {
    return query<DailyRow>(
      `select business_date::text as business_date, provider_code, provider_category,
              float_account_id::text as float_account_id,
              transactions::text, commission_earned::text,
              commission_at_point_of_sale::text, commission_settled::text,
              commission_movement::text
         from public.agency_commission_daily
        where provider_code = $1
        order by business_date`,
      [code],
    );
  }

  beforeAll(async () => {
    owner = await createTestUser('owner_admin');
    cashier = await createTestUser('secretary_treasurer');
    checker = await createTestUser('manager');

    branch = (
      await queryOne<{ id: string }>(
        `select id from public.branches where status = 'active' order by branch_code limit 1`,
      )
    ).id;

    await query(`update public.profiles set branch_id = $1 where id = any($2::uuid[])`, [
      branch,
      [owner.profileId, cashier.profileId, checker.profileId],
    ]);

    const cash = await queryOne<{ code: string }>(
      `select code from public.ledger_accounts
        where branch_id = $1 and cash_kind = 'cash_at_hand'`,
      [branch],
    );
    await fund(cash.code, 500_000_000);

    deferredId = await makeProvider('CDDEFER', 'deferred');
    deferredType = await makeType(deferredId);
    deferredAccount = await makeAccount(deferredId, 'cddefer');

    immediateId = await makeProvider('CDNOW', 'immediate');
    immediateType = await makeType(immediateId);
    immediateAccount = await makeAccount(immediateId, 'cdnow');
  });

  afterAll(async () => {
    await closePool();
  });

  // -------------------------------------------------------------------------
  // The shape of the thing
  // -------------------------------------------------------------------------

  it('has no outstanding column, by day or otherwise', async () => {
    // Deliberate. Outstanding is a position and a day is not a position: a
    // column headed "outstanding" against a Tuesday reads as "still owed for
    // Tuesday", which no figure here can mean. The position is in
    // agency_commission_line_balances.
    const columns = await query<{ column_name: string }>(
      `select column_name from information_schema.columns
        where table_schema = 'public' and table_name = 'agency_commission_daily'`,
    );
    const names = columns.map((c) => c.column_name);
    expect(names).not.toContain('commission_outstanding');
    expect(names).not.toContain('outstanding');
    // What it has instead, named so it cannot be read as a balance.
    expect(names).toContain('commission_movement');
  });

  it('carries the provider category, so a report can split the two modules', async () => {
    await deposit(deferredType, deferredAccount, 1_000_000, '2026-11-10');
    const rows = await daily('CDDEFER');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.provider_category).toBe('agency_banking');
  });

  // -------------------------------------------------------------------------
  // Recognition
  // -------------------------------------------------------------------------

  it('records a day of earning on the day it was earned', async () => {
    const rows = await daily('CDDEFER');
    const day = rows.find((r) => r.business_date === '2026-11-10');
    expect(day, 'the transaction was dated the 10th').toBeDefined();
    // 10% of 1,000,000, from commission_rate_bps = 1000.
    expect(day?.commission_earned).toBe('100000');
    expect(day?.transactions).toBe('1');
  });

  it('keeps two days of earning on two days', async () => {
    await deposit(deferredType, deferredAccount, 2_000_000, '2026-11-11');
    const rows = await daily('CDDEFER');
    expect(rows.map((r) => r.business_date)).toEqual(['2026-11-10', '2026-11-11']);
    expect(rows[0]?.commission_earned).toBe('100000');
    expect(rows[1]?.commission_earned).toBe('200000');
  });

  it('counts nothing for a transaction that is not posted', async () => {
    const before = await daily('CDDEFER');
    const recorded = await asUserCommitted(cashier, [
      {
        sql: `select public.create_agency_transaction(
                 $1, 5000000, $2, '+256770000902', 'Customer', $3, 0, null, null, '2026-11-12'::date, $3)::text as id`,
        params: [deferredType, deferredAccount, key()],
      },
    ]);
    expect(recorded.ok, recorded.message).toBe(true);

    const after = await daily('CDDEFER');
    expect(after).toHaveLength(before.length);
    expect(after.some((r) => r.business_date === '2026-11-12')).toBe(false);
  });

  it('shows an immediate provider as earned and taken at the counter', async () => {
    // Rule 3's separation is between recognition and receipt, and on an
    // immediate provider they are the same event. Reporting that commission
    // as earned-but-unsettled would be reporting a debt that was never owed,
    // so it is carried in its own column as well as inside earned.
    await deposit(immediateType, immediateAccount, 1_000_000, '2026-11-10');
    const rows = await daily('CDNOW');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.commission_earned).toBe('100000');
    expect(rows[0]?.commission_at_point_of_sale).toBe('100000');
    // And the movement is nil: nothing became receivable.
    expect(rows[0]?.commission_movement).toBe('0');
  });

  it('leaves a deferred provider with the whole day as a movement', async () => {
    const rows = await daily('CDDEFER');
    const day = rows.find((r) => r.business_date === '2026-11-10');
    expect(day?.commission_at_point_of_sale).toBe('0');
    expect(day?.commission_movement).toBe('100000');
  });

  // -------------------------------------------------------------------------
  // Receipt, and what cannot be attributed to a day
  // -------------------------------------------------------------------------

  it('records a payout on the day it was received, not the day it was earned', async () => {
    // The whole of Rule 3 in one assertion: the earning stays on the 10th and
    // the receipt lands on the 20th. Recognition and receipt are separate
    // events, and a report that moved one to meet the other would be hiding
    // exactly the gap the client asked to see.
    const paid = await asUserCommitted(checker, [
      {
        sql: `select public.record_agency_commission_payout(
                 $1, 60000, $2, '2026-11-20'::date, 'the bank paid part of it')::text as id`,
        params: [deferredAccount, key()],
      },
    ]);
    expect(paid.ok, paid.message).toBe(true);

    const rows = await daily('CDDEFER');

    const earnedDay = rows.find((r) => r.business_date === '2026-11-10');
    expect(earnedDay?.commission_earned).toBe('100000');
    expect(earnedDay?.commission_settled, 'the earning day is untouched').toBe('0');

    const paidDay = rows.find((r) => r.business_date === '2026-11-20');
    expect(paidDay, 'the receipt makes a row of its own').toBeDefined();
    expect(paidDay?.commission_settled).toBe('60000');
    expect(paidDay?.commission_earned, 'nothing was earned that day').toBe('0');
    expect(paidDay?.transactions).toBe('0');
  });

  it('leaves a provider-level settlement out, and says where it went instead', async () => {
    // The attribution limit, asserted in both directions. A provider paying
    // one sum against a branch names no account, so there is no day-and-account
    // row it could honestly join to — and apportioning it would invent a split
    // the provider never stated.
    const before = await daily('CDDEFER');
    const settledBefore = before.reduce(
      (total, row) => total + Number(row.commission_settled),
      0,
    );

    const settlement = await asUserCommitted(checker, [
      {
        sql: `select public.record_commission_settlement(
                 $1, $2, 25000,
                 (select id from public.ledger_accounts
                   where branch_id = $2 and cash_kind = 'cash_at_hand'),
                 $3, '2026-11-21'::date)::text as id`,
        params: [deferredId, branch, key()],
      },
    ]);
    expect(settlement.ok, settlement.message).toBe(true);

    const after = await daily('CDDEFER');
    const settledAfter = after.reduce(
      (total, row) => total + Number(row.commission_settled),
      0,
    );
    expect(settledAfter, 'an unattributed receipt cannot land on an account').toBe(
      settledBefore,
    );
    expect(after.some((r) => r.business_date === '2026-11-21')).toBe(false);

    // But it is not lost: the provider-level summary has it, which is the
    // table the daily view's own comment points a reader to.
    const summary = await queryOne<{ received: string }>(
      `select commission_received::text as received
         from public.agency_commission_summary
        where provider_id = $1 and branch_id = $2`,
      [deferredId, branch],
    );
    expect(Number(summary.received)).toBeGreaterThanOrEqual(25_000);
  });

  it('reconciles the earned side against the transactions it came from', async () => {
    // The view's earned column is the posted transactions and nothing else,
    // so this is the check that no join has multiplied a row — the failure
    // mode of a view with four joins and a full outer join in it.
    const view = await queryOne<{ total: string; rows: string }>(
      `select coalesce(sum(commission_earned), 0)::text as total,
              coalesce(sum(transactions), 0)::text as rows
         from public.agency_commission_daily
        where provider_code in ('CDDEFER', 'CDNOW')`,
    );
    const source = await queryOne<{ total: string; rows: string }>(
      `select coalesce(sum(t.commission_amount), 0)::text as total,
              count(*)::text as rows
         from public.agency_transactions t
         join public.agency_provider_float_accounts f on f.id = t.float_account_id
         join public.agency_service_providers p on p.id = f.provider_id
        where p.code in ('CDDEFER', 'CDNOW') and t.status = 'posted'`,
    );
    expect(view.total).toBe(source.total);
    expect(view.rows).toBe(source.rows);
  });
});
