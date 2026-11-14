/**
 * Agent Banking on electronic float, end to end.
 *
 * ## What the Owner decided, and what that costs
 *
 * Decision 1: "the client has now confirmed that banks provide electronic
 * float to agents in the same way MTN and Airtel do. Implement
 * `provider_float` support for banking providers." The engine turned out to
 * need nothing: every posting path already branches on `float_model` and none
 * of them reads `category`, so a bank on `provider_float` posts exactly as
 * MTN does. That is a claim worth measuring rather than asserting, and the
 * first half of this file measures it.
 *
 * The reporting layer did need something, and it was not what the Owner's
 * note anticipated. `agency_mobile_money_consolidated` is scoped by float
 * model, not by category — so the moment a bank advances float it appears in a
 * view whose name, and whose screens, say Mobile Money. The fix was in the
 * readers rather than the views, because the views are right: one tested
 * aggregation over both modules is better than two that drift. The tests here
 * pin the property the readers depend on, which is that `provider_category`
 * tells the two apart inside one view.
 *
 * ## Decision 3, and the one figure that could be counted twice
 *
 * "Agent Banking float correctly represented in consolidated financial
 * reports; internal transfers never double-counted."
 *
 * A transfer between two of one provider's own accounts moves no float into
 * or out of the provider. It has two sides, so a roll-up that summed trades
 * by provider would count it twice, and a roll-up that folded it into
 * purchases would report float bought that was never bought. The view keeps
 * it in two columns of its own and out of the purchase and sale totals; these
 * tests assert that for a bank, on real posted trades, with the ledger as the
 * arbiter.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { asUserCommitted, createTestUser, type TestUser } from '../helpers/auth-fixtures';
import { closePool, hasDatabase, query, queryOne, skipReason } from '../helpers/db';

const describeDb = hasDatabase ? describe : describe.skip;
if (!hasDatabase) {
  describe('agency banking float', () => {
    it.skip(`skipped - ${skipReason}`, () => undefined);
  });
}

interface ConsolidatedRow {
  readonly provider_code: string;
  readonly provider_category: string;
  readonly branch_code: string;
  readonly agent_lines: string;
  readonly active_lines: string;
  readonly float_held: string;
  readonly float_purchased: string;
  readonly float_sold: string;
  readonly float_transferred_out: string;
  readonly float_transferred_in: string;
}

describeDb('Agent Banking on electronic float', () => {
  let owner: TestUser;
  /**
   * Who records a float trade, and who posts it.
   *
   * Two people, because the engine refuses a trade posted by whoever recorded
   * it. `trader` is also put on both accounts' rosters: the guard added for
   * client Rule 6 checks *both* ends of a transfer, since moving float into an
   * account is a use of that account. `checker` is a Manager and so passes the
   * roster by the oversight clause rather than by being on it — which is the
   * arrangement the roster screen explains, exercised here rather than
   * described.
   */
  let trader: TestUser;
  let checker: TestUser;
  let branch: string;
  let branchCode: string;

  /** A confirmed bank that advances float, with two accounts. */
  let bankId: string;
  let bankA: string;
  let bankB: string;

  /** A confirmed bank on the other model, which holds no float at all. */
  let payableBankId: string;

  /** A provisional bank, for the correction. */
  let provisionalId: string;

  let seq = 0;
  const ref = (): string => `BF-${String(++seq).padStart(3, '0')}-${Date.now() % 100000}`;

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
          'banking float fixture')`,
      [code, amount, `fixture ${code} ${Math.random().toString(36).slice(2, 8)}`],
    );
  }

  async function makeBank(
    code: string,
    opts: { readonly model: string; readonly provisional: boolean },
  ): Promise<string> {
    const pr = await queryOne<{ id: string }>(
      `insert into public.agency_service_providers
         (code, name, category, float_model, payable_account_id, income_account_id,
          commission_model, commission_source, commission_rate_bps, commission_fixed,
          is_provisional, is_active)
       values ($1, $1, 'agency_banking', $2,
               case when $2 = 'cash_payable'
                    then (select id from public.ledger_accounts where code = '2230')
               end,
               (select id from public.ledger_accounts where code = '4520'),
               'deferred', 'configured', 100, null, $3, true)
       returning id::text as id`,
      [code, opts.model, opts.provisional],
    );
    return pr.id;
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
    await fund(ledger.code, 20_000_000);
    return account.id;
  }

  /** The consolidated row for one provider, or null. */
  async function consolidated(code: string): Promise<ConsolidatedRow | null> {
    const rows = await query<ConsolidatedRow>(
      `select provider_code, provider_category, branch_code,
              agent_lines::text, active_lines::text, float_held::text,
              float_purchased::text, float_sold::text,
              float_transferred_out::text, float_transferred_in::text
         from public.agency_mobile_money_consolidated
        where provider_code = $1`,
      [code],
    );
    return rows[0] ?? null;
  }

  /**
   * Record a float trade as `trader`, then post it as `checker`.
   *
   * Committed, not rolled back: the checker is a second session, and a trade
   * still inside the maker's transaction is a trade the checker cannot see —
   * which is the maker-checker control working, and not what these tests are
   * about.
   */
  async function trade(sql: string, params: readonly unknown[]): Promise<void> {
    const recorded = await asUserCommitted(trader, [{ sql, params: [...params] }]);
    expect(recorded.ok, recorded.message).toBe(true);
    const id = (recorded.rows[0] as { id: string }).id;
    const posted = await asUserCommitted(checker, [
      {
        sql: `select public.verify_agency_float_trade($1::uuid, null) as id`,
        params: [id],
      },
    ]);
    expect(posted.ok, posted.message).toBe(true);
  }

  beforeAll(async () => {
    owner = await createTestUser('owner_admin');
    trader = await createTestUser('secretary_treasurer');
    checker = await createTestUser('manager');

    const b = await queryOne<{ id: string; branch_code: string }>(
      `select id, branch_code from public.branches
        where status = 'active' order by branch_code limit 1`,
    );
    branch = b.id;
    branchCode = b.branch_code;

    await query(`update public.profiles set branch_id = $1 where id = any($2::uuid[])`, [
      branch,
      [owner.profileId, trader.profileId, checker.profileId],
    ]);

    const cash = await queryOne<{ code: string }>(
      `select code from public.ledger_accounts
        where branch_id = $1 and cash_kind = 'cash_at_hand'`,
      [branch],
    );
    await fund(cash.code, 500_000_000);

    bankId = await makeBank('BFLOATBANK', {
      model: 'provider_float',
      provisional: false,
    });
    bankA = await makeAccount(bankId, 'bfmain');
    bankB = await makeAccount(bankId, 'bfcounter');

    payableBankId = await makeBank('BFPAYBANK', {
      model: 'cash_payable',
      provisional: false,
    });

    provisionalId = await makeBank('BFPROVBANK', {
      model: 'cash_payable',
      provisional: true,
    });

    // Both ends of every transfer below, because the Rule 6 guard checks both.
    for (const account of [bankA, bankB]) {
      await query(
        `insert into public.agency_account_staff
           (float_account_id, profile_id, assigned_by) values ($1, $2, $3)`,
        [account, trader.profileId, owner.profileId],
      );
    }
  });

  afterAll(async () => {
    await closePool();
  });

  // -------------------------------------------------------------------------
  // The engine is model-driven, not category-driven
  // -------------------------------------------------------------------------

  it('opens a float account against a bank that advances float', async () => {
    const row = await queryOne<{ count: string }>(
      `select count(*)::text as count
         from public.agency_provider_float_accounts
        where provider_id = $1`,
      [bankId],
    );
    expect(row.count).toBe('2');
  });

  it('refuses a float account against a bank on the cash_payable model', async () => {
    // The structural guarantee behind the Owner's whole decision: the two
    // models are mutually exclusive, so a bank cannot both hold float and owe
    // the customer's cash onward. This is why the correction has to exist at
    // all — the column cannot simply be edited alongside live accounts.
    await expect(
      query(`select public.ensure_agency_float_account($1, $2, 'nope')`, [
        payableBankId,
        branch,
      ]),
    ).rejects.toThrow();
  });

  // -------------------------------------------------------------------------
  // Consolidation — decision 3
  // -------------------------------------------------------------------------

  it('includes a float-advancing bank in the consolidated float view', async () => {
    const row = await consolidated('BFLOATBANK');
    expect(row, 'a bank that advances float must appear in consolidation').not.toBeNull();
    expect(row?.branch_code).toBe(branchCode);
    expect(row?.agent_lines).toBe('2');
    expect(row?.active_lines).toBe('2');
  });

  it('marks it as Agent Banking rather than Mobile Money', async () => {
    // The property every scoped reader depends on. Without it the consolidated
    // report could not say which of its rows were banks, and the Mobile Money
    // screens could not keep them out.
    const row = await consolidated('BFLOATBANK');
    expect(row?.provider_category).toBe('agency_banking');
  });

  it('omits a cash_payable bank, which holds no float to report', async () => {
    const row = await consolidated('BFPAYBANK');
    expect(row, 'a cash_payable provider has a payable, not a float balance').toBeNull();
  });

  it("reports float held as the ledger's own balance, not a running total", async () => {
    const expected = await queryOne<{ total: string }>(
      `select coalesce(sum(bal.balance), 0)::text as total
         from public.agency_provider_float_accounts f
         join public.ledger_account_balances bal on bal.account_id = f.ledger_account_id
        where f.provider_id = $1`,
      [bankId],
    );
    const row = await consolidated('BFLOATBANK');
    expect(row?.float_held).toBe(expected.total);
  });

  // -------------------------------------------------------------------------
  // The double count that must not happen
  // -------------------------------------------------------------------------

  it('keeps an internal transfer out of float bought and float sold', async () => {
    const before = await consolidated('BFLOATBANK');
    expect(before).not.toBeNull();

    await trade(
      `select public.record_agency_float_trade(
                'transfer', $1, 3000000, $3, $2, null, null, null,
                null, null, null, 'moving float between two of our own counters')::text as id`,
      [bankA, bankB, ref()],
    );

    const after = await consolidated('BFLOATBANK');

    // The transfer is visible, once on each side, in the two columns that
    // exist for it.
    expect(after?.float_transferred_out).toBe(
      String(Number(before?.float_transferred_out) + 3_000_000),
    );
    expect(after?.float_transferred_in).toBe(
      String(Number(before?.float_transferred_in) + 3_000_000),
    );

    // And nowhere else. This is the assertion the Owner asked for: a transfer
    // is not float bought from the bank and not float sold back to it, and if
    // it ever leaks into either total the consolidated report overstates the
    // business done with the provider by twice the amount moved.
    expect(after?.float_purchased).toBe(before?.float_purchased);
    expect(after?.float_sold).toBe(before?.float_sold);
  });

  it('leaves the provider-level float unchanged by an internal transfer', async () => {
    // The strongest statement of the same thing, and the one a treasurer would
    // make: moving float between our own counters changes which counter holds
    // it and not how much we hold. Read from the ledger, so it is the books
    // answering rather than the view.
    const row = await consolidated('BFLOATBANK');
    const ledger = await queryOne<{ total: string }>(
      `select coalesce(sum(bal.balance), 0)::text as total
         from public.agency_provider_float_accounts f
         join public.ledger_account_balances bal on bal.account_id = f.ledger_account_id
        where f.provider_id = $1`,
      [bankId],
    );
    expect(row?.float_held).toBe(ledger.total);
    expect(Number(row?.float_held)).toBe(40_000_000);
  });

  it('counts a real purchase from the bank as float bought', async () => {
    // The contrast that makes the transfer assertions mean something: the
    // columns are not simply always zero.
    const before = await consolidated('BFLOATBANK');

    const settlement = await queryOne<{ id: string }>(
      `select id::text as id from public.ledger_accounts
        where branch_id = $1 and cash_kind = 'cash_at_hand'`,
      [branch],
    );
    await trade(
      `select public.record_agency_float_trade(
                'purchase', $1, 1000000, $3, null, $2, 1000000, null,
                'cash', 'The bank', null, 'buying float from the bank')::text as id`,
      [bankA, settlement.id, ref()],
    );

    const after = await consolidated('BFLOATBANK');
    expect(after?.float_purchased).toBe(
      String(Number(before?.float_purchased) + 1_000_000),
    );
    // And a purchase is not a transfer either.
    expect(after?.float_transferred_out).toBe(before?.float_transferred_out);
  });

  // -------------------------------------------------------------------------
  // The correction, end to end — decision 1
  // -------------------------------------------------------------------------

  it('brings a corrected bank into consolidation, with float accounts possible', async () => {
    // Before: on the wrong model, so absent from the float view and unable to
    // hold a float account at all.
    expect(await consolidated('BFPROVBANK')).toBeNull();
    await expect(
      query(`select public.ensure_agency_float_account($1, $2, 'early')`, [
        provisionalId,
        branch,
      ]),
    ).rejects.toThrow();

    await query(
      `select public.set_agency_provider_float_model($1, 'provider_float', null, $2)`,
      [provisionalId, 'the client confirmed this bank advances electronic float'],
    );

    const account = await makeAccount(provisionalId, 'bfprovmain');
    expect(account).toBeTruthy();

    const row = await consolidated('BFPROVBANK');
    expect(row, 'a corrected bank must reach the consolidated report').not.toBeNull();
    expect(row?.provider_category).toBe('agency_banking');
    expect(row?.agent_lines).toBe('1');
    expect(Number(row?.float_held)).toBe(20_000_000);

    // The payable is gone, because the model says the customer's money is not
    // owed onward any more. Two CHECK constraints make the model and the
    // payable one fact, which is why the function moves both in one statement.
    const provider = await queryOne<{ float_model: string; payable: string | null }>(
      `select float_model, payable_account_id::text as payable
         from public.agency_service_providers where id = $1`,
      [provisionalId],
    );
    expect(provider.float_model).toBe('provider_float');
    expect(provider.payable).toBeNull();
  });

  it('refuses to correct the confirmed bank that now holds float', async () => {
    // Both refusals that matter, on one provider: it is confirmed, and it
    // holds 41,000,000 of float. Either alone is enough, and the message names
    // the one it hit first.
    await expect(
      query(
        `select public.set_agency_provider_float_model($1, 'cash_payable',
                  (select id from public.ledger_accounts where code = '2230'), $2)`,
        [bankId, 'should be refused'],
      ),
    ).rejects.toThrow();

    const row = await consolidated('BFLOATBANK');
    expect(row?.provider_category).toBe('agency_banking');
    expect(Number(row?.float_held)).toBeGreaterThan(0);
  });

  it('leaves the dashboard view able to separate the two modules', async () => {
    // What the Mobile Money screens rely on to keep banks out of a module
    // they do not belong to, asserted on the view rather than through a page.
    const rows = await query<{ provider_category: string; count: string }>(
      `select provider_category, count(*)::text as count
         from public.agency_mobile_money_dashboard
        group by provider_category`,
    );
    const banking = rows.find((r) => r.provider_category === 'agency_banking');
    expect(banking, 'bank agent accounts must be labelled as such').toBeDefined();
    expect(Number(banking?.count)).toBeGreaterThanOrEqual(3);
  });
});
