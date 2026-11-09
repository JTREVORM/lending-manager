# POLYTOS Phase 4E — Mobile Money: delivery report

**Branch:** `phase4e/mobile-money-2026-11-09`, created from
`phase4d/agency-banking-interface-2026-11-08` @ `38633d8` ·
**Design accepted at:** `befac86` · **Status:** database engine complete and
tested; application layer and browser coverage outstanding (§7).

No pull request has been merged. No production deployment, no hosted
migration, no change to any hosted financial or demonstration record. No
provider activated. Policy 2.0 not published. PRs #19–#26 untouched at their
audited SHAs, #19 still an independent merge. The integrated production
verdict stays **NO-GO**.

---

## 1. What the twelve approved decisions asked for, and what was built

| Decision | Delivered | Where |
| --- | --- | --- |
| **OD-1** Float purchases at face value, premium or discount | `5970 Agency Float Purchase Premium` and `4580 Agency Float Purchase Discount`; the difference is recognised in the purchase journal rather than absorbed into the float | `…000100`, `…001000` |
| **OD-2** Reconciliation never posts a financial change | `certify_agency_commission_reconciliation()` writes **no journal line of any kind**, and a certified variance stays on the exceptions view | `…001200`, `…001300` |
| **OD-3** Transfers between lines, within and across branches | `record_agency_float_trade('transfer', …)`, authority required at both ends, both provider-balance locks taken in branch-id order | `…001000` |
| **OD-4** Normal closure versus emergency suspension | `status` = active \| suspended \| closed; `agency_agent_line_obligations()` and `close_agency_agent_line()`; the transaction guard now lets a suspended line be *emptied* but not filled | `…000200`, `…000600`, `…001100` |
| **OD-5** Deposit fees on top; withdrawal fees deducted **or** collected | `customer_fee_mode`, with the collected case posting two lines on the same cash account so the gross movements are both recorded | `…000500` |
| **OD-6** External sales settle in full, fee optional and manual | A sale posts and settles in one entry; `fee_amount` is a cashier-entered integer with no rate anywhere; a credit sale is structurally impossible | `…000900`, `…001000` |
| **OD-7** Cashiers record, a different Manager or Owner verifies | `agency:float_trade` records; `agency:settlements` verifies, and verification is what posts. Maker ≠ checker is a CHECK; a pending row moves nothing because no journal exists until verification | `…000300`, `…000900`, `…001000` |
| **OD-8** Unique provider reference on a commission payout | Mandatory, with a per-line unique index — unlike Phase 4C's optional reference, whose partial index gave no protection at all when absent | `…000700` |
| **OD-9** The provider's exact statement dates; overlap detection; separate monthly reports | `submit_agency_commission_reconciliation()` with overlap refusal under the provider lock, and `agency_commission_monthly` kept separate | `…001200`, `…001300` |
| **OD-10** Reversal after payout becomes a recovery payable | `2230 Agency Commission Recovery Payable`; the reversal credits the receivable as far as it goes and the rest to 2230; `record_agency_commission_recovery()` clears it by float deduction or commission offset | `…000100`, `…000800` |
| **OD-11** Owner sets a ceiling per provider and service | `set_agency_service_limit()`, audited, refusing NULL and zero | `…000300` |
| **OD-12** Business date mandatory, provider time optional, entry time automatic | `transacted_at` added; `transaction_date` still decides the posting, in Africa/Kampala | `…000500` |

### What already existed and was reused unchanged

The deposit and withdrawal journals, the deferred commission accrual to
`1310`, per-line float accounts and their `1320.*` ledger codes, per-line
float reconciliation, branch cash reconciliation, the idempotency replay
guard, maker-checker on transactions, the revision check, `post_journal()` as
the sole writer, the two deferrable balance triggers, the lock discipline, the
branch-isolation rule and the append-only audit. The gap analysis at `befac86`
set that out; none of it was rebuilt.

---

## 2. Migration sequence

Thirteen migrations, applied in filename order. Every one is re-runnable:
re-applying the whole set to an already-migrated database is part of the
local loop.

| # | File | What it does |
| --- | --- | --- |
| 1 | `20261115000100_agency_money_chart_of_accounts` | `2230`, `4580`, `5970` with their parents |
| 2 | `20261115000200_agency_agent_line_identity` | line label, MSISDN, agent code, dates, notes; `status`; immutability trigger; configuration audit |
| 3 | `20261115000300_agency_money_permissions_and_limits` | `agency:float_trade`; `set_agency_service_limit()` |
| 4 | `20261115000400_agency_reported_commission` | `commission_source`; the two predicated relaxations; `agency_commission_for`/`_reconcile`; the readiness guard; `set_agency_provider_commission_source()` |
| 5 | `20261115000500_agency_customer_fee_mode` | `customer_fee_mode`, `transacted_at`; posting; `create_`/`update_agency_transaction` re-signed |
| 6 | `20261115000600_agency_reported_basis_and_suspension` | the snapshot CHECK's fourth basis; the transaction guard's two inactive states |
| 7 | `20261115000700_agency_commission_payout` | per-line outstanding; payout into float; the destination trigger; two source types |
| 8 | `20261115000800_agency_commission_recovery` | the recovery register and function; the reversal split |
| 9 | `20261115000900_agency_float_trades` | the float-trade register, its constraints and its revision guard |
| 10 | `20261115001000_agency_float_trade_functions` | record, verify, reject, reverse |
| 11 | `20261115001100_agency_agent_line_administration` | register, update, suspend/reinstate, close, obligations |
| 12 | `20261115001200_agency_commission_reconciliation` | the statement-period register, submit and certify |
| 13 | `20261115001300_agency_money_views` | six views, the register extension, three new exception kinds |

`PHASE_PREFIXES` in `scripts/verify-membership-upgrade.mjs` lists `20261115`.
Without it the upgrade verifier would classify this whole phase as released
schema — the exact defect the integrated release audit found for `20261104`.

---

## 3. The accounting, stated

Figures are illustrative UGX. Every entry below is asserted by its exact
lines, in order, in the test suites named in §4.

**Deposit** (unchanged from Phase 4B): Dr cash 100,000 · Cr line float 100,000
· Dr `1310` 700 · Cr `4510` 700.

**Withdrawal, fee deducted** (unchanged): Dr line float 50,000 · Cr cash
49,500 · Cr `4570` 500 · plus the commission pair.

**Withdrawal, fee collected separately** (OD-5): Dr line float 50,000 · Cr cash
50,000 · **Dr cash 500** · Cr `4570` 500 · plus the commission pair. The net is
identical to the deducted form; the gross is not, and a physical count
reconciles against movements.

**Commission payout** (OD-8): Dr line float 45,000 · Cr `1310` 45,000. No
income account is touched — the income was recognised per transaction.

**Reversal after payout** (OD-10): Dr `4510` 1,000 · Cr `1310` min(1,000,
outstanding) · Cr `2230` the remainder. Where nothing was paid out, the `2230`
leg is absent and the entry is what Phase 4C posted.

**Recovery, float deduction** (OD-10): Dr `2230` 1,000 · Cr line float 1,000.
**Recovery, commission offset**: Dr `2230` 1,000 · Cr `1310` 1,000 — no money
moves; two existing balances fall.

**Float purchase at face value** (OD-1): Dr line float 500,000 · Cr cash
500,000. **At a premium**: Dr line float 500,000 · Cr cash 500,500 · Dr `5970`
500. **At a discount**: Dr line float 500,000 · Cr cash 499,500 · Cr `4580`
500.

**Float sale with a fee** (OD-6): Dr cash 202,000 · Cr line float 200,000 ·
Cr `4570` 2,000. Total proceeds are computed; the fee is typed.

**Line-to-line transfer** (OD-3): Dr receiving line 300,000 · Cr sending line
300,000. No cash, no income, consolidated float unchanged — which is why
`agency_mobile_money_consolidated` reports transfers in their own two columns
and excludes them from the purchase and sale totals.

### The invariant the suites assert after every scenario

`1310` and `2230` are each one general-ledger account shared by every provider
and every line, so the per-line figures are **derived** from the ledger through
each entry's source rather than stored beside it. After each scenario the sum
of the per-line figures is checked against the account's own balance. That is
the single assertion that catches a payout posted against the wrong line, a
double recognition, or a reversal that forgot the receivable.

---

## 4. Test results

Against real PostgreSQL throughout, on a database built from the migrations
on each run.

| Suite | Tests | Covers |
| --- | --- | --- |
| `tests/db/agency-money-foundation.test.ts` (new) | 54 | the three accounts; agent-line identity and immutability; suspension and closure; service ceilings; reported commission; fee modes; timestamps; the Owner's five controls |
| `tests/db/agency-money-commission.test.ts` (new) | 28 | payout, partial payout, over-payout, duplicates, per-line attribution, suspension and closure rules; the OD-10 split and both recovery methods; the statement-period reconciliation and its silence |
| `tests/db/agency-money-float.test.ts` (new) | 32 | a pending trade moving nothing; all four purchase and sale journals; transfers within and across branches; maker-checker; stale revisions; rejection; reversal; suspension rules; and four concurrency races — a sale behind a held line, two sales of the same float where only one may win, two opposing cross-branch transfers that must not deadlock, and a payout behind the line it pays into |

Existing suites, all still passing with every behaviour change above:

| Suite | Tests |
| --- | --- |
| `db` (83 files, including the schema, security, RLS-hoisting and balance-invariant inventories) | 1,950 |
| `agency` (Phase 4A foundation) | 66 |
| `agency-engine` (Phase 4B) | 64 |
| `agency-security` (4B-S closure) | 21 |
| `agency-settlement` (Phase 4C) | 78 |
| `shared-till` (Workstream A) | 6 |
| `unit` + `integration` | 2,682 |

Gates: `scripts/check-database-security.mjs` passes on a clean build;
`scripts/audit-financial-arithmetic.mjs` passes; typecheck, lint and format
clean.

### Existing financial data is provably preserved across the upgrade

`scripts/verify-membership-upgrade.mjs` applies the released schema, seeds a
real book of loans, payments, memberships, savings and benefits, then applies
every unreleased migration — all thirteen of this phase included — and compares
28 financial figures before and after:

> Upgrade verified: 97 existing migrations, a seeded book, then 114 new
> migrations. Every one of 28 financial figures is identical, the 22
> membership, savings, member loan, benefit and meeting tables exist and are
> empty, and 2100 Member Savings is zero.

The three new ledger accounts appear among "28 new account(s), all at zero",
and the only new audit rows are configuration. Nothing this phase adds moves a
shilling of existing money, which is the property that matters when these
migrations are eventually applied to a database that holds real records.

### Three existing tests were rewritten, because an approved decision changed the behaviour they asserted

Not because they were wrong. OD-10 replaced a refusal with an accounting
treatment, and these three asserted the refusal:

- `agency-transaction-engine.test.ts` — "refuses a reversal whose commission
  has already been settled" now asserts the reclassification to `2230` and
  that the receivable does not go negative;
- `agency-settlement.test.ts` — "releases a historical transaction that the
  settlement had blocked" became "reverses a transaction whose commission was
  already settled, and records what is owed back", and ends with the offset
  recovery that closes both figures. Phase 4C's version ended by netting them
  to zero inside `1310` — tidier, and it said less;
- the lock-and-resource matrix gained four rows and its completeness check two
  exclusions.

---

## 5. Where an approved requirement met an existing invariant

The brief asked that these be documented and resolved in the accounting design
before the posting code changed. Three arose, all found by running the engine
rather than by reading it.

**The snapshot basis CHECK.** `agency_transactions_snapshot_basis_agrees` tied
the recorded commission basis to the figures it was derived from, and a
reported commission has neither a rate nor a fixed amount — so every reported
posting was refused. The invariant was complete for three bases; there are now
four, and the fourth asserts its own agreement rather than leaving the columns
unconstrained.

**The transaction guard and a suspended line.** The guard refused every write
against an inactive till, and a reversal is a write. Suspending a compromised
line therefore trapped the float the suspension existed to protect, and the
only route to the money was to un-suspend the compromised line. The two
inactive states are now distinguished: `closed` refuses everything,
`suspended` refuses new business and permits exactly one transition — a posted
transaction becoming reversed. That is the same exemption the readiness guard
already made for a provider switched off after the fact.

**Per-line attribution versus the provider total.** The first version of the
OD-10 split used the per-line receivable alone to decide how much a reversal
could credit back. A Phase 4C settlement into cash names no line, so it clears
receivable the per-line view still counts as outstanding, and the provider
total went to −5,000. Both figures bind, so the lesser of the two decides.

---

## 6. Defects the project's own gates caught

Recorded because the gates are the reason the work is trustworthy, not a
formality.

| Gate | What it caught |
| --- | --- |
| `tests/db/schema.test.ts` — no floating-point or money type | **17 `numeric` columns** in the new views. `sum()` over a `bigint` returns `numeric`, and integer money is ADR-002; every aggregate is now cast back to `bigint` |
| `scripts/check-database-security.mjs` | a grant my own migration had widened to `authenticated` on `agency_commission_outstanding`, which Phase 4C had deliberately revoked; and `agency_commission_recovery_outstanding_by_line` left reachable by `anon` for want of a revoke |
| `tests/db/rls-hoisting.test.ts` | three new policies calling `user_can_see_branch(branch_id)` — correlated *and* SECURITY DEFINER, so two queries against `profiles` **per row**. All three restate the branch rule inline now |
| `tests/db/security.test.ts` — policy roles | the same three policies not scoped `to authenticated` |
| `agency-engine` and `agency-settlement` | the per-line attribution bug above, and three refusal messages my first rewrite of `agency_commission_for` had silently reworded |
| the lock-and-resource matrix | four new posting functions unclassified |
| `tests/integration/migrations.test.ts` | a bare `timestamp` cast in a view, and the generated types out of step with the schema |

And one bug the tests caught that nothing else would have:
`record_agency_float_trade` held the receiving line's branch as `c.branch_id`
inside a `CASE` that would not have chosen it for a purchase or a sale.
PL/pgSQL evaluates every parameter of an `INSERT` before the statement runs,
so the unassigned record raised regardless of the `CASE`, and every
non-transfer trade failed.

---

## 7. What is not done

Stated plainly, because the brief asked for it and it is outstanding.

| Outstanding | Note |
| --- | --- |
| **Application layer** | No new route, component, data reader or server action. The screens for recording a float trade, verifying one, paying commission in, recovering it, reconciling a statement and administering an agent line do not exist. §7 of the gap analysis at `befac86` sets out the plan: a provider-scoped route template under `app/(app)/agency/money/[providerCode]/`, driven by the provider table rather than hardcoded MTN and Airtel sections |
| **Browser-to-database coverage** | `tests/e2e/specs/agency-money.write.spec.ts` is not written. The existing 1,005 browser tests pass against the new schema, which proves the Phase 4D screens are unaffected, but no new workflow has been driven through a browser |
| **The MTN and Airtel dashboards** | The data behind them exists — `agency_mobile_money_dashboard` and `agency_mobile_money_consolidated` — but nothing renders them |
| **CI on the final head** | CI ran on each push. At `64aacfb` the browser E2E and the PostgreSQL 17 release rehearsal both passed; the other two jobs failed on the inventory tests this slice fixes. A green run on the final head is needed and is the first thing to confirm |

Everything in §1 through §6 is complete and tested at the database level. What
is missing is the interface over it.

---

## 8. Release conditions, unchanged

The integrated release audit's verdict stands, and nothing in this phase
changes it:

- **NO-GO** for real client money.
- The Supabase organisation is on the **free tier**: no managed backups, no
  point-in-time recovery, idle projects pause.
- The production URL is behind **Vercel SSO** with no custom domain.
- **No branch is protected** on GitHub.
- **Lending cash sufficiency** (Decision A) is unresolved: a loan
  disbursement, a savings withdrawal and a benefit payment can still take Cash
  at Hand negative. Untouched by this phase.
- **Provider commercial terms** are unapproved. MTN and Airtel remain
  `is_provisional = true`, `is_active = false`, with `commission_source` left
  at `configured` — setting it to `reported` is the Owner's call through an
  audited function. Nothing can post against either until their terms **and**
  decision OD-11's ceilings are approved.
- The active membership policy on the hosted project is still version
  **999.0, "DEMONSTRATION ONLY"**.
- **Decision L** (approval thresholds) remains open, and
  `requires_approval_above` is deliberately still not settable.
- **Agent Banking** posting behaviour is untouched, pending the client's
  business explanation.

---

## 9. Boundaries honoured

No merge. No production deployment or migration. No hosted financial or
demonstration record read for anything but the audit, and none changed. No
provider activated and no commercial rate invented — the only provider
configuration this phase ships is the *mechanism* for the Owner to state one.
Policy 2.0 not published. No authentication, RLS, financial safeguard or CI
gate weakened: every new grant is narrower than the one it sits beside, every
new policy is `SELECT` only, every write goes through a function that refuses
without its capability before it reads an argument, and five existing gates
were tightened rather than relaxed.
