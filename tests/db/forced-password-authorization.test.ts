import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  asAnon,
  asUser,
  asUserScript,
  createTestUser,
  deleteTestUsers,
  type TestUser,
} from '../helpers/auth-fixtures';
import {
  approveLoan,
  createDraftLoan,
  createLoanScenario,
} from '../helpers/loan-fixtures';
import { closePool, hasDatabase, query, queryOne, skipReason } from '../helpers/db';

const describeDb = hasDatabase ? describe : describe.skip;
if (!hasDatabase) {
  describe('forced password authorization', () => {
    it.skip(`skipped - ${skipReason}`, () => undefined);
  });
}

describeDb('forced-password business authorization', () => {
  const users: Record<string, TestUser> = {};
  let loanId: string;

  beforeAll(async () => {
    await deleteTestUsers();
    const scenario = await createLoanScenario();
    users.owner_admin = scenario.owner;
    users.manager = scenario.manager;
    users.secretary_treasurer = scenario.secretary;
    users.client = await createTestUser('client');
    await query('select public.link_client_profile($1, $2)', [
      scenario.clientId,
      users.client.profileId,
    ]);
    loanId = await createDraftLoan(scenario.clientId);
    await approveLoan(loanId, scenario);
  });

  afterAll(async () => {
    await deleteTestUsers();
    await closePool();
  });

  it('denies arbitrary GL account balances to borrowers but permits finance staff', async () => {
    const account = await queryOne<{ id: string }>(
      'select id from public.ledger_accounts where is_postable = true order by code limit 1',
    );
    const client = users.client!;
    const manager = users.manager!;

    const denied = await asUser(
      client,
      'select public.ledger_account_balance($1) as balance',
      [account.id],
    );
    expect(denied.ok).toBe(false);
    expect(denied.code).toBe('42501');

    const authorized = await asUser(
      manager,
      'select public.ledger_account_balance($1) as balance',
      [account.id],
    );
    expect(authorized.ok).toBe(true);
  });

  for (const role of ['owner_admin', 'manager', 'secretary_treasurer', 'client']) {
    it(`withholds business identity, capabilities and loan rows from forced ${role}`, async () => {
      const user = users[role]!;
      const before = await asUser(user, 'select id from public.loans where id = $1', [
        loanId,
      ]);
      expect(before.ok).toBe(true);
      expect(before.rows).toHaveLength(1);
      await query(
        'update public.profiles set must_change_password = true where id = $1',
        [user.profileId],
      );
      const identity = await asUser(
        user,
        `select public.current_profile_id() as id,
        public.current_user_role_keys() as roles,
        public.user_has_permission('account:view') as permitted`,
      );
      expect(identity.ok).toBe(true);
      expect(identity.rows[0]).toEqual({ id: null, roles: [], permitted: false });
      const financial = await asUser(user, 'select id from public.loans where id = $1', [
        loanId,
      ]);
      expect(financial.ok).toBe(true);
      expect(financial.rows).toHaveLength(0);
      const bootstrap = await asUser(
        user,
        'select * from public.current_session_context()',
      );
      expect(bootstrap.rows[0]).toMatchObject({
        outcome: 'ok',
        profile_id: user.profileId,
        must_change_password: true,
        role_keys: [role],
      });
      const gate = await asUser(user, 'select public.enforce_password_change()');
      expect(gate.ok).toBe(false);
      expect(gate.code).toBe('42501');
      for (const [method, path] of [
        ['POST', '/rpc/current_session_context'],
        ['GET', '/rpc/polytos_readiness'],
        ['POST', '/rpc/record_sign_in'],
        ['POST', '/rpc/record_security_event'],
        ['POST', '/rpc/consume_rate_limit'],
        ['GET', '/company_identity'],
      ]) {
        const recovery = await asUserScript(user, [
          {
            sql: "select set_config('request.path', $1, true), set_config('request.method', $2, true)",
            params: [path, method],
          },
          { sql: 'select public.enforce_password_change()' },
        ]);
        expect(recovery.ok, path).toBe(true);
      }
      const stamp = await asUser(user, 'select public.record_sign_in()');
      expect(stamp.ok).toBe(true);
      // Trusted confirmation is exercised here at DB level, not faked as Auth proof.
      await query('select public.confirm_password_change($1)', [user.authUserId]);
      const restored = await asUser(user, 'select id from public.loans where id=$1', [
        loanId,
      ]);
      expect(restored.rows).toHaveLength(1);
    });
  }

  for (const status of ['inactive', 'suspended']) {
    for (const role of ['owner_admin', 'manager', 'secretary_treasurer', 'client']) {
      it(`${status} ${role} has no business authority or recovery profile`, async () => {
        const user = await createTestUser(role, status);
        const context = await asUser(
          user,
          'select * from public.current_session_context()',
        );
        expect(context.rows[0]).toMatchObject({
          outcome: 'no_active_profile',
          profile_id: null,
          role_keys: [],
        });
        const rows = await asUser(user, 'select id from public.loans');
        expect(rows.rows).toEqual([]);
        const gate = await asUser(user, 'select public.enforce_password_change()');
        expect(gate.code).toBe('42501');
      });
    }
  }

  // -----------------------------------------------------------------------
  // The financial definer RPCs guard themselves.
  //
  // Row Level Security does not reach inside a SECURITY DEFINER function, so
  // before 20261103000100 these were held shut only by the PostgREST
  // pre-request hook — which is a role setting, absent from a database
  // rebuilt from migrations alone. Every call below uses an id that does not
  // exist, because the guard runs before any lookup: a forced caller must be
  // refused without the function ever reading a row, and an identified caller
  // must reach the function's own answer for a missing record.
  // -----------------------------------------------------------------------
  const absent = '00000000-0000-4000-8000-0000000000ff';
  interface GuardedRpc {
    readonly name: string;
    readonly sql: string;
    /** What an identified caller gets back when the record does not exist. */
    readonly identified: { readonly value: unknown } | { readonly code: string };
  }
  const guarded: readonly GuardedRpc[] = [
    {
      name: 'ledger_account_balance',
      sql: `select public.ledger_account_balance('${absent}') as v`,
      identified: { code: 'P0001' },
    },
    {
      name: 'savings_pledged_amount',
      sql: `select public.savings_pledged_amount('${absent}') as v`,
      identified: { value: '0' },
    },
    {
      name: 'savings_withdrawable_amount',
      sql: `select public.savings_withdrawable_amount('${absent}') as v`,
      identified: { value: null },
    },
    {
      name: 'client_has_live_loan',
      sql: `select public.client_has_live_loan('${absent}') as v`,
      identified: { value: false },
    },
    {
      name: 'assess_meeting_fines',
      sql: `select public.assess_meeting_fines('${absent}') as v`,
      identified: { value: 0 },
    },
  ];

  for (const rpc of guarded) {
    it(`${rpc.name} refuses a forced caller and answers an identified one`, async () => {
      const user = await createTestUser('manager');

      const identified = await asUser(user, rpc.sql);
      if ('code' in rpc.identified) {
        expect(identified.ok, rpc.name).toBe(false);
        expect(identified.code, rpc.name).toBe(rpc.identified.code);
      } else {
        expect(identified.ok, rpc.name).toBe(true);
        expect(identified.rows[0], rpc.name).toEqual({ v: rpc.identified.value });
      }

      await query(
        'update public.profiles set must_change_password = true where id = $1',
        [user.profileId],
      );

      const forced = await asUser(user, rpc.sql);
      expect(forced.ok, rpc.name).toBe(false);
      expect(forced.code, rpc.name).toBe('42501');
      expect(forced.message, rpc.name).toMatch(/completed password change/i);
    });
  }

  for (const status of ['inactive', 'suspended']) {
    it(`the financial definer RPCs refuse a ${status} caller`, async () => {
      const user = await createTestUser('manager', status);
      for (const rpc of guarded) {
        const denied = await asUser(user, rpc.sql);
        expect(denied.ok, `${status} ${rpc.name}`).toBe(false);
        expect(denied.code, `${status} ${rpc.name}`).toBe('42501');
      }
    });
  }

  it('the guard exempts a caller with no verified token, so trusted paths work', async () => {
    // No `set local request.jwt.claims`: this is the migration/service path,
    // which already bypasses Row Level Security. It must not start raising,
    // or every seed, trigger and server action breaks.
    const rows = await query<{ v: string | null }>(
      `select public.require_business_identity()::text as v`,
    );
    expect(rows).toEqual([{ v: null }]);
    const pledged = await query<{ v: string }>(
      `select public.savings_pledged_amount('${absent}')::text as v`,
    );
    expect(pledged).toEqual([{ v: '0' }]);
  });

  it('the guard is a definer no client role may call directly', async () => {
    const rows = await query(`select p.prosecdef, p.provolatile,
        has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated_may_call,
        has_function_privilege('anon', p.oid, 'EXECUTE') as anon_may_call
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.proname='require_business_identity'`);
    expect(rows).toEqual([
      {
        prosecdef: true,
        provolatile: 's',
        authenticated_may_call: false,
        anon_may_call: false,
      },
    ]);
  });

  it('the request hook is a pinned invoker with no data result', async () => {
    const rows = await query(`select p.prosecdef, p.prorettype::regtype::text as result
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.proname='enforce_password_change'`);
    expect(rows).toEqual([{ prosecdef: false, result: 'void' }]);
  });
});

/**
 * Storage, anonymous access and cross-user isolation under the boundary.
 *
 * Storage is where "the row is invisible" stops being the protection, because
 * an object is reached by path rather than by query. Every storage policy in
 * this schema routes through `user_has_permission` or `current_profile_id`,
 * both of which stopped resolving for a forced account in 20261030180224 — so
 * the claim to test is that the boundary reaches the document store too, and
 * not only the financial tables.
 *
 * These run against `storage.objects` as real database roles. Hosted Supabase
 * Storage is a separate service that the Docker-free harness does not run, so
 * this is policy-level evidence, not hosted-endpoint evidence.
 */
describeDb('forced-password Storage, anonymous and isolation boundary', () => {
  let staff: TestUser;
  let borrower: TestUser;
  let otherBorrower: TestUser;
  let clientId: string;
  let otherClientId: string;
  let photoPath: string;
  let loanId: string;

  const newClient = async (name: string, phone: string): Promise<string> => {
    const row = await queryOne<{ id: string }>(
      `insert into public.clients
         (full_name, sex, date_of_birth, phone, occupation, village_area, district)
       values ($1,'female','1990-01-01',$2,'Trader','Area','District')
       returning id`,
      [name, phone],
    );
    return row.id;
  };

  beforeAll(async () => {
    await deleteTestUsers();
    const scenario = await createLoanScenario();
    staff = scenario.manager;
    clientId = scenario.clientId;
    loanId = await createDraftLoan(clientId);
    await approveLoan(loanId, scenario);

    borrower = await createTestUser('client');
    await query('select public.link_client_profile($1, $2)', [
      clientId,
      borrower.profileId,
    ]);

    otherClientId = await newClient('Isolation Other', '+256700909091');
    otherBorrower = await createTestUser('client');
    await query('select public.link_client_profile($1, $2)', [
      otherClientId,
      otherBorrower.profileId,
    ]);

    photoPath = `clients/${clientId}/photo/boundary.jpg`;
    await query(
      `insert into storage.objects (bucket_id, name) values ($1, $2)
       on conflict (bucket_id, name) do nothing`,
      ['client-documents', photoPath],
    );
  });

  afterAll(async () => {
    await query('delete from storage.objects where name like $1', [
      'clients/%/photo/boundary.jpg',
    ]);
    await deleteTestUsers();
    await closePool();
  });

  it('a forced account loses the document reads its role allowed', async () => {
    const before = await asUser(
      staff,
      'select name from storage.objects where bucket_id = $1 and name = $2',
      ['client-documents', photoPath],
    );
    expect(before.ok).toBe(true);
    expect(before.rows).toHaveLength(1);

    await query('update public.profiles set must_change_password = true where id = $1', [
      staff.profileId,
    ]);

    const after = await asUser(
      staff,
      'select name from storage.objects where bucket_id = $1 and name = $2',
      ['client-documents', photoPath],
    );
    expect(after.ok).toBe(true);
    expect(after.rows).toHaveLength(0);

    // And it cannot put a document there either.
    const write = await asUser(
      staff,
      'insert into storage.objects (bucket_id, name) values ($1, $2)',
      ['loan-documents', `loans/${loanId}/payslip/forced.pdf`],
    );
    expect(write.ok).toBe(false);

    await query('select public.confirm_password_change($1)', [staff.authUserId]);
    const restored = await asUser(
      staff,
      'select name from storage.objects where bucket_id = $1 and name = $2',
      ['client-documents', photoPath],
    );
    expect(restored.rows).toHaveLength(1);
  });

  it('an anonymous caller reads no document, loan, payment or ledger row', async () => {
    for (const sql of [
      'select name from storage.objects',
      'select id from public.loans',
      'select id from public.loan_payments',
      'select id from public.journal_lines',
      'select id from public.savings_accounts',
      'select id from public.clients',
      'select id from public.profiles',
    ]) {
      const attempt = await asAnon(sql);
      // Either the grant is absent or the policy yields nothing. Both are a
      // refusal; what must never happen is a row coming back.
      if (attempt.ok) {
        expect(attempt.rows, sql).toEqual([]);
      } else {
        expect(attempt.code, sql).toBe('42501');
      }
    }
  });

  it('a borrower sees only their own records, and nothing once forced', async () => {
    const own = await asUser(borrower, 'select id from public.loans where id = $1', [
      loanId,
    ]);
    expect(own.ok).toBe(true);
    expect(own.rows).toHaveLength(1);

    const other = await asUser(
      otherBorrower,
      'select id from public.loans where id = $1',
      [loanId],
    );
    expect(other.ok).toBe(true);
    expect(other.rows, 'another borrower must not see this loan').toHaveLength(0);

    await query('update public.profiles set must_change_password = true where id = $1', [
      borrower.profileId,
    ]);
    const forced = await asUser(borrower, 'select id from public.loans where id = $1', [
      loanId,
    ]);
    expect(forced.ok).toBe(true);
    expect(forced.rows).toHaveLength(0);
  });
});
