-- =============================================================================
-- POLYTOS — Production demo-data cleanup
-- =============================================================================
-- Returns the POLYTOS production database to a clean operational starting point
-- while preserving the single Owner/Administrator profile, its Supabase Auth
-- identity and password, and every piece of configuration / reference data.
--
-- Target project : fszgwemtgyrbhngajpzm
-- Authored       : 2026-11-04
--
-- SAFETY MODEL
--   * One transaction. The whole script is a single DO block, so any failure or
--     failed assertion rolls back every change, including the temporary trigger
--     suspension (DDL is transactional in PostgreSQL).
--   * Defaults to DRY RUN. The block reads `polytos.cleanup_dry_run` and treats
--     an unset value as TRUE, so an accidental invocation cannot commit.
--   * Append-only guards are suspended with ALTER TABLE ... DISABLE TRIGGER USER,
--     which suspends only user triggers. Internal referential-integrity triggers
--     stay active, so every foreign key is still enforced throughout.
--   * All guards are re-enabled and asserted back to 'O' before commit.
--   * No TRUNCATE, no CASCADE, no DROP, no db reset. Ordered DELETEs only.
--
-- USAGE
--   Dry run (rollback only):
--     SELECT set_config('polytos.cleanup_dry_run', 'true',  false);  \i this_file
--   Real run (commits):
--     SELECT set_config('polytos.cleanup_dry_run', 'false', false);  \i this_file
--
--   Under psql both statements must run in the same session. The dry run always
--   ends by raising `POLYTOS_DRY_RUN_COMPLETE`, which carries the full report and
--   rolls the transaction back. That exception is the expected success signal.
--
-- Supabase Auth users are NOT removed here. Database rows must be cleared first
-- (public.profiles -> auth.users is ON DELETE RESTRICT); the three non-admin Auth
-- accounts are then removed through the supported Auth Admin API. The Owner/Admin
-- Auth identity is never touched.
-- =============================================================================

DO $cleanup$
DECLARE
  -- Owner/Admin pinned by BOTH database role and Auth UUID, never by name.
  k_owner_profile_id CONSTANT uuid := '83944cea-eba0-4cec-989b-e44528b644f6';
  k_owner_auth_id    CONSTANT uuid := '53385df0-016a-4547-9652-b5d035ef392c';
  k_owner_role       CONSTANT text := 'owner_admin';

  -- Fail-safe: anything other than an explicit 'false' means dry run.
  v_dry_run boolean := coalesce(
    nullif(current_setting('polytos.cleanup_dry_run', true), ''), 'true')::boolean;

  -- Business tables emptied completely, in child-before-parent order.
  k_empty CONSTANT text[] := ARRAY[
    -- money movement documents (must precede journal_entries)
    'account_reconciliations','account_transfers','expenses','other_income',
    'meeting_fine_payments','membership_fee_receipts','benefit_payments',
    'savings_withdrawal_requests','savings_transactions',
    -- payments and allocations
    'payment_allocations','loan_payments','loan_penalties',
    -- loan dependents
    'loan_installment_carry_forwards','loan_installments','loan_periods',
    'loan_schedules','loan_documents','loan_guarantors','loan_collateral',
    'loan_recovery_actions','loan_business_details','loan_salary_details',
    'loan_client_snapshots','loan_guarantor_snapshots','loan_identity_snapshots',
    'loan_product_snapshots','member_loan_eligibility_snapshots',
    'member_loan_savings_pledges',
    -- benefit dependents
    'benefit_assessment_snapshots','benefit_claim_documents',
    'benefit_death_confirmations','benefit_claims',
    'member_beneficiary_identities','member_beneficiaries',
    -- membership and meeting dependents
    'membership_cards','meeting_attendance_corrections','meeting_attendance',
    'meeting_fines','meeting_absence_notices','meeting_action_items',
    'membership_meetings','membership_policy_assignments',
    'membership_terms_acceptances','membership_consent_challenges',
    'membership_status_history',
    -- accounting (must precede loans and clients)
    'journal_lines','journal_entries',
    -- loans, then savings accounts, then memberships
    'loans','savings_accounts','memberships',
    -- clients and guarantors
    'client_remarks','client_identities','client_guarantors','clients',
    'guarantor_identities','guarantors',
    -- notifications and audit history
    'notification_reads','notifications','audit_log',
    -- disposable counters
    'rate_limit_counters'
  ];

  -- Additional tables whose user triggers must be suspended (partial edits).
  k_extra_guarded CONSTANT text[] := ARRAY[
    'profiles','user_roles','reference_sequences'
  ];

  -- Configuration / reference tables whose row counts must not change.
  k_preserve CONSTANT text[] := ARRAY[
    'branches','business_settings','company_settings','finance_settings',
    'ledger_accounts','loan_products','loan_product_branches',
    'permissions','role_permissions','roles',
    'repayment_frequencies','reference_formats',
    'membership_policy_versions','membership_policy_transitions',
    'beneficiary_relationships','benefit_document_kinds',
    'guarantor_consent_terms','reference_sequences'
  ];

  v_guarded        text[] := k_empty || k_extra_guarded;
  v_tbl            text;
  v_cnt            bigint;
  v_total          bigint := 0;
  v_report         text   := '';
  v_before         jsonb  := '{}'::jsonb;
  v_after          jsonb  := '{}'::jsonb;
  v_base_policies  bigint;
  v_base_triggers  bigint;
  v_base_funcs     bigint;
  v_base_migrations bigint;
  v_base_company   jsonb;
  v_base_business  jsonb;
  v_base_finance   jsonb;
  v_base_branch    jsonb;
  v_disabled       int    := 0;
  v_still_off      int;
  v_debit          bigint;
  v_credit         bigint;
BEGIN
  -- ---------------------------------------------------------------------------
  -- 0. Baseline capture (inside the transaction = true pre-cleanup state)
  -- ---------------------------------------------------------------------------
  SELECT count(*) INTO v_base_policies  FROM pg_policies WHERE schemaname = 'public';
  SELECT count(*) INTO v_base_triggers  FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE NOT t.tgisinternal AND n.nspname = 'public';
  SELECT count(*) INTO v_base_funcs     FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public';
  SELECT count(*) INTO v_base_migrations FROM supabase_migrations.schema_migrations;

  SELECT to_jsonb(c.*) INTO v_base_company  FROM public.company_settings  c;
  SELECT to_jsonb(b.*) INTO v_base_business FROM public.business_settings b;
  SELECT to_jsonb(f.*) INTO v_base_finance  FROM public.finance_settings  f;
  SELECT to_jsonb(br.*) INTO v_base_branch  FROM public.branches br;

  FOREACH v_tbl IN ARRAY (k_empty || k_preserve) LOOP
    EXECUTE format('SELECT count(*) FROM public.%I', v_tbl) INTO v_cnt;
    v_before := v_before || jsonb_build_object(v_tbl, v_cnt);
  END LOOP;

  -- ---------------------------------------------------------------------------
  -- 1. Confirm the Owner/Admin by role AND Auth UUID before changing anything
  -- ---------------------------------------------------------------------------
  PERFORM 1 FROM public.profiles p
    JOIN public.user_roles ur ON ur.profile_id = p.id
    JOIN auth.users au        ON au.id = p.auth_user_id
   WHERE p.id = k_owner_profile_id
     AND p.auth_user_id = k_owner_auth_id
     AND au.id = k_owner_auth_id
     AND ur.role_key = k_owner_role
     AND au.encrypted_password IS NOT NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION
      'ABORT: Owner/Admin % / auth % with role % and a password was not found.',
      k_owner_profile_id, k_owner_auth_id, k_owner_role;
  END IF;

  SELECT count(*) INTO v_cnt FROM public.user_roles WHERE role_key = k_owner_role;
  IF v_cnt <> 1 THEN
    RAISE EXCEPTION 'ABORT: expected exactly 1 % holder, found %.', k_owner_role, v_cnt;
  END IF;

  -- Books must balance before disposal, or the "no accounting error" claim is void.
  SELECT coalesce(sum(debit),0), coalesce(sum(credit),0)
    INTO v_debit, v_credit FROM public.journal_lines;
  IF v_debit <> v_credit THEN
    RAISE EXCEPTION 'ABORT: ledger is already unbalanced (debit % <> credit %).',
      v_debit, v_credit;
  END IF;
  v_report := v_report || format(
    E'Pre-cleanup ledger: debit=%s credit=%s (balanced)\n', v_debit, v_credit);

  -- ---------------------------------------------------------------------------
  -- 2. Suspend append-only guards (user triggers only; FK triggers stay live)
  -- ---------------------------------------------------------------------------
  FOREACH v_tbl IN ARRAY v_guarded LOOP
    EXECUTE format('ALTER TABLE public.%I DISABLE TRIGGER USER', v_tbl);
    v_disabled := v_disabled + 1;
  END LOOP;
  v_report := v_report || format(
    E'Suspended user triggers on %s tables (FK enforcement retained)\n', v_disabled);

  -- ---------------------------------------------------------------------------
  -- 3. Unlink self-referencing and circular pointers so ordered DELETEs succeed
  -- ---------------------------------------------------------------------------
  UPDATE public.journal_entries       SET reversed_by_entry_id  = NULL WHERE reversed_by_entry_id  IS NOT NULL;
  UPDATE public.client_remarks        SET retracts_remark_id    = NULL WHERE retracts_remark_id    IS NOT NULL;
  UPDATE public.loan_recovery_actions SET corrects_action_id    = NULL WHERE corrects_action_id    IS NOT NULL;
  UPDATE public.member_beneficiaries  SET supersedes_id         = NULL WHERE supersedes_id         IS NOT NULL;
  UPDATE public.membership_cards      SET superseded_by         = NULL WHERE superseded_by         IS NOT NULL;
  UPDATE public.savings_transactions  SET reverses_transaction_id = NULL, withdrawal_request_id = NULL
    WHERE reverses_transaction_id IS NOT NULL OR withdrawal_request_id IS NOT NULL;
  UPDATE public.savings_withdrawal_requests SET paid_transaction_id = NULL
    WHERE paid_transaction_id IS NOT NULL;

  -- ---------------------------------------------------------------------------
  -- 4. Delete demo business data, child before parent
  -- ---------------------------------------------------------------------------
  FOREACH v_tbl IN ARRAY k_empty LOOP
    EXECUTE format('DELETE FROM public.%I', v_tbl);
    GET DIAGNOSTICS v_cnt = ROW_COUNT;
    v_total := v_total + v_cnt;
    IF v_cnt > 0 THEN
      v_report := v_report || format(E'  deleted %-38s %s\n', v_tbl, v_cnt);
    END IF;
  END LOOP;

  -- ---------------------------------------------------------------------------
  -- 5. Remove non-admin staff role grants and profiles (owner excluded by UUID)
  -- ---------------------------------------------------------------------------
  DELETE FROM public.user_roles WHERE profile_id <> k_owner_profile_id;
  GET DIAGNOSTICS v_cnt = ROW_COUNT;
  v_total := v_total + v_cnt;
  v_report := v_report || format(E'  deleted %-38s %s\n', 'user_roles (non-admin)', v_cnt);

  DELETE FROM public.profiles WHERE id <> k_owner_profile_id;
  GET DIAGNOSTICS v_cnt = ROW_COUNT;
  v_total := v_total + v_cnt;
  v_report := v_report || format(E'  deleted %-38s %s\n', 'profiles (non-admin)', v_cnt);

  -- ---------------------------------------------------------------------------
  -- 6. Reset business reference numbering (keep the preserved branch counter)
  -- ---------------------------------------------------------------------------
  UPDATE public.reference_sequences SET last_value = 0, updated_at = now()
   WHERE scope <> 'branch' AND last_value <> 0;
  GET DIAGNOSTICS v_cnt = ROW_COUNT;
  v_report := v_report || format(
    E'  reset %-40s %s scopes (branch held at 1 for BR2601)\n',
    'reference_sequences', v_cnt);

  -- ---------------------------------------------------------------------------
  -- 7. Restore every append-only guard BEFORE any verification or commit
  -- ---------------------------------------------------------------------------
  FOREACH v_tbl IN ARRAY v_guarded LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE TRIGGER USER', v_tbl);
  END LOOP;

  SELECT count(*) INTO v_still_off FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE NOT t.tgisinternal AND n.nspname = 'public' AND t.tgenabled <> 'O';
  IF v_still_off <> 0 THEN
    RAISE EXCEPTION 'ABORT: % user trigger(s) left suspended; refusing to commit.',
      v_still_off;
  END IF;
  v_report := v_report || E'Restored all append-only guards (0 left suspended)\n';

  -- ---------------------------------------------------------------------------
  -- 8. Verification gates — any failure aborts the whole transaction
  -- ---------------------------------------------------------------------------

  -- 8a. Every targeted business table is empty.
  FOREACH v_tbl IN ARRAY k_empty LOOP
    EXECUTE format('SELECT count(*) FROM public.%I', v_tbl) INTO v_cnt;
    IF v_cnt <> 0 THEN
      RAISE EXCEPTION 'VERIFY FAIL: public.% still holds % row(s).', v_tbl, v_cnt;
    END IF;
  END LOOP;

  -- 8b. Exactly one profile, one role grant, and it is the Owner/Admin.
  SELECT count(*) INTO v_cnt FROM public.profiles;
  IF v_cnt <> 1 THEN
    RAISE EXCEPTION 'VERIFY FAIL: expected 1 profile, found %.', v_cnt;
  END IF;
  SELECT count(*) INTO v_cnt FROM public.user_roles;
  IF v_cnt <> 1 THEN
    RAISE EXCEPTION 'VERIFY FAIL: expected 1 user_roles row, found %.', v_cnt;
  END IF;
  PERFORM 1 FROM public.profiles p
    JOIN public.user_roles ur ON ur.profile_id = p.id
    JOIN auth.users au        ON au.id = p.auth_user_id
   WHERE p.id = k_owner_profile_id
     AND p.auth_user_id = k_owner_auth_id
     AND ur.role_key = k_owner_role
     AND p.status = 'active'
     AND au.encrypted_password IS NOT NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION
      'VERIFY FAIL: surviving account is not the active Owner/Admin with its password.';
  END IF;

  -- 8c. The owner's Auth identity row is intact (login path preserved).
  SELECT count(*) INTO v_cnt FROM auth.identities WHERE user_id = k_owner_auth_id;
  IF v_cnt < 1 THEN
    RAISE EXCEPTION 'VERIFY FAIL: Owner/Admin has no auth.identities row.';
  END IF;

  -- 8d. Configuration and reference row counts unchanged.
  FOREACH v_tbl IN ARRAY k_preserve LOOP
    EXECUTE format('SELECT count(*) FROM public.%I', v_tbl) INTO v_cnt;
    v_after := v_after || jsonb_build_object(v_tbl, v_cnt);
    IF v_cnt <> (v_before ->> v_tbl)::bigint THEN
      RAISE EXCEPTION 'VERIFY FAIL: preserved table public.% changed from % to %.',
        v_tbl, (v_before ->> v_tbl)::bigint, v_cnt;
    END IF;
  END LOOP;

  -- 8e. Settings and branch rows are byte-identical to the baseline.
  IF (SELECT to_jsonb(c.*) FROM public.company_settings c)  IS DISTINCT FROM v_base_company THEN
    RAISE EXCEPTION 'VERIFY FAIL: company_settings changed.';
  END IF;
  IF (SELECT to_jsonb(b.*) FROM public.business_settings b) IS DISTINCT FROM v_base_business THEN
    RAISE EXCEPTION 'VERIFY FAIL: business_settings changed.';
  END IF;
  IF (SELECT to_jsonb(f.*) FROM public.finance_settings f)  IS DISTINCT FROM v_base_finance THEN
    RAISE EXCEPTION 'VERIFY FAIL: finance_settings changed.';
  END IF;
  IF (SELECT to_jsonb(br.*) FROM public.branches br)        IS DISTINCT FROM v_base_branch THEN
    RAISE EXCEPTION 'VERIFY FAIL: branch configuration changed.';
  END IF;

  -- 8f. Accounting integrity: no lines, no entries, nothing dangling.
  SELECT coalesce(sum(debit),0), coalesce(sum(credit),0)
    INTO v_debit, v_credit FROM public.journal_lines;
  IF v_debit <> 0 OR v_credit <> 0 THEN
    RAISE EXCEPTION 'VERIFY FAIL: residual ledger activity (debit %, credit %).',
      v_debit, v_credit;
  END IF;
  SELECT count(*) INTO v_cnt FROM public.journal_lines jl
   WHERE NOT EXISTS (SELECT 1 FROM public.journal_entries je WHERE je.id = jl.entry_id);
  IF v_cnt <> 0 THEN
    RAISE EXCEPTION 'VERIFY FAIL: % orphaned journal line(s).', v_cnt;
  END IF;
  SELECT count(*) INTO v_cnt FROM public.trial_balance
   WHERE coalesce(total_debit,0) <> 0 OR coalesce(total_credit,0) <> 0;
  IF v_cnt <> 0 THEN
    RAISE EXCEPTION 'VERIFY FAIL: trial balance has % non-zero account(s).', v_cnt;
  END IF;

  -- 8g. Reference numbering ready for new operations.
  SELECT count(*) INTO v_cnt FROM public.reference_sequences
   WHERE scope <> 'branch' AND last_value <> 0;
  IF v_cnt <> 0 THEN
    RAISE EXCEPTION 'VERIFY FAIL: % reference sequence(s) not reset.', v_cnt;
  END IF;
  SELECT count(*) INTO v_cnt FROM public.reference_sequences
   WHERE scope = 'branch' AND last_value = 1;
  IF v_cnt <> 1 THEN
    RAISE EXCEPTION 'VERIFY FAIL: branch reference counter was not held at 1.';
  END IF;

  -- 8h. Security surface and migration history untouched.
  SELECT count(*) INTO v_cnt FROM pg_policies WHERE schemaname = 'public';
  IF v_cnt <> v_base_policies THEN
    RAISE EXCEPTION 'VERIFY FAIL: RLS policies changed from % to %.', v_base_policies, v_cnt;
  END IF;
  SELECT count(*) INTO v_cnt FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE NOT t.tgisinternal AND n.nspname = 'public';
  IF v_cnt <> v_base_triggers THEN
    RAISE EXCEPTION 'VERIFY FAIL: user triggers changed from % to %.', v_base_triggers, v_cnt;
  END IF;
  SELECT count(*) INTO v_cnt FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public';
  IF v_cnt <> v_base_funcs THEN
    RAISE EXCEPTION 'VERIFY FAIL: functions changed from % to %.', v_base_funcs, v_cnt;
  END IF;
  SELECT count(*) INTO v_cnt FROM supabase_migrations.schema_migrations;
  IF v_cnt <> v_base_migrations OR v_cnt <> 161 THEN
    RAISE EXCEPTION 'VERIFY FAIL: migrations changed (% -> %, expected 161).',
      v_base_migrations, v_cnt;
  END IF;
  SELECT count(*) INTO v_cnt FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind = 'r' AND NOT c.relrowsecurity;
  IF v_cnt <> 0 THEN
    RAISE EXCEPTION 'VERIFY FAIL: % table(s) left without RLS.', v_cnt;
  END IF;

  v_report := v_report || format(
    E'All verification gates passed. Rows deleted: %s\n'
     'Preserved: policies=%s triggers=%s functions=%s migrations=%s\n'
     'Remaining Auth cleanup (outside this transaction): 3 non-admin auth.users\n',
    v_total, v_base_policies, v_base_triggers, v_base_funcs, v_base_migrations);

  -- ---------------------------------------------------------------------------
  -- 9. Commit, or roll the entire dry run back
  -- ---------------------------------------------------------------------------
  IF v_dry_run THEN
    RAISE EXCEPTION E'POLYTOS_DRY_RUN_COMPLETE — no changes committed\n%', v_report
      USING ERRCODE = 'P0001';
  END IF;

  RAISE NOTICE E'POLYTOS_CLEANUP_COMMITTED\n%', v_report;
END
$cleanup$;
