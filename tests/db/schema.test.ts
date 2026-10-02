import { afterAll, describe, expect, it } from 'vitest';

import { REFERENCE_FORMAT_DEFAULTS, REFERENCE_SCOPES } from '@/lib/domain/reference';
import { PROFILE_STATUSES } from '@/lib/domain/status';
import { ROLES, ROLE_KEYS } from '@/lib/permissions/roles';
import { BUSINESS_DEFAULTS, REPAYMENT_FREQUENCY_DEFAULTS } from '@/config/defaults';
import { closePool, hasDatabase, query, queryOne, skipReason } from '../helpers/db';

/**
 * Schema verification against a real PostgreSQL database with every migration
 * applied from scratch.
 *
 * `tests/integration/migrations.test.ts` reads the SQL text; this suite reads
 * the catalogue, which is what actually governs behaviour.
 */
const describeDb = hasDatabase ? describe : describe.skip;

afterAll(async () => {
  await closePool();
});

if (!hasDatabase) {
  describe('database suite', () => {
    it.skip(`skipped — ${skipReason}`, () => undefined);
  });
}

describeDb('tables', () => {
  const EXPECTED_TABLES = [
    'audit_log',
    'business_settings',
    // Phase 3: the lending-business customer record, its sensitive half, the
    // guarantors who vouch for them, the association between the two, and the
    // append-only staff commentary.
    'client_guarantors',
    'client_identities',
    'client_remarks',
    'clients',
    'company_settings',
    'guarantor_identities',
    'guarantors',
    // Phase 4: the loan agreement, its contractual monthly breakdown, and the
    // three snapshots that make it evidence rather than a view over today's
    // records.
    'loan_client_snapshots',
    'loan_guarantor_snapshots',
    'loan_identity_snapshots',
    // Phase 5: the collection plan — one generation record per loan, and the
    // scheduled collections that allocate the contractual breakdown.
    'loan_installments',
    'loan_payments',
    'loan_periods',
    'loan_schedules',
    'loans',
    // Phase 6: the payment ledger. Balances are derived in views rather than
    // stored, so there is no balance table here.
    'payment_allocations',
    // Phase 2: the capability vocabulary and the role-to-capability map.
    'permissions',
    'profiles',
    'reference_formats',
    'reference_sequences',
    'repayment_frequencies',
    'role_permissions',
    'roles',
    'user_roles',
  ];

  it('creates exactly the expected tables, and no more', () => {
    return query<{ relname: string }>(
      `select c.relname
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind = 'r'
        order by c.relname`,
    ).then((rows) => {
      expect(rows.map((row) => row.relname)).toEqual(EXPECTED_TABLES);
    });
  });

  it('gives every table a primary key', async () => {
    const rows = await query<{ relname: string }>(
      `select c.relname
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public'
          and c.relkind = 'r'
          and not exists (
            select 1 from pg_constraint k
             where k.conrelid = c.oid and k.contype = 'p'
          )`,
    );

    expect(rows.map((row) => row.relname)).toEqual([]);
  });

  it('stores every timestamp as timestamptz', async () => {
    // A bare `timestamp` carries no zone, which is how a repayment gets filed
    // against the wrong business day.
    const rows = await query<{ table_name: string; column_name: string }>(
      `select table_name, column_name
         from information_schema.columns
        where table_schema = 'public'
          and data_type = 'timestamp without time zone'`,
    );

    expect(rows).toEqual([]);
  });

  it('stores every money column as bigint', async () => {
    const rows = await query<{ column_name: string; data_type: string }>(
      `select column_name, data_type
         from information_schema.columns
        where table_schema = 'public'
          and column_name like '%amount%'`,
    );

    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.data_type, row.column_name).toBe('bigint');
    }
  });

  it('stores every rate column as an integer of basis points', async () => {
    const rows = await query<{ column_name: string; data_type: string }>(
      `select column_name, data_type
         from information_schema.columns
        where table_schema = 'public'
          and column_name like '%\\_bps'`,
    );

    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.data_type, row.column_name).toBe('integer');
    }
  });

  it('uses no floating-point or money type anywhere', async () => {
    const rows = await query<{
      table_name: string;
      column_name: string;
      data_type: string;
    }>(
      `select table_name, column_name, data_type
         from information_schema.columns
        where table_schema = 'public'
          and data_type in ('real', 'double precision', 'money', 'numeric')`,
    );

    expect(rows).toEqual([]);
  });
});

describeDb('foreign keys', () => {
  it('declares every expected relationship with the intended delete action', async () => {
    const rows = await query<{
      table_name: string;
      column_name: string;
      foreign_table: string;
      delete_action: string;
    }>(
      `select
           src.relname  as table_name,
           srcatt.attname as column_name,
           tgt.relname  as foreign_table,
           k.confdeltype as delete_action
         from pg_constraint k
         join pg_class src on src.oid = k.conrelid
         join pg_class tgt on tgt.oid = k.confrelid
         join pg_namespace n on n.oid = src.relnamespace
         join unnest(k.conkey) as col(attnum) on true
         join pg_attribute srcatt
              on srcatt.attrelid = src.oid and srcatt.attnum = col.attnum
        where k.contype = 'f' and n.nspname = 'public'
        order by src.relname, srcatt.attname`,
    );

    const describe_ = (row: (typeof rows)[number]) =>
      `${row.table_name}.${row.column_name} -> ${row.foreign_table} (${row.delete_action})`;

    const actual = rows.map(describe_);

    // 'r' = RESTRICT, 'a' = NO ACTION, 'c' = CASCADE, 'n' = SET NULL.
    //
    // RESTRICT throughout, because this is a financial system: a person's
    // record is referenced by loans and payments, and deleting it would
    // corrupt the books. Archiving replaces deletion.
    expect(actual).toEqual([
      'audit_log.actor_profile_id -> profiles (r)',
      'business_settings.default_repayment_frequency -> repayment_frequencies (r)',
      'business_settings.updated_by -> profiles (r)',
      // Phase 3. `c` cascades: a client's identity row, remarks and guarantor
      // associations are parts of that client, not independent records.
      // `r` restricts: a guarantor with an association cannot be removed, and
      // neither can the profile that authored a remark — attribution is
      // evidence. `n` nulls: provenance degrades gracefully, because `created_by`
      // naming a deleted account is less useful than NULL and the audit trail
      // holds the authoritative record either way.
      'client_guarantors.client_id -> clients (c)',
      'client_guarantors.created_by -> profiles (n)',
      'client_guarantors.detached_by -> profiles (n)',
      'client_guarantors.guarantor_id -> guarantors (r)',
      'client_identities.client_id -> clients (c)',
      'client_remarks.client_id -> clients (c)',
      'client_remarks.created_by -> profiles (r)',
      'client_remarks.retracts_remark_id -> client_remarks (r)',
      'clients.created_by -> profiles (n)',
      'clients.profile_id -> profiles (r)',
      'clients.status_changed_by -> profiles (n)',
      'company_settings.updated_by -> profiles (r)',
      'guarantor_identities.guarantor_id -> guarantors (c)',
      'guarantors.created_by -> profiles (n)',
      // Phase 4. `c` cascades: a loan's breakdown and snapshots are parts of
      // that loan. `r` restricts: the client and the guarantors a loan was
      // issued against cannot be removed while it references them, because
      // the snapshot holds the details and the reference is what lets somebody
      // follow it back. `n` nulls: lifecycle attribution degrades gracefully,
      // and the audit trail holds the authoritative record either way.
      'loan_client_snapshots.client_id -> clients (r)',
      'loan_client_snapshots.loan_id -> loans (c)',
      'loan_guarantor_snapshots.guarantor_id -> guarantors (r)',
      'loan_guarantor_snapshots.loan_id -> loans (c)',
      'loan_identity_snapshots.loan_id -> loans (c)',
      // Phase 5. `c` cascades for the same reason: a collection schedule is
      // part of its loan, and an installment is part of the contractual month
      // it collects. `r` restricts on the frequency, so a cadence cannot be
      // deleted out from under a schedule that names it — and migration
      // 20261005000200 refuses the delete outright, referenced or not.
      // `r` on `generated_by`, not `n`: the schedule names who released the
      // money, and that attribution is evidence rather than provenance.
      'loan_installments.loan_id -> loans (c)',
      'loan_installments.loan_period_id -> loan_periods (c)',
      // Phase 6. `r` restricts everywhere on the ledger, with no `c` and no
      // `n`: a payment is financial evidence, so nothing it references may be
      // deleted out from under it and no attribution may be degraded to NULL.
      'loan_payments.client_id -> clients (r)',
      'loan_payments.loan_id -> loans (r)',
      'loan_payments.recorded_by -> profiles (r)',
      'loan_payments.reversed_by -> profiles (r)',
      'loan_periods.loan_id -> loans (c)',
      'loan_schedules.generated_by -> profiles (r)',
      'loan_schedules.loan_id -> loans (c)',
      'loan_schedules.repayment_frequency -> repayment_frequencies (r)',
      'loans.approved_by -> profiles (n)',
      'loans.cancelled_by -> profiles (n)',
      // Phase 6. `r`, not `n`: the loan says who settled it, and that
      // attribution is evidence rather than provenance.
      'loans.cleared_by -> profiles (r)',
      'loans.client_id -> clients (r)',
      'loans.created_by -> profiles (n)',
      'loans.disbursed_by -> profiles (n)',
      'loans.repayment_frequency -> repayment_frequencies (r)',
      'loans.submitted_by -> profiles (n)',
      // Phase 6. `r` restricts everywhere, with no `c` and no `n`: a payment
      // is financial evidence, so nothing it references may be deleted out
      // from under it and no attribution may be degraded to NULL. That is
      // stricter than the loan's own lifecycle columns, which null gracefully
      // because the audit trail holds the authoritative record — a payment's
      // actor is on the receipt a borrower is holding.
      'payment_allocations.installment_id -> loan_installments (r)',
      'payment_allocations.loan_id -> loans (r)',
      'payment_allocations.payment_id -> loan_payments (r)',
      'profiles.auth_user_id -> users (r)',
      'reference_sequences.scope -> reference_formats (r)',
      // Phase 2. RESTRICT here too: a capability cannot be deleted out from
      // under a role that grants it, and a role cannot vanish while granting
      // capabilities.
      'role_permissions.permission_key -> permissions (r)',
      'role_permissions.role_key -> roles (r)',
      'user_roles.granted_by -> profiles (r)',
      'user_roles.profile_id -> profiles (r)',
      'user_roles.role_key -> roles (r)',
    ]);
  });

  it('links profiles to auth.users, not to a duplicated user table', async () => {
    const row = await queryOne<{ foreign_schema: string; foreign_table: string }>(
      `select n.nspname as foreign_schema, tgt.relname as foreign_table
         from pg_constraint k
         join pg_class src on src.oid = k.conrelid
         join pg_class tgt on tgt.oid = k.confrelid
         join pg_namespace n on n.oid = tgt.relnamespace
        where k.contype = 'f'
          and src.relname = 'profiles'`,
    );

    expect(row.foreign_schema).toBe('auth');
    expect(row.foreign_table).toBe('users');
  });

  it('stores no credential value, since Supabase Auth owns them', async () => {
    // Phase 2 adds `must_change_password` (boolean) and `password_set_at`
    // (timestamptz), which are account metadata rather than credentials.
    // Matching on the type as well as the name keeps the check sharp: a
    // credential would have to be stored as text or bytea, so anything of
    // that shape with a credential-like name is a real finding.
    const rows = await query<{
      table_name: string;
      column_name: string;
      data_type: string;
    }>(
      `select table_name, column_name, data_type
         from information_schema.columns
        where table_schema = 'public'
          and data_type in ('text', 'character varying', 'character', 'bytea')
          and (
            column_name like '%password%'
            or column_name like '%secret%'
            or column_name like '%token%'
            or column_name like '%credential%'
            or column_name like '%hash%'
          )`,
    );

    expect(rows).toEqual([]);
  });

  it('stores the password-related columns only as metadata, never as values', async () => {
    const rows = await query<{ column_name: string; data_type: string }>(
      `select column_name, data_type
         from information_schema.columns
        where table_schema = 'public'
          and column_name like '%password%'
        order by column_name`,
    );

    expect(rows).toEqual([
      { column_name: 'must_change_password', data_type: 'boolean' },
      { column_name: 'password_set_at', data_type: 'timestamp with time zone' },
    ]);
  });
});

describeDb('profiles constraints', () => {
  it('makes auth_user_id optional but unique', async () => {
    const column = await queryOne<{ is_nullable: string }>(
      `select is_nullable
         from information_schema.columns
        where table_schema = 'public'
          and table_name = 'profiles'
          and column_name = 'auth_user_id'`,
    );

    // Nullable, because staff register clients who have no portal login.
    expect(column.is_nullable).toBe('YES');

    const unique = await query(
      `select 1
         from pg_constraint k
         join pg_class c on c.oid = k.conrelid
        where c.relname = 'profiles'
          and k.contype = 'u'
          and pg_get_constraintdef(k.oid) like '%auth_user_id%'`,
    );

    expect(unique.length).toBe(1);
  });

  it('permits several profiles with no auth account', async () => {
    // A unique constraint treats NULLs as distinct, which is exactly what is
    // needed here — otherwise only one unlinked client could ever exist.
    const rows = await query<{ count: string }>(
      `with inserted as (
         insert into public.profiles (full_name, phone)
         values ('Test One', '+256700000001'), ('Test Two', '+256700000002')
         returning id
       )
       select count(*)::text as count from inserted`,
    );

    expect(rows[0]?.count).toBe('2');

    await query(`delete from public.profiles where phone in ($1, $2)`, [
      '+256700000001',
      '+256700000002',
    ]);
  });

  it('enforces the same phone format the application validates', async () => {
    const constraint = await queryOne<{ definition: string }>(
      `select pg_get_constraintdef(k.oid) as definition
         from pg_constraint k
         join pg_class c on c.oid = k.conrelid
        where c.relname = 'profiles' and k.conname = 'profiles_phone_e164'`,
    );

    expect(constraint.definition).toContain('+256');
  });

  it('constrains status to exactly the application vocabulary', async () => {
    const constraint = await queryOne<{ definition: string }>(
      `select pg_get_constraintdef(k.oid) as definition
         from pg_constraint k
         join pg_class c on c.oid = k.conrelid
        where c.relname = 'profiles' and k.conname = 'profiles_status_valid'`,
    );

    for (const status of PROFILE_STATUSES) {
      expect(constraint.definition, status).toContain(status);
    }
  });

  it('requires full_name and phone', async () => {
    const rows = await query<{ column_name: string }>(
      `select column_name
         from information_schema.columns
        where table_schema = 'public'
          and table_name = 'profiles'
          and is_nullable = 'NO'
        order by column_name`,
    );

    const required = rows.map((row) => row.column_name);
    expect(required).toContain('full_name');
    expect(required).toContain('phone');
    expect(required).toContain('status');
    expect(required).toContain('created_at');
    expect(required).toContain('updated_at');
  });
});

describeDb('seeded reference data matches the application constants', () => {
  it('seeds exactly the roles the application knows about', async () => {
    const rows = await query<{
      key: string;
      rank: number;
      is_staff: boolean;
      label: string;
    }>(`select key, rank, is_staff, label from public.roles order by rank`);

    // A role added in SQL without updating lib/permissions/roles.ts — or the
    // reverse — fails here rather than at runtime.
    expect(rows.map((row) => row.key)).toEqual([...ROLE_KEYS]);

    for (const row of rows) {
      const definition = ROLES[row.key as keyof typeof ROLES];
      expect(definition, row.key).toBeDefined();
      expect(row.rank, `${row.key} rank`).toBe(definition.rank);
      expect(row.is_staff, `${row.key} is_staff`).toBe(definition.isStaff);
      expect(row.label, `${row.key} label`).toBe(definition.label);
    }
  });

  it('seeds the three repayment cadences', async () => {
    const rows = await query<{ key: string; interval_days: number; is_active: boolean }>(
      `select key, interval_days, is_active
         from public.repayment_frequencies
        order by sort_order`,
    );

    expect(rows.map((row) => row.key)).toEqual(
      REPAYMENT_FREQUENCY_DEFAULTS.map((entry) => entry.key),
    );
    expect(rows.map((row) => row.interval_days)).toEqual(
      REPAYMENT_FREQUENCY_DEFAULTS.map((entry) => entry.intervalDays),
    );
    expect(rows.every((row) => row.is_active)).toBe(true);
  });

  it('seeds reference formats matching the application defaults', async () => {
    const rows = await query<{ scope: string; prefix: string; padding: number }>(
      `select scope, prefix, padding from public.reference_formats order by scope`,
    );

    expect(rows.map((row) => row.scope).sort()).toEqual([...REFERENCE_SCOPES].sort());

    for (const row of rows) {
      const expected =
        REFERENCE_FORMAT_DEFAULTS[row.scope as keyof typeof REFERENCE_FORMAT_DEFAULTS];
      expect(row.prefix, `${row.scope} prefix`).toBe(expected.prefix);
      expect(row.padding, `${row.scope} padding`).toBe(expected.padding);
    }
  });

  it('seeds the business rules the business confirmed', async () => {
    const row = await queryOne<{
      min_loan_amount: string;
      max_loan_amount: string;
      default_monthly_interest_rate_bps: number;
      min_loan_term_months: number;
      max_loan_term_months: number;
      grace_period_days: number;
      penalty_rate_bps: number;
      max_active_loans_per_client: number;
      default_repayment_frequency: string;
    }>(`select * from public.business_settings where id = 1`);

    // bigint arrives as a string from the pg driver.
    expect(Number(row.min_loan_amount)).toBe(BUSINESS_DEFAULTS.minLoanAmount);
    expect(Number(row.max_loan_amount)).toBe(BUSINESS_DEFAULTS.maxLoanAmount);
    expect(row.default_monthly_interest_rate_bps).toBe(
      BUSINESS_DEFAULTS.defaultMonthlyInterestRateBps,
    );
    expect(row.min_loan_term_months).toBe(BUSINESS_DEFAULTS.minLoanTermMonths);
    expect(row.max_loan_term_months).toBe(BUSINESS_DEFAULTS.maxLoanTermMonths);
    expect(row.grace_period_days).toBe(BUSINESS_DEFAULTS.gracePeriodDays);
    expect(row.penalty_rate_bps).toBe(BUSINESS_DEFAULTS.penaltyRateBps);
    expect(row.max_active_loans_per_client).toBe(
      BUSINESS_DEFAULTS.maxActiveLoansPerClient,
    );
    expect(row.default_repayment_frequency).toBe(
      BUSINESS_DEFAULTS.defaultRepaymentFrequency,
    );
  });

  it('seeds the temporary company name and leaves registration fields empty', async () => {
    const row = await queryOne<{
      company_name: string;
      legal_name: string | null;
      registration_number: string | null;
      tax_identification_number: string | null;
      currency_code: string;
      timezone: string;
      locale: string;
    }>(`select * from public.company_settings where id = 1`);

    expect(row.company_name).toBe('Money Lending Management System');
    // Company registration is still in progress, so these have no value yet.
    expect(row.legal_name).toBeNull();
    expect(row.registration_number).toBeNull();
    expect(row.tax_identification_number).toBeNull();

    expect(row.currency_code).toBe('UGX');
    expect(row.timezone).toBe('Africa/Kampala');
    expect(row.locale).toBe('en-UG');
  });

  it('seeds no people and no financial history', async () => {
    // Nothing that could be mistaken for production data.
    //
    // The audit trail is deliberately not counted here. It is append-only by
    // design, so entries other test files generate cannot be cleared between
    // them — asserting it were empty would make this test depend on execution
    // order rather than on the seed. That the seed writes no audit records is
    // asserted instead from the migration SQL, in
    // tests/integration/migrations.test.ts.
    // Fixtures from other files in this suite are excluded by their reserved
    // +2567000 phone prefix, so this asserts what the SEED does rather than
    // depending on which test ran last.
    const row = await queryOne<{ profiles: string; assignments: string }>(
      `select
         (select count(*) from public.profiles
           where phone not like '+2567000%')::text as profiles,
         (select count(*) from public.user_roles ur
           join public.profiles p on p.id = ur.profile_id
          where p.phone not like '+2567000%')::text as assignments`,
    );

    expect(row.profiles).toBe('0');
    expect(row.assignments).toBe('0');
  });

  it('seeds no audit record of its own', async () => {
    // Every audit row in a freshly seeded database would have to come from the
    // seed itself. Scoped to the settings and role actions the seed could
    // plausibly produce, so test fixtures elsewhere do not affect it.
    const row = await queryOne<{ count: string }>(
      `select count(*)::text as count from public.audit_log
        where action in ('settings.updated', 'user.role_granted')`,
    );

    expect(row.count).toBe('0');
  });
});
