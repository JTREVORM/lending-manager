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
      // --- Polytos Phase 4: benefits, beneficiaries and meetings ------------
      //
      // `member_beneficiary_identities` is a table of its own because Row
      // Level Security is row-level: a single beneficiary table could only
      // grant or deny the whole row, so the clerk who must see *that* a
      // member has a verified next of kin would thereby see who she is. The
      // same split `client_identities` makes for a National Identification
      // Number.
      //
      // Every `Insert` and `Update` shape below is here because the generator
      // emits them, not because anything uses them: 20261022001200 grants no
      // INSERT on any of these tables and a narrow UPDATE on two, so every
      // write goes through a SECURITY DEFINER function. A caller that tried
      // one would be refused by the grant before the type ever mattered.

      beneficiary_relationships: {
        Row: {
          key: string;
          label: string;
          sort_order: number;
          condolence_eligible: boolean | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          key: string;
          label: string;
          sort_order: number;
          condolence_eligible?: boolean | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          key?: string;
          label?: string;
          sort_order?: number;
          condolence_eligible?: boolean | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      benefit_document_kinds: {
        Row: {
          key: string;
          label: string;
          claim_type: string | null;
          sort_order: number;
          is_required_for_assessment: boolean;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          key: string;
          label: string;
          claim_type?: string | null;
          sort_order: number;
          is_required_for_assessment?: boolean;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          key?: string;
          label?: string;
          claim_type?: string | null;
          sort_order?: number;
          is_required_for_assessment?: boolean;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      member_beneficiaries: {
        Row: {
          id: string;
          beneficiary_number: string;
          membership_id: string;
          client_id: string;
          branch_id: string;
          relationship: string;
          identity_digest: string;
          is_primary: boolean;
          status: string;
          ended_on: string | null;
          ended_reason: string | null;
          supersedes_id: string | null;
          verification_status: string;
          verification_evidence_kind: string | null;
          verification_evidence_path: string | null;
          verification_note: string | null;
          verified_at: string | null;
          verified_by: string | null;
          verified_by_label: string | null;
          rejected_at: string | null;
          rejected_reason: string | null;
          recorded_by: string | null;
          recorded_by_label: string;
          recorded_on: string;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          beneficiary_number: string;
          membership_id: string;
          client_id: string;
          branch_id: string;
          relationship: string;
          identity_digest: string;
          is_primary?: boolean;
          status?: string;
          ended_on?: string | null;
          ended_reason?: string | null;
          supersedes_id?: string | null;
          verification_status?: string;
          verification_evidence_kind?: string | null;
          verification_evidence_path?: string | null;
          verification_note?: string | null;
          verified_at?: string | null;
          verified_by?: string | null;
          verified_by_label?: string | null;
          rejected_at?: string | null;
          rejected_reason?: string | null;
          recorded_by?: string | null;
          recorded_by_label?: string;
          recorded_on: string;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          beneficiary_number?: string;
          membership_id?: string;
          client_id?: string;
          branch_id?: string;
          relationship?: string;
          identity_digest?: string;
          is_primary?: boolean;
          status?: string;
          ended_on?: string | null;
          ended_reason?: string | null;
          supersedes_id?: string | null;
          verification_status?: string;
          verification_evidence_kind?: string | null;
          verification_evidence_path?: string | null;
          verification_note?: string | null;
          verified_at?: string | null;
          verified_by?: string | null;
          verified_by_label?: string | null;
          rejected_at?: string | null;
          rejected_reason?: string | null;
          recorded_by?: string | null;
          recorded_by_label?: string;
          recorded_on?: string;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      member_beneficiary_identities: {
        Row: {
          beneficiary_id: string;
          full_name: string;
          phone: string;
          alternative_phone: string | null;
          village_area: string | null;
          district: string | null;
          identity_reference: string | null;
          identity_document_kind: string | null;
          created_at: string;
        };
        Insert: {
          beneficiary_id: string;
          full_name: string;
          phone: string;
          alternative_phone?: string | null;
          village_area?: string | null;
          district?: string | null;
          identity_reference?: string | null;
          identity_document_kind?: string | null;
          created_at?: string;
        };
        Update: {
          beneficiary_id?: string;
          full_name?: string;
          phone?: string;
          alternative_phone?: string | null;
          village_area?: string | null;
          district?: string | null;
          identity_reference?: string | null;
          identity_document_kind?: string | null;
          created_at?: string;
        };
        Relationships: [];
      };
      benefit_claims: {
        Row: {
          deceased_beneficiary_id: string | null;
          id: string;
          claim_number: string;
          claim_type: string;
          membership_id: string;
          client_id: string;
          branch_id: string;
          policy_version_id: string;
          policy_version: string;
          status: string;
          event_date: string;
          provider_name: string | null;
          admission_at: string | null;
          discharge_at: string | null;
          bill_amount: number | null;
          admission_nights: number | null;
          admission_inclusive_days: number | null;
          admission_elapsed_days: number | null;
          deceased_name: string | null;
          deceased_relationship: string | null;
          beneficiary_id: string | null;
          claimed_amount: number | null;
          assessed_amount: number | null;
          approved_amount: number | null;
          submitted_at: string | null;
          submitted_by: string | null;
          submitted_by_label: string | null;
          verified_at: string | null;
          verified_by: string | null;
          verified_by_label: string | null;
          information_required_note: string | null;
          assessed_at: string | null;
          assessed_by: string | null;
          assessed_by_label: string | null;
          assessment_note: string | null;
          decided_at: string | null;
          decided_by: string | null;
          decided_by_label: string | null;
          decision_note: string | null;
          rejected_reason: string | null;
          cancelled_reason: string | null;
          payment_id: string | null;
          created_by: string | null;
          created_by_label: string;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          deceased_beneficiary_id?: string | null;
          id?: string;
          claim_number: string;
          claim_type: string;
          membership_id: string;
          client_id: string;
          branch_id: string;
          policy_version_id: string;
          policy_version: string;
          status?: string;
          event_date: string;
          provider_name?: string | null;
          admission_at?: string | null;
          discharge_at?: string | null;
          bill_amount?: number | null;
          admission_nights?: number | null;
          admission_inclusive_days?: number | null;
          admission_elapsed_days?: number | null;
          deceased_name?: string | null;
          deceased_relationship?: string | null;
          beneficiary_id?: string | null;
          claimed_amount?: number | null;
          assessed_amount?: number | null;
          approved_amount?: number | null;
          submitted_at?: string | null;
          submitted_by?: string | null;
          submitted_by_label?: string | null;
          verified_at?: string | null;
          verified_by?: string | null;
          verified_by_label?: string | null;
          information_required_note?: string | null;
          assessed_at?: string | null;
          assessed_by?: string | null;
          assessed_by_label?: string | null;
          assessment_note?: string | null;
          decided_at?: string | null;
          decided_by?: string | null;
          decided_by_label?: string | null;
          decision_note?: string | null;
          rejected_reason?: string | null;
          cancelled_reason?: string | null;
          payment_id?: string | null;
          created_by?: string | null;
          created_by_label?: string;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          deceased_beneficiary_id?: string | null;
          id?: string;
          claim_number?: string;
          claim_type?: string;
          membership_id?: string;
          client_id?: string;
          branch_id?: string;
          policy_version_id?: string;
          policy_version?: string;
          status?: string;
          event_date?: string;
          provider_name?: string | null;
          admission_at?: string | null;
          discharge_at?: string | null;
          bill_amount?: number | null;
          admission_nights?: number | null;
          admission_inclusive_days?: number | null;
          admission_elapsed_days?: number | null;
          deceased_name?: string | null;
          deceased_relationship?: string | null;
          beneficiary_id?: string | null;
          claimed_amount?: number | null;
          assessed_amount?: number | null;
          approved_amount?: number | null;
          submitted_at?: string | null;
          submitted_by?: string | null;
          submitted_by_label?: string | null;
          verified_at?: string | null;
          verified_by?: string | null;
          verified_by_label?: string | null;
          information_required_note?: string | null;
          assessed_at?: string | null;
          assessed_by?: string | null;
          assessed_by_label?: string | null;
          assessment_note?: string | null;
          decided_at?: string | null;
          decided_by?: string | null;
          decided_by_label?: string | null;
          decision_note?: string | null;
          rejected_reason?: string | null;
          cancelled_reason?: string | null;
          payment_id?: string | null;
          created_by?: string | null;
          created_by_label?: string;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      benefit_claim_documents: {
        Row: {
          id: string;
          claim_id: string | null;
          beneficiary_id: string | null;
          membership_id: string;
          client_id: string;
          kind: string;
          object_path: string;
          content_type: string;
          byte_size: number;
          label: string | null;
          uploaded_at: string;
          uploaded_by: string | null;
          uploaded_by_label: string;
          verification_status: string;
          verified_at: string | null;
          verified_by: string | null;
          verified_by_label: string | null;
          verification_note: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          claim_id?: string | null;
          beneficiary_id?: string | null;
          membership_id: string;
          client_id: string;
          kind: string;
          object_path: string;
          content_type: string;
          byte_size: number;
          label?: string | null;
          uploaded_at?: string;
          uploaded_by?: string | null;
          uploaded_by_label?: string;
          verification_status?: string;
          verified_at?: string | null;
          verified_by?: string | null;
          verified_by_label?: string | null;
          verification_note?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          claim_id?: string | null;
          beneficiary_id?: string | null;
          membership_id?: string;
          client_id?: string;
          kind?: string;
          object_path?: string;
          content_type?: string;
          byte_size?: number;
          label?: string | null;
          uploaded_at?: string;
          uploaded_by?: string | null;
          uploaded_by_label?: string;
          verification_status?: string;
          verified_at?: string | null;
          verified_by?: string | null;
          verified_by_label?: string | null;
          verification_note?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      benefit_assessment_snapshots: {
        Row: {
          qualification_basis: string | null;
          savings_qualifying_months: number | null;
          savings_months_required: number | null;
          savings_qualified: boolean | null;
          medical_cap_mode: string | null;
          death_confirmations_required: number | null;
          death_confirmations_recorded: number | null;
          deceased_beneficiary_id: string | null;
          deceased_beneficiary_number: string | null;
          deceased_listed_on: string | null;
          outstanding_loan_principal: number | null;
          outstanding_loan_count: number | null;
          claim_id: string;
          claim_number: string;
          claim_type: string;
          membership_id: string;
          membership_number: string;
          client_id: string;
          policy_version_id: string;
          policy_version: string;
          assessed_on: string;
          event_date: string;
          benefit_rate_bps: number | null;
          min_admission_days: number | null;
          fixed_benefit_amount: number | null;
          waiting_period_days: number;
          waiting_period_served: boolean;
          bill_amount: number | null;
          admission_nights: number | null;
          admission_inclusive_days: number | null;
          admission_elapsed_days: number | null;
          year_basis: string | null;
          period_from: string | null;
          period_to: string | null;
          annual_cap: number | null;
          claims_per_year: number | null;
          prior_claims_in_period: number | null;
          prior_amount_in_period: number | null;
          remaining_cap_before: number | null;
          deceased_relationship: string | null;
          relationship_eligible: boolean | null;
          beneficiary_id: string | null;
          beneficiary_number: string | null;
          beneficiary_name: string | null;
          beneficiary_relationship: string | null;
          beneficiary_phone: string | null;
          beneficiary_verified_at: string | null;
          beneficiary_verified_by_label: string | null;
          outstanding_member_loan_principal: number;
          active_member_loan_count: number;
          pledged_savings: number;
          savings_balance: number;
          verified_document_count: number;
          verified_document_kinds: string[];
          assessed_amount: number;
          assessment_note: string | null;
          assessed_by: string | null;
          assessed_by_label: string;
          captured_at: string;
        };
        Insert: {
          qualification_basis?: string | null;
          savings_qualifying_months?: number | null;
          savings_months_required?: number | null;
          savings_qualified?: boolean | null;
          medical_cap_mode?: string | null;
          death_confirmations_required?: number | null;
          death_confirmations_recorded?: number | null;
          deceased_beneficiary_id?: string | null;
          deceased_beneficiary_number?: string | null;
          deceased_listed_on?: string | null;
          outstanding_loan_principal?: number | null;
          outstanding_loan_count?: number | null;
          claim_id: string;
          claim_number: string;
          claim_type: string;
          membership_id: string;
          membership_number: string;
          client_id: string;
          policy_version_id: string;
          policy_version: string;
          assessed_on: string;
          event_date: string;
          benefit_rate_bps?: number | null;
          min_admission_days?: number | null;
          fixed_benefit_amount?: number | null;
          waiting_period_days: number;
          waiting_period_served: boolean;
          bill_amount?: number | null;
          admission_nights?: number | null;
          admission_inclusive_days?: number | null;
          admission_elapsed_days?: number | null;
          year_basis?: string | null;
          period_from?: string | null;
          period_to?: string | null;
          annual_cap?: number | null;
          claims_per_year?: number | null;
          prior_claims_in_period?: number | null;
          prior_amount_in_period?: number | null;
          remaining_cap_before?: number | null;
          deceased_relationship?: string | null;
          relationship_eligible?: boolean | null;
          beneficiary_id?: string | null;
          beneficiary_number?: string | null;
          beneficiary_name?: string | null;
          beneficiary_relationship?: string | null;
          beneficiary_phone?: string | null;
          beneficiary_verified_at?: string | null;
          beneficiary_verified_by_label?: string | null;
          outstanding_member_loan_principal?: number;
          active_member_loan_count?: number;
          pledged_savings?: number;
          savings_balance?: number;
          verified_document_count: number;
          verified_document_kinds: string[];
          assessed_amount: number;
          assessment_note?: string | null;
          assessed_by?: string | null;
          assessed_by_label: string;
          captured_at?: string;
        };
        Update: {
          qualification_basis?: string | null;
          savings_qualifying_months?: number | null;
          savings_months_required?: number | null;
          savings_qualified?: boolean | null;
          medical_cap_mode?: string | null;
          death_confirmations_required?: number | null;
          death_confirmations_recorded?: number | null;
          deceased_beneficiary_id?: string | null;
          deceased_beneficiary_number?: string | null;
          deceased_listed_on?: string | null;
          outstanding_loan_principal?: number | null;
          outstanding_loan_count?: number | null;
          claim_id?: string;
          claim_number?: string;
          claim_type?: string;
          membership_id?: string;
          membership_number?: string;
          client_id?: string;
          policy_version_id?: string;
          policy_version?: string;
          assessed_on?: string;
          event_date?: string;
          benefit_rate_bps?: number | null;
          min_admission_days?: number | null;
          fixed_benefit_amount?: number | null;
          waiting_period_days?: number;
          waiting_period_served?: boolean;
          bill_amount?: number | null;
          admission_nights?: number | null;
          admission_inclusive_days?: number | null;
          admission_elapsed_days?: number | null;
          year_basis?: string | null;
          period_from?: string | null;
          period_to?: string | null;
          annual_cap?: number | null;
          claims_per_year?: number | null;
          prior_claims_in_period?: number | null;
          prior_amount_in_period?: number | null;
          remaining_cap_before?: number | null;
          deceased_relationship?: string | null;
          relationship_eligible?: boolean | null;
          beneficiary_id?: string | null;
          beneficiary_number?: string | null;
          beneficiary_name?: string | null;
          beneficiary_relationship?: string | null;
          beneficiary_phone?: string | null;
          beneficiary_verified_at?: string | null;
          beneficiary_verified_by_label?: string | null;
          outstanding_member_loan_principal?: number;
          active_member_loan_count?: number;
          pledged_savings?: number;
          savings_balance?: number;
          verified_document_count?: number;
          verified_document_kinds?: string[];
          assessed_amount?: number;
          assessment_note?: string | null;
          assessed_by?: string | null;
          assessed_by_label?: string;
          captured_at?: string;
        };
        Relationships: [];
      };
      benefit_payments: {
        Row: {
          id: string;
          payment_number: string;
          claim_id: string;
          claim_number: string;
          claim_type: string;
          membership_id: string;
          client_id: string;
          branch_id: string;
          amount: number;
          recipient_kind: string;
          recipient_name: string;
          recipient_phone: string;
          recipient_beneficiary_id: string | null;
          recipient_beneficiary_number: string | null;
          payment_method: string;
          cash_account_id: string;
          expense_account_id: string;
          external_reference: string | null;
          idempotency_key: string;
          value_date: string;
          journal_entry_id: string;
          paid_at: string;
          paid_by: string | null;
          paid_by_label: string;
          reversed_at: string | null;
          reversed_by: string | null;
          reversed_by_label: string | null;
          reversal_reason: string | null;
          reversal_journal_entry_id: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          payment_number: string;
          claim_id: string;
          claim_number: string;
          claim_type: string;
          membership_id: string;
          client_id: string;
          branch_id: string;
          amount: number;
          recipient_kind: string;
          recipient_name: string;
          recipient_phone: string;
          recipient_beneficiary_id?: string | null;
          recipient_beneficiary_number?: string | null;
          payment_method: string;
          cash_account_id: string;
          expense_account_id: string;
          external_reference?: string | null;
          idempotency_key: string;
          value_date: string;
          journal_entry_id: string;
          paid_at?: string;
          paid_by?: string | null;
          paid_by_label?: string;
          reversed_at?: string | null;
          reversed_by?: string | null;
          reversed_by_label?: string | null;
          reversal_reason?: string | null;
          reversal_journal_entry_id?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          payment_number?: string;
          claim_id?: string;
          claim_number?: string;
          claim_type?: string;
          membership_id?: string;
          client_id?: string;
          branch_id?: string;
          amount?: number;
          recipient_kind?: string;
          recipient_name?: string;
          recipient_phone?: string;
          recipient_beneficiary_id?: string | null;
          recipient_beneficiary_number?: string | null;
          payment_method?: string;
          cash_account_id?: string;
          expense_account_id?: string;
          external_reference?: string | null;
          idempotency_key?: string;
          value_date?: string;
          journal_entry_id?: string;
          paid_at?: string;
          paid_by?: string | null;
          paid_by_label?: string;
          reversed_at?: string | null;
          reversed_by?: string | null;
          reversed_by_label?: string | null;
          reversal_reason?: string | null;
          reversal_journal_entry_id?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      membership_meetings: {
        Row: {
          id: string;
          meeting_number: string;
          branch_id: string;
          meeting_type: string;
          title: string;
          venue: string;
          scheduled_at: string;
          meeting_date: string | null;
          status: string;
          agenda: string | null;
          minutes: string | null;
          minutes_finalised_at: string | null;
          minutes_finalised_by: string | null;
          minutes_finalised_by_label: string | null;
          minutes_amended_at: string | null;
          minutes_amendment_note: string | null;
          rescheduled_from: string | null;
          reschedule_reason: string | null;
          cancelled_at: string | null;
          cancellation_reason: string | null;
          created_by: string | null;
          created_by_label: string;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          meeting_number: string;
          branch_id: string;
          meeting_type?: string;
          title: string;
          venue: string;
          scheduled_at: string;
          meeting_date?: string | null;
          status?: string;
          agenda?: string | null;
          minutes?: string | null;
          minutes_finalised_at?: string | null;
          minutes_finalised_by?: string | null;
          minutes_finalised_by_label?: string | null;
          minutes_amended_at?: string | null;
          minutes_amendment_note?: string | null;
          rescheduled_from?: string | null;
          reschedule_reason?: string | null;
          cancelled_at?: string | null;
          cancellation_reason?: string | null;
          created_by?: string | null;
          created_by_label?: string;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          meeting_number?: string;
          branch_id?: string;
          meeting_type?: string;
          title?: string;
          venue?: string;
          scheduled_at?: string;
          meeting_date?: string | null;
          status?: string;
          agenda?: string | null;
          minutes?: string | null;
          minutes_finalised_at?: string | null;
          minutes_finalised_by?: string | null;
          minutes_finalised_by_label?: string | null;
          minutes_amended_at?: string | null;
          minutes_amendment_note?: string | null;
          rescheduled_from?: string | null;
          reschedule_reason?: string | null;
          cancelled_at?: string | null;
          cancellation_reason?: string | null;
          created_by?: string | null;
          created_by_label?: string;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      meeting_attendance: {
        Row: {
          id: string;
          meeting_id: string;
          membership_id: string;
          client_id: string;
          attendance: string;
          absence_reason: string | null;
          note: string | null;
          marked_at: string;
          marked_by: string | null;
          marked_by_label: string;
          corrected_at: string | null;
          correction_count: number;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          meeting_id: string;
          membership_id: string;
          client_id: string;
          attendance: string;
          absence_reason?: string | null;
          note?: string | null;
          marked_at?: string;
          marked_by?: string | null;
          marked_by_label?: string;
          corrected_at?: string | null;
          correction_count?: number;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          meeting_id?: string;
          membership_id?: string;
          client_id?: string;
          attendance?: string;
          absence_reason?: string | null;
          note?: string | null;
          marked_at?: string;
          marked_by?: string | null;
          marked_by_label?: string;
          corrected_at?: string | null;
          correction_count?: number;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      meeting_attendance_corrections: {
        Row: {
          id: string;
          attendance_id: string;
          meeting_id: string;
          membership_id: string;
          previous_attendance: string;
          previous_absence_reason: string | null;
          previous_note: string | null;
          previous_marked_by_label: string;
          new_attendance: string;
          new_absence_reason: string | null;
          reason: string;
          corrected_at: string;
          corrected_by: string | null;
          corrected_by_label: string;
        };
        Insert: {
          id?: string;
          attendance_id: string;
          meeting_id: string;
          membership_id: string;
          previous_attendance: string;
          previous_absence_reason?: string | null;
          previous_note?: string | null;
          previous_marked_by_label: string;
          new_attendance: string;
          new_absence_reason?: string | null;
          reason: string;
          corrected_at?: string;
          corrected_by?: string | null;
          corrected_by_label?: string;
        };
        Update: {
          id?: string;
          attendance_id?: string;
          meeting_id?: string;
          membership_id?: string;
          previous_attendance?: string;
          previous_absence_reason?: string | null;
          previous_note?: string | null;
          previous_marked_by_label?: string;
          new_attendance?: string;
          new_absence_reason?: string | null;
          reason?: string;
          corrected_at?: string;
          corrected_by?: string | null;
          corrected_by_label?: string;
        };
        Relationships: [];
      };
      meeting_action_items: {
        Row: {
          id: string;
          meeting_id: string;
          description: string;
          assigned_to: string | null;
          assigned_to_label: string | null;
          due_on: string | null;
          status: string;
          completed_at: string | null;
          completed_by: string | null;
          completed_by_label: string | null;
          completion_note: string | null;
          created_by: string | null;
          created_by_label: string;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          meeting_id: string;
          description: string;
          assigned_to?: string | null;
          assigned_to_label?: string | null;
          due_on?: string | null;
          status?: string;
          completed_at?: string | null;
          completed_by?: string | null;
          completed_by_label?: string | null;
          completion_note?: string | null;
          created_by?: string | null;
          created_by_label?: string;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          meeting_id?: string;
          description?: string;
          assigned_to?: string | null;
          assigned_to_label?: string | null;
          due_on?: string | null;
          status?: string;
          completed_at?: string | null;
          completed_by?: string | null;
          completed_by_label?: string | null;
          completion_note?: string | null;
          created_by?: string | null;
          created_by_label?: string;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      member_loan_eligibility_snapshots: {
        Row: {
          loan_id: string;
          membership_id: string;
          membership_number: string;
          client_id: string;
          policy_version_id: string;
          policy_version: string;
          savings_account_id: string;
          savings_account_number: string;
          assessed_on: string;
          months_required: number;
          must_be_consecutive: boolean;
          qualifying_months: number;
          consecutive_qualifying_months: number;
          eligible_savings: number;
          multiplier_bps: number;
          max_eligible_loan: number;
          interest_rate_bps: number;
          interest_basis: string;
          interest_method: string;
          max_term_months: number;
          required_cadence: string;
          amount_requested: number;
          term_requested: number;
          repayment_frequency: string;
          active_loan_count: number;
          outstanding_principal: number;
          pledged_savings_before: number;
          pending_withdrawals_before: number;
          available_savings: number;
          captured_at: string;
          captured_by: string | null;
          captured_by_label: string;
        };
        Insert: {
          loan_id: string;
          membership_id: string;
          membership_number: string;
          client_id: string;
          policy_version_id: string;
          policy_version: string;
          savings_account_id: string;
          savings_account_number: string;
          assessed_on: string;
          months_required: number;
          must_be_consecutive: boolean;
          qualifying_months: number;
          consecutive_qualifying_months: number;
          eligible_savings: number;
          multiplier_bps: number;
          max_eligible_loan: number;
          interest_rate_bps: number;
          interest_basis: string;
          interest_method: string;
          max_term_months: number;
          required_cadence: string;
          amount_requested: number;
          term_requested: number;
          repayment_frequency: string;
          active_loan_count: number;
          outstanding_principal: number;
          pledged_savings_before: number;
          pending_withdrawals_before?: number;
          available_savings: number;
          captured_at?: string;
          captured_by?: string | null;
          captured_by_label?: string;
        };
        Update: {
          loan_id?: string;
          membership_id?: string;
          membership_number?: string;
          client_id?: string;
          policy_version_id?: string;
          policy_version?: string;
          savings_account_id?: string;
          savings_account_number?: string;
          assessed_on?: string;
          months_required?: number;
          must_be_consecutive?: boolean;
          qualifying_months?: number;
          consecutive_qualifying_months?: number;
          eligible_savings?: number;
          multiplier_bps?: number;
          max_eligible_loan?: number;
          interest_rate_bps?: number;
          interest_basis?: string;
          interest_method?: string;
          max_term_months?: number;
          required_cadence?: string;
          amount_requested?: number;
          term_requested?: number;
          repayment_frequency?: string;
          active_loan_count?: number;
          outstanding_principal?: number;
          pledged_savings_before?: number;
          pending_withdrawals_before?: number;
          available_savings?: number;
          captured_at?: string;
          captured_by?: string | null;
          captured_by_label?: string;
        };
        Relationships: [];
      };
      member_loan_savings_pledges: {
        Row: {
          loan_id: string;
          savings_account_id: string;
          membership_id: string;
          client_id: string;
          policy_version_id: string;
          pledged_amount: number;
          loan_principal: number;
          multiplier_bps: number;
          eligible_savings_at_pledge: number;
          pledged_at: string;
          pledged_by: string | null;
          pledged_by_label: string;
          released_at: string | null;
          released_reason: string | null;
        };
        Insert: {
          loan_id: string;
          savings_account_id: string;
          membership_id: string;
          client_id: string;
          policy_version_id: string;
          pledged_amount: number;
          loan_principal: number;
          multiplier_bps: number;
          eligible_savings_at_pledge: number;
          pledged_at?: string;
          pledged_by?: string | null;
          pledged_by_label?: string;
          released_at?: string | null;
          released_reason?: string | null;
        };
        Update: {
          loan_id?: string;
          savings_account_id?: string;
          membership_id?: string;
          client_id?: string;
          policy_version_id?: string;
          pledged_amount?: number;
          loan_principal?: number;
          multiplier_bps?: number;
          eligible_savings_at_pledge?: number;
          pledged_at?: string;
          pledged_by?: string | null;
          pledged_by_label?: string;
          released_at?: string | null;
          released_reason?: string | null;
        };
        Relationships: [];
      };
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
          allow_client_as_guarantor: boolean;
          guarantor_min_age_years: number;
          guarantor_max_active_loans: number;
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
          allow_client_as_guarantor?: boolean;
          guarantor_min_age_years?: number;
          guarantor_max_active_loans?: number;
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
          allow_client_as_guarantor?: boolean;
          guarantor_min_age_years?: number;
          guarantor_max_active_loans?: number;
        };
        Relationships: [];
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
          employer_name: string | null;
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
          employer_name?: string | null;
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
          employer_name?: string | null;
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
          monthly_expenses: number | null;
          business_contact: string | null;
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
          monthly_expenses?: number | null;
          business_contact?: string | null;
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
          monthly_expenses?: number | null;
          business_contact?: string | null;
        };
        Relationships: [];
      };

      /**
       * Phase 13. The evidence filed with a loan application: a payslip, an
       * employment letter, a trading licence, a bank statement, a business
       * photograph, or a guarantor's identification, photograph or signature.
       * Writable while the loan is a draft and frozen from submission, like
       * every other part of the application.
       */
      loan_documents: {
        Row: {
          id: string;
          loan_id: string;
          loan_guarantor_id: string | null;
          kind: string;
          storage_path: string;
          label: string | null;
          content_type: string;
          byte_size: number;
          created_by: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          loan_id: string;
          loan_guarantor_id?: string | null;
          kind: string;
          storage_path: string;
          label?: string | null;
          content_type: string;
          byte_size: number;
          created_by?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          loan_id?: string;
          loan_guarantor_id?: string | null;
          kind?: string;
          storage_path?: string;
          label?: string | null;
          content_type?: string;
          byte_size?: number;
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
          employment_status: string | null;
          salary_verification: string;
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
          employment_status?: string | null;
          salary_verification?: string;
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
          employment_status?: string | null;
          salary_verification?: string;
        };
        Relationships: [];
      };

      loan_schedules: {
        Row: {
          loan_id: string;
          repayment_frequency: string;
          frequency_label: string;
          /**
           * Polytos Phase 3. Null for a `calendar_month` schedule, where the
           * step is a month rather than a number of days.
           */
          interval_days: number | null;
          /** `fixed_days` for every schedule generated before Polytos Phase 3. */
          cadence_kind: string;
          /** Null for a fixed-day schedule. */
          month_anchor: string | null;
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
          interval_days?: number | null;
          cadence_kind?: string;
          month_anchor?: string | null;
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
          interval_days?: number | null;
          cadence_kind?: string;
          month_anchor?: string | null;
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
          /**
           * Polytos Phase 3. Null for a `calendar_month` cadence: a month is
           * 28, 29, 30 or 31 days, so it is not a number of days at all.
           */
          interval_days: number | null;
          /** `fixed_days` or `calendar_month`. Immutable once set. */
          cadence_kind: string;
          /**
           * For a calendar cadence, what a collection does in a month that has
           * no such day. Null means the business has not decided, and no
           * monthly schedule can be generated until it does.
           */
          month_anchor: string | null;
          is_active: boolean;
          sort_order: number;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          key: string;
          label: string;
          interval_days?: number | null;
          cadence_kind?: string;
          month_anchor?: string | null;
          is_active?: boolean;
          sort_order: number;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          key?: string;
          label?: string;
          /** Immutable by trigger; a change is refused. */
          interval_days?: never;
          /** Immutable by trigger; a change is refused. */
          cadence_kind?: never;
          /** Write-once by trigger: settable while null, frozen thereafter. */
          month_anchor?: string | null;
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

      // --- Phase 14: security and recovery -----------------------------------
      // `loan_recovery_actions` has no Update or Delete shape, which is not an
      // omission: statement-level triggers refuse both outright, the way
      // `audit_log` and `client_remarks` do.
      loan_collateral: {
        Row: {
          id: string;
          loan_id: string;
          item_type: string;
          description: string;
          estimated_value: number;
          valued_on: string;
          serial_number: string | null;
          ownership_document: string | null;
          location: string | null;
          status: string;
          released_at: string | null;
          released_by: string | null;
          release_reason: string | null;
          realised_amount: number | null;
          realised_at: string | null;
          realised_by: string | null;
          created_by: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          loan_id: string;
          item_type: string;
          description: string;
          estimated_value: number;
          valued_on: string;
          serial_number?: string | null;
          ownership_document?: string | null;
          location?: string | null;
          status?: string;
          released_at?: string | null;
          released_by?: string | null;
          release_reason?: string | null;
          realised_amount?: number | null;
          realised_at?: string | null;
          realised_by?: string | null;
          created_by?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          loan_id?: string;
          item_type?: string;
          description?: string;
          estimated_value?: number;
          valued_on?: string;
          serial_number?: string | null;
          ownership_document?: string | null;
          location?: string | null;
          status?: string;
          released_at?: string | null;
          released_by?: string | null;
          release_reason?: string | null;
          realised_amount?: number | null;
          realised_at?: string | null;
          realised_by?: string | null;
          created_by?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      loan_recovery_actions: {
        Row: {
          id: string;
          loan_id: string;
          action_kind: string;
          outcome: string | null;
          notes: string;
          action_date: string;
          follow_up_on: string | null;
          promised_amount: number | null;
          promised_on: string | null;
          created_by: string | null;
          created_by_label: string;
          created_at: string;
          corrects_action_id: string | null;
        };
        Insert: {
          id?: string;
          loan_id: string;
          action_kind: string;
          outcome?: string | null;
          notes: string;
          action_date?: string;
          follow_up_on?: string | null;
          promised_amount?: number | null;
          promised_on?: string | null;
          created_by?: string | null;
          created_by_label?: string;
          created_at?: string;
          corrects_action_id?: string | null;
        };
        Update: {
          id?: string;
          loan_id?: string;
          action_kind?: string;
          outcome?: string | null;
          notes?: string;
          action_date?: string;
          follow_up_on?: string | null;
          promised_amount?: number | null;
          promised_on?: string | null;
          created_by?: string | null;
          created_by_label?: string;
          created_at?: string;
          corrects_action_id?: string | null;
        };
        Relationships: [];
      };

      // --- Phase 15: notifications -------------------------------------------
      // Neither table has an Update or a Delete shape. Both refuse the pair
      // with statement-level triggers, and both hold every reference with
      // `on delete restrict` for exactly that reason.
      notifications: {
        Row: {
          id: string;
          category: string;
          severity: string;
          title: string;
          body: string | null;
          audience_permission: string;
          audience_profile_id: string | null;
          audience_branch_id: string | null;
          entity_type: string;
          entity_id: string | null;
          actor_profile_id: string | null;
          actor_label: string;
          occurred_at: string;
          dedupe_key: string;
        };
        Insert: {
          id?: string;
          category: string;
          severity?: string;
          title: string;
          body?: string | null;
          audience_permission: string;
          audience_profile_id?: string | null;
          audience_branch_id?: string | null;
          entity_type: string;
          entity_id?: string | null;
          actor_profile_id?: string | null;
          actor_label?: string;
          occurred_at?: string;
          dedupe_key: string;
        };
        Update: {
          id?: string;
          category?: string;
          severity?: string;
          title?: string;
          body?: string | null;
          audience_permission?: string;
          audience_profile_id?: string | null;
          audience_branch_id?: string | null;
          entity_type?: string;
          entity_id?: string | null;
          actor_profile_id?: string | null;
          actor_label?: string;
          occurred_at?: string;
          dedupe_key?: string;
        };
        Relationships: [];
      };
      notification_reads: {
        Row: {
          notification_id: string;
          profile_id: string;
          read_at: string;
        };
        Insert: {
          notification_id: string;
          profile_id: string;
          read_at?: string;
        };
        Update: {
          notification_id?: string;
          profile_id?: string;
          read_at?: string;
        };
        Relationships: [];
      };

      /**
       * Polytos Phase 1. The membership programme's rules, effective-dated.
       *
       * Nullable columns are decisions the client has not made — never a
       * default. The six readiness booleans are generated and therefore
       * absent from `Insert` and `Update`: the database computes them, and no
       * write can set one. Five are per-activity — enrolment does not wait on
       * the profit formula — and `is_financially_enabled` is the overall
       * completeness indicator.
       */
      membership_policy_versions: {
        Row: {
          medical_benefit_cap_mode: string | null;
          benefit_qualification_basis: string | null;
          medical_benefit_year_basis: string | null;
          death_confirmations_required: number | null;
          meeting_absence_fine: number | null;
          is_medical_benefit_enabled: boolean;
          is_condolence_benefit_enabled: boolean;
          is_bereavement_benefit_enabled: boolean;
          id: string;
          version: string;
          title: string;
          effective_from: string | null;
          status: string;
          registration_fee: number;
          monthly_savings_minimum: number;
          savings_qualifying_months: number;
          member_loan_interest_rate_bps: number;
          member_loan_max_term_months: number;
          member_loan_weekly_cadence_max_months: number;
          non_member_loan_max_term_months: number;
          medical_benefit_rate_bps: number;
          medical_benefit_min_admission_days: number;
          family_condolence_benefit: number;
          member_bereavement_benefit: number;
          interest_basis: string | null;
          interest_method: string | null;
          savings_to_loan_multiplier_bps: number | null;
          qualifying_months_consecutive: boolean | null;
          savings_withdrawal_with_active_loan: string | null;
          profit_distribution_basis: string | null;
          medical_benefit_annual_cap: number | null;
          medical_benefit_claims_per_year: number | null;
          benefit_waiting_period_days: number | null;
          approved_at: string | null;
          approved_by: string | null;
          approved_by_label: string | null;
          approval_reference: string | null;
          notes: string | null;
          created_by: string | null;
          created_at: string;
          updated_at: string;
          is_enrolment_enabled: boolean;
          is_savings_enabled: boolean;
          is_member_lending_enabled: boolean;
          is_benefits_enabled: boolean;
          is_profit_sharing_enabled: boolean;
          is_financially_enabled: boolean;
        };
        Insert: {
          medical_benefit_cap_mode?: string | null;
          benefit_qualification_basis?: string | null;
          medical_benefit_year_basis?: string | null;
          death_confirmations_required?: number | null;
          meeting_absence_fine?: number | null;
          is_medical_benefit_enabled?: never;
          is_condolence_benefit_enabled?: never;
          is_bereavement_benefit_enabled?: never;
          id?: string;
          version: string;
          title: string;
          effective_from?: string | null;
          status?: string;
          registration_fee: number;
          monthly_savings_minimum: number;
          savings_qualifying_months: number;
          member_loan_interest_rate_bps: number;
          member_loan_max_term_months: number;
          member_loan_weekly_cadence_max_months: number;
          non_member_loan_max_term_months: number;
          medical_benefit_rate_bps: number;
          medical_benefit_min_admission_days: number;
          family_condolence_benefit: number;
          member_bereavement_benefit: number;
          interest_basis?: string | null;
          interest_method?: string | null;
          savings_to_loan_multiplier_bps?: number | null;
          qualifying_months_consecutive?: boolean | null;
          savings_withdrawal_with_active_loan?: string | null;
          profit_distribution_basis?: string | null;
          medical_benefit_annual_cap?: number | null;
          medical_benefit_claims_per_year?: number | null;
          benefit_waiting_period_days?: number | null;
          approved_at?: string | null;
          approved_by?: string | null;
          approved_by_label?: string | null;
          approval_reference?: string | null;
          notes?: string | null;
          created_by?: string | null;
          created_at?: string;
          updated_at?: string;
          is_enrolment_enabled?: never;
          is_savings_enabled?: never;
          is_member_lending_enabled?: never;
          is_benefits_enabled?: never;
          is_profit_sharing_enabled?: never;
          is_financially_enabled?: never;
        };
        Update: {
          medical_benefit_cap_mode?: string | null;
          benefit_qualification_basis?: string | null;
          medical_benefit_year_basis?: string | null;
          death_confirmations_required?: number | null;
          meeting_absence_fine?: number | null;
          is_medical_benefit_enabled?: never;
          is_condolence_benefit_enabled?: never;
          is_bereavement_benefit_enabled?: never;
          id?: string;
          version?: string;
          title?: string;
          effective_from?: string | null;
          status?: string;
          registration_fee?: number;
          monthly_savings_minimum?: number;
          savings_qualifying_months?: number;
          member_loan_interest_rate_bps?: number;
          member_loan_max_term_months?: number;
          member_loan_weekly_cadence_max_months?: number;
          non_member_loan_max_term_months?: number;
          medical_benefit_rate_bps?: number;
          medical_benefit_min_admission_days?: number;
          family_condolence_benefit?: number;
          member_bereavement_benefit?: number;
          interest_basis?: string | null;
          interest_method?: string | null;
          savings_to_loan_multiplier_bps?: number | null;
          qualifying_months_consecutive?: boolean | null;
          savings_withdrawal_with_active_loan?: string | null;
          profit_distribution_basis?: string | null;
          medical_benefit_annual_cap?: number | null;
          medical_benefit_claims_per_year?: number | null;
          benefit_waiting_period_days?: number | null;
          approved_at?: string | null;
          approved_by?: string | null;
          approved_by_label?: string | null;
          approval_reference?: string | null;
          notes?: string | null;
          created_by?: string | null;
          created_at?: string;
          updated_at?: string;
          is_enrolment_enabled?: never;
          is_savings_enabled?: never;
          is_member_lending_enabled?: never;
          is_benefits_enabled?: never;
          is_profit_sharing_enabled?: never;
          is_financially_enabled?: never;
        };
        Relationships: [];
      };

      /**
       * Polytos Phase 1. A client's membership of the savings and benefits
       * programme.
       *
       * Carries no identity data: the member *is* the client it references.
       * `membership_number` is minted by a trigger and refused from a caller,
       * which is why it is absent from `Insert`.
       */
      memberships: {
        Row: {
          id: string;
          membership_number: string;
          client_id: string;
          branch_id: string;
          policy_version_id: string;
          status: string;
          status_reason: string | null;
          status_changed_at: string | null;
          status_changed_by: string | null;
          applied_on: string;
          activated_on: string | null;
          ended_on: string | null;
          notes: string | null;
          created_by: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          membership_number?: never;
          client_id: string;
          branch_id?: string;
          policy_version_id?: string;
          status?: string;
          status_reason?: string | null;
          status_changed_at?: string | null;
          status_changed_by?: string | null;
          applied_on: string;
          activated_on?: string | null;
          ended_on?: string | null;
          notes?: string | null;
          created_by?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          membership_number?: never;
          client_id?: string;
          branch_id?: string;
          policy_version_id?: string;
          status?: string;
          status_reason?: string | null;
          status_changed_at?: string | null;
          status_changed_by?: string | null;
          applied_on?: string;
          activated_on?: string | null;
          ended_on?: string | null;
          notes?: string | null;
          created_by?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };

      /**
       * Polytos Phase 1. Every membership status change, in order.
       *
       * Append-only and written only by the trigger on `memberships`, so
       * there is no session `Insert` path. The shape is declared in full
       * because the trigger is still a writer of this table.
       */
      membership_status_history: {
        Row: {
          id: number;
          membership_id: string;
          from_status: string | null;
          to_status: string;
          reason: string | null;
          effective_on: string;
          changed_by: string | null;
          changed_by_label: string;
          occurred_at: string;
        };
        Insert: {
          id?: never;
          membership_id: string;
          from_status?: string | null;
          to_status: string;
          reason?: string | null;
          effective_on: string;
          changed_by?: string | null;
          changed_by_label?: string;
          occurred_at?: string;
        };
        Update: {
          id?: never;
          membership_id?: string;
          from_status?: string | null;
          to_status?: string;
          reason?: string | null;
          effective_on?: string;
          changed_by?: string | null;
          changed_by_label?: string;
          occurred_at?: string;
        };
        Relationships: [];
      };

      /**
       * Polytos Phase 1. The record that a member was shown a version of the
       * membership terms and signed it.
       *
       * `policy_version` is derived from the referenced row by the guard
       * trigger, never trusted from the caller.
       */
      membership_terms_acceptances: {
        Row: {
          id: string;
          membership_id: string;
          policy_version_id: string;
          policy_version: string;
          accepted_at: string;
          signature_name: string;
          signature_path: string | null;
          witness_name: string | null;
          witness_phone: string | null;
          accepted_place: string | null;
          recorded_by: string | null;
          created_at: string;
          updated_at: string;
          consent_method: string;
          verification_status: string;
          evidence_reference: string | null;
          evidence_digest: string | null;
          verified_at: string | null;
          verified_by: string | null;
          verified_by_label: string | null;
          member_profile_id: string | null;
          witness_profile_id: string | null;
          challenge_id: string | null;
        };
        Insert: {
          id?: string;
          membership_id: string;
          policy_version_id: string;
          policy_version?: never;
          accepted_at: string;
          signature_name: string;
          signature_path?: string | null;
          witness_name?: string | null;
          witness_phone?: string | null;
          accepted_place?: string | null;
          recorded_by?: never;
          created_at?: string;
          updated_at?: string;
          // Polytos Phase 2. The caller says *how* consent was taken and
          // supplies whatever that method's evidence is — the signature
          // object's path, the witnessing member of staff, the challenge the
          // member answered. It does not say whether the evidence is any
          // good.
          consent_method: string;
          member_profile_id?: string | null;
          witness_profile_id?: string | null;
          challenge_id?: string | null;
          // `never`, all six. `membership_terms_acceptances_guard` derives
          // them from evidence it can itself check: the signature object has
          // to exist under this membership's path, the witness has to be an
          // active member of staff who is not the recorder, the challenge has
          // to be live and unspent. A caller that could write
          // `verification_status` could write `'verified'` beside a typed
          // name and activate a membership on nothing at all, which is the
          // exact defect Phase 1 left for this phase to close.
          verification_status?: never;
          evidence_reference?: never;
          evidence_digest?: never;
          verified_at?: never;
          verified_by?: never;
          verified_by_label?: never;
        };
        Update: {
          id?: never;
          membership_id?: never;
          policy_version_id?: never;
          policy_version?: never;
          accepted_at?: never;
          signature_name?: never;
          signature_path?: never;
          witness_name?: never;
          witness_phone?: never;
          accepted_place?: never;
          recorded_by?: never;
          created_at?: never;
          updated_at?: never;
          consent_method?: never;
          verification_status?: never;
          evidence_reference?: never;
          evidence_digest?: never;
          verified_at?: never;
          verified_by?: never;
          verified_by_label?: never;
          member_profile_id?: never;
          witness_profile_id?: never;
          challenge_id?: never;
        };
        Relationships: [];
      };

      /**
       * Polytos Phase 2. Membership enrolment and the savings module.
       *
       * Five of these six tables have **no write surface at all**, and that is
       * not an oversight in this file — it mirrors the grants. `authenticated`
       * holds SELECT and nothing else on the receipts, the subledger, the
       * withdrawal requests, the cards and the consent challenges, because every
       * row in them is written by a SECURITY DEFINER function that wrote a
       * journal entry in the same transaction. A receipt inserted directly would
       * be a receipt with no money behind it; a transaction inserted directly
       * would be money the ledger does not know about.
       *
       * So every column of their `Insert` and `Update` is typed `never`. A
       * direct write becomes a type error at the call site rather than a
       * permission error at runtime, which is the earlier and cheaper place to
       * find out.
       *
       * `savings_accounts` is the exception, with a narrow UPDATE for the one
       * supervisory act this phase ships: restricting or closing an account.
       */
      membership_fee_receipts: {
        Row: {
          id: string;
          receipt_number: string;
          membership_id: string;
          client_id: string;
          branch_id: string;
          policy_version_id: string;
          amount: number;
          payment_method: string;
          receiving_account_id: string;
          external_reference: string | null;
          idempotency_key: string;
          status: string;
          received_at: string;
          business_date: string;
          journal_entry_id: string | null;
          reversal_entry_id: string | null;
          recorded_by: string | null;
          recorded_by_label: string;
          client_name_at_payment: string;
          notes: string | null;
          reversed_at: string | null;
          reversed_by: string | null;
          reversed_by_label: string | null;
          reversal_reason: string | null;
          created_at: string;
          updated_at: string;
        };
        // Written by `record_membership_fee` and `reverse_membership_fee`
        // only. The receipt and its journal entry are one act.

        Insert: {
          id?: never;
          receipt_number?: never;
          membership_id?: never;
          client_id?: never;
          branch_id?: never;
          policy_version_id?: never;
          amount?: never;
          payment_method?: never;
          receiving_account_id?: never;
          external_reference?: never;
          idempotency_key?: never;
          status?: never;
          received_at?: never;
          business_date?: never;
          journal_entry_id?: never;
          reversal_entry_id?: never;
          recorded_by?: never;
          recorded_by_label?: never;
          client_name_at_payment?: never;
          notes?: never;
          reversed_at?: never;
          reversed_by?: never;
          reversed_by_label?: never;
          reversal_reason?: never;
          created_at?: never;
          updated_at?: never;
        };
        Update: {
          id?: never;
          receipt_number?: never;
          membership_id?: never;
          client_id?: never;
          branch_id?: never;
          policy_version_id?: never;
          amount?: never;
          payment_method?: never;
          receiving_account_id?: never;
          external_reference?: never;
          idempotency_key?: never;
          status?: never;
          received_at?: never;
          business_date?: never;
          journal_entry_id?: never;
          reversal_entry_id?: never;
          recorded_by?: never;
          recorded_by_label?: never;
          client_name_at_payment?: never;
          notes?: never;
          reversed_at?: never;
          reversed_by?: never;
          reversed_by_label?: never;
          reversal_reason?: never;
          created_at?: never;
          updated_at?: never;
        };
        Relationships: [];
      };
      savings_accounts: {
        Row: {
          id: string;
          account_number: string;
          membership_id: string;
          client_id: string;
          branch_id: string;
          policy_version_id: string;
          status: string;
          status_reason: string | null;
          opened_on: string;
          closed_on: string | null;
          created_by: string | null;
          created_by_label: string;
          created_at: string;
          updated_at: string;
        };
        // No INSERT. An account is opened by `open_savings_account`, which
        // checks that the policy version governing it actually has the
        // savings rules decided. A directly inserted account would be one
        // whose readiness gate nobody consulted.
        Insert: {
          id?: never;
          account_number?: never;
          membership_id?: never;
          client_id?: never;
          branch_id?: never;
          policy_version_id?: never;
          status?: never;
          status_reason?: never;
          opened_on?: never;
          closed_on?: never;
          created_by?: never;
          created_by_label?: never;
          created_at?: never;
          updated_at?: never;
        };
        Update: {
          id?: never;
          account_number?: never;
          membership_id?: never;
          client_id?: never;
          branch_id?: never;
          policy_version_id?: never;
          // The two the guard lets through, for a caller holding
          // `savings:reverse`. `closed_on` is stamped by the guard from the
          // business clock, so it is not here.
          status?: string;
          status_reason?: string | null;
          opened_on?: never;
          closed_on?: never;
          created_by?: never;
          created_by_label?: never;
          created_at?: never;
          updated_at?: never;
        };
        Relationships: [];
      };
      savings_transactions: {
        Row: {
          id: string;
          transaction_number: string;
          savings_account_id: string;
          membership_id: string;
          client_id: string;
          branch_id: string;
          kind: string;
          amount: number;
          signed_amount: number | null;
          payment_method: string | null;
          cash_account_id: string | null;
          external_reference: string | null;
          idempotency_key: string;
          value_date: string;
          contribution_month: string | null;
          occurred_at: string;
          journal_entry_id: string | null;
          reverses_transaction_id: string | null;
          reversal_reason: string | null;
          withdrawal_request_id: string | null;
          recorded_by: string | null;
          recorded_by_label: string;
          notes: string | null;
          created_at: string;
        };
        // Append-only, and with no write grant of any kind: a statement
        // trigger refuses UPDATE and DELETE behind the missing privilege. A
        // correction is a contra row with its own contra journal, written by
        // `reverse_savings_transaction`.

        Insert: {
          id?: never;
          transaction_number?: never;
          savings_account_id?: never;
          membership_id?: never;
          client_id?: never;
          branch_id?: never;
          kind?: never;
          amount?: never;
          signed_amount?: never;
          payment_method?: never;
          cash_account_id?: never;
          external_reference?: never;
          idempotency_key?: never;
          value_date?: never;
          contribution_month?: never;
          occurred_at?: never;
          journal_entry_id?: never;
          reverses_transaction_id?: never;
          reversal_reason?: never;
          withdrawal_request_id?: never;
          recorded_by?: never;
          recorded_by_label?: never;
          notes?: never;
          created_at?: never;
        };
        Update: {
          id?: never;
          transaction_number?: never;
          savings_account_id?: never;
          membership_id?: never;
          client_id?: never;
          branch_id?: never;
          kind?: never;
          amount?: never;
          signed_amount?: never;
          payment_method?: never;
          cash_account_id?: never;
          external_reference?: never;
          idempotency_key?: never;
          value_date?: never;
          contribution_month?: never;
          occurred_at?: never;
          journal_entry_id?: never;
          reverses_transaction_id?: never;
          reversal_reason?: never;
          withdrawal_request_id?: never;
          recorded_by?: never;
          recorded_by_label?: never;
          notes?: never;
          created_at?: never;
        };
        Relationships: [];
      };
      savings_withdrawal_requests: {
        Row: {
          id: string;
          request_number: string;
          savings_account_id: string;
          membership_id: string;
          client_id: string;
          branch_id: string;
          policy_version_id: string;
          amount: number;
          reason: string;
          status: string;
          balance_at_request: number;
          requested_by: string | null;
          requested_by_label: string;
          requested_at: string;
          business_date: string;
          decided_by: string | null;
          decided_by_label: string | null;
          decided_at: string | null;
          decision_notes: string | null;
          paid_transaction_id: string | null;
          paid_at: string | null;
          cancelled_at: string | null;
          cancellation_reason: string | null;
          created_at: string;
          updated_at: string;
        };
        // Requesting, deciding, paying and cancelling are four definer
        // functions, each with its own capability and its own refusal —
        // including the one that stops a withdrawal being decided by the
        // person who prepared it.

        Insert: {
          id?: never;
          request_number?: never;
          savings_account_id?: never;
          membership_id?: never;
          client_id?: never;
          branch_id?: never;
          policy_version_id?: never;
          amount?: never;
          reason?: never;
          status?: never;
          balance_at_request?: never;
          requested_by?: never;
          requested_by_label?: never;
          requested_at?: never;
          business_date?: never;
          decided_by?: never;
          decided_by_label?: never;
          decided_at?: never;
          decision_notes?: never;
          paid_transaction_id?: never;
          paid_at?: never;
          cancelled_at?: never;
          cancellation_reason?: never;
          created_at?: never;
          updated_at?: never;
        };
        Update: {
          id?: never;
          request_number?: never;
          savings_account_id?: never;
          membership_id?: never;
          client_id?: never;
          branch_id?: never;
          policy_version_id?: never;
          amount?: never;
          reason?: never;
          status?: never;
          balance_at_request?: never;
          requested_by?: never;
          requested_by_label?: never;
          requested_at?: never;
          business_date?: never;
          decided_by?: never;
          decided_by_label?: never;
          decided_at?: never;
          decision_notes?: never;
          paid_transaction_id?: never;
          paid_at?: never;
          cancelled_at?: never;
          cancellation_reason?: never;
          created_at?: never;
          updated_at?: never;
        };
        Relationships: [];
      };
      membership_cards: {
        Row: {
          id: string;
          card_number: string;
          membership_id: string;
          client_id: string;
          branch_id: string;
          printed_name: string;
          verification_code: string;
          status: string;
          issue_reason: string;
          issued_on: string;
          issued_by: string | null;
          issued_by_label: string;
          superseded_by: string | null;
          superseded_at: string | null;
          created_at: string;
          updated_at: string;
        };
        // Issued and superseded by `issue_membership_card`, which mints the
        // verification code. A caller that could choose the code could print
        // a card whose code matched somebody else's.

        Insert: {
          id?: never;
          card_number?: never;
          membership_id?: never;
          client_id?: never;
          branch_id?: never;
          printed_name?: never;
          verification_code?: never;
          status?: never;
          issue_reason?: never;
          issued_on?: never;
          issued_by?: never;
          issued_by_label?: never;
          superseded_by?: never;
          superseded_at?: never;
          created_at?: never;
          updated_at?: never;
        };
        Update: {
          id?: never;
          card_number?: never;
          membership_id?: never;
          client_id?: never;
          branch_id?: never;
          printed_name?: never;
          verification_code?: never;
          status?: never;
          issue_reason?: never;
          issued_on?: never;
          issued_by?: never;
          issued_by_label?: never;
          superseded_by?: never;
          superseded_at?: never;
          created_at?: never;
          updated_at?: never;
        };
        Relationships: [];
      };
      membership_consent_challenges: {
        Row: {
          id: string;
          membership_id: string;
          policy_version_id: string;
          delivered_to: string;
          code_digest: string;
          issued_by: string | null;
          issued_by_label: string;
          issued_at: string;
          expires_at: string;
          consumed_at: string | null;
          attempts: number;
          created_at: string;
          updated_at: string;
        };
        // Nobody reads this table and nobody writes it: there is no grant
        // at all, and no policy. It holds the *digest* of a one-time consent
        // code, never the code, and `issue_membership_consent_code` and the
        // acceptance guard are its only writers. A caller who could insert a
        // row here could consent on somebody else's behalf.

        Insert: {
          id?: never;
          membership_id?: never;
          policy_version_id?: never;
          delivered_to?: never;
          code_digest?: never;
          issued_by?: never;
          issued_by_label?: never;
          issued_at?: never;
          expires_at?: never;
          consumed_at?: never;
          attempts?: never;
          created_at?: never;
          updated_at?: never;
        };
        Update: {
          id?: never;
          membership_id?: never;
          policy_version_id?: never;
          delivered_to?: never;
          code_digest?: never;
          issued_by?: never;
          issued_by_label?: never;
          issued_at?: never;
          expires_at?: never;
          consumed_at?: never;
          attempts?: never;
          created_at?: never;
          updated_at?: never;
        };
        Relationships: [];
      };

      // --- Polytos business-policy update ------------------------------------
      //
      // Seven tables. Three of them — a governing policy assignment, a
      // collection carry-forward and a death confirmation — are append-only in
      // the database: UPDATE is refused by trigger and the privilege is not
      // granted. They still carry an `Update` shape here, as `audit_log` and
      // `loan_recovery_actions` do, because supabase-js requires one on every
      // table in the schema map and omitting it collapses the whole map to
      // `never`. The shape describes a statement the database will reject,
      // which is a limitation of the client's typing rather than a claim about
      // what is allowed.

      membership_policy_transitions: {
        Row: {
          id: string;
          transition_number: string;
          from_version_id: string | null;
          to_version_id: string;
          to_version: string;
          effective_on: string;
          status: string;
          previewed_memberships: number;
          previewed_accounts: number;
          previewed_qualified_before: number;
          previewed_qualified_after: number;
          transitioned_count: number;
          note: string | null;
          requested_by: string | null;
          requested_by_label: string;
          started_at: string;
          completed_at: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          transition_number: string;
          from_version_id?: string | null;
          to_version_id: string;
          to_version: string;
          effective_on: string;
          status?: string;
          previewed_memberships?: number;
          previewed_accounts?: number;
          previewed_qualified_before?: number;
          previewed_qualified_after?: number;
          transitioned_count?: number;
          note?: string | null;
          requested_by?: string | null;
          requested_by_label: string;
          started_at?: string;
          completed_at?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          transition_number?: string;
          from_version_id?: string | null;
          to_version_id?: string;
          to_version?: string;
          effective_on?: string;
          status?: string;
          previewed_memberships?: number;
          previewed_accounts?: number;
          previewed_qualified_before?: number;
          previewed_qualified_after?: number;
          transitioned_count?: number;
          note?: string | null;
          requested_by?: string | null;
          requested_by_label?: string;
          started_at?: string;
          completed_at?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      membership_policy_assignments: {
        Row: {
          id: string;
          membership_id: string;
          policy_version_id: string;
          policy_version: string;
          effective_from: string;
          previous_version_id: string | null;
          transition_id: string | null;
          acceptance_id: string | null;
          reason: string;
          assigned_by: string | null;
          assigned_by_label: string;
          created_at: string;
        };
        Insert: {
          id?: string;
          membership_id: string;
          policy_version_id: string;
          policy_version: string;
          effective_from: string;
          previous_version_id?: string | null;
          transition_id?: string | null;
          acceptance_id?: string | null;
          reason: string;
          assigned_by?: string | null;
          assigned_by_label: string;
          created_at?: string;
        };
        Update: {
          id?: string;
          membership_id?: string;
          policy_version_id?: string;
          policy_version?: string;
          effective_from?: string;
          previous_version_id?: string | null;
          transition_id?: string | null;
          acceptance_id?: string | null;
          reason?: string;
          assigned_by?: string | null;
          assigned_by_label?: string;
          created_at?: string;
        };
        Relationships: [];
      };
      loan_installment_carry_forwards: {
        Row: {
          id: string;
          loan_id: string;
          loan_number: string;
          installment_id: string;
          installment_number: number;
          original_due_date: string;
          carried_from_period: string;
          carried_to_period: string;
          amount_outstanding: number;
          principal_outstanding: number;
          interest_outstanding: number;
          reason: string;
          carried_by: string | null;
          carried_by_label: string;
          business_date: string;
          created_at: string;
        };
        Insert: {
          id?: string;
          loan_id: string;
          loan_number: string;
          installment_id: string;
          installment_number: number;
          original_due_date: string;
          carried_from_period: string;
          carried_to_period: string;
          amount_outstanding: number;
          principal_outstanding: number;
          interest_outstanding: number;
          reason: string;
          carried_by?: string | null;
          carried_by_label: string;
          business_date: string;
          created_at?: string;
        };
        Update: {
          id?: string;
          loan_id?: string;
          loan_number?: string;
          installment_id?: string;
          installment_number?: number;
          original_due_date?: string;
          carried_from_period?: string;
          carried_to_period?: string;
          amount_outstanding?: number;
          principal_outstanding?: number;
          interest_outstanding?: number;
          reason?: string;
          carried_by?: string | null;
          carried_by_label?: string;
          business_date?: string;
          created_at?: string;
        };
        Relationships: [];
      };
      benefit_death_confirmations: {
        Row: {
          id: string;
          claim_id: string;
          claim_number: string;
          subject_membership_id: string;
          confirming_membership_id: string;
          confirming_membership_number: string;
          statement: string;
          relationship_note: string | null;
          confirmation_method: string;
          signature_name: string | null;
          evidence_path: string | null;
          recorded_by: string | null;
          recorded_by_label: string;
          recorded_at: string;
          business_date: string;
          created_at: string;
        };
        Insert: {
          id?: string;
          claim_id: string;
          claim_number: string;
          subject_membership_id: string;
          confirming_membership_id: string;
          confirming_membership_number: string;
          statement: string;
          relationship_note?: string | null;
          confirmation_method: string;
          signature_name?: string | null;
          evidence_path?: string | null;
          recorded_by?: string | null;
          recorded_by_label: string;
          recorded_at?: string;
          business_date: string;
          created_at?: string;
        };
        Update: {
          id?: string;
          claim_id?: string;
          claim_number?: string;
          subject_membership_id?: string;
          confirming_membership_id?: string;
          confirming_membership_number?: string;
          statement?: string;
          relationship_note?: string | null;
          confirmation_method?: string;
          signature_name?: string | null;
          evidence_path?: string | null;
          recorded_by?: string | null;
          recorded_by_label?: string;
          recorded_at?: string;
          business_date?: string;
          created_at?: string;
        };
        Relationships: [];
      };
      meeting_absence_notices: {
        Row: {
          id: string;
          meeting_id: string;
          meeting_number: string;
          membership_id: string;
          membership_number: string;
          client_id: string;
          branch_id: string;
          reason_kind: string;
          reason: string;
          reported_via: string;
          reported_at: string;
          reported_by: string | null;
          reported_by_label: string;
          review_status: string;
          reviewed_at: string | null;
          reviewed_by: string | null;
          reviewed_by_label: string | null;
          review_note: string | null;
          business_date: string;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          meeting_id: string;
          meeting_number: string;
          membership_id: string;
          membership_number: string;
          client_id: string;
          branch_id: string;
          reason_kind: string;
          reason: string;
          reported_via: string;
          reported_at?: string;
          reported_by?: string | null;
          reported_by_label: string;
          review_status?: string;
          reviewed_at?: string | null;
          reviewed_by?: string | null;
          reviewed_by_label?: string | null;
          review_note?: string | null;
          business_date: string;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          meeting_id?: string;
          meeting_number?: string;
          membership_id?: string;
          membership_number?: string;
          client_id?: string;
          branch_id?: string;
          reason_kind?: string;
          reason?: string;
          reported_via?: string;
          reported_at?: string;
          reported_by?: string | null;
          reported_by_label?: string;
          review_status?: string;
          reviewed_at?: string | null;
          reviewed_by?: string | null;
          reviewed_by_label?: string | null;
          review_note?: string | null;
          business_date?: string;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      meeting_fines: {
        Row: {
          id: string;
          fine_number: string;
          meeting_id: string;
          meeting_number: string;
          meeting_date: string;
          membership_id: string;
          membership_number: string;
          client_id: string;
          branch_id: string;
          policy_version_id: string;
          policy_version: string;
          amount: number;
          amount_paid: number;
          status: string;
          attendance_at_assessment: string;
          absence_reason_at_assessment: string | null;
          notice_id: string | null;
          assessed_on: string;
          assessed_by: string | null;
          assessed_by_label: string;
          cancelled_at: string | null;
          cancelled_by: string | null;
          cancelled_by_label: string | null;
          cancellation_reason: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          fine_number: string;
          meeting_id: string;
          meeting_number: string;
          meeting_date: string;
          membership_id: string;
          membership_number: string;
          client_id: string;
          branch_id: string;
          policy_version_id: string;
          policy_version: string;
          amount: number;
          amount_paid?: number;
          status?: string;
          attendance_at_assessment: string;
          absence_reason_at_assessment?: string | null;
          notice_id?: string | null;
          assessed_on: string;
          assessed_by?: string | null;
          assessed_by_label: string;
          cancelled_at?: string | null;
          cancelled_by?: string | null;
          cancelled_by_label?: string | null;
          cancellation_reason?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          fine_number?: string;
          meeting_id?: string;
          meeting_number?: string;
          meeting_date?: string;
          membership_id?: string;
          membership_number?: string;
          client_id?: string;
          branch_id?: string;
          policy_version_id?: string;
          policy_version?: string;
          amount?: number;
          amount_paid?: number;
          status?: string;
          attendance_at_assessment?: string;
          absence_reason_at_assessment?: string | null;
          notice_id?: string | null;
          assessed_on?: string;
          assessed_by?: string | null;
          assessed_by_label?: string;
          cancelled_at?: string | null;
          cancelled_by?: string | null;
          cancelled_by_label?: string | null;
          cancellation_reason?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      meeting_fine_payments: {
        Row: {
          id: string;
          payment_number: string;
          fine_id: string;
          fine_number: string;
          membership_id: string;
          client_id: string;
          branch_id: string;
          amount: number;
          payment_method: string;
          cash_account_id: string;
          income_account_id: string;
          external_reference: string | null;
          idempotency_key: string;
          value_date: string;
          journal_entry_id: string;
          status: string;
          received_by: string | null;
          received_by_label: string;
          reversed_at: string | null;
          reversed_by: string | null;
          reversed_by_label: string | null;
          reversal_reason: string | null;
          reversal_entry_id: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          payment_number: string;
          fine_id: string;
          fine_number: string;
          membership_id: string;
          client_id: string;
          branch_id: string;
          amount: number;
          payment_method: string;
          cash_account_id: string;
          income_account_id: string;
          external_reference?: string | null;
          idempotency_key: string;
          value_date: string;
          journal_entry_id: string;
          status?: string;
          received_by?: string | null;
          received_by_label: string;
          reversed_at?: string | null;
          reversed_by?: string | null;
          reversed_by_label?: string | null;
          reversal_reason?: string | null;
          reversal_entry_id?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          payment_number?: string;
          fine_id?: string;
          fine_number?: string;
          membership_id?: string;
          client_id?: string;
          branch_id?: string;
          amount?: number;
          payment_method?: string;
          cash_account_id?: string;
          income_account_id?: string;
          external_reference?: string | null;
          idempotency_key?: string;
          value_date?: string;
          journal_entry_id?: string;
          status?: string;
          received_by?: string | null;
          received_by_label?: string;
          reversed_at?: string | null;
          reversed_by?: string | null;
          reversed_by_label?: string | null;
          reversal_reason?: string | null;
          reversal_entry_id?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
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
      // --- Polytos Phase 4 -------------------------------------------------
      //
      // `benefit_claim_portal_view` is the one whose **column list is the
      // disclosure policy**: `assessment_note` is absent, so a portal screen
      // cannot render an assessor's reasoning about a member's documents by
      // accident, and a future `select *` cannot reintroduce it.

      benefit_claim_register: {
        Row: {
          id: string | null;
          claim_number: string | null;
          claim_type: string | null;
          status: string | null;
          event_date: string | null;
          membership_id: string | null;
          membership_number: string | null;
          membership_status: string | null;
          client_id: string | null;
          client_number: string | null;
          member_name: string | null;
          branch_id: string | null;
          branch_name: string | null;
          policy_version: string | null;
          claimed_amount: number | null;
          assessed_amount: number | null;
          approved_amount: number | null;
          provider_name: string | null;
          bill_amount: number | null;
          admission_nights: number | null;
          admission_inclusive_days: number | null;
          admission_elapsed_days: number | null;
          deceased_name: string | null;
          deceased_relationship: string | null;
          deceased_relationship_label: string | null;
          beneficiary_id: string | null;
          beneficiary_number: string | null;
          beneficiary_verification_status: string | null;
          submitted_at: string | null;
          submitted_by_label: string | null;
          assessed_at: string | null;
          assessed_by_label: string | null;
          decided_at: string | null;
          decided_by_label: string | null;
          rejected_reason: string | null;
          cancelled_reason: string | null;
          information_required_note: string | null;
          payment_id: string | null;
          payment_number: string | null;
          paid_on: string | null;
          payment_reversed_at: string | null;
          document_count: number | null;
          verified_document_count: number | null;
          required_document_count: number | null;
          created_at: string | null;
          updated_at: string | null;
        };
        Relationships: [];
      };
      benefit_claim_portal_view: {
        Row: {
          id: string | null;
          claim_number: string | null;
          claim_type: string | null;
          status: string | null;
          event_date: string | null;
          client_id: string | null;
          claimed_amount: number | null;
          assessed_amount: number | null;
          approved_amount: number | null;
          provider_name: string | null;
          bill_amount: number | null;
          deceased_name: string | null;
          information_required_note: string | null;
          rejected_reason: string | null;
          submitted_at: string | null;
          decided_at: string | null;
          payment_number: string | null;
          paid_on: string | null;
          paid_amount: number | null;
          payment_method: string | null;
        };
        Relationships: [];
      };
      member_beneficiary_register: {
        Row: {
          id: string | null;
          beneficiary_number: string | null;
          membership_id: string | null;
          membership_number: string | null;
          membership_status: string | null;
          client_id: string | null;
          client_number: string | null;
          member_name: string | null;
          branch_id: string | null;
          relationship: string | null;
          relationship_label: string | null;
          is_primary: boolean | null;
          status: string | null;
          verification_status: string | null;
          verification_evidence_kind: string | null;
          verified_at: string | null;
          verified_by_label: string | null;
          rejected_reason: string | null;
          recorded_on: string | null;
          recorded_by_label: string | null;
          ended_on: string | null;
          ended_reason: string | null;
          supersedes_number: string | null;
          document_count: number | null;
          created_at: string | null;
        };
        Relationships: [];
      };
      benefit_payment_register: {
        Row: {
          id: string | null;
          payment_number: string | null;
          claim_id: string | null;
          claim_number: string | null;
          claim_type: string | null;
          membership_id: string | null;
          membership_number: string | null;
          client_id: string | null;
          member_name: string | null;
          branch_id: string | null;
          branch_name: string | null;
          amount: number | null;
          recipient_kind: string | null;
          recipient_name: string | null;
          recipient_beneficiary_number: string | null;
          payment_method: string | null;
          external_reference: string | null;
          expense_account_code: string | null;
          expense_account_name: string | null;
          cash_account_code: string | null;
          cash_account_name: string | null;
          value_date: string | null;
          journal_entry_id: string | null;
          paid_at: string | null;
          paid_by_label: string | null;
          reversed_at: string | null;
          reversed_by_label: string | null;
          reversal_reason: string | null;
          reversal_journal_entry_id: string | null;
          is_live: boolean | null;
        };
        Relationships: [];
      };
      membership_meeting_register: {
        Row: {
          id: string | null;
          meeting_number: string | null;
          branch_id: string | null;
          branch_name: string | null;
          meeting_type: string | null;
          title: string | null;
          venue: string | null;
          scheduled_at: string | null;
          meeting_date: string | null;
          status: string | null;
          agenda: string | null;
          minutes: string | null;
          minutes_finalised_at: string | null;
          minutes_finalised_by_label: string | null;
          minutes_amended_at: string | null;
          minutes_amendment_note: string | null;
          rescheduled_from: string | null;
          reschedule_reason: string | null;
          cancelled_at: string | null;
          cancellation_reason: string | null;
          attendance_recorded: number | null;
          present_count: number | null;
          absent_count: number | null;
          expected_members: number | null;
          action_count: number | null;
          open_action_count: number | null;
          created_at: string | null;
          created_by_label: string | null;
        };
        Relationships: [];
      };
      meeting_attendance_register: {
        Row: {
          id: string | null;
          meeting_id: string | null;
          meeting_number: string | null;
          meeting_title: string | null;
          meeting_date: string | null;
          branch_id: string | null;
          membership_id: string | null;
          membership_number: string | null;
          client_id: string | null;
          client_number: string | null;
          member_name: string | null;
          member_phone: string | null;
          attendance: string | null;
          absence_reason: string | null;
          note: string | null;
          marked_at: string | null;
          marked_by_label: string | null;
          corrected_at: string | null;
          correction_count: number | null;
        };
        Relationships: [];
      };
      member_loan_register: {
        Row: {
          loan_id: string | null;
          loan_number: string | null;
          client_id: string | null;
          full_name: string | null;
          client_number: string | null;
          branch_id: string | null;
          status: string | null;
          principal_amount: number | null;
          interest_rate_bps: number | null;
          interest_basis: string | null;
          interest_method: string | null;
          loan_term_months: number | null;
          repayment_frequency: string | null;
          total_interest: number | null;
          total_expected_repayment: number | null;
          approved_at: string | null;
          disbursed_at: string | null;
          created_at: string | null;
          membership_id: string | null;
          membership_number: string | null;
          membership_status: string | null;
          policy_version: string | null;
          savings_account_id: string | null;
          savings_account_number: string | null;
          eligible_savings: number | null;
          multiplier_bps: number | null;
          max_eligible_loan: number | null;
          qualifying_months: number | null;
          months_required: number | null;
          pledged_amount: number | null;
          pledge_released_at: string | null;
          principal_remaining: number | null;
          interest_remaining: number | null;
          penalty_remaining: number | null;
          total_outstanding: number | null;
          total_paid: number | null;
          arrears_amount: number | null;
          days_past_due: number | null;
          delinquency_state: string | null;
        };
        Relationships: [];
      };
      member_loan_eligibility: {
        Row: {
          membership_id: string | null;
          membership_number: string | null;
          client_id: string | null;
          branch_id: string | null;
          membership_status: string | null;
          full_name: string | null;
          client_number: string | null;
          policy_version_id: string | null;
          policy_version: string | null;
          months_required: number | null;
          must_be_consecutive: boolean | null;
          multiplier_bps: number | null;
          interest_rate_bps: number | null;
          interest_basis: string | null;
          interest_method: string | null;
          max_term_months: number | null;
          weekly_cadence_max_months: number | null;
          policy_lending_ready: boolean | null;
          policy_lending_open: boolean | null;
          savings_account_id: string | null;
          savings_account_number: string | null;
          savings_account_status: string | null;
          eligible_savings: number | null;
          qualifying_months: number | null;
          max_eligible_loan: number | null;
          pledged_savings: number | null;
          pending_withdrawals: number | null;
          available_savings: number | null;
          active_loan_count: number | null;
          member_loan_count: number | null;
          outstanding_principal: number | null;
          active_loan_limit: number | null;
          savings_months_met: boolean | null;
        };
        Relationships: [];
      };
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
          employer_contact: string | null;
          staff_number: string | null;
          employment_started_on: string | null;
          employment_status: string | null;
          salary_verification: string | null;
          has_employment_letter: boolean | null;
          business_location: string | null;
          trading_since: string | null;
          monthly_expenses: number | null;
          business_contact: string | null;
          employee_count: number | null;
          premises_ownership: string | null;
          trading_licence_number: string | null;
          has_bank_statement: boolean | null;
          document_count: number | null;
          collateral_required: boolean | null;
          min_guarantors: number | null;
        };
        Relationships: [];
      };
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
          employer_name: string | null;
          has_photograph: boolean | null;
          evidence_frozen: boolean | null;
          document_count: number | null;
        };
        Relationships: [];
      };

      /**
       * Phase 13. One row per loan carrying its product, its collection
       * state, its guarantor count and the stage of the loan workflow it sits
       * at. The backing for every view in the loan module, so the thirteen
       * the brief names are thirteen filters over one query.
       */
      loan_workflow_register: {
        Row: {
          loan_id: string | null;
          loan_number: string | null;
          client_id: string | null;
          client_name: string | null;
          client_number: string | null;
          client_phone: string | null;
          branch_id: string | null;
          branch_name: string | null;
          loan_product_id: string | null;
          product_code: string | null;
          product_name: string | null;
          application_profile: string | null;
          principal_amount: number | null;
          interest_rate_bps: number | null;
          interest_method: string | null;
          loan_term_months: number | null;
          repayment_frequency: string | null;
          total_interest: number | null;
          total_expected_repayment: number | null;
          status: string | null;
          closure_kind: string | null;
          cancellation_reason: string | null;
          cancelled_at: string | null;
          review_note: string | null;
          proposed_disbursement_date: string | null;
          submitted_at: string | null;
          approved_at: string | null;
          disbursed_at: string | null;
          cleared_at: string | null;
          created_at: string | null;
          updated_at: string | null;
          delinquency_state: string | null;
          arrears_amount: number | null;
          days_past_due: number | null;
          missed_installment_count: number | null;
          oldest_unpaid_due_date: string | null;
          contractual_outstanding: number | null;
          penalty_remaining: number | null;
          total_outstanding: number | null;
          installment_count: number | null;
          scheduled_completion_date: string | null;
          guarantor_count: number | null;
          guarantor_consent_count: number | null;
          document_count: number | null;
          workflow_stage: string | null;
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
          payment_id: string | null;
          payment_number: string | null;
          loan_id: string | null;
          loan_number: string | null;
          client_id: string | null;
          client_number: string | null;
          client_name: string | null;
          client_phone: string | null;
          client_name_at_payment: string | null;
          amount: number | null;
          payment_method: string | null;
          status: string | null;
          is_effective: boolean | null;
          effective_amount: number | null;
          received_at: string | null;
          business_date: string | null;
          recorded_by: string | null;
          recorded_by_label: string | null;
          external_reference: string | null;
          reversed_at: string | null;
          reversed_by: string | null;
          reversal_reason: string | null;
          outstanding_before: number | null;
          outstanding_after: number | null;
          allocated_principal: number | null;
          allocated_interest: number | null;
          allocated_penalty: number | null;
          principal_collected: number | null;
          interest_collected: number | null;
          penalty_collected: number | null;
          branch_id: string | null;
          branch_name: string | null;
          loan_product_id: string | null;
          product_code: string | null;
          product_name: string | null;
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

      // --- Phase 14: aging, risk and the registers ---------------------------
      loan_collateral_register: {
        Row: {
          id: string | null;
          loan_id: string | null;
          loan_number: string | null;
          loan_status: string | null;
          branch_id: string | null;
          client_id: string | null;
          client_number: string | null;
          client_name: string | null;
          client_phone: string | null;
          product_code: string | null;
          product_name: string | null;
          item_type: string | null;
          description: string | null;
          estimated_value: number | null;
          valued_on: string | null;
          serial_number: string | null;
          ownership_document: string | null;
          location: string | null;
          status: string | null;
          released_at: string | null;
          release_reason: string | null;
          realised_amount: number | null;
          realised_at: string | null;
          created_at: string | null;
          total_outstanding: number | null;
        };
        Relationships: [];
      };
      loan_recovery_register: {
        Row: {
          id: string | null;
          loan_id: string | null;
          loan_number: string | null;
          loan_status: string | null;
          branch_id: string | null;
          client_id: string | null;
          client_number: string | null;
          client_name: string | null;
          client_phone: string | null;
          product_code: string | null;
          product_name: string | null;
          action_kind: string | null;
          outcome: string | null;
          notes: string | null;
          action_date: string | null;
          follow_up_on: string | null;
          promised_amount: number | null;
          promised_on: string | null;
          corrects_action_id: string | null;
          created_by: string | null;
          created_by_label: string | null;
          created_at: string | null;
          is_corrected: boolean | null;
          promise_paid_amount: number | null;
          promise_status: string | null;
        };
        Relationships: [];
      };
      loan_recovery_status: {
        Row: {
          loan_id: string | null;
          loan_number: string | null;
          loan_status: string | null;
          branch_id: string | null;
          client_id: string | null;
          client_number: string | null;
          client_name: string | null;
          client_phone: string | null;
          product_code: string | null;
          product_name: string | null;
          arrears_amount: number | null;
          days_past_due: number | null;
          delinquency_state: string | null;
          total_outstanding: number | null;
          action_count: number | null;
          last_action_date: string | null;
          last_action_kind: string | null;
          last_action_notes: string | null;
          last_action_by: string | null;
          next_follow_up_on: string | null;
          overdue_follow_up_on: string | null;
          open_promise_amount: number | null;
          open_promise_on: string | null;
          open_promise_status: string | null;
        };
        Relationships: [];
      };
      /**
       * Polytos Phase 1. A membership with its member's name and the policy
       * version governing them, as one read.
       */
      membership_register: {
        Row: {
          id: string | null;
          membership_number: string | null;
          client_id: string | null;
          client_number: string | null;
          full_name: string | null;
          phone: string | null;
          village_area: string | null;
          district: string | null;
          client_status: string | null;
          branch_id: string | null;
          branch_name: string | null;
          status: string | null;
          status_reason: string | null;
          status_changed_at: string | null;
          applied_on: string | null;
          activated_on: string | null;
          ended_on: string | null;
          policy_version_id: string | null;
          policy_version: string | null;
          policy_enrolment_enabled: boolean | null;
          policy_savings_enabled: boolean | null;
          policy_member_lending_enabled: boolean | null;
          policy_benefits_enabled: boolean | null;
          policy_profit_sharing_enabled: boolean | null;
          notes: string | null;
          created_at: string | null;
          updated_at: string | null;
        };
        Relationships: [];
      };
      guarantor_exposure: {
        Row: {
          loan_guarantor_id: string | null;
          loan_id: string | null;
          loan_number: string | null;
          loan_status: string | null;
          branch_id: string | null;
          loan_product_id: string | null;
          product_code: string | null;
          product_name: string | null;
          subject_kind: string | null;
          guarantor_id: string | null;
          guarantor_client_id: string | null;
          guarantor_name: string | null;
          guarantor_phone: string | null;
          guarantor_client_number: string | null;
          relationship_to_client: string | null;
          client_id: string | null;
          client_number: string | null;
          client_name: string | null;
          client_phone: string | null;
          guaranteed_amount: number | null;
          guaranteed_total: number | null;
          outstanding_balance: number | null;
          arrears_amount: number | null;
          days_past_due: number | null;
          delinquency_state: string | null;
          guarantee_date: string | null;
          consent_version: string | null;
          consent_signed: boolean | null;
          evidence_frozen_at: string | null;
          released_at: string | null;
          release_reason: string | null;
          is_released: boolean | null;
          guarantee_status: string | null;
          created_at: string | null;
        };
        Relationships: [];
      };
      loan_aging: {
        Row: {
          loan_id: string | null;
          loan_number: string | null;
          loan_status: string | null;
          branch_id: string | null;
          branch_name: string | null;
          loan_product_id: string | null;
          product_code: string | null;
          product_name: string | null;
          client_id: string | null;
          client_number: string | null;
          client_name: string | null;
          client_phone: string | null;
          principal_amount: number | null;
          principal_remaining: number | null;
          interest_remaining: number | null;
          penalty_remaining: number | null;
          total_outstanding: number | null;
          arrears_amount: number | null;
          current_due: number | null;
          missed_installment_count: number | null;
          days_past_due: number | null;
          oldest_past_due_date: string | null;
          grace_end_date: string | null;
          within_grace_period: boolean | null;
          delinquency_state: string | null;
          penalty_applied: boolean | null;
          penalty_amount: number | null;
          penalty_paid: number | null;
          aging_bucket: string | null;
          aging_rank: number | null;
          at_risk_1: boolean | null;
          at_risk_7: boolean | null;
          at_risk_30: boolean | null;
          at_risk_60: boolean | null;
          at_risk_90: boolean | null;
          disbursed_at: string | null;
          last_payment_date: string | null;
        };
        Relationships: [];
      };
      portfolio_at_risk: {
        Row: {
          scope: string | null;
          branch_id: string | null;
          branch_name: string | null;
          loan_product_id: string | null;
          product_code: string | null;
          product_name: string | null;
          loan_count: number | null;
          principal_outstanding: number | null;
          total_outstanding: number | null;
          arrears_amount: number | null;
          loans_at_risk_1: number | null;
          loans_at_risk_7: number | null;
          loans_at_risk_30: number | null;
          loans_at_risk_60: number | null;
          loans_at_risk_90: number | null;
          principal_at_risk_1: number | null;
          principal_at_risk_7: number | null;
          principal_at_risk_30: number | null;
          principal_at_risk_60: number | null;
          principal_at_risk_90: number | null;
          par1_bps: number | null;
          par7_bps: number | null;
          par30_bps: number | null;
          par60_bps: number | null;
          par90_bps: number | null;
          loans_bucket_current: number | null;
          loans_bucket_1_7: number | null;
          loans_bucket_8_30: number | null;
          loans_bucket_31_60: number | null;
          loans_bucket_61_90: number | null;
          loans_bucket_90_plus: number | null;
          principal_bucket_current: number | null;
          principal_bucket_1_7: number | null;
          principal_bucket_8_30: number | null;
          principal_bucket_31_60: number | null;
          principal_bucket_61_90: number | null;
          principal_bucket_90_plus: number | null;
        };
        Relationships: [];
      };

      // --- Phase 15: the feed and the bell's count ---------------------------
      notification_feed: {
        Row: {
          id: string | null;
          category: string | null;
          severity: string | null;
          title: string | null;
          body: string | null;
          entity_type: string | null;
          entity_id: string | null;
          actor_profile_id: string | null;
          actor_label: string | null;
          occurred_at: string | null;
          audience_permission: string | null;
          audience_profile_id: string | null;
          audience_branch_id: string | null;
          is_personal: boolean | null;
          is_read: boolean | null;
          read_at: string | null;
        };
        Relationships: [];
      };
      notification_summary: {
        Row: {
          total: number | null;
          unread: number | null;
          unread_urgent: number | null;
          unread_attention: number | null;
          newest_unread_at: string | null;
        };
        Relationships: [];
      };
      /**
       * Polytos Phase 2. There is no stored savings balance anywhere in this
       * schema, which is why these are views: the balance is
       * `sum(signed_amount)` over the subledger, and `signed_amount` is a
       * generated column, so no caller decides the direction of a movement.
       * A stored balance would be a second figure that could disagree with
       * the ledger, and the one that disagrees is always the one on screen.
       */
      member_savings_balances: {
        Row: {
          savings_account_id: string | null;
          account_number: string | null;
          membership_id: string | null;
          client_id: string | null;
          branch_id: string | null;
          status: string | null;
          opened_on: string | null;
          policy_version_id: string | null;
          balance: number | null;
          total_deposited: number | null;
          total_withdrawn: number | null;
          total_deposits_reversed: number | null;
          total_withdrawals_reversed: number | null;
          transaction_count: number | null;
          last_transaction_on: string | null;
        };
        Relationships: [];
      };
      member_savings_contributions: {
        Row: {
          savings_account_id: string | null;
          contribution_month: string | null;
          contributed: number | null;
          deposited: number | null;
          reversed: number | null;
          deposit_count: number | null;
          last_deposit_on: string | null;
          monthly_savings_minimum: number | null;
          meets_minimum: boolean | null;
          shortfall: number | null;
          surplus: number | null;
        };
        Relationships: [];
      };
      savings_account_register: {
        Row: {
          savings_account_id: string | null;
          account_number: string | null;
          membership_id: string | null;
          membership_number: string | null;
          membership_status: string | null;
          client_id: string | null;
          client_number: string | null;
          full_name: string | null;
          phone: string | null;
          branch_id: string | null;
          branch_name: string | null;
          account_status: string | null;
          opened_on: string | null;
          balance: number | null;
          total_deposited: number | null;
          total_withdrawn: number | null;
          transaction_count: number | null;
          last_transaction_on: string | null;
          monthly_savings_minimum: number | null;
          savings_qualifying_months: number | null;
        };
        Relationships: [];
      };

      // --- Polytos business-policy update ------------------------------------
      //
      // `loan_collection_schedule` carries **both** of an instalment's dates:
      // `original_due_date`, which arrears are measured from, and
      // `collection_period`, which is the month it is being chased in. Reading
      // one as the other is the mistake the carry-forward design exists to
      // prevent, so both are typed and neither is named `due_date`.

      loan_collection_schedule: {
        Row: {
          loan_id: string | null;
          loan_number: string | null;
          client_id: string | null;
          branch_id: string | null;
          loan_status: string | null;
          installment_id: string | null;
          installment_number: number | null;
          original_due_date: string | null;
          expected_amount: number | null;
          scheduled_principal: number | null;
          scheduled_interest: number | null;
          allocated_amount: number | null;
          remaining_amount: number | null;
          remaining_principal: number | null;
          remaining_interest: number | null;
          collection_period: string | null;
          carry_forward_count: number | null;
          days_past_due: number | null;
        };
        Relationships: [];
      };
      meeting_fine_register: {
        Row: {
          id: string | null;
          fine_number: string | null;
          meeting_id: string | null;
          meeting_number: string | null;
          meeting_date: string | null;
          meeting_title: string | null;
          meeting_type: string | null;
          membership_id: string | null;
          membership_number: string | null;
          member_name: string | null;
          client_number: string | null;
          client_id: string | null;
          branch_id: string | null;
          branch_name: string | null;
          policy_version: string | null;
          amount: number | null;
          amount_paid: number | null;
          amount_outstanding: number | null;
          status: string | null;
          attendance_at_assessment: string | null;
          absence_reason_at_assessment: string | null;
          notice_id: string | null;
          notice_status: string | null;
          notice_reason: string | null;
          notice_review_note: string | null;
          assessed_on: string | null;
          assessed_by_label: string | null;
          cancelled_at: string | null;
          cancelled_by_label: string | null;
          cancellation_reason: string | null;
          latest_payment_number: string | null;
          payment_count: number | null;
          reversed_payment_count: number | null;
          created_at: string | null;
          updated_at: string | null;
        };
        Relationships: [];
      };
      meeting_absence_notice_register: {
        Row: {
          id: string | null;
          meeting_id: string | null;
          meeting_number: string | null;
          meeting_title: string | null;
          scheduled_at: string | null;
          meeting_date: string | null;
          meeting_status: string | null;
          membership_id: string | null;
          membership_number: string | null;
          member_name: string | null;
          client_id: string | null;
          branch_id: string | null;
          branch_name: string | null;
          reason_kind: string | null;
          reason: string | null;
          reported_via: string | null;
          reported_at: string | null;
          reported_by_label: string | null;
          hours_before_meeting: number | null;
          review_status: string | null;
          reviewed_at: string | null;
          reviewed_by_label: string | null;
          review_note: string | null;
          register_attendance: string | null;
          fine_charged: boolean | null;
          created_at: string | null;
        };
        Relationships: [];
      };
    };

    Functions: {
      audit_policy_update_event: {
        Args: Record<PropertyKey, never>;
        Returns: unknown;
      };
      // --- Polytos Phase 4: benefits -----------------------------------------
      //
      // Four, and the two that are SECURITY DEFINER each check a capability
      // inside: a cap computed from a partial view of a member's history is a
      // cap that over-approves, and a business-wide aggregate has no row for a
      // policy to filter. `medical_benefit_consumed` is deliberately absent —
      // it is an input to an assessment and to nothing else, and a type for it
      // would advertise a call no screen should make.

      /**
       * Polytos Phase 4. Which expense account a benefit of this type is
       * debited to: 5210 medical, 5220 family condolence, 5230 member
       * bereavement. One answer to "which account does a condolence payment
       * hit", rather than three literals scattered through the posting path.
       */
      benefit_expense_account: {
        Args: { p_claim_type: string };
        Returns: string | null;
      };

      /**
       * Polytos Phase 4. What a benefit of this type is worth before caps:
       * `(bill * rate_bps + 5000) / 10000` in bigint for medical — half-up,
       * never floating point — and the policy's fixed figure for the other
       * two.
       *
       * IMMUTABLE and pure, so a caller may evaluate it: it discloses only
       * the arithmetic the published policy already states.
       */
      benefit_amount_for_claim: {
        Args: {
          p_claim_type: string;
          p_rate_bps: number;
          p_bill_amount: number | null;
          p_condolence_benefit: number;
          p_bereavement_benefit: number;
        };
        Returns: number | null;
      };

      /**
       * Polytos Phase 4. The benefit year containing an event, under either
       * basis. NULL bounds for a NULL basis, which is how an undecided annual
       * period reaches the caller as a refusal rather than as a guess.
       */
      benefit_policy_year_bounds: {
        Args: { p_basis: string; p_activated_on: string; p_event_date: string };
        Returns: {
          period_from: string | null;
          period_to: string | null;
        }[];
      };

      /**
       * Polytos Phase 4. The complete set of benefit claim transitions.
       * Everything absent is refused by the guard: a draft cannot become
       * paid, a rejected claim cannot be paid, an unassessed claim cannot be
       * approved, and a paid claim cannot be paid twice.
       */
      benefit_claim_transition_allowed: {
        Args: { p_from: string; p_to: string };
        Returns: boolean;
      };

      /**
       * Polytos Phase 4. What a member has committed of their medical benefit
       * year: the money and the claim count, over assessed, approved and paid
       * claims. Counting paid alone would let two approvals share one
       * ceiling; a reversed claim is absent, because the money came back.
       *
       * Gated on `benefits:assess` or `benefits:approve` inside. As a
       * SECURITY INVOKER read the figure would silently fall to zero for a
       * caller who cannot see every one of the member's claims, and a cap
       * computed from a partial history is a cap that over-approves.
       */
      medical_benefit_consumed: {
        Args: {
          p_membership_id: string;
          p_period_from: string;
          p_period_to: string;
          p_exclude_claim_id?: string | null;
        };
        Returns: {
          consumed_amount: number;
          consumed_claims: number;
        }[];
      };

      /**
       * Polytos Phase 4. The live primary beneficiary of a membership and its
       * verification state — one row or none, and **no name**. SECURITY
       * INVOKER, so a caller sees it only if their own policies let them; the
       * identity is in `member_beneficiary_identities`, behind
       * `membership:view_sensitive`.
       */
      member_primary_beneficiary: {
        Args: { p_membership_id: string };
        Returns: {
          beneficiary_id: string | null;
          beneficiary_number: string | null;
          relationship: string | null;
          verification_status: string | null;
          verified_at: string | null;
          verified_by_label: string | null;
        }[];
      };

      /**
       * Polytos Phase 4. The claim a benefit-documents object belongs to,
       * from segment four of its path. NULL for a beneficiary document, which
       * denies every claim-scoped policy.
       */
      storage_path_claim_id: {
        Args: { p_name: string };
        Returns: string | null;
      };

      /**
       * Polytos Phase 4. Whether an object is attached to a beneficiary record
       * rather than to a claim. One spelling of the literal, in one place.
       */
      storage_path_is_beneficiary: {
        Args: { p_name: string };
        Returns: boolean;
      };

      /**
       * Polytos Phase 4. Records a beneficiary against a live membership,
       * unverified, writing the record and its identity together so neither
       * can exist without the other.
       *
       * `p_supersedes_id` makes it a change: the old record becomes
       * superseded with its details intact, which is refused while a
       * bereavement claim on the membership is live — because the recipient
       * the business is deciding on must not move under the decision.
       */
      register_member_beneficiary: {
        Args: {
          p_membership_id: string;
          p_full_name: string;
          p_relationship: string;
          p_phone: string;
          p_alternative_phone?: string | null;
          p_village_area?: string | null;
          p_district?: string | null;
          p_identity_document_kind?: string | null;
          p_identity_reference?: string | null;
          p_is_primary?: boolean;
          p_supersedes_id?: string | null;
        };
        Returns: string;
      };

      /**
       * Polytos Phase 4. Verifies or refuses a beneficiary record. Refuses a
       * verification from whoever recorded it, by profile id **and** by actor
       * label — the label because an archived account leaves `recorded_by`
       * NULL, and a control that stopped applying when somebody left would be
       * the worst kind.
       */
      verify_member_beneficiary: {
        Args: {
          p_beneficiary_id: string;
          p_verified: boolean;
          p_evidence_kind: string;
          p_evidence_path?: string | null;
          p_note?: string | null;
        };
        Returns: string;
      };

      /** Polytos Phase 4. Ends a nomination with a reason, keeping every detail. */
      revoke_member_beneficiary: {
        Args: { p_beneficiary_id: string; p_reason: string };
        Returns: string;
      };

      /**
       * Polytos Phase 4. Opens a benefit claim as a draft under the
       * membership's own policy version. One function for all three types,
       * with the schema's CHECK constraints refusing the wrong combination —
       * three signatures over one table would mean the one that drifted was
       * the one nobody tested.
       *
       * The claimed amount is derived from the policy rather than accepted,
       * so a claimant cannot ask for more than the rate allows.
       */
      open_benefit_claim: {
        Args: {
          p_membership_id: string;
          p_claim_type: string;
          p_event_date?: string | null;
          p_provider_name?: string | null;
          p_admission_at?: string | null;
          p_discharge_at?: string | null;
          p_bill_amount?: number | null;
          p_deceased_name?: string | null;
          p_deceased_relationship?: string | null;
          p_beneficiary_id?: string | null;
        };
        Returns: string;
      };

      /**
       * Polytos Phase 4. Submits a draft, freezing every fact it asserts.
       * Deliberately validates no eligibility rule: a claim that cannot
       * succeed should be recorded and then refused with a reason the member
       * can be shown.
       */
      submit_benefit_claim: { Args: { p_claim_id: string }; Returns: string };

      /** Polytos Phase 4. Marks a claim as being checked, so the register shows it. */
      begin_benefit_verification: { Args: { p_claim_id: string }; Returns: string };

      /** Polytos Phase 4. Puts a claim back to the claimant, saying what is missing. */
      request_benefit_information: {
        Args: { p_claim_id: string; p_note: string };
        Returns: string;
      };

      /**
       * Polytos Phase 4. Assesses a claim and returns the amount.
       *
       * Refuses on every eligibility code, computes in integer arithmetic,
       * and freezes a snapshot of everything relied on — including the payee,
       * by copy. Holds an advisory lock on the membership, so two medical
       * assessments cannot share one annual cap.
       */
      assess_benefit_claim: {
        Args: { p_claim_id: string; p_note?: string | null };
        Returns: number;
      };

      /**
       * Polytos Phase 4. Approves an assessed claim and returns the amount.
       *
       * Refuses an approval from whoever assessed it, and re-asks every
       * eligibility rule because an approval is a fresh decision.
       * `p_approved_amount` exists for the day the client settles whether an
       * eligible claim may be paid in part; until then anything below the
       * assessment is refused with the decision named.
       */
      approve_benefit_claim: {
        Args: {
          p_claim_id: string;
          p_approved_amount?: number | null;
          p_note?: string | null;
        };
        Returns: number;
      };

      /**
       * Polytos Phase 4. Refuses a claim with a reason, at any stage a refusal
       * can follow — including after approval, which is how an approval is
       * withdrawn before the money goes.
       */
      reject_benefit_claim: {
        Args: { p_claim_id: string; p_reason: string };
        Returns: string;
      };

      /** Polytos Phase 4. Withdraws a claim before a decision, with a reason. */
      cancel_benefit_claim: {
        Args: { p_claim_id: string; p_reason: string };
        Returns: string;
      };

      /**
       * Polytos Phase 4. Records an uploaded document, unchecked, having
       * first confirmed the object is really in the bucket. The object itself
       * is written by the caller's own session through the storage policies,
       * so the two halves are authorised independently.
       */
      attach_benefit_document: {
        Args: {
          p_claim_id: string | null;
          p_beneficiary_id: string | null;
          p_kind: string;
          p_object_path: string;
          p_content_type: string;
          p_byte_size: number;
          p_label?: string | null;
        };
        Returns: string;
      };

      /**
       * Polytos Phase 4. Records that somebody checked a piece of evidence.
       * Refuses a check from whoever attached it: evidence uploaded and
       * attested by one hand is evidence nobody checked.
       */
      verify_benefit_document: {
        Args: { p_document_id: string; p_verified: boolean; p_note?: string | null };
        Returns: string;
      };

      /**
       * Polytos Phase 4. Pays an approved benefit: debit 5210/5220/5230,
       * credit the branch cash account. The recipient comes from the
       * assessment snapshot and never from the live beneficiary record.
       * Idempotent on `p_idempotency_key`, with the capability check above the
       * replay (ADR-056).
       */
      post_benefit_payment: {
        Args: {
          p_claim_id: string;
          p_payment_method: string;
          p_external_reference: string | null;
          p_idempotency_key: string;
        };
        Returns: string;
      };

      /**
       * Polytos Phase 4. Reverses a payment: posts the contra journal, links
       * the pair, and moves the claim to the terminal reversed state. Never
       * deletes, never reopens the claim, and releases the annual cap the
       * claim had consumed because the money came back.
       */
      reverse_benefit_payment: {
        Args: { p_payment_id: string; p_reason: string };
        Returns: string;
      };

      /**
       * Polytos Phase 4. Schedules a meeting at a branch the caller can see.
       * No mandatory day or hour is imposed: the documents say monthly and
       * nothing more.
       */
      schedule_membership_meeting: {
        Args: {
          p_branch_id: string;
          p_meeting_type: string;
          p_title: string;
          p_venue: string;
          p_scheduled_at: string;
          p_agenda?: string | null;
        };
        Returns: string;
      };

      /**
       * Polytos Phase 4. Moves a scheduled meeting, keeping the **first** date
       * it was announced for — that is the one members remember, and keeping
       * the most recent one instead would lose it.
       */
      reschedule_membership_meeting: {
        Args: {
          p_meeting_id: string;
          p_scheduled_at: string;
          p_reason: string;
          p_venue?: string | null;
        };
        Returns: string;
      };

      /**
       * Polytos Phase 4. Cancels a scheduled meeting, and refuses to cancel
       * one people attended — a meeting that took place is marked held,
       * whatever anybody wants the record to say.
       */
      cancel_membership_meeting: {
        Args: { p_meeting_id: string; p_reason: string };
        Returns: string;
      };

      /**
       * Polytos Phase 4. Marks or corrects one member's attendance.
       *
       * The same answer twice is a no-op, so a double tap cannot rewrite a
       * register; a different answer is a correction and needs a reason,
       * which is appended to `meeting_attendance_corrections` before the row
       * moves.
       */
      mark_meeting_attendance: {
        Args: {
          p_meeting_id: string;
          p_membership_id: string;
          p_attendance: string;
          p_absence_reason?: string | null;
          p_note?: string | null;
          p_correction_reason?: string | null;
        };
        Returns: string;
      };

      /**
       * Polytos Phase 4. Writes or amends a held meeting's minutes. Refused
       * for a meeting that has not happened, and an amendment to finalised
       * minutes needs a note saying what changed.
       */
      record_meeting_minutes: {
        Args: {
          p_meeting_id: string;
          p_minutes: string;
          p_amendment_note?: string | null;
        };
        Returns: string;
      };

      /**
       * Polytos Phase 4. Marks minutes as the record. A separate act from
       * writing them, because minutes everybody can still edit are not a
       * record of what was decided.
       */
      finalise_meeting_minutes: { Args: { p_meeting_id: string }; Returns: string };

      /**
       * Polytos Phase 4. Records something a meeting decided somebody would
       * do. The assignee is a staff profile with an active account, not a
       * typed name: "somebody will look into it" is how an action item becomes
       * nobody's.
       */
      add_meeting_action_item: {
        Args: {
          p_meeting_id: string;
          p_description: string;
          p_assigned_to?: string | null;
          p_due_on?: string | null;
        };
        Returns: string;
      };

      /** Polytos Phase 4. Moves an action item along, stamping who closed it. */
      update_meeting_action_item: {
        Args: { p_action_id: string; p_status: string; p_note?: string | null };
        Returns: string;
      };

      /**
       * Polytos Phase 4. Every reason a claim cannot be assessed, as codes
       * rather than one raise, so an assessment screen can list them all at
       * once instead of revealing them a refusal at a time.
       *
       * The same function `assess_benefit_claim` refuses on, which is what
       * makes the screen's answer and the button's answer the same answer.
       * Seven of its sixteen codes name a client decision nobody has made.
       */
      benefit_claim_eligibility: {
        Args: { p_claim_id: string };
        Returns: {
          failure_code: string;
          detail: string;
        }[];
      };

      /**
       * Polytos Phase 4. The Benefits dashboard in one round trip, gated on
       * `benefits:view`. Money counts live payments only: a reversed payment
       * is money the business did not spend, and counting it would disagree
       * with the trial balance.
       */
      benefit_summary: {
        Args: { p_from?: string | null; p_to?: string | null };
        Returns: {
          claims_draft: number;
          claims_submitted: number;
          claims_under_verification: number;
          claims_information_required: number;
          claims_assessed: number;
          claims_approved: number;
          claims_rejected: number;
          claims_paid: number;
          claims_total: number;
          paid_total: number;
          paid_medical: number;
          paid_condolence: number;
          paid_bereavement: number;
          payments_reversed: number;
          reversed_total: number;
          approved_awaiting_payment: number;
          members_with_beneficiary: number;
          members_with_verified_beneficiary: number;
          beneficiaries_awaiting_verification: number;
          live_memberships: number;
          meetings_upcoming: number;
          meetings_held_in_period: number;
          attendance_recorded_in_period: number;
          meeting_actions_open: number;
          benefits_open: boolean;
          blocked_reason: string | null;
        }[];
      };

      /**
       * Polytos Phase 4. What the benefits scheme cost over a period, by
       * promise, read from the General Ledger rather than from the claim
       * table — so it reconciles against the trial balance by construction
       * and a disagreement between the two becomes visible. Gated on
       * `reports:view_financial`, because who may read the company's expense
       * accounts is a financial-reporting question.
       */
      benefit_expense_by_type: {
        Args: { p_from: string; p_to: string };
        Returns: {
          account_code: string;
          account_name: string;
          claim_type: string | null;
          posted_debits: number;
          posted_credits: number;
          net_expense: number;
        }[];
      };

      /**
       * Polytos Phase 4. Why benefits are shut under a policy version, naming
       * the undecided rules in the words a person would use. The counterpart
       * of `member_lending_blocked_reason`: a banner that does not say what is
       * missing teaches the reader to scroll past it.
       */
      benefits_blocked_reason: {
        Args: { p_version_id: string };
        Returns: string | null;
      };

      // --- Polytos Phase 3: member loans -------------------------------------
      // The eligibility engine, the configurable interest engine and the
      // savings-pledge reads. `member_loan_eligibility_of` and
      // `lock_savings_capacity` are deliberately absent: both are revoked from
      // every application role and reachable only from another privileged
      // function, so a type for either would advertise a call that must not be
      // available.

      /**
       * Polytos Phase 3. The member-loan eligibility assessment a screen
       * reads: checks `member_loans:view_eligibility` and the branch rule,
       * then delegates to the authoritative assessment. An invisible client
       * and a nonexistent one give the same answer.
       *
       * The ceiling comes back null where the savings-to-loan multiplier is
       * undecided, and `blocking_reasons` names the decision. Never a default:
       * a figure there would be an invented credit limit.
       */
      assess_member_loan_eligibility: {
        Args: {
          p_client_id: string;
          p_amount?: number | null;
          p_term_months?: number | null;
          p_repayment_frequency?: string | null;
          p_as_of?: string | null;
        };
        Returns: {
          client_id: string | null;
          membership_id: string | null;
          membership_number: string | null;
          membership_status: string | null;
          policy_version_id: string | null;
          policy_version: string | null;
          as_of: string;
          savings_account_id: string | null;
          savings_account_number: string | null;
          savings_account_status: string | null;
          months_required: number | null;
          must_be_consecutive: boolean | null;
          qualifying_months: number | null;
          consecutive_qualifying_months: number | null;
          savings_qualifies: boolean | null;
          eligible_savings: number | null;
          multiplier_bps: number | null;
          max_eligible_loan: number | null;
          max_term_months: number | null;
          required_cadence: string | null;
          active_loan_count: number | null;
          active_loan_limit: number | null;
          outstanding_principal: number | null;
          pledged_savings: number | null;
          pending_withdrawals: number | null;
          available_savings: number | null;
          amount_requested: number | null;
          term_requested: number | null;
          is_eligible: boolean;
          may_proceed: boolean;
          blocking_reasons: string[];
        }[];
      };

      /**
       * Polytos Phase 3. The Member Loans dashboard in one round trip. Asks
       * for `loans:view` inside: what it reports is a loan book, and a total
       * across every member has no row for a policy to filter.
       */
      member_loan_summary: {
        Args: Record<string, never>;
        Returns: {
          applications_draft: number;
          applications_pending: number;
          loans_approved: number;
          loans_active: number;
          loans_cleared: number;
          principal_disbursed: number;
          principal_outstanding: number;
          interest_outstanding: number;
          total_outstanding: number;
          total_collected: number;
          due_today: number;
          overdue_loans: number;
          arrears_amount: number;
          live_memberships: number;
          members_qualified: number;
          members_not_yet_qualified: number;
          members_with_member_loan: number;
          savings_pledged: number;
          lending_open: boolean;
          blocked_reason: string | null;
        }[];
      };

      /**
       * Polytos Phase 3. The authoritative member loan breakdown for a
       * configured interest basis and method. `per_month` +
       * `reducing_balance_monthly` delegates to `calculate_loan_breakdown`, so
       * there is one reducing-balance implementation; `per_loan` +
       * `reducing_balance_monthly` is refused as undefined.
       */
      member_loan_interest: {
        Args: {
          p_principal: number;
          p_interest_rate_bps: number;
          p_term_months: number;
          p_interest_basis: string;
          p_interest_method: string;
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

      /**
       * Polytos Phase 3. Which collection cadence a member loan of this term
       * must use under a policy version: weekly up to the version's weekly
       * boundary, calendar-monthly beyond it.
       */
      member_loan_cadence_for_term: {
        Args: { p_version_id: string; p_term_months: number };
        Returns: string | null;
      };

      /**
       * Polytos Phase 3. Why member lending is not open under a policy
       * version, naming each decision that is missing rather than only
       * refusing.
       */
      member_lending_blocked_reason: {
        Args: { p_version_id: string };
        Returns: string;
      };

      /**
       * Polytos Phase 3. The calendar-monthly collection date n months after
       * an anchor date, resolved by the agreed convention for a month that has
       * no such day. Raises when the convention has not been decided.
       */
      monthly_collection_date: {
        Args: { p_anchor_date: string; p_months: number; p_month_anchor: string };
        Returns: string | null;
      };

      /**
       * Polytos Phase 3. How much of a savings account's balance secures live
       * member loans, as of a date. Zero while the savings-to-loan multiplier
       * is undecided, because then no member loan can be approved.
       */
      savings_pledged_amount: {
        Args: { p_savings_account_id: string; p_as_of?: string | null };
        Returns: number;
      };

      /**
       * Polytos Phase 3. How much of a savings account a member may withdraw
       * today under their own policy version's live-loan rule. Null where the
       * rule cannot be applied — the policy says only the excess over the
       * pledge, and no multiplier defines the pledge.
       */
      savings_withdrawable_amount: {
        Args: { p_savings_account_id: string; p_as_of?: string | null };
        Returns: number | null;
      };
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

      /**
       * Phase 14. Lets a guarantor out of a live loan, with a reason, provided
       * the loan keeps the number of guarantors its product requires.
       */
      release_loan_guarantor: {
        Args: { p_loan_guarantor_id: string; p_reason: string };
        Returns: string;
      };

      /**
       * Phase 15. Marks notifications read for the calling user. Null marks
       * everything they can see; the profile is derived from the session, so
       * a caller cannot write somebody else's receipt.
       */
      mark_notifications_read: {
        Args: { p_ids?: string[] | null };
        Returns: number;
      };

      /**
       * Phase 13. The loan a `loan-documents` object belongs to, taken from
       * its path. NULL when the path is not shaped like one, which denies the
       * three storage policies that gate the bucket.
       */
      storage_path_loan_id: {
        Args: { p_name: string };
        Returns: string | null;
      };

      /**
       * Phase 13. The existing clients who could back a given application,
       * each with the reasons they may not. Advice for the screen;
       * `loan_guarantors_check_eligibility` and `validate_loan_for_approval`
       * remain the enforcement.
       */
      guarantor_candidates: {
        Args: { p_loan_id: string; p_search?: string | null };
        Returns: {
          client_id: string;
          client_number: string;
          full_name: string;
          phone: string;
          occupation: string;
          location: string;
          district: string | null;
          status: string;
          has_identification: boolean;
          active_loan_count: number;
          arrears_amount: number;
          guaranteeing_count: number;
          already_attached: boolean;
          eligible: boolean;
          reasons: string[];
        }[];
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
      ledger_account_balance_as_of: {
        Args: { p_account_id: string; p_as_of: string };
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
      record_draft_policy_timing: {
        Args: {
          p_policy_id: string;
          p_effective_from: string;
          p_authorization_reference: string;
        };
        Returns: string;
      };
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
      current_user_branch_id: {
        Args: Record<PropertyKey, never>;
        Returns: string | null;
      };
      // Phase 18. The whole session in one round trip. Returns a set, so the
      // client sees an array; it is always exactly one row.
      current_session_context: {
        Args: Record<PropertyKey, never>;
        Returns: {
          outcome: string;
          auth_user_id: string | null;
          profile_id: string | null;
          full_name: string | null;
          phone: string | null;
          email: string | null;
          status: string | null;
          must_change_password: boolean | null;
          role_keys: string[];
        }[];
      };
      user_has_permission: {
        Args: { p_permission_key: string };
        Returns: boolean;
      };
      // Polytos Phase 1. The membership policy version in force on the
      // business date — active, approved and started — or null when there is
      // none. One answer for every caller, because it is what the enrolment
      // rule is written against.
      active_membership_policy_id: {
        Args: Record<PropertyKey, never>;
        Returns: string | null;
      };
      // Polytos Phase 1. Whether one named activity is open on a version
      // today: the decisions that activity needs have been made, and the
      // version is approved, active and started. The gate every later phase
      // posts behind.
      membership_policy_allows: {
        Args: { p_version_id: string; p_activity: string };
        Returns: boolean;
      };
      // Polytos Phase 1. Records a member's acceptance of a newly published
      // policy version and moves them onto it, in one transaction. The only
      // route by which memberships.policy_version_id changes.
      // Polytos Phase 2 replaced the Phase 1 signature, which took a typed
      // signature name and a typed witness name. A typed name is not
      // consent, and Phase 1's own header said so; this one takes the
      // evidence instead and routes it through the same guard an enrolment
      // acceptance goes through, so the database — not the caller — decides
      // whether it is verified.
      accept_membership_policy_version: {
        Args: {
          p_membership_id: string;
          p_policy_version_id: string;
          p_consent_method: string;
          p_signature_name: string;
          p_signature_path?: string | null;
          p_witness_profile_id?: string | null;
          p_challenge_id?: string | null;
          p_accepted_place?: string | null;
        };
        Returns: string;
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
      // Polytos Phase 2. The membership a `membership-consent` object belongs
      // to, read out of its path — which is what makes "this member's own
      // signature" expressible as a storage policy predicate. NULL when the
      // path is not shaped like one, which denies every policy that uses it.
      storage_path_membership_id: {
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
      /**
       * Phase 18. The Settings screen's read-only view of reference
       * numbering. SECURITY DEFINER and gated on settings:view, so the
       * `reference_sequences` table stays unreadable to a direct table read.
       */
      settings_reference_sequences: {
        Args: Record<PropertyKey, never>;
        Returns: {
          scope: string;
          period_year: number;
          last_value: number;
        }[];
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

      // --- Polytos Phase 2: enrolment, consent and savings -------------------
      //
      // Every function here that moves money writes its document and its
      // journal in one transaction, and each is idempotent on a key the
      // server mints when the form renders. The authorisation check sits
      // *above* the replay shortcut inside each of them: an early return
      // hands back a document id, so a caller who may not post must not be
      // able to reach one by replaying a key.
      //
      // `Returns: string` throughout means the id of the thing that was
      // written — a membership, a receipt, a transaction, a request — never a
      // balance. A caller that could be handed a balance by a posting
      // function could print any figure it liked.

      /**
       * Enrol a client: membership, fee, journal, verified consent,
       * activation, savings account and an optional first deposit, in one
       * transaction. Rolls the lot back if the consent cannot be verified.
       */
      enrol_member: {
        Args: {
          p_client_id: string;
          p_payment_method: string;
          p_fee_reference: string | null;
          p_consent_method: string;
          p_signature_name: string;
          p_fee_idempotency_key: string;
          p_signature_path?: string | null;
          p_witness_profile_id?: string | null;
          p_challenge_id?: string | null;
          p_initial_deposit?: number | null;
          p_deposit_reference?: string | null;
          p_deposit_idempotency_key?: string | null;
          p_notes?: string | null;
        };
        Returns: string;
      };

      /**
       * Collect the registration fee. The amount is checked against the
       * membership's own policy version rather than against a constant, so a
       * member enrolled in March pays March's fee.
       */
      record_membership_fee: {
        Args: {
          p_membership_id: string;
          p_amount: number;
          p_payment_method: string;
          p_external_reference: string | null;
          p_idempotency_key: string;
          p_notes?: string | null;
        };
        Returns: string;
      };

      /** Reverse a fee receipt. Does not un-activate a member. */
      reverse_membership_fee: {
        Args: { p_receipt_id: string; p_reason: string };
        Returns: string;
      };

      /**
       * Open the savings account for a membership. Idempotent by
       * construction — one account per membership, so a second call returns
       * the first — and refused while the savings rules are undecided.
       */
      open_savings_account: {
        Args: { p_membership_id: string };
        Returns: string;
      };

      /**
       * Record a deposit: debit the branch cash account, credit
       * 2100 Member Savings. A liability, never income.
       */
      post_savings_deposit: {
        Args: {
          p_savings_account_id: string;
          p_amount: number;
          p_payment_method: string;
          p_external_reference: string | null;
          p_idempotency_key: string;
          p_notes?: string | null;
        };
        Returns: string;
      };

      /** Prepare a withdrawal for review. Decides nothing. */
      request_savings_withdrawal: {
        Args: { p_savings_account_id: string; p_amount: number; p_reason: string };
        Returns: string;
      };

      /**
       * Approve or reject a prepared withdrawal. Refuses a decision from the
       * person who prepared it, which is what makes the split between
       * `savings:request_withdrawal` and `savings:approve_withdrawal` a
       * control rather than a label.
       */
      decide_savings_withdrawal: {
        Args: { p_request_id: string; p_approve: boolean; p_notes?: string | null };
        Returns: string;
      };

      /**
       * Pay an approved withdrawal: debit the liability, credit cash. The
       * balance is re-checked under the account's row lock, so two approved
       * requests racing each other cannot both be paid.
       */
      post_savings_withdrawal: {
        Args: {
          p_request_id: string;
          p_payment_method: string;
          p_external_reference: string | null;
          p_idempotency_key: string;
        };
        Returns: string;
      };

      cancel_savings_withdrawal: {
        Args: { p_request_id: string; p_reason: string };
        Returns: string;
      };

      /**
       * Reverse a posted deposit or withdrawal by writing a contra row and a
       * contra journal. Never edits the original, refuses a second reversal,
       * and refuses to reverse a deposit that has already been spent — which
       * would push the liability below nothing.
       */
      reverse_savings_transaction: {
        Args: { p_transaction_id: string; p_reason: string };
        Returns: string;
      };

      /**
       * Whether an account has served its qualifying months, as of a date.
       * SECURITY INVOKER: the policies on the subledger decide who may ask
       * about whom, so a caller passing somebody else's account id gets
       * nothing. `p_as_of` filters on `value_date`, so the answer to "did
       * they qualify on 1 June" cannot be changed by a deposit made in July.
       */
      member_savings_qualification: {
        Args: { p_savings_account_id: string; p_as_of?: string | null };
        Returns: {
          savings_account_id: string;
          as_of: string;
          monthly_minimum: number;
          months_required: number;
          must_be_consecutive: boolean;
          qualifying_months: number;
          longest_consecutive_months: number;
          months_recorded: number;
          months_short: number;
          total_contributed: number;
          total_withdrawn: number;
          balance: number;
          qualifies: boolean;
          blocked_reason: string | null;
        }[];
      };

      /**
       * A statement with a running balance. SECURITY INVOKER, for the same
       * reason. The window runs over the whole account and the period filter
       * is applied afterwards, so a statement for March opens at the balance
       * March actually opened at rather than at zero.
       */
      savings_statement: {
        Args: {
          p_savings_account_id: string;
          p_from?: string | null;
          p_to?: string | null;
        };
        Returns: {
          transaction_id: string;
          transaction_number: string;
          value_date: string;
          kind: string;
          description: string;
          deposit: number;
          withdrawal: number;
          signed_amount: number;
          running_balance: number;
          payment_method: string | null;
          external_reference: string | null;
          reverses_transaction_number: string | null;
          reversal_reason: string | null;
          recorded_by_label: string | null;
        }[];
      };

      /**
       * The savings position for a dashboard. SECURITY DEFINER, unlike the
       * two above and for the opposite reason: its whole purpose is the
       * figure for the business as a whole, where there is no row for a
       * policy to filter — so it asks for `savings:view_reports` explicitly.
       * `total_liability` is the figure that must equal the 2100 balance.
       */
      savings_summary: {
        Args: { p_from?: string | null; p_to?: string | null };
        Returns: {
          accounts_open: number;
          members_saving: number;
          total_liability: number;
          deposits_in_period: number;
          withdrawals_in_period: number;
          deposits_count: number;
          withdrawals_count: number;
          pending_withdrawal_requests: number;
          pending_withdrawal_value: number;
          members_meeting_minimum: number;
        }[];
      };

      /** Issue or reissue a membership card, superseding the one it replaces. */
      issue_membership_card: {
        Args: { p_membership_id: string; p_reason?: string };
        Returns: string;
      };

      /**
       * Issue a one-time consent code to the phone number already on the
       * member's client record — not one typed into the form, because a code
       * sent to a number a staff member chose proves nothing about who
       * received it. Returns the code **once**; only its digest is stored.
       */
      issue_membership_consent_code: {
        Args: { p_membership_id: string; p_policy_version_id: string };
        Returns: {
          challenge_id: string;
          code: string;
          delivered_to: string;
          expires_at: string;
        }[];
      };

      /**
       * Check a code without consuming it: the acceptance guard consumes it,
       * in the same transaction as the acceptance it proves, so a code cannot
       * be burned by a redemption that then records nothing.
       */
      redeem_membership_consent_code: {
        Args: { p_challenge_id: string; p_code: string };
        Returns: string;
      };

      /** The two ADR-050 activation preconditions, each readable on its own. */
      membership_fee_is_posted: {
        Args: { p_membership_id: string };
        Returns: boolean;
      };
      membership_terms_are_accepted: {
        Args: { p_membership_id: string };
        Returns: boolean;
      };
      client_has_live_loan: {
        Args: { p_client_id: string };
        Returns: boolean;
      };

      // --- Polytos business-policy update ------------------------------------
      //
      // The guards, numbering helpers and notification hooks this update added
      // are deliberately absent: they are called by the database and not over
      // the API, like every other trigger function in the schema.
      //
      // `savings_qualification_under_policy` is present because it is granted
      // to `authenticated` — the transition preview asks it what a target
      // version would say about an account, which is a legitimate read.

      assess_meeting_fine: {
        Args: { p_meeting_id: string; p_membership_id: string };
        Returns: string | null;
      };

      assess_meeting_fines: {
        Args: { p_meeting_id: string };
        Returns: number | null;
      };

      begin_membership_policy_transition: {
        Args: { p_to_version_id: string; p_effective_on: string; p_note?: string };
        Returns: string | null;
      };

      benefit_blocked_reason: {
        Args: { p_version_id: string; p_benefit: string };
        Returns: string | null;
      };

      benefit_payment_blocked_reason: {
        Args: { p_claim_id: string };
        Returns: string | null;
      };

      cancel_meeting_fine: {
        Args: { p_fine_id: string; p_reason: string };
        Returns: string | null;
      };

      carry_forward_unpaid_installments: {
        Args: { p_loan_id: string; p_as_of?: string; p_reason?: string };
        Returns: number | null;
      };

      client_has_outstanding_loan: {
        Args: { p_client_id: string };
        Returns: boolean | null;
      };

      client_outstanding_loans: {
        Args: { p_client_id: string };
        Returns: {
          loan_id: string | null;
          loan_number: string | null;
          status: string | null;
          is_member_loan: boolean | null;
          principal: number | null;
          contractual_outstanding: number | null;
          penalty_outstanding: number | null;
        }[];
      };

      complete_membership_policy_transition: {
        Args: { p_transition_id: string };
        Returns: number | null;
      };

      condolence_next_of_kin_status: {
        Args: { p_claim_id: string };
        Returns: {
          beneficiary_id: string | null;
          beneficiary_number: string | null;
          relationship: string | null;
          relationship_label: string | null;
          relationship_eligible: boolean | null;
          registered_on: string | null;
          listed_before_event: boolean | null;
          beneficiary_status: string | null;
          verification_status: string | null;
        }[];
      };

      death_confirmation_count: {
        Args: { p_claim_id: string };
        Returns: number | null;
      };

      loan_collection_period_total: {
        Args: { p_loan_id: string; p_period: string };
        Returns: number | null;
      };

      meeting_absence_excused: {
        Args: { p_meeting_id: string; p_membership_id: string };
        Returns: boolean | null;
      };

      meeting_fine_candidates: {
        Args: { p_meeting_id: string };
        Returns: {
          membership_id: string | null;
          membership_number: string | null;
          member_name: string | null;
          attendance: string | null;
          absence_reason: string | null;
          notice_id: string | null;
          notice_status: string | null;
          excused: boolean | null;
          already_fined: boolean | null;
          fineable: boolean | null;
          reason: string | null;
        }[];
      };

      meeting_fine_summary: {
        Args: { p_branch_id?: string; p_from?: string; p_to?: string };
        Returns: {
          fines_assessed: number | null;
          amount_assessed: number | null;
          fines_outstanding: number | null;
          amount_outstanding: number | null;
          fines_paid: number | null;
          amount_collected: number | null;
          fines_cancelled: number | null;
          amount_cancelled: number | null;
          payments_reversed: number | null;
          amount_reversed: number | null;
          ledger_income: number | null;
          reconciles: boolean | null;
        }[];
      };

      member_benefit_position: {
        Args: { p_membership_id: string; p_as_of?: string };
        Returns: {
          membership_id: string | null;
          policy_version_id: string | null;
          policy_version: string | null;
          confirmed_member: boolean | null;
          qualification_basis: string | null;
          savings_qualified: boolean | null;
          savings_months: number | null;
          savings_months_required: number | null;
          benefit_year_from: string | null;
          benefit_year_to: string | null;
          medical_claims_used: number | null;
          medical_claims_allowed: number | null;
          medical_claims_left: number | null;
          medical_cap_mode: string | null;
          medical_annual_cap: number | null;
          medical_amount_used: number | null;
          medical_enabled: boolean | null;
          condolence_enabled: boolean | null;
          bereavement_enabled: boolean | null;
          medical_blocked_reason: string | null;
          condolence_blocked_reason: string | null;
          bereavement_blocked_reason: string | null;
          outstanding_loan_count: number | null;
          outstanding_loan_total: number | null;
          death_confirmations_required: number | null;
        }[];
      };

      member_savings_position: {
        Args: { p_membership_id: string };
        Returns: {
          membership_id: string | null;
          policy_version_id: string | null;
          policy_version: string | null;
          monthly_minimum: number | null;
          months_required: number | null;
          must_be_consecutive: boolean | null;
          qualifying_months: number | null;
          qualifies: boolean | null;
          qualification_reason: string | null;
          savings_balance: number | null;
          pledged_savings: number | null;
          savings_multiplier_bps: number | null;
          loan_ceiling: number | null;
          outstanding_loan_count: number | null;
          outstanding_loan_total: number | null;
          withdrawal_rule: string | null;
          withdrawal_blocked: boolean | null;
          withdrawal_block_reason: string | null;
        }[];
      };

      membership_governing_policy: {
        Args: { p_membership_id: string; p_as_of?: string };
        Returns: string | null;
      };

      membership_savings_qualified: {
        Args: { p_membership_id: string; p_as_of?: string };
        Returns: {
          qualifies: boolean | null;
          qualifying_months: number | null;
          months_required: number | null;
          must_be_consecutive: boolean | null;
          monthly_minimum: number | null;
          accounts_considered: number | null;
          blocked_reason: string | null;
        }[];
      };

      post_meeting_fine_payment: {
        Args: {
          p_fine_id: string;
          p_amount: number;
          p_payment_method: string;
          p_external_reference: string;
          p_idempotency_key: string;
        };
        Returns: string | null;
      };

      preview_membership_policy_transition: {
        Args: { p_to_version_id: string; p_effective_on?: string };
        Returns: {
          membership_id: string | null;
          membership_number: string | null;
          member_name: string | null;
          branch_name: string | null;
          membership_status: string | null;
          current_version_id: string | null;
          current_version: string | null;
          savings_account_count: number | null;
          savings_balance: number | null;
          qualifies_before: boolean | null;
          qualifies_after: boolean | null;
          qualifying_months_before: number | null;
          qualifying_months_after: number | null;
          has_acceptance: boolean | null;
          already_transitioned: boolean | null;
          advisory: string | null;
        }[];
      };

      record_death_confirmation: {
        Args: {
          p_claim_id: string;
          p_confirming_membership_id: string;
          p_statement: string;
          p_confirmation_method: string;
          p_signature_name?: string;
          p_evidence_path?: string;
          p_relationship_note?: string;
        };
        Returns: string | null;
      };

      record_meeting_absence_notice: {
        Args: {
          p_meeting_id: string;
          p_membership_id: string;
          p_reason_kind: string;
          p_reason: string;
          p_reported_via?: string;
        };
        Returns: string | null;
      };

      reverse_meeting_fine_payment: {
        Args: { p_payment_id: string; p_reason: string };
        Returns: string | null;
      };

      review_meeting_absence_notice: {
        Args: { p_notice_id: string; p_approved: boolean; p_note?: string };
        Returns: string | null;
      };

      savings_account_governing_policy: {
        Args: { p_savings_account_id: string; p_as_of?: string };
        Returns: string | null;
      };

      savings_qualification_under_policy: {
        Args: {
          p_savings_account_id: string;
          p_policy_version_id: string;
          p_as_of?: string;
          p_month_minimum_from_history?: boolean;
        };
        Returns: {
          savings_account_id: string | null;
          as_of: string | null;
          monthly_minimum: number | null;
          months_required: number | null;
          must_be_consecutive: boolean | null;
          qualifying_months: number | null;
          longest_consecutive_months: number | null;
          months_recorded: number | null;
          months_short: number | null;
          total_contributed: number | null;
          total_withdrawn: number | null;
          balance: number | null;
          qualifies: boolean | null;
          blocked_reason: string | null;
        }[];
      };

      transition_membership_to_policy: {
        Args: { p_transition_id: string; p_membership_id: string };
        Returns: string | null;
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
