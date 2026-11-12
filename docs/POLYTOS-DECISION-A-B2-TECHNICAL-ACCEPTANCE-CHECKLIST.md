# POLYTOS — Blocker B-2: Technical Acceptance Checklist

**Subject:** the exact changes required to the three reconciliation approval
paths, their locking and stale-balance validation, and the removal of
unauthorized automatic variance write-offs.
**Status:** documentation only. **No code, migration or test has been written.**
This is the acceptance specification an authorized implementation must satisfy.
**Classification: one indivisible security change.** §8 states why, and why
landing any part of it alone is worse than landing none.
**Reviewed at:** PR #27 head (`phase4e/mobile-money-2026-11-09`, 214
migrations). Every line reference is to that head and must be re-verified at
branch time.
**Governing rulings:** **DD-1 — no tolerance of any kind**; A-7 — no automatic
variance or loss journal; A-12 and D-1 — branch-scoped reads and writes; rule 9
— atomic posting with concurrency-safe locking; rule 11 — auditability.
**Production:** NO-GO. Draft PRs #25–#27 untouched.

---

## 1. Tolerance correction

**DD-1 approves no tolerance.** Earlier revisions of this review recommended a
configured variance tolerance, and one stale sentence survived into v5 of the
technical review — *"Closed by the tolerance of DD-1"*. That is wrong and is
corrected: **DD-1 removes the tolerance entirely.**

The operative rule, stated once and used everywhere below:

> **Every unexplained reconciliation variance requires investigation, regardless
> of amount. There is no de-minimis, no rounding allowance, no per-account
> tolerance, and no automatic write-off at any figure.** `5950` and `5960`
> receive no new variance posting on any path.

Any specification, setting, column, parameter or test that implies otherwise is
out of scope and must not be built.

---

## 2. The four paths, current state and required state

### 2.1 `submit_reconciliation(p_account_id, p_business_date, p_counted_balance, p_explanation)`

Current definition: `supabase/migrations/20261016000100_balance_as_of.sql:68`.

| | Current | Required |
| --- | --- | --- |
| Account lock | **none** | `perform public.lock_ledger_balances(array[p_account_id])` **before** `ledger_account_balance_as_of` is read, so the frozen `system_balance` is not stale at the instant it is frozen |
| Branch authorization | **none** — `user_can_see_branch` appears zero times | refuse unless the caller is authorized for the account's branch, under D-1's refined predicate |
| Capability | `reconciliation:perform` | unchanged |
| Future-dated count | refused | unchanged |
| Negative count | refused | unchanged |
| Posting | none | unchanged — a count posts nothing |

The agency twin `submit_agency_cash_reconciliation` already locks
(`20261110000400:213`) and already checks the branch. This brings the lending
path to parity.

### 2.2 `approve_reconciliation(p_reconciliation_id, p_notes)`

Current definition: `supabase/migrations/20261011000230_money_movement_income.sql:285`.
**This function carries four defects, not one.**

| | Current | Required |
| --- | --- | --- |
| **Variance posting** | posts **every** approved variance to `5950` unconditionally — shortage `Dr 5950 / Cr account`, overage `Dr account / Cr 5950` | **remove entirely.** Approval records that the count is accepted as evidence and **posts nothing**. The difference is moved by the separate `resolve_cash_difference` function (§3) |
| **Maker-checker** | **absent.** There is no distinct-actor rule, so the officer who counted may approve their own count | refuse `r.performed_by = public.current_profile_id()` with `42501`, **and** add a CHECK constraint on `account_reconciliations` so it cannot be bypassed by `service_role`. The agency twin refuses it both ways; the lending path refuses it neither |
| **Account lock** | **none** | `lock_ledger_balances` on the counted account before any balance is read |
| **Stale-balance validation** | **none** | adopt the agency guard: if the account's live balance no longer equals the frozen `system_balance`, refuse — *"the balance has moved since this count was recorded, so its variance no longer describes anything. Count it again."* Without it a resolution computed from a stale figure posts the wrong amount |
| Branch authorization | **none** | refuse unless authorized for the account's branch (D-1) |
| Capability | `reconciliation:approve` | unchanged |
| Rejection path | records a reason, posts nothing | unchanged |

**A fifth item, which needs the B-1.8 determination before it is built.** The
current adjustment is posted with `entry_date = r.business_date` — **back-dated
to the day of the count** (`20261011000230:321`), with a test asserting it
(`tests/db/reconciliation-as-of.test.ts:191`). Under A-6 an accounting entry is
never backdated into a closed period. The required design dates the resolution
entry to `business_date()` and keeps the count's own date on
`account_reconciliations.business_date` as the economic date — the same two-date
separation already approved for bank value dates. **Do not implement this part
until B-1.8 is answered in writing.**

### 2.3 `approve_agency_cash_reconciliation(p_reconciliation_id, p_adjust, p_reason)`

Current definition: `supabase/migrations/20261110000400_agency_reconciliation.sql:270`.
This path is **better** than the lending path today: it has `for update`, a
branch check, maker-checker with a CHECK behind it, `lock_ledger_balances` at
line 317 and a staleness guard. Only its write-off must go.

| | Current | Required |
| --- | --- | --- |
| **Variance write-off** | with `p_adjust => true`, posts the variance to `5950`, gated on `agency:variance_adjustment` with a mandatory reason | **remove.** Even gated and opt-in, it is a Manager-grade write-off of an unexplained variance, which DD-1 and DD-5 forbid |
| **`p_adjust` parameter** | defaulted `boolean` | **keep the signature; refuse the argument.** `p_adjust => true` raises `P0001`: *"A variance is no longer written off at approval. It opens an investigation."* See §2.5 |
| `agency:variance_adjustment` capability | grants the write-off | retire the grant. Leave the capability row in place so historical audit entries remain readable |
| Lock, staleness guard, branch check, maker-checker | present | **unchanged — do not touch.** These are the reference implementation the lending path is being brought up to |

### 2.4 `approve_agency_float_reconciliation(p_reconciliation_id, p_adjust, p_reason)`

Current definition: `20261110000400:530`. Identical treatment, with two
differences: the write-off destination is **`5960 Agency Float Over and Short`**,
and the current path additionally requires a named provider statement before
writing off. Both the write-off and the `p_adjust` argument are refused as in
§2.3; the provider-statement requirement moves to the float investigation
record, since the statement is still the evidence that matters.

### 2.5 Why the signatures do not change

Removing a defaulted parameter changes a function's signature, and this codebase
has twice recorded what that costs: a defaulted parameter added to an existing
function **creates an overload** and PostgreSQL then refuses every call as
ambiguous — the reason `20261115001500` and `20261115000500` both dropped and
recreated. A DROP/CREATE here would mean re-granting, re-typing and updating
every caller inside a change whose whole purpose is to be minimal and
indivisible.

**So the signatures are kept and `p_adjust => true` is refused with a legible
message.** Callers that pass `false` or omit it are unaffected. Retiring the
vestigial parameter is **follow-up tidying in a separate change**, not part of
this one.

---

## 3. The new function this change depends on

`resolve_cash_difference(p_reconciliation_id uuid, p_reason text, p_evidence_path text)`

The approval paths stop posting, so something must move the difference. It is
specified in `POLYTOS-DECISION-A-D2-ACCOUNTING-REVIEW.md` §4; the acceptance
criteria here are the ones this change must satisfy:

| Requirement | Why |
| --- | --- |
| accepts **only** a reconciliation id, a reason and an evidence reference | no amount, no account, no recipient — so it can never be a payout |
| refuses unless that reconciliation is `approved` with a non-zero variance | the approval is the gate |
| refuses if a resolution entry already exists for it | `journal_entries_one_per_source` on its own source type |
| locks the cash account **and** `1190`/`2900`, sorted, before any read | PR #25's lock covers only cash-kinded accounts; the suspense accounts carry no `cash_kind`, so this function must lock them itself |
| re-validates the frozen `system_balance` against the live balance | the staleness guard, again |
| posts `Dr 1190 / Cr account` for a shortage, `Dr account / Cr 2900` for an overage | §4 of the certification; the directions are verified there against all fourteen journals |
| brings the account's booked balance to exactly the counted figure | the acceptance arithmetic |
| clears `requires_reconciliation` only on success | C5's two conditions are both structurally necessary |
| decides **nothing** about cause or blame | classification is a later, separately authorized act |
| requires the caller to be authorized for the branch | D-1 |

**Gate:** the four `1190`/`2900`/`1195`/`5110` chart rows this depends on are
blocked by **B-1** (§7). `resolve_cash_difference` cannot be built before those
determinations, which is why B-1 and B-2 are sequenced rather than parallel.

---

## 4. Preservation requirements

Each must be demonstrated, not assumed.

| # | Must be preserved | How it is demonstrated |
| --- | --- | --- |
| P1 | **Historic entries never move.** `5950` and `5960` keep every past balance; no historical journal line is edited, deleted or re-posted | `journal_lines` refuses UPDATE and DELETE; `journal_entries_guard_update` permits only `reversed_by_entry_id`. Asserted by a replay of the historical migration set with every tracked fixed point compared |
| P2 | **The opening entry** of 21,449,163 and the assertion that Cash at Hand touches exactly zero at its lowest historical point | the existing ledger suite, unchanged and still green |
| P3 | **Maker-checker**, strengthened rather than weakened: the agency paths keep theirs; the lending path **gains** one | both a function raise and a CHECK on each path; tested by a direct `UPDATE` as `service_role` |
| P4 | **Branch RLS.** Reads and writes scoped under D-1; no fallback branch; no cross-branch disclosure | the real JWT role-and-grant matrix suite |
| P5 | **Concurrency safety.** The global order stays provider lock → account locks (sorted) → reference counter; no new deadlock | the lock-order probes in §6 |
| P6 | **Reconciliation identities.** `trial_balance` foots and equals the journal; `total_liquidity` equals its named components **and** every cash-kinded GL account; `1200` = `principal_outstanding`; `4100` = interest collected; `2100` = `sum(signed_amount)` | `scripts/certify-financial-reconciliation.mjs`, unchanged and still passing. The four new accounts carry **no `cash_kind`**, which is what keeps both liquidity identities untouched |
| P7 | **Borrower records.** No function in this change reads or writes `loan_payments`, `payment_allocations` or any loan status | asserted over the function bodies |
| P8 | **Refusal semantics.** A refused approval or resolution writes no journal, no line, no document change and no status change | the existing refused-transfer assertion pattern, applied per path |

---

## 5. Migration dependencies and order

| # | Depends on | Item |
| --- | --- | --- |
| 1 | **B-1 written approval** | the four chart rows `1190`, `2900`, `1195`, `5110` — and `1191` if Alternative C is chosen |
| 2 | **B-1.8** | the entry-dating change in §2.2 |
| 3 | plan step 5a (**D-1**) | the branch predicate every path in §2 must call. Without it, adding a branch check to these functions would call a predicate that still returns true for a null `branch_id`, which grants everyone everything |
| 4 | PR #25 | `lock_ledger_balances`, and the `post_journal` lock that every other path relies on |
| 5 | PR #27 | the branch point; the operating-branch rule; the migration-ID floor, `20261115001600` when audited — **re-verify at branch time** |
| 6 | — | new `source_type` values for the resolution and investigation entries, added by drop-and-recreate of `journal_entries_source_valid`, **repeating every existing alternative verbatim** and **introspecting the live constraint definition first** — Phase 4A found the architecture specification had both relevant constraint names wrong and would have aborted if transcribed |
| 7 | this change | plan step 7a, which carries it |

`npm run db:types` regenerated; every new column registered in
`tests/db/postgrest-columns.test.ts` (ADR-070).

---

## 6. Named tests

### 6.1 New

**`tests/db/reconciliation-approval.test.ts`**
- `an approved variance posts no journal` — per path, lending and both agency.
- `no variance posting reaches 5950 on the lending path`.
- `p_adjust => true is refused on the agency cash path`.
- `p_adjust => true is refused on the agency float path`.
- `every variance opens an investigation, whatever its amount` — run at 1, at
  1,000 and at 2,000,000, proving **no tolerance** (DD-1).
- `the officer who counted cannot approve their own count` — function raise.
- `the same refusal holds against a direct UPDATE as service_role` — the CHECK.
- `a count is refused for an account the caller's branch grants do not cover`.
- `an approval is refused for an account the caller's branch grants do not cover`.
- `a count locks its account before freezing the system balance`.
- `an approval refuses a stale system balance`.
- `the agency lock, staleness guard, branch check and maker-checker are unchanged`.

**`tests/db/cash-difference-resolution.test.ts`** — specified in the D-2
certification §10 and carried here unchanged: resolution brings the account to
the counted figure exactly; the shortage/overage directions; the suspense
accounts carry no `cash_kind`; resolution takes no amount, account or recipient
and cannot pay anybody; one resolution per reconciliation.

**`tests/db/cash-difference-concurrency.test.ts`** — two approvals of one count
(exactly one succeeds); two resolutions of one reconciliation; a count racing a
posting into the same account (**the D2-b reproduction**); a resolution racing a
payout; the lock-order probe over the cash account and `1190` **in both
orders**. Each case holds **only** the account's advisory lock, posts nothing
and takes no reference, because `next_reference('journal')` serialises every
posting until commit and makes outcome-based races pass by accident.

**`tests/e2e/specs/reconciliation.write.spec.ts`** — a counter cannot approve
their own count; an approval shows the variance and offers **investigation**,
with no write-off control anywhere in the interface; a resolution screen
requiring the approved count, a reason and a document; an `@axe-core/playwright`
pass.

### 6.2 Existing tests that must be **updated**, and exactly how

These assert today's automatic write-off. Under DD-1 that behaviour is
withdrawn, so the tests change **because the approved policy changed** — this is
not a weakening, and each must still assert something stronger than it did.

| Test | Asserts today | Must become |
| --- | --- | --- |
| `money-movement.test.ts:556` *"writes an approved shortage off to Cash Over and Short"* | after approval, cash = 985,000 and `5950` = 15,000 | after approval **nothing is posted**; `5950` stays 0; the variance is open for investigation. After resolution, cash = 985,000 and **`1190` = 15,000** |
| `money-movement.test.ts:572` *"writes an approved overage off the other way"* | `5950` = −7,000 | after resolution, cash = 1,007,000 and **`2900` = 7,000** as a credit; `5950` untouched |
| `reconciliation-as-of.test.ts:171` *"writes off only the shortage that was actually there"* | `5950` = 5,000 against an as-of balance | **`1190` = 5,000**; the as-of arithmetic it exists to protect is unchanged and still asserted |
| `reconciliation-as-of.test.ts:191` *"dates the adjustment to the count, not to the day it was approved"* | `entry_date = current_date - 10` | **blocked on B-1.8.** If dating moves to the posting date, this becomes `the entry is dated when posted, and the count's own date is kept on the document`. If B-1.8 keeps count-dating, the test stands unchanged |
| `money-movement.test.ts:591` *"keeps a rejected difference visible and unposted"* | unchanged | unchanged — still passing is part of the acceptance |
| `security.test.ts:1069`, `:1563` | `approve_reconciliation` in the definer-grant surface | unchanged; `resolve_cash_difference` added to the same lists |

**Every other existing suite must pass unchanged.** That is the evidence this is
a correction and not a behavioural rewrite.

---

## 7. Acceptance criteria

Tick every line, or the change is not accepted.

- [ ] No path writes a variance to `5950` or `5960`. Three paths verified.
- [ ] No tolerance, de-minimis or rounding allowance exists in any form.
- [ ] `agency:variance_adjustment` no longer grants a write-off.
- [ ] `p_adjust => true` is refused, with a legible message, on both agency paths.
- [ ] Both agency function signatures are **unchanged**.
- [ ] `submit_reconciliation` locks its account before freezing the balance.
- [ ] `approve_reconciliation` locks, validates staleness, refuses the counter and checks the branch.
- [ ] A CHECK constraint refuses counter-equals-approver independently of the function.
- [ ] `resolve_cash_difference` exists, locks the suspense account, and takes no amount, account or recipient.
- [ ] A refused approval or resolution writes nothing — no journal, line, document or status.
- [ ] P1–P8 of §4 each demonstrated.
- [ ] `scripts/certify-financial-reconciliation.mjs` passes **unchanged**.
- [ ] The historical replay compares every tracked fixed point as identical.
- [ ] The four updated tests assert the new behaviour; **every other suite passes unchanged**.
- [ ] `npm run verify`, `npm run test:db`, `npm run audit:money` and the database security gate all pass.
- [ ] All four required GitHub jobs green at the final audited code SHA.
- [ ] Migration IDs exceed the parent's greatest, re-verified at branch time.
- [ ] PRs #25, #26, #27 and #19 untouched; no rebase or force push across the stack.

---

## 8. Why this is one indivisible change

Four properties make partial delivery worse than no delivery:

1. **A half-closed write-off is a bypass.** Removing the lending path's
   automatic `5950` posting while leaving the agency opt-in in place means an
   unexplained till variance can still be expensed — on the **same shared till**,
   through a different function. The agency and lending modules post to the same
   Cash at Hand account; closing one door and leaving the other is the defect
   pattern this codebase has already paid for twice.
2. **Removing the posting without adding the resolution strands the money.**
   Approval would stop posting and nothing would move the difference, leaving
   the ledger permanently disagreeing with the count and — where a correction
   flagged the account — the branch blocked with no exit.
3. **Adding the lock without the staleness guard is a false assurance.** The
   lock makes the read current at the moment of posting; the guard is what
   refuses a variance computed against a balance that has since moved. Each
   without the other leaves a wrong amount postable.
4. **Adding the branch check before D-1 grants nothing.** `user_can_see_branch`
   currently returns true for a null `branch_id`, which every profile has. A
   check added before the predicate is refined is a check that passes for
   everyone — worse than none, because it reads as protection in review.

So the change lands as **one migration and one PR**, reviewed as a security
change: three approval paths, the lock, the guard, the maker-checker, the branch
checks and `resolve_cash_difference`, together.

---

## 9. Remaining-blocker register — B-2

| ID | Blocker | Status | Owner |
| --- | --- | --- | --- |
| **B-2.1** | the three reconciliation paths' write-offs, §2.2–§2.4 | specified; **not implemented** | implementation, once authorized |
| **B-2.2** | the missing account lock on both lending reconciliation functions (defect **D2-b**) | specified | same |
| **B-2.3** | the missing stale-balance validation on the lending path | specified | same |
| **B-2.4** | **NEW — the lending `approve_reconciliation` has no maker-checker at all.** The officer who counted may approve their own count. The agency twin refuses it in two places; the lending path in neither | specified; found while writing this checklist | same |
| **B-2.5** | the missing branch authorization on both lending reconciliation functions | specified | same |
| **B-2.6** | the entry-dating change in §2.2 | **blocked on B-1.8** | the qualified accountant |
| **B-2.7** | the four chart rows `resolve_cash_difference` posts to | **blocked on B-1.1–B-1.4** | the qualified accountant |
| **B-2.8** | the branch predicate every path must call | **blocked on plan step 5a (D-1)** | implementation, once authorized |
| **B-2.9** | no `finance-evidence` storage bucket exists for the resolution's evidence reference | specified | implementation, once authorized |

**B-2.4 is new and is the one finding in this checklist that is a live control
gap rather than a policy change.** It is reported here rather than fixed,
because fixing it is code.

Everything in this document is a specification. **No code, migration or test has
been written. Production remains NO-GO** and development remains unauthorized.
