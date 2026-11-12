# POLYTOS — Decision A, Dependency D-2: Accounting Architecture Review

**Scope:** the formal resolution of a flagged cash account, and the accounting
treatment of shortages, recoverable amounts and genuine losses — including
failed, bounced and indefinitely unresolved bank deposits.
**Status:** documentation-only review. **No implementation authorization.**
Stops at the review gate.
**Type:** no migration, application code, test, financial record, deployment
configuration or PR branch touched.
**Reviewed at:** PR #27 head (`phase4e/mobile-money-2026-11-09`, 214 migrations).
**Parents:** `docs/POLYTOS-DECISION-A-IMPLEMENTATION-PLAN.md` v4 (A-1…A-13,
C1–C7, D-1, D-3); `docs/POLYTOS-DECISION-A-TECHNICAL-REVIEW.md` v4.
**Standing constraint:** *missing money is not automatically a loss, a staff
liability or a borrower debt.* Every design choice below is tested against it.
**Production:** NO-GO. Draft PRs #25–#27 untouched.

---

## 1. The finding that shapes everything else

**A booking-error correction cannot, by itself, drive a cash account negative.**

Work it through. A till holds 80,000. A receipt of 100,000 is keyed although no
payment occurred: booked 180,000, physical 80,000. Genuine payouts of 60,000
follow: booked 120,000, physical 20,000. The correction contras the fictitious
receipt: booked 20,000, **physical 20,000**. The books and the drawer agree and
nothing is negative.

A negative can only appear if **more has been recorded as leaving the account
than ever legitimately entered it** — and that is not something the correction
did. It is a *second, independent irregularity* that the correction has
revealed, and it is always one of four things:

| # | Finding | What it means | Resolution |
| --- | --- | --- | --- |
| **F1** | an **unrecorded inflow** exists | real money came in and was never booked | record it, with evidence. No loss |
| **F2** | a **recorded outflow never happened** | a second booking error, on the way out | correct that entry too. No loss |
| **F3** | an **unrecorded transfer** funded the payouts | cash came from another till or account | record the transfer. No loss |
| **F4** | cash is **genuinely missing** | it entered and left without authorization | §6 — and only here does loss or recovery arise |

**Three of the four findings involve no loss at all.** So the formal resolution
of condition C5 is not a decision about who bears a loss; it is an
**investigation with four possible outcomes**, and the accounting must hold the
difference neutrally until the investigation says which one it is. That is
exactly what the standing constraint demands, and it is why §4 parks the amount
on the balance sheet rather than in the income statement.

### 1.1 The two money-gone events are structurally different

| | **Incorrectly recorded receipt** | **Genuinely received, now missing** |
| --- | --- | --- |
| What happened | the payment never occurred | the payment occurred; the cash left unlawfully or unaccountably |
| Who detects it | a correction request with evidence of non-occurrence | the **physical count** at reconciliation |
| Mechanism | `correct_misrecorded_receipt` — exact contra (approved C1–C7) | reconciliation variance → investigation (§4, §6) |
| Borrower record | correctly restored: they never paid | **untouched. They paid** (C6, A-10) |
| Can it reach the correction path? | yes, and only it | **no — refused by C6** |

Condition **C6** is the wall between them: *a genuine customer payment must
never be reversed merely because staff subsequently lost or misappropriated the
cash.* A customer who paid has paid. The business's loss is the business's, and
it is never recovered by re-indebting the customer. §8 states how that is
enforced and tested.

---

## 2. What exists today, and the two defects in it

### 2.1 Reconciliation already auto-expenses every approved variance

`approve_reconciliation` (`20261011000230_money_movement_income.sql:285`) posts,
unconditionally:

```
shortage (variance < 0):   Dr 5950 Cash Over and Short / Cr the counted account
overage  (variance > 0):   Dr the counted account      / Cr 5950
```

So **every** approved difference becomes an expense or a credit to expense the
moment it is approved, whatever its size and whatever caused it. For a 2,000
rounding difference that is right. For a 700,000 shortage under investigation it
is precisely the premature loss recognition the standing constraint forbids, and
it also contradicts A-7's *"no automatic variance or loss journal"*.

**Defect D2-a.** There is one destination for a variance and no way to say "this
is not yet a loss".

### 2.2 The reconciliation path takes no account lock

The lending `approve_reconciliation` calls neither `lock_ledger_balances` nor
any sufficiency assertion, while its agency twin
`approve_agency_cash_reconciliation` calls both. Already recorded as review
finding **H5**; repeated here because D-2's resolution posting runs on this path
and inherits the gap.

**Defect D2-b.** The resolution journal would be written without the lock every
other posting path now takes.

### 2.3 What is sound and is reused unchanged

The count itself. `account_reconciliations` freezes `system_balance` and
`counted_balance`, generates `variance`, enforces one count per account per
business date, and keeps the ledger untouched until an explicit authorized
journal is written — *"the ledger is never edited to make the two agree"*. The
maker-checker (`reconciliation:perform` / `reconciliation:approve`) and the
append-only document discipline are all reused.

---

## 3. Chart of accounts — collisions checked

Every code below was checked against the full chart at the PR #27 head.

| Code | Status at #27 head |
| --- | --- |
| `5950` | **taken** — Cash Over and Short (count variances) |
| `5960` | **taken** — Agency Float Over and Short |
| `5970` | **taken** — Agency Float Purchase Premium |
| `1050-<branch>` | free; reserved by the plan for Cash in Transit |
| `1090`, `1095`, `1190`, `1195`, `2900`, `5110`, `5240`, `5300` | **all free** |

So the v1 proposal of `5960 Deposit Losses Under Investigation` **would have
collided**, and `5970` is taken too. The codes proposed here avoid all three.

### 3.1 Proposed accounts

| Code | Name | Type / side | Purpose |
| --- | --- | --- | --- |
| **`1190`** | Cash Differences Under Investigation | asset, debit | A measured, authorized, **unexplained shortfall** parked on the balance sheet while investigated. A debit balance is money unaccounted for. **Never an expense, never attributed to a person.** |
| **`2900`** | Cash Overages Under Investigation | liability, credit | The mirror: money found that the books cannot explain. A credit balance is an obligation to account for it. Kept separate from `1190` so each always carries its natural sign and the trial balance reads straight — the schema's `ledger_accounts_side_matches_type` discipline |
| **`1195`** | Cash Recovery Receivable | asset, debit | Created **only** when an investigation establishes an enforceable, documented claim — an acknowledgement, an insurer, a bond. **Not created by default** (§6.3) |
| **`5110`** | Cash and Deposit Losses | expense, debit | Recognized **only** on explicit Owner authorization after an investigation concludes nothing is recoverable. Deliberately **not** `5950`: a count variance and an investigated loss are two different facts, and sharing a code is how a report comes to overstate one of them — the reasoning `4340` already records |

`1190` and `2900` sit under a new `1000`-series grouping if one is wanted;
`1195` sits beside `1200 Loans Receivable`; `5110` under the `5000` heading,
clear of the `5200` benefits block.

**Why `1190` is an asset and not a contra-cash account.** The shortfall is a
claim whose substantiation is unknown — possibly F1/F2/F3 (an accounting fact to
be found) and possibly F4 (money to be recovered or lost). An asset that reads
"unaccounted for" is truthful in all four cases. Putting it in the income
statement asserts F4 and asserts it is unrecoverable, which is two unapproved
conclusions at once.

---

## 4. Reconciliation and the formal resolution of a flagged account

### 4.1 The three steps, and what each does and does not decide

| Step | Act | Posts | Decides |
| --- | --- | --- | --- |
| **1** | **Independent count** — `submit_reconciliation`, with the account locked (closing D2-b) | nothing | what is physically there |
| **2** | **Approval of the count** by a different person, `reconciliation:approve` | nothing | that the count is accepted as evidence |
| **3** | **Formal resolution** — an authorized journal moving the difference to `1190` or `2900`, bringing the cash account to the counted balance, and clearing `requires_reconciliation` | one entry, balance sheet only | **nothing about cause or blame** |

Step 3 is what C5 means by *"formally resolved"*, and it is deliberately
**classification-free**. Its whole job is to restore the cash account to
physical truth so the branch can trade again, while keeping the unexplained
amount visible and named.

```
shortage:  Cr the cash account  /  Dr 1190     (books come down to the count)
overage:   Dr the cash account  /  Cr 2900     (books come up to the count)
```

### 4.2 Why step 3 is not a payout, and why that is not a loophole

The shortage posting *credits* a cash account, which §8 of the plan would
otherwise treat as an outgoing path requiring available funds. It is exempt, on
the same doctrine as the correction and for the same three reasons:

1. **No value leaves the business.** The amount moves from one asset to another.
2. **Nothing is arbitrary.** The amount must equal the **approved variance** of
   the named reconciliation, the two accounts are fixed by the reconciliation
   row, and the function takes no amount, no account and no recipient.
3. **Requiring sufficiency would be circular.** The account is short precisely
   because money is missing; a sufficiency check would make the shortfall
   permanently unresolvable and keep the branch blocked forever.

And the exemption cannot be reached from a payout: `resolve_cash_difference`
accepts only a reconciliation id, is refused unless that reconciliation is
`approved` with a non-zero variance, and is refused if a resolution entry
already exists for it. **A-4 is untouched** — no genuine outgoing transaction
gains anything (§9).

### 4.3 Clearing the block

`requires_reconciliation` clears **only** on a successful step 3, which by
construction required steps 1 and 2. So C5's two conditions — *independently
reconciled* **and** *formally resolved* — are both structurally necessary, and
neither alone suffices. A later difference flags the account again.

### 4.4 A tolerance, so small variances stay simple

Defect D2-a is closed by giving the variance **two possible destinations** and a
rule for choosing:

| Variance | Destination | Authorization |
| --- | --- | --- |
| at or below a configured tolerance | `5950`, as today | `reconciliation:approve`, as today |
| above the tolerance | **`1190` / `2900`**, under investigation | `reconciliation:approve` **and** an investigation opened |

The tolerance is a new setting and a **new business decision** (§10, DD-1). With
it, a till that is 500 out at close is still a one-step close; a till that is
700,000 out can no longer be expensed away by one approval.

---

## 5. Failed, bounced and indefinitely unresolved bank deposits

A-8 is already approved and the plan implements it: a refused deposit goes to
`under_investigation`, **posts nothing**, and the money stays in
`1050 Cash in Transit`, which is where it honestly is. What D-2 adds is what
happens when that state does not end.

### 5.1 The ageing problem

`1050` means *"money between the till and the bank"*. A deposit that has sat
unresolved for months is no longer in transit in any meaningful sense, and
leaving it there quietly overstates a plausible asset and understates the
problem. But moving it out too early asserts a loss.

**Proposal.** After a configured ageing threshold, an **authorized
reclassification**, not an automatic one:

```
Dr 1190 Cash Differences Under Investigation  /  Cr 1050 Cash in Transit
```

The deposit's status becomes `aged_unresolved`; `1050` returns to meaning only
genuine transit; the amount stays an unexplained asset, not a loss; and the
deposit record keeps its whole history. Requires `deposits:verify`, a reason and
evidence of the attempts made. The threshold is a **new business decision**
(§10, DD-2).

### 5.2 Recovery of cash physically returned to the till

Already approved and specified (A-8, plan §6.3): `confirm_physical_cash_return`
posts `Dr till / Cr 1050` **only** on documented, independently verified
physical receipt, and refuses the deposit's own recorder.

Two D-2 additions:

- **A return after reclassification.** If the cash comes back after §5.1 moved
  the amount to `1190`, the posting is `Dr till / Cr 1190`, not `Cr 1050` —
  otherwise `1050` would go negative and the two accounts would disagree with
  the deposit's state. The function reads the deposit's current status and
  credits whichever account holds the money.
- **A partial physical return.** Possible in reality — 600,000 of an 800,000
  deposit comes back. The deposit is **not** a clearance (A-7's full-or-nothing
  governs *clearance*, not recovery), so a partial return is permitted, posts
  the returned amount, and leaves the remainder under investigation. Whether to
  allow partial recovery at all is a **new business decision** (§10, DD-3);
  refusing it would mean the business cannot bank money it has physically got
  back.

### 5.3 The states, end to end

| Status | Money sits in | Posted on entry |
| --- | --- | --- |
| `submitted` | `1050` | Dr `1050` / Cr till |
| `cleared` | the bank account | Dr bank / Cr `1050` |
| `under_investigation` | `1050` | **nothing** |
| `returned_to_till` (full or partial) | the till | Dr till / Cr `1050` or `1190` |
| `aged_unresolved` | `1190` | Dr `1190` / Cr `1050` |
| `written_off` | — | Dr `5110` / Cr `1190` — **§6.4, Owner only** |
| `reversed` | `1050` | Dr `1050` / Cr bank |

No status transition writes off, returns or recognizes anything automatically.

---

## 6. Shortages, recoverable amounts and genuine losses

### 6.1 The default is neutral, and it has no time limit

An amount in `1190` is **unexplained**, not lost. It stays there, visible and
aged, until an investigation concludes. Nothing expires it, nothing sweeps it,
and no scheduled job reclassifies it. That is the direct implementation of the
standing constraint.

### 6.2 Closing an investigation — four findings, four postings

| Finding | Posting | Authorization |
| --- | --- | --- |
| **F1** unrecorded inflow found | Dr `1190` / Cr the correct income, liability or receivable leg — the receipt it should always have been | `finance:correct` + second actor + evidence |
| **F2** recorded outflow never happened | correct **that** entry under C1–C7; the resulting movement clears `1190` | as C1–C7 |
| **F3** unrecorded transfer | record the transfer; it clears `1190` against the other account | `transfers:create` + the existing approval rules |
| **F4** genuinely missing | §6.3 or §6.4 | Owner |

F1–F3 need **no new accounts and recognize no loss**. They are the expected
majority, which is why §1's four-finding framing matters more than the loss
accounting it leads to.

### 6.3 Recoverable (F4, recoverable)

Only where the investigation establishes a **documented, enforceable claim**:

```
Dr 1195 Cash Recovery Receivable  /  Cr 1190
```

**It is not created by default, and never by inference.** The standing
constraint forbids assuming staff liability, so a receivable naming a person
requires, at minimum, a documented acknowledgement or a determination through
the business's own disciplinary and legal process — which is outside this system
and outside Decision A. **What constitutes an enforceable claim is a new
business decision** (§10, DD-4), and it is the one with employment-law exposure.

Recovery then: `Dr till or bank / Cr 1195`. A claim that later proves
uncollectable moves to §6.4 with its own authorization — it does not quietly
expire.

### 6.4 Genuine loss (F4, unrecoverable)

```
Dr 5110 Cash and Deposit Losses  /  Cr 1190   (or Cr 1195 for a failed claim)
```

Requires: an investigation formally concluded; `deposits:reverse`-grade
authority, i.e. **Owner only**; a mandatory reason; documented evidence; a
notification; and an audit entry naming the authorizer and the amount. It is the
only posting in this review that touches the income statement, and it is the
only one that cannot be reached without an explicit Owner act.

**No automatic path leads here.** Not ageing, not a threshold, not a failed
recovery, not the close of a period.

---

## 7. Evidence, verification, authorization and audit

| Act | Evidence | Independent verification | Authorization | Audit |
| --- | --- | --- | --- | --- |
| Count (step 1) | counted figure, counter's name | — | `reconciliation:perform` | existing |
| Approve count (step 2) | explanation | **different person** from the counter | `reconciliation:approve` | existing |
| Formal resolution (step 3) | the approved reconciliation | implied by step 2 | `reconciliation:approve` | new event, with the destination account |
| Open investigation | reason | — | `reconciliation:approve` or `deposits:verify` | new event |
| Aged reclassification (§5.1) | record of attempts | — | `deposits:verify` | new event |
| Physical return (§5.2) | **document of actual receipt** | **different person from the deposit's recorder** | `deposits:verify` | existing (A-8) |
| F1/F3 resolution | the source document | second actor | `finance:correct` / `transfers:create` | existing |
| Create receivable (§6.3) | **documented enforceable claim** | second actor | **Owner** | new event, naming the counterparty |
| Recognize loss (§6.4) | investigation conclusion | second actor | **Owner only** | new event, naming authorizer and amount |

Two structural requirements:

- **Distinct-actor rules at both layers** — a CHECK constraint and a function
  raise — as every other second-actor rule in this codebase is enforced. In
  particular the Owner who authorizes a loss may not be the person who opened
  the investigation.
- **A `finance-evidence` storage bucket does not exist.** The six existing
  buckets are `client-documents`, `guarantor-documents`, `loan-documents`,
  `membership-consent`, `benefit-documents` and `company-assets`. One is needed,
  with its own RLS policies, on the pattern of
  `20261022000300_benefit_document_storage.sql`. Carried in the plan's open
  items.

---

## 8. Borrower repayments and historical journals

**Nothing in D-2 touches a borrower record, and nothing can.**

| Protection | How |
| --- | --- |
| A cash shortage never re-indebts a borrower | C6; `correct_misrecorded_receipt` refuses a receipt whose payment occurred; no function in this review reads or writes `loan_payments`, `payment_allocations` or any loan status |
| Repayment recognition is unchanged | A-10: recognition at recording, on the recorded date; `loan_payments.status = 'posted'` throughout |
| The guard stays intact | `loan_payments_guard_mutation` permits exactly one transition, `posted → reversed`; D-2 adds no transition and no column |
| Historical journals never move | `journal_lines` refuses UPDATE and DELETE; `journal_entries_guard_update` permits only `reversed_by_entry_id`. Every D-2 posting is a **new** entry |
| Period integrity | every D-2 entry is dated `business_date()`; nothing is backdated (A-6) |
| The certified identities hold | `1190`, `1195`, `2900` and `5110` carry **no `cash_kind`**, so `branch_cash_position` and `total_liquidity` are untouched and both liquidity identities stay green. This is why the shortfall is parked in a non-cash account rather than a sixth cash kind |

That last row is the quiet one that matters: parking the difference in a
cash-kinded account would have reopened finding B2 and broken three suites.

---

## 9. No-override sufficient funds

| Claim | Why it holds |
| --- | --- |
| No new capability overrides sufficiency | `reconciliation:approve`, `deposits:verify`, `finance:correct` and the Owner loss authority each gate a **reclassification**, never a payout |
| No new setting overrides sufficiency | the tolerance (DD-1) and the ageing threshold (DD-2) change *classification* and *timing*, not whether funds must exist. D-2 adds no `allow_*` flag |
| The exemptions cannot be reached from a payout | each exempt function accepts only a document id, derives its amount and accounts from that document, and takes no amount, account or recipient |
| A flagged account cannot pay out | every outgoing path is refused while `requires_reconciliation` stands |
| An exempt function cannot pay anybody | asserted directly by test |

The doctrine, stated once: **sufficiency governs value leaving the business.**
A reclassification between the business's own accounts, for an amount fixed by
an approved document, is not that — and it is made structurally incapable of
becoming that.

---

## 10. New business decisions for Product Owner approval

Five. Each has options and a recommendation; none is decided here.

### DD-1 — The reconciliation variance tolerance

| Option | Consequence |
| --- | --- |
| **A. A configured absolute tolerance** (e.g. 5,000 per account per count) | small differences close in one step as today; larger ones must be investigated. Simple to explain and to audit |
| B. A percentage of the account's balance | scales with the account, but a quiet till gets a tiny tolerance and a busy one a large allowance — the opposite of prudent |
| C. No tolerance: every variance goes to `1190` | maximally conservative, and it turns every 200-shilling rounding difference into an investigation. Operationally unworkable |
| D. Keep today's behaviour: everything to `5950` | **not available** — contradicts A-7 and the standing constraint |

**Recommendation: A**, as a single Owner-settable amount per cash kind, defaulting
low. It is the only option that is both prudent and workable, and a per-kind
figure recognizes that a bank account should tolerate almost nothing while a
busy till tolerates a little.

### DD-2 — The ageing threshold for an unresolved deposit

| Option | Consequence |
| --- | --- |
| **A. A configured number of days** (e.g. 30), then an authorized reclassification to `1190` | `1050` keeps meaning transit; the amount stays visible and unclassified; a human still has to act |
| B. No threshold — it stays in `1050` indefinitely | `1050` silently accumulates things that are not in transit, and the figure stops meaning anything |
| C. Automatic reclassification on the threshold | removes the human act, which is the one thing that should not be automated here |

**Recommendation: A**, with the reclassification **prompted** by a notification
and **performed** by a person. Thirty days is a starting proposal, not a finding.

### DD-3 — Partial physical return of a deposit

| Option | Consequence |
| --- | --- |
| **A. Permit partial returns**; the remainder stays under investigation | the business can bank what it has actually got back, and the residue stays visible |
| B. All-or-nothing, mirroring A-7 | consistent-sounding, but A-7 governs *clearance* by the bank, not *recovery* of physical cash. It would force the business to refuse money in hand |

**Recommendation: A.** A-7's full-or-nothing rule exists because a bank either
honoured a deposit or did not; recovering physical cash has no such binary.

### DD-4 — What constitutes an enforceable claim (`1195`)

| Option | Consequence |
| --- | --- |
| **A. A documented acknowledgement, or a determination through the business's own disciplinary/legal process, or an insurer's or bond issuer's admission** | no receivable is raised against anybody on suspicion; the system records an outcome reached elsewhere |
| B. A Manager's assessment that it is recoverable | fast, and it makes the ledger an accusation. Employment-law exposure, and it breaches the standing constraint in substance if not in form |
| C. Never raise a receivable; everything unrecovered becomes a loss | simple, and it writes off money that is actually coming back, understating assets and overstating expenses |

**Recommendation: A.** This is the decision with real legal exposure, and it
should be taken with whoever advises the business on employment matters. Until
it is taken, the implementable default is that **no receivable is created** and
amounts stay in `1190`.

### DD-5 — Who may authorize a loss, and is a second Owner needed

| Option | Consequence |
| --- | --- |
| **A. One Owner, who must not be the person who opened the investigation** | matches every other second-actor rule here and is workable in a business with one or two Owners |
| B. Two Owners | stronger, and unworkable if the business has one Owner — the control would simply never be exercisable |
| C. A Manager above a threshold, an Owner above it | introduces a threshold into a decision that is about finality, not size |

**Recommendation: A**, with a materiality threshold above which the loss also
appears on a report the Owner signs periodically — control through visibility
rather than through a second signature that may not exist.

---

## 11. Proposed tests

All new; **none written** under this authorization.

### 11.1 PostgreSQL — `tests/db/cash-difference-resolution.test.ts`

- `a booking-error correction with no intervening outflow leaves no negative balance` — §1's arithmetic, asserted.
- `a correction that reveals a shortfall flags the account`.
- `an approved count alone does not clear the flag`.
- `formal resolution brings the cash account to the counted balance exactly`.
- `formal resolution posts to 1190 for a shortage and 2900 for an overage`.
- `formal resolution clears the flag, and a later difference flags it again`.
- `a variance at or below tolerance still posts to 5950` (DD-1).
- `a variance above tolerance may not be posted to 5950`.
- `resolution refuses a reconciliation that is not approved`.
- `resolution refuses a second resolution of the same reconciliation`.
- `resolution takes no amount, account or recipient argument`.
- `resolution cannot pay anybody` — no cash leg other than the fixed pair.
- `resolution is refused when the variance is zero`.
- `1190, 1195, 2900 and 5110 carry no cash_kind` — the §8 identity protection.
- `total_liquidity and branch_cash_position are unchanged by every D-2 posting`.

### 11.2 PostgreSQL — `tests/db/cash-investigation.test.ts`

- `F1: an unrecorded inflow clears 1190 with no expense`.
- `F2: correcting an overstated outflow clears 1190 with no expense`.
- `F3: recording the missing transfer clears 1190 with no expense`.
- `an amount in 1190 never expires, and no job sweeps it`.
- `creating a receivable requires Owner authorization and documented evidence`.
- `no receivable is created by default or by inference` (standing constraint).
- `recognizing a loss requires Owner authorization, a reason and evidence`.
- `no automatic path reaches 5110` — asserted over ageing, thresholds, failed
  recovery and period close.
- `the Owner who opened the investigation cannot authorize its loss` (DD-5).
- `a recovery posts against 1195 and not against income`.
- `5110 is distinct from 5950, 5960 and 5970 and none is used for the others`.

### 11.3 PostgreSQL — `tests/db/deposit-ageing-and-recovery.test.ts`

- `an unresolved deposit stays in 1050 until authorized reclassification`.
- `reclassification posts Dr 1190 / Cr 1050 and requires evidence of attempts`.
- `no automatic reclassification occurs at the threshold` (DD-2).
- `a physical return after reclassification credits 1190, not 1050`.
- `a partial physical return posts the returned amount and leaves the remainder` (DD-3).
- `1050 never goes negative through any recovery path`.
- `the deposit recorder cannot confirm its own physical return`.
- `an aged or written-off deposit is never reported as returned`.

### 11.4 PostgreSQL — `tests/db/borrower-protection.test.ts`

- `a cash shortage leaves every loan balance, arrears figure and deadline identical`.
- `a correction is refused where the payment occurred` (C6).
- `no D-2 function reads or writes loan_payments or payment_allocations` — asserted over the function bodies.
- `loan_payments_guard_mutation is unchanged and still permits one transition`.
- `every D-2 posting is a new entry; no historical line moves`.
- `every D-2 entry is dated business_date()`.

### 11.5 RLS — `tests/db/rls-cash-difference.test.ts`

Under the D-1 grant model:
- `anon is denied on every new table and view`.
- `an unassigned non-Owner profile cannot read or resolve a difference`.
- `a branch-granted profile sees only its branches' differences`.
- `a Head Office officer reaches only granted branches`.
- `reading 1190 and 1195 requires ledger:view and a branch grant`.
- `no INSERT, UPDATE or DELETE grant exists on the new tables`.
- `loss authorization is refused to a Manager`.
- `direct Data API and raw RPC attempts are refused`.

### 11.6 Concurrency — `tests/db/cash-difference-concurrency.test.ts`

Real parallel connections, on PR #25's advisory-lock harness so the journal
reference counter cannot create a false pass:
- `two resolutions of one reconciliation: exactly one succeeds`.
- `a resolution racing a payout from the same account`.
- `a count racing a posting into the same account` — closing defect D2-b.
- `a physical return racing a reclassification of the same deposit`.
- `a loss authorization racing a recovery on the same 1190 balance`.
- `the lock-order probe over the cash account + 1190, in both orders`.
- Each case holds **only** the account's advisory lock, posts nothing, takes no
  reference, and distinguishes *refused* from *walked past*.

### 11.7 Browser — `tests/e2e/specs/cash-difference.write.spec.ts`

- a flagged account shown as blocked, with every payout button disabled and the
  server still refusing when the form is bypassed;
- the resolution screen showing the counted figure, the variance and the
  destination account, and requiring the approved count;
- an investigation register showing `1190` ageing, with no "write off" action
  available to a Manager;
- a loss authorization available only to an Owner, demanding a reason and a
  document;
- a deposit shown as `aged_unresolved` and never as returned or written off;
- borrower screens showing an unchanged balance throughout a shortage;
- `@axe-core/playwright` and responsive passes on every new screen.

### 11.8 Certification

`npm run verify`, `npm run test:db`, `npm run audit:money`, the database
security gate, `scripts/certify-financial-reconciliation.mjs` — whose identities
**must still pass unchanged**, since no D-2 account carries a `cash_kind` — the
historical replay with identical fixed points, and all four required CI jobs
green at the final audited code SHA.

---

## 12. What this review does not do

- **It implements nothing.** No migration, code, test, chart row or setting
  exists as a result of it.
- **It decides none of DD-1…DD-5.** Options and recommendations only.
- **It does not reopen A-1…A-13, C1–C7, D-1 or D-3.**
- **It does not conclude that any money is lost**, owed by any person, or owed
  by any borrower. The default state it proposes is "unexplained", with no time
  limit and no automatic exit.
- **PRs #19–#27 are untouched**; no hosted data was read or modified.
- **Production remains NO-GO.**

Development remains unauthorized. D-2 closes when DD-1 through DD-5 are decided.
