/**
 * Phase 4B: the agency transaction engine, proved by moving money.
 *
 * ## What this file asserts, and why it asserts it this way
 *
 * Phase 4A proved the *shape* of an agency transaction — what a row may and
 * may not say. This proves the *posting*: that verifying a transaction writes
 * the journal the architecture specifies, leg for leg, for every one of the
 * nine services, and that nothing else can write one.
 *
 * Every posted case is asserted on its exact lines rather than on a total. A
 * total can be right while the directions are wrong — a deposit booked as a
 * withdrawal balances perfectly and is still a lie about where the money went
 * — and the directions are precisely what the architecture had wrong for one
 * case (see "bank agency withdrawal" below).
 *
 * ## Synthetic rates, deliberately
 *
 * None of the nine seeded providers is used for posting. They ship provisional
 * and inactive, and that is the point of them. The providers here are created
 * by this file with **invented, round, obviously-synthetic rates** — 150bp,
 * 500 fixed, an explicit zero — so that no figure in this suite could ever be
 * mistaken for a negotiated commercial term. Real terms are open decisions C
 * and F.
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
  getClient,
  hasDatabase,
  query,
  queryOne,
  skipReason,
} from '../helpers/db';

const describeDb = hasDatabase ? describe : describe.skip;
if (!hasDatabase) {
  describe('agency transaction engine', () => {
    it.skip(`skipped - ${skipReason}`, () => undefined);
  });
}

/** One journal line, as the assertions compare them. */
interface Line {
  readonly code: string;
  readonly debit: number;
  readonly credit: number;
}

/** A service under test: its provider, its operation, and its till. */
interface Service {
  readonly providerId: string;
  readonly typeId: string;
  readonly tillId: string | null;
  readonly floatCode: string | null;
}

describeDb('Phase 4B — agency transaction engine', () => {
  let owner: TestUser;
  let manager: TestUser;
  let secretary: TestUser;
  let secretary2: TestUser;
  let borrower: TestUser;
  let suspended: TestUser;
  let forcedPassword: TestUser;

  let branchA: string;
  let branchB: string;
  let cashCode: string;

  let mtnDeposit: Service;
  let mtnWithdrawal: Service;
  let airtelDeposit: Service;
  let airtelWithdrawal: Service;
  let bankDeposit: Service;
  let bankWithdrawal: Service;
  let uedcl: Service;
  let nwsc: Service;
  let dstv: Service;
  let gotv: Service;
  let lyca: Service;
  let school: Service;

  /** Read the lines of a journal entry, in posting order. */
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

  /** A ledger account's balance, signed by its normal side. */
  async function balanceOf(code: string): Promise<number> {
    const r = await queryOne<{ balance: string }>(
      `select coalesce(b.balance, 0)::text as balance
         from public.ledger_accounts a
         left join public.ledger_account_balances b on b.account_id = a.id
        where a.code = $1`,
      [code],
    );
    return Number(r.balance);
  }

  /**
   * Record, submit and verify one transaction, as two different people.
   *
   * The separation of duties is real throughout this file: the secretary
   * records and the manager verifies, because nothing else is permitted.
   */
  async function postOne(
    service: Service,
    principal: number,
    opts: {
      reference?: string;
      fee?: number;
      supplied?: number | null;
      identifier?: string;
      name?: string;
      recorder?: TestUser;
      verifier?: TestUser;
    } = {},
  ): Promise<{ txId: string; entryId: string }> {
    const recorder = opts.recorder ?? secretary;
    const verifier = opts.verifier ?? manager;

    // `asUserCommitted` rather than `asUser`: the lifecycle spans two people,
    // so each step must persist for the next to see it, and `asUser` rolls
    // back after every call. It runs as the table owner, so RLS is not
    // exercised here — the policies are asserted separately, with `asUser`.
    // The capability checks *are* exercised, because the JWT claim is set and
    // `agency_actor()` reads it.
    const created = await asUserCommitted(recorder, [
      {
        sql: `select public.create_agency_transaction($1, $2, $3, $4, $5, $6, $7, $8) as id`,
        params: [
          service.typeId,
          principal,
          service.tillId,
          opts.identifier ?? '+256770000001',
          opts.name ?? 'Test Customer',
          opts.reference ?? `REF-${Math.random().toString(36).slice(2, 12)}`,
          opts.fee ?? 0,
          opts.supplied ?? null,
        ],
      },
    ]);
    expect(created.ok, created.message).toBe(true);
    const txId = (created.rows[0] as { id: string }).id;

    const submitted = await asUserCommitted(recorder, [
      { sql: `select public.submit_agency_transaction($1)`, params: [txId] },
    ]);
    expect(submitted.ok, submitted.message).toBe(true);

    const verified = await asUserCommitted(verifier, [
      { sql: `select public.verify_agency_transaction($1) as entry`, params: [txId] },
    ]);
    expect(verified.ok, verified.message).toBe(true);
    const entryId = (verified.rows[0] as { entry: string }).entry;

    return { txId, entryId };
  }

  /** Create a confirmed, active provider with a synthetic commission basis. */
  async function makeService(opts: {
    code: string;
    name: string;
    category: string;
    floatModel: 'provider_float' | 'cash_payable';
    incomeCode: string;
    payableCode?: string;
    model: 'deferred' | 'immediate';
    rateBps?: number;
    fixed?: number;
    direction: 'deposit' | 'withdrawal' | 'payment';
    typeCode: string;
    maxSingle?: number;
    branch?: string;
  }): Promise<Service> {
    const provider = await queryOne<{ id: string }>(
      `insert into public.agency_service_providers
         (code, name, category, float_model, payable_account_id, income_account_id,
          commission_model, commission_rate_bps, commission_fixed,
          is_provisional, is_active)
       values ($1, $2, $3, $4,
               (select id from public.ledger_accounts where code = $5),
               (select id from public.ledger_accounts where code = $6),
               $7, $8, $9, false, true)
       on conflict (code) do update set name = excluded.name
       returning id`,
      [
        opts.code,
        opts.name,
        opts.category,
        opts.floatModel,
        opts.payableCode ?? null,
        opts.incomeCode,
        opts.model,
        opts.rateBps ?? null,
        opts.fixed ?? null,
      ],
    );

    const type = await queryOne<{ id: string }>(
      `insert into public.agency_transaction_types
         (provider_id, code, name, direction, max_single_transaction)
       values ($1, $2, $3, $4, $5)
       on conflict (provider_id, code) do update set name = excluded.name
       returning id`,
      [
        provider.id,
        opts.typeCode,
        `${opts.name} ${opts.typeCode}`,
        opts.direction,
        opts.maxSingle ?? 50_000_000,
      ],
    );

    let tillId: string | null = null;
    let floatCode: string | null = null;
    if (opts.floatModel === 'provider_float') {
      const till = await queryOne<{ id: string }>(
        `select public.ensure_agency_float_account($1, $2) as id`,
        [provider.id, opts.branch ?? branchA],
      );
      tillId = till.id;
      const acct = await queryOne<{ code: string }>(
        `select a.code from public.agency_provider_float_accounts f
           join public.ledger_accounts a on a.id = f.ledger_account_id
          where f.id = $1`,
        [tillId],
      );
      floatCode = acct.code;
    }

    return { providerId: provider.id, typeId: type.id, tillId, floatCode };
  }

  /** A second operation on a provider that already exists. */
  async function addType(
    base: Service,
    typeCode: string,
    name: string,
    direction: 'deposit' | 'withdrawal' | 'payment',
  ): Promise<Service> {
    const row = await queryOne<{ id: string }>(
      `insert into public.agency_transaction_types
         (provider_id, code, name, direction, max_single_transaction)
       values ($1, $2, $3, $4, 50000000)
       on conflict (provider_id, code) do update set name = excluded.name
       returning id`,
      [base.providerId, typeCode, name, direction],
    );
    return { ...base, typeId: row.id };
  }

  /** Put money into an account, the way the ledger records capital. */
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
          'test fixture')`,
      [code, amount, `Fixture: fund ${code}`],
    );
  }

  /** A committed draft, recorded by `recorder`. */
  async function makeDraft(
    service: Service,
    principal = 50_000,
    opts: {
      reference?: string;
      recorder?: TestUser;
      fee?: number;
      supplied?: number | null;
    } = {},
  ): Promise<string> {
    const recorder = opts.recorder ?? secretary;
    const r = await asUserCommitted(recorder, [
      {
        sql: `select public.create_agency_transaction($1, $2, $3, $4, $5, $6, $7, $8) as id`,
        params: [
          service.typeId,
          principal,
          service.tillId,
          '+256770000002',
          'Test Customer',
          opts.reference ?? `D-${Math.random().toString(36).slice(2, 12)}`,
          opts.fee ?? 0,
          opts.supplied ?? null,
        ],
      },
    ]);
    expect(r.ok, r.message).toBe(true);
    return (r.rows[0] as { id: string }).id;
  }

  /** A committed draft that has been submitted for verification. */
  async function makeSubmitted(
    service: Service,
    principal = 50_000,
    opts: { reference?: string; recorder?: TestUser; supplied?: number | null } = {},
  ): Promise<string> {
    const id = await makeDraft(service, principal, opts);
    const r = await asUserCommitted(opts.recorder ?? secretary, [
      { sql: `select public.submit_agency_transaction($1)`, params: [id] },
    ]);
    expect(r.ok, r.message).toBe(true);
    return id;
  }

  /** The audit trail for one transaction, oldest first. */
  async function auditOf(txId: string): Promise<string[]> {
    const rows = await query<{ action: string }>(
      `select action from public.agency_transaction_audit_log
        where transaction_id = $1 order by created_at, action`,
      [txId],
    );
    return rows.map((r) => r.action);
  }

  beforeAll(async () => {
    owner = await createTestUser('owner_admin');
    manager = await createTestUser('manager');
    secretary = await createTestUser('secretary_treasurer');
    secretary2 = await createTestUser('secretary_treasurer');
    borrower = await createTestUser('client');
    suspended = await createTestUser('secretary_treasurer', 'suspended');
    forcedPassword = await createTestUser('secretary_treasurer');
    await query(`update public.profiles set must_change_password = true where id = $1`, [
      forcedPassword.profileId,
    ]);

    branchA = (
      await queryOne<{ id: string }>(
        `select id from public.branches order by branch_code limit 1`,
      )
    ).id;
    branchB = (
      await queryOne<{ id: string }>(
        `insert into public.branches (branch_code, name, location, status, opened_on)
         values ('BR9902', 'Engine Test Branch', 'Testing', 'active', current_date)
         on conflict (branch_code) do update set name = excluded.name
         returning id`,
      )
    ).id;

    // Everyone who records or verifies belongs to branch A.
    await query(`update public.profiles set branch_id = $1 where id = any($2::uuid[])`, [
      branchA,
      [
        owner.profileId,
        manager.profileId,
        secretary.profileId,
        secretary2.profileId,
        suspended.profileId,
        forcedPassword.profileId,
      ],
    ]);

    cashCode = (
      await queryOne<{ code: string }>(
        `select a.code from public.ledger_accounts a
          where a.branch_id = $1 and a.cash_kind = 'cash_at_hand'`,
        [branchA],
      )
    ).code;

    // --- the nine services, with synthetic rates -------------------------
    mtnDeposit = await makeService({
      code: 'TMTN',
      name: 'Test MoMo',
      category: 'mobile_money',
      floatModel: 'provider_float',
      incomeCode: '4510',
      model: 'deferred',
      rateBps: 150,
      direction: 'deposit',
      typeCode: 'DEPOSIT',
    });
    mtnWithdrawal = await addType(
      mtnDeposit,
      'WITHDRAWAL',
      'Test MoMo WITHDRAWAL',
      'withdrawal',
    );

    airtelDeposit = await makeService({
      code: 'TAIRTEL',
      name: 'Test Airtel',
      category: 'mobile_money',
      floatModel: 'provider_float',
      incomeCode: '4510',
      model: 'deferred',
      fixed: 500,
      direction: 'deposit',
      typeCode: 'DEPOSIT',
    });
    airtelWithdrawal = await addType(
      airtelDeposit,
      'WITHDRAWAL',
      'Test Airtel WITHDRAWAL',
      'withdrawal',
    );

    bankDeposit = await makeService({
      code: 'TSTANBIC',
      name: 'Test Bank Agency',
      category: 'agency_banking',
      floatModel: 'cash_payable',
      payableCode: '2220',
      incomeCode: '4520',
      model: 'deferred',
      rateBps: 200,
      direction: 'deposit',
      typeCode: 'DEPOSIT',
    });
    bankWithdrawal = await addType(
      bankDeposit,
      'WITHDRAWAL',
      'Test Bank WITHDRAWAL',
      'withdrawal',
    );

    uedcl = await makeService({
      code: 'TUEDCL',
      name: 'Test Yaka',
      category: 'utility',
      floatModel: 'provider_float',
      incomeCode: '4530',
      model: 'deferred',
      fixed: 500,
      direction: 'payment',
      typeCode: 'YAKA',
    });
    nwsc = await makeService({
      code: 'TNWSC',
      name: 'Test Water',
      category: 'utility',
      floatModel: 'provider_float',
      incomeCode: '4530',
      model: 'deferred',
      rateBps: 100,
      direction: 'payment',
      typeCode: 'WATER',
    });
    dstv = await makeService({
      code: 'TDSTV',
      name: 'Test DStv',
      category: 'tv_subscription',
      floatModel: 'provider_float',
      incomeCode: '4550',
      model: 'deferred',
      rateBps: 300,
      direction: 'payment',
      typeCode: 'SUBSCRIPTION',
    });
    gotv = await makeService({
      code: 'TGOTV',
      name: 'Test GOtv',
      category: 'tv_subscription',
      floatModel: 'provider_float',
      incomeCode: '4550',
      model: 'deferred',
      fixed: 1000,
      direction: 'payment',
      typeCode: 'SUBSCRIPTION',
    });
    lyca = await makeService({
      code: 'TLYCA',
      name: 'Test Airtime',
      category: 'airtime_data',
      floatModel: 'provider_float',
      incomeCode: '4560',
      model: 'immediate',
      rateBps: 300,
      direction: 'payment',
      typeCode: 'AIRTIME',
    });
    school = await makeService({
      code: 'TSCHOOL',
      name: 'Test School',
      category: 'school_fees',
      floatModel: 'cash_payable',
      payableCode: '2210',
      incomeCode: '4540',
      model: 'deferred',
      fixed: 0,
      direction: 'payment',
      typeCode: 'FEES',
    });

    // Fund the till and every float account generously, so a refusal in this
    // suite is never an accident of an empty balance.
    await fund(cashCode, 500_000_000);
    const everyService = [
      mtnDeposit,
      airtelDeposit,
      bankDeposit,
      uedcl,
      nwsc,
      dstv,
      gotv,
      lyca,
      school,
    ];
    for (const s of everyService) {
      if (s.floatCode !== null) await fund(s.floatCode, 200_000_000);
    }
  });

  afterAll(async () => {
    // Deliberately no `deleteTestUsers()`. It deletes the journal entries its
    // fixtures wrote, and `agency_transactions.journal_entry_id` is ON DELETE
    // RESTRICT, so the database refuses — correctly: a posted transaction may
    // not lose the journal that proves it. The transactions cannot be removed
    // first either, because the table is append-only by trigger.
    //
    // Nothing leaks as a result. This project has its own `globalSetup`, which
    // rebuilds the database from the migrations before the suite runs, so the
    // fixtures exist only for this run. The same reasoning is why the suite
    // has a project of its own at all.
    await closePool();
  });

  // =========================================================================
  describe('journal by service type', () => {
    it('MTN MoMo deposit: cash in, float out, commission accrued', async () => {
      const { entryId } = await postOne(mtnDeposit, 100_000);
      expect(await linesOf(entryId)).toEqual([
        { code: cashCode, debit: 100_000, credit: 0 },
        { code: mtnDeposit.floatCode, debit: 0, credit: 100_000 },
        { code: '1310', debit: 1_500, credit: 0 },
        { code: '4510', debit: 0, credit: 1_500 },
      ]);
    });

    it('MTN MoMo withdrawal: float in, cash out', async () => {
      const { entryId } = await postOne(mtnWithdrawal, 100_000);
      expect(await linesOf(entryId)).toEqual([
        { code: mtnWithdrawal.floatCode, debit: 100_000, credit: 0 },
        { code: cashCode, debit: 0, credit: 100_000 },
        { code: '1310', debit: 1_500, credit: 0 },
        { code: '4510', debit: 0, credit: 1_500 },
      ]);
    });

    it('Airtel Money deposit and withdrawal, on a fixed commission', async () => {
      const dep = await postOne(airtelDeposit, 70_000);
      expect(await linesOf(dep.entryId)).toEqual([
        { code: cashCode, debit: 70_000, credit: 0 },
        { code: airtelDeposit.floatCode, debit: 0, credit: 70_000 },
        { code: '1310', debit: 500, credit: 0 },
        { code: '4510', debit: 0, credit: 500 },
      ]);

      const wit = await postOne(airtelWithdrawal, 70_000);
      expect(await linesOf(wit.entryId)).toEqual([
        { code: airtelWithdrawal.floatCode, debit: 70_000, credit: 0 },
        { code: cashCode, debit: 0, credit: 70_000 },
        { code: '1310', debit: 500, credit: 0 },
        { code: '4510', debit: 0, credit: 500 },
      ]);
    });

    it('bank agency deposit: cash in, payable up', async () => {
      const { entryId } = await postOne(bankDeposit, 500_000);
      expect(await linesOf(entryId)).toEqual([
        { code: cashCode, debit: 500_000, credit: 0 },
        { code: '2220', debit: 0, credit: 500_000 },
        { code: '1310', debit: 10_000, credit: 0 },
        { code: '4520', debit: 0, credit: 10_000 },
      ]);
    });

    it('bank agency withdrawal: payable DOWN, cash out — the direction the spec had wrong', async () => {
      // §8.2's cash_payable branch posts "Dr Cash, Cr Payable" regardless of
      // direction. For a withdrawal that is backwards: the customer receives
      // cash and the liability must fall. Posted the specification's way, a
      // deposit-and-withdrawal pair would credit 2220 twice and show the
      // business owing a bank money it had just handed back.
      const before = await balanceOf('2220');
      const { entryId } = await postOne(bankWithdrawal, 300_000);
      expect(await linesOf(entryId)).toEqual([
        { code: '2220', debit: 300_000, credit: 0 },
        { code: cashCode, debit: 0, credit: 300_000 },
        { code: '1310', debit: 6_000, credit: 0 },
        { code: '4520', debit: 0, credit: 6_000 },
      ]);
      // The liability really fell, by exactly the principal.
      expect(await balanceOf('2220')).toBe(before - 300_000);
    });

    it('UEDCL Yaka payment: cash in, float out, fixed commission', async () => {
      const { entryId } = await postOne(uedcl, 50_000);
      expect(await linesOf(entryId)).toEqual([
        { code: cashCode, debit: 50_000, credit: 0 },
        { code: uedcl.floatCode, debit: 0, credit: 50_000 },
        { code: '1310', debit: 500, credit: 0 },
        { code: '4530', debit: 0, credit: 500 },
      ]);
    });

    it('NWSC water payment: 100bp of 80,000 is 800', async () => {
      const { entryId } = await postOne(nwsc, 80_000);
      expect(await linesOf(entryId)).toEqual([
        { code: cashCode, debit: 80_000, credit: 0 },
        { code: nwsc.floatCode, debit: 0, credit: 80_000 },
        { code: '1310', debit: 800, credit: 0 },
        { code: '4530', debit: 0, credit: 800 },
      ]);
    });

    it('DStv subscription: 300bp of 45,000 is 1,350', async () => {
      const { entryId } = await postOne(dstv, 45_000);
      expect(await linesOf(entryId)).toEqual([
        { code: cashCode, debit: 45_000, credit: 0 },
        { code: dstv.floatCode, debit: 0, credit: 45_000 },
        { code: '1310', debit: 1_350, credit: 0 },
        { code: '4550', debit: 0, credit: 1_350 },
      ]);
    });

    it('GOtv subscription: a fixed 1,000 whatever the principal', async () => {
      const { entryId } = await postOne(gotv, 32_000);
      expect(await linesOf(entryId)).toEqual([
        { code: cashCode, debit: 32_000, credit: 0 },
        { code: gotv.floatCode, debit: 0, credit: 32_000 },
        { code: '1310', debit: 1_000, credit: 0 },
        { code: '4550', debit: 0, credit: 1_000 },
      ]);
    });

    it('Lycamobile airtime: immediate income, float short by the spread', async () => {
      // The immediate model realises commission inside the float leg: we
      // collect 10,000 and send 9,700, and the 300 is income at once. No
      // receivable is created, which is what distinguishes it.
      const { entryId } = await postOne(lyca, 10_000);
      expect(await linesOf(entryId)).toEqual([
        { code: cashCode, debit: 10_000, credit: 0 },
        { code: lyca.floatCode, debit: 0, credit: 9_700 },
        { code: '4560', debit: 0, credit: 300 },
      ]);
    });

    it('school fees: cash in, payable up, explicit zero commission', async () => {
      const { entryId } = await postOne(school, 200_000);
      expect(await linesOf(entryId)).toEqual([
        { code: cashCode, debit: 200_000, credit: 0 },
        { code: '2210', debit: 0, credit: 200_000 },
      ]);
    });

    it('every posted entry balances, and none is empty', async () => {
      const bad = await query<{ id: string; d: string; c: string }>(
        `select e.id::text, sum(l.debit)::text as d, sum(l.credit)::text as c
           from public.journal_entries e
           join public.journal_lines l on l.entry_id = e.id
          where e.source_type like 'agency%'
          group by e.id having sum(l.debit) <> sum(l.credit)`,
      );
      expect(bad).toEqual([]);

      const empty = await query<{ id: string }>(
        `select e.id::text from public.journal_entries e
          where e.source_type like 'agency%'
            and not exists (select 1 from public.journal_lines l where l.entry_id = e.id)`,
      );
      expect(empty).toEqual([]);
    });
  });

  // =========================================================================
  describe('commission calculation', () => {
    it('rounds basis points half-up, in integer arithmetic', async () => {
      // 150bp of 10,034 is 150.51 and must land on 151; of 10,000 it is
      // exactly 150. No float is involved: the rule is
      // (principal * bps + 5000) / 10000 in bigint.
      const cases: readonly [number, number][] = [
        [10_000, 150],
        [10_001, 150],
        [10_034, 151],
        [1, 0],
        [34, 1],
        [33, 0],
      ];
      for (const [principal, expected] of cases) {
        const r = await queryOne<{ amount: string; basis: string }>(
          `select amount::text, basis from public.agency_commission_for($1, $2)`,
          [mtnDeposit.providerId, principal],
        );
        expect(Number(r.amount), `150bp of ${String(principal)}`).toBe(expected);
        expect(r.basis).toBe('rate');
      }
    });

    it('returns a fixed commission whatever the principal', async () => {
      for (const principal of [1_000, 100_000, 10_000_000]) {
        const r = await queryOne<{ amount: string; basis: string }>(
          `select amount::text, basis from public.agency_commission_for($1, $2)`,
          [airtelDeposit.providerId, principal],
        );
        expect(Number(r.amount)).toBe(500);
        expect(r.basis).toBe('fixed');
      }
    });

    it('reports an explicit zero as its own basis, not as an absent decision', async () => {
      const r = await queryOne<{ amount: string; basis: string }>(
        `select amount::text, basis from public.agency_commission_for($1, 200000)`,
        [school.providerId],
      );
      expect(Number(r.amount)).toBe(0);
      expect(r.basis).toBe('zero');
    });

    it('refuses a provider configuring both a rate and a fixed amount', async () => {
      const err = await expectError(
        `do $$
         declare p uuid;
         begin
           insert into public.agency_service_providers
             (code, name, category, float_model, income_account_id,
              commission_model, commission_rate_bps, commission_fixed,
              is_provisional, is_active)
           values ('TCONFLICT','Conflicted','other','provider_float',
                   (select id from public.ledger_accounts where code='4590'),
                   'deferred', 150, 500, false, true) returning id into p;
           perform public.agency_commission_for(p, 100000);
         end $$;`,
      );
      expect(err?.message).toMatch(/both a .* rate and a fixed commission/i);
    });

    it('refuses a provider configuring neither', async () => {
      const err = await expectError(`select public.agency_commission_for($1, 100000)`, [
        (
          await queryOne<{ id: string }>(
            `select id from public.agency_service_providers where code = 'MTN_MOMO'`,
          )
        ).id,
      ]);
      expect(err?.message).toMatch(/no commission basis/i);
    });

    it('posts an explicitly supplied commission, and records that it differed', async () => {
      // 150bp of 100,000 is 1,500. The operator was told 1,800 by the
      // provider's handset. Both figures are kept: what was taken, and what
      // the configuration said.
      const { txId, entryId } = await postOne(mtnDeposit, 100_000, { supplied: 1_800 });
      const t = await queryOne<{ amount: string; computed: string; basis: string }>(
        `select commission_amount::text as amount, commission_computed::text as computed,
                commission_basis_applied as basis
           from public.agency_transactions where id = $1`,
        [txId],
      );
      expect(Number(t.amount)).toBe(1_800);
      expect(Number(t.computed)).toBe(1_500);
      expect(t.basis).toBe('rate');

      const lines = await linesOf(entryId);
      expect(lines).toContainEqual({ code: '1310', debit: 1_800, credit: 0 });
      expect(lines).toContainEqual({ code: '4510', debit: 0, credit: 1_800 });
    });

    it('refuses a supplied commission larger than its own principal', async () => {
      const id = await makeSubmitted(mtnDeposit, 10_000, { supplied: 20_000 });
      const r = await asUserCommitted(manager, [
        { sql: `select public.verify_agency_transaction($1)`, params: [id] },
      ]);
      expect(r.ok).toBe(false);
      expect(r.message).toMatch(/cannot exceed the principal/i);
    });

    it('credits the income account the provider names, and only that one', async () => {
      const byProvider: readonly [Service, string][] = [
        [mtnDeposit, '4510'],
        [bankDeposit, '4520'],
        [uedcl, '4530'],
        [dstv, '4550'],
        [lyca, '4560'],
      ];
      for (const [service, code] of byProvider) {
        const { entryId } = await postOne(service, 60_000);
        const income = (await linesOf(entryId)).filter(
          (l) => l.code.startsWith('4') && l.credit > 0,
        );
        expect(
          income.map((l) => l.code),
          code,
        ).toEqual([code]);
      }
    });

    it('keeps the snapshot when the provider rate changes afterwards', async () => {
      // The whole reason the snapshot columns exist. Re-rating a provider must
      // not rewrite the explanation of income already recognised.
      const { txId } = await postOne(gotv, 40_000);
      const before = await queryOne<{ fixed: string; amount: string }>(
        `select commission_fixed_applied::text as fixed, commission_amount::text as amount
           from public.agency_transactions where id = $1`,
        [txId],
      );
      expect(Number(before.fixed)).toBe(1_000);

      await query(
        `update public.agency_service_providers set commission_fixed = 9999 where id = $1`,
        [gotv.providerId],
      );
      try {
        const after = await queryOne<{ fixed: string; amount: string }>(
          `select commission_fixed_applied::text as fixed, commission_amount::text as amount
             from public.agency_transactions where id = $1`,
          [txId],
        );
        expect(Number(after.fixed)).toBe(1_000);
        expect(after.amount).toBe(before.amount);
      } finally {
        await query(
          `update public.agency_service_providers set commission_fixed = 1000 where id = $1`,
          [gotv.providerId],
        );
      }
    });

    it('recognises commission once, not twice, when verification is retried', async () => {
      const id = await makeSubmitted(mtnDeposit, 100_000);
      const first = await asUserCommitted(manager, [
        { sql: `select public.verify_agency_transaction($1) as e`, params: [id] },
      ]);
      const second = await asUserCommitted(manager, [
        { sql: `select public.verify_agency_transaction($1) as e`, params: [id] },
      ]);
      expect(first.ok && second.ok).toBe(true);
      expect((second.rows[0] as { e: string }).e).toBe(
        (first.rows[0] as { e: string }).e,
      );

      const entries = await query<{ n: string }>(
        `select count(*)::text as n from public.journal_entries
          where source_type = 'agency_transaction' and source_id = $1`,
        [id],
      );
      expect(Number(entries[0]?.n)).toBe(1);
    });

    it('charges a customer fee to 4570, on top of the principal', async () => {
      const { entryId } = await postOne(uedcl, 50_000, { fee: 2_000 });
      expect(await linesOf(entryId)).toEqual([
        { code: cashCode, debit: 52_000, credit: 0 },
        { code: uedcl.floatCode, debit: 0, credit: 50_000 },
        { code: '4570', debit: 0, credit: 2_000 },
        { code: '1310', debit: 500, credit: 0 },
        { code: '4530', debit: 0, credit: 500 },
      ]);
    });
  });

  // =========================================================================
  describe('roles and separation of duties', () => {
    it('lets a secretary record and submit, and refuses them verification', async () => {
      const id = await makeSubmitted(mtnDeposit);
      const attempt = await asUser(
        secretary2,
        `select public.verify_agency_transaction($1)`,
        [id],
      );
      expect(attempt.ok).toBe(false);
      expect(attempt.code).toBe('42501');
      expect(attempt.message).toMatch(/agency:verify/i);
    });

    it('refuses the submitter verifying their own, even holding agency:verify', async () => {
      // A manager records one, then tries to verify it. The capability is
      // present; the separation of duties is what refuses.
      const id = await makeSubmitted(mtnDeposit, 50_000, { recorder: manager });
      const attempt = await asUser(
        manager,
        `select public.verify_agency_transaction($1)`,
        [id],
      );
      expect(attempt.ok).toBe(false);
      expect(attempt.code).toBe('42501');
      expect(attempt.message).toMatch(
        /cannot be verified by the person who recorded it/i,
      );
    });

    it('lets a manager and an owner verify somebody else’s', async () => {
      for (const verifier of [manager, owner]) {
        const id = await makeSubmitted(mtnDeposit);
        const r = await asUserCommitted(verifier, [
          { sql: `select public.verify_agency_transaction($1) as e`, params: [id] },
        ]);
        expect(r.ok, r.message).toBe(true);
      }
    });

    it('refuses a borrower every agency operation', async () => {
      const id = await makeSubmitted(mtnDeposit);
      const calls: readonly [string, unknown[]][] = [
        [
          `select public.create_agency_transaction($1, 1000, $2)`,
          [mtnDeposit.typeId, mtnDeposit.tillId],
        ],
        [`select public.submit_agency_transaction($1)`, [id]],
        [`select public.verify_agency_transaction($1)`, [id]],
        [`select public.cancel_agency_transaction($1)`, [id]],
        [`select public.reverse_agency_transaction($1, 'no')`, [id]],
        [`select public.update_agency_transaction_reference($1, 'X', 'no')`, [id]],
      ];
      for (const [sql, params] of calls) {
        const attempt = await asUser(borrower, sql, params);
        expect(attempt.ok, sql).toBe(false);
        expect(attempt.code, sql).toBe('42501');
      }
    });

    it('refuses a suspended account and a forced-password account', async () => {
      // Neither resolves through current_profile_id(), so agency_actor()
      // refuses them before any capability is consulted. This is the Phase 2
      // boundary, inherited rather than restated.
      for (const user of [suspended, forcedPassword]) {
        const attempt = await asUser(
          user,
          `select public.create_agency_transaction($1, 1000, $2)`,
          [mtnDeposit.typeId, mtnDeposit.tillId],
        );
        expect(attempt.ok).toBe(false);
        expect(attempt.code).toBe('42501');
        expect(attempt.message).toMatch(/unidentified session/i);
      }
    });

    it('needs agency:correct for a reference correction, which a manager has and a secretary does not', async () => {
      const { txId } = await postOne(mtnDeposit, 20_000);
      const refused = await asUser(
        secretary,
        `select public.update_agency_transaction_reference($1, $2, 'typo')`,
        [txId, `FIX-${Math.random().toString(36).slice(2, 10)}`],
      );
      expect(refused.ok).toBe(false);
      expect(refused.code).toBe('42501');

      const allowed = await asUser(
        manager,
        `select public.update_agency_transaction_reference($1, $2, 'typo')`,
        [txId, `FIX-${Math.random().toString(36).slice(2, 10)}`],
      );
      expect(allowed.ok, allowed.message).toBe(true);
    });
  });

  // =========================================================================
  describe('branch isolation', () => {
    it('refuses a till that belongs to another branch', async () => {
      // A provider with a till at branch B only. The secretary belongs to
      // branch A, and the transaction's branch is the officer's own, so the
      // till and the branch disagree and the guard refuses.
      const other = await makeService({
        code: 'TOTHERBR',
        name: 'Other Branch MoMo',
        category: 'mobile_money',
        floatModel: 'provider_float',
        incomeCode: '4510',
        model: 'deferred',
        rateBps: 100,
        direction: 'deposit',
        typeCode: 'DEPOSIT',
        branch: branchB,
      });
      const attempt = await asUser(
        secretary,
        `select public.create_agency_transaction($1, 10000, $2, '+256770000003', 'C', 'XB-1')`,
        [other.typeId, other.tillId],
      );
      expect(attempt.ok).toBe(false);
      expect(attempt.message).toMatch(/different branch/i);
    });

    it('hides another branch’s transactions from a branch-scoped reader', async () => {
      const { txId } = await postOne(mtnDeposit, 30_000);
      await query(`update public.profiles set branch_id = $1 where id = $2`, [
        branchB,
        manager.profileId,
      ]);
      try {
        const seen = await asUser(
          manager,
          `select count(*)::int as n from public.agency_transactions where id = $1`,
          [txId],
        );
        expect(seen.ok).toBe(true);
        expect((seen.rows[0] as { n: number }).n).toBe(0);
      } finally {
        await query(`update public.profiles set branch_id = $1 where id = $2`, [
          branchA,
          manager.profileId,
        ]);
      }
    });
  });

  // =========================================================================
  describe('provider readiness, preserved from Phase 4A', () => {
    /** A provider that is confirmed and active, then broken in one way. */
    async function brokenService(label: string, patch: string): Promise<Service> {
      const service = await makeService({
        code: `TBRK${label}`,
        name: `Broken ${label}`,
        category: 'mobile_money',
        floatModel: 'provider_float',
        incomeCode: '4510',
        model: 'deferred',
        rateBps: 100,
        direction: 'deposit',
        typeCode: 'DEPOSIT',
      });
      await query(patch.replace('$ID', `'${service.providerId}'`));
      return service;
    }

    it('refuses submission once the provider is made provisional', async () => {
      const s = await brokenService(
        'PROV',
        `update public.agency_service_providers set is_provisional = true where id = $ID`,
      );
      const id = await makeDraft(s);
      const r = await asUserCommitted(secretary, [
        { sql: `select public.submit_agency_transaction($1)`, params: [id] },
      ]);
      expect(r.ok).toBe(false);
      expect(r.message).toMatch(/still provisional/i);
    });

    it('refuses submission once the provider is deactivated', async () => {
      const s = await brokenService(
        'INACT',
        `update public.agency_service_providers set is_active = false where id = $ID`,
      );
      const id = await makeDraft(s);
      const r = await asUserCommitted(secretary, [
        { sql: `select public.submit_agency_transaction($1)`, params: [id] },
      ]);
      expect(r.ok).toBe(false);
      expect(r.message).toMatch(/not active/i);
    });

    it('refuses submission when the type states no maximum', async () => {
      const s = await makeService({
        code: 'TNOMAX',
        name: 'No Ceiling',
        category: 'mobile_money',
        floatModel: 'provider_float',
        incomeCode: '4510',
        model: 'deferred',
        rateBps: 100,
        direction: 'deposit',
        typeCode: 'DEPOSIT',
      });
      await query(
        `update public.agency_transaction_types set max_single_transaction = null where id = $1`,
        [s.typeId],
      );
      const id = await makeDraft(s);
      const r = await asUserCommitted(secretary, [
        { sql: `select public.submit_agency_transaction($1)`, params: [id] },
      ]);
      expect(r.ok).toBe(false);
      expect(r.message).toMatch(/no maximum single transaction/i);
    });

    it('refuses a principal above the type’s maximum', async () => {
      const s = await makeService({
        code: 'TSMALLMAX',
        name: 'Small Ceiling',
        category: 'mobile_money',
        floatModel: 'provider_float',
        incomeCode: '4510',
        model: 'deferred',
        rateBps: 100,
        direction: 'deposit',
        typeCode: 'DEPOSIT',
        maxSingle: 10_000,
      });
      const attempt = await asUser(
        secretary,
        `select public.create_agency_transaction($1, 20000, $2, '+256770000004', 'C', 'MAX-1')`,
        [s.typeId, s.tillId],
      );
      expect(attempt.ok).toBe(false);
      expect(attempt.message).toMatch(/may not exceed/i);
    });

    it('allows a draft against a provisional provider, and refuses its submission', async () => {
      const seeded = await queryOne<{ id: string; type_id: string }>(
        `select p.id, t.id as type_id
           from public.agency_service_providers p
           join public.agency_transaction_types t on t.provider_id = p.id
          where p.code = 'MTN_MOMO' and t.code = 'DEPOSIT'`,
      );
      const till = await queryOne<{ id: string }>(
        `select public.ensure_agency_float_account($1, $2) as id`,
        [seeded.id, branchA],
      );
      const draft = await asUserCommitted(secretary, [
        {
          sql: `select public.create_agency_transaction($1, 1000, $2, '+256770000005', 'C', 'SEED-1') as id`,
          params: [seeded.type_id, till.id],
        },
      ]);
      expect(draft.ok, draft.message).toBe(true);

      const submitted = await asUserCommitted(secretary, [
        {
          sql: `select public.submit_agency_transaction($1)`,
          params: [(draft.rows[0] as { id: string }).id],
        },
      ]);
      expect(submitted.ok).toBe(false);
      expect(submitted.message).toMatch(/still provisional/i);
    });
  });
  // =========================================================================
  describe('cash and float protections', () => {
    it('refuses a deposit the float cannot fund', async () => {
      // A provider whose till is deliberately left unfunded.
      const s = await makeService({
        code: 'TDRY',
        name: 'Dry Till',
        category: 'mobile_money',
        floatModel: 'provider_float',
        incomeCode: '4510',
        model: 'deferred',
        rateBps: 100,
        direction: 'deposit',
        typeCode: 'DEPOSIT',
      });
      const id = await makeSubmitted(s, 100_000);
      const r = await asUserCommitted(manager, [
        { sql: `select public.verify_agency_transaction($1)`, params: [id] },
      ]);
      expect(r.ok).toBe(false);
      expect(r.message).toMatch(/float, which is less than/i);
    });

    it('refuses a withdrawal the till cannot pay', async () => {
      // More than the drawer holds. The ceiling has to be raised above the
      // amount first, or the type's max_single_transaction would refuse it
      // before the cash check was ever reached — which is a different control
      // and is asserted separately.
      const big = await makeService({
        code: 'TBIGWD',
        name: 'Big Withdrawal',
        category: 'mobile_money',
        floatModel: 'provider_float',
        incomeCode: '4510',
        model: 'deferred',
        rateBps: 100,
        direction: 'withdrawal',
        typeCode: 'WITHDRAWAL',
        maxSingle: 1_000_000_000_000,
      });
      const cash = await balanceOf(cashCode);
      const id = await makeSubmitted(big, cash + 1_000_000);
      const r = await asUserCommitted(manager, [
        { sql: `select public.verify_agency_transaction($1)`, params: [id] },
      ]);
      expect(r.ok).toBe(false);
      expect(r.message).toMatch(/less than the .* being taken out of it/i);
    });

    it('keeps the float rule separate from the cash rule', async () => {
      // allow_negative_cash on must not permit negative float. Correction C4,
      // asserted through the posting path rather than the helper alone.
      const s = await makeService({
        code: 'TDRY2',
        name: 'Dry Till Two',
        category: 'mobile_money',
        floatModel: 'provider_float',
        incomeCode: '4510',
        model: 'deferred',
        rateBps: 100,
        direction: 'deposit',
        typeCode: 'DEPOSIT',
      });
      const id = await makeSubmitted(s, 100_000);
      await query(
        `update public.finance_settings set allow_negative_cash = true where id = 1`,
      );
      try {
        const r = await asUserCommitted(manager, [
          { sql: `select public.verify_agency_transaction($1)`, params: [id] },
        ]);
        expect(r.ok).toBe(false);
        expect(r.message).toMatch(/float, which is less than/i);
      } finally {
        await query(
          `update public.finance_settings set allow_negative_cash = false where id = 1`,
        );
      }
    });

    it('never lets agency float move through record_transfer', async () => {
      const floatAccount = await queryOne<{ id: string }>(
        `select id from public.ledger_accounts where code = $1`,
        [mtnDeposit.floatCode],
      );
      const cash = await queryOne<{ id: string }>(
        `select id from public.ledger_accounts where code = $1`,
        [cashCode],
      );
      const attempt = await asUser(
        owner,
        `select public.record_transfer($1, $2, 1000, current_date, 'refused')`,
        [cash.id, floatAccount.id],
      );
      expect(attempt.ok).toBe(false);
      expect(attempt.message).toMatch(/agency float account/i);
    });

    it('reconciles two tills of one provider independently', async () => {
      // A second till for MTN at the same branch. Posting against one must
      // move only that one.
      const second = await queryOne<{ id: string }>(
        `select public.ensure_agency_float_account($1, $2, 'counter2') as id`,
        [mtnDeposit.providerId, branchA],
      );
      const secondCode = (
        await queryOne<{ code: string }>(
          `select a.code from public.agency_provider_float_accounts f
             join public.ledger_accounts a on a.id = f.ledger_account_id
            where f.id = $1`,
          [second.id],
        )
      ).code;
      await fund(secondCode, 10_000_000);

      const firstBefore = await balanceOf(mtnDeposit.floatCode!);
      const secondBefore = await balanceOf(secondCode);

      await postOne({ ...mtnDeposit, tillId: second.id, floatCode: secondCode }, 25_000);

      expect(await balanceOf(mtnDeposit.floatCode!)).toBe(firstBefore);
      expect(await balanceOf(secondCode)).toBe(secondBefore - 25_000);
    });
  });

  // =========================================================================
  describe('duplicates and concurrency', () => {
    it('refuses a provider reference another submitted transaction claims', async () => {
      const reference = `DUP-${Math.random().toString(36).slice(2, 10)}`;
      await makeSubmitted(mtnDeposit, 10_000, { reference });
      const second = await makeDraft(mtnDeposit, 10_000, { reference });
      const r = await asUserCommitted(secretary, [
        { sql: `select public.submit_agency_transaction($1)`, params: [second] },
      ]);
      expect(r.ok).toBe(false);
      expect(r.message).toMatch(/duplicate key|provider_reference_unique/i);
    });

    it('returns the same transaction for a repeated idempotency key', async () => {
      const key = `IDEM-${Math.random().toString(36).slice(2, 10)}`;
      const call = {
        sql: `select public.create_agency_transaction($1, 15000, $2, '+256770000006', 'C', $3, 0, null, null, null, $4) as id`,
        params: [mtnDeposit.typeId, mtnDeposit.tillId, `K-${key}`, key],
      };
      const first = await asUserCommitted(secretary, [call]);
      const second = await asUserCommitted(secretary, [call]);
      expect(first.ok && second.ok).toBe(true);
      expect((second.rows[0] as { id: string }).id).toBe(
        (first.rows[0] as { id: string }).id,
      );

      const n = await queryOne<{ n: string }>(
        `select count(*)::text as n from public.agency_transactions where idempotency_key = $1`,
        [key],
      );
      expect(Number(n.n)).toBe(1);
    });

    it('lets only one of two concurrent verifications post', async () => {
      // Two connections verify the same transaction at the same time. The row
      // lock in post_agency_transaction decides: one posts, the other finds it
      // already posted and returns the same journal. Never two entries.
      const id = await makeSubmitted(mtnDeposit, 40_000);
      const a = await getClient();
      const b = await getClient();
      try {
        await a.query('begin');
        await b.query('begin');
        await a.query(`select set_config('request.jwt.claim.sub', $1, true)`, [
          manager.authUserId,
        ]);
        await b.query(`select set_config('request.jwt.claim.sub', $1, true)`, [
          owner.authUserId,
        ]);

        // A takes the row lock and posts. B's statement is then issued while
        // that lock is still held, so it blocks inside
        // post_agency_transaction's `for update` — which is the race being
        // tested. A commits, B wakes, re-reads the row the lock protected and
        // finds it already posted.
        //
        // A must commit before B is awaited. Awaiting both first would wait
        // forever: B cannot proceed until A releases, and A does not release
        // until it commits.
        const first = await a.query(`select public.verify_agency_transaction($1) as e`, [
          id,
        ]);
        const second = b.query(`select public.verify_agency_transaction($1) as e`, [id]);
        await new Promise((r) => setTimeout(r, 50));
        await a.query('commit');
        const secondResult = await second.then(
          (v) => ({ status: 'fulfilled' as const, value: v }),
          (e: Error) => ({ status: 'rejected' as const, reason: e.message }),
        );
        await b.query('commit').catch(() => undefined);

        const results = [{ status: 'fulfilled' as const }, secondResult];

        // Whichever way the second call reported, it must not have posted a
        // second entry: either it returned A's journal, or it refused.
        if (secondResult.status === 'fulfilled') {
          expect((secondResult.value.rows[0] as { e: string }).e).toBe(
            (first.rows[0] as { e: string }).e,
          );
        }

        // Whatever each call reported, the book must hold exactly one entry.
        const entries = await queryOne<{ n: string }>(
          `select count(*)::text as n from public.journal_entries
            where source_type = 'agency_transaction' and source_id = $1`,
          [id],
        );
        expect(Number(entries.n), JSON.stringify(results.map((r) => r.status))).toBe(1);

        const t = await queryOne<{ status: string; verified_by: string }>(
          `select status, verified_by::text from public.agency_transactions where id = $1`,
          [id],
        );
        expect(t.status).toBe('posted');
        expect([manager.profileId, owner.profileId]).toContain(t.verified_by);
      } finally {
        a.release();
        b.release();
      }
    });

    it('leaves nothing behind when posting fails midway', async () => {
      // An unfundable deposit: the status change, the journal and the snapshot
      // are one transaction, so a refusal leaves the row awaiting
      // verification with no journal and no snapshot.
      const s = await makeService({
        code: 'TROLLBACK',
        name: 'Rollback Till',
        category: 'mobile_money',
        floatModel: 'provider_float',
        incomeCode: '4510',
        model: 'deferred',
        rateBps: 100,
        direction: 'deposit',
        typeCode: 'DEPOSIT',
      });
      const id = await makeSubmitted(s, 500_000);
      const r = await asUserCommitted(manager, [
        { sql: `select public.verify_agency_transaction($1)`, params: [id] },
      ]);
      expect(r.ok).toBe(false);

      const t = await queryOne<{
        status: string;
        journal_entry_id: string | null;
        verified_by: string | null;
        commission_computed: string | null;
      }>(
        `select status, journal_entry_id::text, verified_by::text,
                commission_computed::text
           from public.agency_transactions where id = $1`,
        [id],
      );
      expect(t.status).toBe('awaiting_verification');
      expect(t.journal_entry_id).toBeNull();
      expect(t.verified_by).toBeNull();
      expect(t.commission_computed).toBeNull();

      const entries = await queryOne<{ n: string }>(
        `select count(*)::text as n from public.journal_entries where source_id = $1`,
        [id],
      );
      expect(Number(entries.n)).toBe(0);
    });
  });

  // =========================================================================
  describe('reversals', () => {
    it('mirrors the original journal leg for leg and deletes nothing', async () => {
      const { txId, entryId } = await postOne(mtnDeposit, 90_000, { fee: 1_000 });
      const original = await linesOf(entryId);

      const r = await asUserCommitted(manager, [
        {
          sql: `select public.reverse_agency_transaction($1, $2) as e`,
          params: [txId, 'Customer changed their mind'],
        },
      ]);
      expect(r.ok, r.message).toBe(true);
      const contraId = (r.rows[0] as { e: string }).e;
      const contra = await linesOf(contraId);

      // Same accounts, same amounts, opposite sides.
      expect(contra).toEqual(
        original.map((l) => ({ code: l.code, debit: l.credit, credit: l.debit })),
      );

      // The original entry and its lines are still there.
      const still = await queryOne<{ n: string }>(
        `select count(*)::text as n from public.journal_lines where entry_id = $1`,
        [entryId],
      );
      expect(Number(still.n)).toBe(original.length);
    });

    it('preserves the whole trail: reference, officers, reason and audit', async () => {
      const reference = `REV-${Math.random().toString(36).slice(2, 10)}`;
      const { txId } = await postOne(mtnDeposit, 20_000, { reference });
      await asUserCommitted(manager, [
        {
          sql: `select public.reverse_agency_transaction($1, $2)`,
          params: [txId, 'Wrong wallet'],
        },
      ]);

      const t = await queryOne<{
        status: string;
        provider_reference: string;
        submitted_by: string;
        verified_by: string;
        reversed_by: string;
        reversal_reason: string;
        journal_entry_id: string;
        reversal_entry_id: string;
      }>(
        `select status, provider_reference, submitted_by::text, verified_by::text,
                reversed_by::text, reversal_reason, journal_entry_id::text,
                reversal_entry_id::text
           from public.agency_transactions where id = $1`,
        [txId],
      );
      expect(t.status).toBe('reversed');
      expect(t.provider_reference).toBe(reference); // the claim is kept
      expect(t.submitted_by).toBe(secretary.profileId);
      expect(t.verified_by).toBe(manager.profileId);
      expect(t.reversed_by).toBe(manager.profileId);
      expect(t.reversal_reason).toBe('Wrong wallet');
      expect(t.journal_entry_id).not.toBeNull();
      expect(t.reversal_entry_id).not.toBeNull();

      expect(await auditOf(txId)).toEqual(
        expect.arrayContaining(['submit', 'verify', 'post', 'reverse']),
      );

      // And the original entry names what undid it.
      const stamp = await queryOne<{ reversed_by_entry_id: string }>(
        `select reversed_by_entry_id::text from public.journal_entries where id = $1`,
        [t.journal_entry_id],
      );
      expect(stamp.reversed_by_entry_id).toBe(t.reversal_entry_id);
    });

    it('refuses a reversal without a reason, and is idempotent once done', async () => {
      const { txId } = await postOne(mtnDeposit, 10_000);
      const noReason = await asUser(
        manager,
        `select public.reverse_agency_transaction($1, '  ')`,
        [txId],
      );
      expect(noReason.ok).toBe(false);
      expect(noReason.message).toMatch(/needs a reason/i);

      const first = await asUserCommitted(manager, [
        { sql: `select public.reverse_agency_transaction($1, 'x') as e`, params: [txId] },
      ]);
      const again = await asUserCommitted(manager, [
        { sql: `select public.reverse_agency_transaction($1, 'x') as e`, params: [txId] },
      ]);
      expect((again.rows[0] as { e: string }).e).toBe((first.rows[0] as { e: string }).e);

      const contras = await queryOne<{ n: string }>(
        `select count(*)::text as n from public.journal_entries
          where source_type = 'agency_transaction_reversal' and source_id = $1`,
        [txId],
      );
      expect(Number(contras.n)).toBe(1);
    });

    it('needs agency:reverse_cross_day for a prior day, which a manager lacks', async () => {
      const { txId } = await postOne(mtnDeposit, 15_000);
      await query(
        `update public.agency_transactions set transaction_date = current_date - 1 where id = $1`,
        [txId],
      );
      const refused = await asUser(
        manager,
        `select public.reverse_agency_transaction($1, 'yesterday')`,
        [txId],
      );
      expect(refused.ok).toBe(false);
      expect(refused.code).toBe('42501');
      expect(refused.message).toMatch(/reverse_cross_day/i);

      const allowed = await asUserCommitted(owner, [
        {
          sql: `select public.reverse_agency_transaction($1, 'yesterday') as e`,
          params: [txId],
        },
      ]);
      expect(allowed.ok, allowed.message).toBe(true);
    });

    it('reverses after the provider has been deactivated, without reactivating it', async () => {
      // Task 5's historical-correction path. The readiness gate exempts a
      // reversal precisely so a mistake can be corrected behind a provider
      // that has since been switched off.
      const s = await makeService({
        code: 'TRETIRED',
        name: 'Retired Provider',
        category: 'mobile_money',
        floatModel: 'provider_float',
        incomeCode: '4510',
        model: 'deferred',
        rateBps: 100,
        direction: 'deposit',
        typeCode: 'DEPOSIT',
      });
      await fund(s.floatCode!, 1_000_000);
      const { txId } = await postOne(s, 30_000);

      await query(
        `update public.agency_service_providers
            set is_active = false, is_provisional = true where id = $1`,
        [s.providerId],
      );

      const r = await asUserCommitted(manager, [
        {
          sql: `select public.reverse_agency_transaction($1, 'posted in error') as e`,
          params: [txId],
        },
      ]);
      expect(r.ok, r.message).toBe(true);

      // The provider is still off: the correction did not reopen it.
      const after = await queryOne<{ is_active: boolean; is_provisional: boolean }>(
        `select is_active, is_provisional from public.agency_service_providers where id = $1`,
        [s.providerId],
      );
      expect(after.is_active).toBe(false);
      expect(after.is_provisional).toBe(true);

      // And nothing new can be posted against it.
      const blocked = await asUserCommitted(secretary, [
        {
          sql: `select public.submit_agency_transaction($1)`,
          params: [await makeDraft(s, 1_000)],
        },
      ]);
      expect(blocked.ok).toBe(false);
    });

    it('refuses a reversal whose commission has already been settled', async () => {
      // Settlement is Phase 4C, so the settled state is created here by
      // crediting 1310 directly — a test fixture, clearly labelled, standing
      // in for the settlement entry 4C will write.
      const s = await makeService({
        code: 'TSETTLED',
        name: 'Settled Commission',
        category: 'mobile_money',
        floatModel: 'provider_float',
        incomeCode: '4510',
        model: 'deferred',
        fixed: 5_000,
        direction: 'deposit',
        typeCode: 'DEPOSIT',
      });
      await fund(s.floatCode!, 1_000_000);
      const { txId } = await postOne(s, 100_000);

      const settlement = await queryOne<{ id: string }>(
        `insert into public.agency_commission_settlements
           (provider_id, branch_id, settlement_date, settlement_amount,
            settlement_account_id, created_by)
         values ($1, $2, current_date, 5000,
                 (select id from public.ledger_accounts where code = $3), $4)
         returning id`,
        [s.providerId, branchA, s.floatCode, owner.profileId],
      );
      await query(
        `select public.post_journal($1, current_date, 'Fixture: settle commission',
            'agency_commission_settlement', $2, null, null,
            jsonb_build_array(
              jsonb_build_object('account_id',
                (select id from public.ledger_accounts where code = $3),
                'debit', 5000, 'credit', 0),
              jsonb_build_object('account_id', public.ledger_account_by_code('1310'),
                'debit', 0, 'credit', 5000)),
            now(), $4, 'test fixture')`,
        [branchA, settlement.id, s.floatCode, owner.profileId],
      );

      expect(
        Number(
          (
            await queryOne<{ o: string }>(
              `select public.agency_commission_outstanding($1, $2)::text as o`,
              [s.providerId, branchA],
            )
          ).o,
        ),
      ).toBe(0);

      const r = await asUser(
        manager,
        `select public.reverse_agency_transaction($1, 'too late')`,
        [txId],
      );
      expect(r.ok).toBe(false);
      expect(r.message).toMatch(/already been settled/i);
      expect(r.message).toMatch(/Reverse the commission settlement first/i);
    });
  });

  // =========================================================================
  describe('lifecycle', () => {
    it('edits a draft, and refuses to edit anything else', async () => {
      const id = await makeDraft(mtnDeposit, 10_000);
      const edited = await asUserCommitted(secretary, [
        { sql: `select public.update_agency_transaction($1, 25000)`, params: [id] },
      ]);
      expect(edited.ok, edited.message).toBe(true);
      expect(
        Number(
          (
            await queryOne<{ p: string }>(
              `select principal_amount::text as p from public.agency_transactions where id = $1`,
              [id],
            )
          ).p,
        ),
      ).toBe(25_000);

      await asUserCommitted(secretary, [
        { sql: `select public.submit_agency_transaction($1)`, params: [id] },
      ]);
      const refused = await asUser(
        secretary,
        `select public.update_agency_transaction($1, 30000)`,
        [id],
      );
      expect(refused.ok).toBe(false);
      expect(refused.message).toMatch(/Only a draft can be edited/i);
    });

    it('returns a submitted transaction for correction, and needs a reason', async () => {
      const id = await makeSubmitted(mtnDeposit, 10_000);
      const noReason = await asUser(
        manager,
        `select public.return_agency_transaction($1, '')`,
        [id],
      );
      expect(noReason.ok).toBe(false);

      const returned = await asUserCommitted(manager, [
        {
          sql: `select public.return_agency_transaction($1, 'Wrong meter number')`,
          params: [id],
        },
      ]);
      expect(returned.ok, returned.message).toBe(true);
      expect(
        (
          await queryOne<{ status: string }>(
            `select status from public.agency_transactions where id = $1`,
            [id],
          )
        ).status,
      ).toBe('draft');

      // And it is editable again, which is the point of the state.
      const edited = await asUserCommitted(secretary, [
        { sql: `select public.update_agency_transaction($1, 11000)`, params: [id] },
      ]);
      expect(edited.ok).toBe(true);
    });

    it('cancels an unposted transaction and refuses to cancel a posted one', async () => {
      const draft = await makeDraft(mtnDeposit, 5_000);
      const cancelled = await asUserCommitted(secretary, [
        {
          sql: `select public.cancel_agency_transaction($1, 'keyed twice')`,
          params: [draft],
        },
      ]);
      expect(cancelled.ok, cancelled.message).toBe(true);

      const { txId } = await postOne(mtnDeposit, 5_000);
      const refused = await asUser(
        secretary,
        `select public.cancel_agency_transaction($1, 'too late')`,
        [txId],
      );
      expect(refused.ok).toBe(false);
      expect(refused.message).toMatch(/Only an unposted transaction can be cancelled/i);
    });

    it('releases the provider reference when a transaction is cancelled', async () => {
      const reference = `CAN-${Math.random().toString(36).slice(2, 10)}`;
      const first = await makeSubmitted(mtnDeposit, 5_000, { reference });
      await asUserCommitted(secretary, [
        {
          sql: `select public.cancel_agency_transaction($1, 'keyed twice')`,
          params: [first],
        },
      ]);
      // The same reference is now free, because a cancelled row claims none.
      const second = await makeSubmitted(mtnDeposit, 5_000, { reference });
      expect(second).not.toBe(first);
    });

    it('corrects a reference on a posted transaction without touching the ledger', async () => {
      const { txId, entryId } = await postOne(mtnDeposit, 12_000);
      const before = await linesOf(entryId);
      const corrected = `COR-${Math.random().toString(36).slice(2, 10)}`;

      const r = await asUserCommitted(manager, [
        {
          sql: `select public.update_agency_transaction_reference($1, $2, 'provider re-issued it')`,
          params: [txId, corrected],
        },
      ]);
      expect(r.ok, r.message).toBe(true);

      expect(
        (
          await queryOne<{ provider_reference: string }>(
            `select provider_reference from public.agency_transactions where id = $1`,
            [txId],
          )
        ).provider_reference,
      ).toBe(corrected);

      // No new entry, and the original is untouched.
      expect(await linesOf(entryId)).toEqual(before);
      const entries = await queryOne<{ n: string }>(
        `select count(*)::text as n from public.journal_entries where source_id = $1`,
        [txId],
      );
      expect(Number(entries.n)).toBe(1);
      expect(await auditOf(txId)).toContain('reference_corrected');
    });

    it('refuses a float submission with no provider reference', async () => {
      const r = await asUserCommitted(secretary, [
        {
          sql: `select public.create_agency_transaction($1, 9000, $2, '+256770000007', 'C', null) as id`,
          params: [mtnDeposit.typeId, mtnDeposit.tillId],
        },
      ]);
      expect(r.ok, r.message).toBe(true);
      const submitted = await asUserCommitted(secretary, [
        {
          sql: `select public.submit_agency_transaction($1)`,
          params: [(r.rows[0] as { id: string }).id],
        },
      ]);
      expect(submitted.ok).toBe(false);
      expect(submitted.message).toMatch(/must be recorded before this is submitted/i);
    });
  });
});
