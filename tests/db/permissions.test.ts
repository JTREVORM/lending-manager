import { afterAll, describe, expect, it } from 'vitest';

import { PERMISSIONS, ROLE_KEYS, rolePermissionPairs } from '@/lib/permissions';
import { closePool, hasDatabase, query, queryOne, skipReason } from '../helpers/db';

/**
 * The TypeScript permission matrix and the database one must be identical.
 *
 * They exist in two places for a reason — the application needs it to decide
 * what to render, and Row Level Security needs it to decide what is actually
 * allowed — but two copies of a security rule is exactly the arrangement that
 * drifts. This suite is what stops it: adding a grant in one place without the
 * other fails here.
 */
const describeDb = hasDatabase ? describe : describe.skip;

if (!hasDatabase) {
  describe('permission matrix suite', () => {
    it.skip(`skipped — ${skipReason}`, () => undefined);
  });
}

afterAll(async () => {
  await closePool();
});

describeDb('the permission matrix matches the application', () => {
  it('declares exactly the same capabilities', async () => {
    const rows = await query<{ key: string }>(
      `select key from public.permissions order by key`,
    );

    expect(rows.map((row) => row.key)).toEqual([...PERMISSIONS].sort());
  });

  it('grants exactly the same capabilities to exactly the same roles', async () => {
    const rows = await query<{ role_key: string; permission_key: string }>(
      `select role_key, permission_key from public.role_permissions
        order by role_key, permission_key`,
    );

    const fromDatabase = rows.map((row) => `${row.role_key}:${row.permission_key}`);
    const fromCode = rolePermissionPairs().map(
      ({ role, permission }) => `${role}:${permission}`,
    );

    expect(fromDatabase).toEqual(fromCode);
  });

  it('references only roles that exist', async () => {
    const rows = await query<{ role_key: string }>(
      `select distinct rp.role_key
         from public.role_permissions rp
         left join public.roles r on r.key = rp.role_key
        where r.key is null`,
    );

    expect(rows).toEqual([]);
  });

  it('gives every role at least one capability', async () => {
    // A role nobody can do anything with is a configuration mistake, not a
    // deliberate state.
    const rows = await query<{ key: string }>(
      `select r.key from public.roles r
        where not exists (
          select 1 from public.role_permissions rp where rp.role_key = r.key
        )`,
    );

    expect(rows.map((row) => row.key)).toEqual([]);
  });

  it('covers every role the application knows about', async () => {
    const rows = await query<{ role_key: string }>(
      `select distinct role_key from public.role_permissions order by role_key`,
    );

    expect(rows.map((row) => row.role_key)).toEqual([...ROLE_KEYS].sort());
  });
});

describeDb('user_has_permission', () => {
  it('returns false for an unknown capability rather than erroring', async () => {
    const row = await queryOne<{ result: boolean }>(
      `select public.user_has_permission('loans:forge') as result`,
    );

    expect(row.result).toBe(false);
  });

  it('returns false when there is no session', async () => {
    const row = await queryOne<{ result: boolean }>(
      `select public.user_has_permission('users:create') as result`,
    );

    expect(row.result).toBe(false);
  });

  it('returns an empty capability list when there is no session', async () => {
    const row = await queryOne<{ permissions: string[] }>(
      `select public.current_user_permissions() as permissions`,
    );

    expect(row.permissions).toEqual([]);
  });
});
