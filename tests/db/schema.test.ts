import { afterAll, describe, expect, inject, it } from 'vitest';

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
    // Phase 11: the four ways money moves that are not a loan. Each is a
    // document that points at the journal it wrote; none of them can exist
    // without one.
    'account_reconciliations',
    'account_transfers',
    'audit_log',
    // Phase 10: the branch network and the double-entry ledger.
    'branches',
    'business_settings',
    // Phase 3: the lending-business customer record, its sensitive half, the
    // guarantors who vouch for them, the association between the two, and the
    // append-only staff commentary.
    'client_guarantors',
    'client_identities',
    'client_remarks',
    'clients',
    'company_settings',
    'expenses',
    // Phase 11: approval thresholds, the overdraft rule and the low-float
    // levels. Separate from `business_settings`, which is about lending.
    'finance_settings',
    // Phase 13: the versioned undertaking a guarantor signs. A new version is
    // appended; one in force is never reworded, because a signature points
    // at words.
    'guarantor_consent_terms',
    'guarantor_identities',
    'guarantors',
    // Phase 10: the double-entry ledger. The header carries the branch, the
    // date and what caused the posting; the lines carry the two sides.
    'journal_entries',
    'journal_lines',
    'ledger_accounts',
    // Phase 13: the product-specific answers an application gives, and the
    // guarantors of a particular loan with the undertaking each one signed.
    'loan_business_details',
    // Phase 4: the loan agreement, its contractual monthly breakdown, and the
    // three snapshots that make it evidence rather than a view over today's
    // records.
    'loan_client_snapshots',
    // Phase 14: the security a loan is written against, and the recovery
    // effort recorded when it goes bad.
    'loan_collateral',
    // Phase 13: the evidence filed with an application — payslips, employment
    // letters, trading licences, a guarantor's identification or signature.
    'loan_documents',
    'loan_guarantor_snapshots',
    'loan_guarantors',
    'loan_identity_snapshots',
    // Phase 5: the collection plan — one generation record per loan, and the
    // scheduled collections that allocate the contractual breakdown.
    'loan_installments',
    'loan_payments',
    // Phase 7: the one-time expiry penalty. Arrears are *not* here — they are
    // derived from the schedule, the ledger and the date, so there is no
    // delinquency table for anybody to edit a borrower into or out of.
    'loan_penalties',
    'loan_periods',
    // Phase 12: what the business sells, where it sells it, and the terms a
    // loan was actually agreed under.
    'loan_product_branches',
    'loan_product_snapshots',
    'loan_products',
    'loan_recovery_actions',
    'loan_salary_details',
    'loan_schedules',
    'loans',
    // Phase 11: fees and income that is not interest or a penalty. Those two
    // are written by the lending functions and refused here.
    'other_income',
    // Phase 6: the payment ledger. Balances are derived in views rather than
    // stored, so there is no balance table here.
    'payment_allocations',
    // Phase 2: the capability vocabulary and the role-to-capability map.
    'permissions',
    'profiles',
    // Phase 9: fixed-window rate limit counters. Readable by nobody and
    // reached only through `consume_rate_limit`; the key is a hash, so the
    // table carries no identity.
    'rate_limit_counters',
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
      // Phase 11. The four money-movement documents. RESTRICT on everything
      // a posting or a balance depends on — a branch, an account, a journal
      // entry, a client or a loan a fee was charged against cannot be
      // removed while a document names it. `n` on provenance, as everywhere
      // else: an account that no longer exists is less useful than NULL, and
      // the label column keeps the name the document was recorded under.
      'account_reconciliations.account_id -> ledger_accounts (r)',
      'account_reconciliations.adjustment_entry_id -> journal_entries (r)',
      'account_reconciliations.branch_id -> branches (r)',
      'account_reconciliations.performed_by -> profiles (n)',
      'account_reconciliations.reviewed_by -> profiles (n)',
      'account_transfers.approved_by -> profiles (n)',
      'account_transfers.branch_id -> branches (r)',
      'account_transfers.from_account_id -> ledger_accounts (r)',
      'account_transfers.initiated_by -> profiles (n)',
      'account_transfers.journal_entry_id -> journal_entries (r)',
      'account_transfers.reversal_entry_id -> journal_entries (r)',
      'account_transfers.reversed_by -> profiles (n)',
      'account_transfers.to_account_id -> ledger_accounts (r)',
      'audit_log.actor_profile_id -> profiles (r)',
      // Phase 10. The branch network and the ledger. RESTRICT throughout on
      // anything a posting points at — a branch, an account, a loan or a
      // client that has been posted against cannot be removed, because the
      // journal referring to it is evidence. `c` on a journal line, because
      // a line is part of its entry and has no meaning without it; `n` on
      // provenance, as everywhere else.
      'branches.created_by -> profiles (n)',
      'branches.manager_profile_id -> profiles (n)',
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
      // Phase 10. A branch that has clients or loans cannot be removed.
      'clients.branch_id -> branches (r)',
      'clients.created_by -> profiles (n)',
      'clients.profile_id -> profiles (r)',
      'clients.status_changed_by -> profiles (n)',
      'company_settings.updated_by -> profiles (r)',
      'expenses.approved_by -> profiles (n)',
      'expenses.branch_id -> branches (r)',
      'expenses.expense_account_id -> ledger_accounts (r)',
      'expenses.journal_entry_id -> journal_entries (r)',
      'expenses.payment_account_id -> ledger_accounts (r)',
      'expenses.recorded_by -> profiles (n)',
      'expenses.reversal_entry_id -> journal_entries (r)',
      'expenses.reversed_by -> profiles (n)',
      'finance_settings.updated_by -> profiles (n)',
      'guarantor_consent_terms.created_by -> profiles (n)',
      'guarantor_identities.guarantor_id -> guarantors (c)',
      'guarantors.created_by -> profiles (n)',
      'journal_entries.branch_id -> branches (r)',
      'journal_entries.client_id -> clients (r)',
      'journal_entries.created_by -> profiles (n)',
      'journal_entries.loan_id -> loans (r)',
      'journal_entries.reversed_by_entry_id -> journal_entries (r)',
      'journal_lines.account_id -> ledger_accounts (r)',
      'journal_lines.entry_id -> journal_entries (c)',
      'ledger_accounts.branch_id -> branches (r)',
      'ledger_accounts.parent_id -> ledger_accounts (r)',
      // Phase 13. The application's own answers and its own guarantors, all
      // `r` on the loan and on the people they name: an application is the
      // evidence a decision was made on, so nothing it points at may be
      // deleted from under it. `n` only on `created_by`, which is
      // attribution rather than substance.
      'loan_business_details.created_by -> profiles (n)',
      'loan_business_details.loan_id -> loans (r)',
      // Phase 4. `c` cascades: a loan's breakdown and snapshots are parts of
      // that loan. `r` restricts: the client and the guarantors a loan was
      // issued against cannot be removed while it references them, because
      // the snapshot holds the details and the reference is what lets somebody
      // follow it back. `n` nulls: lifecycle attribution degrades gracefully,
      // and the audit trail holds the authoritative record either way.
      'loan_client_snapshots.client_id -> clients (r)',
      'loan_client_snapshots.loan_id -> loans (c)',
      // Phase 14. `r` on the loan: a pledged item is evidence of what the
      // business agreed to lend against, so the loan cannot be deleted out
      // from under it. `n` on the three actors, because provenance that has
      // been archived should degrade to "unknown" rather than make an account
      // undeletable — the item's own history is in the status and the dates.
      'loan_collateral.created_by -> profiles (n)',
      'loan_collateral.loan_id -> loans (r)',
      'loan_collateral.realised_by -> profiles (n)',
      'loan_collateral.released_by -> profiles (n)',
      // Phase 13. `r` on both: a document is evidence, so the loan it was
      // filed against and the guarantor it belongs to cannot be deleted out
      // from under it.
      'loan_documents.created_by -> profiles (n)',
      'loan_documents.loan_guarantor_id -> loan_guarantors (r)',
      'loan_documents.loan_id -> loans (r)',
      // Phase 13. `r`, never `n`: SET NULL on an append-only table is
      // implemented as an UPDATE, and the guard here is statement-level, so
      // a SET NULL reference would make deleting any client fail.
      'loan_guarantor_snapshots.consent_terms_id -> guarantor_consent_terms (r)',
      'loan_guarantor_snapshots.guarantor_id -> guarantors (r)',
      'loan_guarantor_snapshots.loan_id -> loans (c)',
      'loan_guarantor_snapshots.subject_client_id -> clients (r)',
      'loan_guarantors.consent_terms_id -> guarantor_consent_terms (r)',
      'loan_guarantors.created_by -> profiles (n)',
      'loan_guarantors.guarantor_client_id -> clients (r)',
      'loan_guarantors.guarantor_id -> guarantors (r)',
      'loan_guarantors.loan_id -> loans (r)',
      // Phase 14. `n`, like the other actor columns on this table: a release
      // keeps its reason and its date whatever becomes of the account that
      // made it.
      'loan_guarantors.released_by -> profiles (n)',
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
      // Phase 7. A penalty cascades with its loan, because a loan deleted
      // outright takes its whole financial history with it; its client is
      // RESTRICT, as the payment's is, because a charge must keep naming the
      // person it was charged to.
      'loan_penalties.client_id -> clients (r)',
      'loan_penalties.loan_id -> loans (c)',
      'loan_periods.loan_id -> loans (c)',
      // Phase 12. `c` on the branch join table, because a row there is part
      // of the product rather than a record of its own; `r` everywhere else,
      // including the snapshot's loan — a loan whose terms were frozen is
      // evidence of an agreement.
      'loan_product_branches.branch_id -> branches (r)',
      'loan_product_branches.product_id -> loan_products (c)',
      'loan_product_snapshots.loan_id -> loans (r)',
      'loan_product_snapshots.overridden_by -> profiles (n)',
      'loan_product_snapshots.product_id -> loan_products (r)',
      'loan_products.created_by -> profiles (n)',
      'loan_products.default_repayment_frequency -> repayment_frequencies (r)',
      'loan_products.updated_by -> profiles (n)',
      // Phase 14. `r` throughout, and `r` on `created_by` specifically — the
      // same reasoning `client_remarks` records: SET NULL is implemented as an
      // UPDATE, which this append-only table refuses outright, so a `n`
      // reference would make deleting any profile fail with a confusing
      // error. `created_by_label` keeps the author readable after the account
      // is archived.
      'loan_recovery_actions.corrects_action_id -> loan_recovery_actions (r)',
      'loan_recovery_actions.created_by -> profiles (r)',
      'loan_recovery_actions.loan_id -> loans (r)',
      'loan_salary_details.created_by -> profiles (n)',
      'loan_salary_details.loan_id -> loans (r)',
      'loan_schedules.generated_by -> profiles (r)',
      'loan_schedules.loan_id -> loans (c)',
      'loan_schedules.repayment_frequency -> repayment_frequencies (r)',
      'loans.approved_by -> profiles (n)',
      'loans.branch_id -> branches (r)',
      'loans.cancelled_by -> profiles (n)',
      // Phase 6. `r`, not `n`: the loan says who settled it, and that
      // attribution is evidence rather than provenance.
      'loans.cleared_by -> profiles (r)',
      'loans.client_id -> clients (r)',
      'loans.created_by -> profiles (n)',
      'loans.disbursed_by -> profiles (n)',
      'loans.loan_product_id -> loan_products (r)',
      'loans.repayment_frequency -> repayment_frequencies (r)',
      'loans.submitted_by -> profiles (n)',
      // Phase 6. `r` restricts everywhere, with no `c` and no `n`: a payment
      // is financial evidence, so nothing it references may be deleted out
      // from under it and no attribution may be degraded to NULL. That is
      // stricter than the loan's own lifecycle columns, which null gracefully
      // because the audit trail holds the authoritative record — a payment's
      // actor is on the receipt a borrower is holding.
      'other_income.branch_id -> branches (r)',
      'other_income.client_id -> clients (r)',
      'other_income.income_account_id -> ledger_accounts (r)',
      'other_income.journal_entry_id -> journal_entries (r)',
      'other_income.loan_id -> loans (r)',
      'other_income.receiving_account_id -> ledger_accounts (r)',
      'other_income.recorded_by -> profiles (n)',
      'other_income.reversal_entry_id -> journal_entries (r)',
      'other_income.reversed_by -> profiles (n)',
      'payment_allocations.installment_id -> loan_installments (r)',
      'payment_allocations.loan_id -> loans (r)',
      'payment_allocations.payment_id -> loan_payments (r)',
      'payment_allocations.penalty_id -> loan_penalties (r)',
      'profiles.auth_user_id -> users (r)',
      // Phase 11. RESTRICT: a branch with staff assigned to it cannot be
      // removed while they are. NULL on the column means unrestricted
      // rather than unassigned — an Owner belongs to the company.
      'profiles.branch_id -> branches (r)',
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
    // Named by constraint rather than by "the only foreign key on profiles":
    // Phase 11 added `branch_id`, and the claim being made here was never
    // about how many relationships the table has. It is that the *identity*
    // link points at Supabase Auth.
    const row = await queryOne<{ foreign_schema: string; foreign_table: string }>(
      `select n.nspname as foreign_schema, tgt.relname as foreign_table
         from pg_constraint k
         join pg_class src on src.oid = k.conrelid
         join pg_class tgt on tgt.oid = k.confrelid
         join pg_namespace n on n.oid = tgt.relnamespace
        where k.contype = 'f'
          and src.relname = 'profiles'
          and k.conname = 'profiles_auth_user_id_fkey'`,
    );

    expect(row.foreign_schema).toBe('auth');
    expect(row.foreign_table).toBe('users');

    // And there is still no second person table anywhere for a profile to
    // point at, which is the half of the claim the column name does not
    // carry on its own.
    const duplicates = await query<{ relname: string }>(
      `select c.relname
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind = 'r'
          and c.relname in ('users', 'accounts', 'auth_users')`,
    );
    expect(duplicates).toEqual([]);
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

    // Phase 12. The placeholder is gone: the client's registration completed
    // and migration 20261012000100 wrote the real identity.
    expect(row.company_name).toBe('Polytos Financial Services Ltd');
    expect(row.legal_name).toBe('Polytos Financial Services Limited');
    // Registration and tax numbers are still not held. They are not needed
    // to lend, and they are the two fields the public identity view most
    // carefully leaves out, so an empty value is the honest one.
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
    // Every audit row written before any test ran came from the migrations
    // and the seed, because nothing else had run yet. `seedAuditBoundary` is
    // the highest audit id at that moment, published by the global setup
    // immediately after it rebuilds the database.
    //
    // The bound is what makes this assertion mean what it says. Counting the
    // whole table instead made the result depend on file order:
    // `createTestUser` grants a role, which writes `user.role_granted`, so
    // whether this passed came down to whether another file's fixtures had
    // been torn down yet. The claim was never about those rows.
    const boundary = inject('seedAuditBoundary');

    const rows = await query<{
      action: string;
      entity_type: string;
      actor_label: string;
    }>(
      `select action, entity_type, actor_label from public.audit_log
        where id <= $1 and action in ('settings.updated', 'user.role_granted')
        order by id`,
      [boundary],
    );

    // No role was granted to anybody by the seed. That half is absolute: a
    // migration that quietly granted a role would be a migration that
    // quietly created an administrator.
    expect(rows.filter((row) => row.action === 'user.role_granted')).toEqual([]);

    // Exactly one settings change, and it is the one Phase 12 made on
    // purpose: migration 20261012000100 replaced the placeholder company
    // name with the client's real identity. That row *belongs* in the trail
    // — the company's own name changing is precisely what an audit log is
    // for — and suppressing it to keep this assertion at zero would have
    // been hiding a real change to make a test easier.
    expect(
      rows
        .filter((row) => row.action === 'settings.updated')
        .map((row) => `${row.entity_type}:${row.actor_label}`),
    ).toEqual(['company_settings:system']);
  });
});

describeDb('embedded relationships PostgREST has to resolve', () => {
  /**
   * PostgREST resolves an embed like `profiles -> user_roles(role_key)` from
   * the foreign keys between the two tables. Where there is more than one it
   * refuses the request (PGRST201) instead of choosing, so the application has
   * to name the key it means.
   *
   * This asserts the ambiguity is real. `lib/data/users.ts` carries the hint
   * `user_roles!user_roles_profile_id_fkey`, and a test that the hint is
   * present proves nothing unless the thing it disambiguates exists — if a
   * later migration dropped `granted_by`, this would fail and the hint could
   * be reconsidered rather than silently kept as cargo.
   */
  it('user_roles reaches profiles twice, so the directory must name its key', async () => {
    const rows = await query<{ constraint_name: string }>(
      `select c.conname as constraint_name
         from pg_catalog.pg_constraint c
         join pg_catalog.pg_class child on child.oid = c.conrelid
         join pg_catalog.pg_class parent on parent.oid = c.confrelid
        where c.contype = 'f'
          and child.relname = 'user_roles'
          and parent.relname = 'profiles'
        order by c.conname`,
    );

    expect(rows.map((row) => row.constraint_name)).toEqual([
      'user_roles_granted_by_fkey',
      'user_roles_profile_id_fkey',
    ]);
  });
});
