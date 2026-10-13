-- ===========================================================================
-- Phase 18 — the authorization predicates are evaluated once per statement
--
-- ## What was wrong
--
-- Every Phase 2 policy is written against `public.user_has_permission(...)`,
-- which is right: the capability matrix is the one place authorization is
-- decided, and a policy that re-derived it from role keys would eventually
-- disagree with it. But the call was written bare —
--
--   using (public.user_has_permission('loans:view'))
--
-- — and a function call in a policy predicate is evaluated for every
-- candidate row PostgreSQL considers, not once for the statement. The
-- function is STABLE, which permits caching within a statement but does not
-- require it, and the planner does not cache a call it evaluates as a
-- qualifier.
--
-- Measured on the end-to-end harness against a seeded book of **fourteen**
-- loans, one read of `loan_workflow_register` — the query behind the loan
-- register, which returns twenty-one rows — invoked
-- `public.user_has_permission` **20,524 times** and touched 245,004 shared
-- buffers. The same read as the table owner, where no policy applies, took
-- 15.8 ms; as `authenticated` it took 3,209 ms. Two hundred times the cost,
-- all of it authorization being re-decided per row.
--
-- That is why the application felt slow everywhere at once rather than on one
-- screen: the overhead is per row examined, so it scaled with the size of the
-- book on every page that reads the book.
--
-- ## What this does
--
-- Wraps each constant-argument helper call in a scalar subquery:
--
--   using ((select public.user_has_permission('loans:view')))
--
-- A subquery with no outer references is planned as an **InitPlan** and
-- evaluated exactly once per statement execution, with the result reused for
-- every row. This is the documented shape for Supabase policies, and the
-- reason it is safe to apply mechanically is that it changes *when* the
-- predicate is evaluated and nothing else:
--
--   * the function is unchanged, so it still reads `user_roles` and
--     `role_permissions` through `current_profile_id()`, which still resolves
--     only ACTIVE profiles;
--   * the predicate returns the same boolean it returned before, for the same
--     caller, on the same row;
--   * a suspended account still resolves to NULL and still sees nothing, on
--     the very next statement rather than when its token expires.
--
-- Nothing is widened. No policy gains a branch, a role or a row it did not
-- already admit, and no `USING` clause becomes `true`. The accompanying
-- database tests assert the whole visibility matrix per role, before and
-- after, and `tests/db/rls-hoisting.test.ts` asserts specifically that the
-- rewritten predicates admit exactly the same rows as the originals.
--
-- ## The branch predicate, which could not simply be wrapped
--
-- `public.user_can_see_branch(branch_id)` takes the row's own branch, so it
-- is correlated and cannot become an InitPlan. It is also SECURITY DEFINER,
-- which means PostgreSQL will not inline it — so it stayed a real function
-- call per row, each one running two `EXISTS` queries against `profiles`.
--
-- The predicate is therefore restated in the policies as the thing it
-- actually asks, with the caller's own branch hoisted:
--
--   branch_id is null
--   or (select public.current_user_branch_id()) is null
--   or branch_id = (select public.current_user_branch_id())
--
-- which is the same three-way test, term for term:
--
--   | original                                              | restated                                  |
--   | ----------------------------------------------------- | ----------------------------------------- |
--   | `p_branch_id is null`                                 | `branch_id is null`                       |
--   | no profile, or the caller's profile has no branch     | caller's branch is NULL                   |
--   | the caller's profile has exactly this branch          | `branch_id = ` the caller's branch        |
--
-- `public.user_can_see_branch` itself is kept, re-expressed on top of the new
-- helper so the two can never drift, because it is still the right thing for
-- a function body to call and it is part of the Phase 2 surface.
--
-- ## Nothing here touches money
--
-- No view, function, trigger or constraint that computes a balance, an
-- interest figure, a penalty or a schedule is altered by this migration. It
-- changes policy predicates and adds one read-only helper.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- The caller's branch, resolved once
--
-- NULL means "not restricted to a branch" — either the account has no branch
-- or there is no active profile at all. Both already read as unrestricted in
-- `user_can_see_branch`, and both still do: an account with no active profile
-- resolves no rows anyway, because every policy also requires a capability
-- and `user_has_permission` is false without a profile.
-- ---------------------------------------------------------------------------
create or replace function public.current_user_branch_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select p.branch_id
  from public.profiles p
  where p.id = (select public.current_profile_id())
$$;

comment on function public.current_user_branch_id() is
  'Branch of the authenticated, active user, or NULL when they are not restricted to one. Hoisted out of per-row branch checks so a policy evaluates it once per statement.';

revoke all on function public.current_user_branch_id() from public, anon, authenticated;
grant execute on function public.current_user_branch_id() to authenticated;

-- ---------------------------------------------------------------------------
-- The two existing helpers, with their own internal lookups hoisted
--
-- Same bodies, same results. `(select public.current_profile_id())` inside
-- them is an InitPlan of the function's own query, so a single invocation no
-- longer resolves the profile twice.
-- ---------------------------------------------------------------------------
create or replace function public.user_can_see_branch(p_branch_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select
    p_branch_id is null
    or (select public.current_user_branch_id()) is null
    or p_branch_id = (select public.current_user_branch_id())
$$;

comment on function public.user_can_see_branch(uuid) is
  'True when the authenticated user may see rows belonging to this branch: the row has no branch, the user is not restricted to one, or it is theirs. Re-expressed in Phase 18 on top of current_user_branch_id() so the policies and this function cannot drift.';

create or replace function public.user_has_permission(p_permission_key text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.user_roles ur
    join public.role_permissions rp on rp.role_key = ur.role_key
    where ur.profile_id = (select public.current_profile_id())
      and rp.permission_key = p_permission_key
  )
$$;

comment on function public.user_has_permission(text) is
  'True when the authenticated, ACTIVE user holds a role granting this capability. Returns false for an unknown permission key, an inactive account, or no session.';

-- ---------------------------------------------------------------------------
-- Every policy that calls a helper with a constant argument
--
-- Generated from the live catalogue and emitted explicitly, so this file says
-- exactly what each predicate becomes rather than computing it at run time.
-- The policies absent from this list are the ones that call no helper: the
-- reference tables (`roles`, `permissions`, `role_permissions`,
-- `repayment_frequencies`, `guarantor_consent_terms`) and the two that reach
-- their parent row through an EXISTS alone (`loan_periods`,
-- `payment_allocations`).
-- ---------------------------------------------------------------------------

alter policy account_reconciliations_select_with_permission on public.account_reconciliations
  using (((select public.user_has_permission('reconciliation:view'::text)) AND (branch_id is null or (select public.current_user_branch_id()) is null or branch_id = (select public.current_user_branch_id()))));

alter policy account_transfers_select_with_permission on public.account_transfers
  using (((select public.user_has_permission('transfers:view'::text)) AND (branch_id is null or (select public.current_user_branch_id()) is null or branch_id = (select public.current_user_branch_id()))));

alter policy audit_log_select_with_permission on public.audit_log
  using ((select public.user_has_permission('audit:view'::text)));

alter policy branches_select_with_permission on public.branches
  using ((select public.user_has_permission('branches:view'::text)));

alter policy business_settings_select_with_permission on public.business_settings
  using ((select public.user_has_permission('settings:view'::text)));

alter policy business_settings_update_with_permission on public.business_settings
  using ((select public.user_has_permission('settings:update'::text)))
  with check ((select public.user_has_permission('settings:update'::text)));

alter policy client_guarantors_insert_with_permission on public.client_guarantors
  with check (((select public.user_has_permission('guarantors:link'::text)) AND active));

alter policy client_guarantors_select_with_permission on public.client_guarantors
  using ((select public.user_has_permission('guarantors:view'::text)));

alter policy client_guarantors_update_with_permission on public.client_guarantors
  using ((select public.user_has_permission('guarantors:link'::text)))
  with check ((select public.user_has_permission('guarantors:link'::text)));

alter policy client_identities_insert_with_permission on public.client_identities
  with check ((select public.user_has_permission('clients:create'::text)));

alter policy client_identities_select_with_permission on public.client_identities
  using ((select public.user_has_permission('clients:view_nin'::text)));

alter policy client_identities_update_with_permission on public.client_identities
  using (((select public.user_has_permission('clients:view_nin'::text)) AND ((select public.user_has_permission('clients:update'::text)) OR (select public.user_has_permission('clients:documents'::text)))))
  with check (((select public.user_has_permission('clients:view_nin'::text)) AND ((select public.user_has_permission('clients:update'::text)) OR (select public.user_has_permission('clients:documents'::text)))));

alter policy client_remarks_insert_with_permission on public.client_remarks
  with check ((select public.user_has_permission('clients:remarks_create'::text)));

alter policy client_remarks_select_with_permission on public.client_remarks
  using ((select public.user_has_permission('clients:remarks_view'::text)));

alter policy clients_insert_with_permission on public.clients
  with check (((select public.user_has_permission('clients:create'::text)) AND (status = ANY (ARRAY['active'::text, 'inactive'::text])) AND (profile_id IS NULL)));

alter policy clients_select_own_or_directory on public.clients
  using (((((profile_id IS NOT NULL) AND (profile_id = (select public.current_profile_id()))) OR (select public.user_has_permission('clients:view'::text))) AND (branch_id is null or (select public.current_user_branch_id()) is null or branch_id = (select public.current_user_branch_id()))));

alter policy clients_update_with_permission on public.clients
  using (((select public.user_has_permission('clients:update'::text)) OR (select public.user_has_permission('clients:status'::text)) OR (select public.user_has_permission('clients:blacklist'::text)) OR (select public.user_has_permission('clients:archive'::text)) OR (select public.user_has_permission('clients:documents'::text))))
  with check (((select public.user_has_permission('clients:update'::text)) OR (select public.user_has_permission('clients:status'::text)) OR (select public.user_has_permission('clients:blacklist'::text)) OR (select public.user_has_permission('clients:archive'::text)) OR (select public.user_has_permission('clients:documents'::text))));

alter policy company_settings_select_with_permission on public.company_settings
  using ((select public.user_has_permission('settings:view'::text)));

alter policy company_settings_update_with_permission on public.company_settings
  using ((select public.user_has_permission('settings:update'::text)))
  with check ((select public.user_has_permission('settings:update'::text)));

alter policy expenses_select_with_permission on public.expenses
  using (((select public.user_has_permission('expenses:view'::text)) AND (branch_id is null or (select public.current_user_branch_id()) is null or branch_id = (select public.current_user_branch_id()))));

alter policy finance_settings_select_with_permission on public.finance_settings
  using ((select public.user_has_permission('settings:view'::text)));

alter policy finance_settings_update_with_permission on public.finance_settings
  using ((select public.user_has_permission('finance:settings'::text)))
  with check ((select public.user_has_permission('finance:settings'::text)));

alter policy guarantor_consent_terms_insert_with_permission on public.guarantor_consent_terms
  with check ((select public.user_has_permission('guarantor_terms:manage'::text)));

alter policy guarantor_consent_terms_update_with_permission on public.guarantor_consent_terms
  using ((select public.user_has_permission('guarantor_terms:manage'::text)))
  with check ((select public.user_has_permission('guarantor_terms:manage'::text)));

alter policy guarantor_identities_insert_with_permission on public.guarantor_identities
  with check ((select public.user_has_permission('guarantors:create'::text)));

alter policy guarantor_identities_select_with_permission on public.guarantor_identities
  using ((select public.user_has_permission('guarantors:view_nin'::text)));

alter policy guarantor_identities_update_with_permission on public.guarantor_identities
  using (((select public.user_has_permission('guarantors:view_nin'::text)) AND (select public.user_has_permission('guarantors:update'::text))))
  with check (((select public.user_has_permission('guarantors:view_nin'::text)) AND (select public.user_has_permission('guarantors:update'::text))));

alter policy guarantors_insert_with_permission on public.guarantors
  with check ((select public.user_has_permission('guarantors:create'::text)));

alter policy guarantors_select_with_permission on public.guarantors
  using ((select public.user_has_permission('guarantors:view'::text)));

alter policy guarantors_update_with_permission on public.guarantors
  using (((select public.user_has_permission('guarantors:update'::text)) OR (select public.user_has_permission('guarantors:documents'::text))))
  with check (((select public.user_has_permission('guarantors:update'::text)) OR (select public.user_has_permission('guarantors:documents'::text))));

alter policy journal_entries_select_with_permission on public.journal_entries
  using ((select public.user_has_permission('ledger:view'::text)));

alter policy journal_lines_select_with_permission on public.journal_lines
  using ((select public.user_has_permission('ledger:view'::text)));

alter policy ledger_accounts_select_with_permission on public.ledger_accounts
  using ((select public.user_has_permission('ledger:view'::text)));

alter policy loan_business_details_insert_with_permission on public.loan_business_details
  with check ((select public.user_has_permission('loans:update_draft'::text)));

alter policy loan_business_details_select_with_permission on public.loan_business_details
  using ((select public.user_has_permission('loans:view'::text)));

alter policy loan_business_details_update_with_permission on public.loan_business_details
  using ((select public.user_has_permission('loans:update_draft'::text)))
  with check ((select public.user_has_permission('loans:update_draft'::text)));

alter policy loan_client_snapshots_select_with_permission on public.loan_client_snapshots
  using (((select public.user_has_permission('loans:view'::text)) OR (EXISTS ( SELECT 1 FROM clients c WHERE ((c.id = loan_client_snapshots.client_id) AND (c.profile_id IS NOT NULL) AND (c.profile_id = (select public.current_profile_id())))))));

alter policy loan_collateral_delete_with_permission on public.loan_collateral
  using ((select public.user_has_permission('collateral:manage'::text)));

alter policy loan_collateral_insert_with_permission on public.loan_collateral
  with check ((select public.user_has_permission('collateral:manage'::text)));

alter policy loan_collateral_select_with_permission on public.loan_collateral
  using ((select public.user_has_permission('collateral:view'::text)));

alter policy loan_collateral_update_with_permission on public.loan_collateral
  using ((select public.user_has_permission('collateral:manage'::text)))
  with check ((select public.user_has_permission('collateral:manage'::text)));

alter policy loan_documents_delete_with_permission on public.loan_documents
  using ((select public.user_has_permission('loans:documents'::text)));

alter policy loan_documents_insert_with_permission on public.loan_documents
  with check ((select public.user_has_permission('loans:documents'::text)));

alter policy loan_documents_select_with_permission on public.loan_documents
  using ((select public.user_has_permission('loans:view'::text)));

alter policy loan_documents_update_with_permission on public.loan_documents
  using ((select public.user_has_permission('loans:documents'::text)))
  with check ((select public.user_has_permission('loans:documents'::text)));

alter policy loan_guarantor_snapshots_select_with_permission on public.loan_guarantor_snapshots
  using ((select public.user_has_permission('loans:view'::text)));

alter policy loan_guarantors_delete_with_permission on public.loan_guarantors
  using (((select public.user_has_permission('loans:update_draft'::text)) AND (select public.user_has_permission('guarantors:link'::text))));

alter policy loan_guarantors_insert_with_permission on public.loan_guarantors
  with check (((select public.user_has_permission('loans:update_draft'::text)) AND (select public.user_has_permission('guarantors:link'::text))));

alter policy loan_guarantors_select_with_permission on public.loan_guarantors
  using (((select public.user_has_permission('loans:view'::text)) AND (select public.user_has_permission('guarantors:view'::text))));

alter policy loan_guarantors_update_with_permission on public.loan_guarantors
  using (((select public.user_has_permission('loans:update_draft'::text)) AND (select public.user_has_permission('guarantors:link'::text))))
  with check (((select public.user_has_permission('loans:update_draft'::text)) AND (select public.user_has_permission('guarantors:link'::text))));

alter policy loan_identity_snapshots_select_with_permission on public.loan_identity_snapshots
  using ((select public.user_has_permission('loans:view_sensitive'::text)));

alter policy loan_installments_select_with_loan on public.loan_installments
  using ((EXISTS ( SELECT 1 FROM (loans l JOIN clients c ON ((c.id = l.client_id))) WHERE ((l.id = loan_installments.loan_id) AND ((select public.user_has_permission('schedules:view'::text)) OR ((c.profile_id IS NOT NULL) AND (c.profile_id = (select public.current_profile_id()))))))));

alter policy loan_payments_select_with_loan on public.loan_payments
  using ((EXISTS ( SELECT 1 FROM (loans l JOIN clients c ON ((c.id = l.client_id))) WHERE ((l.id = loan_payments.loan_id) AND ((select public.user_has_permission('payments:view'::text)) OR ((c.profile_id IS NOT NULL) AND (c.profile_id = (select public.current_profile_id()))))))));

alter policy loan_penalties_select_with_loan on public.loan_penalties
  using ((EXISTS ( SELECT 1 FROM (loans l JOIN clients c ON ((c.id = l.client_id))) WHERE ((l.id = loan_penalties.loan_id) AND ((select public.user_has_permission('penalties:view'::text)) OR ((c.profile_id IS NOT NULL) AND (c.profile_id = (select public.current_profile_id()))))))));

alter policy loan_product_branches_delete_with_permission on public.loan_product_branches
  using ((select public.user_has_permission('products:manage'::text)));

alter policy loan_product_branches_insert_with_permission on public.loan_product_branches
  with check ((select public.user_has_permission('products:manage'::text)));

alter policy loan_product_branches_select_with_permission on public.loan_product_branches
  using ((select public.user_has_permission('products:view'::text)));

alter policy loan_product_snapshots_select_own_or_register on public.loan_product_snapshots
  using (((select public.user_has_permission('loans:view'::text)) OR (EXISTS ( SELECT 1 FROM (loans l JOIN clients c ON ((c.id = l.client_id))) WHERE ((l.id = loan_product_snapshots.loan_id) AND (c.profile_id IS NOT NULL) AND (c.profile_id = (select public.current_profile_id())))))));

alter policy loan_products_insert_with_permission on public.loan_products
  with check ((select public.user_has_permission('products:manage'::text)));

alter policy loan_products_select_with_permission on public.loan_products
  using ((select public.user_has_permission('products:view'::text)));

alter policy loan_products_update_with_permission on public.loan_products
  using ((select public.user_has_permission('products:manage'::text)))
  with check ((select public.user_has_permission('products:manage'::text)));

alter policy loan_recovery_actions_insert_with_permission on public.loan_recovery_actions
  with check ((select public.user_has_permission('recovery:record'::text)));

alter policy loan_recovery_actions_select_with_permission on public.loan_recovery_actions
  using ((select public.user_has_permission('recovery:view'::text)));

alter policy loan_salary_details_insert_with_permission on public.loan_salary_details
  with check ((select public.user_has_permission('loans:update_draft'::text)));

alter policy loan_salary_details_select_with_permission on public.loan_salary_details
  using ((select public.user_has_permission('loans:view'::text)));

alter policy loan_salary_details_update_with_permission on public.loan_salary_details
  using ((select public.user_has_permission('loans:update_draft'::text)))
  with check ((select public.user_has_permission('loans:update_draft'::text)));

alter policy loan_schedules_select_with_loan on public.loan_schedules
  using ((EXISTS ( SELECT 1 FROM (loans l JOIN clients c ON ((c.id = l.client_id))) WHERE ((l.id = loan_schedules.loan_id) AND ((select public.user_has_permission('schedules:view'::text)) OR ((c.profile_id IS NOT NULL) AND (c.profile_id = (select public.current_profile_id()))))))));

alter policy loans_insert_with_permission on public.loans
  with check (((select public.user_has_permission('loans:create'::text)) AND (status = 'draft'::text) AND (approved_at IS NULL) AND (approved_by IS NULL) AND (disbursed_at IS NULL) AND (disbursed_by IS NULL) AND (cancelled_at IS NULL) AND (submitted_at IS NULL)));

alter policy loans_select_own_or_register on public.loans
  using ((((select public.user_has_permission('loans:view'::text)) OR ((status = ANY (ARRAY['approved'::text, 'active'::text, 'cleared'::text, 'cancelled'::text])) AND (EXISTS ( SELECT 1 FROM clients c WHERE ((c.id = loans.client_id) AND (c.profile_id IS NOT NULL) AND (c.profile_id = (select public.current_profile_id()))))))) AND (branch_id is null or (select public.current_user_branch_id()) is null or branch_id = (select public.current_user_branch_id()))));

alter policy loans_update_with_permission on public.loans
  using (((select public.user_has_permission('loans:update_draft'::text)) OR (select public.user_has_permission('loans:submit'::text)) OR (select public.user_has_permission('loans:approve'::text)) OR (select public.user_has_permission('loans:disburse'::text)) OR (select public.user_has_permission('loans:cancel'::text))))
  with check (((select public.user_has_permission('loans:update_draft'::text)) OR (select public.user_has_permission('loans:submit'::text)) OR (select public.user_has_permission('loans:approve'::text)) OR (select public.user_has_permission('loans:disburse'::text)) OR (select public.user_has_permission('loans:cancel'::text))));

alter policy notification_reads_select_own on public.notification_reads
  using ((profile_id = (select public.current_profile_id())));

alter policy notifications_select_for_audience on public.notifications
  using (((select public.user_has_permission('notifications:view'::text)) AND user_has_permission(audience_permission) AND ((audience_profile_id IS NULL) OR (audience_profile_id = (select public.current_profile_id()))) AND ((audience_branch_id IS NULL) OR (audience_branch_id is null or (select public.current_user_branch_id()) is null or audience_branch_id = (select public.current_user_branch_id())))));

alter policy other_income_select_with_permission on public.other_income
  using (((select public.user_has_permission('income:view'::text)) AND (branch_id is null or (select public.current_user_branch_id()) is null or branch_id = (select public.current_user_branch_id()))));

alter policy profiles_insert_with_permission on public.profiles
  with check (((select public.user_has_permission('users:create'::text)) AND (status = ANY (ARRAY['active'::text, 'inactive'::text])) AND (must_change_password IS TRUE) AND (auth_user_id IS NULL)));

alter policy profiles_select_self_or_directory on public.profiles
  using (((id = (select public.current_profile_id())) OR (select public.user_has_permission('users:view'::text))));

alter policy profiles_update_self_or_administer on public.profiles
  using ((((id = (select public.current_profile_id())) AND (select public.user_has_permission('account:update'::text))) OR (select public.user_has_permission('users:update'::text)) OR (select public.user_has_permission('users:disable'::text)) OR (select public.user_has_permission('users:reset_password'::text))))
  with check ((((id = (select public.current_profile_id())) AND (select public.user_has_permission('account:update'::text))) OR (select public.user_has_permission('users:update'::text)) OR (select public.user_has_permission('users:disable'::text)) OR (select public.user_has_permission('users:reset_password'::text))));

alter policy repayment_frequencies_insert_with_permission on public.repayment_frequencies
  with check ((select public.user_has_permission('settings:update'::text)));

alter policy repayment_frequencies_update_with_permission on public.repayment_frequencies
  using ((select public.user_has_permission('settings:update'::text)))
  with check ((select public.user_has_permission('settings:update'::text)));

alter policy user_roles_delete_with_permission on public.user_roles
  using ((select public.user_has_permission('users:assign_role'::text)));

alter policy user_roles_insert_with_permission on public.user_roles
  with check ((select public.user_has_permission('users:assign_role'::text)));

alter policy user_roles_select_self_or_directory on public.user_roles
  using (((profile_id = (select public.current_profile_id())) OR (select public.user_has_permission('users:view'::text))));
