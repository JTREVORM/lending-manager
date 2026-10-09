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
      // Phase 11. The money-movement documents and their registers: SELECT
      // only, for the same reason the ledger is. Every one of them is
      // written by a definer function that posts the journal in the same
      // transaction, so a session with INSERT could create a document with
      // no posting behind it.
      'account_reconciliations:SELECT',
      'account_transfers:SELECT',
      'audit_log:SELECT',
      // Phase 10. The branch network and the ledger: SELECT only. Nothing writes to a journal through a session; every posting is made by a definer function.
      'branch_cash_position:SELECT',
      'branches:SELECT',
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
      // Phase 8. The reporting views, SELECT only like every other view. Each
      // aggregates or joins the authoritative views; none recomputes a figure,
      // and none is writable by any session.
      'collections_today:SELECT',
      // Phase 9. The company's own name and locale, readable by every
      // signed-in user including borrowers — SELECT only, through the one
      // definer view, so the registration and tax numbers on
      // `company_settings` stay behind `settings:view`.
      'company_identity:SELECT',
      'company_settings:SELECT',
      'company_settings:UPDATE',
      'dashboard_collection_summary:SELECT',
      'dashboard_portfolio_summary:SELECT',
      'expense_register:SELECT',
      'expenses:SELECT',
      'finance_settings:SELECT',
      'finance_settings:UPDATE',
      'general_ledger:SELECT',
      'guarantor_identities:INSERT',
      'guarantor_identities:SELECT',
      'guarantor_identities:UPDATE',
      'guarantors:INSERT',
      'guarantors:SELECT',
      'guarantors:UPDATE',
      'income_register:SELECT',
      'journal_entries:SELECT',
      'journal_lines:SELECT',
      'ledger_account_balances:SELECT',
      'ledger_accounts:SELECT',
      // Phase 4. The snapshots and the contractual breakdown are read-only to
      // every session: they are written exclusively by `approve_loan`, which
      // runs as the table owner. So nobody can write a snapshot by hand, and
      // a stored snapshot is always one the database captured.
      // Phase 6. The derived balance views: SELECT only, and only to
      // `authenticated`. Every privilege is named in the REVOKE because
      // Supabase's ALTER DEFAULT PRIVILEGES grants them all on a new view.
      'loan_balances:SELECT',
      'loan_client_snapshots:SELECT',
      // Phase 7. Three derived views, SELECT only, each `security_invoker` so
      // it is read under the caller's own policies.
      'loan_delinquency:SELECT',
      'loan_guarantor_snapshots:SELECT',
      'loan_identity_snapshots:SELECT',
      'loan_installment_coverage:SELECT',
      // Phase 5. SELECT and nothing else: the collection schedule is written
      // only by generate_loan_schedule, which runs as the table owner, so no
      // write privilege exists for a session to misuse.
      'loan_installments:SELECT',
      'loan_obligations:SELECT',
      // Phase 6. The payment ledger, likewise: post_payment and
      // reverse_payment are the only writers.
      'loan_payments:SELECT',
      // Phase 7. A charge against a borrower, SELECT only for every role
      // including the Owner: `ensure_penalty_applied` is the only writer, and
      // a penalty amount a person could type would not be a penalty.
      'loan_penalties:SELECT',
      'loan_penalty_coverage:SELECT',
      'loan_periods:SELECT',
      // Phase 8. Reporting views, SELECT only like every other view.
      'loan_portfolio_report:SELECT',
      // Phase 12. The catalogue, where each product is sold, and the terms a
      // loan was approved under. The Owner writes a product and where it is
      // sold — `products:manage`, nobody else — and a snapshot is written
      // only by `capture_loan_product_snapshot` inside `approve_loan`, so it
      // is SELECT and nothing more. No DELETE on `loan_products`: a product
      // with loans against it is referenced by all of their snapshots, and
      // retiring is what `status = 'inactive'` is for.
      'loan_product_branches:DELETE',
      'loan_product_branches:INSERT',
      'loan_product_branches:SELECT',
      'loan_product_catalogue:SELECT',
      'loan_product_snapshots:SELECT',
      'loan_products:INSERT',
      'loan_products:SELECT',
      'loan_products:UPDATE',
      'loan_schedules:SELECT',
      'loans:INSERT',
      'loans:SELECT',
      'loans:UPDATE',
      // Phase 6. The payment ledger: SELECT only. post_payment and
      // reverse_payment are the only writers, and they run as the table owner.
      'other_income:SELECT',
      'payment_allocations:SELECT',
      'payment_collection_totals:SELECT',
      'payment_register:SELECT',
      'permissions:SELECT',
      'profiles:INSERT',
      'profiles:SELECT',
      'profiles:UPDATE',
      'reconciliation_register:SELECT',
      'repayment_frequencies:INSERT',
      'repayment_frequencies:SELECT',
      'repayment_frequencies:UPDATE',
      'role_permissions:SELECT',
      'roles:SELECT',
      'transfer_register:SELECT',
      'trial_balance:SELECT',
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
      // Phase 11. Read policies only, for the same reason the ledger has
      // none that write: every money-movement document is written by a
      // definer function that posts its journal in the same transaction.
      'account_reconciliations:SELECT',
      'account_transfers:SELECT',
      'audit_log:SELECT',
      // Phase 10. Read policies only: no session role writes a journal,
      // a ledger account or a branch — every one of those is a definer
      // function's job.
      'branches:SELECT',
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
      'expenses:SELECT',
      'finance_settings:SELECT',
      'finance_settings:UPDATE',
      'guarantor_identities:INSERT',
      'guarantor_identities:SELECT',
      'guarantor_identities:UPDATE',
      'guarantors:INSERT',
      'guarantors:SELECT',
      'guarantors:UPDATE',
      'journal_entries:SELECT',
      'journal_lines:SELECT',
      'ledger_accounts:SELECT',
      // Phase 4. SELECT only on the breakdown and the snapshots: they are
      // written exclusively by `approve_loan`, which runs as the table owner.
      // No DELETE policy anywhere — a loan is cancelled, never deleted.
      //
      // The Phase 6 balance views are deliberately absent: a view cannot
      // carry a policy, which is exactly why `security_invoker = true`
      // matters. Their access comes from the base tables' policies, and the
      // `views` block below asserts every one of them sets it.
      'loan_client_snapshots:SELECT',
      'loan_guarantor_snapshots:SELECT',
      'loan_identity_snapshots:SELECT',
      // Phase 5. SELECT and nothing else: the collection schedule is written
      // only by generate_loan_schedule, which runs as the table owner, so no
      // write privilege exists for a session to misuse.
      'loan_installments:SELECT',
      // Phase 6. The payment ledger, likewise: post_payment and
      // reverse_payment are the only writers.
      'loan_payments:SELECT',
      // Phase 7. One policy, SELECT, delegating to the loan — and no write
      // policy, because no write grant exists to need one.
      'loan_penalties:SELECT',
      'loan_periods:SELECT',
      'loan_product_branches:DELETE',
      'loan_product_branches:INSERT',
      'loan_product_branches:SELECT',
      'loan_product_snapshots:SELECT',
      'loan_products:INSERT',
      'loan_products:SELECT',
      'loan_products:UPDATE',
      'loan_schedules:SELECT',
      'loans:INSERT',
      'loans:SELECT',
      'loans:UPDATE',
      'other_income:SELECT',
      'payment_allocations:SELECT',
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
      // Phase 6. The payment ledger delegates to the loan; allocations
      // delegate to the payment.
      loan_payments: /FROM \(?loans l\b/,
      // This one delegates *entirely*, with no capability of its own, and
      // that is load-bearing rather than lax: the balance views aggregate
      // allocations, so a role that could read a payment but not its
      // allocations would see a silently under-reported balance. Making the
      // two visibilities one visibility is the point.
      payment_allocations: /FROM loan_payments lp\b/,
    };

    /** Policies that must also name a capability, on top of delegating. */
    const ALSO_REQUIRES_CAPABILITY = new Set([
      'loan_installments',
      'loan_schedules',
      'loan_payments',
    ]);

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

/**
 * Views, which are a Row Level Security bypass unless told otherwise.
 *
 * A PostgreSQL view runs as its **owner** by default, so a view over a
 * policy-protected table hands every row to anybody who can select from the
 * view. `security_invoker = true` makes the caller's policies apply instead.
 *
 * Phase 6 introduced the first views in this schema — the derived balance
 * views — and these assertions exist so a later one cannot quietly
 * reintroduce the bypass.
 */
describeDb('views', () => {
  it('sets security_invoker on every view, so policies still apply', async () => {
    const rows = await query<{ relname: string; invoker: string | null }>(
      `select c.relname,
              (select option_value from pg_options_to_table(c.reloptions)
                where option_name = 'security_invoker') as invoker
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind = 'v'
        order by c.relname`,
    );

    // There are views, so this is a real check rather than a vacuous one.
    expect(rows.length).toBeGreaterThan(0);

    /**
     * The one documented exception, Phase 9.
     *
     * `company_identity` exposes the company's own name, locale, timezone,
     * logo and brand colour to every signed-in user, borrowers included —
     * because a borrower seeing the name of the software instead of the name
     * of the lender they owe money to is what the pre-Phase-9 portal did.
     *
     * RLS decides rows, not columns, and there is one row here, so no policy
     * can say "the name but not the tax number". The view is safe because of
     * what it selects: five public-facing columns, no parameter, no row
     * choice, and nothing of anyone's money in it. Everything sensitive stays
     * on `company_settings` behind `settings:view`.
     *
     * Listed by name rather than skipped by a pattern, so a second definer
     * view cannot arrive without this test being edited and the reason
     * written down. The column list is asserted below.
     */
    const DEFINER_BY_DESIGN = new Set(['company_identity']);

    for (const row of rows) {
      if (DEFINER_BY_DESIGN.has(row.relname)) {
        expect(row.invoker, `${row.relname} is definer by design`).not.toBe('true');
        continue;
      }

      expect(row.invoker, `${row.relname} must set security_invoker`).toBe('true');
    }
  });

  it('exposes nothing sensitive through the one definer view', async () => {
    // The protection on `company_identity` is its column list, so the column
    // list is the thing to assert. A later migration adding `phone` or
    // `tax_identification_number` to it would hand the business's
    // registration details to every borrower.
    const rows = await query<{ column_name: string }>(
      `select column_name
         from information_schema.columns
        where table_schema = 'public' and table_name = 'company_identity'
        order by column_name`,
    );

    // Phase 12 widened this, and the reason is worth keeping next to the
    // list. The registration and tax numbers are still absent and still
    // behind `settings:view`. What was added is the set of details the
    // company publishes on its own flyer — the tagline, the two phone
    // numbers, the postal and physical address — because a receipt that
    // cannot print the lender's phone number is not a receipt anybody can
    // act on, and a borrower has to be able to read one.
    expect(rows.map((row) => row.column_name)).toEqual([
      'address_line1',
      'address_line2',
      'brand_primary_color',
      'city',
      'company_name',
      'country',
      'currency_code',
      'locale',
      'logo_path',
      'phone',
      'phone_secondary',
      'postal_address',
      'tagline',
      'timezone',
    ]);
  });

  it('creates exactly the expected views, and no more', () => {
    return query<{ relname: string }>(
      `select c.relname
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind = 'v'
        order by c.relname`,
    ).then((rows) => {
      expect(rows.map((row) => row.relname)).toEqual([
        // Phase 8. The reporting views: the collection sheet, the two
        // dashboard summaries, the loan register and the payment register.
        // Every one aggregates or joins the views below rather than
        // recomputing anything, and every one is `security_invoker` — a
        // reporting view that ran as its owner would be the most valuable
        // single object in the schema to an attacker.
        //
        // None is materialised, deliberately. A materialised view is owned
        // data with no caller to be read on behalf of, so Row Level Security
        // cannot apply to it at all. Phase 7 noted one might help a larger
        // portfolio; Phase 8 declines it for that reason.
        // Phase 10. The three ledger views.
        // Phase 11. Five more: one register per money-movement document, and
        // the general ledger every financial drill-down reads.
        'branch_cash_position',
        'collections_today',
        // Phase 9. The company's own identity, readable by every signed-in
        // user including borrowers. The only SECURITY DEFINER view in the
        // schema, and the test above says why.
        'company_identity',
        'dashboard_collection_summary',
        'dashboard_portfolio_summary',
        'expense_register',
        'general_ledger',
        'income_register',
        'ledger_account_balances',
        // Phase 6. Balances are derived rather than stored, so a reversal
        // changes every figure the instant it commits.
        'loan_balances',
        // Phase 7. Delinquency is derived too — arrears, lateness, grace and
        // penalty eligibility are computed on every read from the schedule,
        // the ledger and the business date, so no process has to run and no
        // column can go stale.
        'loan_delinquency',
        'loan_installment_coverage',
        'loan_obligations',
        'loan_penalty_coverage',
        'loan_portfolio_report',
        // Phase 12. The product catalogue.
        'loan_product_catalogue',
        'payment_collection_totals',
        'payment_register',
        'reconciliation_register',
        'transfer_register',
        'trial_balance',
      ]);
    });
  });

  it('grants a view nothing but SELECT, and nothing at all to anon', async () => {
    // Supabase's ALTER DEFAULT PRIVILEGES grants every privilege on a new
    // object in `public` to both `anon` and `authenticated`, and
    // `revoke all from public` does not remove them because they were granted
    // to the roles by name. Each role has to be named in the REVOKE.
    //
    // This assertion is here because the first draft of migration
    // 20261006000400 omitted it, and a financial view arrived with INSERT,
    // UPDATE, DELETE and TRUNCATE granted to anonymous visitors.
    const rows = await query<{
      grantee: string;
      table_name: string;
      privilege_type: string;
    }>(
      `select g.grantee, g.table_name, g.privilege_type
         from information_schema.role_table_grants g
         join pg_class c on c.relname = g.table_name
         join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
        where c.relkind = 'v'
          and g.table_schema = 'public'
          and g.grantee in ('anon', 'authenticated')
        order by g.grantee, g.table_name, g.privilege_type`,
    );

    for (const row of rows) {
      expect(
        `${row.grantee}:${row.privilege_type}`,
        `${row.table_name} grants ${row.privilege_type} to ${row.grantee}`,
      ).toBe('authenticated:SELECT');
    }

    // And every view is readable by a signed-in caller, so the revoke did not
    // go too far.
    // One row per view: three from Phase 6, three from Phase 7, five from
    // Phase 8's reporting layer, one from Phase 9, three from Phase 10 and
    // five from Phase 11 — four document registers and the general ledger —
    // and one from Phase 12, the product catalogue.
    // Counted here because the names are already enumerated above; what this
    // assertion is for is the *privilege*, and the count catches a view that
    // arrived with more than SELECT — which is exactly what the Phase 10
    // views did in their first draft, until this assertion said so.
    expect(rows.filter((row) => row.grantee === 'authenticated')).toHaveLength(21);
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
      'apply_eligible_penalties',
      'approve_expense',
      'approve_loan',
      'approve_reconciliation',
      'approve_transfer',
      'assert_cash_account',
      'assert_cash_available',
      'assert_owner_admin_remains',
      'assert_postable_account',
      'audit_actor_label',
      'audit_client_change',
      'audit_client_guarantor_change',
      'audit_client_identity_change',
      'audit_client_remark_added',
      'audit_guarantor_change',
      'audit_guarantor_identity_change',
      'audit_loan_change',
      // Phase 12. A product holds the rate the business lends at, so a
      // change to one is audited the way a change to business_settings is.
      'audit_loan_product_change',
      'audit_loan_schedule_generated',
      'audit_loan_snapshot_created',
      'audit_loan_terms_locked',
      'audit_payment_allocated',
      'audit_payment_change',
      'audit_penalty_applied',
      'audit_profile_change',
      'audit_settings_change',
      'audit_user_role_change',
      'backfill_ledger_history',
      'branch_cash_account',
      'business_now',
      // Phase 12. The other half of the guard rail: a change to
      // business_settings that would strand an active product is refused.
      'business_settings_keep_products_valid',
      'business_timezone',
      'cancel_loan',
      // Phase 12. Freezing the product terms writes an append-only table no
      // session may write, and the two trigger functions enforce the
      // product's own bounds and supply a default. None is granted to
      // `authenticated`.
      'capture_loan_product_snapshot',
      'client_guarantors_guard_detach',
      'client_remarks_stamp_author',
      'clients_assign_client_number',
      'clients_guard_privileged_columns',
      'clients_stamp_branch',
      'clients_stamp_provenance',
      'confirm_password_change',
      'consume_rate_limit',
      'current_profile_id',
      'current_user_max_rank',
      'current_user_permissions',
      'current_user_role_keys',
      'disburse_loan',
      'ensure_penalty_applied',
      'generate_loan_schedule',
      'guarantors_guard_privileged_columns',
      'guarantors_stamp_provenance',
      'journal_assert_balanced',
      'journal_entries_assert_balanced',
      'journal_entries_guard_update',
      'journal_lines_assert_balanced',
      'ledger_account_balance',
      'ledger_account_by_code',
      'link_client_profile',
      'loan_payments_assign_number',
      'loan_payments_guard_mutation',
      'loan_products_stamp_actor',
      'loan_products_within_business_rules',
      'loans_assign_loan_number',
      'loans_enforce_active_limit',
      'loans_guard_transition',
      'loans_stamp_branch',
      'loans_stamp_product',
      'next_reference',
      'post_disbursement_journal',
      'post_expense_journal',
      'post_journal',
      'post_payment',
      'post_repayment_journal',
      'post_reversal_journal',
      'post_transfer_journal',
      'profiles_assert_owner_remains',
      'profiles_guard_privileged_columns',
      'profiles_stamp_password_set_at',
      'purge_expired_rate_limits',
      'record_audit_event',
      'record_expense',
      'record_other_income',
      'record_security_event',
      'record_sign_in',
      'record_transfer',
      'reject_expense',
      'reject_reconciliation',
      'reject_transfer',
      'repayment_frequencies_guard_identity',
      'reverse_expense',
      'reverse_other_income',
      'reverse_payment',
      'reverse_transfer',
      'submit_reconciliation',
      'user_can_see_branch',
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
      'approve_expense',
      'approve_loan',
      'approve_reconciliation',
      'approve_transfer',
      // Phase 7. The business clock and the timezone it is read in. Granted
      // because every screen needs to know what "today" means to the
      // business, and because a date is not sensitive. Neither accepts a
      // date from a caller: `business_now` honours an override only on a
      // direct owner connection, which no application path has.
      'business_date',
      'business_now',
      'business_timezone',
      // Pure arithmetic: a function of its arguments that discloses nothing.
      // The preview screen calls it so staff see the authoritative figures
      // rather than the browser's.
      'calculate_loan_breakdown',
      'cancel_loan',
      // Phase 9. The rate limiter. Granted to `authenticated` so a signed-in
      // caller's own budget is consumed on the path they are using; **not**
      // granted to `anon`, because an anonymous caller who could consume a
      // bucket could exhaust a chosen account's sign-in budget and lock that
      // person out. The pre-authentication path goes through the server.
      'consume_rate_limit',
      'current_profile_id',
      'current_user_max_rank',
      'current_user_permissions',
      'current_user_role_keys',
      'disburse_loan',
      // Phase 6. SECURITY INVOKER, so a session reading a balance sees only
      // what Row Level Security allows it to.
      // Phase 11. One account's balance, for the finance screens. A read
      // of a figure the ledger already publishes through
      // `ledger_account_balances`, so the grant adds no reach.
      'ledger_account_balance',
      'loan_outstanding',
      // Phase 7, all three SECURITY INVOKER for the same reason. The as-of
      // balance is a read-only historical figure: no mutation accepts a date,
      // so nothing a caller passes here can change what is posted.
      'loan_outstanding_as_of',
      'loan_penalty_outstanding',
      'loan_total_outstanding',
      'mask_nin',
      'payment_business_date',
      // Phase 10. Pure mapping from a payment method to the account it lands in. Immutable, takes no identity and reads nothing, so a signed-in caller may resolve it.
      'payment_method_cash_kind',
      // Phase 6. The two trusted ledger paths. Each re-checks the caller's
      // capability inside, because SECURITY DEFINER means the grant alone
      // decides nothing.
      'post_payment',
      // Phase 11. The four money-movement writers and their decisions.
      // Granted for the same reason `post_payment` is: the application
      // calls them as the signed-in person, and each re-checks the
      // capability inside, because SECURITY DEFINER means the grant alone
      // decides nothing. The *_journal helpers are deliberately absent —
      // they post without writing a document, and nothing but their own
      // callers should reach them.
      'record_expense',
      'record_other_income',
      'record_security_event',
      'record_sign_in',
      'record_transfer',
      'reject_expense',
      'reject_reconciliation',
      'reject_transfer',
      'reverse_expense',
      'reverse_other_income',
      'reverse_payment',
      'reverse_transfer',
      'storage_path_client_id',
      'storage_path_guarantor_id',
      'storage_path_kind',
      'submit_reconciliation',
      'user_can_see_branch',
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
