# POLYTOS — Decision A Technical Review Report

**Revision:** v6. Supersedes v5 (`c203ac5`), v4 (`17a54f9`), v3 (`944e00c`),
v2 (`30bc027`) and v1 (`38a7e3d`).
**Blocker packages:** B-1 is prepared as
`docs/POLYTOS-DECISION-A-B1-ACCOUNTANT-REVIEW-PACKAGE.md` (nine determinations
for the qualified accountant); B-2 as
`docs/POLYTOS-DECISION-A-B2-TECHNICAL-ACCEPTANCE-CHECKLIST.md` (one indivisible
security change, with named tests). §10 is the consolidated blocker register.
**Verdict: ARCHITECTURE REVIEW COMPLETE — every business decision is approved,
and development authorization is withheld on two named blockers**, one
accounting and one technical (§7.6). All thirteen A decisions, seven C
conditions, three D dependencies and five DD decisions are settled; no policy
question remains open. The final requirement-to-test traceability report is
§8.
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
| D-2 review v1 §6.2 — `Dr 1190` for the first three findings | **Wrong twice over.** Those findings park in `2900` as a credit, and debiting `1190` would have **increased** the investigation balance it was meant to extinguish. Corrected in the D-2 certification §1 and §4.2, with a named regression test |

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

### 7.3 D-2 — business decisions approved; certified with two blockers

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

**All five business decisions are now approved**, and DD-1 is **stricter than I
recommended**: no tolerance at all, so every unexplained variance is
investigated whatever its size. That closes defect D2-a decisively — `5950` and
`5960` receive no new variance posting on any of the **three** approval paths —
and it removes the last amount-based bypass anywhere in Decision A.

**The certification found one error of my own.** v1 of the D-2 review proposed
`Dr 1190` for the three most common findings. Those findings arise where the
books *understate* cash, which parks the amount in `2900` as a credit — and
`1190` carries a debit balance, so debiting it would have **increased the very
investigation balance it was meant to extinguish**, doubling the unexplained
amount. The cause was a taxonomy error: the finding set is determined by the
**sign of the variance**, and v1 wrote four findings as though all four resolved
one account. v2 rebuilds it as eight findings across two accounts, proves every
posting against seven fully worked examples, and adds the regression test.
Verification item 2 anticipated exactly this failure.

### 7.4 What the certification establishes

- **A booking-error correction cannot by itself create a shortage.** The contra
  nets to zero unless more has been recorded as leaving the account than ever
  legitimately entered it — a second, independent irregularity.
- **Seven of the eight findings involve no loss**, which is why the resolution
  posting is classification-free and never touches the income statement.
- **`5110 Cash and Deposit Losses` is the loss account**, `5960` and `5970`
  being taken by agency float. `1190`, `1195`, `2900` and `5110` are all free
  and **none carries a `cash_kind`**, so both certified liquidity identities
  hold untouched.
- **No money is lost, owed by any person, or owed by any borrower** by default.
  An unexplained amount stays unexplained, with no automatic exit in either
  direction.

### 7.5 Two defects found in the existing system

| | Finding | Status |
| --- | --- | --- |
| **D2-a** | `approve_reconciliation` posts every approved variance to `5950` unconditionally; both agency approval paths offer an opt-in `5950`/`5960` write-off | **Closed by DD-1.** All three must stop, in one change |
| **D2-b** | the lending reconciliation path takes no account lock and has no staleness guard, while its agency twins have both | Open; fixed at plan step 7a |

### 7.6 Why authorization is still withheld

No policy question remains. Two blockers do.

| | Blocker | Owner |
| --- | --- | --- |
| **B-1** | **Accounting.** `1190` is not supportable as an asset at a reporting date — an unexplained shortage is neither a controlled resource nor an enforceable right — and an unidentifiable overage in `2900` generally requires income recognition, for which no destination account or authorization exists. DD-1 and DD-2 make long-open balances ordinary, so a reporting date will fall inside an investigation window. Needs a qualified accountant's determination of the presentation, a period-end resolution policy, the overage treatment and the DD-4 recognition test. **Compounded by the absence of any closed-period concept in the schema.** A financial-reporting blocker, not an architecture defect | A qualified accountant, with the Product Owner |
| **B-2** | **Technical.** The three reconciliation approval paths and the missing lock and staleness guard must all be addressed in the single change at plan step 7a. Leaving any one undone leaves an automatic write-off or an unlocked read in place | Implementation, once authorized |

Five non-blocking items remain in the D-2 certification §11.3 and plan §15: the
blocking policy for a plain shortage, the S2 ordering rule, DD-5's materiality
figure, the absent `finance-evidence` storage bucket, and the `1190`/`2900`
ageing report.

### 7.4 Two defects found in the existing system while reviewing D-2

| | Finding | Consequence |
| --- | --- | --- |
| **D2-a** | `approve_reconciliation` posts **every** approved variance to `5950` unconditionally — a 700,000 shortage becomes an expense on one approval | Contradicts A-7's "no automatic variance or loss journal" and the standing constraint. **Closed by DD-1, which removes every tolerance**: no variance reaches `5950` or `5960` on any path, at any amount |
| **D2-b** | the lending reconciliation path takes **no account lock**, while its agency twin takes both a lock and a sufficiency assertion | Already recorded as H5; repeated because D-2's resolution posting runs on that path and would inherit the gap |

### 7.7 Still open, not blocking

Plan §15 and the D-2 certification §11.3: the evidence standard for C1; the
cross-branch journal header rule; **a `finance-evidence` storage bucket, which
does not exist** — the six existing buckets are client, guarantor, loan,
membership-consent, benefit and company-assets, and the clearance slip,
physical-return, reclassification, correction, claim and loss evidence all need
one; A-10's reach into savings and benefits; fail-closed continuity;
batch-confirmation granularity; the blocking policy for a plain shortage; the S2
ordering rule; DD-5's materiality figure; the `1190`/`2900` ageing report; seven
ADRs.

**Independent of Decision A:** the closed-period workstream — which B-1 now
compounds — and the production blockers: the Git-linked Supabase branch
reporting `MIGRATIONS_FAILED`, GitHub protections, deploy access and custom
domain, backup and recovery, provider commercial terms, Decision L and
membership policy activation.

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

## 8. Final Decision A requirement-to-test traceability report

Every approved decision, its control, and the named test that proves it. Test
cases are specified in plan §13 and in the D-2 certification §10. **None is
written** under the documentation-only authorization.

### 8.1 The original financial controls

| Rule | Control | Test |
| --- | --- | --- |
| 1 — sufficient available funds in the selected funding account | `assert_cash_funds_available` on all 24 outgoing paths; explicit account arguments | `cash-sufficiency.test.ts :: refuses path <n> when the funding account is short` ×12 |
| 2 — Cash at Hand and every bank account independently controlled | per-account availability; explicit account selection; no aggregate consulted | `cash-availability.test.ts :: a sibling account's balance never funds this one` |
| 3 — no automatic cross-account or cross-branch borrowing | nothing nets; refusal is the outcome; D-1 branch grants | `cash-sufficiency.test.ts :: refuses a funding account from another branch` |
| 4 — physical cash confirmed received | `cash_receipt_confirmations`; `confirm_cash_receipt` | `receipt-confirmation.test.ts :: refuses the recorder as confirmer, at both layers` |
| 5 — bank deposits cleared before spendable | `1050 Cash in Transit`; `verify_bank_deposit` | `bank-clearance.test.ts :: a short credit blocks all clearance and posts nothing` |
| 6 — clearance evidence recorded | evidence columns, CHECK-required when cleared | `bank-clearance.test.ts :: requires a bank reference, a value date and a verifier` |
| 7 — a different authorized Manager/Owner verifies | distinct-actor at function **and** constraint layer | `bank-clearance.test.ts :: the verifier cannot be the recorder` |
| 8 — pending and uncleared funds cannot support payouts | availability = booked − pending; `1050` non-spendable | `cash-sufficiency.test.ts :: refuses when booked is sufficient but available is not` |
| 9 — atomic posting, concurrency-safe locking | PR #25's `post_journal` lock; the lock-order contract | `cash-sufficiency-concurrency.test.ts` (whole file) |
| 10 — refused payouts move nothing | single-transaction refusal | `cash-sufficiency.test.ts :: a refusal writes no journal, line, document or status` |
| 11 — approvals, corrections and reversals auditable | `record_audit_event`; append-only ledger | `refusal-audit.test.ts`, `receipt-correction.test.ts` |

### 8.2 A-1 … A-13

| ID | Control | Test |
| --- | --- | --- |
| A-1 | per-receipt restriction; batch performing every per-receipt check | `receipt-confirmation.test.ts :: a batch refuses only the receipts the confirmer recorded, and confirms the rest` |
| A-2 | the 24-path inventory, enumerated by scanning every `post_journal` call site | `cash-sufficiency.test.ts` ×12 |
| A-3 | agency-verified float reuses its verification, carries no restriction | `cash-availability.test.ts :: verified agency float is available on posting, with no confirmation row` |
| A-4 | no flag, no argument, no capability | `cash-sufficiency.test.ts :: no actor, Owner included, can post a short genuine payout` |
| A-5 | one account; no aggregate, no reconciliation | `cash-availability.test.ts :: no availability function consults a branch total` |
| A-6 | `bank_value_date` evidence vs `entry_date` = `business_date()` | `bank-clearance.test.ts :: a historical value date posts to today, never to the value date` |
| A-7 | full clearance only; no automatic variance journal | `bank-clearance.test.ts`; `cash-difference-resolution.test.ts :: no variance posting reaches 5950` |
| A-8 | rejection posts nothing; till contra only on verified physical receipt | `deposit-investigation.test.ts :: rejection writes no journal and does not return cash to the till` |
| A-9 | Manager requests; Owner authorizes; not the verifier; **available** funds | `bank-clearance.test.ts :: the verifier cannot authorize reversal of their own clearance` |
| A-10 | one journal at receipt; confirmation off `loan_payments` | `receipt-confirmation.test.ts :: loan figures are identical before and after confirmation` |
| A-11 | pre-write attempt record, fail closed | `refusal-audit.test.ts :: a failed attempt-log write prevents the payout` |
| A-12 | branch-scoped reads and writes; no fallback branch | `rls-deposits.test.ts :: an unassigned non-Owner profile has no branch financial access` |
| A-13 | distinct status domains; qualified labels | `bank-clearance.test.ts :: deposit clearance does not alter any loan status` |

### 8.3 C1 … C7 — the booking-error conditions

| ID | Control | Test |
| --- | --- | --- |
| C1 | documented non-occurrence required | `receipt-correction.test.ts :: refuses a correction where the payment did occur` |
| C2 | exact contra, read from `journal_lines` | `receipt-correction.test.ts :: corrects only the entry it names, line for line` |
| C3 | second actor + evidence artifact | `receipt-correction.test.ts :: requires documented evidence and a second actor` |
| C4 | no amount, account or recipient argument | `receipt-correction.test.ts :: accepts no amount, account or recipient` |
| C5 | flag and block until reconciled **and** formally resolved | `receipt-correction.test.ts :: an approved count alone does not clear the block` |
| C6 | a genuine payment is never reversed for a staff cash loss | `receipt-correction.test.ts :: a lost or misappropriated receipt leaves the borrower's record untouched` |
| C7 | sufficiency mandatory for every genuine outgoing transaction | `cash-sufficiency.test.ts` (as A-4) |

### 8.4 D-1 … D-3

| ID | Control | Test |
| --- | --- | --- |
| D-1 | `profile_branch_grants`; `user_can_see_branch` refined to role-or-grant; deny by default; no back-filled grants | `rls-deposits.test.ts :: a Head Office officer reaches only granted branches` |
| D-2 | the four accounts and their functions; §8.5 below | `cash-difference-resolution.test.ts`, `cash-investigation.test.ts` |
| D-3 | a non-agency wallet receipt restricted until a different Manager/Owner verifies the provider confirmation | `receipt-confirmation.test.ts :: a wallet receipt stays restricted until its provider confirmation is independently verified` |

### 8.5 DD-1 … DD-5

| ID | Control | Test |
| --- | --- | --- |
| DD-1 | no tolerance; every variance investigated; `5950`/`5960` closed to new variance postings on **three** paths | `cash-difference-resolution.test.ts :: every variance opens an investigation, whatever its amount`; `:: no variance posting reaches 5950 or 5960 on either agency path` |
| DD-2 | Owner-configurable threshold, 30 days initially; notification only; reclassification needs evidence and an independent actor | `deposit-ageing-and-recovery.test.ts :: nothing posts at the ageing threshold; a notification is raised` |
| DD-3 | partial verified returns; remainder under investigation; duplicate recovery structurally impossible; A-7 unchanged | `deposit-ageing-and-recovery.test.ts :: cumulative verified returns can never exceed the deposit amount` |
| DD-4 | receivable only on a documented, legally enforceable claim, Owner-authorized and independently reviewed; no salary deduction | `cash-investigation.test.ts :: no receivable is created by default, by inference or by a Manager`; `:: no salary-deduction path exists` |
| DD-5 | loss by one Owner who did not open the investigation; completed investigation, evidence, reason, immutable audit, material-loss reporting | `cash-investigation.test.ts :: a loss requires a completed investigation, an Owner who did not open it, evidence and a reason`; `:: no automatic path reaches 5110` |

### 8.6 The accounting integrity controls

| Control | Test |
| --- | --- |
| An investigation posting moves its suspense balance **towards zero** | `cash-investigation.test.ts :: O1, O2, O3 each extinguish 2900 and recognize no expense` — the regression test for the v1 direction error |
| A correction alone never creates a negative balance | `cash-difference-resolution.test.ts :: a correction with no intervening outflow leaves no negative balance` |
| A correction-revealed negative is an **overage** | `:: a correction-revealed negative produces an overage, not a shortage` |
| Resolution brings the cash account to the counted balance exactly | `:: resolution brings the cash account to the counted balance exactly` — the seven worked examples replayed as fixtures |
| The four new accounts carry no `cash_kind`; both liquidity identities hold | `:: 1190, 1195, 2900 and 5110 carry no cash_kind` |
| Borrower repayments preserved throughout a shortage | `borrower-protection.test.ts :: a cash shortage leaves every loan balance, arrears figure, installment outcome and deadline identical` |
| Historical journals never move | `borrower-protection.test.ts :: every D-2 posting is a new entry; no historical line moves` |
| Reconciliation locking and staleness | `cash-difference-concurrency.test.ts :: a count racing a posting`; `cash-difference-resolution.test.ts :: a stale system_balance is refused` |

### 8.7 Release certification

`npm run verify`, `npm run test:db`, `npm run audit:money`, the database
security gate, `scripts/certify-financial-reconciliation.mjs` with its sum
identity extended for `in_transit`, migrations-on-empty, the full historical
replay with every tracked fixed point compared, the PostgreSQL 17 rehearsal,
browser E2E on a fresh seed, and **all four required GitHub jobs green at the
final audited code SHA**. Migration ordering verified independently against
PR #19. No test weakened to achieve green; green CI is not permission to merge.

---

## 9. Consolidated remaining-blocker register

Every open item, in one place. Nothing below is approved, assumed or in progress.

### 9.1 Blocking — development cannot start

| ID | Blocker | Owner | Document |
| --- | --- | --- | --- |
| **B-1.1** | is `1190` acceptable as an interim suspense balance within a period? | accountant | B-1 §9 |
| **B-1.2** | treatment of an open `1190` balance **at a reporting date** — Alternative A, B, C or D; if C, confirm `1191` and its presentation | accountant | B-1 §8.3, §9 |
| **B-1.3** | is `2900` acceptable as a liability while a counterparty is only possible? | accountant | B-1 §9 |
| **B-1.4** | when does an unidentifiable overage become income, **which account** receives it, and **who authorizes** it? No destination is proposed | accountant | B-1 §6.2, §9 |
| **B-1.5** | do DD-4's criteria satisfy the receivable recognition test for `1195`? | accountant | B-1 §9 |
| **B-1.6** | is DD-5's single-Owner authorization sufficient control for `5110`? | accountant | B-1 §9 |
| **B-1.7** | is the period-end procedure sufficient, given its close step is a **manual control**? | accountant | B-1 §8, §9 |
| **B-1.8** | should the reconciliation adjustment be dated **when posted** rather than back-dated to the count? | accountant | B-1 §8.2, §9 |
| **B-1.9** | should **gain** recognition require authorization comparable to DD-5's for a loss? | accountant | B-1 §9 |
| **B-2.1** | remove the variance write-off from all **three** approval paths | implementation | B-2 §2 |
| **B-2.2** | add the missing account lock to both lending reconciliation functions (**D2-b**) | implementation | B-2 §2 |
| **B-2.3** | add the missing stale-balance validation to the lending path | implementation | B-2 §2.2 |
| **B-2.4** | **NEW: the lending `approve_reconciliation` has no maker-checker at all** — the officer who counted may approve their own count. The agency twin refuses it in two places; the lending path in neither | implementation | B-2 §2.2, §9 |
| **B-2.5** | add branch authorization to both lending reconciliation functions | implementation | B-2 §2 |

B-2.6 and B-2.7 are the same work gated on B-1.8 and B-1.1–B-1.4; B-2.8 is
gated on plan step 5a.

### 9.2 Required but not blocking the first phase

| ID | Item | Document |
| --- | --- | --- |
| **B-1.E / B-2.9** | **no `finance-evidence` storage bucket exists.** The six existing buckets are client, guarantor, loan, membership-consent, benefit and company-assets; clearance slips, physical-return, reclassification, correction, claim and loss evidence all need one | B-1 §10, B-2 §9 |
| **O-C1** | the evidence standard that establishes C1 — that a payment never occurred | plan §15 |
| **O-HDR** | the header-visibility rule for a cross-branch journal entry whose lines span two branches | plan §15 |
| **O-A10** | A-10's reach into savings qualification, member-loan capacity and benefit gates — **not** inferred | plan §15 |
| **O-CONT** | operational continuity while the fail-closed attempt log is unavailable | plan §15 |
| **O-BATCH** | batch-confirmation granularity | plan §15 |
| **O-SHORT** | whether a plain count shortage blocks its account — this certification says **no**, because the account is physically accurate | D-2 §9.4 |
| **O-S2** | the ordering rule that refuses a correction against an already-flagged account | D-2 §4.3 |
| **O-MAT** | DD-5's materiality figure for loss reporting | D-2 §11.3 |
| **O-AGE** | the `1190`/`2900` ageing report | D-2 §11.3 |
| **O-ADR** | seven new ADRs, from ADR-072 | plan §15 |

### 9.3 Independent of Decision A

| Item | Note |
| --- | --- |
| **No accounting-period concept exists** — no period, no close, no reopen, no restriction on an entry's date; three existing paths accept an unbounded caller date | A separate, unscheduled workstream. **B-1.7 compounds it:** the period-end close is a manual control until it is built |
| Production blockers | the Git-linked Supabase branch reporting `MIGRATIONS_FAILED`; GitHub protections; deploy access and custom domain; backup and recovery; provider commercial terms; Decision L; membership policy activation |

---

## 10. Preserved, and not done

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
