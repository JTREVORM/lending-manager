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
          installment_id: string;
          loan_id: string;
          allocated_amount: number;
          allocated_principal: number;
          allocated_interest: number;
          created_at: string;
        };
        Insert: {
          id?: string;
          payment_id: string;
          installment_id: string;
          loan_id: string;
          allocated_amount: number;
          allocated_principal: number;
          allocated_interest: number;
          created_at?: string;
        };
        Update: {
          id?: string;
          payment_id?: string;
          installment_id?: string;
          loan_id?: string;
          allocated_amount?: number;
          allocated_principal?: number;
          allocated_interest?: number;
          created_at?: string;
        };
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
          outstanding: number;
          principal_remaining: number;
          interest_remaining: number;
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
    };

    Functions: {
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
