# POLYTOS — Blocker B-1: Qualified-Accountant Review Package

**For:** the qualified accountant advising the business.
**From:** the Decision A technical review. **This package proposes; it does not
determine.** Nothing in it is an accounting opinion, and no treatment described
here is adopted until you approve it in writing.
**Subject:** the proposed treatment of four new ledger accounts — `1190`,
`2900`, `1195`, `5110` — and the period-end procedure that governs them.
**Status:** documentation only. The accounts do not exist; no migration, code or
posting has been created. **Production is NO-GO** and development is withheld
pending your written approval of the decisions in §9.
**Framework assumed:** IFRS / IFRS for SMEs, as applied by a Ugandan reporting
entity. If the business reports under a different framework, say so and this
package is re-worked.
**Companion documents:** `docs/POLYTOS-DECISION-A-D2-ACCOUNTING-REVIEW.md` (the
full technical certification, with seven worked examples) and
`docs/POLYTOS-DECISION-A-B2-TECHNICAL-ACCEPTANCE-CHECKLIST.md`.

---

## 1. What the business is trying to solve

A microfinance business takes cash at a counter, pays out loans, savings
withdrawals and benefits, and banks its surplus. Three things can go wrong with
cash, and the business currently has one accounting response to all three.

| What happened | Today's accounting response |
| --- | --- |
| a receipt was keyed although **no payment was ever received** | no mechanism; the fiction stays on the books |
| a payment **was** received and the cash is **now missing** | the daily count produces a difference, and **the whole difference is expensed immediately** to `5950 Cash Over and Short` |
| a bank deposit **bounced or was refused** | no mechanism; the money is treated as though it reached the bank |

The Product Owner has ruled that the second response is wrong: an unexplained
difference must be **investigated**, not expensed on one person's approval, and
— the governing instruction for this whole exercise —

> **missing money is not automatically a loss, a staff liability or a borrower
> debt.**

That ruling creates an accounting question the business cannot answer by itself,
and it is the reason for this package: **where does an unexplained cash
difference sit, and for how long, before it is either substantiated or
recognized?**

---

## 2. The single most important fact for your assessment

**Most unexplained differences turn out not to be losses.**

A difference is always one of eight findings, determined by whether the books
show *more* cash than exists (a shortage) or *less* (an overage):

| | Finding | Is it a loss? |
| --- | --- | --- |
| S1 | a genuine payment was made and never recorded | **no** — record the payment |
| S2 | a receipt was recorded for more than arrived, or twice | **no** — correct the receipt |
| S3 | cash was moved to another till and never recorded | **no** — record the transfer |
| **S4** | **cash was received and is genuinely gone** | **possibly** — §6, §7 |
| O1 | a receipt arrived and was never recorded | **no** — record the receipt |
| O2 | a payment was recorded for more than was paid | **no** — correct the payment |
| O3 | cash arrived from another account unrecorded | **no** — record the transfer |
| O4 | a surplus nobody can explain | **possibly income** — §6.2 |

**Six of the eight are bookkeeping errors with no profit-or-loss effect at all.**
Expensing a difference on the day it is found therefore recognizes a loss that,
in most cases, does not exist — and then has to be reversed when the cause is
found, with the reversal landing in whatever period it happens to fall in.

That is the practice the business is trying to stop, and it is why the proposal
below puts the difference on the balance sheet **while it is being
investigated**. The question for you is what happens to that balance when a
reporting date arrives before the investigation ends.

---

## 3. The four proposed accounts

| Code | Name | Proposed type | What it would hold |
| --- | --- | --- | --- |
| **`1190`** | Cash Differences Under Investigation | asset, debit | a measured, authorized, **unexplained shortage** while it is investigated |
| **`2900`** | Cash Overages Under Investigation | liability, credit | the mirror: an unexplained surplus |
| **`1195`** | Cash Recovery Receivable | asset, debit | an amount the business has a **documented, legally enforceable right** to receive |
| **`5110`** | Cash and Deposit Losses | expense, debit | a loss, recognized **only** on explicit Owner authorization after an investigation concludes. **Whether a mandatory reporting-date charge may also land here is B-1.10** |
| **`1191`** | Allowance for Unrecovered Differences | contra-asset, credit | **only if** you choose Alternative C (§8.3). Code verified free |

Two existing accounts are affected: `5950 Cash Over and Short` and
`5960 Agency Float Over and Short` would **stop receiving automatic postings**
and keep only their historical balances. `5110` is deliberately a separate code
from `5950`, so that "a counted difference written off on the day" and "an
investigated loss formally authorized" are never summed into one figure.

**None of the four accounts is a cash account.** They are not included in the
business's cash position, its liquidity reporting, or any "funds available to
spend" figure. This matters operationally as much as accounting: an amount in
`1190` can never be spent.

---

## 4. The crux: interim bookkeeping versus financial-statement recognition

This is the question this package exists to put to you, and the technical
review's own position is that **it cannot be answered by the technical team.**

### 4.1 Within a reporting period

`1190` and `2900` are used the way a **suspense or clearing account** is
ordinarily used: a measured amount whose cause is being established, held for
days or weeks, resolved into its proper account when the cause is found. The
technical review believes this is ordinary and unremarkable bookkeeping and
seeks your confirmation.

### 4.2 At a reporting date — the problem

Under IFRS an asset is a **present economic resource controlled by the entity as
a result of past events**, from which economic benefits are expected to flow.

An unexplained cash shortage appears to meet none of that. The cash is gone. The
business controls nothing. Unless and until a documented enforceable claim
exists, there is no right to receive anything. **On the technical review's
reading, `1190` is therefore not supportable as an asset in a financial
statement** — however proper it is as an interim bookkeeping balance.

The same question runs the other way for `2900`. An unexplained surplus may be a
present obligation — it could be somebody's money — which would make a liability
appropriate. But if no counterparty can ever be identified, the framework
appears to require **income recognition**, and the business has neither chosen a
destination account for that nor decided who authorizes it.

### 4.3 Why this is not hypothetical

Two approved policies make a long-open balance ordinary rather than exceptional:

- **DD-1: every unexplained variance is investigated, regardless of amount.**
  There is **no** tolerance and no de-minimis write-off. A 2,000 difference and
  a 2,000,000 difference follow the same path.
- **DD-2: an unresolved bank deposit ages for 30 calendar days** before anyone
  is even prompted to reclassify it.

So a reporting date **will** fall inside investigation windows, routinely. The
business needs a rule for that date before the accounts are built, not after.

---

## 5. Worked journals and the evidence behind each

Figures in UGX. Full examples, with opening booked cash, physical cash,
variances, closing positions and remaining suspense balances, are in
`POLYTOS-DECISION-A-D2-ACCOUNTING-REVIEW.md` §5. The four that matter for your
assessment are reproduced here.

### 5.1 A genuine shortage — the difference is parked, nothing is recognized

A till holds 300,000 after a correctly recorded repayment of 300,000. 120,000 is
removed without authorization. The count finds 180,000.

| Step | Journal | Evidence held |
| --- | --- | --- |
| the repayment | Dr `1010` Cash at Hand 300,000 / Cr `1200` Loans Receivable 300,000 | receipt number, payer, time, officer, counter-signature |
| the count | **no journal** | counted figure, counter's name, business date, a second officer's approval |
| formal resolution | **Dr `1190` 120,000 / Cr `1010` 120,000** | the approved count; the investigation reference |

**Closing:** booked cash 180,000 = counted 180,000. `1190` 120,000.
**Nothing is recognized in profit or loss. The borrower's repayment of 300,000
stands in full and `1200` never moves** — the business's loss is never recovered
by re-indebting a customer who paid.

### 5.2 The same difference, explained — no loss ever existed

Continuing, the investigation finds the 120,000 was taken to another till and
not recorded.

| Step | Journal | Evidence |
| --- | --- | --- |
| record the transfer | **Dr the other till 120,000 / Cr `1190` 120,000** | the second till's count, the officer's statement, the movement record |

**Closing:** `1190` nil. No profit-or-loss effect, in any period. This is the
outcome in six of the eight cases in §2.

### 5.3 A documented enforceable claim

| Step | Journal | Evidence required |
| --- | --- | --- |
| recognize the claim | **Dr `1195` 120,000 / Cr `1190` 120,000** | a signed acknowledgement, or a determination through the business's own disciplinary and legal process, or an insurer's or bond issuer's admission — **plus** Owner authorization and an independent review |
| collection | Dr Cash 120,000 / Cr `1195` 120,000 | the receipt |

### 5.4 An authorized loss

| Step | Journal | Evidence required |
| --- | --- | --- |
| recognize the loss | **Dr `5110` 120,000 / Cr `1190` 120,000** | a **completed** investigation; written authorization by **one Owner/Admin who did not open the investigation**; supporting documents; a stated reason; an immutable audit record; inclusion in material-loss reporting |

**Closing trial balance movement:** assets −120,000, expenses +120,000, equity
−120,000. The trial balance foots.

### 5.5 Evidence available for every posting

The system would hold, for each: the acting officer and a second authorizing
officer by identity, both names recorded on the row and in an append-only audit
log; the business date and the posting date separately; a mandatory reason; a
document reference in object storage; and the journal entry, which **cannot be
edited or deleted** — a correction is only ever a further, visible entry. A
count's figures are frozen at the moment of counting and are not recomputed on
later reads.

---

## 6. Unresolved balances at a reporting date

### 6.1 Unresolved shortages — `1190`

The technical review's reading (§4.2) is that an unexplained shortage does not
meet the asset definition, so a `1190` balance should not appear as an asset in
a financial statement. **Four alternatives are set out in §8.3 for your
determination, compared neutrally and with no recommendation.** An earlier
revision of this package recommended one of them on a reasoning that was
wrong; §8.3.1 records the correction.

### 6.2 Unidentifiable overages — `2900`

Three sub-questions, none of which the business has decided:

1. Is a liability appropriate while a counterparty is merely *possible*?
2. At what point does an unidentifiable surplus become income?
3. **Which account receives it, and who authorizes the recognition?** No
   destination account is proposed, deliberately: choosing one would presume the
   answer to question 2.

The technical review notes an asymmetry it is uncomfortable with and flags
rather than resolves: the business has an approved, Owner-only, evidence-bound
procedure for recognizing a **loss** (DD-5) and **no procedure at all** for
recognizing a **gain**. If an unexplained surplus can become income, it should
plausibly require no less authorization than a loss does.

---

## 7. Recovery claims and loss authorization, for your information

These two are **already approved policy** and are described so that you can
assess whether the controls meet the standard your audit opinion requires. They
are not open questions, but if you consider either insufficient, say so.

**DD-4 — recovery claims (`1195`).** A receivable arises **only** for a
documented, legally enforceable claim, after Owner/Admin authorization,
independent review and satisfaction of applicable legal requirements.
**Suspicion alone cannot create staff liability, and no salary-deduction
mechanism exists or is proposed** — recognizing a receivable records a claim; it
does not authorize collection by withholding pay, which is a payroll act
governed by employment law.

**DD-5 — loss authorization (`5110`).** Requires a completed investigation; one
Owner/Admin authorizer who **did not open the investigation**; supporting
evidence; a stated reason; immutable audit history; and material-loss reporting
above an Owner-set threshold. **No Manager or Cashier may authorize a loss, and
no automatic path reaches `5110`** — not ageing, not a threshold, not a failed
recovery, not a period close.

---

## 8. Proposed period-end procedure, and the alternatives

### 8.1 The proposed procedure

1. **A reporting period is defined** — monthly is proposed, with quarterly and
   annual roll-ups.
2. **A suspense clearance schedule** is produced before each reporting date,
   listing every open `1190` and `2900` balance with its age, its evidence
   status, the investigation's state and a proposed treatment.
3. **Each balance is dispositioned** as: substantiated (one of the six
   no-loss findings), converted to `1195` under DD-4, recognized under DD-5, or
   — if your determination permits — **carried**, with a stated basis.
4. **The schedule is approved by the Owner and reviewed by you.**
5. **The period is then closed**, after which no entry may be posted into it.

### 8.2 A disclosure the business must make to you now

**Step 5 cannot currently be enforced by the system.** There is no concept of an
accounting period, no close, no reopen and no restriction on the date an entry
carries anywhere in the application. Building that is a separate piece of work
that has not been authorized or scheduled.

Until it exists, step 5 is a **manual control**: a signed schedule and a
procedural undertaking, with no software enforcement. The technical review
states this plainly rather than implying a control that does not exist, and
notes that **a related design decision in the existing system compounds it** —
the current reconciliation adjustment is deliberately **back-dated to the day of
the count**, which means a difference found today can post into a month already
reported on. The corrected design (`B-2`) dates the accounting entry to the day
it is posted and keeps the count's own date on the document as the economic
date, which is the same separation already approved for bank value dates. **That
change needs your agreement**, because it moves where a difference appears by
period.

### 8.3 Alternatives where a suspense balance fails recognition

#### 8.3.1 A correction to an earlier revision of this package

The previous revision recommended Alternative C and said it *"preserves both the
policy and the framework: no asset is asserted and **no loss is asserted
either**."*

**That was wrong, and the error matters.** An allowance cannot reduce an
unsupported asset to nil without a matching debit, and there is nowhere for that
debit to go except **profit or loss**. Establishing the allowance therefore
recognizes a charge of exactly the same amount that Alternative A recognizes
directly. The recommendation rested on an effect the posting does not have, so
**it is withdrawn**, and §8.3.4 compares the four neutrally with no preference
expressed.

#### 8.3.2 The complete double entry for Alternative C

Taking the §5.1 shortage of 120,000, with `1190` carrying a debit balance of
120,000 at the reporting date.

**Establishing the allowance**

| | Account | Dr | Cr |
| --- | --- | --- | --- |
| | *a P&L charge account — see B-1.10* | 120,000 | |
| | `1191` Allowance for Unrecovered Differences (contra-asset, credit) | | 120,000 |

| Effect | Amount |
| --- | --- |
| **Profit or loss** | **charge of 120,000** |
| **Equity** | **reduced by 120,000** |
| Statement of financial position — gross | `1190` 120,000 debit |
| Statement of financial position — contra | `1191` 120,000 credit |
| **Statement of financial position — net carrying amount** | **nil** |

**Releasing the allowance — three cases**

*R1: the cause is found and no money was ever lost* (findings S1–S3, O1–O3 — six
of the eight, §2):

| | Account | Dr | Cr |
| --- | --- | --- | --- |
| release | `1191` | 120,000 | |
| | *the same P&L charge account* | | 120,000 |
| resolve the difference | the correct account — the other till, the receipt's income or receivable leg, the overstated expense | 120,000 | |
| | `1190` | | 120,000 |

Net effect across the two periods: **nil**. But the charge fell in the first
period and the credit in the second, so **the two periods are each misstated by
120,000 in opposite directions.** §8.3.3 asks you about that.

*R2: a documented enforceable claim arises* (DD-4):

| | Account | Dr | Cr |
| --- | --- | --- | --- |
| reclassify | `1195` Cash Recovery Receivable | 120,000 | |
| | `1190` | | 120,000 |
| release, **if** the claim is recoverable in full | `1191` | 120,000 | |
| | *the P&L charge account* | | 120,000 |

A further determination sits here: whether the allowance is **released** on
reclassification or **carried against `1195`** until collection. The second is
the more conservative and is the ordinary treatment for a receivable of
uncertain collectability; the choice is yours (B-1.5).

*R3: the cash is physically recovered:*

| | Account | Dr | Cr |
| --- | --- | --- | --- |
| recovery | Cash at Hand | 120,000 | |
| | `1190` | | 120,000 |
| release | `1191` | 120,000 | |
| | *the P&L charge account* | | 120,000 |

#### 8.3.3 What this means for the comparison

Alternative C's profit-or-loss effect, equity effect and **net** balance-sheet
effect are **identical to Alternative A's**. The two differ only in
**presentation and operational visibility**:

- **A** removes the amount from the ledger, so the open investigation is tracked
  only outside it.
- **C** keeps the gross amount in the ledger and in the ageing report, with an
  offsetting contra, so recovery is reconciled against a live balance.

C is **not** a way of avoiding loss recognition. Anyone describing it that way —
as the previous revision of this package did — is mistaken.

#### 8.3.4 The four alternatives, compared neutrally

| | Alternative | Mechanism | P&L at the reporting date | Net SOFP | Gross visible in the ledger | Known difficulties |
| --- | --- | --- | --- | --- | --- | --- |
| **A** | Expense at the reporting date; reinstate on recovery | an open `1190` balance is charged to P&L; a later recovery is income or a reinstated receivable | **charge** | nil | **no** | Recognizes a charge for a difference that in six of eight cases is a bookkeeping error. Two investigations with identical facts are reported differently depending on the date. Period displacement on reversal. **Variant:** A plus an investigation register outside the ledger restores the lost visibility at the cost of a second source of truth |
| **B** | Present `1190` net against cash | contra-asset against the cash line | **charge** (same reasoning as C) | nil | yes, but inside cash | Misstates the cash figure, which a reconciliation exists to make reliable. Likely non-compliant with cash presentation requirements, which is for you to determine |
| **C** | Gross `1190` with an allowance in `1191` | §8.3.2 | **charge — identical to A** | nil | **yes** | Two extra accounts and three release paths. The charge must go to **some** P&L line, and `5110` is reserved by DD-5 for Owner-authorized losses (B-1.10). Period displacement on release, as in A |
| **D** | Carry `1190` as an asset, with disclosure of nature and ageing | gross balance carried; note disclosure | **none** | gross | yes | Available **only** if you determine that the asset recognition criteria are met. The technical review doubts they are, and does not decide |

**No recommendation is made.** All four recognize a charge except D, and D is
available only on your determination that an unexplained shortage is an asset.
That is the whole of the question, and it is yours.

### 8.4 Reconciling mandatory reporting with the Owner-only loss policy

**This is a request for your explicit determination, and the technical review
does not presume an answer.**

DD-5 is approved internal policy: a loss in `5110` requires a completed
investigation and written authorization by one Owner/Admin who did not open it,
with evidence, a reason, immutable audit history and material-loss reporting.

IFRS recognition does not work that way. If at a reporting date a balance fails
the asset definition, **the framework requires it off the statement of financial
position whether or not an internal authorizer has signed anything.**
Recognition is not within management's discretion.

**The technical review does not presume that internal policy can override a
mandatory reporting requirement, and it is not asserting that it can.** What it
can do is set out the shape of the problem, so that you can resolve it:

| | What it governs | Who decides | Is it discretionary? |
| --- | --- | --- | --- |
| **The reporting measurement** at a reporting date | whether an unsupported balance may be carried | the framework, applied by you | **no** |
| **DD-5's authorization** | whether an investigation is concluded and the matter closed as a loss | the Owner | yes, within policy |

They need not conflict — they are two acts that may happen at different times
and for different reasons, and could carry different amounts. But they currently
share one account, and that is the practical problem (B-1.10): charging a
mandatory reporting adjustment to `5110` would put an amount in the account DD-5
reserves for authorized losses **without** an Owner authorization, which either
breaches the control or requires the control to be read as not applying.

**Please determine** how the two are to coexist, including whether:

- the reporting-date charge belongs in a **separate P&L account** from `5110`,
  with `5110` reserved for authorized, concluded losses;
- a later DD-5 authorization then **reclassifies within P&L** rather than
  recognizing a second charge;
- or the framework's requirement simply **subsumes** DD-5 for reporting
  purposes, with DD-5 retained as an internal control over closing
  investigations and nothing more.

If the answer is that no internal policy may gate the reporting outcome, say so
plainly. The Product Owner will be told, and the policy documents will record
that the control governs the internal determination and not the financial
statements.

---

## 9. Decisions requiring your written approval

Development stays blocked until each is answered. None is presumed.

| # | Decision | Default if unanswered |
| --- | --- | --- |
| **B-1.1** | Is `1190` acceptable as an **interim** suspense balance within a reporting period? | none — blocks |
| **B-1.2** | What is the treatment of an open `1190` balance **at a reporting date**? Alternative A, B, C, D, or another? If C, confirm `1191 Allowance for Unrecovered Differences`, its establishment and release postings (§8.3.2) and its presentation | none — blocks |
| **B-1.3** | Is `2900` acceptable as a liability while a counterparty is possible? | none — blocks |
| **B-1.4** | When does an **unidentifiable overage** become income, **which account** receives it, and **who authorizes** the recognition? | none — blocks. No destination account is proposed |
| **B-1.5** | Do DD-4's criteria satisfy the recognition test for a receivable in `1195`, and is the evidence set sufficient? | none — blocks |
| **B-1.6** | Is DD-5's single-Owner authorization, with the opener excluded, sufficient control for a loss in `5110`? If not, what is? | none — blocks |
| **B-1.7** | Is the §8.1 period-end procedure sufficient, given that the close at step 5 is a **manual control** until the period subsystem is built? | none — blocks |
| **B-1.8** | Do you agree that the reconciliation adjustment should be dated **when posted**, with the count's date kept on the document, rather than back-dated to the count? | none — blocks B-2 |
| **B-1.9** | Should a **gain** recognition require authorization comparable to DD-5's for a loss? | none — blocks B-1.4 |
| **B-1.10** | **Which P&L account receives a reporting-date charge** under Alternative A, B or C? `5110` is reserved by DD-5 for Owner-authorized losses, so charging a mandatory adjustment there either breaches that control or requires it to be read as not applying. Is a separate account needed, and what is it called? | none — blocks |
| **B-1.11** | **How do IFRS's mandatory recognition requirements and DD-5's Owner-only authorization coexist?** §8.4. If no internal policy may gate the reporting outcome, state that plainly | none — blocks |
| **B-1.12** | **Period displacement.** Under A, B and C the charge falls in one period and its release in another, so for the six no-loss findings two periods are each misstated by the same amount in opposite directions. Is that acceptable, and if not what measurement or disclosure addresses it? | none — blocks |

### 9.1 What is **not** being asked

A-1 through A-13, C1 through C7, D-1 through D-3 and DD-1 through DD-5 are
approved product policy and are not reopened here. This package asks only about
**classification, recognition, presentation and period-end** — the matters that
require a qualified accountant.

### 9.2 What this package is not

It is not an accounting opinion, not advice, and not a determination. The
technical review is not qualified to give any of those. It previously expressed
a preference for Alternative C on reasoning that was wrong, and §8.3.1 withdraws
it; **no alternative is now recommended.** **No treatment described here is
adopted until approved in writing**, and no unexplained amount is classified as
an asset, a liability, income or an expense by default. Nor does this package
presume that any internal authorization policy can override a mandatory
reporting requirement — §8.4 asks you to resolve that directly.

---

## 10. Remaining-blocker register — B-1

| ID | Blocker | Owner | Blocks |
| --- | --- | --- | --- |
| **B-1.1–B-1.12** | the twelve determinations in §9 — the original nine, preserved unchanged, plus B-1.10, B-1.11 and B-1.12 arising from the Alternative C correction | the qualified accountant, with the Product Owner | the `1190`/`2900`/`1195`/`5110` chart rows, `1191` if Alternative C is chosen, and every function that posts to them — plan step 7a |
| **B-1.P** | **No accounting-period concept exists** in the application: no period, no close, no reopen, no restriction on an entry's date. §8.1 step 5 is a manual control until it is built. Three existing functions already accept an unbounded caller-supplied date | Product Owner — a separate, unscheduled workstream | enforcement of A-6 system-wide, and the period-end procedure's final step |
| **B-1.E** | **No finance evidence storage exists.** The six existing buckets are client, guarantor, loan, membership-consent, benefit and company-assets. Clearance slips, physical-return evidence, reclassification evidence, correction evidence, claim documents and loss documents all need one | Implementation, once authorized | §5.5's evidence guarantees |

**Production remains NO-GO.** Development remains unauthorized.
