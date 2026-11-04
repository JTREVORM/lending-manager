# POLYTOS Production Demo-Data Cleanup — Pre-Cleanup Manifest

- **Supabase project:** `fszgwemtgyrbhngajpzm` ("lending manager"), eu-west-1, Postgres 17.11, `ACTIVE_HEALTHY`
- **Captured:** 2026-11-04, before any mutation
- **Scope:** non-sensitive row counts and structural baseline only (no business payloads)

## Owner / Admin identity to preserve (confirmed by role + Auth UUID)

| Field | Value |
|---|---|
| Profile id | `83944cea-eba0-4cec-989b-e44528b644f6` |
| Auth UUID | `53385df0-016a-4547-9652-b5d035ef392c` |
| Auth email | `256740081305@phone.lending.invalid` |
| Full name | Mwesigwa Trevor |
| Role | `owner_admin` (rank 70) — the only holder in the database |
| Last sign-in | 2026-10-31 12:02:26+00 |
| Password present | yes (`encrypted_password` not null) |
| Auth identities | 1 |

## Non-admin staff to remove (5 profiles / 3 Auth accounts)

| Profile id | Name | Role | Auth UUID |
|---|---|---|---|
| `5e13db25-11bb-4303-bf1f-ef38ed8509f6` | Ssemakula Brian Kato | manager | `d85a515e-2910-4b87-b8a3-04656b72c3d1` |
| `b8850630-0b3d-4bbb-8185-f191c0de931e` | Nakato Winnie Birungi | secretary_treasurer | `e972719b-e166-4cb2-bfb8-e3dd7aaa82be` |
| `cfd45517-7065-47d1-a5cd-55fabef4fec4` | AKELLO MARY | secretary_treasurer | `a9f676ba-b6c8-4297-aa60-54f6f46dbd7c` |
| `47739b41-5899-4926-a413-398173d1d50d` | DEMO Branch Witness | secretary_treasurer | (none) |
| `0ed788fb-aecb-407a-ae43-44abe7230a70` | DEMO Branch Manager | manager | (none) |

`auth.users` holds exactly 4 rows; no orphaned Auth users exist. The 3 removable
Auth users hold 3 `auth.identities` rows and zero sessions, refresh tokens and MFA factors.

## Structural baseline (must be unchanged after cleanup)

| Metric | Value |
|---|---|
| Migrations (`supabase_migrations.schema_migrations`) | 161 |
| Tables in `public` | 80 |
| Tables with RLS enabled | 80 |
| RLS policies | 126 |
| User triggers (all `tgenabled = 'O'`) | 267 |
| Functions in `public` | 315 |
| Storage buckets / objects | 6 / 0 |

## Accounting baseline

| Metric | Value |
|---|---|
| `journal_lines` total debit | 89,649,530 |
| `journal_lines` total credit | 89,649,530 |
| Imbalance | 0 |
| Journal entries | 597 |
| Entries without lines | 0 |

## Row counts to delete

| Table | Rows |
|---|---|
| account_reconciliations | 5 |
| account_transfers | 11 |
| audit_log | 1671 |
| benefit_assessment_snapshots | 0 |
| benefit_claim_documents | 0 |
| benefit_claims | 0 |
| benefit_death_confirmations | 0 |
| benefit_payments | 0 |
| client_guarantors | 34 |
| client_identities | 28 |
| client_remarks | 15 |
| clients | 28 |
| expenses | 58 |
| guarantor_identities | 16 |
| guarantors | 16 |
| journal_entries | 597 |
| journal_lines | 1667 |
| loan_business_details | 1 |
| loan_client_snapshots | 28 |
| loan_collateral | 3 |
| loan_documents | 0 |
| loan_guarantor_snapshots | 34 |
| loan_guarantors | 43 |
| loan_identity_snapshots | 62 |
| loan_installment_carry_forwards | 0 |
| loan_installments | 719 |
| loan_payments | 470 |
| loan_penalties | 5 |
| loan_periods | 44 |
| loan_product_snapshots | 28 |
| loan_recovery_actions | 12 |
| loan_salary_details | 1 |
| loan_schedules | 26 |
| loans | 35 |
| meeting_absence_notices | 0 |
| meeting_action_items | 0 |
| meeting_attendance | 0 |
| meeting_attendance_corrections | 0 |
| meeting_fine_payments | 0 |
| meeting_fines | 0 |
| member_beneficiaries | 0 |
| member_beneficiary_identities | 0 |
| member_loan_eligibility_snapshots | 0 |
| member_loan_savings_pledges | 0 |
| membership_cards | 0 |
| membership_consent_challenges | 0 |
| membership_fee_receipts | 6 |
| membership_meetings | 0 |
| membership_policy_assignments | 0 |
| membership_status_history | 11 |
| membership_terms_acceptances | 5 |
| memberships | 6 |
| notification_reads | 0 |
| notifications | 119 |
| other_income | 0 |
| payment_allocations | 522 |
| rate_limit_counters | 13 |
| savings_accounts | 5 |
| savings_transactions | 26 |
| savings_withdrawal_requests | 1 |
| profiles (non-admin subset) | 5 |
| user_roles (non-admin subset) | 5 |
| auth.users (non-admin subset) | 3 |

## Row counts to preserve

| Table | Rows |
|---|---|
| branches | 1 |
| business_settings | 1 |
| company_settings | 1 |
| finance_settings | 1 |
| ledger_accounts | 35 |
| loan_products | 6 |
| loan_product_branches | 0 |
| permissions | 106 |
| role_permissions | 236 |
| roles | 4 |
| repayment_frequencies | 5 |
| reference_formats | 22 |
| membership_policy_versions | 3 |
| membership_policy_transitions | 0 |
| beneficiary_relationships | 12 |
| benefit_document_kinds | 13 |
| guarantor_consent_terms | 1 |
| profiles (owner_admin) | 1 |
| user_roles (owner_admin) | 1 |
| reference_sequences | 13 rows kept, counters reset |

## Reference sequence handling

Pre-cleanup `last_value` per scope: branch 1, client 28, expense 58, journal 597,
loan 35, membership 6, membership_fee 6, payment 470, reconciliation 5,
savings_account 5, savings_transaction 26, savings_withdrawal 1, transfer 11.

All scopes reset to 0 **except `branch`**, which is deliberately held at 1: the
`Head Office` branch (`BR2601`) is preserved, so resetting that counter would
re-issue an existing branch code.

## Settings-row foreign keys (no repointing required)

`company_settings.updated_by`, `business_settings.updated_by` and
`finance_settings.updated_by` are all NULL. `branches.created_by` is the preserved
owner profile and `branches.manager_profile_id` is NULL, so branch configuration is
untouched by staff removal. No `ON DELETE SET NULL` foreign key to `profiles` sits on
a `NOT NULL` column, so no profile deletion can fail that way.
