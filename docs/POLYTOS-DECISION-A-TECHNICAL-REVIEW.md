# POLYTOS — Decision A Technical Review Report

**Revision:** v2, reconciled against the Product Owner's policy corrections of
2026-11-11. Supersedes v1 (commit `38a7e3d`).
**Verdict: CHANGES ACCEPTED AND APPLIED — development authorization still
withheld**, on two grounds stated in §6: one unresolved policy question that
governs a financial control, and one input I still do not have.
**Type:** documentation only. No migration, application code, test, financial
record, deployment configuration or PR branch touched.
**Reviewed at:** PR #27 head (`phase4e/mobile-money-2026-11-09`, 214 migrations),
against PR #25 (194) and the audited base `64ea09c` (161).
**Plan:** `docs/POLYTOS-DECISION-A-IMPLEMENTATION-PLAN.md` v2.
**Production:** NO-GO.

---

## 1. The two documents did not arrive

`POLYTOS_DECISION_A_IMPLEMENTATION_PLAN_REVIEW.md` and
`POLYTOS_DECISION_A_REVIEW_RESPONSE_v2.md` are not in the working tree, not on
any of the 30 remote branches, not in a pull request, not in an issue, not in
the session upload directories (`/mnt/user-data/uploads`, `working`, `outputs`
are all empty) and nowhere on the filesystem — searched by name across the whole
mounted tree. Nothing was attached. This is the second time the transfer has
failed.

**What this does and does not prevent.** It prevents only one thing: the
line-by-line comparison against your two documents. It prevents nothing else,
because your message states the five policy corrections and the four
instructions explicitly, and those are authoritative on their own. **All nine
have been applied in full** — §2 lists each with the exact edit.

So this revision is complete with respect to your instructions and incomplete
with respect to one deliverable: the diff pass. If you can paste the two
documents inline, or commit them to any branch, that pass is quick now that the
findings and the corrected plan both exist.

---

## 2. Policy corrections applied

| Correction | v1 said | v2 says | Where |
| --- | --- | --- | --- |
| **A-3** — verified MTN/Airtel float is immediately available; no wait for daily reconciliation | wallet inflows `pending`, with a reconciliation dependency implied by gap analysis §9.3 | verification is the only gate; **no availability function reads `account_reconciliations`**, asserted on a database holding no reconciliation row | plan §4.2, §4.3, §4.5; test `cash-availability.test.ts :: verified wallet float is available before any reconciliation exists` |
| **A-4** — no sufficient-funds override, Owner included; no `allow_negative_available` | proposed `allow_negative_available` **and** an Owner-only correction override | **both deleted.** Decision A adds **no settings column at all**, because a switch that made unconfirmed or uncleared money available would be that override renamed. `allow_negative_cash` and `allow_negative_agency_float` are left alone and read by nothing new | plan §4.4, §5.3; tests `no actor, Owner included, can post a short payout` and `allow_negative_cash … do not relax availability` |
| **A-5** — account-specific, never branch aggregate | carried as an assumption | ruled and tested: availability reads one account, consults no sibling and no branch total | plan §4.3, §5.1; tests `a sibling account's balance never funds this one`, `no availability function consults a branch total` |
| **A-6** — value dates may be historical; entries must not be backdated into closed periods | conflated `cleared_on` with the journal's `entry_date` | **two dates, separated.** `cleared_on` is evidence and may be historical; the clearance journal's `entry_date` is always `business_date()`. Nothing this plan adds can post into a past period | plan §6.5; tests `a historical value date posts to today, never to the value date`, `refuses a value date in the future` |
| **A-13** — deposit `cleared` and loan `cleared` are distinct context-specific statuses | proposed avoiding the word for deposits (gap analysis D14) | **reversed.** Both keep the word; the mitigation is context separation — separate columns and CHECKs, no shared enum or domain, no view reading a bare `cleared` across both subjects, qualified labels | plan §6.7; tests `deposit clearance does not alter any loan status`, `loan clearance does not alter any deposit status` |
| **Instruction** — the Owner-only correction override is not approved; design a sound alternative that does not bypass sufficiency | override on paths 4–7 gated by `finance:correction` | **withdrawn.** Replaced by `correct_misrecorded_receipt`: it can only contra an entry it names line for line, is refused on every outflow source type, requires a second actor, and hands a resulting negative balance to **reconciliation** — not to an override — by flagging the account and blocking every outgoing path from it until a count is approved | plan §5.3; `receipt-correction.test.ts` |
| **Instruction** — treat the deposit-loss account and write-off as separate review | `5960 Deposit Losses Under Investigation` plus a `written_off` outcome | **removed from scope.** `written_off` is absent from the status domain, and a test asserts it does not exist so the parked decision cannot be used by accident. Two notes handed to that review, including that **`5960` is already taken** (finding N2) | plan §6.6; test `a write-off outcome does not exist` |
| **Instruction** — traceability matrix | absent | 17-row decision → rule → design → migration step → exact test matrix | plan §2 |
| **Instruction** — exact tests per critical control | test plan by theme | named cases per control, nine suites, each mapped from the matrix | plan §13 |

---

## 3. Status of the v1 findings

All sixteen are resolved in the plan. Nothing was dropped.

| ID | Finding | Status |
| --- | --- | --- |
| **B1** | Five outgoing paths missing from the inventory; eight exist, not three | **Resolved.** Full 22-row inventory, plan §8; ten named sufficiency cases |
| **B2** | A sixth `cash_kind` breaks two certified identities and three suites | **Resolved.** `in_transit` is a named component **inside** `total_liquidity`, same migration; availability gets its own columns; the certification script's sum identity is listed for extension. Supersedes gap analysis D12 and §4.3 |
| **B3** | Without hardening `assert_cash_account`, the clearance control is bypassable by `transfers:create` | **Resolved.** Hardening ships in the same indivisible migration as the kind; test `refuses a transfer out of 1050` |
| **B4** | Receipt confirmation must not touch `loan_payments` | **Resolved.** One journal at receipt plus a restriction record; `receipt-confirmation.test.ts` asserts loan figures bit-identical |
| **B5** | Refusal logging cannot be done inside the database | **Resolved.** Application-layer, post-rollback, with the four stated properties, plan §9 |
| **H1** | `payment_method` does not identify a funding account | **Resolved.** Explicit account argument on all three payout paths, plan §5.2 |
| **H2** | Signature changes must DROP then CREATE | **Resolved.** Stated with the precedent and the five-file blast radius |
| **H3** | Head Office branch selection already exists; depend on #27 | **Resolved.** The operating-branch rule is called, not re-derived; branch point is #27 |
| **H4** | `allow_negative_cash` must not govern availability | **Resolved, and strengthened by A-4.** v1 proposed a separate column; v2 has **no column at all** |
| **H5** | Lending reconciliation contradicts its agency twin | **Resolved.** Path 8 gains the assert and the lock |
| **H6** | Reversal versus correction is a genuine contradiction | **Resolved differently.** v1's override is withdrawn; plan §5.3 separates the correction path structurally. The residual policy question is N5 |
| **M1** | Bounced deposit needs a money location and a loss account | **Split.** The location is resolved — money stays in `1050`, the investigation posts nothing. The loss account is **referred to separate review** |
| **M2** | `in_transit` uniqueness | **Resolved.** Step 2 of the migration order |
| **M3** | Query live constraint names, do not transcribe | **Resolved.** Plan §11.4 |
| **M4** | Transition states to name | **Resolved.** Five named; cutover is clean by design |
| **M5** | Test gaps | **Resolved.** Plan §13 names every case, including the lock-order probe and the no-confirmation-row history proof |

---

## 4. New findings from this reconciliation

Five, from reading the code against the corrected rulings.

### N1 — Closed accounting periods do not exist, and A-6 requires them

**Severity: high. Scope larger than Decision A.**

A-6 forbids backdating an accounting entry into a closed period. The schema has
no such concept, at 214 migrations:

- no `financial_period`, `period_close`, `closed_period` or equivalent table —
  zero matches across the migrations and `lib/`;
- no constraint on `journal_entries.entry_date` in either direction, and the
  column's own comment records that *"a back-dated correction posts to the day it
  happened"* — backdating is a **designed** property of this ledger;
- three existing paths already accept an unbounded caller-supplied date:
  `record_transfer(p_transfer_date)`, `record_expense(p_expense_date)` and
  `record_other_income(p_income_date)`, each `coalesce`d to `business_date()`
  with no bound.

So A-6 is not a clearance rule; it is a system-wide rule that today has nothing
to enforce it and three open paths to enforce it on.

**How the plan handles it.** Inside Decision A's own scope, A-6 is satisfied
absolutely and cheaply: the clearance journal's `entry_date` is always
`business_date()`, so nothing this plan adds is ever backdated, whatever the
bank's value date says. That needs no period subsystem.

**What is left.** Enforcing A-6 across the system needs period close — what
closes, who closes and reopens it, hard lock or soft warning, and what becomes
of the three unbounded-date paths. **Recommended as its own workstream, not
folded into Decision A.** Plan §15.1.

### N2 — The proposed deposit-loss code is already taken

`5960` is **`Agency Float Over and Short`** at the PR #27 head, and `5970` is
**`Agency Float Purchase Premium`**. v1's `5960 Deposit Losses Under
Investigation` would have collided with an account that already exists on the
branch Decision A builds from.

Handed to the separate review along with the account itself, and noted in the
plan so the code is chosen against the chart as it will then stand. A second
note for that review: the choice between an expense and a receivable naming an
individual is HR-sensitive and is not a chart question.

### N3 — Three existing paths accept unbounded dates

Named above under N1. Flagged separately because it is a finding about the
existing system rather than about Decision A, and because whoever takes the
period-close workstream needs it as a starting inventory.

### N4 — The settings flags v1 proposed would themselves have been overrides

A-4 forbids a sufficient-funds override. v1 proposed three `finance_settings`
columns, two of which — `require_cash_receipt_confirmation` and
`require_bank_clearance` — would have made unconfirmed or uncleared money
available when switched off. That is the override under another name, and it
would have been one Owner checkbox away from disabling A-1, A-5, A-8 and A-10.

**All three are removed.** Decision A adds no settings column. This is stricter
than v1 and strictly what A-4 asks for. Recorded as a finding because it is a
correction I made to my own design, not something your brief had to tell me.

### N5 — The correction/sufficiency boundary is a genuine policy question

**This is the one item I will not decide, and it governs a financial control.**

The plan's position: a booking-error correction is not a payout. No value
leaves, so rule 1 is not engaged, and where the contra takes a cash account's
booked balance below zero the account is flagged, **blocked from every outgoing
path**, and queued for a count — which is where `5950` and the existing
maker-checker already live.

The alternative: refuse the correction until the account is funded. That keeps
every cash balance non-negative at all times, and leaves the borrower's ledger
showing a repayment the business never received until somebody finds the money.

Neither is obviously right. The first prefers a correct subsidiary ledger and an
explicitly flagged cash account; the second prefers a never-negative cash
account and a knowingly wrong borrower record. **The Product Owner should
choose.** Plan §15.2.

---

## 5. Corrections to my own earlier documents

Recorded here because `POLYTOS-DECISION-A-GAP-ANALYSIS.md` is left as the
historical record and is not edited.

| Superseded statement | Correct position |
| --- | --- |
| Gap analysis **D12** / §4.3 — in-transit money must **not** be folded into `total_liquidity` | **Wrong.** The certified identity requires every cash-kinded account to appear in `total_liquidity`, and money in transit is an asset the business holds. The figure that excludes it is *available* funds, in its own columns. D12's real content is a **UI** finding: a screen must not present liquidity as spendable (finding B2) |
| Gap analysis **D14** / §9.13 — avoid `cleared` for deposits, because loans own the word | **Reversed by A-13.** Both contexts keep the word; separation is structural and in the labels (plan §6.7) |
| Gap analysis **§9.3** — wallet inflows may be pending until the float is reconciled | **Reversed by A-3.** Verification is the only gate; reconciliation is never a precondition |
| Gap analysis **§9.4**, plan v1 **§4.4** — keep `allow_negative_cash` as an escape hatch and add `allow_negative_available` | **Reversed by A-4.** No override exists and no new flag is added (finding N4) |
| Plan v1 **§5.3** — Owner-only correction override | **Withdrawn.** Replaced by the structural design in plan §5.3 |
| Plan v1 **§6.4** — `5960 Deposit Losses Under Investigation` and a `written_off` outcome | **Removed to separate review**, and the code collides (finding N2) |

---

## 6. Why authorization is still withheld

Not because anything in §3 is open — all sixteen findings are resolved — but
because of two things:

1. **N5 is a policy question that governs a financial control.** Whether a
   booking-error correction may take a cash account's booked balance below zero
   decides whether `correct_misrecorded_receipt` can exist in the form planned.
   Building it either way before the ruling risks building the wrong one.
2. **The line-by-line comparison against your two documents has not been
   done**, because they did not arrive (§1). Everything you stated in the brief
   is applied, but I cannot certify that your plan contains no finding I have
   not seen.

Items 1–8 of plan §15 are the remaining open decisions; only N5/§15.2 blocks.
The rest can be settled during A-I and A-II, which are zero-behaviour-change
phases.

---

## 7. Preserved, and not done

- **PRs #19–#27 untouched.** No branch pushed, retargeted, rebased or merged.
  #25 is at `6da70d9`, #26 at `9ed0b22`, #27 at `82d1f8c` — byte-identical to
  the previous review. The independent security work (#19, #20) is unchanged.
- **No migration written or applied. No application code, test, script or
  deployment configuration changed. No financial record touched. No hosted
  Supabase data read or modified.** Two documentation files on
  `ccr-8972366d-qcq8xz` are the whole of the change.
- **`docs/POLYTOS-DECISION-A-GAP-ANALYSIS.md` is unedited**, per the instruction
  to update the plan and review only; §5 above lists what it supersedes.
- **Production remains NO-GO**, with the existing blockers — including the
  Git-linked Supabase branch reporting `MIGRATIONS_FAILED` — untouched and
  independent of this work.

**Stopped at the review gate.** Development is not authorized by this document.
