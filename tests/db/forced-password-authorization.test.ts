import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
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
import { closePool, hasDatabase, query, skipReason } from '../helpers/db';

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

  it('the request hook is a pinned invoker with no data result', async () => {
    const rows = await query(`select p.prosecdef, p.prorettype::regtype::text as result
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.proname='enforce_password_change'`);
    expect(rows).toEqual([{ prosecdef: false, result: 'void' }]);
  });
});
