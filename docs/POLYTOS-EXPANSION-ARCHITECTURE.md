# Polytos Financial Services — expansion architecture

How the Lending Manager becomes an integrated financial management system
supporting membership, savings, preferential member lending, member benefits,
meetings, annual profit sharing and member self-service — without a second
identity system, a second permission vocabulary, or a second set of books.

This document is the architecture for all six phases. Polytos Phase 1, the
membership foundation, is built; the rest is design. Where a decision has not
been made, this document says so rather than choosing one.

---

## 1. The baseline this extends

The audit that preceded this work found an application already carrying, at
the time of writing:

| Area | What exists |
| --- | --- |
| Application | Next.js 16, React 19, TypeScript, Tailwind 4, deployed on Vercel |
| Identity | `auth.users` → `profiles` → `user_roles`, four roles, 75 capabilities before this phase |
| Customers | `clients` (+ `client_identities` for the NIN), `guarantors`, `client_remarks` |
| Lending | `loan_products` with snapshotted terms, `loans`, `loan_periods`, `loan_schedules`, `loan_installments`, `loan_payments`, `payment_allocations`, `loan_penalties`, collateral, recovery |
| Accounting | `branches`, `ledger_accounts` (27 accounts), `journal_entries`, `journal_lines`, with a deferred balance-assertion trigger |
| Money movement | Transfers, expenses, other income, daily reconciliation, each a document that posts its own journal |
| Reporting | 33 views, ten report definitions, CSV and letterheaded PDF export |
| Authorization | A capability matrix in TypeScript, mirrored into `role_permissions`, consumed by every RLS policy through `user_has_permission()` |
| Testing | 2,238 unit/integration tests, 55 database test files against real PostgreSQL, a Docker-free end-to-end stack (real PostgREST + production Next build) driven by Playwright |

49 tables, 33 views, ~190 functions, 95 migrations. The expansion adds to
this; it replaces none of it.

### Dependencies that must remain unchanged

1. **`clients` is the only identity table for customers.** Membership,
   savings, benefits and the member portal all resolve a person through it.
2. **`clients.profile_id` is the only route from a login to a customer.** It
   is unique, optional, and writable only through
   `link_client_profile()` (service_role only).
3. **The capability matrix has one definition.**
   `lib/permissions/permissions.ts` and `public.role_permissions` are two
   representations of it, held together by `tests/db/permissions.test.ts`.
4. **Every policy routes through `user_has_permission()` /
   `current_profile_id()`**, both of which resolve only *active* profiles.
   That is what makes suspending an account take effect on the next request.
5. **`post_journal()` is the only way a journal is written**, and the
   deferred `journal_entries_assert_balanced` trigger means an unbalanced
   entry cannot be committed by anybody — application, `service_role`, or
   psql.
6. **Loan terms freeze at approval**, in `loan_periods` and
   `loan_product_snapshots`. Nothing in any later phase may rewrite them.
7. **Monetary amounts are `bigint` whole shillings** in the database and the
   branded `UgxAmount` in TypeScript. Rates are integer basis points.
8. **Nothing is deleted.** Reference records are archived; financial records
   are reversed by compensating entries.

---

## 2. Module architecture

```
                          ┌──────────────────────────┐
                          │   Identity & access      │
                          │  profiles, roles,        │
                          │  user_roles, permissions │
                          └────────────┬─────────────┘
                                       │ one capability matrix
        ┌──────────────┬───────────────┼───────────────┬──────────────┐
        ▼              ▼               ▼               ▼              ▼
  ┌──────────┐  ┌────────────┐  ┌────────────┐  ┌───────────┐  ┌──────────┐
  │ Clients  │  │ MEMBERSHIP │  │  Lending   │  │  Finance  │  │ Reports  │
  │          │◄─┤ (new)      │  │            │  │  ledger   │  │          │
  │ clients  │  │ memberships│  │ loans,     │  │ accounts, │  │ 33 views │
  │ identities│ │ policy vers│  │ products,  │  │ journals  │  │ + export │
  │ guarantors│ │ savings*   │  │ schedules, │  │           │  │          │
  │          │  │ benefits*  │  │ payments   │  │           │  │          │
  └──────────┘  └─────┬──────┘  └─────┬──────┘  └─────▲─────┘  └────▲─────┘
                      │               │               │             │
                      └───────────────┴───────────────┘             │
                            every movement posts here ──────────────┘
                                                      and is reported from here
      * Phases 2–5
```

Membership is a **sibling** of Lending, not a layer above or below it. Both
hang off Clients, both post to the one ledger, both are reported from the
same views. A member loan is a loan; a savings deposit is not.

### What each phase owns

| Phase | Name | Owns |
| --- | --- | --- |
| 1 | Foundation & membership architecture | `memberships`, `membership_policy_versions`, `membership_status_history`, `membership_terms_acceptances`, five capabilities, the register and policy screens, read-only |
| 2 | Registration & savings management | Enrolment write path, the registration-fee receipt, `savings_accounts`, `savings_transactions`, the qualification calculation, the savings posting functions |
| 3 | Member loans & eligibility | The member loan product, the eligibility engine, the monthly-cadence scheduling work (§7) |
| 4 | Benefits & meetings | `member_beneficiaries`, `benefit_claims`, `benefit_claim_documents`, `membership_meetings`, `meeting_attendance`, membership cards, the benefit posting functions, `membership:view_sensitive` |
| 5 | Profit sharing, member portal & reporting | `profit_distributions`, `profit_distribution_members`, the member portal surfaces, member statements, membership reports |
| 6 | Security, integration testing & production certification | The full-system security review, cross-module integration tests, performance certification, the production runbook |

---

## 3. Data ownership

| Fact | Owner | Everything else reads it |
| --- | --- | --- |
| Who a person is | `clients` | Membership, loans, savings, benefits, the portal |
| Their National Identification Number | `client_identities` | Nothing. Behind `clients:view_nin`, and no audit row carries it |
| Whether they may sign in | `profiles` | — |
| What they may do | `user_roles` + `role_permissions` | Every policy |
| Whether they are a member | `memberships` | Savings, benefits, eligibility, the portal |
| What rules they joined under | `membership_policy_versions`, referenced by `memberships.policy_version_id` | Every later phase that evaluates a rule |
| What they have saved | `savings_transactions` (Phase 2); the balance is **derived**, never stored | Eligibility, the distribution, statements |
| What they owe | `loan_balances` (a view over the payment ledger) | Unchanged |
| Where the money is | `journal_lines` | Every financial figure in the system |

The rule the table restates: **a balance is derived, not stored.** The
existing system already does this for loans — `loan_balances` and
`loan_delinquency` are views, so a reversal changes every figure the instant
it commits. Savings must follow it, for the same reason: a stored
`savings_balance` and the sum of the deposits will disagree, and the day they
do, nobody can tell which is right.

---

## 4. Integration with the existing system

### Clients

A membership references a client; the client record is unchanged. The client
profile gains one read-only section listing the memberships that client has
held, fetched only for a caller holding `membership:view` — a section hidden
in the markup after being fetched is a presentation decision pretending to
be a security control.

**The Client Register is untouched.** `tests/e2e/specs/membership.spec.ts`
asserts it still renders and still lists clients.

### Authentication

No new role, no new identity table, no second login. Membership adds five
capabilities to the existing matrix and nothing else. A borrower reaching
their own membership does so through `clients.profile_id`, the relationship
that already exists.

Account suspension, session verification and the unauthorized-access
behaviour are all inherited unchanged: every membership policy routes
through `current_profile_id()`, which resolves only active profiles, so a
suspended member sees nothing from the next statement onwards.
`tests/db/rls-membership.test.ts` asserts it with a still-valid token.

### Lending

Phase 3 adds a **loan product**, not a parallel lending engine. A member loan
is a row in `loans` with a product whose terms happen to be the member terms,
and it uses the same approval, disbursement, schedule, payment and penalty
machinery. The membership contributes two things: an eligibility check before
the application, and a product the member qualifies for.

A member may hold several loans exactly as a non-member may — governed by
`business_settings.max_active_loans_per_client`, which stays global, because
it is a fact about the borrower rather than about the product.

### Finance

Every membership movement posts through `post_journal()` and balances like
everything else. §6 sets out the accounts and the new source types.

### Reporting

Membership reports are new rows in `lib/reports/registry.ts` reading new
views, using the existing filter, CSV and letterheaded-PDF pipeline. No
report recomputes a figure another view already produces.

### The member portal

The portal exists, behind `portal:view`, keyed on `clients.profile_id`.
Phase 5 adds member surfaces to it. The policies are already written so that
a member reads their own membership, their own savings, their own benefit
claims and their own distribution — and nothing else.

One decision already taken: a member does **not** read
`membership_status_history`. A suspension reason is an internal decision
written about them, in the same category as `client_remarks`. What the portal
says about a member's standing is Phase 5's to choose, in words written for
the person reading them.

---

## 5. Entity-relationship design for all six phases

```
clients ──1:0..1──► memberships ──1:0..1──► savings_accounts          [P2]
   │                    │                        │
   │                    │                        └──1:N──► savings_transactions [P2]
   │                    │                                     │
   │                    │                                     └──► journal_entries
   │                    │
   │                    ├──1:N──► membership_fee_receipts      [P2] ──► journal_entries
   │                    ├──1:N──► membership_status_history    [P1]
   │                    ├──1:N──► membership_terms_acceptances [P1]
   │                    ├──1:N──► member_beneficiaries         [P4]
   │                    │             │
   │                    │             └──1:N──► benefit_claims [P4]
   │                    ├──1:N──► benefit_claims               [P4]
   │                    │             ├──1:N──► benefit_claim_documents [P4]
   │                    │             └──► journal_entries (on payment)
   │                    ├──1:N──► meeting_attendance           [P4]
   │                    └──1:N──► profit_distribution_members  [P5]
   │                                   │
   │                                   └──► journal_entries (on declaration and payment)
   │
   └──1:N──► loans (member and non-member alike)               [existing / P3]

membership_policy_versions [P1] ──1:N──► memberships
                                ──1:N──► membership_terms_acceptances

membership_meetings [P4] ──1:N──► meeting_attendance
profit_distributions [P5] ──1:N──► profit_distribution_members
```

### Proposed migration sequence

| Phase | Migrations | Notes |
| --- | --- | --- |
| 1 | `20261019000100`–`20261019000700` | **Built.** Capabilities, policy versions, memberships, history, acceptances, RLS, audit |
| 2 | `202610200001xx` | Savings capabilities; `savings_accounts`; `savings_transactions`; `membership_fee_receipts`; the two new ledger accounts; the new journal source types; `open_savings_account()`, `post_savings_deposit()`, `post_savings_withdrawal()`, `reverse_savings_transaction()`, `record_membership_fee()`; `enrol_member()` and `transition_membership()`; savings views; RLS; audit triggers |
| 3 | `202610210001xx` | Member loan product; `member_loan_eligibility` view; the monthly cadence (§7); eligibility enforcement in `validate_loan_for_approval()` |
| 4 | `202610220001xx` | Benefit capabilities; `member_beneficiaries`; `benefit_claims`; `benefit_claim_documents`; `membership_meetings`; `meeting_attendance`; membership card numbering; benefit expense accounts; `post_benefit_payment()`; `membership:view_sensitive` |
| 5 | `202610230001xx` | `profit_distributions`; `profit_distribution_members`; the distribution liability account; `declare_profit_distribution()`, `post_distribution_payment()`; member portal views; membership reports |
| 6 | `202610240001xx` | Only what certification finds. A phase that plans migrations in advance is a phase that has pre-judged its own review |

Each phase keeps the Phase 1 shape: capabilities first, then tables, then
functions, then RLS, then audit triggers, in separate migrations — so the
structure can be reviewed, and reverted, without touching a function that
handles money.

---

## 6. Financial architecture

### The accounts to be added

Proposed, not created. No account is added in Phase 1, because an account
nothing posts to is a row in the trial balance that reads as a zero balance
somebody should explain.

| Code | Name | Type | Normal side | Why |
| --- | --- | --- | --- | --- |
| `2100` | Member Savings | **liability** | credit | Money the business owes its members. The single most important account in this design: a deposit is not income, and this is the account that makes that structural rather than a convention. |
| `2200` | Member Profit Distributions Payable | liability | credit | A declared distribution the business owes but has not yet paid. Separate from `2100`, because a distribution is a new obligation and a savings balance is an old one — see the rule below. |
| `4340` | Membership Registration Fees | income | credit | The UGX 5,000. **A new account, not `4320 Registration Fees`**, which is the client-registration fee: one is a lending charge and the other is membership income, and a single account could produce neither figure. |
| `5200` | Member Benefits | expense | debit | Heading under `5000`. |
| `5210` | Medical Support | expense | debit | The 5% of a hospital bill. |
| `5220` | Family Condolence Support | expense | debit | The UGX 100,000. |
| `5230` | Member Bereavement Support | expense | debit | The UGX 200,000. |

The business already has `1010`–`1040` per branch for cash, MTN, Airtel and
bank. Savings deposits and benefit payments move through those, so no new
cash account is needed.

### The postings

Every one balances, and every one is a `post_journal()` call inside the same
transaction as the document that caused it.

| Event | Debit | Credit |
| --- | --- | --- |
| Registration fee received | Cash / MTN / Airtel / Bank | `4340` Membership Registration Fees |
| Savings deposit | Cash / MTN / Airtel / Bank | `2100` Member Savings |
| Savings withdrawal | `2100` Member Savings | Cash / MTN / Airtel / Bank |
| Savings reversal | The exact contra of the original, line for line | |
| Benefit approved **and paid** | `5210` / `5220` / `5230` | Cash / MTN / Airtel / Bank |
| Benefit reversal | The exact contra | |
| Profit distribution **declared** | `3000` Owner Capital *(or a retained-earnings account if the client introduces one — see the open question below)* | `2200` Distributions Payable |
| Profit distribution **paid** | `2200` Distributions Payable | Cash / MTN / Airtel / Bank |

Four rules the table encodes:

1. **A savings deposit is never income.** It credits a liability.
2. **A registration fee is never savings.** It credits income, and a
   different income account from the client-registration fee.
3. **A benefit payment is never a loan disbursement.** It debits an expense;
   a disbursement debits Loans Receivable. Mixing them would make the loan
   book wrong.
4. **A distribution is never a savings withdrawal.** Declaring one creates a
   new liability; withdrawing savings reduces one the member always had.
   Two accounts, so the two can never be netted by accident.

**Open question for the client:** whether to introduce a retained-earnings
account distinct from `3000 Owner Capital` before Phase 5. The present chart
has no retained earnings, so a declaration would debit Owner Capital, which
is defensible for an owner-managed business and wrong for one sharing profit
with members. Recorded, not decided.

### The journal source types to be added

`journal_entries.source_type` is a CHECK constraint listing nine values. Four
must be added, and the constraint must be **replaced** rather than widened in
place:

```sql
alter table public.journal_entries
  drop constraint journal_entries_source_valid;

alter table public.journal_entries
  add constraint journal_entries_source_valid check (source_type in (
    'opening_balance', 'loan_disbursement', 'loan_repayment',
    'payment_reversal', 'penalty_charge', 'transfer', 'expense',
    'other_income', 'adjustment',
    -- Polytos
    'membership_fee', 'savings_deposit', 'savings_withdrawal',
    'benefit_payment', 'profit_distribution'
  ));
```

Five, not four: a savings deposit and a savings withdrawal are different
events in opposite directions, and one `savings_movement` type would make
"how much did members deposit this month" a query over the journal lines
rather than over the entries.

This is an `ALTER` on a table holding financial history, so it belongs in its
own migration with nothing else in it, and it must be verified by the
upgrade check in `scripts/verify-membership-upgrade.mjs` extended with the
new source types. The constraint only ever widens: no existing value is
removed, so no existing row can fail it.

### The posting interfaces

Proposed signatures, following `record_transfer` / `record_expense` exactly —
each takes the business facts, performs its own authorization, writes its
document and posts its journal in one transaction, and returns the document
id:

```sql
-- Phase 2
public.record_membership_fee(
  p_membership_id uuid, p_amount bigint, p_payment_method text,
  p_received_on date, p_external_reference text, p_idempotency_key uuid
) returns uuid

public.post_savings_deposit(
  p_savings_account_id uuid, p_amount bigint, p_payment_method text,
  p_value_date date, p_external_reference text, p_idempotency_key uuid
) returns uuid

public.post_savings_withdrawal(
  p_savings_account_id uuid, p_amount bigint, p_payment_method text,
  p_value_date date, p_reason text, p_idempotency_key uuid
) returns uuid

public.reverse_savings_transaction(p_transaction_id uuid, p_reason text) returns uuid

-- Phase 4
public.post_benefit_payment(
  p_claim_id uuid, p_payment_account_id uuid, p_paid_on date,
  p_idempotency_key uuid
) returns uuid

-- Phase 5
public.declare_profit_distribution(p_distribution_id uuid) returns uuid
public.post_distribution_payment(
  p_distribution_member_id uuid, p_payment_account_id uuid, p_paid_on date,
  p_idempotency_key uuid
) returns uuid
```

### Atomicity and idempotency

The existing contract, restated because it must not be weakened:

- **One transaction.** The document and its journal are written together or
  not at all. `post_payment` already does this, and
  `tests/db/ledger-posting.test.ts` asserts that a failed posting refuses the
  payment.
- **One journal per document.** A partial unique index on
  `(source_type, source_id)` where `source_id is not null` makes a second
  posting for the same document impossible, including from psql. Each new
  source type needs that index.
- **An idempotency key per request.** `post_payment` takes one; every
  function above does too. A retried mobile-money callback must not take the
  savings deposit twice.
- **Reversal, never edit.** A mistake is corrected by an equal and opposite
  entry pointing at the original through `reversed_by_entry_id`.
- **Integer arithmetic only.** 5% of a hospital bill is
  `(bill * 500) / 10000` in `bigint`, rounded explicitly — never
  `bill * 0.05` in JavaScript. `scripts/audit-financial-arithmetic.mjs`
  already fails the build on a float in a money path, and it covers the new
  code by construction.

### Member and branch reconciliation

Three figures that must agree, and the reports that will assert it:

1. **Per member**: the sum of a member's savings transactions equals their
   derived balance. A view, not a stored column.
2. **Across members**: the sum of every member's balance equals the `2100`
   Member Savings balance in the general ledger. A reconciliation report, and
   a database invariant test in Phase 6.
3. **Per branch**: `2100` is a company-wide liability and is **not** branched
   in the chart, for the reason the Phase 10 migration gives — income and
   expense are sliced by the branch on the entry, not cloned per branch.
   Member savings by branch is therefore a reporting dimension read from
   `journal_entries.branch_id`, exactly as interest income by branch already
   is.

### Unique financial reference numbers

New reference scopes, each a row in `reference_formats` and an entry in
`REFERENCE_SCOPES`, minted by `next_reference()` in a BEFORE INSERT trigger:

| Scope | Prefix | Padding | Example |
| --- | --- | --- | --- |
| `membership` | `MB` | 4 | `MB260001` **(built)** |
| `savings_account` | `SA` | 4 | `SA260001` |
| `savings_transaction` | `SV` | 5 | `SV2600001` |
| `membership_fee` | `MF` | 5 | `MF2600001` |
| `benefit_claim` | `BC` | 5 | `BC2600001` |
| `profit_distribution` | `PD` | 3 | `PD26001` |

### What Phase 1 did **not** do

No account created, no source type added, no journal posted, no balance
changed, no historical entry touched. `scripts/verify-membership-upgrade.mjs`
applies the Phase 1 migrations to a database carrying 14 loans, 159 payments
and 172 journal entries and compares 26 financial figures before and after.
All 26 are identical.

---

## 7. The Phase 3 compatibility problem, recorded now

**Do not assume a member loan product can use the existing repayment
scheduling engine for calendar-monthly collection dates. It cannot.**

`public.generate_loan_schedule()` builds a collection plan as
`D + k × interval_days`, where `interval_days` comes from
`repayment_frequencies` and is immutable by trigger (because it *is* what an
agreed cadence means). The seeded cadences are `daily` (1), `every_2_days`
(2) and `every_3_days` (3).

That expresses weekly collection without difficulty: a `weekly` cadence with
`interval_days = 7`. The membership documents require weekly collection for
one- and two-month member loans, so **that half is a one-row insert**.

It cannot express monthly collection. A calendar month is 28, 29, 30 or 31
days, and "the 5th of each month" is not any fixed number of days. An
`interval_days = 30` cadence would drift: a loan disbursed on 31 January
would collect on 2 March, 1 April, 1 May — dates no borrower agreed and no
collection sheet expects.

### The required design, for Phase 3

1. **Add a cadence kind.** `repayment_frequencies` gains a
   `cadence_kind text not null default 'fixed_days'` constrained to
   `fixed_days` or `calendar_month`, and `interval_days` becomes nullable for
   a calendar cadence. The immutability guard extends to the new column: a
   cadence's kind is as much part of what it means as its interval.
2. **Branch inside the generator.** `generate_loan_schedule()` keeps its
   current arm for `fixed_days` — byte for byte, so no existing schedule can
   change — and adds an arm for `calendar_month` that steps
   `disbursement_date + k months` and clamps to the month's last day, which
   is what PostgreSQL's `+ interval '1 month'` already does correctly.
3. **Decide the anchor explicitly.** Whether a loan disbursed on the 31st
   collects on the 28th, the 30th or the 1st is a business decision. It must
   be asked, and recorded as a policy value, not chosen by the implementer.
4. **Prove nothing moved.** A parity test regenerating every existing
   schedule and asserting every date and amount is byte-identical, before the
   new arm is enabled. The suite already has `schedule-parity.test.ts`; this
   extends it.
5. **Insert `weekly` separately.** It needs none of the above, so it ships
   first and independently — the member product's one- and two-month terms
   work before the monthly work begins.

Recording this in Phase 1 is the point of recording it: Phase 3 now starts
from "the engine needs a second cadence kind and a parity test" rather than
from "the member product should be easy, it is just another product".

---

## 8. Performance

The Supabase free tier is the constraint, and the Phase 18 work is the
precedent: one register read was invoking `user_has_permission` 20,524 times
and taking 3.2 seconds, because a bare function call in a policy predicate is
evaluated per candidate row.

What Phase 1 does about it, and what later phases must keep doing:

| Rule | How Phase 1 follows it |
| --- | --- |
| Wrap every constant-argument capability call in a scalar subquery | Every membership policy does. `tests/db/rls-hoisting.test.ts` fails the build on a bare call; `tests/db/rls-membership.test.ts` asserts it again, naming the tables |
| Restate the branch rule rather than calling `user_can_see_branch` | `memberships` restates it with `current_user_branch_id()` hoisted |
| One round trip per screen | `membership_register` joins the membership, the client, the policy and the branch, so the register is one read rather than a client lookup per row |
| Page, never count | One row more than the page needs is fetched, and its presence is `hasMore`. No `count: 'exact'` anywhere |
| Fetch only for a caller who may read | The client profile fetches memberships only when the caller holds `membership:view` |
| Index what is filtered, nothing else | Seven indexes on `memberships`, each named against a query the register or a profile actually runs |
| No whole-database aggregate on a page render | The membership screens aggregate nothing |

For Phase 2 onwards, the figure to watch is the **savings balance**. It is
derived, which is right, and a `sum()` over `savings_transactions` per member
per page view is the obvious way to make the register slow. The design
intent: one view that aggregates per member in a single grouped query, read
once per page — the shape `loan_balances` already uses.

---

## 9. Security risks, and what answers each

| Risk | What answers it |
| --- | --- |
| **RLS recursion.** A policy on a membership table querying a membership table would recurse. | Every helper (`user_has_permission`, `current_profile_id`, `current_user_branch_id`) is SECURITY DEFINER, which is exactly why Phase 2 made them so. The self-clauses query `clients`, which has no policy depending on `memberships`. |
| **A privileged function becoming a hole.** | Nine new SECURITY DEFINER functions, every one a trigger, every one with `set search_path = ''`, every one with EXECUTE revoked from `public`, `anon` and `authenticated`. `tests/db/security.test.ts` asserts the whole inventory, and would fail on a tenth nobody declared. |
| **A capability granted too widely.** | The matrix is asserted cell by cell in `tests/unit/permissions.test.ts` and mirrored into the database, with `tests/db/permissions.test.ts` failing on any difference. |
| **A journal source-type constraint failing on history.** | The constraint only widens. No existing value is removed, so no existing row can fail it, and the change goes in a migration of its own. |
| **A historical loan agreement changing.** | `loan_periods` and `loan_product_snapshots` are append-only by trigger, and the upgrade check compares 26 figures across the migration. |
| **A borrower reading another borrower's membership.** | The self-clause grants exactly one row, keyed on `clients.profile_id`. Asserted by id, through the view, and as a suspended account. |
| **Personal data spreading into the audit trail.** | A membership audit row carries the membership number, the client id, the statuses and the reason. No name, no phone, no NIN — and `tests/db/memberships.test.ts` asserts the member's name appears in no audit row. |
| **Sensitive beneficiary data arriving without a capability.** | Which is why `membership:view_sensitive` is *not* declared in Phase 1. It arrives in Phase 4 with the tables it guards. |
| **A view bypassing every policy beneath it.** | `security_invoker = true` on `membership_register`, asserted twice — in the catalogue and in the migration text. |
| **Supabase free-tier exhaustion as a denial of service.** | The report rate limiter already exists; the membership screens add no aggregate. |
| **Secrets in the repository.** | The CI secret scan runs over the full history; no key, connection string or JWT is in any new file. |
| **Automatic Vercel deployment of unreviewed work.** | Phase 1 is on a branch. Nothing is merged and nothing is deployed. |

### What this design does **not** claim

A database superuser can disable a trigger. No in-database design prevents
that, and `docs/SECURITY.md` says so already. What the design does prevent is
every route the application, a leaked publishable key, a leaked secret key,
or a mistaken `DELETE FROM` can take.

---

## 10. Future phase dependencies

```
Phase 1  Foundation
   │  memberships, policy versions, capabilities, read surfaces
   ▼
Phase 2  Registration & savings ───────────────┐
   │  needs: a membership to attach savings to │
   │  needs: questions 4, 5 answered           │
   ▼                                           │
Phase 3  Member loans & eligibility            │ savings balance
   │  needs: savings balances (Phase 2)  ◄─────┘
   │  needs: questions 1, 2, 3 answered
   │  needs: the monthly cadence work (§7)
   ▼
Phase 4  Benefits & meetings
   │  needs: an active membership (Phase 1)
   │  needs: questions 7, 8, 9 answered
   │  needs: next-of-kin records before a bereavement claim
   ▼
Phase 5  Profit sharing, portal & reporting
   │  needs: savings history (Phase 2) for a pro-rata basis
   │  needs: a full year of postings to distribute
   │  needs: question 6 answered
   │  needs: the retained-earnings decision (§6)
   ▼
Phase 6  Security, integration & certification
      needs: everything above
```

**Phase 2 is blocked** until questions 4 and 5 are answered: a savings
deposit can be taken without knowing whether withdrawal is permitted, but the
qualification calculation cannot be written without knowing whether the
months must be consecutive, and a withdrawal screen cannot be built at all.

**Phase 3 is blocked** until questions 1, 2 and 3 are answered. All three are
the price of the loan.

The nine questions are in
`docs/POLYTOS-MEMBERSHIP-POLICY-DECISIONS.md`, with what each one blocks.
