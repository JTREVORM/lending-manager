import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Static analysis of the migration files.
 *
 * These checks need no database, so they run in CI on every commit and catch
 * the mistakes that are easiest to make and most expensive to discover later:
 * a table added without Row Level Security, a money column declared as a
 * float, a `USING (true)` policy on financial data, a function missing its
 * `search_path` lock.
 *
 * `tests/db/` verifies the same properties against a real database. This file
 * is the fast gate; that one is the authoritative one.
 */

const MIGRATIONS_DIR = join(process.cwd(), 'supabase', 'migrations');

const migrationFiles = readdirSync(MIGRATIONS_DIR)
  .filter((name) => name.endsWith('.sql'))
  .sort();

const migrations = migrationFiles.map((name) => ({
  name,
  sql: readFileSync(join(MIGRATIONS_DIR, name), 'utf8'),
}));

const allSql = migrations.map((migration) => migration.sql).join('\n');

/** Strip `--` line comments so prose in a comment never matches a check. */
function withoutComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, '');
}

/**
 * Strip comments AND single-quoted string literals.
 *
 * Needed for the column-type checks: the seeded company name is literally
 * 'Money Lending Management System', which would otherwise look like a column
 * declared with the `money` type.
 */
function declarationsOnly(sql: string): string {
  return withoutComments(sql).replace(/'(?:[^']|'')*'/g, "''");
}

const executableSql = withoutComments(allSql);

/** Tables created across all migrations, in the `public` schema. */
const createdTables = [...executableSql.matchAll(/create\s+table\s+public\.(\w+)/gi)].map(
  (match) => match[1]!,
);

describe('migration discipline', () => {
  it('has migrations to check', () => {
    expect(migrationFiles.length).toBeGreaterThan(0);
  });

  it('names every migration with a sortable timestamp prefix', () => {
    // The Supabase CLI applies migrations in filename order, so the prefix is
    // what guarantees `profiles` exists before `user_roles` references it.
    for (const name of migrationFiles) {
      expect(name, name).toMatch(/^\d{14}_[a-z0-9_]+\.sql$/);
    }
  });

  it('gives every migration a distinct timestamp, so the order is unambiguous', () => {
    const timestamps = migrationFiles.map((name) => name.slice(0, 14));
    expect(new Set(timestamps).size).toBe(timestamps.length);
  });

  it('declares every table before it is referenced by a foreign key', () => {
    const seen = new Set<string>();

    for (const { name, sql } of migrations) {
      const body = withoutComments(sql);

      for (const match of body.matchAll(/create\s+table\s+public\.(\w+)/gi)) {
        seen.add(match[1]!);
      }

      for (const match of body.matchAll(/references\s+public\.(\w+)\s*\(/gi)) {
        const target = match[1]!;
        expect(
          seen.has(target),
          `${name} references public.${target} before it exists`,
        ).toBe(true);
      }
    }
  });
});

describe('row level security', () => {
  it('enables RLS on every table created', () => {
    // A table without RLS is readable by any signed-in user via the REST API,
    // regardless of what the application does.
    for (const table of createdTables) {
      expect(
        executableSql,
        `public.${table} is missing "alter table ... enable row level security"`,
      ).toMatch(
        new RegExp(
          `alter\\s+table\\s+public\\.${table}\\s+enable\\s+row\\s+level\\s+security`,
          'i',
        ),
      );
    }
  });

  it('revokes default privileges from anon and authenticated on every table', () => {
    // Supabase grants broad table privileges to these roles by default, so RLS
    // alone is one control; revoking the grant is an independent second.
    for (const table of createdTables) {
      expect(
        executableSql,
        `public.${table} does not revoke privileges from anon/authenticated`,
      ).toMatch(
        new RegExp(
          `revoke\\s+[\\s\\S]{0,80}?on\\s+table\\s+public\\.${table}\\s+from`,
          'i',
        ),
      );
    }
  });

  it('uses USING (true) only on the non-sensitive lookup tables', () => {
    // A permissive policy on financial or personal data would defeat the
    // entire security model, so each one is enumerated deliberately.
    // All three are vocabulary: role names, capability names, and which role
    // grants which. None holds personal or financial data, and none says
    // anything about a particular person.
    const PERMITTED = new Set(['roles', 'permissions', 'role_permissions']);

    const policies = [
      ...executableSql.matchAll(
        /create\s+policy\s+(\w+)\s+on\s+public\.(\w+)([\s\S]*?);/gi,
      ),
    ];

    for (const [, policyName, table, body] of policies) {
      if (/using\s*\(\s*true\s*\)/i.test(body ?? '')) {
        expect(
          PERMITTED.has(table!),
          `policy ${String(policyName)} on public.${String(table)} uses USING (true)`,
        ).toBe(true);
      }
    }
  });

  it('gates every policy on personal or financial data behind a capability', () => {
    // Phase 1 left these default-deny. Phase 2 opens them, and the rule is
    // that each policy must be conditional on a capability or on the caller's
    // own identity — never simply on being signed in.
    //
    // Routing through `user_has_permission` / `current_profile_id` is also what
    // makes disabling an account take effect at once: both resolve only active
    // profiles, so a still-valid token stops granting anything.
    const SENSITIVE = [
      'profiles',
      'user_roles',
      'company_settings',
      'business_settings',
      'audit_log',
      'repayment_frequencies',
    ];

    const policies = [
      ...executableSql.matchAll(
        /create\s+policy\s+(\w+)\s+on\s+public\.(\w+)([\s\S]*?);/gi,
      ),
    ];

    let checked = 0;

    for (const [, policyName, table, body] of policies) {
      if (!SENSITIVE.includes(table!)) continue;
      checked += 1;

      expect(
        /user_has_permission|current_profile_id|is_active/.test(body ?? ''),
        `policy ${String(policyName)} on public.${String(table)} is not gated on a capability or on the caller's own identity`,
      ).toBe(true);
    }

    // Guards against the matcher silently finding nothing and passing.
    expect(checked).toBeGreaterThan(5);
  });

  it('leaves the reference tables default-deny, with no policy at all', () => {
    // Nothing reads these from a session: references are issued by
    // next_reference(), which runs as service_role. Opening them would reveal
    // how many clients and loans exist.
    for (const table of ['reference_formats', 'reference_sequences']) {
      expect(
        executableSql,
        `public.${table} has a policy, but nothing should read it from a session`,
      ).not.toMatch(
        new RegExp(`create\\s+policy\\s+\\w+\\s+on\\s+public\\.${table}`, 'i'),
      );
    }
  });

  it('writes no policy that would let a user grant themselves a capability', () => {
    // The permission matrix is migration-managed. A user who could write it
    // could grant themselves anything, so neither table may have a write
    // policy of any kind.
    for (const table of ['permissions', 'role_permissions']) {
      for (const command of ['insert', 'update', 'delete']) {
        expect(
          executableSql,
          `public.${table} has an ${command.toUpperCase()} policy`,
        ).not.toMatch(
          new RegExp(
            `create\\s+policy\\s+\\w+\\s+on\\s+public\\.${table}\\s+for\\s+${command}`,
            'i',
          ),
        );
      }
    }
  });

  it('scopes every policy to a named role rather than leaving it open', () => {
    const policies = [
      ...executableSql.matchAll(
        /create\s+policy\s+(\w+)\s+on\s+public\.(\w+)([\s\S]*?);/gi,
      ),
    ];

    expect(policies.length).toBeGreaterThan(0);

    for (const [, policyName, , body] of policies) {
      expect(body ?? '', `policy ${String(policyName)} has no TO clause`).toMatch(
        /\bto\s+(authenticated|anon|service_role)/i,
      );
    }
  });
});

describe('column type discipline', () => {
  it('never stores money in a floating-point or locale-dependent type', () => {
    // 0.1 + 0.2 !== 0.3. Interest on a reducing balance compounds the error.
    // `money` is worse again: its output depends on the server's lc_monetary.
    for (const { name, sql } of migrations) {
      const body = declarationsOnly(sql);
      expect(body, `${name} uses a float type`).not.toMatch(
        /\b(real|double\s+precision|float4|float8|float\b)/i,
      );
      expect(body, `${name} uses the money type`).not.toMatch(/\bmoney\b/i);
    }
  });

  it('declares every amount column as bigint', () => {
    const amountColumns = [...executableSql.matchAll(/^\s*(\w*amount\w*)\s+(\w+)/gim)];

    expect(amountColumns.length).toBeGreaterThan(0);

    for (const [, column, type] of amountColumns) {
      expect(type?.toLowerCase(), `${String(column)} should be bigint`).toBe('bigint');
    }
  });

  it('declares every rate column as an integer of basis points', () => {
    const rateColumns = [...executableSql.matchAll(/^\s*(\w+_bps)\s+(\w+)/gim)];

    expect(rateColumns.length).toBeGreaterThan(0);

    for (const [, column, type] of rateColumns) {
      expect(type?.toLowerCase(), `${String(column)} should be integer`).toBe('integer');
    }
  });

  it('never uses timestamp without time zone', () => {
    // A bare `timestamp` means "whatever zone the reader assumes", which is
    // how a repayment gets filed against the wrong day.
    for (const { name, sql } of migrations) {
      const body = declarationsOnly(sql);
      expect(body, `${name} uses timestamp without time zone`).not.toMatch(
        /\btimestamp\s+without\s+time\s+zone\b/i,
      );
      // `timestamp` not followed by `tz` or `with time zone`.
      expect(body, `${name} uses a bare timestamp`).not.toMatch(
        /\btimestamp\b(?!tz)(?!\s+with\s+time\s+zone)/i,
      );
    }
  });

  it('records a creation instant on every table, and updated_at where the row is mutable', () => {
    /**
     * Two tables name their creation timestamp for the event it records,
     * which is clearer than a generic `created_at`:
     *
     *   audit_log.occurred_at  — when the audited action happened
     *   user_roles.granted_at  — when the role was granted
     */
    const CREATION_COLUMN: Readonly<Record<string, string>> = {
      audit_log: 'occurred_at',
      user_roles: 'granted_at',
      // Phase 4 snapshots record when they were *captured*, which is the fact
      // that matters about them: the moment the business fixed what it relied
      // on. `created_at` would be the same instant under a vaguer name.
      loan_client_snapshots: 'captured_at',
      loan_guarantor_snapshots: 'captured_at',
      loan_identity_snapshots: 'captured_at',
    };

    /**
     * Tables with no `updated_at`, because a row is never edited in place:
     *
     *   audit_log   append-only; UPDATE is blocked by trigger and privilege.
     *   user_roles  the primary key is (profile_id, role_key), so there is no
     *               non-key column to change — a role is granted or revoked,
     *               never amended.
     *   client_remarks
     *               append-only, like audit_log: UPDATE is refused by a
     *               statement-level trigger and the privilege is not granted.
     *               A mistake is corrected by appending a retraction, so an
     *               `updated_at` column would be a timestamp that can never
     *               advance — worse than absent, because it would imply the
     *               row can be edited.
     *
     * Note that membership here is asserted in both directions: an excluded
     * table must *not* carry the column, so this set cannot be used to excuse
     * a table that simply forgot it.
     */
    const NO_UPDATED_AT = new Set([
      'audit_log',
      'user_roles',
      'role_permissions',
      'client_remarks',
      // Phase 4. All four are append-only in the same way audit_log is:
      // UPDATE is refused by a statement-level trigger and the privilege is
      // not granted. A snapshot that could be edited would not be a snapshot,
      // and a contractual breakdown that could be edited would not be a
      // contract — so an `updated_at` on any of them would be a timestamp
      // that can never advance.
      'loan_periods',
      'loan_client_snapshots',
      'loan_guarantor_snapshots',
      'loan_identity_snapshots',
    ]);

    for (const table of createdTables) {
      const definition = new RegExp(
        `create\\s+table\\s+public\\.${table}\\s*\\(([\\s\\S]*?)\\n\\);`,
        'i',
      ).exec(executableSql)?.[1];

      expect(definition, `could not parse public.${table}`).toBeDefined();

      const creationColumn = CREATION_COLUMN[table] ?? 'created_at';

      expect(definition, `public.${table} is missing ${creationColumn}`).toMatch(
        new RegExp(`${creationColumn}\\s+timestamptz\\s+not\\s+null`, 'i'),
      );

      if (NO_UPDATED_AT.has(table)) {
        expect(definition, `public.${table} should not carry updated_at`).not.toMatch(
          /updated_at\s+timestamptz/i,
        );
        continue;
      }

      expect(definition, `public.${table} is missing updated_at`).toMatch(
        /updated_at\s+timestamptz\s+not\s+null/i,
      );
    }
  });

  it('attaches the updated_at trigger to every table that has the column', () => {
    for (const table of createdTables) {
      const definition = new RegExp(
        `create\\s+table\\s+public\\.${table}\\s*\\(([\\s\\S]*?)\\n\\);`,
        'i',
      ).exec(executableSql)?.[1];

      if (definition === undefined || !/updated_at\s+timestamptz/i.test(definition)) {
        continue;
      }

      // reference_sequences is maintained solely by next_reference(), which
      // sets updated_at itself; no other writer exists.
      if (table === 'reference_sequences') continue;

      expect(
        executableSql,
        `public.${table} has updated_at but no trigger to maintain it`,
      ).toMatch(
        new RegExp(
          `create\\s+trigger\\s+\\w+\\s+before\\s+update\\s+on\\s+public\\.${table}[\\s\\S]{0,160}?set_updated_at`,
          'i',
        ),
      );
    }
  });
});

describe('function discipline', () => {
  it('locks search_path on every function', () => {
    // Without this, a caller can prepend their own schema and make the
    // function resolve `profiles` to a table they control — a privilege
    // escalation route in any SECURITY DEFINER function.
    const functions = [
      ...executableSql.matchAll(
        /create\s+or\s+replace\s+function\s+(public\.\w+)\(([^)]*)\)\s*returns([^$]*?)\sas\s+\$\$/gi,
      ),
    ];

    expect(functions.length).toBeGreaterThan(0);

    for (const [, functionName, , preamble] of functions) {
      expect(preamble ?? '', `${String(functionName)} does not set search_path`).toMatch(
        /set\s+search_path\s*=\s*''/i,
      );
    }
  });

  it('revokes EXECUTE from PUBLIC on every SECURITY DEFINER function', () => {
    // PostgreSQL grants EXECUTE to PUBLIC by default, so a privileged function
    // is callable by `anon` unless that grant is explicitly removed.
    const definerFunctions = [
      ...executableSql.matchAll(
        /create\s+or\s+replace\s+function\s+public\.(\w+)\(([^)]*)\)\s*returns[^$]*?security\s+definer/gi,
      ),
    ].map((match) => match[1]!);

    expect(definerFunctions.length).toBeGreaterThan(0);

    for (const functionName of new Set(definerFunctions)) {
      expect(
        executableSql,
        `public.${functionName} is SECURITY DEFINER but does not revoke EXECUTE from public`,
      ).toMatch(
        new RegExp(
          `revoke\\s+(all|execute)[\\s\\S]{0,40}?on\\s+function\\s+public\\.${functionName}\\s*\\([\\s\\S]{0,200}?\\)\\s+from\\s+public`,
          'i',
        ),
      );
    }
  });
});

describe('audit log immutability', () => {
  it('blocks UPDATE, DELETE and TRUNCATE by trigger', () => {
    for (const operation of ['update', 'delete', 'truncate']) {
      expect(
        executableSql,
        `audit_log does not reject ${operation.toUpperCase()}`,
      ).toMatch(
        new RegExp(
          `create\\s+trigger\\s+\\w+\\s+before\\s+${operation}\\s+on\\s+public\\.audit_log[\\s\\S]{0,160}?reject_mutation`,
          'i',
        ),
      );
    }
  });

  it('also revokes those privileges, including from service_role', () => {
    // The privileged key exists for legitimate administration; rewriting the
    // audit trail is not that.
    expect(executableSql).toMatch(
      /revoke\s+update,\s*delete,\s*truncate\s+on\s+table\s+public\.audit_log\s+from[\s\S]{0,80}?service_role/i,
    );
  });
});

describe('seed data', () => {
  it('seeds required baseline data idempotently', () => {
    const seed = migrations.find((migration) => migration.name.includes('seed'));
    expect(seed).toBeDefined();

    const inserts = [
      ...withoutComments(seed!.sql).matchAll(/insert\s+into\s+public\.(\w+)/gi),
    ];
    expect(inserts.length).toBeGreaterThan(0);

    // Re-running against a database that already holds the rows must be a
    // no-op, not an error.
    const onConflictCount = [...withoutComments(seed!.sql).matchAll(/on\s+conflict/gi)]
      .length;
    expect(onConflictCount).toBe(inserts.length);
  });

  it('seeds no personal data and no financial history', () => {
    // Nothing that could be mistaken for production data.
    const seed = migrations.find((migration) => migration.name.includes('seed'))!;
    const seeded = [
      ...withoutComments(seed.sql).matchAll(/insert\s+into\s+public\.(\w+)/gi),
    ].map((match) => match[1]);

    for (const table of seeded) {
      expect([
        'roles',
        'repayment_frequencies',
        'reference_formats',
        'company_settings',
        'business_settings',
        // Phase 2: the capability vocabulary and the role-to-capability map.
        'permissions',
        'role_permissions',
      ]).toContain(table);
    }
  });
});

describe('types stay in step with the schema', () => {
  it('declares every created table in types/database.types.ts', () => {
    // Generated types are regenerated after each migration; this catches the
    // case where that was forgotten.
    const types = readFileSync(join(process.cwd(), 'types', 'database.types.ts'), 'utf8');

    for (const table of createdTables) {
      expect(types, `types/database.types.ts is missing ${table}`).toMatch(
        new RegExp(`^\\s{6}${table}:\\s*\\{`, 'm'),
      );
    }
  });

  it('declares every function in types/database.types.ts', () => {
    const types = readFileSync(join(process.cwd(), 'types', 'database.types.ts'), 'utf8');

    const functionNames = new Set(
      [
        ...executableSql.matchAll(/create\s+or\s+replace\s+function\s+public\.(\w+)\(/gi),
      ].map((match) => match[1]!),
    );

    // A function a later migration drops is no longer in the schema, so the
    // generated types correctly omit it — and the migration that created it
    // stays as it was, because an applied migration is history.
    //
    // `executableSql` is the migrations concatenated in order, so a drop is
    // always seen after the create it removes. Were the order reversed, the
    // re-create would be the current state and excluding it here would hide a
    // genuine omission; nothing in the project does that, and an out-of-order
    // pair would fail against the live database long before this test.
    for (const match of executableSql.matchAll(
      /drop\s+function\s+(?:if\s+exists\s+)?public\.(\w+)\s*\(/gi,
    )) {
      functionNames.delete(match[1]!);
    }

    // Trigger functions are not callable over the API and are not generated.
    const TRIGGER_FUNCTIONS = new Set([
      'set_updated_at',
      'reject_mutation',
      'profiles_guard_privileged_columns',
      'profiles_stamp_password_set_at',
      'profiles_assert_owner_remains',
      'user_roles_guard_assignment',
      'user_roles_set_granted_by',
      'user_roles_assert_owner_remains',
      'audit_profile_change',
      'audit_user_role_change',
      'audit_settings_change',
      // Called only by other SECURITY DEFINER functions, never over the API.
      'assert_owner_admin_remains',

      // --- Phase 3 ----------------------------------------------------------
      'clients_assign_client_number',
      'clients_guard_privileged_columns',
      'clients_stamp_provenance',
      'guarantors_stamp_provenance',
      'guarantors_guard_privileged_columns',
      'client_guarantors_guard_detach',
      'client_remarks_stamp_author',
      'audit_client_change',
      'audit_client_identity_change',
      'audit_guarantor_change',
      'audit_guarantor_identity_change',
      'audit_client_guarantor_change',
      'audit_client_remark_added',
      // Called only from the audit triggers above.
      'audit_actor_label',

      // --- Phase 4 ----------------------------------------------------------
      'loans_assign_loan_number',
      'loans_guard_transition',
      'loans_enforce_active_limit',
      'audit_loan_change',
      'audit_loan_snapshot_created',
      'audit_loan_terms_locked',
    ]);

    for (const functionName of functionNames) {
      if (TRIGGER_FUNCTIONS.has(functionName)) continue;
      expect(types, `types/database.types.ts is missing ${functionName}`).toContain(
        `${functionName}: {`,
      );
    }
  });
});

describe('no secrets or environment-specific values in migrations', () => {
  it('contains no credentials or hosted project URLs', () => {
    for (const { name, sql } of migrations) {
      expect(sql, `${name} contains a Supabase key`).not.toMatch(
        /sb_(secret|publishable)_[A-Za-z0-9]/,
      );
      expect(sql, `${name} contains a JWT`).not.toMatch(/eyJ[A-Za-z0-9_-]{20,}\./);
      expect(sql, `${name} contains a connection string`).not.toMatch(
        /postgres(ql)?:\/\/[^\s]*:[^\s]*@/,
      );
      expect(sql, `${name} references a hosted project URL`).not.toMatch(
        /https:\/\/[a-z0-9]{20}\.supabase\.co/,
      );
    }
  });
});
