# Phase 4 — Architecture v3.0 reconciled against the live schema

**Spec under review:** `docs/AGENCY-BANKING-ARCHITECTURE.md`, recovered
byte-identical from commit `da8824b` (md5 `b1f28c85…`), authoritative and
superseding the v1/v2 drafts.
**Reconciled against:** the 171-migration schema — 161 in production, 2 from
PR #19, 8 from PR #20 — replayed on a clean PostgreSQL 16 cluster.
**Method:** every factual claim in §2 and §3 of the spec was re-queried rather
than taken on trust.

No Phase 4 migration has been written. Three findings below must be resolved
first; two of them need a Product Owner decision.

---

## 1. Verified — the spec was right

| Spec claim | Verified |
| --- | --- |
| C1 — 1300-series, 2200–2900, 4500–4890, 5960+ are free | **Confirmed.** Zero occupied codes in those ranges, across all 35 accounts |
| C1 — `2000` is a non-postable heading; `2100` and `4400` are taken | Confirmed exactly |
| C11 — `transfer_reversal` already present | Confirmed in `journal_entries_source_valid`; all 21 listed values present, no more, no fewer |
| §2.3 — `cash_kind` has exactly 4 values | Confirmed: `cash_at_hand`, `mtn_mobile_money`, `airtel_money`, `bank` |
| C13 — multiple float accounts per branch are possible | Confirmed. `ledger_accounts_one_wallet_per_branch` is partial: `WHERE cash_kind = ANY('cash_at_hand','mtn_mobile_money','airtel_money')`. `bank` and a new `agency_float` fall outside it, so several per branch are permitted |
| §2.4 — `finance_settings` columns | Confirmed, all 12, names and order as listed |
| §2.5 — helper signatures | Confirmed for `assert_cash_account`, `assert_cash_available`, `assert_postable_account`, `post_journal` — all four `SECURITY DEFINER`, argument lists exact |
| C2 — `record_transfer()` cannot settle a liability | Confirmed. It calls `assert_cash_account()` on both sides, which refuses any account with `cash_kind IS NULL`. A dedicated settlement function is genuinely required |
| §6 — reversals must be contra entries | Confirmed necessary: `journal_entries` and `journal_lines` are append-only, `reject_mutation()` refusing DELETE. Verified by attempting one |

---

## 2. Corrections required before the first migration

These are defects in the spec's DDL, not decisions. They are mechanical and are
applied as part of Phase 4A.

| # | Issue | Correction |
| --- | --- | --- |
| **D1** | §5.1 drops `ledger_accounts_cash_kind_check`. **No such constraint.** | The real name is `ledger_accounts_cash_kind_valid`. As written the migration aborts |
| **D2** | §5.1 drops `journal_entries_source_type_check`. **No such constraint.** | The real name is `journal_entries_source_valid`. As written the migration aborts |
| **D3** | §2.1 calls the type column `type` | It is `account_type`. There is also a `normal_side text NOT NULL` column the spec never mentions, which every new account must set (`debit` for assets/expenses, `credit` for liabilities/income) |
| **D4** | §5 never mentions `ledger_accounts_cash_is_branch_held` | `CHECK ((cash_kind IS NULL) = (branch_id IS NULL))` — a branch-held account **must** carry a `cash_kind`, and a non-cash account **must** have `branch_id IS NULL`. So: float accounts (per branch) must have `cash_kind = 'agency_float'`, and 1310 / 2210 / 2220 / 2290 / 4500-series / 5960 must all be created with `branch_id NULL`. Giving a payable a branch would fail the check |
| **D5** | §9 implies a `current_branch_id()` helper | The helper is `current_user_branch_id()`. The established RLS idiom is `(select user_has_permission('x')) AND (branch_id is null OR (select current_user_branch_id()) is null OR branch_id = (select current_user_branch_id()))`, where a NULL user branch means head office and sees every branch |
| **D6** | §9 implies a `permissions.permission_key` column | `permissions` keys on `key`; only `role_permissions` uses `permission_key`. Roles are `client`(10), `secretary_treasurer`(30), `manager`(50), `owner_admin`(70) |
| **D7** | §2.1 shows `3000 Owner Capital` as a non-postable heading, and cash accounts unsuffixed | `3000` is postable, and the cash accounts are named "… — Head Office". Cosmetic; no impact on Phase 4 |
| **D8** | Spec header says PR #18 "remains open, unmerged" | PR #18 is **merged** (it is the merge-base of this work). Condition D in §13 is therefore already satisfied |

---

## 3. Finding A — adding `agency_float` to `cash_kind` opens a bypass

**This is the one material architectural gap in v3.0, and it is a security
boundary rather than a cosmetic one.**

Correction C4 adds `allow_negative_agency_float` and a dedicated
`assert_agency_float_available()` so that agency float can never be overdrawn
under the *cash* flag. That protects the **agency posting path**. It does not
protect the **generic transfer path**, and §5.1 opens that path by widening the
`cash_kind` constraint.

`assert_cash_account()` does not enumerate kinds. Its only test is:

```
if r.cash_kind is null then raise exception '% is not a cash account' …
```

So the moment `agency_float` is a legal `cash_kind`, every agency float account
becomes a legal `record_transfer()` endpoint. The consequences, all verified
against the live function bodies:

1. **Permission bypass.** `record_transfer()` gates on `transfers:create`, which
   `secretary_treasurer` holds. Agency float could be moved by someone holding
   no `agency:*` permission at all.
2. **Audit bypass.** The movement posts `source_type = 'transfer'`, so it never
   appears in `agency_transactions`, never reaches
   `agency_transaction_audit_log`, and is invisible to every agency report in
   §10.
3. **The exact bypass C4 forbids.** `record_transfer()` calls
   `assert_cash_available()`, which reads **`allow_negative_cash`** — so float
   drawn down this way is governed by the cash flag that C4 went out of its way
   to keep separate.
4. **Till ambiguity.** `branch_cash_account(branch, 'agency_float')` resolves
   `order by code limit 1`. With multiple tills per branch (C13) it would
   silently return an arbitrary till.

**Resolution adopted in Phase 4A.** Add `agency_float` to the constraint — D4
leaves no alternative, since float accounts are branch-held and a branch-held
account must have a `cash_kind` — and in the same migration harden
`assert_cash_account()` to refuse `agency_float` explicitly, directing callers
to the agency path.

This is **backward compatible by construction**: no account has
`cash_kind = 'agency_float'` before this migration, so no existing transfer,
test or certified behaviour can change. Float accounts are resolved through the
`agency_provider_float_accounts` registry by (provider, branch, till), never
through `branch_cash_account()`.

**This also settles the decision the spec deferred at §6.10**, which asked
whether to write a dedicated `post_float_replenishment()` or extend
`record_transfer()` to accept `agency_float`. Extending `record_transfer()` is
now ruled out: it would re-open all four problems above and would alter a
function Phase 3 certified. Phase 4C gets a dedicated
`post_float_replenishment()` gated on `agency:settlements`. Recorded as an
implementation decision, not a Product Owner one.

---

## 4. Open decisions — Product Owner

§13 of the spec lists four conditions before the first migration. D is
satisfied (PR #18 merged). A is this review. B and C remain, and **C materially
changes what the migrations contain.**

### Decision B — account codes

The codes in §3 are confirmed free and follow the existing numbering convention.
Needed: confirmation that the allocation itself is acceptable —
`1310` commission receivable, `1320.{PROVIDER}.{BRANCH}[.T2]` float accounts,
`2210`/`2220`/`2290` payables, `4510`–`4590` commission income, `5960` float
over/short.

Structural only; no business rule depends on it.

### Decision C — commission model per provider

`commission_model` decides whether commission is **recognised at the point of
sale** (`immediate`, no receivable) or **accrued to 1310 and cleared on
settlement** (`deferred`). It changes the journal posted for every transaction
of that provider, so it cannot be guessed.

The spec's §4.1 defaults:

| Category | Model | Providers |
| --- | --- | --- |
| `mobile_money` | deferred | MTN MoMo, Airtel Money |
| `agency_banking` | deferred | Stanbic, PostBank, DFCU |
| `utility` | deferred | UEDCL (Yaka), NWSC |
| `school_fees` | deferred | institutions |
| `tv_subscription` | deferred | DStv, GOtv, StarTimes, Azam |
| `airtime_data` | **immediate** | MTN, Airtel, Lycamobile, Uganda Telecom |

These live in `agency_service_providers` rows — **data, not schema** — so they
are changeable later without a migration. Phase 4A can therefore be built
against the structure while C is still open, provided the provider rows are
seeded separately and marked provisional.

### Decision E — raised by this review

Whether a `secretary_treasurer` may verify an agency transaction at all. §9
grants `agency:verify` to `secretary_treasurer` "cannot verify own", enforced by
the `verifier_not_submitter` CHECK. But the money-movement module Phase 3
certified is stricter: `transfers:approve` and `expenses:approve` are
`manager` + `owner_admin` only, so a `secretary_treasurer` may record money
movement and never approve it — not even someone else's.

So §9 is **looser than the established maker-checker rule** for a module that
moves cash and float. Either is defensible: a one-staff branch cannot operate if
only a manager can verify. Phase 4A seeds the permission rows, so this must be
decided before `agency:verify` is granted.

---

## 5. Migration count

| | Count |
| --- | --- |
| Hosted production | 161 |
| PR #19 | +2 |
| PR #20 | +8 |
| **Phase 4 baseline** | **171** |
| PR #21 (Phase 3 certification) | +0 — tests and documentation only |

All 171 replay cleanly in timestamp order on an empty cluster. Phase 4A's
migrations are numbered from `20261107…`, after PR #20's `20261106000800`, so
merge order with #19 and #20 does not matter. The release total is recomputed
from the directory in each phase report and never carried forward as a literal.
