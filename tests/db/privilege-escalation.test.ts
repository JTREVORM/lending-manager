import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  asAnon,
  asUser,
  asUserScript,
  createTestUser,
  deleteTestUsers,
  type TestUser,
} from '../helpers/auth-fixtures';
import { closePool, hasDatabase, query, queryOne, skipReason } from '../helpers/db';

/**
 * Deliberate attempts to gain authority, made the way an attacker would.
 *
 * Every statement here runs as the `authenticated` database role against a
 * real database, bypassing the application entirely. The interface's buttons,
 * route guards and Server Actions are not involved: these are the requests
 * somebody makes once they have a valid token and a copy of the REST API
 * documentation.
 *
 * A passing test means the attempt failed — either with an error, or by being
 * filtered to zero rows, which is the quieter but equally complete denial RLS
 * produces on a write.
 */
const describeDb = hasDatabase ? describe : describe.skip;

if (!hasDatabase) {
  describe('privilege escalation suite', () => {
    it.skip(`skipped — ${skipReason}`, () => undefined);
  });
}

describeDb('privilege escalation', () => {
  let owner: TestUser;
  let otherOwner: TestUser;
  let manager: TestUser;
  let secretary: TestUser;
  let client: TestUser;

  beforeAll(async () => {
    await deleteTestUsers();
    owner = await createTestUser('owner_admin');
    otherOwner = await createTestUser('owner_admin');
    manager = await createTestUser('manager');
    secretary = await createTestUser('secretary_treasurer');
    client = await createTestUser('client');
  });

  afterAll(async () => {
    await deleteTestUsers();
    await closePool();
  });

  // -------------------------------------------------------------------------
  describe('granting yourself authority', () => {
    it.each([
      ['a client', () => client],
      ['a secretary/treasurer', () => secretary],
      ['a manager', () => manager],
    ])('refuses %s inserting their own owner_admin row', async (_label, subject) => {
      const user = subject();

      const result = await asUser(
        user,
        `insert into public.user_roles (profile_id, role_key) values ($1, 'owner_admin')`,
        [user.profileId],
      );

      expect(result.ok).toBe(false);
      expect(result.message).toMatch(/users:assign_role/);
    });

    it('refuses even an owner changing their own role assignments', async () => {
      // The self-administration rule has no exception. An Owner who could edit
      // their own grants could also quietly remove a constraint somebody else
      // placed on them.
      const result = await asUser(
        owner,
        `insert into public.user_roles (profile_id, role_key) values ($1, 'manager')`,
        [owner.profileId],
      );

      expect(result.ok).toBe(false);
      expect(result.message).toMatch(/your own role assignments/i);
    });

    it('refuses an owner revoking their own owner role', async () => {
      const result = await asUser(
        owner,
        `delete from public.user_roles where profile_id = $1 and role_key = 'owner_admin'`,
        [owner.profileId],
      );

      expect(result.ok).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  describe('granting authority above your own', () => {
    it('refuses a manager promoting anybody at all', async () => {
      // A Manager holds users:view but not users:assign_role, so the capability
      // check refuses before rank is even considered.
      const result = await asUser(
        manager,
        `insert into public.user_roles (profile_id, role_key) values ($1, 'manager')`,
        [secretary.profileId],
      );

      expect(result.ok).toBe(false);
    });

    it('refuses a holder of users:assign_role granting above their rank', async () => {
      // Constructed deliberately: a manager who has somehow been given the
      // assignment capability still cannot create an Owner. The rank rule is
      // independent of the capability rule, so neither alone is load-bearing.
      await query(
        `insert into public.role_permissions (role_key, permission_key)
         values ('manager', 'users:assign_role') on conflict do nothing`,
      );

      try {
        const allowed = await asUser(
          manager,
          `insert into public.user_roles (profile_id, role_key) values ($1, 'secretary_treasurer')`,
          [client.profileId],
        );
        expect(allowed.ok, 'a manager may grant below their own rank').toBe(true);

        const refused = await asUser(
          manager,
          `insert into public.user_roles (profile_id, role_key) values ($1, 'owner_admin')`,
          [client.profileId],
        );

        expect(refused.ok).toBe(false);
        expect(refused.message).toMatch(/outranks your own/i);
      } finally {
        await query(
          `delete from public.role_permissions
            where role_key = 'manager' and permission_key = 'users:assign_role'`,
        );
      }
    });

    it('lets an owner grant up to owner, which is their own rank', async () => {
      const result = await asUser(
        owner,
        `insert into public.user_roles (profile_id, role_key) values ($1, 'owner_admin')`,
        [manager.profileId],
      );

      expect(result.ok).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  describe('forging attribution', () => {
    it('overwrites a supplied granted_by with the real actor', async () => {
      // Without this, an administrator could make the trail say somebody else
      // extended authority to a user.
      const result = await asUser(
        owner,
        `insert into public.user_roles (profile_id, role_key, granted_by)
         values ($1, 'manager', $2) returning granted_by`,
        [client.profileId, secretary.profileId],
      );

      expect(result.ok).toBe(true);
      expect(result.rows[0]?.granted_by).toBe(owner.profileId);
      expect(result.rows[0]?.granted_by).not.toBe(secretary.profileId);
    });

    it('records the real actor in the audit trail, not a claimed one', async () => {
      const subject = await createTestUser('client');

      await asUser(
        owner,
        `update public.profiles set full_name = 'Audited Rename' where id = $1`,
        [subject.profileId],
      );

      // The update above was rolled back with its transaction, so drive a
      // committed one to inspect the recorded actor.
      await query(`select set_config('request.jwt.claim.sub', $1, false)`, [
        owner.authUserId,
      ]);
      await query(`update public.profiles set full_name = 'Audited' where id = $1`, [
        subject.profileId,
      ]);
      await query(`select set_config('request.jwt.claim.sub', '', false)`);

      const entry = await queryOne<{ actor_profile_id: string; actor_label: string }>(
        `select actor_profile_id, actor_label from public.audit_log
          where entity_id = $1 and action = 'user.updated'
          order by id desc limit 1`,
        [subject.profileId],
      );

      expect(entry.actor_profile_id).toBe(owner.profileId);
      expect(entry.actor_label).toBe(owner.fullName);
    });

    it('refuses a direct audit insert naming somebody else', async () => {
      const result = await asUser(
        owner,
        `insert into public.audit_log (actor_profile_id, actor_label, action, entity_type)
         values ($1, 'Framed Person', 'user.created', 'profile')`,
        [secretary.profileId],
      );

      expect(result.ok).toBe(false);
    });

    it('refuses an invented security event name', async () => {
      // The vocabulary is closed, so a caller can record that they signed in
      // but cannot manufacture a 'loan.approved' entry.
      const result = await asUser(
        client,
        `select public.record_security_event('loan.approved', null)`,
      );

      expect(result.ok).toBe(false);
      expect(result.message).toMatch(/Unsupported security event/);
    });

    it('attributes a security event to the caller regardless', async () => {
      const result = await asUser(
        client,
        `select public.record_security_event('auth.signed_in', null) as id`,
      );
      expect(result.ok).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  describe('editing somebody else', () => {
    it('refuses a client updating another profile', async () => {
      const result = await asUser(
        client,
        `update public.profiles set full_name = 'Hacked' where id = $1`,
        [owner.profileId],
      );

      expect(result.rowCount).toBe(0);
    });

    it('refuses a secretary updating another profile', async () => {
      const result = await asUser(
        secretary,
        `update public.profiles set full_name = 'Hacked' where id = $1`,
        [manager.profileId],
      );

      expect(result.rowCount).toBe(0);
    });

    it('refuses a manager updating another profile despite seeing it', async () => {
      // Read access and write access are separate capabilities. A Manager
      // holding users:view can see the directory and change none of it.
      const visible = await asUser(
        manager,
        `select id from public.profiles where id = $1`,
        [secretary.profileId],
      );
      expect(visible.rows).toHaveLength(1);

      const written = await asUser(
        manager,
        `update public.profiles set full_name = 'Hacked' where id = $1`,
        [secretary.profileId],
      );
      expect(written.rowCount).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  describe('privileged columns', () => {
    it('refuses anyone re-pointing an authentication link', async () => {
      // Re-pointing auth_user_id would let one profile adopt another person's
      // session — the most direct account takeover available.
      for (const [label, subject] of [
        ['client', client],
        ['manager', manager],
        ['owner', owner],
      ] as const) {
        const result = await asUser(
          subject,
          `update public.profiles set auth_user_id = gen_random_uuid() where id = $1`,
          [subject.profileId],
        );
        expect(result.ok, label).toBe(false);
        expect(result.message, label).toMatch(/authentication link/i);
      }
    });

    it('refuses a status change without users:disable', async () => {
      for (const [label, subject] of [
        ['client', client],
        ['secretary', secretary],
        ['manager', manager],
      ] as const) {
        const result = await asUser(
          subject,
          `update public.profiles set status = 'inactive' where id = $1`,
          [subject.profileId],
        );
        expect(result.ok, label).toBe(false);
        expect(result.message, label).toMatch(/users:disable/);
      }
    });

    it('refuses clearing the forced password change by editing the row', async () => {
      const subject = await createTestUser('client');
      await query(
        `update public.profiles set must_change_password = true where id = $1`,
        [subject.profileId],
      );

      const direct = await asUser(
        subject,
        `update public.profiles set must_change_password = false where id = $1`,
        [subject.profileId],
      );

      expect(direct.ok).toBe(false);
      expect(direct.message).toMatch(/changing the password/i);
    });

    it('allows clearing it through the sanctioned function', async () => {
      const subject = await createTestUser('client');
      await query(
        `update public.profiles set must_change_password = true where id = $1`,
        [subject.profileId],
      );

      // One transaction, so the read observes the function's effect. `asUser`
      // rolls back after each call, which would hide it.
      const viaFunction = await asUserScript(subject, [
        { sql: `select public.complete_password_change()` },
        {
          sql: `select must_change_password from public.profiles where id = $1`,
          params: [subject.profileId],
        },
      ]);

      expect(viaFunction.ok).toBe(true);
      expect(viaFunction.rows[0]?.must_change_password).toBe(false);
    });

    it('refuses forging a sign-in time', async () => {
      const result = await asUser(
        owner,
        `update public.profiles set last_sign_in_at = now() - interval '1 year' where id = $1`,
        [owner.profileId],
      );

      expect(result.ok).toBe(false);
      expect(result.message).toMatch(/sign-in path/i);
    });

    it('refuses requiring a password change without the capability', async () => {
      const result = await asUser(
        manager,
        `update public.profiles set must_change_password = true where id = $1`,
        [manager.profileId],
      );

      expect(result.ok).toBe(false);
      expect(result.message).toMatch(/users:reset_password/);
    });
  });

  // -------------------------------------------------------------------------
  describe('creating accounts', () => {
    it('refuses a profile insert without users:create', async () => {
      for (const [label, subject] of [
        ['client', client],
        ['secretary', secretary],
        ['manager', manager],
      ] as const) {
        const result = await asUser(
          subject,
          `insert into public.profiles (full_name, phone, must_change_password)
           values ('Smuggled', '+256779000001', true)`,
        );
        expect(result.ok, label).toBe(false);
      }
    });

    it('refuses an owner creating a pre-linked profile', async () => {
      // The INSERT policy pins the shape of a new row: a caller cannot create
      // a profile already attached to an existing login.
      const result = await asUser(
        owner,
        `insert into public.profiles (full_name, phone, must_change_password, auth_user_id)
         values ('Pre-linked', '+256779000002', true, $1)`,
        [client.authUserId],
      );

      expect(result.ok).toBe(false);
    });

    it('refuses an owner creating a profile that skips the password change', async () => {
      const result = await asUser(
        owner,
        `insert into public.profiles (full_name, phone, must_change_password)
         values ('No forced change', '+256779000003', false)`,
      );

      expect(result.ok).toBe(false);
    });

    it('refuses an owner creating a profile that is already suspended-proof', async () => {
      const result = await asUser(
        owner,
        `insert into public.profiles (full_name, phone, must_change_password, status)
         values ('Odd status', '+256779000004', true, 'archived')`,
      );

      expect(result.ok).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  describe('invoking privileged functions directly', () => {
    it('refuses anon every helper', async () => {
      for (const sql of [
        `select public.current_profile_id()`,
        `select public.user_has_permission('users:create')`,
        `select public.next_reference('client')`,
        `select public.record_security_event('auth.signed_in', null)`,
        `select public.complete_password_change()`,
      ]) {
        const result = await asAnon(sql);
        expect(result.ok, sql).toBe(false);
      }
    });

    it('refuses an authenticated user the reference generator', async () => {
      // Nothing in Phase 2 issues a reference. Granting it would let any
      // signed-in user inflate the client and loan counters.
      const result = await asUser(client, `select public.next_reference('client')`);
      expect(result.ok).toBe(false);
    });

    it('scopes complete_password_change to the caller, with no argument to forge', async () => {
      const result = await asUser(client, `select public.complete_password_change($1)`, [
        owner.profileId,
      ]);

      // No such overload exists: the function takes no arguments precisely so
      // one user cannot act on another's row.
      expect(result.ok).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  describe('spoofing a session', () => {
    it('gives nothing to a token whose subject matches no profile', async () => {
      const result = await asUser(
        { authUserId: '00000000-0000-4000-8000-000000000000' },
        `select public.current_profile_id() as id, public.user_has_permission('users:view') as perm`,
      );

      expect(result.rows[0]?.id).toBeNull();
      expect(result.rows[0]?.perm).toBe(false);
    });

    it('gives nothing when the profile exists but is unlinked', async () => {
      // A profile with no auth_user_id — which is how a client registered at
      // the counter exists before they ever get a login. No token can resolve
      // to it. The fixture is removed by the suite's shared cleanup, which
      // shares the +2567000 phone prefix.
      const unlinked = await queryOne<{ id: string }>(
        `insert into public.profiles (full_name, phone, status)
         values ('Unlinked', '+256700099999', 'active') returning id`,
      );

      expect(unlinked.id).toBeTruthy();

      const result = await asUser(
        { authUserId: '00000000-0000-4000-8000-000000000001' },
        `select count(*)::int as visible from public.profiles`,
      );

      expect(result.rows[0]?.visible).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  describe('fixtures', () => {
    it('created a second owner for the last-owner tests', () => {
      expect(otherOwner.profileId).toBeTruthy();
    });
  });
});
