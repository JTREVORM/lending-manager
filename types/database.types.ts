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
          phone: string | null;
          email: string | null;
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
          phone?: string | null;
          email?: string | null;
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
          phone?: string | null;
          email?: string | null;
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
        };
        Insert: {
          id?: string;
          /** Assigned by the loans_assign_loan_number trigger; supplying one is refused. */
          loan_number?: never;
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
      /**
       * Phase 9. The company's own name, locale, timezone, logo and brand
       * colour — the fields the application shell needs — readable by every
       * signed-in user, borrowers included. SECURITY DEFINER by design; see
       * migration 20261009000100.
       */
      company_identity: {
        Row: {
          company_name: string;
          currency_code: string;
          locale: string;
          timezone: string;
          logo_path: string | null;
          brand_primary_color: string | null;
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
