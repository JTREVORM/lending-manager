import { afterAll, describe, expect, it } from 'vitest';

import {
  asAnon,
  asUser,
  createTestUser,
  deleteTestUsers,
} from '../helpers/auth-fixtures';
import { closePool, hasDatabase, query, skipReason } from '../helpers/db';

/**
 * `current_session_context()` — the one round trip that resolves the caller.
 *
 * ## Why this has its own file
 *
 * Phase 18 collapsed three serial calls in `lib/auth/context.ts` —
 * `getClaims()`, a `profiles` select and a `user_roles` select — into this
 * one function. Every protected page and every Server Action resolves its
 * caller through it, so what it returns *is* the authorization decision for
 * the whole application. The three outcomes it reports are not cosmetic:
 * `no_session` sends somebody to the sign-in page, `no_active_profile` tells
 * a suspended account its account is not active, and `no_roles` refuses a
 * half-created user rather than defaulting them to `client` and handing them
 * the borrower portal.
 *
 * The thing to be most careful about is the suspended account. Disabling
 * somebody has to take effect on their next request, not when their token
 * expires — that is the whole reason the context is read from the database
 * rather than from the JWT. This function must therefore refuse an account
 * that was active when its token was issued and is not active now, and it
 * must do so because `current_profile_id()` resolves only active profiles,
 * not because of anything this function decides for itself.
 */
const describeDb = hasDatabase ? describe : describe.skip;

if (!hasDatabase) {
  describe('session context suite', () => {
    it.skip(`skipped — ${skipReason}`, () => undefined);
  });
}

interface SessionRow {
  outcome: string;
  auth_user_id: string | null;
  profile_id: string | null;
  full_name: string | null;
  phone: string | null;
  status: string | null;
  must_change_password: boolean | null;
  role_keys: string[];
}

const SELECT = `select * from public.current_session_context()`;

describeDb('current_session_context', () => {
  afterAll(async () => {
    await deleteTestUsers();
    await closePool();
  });

  it('answers with exactly one row, always', async () => {
    // The application reads `data[0]` and treats a missing row as a fault
    // rather than as a fourth outcome, so "always one row" is part of the
    // contract and not an incidental property of the query.
    const user = await createTestUser('manager');

    const signedIn = await asUser(user, SELECT);
    expect(signedIn.rows).toHaveLength(1);

    const anonymous = await asAnon(SELECT);
    // `anon` holds no EXECUTE grant, which is itself a refusal — PostgREST
    // answers 401/403 and the application maps that to "no session". If the
    // grant is ever widened, the function must still answer with one row.
    if (anonymous.ok) {
      expect(anonymous.rows).toHaveLength(1);
      expect((anonymous.rows[0] as unknown as SessionRow).outcome).toBe('no_session');
    } else {
      expect(anonymous.code).toBe('42501');
    }
  });

  it('reports ok for an active account, with its roles', async () => {
    const user = await createTestUser('secretary_treasurer');

    const result = await asUser(user, SELECT);
    expect(result.ok, result.message).toBe(true);

    const row = result.rows[0] as unknown as SessionRow;

    expect(row.outcome).toBe('ok');
    expect(row.auth_user_id).toBe(user.authUserId);
    expect(row.profile_id).toBe(user.profileId);
    expect(row.full_name).toBe(user.fullName);
    expect(row.phone).toBe(user.phone);
    expect(row.status).toBe('active');
    expect(row.role_keys).toEqual(['secretary_treasurer']);
  });

  it('returns every role a profile holds', async () => {
    const user = await createTestUser('manager');

    await query(
      `insert into public.user_roles (profile_id, role_key) values ($1, 'secretary_treasurer')`,
      [user.profileId],
    );

    const result = await asUser(user, SELECT);
    const row = result.rows[0] as unknown as SessionRow;

    expect(row.outcome).toBe('ok');
    expect([...row.role_keys].sort()).toEqual(['manager', 'secretary_treasurer']);
  });

  it('refuses a suspended account on its very next request', async () => {
    // Active when the token was issued, suspended now. The token is still
    // perfectly valid and still verifies; the account is not usable, and the
    // answer has to come from the database rather than from the token.
    const user = await createTestUser('manager');

    const before = await asUser(user, SELECT);
    expect((before.rows[0] as unknown as SessionRow).outcome).toBe('ok');

    await query(`update public.profiles set status = 'suspended' where id = $1`, [
      user.profileId,
    ]);

    const after = await asUser(user, SELECT);
    const row = after.rows[0] as unknown as SessionRow;

    expect(row.outcome).toBe('no_active_profile');
    // Nothing about the account comes back with the refusal. The reason is
    // reported; the profile is not.
    expect(row.profile_id).toBeNull();
    expect(row.full_name).toBeNull();
    expect(row.role_keys).toEqual([]);
    // The verified subject is still reported, because the application needs
    // to know a token was presented in order to tell "not signed in" from
    // "your account is not active".
    expect(row.auth_user_id).toBe(user.authUserId);
  });

  it('refuses an archived account the same way', async () => {
    const user = await createTestUser('manager');

    await query(
      `update public.profiles set status = 'archived', archived_at = now() where id = $1`,
      [user.profileId],
    );

    const result = await asUser(user, SELECT);
    const row = result.rows[0] as unknown as SessionRow;

    expect(row.outcome).toBe('no_active_profile');
    expect(row.profile_id).toBeNull();
  });

  it('refuses a profile that holds no role', async () => {
    // An incomplete account, not a borrower. Defaulting it to `client` would
    // silently grant portal access to a half-created user.
    const user = await createTestUser('manager');

    await query(`delete from public.user_roles where profile_id = $1`, [user.profileId]);

    const result = await asUser(user, SELECT);
    const row = result.rows[0] as unknown as SessionRow;

    expect(row.outcome).toBe('no_roles');
    // The profile resolved — it is active — so its details come back. It is
    // the role set that is missing, and the application turns that into a
    // different sentence.
    expect(row.profile_id).toBe(user.profileId);
    expect(row.role_keys).toEqual([]);
  });

  it('carries the forced-password-change flag', async () => {
    // The guard refuses every route but the password form while this is set,
    // so it has to survive the one round trip.
    const user = await createTestUser('manager');

    await query(`update public.profiles set must_change_password = true where id = $1`, [
      user.profileId,
    ]);

    const result = await asUser(user, SELECT);
    const row = result.rows[0] as unknown as SessionRow;

    expect(row.outcome).toBe('ok');
    expect(row.must_change_password).toBe(true);
  });

  it('cannot be used to read somebody else’s profile', async () => {
    // It is SECURITY DEFINER, so it reads `profiles` without that table's
    // policies applying — which is only safe because it resolves the row
    // through `current_profile_id()` and can therefore only ever return the
    // caller's own. Two accounts, each asking: each gets itself.
    const first = await createTestUser('manager');
    const second = await createTestUser('secretary_treasurer');

    const asFirst = (await asUser(first, SELECT)).rows[0] as unknown as SessionRow;
    const asSecond = (await asUser(second, SELECT)).rows[0] as unknown as SessionRow;

    expect(asFirst.profile_id).toBe(first.profileId);
    expect(asSecond.profile_id).toBe(second.profileId);
    expect(asFirst.profile_id).not.toBe(asSecond.profile_id);
  });

  it('is not executable by anon', async () => {
    // The pre-authentication path never needs it, and an anonymous caller
    // who could call it would be probing for which accounts exist.
    const [row] = await query<{ granted: boolean }>(
      `select has_function_privilege('anon', 'public.current_session_context()', 'execute')
                as granted`,
    );

    expect(row?.granted).toBe(false);
  });
});
