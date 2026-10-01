import { afterAll, describe, expect, it } from 'vitest';

import { closePool, hasDatabase, query, queryOne, skipReason } from '../helpers/db';

/**
 * Security posture verification.
 *
 * Row Level Security is the only real boundary in this system — application
 * checks are a usability layer that a caller holding a token can bypass by
 * talking to the REST API directly. So the posture is asserted against the
 * catalogue, not against the SQL text or against intent.
 *
 * Phase 1 is default-deny: RLS enabled everywhere, no policies except on two
 * non-sensitive lookup tables, and no table privileges for `anon` at all.
 */
const describeDb = hasDatabase ? describe : describe.skip;

afterAll(async () => {
  await closePool();
});

if (!hasDatabase) {
  describe('security suite', () => {
    it.skip(`skipped — ${skipReason}`, () => undefined);
  });
}

describeDb('row level security', () => {
  it('is enabled on every table in the public schema', async () => {
    const rows = await query<{ relname: string }>(
      `select c.relname
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public'
          and c.relkind = 'r'
          and c.relrowsecurity = false
        order by c.relname`,
    );

    // A table without RLS is readable over the REST API by any signed-in
    // user, whatever the application does.
    expect(rows.map((row) => row.relname)).toEqual([]);
  });

  it('grants anon no privilege on any table', async () => {
    const rows = await query<{ table_name: string; privilege_type: string }>(
      `select table_name, privilege_type
         from information_schema.role_table_grants
        where table_schema = 'public' and grantee = 'anon'
        order by table_name, privilege_type`,
    );

    // Supabase grants these by default; the migrations revoke them. An
    // anonymous visitor must reach nothing, even with RLS misconfigured.
    expect(rows).toEqual([]);
  });

  it('grants authenticated nothing beyond SELECT on the two lookup tables', async () => {
    const rows = await query<{ table_name: string; privilege_type: string }>(
      `select table_name, privilege_type
         from information_schema.role_table_grants
        where table_schema = 'public' and grantee = 'authenticated'
        order by table_name, privilege_type`,
    );

    expect(rows.map((row) => `${row.table_name}:${row.privilege_type}`)).toEqual([
      'repayment_frequencies:SELECT',
      'roles:SELECT',
    ]);
  });

  it('defines policies only on the non-sensitive lookup tables', async () => {
    const rows = await query<{
      tablename: string;
      policyname: string;
      cmd: string;
      roles: string;
    }>(
      `select tablename, policyname, cmd, roles::text as roles
         from pg_policies
        where schemaname = 'public'
        order by tablename, policyname`,
    );

    expect(rows.map((row) => `${row.tablename}:${row.cmd}:${row.roles}`)).toEqual([
      'repayment_frequencies:SELECT:{authenticated}',
      'roles:SELECT:{authenticated}',
    ]);
  });

  it('leaves the tables holding personal and financial data with no policy, so they deny by default', async () => {
    const DEFAULT_DENY = [
      'profiles',
      'user_roles',
      'company_settings',
      'business_settings',
      'audit_log',
      'reference_formats',
      'reference_sequences',
    ];

    const rows = await query<{ tablename: string }>(
      `select distinct tablename from pg_policies where schemaname = 'public'`,
    );
    const withPolicies = new Set(rows.map((row) => row.tablename));

    for (const table of DEFAULT_DENY) {
      expect(withPolicies.has(table), `${table} has a policy in Phase 1`).toBe(false);
    }
  });

  it('restricts the one permissive policy to non-sensitive data', async () => {
    const rows = await query<{ tablename: string; qual: string | null }>(
      `select tablename, qual from pg_policies where schemaname = 'public'`,
    );

    for (const row of rows) {
      if (row.qual === 'true') {
        // `roles` holds four keys, their labels and their ordering. No
        // personal data, no financial data, nothing about who holds what.
        expect(row.tablename).toBe('roles');
      }
    }
  });
});

describeDb('privileged functions', () => {
  const EXPECTED_DEFINER = [
    'current_profile_id',
    'current_user_role_keys',
    'next_reference',
    'record_audit_event',
    'user_has_at_least_role',
    'user_has_role',
  ];

  it('marks exactly the intended functions SECURITY DEFINER', async () => {
    const rows = await query<{ proname: string }>(
      `select p.proname
         from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.prosecdef = true
        order by p.proname`,
    );

    expect(rows.map((row) => row.proname)).toEqual(EXPECTED_DEFINER);
  });

  it('locks search_path on every function, privileged or not', async () => {
    // Without this a caller can prepend their own schema and make the function
    // resolve `profiles` to a table they control.
    const rows = await query<{ proname: string; proconfig: string[] | null }>(
      `select p.proname, p.proconfig
         from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.prokind = 'f'
        order by p.proname`,
    );

    expect(rows.length).toBeGreaterThan(0);

    for (const row of rows) {
      expect(row.proconfig, `${row.proname} has no search_path setting`).not.toBeNull();
      // PostgreSQL records `SET search_path = ''` in proconfig as the string
      // `search_path=""` — the empty value is quoted.
      expect(
        row.proconfig?.some((setting) => /^search_path=(""|)$/.test(setting)),
        `${row.proname} does not pin search_path to the empty string`,
      ).toBe(true);
    }
  });

  it('revokes EXECUTE from PUBLIC on every privileged function', async () => {
    // PostgreSQL grants EXECUTE to PUBLIC by default, which would make a
    // SECURITY DEFINER function callable by `anon`.
    for (const functionName of EXPECTED_DEFINER) {
      const row = await queryOne<{ public_can_execute: boolean }>(
        `select bool_or(
                  coalesce(has_function_privilege('public', p.oid, 'execute'), false)
                ) as public_can_execute
           from pg_proc p
           join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public' and p.proname = $1`,
        [functionName],
      );

      expect(row.public_can_execute, `PUBLIC can execute ${functionName}`).toBe(false);
    }
  });

  it('withholds EXECUTE on next_reference and record_audit_event until a later phase needs them', async () => {
    // Nothing in Phase 1 issues a reference or records an audit event.
    // Granting now would let any signed-in user inflate the counters.
    for (const functionName of ['next_reference', 'record_audit_event']) {
      for (const role of ['anon', 'authenticated']) {
        const row = await queryOne<{ can_execute: boolean }>(
          `select bool_or(
                    coalesce(has_function_privilege($2, p.oid, 'execute'), false)
                  ) as can_execute
             from pg_proc p
             join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.proname = $1`,
          [functionName, role],
        );

        expect(row.can_execute, `${role} can execute ${functionName}`).toBe(false);
      }
    }
  });

  it('grants the session role helpers to authenticated but not to anon', async () => {
    // Each helper reads only the calling user's own rows, so exposing it to a
    // signed-in user is safe; an anonymous visitor has no session to read.
    for (const functionName of [
      'current_profile_id',
      'current_user_role_keys',
      'user_has_role',
      'user_has_at_least_role',
    ]) {
      const row = await queryOne<{ authenticated: boolean; anon: boolean }>(
        `select
             bool_or(coalesce(has_function_privilege('authenticated', p.oid, 'execute'), false)) as authenticated,
             bool_or(coalesce(has_function_privilege('anon', p.oid, 'execute'), false)) as anon
           from pg_proc p
           join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public' and p.proname = $1`,
        [functionName],
      );

      expect(row.authenticated, `authenticated cannot execute ${functionName}`).toBe(
        true,
      );
      expect(row.anon, `anon can execute ${functionName}`).toBe(false);
    }
  });
});

describeDb('storage buckets', () => {
  it('creates the three buckets, all private', async () => {
    const rows = await query<{
      id: string;
      public: boolean;
      file_size_limit: string | null;
      allowed_mime_types: string[] | null;
    }>(`select id, public, file_size_limit, allowed_mime_types
          from storage.buckets order by id`);

    expect(rows.map((row) => row.id)).toEqual([
      'client-documents',
      'company-assets',
      'guarantor-documents',
    ]);

    // A public bucket holding a National ID photograph is a data breach
    // waiting for a crawler.
    for (const row of rows) {
      expect(row.public, `${row.id} is public`).toBe(false);
      expect(row.file_size_limit, `${row.id} has no size limit`).not.toBeNull();
      expect(row.allowed_mime_types, `${row.id} has no MIME allow-list`).not.toBeNull();
    }
  });

  it('excludes SVG from every bucket, because an SVG is executable XML', async () => {
    const rows = await query<{ id: string; allowed_mime_types: string[] }>(
      `select id, allowed_mime_types from storage.buckets`,
    );

    for (const row of rows) {
      expect(row.allowed_mime_types, `${row.id} permits SVG`).not.toContain(
        'image/svg+xml',
      );
    }
  });

  it('bounds identity-document uploads at 10 MiB and company assets at 2 MiB', async () => {
    const rows = await query<{ id: string; file_size_limit: string }>(
      `select id, file_size_limit from storage.buckets order by id`,
    );

    const limits = Object.fromEntries(
      rows.map((row) => [row.id, Number(row.file_size_limit)]),
    );

    expect(limits['client-documents']).toBe(10 * 1024 * 1024);
    expect(limits['guarantor-documents']).toBe(10 * 1024 * 1024);
    expect(limits['company-assets']).toBe(2 * 1024 * 1024);
  });
});
