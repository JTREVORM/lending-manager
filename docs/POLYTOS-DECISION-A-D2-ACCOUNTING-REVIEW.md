# POLYTOS — Decision A, Dependency D-2: Accounting Certification

**Revision:** v2. Incorporates the Product Owner's approval of **DD-1 through
DD-5** (2026-11-12) and the mandatory accounting verification. Supersedes v1
(`17a54f9`).
**Status:** documentation-only certification. **No implementation
authorization.** Stops at the review gate.
**Type:** no migration, application code, test, chart row, setting, hosted data
or PR branch touched.
**Reviewed at:** PR #27 head (`phase4e/mobile-money-2026-11-09`, 214 migrations).
**Verdict: the accounting architecture is certified, with one accounting blocker
and one technical blocker named in §11.** Neither is an assumption silently
approved.
**Standing constraint:** *missing money is not automatically a loss, a staff
liability or a borrower debt.*
**Production:** NO-GO. Draft PRs #25–#27 untouched.

---

## 1. Correction notice — a direction error in v1

**v1 §6.2 was wrong, and the Product Owner's verification item 2 anticipated
exactly this failure.** It proposed, for the first three findings:

> ~~Dr `1190` / Cr the correct income, liability or receivable leg~~

That is wrong twice over. Those findings arise where the books **understate**
cash, which parks the amount in **`2900`** as a credit, not in `1190`. And
`1190` carries a **debit** balance, so debiting it would have **increased the
investigation balance it was meant to extinguish** — doubling the unexplained
amount on every one of the three most common findings.

The cause was a taxonomy error: v1 listed four findings as though all four
resolved one account, when the finding set is **determined by the sign of the
variance**. §4 rebuilds it correctly, §5 proves every posting with worked
numbers, and §3.3 is the recheck of all four accounts that verification item 1
asked for.

Nothing else in v1 was wrong: the shortage resolution, the recovery, the loss
and the deposit postings all verified correct on recheck.

---

## 2. The approved DD decisions

| ID | Approved ruling | Effect on the design |
| --- | --- | --- |
| **DD-1** | **Every unexplained reconciliation variance requires investigation, regardless of amount. No automatic loss-recognition tolerance.** | The tolerance v1 recommended is **withdrawn**. `5950` and `5960` receive **no** new variance posting on any path (§6). Stricter than v1 proposed |
| **DD-2** | Unresolved bank deposits have an **Owner/Admin-configurable ageing threshold, initially 30 calendar days.** Management is notified; reclassification requires **evidence and independent authorization**. **No automatic posting or write-off** | §7.1. The threshold is a setting; the posting is a human act |
| **DD-3** | **Permit partial physical returns**, recording only **independently verified** amounts. Unrecovered amounts stay under investigation. **Prevent duplicate recoveries.** A-7 full bank clearance unchanged | §7.2, worked at §5.7 |
| **DD-4** | **Cash Recovery Receivables only for documented, legally enforceable claims**, after Owner/Admin authorization, independent review and applicable legal requirements. **Suspicion alone cannot create staff liability or salary deductions** | §8.2, worked at §5.5 |
| **DD-5** | Genuine losses require **explicit authorization by one Owner/Admin who did not open the investigation**; completed investigation, supporting evidence, reason, immutable audit history and **material-loss reporting**. **No Manager/Cashier authorization and no automatic write-off** | §8.3, worked at §5.6 |

---

## 3. Accounts, classifications and the recheck

### 3.1 Codes, verified against the chart at the #27 head

| Code | Name | Type / normal side | `cash_kind` | Status |
| --- | --- | --- | --- | --- |
| `1190` | Cash Differences Under Investigation | asset / debit | **none** | free — proposed |
| `1195` | Cash Recovery Receivable | asset / debit | **none** | free — proposed |
| `2900` | Cash Overages Under Investigation | liability / credit | **none** | free — proposed |
| `5110` | Cash and Deposit Losses | expense / debit | **none** | free — proposed |
| `5950` | Cash Over and Short | expense / debit | none | **taken** — closed to new variance postings (§6) |
| `5960` | Agency Float Over and Short | expense / debit | none | **taken** — same |
| `5970` | Agency Float Purchase Premium | expense / debit | none | **taken** — unrelated |

**None of the four new accounts carries a `cash_kind`.** That is deliberate and
load-bearing: `branch_cash_position` and `total_liquidity` are computed over
`cash_kind is not null`, so the two certified liquidity identities are untouched
and no suite breaks. Parking an unexplained difference in a cash-kinded account
would have reopened finding B2.

### 3.2 Which account, decided by the sign of the variance

```
variance = counted_balance − system_balance
```

| Variance | Meaning | Parked in | Natural balance |
| --- | --- | --- | --- |
| **negative — shortage** | the books claim more cash than exists | **`1190`** (asset) | **debit** |
| **positive — overage** | more cash exists than the books claim | **`2900`** (liability) | **credit** |

Two accounts rather than one, so each always carries its natural sign, the
trial balance reads straight, and the schema's
`ledger_accounts_side_matches_type` discipline holds. **Extinguishing `1190`
means crediting it; extinguishing `2900` means debiting it.** Every posting in
§4 and §5 obeys that, and §3.3 checks each one.

### 3.3 Recheck of every journal touching `1190`, `1195`, `2900`, `5110`

Verification item 1, with item 2's test applied to each row: does the posting
move the investigation balance **towards zero** when it is meant to?

| # | Event | Dr | Cr | Effect on the suspense account | Intent | Verdict |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | resolution of a **shortage** | `1190` | cash | `1190` **created** (debit ↑) | create | ✓ |
| 2 | resolution of an **overage** | cash | `2900` | `2900` **created** (credit ↑) | create | ✓ |
| 3 | deposit ageing reclassification | `1190` | `1050` | `1190` created; `1050` → 0 | create | ✓ |
| 4 | **S1** unrecorded outflow found | expense / `1200` / etc. | **`1190`** | **extinguishes** | extinguish | ✓ |
| 5 | **S2** overstated inflow found | — | — | handled by C1–C7 before resolution (§4.3) | — | ✓ |
| 6 | **S3** unrecorded transfer **out** found | other cash account | **`1190`** | **extinguishes** | extinguish | ✓ |
| 7 | **O1** unrecorded inflow found | **`2900`** | `1200` / income | **extinguishes** | extinguish | ✓ **corrected from v1** |
| 8 | **O2** overstated outflow found | **`2900`** | `1200` / expense | **extinguishes** | extinguish | ✓ **corrected from v1** |
| 9 | **O3** unrecorded transfer **in** found | **`2900`** | source cash account | **extinguishes** | extinguish | ✓ **corrected from v1** |
| 10 | recovery claim raised (DD-4) | `1195` | **`1190`** | `1190` **extinguishes**; `1195` created | extinguish | ✓ |
| 11 | claim collected | cash | `1195` | `1195` **extinguishes** | extinguish | ✓ |
| 12 | loss recognized (DD-5) | `5110` | **`1190`** or **`1195`** | **extinguishes** | extinguish | ✓ |
| 13 | physical return after reclassification | till | **`1190`** | **extinguishes** | extinguish | ✓ |
| 14 | unidentifiable overage recognized as income | **`2900`** | a named income account | **extinguishes** | extinguish | **⚠ destination unspecified — §11.1** |

Rows 7, 8 and 9 are the correction. Row 14 is a gap v1 did not notice and is
carried as an open item, not quietly resolved.

### 3.4 Accounting-framework classification — verification item 5

Assessed against IFRS / IFRS for SMEs, which is the framework a Ugandan
reporting entity applies.

| Account | Within a reporting period | **At a reporting date** |
| --- | --- | --- |
| `1190` | **Defensible as an interim suspense/clearing balance** while the cause is established. Standard bookkeeping practice | **NOT defensible as an asset.** An asset is a present economic resource the entity controls. An unexplained cash shortage is neither controlled nor supported by an enforceable right — the cash is gone and nothing is yet owed to the entity. **Each `1190` balance must be resolved before the reporting date** into a receivable (only with DD-4's enforceable claim) or an expense (DD-5) |
| `2900` | Defensible as an interim clearing balance; plausibly a liability where a counterparty may exist | Supportable **only** while a present obligation is plausible. An overage with no identifiable counterparty generally requires **income recognition**, which needs a destination account and an authorization — row 14, §11.1 |
| `1195` | Receivable | **Supportable**, because DD-4 requires a documented, legally enforceable claim — which is precisely the recognition criterion. DD-4 and the framework agree |
| `5110` | Expense | Supportable |

**This is the one place where the approved policy and the reporting framework
pull in different directions, and it must not be papered over.** DD-1 (every
variance investigated, no tolerance) and DD-2 (a 30-day ageing threshold)
together make it ordinary for a `1190` balance to be open for weeks. If a
reporting date falls inside that window, the balance cannot simply be presented
as an asset.

That is **accounting blocker B-1** (§11.1). It needs a qualified accountant's
determination and a period-end policy, and it compounds with the fact that the
schema has **no closed-period concept at all**. It is a *financial reporting*
blocker, not an architecture defect: the architecture is what makes the balance
visible and resolvable in time.

---

## 4. The finding taxonomy, rebuilt

### 4.1 Why a correction alone never creates a shortage

A booking-error correction cannot by itself drive a cash account negative. Work
it: till 80,000; a receipt of 100,000 keyed although no payment occurred (booked
180,000, physical 80,000); genuine payouts of 60,000 (booked 120,000, physical
20,000); correct the fictitious receipt → **booked 20,000, physical 20,000.**
The books and the drawer agree.

A negative appears only when **more has been recorded as leaving the account
than ever legitimately entered it** — a *second, independent irregularity* the
correction has merely revealed. And because booked is then **below** physical,
the resulting variance is an **overage**, parked in `2900`.

### 4.2 Overage findings — books understate cash → `2900`

| # | Finding | Resolution | Loss? |
| --- | --- | --- | --- |
| **O1** | an **unrecorded inflow** exists | record it: Dr `2900` / Cr the income, liability or receivable leg it should have credited | **no** |
| **O2** | a **recorded outflow was overstated** or never happened | correct it: Dr `2900` / Cr the overstated expense or receivable | **no** |
| **O3** | an **unrecorded transfer in** funded the payouts | record it: Dr `2900` / Cr the source cash account | **no** |
| **O4** | **unidentifiable surplus** | stays in `2900`; eventual income recognition needs a destination and an authorization | §11.1 |

### 4.3 Shortage findings — books overstate cash → `1190`

| # | Finding | Resolution | Loss? |
| --- | --- | --- | --- |
| **S1** | an **unrecorded outflow** — a genuine payment made and never booked | record it: Dr the expense / receivable / loan leg / Cr `1190` | **no** |
| **S2** | an **overstated inflow** — a receipt booked for more than arrived, or twice | correct it under C1–C7. **Ordering matters:** the correction must be posted *before* the formal resolution, or the contra would drive booked below the counted figure. A correction request against an account already flagged is therefore refused until its resolution is complete | **no** |
| **S3** | an **unrecorded transfer out** | record it: Dr the destination cash account / Cr `1190` | **no** |
| **S4** | cash **genuinely missing** — received and gone without authorization | §8: recovery (DD-4) or loss (DD-5) | only here |

**Seven of the eight findings involve no loss.** That is why the resolution
posting must be classification-free and must not touch the income statement, and
why DD-1's removal of the tolerance is the right call rather than an
inconvenience.

### 4.4 The two money-gone events stay structurally separate

| | **Incorrectly recorded receipt** | **Genuinely received, now missing** |
| --- | --- | --- |
| What happened | the payment never occurred | the payment occurred; the cash is gone |
| Detected by | a correction request with evidence of non-occurrence | the **physical count** |
| Mechanism | `correct_misrecorded_receipt` (C1–C7) | reconciliation variance → `1190` |
| Borrower record | correctly restored — they never paid | **untouched. They paid** (C6, A-10) |
| Reaches the correction path? | yes, only it | **no — refused by C6** |

---

## 5. Worked examples — verification items 3 and 4

Every figure in UGX. `1010` is the Head Office till, `1040` the bank, `1050`
Cash in Transit, `1200` Loans Receivable. Each example shows opening booked
cash, physical cash, the variance, every journal, the closing position and the
remaining suspense balance.

### 5.1 O1 — unrecorded inflow

Opening: `1010` booked **0**, physical **0**; `1200` **500,000**; `2900` **0**.

| # | Event | Journal | `1010` booked | `1010` physical | `1200` | `2900` |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | repayment 100,000 received, recorded | Dr `1010` 100,000 / Cr `1200` 100,000 | 100,000 | 100,000 | 400,000 | 0 |
| 2 | **fictitious** repayment 100,000 keyed, no money | Dr `1010` 100,000 / Cr `1200` 100,000 | 200,000 | 100,000 | 300,000 | 0 |
| 3 | repayment 80,000 arrives, **never recorded** | — | 200,000 | 180,000 | 300,000 | 0 |
| 4 | disbursement 180,000 | Dr `1200` 180,000 / Cr `1010` 180,000 | 20,000 | 0 | 480,000 | 0 |
| 5 | correction of 2 under C1–C7 | Dr `1200` 100,000 / Cr `1010` 100,000 | **−80,000** | 0 | 580,000 | 0 |
| 6 | count | — counted 0, system −80,000, **variance +80,000 overage** | −80,000 | 0 | 580,000 | 0 |
| 7 | **formal resolution** | Dr `1010` 80,000 / Cr `2900` 80,000 | **0** | 0 | 580,000 | **80,000** |
| 8 | **O1 evidenced**, receipt recorded | **Dr `2900` 80,000 / Cr `1200` 80,000** | 0 | 0 | **500,000** | **0** |

**Closing.** `1010` booked 0 = physical 0 ✓. `1200` 500,000, which is the
economically correct figure (500,000 − 100,000 − 80,000 + 180,000) ✓.
**Remaining suspense: nil.** No expense recognized. Trial balance foots at every
step, each journal being two equal legs.

### 5.2 O2 — overstated outflow

Opening: `1010` booked **200,000**, physical **200,000**; `1200` **500,000**.

| # | Event | Journal | `1010` booked | physical | `1200` | `2900` |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | fictitious repayment 150,000 | Dr `1010` 150,000 / Cr `1200` 150,000 | 350,000 | 200,000 | 350,000 | 0 |
| 2 | disbursement **recorded 300,000**, actually paid 200,000 | Dr `1200` 300,000 / Cr `1010` 300,000 | 50,000 | 0 | 650,000 | 0 |
| 3 | correction of 1 | Dr `1200` 150,000 / Cr `1010` 150,000 | **−100,000** | 0 | 800,000 | 0 |
| 4 | count | counted 0, **variance +100,000** | −100,000 | 0 | 800,000 | 0 |
| 5 | **formal resolution** | Dr `1010` 100,000 / Cr `2900` 100,000 | **0** | 0 | 800,000 | **100,000** |
| 6 | **O2 evidenced** — the borrower received 200,000 | **Dr `2900` 100,000 / Cr `1200` 100,000** | 0 | 0 | **700,000** | **0** |

**Closing.** `1200` 700,000 = 500,000 + the 200,000 actually advanced ✓.
**Remaining suspense: nil.** No expense. The borrower is credited with the
200,000 they actually received, not the 300,000 recorded.

### 5.3 O3 — unrecorded transfer in

Opening: `1010` booked **50,000**, physical **50,000**; `1040` booked
**300,000**, bank statement **300,000**.

| # | Event | Journal | `1010` booked | `1010` physical | `1040` booked | bank | `2900` |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | fictitious repayment 100,000 | Dr `1010` / Cr `1200` 100,000 | 150,000 | 50,000 | 300,000 | 300,000 | 0 |
| 2 | 120,000 withdrawn from the bank to the till, **never recorded** | — | 150,000 | 170,000 | 300,000 | **180,000** | 0 |
| 3 | payouts 150,000 from the till | Dr `1200` / Cr `1010` 150,000 | 0 | 20,000 | 300,000 | 180,000 | 0 |
| 4 | correction of 1 | Dr `1200` / Cr `1010` 100,000 | **−100,000** | 20,000 | 300,000 | 180,000 | 0 |
| 5 | count the till | counted 20,000, system −100,000, **variance +120,000** | −100,000 | 20,000 | 300,000 | 180,000 | 0 |
| 6 | **formal resolution** | Dr `1010` 120,000 / Cr `2900` 120,000 | **20,000** | 20,000 | 300,000 | 180,000 | **120,000** |
| 7 | **O3 evidenced** — the bank withdrawal | **Dr `2900` 120,000 / Cr `1040` 120,000** | 20,000 | 20,000 | **180,000** | 180,000 | **0** |

**Closing.** Both accounts agree with reality: till 20,000 = 20,000, bank
180,000 = statement 180,000 ✓. **Remaining suspense: nil.** No expense. Note the
bank account's own balance was wrong until step 7 and is corrected without any
posting to the income statement.

### 5.4 S4 — genuine cash shortage, borrower preserved

Opening: `1010` booked **0**, physical **0**; `1200` **500,000**.

| # | Event | Journal | `1010` booked | physical | `1200` | `1190` |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | repayment 300,000 received, **correctly** recorded | Dr `1010` 300,000 / Cr `1200` 300,000 | 300,000 | 300,000 | **200,000** | 0 |
| 2 | 120,000 removed without authorization | — | 300,000 | **180,000** | 200,000 | 0 |
| 3 | count | counted 180,000, system 300,000, **variance −120,000 shortage** | 300,000 | 180,000 | 200,000 | 0 |
| 4 | **no correction is attempted** — C6 refuses it; the borrower paid | — | 300,000 | 180,000 | **200,000** | 0 |
| 5 | **formal resolution** | **Dr `1190` 120,000 / Cr `1010` 120,000** | **180,000** | 180,000 | **200,000** | **120,000** |

**Closing.** `1010` booked 180,000 = physical 180,000 ✓. `1200` **200,000,
unchanged from step 1** — the borrower's repayment stands in full ✓.
**Remaining suspense: `1190` 120,000, unexplained.** No expense, no receivable,
no staff liability, no borrower debt. The account is physically accurate, so it
is **not** blocked from trading (§9.4); the open investigation is reported and
aged.

### 5.5 DD-4 — recoverable claim, continuing §5.4

| # | Event | Journal | `1010` | `1190` | `1195` | `1200` |
| --- | --- | --- | --- | --- | --- | --- |
| 5 | carried from §5.4 | — | 180,000 | 120,000 | 0 | 200,000 |
| 6 | a **documented, legally enforceable** claim exists; Owner authorized; independently reviewed; legal requirements met | **Dr `1195` 120,000 / Cr `1190` 120,000** | 180,000 | **0** | **120,000** | 200,000 |
| 7 | the claim is settled in cash | Dr `1010` 120,000 / Cr `1195` 120,000 | **300,000** | 0 | **0** | 200,000 |

**Closing.** Cash restored to 300,000; no expense ever recognized; the borrower
untouched. **Remaining suspense: nil.** Duplicate recovery is impossible: step 7
is keyed to the claim, whose settled state is a one-way transition.

**If the claim later proves uncollectable**, it moves to §5.6's posting with
`Cr 1195` instead of `Cr 1190` — it does not quietly expire.

### 5.6 DD-5 — unrecoverable loss, continuing §5.4

| # | Event | Journal | `1010` | `1190` | `5110` | `1200` |
| --- | --- | --- | --- | --- | --- | --- |
| 5 | carried from §5.4 | — | 180,000 | 120,000 | 0 | 200,000 |
| 6 | investigation **completed**; nothing recoverable; authorized by **one Owner/Admin who did not open it**; evidence, reason and audit recorded; material-loss reporting triggered | **Dr `5110` 120,000 / Cr `1190` 120,000** | 180,000 | **0** | **120,000** | 200,000 |

**Closing trial balance movement.** Assets −120,000 (`1190` extinguished),
expenses +120,000, therefore equity −120,000. The trial balance foots ✓.
**Remaining suspense: nil.** The borrower's 300,000 repayment is intact and
`1200` never moved ✓. This is the **only** posting in this certification that
touches the income statement, and the only one unreachable without an explicit
Owner act.

### 5.7 DD-2 and DD-3 — deposit ageing and partial return

Opening: `1010` booked **500,000**, physical **500,000**; `1050` **0**; `1040`
**1,000,000**.

| # | Event | Journal | `1010` | `1050` | `1040` | `1190` |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | deposit 400,000 recorded — **sufficiency checked on the till** | Dr `1050` 400,000 / Cr `1010` 400,000 | 100,000 | 400,000 | 1,000,000 | 0 |
| 2 | the bank refuses it; investigation opened (A-8) | **nothing posted** | 100,000 | 400,000 | 1,000,000 | 0 |
| 3 | day 30 — management notified (DD-2) | **nothing posted** | 100,000 | 400,000 | 1,000,000 | 0 |
| 4 | reclassification, with evidence of the attempts and **independent authorization** | Dr `1190` 400,000 / Cr `1050` 400,000 | 100,000 | **0** | 1,000,000 | **400,000** |
| 5 | **250,000 physically returned and independently verified** (DD-3) | **Dr `1010` 250,000 / Cr `1190` 250,000** | **350,000** | 0 | 1,000,000 | **150,000** |

**Closing.** `1050` is 0, so it again means only genuine transit ✓. `1010`
350,000 ✓. **Remaining suspense: `1190` 150,000, still under investigation** —
awaiting §5.5 or §5.6, with no automatic exit.

**Duplicate recovery prevented** by a cumulative constraint: the sum of verified
returns on a deposit may never exceed its amount, enforced structurally and not
by application arithmetic. **A-7 is untouched** — this is *recovery of physical
cash*, not *clearance by a bank*, which remains full-or-nothing.

---

## 6. `5950` can no longer absorb an unexplained variance — verification item 7

DD-1 removes the tolerance, so there is no amount at which a variance may be
expensed without investigation. **Three** approval paths currently do exactly
that, and all three must change:

| Path | Today | Required |
| --- | --- | --- |
| `approve_reconciliation` (lending) — `20261011000230:285` | posts **every** approved variance to `5950`, unconditionally | never posts to `5950`. A variance opens an investigation and is parked in `1190` / `2900` |
| `approve_agency_cash_reconciliation` — `20261110000400` | posts to `5950` when `p_adjust` is set, gated on `agency:variance_adjustment` with a mandatory reason | the opt-in write-off is removed. Better than the lending path today, but still a Manager-grade write-off of an unexplained variance, which DD-1 and DD-5 forbid |
| `approve_agency_float_reconciliation` — `20261110000400` | posts to `5960` on the same opt-in, additionally requiring a named provider statement | same treatment, for float |

**`5950` and `5960` keep their historical balances** — the ledger is append-only
and no past entry moves — but receive **no new variance posting**. A concluded
investigation posts to `5110` (loss, Owner-authorized) or to a substantiated
leg. The two accounts become closed to new postings rather than deleted, which
keeps every historical report readable.

**One rule across three paths**, which is the property the agency/lending
asymmetry has repeatedly cost this codebase.

The agency paths also carry a **staleness guard** the lending path lacks —
*"the balance of % has moved from % to % since this count was recorded, so its
variance of % no longer describes anything"*. That guard should be adopted on
the lending path as part of the same change: a resolution computed from a stale
`system_balance` would post the wrong amount.

---

## 7. Deposits — DD-2 and DD-3

### 7.1 Ageing (DD-2)

- The threshold is an **Owner/Admin-configurable** `finance_settings` value,
  **initially 30 calendar days**, measured from `deposit_date`.
- Crossing it **posts nothing**. It raises a notification to management, on the
  existing low-balance notification pattern.
- Reclassification `Dr 1190 / Cr 1050` is a **human act** requiring
  `deposits:verify`, a reason, **evidence of the attempts made** and
  **independent authorization** — the actor may not be the deposit's recorder.
- The deposit's status becomes `aged_unresolved`; its whole history is retained;
  `1050` returns to meaning only genuine transit.
- **No automatic posting and no automatic write-off**, at the threshold or ever.

This threshold is a *timing* setting, not a sufficiency bypass: it changes when
a human is prompted, never whether funds must exist (§9.2).

### 7.2 Partial physical returns (DD-3)

- Permitted, for **independently verified** amounts only, each requiring
  evidence of actual physical receipt and an actor who is not the deposit's
  recorder.
- Each verified return posts `Dr till / Cr 1190` — or `Cr 1050` if the deposit
  has not yet been reclassified. The function reads the deposit's current state
  and credits whichever account holds the money, so neither account can be
  driven negative.
- **Unrecovered amounts stay under investigation**, with no automatic exit.
- **Duplicate recoveries prevented structurally:** a cumulative verified-returns
  column with a CHECK that it never exceeds the deposit amount, plus an
  idempotency key per return. Not application arithmetic.
- **A-7 unchanged:** bank *clearance* remains full-or-nothing. Recovering
  physical cash is a different act with no such binary, which is why DD-3 and
  A-7 do not conflict.

---

## 8. Shortages, recoveries and losses

### 8.1 The default is neutral and has no expiry

An amount in `1190` is **unexplained**, not lost. Nothing expires it, no
scheduled job sweeps it, and no threshold reclassifies it into the income
statement. §11.1's reporting-date constraint is the one force that requires it
to be resolved, and that is a reporting obligation on the business, not an
automatic posting.

### 8.2 Recovery (DD-4)

`Dr 1195 / Cr 1190`, and **only** where there is a **documented, legally
enforceable** claim, after **Owner/Admin authorization**, **independent review**
and satisfaction of **applicable legal requirements**.

**Suspicion alone cannot create staff liability or a salary deduction.** Three
structural consequences:

1. The function **refuses** without an evidence reference and an Owner actor.
2. It records the **counterparty** and the basis of the claim, so a receivable
   can always be traced to the determination that created it.
3. **No salary-deduction mechanism exists in this system and none is proposed.**
   A deduction is a payroll act governed by employment law; recognizing a
   receivable records a claim, it does not authorize collection by withholding
   pay. The certification states this explicitly so that an implementer cannot
   infer otherwise from the existence of `1195`.

### 8.3 Loss (DD-5)

`Dr 5110 / Cr 1190` — or `Cr 1195` for a claim that failed — requiring:

| Requirement | Enforcement |
| --- | --- |
| a **completed** investigation | status precondition; refused while open |
| **one Owner/Admin** authorizer | capability granted to `owner_admin` alone |
| **who did not open the investigation** | distinct-actor rule at the function layer **and** a CHECK on the stored actor pair |
| **supporting evidence** | a non-blank evidence reference in the finance evidence bucket |
| a **reason** | mandatory, non-blank |
| **immutable audit history** | `record_audit_event` plus the append-only ledger; `journal_lines` refuses UPDATE and DELETE |
| **material-loss reporting** | losses at or above an Owner-set materiality figure appear on a periodic report the Owner reviews |

**No Manager or Cashier authorization, and no automatic write-off from any
path** — not ageing, not a threshold, not a failed recovery, not period close.

---

## 9. Controls verification — items 6 and 8

### 9.1 Reconciliation locking and concurrency

| Control | State | Required |
| --- | --- | --- |
| Count locks the account | **absent on the lending path**; present on both agency paths | adopt `lock_ledger_balances` on `submit_reconciliation` and `approve_reconciliation` — defect **D2-b** |
| Staleness guard | absent on lending, present on agency | adopt on lending (§6) |
| Resolution posting locks | — | `lock_ledger_balances` over the cash account **and** `1190`/`2900`, sorted, before any read |
| Journal-writer lock | PR #25 locks every cash-kinded account inside `post_journal` | `1190`/`2900`/`1195`/`5110` carry no `cash_kind`, so they are **not** covered — the resolution function must lock them itself |
| One resolution per reconciliation | — | a unique index on the resolution's `(source_type, source_id)`, which `journal_entries_one_per_source` already provides |
| False-pass hazard | `next_reference('journal')` serialises every posting until commit | concurrency tests must hold **only** the advisory lock, post nothing and take no reference |

### 9.2 Sufficient funds, no override — item 8

| Claim | Basis |
| --- | --- |
| Every **genuine** outgoing transaction is checked | all 24 paths in plan §8 call `assert_cash_funds_available` |
| No override exists for anybody, Owner included | A-4; no `allow_*` flag is added; **DD-1 removes the last amount-based bypass**, so there is no threshold at which anything is waived |
| The exempt postings cannot become payouts | resolution, reclassification, recovery and loss each take only a **document id**, derive amount and accounts from that document, and accept **no amount, account or recipient** |
| DD-2's threshold is not a bypass | it changes when a human is prompted, not whether funds exist |
| The exemptions cannot be reached from a payout | each is refused unless its named document is in the one state that permits it, and refused if its entry already exists |

**The doctrine, once:** sufficiency governs **value leaving the business**. A
reclassification between the business's own accounts, for an amount fixed by an
approved document, is not that — and is made structurally incapable of becoming
that.

### 9.3 Maker-checker and branch RLS

| Act | Second actor | Branch scoping |
| --- | --- | --- |
| count → approve count | different person (existing) | D-1 grant required on the account's branch |
| formal resolution | implied by the approved count | D-1 grant |
| investigation open / close | recorded; the opener may not authorize a loss (DD-5) | D-1 grant |
| ageing reclassification | not the deposit's recorder | D-1 grant |
| physical return | not the deposit's recorder | D-1 grant |
| recovery claim | Owner + independent review | D-1 grant |
| loss | **Owner, not the investigation's opener** | D-1 grant |

Every new table: RLS enabled, `revoke all` from `anon` and `authenticated`,
`select` only, policy `user_has_permission(...) and user_can_see_branch(branch)`
under D-1's refined predicate, writes solely through `SECURITY DEFINER`.
Reading `1190` and `1195` requires `ledger:view` **and** a branch grant.

### 9.4 Blocking, and when it applies

| Situation | Account blocked? | Why |
| --- | --- | --- |
| a correction drove booked **negative** | **yes**, until resolved **and** formally resolved (C5) | the booked balance is not physically possible; the account is not safe to transact on |
| a plain count **shortage** (§5.4) | **no** | after resolution the booked balance equals the counted cash. The account is accurate and the branch can trade; the investigation is reported and aged instead |
| an **overage** | no | same reasoning |

Blocking an accurate account would stop a branch for a reason that is not a
solvency problem. **Flagged for confirmation** (§11.3) because it refines C5
rather than restating it.

### 9.5 Borrower repayments and historical journals

| Protection | How |
| --- | --- |
| A shortage never re-indebts a borrower | C6; `1200` is unchanged through §5.4, §5.5 and §5.6 |
| Recognition timing unchanged | A-10: at recording, on the recorded date; `status = 'posted'` throughout |
| The payment guard intact | `loan_payments_guard_mutation` still permits exactly one transition; D-2 adds no column and no transition |
| No D-2 function touches the loan book | asserted over the function bodies by test |
| Historical journals never move | `journal_lines` refuses UPDATE and DELETE; `journal_entries_guard_update` permits only `reversed_by_entry_id`. Every D-2 posting is a **new** entry |
| No backdating | every D-2 entry is dated `business_date()` (A-6) |
| Liquidity identities hold | the four new accounts carry no `cash_kind` (§3.1) |

---

## 10. Tests — verification item 10's evidence base

New suites; **none written** under this authorization. The requirement-to-test
matrix is in `docs/POLYTOS-DECISION-A-TECHNICAL-REVIEW.md` §9.

**`tests/db/cash-difference-resolution.test.ts`**
- `a correction with no intervening outflow leaves no negative balance` — §4.1.
- `a correction-revealed negative produces an overage, not a shortage` — §5.1.
- `a shortage parks in 1190 as a debit; an overage parks in 2900 as a credit`.
- `resolution brings the cash account to the counted balance exactly` — all seven examples replayed as fixtures.
- `every variance opens an investigation, whatever its amount` (DD-1).
- `no variance posting reaches 5950 on the lending path`.
- `no variance posting reaches 5950 or 5960 on either agency path`.
- `a stale system_balance is refused` — the adopted staleness guard.
- `resolution refuses an unapproved, zero-variance or already-resolved reconciliation`.
- `resolution takes no amount, account or recipient argument` and `cannot pay anybody`.
- `1190, 1195, 2900 and 5110 carry no cash_kind`; `total_liquidity and branch_cash_position are unchanged by every D-2 posting`.

**`tests/db/cash-investigation.test.ts`**
- `O1, O2, O3 each extinguish 2900 and recognize no expense` — **the regression test for the v1 direction error**, asserting the balance moves towards zero.
- `S1, S3 each extinguish 1190 and recognize no expense`.
- `S2 is refused while the account is flagged, and permitted before resolution` — the ordering rule.
- `no posting increases an investigation balance except the resolution and the reclassification`.
- `an amount in 1190 never expires and no job sweeps it`.
- `a receivable requires an Owner, documented evidence and a recorded counterparty`.
- `no receivable is created by default, by inference or by a Manager` (DD-4).
- `no salary-deduction path exists`.
- `a loss requires a completed investigation, an Owner who did not open it, evidence and a reason` (DD-5).
- `a Manager cannot authorize a loss`; `no automatic path reaches 5110`.
- `a failed claim moves from 1195 to 5110 only with fresh authorization`.

**`tests/db/deposit-ageing-and-recovery.test.ts`**
- `nothing posts at the ageing threshold; a notification is raised` (DD-2).
- `reclassification requires evidence, an independent actor and a reason`.
- `a verified return credits 1190 after reclassification and 1050 before it`.
- `a partial return posts only the verified amount and leaves the remainder` (DD-3).
- `cumulative verified returns can never exceed the deposit amount`.
- `a replayed return is idempotent and cannot double-recover`.
- `1050 and 1190 never go negative through any recovery path`.
- `bank clearance remains full-or-nothing` (A-7).

**`tests/db/borrower-protection.test.ts`**
- `a cash shortage leaves every loan balance, arrears figure, installment outcome and deadline identical`.
- `a correction is refused where the payment occurred` (C6).
- `no D-2 function reads or writes loan_payments or payment_allocations`.
- `every D-2 posting is a new entry; no historical line moves`.

**`tests/db/rls-cash-difference.test.ts`** — under D-1's grants: `anon` denied;
an unassigned non-Owner profile has no access; a branch-granted profile sees
only its branches; a Head Office officer reaches only granted branches; reading
`1190`/`1195` needs `ledger:view` **and** a grant; no write grants; loss
authorization refused to a Manager; direct Data API and raw RPC attempts
refused.

**`tests/db/cash-difference-concurrency.test.ts`** — real parallel connections on
PR #25's advisory-lock harness: two resolutions of one reconciliation (exactly
one succeeds); a resolution racing a payout; a count racing a posting (closing
D2-b); a return racing a reclassification; a loss racing a recovery on one
`1190` balance; the lock-order probe over the cash account and `1190` in both
orders. Each case holds **only** the advisory lock, posts nothing and takes no
reference.

**`tests/e2e/specs/cash-difference.write.spec.ts`** — a flagged account blocked
with payout controls disabled and the server still refusing a bypassed form; an
accurate account after a plain shortage **not** blocked; the resolution screen
showing counted figure, variance and destination; an investigation register with
`1190` ageing and no write-off action for a Manager; loss authorization
Owner-only, demanding reason and document, and refused to the investigation's
opener; a deposit shown `aged_unresolved` and never as returned; partial-return
entry refusing more than the outstanding amount; borrower screens unchanged
throughout; `@axe-core/playwright` and responsive passes.

---

## 11. Remaining blockers and open items — verification item 10

Named, not silently approved.

### 11.1 **B-1, accounting blocker: `1190` and `2900` at a reporting date**

`1190` is **not** supportable as an asset at a reporting date (§3.4): an
unexplained shortage is neither a controlled resource nor an enforceable right.
`2900` is supportable only while a present obligation is plausible, and an
unidentifiable overage generally requires income recognition — for which **no
destination account and no authorization are specified** (journal row 14).

DD-1 and DD-2 make long-open balances ordinary, so a reporting date will fall
inside an investigation window.

**Required:** a qualified accountant's determination of (a) the presentation of
`1190` and `2900` at a reporting date, (b) a period-end resolution policy, (c)
whether and when an unidentifiable overage becomes income and which account
receives it, and (d) the recognition test applied to each DD-4 claim.
**Compounded by** the absence of any closed-period concept in the schema, which
is itself a separate workstream. This is a financial-reporting blocker, not an
architecture defect.

### 11.2 **B-2, technical blocker: three reconciliation paths and a missing lock**

Implementation must, in one change: remove the `5950` posting from
`approve_reconciliation`, remove the opt-in `5950`/`5960` write-off from both
agency approval paths, add `lock_ledger_balances` to the lending count and
approval (**D2-b**), and adopt the agency staleness guard on the lending path.
Leaving any one undone leaves an automatic write-off or an unlocked read in
place, which DD-1 and rule 9 forbid.

### 11.3 Open items, not blocking

1. **Blocking policy for a plain shortage** (§9.4) — this certification does
   **not** block an account whose booked balance equals its counted cash.
   Confirm.
2. **Ordering rule for S2** (§4.3) — a correction against an already-flagged
   account is refused until its resolution completes. Confirm.
3. **Materiality figure** for DD-5's loss reporting — an Owner setting with no
   proposed default.
4. **A `finance-evidence` storage bucket does not exist.** The six existing
   buckets are `client-documents`, `guarantor-documents`, `loan-documents`,
   `membership-consent`, `benefit-documents` and `company-assets`. The clearance
   slip, physical-return, reclassification, correction, claim and loss evidence
   all need one, with its own RLS policies.
5. **`1190`/`2900` ageing report** — the operational surface that makes §8.1's
   "no expiry" supervisable rather than merely true.

---

## 12. Verdict

**The accounting architecture for D-2 is certified**, subject to B-1 and B-2.

| Verification item | Outcome |
| --- | --- |
| 1 — recheck all `1190`/`1195`/`2900`/`5110` journals | **done**, §3.3, fourteen rows |
| 2 — correct entries that increase an investigation balance | **three corrected** — O1, O2, O3 in §4.2; v1 named the wrong account and the wrong direction |
| 3 — worked examples for all six cases | **done**, §5.1–§5.6 |
| 4 — opening, physical, variance, journals, closing, suspense | **done**, every example |
| 5 — classification and asset recognition | **done**, §3.4; **accounting-professional review required — B-1** |
| 6 — locking, concurrency, maker-checker, RLS, borrower preservation | **done**, §9; one gap — **B-2** |
| 7 — `5950` cannot auto-recognize a variance | **done**, §6; three paths must change |
| 8 — strict sufficiency, no override | **confirmed**, §9.2; DD-1 removes the last amount-based bypass |
| 9 — requirement-to-test traceability | in `POLYTOS-DECISION-A-TECHNICAL-REVIEW.md` §9 |
| 10 — remaining blockers | **two named**, §11 |

**This certification concludes that no money is lost, owed by any person, or
owed by any borrower.** The default state of an unexplained amount is
"unexplained", with no automatic exit in either direction.

Development remains unauthorized. **Production remains NO-GO.**
