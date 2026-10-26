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
      // Polytos Phase 4. SELECT only almost everywhere: a beneficiary is
      // registered by `register_member_beneficiary`, a claim is moved by the
      // lifecycle functions, a payment is posted by `post_benefit_payment`
      // and a register is marked by `mark_meeting_attendance` — every one a
      // definer function that applies the capability check, the separation of
      // duties and, where money moves, the journal in the same transaction. A
      // session with INSERT could create a claim nobody assessed or a payment
      // with no posting behind it.
      //
      // Two exceptions, both deliberate:
      //
      //   `benefit_claim_documents:DELETE` — an unchecked document on an open
      //   claim is a thing people need to undo, and the delete guard refuses
      //   anything else with a message that says why.
      //
      //   `membership_meetings:UPDATE` — the scheduling functions run as the
      //   table owner, and the policy narrows the grant to `meetings:manage`
      //   within branch so that even a bare UPDATE from a session cannot move
      //   another branch's meeting.
      //
      // DELETE appears on nothing else in this phase. `member_beneficiaries`,
      // `benefit_claims` and `benefit_payments` all refuse it by trigger as
      // well, because each is evidence of a decision about money.
      'beneficiary_relationships:SELECT',
      'benefit_assessment_snapshots:SELECT',
      'benefit_claim_documents:DELETE',
      'benefit_claim_documents:SELECT',
      'benefit_claim_portal_view:SELECT',
      'benefit_claim_register:SELECT',
      'benefit_claims:SELECT',
      'benefit_document_kinds:SELECT',
      'benefit_payment_register:SELECT',
      'benefit_payments:SELECT',
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
      'guarantor_consent_terms:INSERT',
      'guarantor_consent_terms:SELECT',
      'guarantor_consent_terms:UPDATE',
      // Phase 14. The guarantor register, SELECT only.
      'guarantor_exposure:SELECT',
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
      // Phase 14. Aging, SELECT only like every other derived view.
      'loan_aging:SELECT',
      'loan_application_profile:SELECT',
      // Phase 4. The snapshots and the contractual breakdown are read-only to
      // every session: they are written exclusively by `approve_loan`, which
      // runs as the table owner. So nobody can write a snapshot by hand, and
      // a stored snapshot is always one the database captured.
      // Phase 6. The derived balance views: SELECT only, and only to
      // `authenticated`. Every privilege is named in the REVOKE because
      // Supabase's ALTER DEFAULT PRIVILEGES grants them all on a new view.
      'loan_balances:SELECT',
      'loan_business_details:INSERT',
      'loan_business_details:SELECT',
      'loan_business_details:UPDATE',
      'loan_client_snapshots:SELECT',
      // Phase 14. The security a loan is written against. Four privileges,
      // because an item on an application being assembled is genuinely
      // editable and genuinely removable — the guard narrows both once the
      // money has moved, which is a rule a privilege cannot express.
      'loan_collateral:DELETE',
      'loan_collateral:INSERT',
      'loan_collateral:SELECT',
      'loan_collateral:UPDATE',
      'loan_collateral_register:SELECT',
      // Phase 7. Three derived views, SELECT only, each `security_invoker` so
      // it is read under the caller's own policies.
      'loan_delinquency:SELECT',
      // Phase 13. The evidence filed with an application: read with
      // `loans:view`, written and removed with `loans:documents`.
      'loan_documents:DELETE',
      'loan_documents:INSERT',
      'loan_documents:SELECT',
      'loan_documents:UPDATE',
      'loan_guarantor_evidence:SELECT',
      'loan_guarantor_register:SELECT',
      'loan_guarantor_snapshots:SELECT',
      'loan_guarantors:DELETE',
      'loan_guarantors:INSERT',
      'loan_guarantors:SELECT',
      'loan_guarantors:UPDATE',
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
      // Phase 14. SELECT and INSERT, and deliberately no UPDATE or DELETE:
      // the table refuses both with statement-level triggers, and a privilege
      // that only ever leads to a refusal is a promise the schema does not
      // keep. A mistake is corrected by appending a correction.
      'loan_recovery_actions:INSERT',
      'loan_recovery_actions:SELECT',
      'loan_recovery_register:SELECT',
      'loan_recovery_status:SELECT',
      'loan_salary_details:INSERT',
      'loan_salary_details:SELECT',
      'loan_salary_details:UPDATE',
      'loan_schedules:SELECT',
      // Phase 13. The loan module's register. `security_invoker` and SELECT
      // only, like every other register here.
      'loan_workflow_register:SELECT',
      'loans:INSERT',
      'loans:SELECT',
      'loans:UPDATE',
      // Polytos Phase 3. SELECT and nothing else, on the two tables and the
      // two views. Both tables are written by `approve_loan` and the release
      // trigger, both SECURITY DEFINER, so the privilege a session would need
      // to forge a snapshot or a pledge simply does not exist.
      'meeting_action_items:SELECT',
      'meeting_attendance:SELECT',
      'meeting_attendance_corrections:SELECT',
      'meeting_attendance_register:SELECT',
      'member_beneficiaries:SELECT',
      'member_beneficiary_identities:SELECT',
      'member_beneficiary_register:SELECT',
      'member_loan_eligibility:SELECT',
      'member_loan_eligibility_snapshots:SELECT',
      'member_loan_register:SELECT',
      'member_loan_savings_pledges:SELECT',
      // Polytos Phase 1. The membership foundation.
      //
      // `membership_policy_versions` takes INSERT and UPDATE because
      // publishing and approving a version are session acts gated on
      // `membership:manage_policies`; `memberships` takes them because
      // enrolling a member and moving a membership are session acts too.
      // Neither writes money, so neither needs the definer-only treatment
      // the money-movement documents get.
      //
      // `membership_status_history` has SELECT and nothing else: it is
      // written by a trigger, so a session holding INSERT could compose a
      // history that never happened. `membership_terms_acceptances` has no
      // UPDATE: what a member signed is evidence, and a correction is a
      // fresh acceptance against a new version.
      //
      // DELETE appears on none of them, as it appears on nothing in this
      // system but `user_roles`.
      'member_savings_balances:SELECT',
      'member_savings_contributions:SELECT',
      // Polytos Phase 2. Every one of these is SELECT and nothing more, with
      // one exception: `savings_accounts` takes UPDATE so a supervisor can
      // restrict an account. The subledger, the receipts, the withdrawal
      // requests and the cards are written by SECURITY DEFINER functions
      // that post a journal in the same transaction — a row inserted
      // directly would be money the ledger does not know about, so no
      // session may insert one.
      //
      // The first draft of 20261020001100 granted SELECT without revoking
      // first, and `CREATE TABLE` had already handed `authenticated`
      // everything including DELETE and TRUNCATE. This assertion found it.
      'membership_cards:SELECT',
      'membership_fee_receipts:SELECT',
      'membership_meeting_register:SELECT',
      'membership_meetings:SELECT',
      'membership_meetings:UPDATE',
      'membership_policy_versions:INSERT',
      'membership_policy_versions:SELECT',
      'membership_policy_versions:UPDATE',
      'membership_register:SELECT',
      'membership_status_history:SELECT',
      'membership_terms_acceptances:INSERT',
      'membership_terms_acceptances:SELECT',
      'memberships:INSERT',
      'memberships:SELECT',
      'memberships:UPDATE',
      // Phase 15. The stream, the receipts and the two views over them.
      // SELECT only on all four: `raise_notification` and
      // `mark_notifications_read` are the only writers and both run as the
      // table owner, so no session has a write privilege to misuse.
      'notification_feed:SELECT',
      'notification_reads:SELECT',
      'notification_summary:SELECT',
      'notifications:SELECT',
      // Phase 6. The payment ledger: SELECT only. post_payment and
      // reverse_payment are the only writers, and they run as the table owner.
      'other_income:SELECT',
      'payment_allocations:SELECT',
      'payment_collection_totals:SELECT',
      'payment_register:SELECT',
      'permissions:SELECT',
      // Phase 14. The PAR aggregate, SELECT only.
      'portfolio_at_risk:SELECT',
      'profiles:INSERT',
      'profiles:SELECT',
      'profiles:UPDATE',
      'reconciliation_register:SELECT',
      'repayment_frequencies:INSERT',
      'repayment_frequencies:SELECT',
      'repayment_frequencies:UPDATE',
      'role_permissions:SELECT',
      'roles:SELECT',
      'savings_account_register:SELECT',
      'savings_accounts:SELECT',
      'savings_accounts:UPDATE',
      'savings_transactions:SELECT',
      'savings_withdrawal_requests:SELECT',
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
      // Polytos Phase 4. Read policies throughout, for the reason the Phase 2
      // and Phase 3 tables have none that write: every benefit and meeting
      // write is a definer function's. The two exceptions are the ones the
      // grant list above explains.
      'beneficiary_relationships:SELECT',
      'benefit_assessment_snapshots:SELECT',
      'benefit_claim_documents:DELETE',
      'benefit_claim_documents:SELECT',
      'benefit_claims:SELECT',
      'benefit_document_kinds:SELECT',
      'benefit_payments:SELECT',
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
      'guarantor_consent_terms:INSERT',
      'guarantor_consent_terms:SELECT',
      'guarantor_consent_terms:UPDATE',
      'guarantor_identities:INSERT',
      'guarantor_identities:SELECT',
      'guarantor_identities:UPDATE',
      'guarantors:INSERT',
      'guarantors:SELECT',
      'guarantors:UPDATE',
      'journal_entries:SELECT',
      'journal_lines:SELECT',
      'ledger_accounts:SELECT',
      'loan_business_details:INSERT',
      'loan_business_details:SELECT',
      'loan_business_details:UPDATE',
      // Phase 4. SELECT only on the breakdown and the snapshots: they are
      // written exclusively by `approve_loan`, which runs as the table owner.
      // No DELETE policy anywhere — a loan is cancelled, never deleted.
      //
      // The Phase 6 balance views are deliberately absent: a view cannot
      // carry a policy, which is exactly why `security_invoker = true`
      // matters. Their access comes from the base tables' policies, and the
      // `views` block below asserts every one of them sets it.
      'loan_client_snapshots:SELECT',
      // Phase 14. Read with `collateral:view`, written with
      // `collateral:manage`. Four policies, matching the four privileges: the
      // guard, not the policy, is what narrows editing and removal once the
      // money has moved.
      'loan_collateral:DELETE',
      'loan_collateral:INSERT',
      'loan_collateral:SELECT',
      'loan_collateral:UPDATE',
      // Phase 13. Read with `loans:view`, written with `loans:documents`.
      'loan_documents:DELETE',
      'loan_documents:INSERT',
      'loan_documents:SELECT',
      'loan_documents:UPDATE',
      'loan_guarantor_snapshots:SELECT',
      'loan_guarantors:DELETE',
      'loan_guarantors:INSERT',
      'loan_guarantors:SELECT',
      'loan_guarantors:UPDATE',
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
      // Phase 14. SELECT with `recovery:view`, INSERT with
      // `recovery:record`, and nothing else — the table refuses UPDATE and
      // DELETE outright, so there is no write grant for a policy to gate.
      'loan_recovery_actions:INSERT',
      'loan_recovery_actions:SELECT',
      'loan_salary_details:INSERT',
      'loan_salary_details:SELECT',
      'loan_salary_details:UPDATE',
      'loan_schedules:SELECT',
      'loans:INSERT',
      'loans:SELECT',
      'loans:UPDATE',
      // Polytos Phase 3. One SELECT policy each, and no write policy
      // anywhere: nothing a session does writes either table.
      'meeting_action_items:SELECT',
      'meeting_attendance:SELECT',
      'meeting_attendance_corrections:SELECT',
      'member_beneficiaries:SELECT',
      'member_beneficiary_identities:SELECT',
      'member_loan_eligibility_snapshots:SELECT',
      'member_loan_savings_pledges:SELECT',
      // Polytos Phase 1. A policy for every operation `authenticated` was
      // granted, and no operation granted without one.
      // Polytos Phase 2. One policy per granted operation and no more: five
      // SELECTs and the single UPDATE on `savings_accounts`. There is no
      // INSERT policy anywhere in this phase, because nothing a session does
      // writes these tables directly — the posting functions do, and each
      // writes a journal in the same transaction.
      'membership_cards:SELECT',
      'membership_fee_receipts:SELECT',
      'membership_meetings:SELECT',
      'membership_meetings:UPDATE',
      'membership_policy_versions:INSERT',
      'membership_policy_versions:SELECT',
      'membership_policy_versions:UPDATE',
      'membership_status_history:SELECT',
      'membership_terms_acceptances:INSERT',
      'membership_terms_acceptances:SELECT',
      'memberships:INSERT',
      'memberships:SELECT',
      'memberships:UPDATE',
      // Phase 15. SELECT only on both, matching the only privileges granted.
      // The notification policy is three independent narrowings — the
      // capability of the thing it is about, an optional person, an optional
      // branch; the receipt policy is "mine and nobody else's".
      'notification_reads:SELECT',
      'notifications:SELECT',
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
      'savings_accounts:SELECT',
      'savings_accounts:UPDATE',
      'savings_transactions:SELECT',
      'savings_withdrawal_requests:SELECT',
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

    // The tables a signed-in user may read without qualification: the three
    // vocabularies — role names, capability names, and the mapping between
    // them — and, as of Phase 13, the guarantor undertaking. None names a
    // person or an amount.
    //
    // The undertaking belongs in this set for the same reason the
    // vocabularies do: it is the business's own published document, with no
    // personal data in it, and the people most entitled to re-read it are
    // the guarantors who signed it — who hold a borrower's portal login and
    // nothing more. Gating it on a capability would hide a contract from the
    // person bound by it.
    const unconditional = rows
      .filter((row) => row.qual === 'true')
      .map((row) => row.tablename)
      .sort();

    expect([...new Set(unconditional)]).toEqual([
      // Polytos Phase 4. Two more vocabularies, and they belong here for
      // exactly the reason the other four do: one is a list of words for
      // family relationships, the other a list of document names. Neither
      // names a person or an amount, and every beneficiary and claim form has
      // to render both.
      //
      // `beneficiary_relationships.condolence_eligible` is the only column on
      // either that carries a *rule*, and it is NULL on every row — the
      // client has not defined an eligible family member — so reading the
      // table discloses no entitlement either.
      'beneficiary_relationships',
      'benefit_document_kinds',
      'guarantor_consent_terms',
      'permissions',
      'role_permissions',
      'roles',
    ]);

    // And the claim that it carries nothing personal, asserted rather than
    // assumed: a column named after a person or a sum would make the policy
    // above wrong.
    const columns = await query<{ table_name: string; column_name: string }>(
      `select table_name, column_name from information_schema.columns
        where table_schema = 'public'
          and table_name in (
            'guarantor_consent_terms',
            'beneficiary_relationships',
            'benefit_document_kinds')`,
    );

    for (const { table_name, column_name } of columns) {
      // `label` is permitted: on all three it is the published wording, not
      // anybody's name. The pattern below matches `name$`, which `label`
      // is not, so nothing has to be excepted.
      expect(column_name, `${table_name} column`).not.toMatch(
        /name$|phone|nin|amount|salary|balance/i,
      );
    }
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
          and tablename not in
              ('permissions', 'role_permissions', 'roles', 'guarantor_consent_terms',
               -- Polytos Phase 4. Two more published vocabularies, read
               -- without qualification for the reason the other four are.
               'beneficiary_relationships', 'benefit_document_kinds')`,
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
        // Polytos Phase 4. Five registers and the portal's read. Every one is
        // `security_invoker`, so the policies beneath decide what a caller sees —
        // and `benefit_claim_portal_view` carries the member's disclosure policy
        // as its column list, so a portal screen cannot render an assessor's note
        // by accident and a future `select *` cannot reintroduce one.
        'benefit_claim_portal_view',
        'benefit_claim_register',
        'benefit_payment_register',
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
        // Phase 14. The guarantor register: every guarantee with its
        // exposure, and whether the undertaking still binds.
        'guarantor_exposure',
        'income_register',
        'ledger_account_balances',
        // Phase 14. Aging is a presentation of `days_past_due`, bucketed in
        // one `case` so a screen and a report cannot disagree about which
        // bucket a loan is in.
        'loan_aging',
        'loan_application_profile',
        // Phase 6. Balances are derived rather than stored, so a reversal
        // changes every figure the instant it commits.
        'loan_balances',
        'loan_collateral_register',
        // Phase 7. Delinquency is derived too — arrears, lateness, grace and
        // penalty eligibility are computed on every read from the schedule,
        // the ledger and the business date, so no process has to run and no
        // column can go stale.
        'loan_delinquency',
        'loan_guarantor_evidence',
        'loan_guarantor_register',
        'loan_installment_coverage',
        'loan_obligations',
        'loan_penalty_coverage',
        'loan_portfolio_report',
        // Phase 12. The product catalogue.
        'loan_product_catalogue',
        // Phase 14. The chase, per action and per loan. Whether a promise was
        // kept is derived from posted payments, so a reversal un-keeps one
        // without anybody remembering to.
        'loan_recovery_register',
        'loan_recovery_status',
        // Phase 13. The loan module's register: the loan, its product, its
        // collection state and its guarantor count.
        'loan_workflow_register',
        // Polytos Phase 1. A membership with its member's name and the policy
        // version governing it, as one read rather than a membership query
        // followed by a client lookup per row.
        // Polytos Phase 2. A savings balance is a sum over the subledger and
        // never a stored column, so it is a view — and the register and the
        // contribution months are built on it rather than re-deriving it.
        // Polytos Phase 3. One row per live membership with the ceiling their
        // savings support, and member loans with their frozen eligibility
        // evidence beside them — each the one read a dashboard or a panel
        // makes, rather than a function call per member.
        'meeting_attendance_register',
        'member_beneficiary_register',
        'member_loan_eligibility',
        'member_loan_register',
        'member_savings_balances',
        'member_savings_contributions',
        'membership_meeting_register',
        'membership_register',
        // Phase 15. The caller's notifications, each with whether that caller
        // has read it, and the one-row count the bell shows.
        'notification_feed',
        'notification_summary',
        'payment_collection_totals',
        'payment_register',
        // Phase 14. PAR1/7/30/60/90 and the aging buckets, for the whole
        // active book and sliced by branch and by product.
        'portfolio_at_risk',
        'reconciliation_register',
        'savings_account_register',
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
    // one from Phase 12, the product catalogue, three from Phase 13 — the
    // application profile, a loan's guarantor register and the frozen
    // guarantor evidence — and six from Phase 14: aging, the PAR aggregate,
    // the security register, the recovery register and its per-loan rollup,
    // and the guarantor exposure register, one from Polytos Phase 1 — the
    // membership register — and three from Polytos Phase 2: the savings
    // balance, the savings register built on it and the contribution months.
    // Counted here because the names are already enumerated above; what this
    // assertion is for is the *privilege*, and the count catches a view that
    // arrived with more than SELECT — which is exactly what the Phase 10
    // views did in their first draft, and what the Polytos Phase 2 tables did
    // in theirs, until these assertions said so.
    // Two more from Polytos Phase 3: the member-loan eligibility register
    // and the member-loan register. And six from Polytos Phase 4: the claim
    // register and the portal's read of it, the beneficiary register, the
    // payment register, the meeting register and the attendance register.
    expect(rows.filter((row) => row.grantee === 'authenticated')).toHaveLength(45);
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
      // Polytos Phase 1. The re-acceptance route: it records the member's
      // acceptance of a newly published policy version and moves them onto
      // it in one transaction, and it is the only route by which
      // `memberships.policy_version_id` changes. DEFINER because it writes
      // two tables a session may not write between, and it checks
      // `membership:manage_policies` on the session itself.
      'accept_membership_policy_version',
      // Polytos Phase 1. Which version is in force. DEFINER so that the rule
      // the enrolment trigger enforces and the answer a screen reads are one
      // rule; it returns an id, and the row behind it stays behind the
      // select policy.
      'active_membership_policy_id',
      // Polytos Phase 4. Every write path in the benefit and meeting modules
      // is a definer function, because every one of them enforces something a
      // session must not be able to skip: the capability, the separation of
      // duties, the policy gate, the evidence check, the journal. The
      // guards and the number-minting triggers are definer for the reason
      // every earlier phase's are — they read `profiles` and the reference
      // counter, neither of which a caller may reach.
      //
      // `benefit_claim_eligibility`, `medical_benefit_consumed`,
      // `benefit_summary` and `benefit_expense_by_type` are definer *reads*,
      // each with an explicit capability check: a cap computed from a partial
      // view of a member's history is a cap that over-approves, and a
      // business-wide aggregate has no row for a policy to filter. ADR-057's
      // rule, and the registers that report per-member rows are
      // `security_invoker` views instead.
      'add_meeting_action_item',
      'apply_eligible_penalties',
      'approve_benefit_claim',
      'approve_expense',
      'approve_loan',
      'approve_reconciliation',
      'approve_transfer',
      'assert_cash_account',
      'assert_cash_available',
      'assert_owner_admin_remains',
      'assert_postable_account',
      // Polytos Phase 3. The member-loan eligibility assessment a screen
      // reads. DEFINER because it checks `member_loans:view_eligibility` on
      // the session itself and then reads tables a caller may not join
      // across; it restates the branch rule the policy on `memberships`
      // states, because the policies do not run for a definer function and
      // that is the whole privilege-escalation risk one carries.
      'assess_benefit_claim',
      'assess_member_loan_eligibility',
      'attach_benefit_document',
      'audit_actor_label',
      'audit_attendance_corrected',
      'audit_beneficiary_decided',
      'audit_beneficiary_registered',
      'audit_benefit_claim_decided',
      'audit_benefit_claim_opened',
      'audit_benefit_document_checked',
      'audit_benefit_payment',
      'audit_client_change',
      'audit_client_guarantor_change',
      'audit_client_identity_change',
      'audit_client_remark_added',
      'audit_guarantor_change',
      'audit_guarantor_identity_change',
      'audit_loan_change',
      // Phase 13. Records that a loan's guarantor evidence was frozen at
      // approval — the kind and the row count, never the contents.
      'audit_loan_guarantors_frozen',
      // Phase 12. A product holds the rate the business lends at, so a
      // change to one is audited the way a change to business_settings is.
      'audit_loan_product_change',
      'audit_loan_schedule_generated',
      'audit_loan_snapshot_created',
      'audit_loan_terms_locked',
      // Polytos Phase 1. The three membership audit triggers.
      // Polytos Phase 2. The audit triggers, the number minters, the guards
      // and the posting functions. Every posting function is DEFINER
      // because it writes a journal, and no session may write one; every
      // guard is DEFINER because it reads `user_has_permission` and
      // `current_profile_id`. EXECUTE is revoked from anon and
      // authenticated on all of them but the ones listed in the next
      // assertion.
      // Polytos Phase 3. Two statement-level audit triggers: one records that
      // an eligibility assessment was frozen onto a loan, the other that
      // savings capacity was pledged to it and returned when it closed.
      // Neither carries a name, a phone number or a savings balance — the
      // trail is read by `audit:view`, which is broader than
      // `loans:view_sensitive`.
      'audit_meeting_event',
      'audit_member_loan_assessed',
      'audit_member_loan_pledge',
      'audit_membership_card_change',
      'audit_membership_change',
      'audit_membership_fee_change',
      'audit_membership_policy_change',
      'audit_membership_terms_accepted',
      'audit_payment_allocated',
      'audit_payment_change',
      'audit_penalty_applied',
      'audit_profile_change',
      'audit_savings_account_change',
      'audit_savings_transaction',
      'audit_savings_withdrawal_change',
      'audit_settings_change',
      'audit_user_role_change',
      'backfill_ledger_history',
      'begin_benefit_verification',
      'benefit_claim_documents_delete_guard',
      'benefit_claim_documents_guard',
      'benefit_claim_eligibility',
      'benefit_claims_assign_number',
      'benefit_claims_guard',
      'benefit_expense_account',
      'benefit_expense_by_type',
      'benefit_payments_assign_number',
      'benefit_payments_guard',
      'benefit_summary',
      'benefits_blocked_reason',
      'branch_cash_account',
      'business_now',
      // Phase 12. The other half of the guard rail: a change to
      // business_settings that would strand an active product is refused.
      'business_settings_keep_products_valid',
      'business_timezone',
      'cancel_benefit_claim',
      'cancel_loan',
      // Phase 12. Freezing the product terms writes an append-only table no
      // session may write, and the two trigger functions enforce the
      // product's own bounds and supply a default. None is granted to
      // `authenticated`.
      'cancel_membership_meeting',
      'cancel_savings_withdrawal',
      'capture_loan_product_snapshot',
      'client_guarantors_guard_detach',
      'client_has_live_loan',
      'client_remarks_stamp_author',
      'clients_assign_client_number',
      'clients_guard_privileged_columns',
      'clients_stamp_branch',
      'clients_stamp_provenance',
      'confirm_password_change',
      'consume_rate_limit',
      'current_profile_id',
      'current_session_context',
      'current_user_branch_id',
      'current_user_max_rank',
      'current_user_permissions',
      'current_user_role_keys',
      'decide_savings_withdrawal',
      'disburse_loan',
      'enrol_member',
      'ensure_penalty_applied',
      'finalise_meeting_minutes',
      'generate_loan_schedule',
      'guarantor_consent_terms_guard',
      'guarantors_guard_privileged_columns',
      'guarantors_stamp_provenance',
      'issue_membership_card',
      'issue_membership_consent_code',
      'journal_assert_balanced',
      'journal_entries_assert_balanced',
      'journal_entries_guard_update',
      'journal_lines_assert_balanced',
      'ledger_account_balance',
      'ledger_account_balance_as_of',
      'ledger_account_by_code',
      'link_client_profile',
      'loan_application_details_guard',
      'loan_application_details_stamp_actor',
      // Phase 14. Freezes a pledged item's identity once the loan is live,
      // stamps who released or realised it, and refuses a status that moves
      // backwards.
      'loan_collateral_guard',
      // Phase 13. Confines a document write to a draft, stamps the uploader,
      // and keeps a stored document pointing where it was filed.
      'loan_documents_guard',
      'loan_guarantors_check_eligibility',
      'loan_guarantors_guard_removal',
      'loan_guarantors_guard_snapshot',
      'loan_guarantors_stamp_actor',
      'loan_payments_assign_number',
      'loan_payments_guard_mutation',
      'loan_products_stamp_actor',
      'loan_products_within_business_rules',
      // Phase 14. Derives the author from the session, refuses recovery
      // activity on a loan that was never disbursed, and keeps a correction
      // on its own loan.
      'loan_recovery_actions_stamp_author',
      'loans_assign_loan_number',
      'loans_enforce_active_limit',
      // Polytos Phase 3. Makes `membership_id` and `interest_basis` on a loan
      // write-once at approval, for every caller including service_role. A
      // second trigger rather than an edit to `loans_guard_transition`, so the
      // Phase 4 state machine and the Phase 3 member terms can be reviewed and
      // reverted separately.
      'loans_guard_member_terms',
      'loans_guard_transition',
      'loans_stamp_branch',
      'loans_stamp_product',
      // Phase 15. The one writer of the stream, and the ten triggers that
      // call it. Every one is a trigger function or definer-only: none is
      // granted to `authenticated`, which the next assertion checks.
      // Polytos Phase 3. The advisory lock that serialises a member loan
      // approval against a savings withdrawal. DEFINER and revoked from every
      // application role: a caller able to take it at will could hold a
      // member's savings capacity shut. One function rather than the key
      // written out at two call sites, because an advisory lock written twice
      // drifts onto two keys and then fails silently by never blocking.
      'lock_savings_capacity',
      'mark_meeting_attendance',
      'mark_notifications_read',
      // Polytos Phase 3. The member-loan machinery.
      //
      // `member_loan_eligibility_of` is the authoritative assessment, DEFINER
      // and unreachable from a session — the arrangement
      // `generate_loan_schedule` has, and for the same reason: its only
      // legitimate callers are other privileged functions that have already
      // decided who may act. `assess_member_loan_eligibility`, above, is the
      // one a screen reaches, and it checks the capability.
      //
      // `member_lending_blocked_reason` is DEFINER and granted, because it is
      // what a configuration screen names the missing decision from and must
      // answer the same way for every caller. It discloses which of the
      // client's own policy questions are open, about a version the caller
      // has already named.
      //
      // The two guards are triggers, like every other guard here.
      //
      // `member_loan_interest` and `member_loan_cadence_for_term` are
      // deliberately **absent**: both are pure functions of their arguments,
      // so neither needs to run as the owner — which is the same reason
      // `calculate_loan_breakdown` is not here.
      'medical_benefit_consumed',
      'member_beneficiaries_assign_number',
      'member_beneficiaries_guard',
      'member_lending_blocked_reason',
      'member_loan_eligibility_of',
      'member_loan_pledges_guard',
      'member_loan_release_pledge',
      // Polytos Phase 3. The dashboard in one round trip. DEFINER and granted,
      // because it reports business-wide aggregates: there is no *row* for a
      // policy to filter, so it asks for `loans:view` in so many words — the
      // same arrangement `savings_summary` has, and for the same reason.
      'member_loan_summary',
      // Polytos Phase 1. The membership guards and the number minter.
      // SECURITY DEFINER for the reason every guard here is: they read
      // `user_has_permission` and `current_profile_id`, and they write
      // `membership_status_history`, which no session may write. EXECUTE is
      // revoked from `anon` and `authenticated` on every one, which the
      // assertion below enforces.
      //
      // The three that are *not* triggers are DEFINER for a different
      // reason, and each is granted to `authenticated` below:
      //
      //   `accept_membership_policy_version` writes the member's acceptance
      //   and moves them onto the new version in one transaction. It is the
      //   only route by which `memberships.policy_version_id` changes, and
      //   it checks `membership:manage_policies` itself.
      //
      //   `active_membership_policy_id` and `membership_policy_allows` are
      //   what the enrolment rule is written against, so they must give the
      //   same answer to every caller. Each returns an opaque id or a
      //   boolean; the rows behind them stay governed by the select policy.
      //
      // Two Polytos Phase 2 functions are deliberately **absent** from this
      // list: `savings_statement` and `member_savings_qualification` are
      // SECURITY INVOKER, because each reads a member's savings and the
      // policies on `savings_transactions` are what decide who may. They
      // were definer in the first draft, and `rls-savings.test.ts` caught
      // what that meant: any signed-in caller could read any member's full
      // statement by passing an account id. `savings_summary` stays definer
      // beside them because it reports the business as a whole, where there
      // is no row for a policy to filter, so it asks for
      // `savings:view_reports` in so many words.
      'membership_cards_assign_number',
      'membership_cards_guard',
      'membership_fee_is_posted',
      'membership_fee_receipts_assign_number',
      'membership_fee_receipts_guard',
      'membership_meetings_assign_number',
      'membership_meetings_guard',
      'membership_policy_allows',
      'membership_policy_versions_guard',
      'membership_terms_acceptances_guard',
      'membership_terms_are_accepted',
      'memberships_assign_number',
      'memberships_guard_transition',
      'memberships_record_status',
      'memberships_stamp_provenance',
      'next_reference',
      'notify_beneficiary_awaiting_verification',
      'notify_benefit_claim_transition',
      'notify_client_blacklisted',
      'notify_collateral_realised',
      'notify_expense_pending',
      'notify_loan_transition',
      'notify_low_float',
      'notify_meeting_action_assigned',
      'notify_meeting_moved',
      'notify_meeting_scheduled',
      'notify_payment_reversed',
      'notify_penalty_applied',
      'notify_promise_recorded',
      'notify_reconciliation_variance',
      'notify_transfer_pending',
      'open_benefit_claim',
      'open_savings_account',
      'post_benefit_payment',
      'post_disbursement_journal',
      'post_expense_journal',
      'post_journal',
      'post_payment',
      'post_repayment_journal',
      'post_reversal_journal',
      'post_savings_deposit',
      'post_savings_withdrawal',
      'post_transfer_journal',
      'profiles_assert_owner_remains',
      'profiles_guard_privileged_columns',
      'profiles_stamp_password_set_at',
      'purge_expired_rate_limits',
      // Phase 15. The only writer of the notification stream. Definer-only
      // and granted to nobody: a session that could raise a notification
      // could address one to any capability it liked.
      'raise_notification',
      'record_audit_event',
      'record_expense',
      'record_meeting_minutes',
      'record_membership_fee',
      'record_other_income',
      'record_security_event',
      'record_sign_in',
      'record_transfer',
      'redeem_membership_consent_code',
      'register_member_beneficiary',
      'reject_benefit_claim',
      'reject_expense',
      'reject_loan',
      'reject_reconciliation',
      'reject_transfer',
      // Phase 14. Lets a guarantor out of a live loan, with a reason, provided
      // the loan keeps the number of guarantors its product requires.
      'release_loan_guarantor',
      'repayment_frequencies_guard_identity',
      'request_benefit_information',
      'request_savings_withdrawal',
      'reschedule_membership_meeting',
      'reverse_benefit_payment',
      'reverse_expense',
      'reverse_membership_fee',
      'reverse_other_income',
      'reverse_payment',
      'reverse_savings_transaction',
      'reverse_transfer',
      // Phase 18. The Settings screen's read-only view of reference
      // numbering. SECURITY DEFINER so it can read `reference_sequences`,
      // which stays default-deny to every session; it re-checks
      // `settings:view` inside, because the grant alone decides nothing.
      'revoke_member_beneficiary',
      'savings_accounts_assign_number',
      'savings_accounts_guard',
      'savings_accounts_stamp_provenance',
      // Polytos Phase 3. Each answers one figure about an account the caller
      // has already named, and both are what the policy's live-loan rule is
      // written against — so they must give the same answer to every caller.
      'savings_pledged_amount',
      'savings_summary',
      'savings_transactions_assign_number',
      'savings_withdrawable_amount',
      'savings_withdrawal_requests_assign_number',
      'savings_withdrawal_requests_guard',
      'schedule_membership_meeting',
      'settings_reference_sequences',
      'submit_benefit_claim',
      'submit_reconciliation',
      'update_meeting_action_item',
      'user_can_see_branch',
      'user_has_at_least_role',
      'user_has_permission',
      'user_has_role',
      'user_roles_assert_owner_remains',
      'user_roles_guard_assignment',
      'user_roles_set_granted_by',
      'validate_loan_for_approval',
      'verify_benefit_document',
      'verify_member_beneficiary',
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
    // `accept_membership_policy_version` is the exception that proves it: it
    // names a membership and a policy version, and it is granted because it
    // checks `membership:manage_policies` on the session before it writes
    // anything, refuses a version that is not approved and in force, and
    // records the member's signature as the evidence of the move. Its
    // refusals are asserted in tests/db/membership-hardening.test.ts.
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
      // Polytos Phase 1. The re-acceptance route. See the note above.
      'accept_membership_policy_version',
      // Polytos Phase 1. Which membership policy version is in force —
      // active, approved and started. SECURITY DEFINER, so that the rule the
      // enrolment trigger enforces and the answer a screen reads are the
      // same rule. It returns an id and nothing else; the row behind it is
      // still governed by `membership_policy_versions_select`.
      'active_membership_policy_id',
      // Polytos Phase 4. The lifecycle functions a screen calls, the two
      // reporting functions the dashboards read, and the pure helpers a
      // caller may evaluate — `benefit_amount_for_claim`,
      // `benefit_policy_year_bounds` and `benefit_claim_transition_allowed`
      // disclose nothing: they are the arithmetic and the edge list, and a
      // caller who runs them learns what the published policy already says.
      //
      // The guards, the audit triggers, the notification triggers and the
      // number minters are **absent**, as they are in every earlier phase:
      // nothing calls them but PostgreSQL.
      'add_meeting_action_item',
      'approve_benefit_claim',
      'approve_expense',
      'approve_loan',
      'approve_reconciliation',
      'approve_transfer',
      // Polytos Phase 3. Granted because a screen reads it, and safe to grant
      // for the reason this list is about: it checks
      // `member_loans:view_eligibility` on the session and restates the
      // branch rule before it reads anything, and an invisible client and a
      // nonexistent one give it the same answer.
      'assess_benefit_claim',
      'assess_member_loan_eligibility',
      // Phase 7. The business clock and the timezone it is read in. Granted
      // because every screen needs to know what "today" means to the
      // business, and because a date is not sensitive. Neither accepts a
      // date from a caller: `business_now` honours an override only on a
      // direct owner connection, which no application path has.
      'attach_benefit_document',
      'begin_benefit_verification',
      'benefit_amount_for_claim',
      'benefit_claim_eligibility',
      'benefit_claim_transition_allowed',
      'benefit_expense_account',
      'benefit_expense_by_type',
      'benefit_policy_year_bounds',
      'benefit_summary',
      'benefits_blocked_reason',
      'business_date',
      'business_now',
      'business_timezone',
      // Pure arithmetic: a function of its arguments that discloses nothing.
      // The preview screen calls it so staff see the authoritative figures
      // rather than the browser's.
      'calculate_loan_breakdown',
      'cancel_benefit_claim',
      'cancel_loan',
      // Phase 9. The rate limiter. Granted to `authenticated` so a signed-in
      // caller's own budget is consumed on the path they are using; **not**
      // granted to `anon`, because an anonymous caller who could consume a
      // bucket could exhaust a chosen account's sign-in budget and lock that
      // person out. The pre-authentication path goes through the server.
      // Polytos Phase 2. The membership and savings workflow functions.
      // Each names a record rather than a person, and each checks its own
      // capability on the session before it writes anything — which is why
      // they are reachable from a session at all. Their refusals are
      // asserted in tests/db/savings.test.ts and rls-savings.test.ts.
      'cancel_membership_meeting',
      'cancel_savings_withdrawal',
      'client_has_live_loan',
      'consume_rate_limit',
      'current_profile_id',
      // Phase 18. The whole session in one round trip: the caller's active
      // profile, their role keys, and why not when there is none. Granted
      // because it is the read every authenticated request already made as
      // three — `getClaims()`, a `profiles` select and a `user_roles` select
      // — and it discloses strictly less than those three did. It resolves
      // the profile through `current_profile_id()`, so it can only ever
      // return the caller's own row, and only while that account is active.
      'current_session_context',
      // Phase 18. The caller's own branch, hoisted out of the per-row branch
      // check so a policy resolves it once per statement instead of once per
      // candidate row. Granted for the same reason `current_profile_id` is:
      // it answers a question about the caller and nobody else, and it
      // discloses nothing a caller does not already know about themselves.
      // It reads `profiles` through `current_profile_id()`, so a suspended
      // account resolves no branch at all.
      'current_user_branch_id',
      'current_user_max_rank',
      'current_user_permissions',
      'current_user_role_keys',
      'decide_savings_withdrawal',
      'disburse_loan',
      // Phase 13. The existing clients who could back an application, each
      // with the reasons they may not. SECURITY INVOKER, so a caller sees
      // exactly the clients their own policies admit. Advice only: the
      // trigger and the approval validator are the enforcement.
      'enrol_member',
      'finalise_meeting_minutes',
      'guarantor_candidates',
      // Phase 6. SECURITY INVOKER, so a session reading a balance sees only
      // what Row Level Security allows it to.
      // Phase 11. One account's balance, for the finance screens. A read
      // of a figure the ledger already publishes through
      // `ledger_account_balances`, so the grant adds no reach.
      'issue_membership_card',
      'issue_membership_consent_code',
      'ledger_account_balance',
      'loan_outstanding',
      // Phase 7, all three SECURITY INVOKER for the same reason. The as-of
      // balance is a read-only historical figure: no mutation accepts a date,
      // so nothing a caller passes here can change what is posted.
      'loan_outstanding_as_of',
      'loan_penalty_outstanding',
      'loan_total_outstanding',
      // Phase 15. Acts on the calling user alone: the profile whose read
      // receipts it writes is derived from the session, never passed, so the
      // array of ids a caller supplies can only narrow what *they* can
      // already see. Nothing to forge.
      'mark_meeting_attendance',
      'mark_notifications_read',
      'mask_nin',
      // Polytos Phase 1. The gate every later phase posts behind: whether one
      // named activity is open on this version today. Granted for the same
      // reason `active_membership_policy_id` is — a gate that answers
      // differently depending on who asks is not a gate. It discloses one
      // boolean about a version the caller has already named.
      // Polytos Phase 3. Three reads and the price of a member loan.
      //
      // `member_lending_blocked_reason` names which of the client's own
      // undecided policy questions is holding member lending up, about a
      // version the caller has already named. It is what the configuration
      // screen and the eligibility panel say instead of only refusing.
      //
      // `member_loan_interest` and `member_loan_cadence_for_term` are granted
      // for the reason `calculate_loan_breakdown` is: each is a pure function
      // of its arguments that discloses nothing, and the application preview
      // calls it so that staff see the authoritative figures rather than the
      // browser's.
      'medical_benefit_consumed',
      'member_lending_blocked_reason',
      'member_loan_cadence_for_term',
      'member_loan_interest',
      // Polytos Phase 3. Granted because the dashboard reads it, and safe to
      // grant for the reason this list is about: it re-checks `loans:view` on
      // the session before it reads anything.
      'member_loan_summary',
      'member_primary_beneficiary',
      'member_savings_qualification',
      'membership_fee_is_posted',
      'membership_policy_allows',
      'membership_terms_are_accepted',
      // Polytos Phase 3. The calendar-monthly collection date rule, granted
      // for the same reason: pure, immutable, and the one place the rule is
      // stated, so the preview and the generator cannot disagree about it.
      'monthly_collection_date',
      'open_benefit_claim',
      'open_savings_account',
      'payment_business_date',
      // Phase 10. Pure mapping from a payment method to the account it lands in. Immutable, takes no identity and reads nothing, so a signed-in caller may resolve it.
      'payment_method_cash_kind',
      // Phase 6. The two trusted ledger paths. Each re-checks the caller's
      // capability inside, because SECURITY DEFINER means the grant alone
      // decides nothing.
      'post_benefit_payment',
      'post_payment',
      // Phase 11. The four money-movement writers and their decisions.
      // Granted for the same reason `post_payment` is: the application
      // calls them as the signed-in person, and each re-checks the
      // capability inside, because SECURITY DEFINER means the grant alone
      // decides nothing. The *_journal helpers are deliberately absent —
      // they post without writing a document, and nothing but their own
      // callers should reach them.
      'post_savings_deposit',
      'post_savings_withdrawal',
      'record_expense',
      'record_meeting_minutes',
      'record_membership_fee',
      'record_other_income',
      'record_security_event',
      'record_sign_in',
      'record_transfer',
      'redeem_membership_consent_code',
      'register_member_beneficiary',
      'reject_benefit_claim',
      'reject_expense',
      'reject_loan',
      'reject_reconciliation',
      'reject_transfer',
      'release_loan_guarantor',
      'request_benefit_information',
      'request_savings_withdrawal',
      'reschedule_membership_meeting',
      'reverse_benefit_payment',
      'reverse_expense',
      'reverse_membership_fee',
      'reverse_other_income',
      'reverse_payment',
      'reverse_savings_transaction',
      'reverse_transfer',
      // Phase 18. Granted to `authenticated` so the Settings screen reads the
      // reference counters as the signed-in Owner. It re-checks
      // `settings:view` inside and reads a table no session may touch
      // directly, so the grant hands a caller nothing the page does not.
      // Polytos Phase 3. Each answers one figure about an account the caller
      // has already named, and both are what the policy's live-loan rule is
      // written against — so they must give the same answer to every caller.
      'revoke_member_beneficiary',
      'savings_pledged_amount',
      'savings_statement',
      'savings_summary',
      'savings_withdrawable_amount',
      'schedule_membership_meeting',
      'settings_reference_sequences',
      'storage_path_claim_id',
      'storage_path_client_id',
      'storage_path_guarantor_id',
      'storage_path_is_beneficiary',
      'storage_path_kind',
      // Phase 13. Reads the path of a loan-documents object, for the three
      // storage policies that gate the bucket.
      'storage_path_loan_id',
      'storage_path_membership_id',
      'submit_benefit_claim',
      'submit_reconciliation',
      'update_meeting_action_item',
      'user_can_see_branch',
      'user_has_at_least_role',
      'user_has_permission',
      'user_has_role',
      'validate_loan_for_approval',
      'verify_benefit_document',
      'verify_member_beneficiary',
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
  it('creates the six buckets, all private', async () => {
    const rows = await query<{
      id: string;
      public: boolean;
      file_size_limit: string | null;
      allowed_mime_types: string[] | null;
    }>(`select id, public, file_size_limit, allowed_mime_types
          from storage.buckets order by id`);

    expect(rows.map((row) => row.id)).toEqual([
      // Polytos Phase 4. Benefit evidence: hospital admissions, invoices,
      // death certificates and relationship documents. Private, like the
      // other five, and this is the one where it matters most — these are the
      // most sensitive documents this system will ever hold, and a public
      // bucket would make a leak a matter of guessing a UUID.
      'benefit-documents',
      'client-documents',
      'company-assets',
      'guarantor-documents',
      // Phase 13. The evidence filed with a loan application. Private, like
      // the other three, and for the same reason.
      'loan-documents',
      // Polytos Phase 2. Signature documents, which are the strongest form of
      // consent evidence the counter can take. Private like every other
      // bucket here, and read only by staff holding membership:view or by the
      // member whose own path it is.
      'membership-consent',
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
