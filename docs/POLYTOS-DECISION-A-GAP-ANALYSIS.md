# POLYTOS — Decision A: Cash Sufficiency Architecture Audit and Gap Analysis

**Type:** read-only architecture and financial-integrity audit. **No implementation.**
**Audited revision:** branch `ccr-8972366d-qcq8xz` at `64ea09c`, 161 migrations.
**Also inspected (read-only):** the open draft PR stack `#19 → #27`, because the
locking Decision A depends on lives there and is not yet merged.
**Authorization honoured:** no financial posting function changed, no migration
applied, no PR merged or created, no deployment, no hosted record touched. The
PR stack — draft PRs **#26** and **#27** included — is untouched. **Production
remains NO-GO.**
**Deliverable:** this document only. One new untracked file; nothing else written.

---

## 0. Verdict at a glance

The approved rules are measured against what the code does **today**, on the
audited revision.

| # | Approved rule | Status | Where it fails |
| --- | --- | --- | --- |
| 1 | Payouts require sufficient available funds in the selected funding account | **NOT MET** | None of the three payout functions checks the funding account at all; a disbursement cannot even *name* one |
| 2 | Cash at Hand and every bank account independently controlled | **PARTIAL** | Per-account balances are correct; the only balance the product *shows* aggregates all bank accounts and totals all four kinds |
| 3 | No automatic cross-account or cross-branch borrowing | **MET BY ABSENCE** | Nothing borrows — but nothing refuses either, so three paths simply overdraw |
| 4 | Physical cash must be confirmed received | **NOT MET** | No receipt state exists; a prior migration records the deliberate decision *not* to have one |
| 5 | Bank deposits must be cleared before becoming spendable | **NOT MET** | A transfer into a bank account is spendable in the same transaction |
| 6 | Cashiers record bank-clearance evidence (dates, references, details) | **PARTIAL** | References are captured and validated; there is no clearance record to attach them to |
| 7 | A different authorized Manager/Owner verifies bank clearance | **NOT MET** | Nothing to verify. Strong precedents exist to copy |
| 8 | Pending receipts and uncleared funds cannot support payouts | **NOT MET** | Follows from 4 and 5: available ≡ booked, by construction |
| 9 | Enforced at atomic posting, concurrency-safe locking | **PARTIAL / SPLIT** | Atomicity is sound. Locking is absent on the audited revision and closed only on **unmerged PR #25** |
| 10 | Refused payouts create no journal or balance movement | **MET** | Holds by transaction semantics, with an existing test asserting it. Must be preserved |
| 11 | Every approval, correction and reversal auditable | **LARGELY MET** | Append-only ledger, contra-entry discipline, audit log. Refusals are not logged (by design) |

**The headline finding is not a defect of omission — it is a known, reported,
deliberately deferred decision.** PR #25's own migration header says so:

> Deliberately **not** added: a till sufficiency check on the lending cash-out
> paths. `disburse_loan`, `post_benefit_payment` and `post_savings_withdrawal`
> do not check that the till holds the money, so two concurrent disbursements
> can overdraw it. That is a real finding and it is reported, but adding the
> check would be a new business rule, and this correction is authorised to add
> synchronisation only.
>
> — `supabase/migrations/20261112000100_shared_till_account_locking.sql` (PR #25)

and its closure report escalated it:

> **Recorded as an open decision for the Product Owner.**
>
> — `docs/POLYTOS-SHARED-TILL-CLOSURE-REPORT.md` §4, §7 (PR #25)

Decision A is the answer to that escalation. This audit therefore has an
unusually firm foundation: the gap was already located, reproduced and scoped
by the work immediately beneath it.

**Does the current schema distinguish booked balances from cleared available
funds?** **No.** There is exactly one balance primitive —
`ledger_account_balance(uuid)` (`supabase/migrations/20261011000100_finance_foundations.sql:198`)
— it sums every journal line on the account, and every caller, view, report and
screen in the product reads that one number. The token `cleared` does occur in
the schema, but it means *a loan that owes nothing*
(`loans.status = 'cleared'`), which is a different domain concept and a naming
collision Decision A must avoid.

---

## 1. Current implementation versus approved requirements

### 1.1 The accounting model, as built

Double entry, **cash basis**, one chart of accounts, append-only journal. The
design intent is documented at `docs/LEDGER.md` and in the migration headers,
and the audit found the code faithful to it.

| Object | Where | What it is |
| --- | --- | --- |
| `branches` | `20261010000100_branches_and_ledger.sql:57` | A place money physically sits |
| `ledger_accounts` | `20261010000100:113` | The whole chart. Rows with `cash_kind` are the physical places and carry a `branch_id` |
| `journal_entries` | `20261010000100:205` | Balanced posting header, append-only |
| `journal_lines` | `20261010000100:280` | One side, separate `debit`/`credit` columns |
| `post_journal(...)` | `20261010000200_ledger_backfill.sql:202` | **The only writer of a journal line in the system** |
| `ledger_account_balance(uuid)` | `20261011000100:198` | The one balance primitive, signed by normal side |
| `ledger_account_balances` / `branch_cash_position` / `trial_balance` | `20261010000100:490`, `:526`, `:549` | The read surface, `security_invoker` |

Cash kinds are `cash_at_hand`, `mtn_mobile_money`, `airtel_money`, `bank`
(`20261010000100:164`). A partial unique index allows exactly one till and one
of each wallet per branch and deliberately excludes `bank`, so a branch may
hold several bank accounts (`20261010000100:184`).

### 1.2 Rule 1 — sufficiency on the selected funding account

**Not met on any of the three named paths.**

| Path | Current definition | Cash check |
| --- | --- | --- |
| Loan disbursement | `disburse_loan` — `20261010000300_ledger_posting.sql:32` | **none** |
| Savings withdrawal payout | `post_savings_withdrawal` — `20261028000300_savings_withdrawal_outstanding_loans.sql:384` | **none** on company cash |
| Benefit payment | `post_benefit_payment` — `20261028000750_benefit_assessment_snapshot.sql:502` | **none** |

`assert_cash_available(uuid, bigint)` (`20261011000100:244`) is the only
sufficiency control in the product, and it is reached from exactly four places:

- `post_transfer_journal` → `20261011000210_money_movement_transfers.sql:121`
- `reverse_transfer` → `20261011000210:386`
- `post_expense_journal` → `20261011000220_money_movement_expenses.sql:36`
- `reverse_other_income` → `20261011000230_money_movement_income.sql:146`

Three further observations make the gap sharper than "a missing call":

**The funding account is not a parameter.** `disburse_loan(p_loan_id uuid)`
takes a loan and nothing else, and `post_disbursement_journal`
(`20261010000200:437`) hard-codes the destination:

```sql
'account_id', public.branch_cash_account(r.branch_id, 'cash_at_hand'),
'debit', 0, 'credit', r.principal_amount, 'memo', 'Paid out at the counter'
```

with the comment *"The funding account is Cash at Hand because `loans` records
no disbursement method."* So "the **selected** funding account" in rule 1 does
not exist for disbursements: there is no column, no parameter, no form field
(`lib/loans/actions.ts:417` passes only `p_loan_id`). Savings withdrawals and
benefit payments do choose, indirectly, by `payment_method` →
`payment_method_cash_kind` → `branch_cash_account`
(`20261010000200:118`, `:138`).

**`post_savings_withdrawal` is the instructive near-miss.** It locks carefully
and checks three balances — the member's savings
(`sum(signed_amount)` under a row lock), the withdrawable amount after loans
and pledges, and the governing policy. Every one of them is about the
*member's* money. None is about the company's till. A path can be rigorously
synchronised on its own domain resource and entirely unprotected on the shared
one; PR #25's report makes the same point in the same words.

**`allow_negative_cash` is a single global switch over the only control that
exists** (`20261011000100:149`, read inside `assert_cash_available` at `:256`).
It is correctly designed — the helper reads the setting itself so no caller can
opt out — but it is system-wide, not per account, and it is Owner-settable
through the UI (`lib/validation/settings.ts:244`, `lib/settings/actions.ts:266`).
Any Decision A design must state explicitly whether this flag may switch off
the new rules.

### 1.3 Rule 2 — independent control of Cash at Hand and each bank account

**Partial.** Structurally the model is right: balances are per `ledger_accounts`
row, `ledger_account_balance` is per account, and nothing nets one account
against another.

The failure is in presentation and in the funding decision. `branch_cash_position`
(`20261010000100:526`) collapses **every** bank account of a branch into one
`cash_at_bank` figure and then sums all four kinds into `total_liquidity`:

```sql
coalesce(sum(bal.balance) filter (where bal.cash_kind = 'bank'), 0) as cash_at_bank
...
total_liquidity
```

That view is what the product shows — `getCashPositions()`
(`lib/data/finance.ts:199`) reads exactly those columns and the finance page
renders them (`app/(app)/finance/page.tsx:53`). A branch with three bank
accounts sees one number, and a "total liquidity" figure invites precisely the
mental cross-account borrowing rule 3 forbids.

### 1.4 Rule 3 — no automatic cross-account or cross-branch borrowing

**Met by absence, and that is weaker than it sounds.** No function sweeps,
nets or borrows; every posting names its accounts explicitly; a transfer is an
explicit document with both legs constrained to cash accounts
(`account_transfers_distinct_accounts`, `assert_cash_account`). Cross-branch
movement is possible only by recording a transfer, which is correct.

But because rule 1 is unmet on three paths, the *effect* today is worse than
borrowing: the till goes negative. `20261112000100`'s header and
`tests/db/money-movement.test.ts:152` both confirm a negative cash balance is
reachable and currently only ordered, not prevented.

### 1.5 Rules 4 and 8 — confirmation of physical cash, and pending receipts

**Not met, and there is a documented prior decision against it** that Decision A
supersedes. Every money-in document carries two states only:

| Table | Status domain | Reference |
| --- | --- | --- |
| `loan_payments` | `posted`, `reversed` | `20261006000200_loan_payments.sql:114` |
| `membership_fee_receipts` | `posted`, `reversed` | `20261020000400:98` |
| `savings_transactions` | (kind + reversal row) | `20261020000600`, `20261020000800` |
| `benefit_payments` | posted / reversed | `20261022000900:172` |
| `other_income` | `posted`, `reversed` | `20261011000200:280` |

There is no `pending`, no `confirmed`, no `settled`. The architectural stance is
stated in full at the head of `20261020000400_membership_fee_receipts.sql:1-34`:

> This phase deliberately does **not** invent a `settlement_status` column for
> that, because the system already has the mechanism: `account_reconciliations`
> compares an account's system balance against a counted one … Adding a second,
> parallel notion of "settled" would give two answers to one question.

That reasoning is sound *for detection* and insufficient *for control*: a daily
count tells you afterwards that money never arrived; it cannot stop the money
being paid out this morning. Decision A's rules 4, 5 and 8 overturn the stance,
and the overturning should be recorded as a new ADR that names and supersedes
this note (the repository's convention — latest is ADR-071,
`docs/DECISIONS.md:3225`).

Consequence of the current design: a cash repayment is spendable the instant it
is typed, and an MTN repayment is spendable before anyone has looked at the
statement.

### 1.6 Rules 5, 6 and 7 — bank clearance

**Rule 5: not met.** A deposit to the bank is recorded as an
`account_transfers` row, and `post_transfer_journal` (`20261011000210:90`)
debits the destination bank account in the same transaction as it credits the
till. From that instant the bank balance is indistinguishable from spendable
money. There is no in-transit state, no clearance date, no clearance document
and no `source_type` for one (`journal_entries_source_valid`, last extended at
`20261022000200_benefit_ledger_accounts.sql:116`).

**Rule 6: partial — the raw materials exist, the record does not.**
`external_reference` is present on `account_transfers`, `loan_payments`,
`savings_transactions`, `membership_fee_receipts` and `benefit_payments`, is
normalised (trim + upper) and is *required* for every non-cash method with a
minimum length — e.g. `20261028000300:510-530`. `expenses.receipt_path`
(`20261011000200:184`) shows the established pattern for attaching evidence
from the storage buckets. What is missing is a clearance record with its own
date (the bank's value date, distinct from the posting date), its own
reference, its own supporting document and its own actor.

**Rule 7: not met for clearance, but the pattern to copy is already in the
codebase — three times.**

| Precedent | Where | Form of the rule |
| --- | --- | --- |
| `approve_transfer` | `20261011000210:274` | refuses `initiated_by = current_profile_id()` |
| `approve_expense` | `20261011000220:181` | refuses the recorder |
| `decide_savings_withdrawal` | `20261020000700:480` | refuses the preparer |
| `verify_beneficiary` | `20261022000400:820` | second pair of eyes, both names recorded in audit |
| **`verify_agency_transaction`** | PR stack, `20261108000300_agency_lifecycle.sql:448` | refuses the submitter **and** a CHECK constraint `agency_transactions_verifier_not_submitter` enforces it independently — **and the journal is written only at verification** |

The agency pattern is the strongest template available and matches Decision A's
shape almost exactly: `draft → awaiting_verification → posted`, where posting
*is* verification, the distinct-actor rule exists at both the function layer
(for a legible message) and the storage layer (so it cannot be forgotten), and
a retry on an already-verified document returns its journal rather than posting
twice.

**A caution on the role matrix.** "A different authorized Manager/Owner" cannot
be implemented by splitting capabilities, because the existing matrix gives one
role both sides of several pairs: `manager` and `owner_admin` each hold
`savings:approve_withdrawal` **and** `savings:post_withdrawal`
(`20261020000100_savings_permissions.sql:75-84`), and `manager` holds
`benefits:assess` **and** `benefits:pay`
(`20261022000100_benefit_permissions.sql:178-180`). The savings migration even
states the intent:

> Approving and paying *may* be the same person. That is deliberate.
> — `20261020000700_savings_withdrawals.sql:20`

So the distinct-actor rule for clearance must be **per document, by profile
id**, exactly as the five precedents above do it — not by capability design.

### 1.7 Rule 9 — atomic posting and concurrency-safe locking

**Atomicity: sound.** Every money path is a single `SECURITY DEFINER`
PL/pgSQL function that posts its journal before returning; an unhandled raise
aborts the whole transaction, so there is no interleaving in which the document
commits and the journal does not. Three structural guarantees back it:

- the **deferred** constraint triggers `journal_lines_assert_balanced` and
  `journal_entries_assert_balanced` (`20261010000100:409`, `:414`) evaluate the
  balance rule at commit against the whole entry, so an unbalanced journal
  cannot be committed by the application, by `service_role`, or by hand;
- `journal_entries_one_per_source`, unique on `(source_type, source_id)`
  (`20261010000200:78`), makes a second journal for one event impossible at the
  storage level — this is also what makes the historical backfill idempotent;
- `idempotency_key uuid not null unique` on every money-in document
  (`loan_payments:64`, `membership_fee_receipts:66`, `savings_transactions:72`,
  `benefit_payments:122`), with an advisory lock taken **on the key** before
  anything else so a replay serialises and returns the existing row
  (`20261010000300:139`).

**Locking: absent on the audited revision; closed only on unmerged PR #25.**
This is the single most important fact about where Decision A can be built.

On `64ea09c` (what this audit covers), `assert_cash_available` is declared
`stable` and does this, with no lock of any kind:

```sql
v_balance := public.ledger_account_balance(p_account_id);
if v_balance >= p_amount then return; end if;
```

Nothing holds the balance still between the read and the write, so two
transactions both read the same figure and both post — a textbook
time-of-check/time-of-use double spend. Separately, **no posting path locks a
cash account in either direction**: PR #25's audit found that of 29 journal-
posting functions, 16 took no account lock at all, and that the four which
appeared protected got the lock only as a side effect of a sufficiency check
that is only ever applied to the account being drawn *down* — so every account
an entry *credited* went unlocked.

On the PR stack, two migrations close it:

| Migration | PR | What it adds |
| --- | --- | --- |
| `20261109000100_ledger_balance_serialization.sql` | #23/#24 lineage | `lock_ledger_balances(uuid[])` — a transaction-scoped advisory lock per account, taken in **sorted, distinct, null-free** order so two callers cannot deadlock; `assert_cash_available` becomes lock-first, read-after |
| `20261112000100_shared_till_account_locking.sql` | **#25** | moves the lock **inside `post_journal`**, over every cash/float account in the entry, before the reference counter — covering every posting path by construction, including paths added later |

The lock order the whole system now follows is **provider lock → account locks
(sorted) → reference counter**, and PR #25 also fixed the deadlock its own
change would otherwise have introduced on the two transfer paths (a caller
holding only the source account held an out-of-order subset).

The practical consequence for Decision A: **it must be built on PR #25 or
above.** Implementing availability checks on the audited base would reproduce
the TOCTOU race in a new place.

### 1.8 Rule 10 — a refused payout moves nothing

**Met, with existing evidence.** Because the check, the document insert and the
journal are one transaction, a raise unwinds all of it. There is a test that
asserts the stronger property — a refused transfer is not even a *pending* row:

```ts
).rejects.toThrow(/less than/i);
// And nothing was written: a refused transfer is not a pending one.
const rows = await query(`select 1 from public.account_transfers`);
expect(rows).toHaveLength(0);
```
— `tests/db/money-movement.test.ts:140-148`

Two design constraints follow for Decision A: the availability check must run
**inside** the posting transaction (not as a separate pre-flight RPC whose
result is then trusted), and nothing about a refusal may be written by a
mechanism that commits independently.

### 1.9 Rule 11 — auditability

**Largely met.** `audit_log` + `record_audit_event(...)`
(`20261001000600_audit_log.sql:154`) records actor, label, action, entity,
before/after and metadata, attributing unattended actions to `system` rather
than leaving a blank. The ledger is append-only:
`journal_lines` refuses UPDATE and DELETE outright; `journal_entries` refuses
DELETE and permits **exactly one** mutation — stamping
`reversed_by_entry_id` — enforced column-by-column by
`journal_entries_guard_update` (`20261010000100:441`):

> 'A journal entry is history. Reverse it with a contra entry rather than
> editing it.'

Every reversal has its own `source_type` (`transfer_reversal`,
`expense_reversal`, `savings_deposit_reversal`, …) precisely so the
one-journal-per-source index still means something
(`20261020000200:47`, `20261022000200:75`).

**This guard is a hard design input.** A `clearance_status` or `cleared_at`
column added to `journal_entries` would be refused by it on every update.
Clearance state must therefore live on its **own table**, which is also the
better design: it keeps the ledger immutable and makes historical compatibility
free (§7).

Two auditability gaps worth naming: a **refused** payout leaves no record at
all (there is nothing wrong with that — rule 11 names approvals, corrections
and reversals — but see §9.11), and the finance write functions record audit
events without any branch check (§3, D10).

---

## 2. Existing reusable database functions and safeguards

Decision A should be assembled mostly from parts that already exist and are
already certified. This is the inventory.

### 2.1 Reuse directly, unchanged

| Function / object | Where | Why it is the right part |
| --- | --- | --- |
| `post_journal(...)` | `20261010000200:202` | The single writer. Any new posting goes through it and inherits the balance rule, the zero-leg drop, the entry numbering and (on PR #25) the account locks |
| `lock_ledger_balances(uuid[])` | PR stack `20261109000100` | Sorted, distinct, transaction-scoped per-account advisory locks. The correct primitive for serialising an availability check against its own posting |
| `assert_cash_available(uuid, bigint)` | `20261011000100:244` (lock-first on the stack) | Keep for **booked** overdraft. Model the new availability assertion on it exactly — including reading its policy flags itself, so no caller can opt out |
| `assert_cash_account(uuid, text)` | `20261011000210:11` | Refuses a non-cash, inactive or heading account as a leg. Reuse for funding-account validation |
| `assert_postable_account(uuid, text, text)` | `20261011000210:44` | Type/heading/status validation, plus the rule that `4100`/`4200` are never hand-posted |
| `branch_cash_account(uuid, text)` | `20261010000200:138` | Branch + cash kind → account id |
| `payment_method_cash_kind(text)` | `20261010000200:118` | Method → cash kind, NULL for unknown (callers treat NULL as an error, never a default) |
| `ledger_account_by_code(text)` | `20261010000200` | Chart lookup by code |
| `next_reference(text)` | `20261001000500:118` | Atomic, gapless-per-commit reference minting with a row lock on `(scope, period_year)`. A new `bank_deposit` scope is a row in `reference_formats`, not new code |
| `business_date()` / `business_now()` / `business_timezone()` | `20261007000200_business_date.sql` | Africa/Kampala business clock. Clearance dates must use it, never `current_date` |
| `record_audit_event(...)` | `20261001000600:154` | Every transition |
| `user_has_permission(text)` | `20261002000100:83` | Capability checks |
| `user_can_see_branch(uuid)` | `20261011000100:294` | Branch scoping. NULL `profiles.branch_id` = unrestricted, which is how every profile stands today |
| `reject_mutation()` | `20261001000100_shared_functions.sql` | The no-delete / no-update trigger used on every financial document |
| `set_updated_at()` | `20261001000100` | The `updated_at` discipline |
| `current_profile_id()` / `audit_actor_label()` | Phase 1/2 | Actor derived from the session, never a parameter (ADR-025) |

### 2.2 Patterns to copy, not functions to call

| Pattern | Exemplar | What to take from it |
| --- | --- | --- |
| **Verify-posts-the-journal** | `verify_agency_transaction` — stack `20261108000300:448` | A document that exists before it posts; the journal is written *by* verification; idempotent retry returns the existing journal |
| **Distinct-actor at two layers** | same, plus `agency_transactions_verifier_not_submitter` CHECK | Function raise for a legible sentence; CHECK constraint so it cannot be forgotten or bypassed by `service_role` |
| **Pending means no journal at all** | `record_transfer` — `20261011000210:149`; `20261011000200:21-27` | Above the threshold the document waits and **no journal is written**, because writing one and reversing it on rejection would put two entries in the books for an event that never happened. This is exactly the right shape for an uncleared deposit |
| **Document ↔ journal consistency as a CHECK** | `account_transfers_posted_has_journal` — `20261011000200:130` | `(status in ('posted','reversed')) = (journal_entry_id is not null)`. The new clearance document needs the same, per journal |
| **Reversal is a contra entry with its own source type** | `reverse_transfer` — `20261011000210:345` | And it re-asserts availability on the account the money must come back out of (`:386`) — directly reusable for clearance reversal |
| **Idempotency key + advisory lock on the key, above the replay** | `post_payment` — `20261010000300:139`; ADR-056 | Authorisation *above* the replay shortcut, because the early return reads a record |
| **No stored balances** | ADR-052, `20261006000200:17` | Availability must be derived, never cached in a column, or a reversal leaves it stale |
| **Client-side sufficiency hint** | `components/finance/transfer-form.tsx:70` | `!allowNegativeCash && amount > from.balance` already disables submit. Re-point at *available* and reuse on the three payout forms |
| **Count is evidence, not an instruction** | `submit_reconciliation` — `20261011000230:191` | A difference stays visible; the ledger is never edited to match. Clearance evidence should follow the same philosophy |

### 2.3 Safeguards already in force that Decision A must not weaken

- Deferred balance constraint triggers; one-side-only lines; append-only ledger.
- `journal_entries_one_per_source` — the storage-level bar on double posting.
- `SECURITY DEFINER` + `set search_path = ''` on every money function; `revoke all
  … from public, anon` then a narrow grant. Writes never go through RLS.
- The `ALTER DEFAULT PRIVILEGES` hazard: a view created in `public` is handed
  every privilege on `anon`, so each one is explicitly revoked before `select` is
  granted (`20261010000100:605`, `20261011000240:255`). Any new view must do the
  same.
- `require_business_identity` on the definer financial RPCs
  (`20261103000100_definer_rpc_business_identity.sql`).
- Reconciliation identities asserted by test: `2100` equals
  `sum(signed_amount)` over `savings_transactions`; `1200` equals
  `principal_outstanding`; `trial_balance` columns foot (`docs/LEDGER.md`,
  `tests/db/trial-balance.test.ts`).
- Actor rate limiting on sensitive actions (`checkActorRateLimit`,
  `lib/loans/actions.ts:431`).
- `audit:money` — `scripts/audit-financial-arithmetic.mjs` holds the money path
  to integer/BigInt arithmetic mechanically.
- ADR-070 — `tests/db/postgrest-columns.test.ts` asserts every column the app
  asks PostgREST for exists in the schema.

---

## 3. Confirmed deficiencies

Each is confirmed by reading the current definition of the named function or
object on the audited revision.

| ID | Deficiency | File : function |
| --- | --- | --- |
| **D1** | Loan disbursement performs **no** cash sufficiency check; it credits the till unconditionally | `20261010000300_ledger_posting.sql:32` `disburse_loan` → `20261010000200:437` `post_disbursement_journal` |
| **D2** | Savings withdrawal payout checks the member's savings, withdrawable amount and policy, but never the company's funding account | `20261028000300_savings_withdrawal_outstanding_loans.sql:384` `post_savings_withdrawal` |
| **D3** | Benefit payment checks the claim, snapshot, recipient and gates, but never the funding account | `20261028000750_benefit_assessment_snapshot.sql:502` `post_benefit_payment` |
| **D4** | The funding account for a disbursement is not selectable — not a parameter, not a column, not a form field. Rule 1's "selected funding account" has no representation | `disburse_loan(p_loan_id uuid)`; `post_disbursement_journal` hard-codes `cash_at_hand`; `lib/loans/actions.ts:440` |
| **D5** | No booked-versus-available distinction exists. One primitive, read by everything | `20261011000100:198` `ledger_account_balance` |
| **D6** | No confirmation state for physical cash received; every money-in document is `posted` or `reversed`, and a prior migration records the deliberate decision against a settlement status | `20261006000200:114`; `20261020000400:1-34` |
| **D7** | No bank-deposit clearance state, document, date, evidence record or `source_type`. A transfer into a bank account is spendable in the same transaction | `20261011000210:90` `post_transfer_journal`; `20261022000200:116` `journal_entries_source_valid` |
| **D8** | `allow_negative_cash` is a **single global** switch over the only sufficiency control, Owner-settable from the UI, with no per-account granularity | `20261011000100:149`, `:256`; `lib/settings/actions.ts:266` |
| **D9** | On the audited revision the sufficiency check is `stable` and takes no lock — a TOCTOU double spend. Closed only on **unmerged** PR #25 | `20261011000100:244`; fixed by stack `20261109000100`, `20261112000100` |
| **D10** | **Zero** branch authorization in the finance write paths: `user_can_see_branch` appears 0 times in the transfer, expense, income and ledger-posting migrations. Any `transfers:create` holder can move another branch's cash | `20261011000210`, `:220`, `:230`, `20261010000300` (0 occurrences); contrast `20261028000300:454` and `20261028000750:584`, which do check |
| **D11** | Ledger read policies carry no branch predicate: any `ledger:view` holder reads every branch's cash accounts, journal entries and lines | `20261010000100:630-640` |
| **D12** | `branch_cash_position` aggregates all of a branch's bank accounts into one figure and totals all four kinds into `total_liquidity` — the figure the product actually displays. In tension with rule 2 and an invitation to the cross-account reasoning rule 3 forbids | `20261010000100:526`; `lib/data/finance.ts:199`; `app/(app)/finance/page.tsx:53` |
| **D13** | Reconciliation is a per-account **daily count**, one row per `(account_id, business_date)`, not per-deposit statement matching; its approval writes the variance to `5950 Cash Over and Short` and takes **no** account lock. There is no mechanism to clear an individual deposit | `20261011000200:307`; `20261011000230:285` `approve_reconciliation`; PR #25 report §2 |
| **D14** | Naming collision: `cleared` already means a fully repaid loan (`loans.status`, `cleared_at`, `cleared_by`, `delinquency_state='cleared'`). Decision A's vocabulary must not reuse it for funds | `20261007000800:103-208`; `20261007000600:448` |
| **D15** | No reference scope, capability, notification kind or `source_type` exists for deposits or clearance; none of the 22 current scopes covers it | `20261001000500` `reference_formats`; capability list §6.3 |
| **D16** | The forms' pre-submit sufficiency hint reads the **booked** balance and would silently become wrong the moment available ≠ booked | `components/finance/transfer-form.tsx:70`; `components/finance/expense-form.tsx:21` |
| **D17** | A refused payout leaves no audit record, because the audit insert rolls back with the refusal. Correct per rule 10, but it means refusals are invisible to review | `record_audit_event` within the aborted transaction |

**Not a deficiency, recorded to prevent a false positive:** the three payout
paths *do* re-validate their own domain preconditions at the moment of payment —
blacklisted client, missing breakdown or snapshot (`disburse_loan`), active
membership and governing policy and outstanding loans
(`post_savings_withdrawal`), assessment snapshot and the rule-14 loan gate
(`post_benefit_payment`). The pattern "re-ask at the moment money moves" is
already established and well executed; it simply never asked about the till.

---

## 4. Proposed accounting design for available balances

### 4.1 The principle

**Do not add a second set of books.** The double entry is correct, the trial
balance foots, and three reconciliation identities are asserted by test.
Availability is not a new account type, a contra-asset or a liability — it is
either *(a)* money sitting in a **different, non-spendable account**, or *(b)* a
**restriction** on an asset the business physically holds. The right answer
differs between bank deposits and physical cash, and the schema's own definition
of `cash_kind` — *"cash is the only thing that is physically somewhere"*
(`20261010000100:190`) — is what decides which.

### 4.2 Two candidate designs, and why the recommendation is a hybrid

**Design A — clearing accounts.** Inflows land in a non-spendable holding
account; confirmation or clearance posts a transfer into the spendable one.
Availability then needs no new primitive at all: the spendable account's
*booked* balance already excludes unavailable money, `assert_cash_available`
already enforces it, and the trial balance shows uncleared money honestly on
its face.

**Design B — a restriction layer.** The ledger is untouched; a side table
records unconfirmed inflows, and `available = booked − pending`. The money stays
in the account it is physically in.

Design A is wrong for **physical cash**: the notes *are* in the drawer, so
debiting a non-cash account would misstate where the money physically is and
would break the daily count, which counts the drawer. Design B is wrong for
**bank deposits**: once the slip and the cash leave the till, the money is
genuinely in neither place, and "in transit" is the literally true answer — and
the business already has a document with a source and a destination.

**Recommendation: hybrid — Design A for bank deposits, Design B for physical
cash.**

### 4.3 Bank deposits — a Cash in Transit clearing account

Add one chart row and one `cash_kind`:

```
1050-<branch>   Cash in Transit — <branch>    asset, debit, cash_kind 'in_transit'
```

- **Deposit** (recorded by the cashier): Dr `1050`, Cr the till. Posted at
  submission, because the cash really has left the drawer. The till's booked
  balance falls immediately and correctly; the daily count still agrees.
- **Clearance** (verified by a different Manager/Owner): Dr the bank account,
  Cr `1050`. Only now is the money spendable, because only now is it in a
  spendable account.
- `1050` is **not** a permitted funding account. Enforce structurally, not by
  convention: add `ledger_accounts.is_spendable boolean not null default true`
  (or treat the new `cash_kind` as non-spendable in `assert_cash_account`), so
  `1050` cannot be chosen as a source anywhere — transfers, expenses,
  disbursements, withdrawals or benefits.
- Double-counting is impossible **by construction**: the money is in exactly
  one account at any instant, `journal_entries_one_per_source` permits one
  journal per deposit and one per clearance (two distinct source types), and
  `assert_cash_available` on `1050` stops a clearance exceeding what is in
  transit.
- Rule 2 is satisfied exactly: one `1050` per branch, independent of every
  other account; and because `1050` carries a `branch_id`, no branch's transit
  money can clear into another branch's bank account without an explicit
  transfer.
- `branch_cash_position` gains an `in_transit` column (and must **not** fold it
  into `total_liquidity` — see D12).

New `source_type` values: `bank_deposit`, `bank_deposit_clearance`,
`bank_deposit_reversal`, `bank_deposit_clearance_reversal` — each its own, per
the convention at `20261020000200:47`.

### 4.4 Physical cash — a confirmation restriction

Keep the till posting exactly as it is; add a confirmation record and derive
availability.

```
cash_receipt_confirmations
  journal_entry_id  uuid  -- the inflow entry
  account_id        uuid  -- the till (or wallet) credited
  amount            bigint
  state             text  -- 'pending' | 'confirmed' | 'void'
  confirmed_by / _label / confirmed_at
  ...
```

Written by **one** helper invoked from `post_journal` itself, over the lines it
has been handed — the same argument PR #25 used for the lock: coverage by
construction, including paths added later, which a list of call sites cannot
promise.

Availability becomes:

```
available(account) = ledger_account_balance(account)
                   − sum(amount) over cash_receipt_confirmations
                     where account_id = account and state = 'pending'
```

**The property that makes the migration free** (§7): a row that does not exist
deducts nothing. Every historical inflow has no confirmation row and is
therefore fully available, with zero backfill and zero balance movement.

### 4.5 New database objects

| Object | Shape | Notes |
| --- | --- | --- |
| `cash_account_available_balance(p_account_id uuid) returns bigint` | `stable`, definer, no lock | For display and reports. Booked minus pending |
| `assert_cash_funds_available(p_account_id uuid, p_amount bigint) returns void` | `volatile`, definer | **The enforcement sibling.** `lock_ledger_balances(array[p_account_id])` **first**, then compute availability, then raise. Reads its own policy flags so no caller can opt out — the `assert_cash_available` discipline, verbatim |
| `assert_spendable_account(p_account_id uuid, p_role text)` | `stable`, definer | Refuses `1050`, headings, inactive accounts, non-cash accounts |
| `cash_account_availability` view | `security_invoker`, revoke-then-grant | `(account_id, booked, pending_in, in_transit, available)` |
| `branch_cash_position` | **extended**, not replaced | Add `in_transit` and `available_*` columns; keep existing columns so `lib/data/finance.ts:199` and ADR-070's column test stay green. Per-bank-account detail gets its own view |

### 4.6 Where enforcement is wired

| Path | Call to add |
| --- | --- |
| `disburse_loan` | **new parameter** `p_funding_account_id uuid` (D4), validated by `assert_spendable_account` + branch, then `assert_cash_funds_available`; `post_disbursement_journal` credits the named account instead of the hard-coded till |
| `post_savings_withdrawal` | `assert_cash_funds_available(v_cash, v_request.amount)` after `v_cash` is resolved |
| `post_benefit_payment` | `assert_cash_funds_available(v_cash, v_claim.approved_amount)` after `v_cash` is resolved |
| `post_transfer_journal`, `post_expense_journal`, `reverse_transfer`, `reverse_other_income` | **recommended:** move from `assert_cash_available` to `assert_cash_funds_available`, so there is one rule rather than two (see §9.2) |

`assert_cash_available` is kept, unchanged, for the booked-overdraft question
and for `1050`.

---

## 5. Proposed bank-clearance verification workflow

Modelled on `verify_agency_transaction` + `agency_transactions_verifier_not_submitter`,
which is the closest certified precedent in the codebase.

### 5.1 The document

```
bank_deposits
  id, deposit_number                  -- next_reference('bank_deposit')
  branch_id                           -- not null, references branches
  from_account_id                     -- the till; cash_kind not null, same branch
  transit_account_id                  -- 1050 for that branch
  bank_account_id                     -- destination; cash_kind = 'bank'
  amount                              -- > 0
  deposit_date                        -- business_date() at recording
  status                              -- 'submitted' | 'cleared' | 'rejected' | 'reversed'

  -- clearance evidence (rule 6)
  bank_reference        text          -- trimmed, upper-cased, min length
  cleared_on            date          -- the bank's value date
  deposit_slip_path     text          -- storage bucket path, expenses.receipt_path pattern
  clearance_notes       text

  recorded_by / recorded_by_label
  verified_by / verified_by_label / verified_at
  decision_reason                     -- rejection or reversal

  deposit_journal_entry_id    uuid unique  -- till -> 1050, at submission
  clearance_journal_entry_id  uuid unique  -- 1050 -> bank, at verification
  reversal_entry_id           uuid unique
  idempotency_key             uuid not null unique
  created_at, updated_at
```

**Constraints** (the rules that cannot be forgotten):

| Constraint | Rule |
| --- | --- |
| `bank_deposits_amount_positive` | `amount > 0` |
| `bank_deposits_accounts_distinct` | the three accounts are three different accounts |
| `bank_deposits_submitted_has_journal` | `(status <> 'rejected') = (deposit_journal_entry_id is not null)` |
| `bank_deposits_cleared_has_clearance` | `(status = 'cleared') = (clearance_journal_entry_id is not null)` |
| **`bank_deposits_verifier_not_recorder`** | `verified_by is null or verified_by <> recorded_by` — **the storage-level maker-checker rule** |
| `bank_deposits_clearance_has_evidence` | when `cleared`: `bank_reference` non-blank, `cleared_on` not null, `verified_by` not null, `verified_at` not null |
| `bank_deposits_cleared_on_not_before_deposit` | `cleared_on is null or cleared_on >= deposit_date` |
| `bank_deposits_rejected_has_reason` | `status <> 'rejected' or btrim(decision_reason) <> ''` |
| `bank_deposits_reversed_consistent` | `(status = 'reversed') = (reversal_entry_id is not null)` |

Plus `reject_mutation()` on DELETE, `set_updated_at()` on UPDATE, and an
update guard in the `journal_entries_guard_update` spirit so evidence columns
are write-once.

### 5.2 The functions

| Function | Capability | Behaviour |
| --- | --- | --- |
| `record_bank_deposit(p_from_account_id, p_bank_account_id, p_amount, p_deposit_date, p_description, p_idempotency_key)` | `deposits:create` | Advisory lock on the key, replay returns the existing row; `user_can_see_branch` on the till's branch; `assert_cash_funds_available(till, amount)` — **a deposit is a payout from the till and obeys rule 1**; posts Dr `1050` / Cr till; status `submitted`; audit `deposit.recorded` |
| `verify_bank_deposit(p_deposit_id, p_bank_reference, p_cleared_on, p_slip_path, p_notes)` | `deposits:verify` | `select … for update`; idempotent return if already `cleared`; **refuses `recorded_by = current_profile_id()` with `42501`**; `user_can_see_branch`; validates evidence; `assert_cash_available(transit, amount)`; posts Dr bank / Cr `1050`; status `cleared`; audit `deposit.verified` with both names |
| `reject_bank_deposit(p_deposit_id, p_reason)` | `deposits:verify` | Same distinct-actor rule; contra of the deposit entry (`bank_deposit_reversal`), money returns to the till, status `rejected`, reason required |
| `reverse_bank_deposit_clearance(p_deposit_id, p_reason)` | `deposits:verify` (see §9.9) | Only from `cleared`; `assert_cash_available(bank, amount)` — **the money must still be in the bank**, exactly as `reverse_transfer` does at `20261011000210:386`; contra of the *clearance* entry only, returning the money to `1050`; status back to `submitted` with the clearance columns cleared and the history preserved in audit; stamps `reversed_by_entry_id` on the clearance entry |

**On "inconsistent clearance reversals"** — one of the named risks. Three rules
make it consistent: a reversal contras exactly one journal (never both, never
neither); the direction is always the exact opposite of what it reverses; and
the account the money must come back out of is re-asserted for availability at
the moment of reversal. Reversing a clearance returns money to transit, not to
the till; reversing a *deposit* returns it to the till and is permitted only
while `submitted`. The two are different functions, with different source
types, because collapsing them is how a reversal comes to move money from a
place it was never in.

### 5.3 Reads, capabilities, notifications

- `bank_deposit_register` view, `security_invoker`, revoke-then-grant, joined
  to branch and account names, carrying both actors' labels so the separation
  of duties is readable rather than re-derived (the `20261022001300:126`
  pattern).
- New capabilities: `deposits:view`, `deposits:create`,
  `deposits:verify`. Suggested matrix — `secretary_treasurer`: view + create;
  `manager`: all three; `owner_admin`: all three. The distinct-actor rule does
  the real work, because `manager` necessarily holds both sides (§1.6).
- A notification for deposits submitted and not cleared beyond a configured
  age, following `20261011000100`'s low-balance threshold pattern and the
  `notify_pending_only` test discipline. Uncleared money the business has
  forgotten about is the operational failure mode this workflow creates.

---

## 6. Concurrency, RLS and maker-checker protections

### 6.1 Concurrency

1. **Build on PR #25.** `post_journal` must already lock every cash account in
   the entry. Without it, availability enforcement reintroduces the TOCTOU race
   in a new place (D9).
2. **Lock before you read, inside the assertion.** `assert_cash_funds_available`
   takes `lock_ledger_balances(array[p_account_id])` as its first statement and
   computes availability after — the construction `20261109000100` chose, for
   the reason it gives: the waiting transaction then sees the committed result
   of the one it waited for.
3. **Preserve the global lock order:** provider lock → account locks (sorted) →
   reference counter. Every new path acquires account locks only through
   `lock_ledger_balances`, which sorts, so no new deadlock is possible. A
   clearance touches `1050` and the bank account — both must be locked **up
   front, together**, before the sufficiency check, because PR #25's transfer
   fix showed that holding an out-of-order subset is precisely what deadlocks.
4. **Lock the till on confirmation too.** Confirming a pending cash receipt
   changes an availability figure, so it must take the same account lock;
   otherwise a payout can be decided against a stale availability read.
5. **Never cache availability in a column** (ADR-052). A reversal must change
   every availability figure the instant it commits.
6. **Idempotency on every new write path:** `idempotency_key uuid not null
   unique`, advisory lock on the key taken first, authorisation **above** the
   replay shortcut (ADR-056), and verification idempotent on an
   already-cleared deposit.
7. **The reproduction harness matters.** Because `post_journal` takes
   `next_reference('journal')`, whose counter row lock serialises every posting
   until commit, two sessions that both post *appear* ordered whatever their
   locking. New concurrency tests must therefore hold **only** the account's
   advisory lock, post nothing, take no reference, and assert that the payout
   path waits — and must distinguish *refused* from *walked past*. This is
   PR #25's harness (`tests/db/shared-till-concurrency.test.ts`) and it should
   be extended, not reinvented.

### 6.2 RLS

- New tables: `enable row level security`; `revoke all … from anon,
  authenticated`; `grant select` only; policy
  `user_has_permission('deposits:view') and user_can_see_branch(branch_id)`.
  No INSERT/UPDATE/DELETE grant to anybody — writes only through the definer
  functions, per `20261011000240:215-222`.
- New views: `security_invoker = true`, and **revoke from `anon` and
  `authenticated` before granting `select`**, because of the
  `ALTER DEFAULT PRIVILEGES` hazard documented at `20261010000100:605`.
- **Close D10 in this work.** Add `user_can_see_branch` to `record_transfer`,
  `approve_transfer`, `reject_transfer`, `reverse_transfer`, the three expense
  functions, `record_other_income`, `reverse_other_income`,
  `submit_reconciliation`, `approve_reconciliation`, `disburse_loan` and
  `post_payment`. Decision A's rules 2 and 3 are not enforceable while a
  `transfers:create` holder can move another branch's cash.
- **Close D11 in this work, deliberately.** Add a branch predicate to the
  `journal_entries`, `journal_lines` and `ledger_accounts` read policies. This
  is a visible behaviour change *the moment anyone is assigned a branch* — and
  today every `profiles.branch_id` is NULL, so the blast radius is nil. That
  makes now the cheapest possible moment; it will never be cheaper. Flag it to
  the PO as a scope addition rather than smuggling it in (§9.12).
- All new definer functions: `set search_path = ''`, `revoke all … from public,
  anon`, grant to `authenticated` only where a session legitimately calls them,
  and `require_business_identity` per `20261103000100`.

### 6.3 Maker-checker

- **Both layers, always.** A CHECK constraint `verified_by <> recorded_by` so it
  cannot be forgotten or bypassed by `service_role`, and a function raise with
  `42501` so the person gets a sentence they can act on. This is the agency
  precedent's own stated reasoning and it should be followed verbatim.
- **By profile id, not by capability.** `manager` and `owner_admin` hold both
  sides of several existing pairs, and `20261020000700:20` records that
  approving and paying may deliberately be the same person for withdrawals. A
  capability split would be theatre.
- **Record both names.** `recorded_by_label` and `verified_by_label` on the row
  and in the audit payload, so the separation of duties is an audit fact rather
  than something to re-derive from a join that may no longer resolve.
- **Consider the existing pairs.** Decision A tightens clearance but says
  nothing about `savings:approve_withdrawal` + `savings:post_withdrawal` or
  `benefits:assess` + `benefits:pay` both sitting with one `manager`. Out of
  scope; recorded here because a reviewer will ask (§9).

---

## 7. Migration and historical-data transition strategy

### 7.1 Non-negotiables

- **Additive only.** No applied migration is edited, renamed or re-ordered
  (`docs/DELIVERY.md:442`).
- **Timestamps above the stack head.** The newest migration on PR #27 is
  `20261115001600`. Decision A's migrations must be dated beyond it so the
  stack is never re-ordered, and must be cut from a branch that contains
  PR #25.
- **No historical journal line moves.** Not one. The audit's strongest
  assertion.

### 7.2 Why no backfill is needed — the key design property

Both halves of §4 are constructed so that **the absence of a record means
"available"**:

- physical cash: availability deducts only `cash_receipt_confirmations` rows in
  state `pending`; no historical inflow has a row, so none is deducted;
- bank deposits: `1050` starts at zero and is credited only by clearances of
  deposits recorded after the cutover; no historical deposit is retrofitted.

So at cutover **every existing balance is available in full, no row is written,
no journal is posted, no figure moves.** This is what satisfies "accidental
changes to historical balances", and it is a property of the design rather than
a promise about the migration script. The alternative — backfilling confirmation
rows or re-posting historical deposits through `1050` — would move historical
balances and must be refused.

### 7.3 Specific historical artefacts to protect

- **The derived opening entry.** `backfill_ledger_history()`
  (`20261010000200:700-735`) derived a single opening capital entry of
  **21,449,163** into Cash at Hand — the smallest figure that keeps the cash
  position non-negative across its whole history, such that the till touches
  exactly zero at its lowest point, which a test asserts. Decision A must not
  disturb it, and the test must still pass afterwards.
- **The three reconciliation identities:** `1200` ↔ `principal_outstanding`,
  `2100` ↔ `sum(signed_amount)` over `savings_transactions`, and
  `trial_balance` footing. All three must hold unchanged.
- **`journal_entries_guard_update`** (`20261010000100:441`) permits exactly one
  mutable column. Clearance state must live on its own table; this is a
  constraint-driven design decision, not a preference.
- **Replay.** The historical migration replay gate (122 + 72 migrations,
  28 figures identical, per PR #25's certification) must be re-run at the new
  migration count and the figures must be identical.

### 7.4 Mechanics

- `ledger_accounts.is_spendable` (or the new non-spendable `cash_kind`) is
  added with a default that preserves today's behaviour for every existing row.
- `1050-<branch>` rows are created idempotently per branch, in the
  `20261010000200:280` seed style (`on conflict (code) do nothing`), including
  for branches added later — a trigger or a seeding helper, not a one-shot
  `do` block, since `branches` grows.
- New `source_type` values extend `journal_entries_source_valid` by
  drop-and-recreate, the convention at `20261022000200:114`.
- New `reference_formats` row for the `bank_deposit` scope.
- `npm run db:types` to regenerate `types/database.types.ts`, and new columns
  registered in `tests/db/postgrest-columns.test.ts` (ADR-070).
- **No feature flag for the rules themselves.** Because §7.2 makes the
  transition a no-op, there is nothing a flag would buy, and a flag is exactly
  how Decision A would come to be silently switched off. If a rollback lever is
  required, make it Owner-only, per-account rather than global, audited on
  change, and separate from `allow_negative_cash` (§9.4).
- **No production application.** The release gates record the current blockers,
  including a Git-linked Supabase branch reporting `MIGRATIONS_FAILED`
  (`docs/POLYTOS-SECURITY-RELEASE-GATES.md:274`). Those are independent of this
  work and must clear on their own terms.

---

## 8. Required PostgreSQL, integration and browser tests

### 8.1 PostgreSQL (`tests/db/`, `vitest --project db`)

**`cash-sufficiency.test.ts`**
- each of the three payout paths is refused when the funding account holds less
  than the payout, with a legible message;
- a refusal writes **nothing**: no journal entry, no journal line, no document,
  no status change, no balance movement — the `money-movement.test.ts:140-148`
  assertion pattern, applied to all three paths (rule 10);
- refused when *booked* is sufficient but *available* is not, because an inflow
  is pending or a deposit is uncleared (rule 8);
- permitted once the receipt is confirmed, and once the deposit is cleared;
- `1050` cannot be selected as a funding account, by any path;
- a cross-branch funding account is refused (rule 3);
- `allow_negative_cash` does **not** permit an availability breach (whatever
  §9.4 decides, assert the decision).

**`cash-sufficiency-concurrency.test.ts`** — real parallel connections, the
`tests/db/payment-concurrency.test.ts` harness, extending PR #25's
`shared-till-concurrency.test.ts`:
- two disbursements, each affordable alone, against one till → exactly one
  succeeds; the till never goes negative;
- disbursement versus savings withdrawal; disbursement versus benefit payment;
  benefit versus withdrawal — every pair on one till;
- a payout racing a clearance verification; a payout racing a cash
  confirmation; two verifications of one deposit;
- the lock-order deadlock probe: a clearance and a transfer touching `1050` and
  the bank account in opposite orders;
- each test holds **only** the account's advisory lock and asserts the path
  waits, distinguishing *refused* from *walked past* (§6.1.7).

**`bank-clearance.test.ts`**
- evidence required to clear: blank reference, null `cleared_on`, `cleared_on`
  before `deposit_date` each refused;
- **verifier ≠ recorder** refused by the function with `42501` **and** by a
  direct `UPDATE` as `service_role`, proving the CHECK constraint stands alone;
- double clearance of one deposit refused by
  `journal_entries_one_per_source`;
- clearance reversal returns the money to `1050`, not to the till; refused when
  the bank account no longer holds it; stamps `reversed_by_entry_id`;
- deposit rejection permitted only while `submitted`, and returns the money to
  the till;
- idempotent replay of `record_bank_deposit` and `verify_bank_deposit`;
- the deposit itself obeys rule 1 — refused when the till is short.

**`cash-availability.test.ts`**
- `available = booked − pending`; a pending inflow does not raise availability;
- reversing a pending inflow removes its deduction;
- **no confirmation row ⇒ fully available** — the historical-compatibility
  assertion, run against the demo book;
- `cash_account_availability` and the extended `branch_cash_position` agree
  with the function, account by account;
- `in_transit` is never folded into a spendable figure.

**`rls-deposits.test.ts`**
- `anon` denied on every new table and view; no INSERT/UPDATE/DELETE grant to
  `authenticated`; a branch-scoped profile sees only its branch; a profile
  without the capability sees nothing.

**Regression and identity**
- `trial_balance` still foots; `1050` equals the sum of submitted deposits;
  the `1200` and `2100` identities hold;
- the derived opening entry is still 21,449,163 and the till still touches
  exactly zero at its lowest historical point;
- **every existing suite passes unchanged** — payments, allocations, schedules,
  delinquency, savings, membership, member loans, benefits, meetings, reporting.
  That is the evidence the change is additive, and it is the argument PR #25
  used for its own correction.

### 8.2 Integration (`vitest --project integration`)

- each server action returns the refusal as a friendly message, never a stack
  or a raw SQLSTATE (`friendlyLoanError` and the `toPublicError` discipline);
- the funding-account parameter is validated and rejected safely when absent,
  malformed or not visible to the actor;
- rate limiting still applies to disbursement (`lib/loans/actions.ts:431`);
- `revalidatePath` covers the finance, loan, savings and benefit routes a
  clearance changes;
- `audit:money` passes over any new TypeScript that touches money.

### 8.3 Browser (Playwright, `tests/e2e/specs/`)

- `bank-deposits.write.spec.ts` — record a deposit, see it as uncleared and
  excluded from available funds, verify it as a **second** user (two
  `storageState`s), and confirm the first user's verify attempt is refused with
  a legible message;
- `cash-sufficiency.write.spec.ts` — the disbursement form shows the funding
  account and its **available** balance, blocks submit when short (the
  `transfer-form.tsx:70` hint re-pointed at available), and the server still
  refuses when the form is bypassed; the same for the withdrawal payout and
  benefit payment screens;
- after a refusal, a reload shows no partial state anywhere;
- the finance screen distinguishes booked, in transit and available, and no
  screen presents an aggregated "total liquidity" as spendable (D12);
- accessibility pass on the new screens with `@axe-core/playwright`, already
  wired into the harness.

### 8.4 Gates to re-run

`npm run verify` (typecheck · lint · format · unit+integration · build),
`npm run test:db` (all ten projects), `npm run audit:money`, the database
security gate, the financial certification at the new migration count, the
historical migration replay, and the new-head required CI named in
`docs/POLYTOS-SECURITY-RELEASE-GATES.md`.

---

## 9. Genuinely unresolved business decisions

These are questions the code cannot answer. Each needs a Product Owner ruling
before the phase that depends on it.

1. **Scope of "confirmed received" for physical cash.** Per receipt, per till
   session, or at the end-of-day count? And *who* confirms — the cashier who
   took the money (self-confirmation is not a control) or a second person? Today
   a cash repayment is spendable the instant it is typed; per-receipt
   confirmation by a second person is the strongest reading of rule 4 and the
   heaviest at the counter. **Recommendation:** per-receipt confirmation with a
   batch-confirm action for throughput, and a stated position on
   self-confirmation.
2. **Does rule 1 apply beyond the three named paths?** Expenses, outbound
   transfers, meeting-fine refunds and — if the stack lands — agency
   withdrawals and float trades all take money out of a till.
   **Recommendation: yes, all of them, one rule.** Two sufficiency rules in one
   ledger is how the Phase 4B-S claim came to be too broad.
3. **MTN and Airtel.** Rule 5 names bank deposits. The same
   "the network says it happened; the statement decides" argument applies to
   wallet inflows. Are mobile-money receipts pending until the float is
   reconciled, or confirmed on arrival?
4. **Does `allow_negative_cash` survive, and may it override availability?**
   **Recommendation: it must not.** Keep it as a booked-overdraft escape hatch
   only, and make availability unconditional — otherwise Decision A is one
   Owner checkbox away from being off.
5. **Per account only, or also per branch?** Rule 2 says accounts are
   independently controlled, which implies strictly per account. Confirm that no
   branch-level aggregate limit is intended.
6. **Clearance dating.** Is `cleared_on` the bank's value date (which may
   precede the verification date)? How far may it be back-dated, and may it fall
   in a closed reporting period?
7. **Partial clearance.** May the bank credit 800,000 of a 1,000,000 deposit?
   Every document in the system today is all-or-nothing.
   **Recommendation:** refuse partials in v1; handle a short credit as a
   clearance for the actual amount plus an explained variance to
   `5950 Cash Over and Short`, or as reject-and-re-record.
8. **A deposit that bounces.** Does the money return to the till — where it
   physically is not — or become a loss requiring an explanation and an
   explicit journal? Needs an Owner rule, not a code decision.
9. **Who may reverse a verified clearance, and may the verifier reverse their
   own verification?** The system has no precedent either way.
10. **What else does a pending receipt stop counting for?** Loan clearance
    status, savings qualification and contribution months, member-loan capacity,
    benefit eligibility gates, low-float notifications, the dashboard liquidity
    cards and every Financial report. Rule 8 speaks only about payouts.
    **Recommendation:** a pending receipt still satisfies the borrower's
    installment on the day it was taken — the borrower paid; it is the
    *company's* cash that is restricted — but this must be ruled on explicitly,
    because the opposite reading silently changes arrears for every borrower.
11. **Should refused payouts be recorded?** Rule 10 forbids a journal, not a
    log. But a log row written inside the refused transaction rolls back with
    it, so recording refusals needs an out-of-band mechanism. Is that wanted?
12. **Branch-scoped ledger reads (D11).** Closing it is nearly free today
    (every profile is unrestricted) and changes who sees what the moment anyone
    is assigned a branch. In or out of Decision A's scope?
13. **Vocabulary.** `cleared` is taken by loans (D14). Confirm the funds
    vocabulary — the proposal uses *submitted / in transit / cleared* for
    deposits and *pending / confirmed* for cash, with `cleared` on a deposit
    never appearing on a loan.

---

## 10. Recommended implementation phases and release dependencies

### 10.1 Dependencies

**Hard dependency: PR #25.** Decision A's enforcement is unsafe without
`lock_ledger_balances` and the `post_journal` lock. The chain is
`#19/#20 → #21 → #22 → #23 → #24 → #25`, with `#26` and `#27` stacked above
`#25`'s base:

| PR | Branch | Migrations | Role for Decision A |
| --- | --- | --- | --- |
| #25 | `fix/shared-till-concurrency-2026-11-08` | 194 | **The foundation.** Locking + the escalated open decision |
| #26 | `phase4d/agency-banking-interface-2026-11-08` | 198 | Draft. **Preserve untouched** |
| #27 | `phase4e/mobile-money-2026-11-09` | 214 | Draft. **Preserve untouched** |
| — | audited base `64ea09c` | 161 | No locking; do not build here |

Decision A should branch from **PR #25's head** (or a head that contains it),
and must not be rebased beneath #26/#27 without re-running their suites. PR
#25's own integration note recommends it land before Phase 4D, and observes
that it applies cleanly either way.

**Also blocking any production step:** the independent NO-GO blockers in
`docs/POLYTOS-SECURITY-RELEASE-GATES.md:274`, including the Git-linked Supabase
branch reporting `MIGRATIONS_FAILED`.

### 10.2 Phases

| Phase | Content | Depends on | Release characteristic |
| --- | --- | --- | --- |
| **A0** | This audit; PO rulings on §9.1, §9.2, §9.4, §9.10, §9.13 | — | Document only |
| **A1** | Availability primitives, **no enforcement**: `cash_receipt_confirmations`, `is_spendable`, `cash_account_available_balance`, `assert_cash_funds_available`, `cash_account_availability`, extended `branch_cash_position`. ADR superseding `20261020000400`'s settlement-status note | PR #25 | **Zero behaviour change.** Availability ≡ booked because no confirmation row exists |
| **A2** | **Enforcement on the three payout paths**, plus the funding-account parameter on `disburse_loan` (D4) and its UI | A1, §9.2 | First behaviour change. Closes the escalated finding |
| **A3** | Bank deposits and clearance verification: `1050`, `bank_deposits`, the four functions, maker-checker at both layers, evidence, register, notification | A1, A2, §9.6–§9.9 | Closes rules 5, 6, 7 |
| **A4** | Physical-cash confirmation: pending-at-birth for receipts, the confirm action, batch confirmation | A1, A2, §9.1, §9.3, §9.10 | Closes rules 4, 8. **Highest operational impact** |
| **A5** | Branch and RLS closure: `user_can_see_branch` on the finance write paths (D10), branch predicate on the ledger read policies (D11), per-bank-account presentation (D12) | A1, §9.12 | Nil blast radius today; grows with every branch assignment |
| **A6** | Reporting and UI: booked / in transit / available everywhere, uncleared-deposit ageing, the form hints re-pointed at available (D16) | A1–A5 | Read-only |
| **A7** | Certification: full gate sweep, financial certification at the new count, historical replay, release-gate update | all | **Production stays NO-GO** until the independent blockers clear |

### 10.3 Ordering rationale

A1 before A2 so enforcement is switched on against primitives already proven
green. A2 early rather than late, because it closes the live overdraft; A3 and
A4 after it, because a payout refusal with no clearance workflow yet is
operationally inconvenient but *financially safe*, whereas a clearance workflow
with no enforcement is paperwork that stops nothing. If the PO prefers A4 before
A2 to spare the counter, that is defensible — it simply leaves the overdraft
open for longer, and the trade-off should be made explicitly rather than by
sequencing.

A5 is separable and could ship at any point after A1; it is grouped here
because Decision A's rules 2 and 3 are not truly enforceable while a
`transfers:create` holder can move another branch's cash.

---

## Appendix — audit scope and method

**Read:** all 161 migrations on the audited revision, by targeted reading of
every function that posts a journal or decides a balance; `docs/LEDGER.md`,
`docs/DECISIONS.md` (ADR-001…071), `docs/DELIVERY.md`,
`docs/POLYTOS-SECURITY-RELEASE-GATES.md`; `lib/finance/`, `lib/savings/`,
`lib/benefits/`, `lib/loans/`, `lib/data/finance.ts`, `lib/settings/`;
`components/finance/`; `app/(app)/finance/`; `tests/db/` (84 suites),
`tests/e2e/specs/` (32 specs); `playwright.config.ts`, `vitest.config.mts`,
`package.json`, `scripts/`. Read-only on the PR stack: PRs #19–#27 metadata,
`20261109000100_ledger_balance_serialization.sql`,
`20261112000100_shared_till_account_locking.sql`,
`20261108000300_agency_lifecycle.sql`, `20261110000400_agency_reconciliation.sql`,
`20261113000200_agency_verification_revision.sql`,
`20261107000500_agency_settlement_and_reconciliation.sql`, and
`docs/POLYTOS-SHARED-TILL-CLOSURE-REPORT.md`.

**Not done:** no implementation, no change to any financial posting function, no
migration applied, no database touched, no PR created, merged, rebased or
retargeted, no deployment, no hosted record modified. Branches `#26` and `#27`
were fetched read-only and are unmodified.

**Next step:** independent review of this audit and Product Owner rulings on
§9, after which phase A1 may be planned. **Production remains NO-GO.**
