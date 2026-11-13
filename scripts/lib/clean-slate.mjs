/**
 * The clean slate: empty the books, keep the system.
 *
 * The business is launching on a database that holds demonstration records —
 * loans, repayments, journals, memberships, savings, clients and the staff
 * profiles that acted on them. The Product Owner has classified all of it as
 * test data. This module removes it and leaves a database that is empty of
 * business history but otherwise identical: every table, migration, function,
 * trigger, policy, grant and piece of reference data still in place.
 *
 * ## Why it is written this way
 *
 * There are 80 tables in `public` and 57 of them reference `profiles`, so a
 * hand-written delete order would be wrong the first time somebody added a
 * table. Instead every table is classified into exactly one bucket, and the
 * procedure REFUSES TO RUN if a table in the database is not classified at
 * all. A table added by a later migration therefore stops the cleanup with a
 * name to look at, rather than being silently emptied or silently skipped —
 * the two failure modes that matter when the thing you are deleting is
 * somebody's financial history.
 *
 * ## The buckets
 *
 * `TRUNCATE_TABLES`  business and transactional rows. Emptied together in one
 *                    `TRUNCATE`, which satisfies the foreign keys between
 *                    them without `CASCADE` — and `CASCADE` is deliberately
 *                    not used, because it would reach tables nobody listed.
 *
 * `PRESERVE_WHOLE`   reference data and configuration the application cannot
 *                    run without: the permission matrix, the cadences, the
 *                    reference formats, the chart of accounts, the branch, the
 *                    product catalogue, the consent terms, the settings
 *                    singletons.
 *
 * `PRESERVE_PARTIAL` rows that are kept selectively, each with the predicate
 *                    that decides: the Owner's profile and role assignment,
 *                    and the membership policy versions the business wrote
 *                    (the DEMONSTRATION ONLY one goes).
 *
 * `RESET_SEQUENCES`  counters that must start again, so the first real client
 *                    is CL26001 rather than CL26029.
 *
 * ## What it does not do
 *
 * It does not drop or alter a single schema object, it does not touch
 * `auth.users` rows it was not told about, and it runs in one transaction so
 * a failure anywhere leaves the database exactly as it was.
 */

/** Reference data and configuration. Nothing here is deleted. */
export const PRESERVE_WHOLE = [
  // The permission matrix. Migration-managed; no application role may write it.
  'roles',
  'permissions',
  'role_permissions',
  // What the business offers and how it refers to things.
  'repayment_frequencies',
  'reference_formats',
  'loan_products',
  'loan_product_branches',
  'guarantor_consent_terms',
  'benefit_document_kinds',
  // Where the business operates, and its books' structure.
  'branches',
  'ledger_accounts',
  // The three settings singletons.
  'company_settings',
  'business_settings',
  'finance_settings',
  // The reference counters. The table and its rows are kept — one row per
  // scope, which the application reads to issue the next number — and the
  // values are reset in place by RESET_SEQUENCES below. Deleting the rows
  // would leave nothing to increment.
  'reference_sequences',
  // Published policy versions, which cannot be deleted either:
  // `20261019000200` rejects DELETE at statement level, because a savings
  // account is frozen to the version it was opened under and removing one
  // would silently re-price history. UPDATE is permitted, and the guard in
  // that migration allows the one-way step `active` -> `superseded` without
  // touching a contractual column, so a demonstration version CAN be retired
  // rather than removed. This procedure deliberately does not do it: an
  // approved policy is a business instrument, and retiring one is an
  // explicitly authorised act, not a side effect of emptying the books. It is
  // reported instead — see DEMONSTRATION_POLICY_MATCH and describeResidue —
  // and carried out as launch item A-1.
  'membership_policy_versions',
  // The audit log, which CANNOT be emptied and is not asked to be.
  //
  // `20261001000600_audit_log` puts statement-level triggers on UPDATE,
  // DELETE and TRUNCATE, all three raising P0001. An audit trail you can
  // erase is not an audit trail, and a cleanup script able to erase one is
  // exactly the capability an attacker would want, so this procedure does not
  // disable those triggers — it works around them.
  //
  // The consequence reaches further than the table. `audit_log
  // .actor_profile_id` references `profiles` ON DELETE RESTRICT, and
  // `profiles.auth_user_id` references `auth.users` the same way. So a
  // demonstration staff profile that ever acted cannot be deleted, and
  // neither can the Auth user behind it. They are neutralised instead — see
  // NEUTRALISE_PROFILES — which removes every ability they had without
  // breaking the trail that records what they did.
  //
  // A genuinely empty audit log therefore needs a database that never held
  // the demonstration activity: a fresh Supabase project, which costs nothing
  // on the free plan. That is a Product Owner decision, not something a
  // cleanup script should take.
  'audit_log',
];

/**
 * Kept selectively. Each entry says what survives and why.
 *
 * `keep` is a SQL predicate evaluated against the table; everything else in
 * that table is deleted.
 */
export const PRESERVE_PARTIAL = [
  {
    table: 'user_roles',
    keep: 'profile_id = $OWNER$',
    why: "Only the Owner's assignment survives, so no other profile holds a capability.",
  },
];

/**
 * How a demonstration policy version is recognised, for reporting.
 *
 * This procedure does NOT retire it, and that is deliberate.
 * `20261019000200` rejects DELETE on this table outright — a savings account
 * is frozen to the version it was opened under, so removing one would
 * silently re-price history — and its update guard freezes an approved
 * version's columns as well. Whether a given approved row can be moved back
 * to `draft` depends on that guard, and a cleanup script is the wrong place
 * to find out by trying.
 *
 * So it is reported rather than changed. Retiring the demonstration policy is
 * launch-configuration item A-1 in docs/POLYTOS-V1-LAUNCH-CONFIGURATION.md,
 * and it is one of the reasons a fresh Supabase project is the cleaner route
 * to a client launch — on the free plan that costs nothing and it starts with
 * no demonstration history at all.
 */
export const DEMONSTRATION_POLICY_MATCH = "title ilike '%DEMONSTRATION ONLY%'";

/**
 * Business and transactional rows. Emptied.
 *
 * Grouped only for reading; they are truncated in a single statement.
 */
export const TRUNCATE_TABLES = [
  // --- lending -----------------------------------------------------------
  'loans',
  'loan_schedules',
  'loan_installments',
  'loan_installment_carry_forwards',
  'loan_periods',
  'loan_payments',
  'payment_allocations',
  'loan_penalties',
  'loan_guarantors',
  'loan_collateral',
  'loan_documents',
  'loan_recovery_actions',
  'loan_business_details',
  'loan_salary_details',
  'loan_client_snapshots',
  'loan_guarantor_snapshots',
  'loan_identity_snapshots',
  'loan_product_snapshots',
  // --- customers and guarantors -----------------------------------------
  'clients',
  'client_identities',
  'client_guarantors',
  'client_remarks',
  'guarantors',
  'guarantor_identities',
  // --- the books ---------------------------------------------------------
  'journal_entries',
  'journal_lines',
  'account_transfers',
  'account_reconciliations',
  'expenses',
  'other_income',
  // --- membership, savings, benefits, meetings ---------------------------
  'memberships',
  'membership_status_history',
  'membership_terms_acceptances',
  'membership_consent_challenges',
  'membership_fee_receipts',
  'membership_cards',
  'membership_policy_assignments',
  'membership_policy_transitions',
  'savings_accounts',
  'savings_transactions',
  'savings_withdrawal_requests',
  'member_loan_savings_pledges',
  'member_loan_eligibility_snapshots',
  'member_beneficiaries',
  'member_beneficiary_identities',
  'beneficiary_relationships',
  'benefit_claims',
  'benefit_claim_documents',
  'benefit_assessment_snapshots',
  'benefit_death_confirmations',
  'benefit_payments',
  'membership_meetings',
  'meeting_attendance',
  'meeting_attendance_corrections',
  'meeting_absence_notices',
  'meeting_action_items',
  'meeting_fines',
  'meeting_fine_payments',
  // --- operational traces ------------------------------------------------
  'notifications',
  'notification_reads',
  'rate_limit_counters',
];

/**
 * Profiles that cannot be deleted, and are made harmless instead.
 *
 * The audit log references them ON DELETE RESTRICT and cannot itself be
 * emptied, so deletion is impossible by design. Neutralising is not a
 * consolation prize: it removes everything the account could do.
 *
 *   status = 'inactive'   `current_profile_id()` resolves only active
 *                         profiles, so every capability check, every RLS
 *                         policy and every definer RPC refuses the session
 *   auth_user_id = null    severs the link to Auth, which then lets the Auth
 *                         user be deleted — so there is no credential left to
 *                         sign in with at all
 *
 * What survives is a row carrying a name, which is what the audit trail needs
 * in order to say who did something in the demonstration period.
 */
export const NEUTRALISE_PROFILES = {
  keep: 'id = $OWNER$',
  why: 'Every profile but the Owner is deactivated and unlinked from Auth; the audit log forbids deleting them.',
};

/**
 * Reference counters, so the first real record is numbered 1.
 *
 * Every scope here numbers a table in TRUNCATE_TABLES: once the rows are
 * gone, a counter left at its demonstration value numbers the client's first
 * real document after a history that no longer exists — the first journal
 * voucher would be JV2600598, not JV2600001.
 *
 * `reference_formats` is the list of scopes that exist; `reference_sequences`
 * holds one row per scope PER YEAR, created on demand by `next_reference`. So
 * a scope legitimately has no row yet on a database where that document type
 * has never been issued, and the reset is written to cover every row a scope
 * does have.
 */
export const RESET_SEQUENCES = [
  // lending and the books
  'client',
  'loan',
  'payment',
  'journal',
  'expense',
  'other_income',
  'transfer',
  'reconciliation',
  // membership, savings, benefits, meetings
  'membership',
  'membership_fee',
  'membership_card',
  'membership_meeting',
  'membership_policy_transition',
  'savings_account',
  'savings_transaction',
  'savings_withdrawal',
  'beneficiary',
  'benefit_claim',
  'benefit_payment',
  'meeting_fine',
  'meeting_fine_payment',
];

/**
 * Counters that must NOT be reset, each with the reason.
 *
 * `branch` numbers `branches`, which is reference data in PRESERVE_WHOLE.
 * Resetting it would hand the next branch a code an existing branch holds.
 */
export const PRESERVE_SEQUENCES = ['branch'];

/**
 * The same refusal the table lists get, for the numbering counters.
 *
 * Checked against `reference_formats`, which is migration-managed and is the
 * list of scopes that exist — not against `reference_sequences`, whose rows
 * appear only once a document of that kind has been issued.
 *
 * A scope in neither list means nobody has decided whether the client's first
 * real document of that kind should be numbered 1, so it stops the procedure
 * with a name to look at rather than being silently left at a demonstration
 * value.
 *
 * @param {readonly string[]} formatScopes every scope in reference_formats
 * @returns {{ unclassified: string[], missing: string[] }}
 */
export function classifySequences(formatScopes) {
  const classified = new Set([...RESET_SEQUENCES, ...PRESERVE_SEQUENCES]);
  const actual = new Set(formatScopes);
  return {
    unclassified: formatScopes.filter((scope) => !classified.has(scope)).sort(),
    missing: [...classified].filter((scope) => !actual.has(scope)).sort(),
  };
}

/**
 * Which Supabase project a connection string actually points at.
 *
 * The enable phrase authorises emptying "a database". It does not say which
 * one, and a DATABASE_URL is one paste away from naming a different project,
 * so the runner confirms the target by name and this is what it compares.
 *
 * Supabase puts the project reference in one of two places: the direct host
 * `db.<ref>.supabase.co`, or the pooler username `postgres.<ref>`. Returns
 * null when neither is present — the answer for a local cluster, and the
 * reason a hosted run with no confirmed reference is refused rather than
 * assumed.
 *
 * @param {string} value a PostgreSQL connection string
 * @returns {string | null} the 20-character project reference, lowercased
 */
export function projectRefFromConnectionString(value) {
  const host = /(?:^|@)db\.([a-z0-9]{20})\.supabase\.(?:co|com)/i.exec(value);
  if (host !== null) return host[1].toLowerCase();
  const pooler = /(?:^|\/\/)postgres\.([a-z0-9]{20})(?::|@)/i.exec(value);
  if (pooler !== null) return pooler[1].toLowerCase();
  return null;
}

/**
 * Columns on preserved tables that point at a profile being deleted.
 *
 * `company_settings.updated_by` and friends record who last edited the
 * settings, and that person is a demonstration actor. The FK is
 * `on delete set null`, so Postgres would handle it — but these are listed
 * and nulled explicitly first, so the cleanup states its own effects rather
 * than relying on a cascade nobody reads.
 */
export const NULL_PRESERVED_ACTOR_REFERENCES = [
  { table: 'company_settings', column: 'updated_by' },
  { table: 'business_settings', column: 'updated_by' },
  { table: 'finance_settings', column: 'updated_by' },
];

/**
 * Build the plan, and refuse if the database holds a table nobody classified.
 *
 * @param {readonly string[]} actualTables every table in `public`
 * @returns {{ unclassified: string[], missing: string[] }}
 */
export function classify(actualTables) {
  const classified = new Set([
    ...PRESERVE_WHOLE,
    ...PRESERVE_PARTIAL.map((entry) => entry.table),
    ...TRUNCATE_TABLES,
    // Neutralised, not emptied and not preserved whole.
    'profiles',
  ]);

  const actual = new Set(actualTables);

  return {
    // In the database, in no bucket. The cleanup must not run.
    unclassified: actualTables.filter((table) => !classified.has(table)).sort(),
    // In a bucket, not in the database. A rename or a dropped table; also a
    // refusal, because the bucket lists are the specification.
    missing: [...classified].filter((table) => !actual.has(table)).sort(),
  };
}

/**
 * Run the clean slate.
 *
 * Connection-injected: importing this module connects to nothing and executes
 * no SQL. The caller owns the connection and the decision to use it.
 *
 * @param {{ query: (sql: string, params?: readonly unknown[]) => Promise<{ rows: Record<string, unknown>[] }> }} db
 * @param {{ ownerProfileId: string, dryRun?: boolean }} options
 */
export async function runCleanSlate(db, { ownerProfileId, dryRun = true }) {
  if (typeof ownerProfileId !== 'string' || ownerProfileId.length === 0) {
    throw new Error('ownerProfileId is required: the cleanup must know what to keep.');
  }

  const { rows: tableRows } = await db.query(
    `select tablename from pg_tables where schemaname = 'public' order by tablename`,
  );
  const actualTables = tableRows.map((row) => String(row.tablename));

  const { unclassified, missing } = classify(actualTables);

  if (unclassified.length > 0 || missing.length > 0) {
    const lines = ['The clean slate refuses to run: its table lists are out of date.'];
    if (unclassified.length > 0) {
      lines.push(
        `  in the database, classified nowhere: ${unclassified.join(', ')}`,
        '  Decide whether each holds business rows or reference data, and add it',
        '  to TRUNCATE_TABLES, PRESERVE_WHOLE or PRESERVE_PARTIAL.',
      );
    }
    if (missing.length > 0) {
      lines.push(`  classified but not in the database: ${missing.join(', ')}`);
    }
    throw new Error(lines.join('\n'));
  }

  // The Owner must exist and be able to work afterwards.
  const { rows: ownerRows } = await db.query(
    `select p.id, p.full_name, p.status, p.auth_user_id,
            (select pg_catalog.string_agg(ur.role_key, ',')
               from public.user_roles ur where ur.profile_id = p.id) as roles
       from public.profiles p where p.id = $1`,
    [ownerProfileId],
  );
  const owner = ownerRows[0];
  if (owner === undefined) {
    throw new Error(`No profile ${ownerProfileId}: refusing to empty the database.`);
  }
  if (owner.status !== 'active') {
    throw new Error(
      `Profile ${ownerProfileId} is ${String(owner.status)}, not active: it could not sign in afterwards.`,
    );
  }
  if (!String(owner.roles ?? '').includes('owner_admin')) {
    throw new Error(
      `Profile ${ownerProfileId} does not hold owner_admin (holds: ${String(owner.roles ?? 'nothing')}).`,
    );
  }
  // The Owner must have an Auth identity, for two reasons that both end with
  // nobody able to sign in. A profile with no `auth_user_id` has no
  // credential, so it could not sign in afterwards however active it is. And
  // step 5 keeps exactly the Auth user this column names: with the column
  // NULL there is no user to keep, so the delete would take every one of
  // them. Refusing here is the difference between a clean slate and a locked
  // building.
  if (owner.auth_user_id === null || owner.auth_user_id === undefined) {
    throw new Error(
      `Profile ${ownerProfileId} has no auth_user_id: it holds no credential, ` +
        'so it could not sign in after the cleanup and there would be no Auth ' +
        'user to preserve. Link the Owner to an Auth user first.',
    );
  }

  // The counters get the same treatment as the tables: a scope nobody has
  // classified stops the procedure rather than being silently left at its
  // demonstration value.
  const { rows: scopeRows } = await db.query(
    `select scope from public.reference_formats order by scope`,
  );
  const actualScopes = scopeRows.map((row) => String(row.scope));
  const scopeVerdict = classifySequences(actualScopes);

  if (scopeVerdict.unclassified.length > 0 || scopeVerdict.missing.length > 0) {
    const lines = ['The clean slate refuses to run: its counter lists are out of date.'];
    if (scopeVerdict.unclassified.length > 0) {
      lines.push(
        `  in reference_formats, classified nowhere: ${scopeVerdict.unclassified.join(', ')}`,
        '  Decide whether each should restart at 1 for the first real record, and',
        '  add it to RESET_SEQUENCES or PRESERVE_SEQUENCES.',
      );
    }
    if (scopeVerdict.missing.length > 0) {
      lines.push(
        `  classified but not in reference_formats: ${scopeVerdict.missing.join(', ')}`,
      );
    }
    throw new Error(lines.join('\n'));
  }

  const before = await countBusinessRows(db);

  if (dryRun) {
    return { dryRun: true, owner, before, plan: { truncate: TRUNCATE_TABLES.length } };
  }

  // One transaction. A failure anywhere leaves the database as it was.
  await db.query('begin');
  try {
    // 1. The business rows, together, so the foreign keys between them are
    //    satisfied without CASCADE reaching anything unlisted.
    await db.query(
      `truncate table ${TRUNCATE_TABLES.map((t) => `public.${t}`).join(', ')}`,
    );

    // 2. The demonstration actors' own references on preserved rows.
    for (const { table, column } of NULL_PRESERVED_ACTOR_REFERENCES) {
      await db.query(
        `update public.${table} set ${column} = null where ${column} is not null`,
      );
    }

    // 3. Selective deletes, children before parents.
    for (const entry of [...PRESERVE_PARTIAL].reverse()) {
      const predicate = entry.keep.replaceAll('$OWNER$', `'${ownerProfileId}'::uuid`);
      await db.query(`delete from public.${entry.table} where not (${predicate})`);
    }

    // 4. The demonstration profiles. Deactivated and unlinked rather than
    //    deleted, because the audit log references them ON DELETE RESTRICT
    //    and cannot be emptied. An inactive profile resolves to nothing in
    //    `current_profile_id()`, so it holds no capability anywhere.
    const keepOwner = NEUTRALISE_PROFILES.keep.replaceAll(
      '$OWNER$',
      `'${ownerProfileId}'::uuid`,
    );
    await db.query(
      `update public.profiles
          set status = 'inactive', auth_user_id = null
        where not (${keepOwner})`,
    );

    // 5. The Auth users those profiles used to point at. Reachable only now
    //    that nothing references them. The Owner's is kept; a user with no
    //    profile at all was never this procedure's business, so it goes too —
    //    there is no account left that could sign in but the Owner's.
    await db.query(
      `delete from auth.users u
        where u.id is distinct from (
          select p.auth_user_id from public.profiles p where p.id = $1
        )`,
      [ownerProfileId],
    );

    // 6. Demonstration documents. The buckets stay; their objects go.
    await db.query('delete from storage.objects');

    // 7. Reference counters start again.
    for (const scope of RESET_SEQUENCES) {
      await db.query(
        `update public.reference_sequences set last_value = 0 where scope = $1`,
        [scope],
      );
    }

    await db.query('commit');
  } catch (error) {
    await db.query('rollback');
    throw error;
  }

  const after = await countBusinessRows(db);
  return { dryRun: false, owner, before, after, residue: await describeResidue(db) };
}

/**
 * What the schema will not let this procedure remove.
 *
 * Three deliberate immutability guarantees, each worth more than the tidiness
 * of deleting it: the audit log is append-only, the profiles it names cannot
 * be deleted while it names them, and an approved policy version cannot be
 * deleted at all. The procedure works around all three; this is what is left
 * behind, so a report can say so plainly instead of implying a clean sweep.
 */
export async function describeResidue(db) {
  const { rows } = await db.query(`
    select
      (select count(*) from public.audit_log) as audit_entries,
      (select count(*) from public.profiles where status <> 'active') as deactivated_profiles,
      (select count(*) from public.membership_policy_versions
        where ${DEMONSTRATION_POLICY_MATCH}) as demonstration_policies,
      (select count(*) from public.membership_policy_versions
        where status = 'active' and ${DEMONSTRATION_POLICY_MATCH}) as active_demonstration_policies
  `);
  return Object.fromEntries(
    Object.entries(rows[0] ?? {}).map(([key, value]) => [key, Number(value)]),
  );
}

/** The figures that say whether the slate is clean. */
export async function countBusinessRows(db) {
  const { rows } = await db.query(`
    select
      (select count(*) from public.clients)                      as clients,
      (select count(*) from public.loans)                        as loans,
      (select count(*) from public.loan_payments)                as payments,
      (select count(*) from public.journal_entries)              as journal_entries,
      (select count(*) from public.journal_lines)                as journal_lines,
      (select count(*) from public.memberships)                  as memberships,
      (select count(*) from public.savings_accounts)             as savings_accounts,
      (select count(*) from public.guarantors)                   as guarantors,
      (select count(*) from public.audit_log)                    as audit_entries,
      (select count(*) from public.profiles)                     as profiles,
      (select count(*) from public.profiles where status = 'active') as active_profiles,
      (select count(*) from auth.users)                          as auth_users,
      (select count(*) from storage.objects)                     as storage_objects,
      (select count(*) from public.roles)                        as roles,
      (select count(*) from public.permissions)                  as permissions,
      (select count(*) from public.ledger_accounts)              as ledger_accounts,
      (select count(*) from public.repayment_frequencies)        as cadences,
      (select count(*) from public.loan_products)                as loan_products,
      (select count(*) from public.membership_policy_versions)   as policy_versions,
      (select count(*) from public.membership_policy_versions
        where status = 'active')                                 as active_policies,
      (select coalesce(sum(debit), 0) from public.journal_lines)  as total_debits,
      (select coalesce(sum(credit), 0) from public.journal_lines) as total_credits
  `);
  return Object.fromEntries(
    Object.entries(rows[0] ?? {}).map(([key, value]) => [key, Number(value)]),
  );
}
