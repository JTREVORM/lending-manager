import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  asAnon,
  asUser,
  createTestUser,
  deleteTestUsers,
  type TestUser,
} from '../helpers/auth-fixtures';
import { closePool, hasDatabase, query, skipReason } from '../helpers/db';

/**
 * Row Level Security, exercised as each role against a real database.
 *
 * The application's own authorization checks are not involved here. Every
 * statement runs as the `authenticated` or `anon` database role, exactly as a
 * request arriving at Supabase's REST API would — which is the way an attacker
 * would reach the data if they ignored the interface entirely.
 */
const describeDb = hasDatabase ? describe : describe.skip;

if (!hasDatabase) {
  describe('identity RLS suite', () => {
    it.skip(`skipped — ${skipReason}`, () => undefined);
  });
}

describeDb('identity row level security', () => {
  let owner: TestUser;
  let manager: TestUser;
  let secretary: TestUser;
  let client: TestUser;
  let secondOwner: TestUser;

  beforeAll(async () => {
    await deleteTestUsers();
    owner = await createTestUser('owner_admin');
    secondOwner = await createTestUser('owner_admin');
    manager = await createTestUser('manager');
    secretary = await createTestUser('secretary_treasurer');
    client = await createTestUser('client');
  });

  afterAll(async () => {
    await deleteTestUsers();
    await closePool();
  });

  // -------------------------------------------------------------------------
  describe('anonymous visitors', () => {
    it('cannot read any identity table', async () => {
      for (const table of ['profiles', 'user_roles', 'audit_log', 'company_settings']) {
        const result = await asAnon(`select * from public.${table}`);
        expect(result.ok, table).toBe(false);
        // 42501 — denied at the grant level, before RLS is even consulted.
        expect(result.code, table).toBe('42501');
      }
    });

    it('cannot read the permission matrix', async () => {
      // Knowing which role grants what is a map of the system's authority.
      for (const table of ['permissions', 'role_permissions']) {
        const result = await asAnon(`select * from public.${table}`);
        expect(result.ok, table).toBe(false);
      }
    });

    it('cannot write anything', async () => {
      const insert = await asAnon(
        `insert into public.profiles (full_name, phone) values ('Intruder', '+256779999999')`,
      );
      expect(insert.ok).toBe(false);
    });

    it('resolves to no identity and no capability', async () => {
      const result = await asAnon(
        `select public.current_profile_id() is null as anonymous`,
      );
      // The helpers are not granted to anon at all, so this is denied outright.
      expect(result.ok).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  describe('a client', () => {
    it('sees only their own profile', async () => {
      const result = await asUser(client, `select id, full_name from public.profiles`);

      expect(result.ok).toBe(true);
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0]?.id).toBe(client.profileId);
    });

    it('cannot see a staff member even by asking for them directly', async () => {
      const result = await asUser(
        client,
        `select id from public.profiles where id = $1`,
        [owner.profileId],
      );

      expect(result.ok).toBe(true);
      expect(result.rows).toHaveLength(0);
    });

    it('sees only their own role assignment', async () => {
      const result = await asUser(client, `select role_key from public.user_roles`);

      expect(result.rows).toHaveLength(1);
      expect(result.rows[0]?.role_key).toBe('client');
    });

    it('cannot read business or company settings', async () => {
      for (const table of ['business_settings', 'company_settings']) {
        const result = await asUser(client, `select * from public.${table}`);
        expect(result.ok, table).toBe(true);
        expect(result.rows, table).toHaveLength(0);
      }
    });

    it('cannot read the audit trail', async () => {
      const result = await asUser(client, `select * from public.audit_log`);
      expect(result.rows).toHaveLength(0);
    });

    it('can read the role vocabulary, which is not sensitive', async () => {
      const result = await asUser(client, `select key from public.roles`);
      expect(result.rows.length).toBeGreaterThanOrEqual(4);
    });
  });

  // -------------------------------------------------------------------------
  describe('a secretary/treasurer', () => {
    it('sees only themselves, because they hold no users:view', async () => {
      const result = await asUser(secretary, `select id from public.profiles`);

      expect(result.rows).toHaveLength(1);
      expect(result.rows[0]?.id).toBe(secretary.profileId);
    });

    it('can read settings, which they quote to clients', async () => {
      const result = await asUser(
        secretary,
        `select min_loan_amount from public.business_settings`,
      );
      expect(result.rows).toHaveLength(1);
    });

    it('cannot change settings', async () => {
      const result = await asUser(
        secretary,
        `update public.business_settings set grace_period_days = 99 where id = 1`,
      );
      // Filtered to zero rows by the policy rather than raising.
      expect(result.rowCount).toBe(0);
    });

    it('cannot read the audit trail', async () => {
      const result = await asUser(secretary, `select * from public.audit_log`);
      expect(result.rows).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  describe('a manager', () => {
    it('sees the staff directory', async () => {
      const result = await asUser(manager, `select id from public.profiles`);
      expect(result.rows.length).toBeGreaterThanOrEqual(5);
    });

    it('sees role assignments, which they need to know who does what', async () => {
      const result = await asUser(manager, `select role_key from public.user_roles`);
      expect(result.rows.length).toBeGreaterThanOrEqual(5);
    });

    it('cannot change anybody else"s details', async () => {
      const result = await asUser(
        manager,
        `update public.profiles set full_name = 'Renamed' where id = $1`,
        [secretary.profileId],
      );
      expect(result.rowCount).toBe(0);
    });

    it('cannot change an account status', async () => {
      const result = await asUser(
        manager,
        `update public.profiles set status = 'suspended' where id = $1`,
        [secretary.profileId],
      );
      expect(result.rowCount).toBe(0);
    });

    it('cannot read the audit trail', async () => {
      const result = await asUser(manager, `select * from public.audit_log`);
      expect(result.rows).toHaveLength(0);
    });

    it('can change their own name', async () => {
      const result = await asUser(
        manager,
        `update public.profiles set full_name = 'Manager Renamed' where id = $1`,
        [manager.profileId],
      );
      expect(result.rowCount).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  describe('an owner/administrator', () => {
    it('sees every profile and every assignment', async () => {
      const profiles = await asUser(owner, `select id from public.profiles`);
      const roles = await asUser(owner, `select role_key from public.user_roles`);

      expect(profiles.rows.length).toBeGreaterThanOrEqual(5);
      expect(roles.rows.length).toBeGreaterThanOrEqual(5);
    });

    it('can read and change settings', async () => {
      const read = await asUser(owner, `select * from public.business_settings`);
      expect(read.rows).toHaveLength(1);

      const write = await asUser(
        owner,
        `update public.business_settings set grace_period_days = 4 where id = 1`,
      );
      expect(write.rowCount).toBe(1);
    });

    it('can read the audit trail', async () => {
      const result = await asUser(owner, `select id from public.audit_log limit 5`);
      expect(result.ok).toBe(true);
      expect(result.rows.length).toBeGreaterThan(0);
    });

    it('can suspend another user', async () => {
      const result = await asUser(
        owner,
        `update public.profiles set status = 'suspended' where id = $1`,
        [secretary.profileId],
      );
      expect(result.rowCount).toBe(1);
    });

    it('can grant a role to somebody else', async () => {
      const result = await asUser(
        owner,
        `insert into public.user_roles (profile_id, role_key) values ($1, 'manager')`,
        [secretary.profileId],
      );
      expect(result.ok).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  describe('a disabled account loses access immediately', () => {
    /**
     * The scenario the brief calls out: a user signs in, an administrator
     * disables them, and the user makes another request with the same,
     * still-cryptographically-valid token.
     *
     * Every policy routes through `current_profile_id()`, which resolves only
     * active profiles — so the answer is not "wait for the token to expire",
     * it is "nothing is visible on the very next statement".
     */
    it.each(['suspended', 'inactive', 'archived'])(
      'a %s account resolves to no identity and sees nothing',
      async (status) => {
        const subject = await createTestUser('manager');

        const before = await asUser(subject, `select id from public.profiles`);
        expect(before.rows.length).toBeGreaterThan(0);

        await query(
          `update public.profiles
              set status = $2,
                  archived_at = case when $2 = 'archived' then now() else null end
            where id = $1`,
          [subject.profileId, status],
        );

        const identity = await asUser(
          subject,
          `select public.current_profile_id() as id, public.user_has_permission('users:view') as perm`,
        );

        expect(identity.rows[0]?.id, status).toBeNull();
        expect(identity.rows[0]?.perm, status).toBe(false);

        const profiles = await asUser(subject, `select id from public.profiles`);
        expect(profiles.rows, status).toHaveLength(0);

        const settings = await asUser(subject, `select * from public.business_settings`);
        expect(settings.rows, status).toHaveLength(0);
      },
    );

    it('cannot restore themselves', async () => {
      const subject = await createTestUser('owner_admin');

      await query(`update public.profiles set status = 'suspended' where id = $1`, [
        subject.profileId,
      ]);

      const result = await asUser(
        subject,
        `update public.profiles set status = 'active' where id = $1`,
        [subject.profileId],
      );

      // Their own row is no longer visible to them, so the update matches
      // nothing — a suspended Owner cannot un-suspend themselves.
      expect(result.rowCount).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  describe('the permission matrix is readable but not writable', () => {
    it('lets a signed-in user read it', async () => {
      const result = await asUser(client, `select * from public.role_permissions`);
      expect(result.rows.length).toBeGreaterThan(0);
    });

    it('lets nobody write it, not even an owner', async () => {
      // A user who could insert here could grant themselves any capability.
      const insert = await asUser(
        owner,
        `insert into public.role_permissions (role_key, permission_key)
         values ('client', 'users:create')`,
      );
      expect(insert.ok).toBe(false);

      const update = await asUser(
        owner,
        `update public.role_permissions set permission_key = 'audit:view' where role_key = 'client'`,
      );
      expect(update.ok).toBe(false);

      const remove = await asUser(
        owner,
        `delete from public.role_permissions where role_key = 'owner_admin'`,
      );
      expect(remove.ok).toBe(false);
    });

    it('lets nobody invent a new permission', async () => {
      const result = await asUser(
        owner,
        `insert into public.permissions (key, description) values ('loans:forge', 'x')`,
      );
      expect(result.ok).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  describe('the audit trail cannot be altered by anyone', () => {
    it.each([
      ['update', `update public.audit_log set action = 'tampered'`],
      ['delete', `delete from public.audit_log`],
      ['truncate', `truncate public.audit_log`],
    ])('refuses %s even for an owner', async (_label, sql) => {
      const result = await asUser(owner, sql);
      expect(result.ok).toBe(false);
    });

    it('refuses a direct insert, so the actor cannot be forged', async () => {
      // Writes go through SECURITY DEFINER paths that derive the actor. A
      // direct insert would let a caller attribute an action to somebody else.
      const result = await asUser(
        owner,
        `insert into public.audit_log (actor_label, action, entity_type)
         values ('Somebody Else', 'user.created', 'profile')`,
      );
      expect(result.ok).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  describe('second owner exists for the escalation tests', () => {
    it('was created', () => {
      expect(secondOwner.profileId).toBeTruthy();
    });
  });
});
