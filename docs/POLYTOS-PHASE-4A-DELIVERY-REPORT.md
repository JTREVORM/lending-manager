# POLYTOS Phase 4A — Agency Banking foundation and schema

**Scope:** the financial foundation only. No posting function, no UI.
**Branch:** `ccr-2cd639d2-7rv2sa`
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

### Migration count

| | Count |
| --- | --- |
| Hosted production | 161 |
| PR #19 | +2 |
| PR #20 | +8 |
| PR #21 (Phase 3) | +0 — tests and docs only |
| **Baseline before Phase 4** | **171** |
| **Phase 4A** | **+9** |
| **Total on this branch** | **180** |

Counted from the directory, not carried forward. All 180 replay in timestamp
order on a clean PostgreSQL 16 cluster.

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

Every row carries `is_provisional = true` (decision C, §8). Additional
providers are rows, not migrations — the `other` category and 4590 exist for
them.

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
| All 180 migrations, clean cluster, timestamp order | **PASS** |
| `tests/db/agency-foundation.test.ts` (new) | **PASS — 55/55** |
| `npm run test:db` (five projects) | **PASS — 2,034** (1,952 + 18 + 15 + 24 + 25) |
| `npm run test:run` (unit + integration) | **PASS — 2,650 passed, 6 skipped** |
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

Five, each caught by an existing test rather than by inspection:

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

**BLOCKED for merge and deploy.** No Product Owner authorisation has been given,
the specification still carries its AWAITING APPROVAL header, and decisions B,
C, F, G and H remain open. Nothing here activates Policy 2.0, deletes demo data,
touches production or bypasses a security gate.
