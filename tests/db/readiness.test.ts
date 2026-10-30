import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { closePool, hasDatabase, inRollbackTransaction, queryOne } from '../helpers/db';

const describeDb = hasDatabase ? describe : describe.skip;
afterAll(closePool);

describeDb('no-data readiness RPC', () => {
  it.each(['anon', 'authenticated'] as const)(
    'returns only true as %s in a read-only transaction without a user session',
    async (role) => {
      await inRollbackTransaction(async (client) => {
        await client.query('set transaction read only');
        await client.query("select set_config('request.jwt.claims', '{}', true)");
        // Roles are literals from the closed list above, never caller input.
        await client.query('set local role ' + role);
        const result = await client.query('select public.polytos_readiness() as ready');
        expect(result.rows).toEqual([{ ready: true }]);
        expect(result.fields.map((field) => [field.name, field.dataTypeID])).toEqual([
          ['ready', 16],
        ]);
      });
    },
  );

  it('is a fixed, argument-free invoker function with no table references', async () => {
    const row = await queryOne<{
      prosecdef: boolean;
      provolatile: string;
      proconfig: string[];
      pronargs: number;
      result: string;
      prosrc: string;
    }>(`select p.prosecdef, p.provolatile, p.proconfig, p.pronargs,
              pg_get_function_result(p.oid) as result, p.prosrc
       from pg_proc p where p.oid = 'public.polytos_readiness()'::regprocedure`);
    expect(row.prosecdef).toBe(false);
    expect(row.provolatile).toBe('s');
    expect(row.proconfig).toEqual(['search_path=""']);
    expect(row.pronargs).toBe(0);
    expect(row.result).toBe('boolean');
    expect(row.prosrc.trim()).toBe('select true;');
  });

  it('grants execution only to the two public API roles and the owner', async () => {
    const row = await queryOne<{ grantees: string[]; public_execute: boolean }>(
      `select array_agg(r.rolname::text order by r.rolname)
                filter (where a.grantee <> p.proowner) as grantees,
              bool_or(a.grantee = 0 and a.privilege_type = 'EXECUTE') as public_execute
       from pg_proc p
       cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
       left join pg_roles r on r.oid = a.grantee
       where p.oid = 'public.polytos_readiness()'::regprocedure`,
    );
    expect(row.grantees).toEqual(['anon', 'authenticated']);
    expect(row.public_execute).toBe(false);
  });

  it('does not give an unrelated role implicit execution', async () => {
    await inRollbackTransaction(async (client) => {
      await client.query('create role readiness_untrusted nologin');
      const result = await client.query(
        "select has_function_privilege('readiness_untrusted', 'public.polytos_readiness()', 'execute') as allowed",
      );
      expect(result.rows).toEqual([{ allowed: false }]);
    });
  });

  it.each(['loans', 'journal_lines', 'memberships', 'membership_policy_versions'])(
    'keeps anonymous access to %s denied after a successful readiness call',
    async (table) => {
      await expect(
        inRollbackTransaction(async (client) => {
          await client.query('set local role anon');
          expect(
            (await client.query('select public.polytos_readiness() as ready')).rows,
          ).toEqual([{ ready: true }]);
          await client.query('select * from public.' + table + ' limit 0');
        }),
      ).rejects.toMatchObject({ code: '42501' });
    },
  );

  it('leaves all existing table, policy and function security definitions unchanged', async () => {
    await inRollbackTransaction(async (client) => {
      await client.query('drop function public.polytos_readiness()');
      const snapshot = async () =>
        (
          await client.query<{ kind: string; name: string; definition: unknown }>(`
        select 'relation' as kind, c.relname as name,
               jsonb_build_array(c.relacl, c.relrowsecurity, c.relforcerowsecurity) as definition
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind in ('r', 'v', 'S')
        union all
        select 'policy', p.polname || ':' || p.polrelid::regclass::text,
               jsonb_build_array(p.polcmd, p.polpermissive, p.polroles, p.polqual::text, p.polwithcheck::text)
        from pg_policy p join pg_class c on c.oid = p.polrelid
        join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public'
        union all
        select 'function', p.oid::regprocedure::text,
               jsonb_build_array(p.proacl, p.prosecdef, p.proconfig, p.prosrc)
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname <> 'polytos_readiness'
        order by kind, name
      `)
        ).rows;
      const before = await snapshot();
      await client.query(
        readFileSync(
          join(process.cwd(), 'supabase/migrations/20261030115530_polytos_readiness.sql'),
          'utf8',
        ),
      );
      expect(await snapshot()).toEqual(before);
    });
  });
});
