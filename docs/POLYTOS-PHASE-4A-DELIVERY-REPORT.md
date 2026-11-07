# POLYTOS Phase 4A — Agency Banking foundation and schema

**Scope:** the financial foundation only. No posting function, no UI.
**Branch:** `phase4a/agency-foundation-2026-11-07`, stacked on PR #21
(`phase3/financial-certification-2026-11-06` at `9b0d1ef`).
**Status:** conditionally accepted at first review; this revision answers the
nine conditions. Draft PR only — not a merge and not a release.
**Spec:** `docs/AGENCY-BANKING-ARCHITECTURE.md` v3.0 (recovered from `da8824b`)
**Reconciliation:** `docs/POLYTOS-PHASE-4-ARCHITECTURE-RECONCILIATION.md`
**Verdict:** **PASS** for Phase 4A. Not authorised for merge or deploy.

---

## 1. Migrations

Nine, numbered `20261107000100`–`20261107000900`, all after PR #20's
`20261106000800`, so merge order with #19 and #20 does not matter.

| Migration | What it does |
| --- | --- |
| `…000100_agency_extend_financial_constraints` | Adds `agency_float` to `cash_kind`; **hardens `assert_cash_account()` to refuse it**; widens `ledger_accounts_code_shape`; adds the five agency `source_type` values; adds `allow_negative_agency_float` and `low_balance_agency_float`; adds `assert_agency_float_available()` |
| `…000200_agency_chart_of_accounts` | 17 accounts: 1300/1310/1320, 2200/2210/2220/2290, 4500 + eight commission accounts, 5960. Parent wiring as separate statements |
| `…000300_agency_provider_registry` | `agency_service_providers`, `agency_transaction_types`, `agency_provider_float_accounts`; three integrity guards; `ensure_agency_float_account()`; RLS |
| `…000400_agency_transactions` | `agency_transactions` with 13 CHECK constraints, the provider-reference unique index, idempotency, the cross-table guard, RLS |
| `…000500_agency_settlement_and_reconciliation` | The two settlement tables and the two reconciliation tables, with generated `variance` columns and write-off-needs-approval constraints |
| `…000600_agency_transaction_audit_log` | Append-only trail: UPDATE, DELETE and TRUNCATE all refused |
| `…000700_agency_permissions` | Nine capability keys and their role grants |
| `…000800_agency_provider_catalogue_provisional` | Nine providers and 13 transaction types, every row `is_provisional = true` |
| `…000900_branch_cash_position_agency_float` | Repairs the `total_liquidity` defect the first migration introduced |
| `…001000_agency_live_posting_readiness` | Refuses any transaction past draft unless the provider is confirmed **and** active, the type is active and states a maximum, and the provider states a commission basis |
| `…001100_notify_low_agency_float` | `notify_low_float()` reads `low_balance_agency_float`, which nothing read before |

### Migration count

| | Count |
| --- | --- |
| Hosted production | 161 |
| PR #19 | +2 |
| PR #20 | +8 |
| PR #21 (Phase 3) | +0 — tests and docs only |
| **Baseline before Phase 4** | **171** |
| **Phase 4A** | **+11** |
| **Full release total** | **182** |

**Recomputed, and it moved.** The first review was told 9 Phase 4A migrations
and a 180-migration release. Answering conditions 5 and 6 added two more
(`…001000` and `…001100`), so Phase 4A is **11** migrations. The draft PR's own
branch carries **180** — PR #21's 169 plus 11 — because PR #19's two are
deliberately not on it; the complete release, once #19 lands, is **182**.
Counted from the directory on each branch, never carried forward.

Both were replayed on a clean PostgreSQL 16 cluster: the stacked branch at 180,
and a throwaway rehearsal branch at 182 with PR #19 merged in. All apply in
timestamp order, no duplicate version prefixes, and on the 182 rehearsal both
PRs' effects are present together — #19's probe-drop fired, its `ledger:view`
guard landed, and Phase 4A's readiness guard and `agency_float` cash kind are
both in place. The security gate and the full database suite pass on the
rehearsal as well as on the branch.

### Ordering constraints

`…000100` **must** precede `…000200`: the chart migration creates nothing with
a `cash_kind`, but `…000900` depends on `agency_float` being a legal kind, and
`ensure_agency_float_account()` in `…000300` cannot create a float account
until the constraint admits one. `…000800` must come last of the data
migrations: it references the accounts `…000200` creates and the tables
`…000300` creates.

---

## 2. Implemented functionality by service provider

Phase 4A seeds the catalogue and the accounts. **No transaction can be posted
yet** — that is 4B. "Ready" below means the provider, its operations, its
income account and its settlement route all exist and are constrained.

| Provider | Category | Float model | Commission | Income | Payable | Operations | Ready |
| --- | --- | --- | --- | --- | --- | --- | --- |
| MTN Mobile Money | mobile_money | provider_float | deferred | 4510 | — | deposit, withdrawal | yes |
| Airtel Money | mobile_money | provider_float | deferred | 4510 | — | deposit, withdrawal | yes |
| Stanbic Bank Agency | agency_banking | cash_payable | deferred | 4520 | 2220 | deposit, withdrawal | yes |
| UEDCL Yaka Electricity | utility | provider_float | deferred | 4530 | — | Yaka token (meter no.) | yes |
| NWSC Water | utility | provider_float | deferred | 4530 | — | water bill | yes |
| DStv | tv_subscription | provider_float | deferred | 4550 | — | subscription | yes |
| GOtv | tv_subscription | provider_float | deferred | 4550 | — | subscription | yes |
| Lycamobile | airtime_data | provider_float | **immediate** | 4560 | — | airtime, data | yes |
| School Fees Collection | school_fees | cash_payable | deferred | 4540 | 2210 | fees payment | yes |

Every row carries `is_provisional = true` **and `is_active = false`**
(condition 5). "Ready" in the table above therefore means *constrained and
complete*, not *live*: nothing can be posted against any of these nine until
somebody confirms its commission terms and switches it on, which §4A below
enforces at the data layer. Additional providers are rows, not migrations — the
`other` category and 4590 exist for them.

`commission_rate_bps` and `commission_fixed` are **NULL throughout**. Rates are
commercially negotiated and nobody supplied them; a plausible guess would be
indistinguishable from a real figure once stored.

---

## 3. Database changes

9 tables, 17 accounts, 9 permissions, 42 foreign keys (all RESTRICT), 2
settings columns, 5 `source_type` values, 1 new `cash_kind`, 1 view column.

Three existing objects were modified, each for a stated reason:

| Object | Change | Why |
| --- | --- | --- |
| `assert_cash_account()` | refuses `agency_float` | §4 below. Backward compatible: no account carried the kind beforehand |
| `ledger_accounts_code_shape` | allows `_`, up to 64 chars | The spec's `1320.{PROVIDER}.{BRANCH}.T2` format does not fit `^[0-9A-Z][0-9A-Z.-]{1,23}$`. A pure widening — every previously valid code is still valid |
| `branch_cash_position` | `agency_float` component added | §5 below |

---

## 4. The security finding, and what was done

Adding `agency_float` to `cash_kind` would have made every float account a
legal `record_transfer()` endpoint, because `assert_cash_account()` tests only
`cash_kind is null`. Consequences, all verified against the live function
bodies:

1. **Permission bypass** — `record_transfer()` gates on `transfers:create`,
   which `secretary_treasurer` holds. Float movable with no `agency:*`
   capability.
2. **Audit bypass** — posted as `source_type = 'transfer'`, so invisible to
   `agency_transactions`, the agency audit log and every agency report.
3. **The bypass C4 exists to prevent** — `record_transfer()` calls
   `assert_cash_available()`, which reads `allow_negative_cash`.
4. **Till ambiguity** — `branch_cash_account(branch,'agency_float')` resolves
   `order by code limit 1`.

The kind is added and the assertion hardened in the same migration. Proved
both ways in `tests/db/agency-foundation.test.ts`: `record_transfer` refuses a
float account for an owner, and an ordinary cash transfer between two cash
accounts still reaches the balance check and succeeds when funded.

This also settles what the spec deferred at §6.10: `record_transfer()` is not
extended, and Phase 4C gets `post_float_replenishment()`.

---

## 5. A defect Phase 4A introduced and repaired

`branch_cash_position` reported four named components and a `total_liquidity`
that was **not** filtered by kind. While there were four kinds the parts summed
to the total by construction; the fifth broke it, so any branch holding float
would show a total exceeding its own parts.

Caught by three independent places, all of which failed:
`money-movement.test.ts`, `ledger-posting.test.ts`, and the reconciliation
harness identity "total liquidity is the sum of its parts".

Repaired by giving float its own component rather than filtering it out of the
total — filtering would have broken the *other* identity, "total liquidity
agrees with every cash GL account", and a cash position that disagrees with the
general ledger is the failure the harness exists to catch. Both identities now
hold at 3,865,040.

---

## 5A. Nothing posts against an unconfirmed provider (condition 5)

The catalogue ships with the specification's default commission models and no
limits at all, because neither has been confirmed (open decisions C and H). The
risk was precise: once 4B adds the posting functions, a provisional provider
would be indistinguishable from a confirmed one, and a transaction type whose
`max_single_transaction` is NULL would accept **any** amount — so an unreviewed
rate and an unbounded limit would quietly become live financial behaviour.

Two things close it.

**The nine providers are seeded inactive as well as provisional.** Loading the
catalogue is no longer the same act as going live with it. Provisional records
that the terms are unconfirmed; inactive is what actually keeps the provider out
of the posting path.

**`20261107001000` refuses any transaction past draft** unless five conditions
hold, each closing one way a figure could go live unreviewed:

| # | Condition | What it prevents |
| --- | --- | --- |
| 1 | `is_provisional = false` | Posting on a default nobody confirmed |
| 2 | `is_active = true` | Posting against a provider not switched on |
| 3 | the type is active | Posting a retired operation |
| 4 | the type states a maximum | A silent "unlimited" |
| 5 | the provider states a commission basis | Income recognised from nothing |

A CHECK also refuses clearing the provisional flag with no commission recorded,
because a NULL rate means nobody decided rather than zero — and zero is a fine
answer, it just has to be stated as `commission_fixed = 0`.

**Why a trigger rather than a rule inside the posting functions.** They do not
exist yet. A readiness rule written in 4B would be one that did not exist while
the catalogue did, and one a second posting path added later could forget. Here
it constrains every writer of the table, the table owner included.

Drafts and cancelled rows are exempt, so a counter can still type while a
provider is being set up. The gate sits on the transition out of draft, which is
exactly where money starts to move.

Eight tests cover it, including the positive side — a provider that passes all
five is not blocked, so the gate refuses readiness failures and nothing else.

---

## 5B. Agency float is not available lending cash (condition 6)

Every consumer of `branch_cash_position.total_liquidity` was audited. There are
two, and both were wrong.

**`getCashPositions()` selected the four components and the total, but not
`agency_float`.** The finance screen would have shown a total larger than its
own visible parts, with the difference unexplained — which is exactly float
being read as spendable till cash. It is now selected, carried on
`BranchCashPosition.agencyFloat`, and rendered as its own card, labelled as
float, shown only when there is any, with the same line added to the per-branch
breakdown so the branch cards add up too.

It is deliberately **not** a `CashKind`. Those four kinds drive the account
pickers, which is the second finding:

**`getLedgerAccounts({ cashOnly: true })` filtered `cash_kind is not null`.**
After the fifth kind, all four screens that ask for it — a transfer, an expense
payment, an income receipt and a cash reconciliation — would have offered float
accounts. The database refuses every one of them, so the only possible outcome
was a confusing refusal in front of a user. `cashOnly` now names the four
lending kinds explicitly, so a sixth kind cannot silently widen those pickers
either.

**A third finding, from the same audit.** `20261107000100` added
`finance_settings.low_balance_agency_float` and **nothing read it**:
`notify_low_float()` picks its threshold with a CASE over the four original
kinds, so `agency_float` fell through to the `continue` and every float account
was silently skipped. Wrong in both directions — the column was inert, and an
agent whose MTN float was nearly spent got no warning, on the one balance that
cannot be topped up from the drawer. Repaired in `20261107001100`. No test
caught it because before this phase there was no fifth kind to fall through.

---

## 5C. Generic money-movement paths rechecked (condition 7)

Every `public` function that takes an account id or touches `cash_kind` was
enumerated from the catalogue and classified.

| Path | Reaches float? | Why |
| --- | --- | --- |
| `record_transfer` | **No** | `assert_cash_account` on both legs |
| `record_expense` | **No** | `assert_cash_account` on the payment account |
| `record_other_income` | **No** | `assert_cash_account` on the receiving account |
| `submit_reconciliation` | **No** | `assert_cash_account` on the counted account |
| 9 posting functions (disbursement, repayment, reversal, savings in/out, benefit, meeting fine, membership fee, backfill) | **No** | each resolves via `branch_cash_account(branch, '<literal kind>')` — never `agency_float` |
| `payment_method_cash_kind()` | **No** | closed mapping over the four payment methods |
| `notify_low_float()` | Yes, by design | now reads the float threshold (§5B) |

All four generic entry points funnel through `assert_cash_account`, so
hardening that one function closed all four. Asserted rather than assumed: two
tests drive `record_expense`, `record_other_income` and `submit_reconciliation`
at a float account and require the agency refusal from each.

That last one also keeps **correction C9** intact at the data layer — float
cannot be reconciled through the generic cash reconciliation, which counts
physical notes against a till — and the test proves the cash account at the same
branch is still reconcilable, so the separation is not achieved by breaking
reconciliation.

---

## 6. Financial journal matrix

**No journal is posted by Phase 4A.** The matrix is specified in §6 of the
architecture and is implemented in 4B/4C. What Phase 4A guarantees structurally:

| Guarantee | Mechanism |
| --- | --- |
| A posted transaction has a journal | `agency_transactions_posted_has_journal` — `(status in ('posted','reversed')) = (journal_entry_id is not null)` |
| A posted transaction has a verifier | `agency_transactions_posted_has_verifier` |
| A reversal keeps its whole trail | `agency_transactions_reversed_is_complete` — reversed_at, reversed_by, reversal_reason **and** reversal_entry_id |
| An unreversed row carries no reversal data | `agency_transactions_unreversed_is_clean` |
| Customer money, float, commission and fees stay separate | three distinct `bigint` columns, never summed into one |
| Agency income is never lending income | `agency_provider_accounts_guard()` refuses any income account outside `45%` |
| A liability is never settled as cash | `record_transfer()` refuses non-cash accounts (C2); 2210/2220/2290 have no `cash_kind` |
| A variance cannot be written off unapproved | `agency_*_recon_writeoff_needs_approval` — requires `status = 'reconciled'` **and** a journal entry |
| The ledger cannot be rewritten | `journal_entries`/`journal_lines` are append-only; verified by attempting a DELETE |

---

## 7. Security and permission matrix

| Capability | secretary_treasurer | manager | owner_admin | client |
| --- | --- | --- | --- | --- |
| `agency:write` | ✓ | ✓ | ✓ | — |
| `agency:verify` | **—** | ✓ | ✓ | — |
| `agency:reverse` | — | ✓ | ✓ | — |
| `agency:reverse_cross_day` | — | — | ✓ | — |
| `agency:correct` | — | ✓ | ✓ | — |
| `agency:settlements` | — | ✓ | ✓ | — |
| `agency:reconcile` | — | ✓ | ✓ | — |
| `agency:providers` | — | — | ✓ | — |
| `agency:reports` | ✓ | ✓ | ✓ | — |

Two deliberate departures from §9, both tightenings and both recorded:

- **`agency:verify` excludes `secretary_treasurer`** (decision E, Product Owner
  approved). Matches the boundary Phase 3 certified for `transfers:approve` and
  `expenses:approve`. The `verifier_not_submitter` CHECK remains as the second
  line: even between two managers, nobody verifies their own entry.
- **`agency:reports` excludes `client`.** §9 says "All roles"; `client` is the
  borrower role and every agency RLS predicate is built on this key, so
  granting it would expose every transaction and till balance in the branch.
  `client` holds exactly three self-service permissions and no finance
  permission has ever been granted to it.

The matrix is asserted in three places that must agree: the migration,
`lib/permissions/permissions.ts`, and `tests/unit/permissions.test.ts` — with
`tests/db/permissions.test.ts` comparing the database against the application.

### Access control

All nine tables: RLS enabled, `SELECT` only for `authenticated`, no INSERT or
UPDATE grant anywhere. Writes come only from `SECURITY DEFINER` functions. Every
policy is gated on `agency:reports` and branch-isolated, in the hoisted form
(`(select …)`) that `tests/db/rls-hoisting.test.ts` enforces — the first draft
used the bare per-row form and that test caught it.

---

## 8. Verification

Everything below was run on this branch at 180 migrations.

| Gate | Result |
| --- | --- |
| All 180 migrations on the branch, clean cluster, timestamp order | **PASS** |
| All 182 migrations with PR #19, independent rehearsal | **PASS** |
| `tests/db/agency-foundation.test.ts` | **PASS — 66/66** |
| `npm run test:db` (five projects) | **PASS — 2,044** (1,962 + 18 + 15 + 24 + 25) |
| `npm run test:run` (unit + integration) | **PASS — 2,656 passed** |
| `npm run check:security` | **PASS — no unreviewed privileged exposure** |
| Financial reconciliation certification | **PASS — 36 pass, 2 explained, 0 vacuous, 0 fail** |
| `npm run typecheck` | **PASS** |
| `npm run lint` | **PASS** |
| `npm run format:check` | **PASS** |
| `npm run audit:money` | **PASS — 71 files, no hazard** |
| `npm run build` | **PASS** |

### Not run here

`browser E2E` and `security release rehearsal` need a PostgREST binary and a
real Auth binary downloaded in CI, and PostgreSQL 17 for the rehearsal. They
run on the pull request. Phase 4A adds no route and no screen, so neither
exercises any new code path; the `database` job is the one that covers this
change and it is green locally in full.

### Regressions found and fixed during verification

**Eight in all.** Five in the first pass, each caught by an existing test
rather than by inspection:

1. `total_liquidity` no longer summed its parts (§5).
2. Nine RLS policies used the bare per-row helper form.
3. `commission_rate numeric(7,4)` — the schema admits **no** `numeric` column
   anywhere. Changed to `commission_rate_bps integer`, matching
   `interest_rate_bps`. A 14th correction to the spec.
4. 42 foreign keys defaulted to NO ACTION instead of explicit RESTRICT.
5. Three trigger guards were `SECURITY DEFINER` and reachable by
   `authenticated`; the grant is withheld, since a trigger fires as the table
   owner.

One finding of the chart migration's own: a multi-row `INSERT` cannot reference
a heading created by the same statement, so the first draft left eleven
accounts unparented.

Three more in this revision, all found by auditing consumers rather than by a
failing test — because no test existed for a fifth cash kind that had never
existed:

6. `getCashPositions()` omitted `agency_float`, so the cash position screen
   would have shown a total larger than its visible parts (§5B).
7. `getLedgerAccounts({ cashOnly: true })` would have offered float accounts in
   four account pickers the database refuses (§5B).
8. `low_balance_agency_float` was added and never read, so float accounts got no
   low-balance warning at all (§5B).

The pattern is worth naming: widening a constraint is not a local change.
Three of these eight were consumers of `cash_kind` or of a total derived from
it, and the first pass found them only where a test already happened to assert
the invariant.

---

## 9. Remaining business decisions

| # | Decision | Status |
| --- | --- | --- |
| A | Specification approved | Open — this phase is built on it under §2's corrections |
| B | Account code allocation acceptable | Open; structural only, nothing depends on the answer |
| C | Commission model per provider | **Open.** Seeded provisionally at the spec's §4.1 defaults, `is_provisional = true`. A data change, not a migration |
| D | PR #18 released | **Closed** — merged, contrary to the spec's header |
| E | Who may verify | **Closed** — manager and owner_admin only |
| F | Commission rates per provider | **Open.** NULL throughout; no rate invented |
| G | Which providers are live at which branch | **Open.** No float till is provisioned; `ensure_agency_float_account()` creates them when known |
| H | Per-type limits and approval ceilings | **Open.** `max_single_transaction` and `requires_approval_above` NULL, meaning no limit |
| I | F1 error-code reclassification | Open — `docs/POLYTOS-F1-AUTHORIZATION-ERROR-CLASSIFICATION.md` §4 |

---

## 10. Estimated remaining work

| Phase | Content | Estimate |
| --- | --- | --- |
| 4B | Transaction engine: six lifecycle functions, the journal matrix for nine providers, separation of duties, insufficient-float and duplicate-reference refusals, the full negative test suite | 3–4 days |
| 4C | Settlement and reconciliation: five posting functions, `post_float_replenishment()`, variance approval, end-of-day reporting, three views | 3–4 days |
| 4D | Mobile-first UI: eleven screens, forms, receipts, reports | 4–6 days |
| Certification | The Task 6 matrix end to end, plus browser coverage of the new screens | 1–2 days |

Phase 4A is ready for review. 4B should not start until the §9 decisions that
affect journals — C and F — are settled, because the commission model decides
the journal posted for every transaction of a provider.

---

## 11. Verdict

**PASS for Phase 4A.** Schema, constraints, permissions, RLS, idempotency,
append-only audit and chart-of-accounts integration are implemented, applied to
a clean cluster at 180 migrations, and verified by every gate available in this
environment. One security gap in the specification was found and closed; one
defect this phase introduced was found by the existing suite and repaired.

**BLOCKED for merge and deploy.** A draft PR is authorised; a merge and a
release are not. The specification still carries its AWAITING APPROVAL header,
and decisions B, C, F, G and H remain open.

**No provider is active.** All nine are seeded `is_active = false` and
provisional, and the data layer refuses to post against any of them. Activating
one is a deliberate, separately authorised data change — not a migration, and
not something this branch does.

Nothing here activates Policy 2.0, deletes demo data, touches production or
bypasses a security gate.

### Residual risks

| Risk | Standing |
| --- | --- |
| Commission rates and per-type limits are unset | Mitigated, not resolved. Nothing can post until both are stated (§5A), so the exposure is a blocked counter rather than a wrong journal |
| `total_liquidity` now includes float | Deliberate and visible: float is shown as its own component on the screen and in the harness identity. A consumer added later that reads the total without the component would reintroduce finding 6 |
| The 4500-series income guard is a trigger, not a foreign-key domain | A provider pointed at 4100 is refused, but the rule lives in `agency_provider_accounts_guard()`; a future migration that replaced that trigger would need to keep it |
| Browser E2E and the release rehearsal not run locally | They run on the PR. Phase 4A adds no route; the finance screen change in §5B is the one place a browser test could regress, and it is covered by the existing finance screens' assertions |
| PR #19 and PR #20 are still open | The 182-migration release was rehearsed, but the ordering that production finally takes depends on the order #19 and #20 land. Their migrations are disjoint and differently dated, so any order gives the same result |
