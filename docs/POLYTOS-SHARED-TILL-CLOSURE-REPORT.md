# POLYTOS — Shared Cash at Hand Closure Report

**Workstream:** A, the cross-module risk Phase 4C-S recorded and did not close.
**Branch:** `fix/shared-till-concurrency-2026-11-08`, cut from the Phase 4C head.
**Scope:** synchronisation only. No business rule, accounting direction,
allocation, schedule, permission, reversal or audit behaviour changes.
**Authorization:** draft only. No merge, no deployment, production untouched.
**Migrations:** 194 (one new).

---

## 1. The risk

A branch Cash at Hand account is shared between agency work and lending, and
`approve_agency_cash_reconciliation()` counts the **whole** till. Phase 4C-S
made the agency paths lock that account in either direction and recorded, as
an open risk, that the lending paths did not — so a certified cash count could
be measured against a balance a loan repayment had already changed.

## 2. A1 — the audit

Twenty-nine functions post a journal. **Sixteen took no account lock at all.**
Reading the seeded book for which source types actually move a `cash_at_hand`
account:

| Source type | Direction | Entry point | Lock before |
| --- | --- | --- | --- |
| `loan_repayment` | **in** (123 lines) | `post_payment` → `post_repayment_journal` | **none** |
| `savings_deposit` | **in** (39) | `post_savings_deposit` | **none** |
| `membership_fee` | **in** (8) | `record_membership_fee` | **none** |
| `loan_disbursement` | **out** (12) | `disburse_loan` → `post_disbursement_journal` | **none** |
| `benefit_payment` | **out** (1) | `post_benefit_payment` | **none** |
| `savings_withdrawal` | **out** (1) | `post_savings_withdrawal` | **none** |
| `savings_deposit_reversal` | **out** (1) | `reverse_savings_transaction` | **none** |
| `transfer`, `transfer_reversal` | both | `post_transfer_journal`, `reverse_transfer` | **source only** |
| `expense`, `other_income_reversal` | out | via `assert_cash_available` | yes |
| `other_income` | **in** | `record_other_income` | **none** |
| `reconciliation_adjustment` (lending) | both | `submit_reconciliation` → `approve_reconciliation` | **none** |
| `agency_*` | both | the Phase 4C paths | yes, since 4C-S |

Not one lending path locked the till, **in either direction**. No caller
supplied the lock either: `post_payment`, `disburse_loan` and
`submit_reconciliation` all take none. The four paths that did lock got it only
as a side effect of `assert_cash_available()`, which locks the single account
it checks — and since sufficiency is only ever checked on the balance being
drawn **down**, every account an entry credited went unlocked.

`post_savings_withdrawal` is worth naming separately: it *does* lock, but it
locks the **savings account row** and the savings capacity — the member's
balance, not the branch till. A path can be carefully synchronised on its own
domain resource and still be unsynchronised on a shared one.

### A correction to Phase 4B-S

Phase 4B-S stated that `record_transfer`, `record_expense`,
`record_other_income` and `submit_reconciliation` all gained till protection
from the shared sufficiency helper. That was true only of the paths that draw
down. `record_other_income` credits a till and never calls the helper; neither
does the lending reconciliation's approval. **The claim was too broad**, and it
was the same blind spot — reasoning about money-out and generalising to money.

## 3. A2 — reproduction

All six reproductions failed against the pre-fix code, including the headline
case:

```
a repayment posted into the till while its count was being certified
a loan repayment credited a till whose balance lock was held by another session
other income credited a till whose balance lock was held
```

### Why these assert locks, not outcomes

`post_journal()` calls `next_reference('journal')`, whose counter row lock
serialises **every** posting in the system until commit. Two sessions that both
post therefore appear ordered whatever their locking — which is exactly how the
Phase 4C payable race passed on one run and failed on another with identical
code.

Each reproduction therefore holds **only** the account's advisory lock,
posting nothing and taking no reference, and asks whether a lending path walks
straight past it. No journal-reference serialisation can make that pass. The
helper also distinguishes *refused* from *walked past*: a path that failed for
an unrelated reason never reached the lock, and reporting that as a
concurrency defect would be wrong — a distinction that caught two of my own
fixture errors (a cash payment may not carry a network reference; a client may
hold only one active loan).

## 4. A3 — the correction

**The lock goes inside `post_journal()`** — the single writer of every journal
line in the system:

```sql
perform public.lock_ledger_balances(array(
  select (l ->> 'account_id')::uuid
    from pg_catalog.jsonb_array_elements(p_lines) l
    join public.ledger_accounts a on a.id = (l ->> 'account_id')::uuid
   where a.cash_kind is not null
));
```

One function instead of fourteen, covering every posting path by construction —
including paths added later, which a list of functions cannot promise. Taken
before the reference counter, so the global order every poster follows is:
provider lock (where one applies) → account locks → counter.

**And the deadlock the fix would otherwise have introduced.** A transfer debits
one cash account and credits another, and locked only the source. Once
`post_journal()` locks every cash account in the entry, a caller holding just
the source holds an **out-of-order subset**: two opposing transfers could each
hold one account and wait for the other. Sorted acquisition only prevents a
deadlock when every holder acquires in sorted order from the start. Both
transfer paths now take both locks up front, sorted, before the sufficiency
check.

### Deliberately not done

`disburse_loan`, `post_benefit_payment` and `post_savings_withdrawal` do **not
check that the till holds the money**. Two concurrent disbursements can
overdraw it, and that is now ordered rather than prevented. This is a real
finding and it is reported rather than fixed: adding the check is a new
business rule, and this correction is authorised to add synchronisation only.
**Recorded as an open decision for the Product Owner.**

## 5. A4 — certification

| Gate | Result |
| --- | --- |
| `shared-till-concurrency.test.ts` (new) | **PASS — 6/6** |
| `npm run test:db` (ten projects) | **PASS — 2,229** |
| Financial certification at 194 migrations | **PASS — 36 pass, 2 explained, 0 vacuous, 0 fail** |
| Historical migration replay | **PASS — 122 existing + 72 new, 28 figures identical** |
| Database security gate | **PASS** |
| Money audit | **PASS — 240 files** |
| typecheck · lint · format | **PASS** |

<!-- A_CI -->

No previous test was removed or weakened. The lending suites — payments,
allocation, schedules, delinquency, savings, membership, benefits — all pass
unchanged, which is the evidence that this is synchronisation and not a
behavioural change.

## 6. Integration order

This PR and the Phase 4D interface PR are independent and both branch from the
Phase 4C head. Recommended order:

1. **This PR first.** It is a correctness fix to the ledger writer, it is small,
   and Phase 4D's reconciliation screens exercise the very paths it protects.
2. Phase 4D second, rebased onto it.

If Phase 4D lands first, this fix applies cleanly regardless: it touches
`post_journal` and the two transfer functions, none of which Phase 4D changes.

## 7. Open items

- **The missing till sufficiency check** on the three lending cash-out paths
  (section 4). Needs a Product Owner decision, not a code decision.
- **Decision L** and the Phase 4A decisions remain open, untouched here.
