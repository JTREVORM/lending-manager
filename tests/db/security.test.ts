import { afterAll, describe, expect, it } from 'vitest';

import { closePool, hasDatabase, query, skipReason } from '../helpers/db';

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

  it('grants authenticated exactly the privileges Phase 2 intends', async () => {
    const rows = await query<{ table_name: string; privilege_type: string }>(
      `select table_name, privilege_type
         from information_schema.role_table_grants
        where table_schema = 'public' and grantee = 'authenticated'
        order by table_name, privilege_type`,
    );

    // Stated exhaustively rather than as spot checks: a privilege appearing
    // on a table that should not have one is the kind of change that reads as
    // harmless in a diff. DELETE appears nowhere — nothing is deleted in this
    // system, and `user_roles` is the single exception because revoking a role
    // is a removal rather than an edit.
    expect(rows.map((row) => `${row.table_name}:${row.privilege_type}`)).toEqual([
      'audit_log:SELECT',
      'business_settings:SELECT',
      'business_settings:UPDATE',
      // Phase 3. Every table gets SELECT, INSERT and UPDATE except
      // `client_remarks`, which gets no UPDATE because it is append-only.
      // DELETE still appears nowhere but `user_roles`: a client is archived,
      // never deleted, and the privilege simply is not there to be misused.
      'client_guarantors:INSERT',
      'client_guarantors:SELECT',
      'client_guarantors:UPDATE',
      'client_identities:INSERT',
      'client_identities:SELECT',
      'client_identities:UPDATE',
      'client_remarks:INSERT',
      'client_remarks:SELECT',
      'clients:INSERT',
      'clients:SELECT',
      'clients:UPDATE',
      'company_settings:SELECT',
      'company_settings:UPDATE',
      'guarantor_identities:INSERT',
      'guarantor_identities:SELECT',
      'guarantor_identities:UPDATE',
      'guarantors:INSERT',
      'guarantors:SELECT',
      'guarantors:UPDATE',
      // Phase 4. The snapshots and the contractual breakdown are read-only to
      // every session: they are written exclusively by `approve_loan`, which
      // runs as the table owner. So nobody can write a snapshot by hand, and
      // a stored snapshot is always one the database captured.
      'loan_client_snapshots:SELECT',
      'loan_guarantor_snapshots:SELECT',
      'loan_identity_snapshots:SELECT',
      // Phase 5. SELECT and nothing else: the collection schedule is written
      // only by generate_loan_schedule, which runs as the table owner, so no
      // write privilege exists for a session to misuse.
      'loan_installments:SELECT',
      'loan_periods:SELECT',
      'loan_schedules:SELECT',
      'loans:INSERT',
      'loans:SELECT',
      'loans:UPDATE',
      'permissions:SELECT',
      'profiles:INSERT',
      'profiles:SELECT',
      'profiles:UPDATE',
      'repayment_frequencies:INSERT',
      'repayment_frequencies:SELECT',
      'repayment_frequencies:UPDATE',
      'role_permissions:SELECT',
      'roles:SELECT',
      'user_roles:DELETE',
      'user_roles:INSERT',
      'user_roles:SELECT',
    ]);
  });

  it('grants nobody the ability to delete a profile or an audit record', async () => {
    const rows = await query<{ table_name: string; grantee: string }>(
      `select table_name, grantee
         from information_schema.role_table_grants
        where table_schema = 'public'
          and privilege_type = 'DELETE'
          and grantee in ('anon', 'authenticated')
          and table_name in ('profiles', 'audit_log')`,
    );

    // Records are archived or reversed, never deleted (ADR-006).
    expect(rows).toEqual([]);
  });

  it('defines a policy for every table that any role may reach', async () => {
    const rows = await query<{ tablename: string; policyname: string; cmd: string }>(
      `select tablename, policyname, cmd
         from pg_policies
        where schemaname = 'public'
        order by tablename, cmd, policyname`,
    );

    expect(rows.map((row) => `${row.tablename}:${row.cmd}`)).toEqual([
      'audit_log:SELECT',
      'business_settings:SELECT',
      'business_settings:UPDATE',
      'client_guarantors:INSERT',
      'client_guarantors:SELECT',
      'client_guarantors:UPDATE',
      'client_identities:INSERT',
      'client_identities:SELECT',
      'client_identities:UPDATE',
      'client_remarks:INSERT',
      'client_remarks:SELECT',
      'clients:INSERT',
      'clients:SELECT',
      'clients:UPDATE',
      'company_settings:SELECT',
      'company_settings:UPDATE',
      'guarantor_identities:INSERT',
      'guarantor_identities:SELECT',
      'guarantor_identities:UPDATE',
      'guarantors:INSERT',
      'guarantors:SELECT',
      'guarantors:UPDATE',
      // Phase 4. SELECT only on the breakdown and the snapshots: they are
      // written exclusively by `approve_loan`, which runs as the table owner.
      // No DELETE policy anywhere — a loan is cancelled, never deleted.
      'loan_client_snapshots:SELECT',
      'loan_guarantor_snapshots:SELECT',
      'loan_identity_snapshots:SELECT',
      // Phase 5. SELECT and nothing else: the collection schedule is written
      // only by generate_loan_schedule, which runs as the table owner, so no
      // write privilege exists for a session to misuse.
      'loan_installments:SELECT',
      'loan_periods:SELECT',
      'loan_schedules:SELECT',
      'loans:INSERT',
      'loans:SELECT',
      'loans:UPDATE',
      'permissions:SELECT',
      'profiles:INSERT',
      'profiles:SELECT',
      'profiles:UPDATE',
      'repayment_frequencies:INSERT',
      'repayment_frequencies:SELECT',
      'repayment_frequencies:UPDATE',
      'role_permissions:SELECT',
      'roles:SELECT',
      'user_roles:DELETE',
      'user_roles:INSERT',
      'user_roles:SELECT',
    ]);
  });

  it('scopes every policy to authenticated, never to anon or to everyone', async () => {
    const rows = await query<{ policyname: string; roles: string }>(
      `select policyname, roles::text as roles
         from pg_policies
        where schemaname = 'public'
          and roles::text <> '{authenticated}'`,
    );

    expect(rows).toEqual([]);
  });

  it('leaves the reference tables with no policy at all', async () => {
    // Nothing reads them from a session. Opening them would disclose how many
    // clients and loans the business has.
    const rows = await query<{ tablename: string }>(
      `select distinct tablename from pg_policies
        where schemaname = 'public'
          and tablename in ('reference_formats', 'reference_sequences')`,
    );

    expect(rows).toEqual([]);
  });

  it('restricts every unconditional policy to non-sensitive vocabulary', async () => {
    const rows = await query<{ tablename: string; qual: string | null }>(
      `select tablename, qual from pg_policies where schemaname = 'public'`,
    );

    // The only tables a signed-in user may read without qualification are the
    // three vocabularies: role names, capability names, and the mapping
    // between them. None names a person or an amount.
    const unconditional = rows
      .filter((row) => row.qual === 'true')
      .map((row) => row.tablename)
      .sort();

    expect([...new Set(unconditional)]).toEqual([
      'permissions',
      'role_permissions',
      'roles',
    ]);
  });

  it('gates every other read policy on a capability or on the caller themselves', async () => {
    const rows = await query<{
      tablename: string;
      policyname: string;
      qual: string | null;
    }>(
      `select tablename, policyname, qual
         from pg_policies
        where schemaname = 'public'
          and cmd = 'SELECT'
          and tablename not in ('permissions', 'role_permissions', 'roles')`,
    );

    expect(rows.length).toBeGreaterThan(0);

    /**
     * Policies that delegate instead of restating.
     *
     * `loan_periods` is visible exactly when its loan is, and it says so by
     * testing `exists (select 1 from public.loans ...)`. That sub-select is
     * itself subject to the SELECT policy on `loans`, so the row is gated by
     * that policy rather than by a capability named here.
     *
     * Delegating is the stronger choice: the alternative is a second copy of
     * the loans rule — including its borrower self-clause — which could drift
     * from the original and quietly widen or narrow access. So the assertion
     * for these tables is that the delegation is actually present, which is a
     * more specific check than the regex below rather than an exemption from
     * it.
     */
    // PostgreSQL normalises `public.loans` to `loans` when it stores the
    // expression, so the needle is the normalised form.
    const DELEGATES_TO: Readonly<Record<string, RegExp>> = {
      loan_periods: /FROM loans\b/,
      // Phase 5. Both delegate the same way, and both additionally require
      // `schedules:view` of a staff caller — so for these two the assertion
      // below checks the delegation *and* the capability, which is stronger
      // than either branch alone.
      loan_installments: /FROM \(?loans l\b/,
      loan_schedules: /FROM \(?loans l\b/,
    };

    /** Policies that must also name a capability, on top of delegating. */
    const ALSO_REQUIRES_CAPABILITY = new Set(['loan_installments', 'loan_schedules']);

    for (const row of rows) {
      const delegate = DELEGATES_TO[row.tablename];

      if (delegate !== undefined) {
        expect(row.qual ?? '', `${row.tablename}.${row.policyname}`).toMatch(delegate);

        if (ALSO_REQUIRES_CAPABILITY.has(row.tablename)) {
          expect(
            row.qual ?? '',
            `${row.tablename}.${row.policyname} must also gate on a capability`,
          ).toContain('user_has_permission');
        }

        continue;
      }

      expect(
        /user_has_permission|current_profile_id|is_active/.test(row.qual ?? ''),
        `${row.tablename}.${row.policyname}`,
      ).toBe(true);
    }
  });

  it('gates every write policy on a capability', async () => {
    const rows = await query<{
      tablename: string;
      policyname: string;
      cmd: string;
      qual: string | null;
      with_check: string | null;
    }>(
      `select tablename, policyname, cmd, qual, with_check
         from pg_policies
        where schemaname = 'public' and cmd <> 'SELECT'`,
    );

    expect(rows.length).toBeGreaterThan(0);

    for (const row of rows) {
      const expression = `${row.qual ?? ''} ${row.with_check ?? ''}`;
      expect(
        /user_has_permission|current_profile_id/.test(expression),
        `${row.tablename}.${row.policyname} (${row.cmd})`,
      ).toBe(true);
    }
  });
});

describeDb('privileged functions', () => {
  it('marks exactly the intended functions SECURITY DEFINER', async () => {
    const rows = await query<{ proname: string }>(
      `select p.proname
         from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.prosecdef = true
        order by p.proname`,
    );

    // Stated exhaustively. SECURITY DEFINER means "runs as the table owner",
    // so a function gaining it by accident gains the ability to ignore every
    // policy in the system.
    expect(rows.map((row) => row.proname)).toEqual([
      // Phase 4 lifecycle functions. Each is SECURITY DEFINER because it
      // writes snapshot tables no session may write, and each checks the
      // caller's capability inside before doing so.
      'approve_loan',
      'assert_owner_admin_remains',
      'audit_actor_label',
      'audit_client_change',
      'audit_client_guarantor_change',
      'audit_client_identity_change',
      'audit_client_remark_added',
      'audit_guarantor_change',
      'audit_guarantor_identity_change',
      'audit_loan_change',
      // Phase 5: one event per generated schedule.
      'audit_loan_schedule_generated',
      'audit_loan_snapshot_created',
      'audit_loan_terms_locked',
      'audit_profile_change',
      'audit_settings_change',
      'audit_user_role_change',
      'cancel_loan',
      'client_guarantors_guard_detach',
      'client_remarks_stamp_author',
      'clients_assign_client_number',
      'clients_guard_privileged_columns',
      'clients_stamp_provenance',
      'confirm_password_change',
      'current_profile_id',
      'current_user_max_rank',
      'current_user_permissions',
      'current_user_role_keys',
      'disburse_loan',
      // Phase 5. SECURITY DEFINER for the usual reason — it writes tables no
      // session may write — and additionally with no execute grant at all,
      // so it is deliberately absent from the grants list below.
      'generate_loan_schedule',
      'guarantors_guard_privileged_columns',
      'guarantors_stamp_provenance',
      'link_client_profile',
      'loans_assign_loan_number',
      'loans_enforce_active_limit',
      'loans_guard_transition',
      'next_reference',
      'profiles_assert_owner_remains',
      'profiles_guard_privileged_columns',
      'profiles_stamp_password_set_at',
      'record_audit_event',
      'record_security_event',
      'record_sign_in',
      'repayment_frequencies_guard_identity',
      'user_has_at_least_role',
      'user_has_permission',
      'user_has_role',
      'user_roles_assert_owner_remains',
      'user_roles_guard_assignment',
      'user_roles_set_granted_by',
      'validate_loan_for_approval',
    ]);
  });

  it('locks search_path on every function, privileged or not', async () => {
    // Without this a caller can prepend their own schema and make the function
    // resolve `profiles` to a table they control — a privilege-escalation
    // route in any SECURITY DEFINER function.
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
      // PostgreSQL records `SET search_path = ''` as the string `search_path=""`.
      expect(
        row.proconfig?.some((setting) => /^search_path=(""|)$/.test(setting)),
        `${row.proname} does not pin search_path to the empty string`,
      ).toBe(true);
    }
  });

  it('leaves no function at all executable by an anonymous visitor', async () => {
    // Stated as an absolute rather than an allowlist: an exception always
    // needs justifying, and the justification is easier to demand when the
    // expected answer is "none" rather than "those two are harmless".
    const rows = await query<{ proname: string }>(
      `select p.proname
         from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and p.prokind = 'f'
          and has_function_privilege('anon', p.oid, 'execute')
        order by p.proname`,
    );

    expect(rows.map((row) => row.proname)).toEqual([]);
  });

  it('grants authenticated only the session-scoped helpers', async () => {
    const rows = await query<{ proname: string }>(
      `select p.proname
         from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and p.prokind = 'f'
          and has_function_privilege('authenticated', p.oid, 'execute')
        order by p.proname`,
    );

    // Each acts on the calling user alone and takes either no argument or one
    // that cannot identify another person, so there is nothing to forge.
    //
    // `next_reference` and `record_audit_event` are deliberately absent:
    // nothing in this phase issues a reference, and audit rows are written by
    // triggers precisely so the actor cannot be supplied by a caller.
    //
    // `confirm_password_change` is absent for a stronger reason, and that
    // absence is load-bearing. Its predecessor was on this list, and being on
    // this list was the bypass: a user issued a temporary password could clear
    // the forced-change requirement over PostgREST without changing anything.
    // Clearing that flag is only safe once Supabase Auth has accepted a new
    // password, which the database cannot observe — so the function is
    // reachable only through the server, by `service_role`. See migration
    // 20261002000800 and tests/db/password-change.test.ts.
    expect(rows.map((row) => row.proname)).toEqual([
      'approve_loan',
      // Pure arithmetic: a function of its arguments that discloses nothing.
      // The preview screen calls it so staff see the authoritative figures
      // rather than the browser's.
      'calculate_loan_breakdown',
      'cancel_loan',
      'current_profile_id',
      'current_user_max_rank',
      'current_user_permissions',
      'current_user_role_keys',
      'disburse_loan',
      'mask_nin',
      'record_security_event',
      'record_sign_in',
      'storage_path_client_id',
      'storage_path_guarantor_id',
      'storage_path_kind',
      'user_has_at_least_role',
      'user_has_permission',
      'user_has_role',
      'validate_loan_for_approval',
    ]);
  });

  it('revokes EXECUTE from PUBLIC on every privileged function', async () => {
    // PostgreSQL grants EXECUTE to PUBLIC by default, which would make a
    // SECURITY DEFINER function callable by anyone at all.
    const rows = await query<{ proname: string }>(
      `select p.proname
         from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and p.prosecdef = true
          and has_function_privilege('public', p.oid, 'execute')
        order by p.proname`,
    );

    expect(rows.map((row) => row.proname)).toEqual([]);
  });

  it('withholds the reference generator and the raw audit writer from every session', async () => {
    for (const functionName of ['next_reference', 'record_audit_event']) {
      for (const role of ['anon', 'authenticated']) {
        const rows = await query<{ can_execute: boolean }>(
          `select coalesce(bool_or(has_function_privilege($2, p.oid, 'execute')), false) as can_execute
             from pg_proc p
             join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.proname = $1`,
          [functionName, role],
        );

        expect(rows[0]?.can_execute, `${role} can execute ${functionName}`).toBe(false);
      }
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
