import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  asAnon,
  asServiceRole,
  asUser,
  createTestUser,
  deleteTestUsers,
  type TestUser,
} from '../helpers/auth-fixtures';
import { closePool, hasDatabase, query, queryOne, skipReason } from '../helpers/db';

/**
 * Linking a client record to a portal login, attacked.
 *
 * This is the most consequential write in Phase 3: it decides which login can
 * read which client's data. A wrong link does not merely show the wrong name —
 * it hands one person another person's financial record.
 *
 * So the invariants are enforced inside a `service_role`-only function, under
 * an advisory lock, and the column itself is guarded by a rule that binds
 * every caller including `service_role`. Everything below tries to get around
 * that.
 */
const describeDb = hasDatabase ? describe : describe.skip;

if (!hasDatabase) {
  describe('client auth linkage suite', () => {
    it.skip(`skipped — ${skipReason}`, () => undefined);
  });
}

/**
 * Every test that links uses a **fresh** login.
 *
 * Deliberate, and the reason is the rule under test: a profile may be linked
 * to at most one client, ever. Reusing one fixture login across tests would
 * mean the second test failing on the first test's link rather than on what it
 * is actually asserting.
 */
async function makeClient(name: string, phone: string): Promise<string> {
  const row = await queryOne<{ id: string }>(
    `insert into public.clients
       (full_name, sex, date_of_birth, phone, occupation, village_area, district)
     values ($1, 'male', '1988-06-06', $2, 'Trader', 'Nakawa', 'Kampala')
     returning id`,
    [name, phone],
  );
  return row.id;
}

describeDb('linking a client to a portal login', () => {
  let owner: TestUser;
  let manager: TestUser;
  let secretary: TestUser;
  let borrower: TestUser;
  let otherBorrower: TestUser;

  beforeAll(async () => {
    await deleteTestUsers();
    owner = await createTestUser('owner_admin');
    manager = await createTestUser('manager');
    secretary = await createTestUser('secretary_treasurer');
    borrower = await createTestUser('client');
    otherBorrower = await createTestUser('client');
  });

  afterAll(async () => {
    await deleteTestUsers();
    await closePool();
  });

  // -------------------------------------------------------------------------
  describe('the function is unreachable from a session', () => {
    it('gives no session role EXECUTE', async () => {
      for (const role of ['anon', 'authenticated']) {
        const row = await queryOne<{ can_execute: boolean }>(
          `select coalesce(bool_or(has_function_privilege($1, p.oid, 'execute')), false)
                    as can_execute
             from pg_proc p
             join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.proname = 'link_client_profile'`,
          [role],
        );

        expect(row.can_execute, `${role} can execute link_client_profile`).toBe(false);
      }
    });

    it('refuses an owner calling it directly', async () => {
      const clientId = await makeClient('Owner Direct', '+256700071001');

      // Even the Owner, who holds `clients:link_auth`, cannot call it from a
      // session. The capability authorises the Server Action; the function
      // itself is reachable only through the server's secret key.
      const result = await asUser(owner, `select public.link_client_profile($1, $2)`, [
        clientId,
        borrower.profileId,
      ]);

      expect(result.ok).toBe(false);
      expect(result.code).toBe('42501');
    });

    it.each([
      ['a manager', 'manager'],
      ['a secretary', 'secretary'],
      ['a borrower', 'borrower'],
    ])('refuses %s calling it directly', async (_label, which) => {
      const actor =
        which === 'manager' ? manager : which === 'secretary' ? secretary : borrower;
      const clientId = await makeClient(`Direct ${which}`, nextPhone());

      const result = await asUser(actor, `select public.link_client_profile($1, $2)`, [
        clientId,
        otherBorrower.profileId,
      ]);

      expect(result.ok).toBe(false);
      expect(result.code).toBe('42501');
    });

    it('refuses an anonymous visitor', async () => {
      const result = await asAnon(
        `select public.link_client_profile(gen_random_uuid(), gen_random_uuid())`,
      );
      expect(result.ok).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  describe('a borrower cannot link themselves', () => {
    it('cannot write profile_id on an unlinked client', async () => {
      const clientId = await makeClient('Self Link Target', '+256700071010');

      const result = await asUser(
        borrower,
        `update public.clients set profile_id = $2 where id = $1`,
        [clientId, borrower.profileId],
      );

      // The row is invisible to them in the first place (no self-clause match
      // on an unlinked client), and the column guard would refuse it anyway.
      expect(result.rowCount).toBe(0);

      const row = await queryOne<{ profile_id: string | null }>(
        `select profile_id from public.clients where id = $1`,
        [clientId],
      );
      expect(row.profile_id).toBeNull();
    });

    it('cannot repoint a client they are already linked to', async () => {
      const linked = await createTestUser('client');
      const target = await createTestUser('client');
      const clientId = await makeClient('Already Linked', '+256700071011');

      await query(`select public.link_client_profile($1, $2)`, [
        clientId,
        linked.profileId,
      ]);

      const result = await asUser(
        linked,
        `update public.clients set profile_id = $2 where id = $1`,
        [clientId, target.profileId],
      );

      // Two defences, and only the first is reached: a borrower holds no
      // client-editing capability, so the UPDATE policy never opens the row
      // and nothing changes. The column guard behind it is what stops a
      // caller who *does* hold one.
      expect(result.rowCount).toBe(0);

      const row = await queryOne<{ profile_id: string | null }>(
        `select profile_id from public.clients where id = $1`,
        [clientId],
      );
      expect(row.profile_id).toBe(linked.profileId);
    });

    it('cannot unlink themselves to escape a blacklisting', async () => {
      const linked = await createTestUser('client');
      const clientId = await makeClient('Escape Attempt', '+256700071012');

      await query(`select public.link_client_profile($1, $2)`, [
        clientId,
        linked.profileId,
      ]);
      await query(
        `update public.clients
            set status = 'blacklisted', status_reason = 'defaulted' where id = $1`,
        [clientId],
      );

      const result = await asUser(
        linked,
        `update public.clients set profile_id = null where id = $1`,
        [clientId],
      );

      expect(result.rowCount).toBe(0);

      const row = await queryOne<{ profile_id: string | null; status: string }>(
        `select profile_id, status from public.clients where id = $1`,
        [clientId],
      );
      expect(row.profile_id).toBe(linked.profileId);
      expect(row.status).toBe('blacklisted');
    });
  });

  // -------------------------------------------------------------------------
  describe('the invariants hold against the privileged client', () => {
    it('refuses a second login on one client', async () => {
      const first = await createTestUser('client');
      const second = await createTestUser('client');
      const clientId = await makeClient('One Login Only', '+256700071020');

      await query(`select public.link_client_profile($1, $2)`, [
        clientId,
        first.profileId,
      ]);

      const result = await asServiceRole(`select public.link_client_profile($1, $2)`, [
        clientId,
        second.profileId,
      ]);

      expect(result.ok).toBe(false);
      expect(result.message).toMatch(/already has a portal login/i);
    });

    it('refuses one login on a second client', async () => {
      const login = await createTestUser('client');
      const first = await makeClient('First Client', '+256700071021');
      const second = await makeClient('Second Client', '+256700071022');

      await query(`select public.link_client_profile($1, $2)`, [first, login.profileId]);

      const result = await asServiceRole(`select public.link_client_profile($1, $2)`, [
        second,
        login.profileId,
      ]);

      // Without this, one person could sign in and see two clients' records —
      // or, worse, two people could share a login into one record.
      expect(result.ok).toBe(false);
      expect(result.message).toMatch(/already linked to another client/i);
    });

    it('refuses a suspended account', async () => {
      const clientId = await makeClient('Suspended Login', '+256700071023');
      const suspended = await createTestUser('client', 'suspended');

      const result = await asServiceRole(`select public.link_client_profile($1, $2)`, [
        clientId,
        suspended.profileId,
      ]);

      expect(result.ok).toBe(false);
      expect(result.message).toMatch(/not active/i);
    });

    it('refuses a profile that does not exist', async () => {
      const clientId = await makeClient('Ghost Login', '+256700071024');

      const result = await asServiceRole(
        `select public.link_client_profile($1, '00000000-0000-4000-8000-000000000000')`,
        [clientId],
      );

      expect(result.ok).toBe(false);
      expect(result.message).toMatch(/No such profile/i);
    });

    it('refuses a client that does not exist', async () => {
      const result = await asServiceRole(
        `select public.link_client_profile('00000000-0000-4000-8000-000000000000', $1)`,
        [borrower.profileId],
      );

      expect(result.ok).toBe(false);
      expect(result.message).toMatch(/No such client/i);
    });

    it('refuses nulls rather than linking something arbitrary', async () => {
      for (const sql of [
        `select public.link_client_profile(null, null)`,
        `select public.link_client_profile(null, gen_random_uuid())`,
        `select public.link_client_profile(gen_random_uuid(), null)`,
      ]) {
        const result = await asServiceRole(sql);
        expect(result.ok, sql).toBe(false);
      }
    });
  });

  // -------------------------------------------------------------------------
  describe('the unique constraint is the backstop', () => {
    it('refuses two clients sharing one profile even by direct insert', async () => {
      const login = await createTestUser('client');
      const clientId = await makeClient('Constraint Test', '+256700071030');

      await query(`select public.link_client_profile($1, $2)`, [
        clientId,
        login.profileId,
      ]);

      // The function's checks are the readable refusal; this is what holds if
      // a future code path ever bypasses them.
      await expect(
        query(
          `insert into public.clients
             (full_name, sex, date_of_birth, phone, occupation, village_area, district, profile_id)
           values ('Constraint Dup','male','1988-01-01','+256700071031','X','Y','Z',$1)`,
          [login.profileId],
        ),
      ).rejects.toMatchObject({ code: '23505' });
    });
  });

  // -------------------------------------------------------------------------
  describe('the sanctioned path works', () => {
    it('links, and the borrower then sees exactly their own record', async () => {
      const clientId = await makeClient('Properly Linked', '+256700071040');
      const freshBorrower = await createTestUser('client');

      await query(`select public.link_client_profile($1, $2)`, [
        clientId,
        freshBorrower.profileId,
      ]);

      const visible = await asUser(freshBorrower, `select id from public.clients`);

      expect(visible.rows).toHaveLength(1);
      expect(visible.rows[0]?.id).toBe(clientId);
    });

    it('records the linkage in the audit trail', async () => {
      const clientId = await makeClient('Audited Link', '+256700071041');
      const freshBorrower = await createTestUser('client');

      await query(`select public.link_client_profile($1, $2)`, [
        clientId,
        freshBorrower.profileId,
      ]);

      const entry = await queryOne<{ action: string }>(
        `select action from public.audit_log
          where entity_type = 'client' and entity_id = $1
          order by id desc limit 1`,
        [clientId],
      );

      expect(entry.action).toBe('client.auth_linked');
    });
  });
});

/** Distinct test phone numbers, within the fixture cleanup prefix. */
let phoneCounter = 0;
function nextPhone(): string {
  phoneCounter += 1;
  return `+2567000719${String(phoneCounter).padStart(2, '0')}`;
}
