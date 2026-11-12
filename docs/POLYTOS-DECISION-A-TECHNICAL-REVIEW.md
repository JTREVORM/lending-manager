# POLYTOS — Decision A Technical Review Report

**Revision:** v4. Supersedes v3 (`944e00c`), v2 (`30bc027`) and v1 (`38a7e3d`).
**Verdict: CHANGES APPLIED — development authorization withheld for ONE
dependency, D-2** (§7). D-1 and D-3 are **approved and recorded** in plan v4;
D-2 is now **reviewed** in `docs/POLYTOS-DECISION-A-D2-ACCOUNTING-REVIEW.md` and
closes when its five business decisions are taken.
**Comparison status: PERFORMED.** Both review-package documents were received,
extracted and compared clause by clause — 71 clauses across the two of them.
§3 and §4 carry the result. Nothing is recorded as compared that was not.
**Type:** documentation only. No migration, application code, test, financial
record, deployment configuration or PR branch touched.
**Compared against:** `docs/POLYTOS-DECISION-A-IMPLEMENTATION-PLAN.md` (v2 at
`30bc027`, now v3), `docs/POLYTOS-DECISION-A-TECHNICAL-REVIEW.md` (v2) and
`docs/POLYTOS-DECISION-A-GAP-ANALYSIS.md` (`4739d0d`).
**Code state:** PR #27 head (`phase4e/mobile-money-2026-11-09`, 214 migrations).
**Production:** NO-GO.

---

## 1. The booking-error ruling resolves the blocking question

v2 withheld authorization on one item: whether a proven booking-error correction
may take a cash account's booked balance below zero. The Product Owner has ruled
that it may, under seven conditions.

**This is the "fresh explicit Owner approval" that the review package itself
required.** Its §2 H6 rejected the override "as currently stated" and said *"Any
exceptional financial rule requires fresh explicit Owner approval."* Its Gate P3
required an error-correction design that creates **no** negative balance. The
ruling supersedes P3 by granting a bounded exception instead, and the plan
implements all seven conditions (plan §1.2, §5.3).

**Two consequences worth naming.**

- **The exception is narrower than v2's withdrawn override, not wider.** Condition
  C6 — *a genuine customer payment must never be reversed merely because staff
  subsequently lost or misappropriated the cash* — splits one function into two
  workflows. v2 had a single correction path for all four reversal routes;
  the plan now refuses correction whenever the payment actually occurred and
  routes that to a cash-loss investigation that leaves the borrower's record
  intact (plan §5.3.2, §5.4). That is a real tightening, and it is the condition
  most likely to be got wrong in implementation.
- **C2 forecloses the suspense design the package floated.** §2 H6 invited a
  "truthful, balanced suspense/receivable/non-cash reclassification". C2 requires
  the correction to *exactly reverse* the original entry, and a suspense posting
  is not an exact reverse. So the suspense route is now closed by the ruling, and
  the negative-balance-plus-block route is the approved one.

---

## 2. What the comparison covered

| Document | Clauses compared |
| --- | --- |
| `POLYTOS_DECISION_A_IMPLEMENTATION_PLAN_REVIEW.md` — §1 policy table (13), §1 invariants (7), §2.1–2.4 (4), §3 (5), §4 gates (8), §5 test groups (6), §6 (2), §7 (7), §8 (1) | **53** |
| `POLYTOS_DECISION_A_REVIEW_RESPONSE_v2.md` — §1 rulings (13, folded into the above), §2 findings (16), §3 corrections (8), §4 gates (4) | **28**, of which 10 overlap |
| **Total distinct** | **71** |

Outcome: **49 already addressed**, **14 needed an edit to my documents**,
**3 conflicted with approved policy** (all three in *my* plan), **5 open design
decisions**. §3 and §4 enumerate the non-trivial 22.

---

## 3. Conflicts with approved policy — all three were mine

These are the findings the comparison existed to produce. Each was a defect in
plan v2, not in the package.

### C-1 — v2 returned bounced-deposit cash to the till automatically. A-8 forbids it.

Plan v2 §6.3 defined `reject_bank_deposit` as: *"only from `submitted`;
distinct-actor; contra of the deposit entry; money returns to the till;
`rejected`."* That posts a till credit on rejection, with no verification that
any cash came back.

A-8 is explicit: *"Cash moves back to till only after independently verified
physical receipt."* The original plan says the same twice — its §2.2
`Physical Cash Returned` state requires *"authenticated, separately verified
return to till. Post Dr till / Cr transit only at confirmed actual return"*, and
its §1 A-8 row states it **supersedes** the audit's preliminary
automatic-return-on-rejection proposal. My v2 had carried that superseded
proposal forward.

**Resolved.** `rejected` is removed from the status domain entirely. A refused
deposit goes to `under_investigation`, which **posts nothing** and leaves the
money in `1050` where it honestly is; a new
`confirm_physical_cash_return(deposit_id, evidence_path, notes)` posts
Dr till / Cr `1050` only on documented, independently verified physical receipt,
and refuses the deposit's own recorder. Plan §6.3, §6.4; tests
`rejection writes no journal and does not return cash to the till` and
`the deposit recorder cannot confirm its own physical return`.

### C-2 — v2's refusal logging was best-effort. A-11 says fail closed.

Plan v2 §9.2–9.3 logged refusals **after** the rollback, best-effort, and stated
as a virtue that *"the refusal is returned to the user whether or not the log
write succeeded."*

A-11's design consequence in the original plan is *"nonfinancial attempt log
outside an aborted posting transaction; **fail closed**"*, and its §3 gives the
architecture: *"a durable attempt record in a separate committed transaction
**before** the financial RPC… If the initial durable audit write fails, do not
execute the payout."*

My reading of A-11's sentence — *a logging failure cannot turn a refusal into a
success* — was literal and too narrow: it rules out one failure mode but does
not deliver the completeness fail-closed gives. Under v2's design a refusal
occurring while the log was down left no record at all.

**Resolved.** Adopted as specified: pre-write the attempt in its own committed
transaction; **if that write fails, do not attempt the payout**; write the
outcome separately; treat an attempt with no outcome as a monitored anomaly.
Plan §9.2. The safety argument is that the attempt log can only ever *prevent* a
payout, never permit one.

**And the cost is stated rather than hidden:** the attempt log becomes an
availability dependency of every payout, so an outage stops the counter. The
package anticipated this (its §6 asks for *"continuity during system outages"*),
and plan §15.7 carries it as an operational requirement. The plan makes **no**
claim of exactly-once delivery under arbitrary infrastructure failure, which the
package expressly warned against.

### C-3 — v2 sequenced branch security after enforcement. The package requires the reverse.

Plan v2 §13 put branch scoping at phase A-VI, after universal enforcement at
A-III. The original plan pulls branch security **forward** (its gate A5 precedes
A2), and the response §3.8 states why: *"Keep branch-scoped RLS ahead of or at
least inseparable from activation of universal funding-account selectors, so
bank account IDs cannot access another branch."*

That is correct and the reasoning is sharp: an explicit funding-account
parameter is itself an access vector. Shipping the selectors before branch
scoping would briefly let a caller name another branch's account by id.

**Resolved.** Branch authorization becomes step **5a**, a precondition of the
signature changes at step 6. Plan §11.2.

---

## 4. Clauses that needed an edit

| # | Package clause | My v2 | Resolution in v3 |
| --- | --- | --- | --- |
| E-1 | A-9: *"source bank must have sufficient available funds"* | used `assert_cash_available` — the **booked** helper | now `assert_cash_funds_available`; test `a reversal is refused when the bank's available funds are short`. Plan §6.3 |
| E-2 | A-9: *"Manager may request"* | only an Owner-only reversal function | added `request_clearance_reversal` (Manager) → `authorize_clearance_reversal` (Owner, ≠ verifier). Plan §6.3, §10.4 |
| E-3 | A-3: *"Do not add a second physical-cash receipt confirmation requirement to the electronic float itself"* | classified **all** wallet inflows as pending | agency/Mobile Money legs now carry **no** confirmation row, because `verify_agency_transaction` already is the independent verification and writes the journal. Plan §4.2. The residual gap is O-1 below |
| E-4 | A-7 and response M1: no automatic variance journal; *"Do not book an expense merely because funds are still under investigation"* | §5.3 handed a correction shortfall to reconciliation, *"which is where 5950 … already live"* — implying automatic absorption | C5's *"and formally resolved"* is now implemented as a **second, separate** condition; `5950` is explicitly not used by default; the formal-resolution design is referred out. Plan §5.3.4, §1.3 |
| E-5 | Response H1: *"bank inbound destinations and other ambiguous account selectors need equivalent review"* | fixed only the three outbound payout paths | explicit `p_receiving_account_id` added to the five inbound paths, because a receipt landing in an arbitrary bank account is the same defect facing the other way. Plan §5.2 |
| E-6 | Original §6: *"that compatibility rule does not prove old cash is physically present or old bank deposits have cleared"* | presented "absent means available" as sufficient | new §11.4: signed per-account till counts, bank confirmations and statement reconciliation, discrepancy resolution and a documented initial verified available position, as a precondition of **activation**. The best correction in the package |
| E-7 | A-1: batch verification *"performs every per-receipt verifier-versus-recorder check, account lock and idempotent state change"* | "batch form for counter throughput"; one atomicity test | per-receipt semantics specified, with test `a batch refuses only the receipts the confirmer recorded, and confirms the rest`. Plan §4.3 |
| E-8 | Original §2.2 / Phase 4E precedent: *"validate branch and account authorization before any idempotent early return"* | ADR-056 cited for capability only | branch authorization is now explicitly above the replay shortcut on every new path. Plan §5.2, §12.6 |
| E-9 | Original §3: *"Handle multi-branch journal entries carefully… whether exposing an entry header leaks another branch's activity"* | a flat branch predicate on `journal_entries` and `journal_lines` | the asymmetry is now stated: `journal_lines` carries no branch, so it must be scoped by **its account's** branch, and header visibility on a cross-branch entry needs its own rule. Plan §10.3; open decision O-4 |
| E-10 | A-12: *"Cross-branch money movements require both-branch authorization"* | absent | added: a transfer whose legs span two branches requires authorization for both, not merely the source. Plan §10.3; test `a cross-branch transfer requires authorization for both branches` |
| E-11 | Original §2.4: aggregated liquidity *"informational only, never a funding source"*; *"client-side warnings must supplement, never replace, server-side atomic checks"* | implied via D12 | stated as a rule and tested in the browser suite. Plan §5.1, §13.3 |
| E-12 | Original §7.1: distinguish genuine cash receipts from *"transfers, reversals, opening capital and corrections"* | the inflow table omitted `opening_balance` | `opening_balance` and contra lines now explicitly excluded. Plan §4.2 |
| E-13 | Original §5 and §4: *"four mandatory GitHub jobs"*, PG 17 rehearsal, migrations-on-empty, fixed-point comparison, *"no weakening tests to achieve green"* | "the new-head required CI" | the full release gate is itemized, including that green CI is not permission to merge. Plan §13.4 |
| E-14 | Original §6: production also blocked by *"Decision L and membership policy activation"*, provider commercial terms, backup and recovery, deploy access | named only the Supabase/CI blockers | the full independent blocker list is carried. Plan §11.5 |

### 4.1 Clauses already addressed

For completeness, the package's substantive positions that plan v2 already
implemented, and which v3 keeps: `post_journal` as sole writer and append-only
ledger; no financial artifact on refusal (rule 10); per-account non-pooled
sufficiency; whole-set deterministic locking on PR #25's contract; no
self-verification, enforced in constraints **and** functions; restriction-not-a-
second-journal for receipts (A-1, A-10); borrower recognition at recording with
spendability separate (A-10); `in_transit` as a **named component of book
liquidity** with separate spendable figures (B2 — the package's own correction of
its earlier exclusion); the indivisible `assert_cash_account` hardening (B3);
`loan_payments` untouched (B4); explicit funding accounts (H1); DROP/CREATE
signatures (H2); branch from #27 (H3); no `allow_negative_available` (H4);
lending/agency reconciliation parity (H5); one transit account per branch (M2);
live constraint introspection preserving every CHECK alternative (M3); the
transition-state list (M4); the full test matrix with the advisory-lock harness
(M5); `5960` referred out (M1); and A-13's two-domain `cleared`.

---

## 5. New findings from the comparison

### O-1 — A-3 leaves non-agency wallet inflows unverified, and nothing in either document covers them

A-3 and the response §1 both speak of *electronic float* reaching availability
through *provider-confirmed, independently verified, posted* transactions — which
is exactly what the agency and Mobile Money modules do, because
`verify_agency_transaction` is the verification and the journal is written by it.

But a **loan repayment or savings deposit keyed `mtn_mobile_money` or
`airtel_money` through `post_payment` / `post_savings_deposit`** is not an agency
transaction. It posts on recording, with **no verification step of any kind**. So
reading A-3 as "all wallet inflows are immediately available" would make
unverified wallet money spendable on one officer's keystroke — which A-1's logic
plainly does not intend, and which neither document addresses.

The plan therefore restricts those inflows and leaves the agency path alone,
which satisfies A-3's "no *second* requirement" literally. **Confirmation
requested** (plan §15.1): either endorse that, or rule that a provider reference
is itself sufficient evidence for a non-agency wallet receipt.

### O-2 — Both documents assume closed accounting periods exist. They do not.

The original plan §2.4 states *"Closed periods are immutable even if the bank
value date is historical"* and its §5 lifecycle tests include *"attempt to post
into closed period"*. A-6 and the response §1 both turn on the concept.

At 214 migrations there is no `financial_period` table, no close or reopen
function, and **no constraint on `journal_entries.entry_date` in either
direction** — and the column's own comment records that *"a back-dated
correction posts to the day it happened"*: backdating is a designed property of
this ledger. Three existing paths already accept an unbounded caller-supplied
date: `record_transfer(p_transfer_date)`, `record_expense(p_expense_date)`,
`record_other_income(p_income_date)`.

The plan complies inside its own scope by never backdating at all — the
clearance journal's `entry_date` is always `business_date()`, whatever the value
date says — so A-6 needs no period subsystem for Decision A. But **the
package's "post into closed period" test cannot be written until one exists**,
and enforcing A-6 system-wide is a larger workstream touching paths Decision A
does not. Plan §6.5, §15.4.

### O-3 — A-12 cannot be built on `user_can_see_branch` as it stands

A-12 forbids a *"`NULL ⇒ all branches`"* fallback for ordinary users.
`user_can_see_branch(uuid)` returns **true for any profile whose `branch_id` is
null**, and today **every** profile's is null. So applying the existing predicate
would grant every Manager and Secretary every branch — the opposite of A-12.

Two things follow, neither of which either document resolves:

1. unrestricted access must follow from the **`owner_admin` role**, not from a
   null column, and every other role needs an **explicit authorized-branch set**
   — new state, because `profiles.branch_id` is a single column while Head Office
   staff may legitimately be authorized for several branches;
2. the migration that narrows this **changes what real users can see today**, and
   which branches each existing non-Owner account is authorized for is a data
   decision that cannot be derived from the schema.

Plan §10.2; open decision for the Product Owner.

### O-4 — The multi-branch journal entry has no visibility rule

`journal_entries` carries one `branch_id`; its **lines** can touch accounts of
two branches — exactly what a cross-branch transfer produces — and
`journal_lines` carries no branch of its own. A predicate on the header alone
therefore both over- and under-discloses: it hides the entry from the second
branch entirely while exposing, to the first, lines belonging to accounts it may
not see. The original plan raises the question (§3, §7.7); neither document
answers it. Plan §10.3, §15.5.

### O-5 — An internal tension in the original plan's §1

Its "Original" row says *"enforce per **individual account** and branch"*, while
A-5 says a branch total *"cannot fund an account-specific shortage"*. Read
together the resolution is that **branch is an authorization dimension, not a
funding pool** — which is how the plan implements it (§5.1 for sufficiency, §10
for authorization). Recorded so the two clauses are not later read as licensing
a branch-level sufficiency check.

---

## 6. Corrections to my own earlier documents

`POLYTOS-DECISION-A-GAP-ANALYSIS.md` remains the historical record and is not
edited. Superseded statements, now cumulative across all three revisions:

| Superseded | Correct position |
| --- | --- |
| Gap analysis **D12** / §4.3 — in-transit money must not be in `total_liquidity` | **Wrong.** It is a named component of book liquidity and of every cash-kind GL account; *available* is the figure that excludes it. The package reached the same conclusion independently |
| Gap analysis **D14** / §9.13 — avoid `cleared` for deposits | **Reversed by A-13.** Both domains keep the word |
| Gap analysis **§9.3** — wallet inflows pending until reconciled | **Reversed by A-3.** Verification is the gate; reconciliation never is |
| Gap analysis **§9.4** / plan v1 §4.4 — `allow_negative_available` | **Reversed by A-4.** No bypass flag exists; v3 adds no settings column at all |
| Plan v1 **§5.3** — Owner-only correction override | **Withdrawn**, then replaced by the approved seven-condition design |
| Plan v1 **§6.4** — `5960 Deposit Losses Under Investigation` | **Referred out**, and the code collides |
| Plan v2 **§6.3** — `reject_bank_deposit` returns cash to the till | **Conflicted with A-8.** Removed (C-1) |
| Plan v2 **§9.2–9.3** — post-rollback best-effort refusal logging | **Conflicted with A-11's fail-closed.** Replaced (C-2) |
| Plan v2 **§13** — branch security after enforcement | **Conflicted with the package's ordering.** Reordered (C-3) |
| Plan v2 **§5.3** — reconciliation absorbs a correction shortfall via `5950` | **Conflicted with A-7.** Formal resolution is a separate condition and is referred out (E-4) |
| Plan v2 **§4.2** — all wallet inflows pending | **Conflicted with A-3.** Agency legs carry no restriction (E-3) |
| Review v2 §1 — the comparison could not be performed | **Performed.** 71 clauses, §2–§5 |

---

## 7. Dependency status

### 7.1 D-1 — approved and recorded

**Explicit per-staff branch grants.** Owner/Admin hold authorized cross-branch
access; branch-assigned staff are restricted to their authorized branches; Head
Office staff need explicit multi-branch grants; **existing non-Owner staff
without an assignment receive no branch financial access until granted**;
enforced in RLS **and** posting functions, with no fallback branch.

Recorded in plan §1 and designed in plan §10.2. Two notes:

- **The data decision I flagged as D-1's hard part has been dissolved, not
  answered.** v3 asked which branches each existing non-Owner account should
  get, and said it could not be derived. The ruling's deny-by-default answers it
  structurally: **no grants are back-filled**, the table is created empty, and
  access is granted deliberately afterwards. That removes a migration-time data
  decision entirely, which is the better outcome.
- **It creates an activation precondition instead.** Because the change is
  deny-by-default, an Owner must issue grants to working staff at or before
  activation or the counter stops. Carried in plan §10.2(4) and §11.4, with the
  release notes stating the behaviour change plainly.

### 7.2 D-3 — approved and recorded

**Non-agency MTN/Airtel receipts require independently verified provider
confirmation before their funds become spendable, verified by a different
Manager/Owner. An already-verified Agency Banking transaction reuses that trusted
verification without duplicate posting. Daily reconciliation stays mandatory and
is not an availability gate.**

This confirms the reading plan v3 adopted and adds the part v3 could not infer:
the verification **reuses** the agency module's own maker-checker rather than
layering a second one, and it **posts nothing** — it releases a restriction.
Recorded in plan §1, §2 and §4.2.

### 7.3 D-2 — reviewed; one dependency remains

`docs/POLYTOS-DECISION-A-D2-ACCOUNTING-REVIEW.md` covers all ten requested
areas. Its central finding changes the shape of the problem:

> **A booking-error correction cannot by itself drive a cash account negative.**
> A negative appears only when more has been recorded as leaving the account than
> ever legitimately entered it — which is a *second, independent irregularity*
> the correction has merely revealed. It is always one of four findings, and
> **three of the four involve no loss at all**.

So C5's "formal resolution" is not a decision about who bears a loss. It is a
classification-free posting that restores the cash account to its counted balance
and parks the unexplained amount on the **balance sheet** — `1190 Cash
Differences Under Investigation` — with no time limit and no automatic exit.
Loss recognition (`5110`) and a receivable (`1195`) each need an explicit Owner
act on top.

**D-2 closes when five business decisions are taken** (that review's §10): the
variance tolerance, the deposit ageing threshold, partial physical returns, what
constitutes an enforceable claim, and who authorizes a loss. Each has options and
a recommendation; none is decided in the document.

### 7.4 Two defects found in the existing system while reviewing D-2

| | Finding | Consequence |
| --- | --- | --- |
| **D2-a** | `approve_reconciliation` posts **every** approved variance to `5950` unconditionally — a 700,000 shortage becomes an expense on one approval | Contradicts A-7's "no automatic variance or loss journal" and the standing constraint. Closed by the tolerance of DD-1 and a second destination |
| **D2-b** | the lending reconciliation path takes **no account lock**, while its agency twin takes both a lock and a sufficiency assertion | Already recorded as H5; repeated because D-2's resolution posting runs on that path and would inherit the gap |

### 7.5 Still open, not blocking

Plan §15: the evidence standard for C1; the cross-branch journal header rule;
**a `finance-evidence` storage bucket, which does not exist** — the six existing
buckets are client, guarantor, loan, membership-consent, benefit and
company-assets, and the clearance slip, physical-return and correction evidence
all need one; A-10's reach into savings and benefits; fail-closed continuity;
batch-confirmation granularity; six ADRs.

**Independent of Decision A:** the closed-period workstream, and the production
blockers — the Git-linked Supabase branch reporting `MIGRATIONS_FAILED`, GitHub
protections, deploy access and custom domain, backup and recovery, provider
commercial terms, Decision L and membership policy activation.

**Not blocking, settleable during the zero-behaviour-change phases A-I and
A-II:** the evidence standard for C1 (plan §15.2); the multi-branch journal
header rule (O-4, §15.5); A-10's reach into savings and benefits (§15.6);
operational continuity for a fail-closed attempt log (§15.7); batch-confirmation
granularity (§15.8); six new ADRs (§15.9).

**Independent of Decision A and unchanged:** the closed-period workstream (O-2),
and the production blockers — the Git-linked Supabase branch reporting
`MIGRATIONS_FAILED`, GitHub protections, deploy access and custom domain, backup
and recovery, provider commercial terms, Decision L and membership policy
activation.

---

## 8. Preserved, and not done

- **PRs #19–#27 untouched.** No branch pushed, retargeted, rebased or merged.
  #25 `6da70d9`, #26 `9ed0b22`, #27 `82d1f8c` — byte-identical to both previous
  reviews. PR #19's independent security work is unchanged and stays visible for
  the combined rehearsal.
- **No migration written or applied. No application code, test, script or
  deployment configuration changed. No financial record touched. No hosted
  Supabase data read or modified.** Two documentation files are the whole change.
- **The review package was treated as data**, extracted read-only into an
  isolated scratch directory; nothing from it was executed.
- **`docs/POLYTOS-DECISION-A-GAP-ANALYSIS.md` is unedited**; §6 lists what it
  supersedes.
- **Production remains NO-GO.**

**Stopped at the review gate.** This document authorizes no development; A1 and
every later phase need their own Product Owner sign-off, and every PR stays
draft pending integrated review.
