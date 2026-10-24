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
| Gates (all **generated always as stored**) | `is_enrolment_enabled`, `is_savings_enabled`, `is_member_lending_enabled`, `is_benefits_enabled`, `is_profit_sharing_enabled`, and `is_financially_enabled` as the overall completeness indicator |
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
| `membership_policy_versions_guard` | BEFORE UPDATE | Enforces the one-way status sequence; freezes **every contractual column, the nine undecided rules included** once the version is approved *or* anybody is enrolled under it; stamps `approved_at`/`approved_by`/`approved_by_label` from the session; refuses a second approval; requires `membership:manage_policies` from a session |
| `membership_policy_versions_no_delete` | BEFORE DELETE (statement) | `reject_mutation()` |
| `audit_membership_policy_change` | AFTER INSERT/UPDATE | Full before-and-after into `audit_log` |

#### The status moves one way

```
draft      -> active       (publishing it; the approval constraint already
                            requires an approval for anything but a draft)
active     -> superseded   (retiring it)
superseded -> nothing
```

Nothing returns to draft. A version that has been in force governed
somebody's terms for a period of time, and "draft" would assert it never
did. Nothing returns from superseded either: bringing an old version back is
publishing a new one carrying the old figures, which leaves the dates telling
the truth. The rule binds every caller, `service_role` included.

#### What the freeze covers, and when it starts

Every contractual column — the twelve confirmed figures, the **nine
undecided rules**, the version string, the effective date and the title a
printed form carries. It starts at **either** of two events: the business
approves the version, or anybody is enrolled under it.

Freezing the nine matters more than freezing the twelve. A member who
enrolled while "may savings be withdrawn against a live loan" was open did
not agree to whatever answer the business later writes into that column; they
agreed to a version in which it was open. Filling it in afterwards is a
retroactive variation of their terms in the more dangerous form, because it
leaves no trace of having changed a value.

What stays editable on a frozen version: `notes`, which is operational
commentary rather than a term, and `status`, because retiring a version is
how the next one takes effect.

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
| `pending` | `active` | `membership:manage_status` | Nothing beyond the capability in Phase 1 — **Phase 2 must add two database preconditions**, below. `activated_on` is stamped |
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

#### What Phase 2 must add to `pending → active`

This guard checks that a transition is the right *shape*. It cannot check
that the member paid and agreed, because neither record exists until Phase 2
creates the tables. Both belong in this trigger, as `exists (...)` tests
above the trusted-path exemption so they bind `service_role` too:

1. **A registration fee that posted** — a `membership_fee_receipts` row whose
   journal entry exists and has not been reversed. The test is the **journal**,
   not a status column on the receipt: "successfully posted" means the ledger
   moved.
2. **An acceptance of the member's own terms** — a
   `membership_terms_acceptances` row for this membership *and* the exact
   `policy_version_id` it carries. Accepting version 1.0 does not activate
   somebody enrolled under 1.1.

Neither can be a CHECK constraint, because both are statements about rows in
other tables. Neither belongs in a Server Action either: a membership that
reached `active` without them is a person the business is taking savings from
under terms nobody can show they agreed to, and every route to the table has
to be refused, not only the one the form takes. See ADR-050.

### Triggers

| Trigger | When | What it does |
| --- | --- | --- |
| `memberships_assign_number` | BEFORE INSERT | Mints the number; refuses a supplied one |
| `memberships_stamp_provenance` | BEFORE INSERT | `created_by` from the session, the branch from the client and the policy from the version in force — **always**, refusing a supplied value that disagrees rather than defaulting around it; refuses a non-pending opening status; refuses an enrolment when no version is in force |
| `memberships_guard_transition` | BEFORE UPDATE | The lifecycle, the branch following the client, the policy version moving only through a recorded re-acceptance, the date stamps, the attribution, and per-column authorization |
| `memberships_set_updated_at` | BEFORE UPDATE | The shared `set_updated_at()` |
| `memberships_record_status_on_insert` | AFTER INSERT | Writes the opening history row |
| `memberships_record_status_on_update` | AFTER UPDATE OF status | Writes the transition history row |
| `memberships_no_delete` | BEFORE DELETE (statement) | `reject_mutation()` |
| `audit_membership_change` | AFTER INSERT/UPDATE | `membership.enrolled`, `membership.policy_reaccepted`, `membership.status_changed`, `membership.updated` |

#### Derived always, not merely defaulted

The branch and the policy version were originally filled in **when they
arrived NULL**, which is a default rather than a rule. A caller with
`membership:create` and a copy of curl supplies them, and a supplied value
went through untouched: a member enrolled into a branch they have no
relationship with, or under a draft nobody approved, a superseded version, or
one that does not begin until next year.

The RLS policy did not close it either. Its branch clause reads *"a
branch-assigned profile may enrol only into their own branch"*, and **every
profile in this system is unassigned** — so the clause was vacuously true.

Both are now derived on every insert, and a value that disagrees with the
derivation is **refused** rather than silently corrected, which is the same
choice `memberships_assign_number` makes about a supplied membership number
and for the same reason: silently correcting it hides a caller that believes
it is choosing. The rules sit above the trusted-path exemption, so they bind
`service_role` and the table owner too.

The insert policy now states the same two rules independently — WITH CHECK is
evaluated on the finished row, after the BEFORE INSERT trigger — so the
refusal does not depend on a trigger that somebody could disable.

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

## 7. The policy functions

### `public.active_membership_policy_id()`

`stable`, **SECURITY DEFINER**, `EXECUTE` granted to `authenticated`. Returns
the id of the version in force, or NULL.

**In force means active, approved _and_ started.** `status = 'active'` alone
was not enough: a version is activated when the business decides it is next,
and `effective_from` is the day it begins. A programme announced in October
and starting in November is the ordinary case. Without the date comparison,
enrolling somebody in October bound them to terms that do not take effect
until November, and the register said they joined under rules nobody was
operating yet.

DEFINER rather than INVOKER, which is a deliberate change from the first
draft: this function is what the enrolment rule is written against, and a
rule that gives a different answer depending on who asks is not a rule. It
returns an opaque id and nothing else; the row behind it is still governed by
`membership_policy_versions_select`, so holding the id gets a caller no
further than they could already go.

### `public.membership_policy_allows(p_version_id uuid, p_activity text)`

`stable`, **SECURITY DEFINER**, `EXECUTE` granted to `authenticated`. The one
gate Polytos Phases 2–5 consult before posting anything. Two questions in one
answer, both of which must be yes: the decisions *that activity* needs have
been made (the generated column, which no write can forge), and the version
is in force on the business date (which no generated column can express,
because the business date is not immutable).

Activities: `enrolment`, `savings`, `lending`, `benefits`, `profit_sharing`.
Anything else **raises** — failing shut is safe, but a typo that silently
disables a module looks exactly like a policy that has not been decided, and
the two need very different responses. See
`docs/POLYTOS-MEMBERSHIP-POLICY-DECISIONS.md` §4 for which decisions gate
which activity.

### `public.accept_membership_policy_version(...)`

**SECURITY DEFINER**, `EXECUTE` granted to `authenticated`, and the **only**
route by which `memberships.policy_version_id` changes.

A frozen version plus an immutable column together said something the
programme cannot live with: that a member enrolled under version 1.0 is held
to version 1.0 for as long as they are a member, whatever the business and
that member later agree. That is not how terms change. The business publishes
version 1.1 and existing members are asked to accept it, and what makes that
lawful is evidence — not an editable column.

So this function writes the acceptance into
`membership_terms_acceptances` and moves the member in **one transaction**,
having first established that the caller holds `membership:manage_policies`
(when there is a session), that the membership is still live, that the target
version is approved and in force, and that it does not take effect earlier
than the version the member is already on.

The transaction-local marker it sets is a **route, not a permission**.
`memberships_guard_transition` re-checks on its own account that the
acceptance exists and that the target is approved and in force, so a caller
who found some way to set the marker still could not move a member onto a
draft, and still could not move one without their signature.

Phase 1 ships no screen for it. It exists so the rule above it can be strict
without being a trap, and so the authorization around re-acceptance is
reviewed before Polytos Phase 2 builds the form that calls it.

#### Phase 2 must require consent evidence, not a typed name

`p_signature_name` is free text. Anybody holding
`membership:manage_policies` can type any member's name, and the row that
results is indistinguishable from one the member signed. That is tolerable
only while nothing calls this function; the moment a screen does, it becomes
a staff member's unilateral power to move somebody onto new terms and produce
the paperwork saying they agreed.

Phase 2 must require, **by CHECK constraint on
`membership_terms_acceptances`** so no write path can skip it, at least one
artefact that did not originate with the person typing:

- a signature image at `signature_path`, in the private documents bucket; or
- a witnessed record carrying both `witness_name` and `witness_phone`, where
  the witness is **somebody other than `recorded_by`** — a staff member
  witnessing their own entry is the same signature twice; or
- a confirmation the member themselves sent: a portal acknowledgement under
  their own `clients.profile_id`, or a one-time code delivered to the phone
  number on the client record and returned.

`signature_name` stays — the name a person writes is what a printed form
shows — but it stops being sufficient on its own. The rule applies equally to
the acceptance taken at enrolment. See ADR-050.

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
| `20261019000800_membership_policy_reacceptance.sql` | `accept_membership_policy_version()` — the only route onto newly published terms |

They apply in filename order, which is what the timestamp prefix is for.
`20261019000200` creates a function whose body reads `public.memberships`,
which does not exist until `20261019000300`; PL/pgSQL resolves a table
reference at execution rather than at creation, so the order is correct and
the trigger first fires only after both tables exist.
