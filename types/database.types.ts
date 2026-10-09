/**
 * Database types for the `public` schema.
 *
 * ## How to regenerate
 *
 * This file is written in the exact shape the Supabase CLI emits, so it is a
 * drop-in replacement for generated output:
 *
 *   # against the local Supabase stack (requires Docker)
 *   npm run db:types
 *
 *   # against a hosted project
 *   npx supabase gen types typescript --project-id <ref> --schema public \
 *     > types/database.types.ts
 *
 * **Regenerate after every migration that changes the schema**, and commit the
 * result in the same pull request as the migration. The CI type check will
 * fail on code that reads a column this file does not know about, which is the
 * point: the compiler, not a code review, catches a rename.
 *
 * It is maintained by hand for Phase 1 because the project is not yet linked
 * to a Supabase project and the generator needs a running database. A database
 * integration test (`tests/db/schema-types.test.ts`) compares this file
 * against the live schema and fails on drift, so a hand edit cannot quietly
 * diverge from the migrations.
 *
 * ## Type mapping notes
 *
 *   - `bigint` columns (money, in whole shillings) appear as `number`.
 *     PostgREST serialises them as JSON numbers. Values are far below
 *     `Number.MAX_SAFE_INTEGER`, and `fromDatabaseAmount` in
 *     lib/domain/money.ts validates each one on the way in regardless.
 *   - `timestamptz` and `date` appear as `string` (ISO 8601).
 *   - `inet` appears as `string`.
 *   - Columns with a database default are optional in `Insert`.
 */

export type Json =
  string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export type Database = {
  public: {
    Tables: {
      account_transfers: {
        Row: {
          id: string;
          transfer_number: string;
          branch_id: string;
          from_account_id: string;
          to_account_id: string;
          amount: number;
          transfer_date: string;
          occurred_at: string;
          external_reference: string | null;
          description: string;
          status: string;
          initiated_by: string | null;
          initiated_by_label: string;
          approved_by: string | null;
          approved_by_label: string | null;
          approved_at: string | null;
          decision_reason: string | null;
          journal_entry_id: string | null;
          reversal_entry_id: string | null;
          reversed_at: string | null;
          reversed_by: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          transfer_number: string;
          branch_id: string;
          from_account_id: string;
          to_account_id: string;
          amount: number;
          transfer_date: string;
          occurred_at?: string;
          external_reference?: string | null;
          description: string;
          status?: string;
          initiated_by?: string | null;
          initiated_by_label?: string;
          approved_by?: string | null;
          approved_by_label?: string | null;
          approved_at?: string | null;
          decision_reason?: string | null;
          journal_entry_id?: string | null;
          reversal_entry_id?: string | null;
          reversed_at?: string | null;
          reversed_by?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          transfer_number?: string;
          branch_id?: string;
          from_account_id?: string;
          to_account_id?: string;
          amount?: number;
          transfer_date?: string;
          occurred_at?: string;
          external_reference?: string | null;
          description?: string;
          status?: string;
          initiated_by?: string | null;
          initiated_by_label?: string;
          approved_by?: string | null;
          approved_by_label?: string | null;
          approved_at?: string | null;
          decision_reason?: string | null;
          journal_entry_id?: string | null;
          reversal_entry_id?: string | null;
          reversed_at?: string | null;
          reversed_by?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      expenses: {
        Row: {
          id: string;
          expense_number: string;
          branch_id: string;
          expense_account_id: string;
          payment_account_id: string;
          amount: number;
          expense_date: string;
          occurred_at: string;
          payee: string | null;
          description: string;
          external_reference: string | null;
          receipt_path: string | null;
          status: string;
          recorded_by: string | null;
          recorded_by_label: string;
          approved_by: string | null;
          approved_by_label: string | null;
          approved_at: string | null;
          decision_reason: string | null;
          journal_entry_id: string | null;
          reversal_entry_id: string | null;
          reversed_at: string | null;
          reversed_by: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          expense_number: string;
          branch_id: string;
          expense_account_id: string;
          payment_account_id: string;
          amount: number;
          expense_date: string;
          occurred_at?: string;
          payee?: string | null;
          description: string;
          external_reference?: string | null;
          receipt_path?: string | null;
          status?: string;
          recorded_by?: string | null;
          recorded_by_label?: string;
          approved_by?: string | null;
          approved_by_label?: string | null;
          approved_at?: string | null;
          decision_reason?: string | null;
          journal_entry_id?: string | null;
          reversal_entry_id?: string | null;
          reversed_at?: string | null;
          reversed_by?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          expense_number?: string;
          branch_id?: string;
          expense_account_id?: string;
          payment_account_id?: string;
          amount?: number;
          expense_date?: string;
          occurred_at?: string;
          payee?: string | null;
          description?: string;
          external_reference?: string | null;
          receipt_path?: string | null;
          status?: string;
          recorded_by?: string | null;
          recorded_by_label?: string;
          approved_by?: string | null;
          approved_by_label?: string | null;
          approved_at?: string | null;
          decision_reason?: string | null;
          journal_entry_id?: string | null;
          reversal_entry_id?: string | null;
          reversed_at?: string | null;
          reversed_by?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      other_income: {
        Row: {
          id: string;
          income_number: string;
          branch_id: string;
          income_account_id: string;
          receiving_account_id: string;
          amount: number;
          income_date: string;
          occurred_at: string;
          payer: string | null;
          client_id: string | null;
          loan_id: string | null;
          description: string;
          external_reference: string | null;
          status: string;
          recorded_by: string | null;
          recorded_by_label: string;
          decision_reason: string | null;
          journal_entry_id: string | null;
          reversal_entry_id: string | null;
          reversed_at: string | null;
          reversed_by: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          income_number: string;
          branch_id: string;
          income_account_id: string;
          receiving_account_id: string;
          amount: number;
          income_date: string;
          occurred_at?: string;
          payer?: string | null;
          client_id?: string | null;
          loan_id?: string | null;
          description: string;
          external_reference?: string | null;
          status?: string;
          recorded_by?: string | null;
          recorded_by_label?: string;
          decision_reason?: string | null;
          journal_entry_id?: string | null;
          reversal_entry_id?: string | null;
          reversed_at?: string | null;
          reversed_by?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          income_number?: string;
          branch_id?: string;
          income_account_id?: string;
          receiving_account_id?: string;
          amount?: number;
          income_date?: string;
          occurred_at?: string;
          payer?: string | null;
          client_id?: string | null;
          loan_id?: string | null;
          description?: string;
          external_reference?: string | null;
          status?: string;
          recorded_by?: string | null;
          recorded_by_label?: string;
          decision_reason?: string | null;
          journal_entry_id?: string | null;
          reversal_entry_id?: string | null;
          reversed_at?: string | null;
          reversed_by?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      account_reconciliations: {
        Row: {
          id: string;
          reconciliation_number: string;
          branch_id: string;
          account_id: string;
          business_date: string;
          system_balance: number;
          counted_balance: number;
          variance: number;
          explanation: string | null;
          status: string;
          performed_by: string | null;
          performed_by_label: string;
          performed_at: string;
          reviewed_by: string | null;
          reviewed_by_label: string | null;
          reviewed_at: string | null;
          review_notes: string | null;
          adjustment_entry_id: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          reconciliation_number: string;
          branch_id: string;
          account_id: string;
          business_date: string;
          system_balance: number;
          counted_balance: number;
          variance?: number;
          explanation?: string | null;
          status?: string;
          performed_by?: string | null;
          performed_by_label?: string;
          performed_at?: string;
          reviewed_by?: string | null;
          reviewed_by_label?: string | null;
          reviewed_at?: string | null;
          review_notes?: string | null;
          adjustment_entry_id?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          reconciliation_number?: string;
          branch_id?: string;
          account_id?: string;
          business_date?: string;
          system_balance?: number;
          counted_balance?: number;
          variance?: number;
          explanation?: string | null;
          status?: string;
          performed_by?: string | null;
          performed_by_label?: string;
          performed_at?: string;
          reviewed_by?: string | null;
          reviewed_by_label?: string | null;
          reviewed_at?: string | null;
          review_notes?: string | null;
          adjustment_entry_id?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      finance_settings: {
        Row: {
          id: number;
          transfer_approval_threshold: number | null;
          expense_approval_threshold: number | null;
          allow_negative_cash: boolean;
          reconciliation_requires_review: boolean;
          low_balance_cash_at_hand: number;
          low_balance_mtn_mobile_money: number;
          low_balance_airtel_money: number;
          low_balance_bank: number;
          created_at: string;
          updated_at: string;
          updated_by: string | null;
        };
        Insert: {
          id?: number;
          transfer_approval_threshold?: number | null;
          expense_approval_threshold?: number | null;
          allow_negative_cash?: boolean;
          reconciliation_requires_review?: boolean;
          low_balance_cash_at_hand?: number;
          low_balance_mtn_mobile_money?: number;
          low_balance_airtel_money?: number;
          low_balance_bank?: number;
          created_at?: string;
          updated_at?: string;
          updated_by?: string | null;
        };
        Update: {
          id?: number;
          transfer_approval_threshold?: number | null;
          expense_approval_threshold?: number | null;
          allow_negative_cash?: boolean;
          reconciliation_requires_review?: boolean;
          low_balance_cash_at_hand?: number;
          low_balance_mtn_mobile_money?: number;
          low_balance_airtel_money?: number;
          low_balance_bank?: number;
          created_at?: string;
          updated_at?: string;
          updated_by?: string | null;
        };
        Relationships: [];
      };
      /**
       * Phase 10. A place the business operates from. Cash accounts belong to
       * a branch; income and expense are sliced by the branch recorded on the
       * journal entry rather than by cloning accounts per branch.
       */
      branches: {
        Row: {
          id: string;
          branch_code: string;
          name: string;
          location: string;
          district: string | null;
          phone: string | null;
          email: string | null;
          manager_profile_id: string | null;
          status: string;
          opened_on: string;
          closed_on: string | null;
          notes: string | null;
          created_by: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          branch_code: string;
          name: string;
          location: string;
          district?: string | null;
          phone?: string | null;
          email?: string | null;
          manager_profile_id?: string | null;
          status?: string;
          opened_on: string;
          closed_on?: string | null;
          notes?: string | null;
          created_by?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          branch_code?: string;
          name?: string;
          location?: string;
          district?: string | null;
          phone?: string | null;
          email?: string | null;
          manager_profile_id?: string | null;
          status?: string;
          opened_on?: string;
          closed_on?: string | null;
          notes?: string | null;
          created_by?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };

      /**
       * Phase 10. The chart of accounts. A row with a `cash_kind` is one of
       * the four places money physically sits and carries the branch holding
       * it; every other row is company-wide.
       */
      ledger_accounts: {
        Row: {
          id: string;
          code: string;
          name: string;
          account_type: string;
          normal_side: string;
          cash_kind: string | null;
          branch_id: string | null;
          institution: string | null;
          account_number: string | null;
          is_postable: boolean;
          parent_id: string | null;
          status: string;
          description: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          code: string;
          name: string;
          account_type: string;
          normal_side: string;
          cash_kind?: string | null;
          branch_id?: string | null;
          institution?: string | null;
          account_number?: string | null;
          is_postable?: boolean;
          parent_id?: string | null;
          status?: string;
          description?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          code?: string;
          name?: string;
          account_type?: string;
          normal_side?: string;
          cash_kind?: string | null;
          branch_id?: string | null;
          institution?: string | null;
          account_number?: string | null;
          is_postable?: boolean;
          parent_id?: string | null;
          status?: string;
          description?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };

      /**
       * Phase 10. The header of a balanced double-entry posting. Append-only:
       * the only permitted update is stamping the contra entry that reverses
       * it.
       */
      journal_entries: {
        Row: {
          id: string;
          entry_number: string;
          branch_id: string;
          entry_date: string;
          posted_at: string;
          description: string;
          source_type: string;
          source_id: string | null;
          loan_id: string | null;
          client_id: string | null;
          reversed_by_entry_id: string | null;
          created_by: string | null;
          created_by_label: string;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          entry_number: string;
          branch_id: string;
          entry_date: string;
          posted_at?: string;
          description: string;
          source_type: string;
          source_id?: string | null;
          loan_id?: string | null;
          client_id?: string | null;
          reversed_by_entry_id?: string | null;
          created_by?: string | null;
          created_by_label?: string;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          reversed_by_entry_id?: string | null;
          updated_at?: string;
        };
        Relationships: [];
      };

      /**
       * Phase 10. One side of one posting. Debits and credits are separate
       * columns because that is how a trial balance is read. Fully immutable.
       */
      journal_lines: {
        Row: {
          id: string;
          entry_id: string;
          line_number: number;
          account_id: string;
          debit: number;
          credit: number;
          memo: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          entry_id: string;
          line_number: number;
          account_id: string;
          debit?: number;
          credit?: number;
          memo?: string | null;
          created_at?: string;
        };
        Update: never;
        Relationships: [];
      };
      /**
       * Phase 9. Fixed-window rate limit counters. The key is a hash, so the
       * table carries no identity; it is readable by nobody and reached only
       * through `consume_rate_limit`.
       */
      rate_limit_counters: {
        Row: {
          bucket_key: string;
          action: string;
          window_started_at: string;
          window_seconds: number;
          request_count: number;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          bucket_key: string;
          action: string;
          window_started_at: string;
          window_seconds: number;
          request_count?: number;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          bucket_key?: string;
          action?: string;
          window_started_at?: string;
          window_seconds?: number;
          request_count?: number;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };

      audit_log: {
        Row: {
          id: number;
          occurred_at: string;
          actor_profile_id: string | null;
          actor_auth_user_id: string | null;
          actor_label: string;
          action: string;
          entity_type: string;
          entity_id: string | null;
          old_values: Json | null;
          new_values: Json | null;
          metadata: Json | null;
          request_id: string | null;
          ip_address: string | null;
          user_agent: string | null;
        };
        Insert: {
          id?: never;
          occurred_at?: string;
          actor_profile_id?: string | null;
          actor_auth_user_id?: string | null;
          actor_label: string;
          action: string;
          entity_type: string;
          entity_id?: string | null;
          old_values?: Json | null;
          new_values?: Json | null;
          metadata?: Json | null;
          request_id?: string | null;
          ip_address?: string | null;
          user_agent?: string | null;
        };
        /**
         * Present for shape compatibility with generated output only. The
         * table rejects every UPDATE by trigger and by privilege.
         */
        Update: {
          [_ in never]: never;
        };
        Relationships: [
          {
            foreignKeyName: 'audit_log_actor_profile_id_fkey';
            columns: ['actor_profile_id'];
            isOneToOne: false;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
        ];
      };

      business_settings: {
        Row: {
          id: number;
          min_loan_amount: number;
          max_loan_amount: number;
          default_monthly_interest_rate_bps: number;
          min_loan_term_months: number;
          max_loan_term_months: number;
          grace_period_days: number;
          penalty_rate_bps: number;
          max_active_loans_per_client: number;
          default_repayment_frequency: string;
          created_at: string;
          updated_at: string;
          updated_by: string | null;
          multi_month_min_amount: number;
          min_guarantors_required: number;
          default_interest_method: string;
        };
        Insert: {
          id?: number;
          min_loan_amount: number;
          max_loan_amount: number;
          default_monthly_interest_rate_bps: number;
          min_loan_term_months: number;
          max_loan_term_months: number;
          grace_period_days: number;
          penalty_rate_bps: number;
          max_active_loans_per_client?: number;
          default_repayment_frequency: string;
          created_at?: string;
          updated_at?: string;
          updated_by?: string | null;
          multi_month_min_amount?: number;
          min_guarantors_required?: number;
          default_interest_method?: string;
        };
        Update: {
          id?: number;
          min_loan_amount?: number;
          max_loan_amount?: number;
          default_monthly_interest_rate_bps?: number;
          min_loan_term_months?: number;
          max_loan_term_months?: number;
          grace_period_days?: number;
          penalty_rate_bps?: number;
          max_active_loans_per_client?: number;
          default_repayment_frequency?: string;
          created_at?: string;
          updated_at?: string;
          updated_by?: string | null;
          multi_month_min_amount?: number;
          min_guarantors_required?: number;
          default_interest_method?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'business_settings_default_repayment_frequency_fkey';
            columns: ['default_repayment_frequency'];
            isOneToOne: false;
            referencedRelation: 'repayment_frequencies';
            referencedColumns: ['key'];
          },
          {
            foreignKeyName: 'business_settings_updated_by_fkey';
            columns: ['updated_by'];
            isOneToOne: false;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
        ];
      };

      client_guarantors: {
        Row: {
          id: string;
          client_id: string;
          guarantor_id: string;
          relationship_to_client: string;
          active: boolean;
          detached_at: string | null;
          detached_by: string | null;
          detached_reason: string | null;
          created_by: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          client_id: string;
          guarantor_id: string;
          relationship_to_client: string;
          active?: boolean;
          detached_at?: string | null;
          detached_by?: string | null;
          detached_reason?: string | null;
          created_by?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          client_id?: string;
          guarantor_id?: string;
          relationship_to_client?: string;
          active?: boolean;
          detached_at?: string | null;
          detached_by?: string | null;
          detached_reason?: string | null;
          created_by?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      client_identities: {
        Row: {
          client_id: string;
          nin: string | null;
          id_document_path: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          client_id: string;
          nin?: string | null;
          id_document_path?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          client_id?: string;
          nin?: string | null;
          id_document_path?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      client_remarks: {
        Row: {
          id: string;
          client_id: string;
          body: string;
          category: string;
          created_by: string | null;
          created_by_label: string;
          created_at: string;
          retracts_remark_id: string | null;
        };
        Insert: {
          id?: string;
          client_id: string;
          body: string;
          category?: string;
          created_by?: string | null;
          created_by_label?: string;
          created_at?: string;
          retracts_remark_id?: string | null;
        };
        Update: {
          id?: string;
          client_id?: string;
          body?: string;
          category?: string;
          created_by?: string | null;
          created_by_label?: string;
          created_at?: string;
          retracts_remark_id?: string | null;
        };
        Relationships: [];
      };
      clients: {
        Row: {
          id: string;
          client_number: string;
          profile_id: string | null;
          full_name: string;
          sex: string;
          date_of_birth: string;
          phone: string;
          alternative_phone: string | null;
          occupation: string;
          business_type: string | null;
          village_area: string;
          district: string;
          photo_path: string | null;
          status: string;
          status_reason: string | null;
          status_changed_at: string | null;
          status_changed_by: string | null;
          notes: string | null;
          registered_at: string;
          created_by: string | null;
          created_at: string;
          updated_at: string;
          archived_at: string | null;
        };
        Insert: {
          id?: string;
          /** Assigned by the clients_assign_client_number trigger; supplying one is refused. */
          client_number?: never;
          profile_id?: string | null;
          full_name: string;
          sex: string;
          date_of_birth: string;
          phone: string;
          alternative_phone?: string | null;
          occupation: string;
          business_type?: string | null;
          village_area: string;
          district: string;
          photo_path?: string | null;
          status?: string;
          status_reason?: string | null;
          status_changed_at?: string | null;
          status_changed_by?: string | null;
          notes?: string | null;
          registered_at?: string;
          created_by?: string | null;
          created_at?: string;
          updated_at?: string;
          archived_at?: string | null;
        };
        Update: {
          id?: string;
          client_number?: string;
          profile_id?: string | null;
          full_name?: string;
          sex?: string;
          date_of_birth?: string;
          phone?: string;
          alternative_phone?: string | null;
          occupation?: string;
          business_type?: string | null;
          village_area?: string;
          district?: string;
          photo_path?: string | null;
          status?: string;
          status_reason?: string | null;
          status_changed_at?: string | null;
          status_changed_by?: string | null;
          notes?: string | null;
          registered_at?: string;
          created_by?: string | null;
          created_at?: string;
          updated_at?: string;
          archived_at?: string | null;
        };
        Relationships: [];
      };
      guarantor_identities: {
        Row: {
          guarantor_id: string;
          nin: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          guarantor_id: string;
          nin?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          guarantor_id?: string;
          nin?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      guarantors: {
        Row: {
          id: string;
          full_name: string;
          sex: string;
          date_of_birth: string;
          phone: string;
          alternative_phone: string | null;
          occupation: string;
          location: string;
          district: string | null;
          photo_path: string | null;
          created_by: string | null;
          created_at: string;
          updated_at: string;
          archived_at: string | null;
        };
        Insert: {
          id?: string;
          full_name: string;
          sex: string;
          date_of_birth: string;
          phone: string;
          alternative_phone?: string | null;
          occupation: string;
          location: string;
          district?: string | null;
          photo_path?: string | null;
          created_by?: string | null;
          created_at?: string;
          updated_at?: string;
          archived_at?: string | null;
        };
        Update: {
          id?: string;
          full_name?: string;
          sex?: string;
          date_of_birth?: string;
          phone?: string;
          alternative_phone?: string | null;
          occupation?: string;
          location?: string;
          district?: string | null;
          photo_path?: string | null;
          created_by?: string | null;
          created_at?: string;
          updated_at?: string;
          archived_at?: string | null;
        };
        Relationships: [];
      };
      company_settings: {
        Row: {
          id: number;
          company_name: string;
          legal_name: string | null;
          registration_number: string | null;
          tax_identification_number: string | null;
          tagline: string | null;
          phone: string | null;
          phone_secondary: string | null;
          email: string | null;
          postal_address: string | null;
          address_line1: string | null;
          address_line2: string | null;
          city: string | null;
          country: string | null;
          currency_code: string;
          locale: string;
          timezone: string;
          logo_path: string | null;
          receipt_header: string | null;
          receipt_footer: string | null;
          brand_primary_color: string | null;
          created_at: string;
          updated_at: string;
          updated_by: string | null;
        };
        Insert: {
          id?: number;
          company_name: string;
          legal_name?: string | null;
          registration_number?: string | null;
          tax_identification_number?: string | null;
          tagline?: string | null;
          phone?: string | null;
          phone_secondary?: string | null;
          email?: string | null;
          postal_address?: string | null;
          address_line1?: string | null;
          address_line2?: string | null;
          city?: string | null;
          country?: string | null;
          currency_code?: string;
          locale?: string;
          timezone?: string;
          logo_path?: string | null;
          receipt_header?: string | null;
          receipt_footer?: string | null;
          brand_primary_color?: string | null;
          created_at?: string;
          updated_at?: string;
          updated_by?: string | null;
        };
        Update: {
          id?: number;
          company_name?: string;
          legal_name?: string | null;
          registration_number?: string | null;
          tax_identification_number?: string | null;
          tagline?: string | null;
          phone?: string | null;
          phone_secondary?: string | null;
          email?: string | null;
          postal_address?: string | null;
          address_line1?: string | null;
          address_line2?: string | null;
          city?: string | null;
          country?: string | null;
          currency_code?: string;
          locale?: string;
          timezone?: string;
          logo_path?: string | null;
          receipt_header?: string | null;
          receipt_footer?: string | null;
          brand_primary_color?: string | null;
          created_at?: string;
          updated_at?: string;
          updated_by?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: 'company_settings_updated_by_fkey';
            columns: ['updated_by'];
            isOneToOne: false;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
        ];
      };

      profiles: {
        Row: {
          id: string;
          auth_user_id: string | null;
          full_name: string;
          phone: string;
          email: string | null;
          status: string;
          archived_at: string | null;
          must_change_password: boolean;
          password_set_at: string | null;
          last_sign_in_at: string | null;
          branch_id: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          auth_user_id?: string | null;
          full_name: string;
          phone: string;
          email?: string | null;
          status?: string;
          archived_at?: string | null;
          must_change_password?: boolean;
          password_set_at?: string | null;
          last_sign_in_at?: string | null;
          branch_id?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          auth_user_id?: string | null;
          full_name?: string;
          phone?: string;
          email?: string | null;
          status?: string;
          archived_at?: string | null;
          must_change_password?: boolean;
          password_set_at?: string | null;
          last_sign_in_at?: string | null;
          branch_id?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };

      loan_client_snapshots: {
        Row: {
          loan_id: string;
          client_id: string;
          client_number: string;
          full_name: string;
          phone: string;
          alternative_phone: string | null;
          sex: string;
          date_of_birth: string;
          occupation: string;
          business_type: string | null;
          village_area: string;
          district: string;
          client_status_at_origination: string;
          captured_at: string;
        };
        Insert: {
          loan_id: string;
          client_id: string;
          client_number: string;
          full_name: string;
          phone: string;
          alternative_phone?: string | null;
          sex: string;
          date_of_birth: string;
          occupation: string;
          business_type?: string | null;
          village_area: string;
          district: string;
          client_status_at_origination: string;
          captured_at?: string;
        };
        Update: {
          loan_id?: string;
          client_id?: string;
          client_number?: string;
          full_name?: string;
          phone?: string;
          alternative_phone?: string | null;
          sex?: string;
          date_of_birth?: string;
          occupation?: string;
          business_type?: string | null;
          village_area?: string;
          district?: string;
          client_status_at_origination?: string;
          captured_at?: string;
        };
        Relationships: [];
      };
      loan_guarantor_snapshots: {
        Row: {
          id: string;
          loan_id: string;
          guarantor_id: string;
          full_name: string;
          phone: string;
          alternative_phone: string | null;
          sex: string;
          date_of_birth: string;
          occupation: string;
          location: string;
          district: string | null;
          relationship_to_client: string;
          had_photograph: boolean;
          captured_at: string;
        };
        Insert: {
          id?: string;
          loan_id: string;
          guarantor_id: string;
          full_name: string;
          phone: string;
          alternative_phone?: string | null;
          sex: string;
          date_of_birth: string;
          occupation: string;
          location: string;
          district?: string | null;
          relationship_to_client: string;
          had_photograph?: boolean;
          captured_at?: string;
        };
        Update: {
          id?: string;
          loan_id?: string;
          guarantor_id?: string;
          full_name?: string;
          phone?: string;
          alternative_phone?: string | null;
          sex?: string;
          date_of_birth?: string;
          occupation?: string;
          location?: string;
          district?: string | null;
          relationship_to_client?: string;
          had_photograph?: boolean;
          captured_at?: string;
        };
        Relationships: [];
      };
      loan_identity_snapshots: {
        Row: {
          id: string;
          loan_id: string;
          subject_type: string;
          subject_id: string;
          nin: string | null;
          captured_at: string;
        };
        Insert: {
          id?: string;
          loan_id: string;
          subject_type: string;
          subject_id: string;
          nin?: string | null;
          captured_at?: string;
        };
        Update: {
          id?: string;
          loan_id?: string;
          subject_type?: string;
          subject_id?: string;
          nin?: string | null;
          captured_at?: string;
        };
        Relationships: [];
      };
      loan_installments: {
        Row: {
          id: string;
          loan_id: string;
          loan_period_id: string;
          loan_period_number: number;
          installment_number: number;
          period_installment_number: number;
          due_date: string;
          scheduled_principal: number;
          scheduled_interest: number;
          expected_amount: number;
          created_at: string;
        };
        Insert: {
          id?: string;
          loan_id: string;
          loan_period_id: string;
          loan_period_number: number;
          installment_number: number;
          period_installment_number: number;
          due_date: string;
          scheduled_principal: number;
          scheduled_interest: number;
          expected_amount: number;
          created_at?: string;
        };
        Update: {
          id?: string;
          loan_id?: string;
          loan_period_id?: string;
          loan_period_number?: number;
          installment_number?: number;
          period_installment_number?: number;
          due_date?: string;
          scheduled_principal?: number;
          scheduled_interest?: number;
          expected_amount?: number;
          created_at?: string;
        };
        Relationships: [];
      };
      loan_payments: {
        Row: {
          id: string;
          payment_number: string;
          loan_id: string;
          client_id: string;
          amount: number;
          payment_method: string;
          external_reference: string | null;
          idempotency_key: string;
          status: string;
          received_at: string;
          recorded_by: string;
          outstanding_before: number;
          outstanding_after: number;
          client_name_at_payment: string;
          recorded_by_label: string;
          notes: string | null;
          reversed_at: string | null;
          reversed_by: string | null;
          reversal_reason: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          payment_number?: string;
          loan_id: string;
          client_id: string;
          amount: number;
          payment_method: string;
          external_reference?: string | null;
          idempotency_key: string;
          status?: string;
          received_at?: string;
          recorded_by: string;
          outstanding_before: number;
          outstanding_after: number;
          client_name_at_payment: string;
          recorded_by_label: string;
          notes?: string | null;
          reversed_at?: string | null;
          reversed_by?: string | null;
          reversal_reason?: string | null;
          created_at?: string;
        };
        Update: {
          id?: string;
          payment_number?: string;
          loan_id?: string;
          client_id?: string;
          amount?: number;
          payment_method?: string;
          external_reference?: string | null;
          idempotency_key?: string;
          status?: string;
          received_at?: string;
          recorded_by?: string;
          outstanding_before?: number;
          outstanding_after?: number;
          client_name_at_payment?: string;
          recorded_by_label?: string;
          notes?: string | null;
          reversed_at?: string | null;
          reversed_by?: string | null;
          reversal_reason?: string | null;
          created_at?: string;
        };
        Relationships: [];
      };
      loan_periods: {
        Row: {
          id: string;
          loan_id: string;
          period_number: number;
          opening_principal: number;
          principal_portion: number;
          interest: number;
          total_obligation: number;
          closing_principal: number;
          created_at: string;
        };
        Insert: {
          id?: string;
          loan_id: string;
          period_number: number;
          opening_principal: number;
          principal_portion: number;
          interest: number;
          total_obligation: number;
          closing_principal: number;
          created_at?: string;
        };
        Update: {
          id?: string;
          loan_id?: string;
          period_number?: number;
          opening_principal?: number;
          principal_portion?: number;
          interest?: number;
          total_obligation?: number;
          closing_principal?: number;
          created_at?: string;
        };
        Relationships: [];
      };
      /**
       * Phase 12. What the business sells. Within the bounds
       * `business_settings` sets — enforced by a trigger when a product is
       * saved — a product is the source of truth for a loan's terms.
       *
       * `product_code` is typed as writable because the column is, but an
       * update to it is silently restored by `loan_products_stamp_actor`:
       * the code appears on every snapshot and export, so renaming it would
       * relabel history. `created_by` and `updated_by` are stamped from the
       * session by the same trigger.
       */
      loan_products: {
        Row: {
          id: string;
          product_code: string;
          name: string;
          description: string | null;
          status: string;
          sort_order: number;
          is_default: boolean;
          min_amount: number;
          max_amount: number;
          default_interest_rate_bps: number;
          min_interest_rate_bps: number;
          max_interest_rate_bps: number;
          interest_method: string;
          interest_override_allowed: boolean;
          interest_override_roles: string[];
          min_term_months: number;
          max_term_months: number;
          allowed_term_months: number[] | null;
          allowed_repayment_frequencies: string[];
          default_repayment_frequency: string;
          grace_period_days: number;
          penalty_rate_bps: number;
          penalty_method: string;
          guarantor_required: boolean;
          min_guarantors: number;
          collateral_required: boolean;
          early_repayment: string;
          extra_payment: string;
          application_profile: string;
          requires_supporting_documents: boolean;
          created_by: string | null;
          created_at: string;
          updated_at: string;
          updated_by: string | null;
        };
        Insert: {
          id?: string;
          product_code: string;
          name: string;
          description?: string | null;
          status?: string;
          sort_order?: number;
          is_default?: boolean;
          min_amount: number;
          max_amount: number;
          default_interest_rate_bps: number;
          min_interest_rate_bps: number;
          max_interest_rate_bps: number;
          interest_method?: string;
          interest_override_allowed?: boolean;
          interest_override_roles?: string[];
          min_term_months: number;
          max_term_months: number;
          allowed_term_months?: number[] | null;
          allowed_repayment_frequencies: string[];
          default_repayment_frequency: string;
          grace_period_days: number;
          penalty_rate_bps: number;
          penalty_method?: string;
          guarantor_required?: boolean;
          min_guarantors?: number;
          collateral_required?: boolean;
          early_repayment?: string;
          extra_payment?: string;
          application_profile?: string;
          requires_supporting_documents?: boolean;
          created_by?: string | null;
          created_at?: string;
          updated_at?: string;
          updated_by?: string | null;
        };
        Update: {
          id?: string;
          product_code?: string;
          name?: string;
          description?: string | null;
          status?: string;
          sort_order?: number;
          is_default?: boolean;
          min_amount?: number;
          max_amount?: number;
          default_interest_rate_bps?: number;
          min_interest_rate_bps?: number;
          max_interest_rate_bps?: number;
          interest_method?: string;
          interest_override_allowed?: boolean;
          interest_override_roles?: string[];
          min_term_months?: number;
          max_term_months?: number;
          allowed_term_months?: number[] | null;
          allowed_repayment_frequencies?: string[];
          default_repayment_frequency?: string;
          grace_period_days?: number;
          penalty_rate_bps?: number;
          penalty_method?: string;
          guarantor_required?: boolean;
          min_guarantors?: number;
          collateral_required?: boolean;
          early_repayment?: string;
          extra_payment?: string;
          application_profile?: string;
          requires_supporting_documents?: boolean;
          created_by?: string | null;
          created_at?: string;
          updated_at?: string;
          updated_by?: string | null;
        };
        Relationships: [];
      };

      /**
       * Phase 12. Which branches may sell a product. No rows for a product
       * means every branch.
       */
      loan_product_branches: {
        Row: {
          product_id: string;
          branch_id: string;
          created_at: string;
        };
        Insert: {
          product_id: string;
          branch_id: string;
          created_at?: string;
        };
        Update: {
          product_id?: string;
          branch_id?: string;
          created_at?: string;
        };
        Relationships: [];
      };

      /**
       * Phase 12. The product configuration as it stood when the loan was
       * approved. Append-only: `Insert` is typed because
       * `capture_loan_product_snapshot` writes it, and the update and delete
       * triggers refuse everything else.
       */
      loan_product_snapshots: {
        Row: {
          loan_id: string;
          product_id: string;
          product_code: string;
          product_name: string;
          min_amount: number;
          max_amount: number;
          interest_rate_bps: number;
          interest_method: string;
          min_term_months: number;
          max_term_months: number;
          repayment_frequency: string;
          grace_period_days: number;
          penalty_rate_bps: number;
          penalty_method: string;
          guarantor_required: boolean;
          min_guarantors: number;
          collateral_required: boolean;
          early_repayment: string;
          extra_payment: string;
          application_profile: string;
          interest_rate_overridden: boolean;
          overridden_by: string | null;
          overridden_by_label: string | null;
          captured_at: string;
        };
        Insert: {
          loan_id: string;
          product_id: string;
          product_code: string;
          product_name: string;
          min_amount: number;
          max_amount: number;
          interest_rate_bps: number;
          interest_method: string;
          min_term_months: number;
          max_term_months: number;
          repayment_frequency: string;
          grace_period_days: number;
          penalty_rate_bps: number;
          penalty_method: string;
          guarantor_required: boolean;
          min_guarantors: number;
          collateral_required: boolean;
          early_repayment: string;
          extra_payment: string;
          application_profile: string;
          interest_rate_overridden?: boolean;
          overridden_by?: string | null;
          overridden_by_label?: string | null;
          captured_at?: string;
        };
        Update: {
          loan_id?: string;
          product_id?: string;
          product_code?: string;
          product_name?: string;
          min_amount?: number;
          max_amount?: number;
          interest_rate_bps?: number;
          interest_method?: string;
          min_term_months?: number;
          max_term_months?: number;
          repayment_frequency?: string;
          grace_period_days?: number;
          penalty_rate_bps?: number;
          penalty_method?: string;
          guarantor_required?: boolean;
          min_guarantors?: number;
          collateral_required?: boolean;
          early_repayment?: string;
          extra_payment?: string;
          application_profile?: string;
          interest_rate_overridden?: boolean;
          overridden_by?: string | null;
          overridden_by_label?: string | null;
          captured_at?: string;
        };
        Relationships: [];
      };

      /**
       * Phase 13. The versioned undertaking a guarantor signs. A version that
       * has been signed cannot be reworded — a trigger refuses it — so a new
       * version is appended instead.
       */
      guarantor_consent_terms: {
        Row: {
          id: string;
          version: string;
          title: string;
          body: string;
          effective_from: string;
          is_current: boolean;
          created_by: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          version: string;
          title: string;
          body: string;
          effective_from: string;
          is_current?: boolean;
          created_by?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          version?: string;
          title?: string;
          body?: string;
          effective_from?: string;
          is_current?: boolean;
          created_by?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };

      /**
       * Phase 13. What a business product asks for, one row per loan. Same
       * lifecycle as the salary details.
       */
      loan_business_details: {
        Row: {
          loan_id: string;
          business_name: string;
          business_type: string;
          business_location: string;
          trading_since: string | null;
          monthly_turnover: number;
          loan_purpose: string;
          employee_count: number | null;
          premises_ownership: string | null;
          trading_licence_number: string | null;
          trading_licence_path: string | null;
          bank_statement_path: string | null;
          created_by: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          loan_id: string;
          business_name: string;
          business_type: string;
          business_location: string;
          trading_since?: string | null;
          monthly_turnover: number;
          loan_purpose: string;
          employee_count?: number | null;
          premises_ownership?: string | null;
          trading_licence_number?: string | null;
          trading_licence_path?: string | null;
          bank_statement_path?: string | null;
          created_by?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          loan_id?: string;
          business_name?: string;
          business_type?: string;
          business_location?: string;
          trading_since?: string | null;
          monthly_turnover?: number;
          loan_purpose?: string;
          employee_count?: number | null;
          premises_ownership?: string | null;
          trading_licence_number?: string | null;
          trading_licence_path?: string | null;
          bank_statement_path?: string | null;
          created_by?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };

      /**
       * Phase 13. Who guaranteed a particular loan, and the consent they
       * signed. Exactly one of `guarantor_id` (an external person) and
       * `guarantor_client_id` (an existing client) is set. The `snapshot_*`
       * columns are the person's details frozen at approval, write-once.
       */
      loan_guarantors: {
        Row: {
          id: string;
          loan_id: string;
          guarantor_id: string | null;
          guarantor_client_id: string | null;
          relationship_to_client: string;
          consent_terms_id: string | null;
          consent_version: string | null;
          consented_at: string | null;
          signature_name: string | null;
          signature_path: string | null;
          witness_name: string | null;
          witness_phone: string | null;
          consent_place: string | null;
          created_by: string | null;
          created_at: string;
          updated_at: string;
          snapshot_full_name: string | null;
          snapshot_phone: string | null;
          snapshot_alternative_phone: string | null;
          snapshot_sex: string | null;
          snapshot_date_of_birth: string | null;
          snapshot_occupation: string | null;
          snapshot_location: string | null;
          snapshot_district: string | null;
          snapshot_had_identification: boolean | null;
          snapshot_had_photograph: boolean | null;
          snapshot_at: string | null;
        };
        Insert: {
          id?: string;
          loan_id: string;
          guarantor_id?: string | null;
          guarantor_client_id?: string | null;
          relationship_to_client: string;
          consent_terms_id?: string | null;
          consent_version?: string | null;
          consented_at?: string | null;
          signature_name?: string | null;
          signature_path?: string | null;
          witness_name?: string | null;
          witness_phone?: string | null;
          consent_place?: string | null;
          created_by?: string | null;
          created_at?: string;
          updated_at?: string;
          snapshot_full_name?: string | null;
          snapshot_phone?: string | null;
          snapshot_alternative_phone?: string | null;
          snapshot_sex?: string | null;
          snapshot_date_of_birth?: string | null;
          snapshot_occupation?: string | null;
          snapshot_location?: string | null;
          snapshot_district?: string | null;
          snapshot_had_identification?: boolean | null;
          snapshot_had_photograph?: boolean | null;
          snapshot_at?: string | null;
        };
        Update: {
          id?: string;
          loan_id?: string;
          guarantor_id?: string | null;
          guarantor_client_id?: string | null;
          relationship_to_client?: string;
          consent_terms_id?: string | null;
          consent_version?: string | null;
          consented_at?: string | null;
          signature_name?: string | null;
          signature_path?: string | null;
          witness_name?: string | null;
          witness_phone?: string | null;
          consent_place?: string | null;
          created_by?: string | null;
          created_at?: string;
          updated_at?: string;
          snapshot_full_name?: string | null;
          snapshot_phone?: string | null;
          snapshot_alternative_phone?: string | null;
          snapshot_sex?: string | null;
          snapshot_date_of_birth?: string | null;
          snapshot_occupation?: string | null;
          snapshot_location?: string | null;
          snapshot_district?: string | null;
          snapshot_had_identification?: boolean | null;
          snapshot_had_photograph?: boolean | null;
          snapshot_at?: string | null;
        };
        Relationships: [];
      };

      /**
       * Phase 13. What a salary product asks for, one row per loan. Writable
       * only while the loan is a draft.
       */
      loan_salary_details: {
        Row: {
          loan_id: string;
          employer_name: string;
          employer_contact: string | null;
          job_title: string;
          staff_number: string | null;
          net_monthly_salary: number;
          salary_pay_day: number;
          employment_started_on: string | null;
          payslip_path: string | null;
          employment_letter_path: string | null;
          created_by: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          loan_id: string;
          employer_name: string;
          employer_contact?: string | null;
          job_title: string;
          staff_number?: string | null;
          net_monthly_salary: number;
          salary_pay_day: number;
          employment_started_on?: string | null;
          payslip_path?: string | null;
          employment_letter_path?: string | null;
          created_by?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          loan_id?: string;
          employer_name?: string;
          employer_contact?: string | null;
          job_title?: string;
          staff_number?: string | null;
          net_monthly_salary?: number;
          salary_pay_day?: number;
          employment_started_on?: string | null;
          payslip_path?: string | null;
          employment_letter_path?: string | null;
          created_by?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };

      loan_schedules: {
        Row: {
          loan_id: string;
          repayment_frequency: string;
          frequency_label: string;
          interval_days: number;
          disbursement_date: string;
          business_timezone: string;
          generator_version: number;
          generated_at: string;
          generated_by: string | null;
        };
        Insert: {
          loan_id: string;
          repayment_frequency: string;
          frequency_label: string;
          interval_days: number;
          disbursement_date: string;
          business_timezone: string;
          generator_version?: number;
          generated_at?: string;
          generated_by?: string | null;
        };
        Update: {
          loan_id?: string;
          repayment_frequency?: string;
          frequency_label?: string;
          interval_days?: number;
          disbursement_date?: string;
          business_timezone?: string;
          generator_version?: number;
          generated_at?: string;
          generated_by?: string | null;
        };
        Relationships: [];
      };
      loans: {
        Row: {
          id: string;
          loan_number: string;
          client_id: string;
          principal_amount: number;
          interest_rate_bps: number;
          interest_method: string;
          loan_term_months: number;
          repayment_frequency: string;
          total_interest: number;
          total_expected_repayment: number;
          currency_code: string;
          min_loan_amount_applied: number;
          max_loan_amount_applied: number | null;
          grace_period_days_applied: number;
          penalty_rate_bps_applied: number;
          proposed_disbursement_date: string;
          status: string;
          submitted_at: string | null;
          submitted_by: string | null;
          approved_at: string | null;
          approved_by: string | null;
          disbursed_at: string | null;
          disbursed_by: string | null;
          cancelled_at: string | null;
          cancelled_by: string | null;
          cancellation_reason: string | null;
          review_note: string | null;
          notes: string | null;
          created_by: string | null;
          created_at: string;
          updated_at: string;
          /** Phase 12. The product this loan was sold under. */
          loan_product_id: string;
          /**
           * Phase 12. A rate deliberately chosen in place of the product's
           * own, or null for the standard rate. Distinct from
           * `interest_rate_bps`, which is NOT NULL and carries a placeholder
           * until approval writes the agreed rate.
           */
          proposed_interest_rate_bps: number | null;
        };
        Insert: {
          id?: string;
          /** Assigned by the loans_assign_loan_number trigger; supplying one is refused. */
          loan_number?: never;
          /** Phase 12. Supplied by the loans_stamp_product trigger when absent. */
          loan_product_id?: string;
          proposed_interest_rate_bps?: number | null;
          client_id: string;
          principal_amount: number;
          interest_rate_bps: number;
          interest_method: string;
          loan_term_months: number;
          repayment_frequency: string;
          total_interest?: number;
          total_expected_repayment?: number;
          currency_code?: string;
          min_loan_amount_applied: number;
          max_loan_amount_applied?: number | null;
          grace_period_days_applied: number;
          penalty_rate_bps_applied: number;
          proposed_disbursement_date: string;
          status?: string;
          submitted_at?: string | null;
          submitted_by?: string | null;
          approved_at?: string | null;
          approved_by?: string | null;
          disbursed_at?: string | null;
          disbursed_by?: string | null;
          cancelled_at?: string | null;
          cancelled_by?: string | null;
          cancellation_reason?: string | null;
          review_note?: string | null;
          notes?: string | null;
          created_by?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          loan_number?: string;
          client_id?: string;
          /** Phase 12. The product, and the rate somebody chose in place of its own. */
          loan_product_id?: string;
          proposed_interest_rate_bps?: number | null;
          principal_amount?: number;
          interest_rate_bps?: number;
          interest_method?: string;
          loan_term_months?: number;
          repayment_frequency?: string;
          total_interest?: number;
          total_expected_repayment?: number;
          currency_code?: string;
          min_loan_amount_applied?: number;
          max_loan_amount_applied?: number | null;
          grace_period_days_applied?: number;
          penalty_rate_bps_applied?: number;
          proposed_disbursement_date?: string;
          status?: string;
          submitted_at?: string | null;
          submitted_by?: string | null;
          approved_at?: string | null;
          approved_by?: string | null;
          disbursed_at?: string | null;
          disbursed_by?: string | null;
          cancelled_at?: string | null;
          cancelled_by?: string | null;
          cancellation_reason?: string | null;
          review_note?: string | null;
          notes?: string | null;
          created_by?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      payment_allocations: {
        Row: {
          id: string;
          payment_id: string;
          installment_id: string | null;
          penalty_id: string | null;
          loan_id: string;
          allocated_amount: number;
          allocated_principal: number;
          allocated_interest: number;
          allocated_penalty: number;
          created_at: string;
        };
        Insert: {
          id?: string;
          payment_id: string;
          installment_id?: string | null;
          penalty_id?: string | null;
          loan_id: string;
          allocated_amount: number;
          allocated_principal: number;
          allocated_interest: number;
          allocated_penalty?: number;
          created_at?: string;
        };
        Update: {
          id?: string;
          payment_id?: string;
          installment_id?: string | null;
          penalty_id?: string | null;
          loan_id?: string;
          allocated_amount?: number;
          allocated_principal?: number;
          allocated_interest?: number;
          allocated_penalty?: number;
          created_at?: string;
        };
        Relationships: [];
      };
      loan_penalties: {
        Row: {
          id: string;
          loan_id: string;
          client_id: string;
          penalty_type: string;
          final_due_date: string;
          grace_period_days: number;
          grace_end_date: string;
          effective_date: string;
          basis_amount: number;
          penalty_rate_bps: number;
          penalty_amount: number;
          trigger_rule: string;
          applied_at: string;
          created_at: string;
        };
        // No Insert and no Update that any session role can use: the table
        // grants SELECT only, and `ensure_penalty_applied` is the sole writer.
        // The shapes are declared so a privileged server path stays typed.
        Insert: {
          id?: string;
          loan_id: string;
          client_id: string;
          penalty_type?: string;
          final_due_date: string;
          grace_period_days: number;
          grace_end_date: string;
          effective_date: string;
          basis_amount: number;
          penalty_rate_bps: number;
          penalty_amount: number;
          trigger_rule?: string;
          applied_at?: string;
          created_at?: string;
        };
        Update: Record<PropertyKey, never>;
        Relationships: [];
      };
      permissions: {
        Row: {
          key: string;
          description: string;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          key: string;
          description: string;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          key?: string;
          description?: string;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };

      role_permissions: {
        Row: {
          role_key: string;
          permission_key: string;
          created_at: string;
        };
        Insert: {
          role_key: string;
          permission_key: string;
          created_at?: string;
        };
        Update: {
          role_key?: string;
          permission_key?: string;
          created_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'role_permissions_role_key_fkey';
            columns: ['role_key'];
            isOneToOne: false;
            referencedRelation: 'roles';
            referencedColumns: ['key'];
          },
          {
            foreignKeyName: 'role_permissions_permission_key_fkey';
            columns: ['permission_key'];
            isOneToOne: false;
            referencedRelation: 'permissions';
            referencedColumns: ['key'];
          },
        ];
      };

      reference_formats: {
        Row: {
          scope: string;
          prefix: string;
          padding: number;
          description: string;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          scope: string;
          prefix: string;
          padding?: number;
          description: string;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          scope?: string;
          prefix?: string;
          padding?: number;
          description?: string;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };

      reference_sequences: {
        Row: {
          scope: string;
          period_year: number;
          last_value: number;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          scope: string;
          period_year: number;
          last_value?: number;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          scope?: string;
          period_year?: number;
          last_value?: number;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'reference_sequences_scope_fkey';
            columns: ['scope'];
            isOneToOne: false;
            referencedRelation: 'reference_formats';
            referencedColumns: ['scope'];
          },
        ];
      };

      repayment_frequencies: {
        Row: {
          key: string;
          label: string;
          interval_days: number;
          is_active: boolean;
          sort_order: number;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          key: string;
          label: string;
          interval_days: number;
          is_active?: boolean;
          sort_order: number;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          key?: string;
          label?: string;
          interval_days?: number;
          is_active?: boolean;
          sort_order?: number;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };

      roles: {
        Row: {
          key: string;
          label: string;
          description: string;
          rank: number;
          is_staff: boolean;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          key: string;
          label: string;
          description: string;
          rank: number;
          is_staff: boolean;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          key?: string;
          label?: string;
          description?: string;
          rank?: number;
          is_staff?: boolean;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };

      user_roles: {
        Row: {
          profile_id: string;
          role_key: string;
          granted_by: string | null;
          granted_at: string;
        };
        Insert: {
          profile_id: string;
          role_key: string;
          granted_by?: string | null;
          granted_at?: string;
        };
        Update: {
          profile_id?: string;
          role_key?: string;
          granted_by?: string | null;
          granted_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'user_roles_profile_id_fkey';
            columns: ['profile_id'];
            isOneToOne: false;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'user_roles_role_key_fkey';
            columns: ['role_key'];
            isOneToOne: false;
            referencedRelation: 'roles';
            referencedColumns: ['key'];
          },
          {
            foreignKeyName: 'user_roles_granted_by_fkey';
            columns: ['granted_by'];
            isOneToOne: false;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
        ];
      };
    };

    /**
     * Phase 6. Balances are derived rather than stored, so they live in views.
     *
     * Every one sets `security_invoker = true`, so reading a view applies the
     * caller's Row Level Security on the underlying tables. `Row` only: a view
     * here is read-only to every session.
     */
    Views: {
      transfer_register: {
        Row: {
          id: string | null;
          transfer_number: string | null;
          branch_id: string | null;
          branch_code: string | null;
          branch_name: string | null;
          transfer_date: string | null;
          occurred_at: string | null;
          amount: number | null;
          status: string | null;
          from_account_id: string | null;
          from_account_code: string | null;
          from_account_name: string | null;
          from_cash_kind: string | null;
          to_account_id: string | null;
          to_account_code: string | null;
          to_account_name: string | null;
          to_cash_kind: string | null;
          external_reference: string | null;
          description: string | null;
          initiated_by: string | null;
          initiated_by_label: string | null;
          approved_by: string | null;
          approved_by_label: string | null;
          approved_at: string | null;
          decision_reason: string | null;
          journal_entry_id: string | null;
          reversal_entry_id: string | null;
          reversed_at: string | null;
          created_at: string | null;
        };
        Relationships: [];
      };
      expense_register: {
        Row: {
          id: string | null;
          expense_number: string | null;
          branch_id: string | null;
          branch_code: string | null;
          branch_name: string | null;
          expense_date: string | null;
          occurred_at: string | null;
          amount: number | null;
          status: string | null;
          expense_account_id: string | null;
          category_code: string | null;
          category_name: string | null;
          payment_account_id: string | null;
          payment_account_code: string | null;
          payment_account_name: string | null;
          payment_cash_kind: string | null;
          payee: string | null;
          description: string | null;
          external_reference: string | null;
          receipt_path: string | null;
          recorded_by: string | null;
          recorded_by_label: string | null;
          approved_by: string | null;
          approved_by_label: string | null;
          approved_at: string | null;
          decision_reason: string | null;
          journal_entry_id: string | null;
          reversal_entry_id: string | null;
          reversed_at: string | null;
          created_at: string | null;
          effective_amount: number | null;
        };
        Relationships: [];
      };
      income_register: {
        Row: {
          id: string | null;
          income_number: string | null;
          branch_id: string | null;
          branch_code: string | null;
          branch_name: string | null;
          income_date: string | null;
          occurred_at: string | null;
          amount: number | null;
          status: string | null;
          income_account_id: string | null;
          category_code: string | null;
          category_name: string | null;
          receiving_account_id: string | null;
          receiving_account_code: string | null;
          receiving_account_name: string | null;
          receiving_cash_kind: string | null;
          payer: string | null;
          client_id: string | null;
          client_number: string | null;
          client_name: string | null;
          loan_id: string | null;
          loan_number: string | null;
          description: string | null;
          external_reference: string | null;
          recorded_by: string | null;
          recorded_by_label: string | null;
          journal_entry_id: string | null;
          reversal_entry_id: string | null;
          reversed_at: string | null;
          created_at: string | null;
          effective_amount: number | null;
        };
        Relationships: [];
      };
      reconciliation_register: {
        Row: {
          id: string | null;
          reconciliation_number: string | null;
          branch_id: string | null;
          branch_code: string | null;
          branch_name: string | null;
          account_id: string | null;
          account_code: string | null;
          account_name: string | null;
          cash_kind: string | null;
          business_date: string | null;
          system_balance: number | null;
          counted_balance: number | null;
          variance: number | null;
          status: string | null;
          explanation: string | null;
          performed_by: string | null;
          performed_by_label: string | null;
          performed_at: string | null;
          reviewed_by: string | null;
          reviewed_by_label: string | null;
          reviewed_at: string | null;
          review_notes: string | null;
          adjustment_entry_id: string | null;
          created_at: string | null;
        };
        Relationships: [];
      };
      general_ledger: {
        Row: {
          line_id: string | null;
          entry_id: string | null;
          entry_number: string | null;
          entry_date: string | null;
          posted_at: string | null;
          branch_id: string | null;
          branch_code: string | null;
          branch_name: string | null;
          source_type: string | null;
          source_id: string | null;
          entry_description: string | null;
          loan_id: string | null;
          client_id: string | null;
          created_by: string | null;
          created_by_label: string | null;
          reversed_by_entry_id: string | null;
          line_number: number | null;
          account_id: string | null;
          account_code: string | null;
          account_name: string | null;
          account_type: string | null;
          normal_side: string | null;
          cash_kind: string | null;
          account_branch_id: string | null;
          debit: number | null;
          credit: number | null;
          signed_amount: number | null;
          memo: string | null;
        };
        Relationships: [];
      };
      /**
       * Phase 10. Every account with its debit and credit totals and its
       * balance, signed the way the account is read.
       */
      ledger_account_balances: {
        Row: {
          account_id: string;
          code: string;
          name: string;
          account_type: string;
          normal_side: string;
          cash_kind: string | null;
          branch_id: string | null;
          branch_code: string | null;
          branch_name: string | null;
          institution: string | null;
          account_number: string | null;
          status: string;
          total_debit: number;
          total_credit: number;
          balance: number;
          line_count: number;
          last_movement_on: string | null;
        };
        Relationships: [];
      };

      /**
       * Phase 10. Cash at Hand, the two wallets and the bank, per branch,
       * with their total. The liquidity cards on the dashboard read this.
       */
      branch_cash_position: {
        Row: {
          branch_id: string;
          branch_code: string;
          branch_name: string;
          branch_status: string;
          cash_at_hand: number;
          mtn_mobile_money: number;
          airtel_money: number;
          cash_at_bank: number;
          total_liquidity: number;
        };
        Relationships: [];
      };

      /**
       * Phase 10. Debit and credit totals per account. The two columns foot to
       * the same figure when the ledger is sound.
       */
      trial_balance: {
        Row: {
          code: string;
          name: string;
          account_type: string;
          normal_side: string;
          total_debit: number;
          total_credit: number;
        };
        Relationships: [];
      };
      /**
       * Phase 13. One row per loan: the product it was taken under, the
       * questions that product asks, and whether they are answered.
       */
      loan_application_profile: {
        Row: {
          loan_id: string | null;
          loan_number: string | null;
          status: string | null;
          product_code: string | null;
          product_name: string | null;
          application_profile: string | null;
          requires_supporting_documents: boolean | null;
          details_present: boolean | null;
          employer_name: string | null;
          job_title: string | null;
          net_monthly_salary: number | null;
          salary_pay_day: number | null;
          has_payslip: boolean | null;
          business_name: string | null;
          business_type: string | null;
          monthly_turnover: number | null;
          loan_purpose: string | null;
          has_trading_licence: boolean | null;
        };
        Relationships: [];
      };

      /**
       * Phase 13. Who guaranteed a loan, as frozen at approval: from
       * `loan_guarantors` for loans approved from Phase 13 onward, and from
       * `loan_guarantor_snapshots` for the ones before it. `source` says
       * which.
       */
      loan_guarantor_evidence: {
        Row: {
          loan_id: string | null;
          subject_kind: string | null;
          guarantor_id: string | null;
          guarantor_client_id: string | null;
          full_name: string | null;
          phone: string | null;
          alternative_phone: string | null;
          sex: string | null;
          date_of_birth: string | null;
          occupation: string | null;
          location: string | null;
          district: string | null;
          relationship_to_client: string | null;
          had_photograph: boolean | null;
          had_identification: boolean | null;
          consent_version: string | null;
          consented_at: string | null;
          signature_name: string | null;
          witness_name: string | null;
          captured_at: string | null;
          source: string | null;
        };
        Relationships: [];
      };

      /**
       * Phase 13. A loan's guarantors with their details resolved from
       * whichever record holds them, and whether each has signed.
       */
      loan_guarantor_register: {
        Row: {
          id: string | null;
          loan_id: string | null;
          loan_number: string | null;
          loan_status: string | null;
          client_id: string | null;
          subject_kind: string | null;
          guarantor_id: string | null;
          guarantor_client_id: string | null;
          full_name: string | null;
          phone: string | null;
          alternative_phone: string | null;
          sex: string | null;
          date_of_birth: string | null;
          occupation: string | null;
          location: string | null;
          district: string | null;
          client_number: string | null;
          relationship_to_client: string | null;
          consent_terms_id: string | null;
          consent_version: string | null;
          consented_at: string | null;
          signature_name: string | null;
          has_signature_image: boolean | null;
          witness_name: string | null;
          witness_phone: string | null;
          consent_place: string | null;
          consent_signed: boolean | null;
          has_identification: boolean | null;
          created_at: string | null;
        };
        Relationships: [];
      };

      /**
       * Phase 12. Every product with its configuration, the branches that may
       * sell it and how many loans have been written against it. `branch_ids`
       * is null when the product is sold everywhere.
       */
      loan_product_catalogue: {
        Row: {
          product_id: string;
          product_code: string;
          name: string;
          description: string | null;
          status: string;
          sort_order: number;
          is_default: boolean;
          min_amount: number;
          max_amount: number;
          default_interest_rate_bps: number;
          min_interest_rate_bps: number;
          max_interest_rate_bps: number;
          interest_method: string;
          interest_override_allowed: boolean;
          interest_override_roles: string[];
          min_term_months: number;
          max_term_months: number;
          allowed_term_months: number[] | null;
          allowed_repayment_frequencies: string[];
          default_repayment_frequency: string;
          grace_period_days: number;
          penalty_rate_bps: number;
          penalty_method: string;
          guarantor_required: boolean;
          min_guarantors: number;
          collateral_required: boolean;
          early_repayment: string;
          extra_payment: string;
          application_profile: string;
          requires_supporting_documents: boolean;
          branch_ids: string[] | null;
          loans_written: number;
          created_at: string;
          updated_at: string;
        };
        Relationships: [];
      };

      /**
       * Phase 9, widened in Phase 12. The company's own published identity —
       * name, tagline, locale, timezone, logo, brand colour and the contact
       * details a document it issues has to carry — readable by every
       * signed-in user, borrowers included. SECURITY DEFINER by design; the
       * registration and tax numbers are deliberately absent. See migrations
       * 20261009000100 and 20261012000100.
       */
      company_identity: {
        Row: {
          company_name: string;
          currency_code: string;
          locale: string;
          timezone: string;
          logo_path: string | null;
          brand_primary_color: string | null;
          // Phase 12. The published identity: what a document the business
          // hands out has to carry. The registration and tax numbers are
          // deliberately still absent — see migration 20261012000100.
          tagline: string | null;
          phone: string | null;
          phone_secondary: string | null;
          postal_address: string | null;
          address_line1: string | null;
          address_line2: string | null;
          city: string | null;
          country: string | null;
        };
        Relationships: [];
      };

      /**
       * Phase 8. One row per recorded payment with its allocation components.
       * `loan_number` and the client columns are nullable because the joins are
       * outer: a financial register must show a payment the caller may read even
       * if a future role could not read the borrower's directory entry.
       */
      payment_register: {
        Row: {
          payment_id: string;
          payment_number: string;
          loan_id: string;
          loan_number: string | null;
          client_id: string;
          client_number: string | null;
          client_name: string | null;
          client_phone: string | null;
          client_name_at_payment: string;
          amount: number;
          payment_method: string;
          status: string;
          is_effective: boolean;
          effective_amount: number;
          received_at: string;
          business_date: string;
          recorded_by: string;
          recorded_by_label: string;
          external_reference: string | null;
          reversed_at: string | null;
          reversed_by: string | null;
          reversal_reason: string | null;
          outstanding_before: number;
          outstanding_after: number;
          allocated_principal: number;
          allocated_interest: number;
          allocated_penalty: number;
          principal_collected: number;
          interest_collected: number;
          penalty_collected: number;
        };
        Relationships: [];
      };
      /** Phase 8. Loans with a collection due today that was not already covered. */
      collections_today: {
        Row: {
          loan_id: string;
          loan_number: string;
          loan_status: string;
          client_id: string;
          client_number: string | null;
          client_name: string | null;
          client_phone: string | null;
          business_date: string;
          installment_id: string;
          installment_number: number;
          scheduled_amount: number;
          expected_today: number;
          collected_today: number;
          payments_today: number;
          remaining_today: number;
          arrears_amount: number;
          current_due: number;
          total_outstanding: number;
          days_past_due: number;
          missed_installment_count: number;
          delinquency_state: string;
          collection_status: string;
        };
        Relationships: [];
      };
      /**
       * Phase 8. The loan register with its derived balances and delinquency.
       * Everything from `loan_balances` and `loan_delinquency` is nullable: a
       * draft or cancelled loan has no schedule, so it appears here with no
       * derived position rather than with invented zeroes.
       */
      loan_portfolio_report: {
        Row: {
          loan_id: string;
          loan_number: string;
          client_id: string;
          client_number: string | null;
          client_name: string | null;
          client_phone: string | null;
          client_status: string | null;
          client_name_at_origination: string | null;
          client_phone_at_origination: string | null;
          loan_status: string;
          principal_amount: number;
          interest_rate_bps: number;
          interest_method: string;
          loan_term_months: number;
          repayment_frequency: string;
          contractual_interest: number;
          total_expected_repayment: number;
          grace_period_days_applied: number;
          penalty_rate_bps_applied: number;
          proposed_disbursement_date: string | null;
          disbursed_at: string | null;
          cleared_at: string | null;
          cancelled_at: string | null;
          created_at: string;
          scheduled_total: number | null;
          total_paid: number | null;
          principal_paid: number | null;
          interest_paid: number | null;
          contractual_outstanding: number | null;
          principal_remaining: number | null;
          interest_remaining: number | null;
          penalty_assessed: number | null;
          penalty_paid: number | null;
          penalty_remaining: number | null;
          total_outstanding: number | null;
          total_collected: number | null;
          fully_repaid: boolean | null;
          posted_payment_total: number | null;
          posted_payment_count: number | null;
          reversed_payment_count: number | null;
          last_payment_at: string | null;
          scheduled_completion_date: string | null;
          installment_count: number | null;
          first_due_date: string | null;
          arrears_amount: number | null;
          due_today_amount: number | null;
          current_due: number | null;
          missed_installment_count: number | null;
          days_past_due: number | null;
          oldest_unpaid_due_date: string | null;
          oldest_past_due_date: string | null;
          grace_end_date: string | null;
          penalty_effective_date: string | null;
          within_grace_period: boolean | null;
          penalty_applied: boolean | null;
          penalty_eligible: boolean | null;
          penalty_projected_amount: number | null;
          delinquency_state: string | null;
        };
        Relationships: [];
      };
      /**
       * Phase 8. A single row of business-wide figures. Every column is an
       * aggregate with a `coalesce`, so none of them is ever null — an empty
       * database reports zero, which is the true answer.
       */
      dashboard_portfolio_summary: {
        Row: {
          business_date: string;
          total_clients: number;
          active_clients: number;
          inactive_clients: number;
          suspended_clients: number;
          blacklisted_clients: number;
          archived_clients: number;
          clients_with_active_loan: number;
          loans_total: number;
          loans_draft: number;
          loans_pending_approval: number;
          loans_approved: number;
          loans_active: number;
          loans_cleared: number;
          loans_cancelled: number;
          principal_disbursed: number;
          contractual_interest: number;
          contractual_expected: number;
          contract_collected: number;
          principal_collected: number;
          interest_collected: number;
          penalty_collected: number;
          total_collected: number;
          posted_payment_total: number;
          contractual_outstanding: number;
          principal_outstanding: number;
          interest_outstanding: number;
          penalty_assessed: number;
          penalty_outstanding: number;
          total_outstanding: number;
          loans_with_schedule: number;
          loans_state_current: number;
          loans_state_due_today: number;
          loans_state_in_arrears: number;
          loans_state_grace_period: number;
          loans_state_expired_unpaid: number;
          loans_state_penalty_due: number;
          loans_state_cleared: number;
          loans_with_arrears: number;
          loans_penalised: number;
          loans_penalty_pending: number;
          arrears_total: number;
          due_today_total: number;
          current_due_total: number;
        };
        Relationships: [];
      };
      /** Phase 8. A single row for today: target, received, method split, components. */
      dashboard_collection_summary: {
        Row: {
          business_date: string;
          expected_today: number;
          remaining_today: number;
          loans_due_today: number;
          clients_due_today: number;
          loans_settled_today: number;
          collected_today: number;
          payments_today: number;
          clients_paying_today: number;
          cash_received: number;
          mtn_received: number;
          airtel_received: number;
          principal_collected: number;
          interest_collected: number;
          penalty_collected: number;
          reversed_today_amount: number;
          reversed_today_count: number;
          bank_received: number;
        };
        Relationships: [];
      };
      loan_installment_coverage: {
        Row: {
          installment_id: string;
          loan_id: string;
          loan_period_id: string;
          loan_period_number: number;
          installment_number: number;
          due_date: string;
          expected_amount: number;
          scheduled_principal: number;
          scheduled_interest: number;
          allocated_amount: number;
          allocated_principal: number;
          allocated_interest: number;
          remaining_amount: number;
          remaining_principal: number;
          remaining_interest: number;
        };
        Relationships: [];
      };
      loan_balances: {
        Row: {
          loan_id: string;
          loan_number: string;
          client_id: string;
          status: string;
          contractual_principal: number;
          contractual_interest: number;
          total_expected_repayment: number;
          scheduled_total: number;
          total_paid: number;
          principal_paid: number;
          interest_paid: number;
          contractual_outstanding: number;
          principal_remaining: number;
          interest_remaining: number;
          penalty_assessed: number;
          penalty_paid: number;
          penalty_remaining: number;
          total_outstanding: number;
          total_collected: number;
          fully_repaid: boolean;
          posted_payment_total: number;
          posted_payment_count: number;
          reversed_payment_count: number;
          last_payment_at: string | null;
        };
        Relationships: [];
      };
      payment_collection_totals: {
        Row: {
          collection_date: string;
          payment_method: string;
          payment_count: number;
          total_amount: number;
        };
        Relationships: [];
      };
      loan_penalty_coverage: {
        Row: {
          penalty_id: string;
          loan_id: string;
          client_id: string;
          penalty_type: string;
          final_due_date: string;
          grace_period_days: number;
          grace_end_date: string;
          effective_date: string;
          basis_amount: number;
          penalty_rate_bps: number;
          penalty_amount: number;
          trigger_rule: string;
          applied_at: string;
          allocated_amount: number;
          remaining_amount: number;
        };
        Relationships: [];
      };
      loan_obligations: {
        Row: {
          loan_id: string;
          obligation_kind: string;
          obligation_rank: number;
          installment_id: string | null;
          penalty_id: string | null;
          effective_date: string;
          sequence_number: number;
          expected_amount: number;
          scheduled_principal: number;
          scheduled_interest: number;
          scheduled_penalty: number;
          allocated_amount: number;
          allocated_principal: number;
          allocated_interest: number;
          allocated_penalty: number;
          remaining_amount: number;
          remaining_principal: number;
          remaining_interest: number;
          remaining_penalty: number;
        };
        Relationships: [];
      };
      loan_delinquency: {
        Row: {
          loan_id: string;
          loan_number: string;
          client_id: string;
          loan_status: string;
          business_date: string;
          installment_count: number;
          first_due_date: string;
          scheduled_completion_date: string;
          scheduled_total: number;
          scheduled_due_to_date: number;
          paid_against_schedule: number;
          arrears_amount: number;
          due_today_amount: number;
          current_due: number;
          missed_installment_count: number;
          oldest_unpaid_due_date: string | null;
          oldest_past_due_date: string | null;
          days_past_due: number;
          grace_period_days: number;
          grace_end_date: string;
          penalty_effective_date: string;
          past_final_due_date: boolean;
          within_grace_period: boolean;
          contractual_outstanding: number;
          penalty_amount: number;
          penalty_paid: number;
          penalty_remaining: number;
          total_outstanding: number;
          penalty_applied: boolean;
          penalty_id: string | null;
          penalty_applied_effective_date: string | null;
          penalty_basis_amount: number | null;
          penalty_rate_bps: number;
          penalty_basis_as_of_grace_end: number;
          penalty_eligible: boolean;
          penalty_projected_amount: number;
          delinquency_state: string;
        };
        Relationships: [];
      };
    };

    Functions: {
      // --- Phase 11: money movement ------------------------------------------
      // Each of these writes its document and its journal in one transaction.
      // None of them takes a debit, a credit or an approval decision as an
      // argument: the legs are derived from the document and the threshold is
      // read from `finance_settings`, so a caller cannot opt out of either.

      /**
       * Phase 11. Refuses to take more out of a cash account than it holds,
       * unless `finance_settings` says an account may go overdrawn. Reads the
       * setting itself, so no caller can opt out.
       */
      assert_cash_available: {
        Args: { p_account_id: string; p_amount: number };
        Returns: undefined;
      };

      /**
       * Phase 13. Refuses an application awaiting approval. Terminal and
       * reasoned, and distinguishable from a withdrawal by `closure_kind`.
       */
      reject_loan: {
        Args: { p_loan_id: string; p_reason: string };
        Returns: string;
      };

      /** Phase 11. Refuses an account that is not an active cash account. */
      assert_cash_account: {
        Args: { p_account_id: string; p_role: string };
        Returns: undefined;
      };

      /**
       * Phase 11. Refuses a heading, an inactive account, the wrong type, and
       * Interest or Penalty Income — those are posted by the lending
       * functions from a payment's own allocation components.
       */
      assert_postable_account: {
        Args: { p_account_id: string; p_type: string; p_role: string };
        Returns: undefined;
      };

      /** Phase 11. Dr the destination, Cr the source. Called by the two transfer paths. */
      post_transfer_journal: {
        Args: { p_transfer_id: string };
        Returns: string;
      };

      /** Phase 11. Dr the category, Cr the paying account. */
      post_expense_journal: {
        Args: { p_expense_id: string };
        Returns: string;
      };

      /**
       * Phase 11. Whether the signed-in person may see data belonging to this
       * branch. True for everybody not assigned to one.
       */
      user_can_see_branch: {
        Args: { p_branch_id: string };
        Returns: boolean;
      };

      /** Phase 11. One account's balance, signed the way the account is read. */
      ledger_account_balance: {
        Args: { p_account_id: string };
        Returns: number;
      };

      /** Phase 11. Move money between two of the company's cash accounts. */
      record_transfer: {
        Args: {
          p_from_account_id: string;
          p_to_account_id: string;
          p_amount: number;
          p_transfer_date: string;
          p_description: string;
          p_external_reference?: string | null;
        };
        Returns: string;
      };

      /** Phase 11. Approve a waiting transfer, which is what posts it. */
      approve_transfer: {
        Args: { p_transfer_id: string };
        Returns: string;
      };

      /** Phase 11. Reject a waiting transfer. Nothing is posted. */
      reject_transfer: {
        Args: { p_transfer_id: string; p_reason: string };
        Returns: string;
      };

      /** Phase 11. Cancel a posted transfer with a contra entry. */
      reverse_transfer: {
        Args: { p_transfer_id: string; p_reason: string };
        Returns: string;
      };

      /** Phase 11. Dr the expense category, Cr the account it was paid from. */
      record_expense: {
        Args: {
          p_expense_account_id: string;
          p_payment_account_id: string;
          p_amount: number;
          p_expense_date: string;
          p_description: string;
          p_payee?: string | null;
          p_external_reference?: string | null;
          p_receipt_path?: string | null;
        };
        Returns: string;
      };

      approve_expense: {
        Args: { p_expense_id: string };
        Returns: string;
      };

      reject_expense: {
        Args: { p_expense_id: string; p_reason: string };
        Returns: string;
      };

      reverse_expense: {
        Args: { p_expense_id: string; p_reason: string };
        Returns: string;
      };

      /** Phase 11. Dr the receiving account, Cr the fee account. */
      record_other_income: {
        Args: {
          p_income_account_id: string;
          p_receiving_account_id: string;
          p_amount: number;
          p_income_date: string;
          p_description: string;
          p_payer?: string | null;
          p_client_id?: string | null;
          p_loan_id?: string | null;
          p_external_reference?: string | null;
        };
        Returns: string;
      };

      reverse_other_income: {
        Args: { p_income_id: string; p_reason: string };
        Returns: string;
      };

      /** Phase 11. Record what was counted against what the ledger says. */
      submit_reconciliation: {
        Args: {
          p_account_id: string;
          p_business_date: string;
          p_counted_balance: number;
          p_explanation?: string | null;
        };
        Returns: string;
      };

      /** Phase 11. Write an approved difference off to Cash Over and Short. */
      approve_reconciliation: {
        Args: { p_reconciliation_id: string; p_notes: string | null };
        Returns: string;
      };

      /** Phase 11. Decline to write a difference off. The ledger is unchanged. */
      reject_reconciliation: {
        Args: { p_reconciliation_id: string; p_reason: string };
        Returns: string;
      };

      /**
       * Phase 10. The account a payment by this method lands in. Pure
       * mapping; the only ledger helper a signed-in caller may execute.
       */
      payment_method_cash_kind: {
        Args: { p_method: string };
        Returns: string;
      };

      /** Phase 10. The branch's account of a given kind. Raises if absent. */
      branch_cash_account: {
        Args: { p_branch_id: string; p_cash_kind: string };
        Returns: string;
      };

      /** Phase 10. A chart row by its code. Raises if absent. */
      ledger_account_by_code: {
        Args: { p_code: string };
        Returns: string;
      };

      /** Phase 10. The only way a journal is written. */
      post_journal: {
        Args: {
          p_branch_id: string;
          p_entry_date: string;
          p_description: string;
          p_source_type: string;
          p_source_id: string | null;
          p_loan_id: string | null;
          p_client_id: string | null;
          p_lines: Json;
          p_posted_at?: string | null;
          p_created_by?: string | null;
          p_created_by_label?: string | null;
        };
        Returns: string;
      };

      /** Phase 10. Dr Loans Receivable, Cr the branch Cash at Hand. */
      post_disbursement_journal: {
        Args: { p_loan_id: string };
        Returns: string;
      };

      /** Phase 10. Dr the receiving account, Cr receivable and the income accounts. */
      post_repayment_journal: {
        Args: { p_payment_id: string };
        Returns: string;
      };

      /** Phase 10. The contra of a repayment journal. */
      post_reversal_journal: {
        Args: { p_payment_id: string };
        Returns: string;
      };

      /** Phase 10. Derives journals for events already recorded. Idempotent. */
      backfill_ledger_history: {
        Args: Record<string, never>;
        Returns: {
          opening: number;
          disbursements: number;
          repayments: number;
          reversals: number;
        }[];
      };
      /**
       * Phase 10. Called only by the two deferred constraint triggers on the
       * journal tables; raises if an entry has fewer than two lines or does
       * not balance.
       */
      journal_assert_balanced: {
        Args: { p_entry_id: string };
        Returns: undefined;
      };
      /**
       * Phase 9. Records one request against a fixed window and reports
       * whether it is within the limit. SECURITY DEFINER; see migration
       * 20261009000200.
       */
      consume_rate_limit: {
        Args: {
          p_bucket_key: string;
          p_action: string;
          p_limit: number;
          p_window_seconds: number;
        };
        Returns: {
          allowed: boolean;
          remaining: number;
          retry_after_seconds: number;
        }[];
      };
      purge_expired_rate_limits: {
        Args: Record<PropertyKey, never>;
        Returns: number;
      };
      current_profile_id: {
        Args: Record<PropertyKey, never>;
        Returns: string;
      };
      current_user_role_keys: {
        Args: Record<PropertyKey, never>;
        Returns: string[];
      };
      current_user_permissions: {
        Args: Record<PropertyKey, never>;
        Returns: string[];
      };
      current_user_max_rank: {
        Args: Record<PropertyKey, never>;
        Returns: number;
      };
      user_has_permission: {
        Args: { p_permission_key: string };
        Returns: boolean;
      };
      link_client_profile: {
        Args: { p_client_id: string; p_profile_id: string };
        Returns: undefined;
      };
      approve_loan: {
        Args: { p_loan_id: string };
        Returns: string;
      };
      payment_business_date: {
        Args: { p_received_at: string };
        Returns: string;
      };
      business_now: {
        Args: Record<PropertyKey, never>;
        Returns: string;
      };
      business_date: {
        Args: Record<PropertyKey, never>;
        Returns: string;
      };
      business_timezone: {
        Args: Record<PropertyKey, never>;
        Returns: string;
      };
      loan_penalty_outstanding: {
        Args: { p_loan_id: string };
        Returns: number;
      };
      loan_total_outstanding: {
        Args: { p_loan_id: string };
        Returns: number;
      };
      loan_outstanding_as_of: {
        Args: { p_loan_id: string; p_as_of: string };
        Returns: number;
      };
      calculate_loan_breakdown: {
        Args: {
          p_principal: number;
          p_interest_rate_bps: number;
          p_term_months: number;
        };
        Returns: {
          period_number: number;
          opening_principal: number;
          principal_portion: number;
          interest: number;
          total_obligation: number;
          closing_principal: number;
        }[];
      };
      cancel_loan: {
        Args: { p_loan_id: string; p_reason: string };
        Returns: string;
      };
      disburse_loan: {
        Args: { p_loan_id: string };
        Returns: string;
      };
      loan_outstanding: {
        Args: { p_loan_id: string };
        Returns: number;
      };
      mask_nin: {
        Args: { p_nin: string };
        Returns: string;
      };
      post_payment: {
        Args: {
          p_loan_id: string;
          p_amount: number;
          p_payment_method: string;
          p_external_reference: string | null;
          p_idempotency_key: string;
          p_notes?: string | null;
        };
        Returns: string;
      };
      reverse_payment: {
        Args: { p_payment_id: string; p_reason: string };
        Returns: string;
      };
      storage_path_client_id: {
        Args: { p_name: string };
        Returns: string;
      };
      storage_path_guarantor_id: {
        Args: { p_name: string };
        Returns: string;
      };
      storage_path_kind: {
        Args: { p_name: string };
        Returns: string;
      };
      confirm_password_change: {
        Args: { p_auth_user_id: string };
        Returns: string;
      };
      record_sign_in: {
        Args: Record<PropertyKey, never>;
        Returns: undefined;
      };
      record_security_event: {
        Args: { p_action: string; p_metadata?: Json };
        Returns: number;
      };
      next_reference: {
        Args: { p_scope: string };
        Returns: string;
      };
      record_audit_event: {
        Args: {
          p_action: string;
          p_entity_type: string;
          p_entity_id?: string;
          p_old_values?: Json;
          p_new_values?: Json;
          p_metadata?: Json;
          p_request_id?: string;
        };
        Returns: number;
      };
      validate_loan_for_approval: {
        Args: { p_loan_id: string };
        Returns: { failure_code: string; detail: string | null }[];
      };
      user_has_at_least_role: {
        Args: { p_role_key: string };
        Returns: boolean;
      };
      user_has_role: {
        Args: { p_role_key: string };
        Returns: boolean;
      };
    };

    Enums: {
      [_ in never]: never;
    };

    CompositeTypes: {
      [_ in never]: never;
    };
  };
};

// ---------------------------------------------------------------------------
// Convenience aliases
//
// Prefer these over reaching into `Database['public']['Tables'][...]` at every
// call site, so a future schema-wide change touches one place.
// ---------------------------------------------------------------------------

type PublicSchema = Database['public'];

export type TableName = keyof PublicSchema['Tables'];

/** A row as read from the database. */
export type Tables<Name extends TableName> = PublicSchema['Tables'][Name]['Row'];

/** The shape accepted by an insert. */
export type TablesInsert<Name extends TableName> = PublicSchema['Tables'][Name]['Insert'];

/** The shape accepted by an update. */
export type TablesUpdate<Name extends TableName> = PublicSchema['Tables'][Name]['Update'];

export type FunctionName = keyof PublicSchema['Functions'];

export type FunctionArgs<Name extends FunctionName> =
  PublicSchema['Functions'][Name]['Args'];

export type FunctionReturns<Name extends FunctionName> =
  PublicSchema['Functions'][Name]['Returns'];
