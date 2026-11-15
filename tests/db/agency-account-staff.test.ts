/**
 * The agent-account roster, and the float-model correction.
 *
 * ## What these have to make good on
 *
 * Two Owner decisions, each of which is only real if the database refuses the
 * thing it is supposed to refuse.
 *
 * **Rule 6, the roster.** "Unassigned staff must not be able to record or post
 * financial transactions against those accounts." A roster that the posting
 * path does not consult is a list, not a control, so the tests here are
 * mostly refusals: an unassigned secretary recording, an unassigned secretary
 * posting, an officer whose assignment was withdrawn, a float transfer into
 * an account the mover may not operate.
 *
 * And the other half of Rule 6, which already worked and must keep working:
 * one employee operating several accounts across several providers.
 *
 * **The float-model correction.** The client confirmed banks provide
 * electronic float. The test that matters most is not that the change works
 * but that it is refused where it would strand money: on a confirmed
 * provider, and on one still holding a balance.
 *
 * ## Why the oversight clause is tested as hard as the refusals
 *
 * `agency_may_operate_account()` lets `agency:verify` through, which is the
 * Manager and the Owner. That clause is load-bearing — without it an account
 * with one assigned cashier could never have anything posted, because posting
 * is refused to whoever recorded. If it ever stopped working the module would
 * deadlock in production rather than fail here, so it is asserted directly.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  asUserCommitted,
  asUserScript,
  createTestUser,
  type TestUser,
} from '../helpers/auth-fixtures';
import { closePool, hasDatabase, query, queryOne, skipReason } from '../helpers/db';

const describeDb = hasDatabase ? describe : describe.skip;
if (!hasDatabase) {
  describe('agency account staff', () => {
    it.skip(`skipped - ${skipReason}`, () => undefined);
  });
}

describeDb('Agency redesign — the agent account roster', () => {
  let owner: TestUser;
  let manager: TestUser;
  let manager2: TestUser;
  let assigned: TestUser;
  let outsider: TestUser;
  let branch: string;

  let providerId: string;
  let typeId: string;
  let tillA: string;
  let tillB: string;
  /** A second provider, to prove one officer may work across providers. */
  let otherProviderId: string;
  let otherTill: string;

  let seq = 0;
  const key = (): string => `RS-${String(++seq).padStart(3, '0')}-${Date.now() % 100000}`;

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
          'roster fixture')`,
      [code, amount, `fixture ${code} ${Math.random().toString(36).slice(2, 8)}`],
    );
  }

  /** A confirmed, active provider on electronic float, with one type. */
  async function makeProvider(code: string): Promise<string> {
    const pr = await queryOne<{ id: string }>(
      `insert into public.agency_service_providers
         (code, name, category, float_model, payable_account_id, income_account_id,
          commission_model, commission_source, commission_rate_bps, commission_fixed,
          is_provisional, is_active)
       values ($1, $1, 'agency_banking', 'provider_float', null,
               (select id from public.ledger_accounts where code = '4520'),
               'deferred', 'configured', 100, null, false, true)
       returning id::text as id`,
      [code],
    );
    return pr.id;
  }

  async function makeTill(pr: string, name: string): Promise<string> {
    const t = await queryOne<{ id: string }>(
      `select public.ensure_agency_float_account($1, $2, $3)::text as id`,
      [pr, branch, name],
    );
    const code = await queryOne<{ code: string }>(
      `select a.code from public.agency_provider_float_accounts f
         join public.ledger_accounts a on a.id = f.ledger_account_id
        where f.id = $1`,
      [t.id],
    );
    await fund(code.code, 50_000_000);
    return t.id;
  }

  /** Record a deposit as `who` against `till`. Returns the attempt. */
  function record(who: TestUser, till: string, amount = 50_000) {
    return asUserScript(who, [
      {
        sql: `select public.create_agency_transaction($1, $2, $3, '+256770000900', 'Customer', $4, 0, null, null, null, $4) as id`,
        params: [typeId, amount, till, key()],
      },
    ]);
  }

  beforeAll(async () => {
    owner = await createTestUser('owner_admin');
    manager = await createTestUser('manager');
    manager2 = await createTestUser('manager');
    assigned = await createTestUser('secretary_treasurer');
    outsider = await createTestUser('secretary_treasurer');

    branch = (
      await queryOne<{ id: string }>(
        `select id from public.branches where status = 'active' order by branch_code limit 1`,
      )
    ).id;

    // Branch cashiers, not head office. `create_agency_transaction()` refuses
    // to guess a branch for an officer who has none — the operating-branch
    // rule — and that refusal would fire before the roster was ever
    // consulted, which would make every assertion here about the wrong thing.
    await query(`update public.profiles set branch_id = $1 where id = any($2::uuid[])`, [
      branch,
      [manager.profileId, manager2.profileId, assigned.profileId, outsider.profileId],
    ]);

    const cash = await queryOne<{ code: string }>(
      `select code from public.ledger_accounts
        where branch_id = $1 and cash_kind = 'cash_at_hand'`,
      [branch],
    );
    await fund(cash.code, 500_000_000);

    providerId = await makeProvider('ROSTERBANK');
    typeId = (
      await queryOne<{ id: string }>(
        `insert into public.agency_transaction_types
           (provider_id, code, name, direction, requires_account_number, max_single_transaction)
         values ($1, 'DEPOSIT', 'Roster Deposit', 'deposit', true, 50000000)
         returning id::text as id`,
        [providerId],
      )
    ).id;

    tillA = await makeTill(providerId, 'main');
    tillB = await makeTill(providerId, 'counter2');

    otherProviderId = await makeProvider('ROSTERNET');
    otherTill = await makeTill(otherProviderId, 'main');

    // `assigned` is on tillA only, and on the other provider's till — the
    // "one agent, several providers" half of Rule 6. `outsider` is on none.
    for (const till of [tillA, otherTill]) {
      await query(
        `insert into public.agency_account_staff
           (float_account_id, profile_id, assigned_by) values ($1, $2, $3)`,
        [till, assigned.profileId, owner.profileId],
      );
    }
  });

  afterAll(async () => {
    await closePool();
  });

  // -------------------------------------------------------------------------
  // Recording
  // -------------------------------------------------------------------------

  it('lets an assigned officer record against their account', async () => {
    const attempt = await record(assigned, tillA);
    expect(attempt.ok, attempt.message).toBe(true);
  });

  it('refuses an officer who is on no roster at all', async () => {
    const attempt = await record(outsider, tillA);
    expect(attempt.ok).toBe(false);
    expect(attempt.message).toContain('not assigned');
    expect(attempt.code).toBe('42501');
  });

  it('refuses an officer assigned to a different account of the same provider', async () => {
    // `assigned` is on tillA. tillB is the same provider, same branch, and
    // still not theirs: the roster is per account, which is what "account-level
    // transaction ownership" in Rule 6 means.
    const attempt = await record(assigned, tillB);
    expect(attempt.ok).toBe(false);
    expect(attempt.message).toContain('not assigned');
  });

  it('lets one officer work accounts across two providers', async () => {
    // The half of Rule 6 that already worked, and must keep working: "a single
    // employee can be assigned to several banking providers and agent
    // accounts."
    const otherType = await queryOne<{ id: string }>(
      `insert into public.agency_transaction_types
         (provider_id, code, name, direction, requires_account_number, max_single_transaction)
       values ($1, 'DEPOSIT', 'Other Deposit', 'deposit', true, 50000000)
       returning id::text as id`,
      [otherProviderId],
    );

    const attempt = await asUserScript(assigned, [
      {
        sql: `select public.create_agency_transaction($1, 40000, $2, '+256770000901', 'Customer', $3, 0, null, null, null, $3) as id`,
        params: [otherType.id, otherTill, key()],
      },
    ]);
    expect(attempt.ok, attempt.message).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Posting, and the oversight clause
  // -------------------------------------------------------------------------

  it('lets a Manager post against an account they are not on, as oversight', async () => {
    /*
      The load-bearing clause. Posting is refused to whoever recorded, so an
      account whose roster held one cashier could never have anything posted
      at all. `agency:verify` is held by the Manager and the Owner and by
      nobody else, so this is "a Manager or Owner in oversight" and not a
      loophole.
    */
    const recorded = await asUserCommitted(assigned, [
      {
        sql: `select public.create_agency_transaction($1, 60000, $2, '+256770000902', 'Customer', $3, 0, null, null, null, $3) as id`,
        params: [typeId, tillA, key()],
      },
    ]);
    const id = String(recorded.rows[0]?.id);

    await asUserCommitted(assigned, [
      { sql: `select public.submit_agency_transaction($1)`, params: [id] },
    ]);

    const assignments = await queryOne<{ n: string }>(
      `select count(*)::text as n from public.agency_account_staff
        where float_account_id = $1 and profile_id = $2 and status = 'active'`,
      [tillA, manager.profileId],
    );
    expect(assignments.n, 'the manager must not be on this roster').toBe('0');

    const posted = await asUserCommitted(manager, [
      { sql: `select public.verify_agency_transaction($1)`, params: [id] },
    ]);
    expect(posted.ok, posted.message).toBe(true);
  });

  it('refuses a posting by somebody with neither an assignment nor oversight', async () => {
    // A Secretary holds `agency:write` and not `agency:verify`, so they are
    // refused the posting anyway — but by the capability, before the roster is
    // consulted. What this pins is that the roster does not *grant* posting:
    // being assigned is not a substitute for the capability.
    const recorded = await asUserCommitted(assigned, [
      {
        sql: `select public.create_agency_transaction($1, 70000, $2, '+256770000903', 'Customer', $3, 0, null, null, null, $3) as id`,
        params: [typeId, tillA, key()],
      },
    ]);
    const id = String(recorded.rows[0]?.id);
    await asUserCommitted(assigned, [
      { sql: `select public.submit_agency_transaction($1)`, params: [id] },
    ]);

    const attempt = await asUserScript(assigned, [
      { sql: `select public.verify_agency_transaction($1)`, params: [id] },
    ]);
    expect(attempt.ok).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Assigning and withdrawing
  // -------------------------------------------------------------------------

  it('lets an Owner assign, and the newly assigned officer can then record', async () => {
    const before = await record(outsider, tillB);
    expect(before.ok, 'precondition: not yet assigned').toBe(false);

    const assignment = await asUserCommitted(owner, [
      {
        sql: `select public.assign_agency_account_staff($1, $2, 'opened the counter') as id`,
        params: [tillB, outsider.profileId],
      },
    ]);
    expect(assignment.ok, assignment.message).toBe(true);

    const after = await record(outsider, tillB);
    expect(after.ok, after.message).toBe(true);
  });

  it('lets a Manager assign too, which is the oversight the decision asked for', async () => {
    const attempt = await asUserCommitted(manager, [
      {
        sql: `select public.assign_agency_account_staff($1, $2, null) as id`,
        params: [tillB, manager2.profileId],
      },
    ]);
    expect(attempt.ok, attempt.message).toBe(true);
  });

  it('refuses a Secretary/Treasurer the staffing call', async () => {
    const attempt = await asUserScript(assigned, [
      {
        sql: `select public.assign_agency_account_staff($1, $2, null)`,
        params: [tillA, outsider.profileId],
      },
    ]);
    expect(attempt.ok).toBe(false);
    expect(attempt.code).toBe('42501');
  });

  it('is idempotent: assigning somebody already assigned returns their row', async () => {
    const first = await asUserCommitted(owner, [
      {
        sql: `select public.assign_agency_account_staff($1, $2, null)::text as id`,
        params: [tillA, assigned.profileId],
      },
    ]);
    const second = await asUserCommitted(owner, [
      {
        sql: `select public.assign_agency_account_staff($1, $2, null)::text as id`,
        params: [tillA, assigned.profileId],
      },
    ]);
    expect(second.rows[0]?.id).toBe(first.rows[0]?.id);
  });

  it('refuses to assign a borrower', async () => {
    const borrower = await createTestUser('client');
    const attempt = await asUserScript(owner, [
      {
        sql: `select public.assign_agency_account_staff($1, $2, null)`,
        params: [tillA, borrower.profileId],
      },
    ]);
    expect(attempt.ok).toBe(false);
    expect(attempt.message).toContain('no staff role');
  });

  it('withdraws an assignment, with a reason, and the officer can no longer record', async () => {
    const victim = await createTestUser('secretary_treasurer');
    await query(`update public.profiles set branch_id = $1 where id = $2`, [
      branch,
      victim.profileId,
    ]);
    await query(
      `insert into public.agency_account_staff (float_account_id, profile_id, assigned_by)
       values ($1, $2, $3)`,
      [tillA, victim.profileId, owner.profileId],
    );
    expect((await record(victim, tillA)).ok, 'precondition: assigned').toBe(true);

    const revoked = await asUserCommitted(owner, [
      {
        sql: `select public.revoke_agency_account_staff($1, $2, 'moved to another branch')`,
        params: [tillA, victim.profileId],
      },
    ]);
    expect(revoked.ok, revoked.message).toBe(true);

    const after = await record(victim, tillA);
    expect(after.ok).toBe(false);
    expect(after.message).toContain('not assigned');

    // The row is kept, with who withdrew it and why.
    const row = await queryOne<{ status: string; revoked_reason: string }>(
      `select status, revoked_reason from public.agency_account_staff
        where float_account_id = $1 and profile_id = $2`,
      [tillA, victim.profileId],
    );
    expect(row.status).toBe('revoked');
    expect(row.revoked_reason).toBe('moved to another branch');
  });

  it('refuses a withdrawal with no reason', async () => {
    const attempt = await asUserScript(owner, [
      {
        sql: `select public.revoke_agency_account_staff($1, $2, '  ')`,
        params: [tillA, assigned.profileId],
      },
    ]);
    expect(attempt.ok).toBe(false);
    expect(attempt.message).toContain('Say why');
  });

  it('never deletes a roster row', async () => {
    await expect(
      query(`delete from public.agency_account_staff where float_account_id = $1`, [
        tillA,
      ]),
    ).rejects.toThrow();
  });

  // -------------------------------------------------------------------------
  // Float movements
  // -------------------------------------------------------------------------

  it('refuses a float transfer into an account the mover may not operate', async () => {
    /*
      Both ends are checked. `assigned` is on tillA and not on tillB, so
      moving float *out of* tillA and *into* tillB is a use of tillB — and
      allowing it would let an officer push float onto an account nobody has
      put them on.
    */
    const attempt = await asUserScript(assigned, [
      {
        sql: `select public.record_agency_float_trade('transfer', $1, 10000, $2, $3, null, null, null, null, null, null, null)`,
        params: [tillA, `TR-${key()}`, tillB],
      },
    ]);
    expect(attempt.ok).toBe(false);
    expect(attempt.message).toContain('not assigned');
  });

  it('refuses a float purchase recorded by an unassigned officer', async () => {
    const cash = await queryOne<{ id: string }>(
      `select id::text as id from public.ledger_accounts
        where branch_id = $1 and cash_kind = 'cash_at_hand'`,
      [branch],
    );
    const attempt = await asUserScript(outsider, [
      {
        sql: `select public.record_agency_float_trade('purchase', $1, 10000, $2, null, $3, 10000, null, 'provider_service_centre', null, null, null)`,
        params: [tillA, `TR-${key()}`, cash.id],
      },
    ]);
    expect(attempt.ok).toBe(false);
    expect(attempt.message).toContain('not assigned');
  });

  // -------------------------------------------------------------------------
  // What a reader may see
  // -------------------------------------------------------------------------

  it('shows the roster through its view, and shows a borrower nothing', async () => {
    const seen = await asUserScript(manager, [
      {
        sql: `select count(*)::text as n from public.agency_account_operators
               where float_account_id = $1 and status = 'active'`,
        params: [tillA],
      },
    ]);
    expect(seen.ok, seen.message).toBe(true);
    expect(Number(seen.rows[0]?.n)).toBeGreaterThan(0);

    const borrower = await createTestUser('client');
    const denied = await asUserScript(borrower, [
      { sql: `select count(*)::text as n from public.agency_account_staff` },
    ]);
    expect(denied.ok).toBe(true);
    expect(denied.rows[0]?.n).toBe('0');
  });

  it('refuses a borrower the staffing calls outright', async () => {
    const borrower = await createTestUser('client');
    for (const sql of [
      `select public.assign_agency_account_staff($1, $2, null)`,
      `select public.revoke_agency_account_staff($1, $2, 'x')`,
    ]) {
      const attempt = await asUserScript(borrower, [
        { sql, params: [tillA, assigned.profileId] },
      ]);
      expect(attempt.ok, sql).toBe(false);
    }
  });
});

describeDb('Agency redesign — correcting a provisional provider float model', () => {
  let owner: TestUser;
  let manager: TestUser;
  let branch: string;

  beforeAll(async () => {
    owner = await createTestUser('owner_admin');
    manager = await createTestUser('manager');
    branch = (
      await queryOne<{ id: string }>(
        `select id from public.branches where status = 'active' order by branch_code limit 1`,
      )
    ).id;
  });

  afterAll(async () => {
    await closePool();
  });

  /** A provisional bank on the cash-payable model, as the catalogue ships. */
  async function provisionalBank(code: string): Promise<string> {
    const pr = await queryOne<{ id: string }>(
      `insert into public.agency_service_providers
         (code, name, category, float_model, payable_account_id, income_account_id,
          commission_model, commission_source, commission_rate_bps, commission_fixed,
          is_provisional, is_active)
       values ($1, $1, 'agency_banking', 'cash_payable',
               (select id from public.ledger_accounts where code = '2220'),
               (select id from public.ledger_accounts where code = '4520'),
               'deferred', 'configured', 100, null, true, true)
       returning id::text as id`,
      [code],
    );
    return pr.id;
  }

  it('moves a provisional bank onto electronic float, and clears the payable account', async () => {
    // The client's confirmation, as the database performs it.
    const id = await provisionalBank('FLIPBANK1');

    const done = await asUserCommitted(owner, [
      {
        sql: `select public.set_agency_provider_float_model($1, 'provider_float', null, 'client confirmed the bank advances float')`,
        params: [id],
      },
    ]);
    expect(done.ok, done.message).toBe(true);

    const row = await queryOne<{ float_model: string; payable: string | null }>(
      `select float_model, payable_account_id::text as payable
         from public.agency_service_providers where id = $1`,
      [id],
    );
    expect(row.float_model).toBe('provider_float');
    // The CHECK forbids a payable on a float provider, so it must have gone in
    // the same statement.
    expect(row.payable).toBeNull();
  });

  it('then lets a float account be opened against it, which is the point', async () => {
    const id = await provisionalBank('FLIPBANK2');
    const before = await query(
      `select public.ensure_agency_float_account($1, $2) as id`,
      [id, branch],
    ).then(
      () => 'allowed',
      (error: Error) => error.message,
    );
    expect(before, 'a cash_payable provider has no float to open').not.toBe('allowed');

    await asUserCommitted(owner, [
      {
        sql: `select public.set_agency_provider_float_model($1, 'provider_float', null, 'confirmed')`,
        params: [id],
      },
    ]);

    const after = await queryOne<{ id: string }>(
      `select public.ensure_agency_float_account($1, $2)::text as id`,
      [id, branch],
    );
    expect(after.id).toBeTruthy();
  });

  it('moves a provisional provider the other way, when a payable is named', async () => {
    const id = await queryOne<{ id: string }>(
      `insert into public.agency_service_providers
         (code, name, category, float_model, payable_account_id, income_account_id,
          commission_model, commission_source, commission_rate_bps, commission_fixed,
          is_provisional, is_active)
       values ('FLIPBACK', 'FLIPBACK', 'agency_banking', 'provider_float', null,
               (select id from public.ledger_accounts where code = '4520'),
               'deferred', 'configured', 100, null, true, true)
       returning id::text as id`,
    );

    const payable = await queryOne<{ id: string }>(
      `select id::text as id from public.ledger_accounts where code = '2220'`,
    );

    const done = await asUserCommitted(owner, [
      {
        sql: `select public.set_agency_provider_float_model($1, 'cash_payable', $2, 'the bank does not advance float after all')`,
        params: [id.id, payable.id],
      },
    ]);
    expect(done.ok, done.message).toBe(true);
  });

  it('refuses a move to cash_payable with no liability named', async () => {
    const id = await queryOne<{ id: string }>(
      `insert into public.agency_service_providers
         (code, name, category, float_model, payable_account_id, income_account_id,
          commission_model, commission_source, commission_rate_bps, commission_fixed,
          is_provisional, is_active)
       values ('FLIPNOPAY', 'FLIPNOPAY', 'agency_banking', 'provider_float', null,
               (select id from public.ledger_accounts where code = '4520'),
               'deferred', 'configured', 100, null, true, true)
       returning id::text as id`,
    );

    const attempt = await asUserScript(owner, [
      {
        sql: `select public.set_agency_provider_float_model($1, 'cash_payable', null, 'x')`,
        params: [id.id],
      },
    ]);
    expect(attempt.ok).toBe(false);
    expect(attempt.message).toContain('must name the liability');
  });

  it('refuses a confirmed provider, and says what to do instead', async () => {
    /*
      The refusal that matters most. A confirmed provider has posted history
      citing the model that was in force; flipping it would strand a real
      liability with no path to settle it under the new model.
    */
    const id = await provisionalBank('FLIPCONFIRMED');
    await query(
      `update public.agency_service_providers set is_provisional = false where id = $1`,
      [id],
    );

    const attempt = await asUserScript(owner, [
      {
        sql: `select public.set_agency_provider_float_model($1, 'provider_float', null, 'x')`,
        params: [id],
      },
    ]);
    expect(attempt.ok).toBe(false);
    expect(attempt.message).toContain('confirmed');
    expect(attempt.message).toContain('settle the position');
  });

  it('refuses a provider still holding electronic float', async () => {
    const id = await queryOne<{ id: string }>(
      `insert into public.agency_service_providers
         (code, name, category, float_model, payable_account_id, income_account_id,
          commission_model, commission_source, commission_rate_bps, commission_fixed,
          is_provisional, is_active)
       values ('FLIPHELD', 'FLIPHELD', 'agency_banking', 'provider_float', null,
               (select id from public.ledger_accounts where code = '4520'),
               'deferred', 'configured', 100, null, true, true)
       returning id::text as id`,
    );
    const till = await queryOne<{ id: string }>(
      `select public.ensure_agency_float_account($1, $2)::text as id`,
      [id.id, branch],
    );
    const code = await queryOne<{ code: string }>(
      `select a.code from public.agency_provider_float_accounts f
         join public.ledger_accounts a on a.id = f.ledger_account_id where f.id = $1`,
      [till.id],
    );
    await query(
      `select public.post_journal(
          (select branch_id from public.ledger_accounts where code = $1),
          current_date, 'flip float', 'opening_balance', null, null, null,
          jsonb_build_array(
            jsonb_build_object('account_id',
              (select id from public.ledger_accounts where code = $1),
              'debit', 500000::bigint, 'credit', 0),
            jsonb_build_object('account_id', public.ledger_account_by_code('3000'),
              'debit', 0, 'credit', 500000::bigint)),
          now(),
          (select p.id from public.profiles p
             join public.user_roles r on r.profile_id = p.id
            where r.role_key = 'owner_admin' order by p.created_at limit 1),
          'flip fixture')`,
      [code.code],
    );

    const payable = await queryOne<{ id: string }>(
      `select id::text as id from public.ledger_accounts where code = '2220'`,
    );
    const attempt = await asUserScript(owner, [
      {
        sql: `select public.set_agency_provider_float_model($1, 'cash_payable', $2, 'x')`,
        params: [id.id, payable.id],
      },
    ]);
    expect(attempt.ok).toBe(false);
    expect(attempt.message).toContain('electronic float');
  });

  it('refuses a change to the model it already has', async () => {
    const id = await provisionalBank('FLIPSAME');
    const attempt = await asUserScript(owner, [
      {
        sql: `select public.set_agency_provider_float_model($1, 'cash_payable', (select id from public.ledger_accounts where code = '2220'), 'x')`,
        params: [id],
      },
    ]);
    expect(attempt.ok).toBe(false);
    expect(attempt.message).toContain('already holds its money');
  });

  it('refuses a Manager and a Secretary: this is the Owner’s', async () => {
    const id = await provisionalBank('FLIPAUTHZ');
    const secretary = await createTestUser('secretary_treasurer');

    for (const who of [manager, secretary]) {
      const attempt = await asUserScript(who, [
        {
          sql: `select public.set_agency_provider_float_model($1, 'provider_float', null, 'x')`,
          params: [id],
        },
      ]);
      expect(attempt.ok, who.role).toBe(false);
      expect(attempt.code, who.role).toBe('42501');
    }
  });

  it('records the change in the audit log, with both models', async () => {
    const id = await provisionalBank('FLIPAUDIT');
    await asUserCommitted(owner, [
      {
        sql: `select public.set_agency_provider_float_model($1, 'provider_float', null, 'client confirmation')`,
        params: [id],
      },
    ]);

    const entry = await queryOne<{ old_values: string; new_values: string }>(
      `select old_values::text, new_values::text from public.audit_log
        where action = 'agency_provider.float_model_set' and entity_id = $1
        order by occurred_at desc limit 1`,
      [id],
    );
    expect(entry.old_values).toContain('cash_payable');
    expect(entry.new_values).toContain('provider_float');
  });
});
