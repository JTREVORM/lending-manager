# POLYTOS — Phase 4C Architecture Reconciliation

**Purpose:** reconcile Architecture v3.0 (`docs/AGENCY-BANKING-ARCHITECTURE.md`) against
the implementation as it actually stands at the reviewed 4B-S head
`1d30d5d`, **before** any Phase 4C SQL is written.
**Base:** 186 migrations. Branch `phase4c/agency-settlement-reconciliation-2026-11-07`,
cut from `1d30d5d`.

Every deviation below is a change Phase 4C must make, or a specification
statement that no longer matches the built system. Each is recorded with what
the specification says, what is actually there, and what Phase 4C will do.

---

## Part A — What the specification got right and 4A/4B built as described

These need no deviation and are listed so the reconciliation is a complete
account rather than a list of problems.

| Spec | Built | Status |
| --- | --- | --- |
| §5.6 `agency_commission_settlements` | exists, 11 columns | as specified |
| §5.7 `agency_payable_settlements` | exists, with full reversal columns and CHECKs | as specified |
| §5.8 `agency_float_reconciliations` | exists | partially — see **D3** |
| §5.9 `agency_cash_reconciliations` | exists | partially — see **D4** |
| §3 accounts 1310, 2210, 2220, 4510, 5950, 5960 | all present and postable | as specified |
| §6.8 commission settlement journal | `agency_commission_outstanding()` already nets accruals against settlements, per provider **and** branch, attributed by source | better than specified |
| §6.9 payable settlement journal | `agency_payable_outstanding()` from 4B-S attributes per provider | as specified, hardened |
| §8.5 note: do not use `record_transfer()` | `assert_cash_account()` refuses `agency_float`, and 2210/2220 have `cash_kind IS NULL`, so the generic path cannot reach either | enforced by the database, not just by convention |
| Append-only | all four tables carry a `no_delete` guard | as specified |

`agency_commission_outstanding(provider, branch)` and
`agency_payable_outstanding(provider, branch)` both already exist, are
`SECURITY DEFINER` with `search_path = ''`, revoked from
`public, anon, authenticated`, and attribute by **source entity** rather than
by account — because 1310, 2210 and 2220 are each shared across providers.
Phase 4C reuses them rather than recomputing balances.

---

## Part B — Deviations Phase 4C must resolve

### D1 — The agency audit log cannot carry a settlement, replenishment or reconciliation event

**Specification:** §5.10 presents `agency_transaction_audit_log` as the agency
audit trail, and Phase 4C's brief requires every money movement to be recorded
in "the appropriate agency financial audit trail".

**Actually built:** `transaction_id` is `NOT NULL` with
`REFERENCES agency_transactions(id) ON DELETE RESTRICT`, and
`agency_audit_action_valid` allows only the seven transaction-lifecycle
actions. A settlement, a float top-up and a reconciliation are **not**
transactions and have no transaction id.

**Phase 4C will:** write settlement, replenishment and reconciliation evidence
to the existing generic `audit_log` through `record_audit_event()`, with
`entity_type` of `agency_commission_settlement`,
`agency_payable_settlement`, `agency_float_replenishment`,
`agency_cash_reconciliation` or `agency_float_reconciliation`, and
`entity_id` the settlement's own id.

**Phase 4C will not** make `transaction_id` nullable. That `NOT NULL` is what
guarantees every row in the agency transaction log belongs to a real
transaction; loosening it to accommodate a different kind of event would make
the column meaningless and the log unverifiable. Two trails with clear owners
beat one trail with a nullable discriminator.

### D2 — The two reconciliation tables use **opposite** variance conventions

**Specification:** §5.8 and §5.9 both call the column `variance` and §6.12
gives one write-off journal.

**Actually built —** both are `GENERATED ALWAYS`, and they are not the same
quantity:

| Table | Generated expression | A positive variance means |
| --- | --- | --- |
| `agency_cash_reconciliations` | `physical_count - system_closing_balance` | **more** physical cash than the books say — an excess |
| `agency_float_reconciliations` | `system_closing_balance - provider_statement_balance` | the **books** show more than the provider's statement — a system surplus |

So a positive number is a cash *excess* in one table and a system *overstatement*
in the other, which are opposite directions of correction. §6.12's example
(system float 1,000 above the statement → `Dr 5960, Cr float`) is consistent
with the float table's convention, and the specification never states the cash
one.

**Phase 4C will:** derive the adjustment direction **per table**, never share
one branch of logic between them, and assert both directions on exact lines:

| Case | Journal |
| --- | --- |
| Float: system above statement (variance > 0) | `Dr 5960 Agency Float Over and Short` / `Cr` the float account |
| Float: system below statement (variance < 0) | `Dr` the float account / `Cr 5960` |
| Cash: physical above books (variance > 0) | `Dr` the cash account / `Cr 5950 Cash Over and Short` |
| Cash: physical below books (variance < 0) | `Dr 5950 Cash Over and Short` / `Cr` the cash account |

The brief instructs that the existing generated variance be used, so neither
expression is changed. The risk is entirely in reading them, and it is
addressed by never writing one shared helper.

### D3 — `agency_float_reconciliations` carries neither branch nor statement evidence

**Specification:** §5.8 lists the float reconciliation by `float_account_id`.
Phase 4C's Task 6 requires provider identity, **branch identity**, till
identity and a **statement reference/evidence** to be preserved.

**Actually built:** columns are `float_account_id`, `reconciliation_date`,
`system_closing_balance`, `provider_statement_balance`, `variance`,
`variance_written_off`, `variance_journal_entry_id`, `notes`, `status`,
`reconciled_by`, `reconciled_at`, `created_by`, timestamps. There is **no**
`branch_id`, **no** `provider_id` and **no** statement reference — only a free
`notes` field, which is not evidence.

Provider and branch are reachable through
`agency_provider_float_accounts`, so nothing is lost; but a report that has to
join three tables to say which branch a variance belongs to is a report that
will eventually be written wrongly.

**Phase 4C will:** add `branch_id`, `provider_id` and `provider_statement_ref`
to the table, with a guard trigger asserting all three agree with the till's
own registration — a denormalisation that is checked, not trusted. A
reconciliation with a written-off variance will require the statement
reference, since that is the evidence for the write-off.

### D4 — Neither reconciliation table enforces maker-checker separation

**Specification:** §11.3 lists separation-of-duties tests; §5.8/§5.9 give
`created_by` and `reconciled_by` columns.

**Actually built:** both columns exist and nothing prevents them holding the
same profile. The existing CHECKs cover only completeness
(`..._closed_is_complete`, `..._open_is_clean`) and that a write-off needs an
approved status and a journal.

**Phase 4C will:** add a CHECK to each table that `reconciled_by` differs from
`created_by` whenever the row is `reconciled`, and refuse the approval in the
RPC with its own message before the constraint is reached, so the operator sees
a sentence rather than a constraint name.

### D5 — `agency_payable_settlements` has no duplicate-reference protection

**Specification:** silent.

**Actually built:** `agency_commission_settlements` has
`agency_commission_settlement_statement_unique`, a partial unique index on
`(provider_id, provider_statement_ref) WHERE provider_statement_ref IS NOT NULL`.
`agency_payable_settlements` has **no equivalent** on
`provider_receipt_ref`, so the same receipt can be recorded twice.

**Phase 4C will:** add the matching partial unique index, and the same for the
new replenishment table. Task 9 requires a duplicate-external-reference
negative test for each.

### D6 — There is no float replenishment table and no source type for it

**Specification:** §6.10 gives the journal (`Dr` float, `Cr` funding account)
but **explicitly defers the decision**: *"Use a dedicated
`post_float_replenishment()` function or extend `record_transfer()` to accept
`agency_float` — decision deferred for implementation."*

**Actually built:** neither. No table, no function, and
`journal_entries_source_valid` has no replenishment value. Its 26 values
include `agency_transaction`, `agency_transaction_reversal`,
`agency_commission_settlement`, `agency_payable_settlement` and
`agency_payable_settlement_reversal` — and nothing for a top-up.

**Phase 4C will:** resolve the deferred decision the way the brief directs — a
dedicated `post_float_replenishment()`, with `record_transfer()` left alone —
and add an `agency_float_replenishments` table plus an
`agency_float_replenishment` source type. Extending `record_transfer()` is
rejected for the reason 4B-S already demonstrated: the generic money-movement
path is shared with lending, and widening it to reach agency float would put
every lending caller one argument away from an agency account.

### D7 — A commission settlement cannot be corrected, and that blocks historical reversals

**Specification:** silent. §8.4 records a settlement and never revisits it.

**Actually built:** an asymmetry. `agency_payable_settlements` has `status`,
`reversed_at`, `reversed_by`, `reversal_reason`, `reversal_entry_id`, a
`status_valid` CHECK and an `agency_payable_settlement_reversal` source type.
`agency_commission_settlements` has **none of these** — no status, no reversal
columns, no reversal source type.

This matters beyond tidiness. Phase 4B refuses to reverse a transaction whose
deferred commission has been settled. With no way to correct a settlement, a
settlement recorded in error **permanently** blocks the reversal of an
otherwise valid historical transaction.

**Phase 4C will:** add `status`, `corrected_at`, `corrected_by`,
`correction_reason` and `correction_entry_id` to
`agency_commission_settlements`, plus an
`agency_commission_settlement_correction` source type, and post a **contra
entry** rather than deleting or mutating the original. A corrected settlement
then releases the transaction for reversal.

**Phase 4C must also** extend `agency_commission_outstanding()` to recognise
the new source type. It currently nets accruals against
`agency_commission_settlement` entries only; a correction that posts a contra
and is not counted would leave the receivable understated, which is exactly
the silent negative receivable Task 7 forbids. This dependency is the reason
D7 cannot be implemented as a table change alone.

### D8 — §8.4's receivable computation is looser than what exists

**Specification:** §8.4 step 3 — *"Compute outstanding receivable balance for
provider (from 1310 filtered by provider_id in source transactions)"* — says
nothing about branch.

**Actually built:** `agency_commission_outstanding(p_provider_id, p_branch_id)`
is already scoped to both, by `e.branch_id = p_branch_id`.

**Phase 4C will:** keep the per-provider **and** per-branch scope, consistent
with decision N recorded in 4B-S for the payable. One branch must not settle
against another branch's receivable, for the same reason one bank's collections
must not fund another's withdrawal.

### D9 — §8.5's "cash account" test is necessary but not sufficient

**Specification:** §8.5 step 3 — check `cash_kind IS NOT NULL` on the
settlement account.

**Actually built:** `assert_cash_account()` was hardened in Phase 4A to refuse
`agency_float` as well, so that test already rejects more than the
specification asks. But `cash_kind IS NOT NULL` still admits `bank`,
`cash_at_hand` and the mobile-money wallets — and Task 3 asks for "Cash at Hand
or another **explicitly approved** settlement account".

**Phase 4C will:** require the settlement account to be a **branch-held** cash
account belonging to the settling branch (`cash_at_hand` or `bank`), refuse
`agency_float` and refuse the ordinary mobile-money repayment wallets, so that
remitting a school's fees cannot be booked against a lending repayment wallet.
Task 4 asks for the same assurance on the funding side of a replenishment.

### D10 — The specification's §10 views predate branch scoping

**Specification:** §10 gives three views — `agency_float_balances`,
`agency_commission_report`, `agency_transaction_history`.

**Actually built:** no agency views exist at all yet.

**Phase 4C will:** build the seven views the brief lists, which supersede §10's
three, every one `security_invoker` so the caller's own RLS applies rather than
the view owner's. A borrower must read none of them and a branch must read only
its own.

---

## Part C — Decisions this phase inherits and does not reopen

- **No advance.** The bank agency payable floor stays absolute. A payable
  settlement reduces a liability and so cannot breach it, but the floor is
  re-asserted on the settlement path too, because a settlement that overshot
  the outstanding balance would create the same net debit by a different route.
- **Per provider and per branch** attribution for both 1310 and the 2200
  series. Decision **N** remains open as recorded in 4B-S; Phase 4C follows the
  narrow reading consistently rather than settling it.
- **Providers stay provisional and inactive.** Nothing in Phase 4C activates
  one, and no rate, limit or threshold is invented.
- **Locking.** Every balance read that a decision depends on takes
  `lock_ledger_balances()` first, sorted, exactly as 4B-S established. Phase 4C
  adds a provider-and-branch dimension to this and must do so **without**
  introducing a second lock ordering, or two call paths could deadlock against
  each other.

## Part D — Deviation summary

| # | Deviation | Resolution |
| --- | --- | --- |
| D1 | Agency audit log cannot carry settlement events | use generic `audit_log`; do not loosen the FK |
| D2 | Opposite variance conventions in the two tables | derive direction per table, assert all four |
| D3 | Float reconciliation lacks branch, provider, statement ref | add all three, guarded |
| D4 | No maker-checker constraint | add CHECK + an RPC refusal |
| D5 | No duplicate-ref index on payable settlements | add it, and on replenishments |
| D6 | No replenishment table, function or source type | add all three; leave `record_transfer()` alone |
| D7 | No commission settlement correction | add contra-entry correction + extend the outstanding function |
| D8 | §8.4 omits branch from the receivable | keep per-branch scope |
| D9 | `cash_kind IS NOT NULL` admits too much | require a branch-held cash account of the settling branch |
| D10 | §10's three views predate branch scoping | build seven `security_invoker` views |
