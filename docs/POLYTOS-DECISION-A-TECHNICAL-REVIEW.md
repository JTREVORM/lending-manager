# POLYTOS — Decision A Technical Review Report

**Gate:** technical review. **Verdict: CHANGES REQUIRED before development authorization.**
**Type:** documentation only. No migration, no application code, no test change,
no PR created or merged, no hosted data touched. PRs #19–#27 untouched.
**Reviewed at:** PR #27 head (`phase4e/mobile-money-2026-11-09`, 214 migrations),
against PR #25 (194) and the audited base `64ea09c` (161).
**Finalized plan:** `docs/POLYTOS-DECISION-A-IMPLEMENTATION-PLAN.md`.
**Production:** NO-GO.

---

## 1. One input I do not have

**I could not find the implementation plan you prepared.** It is not in the
working tree, not on any of the 30 remote branches, not in a pull request
(#19–#27 are the only open ones and all are Agency Banking or security work),
not in an issue (the repository has none), and not in a comment on #25. Nothing
was attached to the brief.

So this is **not** a line-by-line review of your document. It is a review of the
approved decision set and the design it implies, against the codebase — which is
where every finding below comes from. Each finding is a fact about the code,
independent of how your draft words things, so all of them apply to it; what I
cannot tell you is which ones your draft already handles.

**Send me the plan and I will do the diff pass**, which is cheap once the
findings exist. The two documents I have written stand on their own in the
meantime: §1 of the plan records how I read A-1…A-13, and four rulings I could
not infer are flagged there for confirmation.

---

## 2. Findings

Severity-ordered. **B** = blocker for authorization, **H** = high, **M** = medium.

### B1 — Five outgoing financial paths are missing from the known inventory

A-2 is universal enforcement. PR #25 reported **three** unchecked cash-out paths;
there are **eight**. A plan scoped to "the three payout paths" leaves five open.

| Path | Credits a cash account | In PR #25's list |
| --- | --- | --- |
| `post_disbursement_journal` | branch till | yes |
| `post_savings_withdrawal` | branch cash by method | yes |
| `post_benefit_payment` | branch cash by method | yes |
| **`post_reversal_journal`** (`reverse_payment`) | `'credit', r.amount` on `branch_cash_account(...)` | **no** |
| **`reverse_savings_transaction`** (deposit reversal) | `'credit', v_original.amount` on `cash_account_id` | locking only |
| **`reverse_membership_fee`** | `'credit', v_receipt.amount` on `receiving_account_id` | **no** |
| **`reverse_meeting_fine_payment`** | `'credit', v_payment.amount` on `cash_account_id` | **no** |
| **`approve_reconciliation`** (lending, shortage) | `'credit', -r.variance` on `r.account_id` | locking only |

**Why PR #25 under-counted, and it is not carelessness.** Its table was built
"reading the seeded book for which source types actually move a `cash_at_hand`
account". A membership-fee refund, a meeting-fine refund and a lending shortage
write-off were not in the seeded data, so they were not in the table. Its *fix*
is nonetheless complete, because the lock went inside `post_journal` and covers
every path by construction — which is the strongest argument for putting
Decision A's enforcement somewhere equally structural rather than in a list.

**Recommended change:** enumerate all eight explicitly, with a test per path.
Plan §3 and §12.1.

### B2 — A new `in_transit` cash kind breaks two certified identities and three suites

`branch_cash_position.total_liquidity` is `sum(balance) where cash_kind is not
null`. Two certified identities in
`scripts/certify-financial-reconciliation.mjs` depend on it:

- `hand + bank + mtn + airtel + agency float` = `total_liquidity`
- `total_liquidity` = `GL accounts with a cash_kind`

This is not hypothetical. `20261107000900`'s header records it happening when
Phase 4A added the fifth kind: the total exceeded its own parts and
`money-movement.test.ts`, `ledger-posting.test.ts` and the reconciliation
harness all failed.

**This corrects my own gap analysis.** D12 and §4.3 of
`POLYTOS-DECISION-A-GAP-ANALYSIS.md` said in-transit money must **not** be
folded into `total_liquidity`. That is wrong: the second identity requires that
every cash-kinded account appear in it, and on the merits money in transit is an
asset the business holds. The figure that must exclude it is **available** funds,
which is a different number needing its own columns. D12's real content is a
*UI* finding — a screen must not present liquidity as spendable — not a reason
to redefine the view.

**Recommended change:** `in_transit` becomes a named component **inside**
`total_liquidity`, in the same migration that adds the kind; availability gets
separate columns; the certification script's sum identity is extended. Plan
§6.1, §14.

### B3 — Adding `in_transit` without hardening `assert_cash_account` makes the whole clearance control bypassable

`assert_cash_account` tests only `cash_kind is null`. The moment `in_transit` is
a legal kind, a Cash in Transit account becomes a legal `record_transfer`
endpoint — and `record_transfer` gates on `transfers:create`, which
`secretary_treasurer` holds.

So a cashier could move money straight out of Cash in Transit into a bank
account with **no clearance, no verifier, no evidence, no Owner, no deposit
record**, posting `source_type = 'transfer'` so it never appears in the deposit
register, under `allow_negative_cash`. The maker-checker Decision A is built to
impose would be bypassable by one unrelated capability.

This is precisely the bypass Phase 4A identified and closed for `agency_float`,
**in the same migration that added the kind**, with the note: *"The two are
inseparable: either without the other is a defect."*

**Recommended change:** the hardening ships in the same indivisible migration as
the kind, the view component and the uniqueness index. Plan §6.1, §10.2 step 2.

### B4 — Receipt confirmation must not touch `loan_payments`; A-10 depends on it

A-10 forbids double-posting loan repayments. Two things in the schema make the
design single-valued:

1. **`loan_payments_guard_mutation`** (`20261006000500`) permits exactly one
   status transition, `posted → reversed`, with three companion columns, and
   refuses every other column change *"by anybody — including the table owner
   and `service_role`"*. A confirmation status or column on `loan_payments`
   would be refused outright.
2. **`loan_balances`, `loan_installment_coverage` and
   `payment_collection_totals` all filter `lp.status = 'posted'`.** If
   confirmation gated that status, every borrower's arrears, installment
   coverage, delinquency state and loan clearance would change — because the
   business had not yet counted its drawer.

A third tempting design — post the receipt to a holding account and transfer it
to the till on confirmation — double-posts (two journals per receipt) *and*
misstates where the cash physically is, so the daily count stops agreeing with
the till.

**Recommended change:** one journal at receipt into the real cash account, plus
a separate restriction record keyed to the journal entry. `post_payment`,
`post_savings_deposit`, `record_membership_fee`, `post_meeting_fine_payment` and
`record_other_income` are unchanged. Plan §7, with a named regression suite
asserting the loan figures are bit-identical.

### B5 — Refusal-audit logging cannot be done inside the database

Rule 10 requires a refused payout to move nothing, which it achieves by
aborting the transaction — and the abort takes any log row with it. The
in-database answer would be an autonomous transaction, and this deployment has
no mechanism for one: the only installed extension is `pg_trgm`. No `dblink`, no
`pg_background`, no `pg_cron`.

**Recommended change:** A-11 is an application-layer, post-rollback, best-effort
write through a dedicated definer RPC, with four stated properties — it can
write nothing financial; its output is never an input to any authorization,
sufficiency, approval or clearance decision; a logging failure never converts a
refusal into a success; and it is not a side channel (actor from the session,
no probe-able foreign keys, capability-gated reads, rate-limited writes). Plan
§9. If the plan instead proposes an in-database trigger or an exception handler
that writes before re-raising, that will either roll back with the refusal or —
if it suppresses the raise — breach rule 10.

### H1 — `payment_method` does not identify a funding account

`branch_cash_account(branch, kind)` resolves `order by a.code limit 1`, and
`ledger_accounts_one_wallet_per_branch` **deliberately excludes `bank`** so a
branch may hold several bank accounts. So `payment_method = 'bank'` silently
pays from, and receives into, the alphabetically lowest-coded bank account.

Rule 1's "selected funding account" and rule 2's "every bank account
independently controlled" are therefore unmet on the **withdrawal and benefit
paths too**, not only disbursement — and receipts land in an arbitrary bank
account as well. This is the same defect class the Phase 4E operating-branch
migration fixed for branches, where a branch was *"chosen by a string
comparison"*.

**Recommended change:** an explicit account argument on all three payout paths.
Plan §5.2, confirmation §15.8.

### H2 — Signature changes must DROP then CREATE

Adding `p_funding_account_id` with a default creates an **overload**, and
PostgreSQL then refuses every call as ambiguous. The codebase has hit this twice
and recorded the remedy: *"the old signature is dropped and the new one
created, as `20261115000500` did for the fee mode."*

Good news for the blast radius: there are **no internal database callers** of
`disburse_loan`, `post_savings_withdrawal` or `post_benefit_payment`. The
affected surface is `lib/loans/actions.ts:440`, `lib/savings/actions.ts:423`,
`lib/benefits/actions.ts:1273`, `types/database.types.ts` and the ADR-070 column
test. Each DROP needs its `revoke`/`grant` pair restated in the same migration.

### H3 — Head Office branch selection already exists; reuse it, and depend on #27

`20261115001500_agency_operating_branch.sql` (PR #27) already settles A-12's
branch-selection half, and records why guessing is worse than refusing:
`create_agency_transaction` fell back to the alphabetically first active branch,
which was right by accident with one branch and misrouted five counter tests the
moment a second existed. Head Office is exactly the affected officer — the Owner
and the Secretary both carry `profiles.branch_id = null`.

The ruling in code: *a branch-less officer names the operating branch, a
branch-assigned officer records at their own and may name no other, the branch is
validated against what the officer may see, and it must be open.*

**Recommended change:** call that rule rather than writing a second one — two
rules for one question is the pattern this codebase repeatedly refuses. And
therefore **branch Decision A from PR #27's head, not #25's**: #25 has the
locking but not this rule. Plan §8.1, §10.1.

### H4 — `allow_negative_cash` must not govern availability

Phase 4A's correction C4 established the precedent exactly:
`allow_negative_agency_float` is a separate column read only by the float
assertion, *"so relaxing the cash rule cannot relax the float rule."*

Without the same separation, one Owner checkbox disables A-1 through A-10.

**Recommended change:** `assert_cash_funds_available` reads its own column and
never `allow_negative_cash`. Plan §4.4, confirmation §15.2.

### H5 — The lending reconciliation path contradicts its agency twin

`approve_agency_cash_reconciliation` calls `lock_ledger_balances` and
`assert_cash_available(r.cash_account_id, -r.variance)`. The lending
`approve_reconciliation` does neither, though it posts the same shortage
write-off against the same shared till. One question, two answers.

**Recommended change:** bring the lending path up to the agency path. It is
safe: after a write-off the account equals the physical count, which
`counted_balance >= 0` already keeps non-negative, so the assert acts as a
staleness guard rather than a blocker. Plan §3 path 8, §5.3.4.

### H6 — "Every outgoing path" contains a genuine contradiction: reversal versus correction

Paths 4–7 credit cash for two incompatible reasons:

- a **refund** — money genuinely leaves; sufficiency must apply;
- a **correction** — the original credit was wrong, so the money was never
  there; refusing the contra entry leaves the books permanently wrong.

Enforcing is the consistent choice: `reverse_transfer`, `reverse_other_income`
and `reverse_agency_transaction` all already assert on the account that must
give the money up. But enforcing alone means a mis-keyed receipt cannot be
corrected once the till has been emptied.

**Recommended change:** enforce on all eight, and add an Owner-only
`finance:correction` override with a mandatory reason, audited and notified,
accepted on paths 4–7 and **refused outright** on paths 1–3 and the two new
deposit paths, where no correction semantics exist. Leaving five paths unchecked
instead is the one option that satisfies neither A-2 nor the correction case.
Plan §5.3, confirmation §15.5.

### M1 — A bounced deposit needs a defined money location and a loss account

Physically the cash left the till and the bank refused it: it is in none of the
three places. The investigation must therefore **post nothing** and hold the
money in `1050` until an outcome is decided, with three distinct postings for
`recovered`, `returned_to_till` and `written_off`.

The write-off needs a chart decision. `5950 Cash Over and Short` is for count
variances; reusing it merges two different facts in one account — the error the
separate `4320`/`4340` fee codes exist to avoid. Plan §6.4 proposes
**`5960 Deposit Losses Under Investigation`**. Confirmation §15.6.

### M2 — `in_transit` uniqueness

One per branch must be added to `ledger_accounts_one_wallet_per_branch` or its
own partial unique index, or `branch_cash_account(branch, 'in_transit')` repeats
H1's arbitrary pick. (`agency_float` is excluded from that index deliberately,
because a branch may hold several float tills; in-transit is not like that.)

### M3 — Constraint names must be queried, not transcribed

Four new `source_type` values and a widened `cash_kind` both require
drop-and-recreate of a CHECK constraint. Phase 4A found that the architecture
specification named both constraints wrongly — `ledger_accounts_cash_kind_check`
and `journal_entries_source_type_check`, neither of which exists — and *"taken
literally the specification's DDL aborts"*. Query the live names first; repeat
every existing value verbatim.

### M4 — Transition states the plan must name

Currently undefined, and each needs a sentence: a deposit left `submitted` when
its branch is closed; a clearance verified into a closed reporting period
(A-6); a bounced deposit whose till has since been reconciled; a receipt
reversed before confirmation (plan §7 voids its pending row); a confirmation
outstanding when the member's loan is cleared. **Cutover itself is clean** — no
deposits exist and no confirmation rows exist, which is the design property, not
luck.

### M5 — Test gaps

A plan scoped to three paths yields three sufficiency tests where eight are
needed; the lock-order deadlock probe over `1050` + bank is new and cannot be
borrowed; the "no confirmation row ⇒ fully available" assertion is the only
mechanical proof that history did not move; and
`scripts/certify-financial-reconciliation.mjs` must gain the `in_transit`
component or B2 lands at certification rather than at review. New concurrency
tests must hold **only** the account's advisory lock, post nothing and take no
reference — because `next_reference('journal')` serialises every posting until
commit, which is how the Phase 4C payable race passed on one run and failed on
another with identical code.

---

## 3. What I verified and found no problem with

So the review is not read as uniformly negative:

- **PRs #26 and #27 redefine none** of `post_journal`, `assert_cash_available`,
  `lock_ledger_balances`, `disburse_loan`, `post_payment`, `post_reversal_journal`,
  `post_savings_withdrawal` or `post_benefit_payment`. Decision A's changes to
  those are conflict-free against both; the stack is preserved by date ordering
  alone. (`branch_cash_position` was last redefined by `20261107000900`, so
  extend that version.)
- **PR #25's locking is the right foundation and is complete.** The lock inside
  `post_journal` covers paths its own inventory did not list, including the
  three this review adds (B1), because it is structural rather than enumerated.
  A new `in_transit` account inherits it automatically, since the lock selects
  `where a.cash_kind is not null`.
- **Atomicity needs nothing.** Single-transaction definer functions, the
  deferred balance triggers, `journal_entries_one_per_source` and the
  idempotency-key discipline already give rule 9's atomic half and rule 10
  entire, with an existing test asserting a refused transfer leaves not even a
  pending row.
- **The maker-checker template is already certified.**
  `verify_agency_transaction` plus `agency_transactions_verifier_not_submitter`
  gives both layers — a legible refusal and a constraint that cannot be
  forgotten or bypassed by `service_role`.
- **Historical preservation is achievable with no backfill at all**, by the
  design property in plan §10.3, and that is strictly better than any migration
  script.

---

## 4. Changes required before development authorization

1. Enumerate **all eight** existing outgoing paths, not three — **B1**.
2. Ship `in_transit` as one indivisible migration: the kind, the
   `branch_cash_position` component **inside** `total_liquidity`, the
   `assert_cash_account` hardening, the uniqueness index — **B2, B3, M2**.
3. Extend the certification script's sum identity in that same change — **B2, M5**.
4. Keep confirmation off `loan_payments`: one journal at receipt plus a
   restriction record, with a bit-identical-loan-figures regression suite —
   **B4**.
5. Make refusal logging application-layer and post-rollback, with the four
   stated properties — **B5**.
6. Add explicit funding-account arguments to all three payout paths, by
   DROP-then-CREATE — **H1, H2**.
7. Branch from **PR #27's head** and call the existing operating-branch rule —
   **H3**.
8. Give availability its own settings column; never read `allow_negative_cash` —
   **H4**.
9. Bring the lending reconciliation path up to its agency twin — **H5**.
10. Resolve reversal-versus-correction with an Owner-only audited override
    rather than unchecked paths — **H6**.
11. Add the bounced-deposit loss account and the three outcome postings — **M1**.
12. Query live constraint names before writing the widening DDL — **M3**.
13. Name the five transition states — **M4**.
14. Confirm the four unstated rulings and five design choices in plan §15.

---

## 5. Preserved, and not done

- **PRs #19–#27 untouched.** No branch was pushed, retargeted, rebased or
  merged; #26 and #27 were read at their current heads and are byte-identical.
  The independent security work (#19, #20) was not inspected beyond its release
  gates and is unchanged.
- **No migration written or applied; no application code, test or script
  changed; nothing deployed; no hosted Supabase data read or modified.** Two new
  documentation files on `ccr-8972366d-qcq8xz` are the whole of the change.
- **Production remains NO-GO**, with the existing blockers — including the
  Git-linked Supabase branch reporting `MIGRATIONS_FAILED` — untouched and
  independent of this work.

**Stopped at the technical review gate**, as instructed. Development is not
authorized by this document.
