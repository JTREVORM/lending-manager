# POLYTOS — Phase 4C Delivery Report

**Scope:** agency settlement, float replenishment, reconciliation and
reporting — the accounting that happens *after* a transaction is posted.
**Branch:** `phase4c/agency-settlement-reconciliation-2026-11-07`, cut from the
reviewed 4B-S head `1d30d5d`. Draft stacked PR onto the Phase 4B branch.
**Authorization:** draft only. Not merged, not deployed, no provider activated,
Phase 4D not begun. Production untouched.
**Migrations:** 192 on this branch.

---

## 1. Functions implemented

| Function | Capability | What it does |
| --- | --- | --- |
| `record_commission_settlement` | `agency:settlements` | Records a provider's remittance of accrued commission |
| `reverse_commission_settlement` | `agency:reverse` | Corrects a settlement recorded in error, by contra |
| `post_agency_payable_settlement` | `agency:settlements` | Remits collections held on a provider's behalf |
| `reverse_agency_payable_settlement` | `agency:reverse` | Reverses a remittance, restoring the liability |
| `post_float_replenishment` | `agency:settlements` | Tops up one provider float till |
| `submit_agency_cash_reconciliation` | `agency:reconcile` | Records a physical count of a branch till |
| `approve_agency_cash_reconciliation` | `agency:reconcile` (+ `agency:variance_adjustment` to adjust) | Certifies a count, optionally writing off to 5950 |
| `submit_agency_float_reconciliation` | `agency:reconcile` | Records a till against a provider statement |
| `approve_agency_float_reconciliation` | `agency:reconcile` (+ `agency:variance_adjustment` to adjust) | Certifies a statement, optionally writing off to 5960 |

Supporting, all revoked from `authenticated`:
`lock_agency_provider_balance`, `assert_agency_settlement_account`,
`agency_locked_payable_settlement`, `agency_locked_commission_settlement`,
and two trigger guards.

## 2. Exact journals

**Commission settlement** (§6.8). 4510 is **not** touched — the income was
recognised at accrual, and posting here would recognise it twice.

| Account | Dr | Cr |
| --- | --: | --: |
| 1010-BR2601 Cash at Hand | 1,500 | |
| 1310 Agency Commission Receivable | | 1,500 |

**Commission settlement correction.** Restores the receivable and takes the
cash back out of the account it was received into.

| Account | Dr | Cr |
| --- | --: | --: |
| 1310 Agency Commission Receivable | 10,000 | |
| 1010-BR2601 Cash at Hand | | 10,000 |

**Payable settlement** (§6.9). Never `record_transfer()` — a payable account
has `cash_kind IS NULL` and `assert_cash_account()` refuses it outright.

| Account | Dr | Cr |
| --- | --: | --: |
| 2220 Bank Agency Payable | 200,000 | |
| 1010-BR2601 Cash at Hand | | 200,000 |

**Payable settlement reversal.** The mirror.

| Account | Dr | Cr |
| --- | --: | --: |
| 1010-BR2601 Cash at Hand | 250,000 | |
| 2220 Bank Agency Payable | | 250,000 |

**Float replenishment** (§6.10).

| Account | Dr | Cr |
| --- | --: | --: |
| 1320.SETF1.BR2601 Provider float | 500,000 | |
| 1040-BR2601 Cash at Bank | | 500,000 |

**Variance adjustments — all four signed cases.** The two tables use
**opposite** generated variance conventions, so the direction is derived per
table and nothing is shared between them:

| Case | Variance | Dr | Cr |
| --- | --- | --- | --- |
| Cash over (physical above books) | +3,000 | till | 5950 |
| Cash short (physical below books) | −4,000 | 5950 | till |
| Float over (books above statement) | +1,000 | 5960 | float till |
| Float short (books below statement) | −2,500 | float till | 5960 |

## 3. Per-provider and per-branch balances

GL 1310, 2210 and 2220 are each **shared** across providers, so no balance in
this phase is read from an account. Every outstanding figure is attributed by
**source entity** — the transaction or settlement the entry came from — and
scoped to one branch:

- `agency_commission_outstanding(provider, branch)` — amended this phase to
  count settlement corrections (§7 below).
- `agency_payable_outstanding(provider, branch)` — from 4B-S, unchanged.

Proved rather than asserted: one bank's 400,000 of collections does not fund
another bank's 50,000 settlement, though both post to 2220; and a branch
cannot settle another branch's payable or receivable.

## 4. Concurrency and idempotency

**The lock order, obeyed by every function in this phase:**

```
provider/branch financial lock  →  sorted account locks  →  fresh balances  →  atomic posting
```

A commission settlement is not contended on an *account*: 1310 is shared, so
locking it would serialise every provider against every other while still not
protecting the real resource — one provider's receivable at one branch.
`lock_agency_provider_balance()` adds that second dimension, and a second
dimension is where deadlocks come from. Hence one rule: **the provider lock is
always taken before `lock_ledger_balances()`**, giving a single global order
across both keyspaces.

A test reads this off `pg_get_functiondef` for every function that takes both
locks and fails if any takes them the other way round — so a function added
later cannot quietly reverse the order.

Races proved, each refusal quoting the balance the *other* transaction's
commit left behind, which is what shows the read happens after the lock:

| Race | Result |
| --- | --- |
| Two 6,000 commission settlements against a 10,000 receivable | second refused, quoting 4,000 |
| A 60,000 bank withdrawal verified while a 60,000 payable settlement is issued | settlement refused, quoting 40,000 |
| A settlement and a float replenishment on one provider, interleaved | **both complete** — no deadlock |

Idempotency and duplicate protection: a partial unique index per external
reference on commission settlements (pre-existing), payable settlements and
replenishments (both added this phase, deviation D5); a unique
`(account, date)` per reconciliation; and every reversal refuses a second
attempt.

**The stale reconciliation.** A count is taken against a balance. If cash
moves before approval, the variance no longer describes anything and writing
it off would post a correction that was never measured. Both approval
functions re-read the balance under the lock and refuse, naming both figures.

## 5. Reversal and correction rules

| Operation | Mechanism | Authority |
| --- | --- | --- |
| Payable settlement | contra entry, original row annotated | `agency:reverse` |
| Commission settlement | contra entry, original row annotated | `agency:reverse` |
| Agency transaction | Phase 4B, unchanged | `agency:reverse` / `agency:reverse_cross_day` |

Nothing is ever deleted. Each reversal records who, when, why and which contra
entry, enforced by completeness CHECKs.

**Deviation D7, and the bug that omitting half of it would have caused.**
Phase 4B refuses to reverse a transaction whose commission has been settled —
correctly. But with no way to correct a settlement, one recorded in error
**permanently** blocked an otherwise valid historical reversal. The correction
closes that, and `agency_commission_outstanding()` had to be amended in the
same migration: it netted only against `agency_commission_settlement`, so a
correction posting a new source type would not have been counted, the
receivable would have stayed understated for ever, and the next genuine
settlement would have been refused as excessive with nothing to explain why.
That is the silent negative receivable Task 7 forbids, arriving by omission.

A test walks it end to end: accrue, settle, attempt the reversal (refused),
correct the settlement, reverse successfully, and the receivable nets to zero.

## 6. Maker-checker and permission matrix

| Capability | Roles | Covers |
| --- | --- | --- |
| `agency:settlements` | manager, owner_admin | recording settlements and replenishments |
| `agency:reverse` | manager, owner_admin | correcting a settlement |
| `agency:reconcile` | manager, owner_admin | submitting and certifying counts |
| `agency:variance_adjustment` | **owner_admin only** | writing a variance into the ledger |

`agency:variance_adjustment` is new this phase. Recording a count and moving
its difference into the books are different acts: without the split, a manager
who miscounts can certify the miscount. A test shows the same manager refused
the adjustment and then allowed to certify without one.

Maker-checker on both reconciliations: a CHECK on each table, refused first in
the RPC with a sentence rather than a constraint name.

## 7. Migrations and counts

Six new migrations, `20261110000100`–`000600`:

| Migration | Contents |
| --- | --- |
| `000100` | provider/branch lock, settlement-account assertion, commission settlement |
| `000200` | payable settlement, its reversal, duplicate-receipt index |
| `000300` | float replenishment: table, source type, function |
| `000400` | both reconciliations, maker-checker CHECKs, `agency:variance_adjustment` |
| `000500` | commission settlement correction, amended outstanding function |
| `000600` | seven `security_invoker` reporting views |

**Counts, recomputed from the directory.** 161 production + 2 (PR #19, not on
this branch) + 8 (#20) + 0 (#21) + 11 (#22) = 180 base; +4 Phase 4B +2
Phase 4B-S = 186 at the reviewed head; **+6 Phase 4C = 192** on this branch;
**194** for the complete release once #19 lands.

## 8. Tests

Every figure below is from a run on this branch at 192 migrations.

| Suite | Result |
| --- | --- |
| `agency-settlement.test.ts` (new) | **PASS — 63/63** |
| `ledger-balance-invariant.test.ts` | **PASS — 27/27** (21 + 6 for the two new source types) |
| `agency-transaction-engine.test.ts` | **PASS — 62/62** |
| `agency-foundation.test.ts` | **PASS — 66/66** |
| `agency-security-closure.test.ts` | **PASS — 21/21** |
| `db` project | **PASS — 1,923** |
| four seeder projects | **PASS — 82** |
| **`npm run test:db` (nine projects)** | **PASS — 2,217** |
| `npm run test:run` (unit + integration) | **PASS — 2,658** |
| Database security gate | **PASS — no unreviewed privileged exposure** |
| Financial reconciliation certification | **PASS — 36 pass, 2 explained, 0 vacuous, 0 fail** |
| Historical migration upgrade rehearsal | **PASS — 120 existing + 72 new, 28 financial figures identical** |
| Arithmetic hazard scan | **PASS — 240 files, 6 acknowledged exemptions, verified by injection** |
| typecheck · lint · format · build | **PASS** |
| Browser E2E · PostgreSQL 17 real-Auth rehearsal | **CI only** — no PostgREST or Auth binary here, PostgreSQL 16 only |

Nothing was skipped. The two CI-only gates cannot run in this sandbox and are
named rather than omitted, because a gate nobody ran is not a gate that
passed.

### The 63 settlement tests, by task

| Block | Tests |
| --- | --- |
| Commission settlement (Task 2) | 11 |
| Payable settlement and reversal (Task 3) | 9 |
| Float replenishment (Task 4) | 7 |
| Cash reconciliation (Task 5) | 10 |
| Float reconciliation (Task 6) | 8 |
| Commission settlement correction (Task 7) | 4 |
| Reporting views (Task 8) | 6 |
| Security certification (Task 9) | 6 |
| Cross-cutting lock order | 2 |

Fixtures are meaningful and non-vacuous throughout: partial settlements
(4,000 then 6,000 of a 10,000 receivable), several providers sharing account
2220, several branches, and a provider with two tills replenished
independently. No reconciliation test asserts a zero against a zero — the
exact-match case is a 1,000,000 count against a 1,000,000 book.


## 9. CI run and final SHA

**Run 42452436610 at `c02068b` — all four mandatory jobs `success`.**

| Job | Conclusion |
| --- | --- |
| checks, unit/integration, build | **success** |
| database (real PostgreSQL) | **success** |
| browser E2E (production build, fresh seed) | **success** |
| security release rehearsal (PostgreSQL 17, real Auth) | **success** |

Every step inside `checks` passed, not merely the job: typecheck, lint,
format, unit and integration tests, the money arithmetic audit, the secret
scan over source and full history, the dependency audit, the production
build, no-secret-in-client-bundle, and the browser bundle assertions.

Inside `database`: the security gate, all nine test projects, the upgrade and
existing-borrower integration, and the financial reconciliation certification.

Inside the PostgreSQL 17 job: the scoped migration, hook reload and
interruption rehearsal, then real recovery and two-tab renewal past JWT
expiry against a real Auth stack.

`Supabase Preview` is **skipped**, so nothing in this work created a branch
against the hosted project. The check run is the evidence rather than my word
for it.

**Final SHA: `c02068b`** for the code. This report's own commit is
documentation only and the code at both is identical.

### The failures before it, all mine

Recorded because a report that shows only the green run is not a record of
what happened.

- **The full `test:db` failed with 112 failures across 73 files** before the
  three real defects below were found. That run was polluted by my own
  repeated interactive suite runs against the shared cluster, not a
  regression: `money-movement.test.ts` passes 32/32 on a clean rebuild. The
  three genuine failures underneath it were only visible after re-running
  undisturbed, which is why the first explanation was not accepted.
- **`agency-settlement.test.ts` was missing from the `db` project's exclude
  list**, so it ran in two projects and committed test branches into the one
  that reads `branch_cash_position` with `queryOne`. The 4B-S comment above
  that very list records the same mistake and calls it "the definition of the
  problem rather than bad luck."
- **`rls-payments.test.ts` holds a second view inventory** which names every
  `security_invoker` view rather than counting them, deliberately. The seven
  new views had to be named there too.


## 10. Remaining defects, risks and business decisions

### Found and fixed in this phase, in my own work

- **The money audit was reading an allowlist of dates** — 20261004, 20261005,
  20261021, 20261107, 20261108 — and so had never opened the 4B-S migrations
  (`20261109*`) or any Phase 4C migration. It reported "86 financial files
  scanned, no hazard found" over code it had not read. It now reads every
  migration (240 files) and was verified by injecting a `::numeric / 10000.0`
  into a Phase 4C function: exit 1, both hazards named, exit 0 after restore.
  This is the second time the enumerated-prefix design failed and I extended
  it the first time; it is now a rule that cannot go stale.
- **Seven new views granted `anon` all seven privileges.** The database grants
  defaults on every new relation, so `grant select` alone is not enough — the
  convention is `revoke all … from anon, authenticated` first. Caught by
  `security.test.ts`, not by me.
- **The replenishment RLS policy was not scoped to a role**, so it applied to
  PUBLIC rather than `authenticated`. Caught by the policy-scope test.

### Open business decisions

- **N (from 4B-S) remains open.** Payables and receivables are scoped per
  branch as well as per provider, so one branch cannot settle against
  another's balance. Phase 4C follows that narrow reading consistently rather
  than settling it.
- **L remains open.** `requires_approval_above` is stored per transaction type
  and still nothing reads it, so a 50,000 and a 50,000,000 transaction need
  the same authority. Phase 4C did not change this.
- C, F, G, H and I remain open from Phase 4A.

### Risks recorded, not fixed

- **The attribution rule now exists twice** — in the two outstanding functions
  and again inline in the two summary views, because those functions are
  revoked from `authenticated` and a `security_invoker` view calling them
  would be denied. Two copies of a rule drift. A test asserts the two agree on
  both the commission and the payable side, which detects drift but does not
  prevent it. Collapsing them would need the view to call a function the
  caller may not execute, which is the thing being avoided.
- **The two variance conventions are opposite and both are generated.** This
  phase handles it by never sharing a branch of logic and by stating the
  meaning in `agency_variance_report.variance_means`. A future contributor
  adding a third reconciliation kind should read deviation D2 first.

### Restrictions preserved

Nine seeded providers remain `is_provisional = true, is_active = false` with
NULL rates. No commission rate, limit, threshold or live provider setting is
invented anywhere. The bank agency no-advance rule holds, and is now
re-asserted on the settlement path too. Policy 2.0 is not activated. No demo
data deleted. All existing lending accounting and security controls unchanged.
