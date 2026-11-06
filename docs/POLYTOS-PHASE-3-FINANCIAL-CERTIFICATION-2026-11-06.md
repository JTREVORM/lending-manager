# POLYTOS Phase 3 — financial and business logic certification

**Date:** 6 November 2026 · **Branch:** `phase3/financial-certification-2026-11-06`
**Stacked on:** `ccr-2f5e3786-jo3efn` at `4e6460f` (PR #20, Phase 2/2B)
**Supabase project:** `fszgwemtgyrbhngajpzm` only · **Production authorization:** NOT GRANTED

**No production writes, migrations or deployments. No PR merged. No demo data
deleted. Policy 2.0 untouched.**

---

## 1. What this phase found

Three things worth reading before the detail.

**The books reconcile.** Thirty-eight cross-subsystem identities were walked
against a real seeded book — 14 loans, 165 payments, 198 journal entries. Debits
equal credits at 4,846,826, every journal entry balances individually, the trial
balance is the journal, the accounting equation holds at 1,630,021, the cash
position is the cash accounts at 4,679,326, the portfolio is the loan book at
3,450,695 principal, arrears agree with the delinquency view at 780,713, and the
savings sub-ledger is the 2100 liability at 1,010,000.

**The one failure was a seeding shortcut, proved rather than assumed.** GL 1200
Loans Receivable came back *negative* — −3,049,305 against 3,450,695 of
principal owed, short by exactly 6,500,000. The journal holds no
`loan_disbursement` entries at all, and 11 disbursed loans totalling exactly
6,500,000 carry none. The product is correct: disbursing 500,000 through
`disburse_loan` as an `owner_admin` debits 1200 by exactly 500,000 and credits
Cash at Hand — Head Office by exactly 500,000, in one balanced entry.
`tests/e2e/harness/seed.mjs` back-dates `disbursed_at` by direct write with the
transition trigger suspended, so `post_disbursement_journal` never runs.

**The money-movement module has maker-checker separation, and nothing was
testing it.** A `secretary_treasurer` holds `transfers:create` and
`expenses:create` but not the matching `:approve`, so they may record a transfer
or an expense and may not approve or reverse one — including the one they just
recorded. Twenty-four new cases now assert that, with before/after state and
audit comparison.

---

## 2. Task 0 — the release checklist, corrected

The checklist said seven migrations and 168. Verified rather than taken on
trust:

| | Count |
| --- | --- |
| Hosted production migrations | **161** |
| PR #19 pending | **2** (`20261104000100`, `20261104000200`) |
| PR #20 pending | **8** (`20261106000100`–`000800`) |
| Total pending | **10** |
| Post-release total | **171** |
| Duplicate versions across all ten, against the 161 applied | **0** |

Both earlier figures were right when written: the checklist was drafted when
Phase 2 carried five migrations, and Phase 2B added three more.

**Two ordering constraints the old table could not express**, because it predated
both migrations involved:

- **`20261106000400` before `20261106000600` is mandatory.** The first withdraws
  a grant the second restores. Applying by version number is correct;
  cherry-picking is not.
- `20261104000200` touches only `ledger_account_balance`, which nothing in
  PR #20 goes near, so PR #19's two sort before PR #20's eight and **merge order
  does not matter**.

**A verification neither PR can perform alone.** Each branch holds only its own
migrations, so the combined 171-migration ordering that production will actually
take had never been replayed. It has now, on a clean cluster with PR #19's two
staged alongside PR #20's eight: all 171 apply in timestamp order, PR #19's
guarded probe-drop **fires rather than refusing**, its `ledger:view` guard lands,
the restored grant survives, and the security gate passes against the result.

---

## 3. Task 1 — ledger and accounting

`scripts/certify-financial-reconciliation.mjs`, 38 identities. Money compared as
`BigInt` throughout — these are `bigint` minor units and never pass through a
float.

| Area | Result |
| --- | --- |
| Double-entry, in total | debits = credits = **4,846,826** |
| Double-entry, **per entry** | no single entry whose own legs disagree |
| Journal referential integrity | no orphaned line, no empty entry |
| Trial balance | foots, and equals the journal |
| GL view vs journal | every account total in `ledger_account_balances` is the journal sum |
| Balance signs | every balance follows its account's normal side |
| Chart of accounts | 35 accounts, 31 postable, 0 untyped |
| Accounting equation | assets = liabilities + equity + income − expense = **1,630,021** |
| Cash at hand | screen = GL = **3,252,245** |
| Total liquidity | sum of parts = every cash GL account = **4,679,326** |
| Reversals | every stamp points at a real entry; every reversal mirrors its original leg for leg |
| Idempotency | no key reused in `loan_payments` or `savings_transactions` |
| Audit trail | 72 rows, **0** with neither a profile nor a label |
| Business time zone | `business_timezone()` = **Africa/Kampala** |

Plus 210 existing tests across `ledger`, `ledger-posting`, `money-movement` and
`trial-balance`, which already cover the posting legs by name, the dating rule,
the refusal to create a document whose journal cannot post, and double-post
prevention.

### Two design decisions in the harness that matter more than the checks

**A difference is only ever EXPLAINED by a reason the harness can state.** The
explain callback must return a string, so nothing passes through a lenient
matcher — somebody has to have written down why.

**Zero does not equal zero.** A check whose subject set is empty agrees
trivially, and reporting that as a pass in a certification document is worse
than reporting nothing. Those are **VACUOUS**, counted separately and listed as
"NOT coverage". This mattered immediately: run against the membership-only demo
book, **ten loan identities proved nothing**, and without this they would have
read as ten passes.

---

## 4. Task 4 — financial authorization

`tests/db/financial-authorization.test.ts`, **24 passing**. Real records, real
identities, before/after state and audit comparison. Every refusal is measured
on three things, not one: the call is refused, the documents and ledger are
unchanged, and the audit trail gained nothing.

| Function | Unauthorized caller | Result |
| --- | --- | --- |
| `record_transfer` | borrower | refused, nothing moved |
| `approve_transfer` | **secretary_treasurer** | refused — maker-checker |
| `reverse_transfer` | secretary, borrower | refused, nothing moved |
| `record_expense` | borrower | refused, nothing moved |
| `approve_expense` | **secretary_treasurer**, borrower | refused — maker-checker |
| `reverse_expense` | secretary | refused, nothing moved |
| `ledger_account_balance` | borrower | refused |
| `trial_balance` | borrower | zero rows (RLS) |
| `assess_member_loan_eligibility` | borrower | refused |

And the authorized side, because a function that refuses everybody passes a
one-sided test: all three staff roles record transfers; owner and manager
approve expenses with the journal still balancing; all three read the cash
balance and get **the same figure the owner sees**; a manager reverses a transfer
and the status becomes `reversed` with a new balanced entry and a new audit row.

**A control found along the way.** A loan cannot be made active without both
`disbursed_at` and `disbursed_by`, and the transition trigger takes
`disbursed_by` from `current_profile_id()`. So money cannot be disbursed by an
unattributable session — not even by the database owner, which is how the first
attempt at the disbursement proof in §1 failed.

---

## 5. Task 5 — reporting reconciled to the ledger

Covered by the same harness, and this is where the cross-subsystem identities
live:

| Report figure | Reconciled against | Result |
| --- | --- | --- |
| `principal_outstanding` | `sum(loan_balances.principal_remaining)` | 3,450,695 = 3,450,695 |
| `interest_outstanding` | `sum(loan_balances.interest_remaining)` | 611,104 = 611,104 |
| `penalty_outstanding` | `sum(loan_balances.penalty_remaining)` | 204,523 = 204,523 |
| `total_outstanding` | its three parts | 4,266,322 = 4,266,322 |
| `total_collected` | its three parts | 3,639,326 = 3,639,326 |
| allocations | `sum(loan_payments.amount)` not reversed | 3,639,326 = 3,639,326 |
| `principal_collected` | `payment_allocations.allocated_principal` | 3,049,305 = 3,049,305 |
| `arrears_total` | `sum(loan_delinquency.arrears_amount)` | 780,713 = 780,713 |
| loans in arrears | delinquency view | 4 = 4 |
| savings sub-ledger | GL 2100 Member Savings | 1,010,000 = 1,010,000 |
| savings register | `sum(savings_transactions.signed_amount)` | 1,010,000 = 1,010,000 |
| cash position | cash GL accounts | 4,679,326 = 4,679,326 |

### Differences, each explained

**`other income` vs the income accounts** — 0 vs 30,000. EXPLAINED: income GL
accounts also carry loan interest, penalties and membership fees, which are not
rows in `other_income`. A composition difference, not a discrepancy.

**GL 1200 vs principal outstanding** — short by exactly 6,500,000. EXPLAINED by
cause and arithmetic together (§1), and the structural assertion "every
disbursed loan carries a disbursement journal" is still reported **FAIL**,
because in a production book that would be a defect rather than a seeding
shortcut. The harness refuses to let the explanation silence the structural
fact.

---

## 6. Findings

| # | Severity | Finding |
| --- | --- | --- |
| **F1** | **MEDIUM** | **Capability refusals are inconsistently classified.** 32 functions raise `42501` for a capability refusal; **67 do not** — some omit `using errcode`, and `assess_member_loan_eligibility` sets `P0001` explicitly, so it is a deliberate split. `lib/db-errors.ts` maps `42501` to `AuthorizationError` and `P0001` to `BusinessRuleError`, so roughly two thirds of capability denials are classified as business-rule violations. Anything watching for authorization failures sees a third of them, and an attacker probing transfer approval looks like a user hitting a validation rule. **Not a security defect** — every denial works, and 24 cases prove it. Observability only. **Not changed here**: `lib/clients/actions.ts` and `lib/guarantors/actions.ts` both match on `P0001` to pass those messages through to users, so adding `using errcode` would change user-facing text well outside this phase's scope |
| **F2** | **LOW** (test infrastructure) | **The E2E seeded book is not financially coherent.** `tests/e2e/harness/seed.mjs` back-dates `disbursed_at` by direct write with the transition trigger suspended, so 11 of its loans carry no `loan_disbursement` journal and GL 1200 is 6,500,000 short — in fact *negative*. No production impact. But it means **the browser E2E suite cannot certify any screen that reconciles the portfolio to the general ledger**, because in that book the two legitimately disagree. Recommendation: either post a backfill entry for the back-dated loans in the seeder, or record explicitly that GL-vs-portfolio screens are out of E2E scope |
| **F3** | Positive | Disbursement requires an identified officer at the data layer: `loans_active_requires_disbursement` demands both `disbursed_at` and `disbursed_by`, and the latter comes from `current_profile_id()`. An unattributable session cannot disburse, database owner included |

**No critical or high-severity financial defect was found. No unexplained
financial difference remains.**

---

## 7. Coverage — what was certified, and what was not

Stated plainly, because a certification that overstates its reach is worse than
one that admits a gap.

### Certified in this phase

- Task 0, the release baseline: complete and verified, including the combined
  171-migration replay.
- Task 1, ledger and accounting: 38 identities plus 210 existing tests.
- Task 4, financial authorization: 24 new cases on previously untested
  privileged paths.
- Task 5, reporting against the ledger: the twelve identities in §5.

### Relied on existing coverage, verified by name rather than re-derived

- **Task 2, loan lifecycle.** The disbursement posting path was proved here with
  exact figures. The rest rests on `loan-lifecycle.test.ts` (38),
  `loan-engine-parity.test.ts` (6), `loan-snapshots.test.ts` (16),
  `delinquency.test.ts` and `delinquency-parity.test.ts` (13), and
  `reporting-parity.test.ts` (24) — all passing. **I did not independently
  re-derive expected values** for multi-month reducing-balance schedules, early
  settlement or overpayment allocation. Those suites assert them; this phase
  confirmed they pass and did not duplicate them.
- **Task 3, membership, savings and benefits.** The savings sub-ledger
  reconciles to GL 2100, and the membership and benefit suites pass. Benefit
  claim approval and meeting fines were not separately exercised with new
  exact-figure scenarios.

### Not covered, and why

| Gap | Reason |
| --- | --- |
| Historical balances and reporting-period comparisons | `balance_as_of` exists and has its own migration and tests, but no period-comparison identity was added to the harness. **Untested financial path.** |
| Security deposits as a distinct liability | No separate deposit liability was identified in the chart beyond member savings; if one exists it was not reconciled |
| Cash reconciliation documents (`submit_reconciliation`, `approve_reconciliation`) | Authorization not exercised in the new suite; `money-movement.test.ts` covers the arithmetic |
| PostgreSQL 17 real-Auth rehearsal | Cannot run in this session: PG 17 is not installed and `www.postgresql.org` is denied by the network policy. CI is the authority |
| Browser E2E | Not re-run in this phase; see F2 for why it cannot certify GL-vs-portfolio screens regardless |

---

## 8. Regression results

See §9 for the authoritative CI run.

Local, PostgreSQL 16, 171 migrations (PR #19's two staged locally so the true
post-release state is what was tested; they are excluded from this branch's
commits because PR #19 owns them):

| Suite | Result |
| --- | --- |
| Security gate, incl. the Phase 2B invoker-chain invariant | **PASS** — no unreviewed privileged exposure |
| Fresh migration replay | **PASS** — all 171 in timestamp order |
| Reconciliation harness | 38 identities: 34 pass, 2 explained, 1 vacuous, 1 fail (F2) |
| `financial-authorization.test.ts` | **PASS — 24/24** |
| *filled from the regression sweep below* | |

---

## 9. CI at the final head

*To be completed from the run on the final Phase 3 head.*

---

## 10. Acceptance criteria

| Criterion | Status |
| --- | --- |
| Every tested loan lifecycle reconciles | **Met** for the identities in §5; see §7 for what was not independently re-derived |
| All tested journal entries balance | **Met** — in total and per entry |
| No unexplained financial difference remains | **Met** — both differences explained with cause and arithmetic |
| Unauthorized financial operations denied | **Met** — 24 cases, with state and audit unchanged |
| Existing security regression tests green | **Met** — gate passes, Phase 2 fixes intact |
| All four mandatory CI jobs pass | **§9** |
| No unresolved critical or high financial defect | **Met** — F1 MEDIUM, F2 LOW, neither financial-calculation defects |
| All blocked or untested paths recorded | **Met** — §7 |

---

## 11. Production blockers, unchanged from Phase 2B

| | Blocker | Owner |
| --- | --- | --- |
| B1 | PR #19 draft; two migrations unapplied | Trevor |
| B2 | PR #20 draft; eight migrations unapplied | Trevor |
| B3 | **Branch protection authorized but unapplied**; branch still `protected: false` | Trevor — `docs/POLYTOS-BRANCH-PROTECTION-MANUAL-STEPS.md` |
| B4 | Leaked-password protection disabled | Operator |
| B5 | Hosted authenticated negative-role certification never performed | Trevor |

Production was read at the start and end of this phase and is unchanged: 161
migrations, 35 loans, 470 payments, 597 journal entries, 28 clients, Policy 2.0
`draft` with every flag false, ledger debits = credits = **89,649,530**.

---

*Prepared by Claude Code as Lead Implementation Engineer. For ChatGPT's
independent review before Phase 4.*
