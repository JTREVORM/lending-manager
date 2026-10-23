# Polytos membership — the schema

Four tables, one view, one read function, nine trigger functions wired as
eighteen triggers, and five capabilities — added by seven migrations
numbered `20261019000100`–`20261019000700`.

Nothing existing was altered: no column was dropped, no constraint relaxed,
no policy widened, and no row of financial history touched.
`scripts/verify-membership-upgrade.mjs` proves the last of those against a
seeded book.

---

## 1. Entity relationships

```
            profiles ──────────────┐  (attribution, ON DELETE SET NULL,
                │                  │   except where an append-only table
                │                  │   forces RESTRICT)
                │ profile_id
                ▼  (optional, unique)
            clients ◄───────────────── memberships ──────► branches
          (one identity)   client_id   (one live per        branch_id
                           RESTRICT     client)             RESTRICT
                                           │
                        policy_version_id  │  RESTRICT
                                           ▼
                           membership_policy_versions
                           (effective-dated; frozen once referenced)
                                           ▲
                                           │ policy_version_id  RESTRICT
                                           │
            membership_status_history   membership_terms_acceptances
            (append-only, one row per   (append-only evidence, one row
             transition, written only    per (membership, version))
             by trigger)
```

### Why membership hangs off `clients` and not off `profiles`

`profiles` answers "who may sign in, and what may they do". `clients`
answers "who are we dealing with". A member is a customer, not a login —
most will never sign in to anything — so membership is keyed on
`clients.id`. A borrower reaches their own membership through
`clients.profile_id`, which is the single optional, indirect link the
system already has between a customer and an account.

### Why there is no `members` table with its own identity columns

A second identity record for the same person is how a register comes to hold
two of somebody with different phone numbers. It would also mean the
National Identification Number protection built into `client_identities`
had to be built again, and the second copy would be the one that leaked.
`memberships` therefore carries **no** name, phone, date of birth or
identity number.

---

## 2. `public.membership_policy_versions`

The programme's rules, effective-dated. A membership references the version
it was enrolled under; a version anybody is enrolled under can never have
its figures changed.

| Group | Columns |
| --- | --- |
| Identity | `id`, `version` (unique, `^\d+\.\d+$`), `title`, `effective_from`, `status` |
| Membership | `registration_fee`, `monthly_savings_minimum`, `savings_qualifying_months` |
| Lending | `member_loan_interest_rate_bps`, `member_loan_max_term_months`, `member_loan_weekly_cadence_max_months`, `non_member_loan_max_term_months` |
| Benefits | `medical_benefit_rate_bps`, `medical_benefit_min_admission_days`, `family_condolence_benefit`, `member_bereavement_benefit` |
| **Undecided** (all nullable, no defaults) | `interest_basis`, `interest_method`, `savings_to_loan_multiplier_bps`, `qualifying_months_consecutive`, `savings_withdrawal_with_active_loan`, `profit_distribution_basis`, `medical_benefit_annual_cap`, `medical_benefit_claims_per_year`, `benefit_waiting_period_days` |
| Approval | `approved_at`, `approved_by`, `approved_by_label`, `approval_reference` |
| Gate | `is_financially_enabled` — **generated always as stored** |
| Metadata | `notes`, `created_by`, `created_at`, `updated_at` |

### Constraints

| Name | Rule |
| --- | --- |
| `membership_policy_version_shape` | `version ~ '^[0-9]+\.[0-9]+$'` |
| `membership_policy_status_valid` | `draft`, `active` or `superseded` |
| `membership_policy_registration_fee_sane` | 0 … 100,000,000 |
| `membership_policy_savings_minimum_positive` | > 0, ≤ 1,000,000,000 |
| `membership_policy_qualifying_months_range` | 1 … 60 |
| `membership_policy_member_rate_range` | 0 … 100,000 bps |
| `membership_policy_member_term_range` | 1 … 120 months |
| `membership_policy_weekly_cadence_within_term` | 0 … `member_loan_max_term_months` |
| `membership_policy_non_member_term_range` | 1 … 120 months |
| `membership_policy_medical_rate_range` | 0 … 10,000 bps |
| `membership_policy_medical_admission_range` | 0 … 365 days |
| `membership_policy_condolence_sane`, `..._bereavement_sane` | 0 … 1,000,000,000 |
| `membership_policy_interest_basis_valid` | NULL, `per_month` or `per_loan` |
| `membership_policy_interest_method_valid` | NULL, `flat` or `reducing_balance_monthly` |
| `membership_policy_multiplier_range` | NULL or 0 … 1,000,000 bps |
| `membership_policy_withdrawal_rule_valid` | NULL, `allowed`, `blocked` or `above_pledged` |
| `membership_policy_distribution_basis_valid` | NULL, `pro_rata_savings`, `pro_rata_savings_months` or `equal_shares` |
| `membership_policy_medical_cap_sane` | NULL or 0 … 1,000,000,000 |
| `membership_policy_medical_claims_range` | NULL or 0 … 52 |
| `membership_policy_waiting_period_range` | NULL or 0 … 3,650 |
| `membership_policy_approval_complete` | `(approved_at is null) = (approved_by_label is null)` |
| `membership_policy_approver_needs_a_date` | An approver id implies a date |
| `membership_policy_in_force_is_approved` | Only a draft may be unapproved |
| `membership_policy_approver_label_not_blank`, `..._title_not_blank` | Not blank |
| `membership_policy_notes_length`, `..._approval_reference_length` | ≤ 4,000 / ≤ 200 |

### Indexes

| Name | Purpose |
| --- | --- |
| `membership_policy_versions_pkey` | Primary key |
| `membership_policy_versions_version_key` | One row per version string |
| `membership_policy_versions_one_active` | Unique on `(true) where status = 'active'` — at most one version in force |
| `membership_policy_versions_effective_from_unique` | Unique on `effective_from where status <> 'draft'` — two versions cannot claim the same day |
| `membership_policy_versions_status_idx` | `(status, effective_from desc)`, for the configuration list |

### Triggers

| Trigger | When | What it does |
| --- | --- | --- |
| `membership_policy_versions_set_updated_at` | BEFORE UPDATE | The shared `set_updated_at()` |
| `membership_policy_versions_guard` | BEFORE UPDATE | Freezes every figure of a version members are enrolled under; stamps `approved_at`/`approved_by`/`approved_by_label` from the session; refuses a second approval; requires `membership:manage_policies` from a session |
| `membership_policy_versions_no_delete` | BEFORE DELETE (statement) | `reject_mutation()` |
| `audit_membership_policy_change` | AFTER INSERT/UPDATE | Full before-and-after into `audit_log` |

The guard places approval **attribution** below the trusted-path exemption
and the **figure freeze** above it, deliberately: `approved_by` is
`ON DELETE SET NULL`, so deleting the approver's profile blanks the id while
`approved_at` and `approved_by_label` survive — a cascade that preserves the
record. Changing the figures, by contrast, is refused for `service_role` too,
because what a member was promised is not the privileged client's to revise.

---

## 3. `public.memberships`

| Column | Notes |
| --- | --- |
| `id` | uuid primary key |
| `membership_number` | `MB260001`. Minted by `next_reference('membership')` in a BEFORE INSERT trigger; a caller-supplied value is refused; immutable thereafter |
| `client_id` | → `clients`, RESTRICT. Immutable |
| `branch_id` | → `branches`, RESTRICT. Stamped from the client |
| `policy_version_id` | → `membership_policy_versions`, RESTRICT. Defaults to whichever version is in force; immutable |
| `status` | `pending` → `active` → `suspended` → `withdrawn` / `deceased` |
| `status_reason`, `status_changed_at`, `status_changed_by` | Reason required for `suspended` and `withdrawn`; attribution stamped by the database |
| `applied_on`, `activated_on`, `ended_on` | Calendar dates in the business timezone. Stamped by the transition that sets them |
| `notes` | ≤ 2,000 characters |
| `created_by`, `created_at`, `updated_at` | Provenance; `created_by` from the session |

### Deliberately absent

`savings_balance`, `total_saved`, `months_qualified`,
`registration_fee_paid`, `card_number`. Every one would be a financial or
derived figure in a table nothing posts to — the mistake `loan_schedules`
avoided in Phase 5 by refusing to carry an `amount_paid` of zero. A zero here
would be a statement about the software, not about the member.

### Constraints

| Name | Rule |
| --- | --- |
| `memberships_number_shape` | `^MB[0-9]{5,}$` |
| `memberships_status_valid` | The five statuses |
| `memberships_restricted_status_has_reason` | `suspended` and `withdrawn` need a non-blank reason |
| `memberships_status_reason_length`, `..._notes_length` | ≤ 500 / ≤ 2,000 |
| `memberships_pending_has_no_dates` | A pending membership has neither date |
| `memberships_live_is_activated` | `active`/`suspended` have `activated_on` and no `ended_on` |
| `memberships_ended_has_end_date` | `withdrawn`/`deceased` have `ended_on` |
| `memberships_activated_after_applied`, `..._ended_after_applied`, `..._ended_after_activated` | The dates cannot run backwards |
| `memberships_applied_on_plausible` | 2020-01-01 … business date + 1 |

### Indexes

| Name | Purpose |
| --- | --- |
| `memberships_pkey` | Primary key |
| `memberships_membership_number_key` | One number, one membership |
| **`memberships_one_live_per_client`** | **Unique on `client_id where status in ('pending','active','suspended')`** — the brief's "one active membership per client", enforced structurally. Partial, so a client who withdrew and rejoins keeps both rows |
| `memberships_status_idx` | The register's status filter |
| `memberships_applied_on_idx` | The register's ordering |
| `memberships_branch_idx` | Branch visibility |
| `memberships_client_idx` | "Is this client a member", asked on every client profile view |
| `memberships_policy_version_idx` | The policy guard's in-use check |

### The lifecycle

| From | To | Who | What is required |
| --- | --- | --- | --- |
| *(insert)* | `pending` | `membership:create` | A client. The branch and the policy version are stamped; any other opening status is refused |
| `pending` | `active` | `membership:manage_status` | Nothing beyond the capability in Phase 1. Phase 2 adds the registration-fee receipt and the signed terms as preconditions. `activated_on` is stamped |
| `pending` | `withdrawn` | `membership:manage_status` | A reason. `ended_on` stamped |
| `pending` | `deceased` | `membership:manage_status` | `ended_on` stamped |
| `active` | `suspended` | `membership:manage_status` | A reason |
| `active` | `withdrawn` | `membership:manage_status` | A reason. `ended_on` stamped |
| `active` | `deceased` | `membership:manage_status` | `ended_on` stamped |
| `suspended` | `active` | `membership:manage_status` | Nothing beyond the capability |
| `suspended` | `withdrawn` | `membership:manage_status` | A reason. `ended_on` stamped |
| `suspended` | `deceased` | `membership:manage_status` | `ended_on` stamped |
| `withdrawn` | — | — | Terminal |
| `deceased` | — | — | Terminal |

Reactivating a withdrawn membership is **not** a transition. It is a new
enrolment with a new number, because the savings qualification clock and the
benefit waiting period both restart and a reused row could not express that.

### Triggers

| Trigger | When | What it does |
| --- | --- | --- |
| `memberships_assign_number` | BEFORE INSERT | Mints the number; refuses a supplied one |
| `memberships_stamp_provenance` | BEFORE INSERT | `created_by` from the session, branch from the client, policy from whichever is in force; refuses a non-pending opening status; refuses an enrolment when no version is in force |
| `memberships_guard_transition` | BEFORE UPDATE | The lifecycle, the date stamps, the attribution, and per-column authorization |
| `memberships_set_updated_at` | BEFORE UPDATE | The shared `set_updated_at()` |
| `memberships_record_status_on_insert` | AFTER INSERT | Writes the opening history row |
| `memberships_record_status_on_update` | AFTER UPDATE OF status | Writes the transition history row |
| `memberships_no_delete` | BEFORE DELETE (statement) | `reject_mutation()` |
| `audit_membership_change` | AFTER INSERT/UPDATE | `membership.enrolled`, `membership.status_changed`, `membership.updated` |

---

## 4. `public.membership_status_history`

Append-only. `id bigint generated always as identity`, `membership_id`,
`from_status` (NULL on the opening row), `to_status`, `reason`,
`effective_on`, `changed_by`, `changed_by_label`, `occurred_at`.

Three properties worth stating:

1. **No session may write it.** `authenticated` holds `SELECT` and nothing
   else. Rows come from `memberships_record_status`, a SECURITY DEFINER
   trigger, inside the same transaction as the change.
2. **`changed_by` is `ON DELETE RESTRICT`, not SET NULL.** The table refuses
   every `UPDATE`, and an `ON DELETE SET NULL` *is* an UPDATE — so the cascade
   would be refused by the append-only trigger with an error naming the wrong
   table. `notifications` holds every reference the same way for the same
   reason, and `changed_by_label` is what makes RESTRICT affordable.
3. **It is not the audit trail.** `audit_log` records the same changes
   forensically, behind `audit:view`, which is the Owner's alone. This is the
   business history a Manager reads, and the dates Phases 2 and 4 compute the
   savings qualification and the benefit waiting period from.

Constraints: `..._to_status_valid`, `..._from_status_valid`,
`..._is_a_change` (`from_status is distinct from to_status`),
`..._reason_length`, `..._label_not_blank`.
Indexes: `(membership_id, occurred_at desc)`, `(effective_on desc)`.
Triggers: `..._no_update`, `..._no_delete`, both `reject_mutation()`.

`tests/integration/migrations.test.ts` records it in `CREATION_COLUMN` as
using `occurred_at` and in `NO_UPDATED_AT`, for the reason `notifications`
is in both: a timestamp that can never advance is worse than absent.

---

## 5. `public.membership_terms_acceptances`

What a member was shown and agreed to. One row per
`(membership_id, policy_version_id)`, so re-acceptance after a policy change
is recordable rather than destructive.

`policy_version` is denormalised **and derived**: the guard copies it from
the referenced row rather than trusting the caller, because a denormalised
column nothing checks is a column that eventually lies. It is kept because
the printed form carries the version string and it must stay legible after
the policy row is superseded — the same reasoning as
`loan_guarantors.consent_version`.

Constraints include the storage-path shape
(`^memberships/<uuid>/signature/<name>$`), which rules out traversal, an
absolute path and a path into another bucket by constraint rather than by
code review.

Privileges: `SELECT` and `INSERT` only. No `UPDATE` at all — a correction is
a fresh acceptance against a new version.

---

## 6. `public.membership_register`

A `security_invoker = true` view joining `memberships`, `clients`,
`membership_policy_versions` and `branches`. It exists so the register is one
round trip rather than a membership query followed by a client lookup per row
— the waterfall Phases 17 and 19 were spent removing, and the one a Supabase
free tier punishes hardest.

`security_invoker` is not optional. As its owner it would hand every
member's name to anybody who could select from it, bypassing all four
underlying policies. Two tests assert the flag: the catalogue one in
`tests/db/rls-payments.test.ts` and the migration-text one in
`tests/integration/migrations.test.ts`.

---

## 7. `public.active_membership_policy_id()`

`stable`, **SECURITY INVOKER**, `EXECUTE` granted to `authenticated`. It
returns the id of the version in force, or NULL.

Invoker rather than definer deliberately: it discloses nothing the caller
could not read from the table directly, so there is no reason to let it run
with more authority than the caller has. It exists so "the current policy"
has one definition rather than a `where status = 'active'` repeated in every
caller.

---

## 8. Row Level Security

Every policy is `TO authenticated`, every capability call is wrapped in a
scalar subquery (the Phase 18 InitPlan rule), and the branch rule is
restated rather than called — `user_can_see_branch` is correlated *and*
SECURITY DEFINER, so PostgreSQL can neither hoist nor inline it.

| Relation | Command | Who |
| --- | --- | --- |
| `membership_policy_versions` | SELECT | `membership:view`, **or** a member reading the version they are enrolled under |
| | INSERT | `membership:manage_policies`, and the row must arrive an unapproved draft |
| | UPDATE | `membership:manage_policies` |
| `memberships` | SELECT | `membership:view` **or** the linked borrower themselves, within the caller's branch |
| | INSERT | `membership:create`, status `pending`, own branch |
| | UPDATE | `membership:update` **or** `membership:manage_status`, own branch. Which columns is decided by the trigger |
| `membership_status_history` | SELECT | `membership:view`. **No self-clause** — a suspension reason is an internal decision written about the member, the same rule `client_remarks` follows |
| `membership_terms_acceptances` | SELECT | `membership:view` **or** the member who signed it |
| | INSERT | `membership:create` |
| `membership_register` | SELECT | Whatever the four relations above allow, because it is `security_invoker` |

**No `DELETE` grant exists anywhere in this schema.** That is how "a
membership is withdrawn, never deleted" is enforced rather than merely
documented: a capability for it cannot be added by mistake, because the
privilege is not there.

---

## 9. Capabilities

| Capability | Client | Secretary/Treasurer | Manager | Owner |
| --- | --- | --- | --- | --- |
| `membership:view` | | ✓ | ✓ | ✓ |
| `membership:create` | | | ✓ | ✓ |
| `membership:update` | | | ✓ | ✓ |
| `membership:manage_status` | | | ✓ | ✓ |
| `membership:manage_policies` | | | | ✓ |

A borrower holds none of them and reads their own membership through the
identity clause, exactly as they read their own client record. Granting
`membership:view` to `client` would hand them the whole register, which is
what that capability means everywhere else.

`membership:view_sensitive` is deliberately **not** declared. The Phase 1
schema holds no personal data of its own; the capability arrives in Polytos
Phase 4 with the beneficiary and benefit-claim tables it would actually
guard.

---

## 10. Migration sequence

| File | What it adds |
| --- | --- |
| `20261019000100_membership_permissions.sql` | Five capabilities, their role grants, and the `membership` reference scope (`MB`, padding 4) |
| `20261019000200_membership_policy_versions.sql` | The policy table, its guard, `active_membership_policy_id()`, and version 1.0 as an unapproved draft |
| `20261019000300_memberships.sql` | The membership table, the number minter, the provenance stamper and the lifecycle guard |
| `20261019000400_membership_status_history.sql` | The append-only history and the trigger that writes it |
| `20261019000500_membership_terms_acceptances.sql` | The acceptance table and its guard |
| `20261019000600_membership_rls.sql` | Every grant, every policy, and the register view |
| `20261019000700_membership_audit_triggers.sql` | Three audit triggers |

They apply in filename order, which is what the timestamp prefix is for.
`20261019000200` creates a function whose body reads `public.memberships`,
which does not exist until `20261019000300`; PL/pgSQL resolves a table
reference at execution rather than at creation, so the order is correct and
the trigger first fires only after both tables exist.
