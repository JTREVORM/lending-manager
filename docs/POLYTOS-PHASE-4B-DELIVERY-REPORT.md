# POLYTOS Phase 4B — Agency transaction engine

**Scope:** the transaction engine and financial posting only. No settlement, no
reconciliation, no UI.
**Branch:** `phase4b/agency-transaction-engine-2026-11-07`, stacked on PR #22
(`phase4a/agency-foundation-2026-11-07` at `643bb38`).
**Verdict:** **PASS** for Phase 4B. Draft PR only — not a merge, not a release,
and no provider is active.

---

## 1. Implemented transaction functions

| Function | Capability | What it does |
| --- | --- | --- |
| `create_agency_transaction()` | `agency:write` | Records a draft. The branch is the officer's own and never an argument. Idempotent on the caller's key |
| `update_agency_transaction()` | `agency:write` | Edits a draft, and only a draft |
| `submit_agency_transaction()` | `agency:write` | draft → awaiting_verification. Where the provider reference becomes a claim |
| `return_agency_transaction()` | `agency:verify` | awaiting_verification → draft, with a reason. **Not in the specification** — see §9 |
| `verify_agency_transaction()` | `agency:verify` | Verifies and posts, in one transaction. Refuses the submitter |
| `cancel_agency_transaction()` | `agency:write` | Cancels an unposted transaction; needs `agency:verify` for somebody else's |
| `reverse_agency_transaction()` | `agency:reverse` (+ `agency:reverse_cross_day`) | Mirrors the journal, deletes nothing |
| `update_agency_transaction_reference()` | `agency:correct` | Metadata only, no journal (correction C6) |
| `post_agency_transaction()` | — internal | The posting routine. Not reachable by a signed-in user |
| `agency_commission_for()` / `_reconcile()` | — internal | The commission engine |
| `agency_commission_outstanding()` | — internal | Receivable still owed, for the settled-commission check |
| `agency_actor()` | — internal | Identity and capability, refusing an unattributable session |
| `agency_line()` | — internal | One journal line, so argument order is stated once |

Every transition takes `for update` on the row before reading its status, and
the status change, the journal, the snapshot and the audit row are one
transaction. There is no reachable state in which a transaction is posted and
its journal is not.

`create`, `submit`, `verify`, `cancel` and `reverse` are all idempotent: a
retry returns the first outcome rather than producing a second.

---

## 2. Journal entries by service type

Three amounts, kept apart on purpose: **P** the principal the customer
transacts, **C** the commission the provider pays us, **F** the fee we charge
the customer. Under the **immediate** model the commission is realised inside
the counter leg; under **deferred** it is accrued to 1310.

Every row below is asserted on its exact lines in
`tests/db/agency-transaction-engine.test.ts`, not on a total.

| # | Service | Journal (deferred unless stated) |
| --- | --- | --- |
| 1 | MTN MoMo deposit | Dr Cash P+F · Cr Float P · Cr 4570 F · Dr 1310 C · Cr 4510 C |
| 2 | MTN MoMo withdrawal | Dr Float P · Cr Cash P−F · Cr 4570 F · Dr 1310 C · Cr 4510 C |
| 3 | Airtel deposit / withdrawal | as 1 and 2, commission a fixed amount, 4510 |
| 4 | Stanbic bank agency **deposit** | Dr Cash P+F · **Cr 2220 P** · Cr 4570 F · Dr 1310 C · Cr 4520 C |
| 5 | Stanbic bank agency **withdrawal** | **Dr 2220 P** · Cr Cash P−F · Cr 4570 F · Dr 1310 C · Cr 4520 C |
| 6 | UEDCL Yaka | Dr Cash P+F · Cr Float P · Cr 4570 F · Dr 1310 C · Cr 4530 C |
| 7 | NWSC water | as 6, 4530 |
| 8 | DStv / GOtv | as 6, 4550 |
| 9 | Lycamobile airtime & data (**immediate**) | Dr Cash P · **Cr Float P−C** · Cr 4560 C |
| 10 | School fees (zero commission) | Dr Cash P · Cr 2210 P |
| 11 | Reversal of any of the above | the original entry's lines, debit and credit swapped |

Worked examples from the suite: MoMo 100,000 at 150bp → Dr Cash 100,000, Cr
Float 100,000, Dr 1310 1,500, Cr 4510 1,500. Airtime 10,000 at 300bp → Dr Cash
10,000, Cr Float 9,700, Cr 4560 300. Bank withdrawal 300,000 at 200bp → Dr 2220
300,000, Cr Cash 300,000, Dr 1310 6,000, Cr 4520 6,000, and GL 2220 falls by
exactly 300,000.

### The direction the specification had wrong

§8.2's `cash_payable` branch posts "Dr Cash at Hand, CR Payable account"
**whatever the direction**. Case 5 is the counter-example: in a bank agency
withdrawal the customer receives cash and the liability must fall. Posted the
specification's way, a deposit-and-withdrawal pair would credit 2220 twice and
show the business owing a partner bank money it had just handed back.

Debiting the payable can take 2220 into a net debit balance — the bank owing us
for cash advanced on its behalf, which is what agency banking is and why the
account is named "Net settlement due to partner bank". It is **not** blocked:
the controls that bind are the type's `max_single_transaction` and the till's
own cash. Recorded as open decision **K** in §10.

### `post_journal()` does not check that debits equal credits

It has no balance check and no constraint behind it; `journal_lines_one_side`
only asserts each line is one-sided. "Every journal entry balances" is a *test*
in this repository, not an invariant of the writer. Both the posting and the
reversal therefore compute the two totals themselves and refuse to call it
unless they agree.

### One entry, not two

§6.3 describes the commission accrual as a separate entry. Both pairs go in one
entry here: the same accounts and arithmetic, but the transaction can point at
its whole posting rather than half of it, the reversal is one mirrored entry
rather than two that could half-fail, and the posting balances as a unit.
Recorded as a deliberate deviation.

---

## 3. Commission-calculation decisions

| Decision | Resolution |
| --- | --- |
| Rounding | **Half-up, integer only**: `(P × bps + 5000) / 10000`. 10,000 at 150bp = 150; 10,034 at 150bp = 151; 33 at 150bp = 0, 34 = 1 |
| No floats anywhere | `P` is `bigint`, `bps` is `integer`, so the product is `bigint` and the division is integer division. No `numeric` column exists anywhere in the schema, and the money audit now reads these migrations — see §8 and defect 9 |
| Rate **and** fixed both set | **Refused**, not resolved. The greater, the sum, and rate-with-a-floor are all defensible, and the engine must not pick one for the business |
| Neither set | Refused, and Phase 4A's readiness gate already refuses the provider |
| Explicit zero | Reported as basis `zero`, distinct from `fixed`, so "we agreed nothing" reads differently from "we have not decided" |
| Supplied ≠ computed | **Posted and flagged.** Both figures are kept: `commission_amount` is what was taken, `commission_computed` what the configuration said. Refusing outright would make a counter unusable when a provider's handset says something else; accepting silently would make the configured rate decorative |
| Supplied > principal | Refused — a commission larger than the transaction it is earned on is a keying error |
| Rate changed after posting | The snapshot is immutable, so income already recognised keeps its explanation. Asserted by re-rating a provider and re-reading the posted transaction |
| Customer fee | Always our income, immediately, to 4570. Collected on top of a deposit and netted out of a withdrawal |

**Synthetic rates throughout.** None of the nine seeded providers is used for
posting — they ship provisional and inactive, which is the point of them. The
suite creates its own providers with invented, round rates (150bp, 500 fixed,
an explicit zero) so no figure here could be mistaken for a negotiated term.

### Why the snapshot columns exist

A provider's rate is live configuration. If the only record of it is the
provider row, re-rating silently rewrites the explanation of every historical
posting: the journal says 1,500 and the configuration now says 2,000, with
nothing to say which was right. The model, basis, rate, fixed amount and income
account are copied onto the transaction at posting and tied to the posted
states by a CHECK — the same reasoning as `loan_product_snapshots`.

---

## 4. Permission and branch-isolation tests

| Assertion | Outcome |
| --- | --- |
| Secretary records and submits | permitted |
| Secretary verifies | **refused, 42501**, names `agency:verify` |
| Submitter verifies their own, holding `agency:verify` | **refused, 42501** — proved with a *manager* recording and then verifying, so the capability is present and only the separation of duties refuses |
| Manager and owner verify somebody else's | permitted |
| Borrower: create, submit, verify, cancel, reverse, correct reference | **all six refused, 42501** |
| Suspended account | **refused, 42501**, "unidentified session" |
| Forced-password account | **refused, 42501**, same path |
| Reference correction by secretary / by manager | refused 42501 / permitted |
| Cross-day reversal by manager / by owner | refused 42501 / permitted |

Suspended and forced-password accounts are refused by `current_profile_id()`,
which excludes both — so `agency_actor()` refuses them before any capability is
consulted. That is the Phase 2 boundary inherited, not restated.

### Branch isolation, at two layers

- **Data layer.** A till belonging to branch B is refused for an officer of
  branch A, because the transaction's branch is the officer's own profile and
  never an argument. The refusal comes from the Phase 4A guard, before RLS is
  reached.
- **RLS.** A manager re-pinned to branch B cannot see a branch A transaction at
  all: the count is zero rather than an error, which is how RLS denies.

---

## 5. Duplicate and concurrency protections

| Protection | Mechanism | Asserted |
| --- | --- | --- |
| Duplicate provider reference | Phase 4A partial unique index, excluding only draft and cancelled | A second submission with a claimed reference is refused |
| Reference released on cancel | the same index | The reference becomes reusable after a cancel |
| Reference kept after reversal | the same index | Reversing does not un-send the money at the provider |
| Repeated create | `idempotency_key` unique + an early return | Two identical calls return one id and one row |
| Repeated verify | `journal_entry_id` already set → return it | Two verifications, one journal entry |
| Repeated reverse | `status = 'reversed'` → return the contra | Two reversals, one contra entry |
| **Concurrent verify** | `select … for update` in `post_agency_transaction()` | Two connections verify at once; the second blocks on the lock, wakes after the first commits, finds it posted and returns the same journal. Exactly one entry exists |
| Rollback on failure | one transaction for the whole posting | An unfundable deposit leaves the row `awaiting_verification` with no journal, no verifier and no snapshot, and zero entries for it |

---

## 6. Reversal behaviour

- **Contra mirrored from the original journal**, not recomputed from the
  transaction, so it cannot drift from what was actually posted. Asserted by
  comparing the contra line-for-line against the original with debit and credit
  swapped.
- **Nothing is deleted.** The original entry and all its lines remain; the
  transaction becomes `reversed` rather than disappearing.
- **The whole trail is preserved**: provider reference (still claimed),
  submitter, verifier, reverser, reason, both journal ids, and an audit trail
  containing submit, verify, post and reverse. The original entry's
  `reversed_by_entry_id` names the contra.
- **Sufficiency on the way back**, derived from the journal rather than
  restated: every account the original debited is one the contra will credit, so
  cash is checked against the cash rule and float against the float rule.
- **Cross-day** reversal requires `agency:reverse_cross_day`; a manager is
  refused and an owner permitted.
- **A reason is mandatory**; whitespace is refused.
- **Settled commission is refused, not reversed.** The reversal compares what it
  would withdraw from 1310 against the receivable still outstanding for that
  provider and branch, and names the settlement to reverse first. Tested by
  settling the commission (a labelled fixture standing in for Phase 4C's
  settlement function) and confirming the reversal is refused.
- **After provider deactivation**, the reversal still works and the provider
  stays off. See §9.

---

## 7. Migrations and replay

| Migration | Content |
| --- | --- |
| `20261108000100_agency_commission_engine` | `commission_supplied`, the six snapshot columns and their CHECKs, `agency_commission_for()`, `agency_commission_reconcile()` |
| `20261108000200_agency_posting` | `agency_line()`, `post_agency_transaction()` |
| `20261108000300_agency_lifecycle` | `agency_actor()` and the seven lifecycle functions |
| `20261108000400_agency_reversal` | `agency_commission_outstanding()`, the readiness-gate amendment, `reverse_agency_transaction()` |

| | Count |
| --- | --- |
| Hosted production | 161 |
| PR #19 (not on this branch) | +2 |
| PR #20 | +8 |
| PR #21 | +0 |
| PR #22 (Phase 4A) | +11 |
| PR #22 head, this branch's base | **180** |
| **Phase 4B** | **+4** |
| **This branch** | **184** |
| **Complete release once #19 lands** | **186** |

Counted from the directory, never carried forward. All 184 replay in timestamp
order on a clean PostgreSQL 16 cluster, with no duplicate version prefixes.

---

## 8. Verification

| Gate | Result |
| --- | --- |
| All 184 migrations, clean cluster, timestamp order | **PASS** |
| `tests/db/agency-transaction-engine.test.ts` (new) | **PASS — 57/57** |
| `npm run test:db` (seven projects) | **PASS — 2,101** (1,896 + 66 + 57 + 18 + 15 + 24 + 25) |
| `npm run test:run` (unit + integration) | **PASS — 2,656** |
| Database security gate | **PASS — no unreviewed privileged exposure** |
| Financial reconciliation certification | **PASS — 36 pass, 2 explained, 0 vacuous, 0 fail** |
| `npm run typecheck` / `lint` / `format:check` | **PASS** |
| `npm run audit:money` | **PASS — 86 files, no hazard** (71 before this phase extended its reach — see defect 9) |
| `npm run build` | **PASS** |

### CI — all four mandatory jobs, green

Run **42368072464** at `a32dcf1`, event `pull_request`, on draft PR #23. Every
job `success`:

| Job | Result | Duration |
| --- | --- | --- |
| `checks, unit/integration, build` | **success** | 2m 49s |
| `database (real PostgreSQL)` | **success** | 4m 31s |
| `browser E2E (production build, fresh seed)` | **success** | 13m 59s |
| `security release rehearsal (PostgreSQL 17, real Auth)` | **success** | 3m 19s |

`Supabase Preview` is **skipped**, so nothing in this work created a branch
against the hosted project. The check run is the evidence rather than an
assertion.

### The first attempt failed, and the defect was mine

Run 42367318821 at `e9be504` failed the `database` job on
`security.test.ts > grants authenticated only the session-scoped helpers`: 157
expected against 154 actual. `checks` and the `security release rehearsal`
passed; `browser E2E` was **cancelled** rather than failed, because the
workflow sets `concurrency: cancel-in-progress` on the ref and the corrective
push ended it.

The cause is defect 11 below, and the sequencing is the part worth reading: the
expected list was correct when written and wrong by the time it ran, because the
grants changed after the last full suite run and I did not repeat it.

### Exposure decisions

Eight lifecycle RPCs are reachable by `authenticated` and are classified **A**
in `config/database-security-baseline.json`, each with the capability it refuses
on and the SQLSTATE it raises. Four functions are **withheld** from
`authenticated` rather than baselined — `post_agency_transaction`,
`agency_commission_for`, `agency_commission_reconcile` and
`agency_commission_outstanding` — because the DEFINER lifecycle functions are
their only callers, and the last would otherwise expose a provider-level
receivable aggregate to any signed-in user.

---

## 9. Defects found and corrected

| # | Defect | Resolution |
| --- | --- | --- |
| 1 | **§8.2 posts a bank agency withdrawal backwards** — "Dr Cash, Cr Payable" regardless of direction | Direction-aware: a withdrawal posts Dr Payable, Cr Cash. Asserted on exact lines, and on 2220 falling by the principal |
| 2 | **`post_journal()` enforces no balance** | Both posting and reversal assert debits = credits before calling it |
| 3 | **Phase 4A's readiness gate trapped historical corrections** — deactivating a provider made last week's mistake permanently unreversible, and reactivating it to allow the fix would reopen live posting for everybody | The gate exempts `reversed` alongside `draft` and `cancelled`. A test deactivates a provider, reverses behind it, and asserts the provider is still off and still refuses new postings |
| 4 | **§7 gives a verifier no way to reject** — a mistyped meter number could only be posted and reversed, putting two entries in the books for a typo that moved no money | `return_agency_transaction()`, which moves nothing and releases the reference |
| 5 | **Test suite: a stale fixture edit silently did nothing.** A `postOne` helper was still rolling back every step, so the first run of the journal matrix failed with "No such agency transaction" | The edit had not matched after reformatting, and the script asserted nothing. Fixed, and the lesson is recorded: a scripted edit that does not assert its own replacement count is not an edit |
| 6 | **Test suite: the concurrency case deadlocked itself**, holding the row lock while awaiting the blocked second call, which timed out ten tests | The first transaction commits before the second is awaited, which is also the only way the race can resolve |
| 7 | **Test suite: the insufficient-cash case tripped the type ceiling instead**, so it proved the wrong control | A dedicated service with a raised ceiling, so only cash can bind |
| 8 | **Test suite: `deleteTestUsers()` cannot run here** — it deletes journal entries, and `agency_transactions.journal_entry_id` is ON DELETE RESTRICT | Cleanup removed and the reason recorded: the project rebuilds its database, and the FK refusing is the schema behaving correctly |

| 9 | **The money audit was not reading any agency SQL, and could not have caught a float in it if it had been.** Two separate holes: its migration filter admitted only `20261004*`, `20261005*` and `20261021*`, so every Phase 4A and 4B migration went unread; and its hazard patterns caught `::float`, `::double`, `::real` and a division by 100, but **not `::numeric`** and not a decimal divisor like `/ 10000.0` — which is the obvious way to turn basis points into a fraction | The filter now admits `20261107*` and `20261108*`, and two patterns were added: a `::numeric` cast and a decimal-literal division. Proved by injecting `round((p × bps)::numeric / 10000.0)` into the commission engine: before, the audit reported "no hazard found"; after, it names both hazards and exits 1. The original was restored byte-identically and the audit is clean at 86 files |

| 10 | **The money audit was reporting success over code it had never read.** Its migration filter admitted only `20261004*`, `20261005*` and `20261021*`, so every Phase 4A and 4B migration went unread — including the commission engine, the only place in the system that performs a division. Extending the filter was **not sufficient**: with the agency migrations in scope, an injected `round((p × bps)::numeric / 10000.0)` still passed, because the hazard patterns knew `::float`, `::double`, `::real` and a division by 100, but had no opinion about `::numeric` or a divisor like `/ 10000.0` | Filter extended to `20261107*` and `20261108*`, and two patterns added: a `::numeric` cast and a decimal-literal division. Verified in both directions — with the hazard injected the audit names both findings and exits 1; with the file restored byte-identically it is clean at **86** files, up from 71. Neither pattern appears anywhere in the previously-scanned set |
| 11 | **`security.test.ts` named three functions the database no longer grants.** The eleven new agency functions were added to the authenticated-execute list, and the three commission helpers were then withheld from `authenticated` — without re-running the suite. 157 expected, 154 actual | The three are removed from that list and remain in the SECURITY DEFINER inventory, which is a different question and still true of them. Re-run after the fix on a freshly migrated database: seven projects, 2,101 tests, and the security gate clean |

Defects 5 to 7 were mine and were caught by running the suite rather than by
reading it. Defect 8 is the schema refusing to let a test destroy evidence.

Defects 10 and 11 are both about **a measurement that had stopped describing
the code**. The money audit said "71 financial files scanned, no hazard found",
which was true and said nothing about the newest money arithmetic in the
system. This report said "test:db PASS — 2,101", and that figure was taken
before the grant change, so it described a tree that no longer existed. The
number after the re-run is the same 2,101; what changed is that it is now a
statement about this commit.

Defect 10 also carries a general lesson about gates. Adding files to a
scanner's input is not the same as covering them: the first injection passed. A
gate cannot be trusted on code it has only just started reading until it has
been made to fail on that code on purpose.

Defect 9 deserves a note of its own, because it is the one that was *reporting
success*. "71 financial files scanned, no hazard found" was true and told me
nothing about the newest money arithmetic in the system, which is a division in
SQL. Extending the file list alone was not enough either — the first injection
still passed, because the patterns had no opinion about `numeric`. A gate that
cannot fail on the code it has just started reading is not yet a gate, and the
only way to know was to make it fail on purpose.

---

## 10. Remaining business decisions

| # | Decision | Status |
| --- | --- | --- |
| B | Account code allocation | Open; structural only |
| **C** | **Commission model per provider** | **Open.** Catalogue still provisional and inactive; the engine is proved on synthetic rates |
| **F** | **Commission rates per provider** | **Open.** NULL on every seeded provider; no rate invented |
| G | Which providers are live at which branch | Open. No float till is provisioned for a seeded provider |
| H | Per-type limits and approval ceilings | Open. The readiness gate refuses posting until a maximum is stated, so the exposure is a blocked counter rather than an unbounded transaction |
| I | F1 error-code reclassification | Open; Phase 4B's new functions raise 42501 from the outset |
| **K** | **May a bank agency payable go into net debit?** | **New, open.** A withdrawal debits 2220 and can take it below zero, meaning the bank owes us for cash advanced. Economically correct and the account is named for it, but whether to cap it — and against what — is a business decision. Today only the type's maximum and the till's cash bind |
| **L** | **Should `requires_approval_above` gate verification?** | **New, open.** Phase 4A stores a per-type approval ceiling and nothing reads it yet. Phase 4B gates on capability alone, so a 50,000 and a 50,000,000 transaction need the same authority |
| **M** | **Is a supplied commission acceptable at all?** | **New, open.** The engine posts an operator-supplied figure that differs from the configuration, flagged and with both numbers kept. The alternative is refusing it, which would stop a counter when a provider's handset disagrees |

---

## 11. Verdict

**PASS for Phase 4B.** The engine posts every one of the nine services with the
directions asserted leg by leg, enforces the lifecycle and the separation of
duties at the data layer, computes commission in integer arithmetic with
immutable evidence of the configuration used, protects float and cash
separately, cannot double-post under retry or concurrency, and reverses by
mirroring without deleting anything.

All four mandatory CI jobs pass at the final head, with the one failure that
preceded them recorded above rather than tidied away.

**BLOCKED for merge, deploy and live use.** A draft PR is authorised; nothing
else is. No provider is active, none was activated, and decisions C, F, G, H, K,
L and M remain open. Nothing here activates Policy 2.0, deletes demo data,
touches production or bypasses a security gate.

### Not in this phase

Settlement and reconciliation posting — commission settlement, payable
remittance, float replenishment, cash and float reconciliation, variance
approval and end-of-day reporting — are Phase 4C. The settled-commission
refusal in §6 is the one place Phase 4B reaches toward them, and it reads the
ledger rather than depending on 4C's functions.
