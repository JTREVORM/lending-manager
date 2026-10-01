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
 * The forced password change, defended at the database.
 *
 * The bypass this closes: a user holding an administrator-issued temporary
 * password called `complete_password_change()` over PostgREST and cleared the
 * flag without changing anything, keeping a password their administrator also
 * knew. The interface was never involved, so no amount of care in the
 * interface could have prevented it.
 *
 * Everything below runs as a real database role — `anon`, `authenticated` or
 * `service_role` — exactly as a request arriving at the REST API would.
 */
const describeDb = hasDatabase ? describe : describe.skip;

if (!hasDatabase) {
  describe('password change suite', () => {
    it.skip(`skipped — ${skipReason}`, () => undefined);
  });
}

/** Raise the flag through a trusted path, as an administrator reset would. */
async function issueTemporaryPassword(profileId: string): Promise<void> {
  await query(`update public.profiles set must_change_password = true where id = $1`, [
    profileId,
  ]);
}

async function readFlag(
  profileId: string,
): Promise<{ must_change_password: boolean; password_set_at: string | null }> {
  return queryOne(
    `select must_change_password, password_set_at::text as password_set_at
       from public.profiles where id = $1`,
    [profileId],
  );
}

describeDb('the forced-password-change flag', () => {
  let subject: TestUser;
  let owner: TestUser;

  beforeAll(async () => {
    await deleteTestUsers();
    owner = await createTestUser('owner_admin');
    subject = await createTestUser('secretary_treasurer');
  });

  afterAll(async () => {
    await deleteTestUsers();
    await closePool();
  });

  // -------------------------------------------------------------------------
  describe('the old bypass no longer exists', () => {
    it('removes complete_password_change entirely', async () => {
      const rows = await query<{ proname: string }>(
        `select p.proname
           from pg_proc p
           join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public' and p.proname = 'complete_password_change'`,
      );

      // Dropped rather than merely un-granted: a function nobody may call is
      // still a function somebody may later re-grant by accident.
      expect(rows).toEqual([]);
    });

    it('gives no session role EXECUTE on the replacement', async () => {
      for (const role of ['anon', 'authenticated']) {
        const row = await queryOne<{ can_execute: boolean }>(
          `select coalesce(bool_or(has_function_privilege($1, p.oid, 'execute')), false)
                    as can_execute
             from pg_proc p
             join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.proname = 'confirm_password_change'`,
          [role],
        );

        expect(row.can_execute, `${role} can execute confirm_password_change`).toBe(
          false,
        );
      }
    });

    it('keeps it callable by service_role, which is the trusted server path', async () => {
      const row = await queryOne<{ can_execute: boolean }>(
        `select coalesce(bool_or(has_function_privilege('service_role', p.oid, 'execute')), false)
                  as can_execute
           from pg_proc p
           join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public' and p.proname = 'confirm_password_change'`,
      );

      expect(row.can_execute).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  describe('a user holding a temporary password', () => {
    it('cannot clear the flag with a direct UPDATE', async () => {
      await issueTemporaryPassword(subject.profileId);

      const attempt = await asUser(
        subject,
        `update public.profiles set must_change_password = false where id = $1`,
        [subject.profileId],
      );

      expect(attempt.ok).toBe(false);
      expect(attempt.message).toMatch(/confirming a completed password change/i);

      expect((await readFlag(subject.profileId)).must_change_password).toBe(true);
    });

    it('cannot call the confirmation function directly', async () => {
      await issueTemporaryPassword(subject.profileId);

      const attempt = await asUser(subject, `select public.confirm_password_change($1)`, [
        subject.authUserId,
      ]);

      expect(attempt.ok).toBe(false);
      expect(attempt.code, 'expected a privilege error').toBe('42501');

      expect((await readFlag(subject.profileId)).must_change_password).toBe(true);
    });

    it('cannot call it for somebody else either', async () => {
      const attempt = await asUser(subject, `select public.confirm_password_change($1)`, [
        owner.authUserId,
      ]);

      expect(attempt.ok).toBe(false);
    });

    it('cannot reach it as an anonymous visitor', async () => {
      const attempt = await asAnon(`select public.confirm_password_change($1)`, [
        subject.authUserId,
      ]);

      expect(attempt.ok).toBe(false);
    });

    it('cannot backdate password_set_at to fake an old change', async () => {
      const attempt = await asUser(
        subject,
        `update public.profiles set password_set_at = now() - interval '1 year' where id = $1`,
        [subject.profileId],
      );

      expect(attempt.ok).toBe(false);
      expect(attempt.message).toMatch(/maintained by the database/i);
    });

    it('cannot clear the flag by hiding it inside an otherwise valid update', async () => {
      await issueTemporaryPassword(subject.profileId);

      // The column guard is per-column, so bundling the change with a
      // legitimate one gains nothing.
      const attempt = await asUser(
        subject,
        `update public.profiles
            set full_name = 'Renamed Legitimately', must_change_password = false
          where id = $1`,
        [subject.profileId],
      );

      expect(attempt.ok).toBe(false);
      expect((await readFlag(subject.profileId)).must_change_password).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  describe('even the privileged client cannot clear it by editing the row', () => {
    it('refuses a plain UPDATE from service_role', async () => {
      await issueTemporaryPassword(subject.profileId);

      const attempt = await asServiceRole(
        `update public.profiles set must_change_password = false where id = $1`,
        [subject.profileId],
      );

      // This is the rule that moved above the trusted-path exemption. Before
      // it did, a bug or a compromised secret key could clear the flag without
      // any password having changed.
      expect(attempt.ok).toBe(false);
      expect(attempt.message).toMatch(/confirming a completed password change/i);
      expect((await readFlag(subject.profileId)).must_change_password).toBe(true);
    });

    it('refuses a plain UPDATE from the table owner', async () => {
      await issueTemporaryPassword(subject.profileId);

      await expect(
        query(`update public.profiles set must_change_password = false where id = $1`, [
          subject.profileId,
        ]),
      ).rejects.toMatchObject({ code: 'P0001' });
    });
  });

  // -------------------------------------------------------------------------
  describe('the sanctioned path', () => {
    it('clears the flag and stamps password_set_at', async () => {
      const user = await createTestUser('manager');
      await issueTemporaryPassword(user.profileId);

      const before = await readFlag(user.profileId);
      expect(before.must_change_password).toBe(true);
      expect(before.password_set_at).not.toBeNull();

      // Committed, so the effect can be observed.
      await query(`select public.confirm_password_change($1)`, [user.authUserId]);

      const after = await readFlag(user.profileId);
      expect(after.must_change_password).toBe(false);
      expect(after.password_set_at).not.toBeNull();
      expect(
        new Date(after.password_set_at!).getTime(),
        'password_set_at advances on a confirmed change',
      ).toBeGreaterThan(new Date(before.password_set_at!).getTime());
    });

    it('clears it exactly once — a second call is a no-op, not a second clear', async () => {
      const user = await createTestUser('manager');
      await issueTemporaryPassword(user.profileId);

      await query(`select public.confirm_password_change($1)`, [user.authUserId]);
      const first = await readFlag(user.profileId);

      await query(`select public.confirm_password_change($1)`, [user.authUserId]);
      const second = await readFlag(user.profileId);

      expect(first.must_change_password).toBe(false);
      expect(second.must_change_password).toBe(false);

      // A voluntary change still re-stamps, which is correct: the column means
      // "when the password was last set", not "when the flag was cleared".
      expect(new Date(second.password_set_at!).getTime()).toBeGreaterThanOrEqual(
        new Date(first.password_set_at!).getTime(),
      );
    });

    it('refuses an unknown authentication identity', async () => {
      const attempt = await asServiceRole(
        `select public.confirm_password_change('00000000-0000-4000-8000-000000000000')`,
      );

      expect(attempt.ok).toBe(false);
      expect(attempt.message).toMatch(/No active profile/i);
    });

    it('refuses a null identity rather than clearing something arbitrary', async () => {
      const attempt = await asServiceRole(`select public.confirm_password_change(null)`);

      expect(attempt.ok).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  describe('a disabled account cannot complete the flow', () => {
    it.each(['suspended', 'inactive', 'archived'])(
      'refuses a %s account',
      async (status) => {
        const user = await createTestUser('secretary_treasurer');
        await issueTemporaryPassword(user.profileId);

        await query(
          `update public.profiles
              set status = $2,
                  archived_at = case when $2 = 'archived' then now() else null end
            where id = $1`,
          [user.profileId, status],
        );

        const attempt = await asServiceRole(`select public.confirm_password_change($1)`, [
          user.authUserId,
        ]);

        // Matches every other authorization decision: an account that is not
        // active has no identity for these purposes.
        expect(attempt.ok, status).toBe(false);
        expect(attempt.message, status).toMatch(/No active profile/i);
        expect((await readFlag(user.profileId)).must_change_password, status).toBe(true);
      },
    );
  });

  // -------------------------------------------------------------------------
  describe('raising the flag', () => {
    it('still requires users:reset_password', async () => {
      // The flag must start down for this to be a *raise* rather than a no-op
      // re-assertion of a value that is already set.
      await query(`select public.confirm_password_change($1)`, [subject.authUserId]);
      expect((await readFlag(subject.profileId)).must_change_password).toBe(false);

      const attempt = await asUser(
        subject,
        `update public.profiles set must_change_password = true where id = $1`,
        [subject.profileId],
      );

      expect(attempt.ok).toBe(false);
      expect(attempt.message).toMatch(/users:reset_password/);
      expect((await readFlag(subject.profileId)).must_change_password).toBe(false);
    });

    it('treats re-asserting an already-raised flag as no change at all', async () => {
      // Deliberate: a no-op UPDATE is not a password reset, so it needs no
      // capability. What it must also not do is clear anything or re-stamp.
      await query(
        `update public.profiles set must_change_password = true where id = $1`,
        [subject.profileId],
      );
      const before = await readFlag(subject.profileId);

      const attempt = await asUser(
        subject,
        `update public.profiles set must_change_password = true where id = $1`,
        [subject.profileId],
      );

      expect(attempt.ok).toBe(true);
      const after = await readFlag(subject.profileId);
      expect(after.must_change_password).toBe(true);
      expect(after.password_set_at).toBe(before.password_set_at);
    });

    it('stamps password_set_at from the database clock, ignoring any supplied value', async () => {
      const user = await createTestUser('client');
      await query(`select public.confirm_password_change($1)`, [user.authUserId]);

      const backdated = '2000-01-01T00:00:00Z';

      await query(
        `update public.profiles
            set must_change_password = true, password_set_at = $2
          where id = $1`,
        [user.profileId, backdated],
      );

      const after = await readFlag(user.profileId);
      expect(after.must_change_password).toBe(true);
      expect(
        new Date(after.password_set_at!).getFullYear(),
        'the supplied value was overwritten',
      ).toBeGreaterThan(2000);
    });

    it('stamps it on insert too, and only when the flag is set', async () => {
      const withFlag = await queryOne<{ password_set_at: string | null }>(
        `insert into public.profiles (full_name, phone, must_change_password, password_set_at)
         values ('Insert Flagged', '+256700077101', true, '2000-01-01T00:00:00Z')
         returning password_set_at::text as password_set_at`,
      );

      const withoutFlag = await queryOne<{ password_set_at: string | null }>(
        `insert into public.profiles (full_name, phone, must_change_password, password_set_at)
         values ('Insert Unflagged', '+256700077102', false, '2000-01-01T00:00:00Z')
         returning password_set_at::text as password_set_at`,
      );

      expect(withFlag.password_set_at).not.toBeNull();
      expect(new Date(withFlag.password_set_at!).getFullYear()).toBeGreaterThan(2000);

      // No temporary password was issued, so there is nothing to stamp.
      expect(withoutFlag.password_set_at).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  describe('audit', () => {
    it('records a cleared flag as a password change, with no password material', async () => {
      const user = await createTestUser('manager');
      await issueTemporaryPassword(user.profileId);
      await query(`select public.confirm_password_change($1)`, [user.authUserId]);

      const entry = await queryOne<{
        action: string;
        old_values: Record<string, unknown>;
        new_values: Record<string, unknown>;
      }>(
        `select action, old_values, new_values
           from public.audit_log
          where entity_id = $1 and action = 'user.password_changed'
          order by id desc limit 1`,
        [user.profileId],
      );

      expect(entry.action).toBe('user.password_changed');
      expect(entry.old_values.must_change_password).toBe(true);
      expect(entry.new_values.must_change_password).toBe(false);

      // The whole record, serialised, must contain nothing resembling a
      // credential. The captured columns are listed explicitly in the trigger
      // precisely so a column added later cannot start appearing here.
      const serialised = JSON.stringify(entry);
      expect(serialised).not.toMatch(/password["']?\s*:\s*["'][^"']{4,}/i);
      expect(serialised).not.toMatch(/encrypted_password|crypt|\$2[aby]\$/);
    });

    it('records an administrator-issued reset distinctly from a user change', async () => {
      const user = await createTestUser('manager');
      await issueTemporaryPassword(user.profileId);

      const reset = await queryOne<{ action: string }>(
        `select action from public.audit_log
          where entity_id = $1 order by id desc limit 1`,
        [user.profileId],
      );

      expect(reset.action).toBe('user.password_reset');
    });
  });

  // -------------------------------------------------------------------------
  describe('the rest of the security model is unaffected', () => {
    it('still refuses a status change without the capability', async () => {
      const attempt = await asUser(
        subject,
        `update public.profiles set status = 'inactive' where id = $1`,
        [subject.profileId],
      );

      expect(attempt.ok).toBe(false);
      expect(attempt.message).toMatch(/users:disable/);
    });

    it('still refuses re-pointing an authentication link', async () => {
      const attempt = await asUser(
        subject,
        `update public.profiles set auth_user_id = gen_random_uuid() where id = $1`,
        [subject.profileId],
      );

      expect(attempt.ok).toBe(false);
      expect(attempt.message).toMatch(/authentication link/i);
    });

    it('still refuses forging a sign-in time', async () => {
      const attempt = await asUser(
        subject,
        `update public.profiles set last_sign_in_at = now() where id = $1`,
        [subject.profileId],
      );

      expect(attempt.ok).toBe(false);
      expect(attempt.message).toMatch(/sign-in path/i);
    });

    it('still lets a user change their own name', async () => {
      const attempt = await asUser(
        subject,
        `update public.profiles set full_name = 'Still Editable' where id = $1`,
        [subject.profileId],
      );

      expect(attempt.rowCount).toBe(1);
    });

    it('still records the sign-in stamp through its own function', async () => {
      const attempt = await asUser(subject, `select public.record_sign_in()`);
      expect(attempt.ok).toBe(true);
    });
  });
});
