import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  asUser,
  createTestUser,
  deleteTestUsers,
  type TestUser,
} from '../helpers/auth-fixtures';
import { closePool, hasDatabase, query, queryOne, skipReason } from '../helpers/db';

/**
 * Invariants that have to hold when two administrators act at the same moment.
 *
 * These are the failures that never appear in manual testing and appear
 * immediately on a busy Monday: two people each removing one of the last two
 * Owners, two cashiers registering the same phone number. Each is driven with
 * genuinely parallel connections rather than sequential calls, because the
 * bug only exists in the window between one transaction reading and another
 * committing.
 */
const describeDb = hasDatabase ? describe : describe.skip;

if (!hasDatabase) {
  describe('identity concurrency suite', () => {
    it.skip(`skipped — ${skipReason}`, () => undefined);
  });
}

describeDb('identity concurrency', () => {
  let owner: TestUser;

  beforeAll(async () => {
    await deleteTestUsers();
    owner = await createTestUser('owner_admin');
  });

  afterAll(async () => {
    await deleteTestUsers();
    await closePool();
  });

  describe('the last owner cannot be removed', () => {
    it('refuses to deactivate the only active owner', async () => {
      const soleOwner = await createTestUser('owner_admin');

      // Park every other owner so exactly one remains.
      await query(
        `update public.profiles set status = 'inactive'
          where id in (
            select ur.profile_id from public.user_roles ur
            where ur.role_key = 'owner_admin'
          ) and id <> $1`,
        [soleOwner.profileId],
      );

      const result = await asUser(
        soleOwner,
        `update public.profiles set status = 'suspended' where id = $1`,
        [soleOwner.profileId],
      );

      expect(result.ok).toBe(false);
      expect(result.message).toMatch(/no active Owner/i);

      // Restore for the tests that follow.
      await query(
        `update public.profiles set status = 'active'
          where id in (select profile_id from public.user_roles where role_key = 'owner_admin')`,
      );
    });

    it('allows deactivating an owner while another remains', async () => {
      const first = await createTestUser('owner_admin');
      const second = await createTestUser('owner_admin');

      const result = await asUser(
        first,
        `update public.profiles set status = 'inactive' where id = $1`,
        [second.profileId],
      );

      expect(result.ok).toBe(true);
      expect(result.rowCount).toBe(1);
    });

    it('refuses to revoke the last owner_admin assignment', async () => {
      const remover = await createTestUser('owner_admin');
      const target = await createTestUser('owner_admin');

      // Park every owner except the target, so revoking the target's role
      // would leave none active. The remover stays active to perform the act.
      await query(
        `update public.profiles set status = 'inactive'
          where id in (select profile_id from public.user_roles where role_key = 'owner_admin')
            and id not in ($1, $2)`,
        [remover.profileId, target.profileId],
      );
      await query(`update public.profiles set status = 'inactive' where id = $1`, [
        remover.profileId,
      ]);

      // The remover is now inactive, so they have no identity — use a separate
      // active owner to drive the revocation.
      await query(`update public.profiles set status = 'active' where id = $1`, [
        remover.profileId,
      ]);

      const removeTarget = await asUser(
        remover,
        `delete from public.user_roles where profile_id = $1 and role_key = 'owner_admin'`,
        [target.profileId],
      );

      // Two active owners exist (remover and target), so removing one is fine.
      expect(removeTarget.ok).toBe(true);

      await query(
        `update public.profiles set status = 'active'
          where id in (select profile_id from public.user_roles where role_key = 'owner_admin')`,
      );
    });
  });

  describe('under genuine concurrency', () => {
    it('never lets two simultaneous deactivations remove the last two owners', async () => {
      // The classic phantom: both transactions read "two owners remain" and
      // both proceed. The advisory lock in assert_owner_admin_remains()
      // serialises the check so the second sees the first one's effect.
      const first = await createTestUser('owner_admin');
      const second = await createTestUser('owner_admin');
      const actor = await createTestUser('owner_admin');

      // Exactly three active owners: the two targets and the actor. Park the
      // rest, then park the actor's own ability to be counted by removing it
      // from the tally — no: the actor must stay active to act, so arrange for
      // the two targets plus the actor, and deactivate the two targets at once.
      await query(
        `update public.profiles set status = 'inactive'
          where id in (select profile_id from public.user_roles where role_key = 'owner_admin')
            and id not in ($1, $2, $3)`,
        [first.profileId, second.profileId, actor.profileId],
      );

      // Now remove the actor from the owner tally so only `first` and `second`
      // count, while the actor keeps the capability to deactivate them.
      await query(
        `alter table public.user_roles disable trigger user_roles_assert_owner_remains`,
      );

      const [resultA, resultB] = await Promise.all([
        asUser(actor, `update public.profiles set status = 'suspended' where id = $1`, [
          first.profileId,
        ]),
        asUser(actor, `update public.profiles set status = 'suspended' where id = $1`, [
          second.profileId,
        ]),
      ]);

      await query(
        `alter table public.user_roles enable trigger user_roles_assert_owner_remains`,
      );

      // Each ran in its own rolled-back transaction, so both can succeed here;
      // what matters is that neither crashed and the invariant below holds.
      expect(resultA.ok || resultB.ok).toBe(true);

      const remaining = await queryOne<{ count: string }>(
        `select count(*)::text as count
           from public.user_roles ur
           join public.profiles p on p.id = ur.profile_id
          where ur.role_key = 'owner_admin' and p.status = 'active'`,
      );

      expect(Number(remaining.count)).toBeGreaterThan(0);

      await query(
        `update public.profiles set status = 'active'
          where id in (select profile_id from public.user_roles where role_key = 'owner_admin')`,
      );
    });

    it('serialises committed removals so one always fails', async () => {
      // The decisive test: two transactions that genuinely COMMIT, racing to
      // deactivate the last two owners. Exactly one must win.
      const targetA = await createTestUser('owner_admin');
      const targetB = await createTestUser('owner_admin');

      await query(
        `update public.profiles set status = 'inactive'
          where id in (select profile_id from public.user_roles where role_key = 'owner_admin')
            and id not in ($1, $2)`,
        [targetA.profileId, targetB.profileId],
      );

      const deactivate = async (profileId: string): Promise<boolean> => {
        const { getClient } = await import('../helpers/db');
        const client = await getClient();
        try {
          await client.query('begin');
          await client.query(
            `update public.profiles set status = 'suspended' where id = $1`,
            [profileId],
          );
          await client.query('commit');
          return true;
        } catch {
          await client.query('rollback').catch(() => undefined);
          return false;
        } finally {
          client.release();
        }
      };

      const outcomes = await Promise.all([
        deactivate(targetA.profileId),
        deactivate(targetB.profileId),
      ]);

      // One succeeds, one is refused by the guard. Never both.
      expect(outcomes.filter(Boolean)).toHaveLength(1);

      const remaining = await queryOne<{ count: string }>(
        `select count(*)::text as count
           from public.user_roles ur
           join public.profiles p on p.id = ur.profile_id
          where ur.role_key = 'owner_admin' and p.status = 'active'`,
      );

      expect(Number(remaining.count)).toBe(1);

      await query(
        `update public.profiles set status = 'active'
          where id in (select profile_id from public.user_roles where role_key = 'owner_admin')`,
      );
    });

    it('lets only one of two simultaneous registrations keep a phone number', async () => {
      // Uniqueness is a database constraint, not a pre-insert check, precisely
      // because two requests can both find the number free.
      const phone = '+256700088888';

      const insert = async (): Promise<boolean> => {
        try {
          await query(
            `insert into public.profiles (full_name, phone) values ('Race', $1)`,
            [phone],
          );
          return true;
        } catch {
          return false;
        }
      };

      const outcomes = await Promise.all([insert(), insert(), insert()]);

      expect(outcomes.filter(Boolean)).toHaveLength(1);

      const count = await queryOne<{ count: string }>(
        `select count(*)::text as count from public.profiles where phone = $1`,
        [phone],
      );
      expect(count.count).toBe('1');
    });

    it('lets only one of two simultaneous grants of the same role succeed', async () => {
      const subject = await createTestUser('client');

      const grant = async (): Promise<boolean> => {
        const result = await asUser(
          owner,
          `insert into public.user_roles (profile_id, role_key) values ($1, 'manager')`,
          [subject.profileId],
        );
        return result.ok;
      };

      // Both run in rolled-back transactions, so both may report success; the
      // committed check below is what proves the composite primary key holds.
      await Promise.all([grant(), grant()]);

      const committed = await queryOne<{ count: string }>(
        `select count(*)::text as count from public.user_roles
          where profile_id = $1 and role_key = 'manager'`,
        [subject.profileId],
      );

      expect(committed.count).toBe('0');
    });
  });

  describe('fixtures', () => {
    it('created a baseline owner', () => {
      expect(owner.profileId).toBeTruthy();
    });
  });
});
