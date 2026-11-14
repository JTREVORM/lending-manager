# POLYTOS — Agency module redesign: delivery report

**Branch** `claude/adoring-cerf-w07o5i` · **Target** `main` · **Date** 2026-11-14
**Repository** `JTREVORM/lending-manager`

Nothing in this branch has been applied to the production database or deployed.
No migration already applied has been edited. No production data has been
touched. The verdict at §15 is **not** a go-live authorisation.

---

## 1. Architecture audit and gap analysis

### What was already there, and is substantial

The audit's first finding is the most important one for scoping: **the Agency
back end was already close to complete.** 44 of the 217 applied migrations are
agency migrations, and between them they implement:

| Capability | Where |
| --- | --- |
| Provider registry, with float model and commission model per provider | `agency_service_providers` (20261107000300) |
| Agent accounts / lines, one ledger account each, several per branch | `agency_provider_float_accounts` (+ identity in 20261115000200) |
| The transaction engine: record → submit → verify → post, with reversal | 20261107000400, 20261108000200/0400 |
| Maker-checker on every posting path | `agency_actor()`, `*_checker_is_not_maker` CHECKs |
| Commission engine: earned, receivable, settled, outstanding, recovery | 20261108000100, 20261115000400/0700/0800 |
| Float replenishment (Owner funds a till) | 20261110000300 |
| Float trades: purchase, sale, line-to-line transfer, with reversal | 20261115000900/1000 |
| Cash and float reconciliation, with variance and certification | 20261110000400 |
| Provider remittances and commission settlements | 20261110000200, 20261110000100 |
| Idempotency and replay guards | 20261114000100 |
| Concurrency: provider-balance and ledger-balance locking, in order | 20261111000100, 20261110000100 |
| Audit trail on every configuration change | `audit_agency_configuration_change` |
| 20 reporting views, all `security_invoker` | 20261110000600, 20261115001300/1400 |
| RLS on every agency table, branch-scoped, hoisted form | each table's migration |

**Nothing in this branch re-implements any of it.** Every screen added here
reads those views and calls those functions.

### What was actually missing

| Gap | Severity | Status |
| --- | --- | --- |
| **The navigation.** 14 entries in one flat list; a counter screen, a provider register and a Mobile Money dashboard as siblings. No way to ask for "Stanbic's agent accounts". | The client's primary complaint | **Implemented and tested** |
| **Agent Banking had no screens of its own.** `category` distinguished banking from Mobile Money since Phase 4A; nothing in the application read it. | High | **Implemented and tested** |
| **No per-account page.** No screen for one bank agent account or one Mobile Money line. | High | **Implemented and tested** |
| **Cash banking did not exist.** No table, no posting function, no screen. All three of the ways it might have been recorded instead misclassified it. | High — client Rule 5 | **Implemented and tested** |
| **Float trades had no home.** The engine existed; the form appeared only inside one provider's Mobile Money screen. | Medium | **Implemented and tested** |
| **Agency reports had no filters and no exports.** One static screen; the ten lending reports had a registry, a CSV writer, a PDF renderer and an export guard, and agency used none of it. | High — client §6 | **Implemented and tested** |
| **Explicit staff assignment to an account.** No `account → staff` table. Accountability runs through branch authorisation and the recording officer. | Medium — client Rule 6 | **Partially implemented — see §14.1** |
| **Daily commission breakdown on a screen.** The engine records commission per transaction per day and `agency_commission_monthly` rolls it up; no screen shows a per-day table. | Low | **Partially implemented — see §14.2** |

### Risk found during the work, not before it

Two defects were introduced by this branch and caught by the existing suite
before it was pushed. Both are recorded here because they are the evidence that
the suite is doing its job:

1. `mask_msisdn()` was executable by `anon`. `revoke … from public` is not
   enough on this stack — `anon` is granted EXECUTE directly on a new function,
   so it must be named in the revoke. Fixed; `mask_nin()` is the precedent.
2. `agency_mobile_money_consolidated` was rebuilt from migration `…001300` in
   order to append a column, but `…001400` had replaced that view precisely to
   stop it calling two SECURITY DEFINER helpers that are revoked from
   `authenticated`. The rebuild silently reinstated the denial: the whole
   consolidated report would have failed to read for every signed-in officer.
   Fixed, and the migration now states which definition is the correct base.

---

## 2. Final navigation tree

```
AGENCY
├── AGENT BANKING
│   ├── Overview                     /agency/banking                     NEW
│   ├── Record transaction           /agency/record
│   ├── Pending verification         /agency/pending
│   ├── Transaction history          /agency/history                     filters added
│   ├── Float top-ups                /agency/float/replenish
│   ├── Account transfers            /agency/transfers                   NEW
│   ├── Cash banking                 /agency/cash-banking                NEW
│   ├── Commissions                  /agency/commission
│   ├── Settlements                  /agency/payables
│   ├── Cash reconciliation          /agency/reconciliation/cash
│   ├── Float reconciliation         /agency/reconciliation/float
│   ├── Banking reports              /agency/reports?scope=banking
│   └── Banks & Agent Accounts                                           NEW branch
│       ├── All banks & accounts     /agency/banking/accounts            NEW
│       ├── Register a bank          /agency/providers
│       ├── Register an agent account /agency/lines
│       └── «each configured bank»                        ← from the database
│           ├── Registered agent accounts
│           │                        /agency/banking/accounts?provider=CODE
│           └── «each agent account» /agency/accounts/{id}               NEW
│
├── MOBILE MONEY
│   ├── Overview                     /agency/money
│   └── «each configured network»                         ← from the database
│       ├── Dashboard                /agency/money/CODE
│       ├── Transactions             /agency/history?provider=CODE
│       ├── Float management         /agency/money/CODE#float-trades
│       ├── Commissions              /agency/money/CODE/commission
│       ├── Reconciliation           /agency/money/CODE/statements
│       ├── «Network» reports        /agency/reports?provider=CODE
│       └── Agent lines
│           └── «each line»          /agency/accounts/{id}               NEW
│
└── CONSOLIDATED AGENCY REPORTS
    ├── Overview                     /agency/reports
    ├── Transaction reports          /agency/reports?section=transactions
    ├── Cash & float reports         /agency/reports?section=cash-float
    ├── Commission reports           /agency/reports?section=commission
    ├── Settlement reports           /agency/reports?section=settlements
    ├── Reconciliation reports       /agency/reports?section=reconciliation
    ├── Agent performance            /agency/reports?section=performance
    ├── Audit & exception reports    /agency/exceptions
    └── Export centre                /agency/reports?section=export
```

**No provider code appears in any navigation source file.** Asserted by a test
that reads `nav-items.ts`, `primary-nav.tsx` and `agency-nav.ts` with comments
stripped and refuses `STANBIC`, `MTN_MOMO` and `AIRTEL_MONEY`. The per-bank,
per-network and per-account branches are built by `withAgencyNavData()` from
`getAgencyNavData()`, which reads the provider register filtered by **category**
— the database's own vocabulary, which admits providers nobody has registered
yet.

### Navigation rules, as implemented

| Requirement | How |
| --- | --- |
| Expandable, collapsible, nested | `NavGroup` recurses; `SidebarGroup` renders it at any depth |
| Active page and active parent highlighted | `aria-current="page"` on the row; every ancestor header marked via `containsCurrent` |
| Existing responsive behaviour preserved | The drawer, the two breakpoints and the row padding are untouched; asserted by the existing E2E spec |
| Inactive branches collapsed | One module open at a time; branches open only on the path to the page being viewed |
| Only entries the role may reach | `visibleNavModules` → `visibleNavGroup` → `canReachNavItem`, applied **before** the data is grafted on |
| Hiding is not the authorization | Route guard and RLS refuse a hand-typed URL; `permissionForPath` parity asserted over every entry at every depth |
| Routes reused where practical | 11 of the 24 destinations are existing routes; 7 are filtered views of existing screens |
| Empty state + permitted registration action | Declared per branch; a configured provider with no accounts keeps its branch |
| Future providers without restructuring | A category filter, not a code list |

---

## 3. Banking transaction workflow specification

### Customer deposit and withdrawal — unchanged, deliberately

Recorded at `/agency/record` on the Phase 4B engine. A second counter would be
a second posting path. The engine already captures: bank (provider), agent
account, transaction date/time, amount, provider reference, customer
identifier, customer fee, commission, recording officer and verification state.

Movements, from `post_agency_transaction()`:

| Event | Debit | Credit |
| --- | --- | --- |
| Customer deposit, `provider_float` provider | Cash at hand | the account's `1320` float |
| Customer withdrawal, `provider_float` provider | the account's `1320` float | Cash at hand |
| Customer deposit, `cash_payable` provider | Cash at hand | the provider's payable (`2220` for a bank) |
| Charge collected | — | `4570` Agency Service Fees |
| Commission, `immediate` | — | the provider's `45xx` income account |
| Commission, `deferred` | `1310` Commission Receivable | the provider's `45xx` income account |

Fees and commission are separate legs from the principal in every case.

**No customer deposit account and no customer bank balance field exists**, in
the schema or in any export — client Rule 1, asserted by a test over every
export column.

### Cash banking — new. Client Rule 5

| | |
| --- | --- |
| **Business event** | An agent takes collected physical cash to the company's own bank |
| **Debit** | the branch's chosen `bank` account, `amount − charge` |
| **Debit** | `5080 Bank Charges`, `charge`, only when there is one |
| **Credit** | the branch's `cash_at_hand`, the **full** `amount` |
| **Balance effects** | physical cash −`amount`; bank +`amount − charge`; expense +`charge` |
| **Fees** | the bank's charge is an expense, never a reduction of the deposit and never a commission |
| **Commission** | none. No provider, no transaction type, nothing for a commission to attach to |
| **Verification** | required. `agency:write` records and posts nothing; `agency:settlements` posts, and is refused to whoever recorded it |
| **Reversal** | contra entries under `agency:reverse`; `agency:reverse_cross_day` for a closed day. The original journal is never touched |
| **Idempotency** | the bank's deposit reference is unique per destination account; `verify_` and `reverse_` both return the existing entry on a second call |
| **Concurrency** | row taken `FOR UPDATE`, then both ledger balances locked through `lock_ledger_balances()` (which sorts the ids), then the cash is read |

The credit is the full amount because that is what physically left the till.
Netting the charge off the credit would balance just as well and would claim
the cashier carried less money than they did.

### Inter-account transfers — `/agency/transfers`

The Phase 4E float-trade engine, given a screen. Purchase, sale and
line-to-line transfer, each with source, destination, amount, category,
reference, date, optional fee, recording officer, approving officer, status,
reversal linkage and audit history.

Validation, all enforced in the database: source ≠ destination; sufficient
funds under lock; accounts active and eligible; cross-branch authority required
for both branches; suspended accounts may be recovered from but not bought
into; duplicate references refused; concurrent transfers serialised by the
provider-balance lock taken in branch-id order.

**Cross-provider float transfers are refused.** Client Rule 8: one provider
cannot settle another's float. Value crosses by selling float into a cash
account and buying it on the other side, both recorded as what they are. The
screen is therefore scoped to one provider rather than offering a pair the
engine would reject.

---

## 4. Mobile Money provider and line architecture

One screen per concern, driven by the provider's own row, for the reason
`/agency/money/[providerCode]` already stated: MTN and Airtel are the same
accounting and different configuration, and the configuration is columns.

`MTN_MOMO` and `AIRTEL_MONEY` keep their established codes and identities;
neither is altered. Both remain `is_provisional = true`, which is unchanged and
correct: requirement 11 forbids activating a provider before its commercial
configuration is approved.

A line's own page is `/agency/accounts/{id}` — **the same route a bank agent
account uses.** §4.1 and §5.2 ask for almost the same contents, because the
thing is the same: one row of `agency_provider_float_accounts` with one ledger
account, and every figure from one view. Two pages would be two aggregations
that could disagree with each other and with the ledger. What differs is the
vocabulary and the breadcrumb, both read from the provider's category.

The page shows: name or masked number, provider, branch, current float,
commission receivable, commission owed back, commission earned today, today's
deposits/withdrawals/charges, work awaiting verification, the registration
(agent code, ledger account, till, opened, closed, open reconciliations),
recent transactions and float movements on that account.

`line_msisdn` is exposed **masked only** — `+256 77 *** 4567`, by
`mask_msisdn()` inside the view. The full number stays in the table behind the
administration path that guards `agency:providers`.

---

## 5. Schema and migration summary

Three new migrations. **217 applied migrations are untouched.** All 220 apply in
order to an empty database, re-proved on every `npm run test:db` run.

| Migration | What it does | Dependencies |
| --- | --- | --- |
| `20261116000100_agency_provider_category_and_line_identity` | Adds `mask_msisdn()`. Appends `provider_category`, `line_msisdn_masked`, `agent_code`, `opened_on`, `closed_on`, `branch_name`, `transactions_today` to `agency_commission_by_line` and `agency_mobile_money_dashboard`, and `provider_category` to `agency_mobile_money_consolidated`. | 20261115001400 (its view definitions are the base) |
| `20261116000200_agency_cash_banking` | `agency_cash_bankings`, two guards, RLS, four RPCs, `agency_cash_banking_register`, two journal source types. | 20261110000300 (settlement account assertions), `lock_ledger_balances`, `post_journal` |
| `20261116000300_agency_transaction_history_reporting` | Appends `provider_category`, `branch_name`, `submitted_by_name`, `verified_by_name`, `agent_code` to `agency_transaction_history`. | 20261115001300 (its definition is the base) |

**Every view change is additive by construction.** `create or replace view`
refuses to rename, reorder or retype a column, so each definition is the live
one with columns appended — existing readers are untouched because the database
would not allow otherwise.

Why these were needed rather than reusing the schema: the three views carried
the provider's id, code and name and stopped there, so a screen wanting "every
bank agent account" had to re-join in TypeScript or hard-code the codes that
count as banks. Cash banking needed a table because it is a distinct business
event with its own maker-checker control and its own source type.

---

## 6. Financial posting matrix

Only one new financial operation is introduced. Everything else reuses a posting
function that was already there and already tested.

| # | Business event | Dr | Cr | Balance effects | Fees | Commission | Verification | Reversal | Idempotency key | Concurrency |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | Cash banked, no charge | branch `bank` | branch `cash_at_hand` | cash −A, bank +A | — | none | `agency:settlements`, ≠ maker | contra, `agency:reverse` | `(bank_account_id, deposit_reference)` unique | row `FOR UPDATE` → `lock_ledger_balances([cash, bank])` → `assert_cash_available` |
| 2 | Cash banked, with charge | branch `bank` A−C; `5080` C | branch `cash_at_hand` A | cash −A, bank +A−C, expense +C | charge → `5080` as expense | none | as above | as above, charge reversed out of `5080` | as above | as above |
| 3 | Cash banking reversed | branch `cash_at_hand` A | branch `bank` A−C; `5080` C | every effect of 1/2 undone | — | none | `agency:reverse`; closed day needs `agency:reverse_cross_day` | idempotent; returns the existing contra entry | the row's own state | as above, plus `assert_cash_available(bank, A−C)` |

Integrity properties, each asserted:

- every posted journal balances — `journal_entries_assert_balanced` trigger,
  plus an explicit debits-equal-credits assertion in the cash banking suite;
- no financial transaction posts twice — unique reference, idempotent verify,
  and a two-connection race asserting exactly one journal entry;
- posting and reversal preserve immutability — the original entry is read
  before and after a reversal and asserted byte-identical;
- cash and float cannot be silently created or destroyed — the balance
  invariant suite now covers both new source types;
- commission cannot be mistaken for principal — the new event recognises none,
  asserted by "the entry touches no income account";
- internal transfers do not inflate revenue or volume — a cash banking creates
  no `agency_transaction` row, asserted directly;
- failed operations leave no partial journals — one transaction per RPC, and
  the pending-state test asserts recording moves nothing at all;
- the correct branch and account are used — the guard refuses an account of
  another branch, and the source cash account is looked up from the branch
  rather than taken as an argument.

---

## 7. Reports inventory

Three levels, one filter. `?account=` is Level A, `?provider=` or `?scope=` is
Level B, the default is Level C.

| § | Report | Section | Source |
| --- | --- | --- | --- |
| 6.1 | Transactions: deposits, withdrawals, counts, values, charges, verified/pending/reversed, references, maker and checker | `?section=transactions` | `agency_transaction_history` |
| 6.2 | Electronic float per account, with the ledger account behind it | `?section=cash-float` | `agency_mobile_money_dashboard` |
| 6.3 | Cash: received, paid out, banked, counted, variance, reconciliation status | `?section=cash-float` | `agency_daily_cash_movement`, `agency_cash_banking_register`, `agency_cash_reconciliation_register` |
| 6.4 | Commission: earned vs received vs outstanding, by provider and by account | `?section=commission` | `agency_commission_summary`, `agency_mobile_money_dashboard` |
| 6.6 | Settlements, with statement reference and settlement account | `?section=settlements` | `agency_commission_settlement_register`, `agency_payable_summary` |
| 6.6 | Reconciliation: system vs statement, variance with its stated convention, resolution | `?section=reconciliation` | `agency_variance_report`, `agency_float_reconciliation_register` |
| 6.5 | Agent performance per staff member | `?section=performance` | tallied over `agency_transaction_history` |
| 6.7 | Consolidated overview | `?section=` (default) | all of the above |
| — | Audit & exceptions | `/agency/exceptions` | `agency_end_of_day_exceptions` |
| 6.8 | Export centre | `?section=export` | links carrying the filter |

**Filters** (§6.8): today, yesterday *(via a custom range)*, this week, this
month, this year, custom range; provider; bank *(a provider in the banking
category)*; agent account/line; branch; transaction status. Staff member is a
filter column on the transaction and performance reports.

**Exports**: `/agency/reports/export?…&format=csv|pdf`. Both carry the report's
heading, the period, the filters applied, who generated it and when. The PDF is
letterheaded through the existing pipeline. CSV writes money as plain digits so
a spreadsheet reads it as a number, and disarms a leading `=`, `+`, `-` or `@`.

**Double counting**: a transfer stays in its own two columns and out of
`float_purchased`/`float_sold`, because a transfer between two of one provider's
lines moves no float into or out of the provider. Service volume and the
company's own position are rendered in two separate groups, because §6.5
forbids reading transaction volume as profit.

---

## 8. Authorization and RLS assessment

No capability was added, no role's capability set was changed, and no policy was
relaxed.

| Operation | Capability | Role |
| --- | --- | --- |
| Record a transaction or a cash banking | `agency:write` | Secretary/Treasurer, Manager, Owner |
| Verify a transaction | `agency:verify` | Manager, Owner |
| Post a cash banking, a float trade, a settlement | `agency:settlements` | Manager, Owner |
| Reverse | `agency:reverse`; `agency:reverse_cross_day` for a closed day | Manager (same-day), Owner (any) |
| Record a float trade | `agency:float_trade` | Secretary/Treasurer, Manager, Owner |
| Reconcile | `agency:reconcile` | Manager, Owner |
| Configure providers, register accounts | `agency:providers` | Owner |
| Read reports, open an export | `agency:reports` | Secretary/Treasurer, Manager, Owner |
| Anything agency at all | — | **Client: none** |

Preserved and asserted:

- **RLS** — `agency_cash_bankings` has a branch-scoped read policy in the
  hoisted form the repository enforces; no INSERT, UPDATE or DELETE grant
  exists on it for any exposed role;
- **Maker-checker** — a CHECK constraint (`verified_by <> created_by`) *and* an
  explicit refusal in the function, so it cannot be bypassed by any path;
- **Server-action authorization** — `requirePermission` plus a rate-limit
  bucket, and the database refuses the same thing again with 42501;
- **Database-level guards** — the four new RPCs refuse a borrower with SQLSTATE
  42501 **before reading an argument**, measured by
  `scripts/probe-definer-authorization.mjs`, not inferred from the body;
- **Forced-password-change boundary** — the export route goes through
  `guardExport`, which refuses an account holding a temporary password;
- **Rate limiting** — recording uses `agency.record`, posting and rejecting
  `agency.settlement`, reversing `agency.reverse`; exports carry the export
  limit;
- **Audit events** — recorded, posted, rejected and reversed each write an
  audit row naming the actor;
- **Branch visibility** — enforced by the policy, by `user_can_see_branch()` in
  every RPC, and by the guard that refuses an account of another branch.

`config/database-security-baseline.json` classifies all four new DEFINER
functions as **A**, each with the measured refusal recorded as its reason.
`node scripts/check-database-security.mjs` reports **no unreviewed privileged
exposure**.

**Adding navigation entries made no database operation newly available.** The
parity test asserts every entry's declared capability equals what its route
guards, at every depth, including the data-driven ones.

---

## 9. Implemented file list

**New migrations (3)**
`supabase/migrations/20261116000100_agency_provider_category_and_line_identity.sql`
`supabase/migrations/20261116000200_agency_cash_banking.sql`
`supabase/migrations/20261116000300_agency_transaction_history_reporting.sql`

**New routes (6)**
`app/(app)/agency/banking/page.tsx`
`app/(app)/agency/banking/accounts/page.tsx`
`app/(app)/agency/accounts/[accountId]/page.tsx`
`app/(app)/agency/cash-banking/page.tsx`
`app/(app)/agency/transfers/page.tsx`
`app/(app)/agency/reports/export/route.ts`

**New components (5)**
`components/agency/agent-accounts.tsx`
`components/agency/cash-banking-forms.tsx`
`components/agency/filter-chips.tsx`
`components/agency/report-filters.tsx`
`components/agency/report-sections.tsx`

**New library modules (3)**
`lib/agency/reporting.ts`
`lib/data/agency-nav.ts`
`lib/reports/agency-fields.ts`

**New tests (3)**
`tests/db/agency-cash-banking.test.ts`
`tests/integration/agency-navigation.test.tsx`
`tests/unit/agency-report-fields.test.ts`

**Modified (20)** — `components/layout/nav-items.ts`,
`components/layout/primary-nav.tsx`, `components/layout/app-shell.tsx`,
`config/app.ts`, `lib/auth/routing.ts`, `lib/domain/agency.ts`,
`lib/data/agency.ts`, `lib/validation/agency.ts`, `lib/agency/actions.ts`,
`app/(app)/agency/reports/page.tsx`, `app/(app)/agency/history/page.tsx`,
`types/database.types.ts`, `config/database-security-baseline.json`,
`scripts/lib/clean-slate.mjs`, `vitest.config.mts`, `package.json`, and five
test files updated to cover the new level.

45 files, +9,489 / −535.

---

## 10. Automated test results

Every figure below is from a run on this branch, against a database rebuilt
from all 220 migrations.

| Suite | Command | Result |
| --- | --- | --- |
| Unit + integration | `npm run test:run` | **2,743 passed**, 0 failed |
| Database, 13 projects | `npm run test:db` | **2,487 passed**, 0 failed |
| — cash banking | `--project agency-cash-banking` | **29 passed** |
| — Mobile Money | `--project agency-money` | 123 passed |
| — clean slate | `--project clean-slate` | 37 passed |
| Agency navigation | `tests/integration/agency-navigation.test.tsx` | **23 passed** |
| Agency export columns | `tests/unit/agency-report-fields.test.ts` | **26 passed** |
| Typecheck | `npm run typecheck` | clean |
| Lint | `npm run lint` | clean |
| Format | `npm run format:check` | clean |
| Build | `npm run build` | compiled; all 25 `/agency` routes present |
| Money arithmetic | `npm run audit:money` | 268 files, no hazard |
| Database security | `check-database-security.mjs` | no unreviewed exposure |
| Financial certification | `npm run certify:financial` | 38 identities — 36 pass, 2 explained, **0 fail** |
| Authorization probe | `probe-definer-authorization.mjs` | 4/4 new RPCs refuse a borrower with 42501 |

### Coverage against §11, item by item

| Required | Status |
| --- | --- |
| Correct Agent Banking hierarchy | ✅ integration |
| Correct Mobile Money hierarchy | ✅ integration |
| MTN and Airtel separation | ✅ integration (per-provider branches, no shared destination) |
| Dynamic line navigation | ✅ integration (built from fixture data; no provider code in source) |
| Active page highlighting | ✅ integration (exactly one entry lit) + E2E |
| Role-based menu visibility | ✅ integration (borrower, Secretary, Manager, Owner) |
| Mobile responsiveness | ⚠️ existing E2E spec covers the drawer; the new branch tests are **written, not yet run** — see §11 |
| Deposit / withdrawal postings | ✅ pre-existing (`agency-transaction-engine`) |
| Float top-ups | ✅ pre-existing |
| **Cash banking** | ✅ 29 tests, including the three Rule 5 negatives |
| Same-provider account transfers | ✅ pre-existing (`agency-money-float`) |
| Cross-provider transfer restrictions | ✅ pre-existing |
| Transfer fees | ✅ pre-existing |
| Duplicate submissions | ✅ cash banking + pre-existing idempotency suite |
| Failed posting rollback | ✅ "records a pending banking and moves no money at all" |
| Insufficient funds | ✅ "refuses more cash than the till holds" |
| Suspended accounts | ✅ pre-existing |
| Daily earned commission | ✅ pre-existing engine tests |
| Actual settlement, outstanding, adjustments, reversals, allocation | ✅ pre-existing |
| Line and provider totals | ✅ pre-existing view tests |
| Consolidated totals, no double counting | ✅ pre-existing (transfer columns) |
| Date filters, zero-data cases | ✅ unit (filter defaults, fallbacks, unreadable range) |
| Reversal handling in reports | ✅ performance tally; reversed in its own column and no volume |
| PDF exports | ⚠️ implemented and reachable; **no test asserts the bytes** — see §14.3 |
| Excel-compatible exports | ✅ unit (plain digits, formula disarming, heading rows pinned) |
| Unauthorized report access | ⚠️ `guardExport` is shared and pre-tested; **no test exercises the agency route specifically** — see §14.3 |
| Role boundaries, branch isolation, RLS | ✅ cash banking suite + `security.test.ts` + `rls-*` suites |
| Maker-checker | ✅ 4 tests |
| Unauthorized posting attempts | ✅ 3 tests + the probe |
| Unauthenticated access | ✅ `guardExport`, pre-tested |
| Parallel withdrawals / float transfers | ✅ pre-existing |
| Posting vs reversal, settlement vs reversal | ✅ pre-existing |
| **Two verifiers racing one banking** | ✅ staged on two connections; exactly one journal entry |
| Reconciliation vs concurrent balance change | ✅ pre-existing (`balanceMoved`) |

**No test was weakened or deleted.** Five existing tests were updated, each
because the invariant it asserts gained a level; two were made *stronger*
(the module-filter test now recurses; the boundary test now asserts the new
prop carries no component).

---

## 11. CI evidence

CI will run on the pull request: `.github/workflows/ci.yml` performs typecheck,
lint, format, unit/integration, the database projects, the build, the security
gate, the money audit, and the Playwright suites against a Docker-free stack
(real PostgreSQL, real PostgREST, an auth shim, the production Next build).

**The Playwright suites were not run in this session.** The harness needs a
PostgREST binary; this sandbox has none, and executing a freshly downloaded one
was declined by the environment — correctly, since it is an unverified
third-party binary. CI fetches it with a pinned SHA-256, which is the right
place for that step. The five new browser tests for the Agency branch are
committed and will run there.

Until that run completes, **§11's "mobile responsiveness" and the browser-level
rendering of the nested rail are untested claims.** They are marked as such
above and in §15.

---

## 12. Commit hashes

```
215e245  test(agency): pin every export's heading row, the filter, and the performance tally
d4d69ff  fix(agency): declare the new objects in the exhaustive inventories, and two real defects they caught
891ee8f  test(agency): 23 tests for the nested rail, and the bundle budget's case
cb93c9a  feat(agency): the consolidated reporting hub, nine sections and the exports
872a42f  feat(agency): Agent Banking pages, the per-account page, cash banking and transfers
ece0a0a  feat(agency): nested data-driven Agency navigation, and the reporting filter behind it
848ffa7  feat(agency): expose provider category on the agency views, and implement Cash Banking
```

---

## 13. Deliverables index

| # | Deliverable | Where |
| --- | --- | --- |
| 1 | Architecture audit and gap analysis | §1 |
| 2 | Final navigation tree | §2 |
| 3 | Banking transaction workflow specification | §3 |
| 4 | Mobile Money provider and line architecture | §4 |
| 5 | Schema and migration summary | §5 |
| 6 | Financial posting matrix | §6 |
| 7 | Full reports inventory | §7 |
| 8 | Authorization and RLS assessment | §8 |
| 9 | Implemented file list | §9 |
| 10 | Automated test results and counts | §10 |
| 11 | CI evidence | §11 |
| 12 | Git commit hashes | §12 |
| 13 | Pull request link | the PR this document is referenced from |
| 14 | Known risks and outstanding decisions | §14 |
| 15 | Production readiness verdict | §15 |
| 16 | Safe release instructions | §16 |

---

## 14. Known risks and outstanding decisions

### 14.1 Client Rule 2 conflicts with the provisional STANBIC configuration — **requires client clarification**

Rule 2 says each bank supplies electronic float, like MTN and Airtel. The
provisional `STANBIC` row is configured `float_model = 'cash_payable'`, which
means the company holds the customer's cash and owes it onward — **not**
electronic float. The two cannot both be true.

Consequences while it stands:

- `agency_mobile_money_consolidated` filters on `float_model =
  'provider_float'`, so **no bank appears in that roll-up**. The banking
  screens read the per-account view instead, which is float-model agnostic, so
  they work either way;
- a bank agent account on the cash-payable model holds no `1320` float, so its
  float figures are zero and its position is a payable on the remittances
  screen.

This branch **does not change it**, deliberately. Requirement 11 forbids
activating or reconfiguring a provider before its commercial configuration is
approved, and a migration that silently rewrote a provider's float model would
be exactly that. The row is `is_provisional = true`, which is the schema saying
the same thing.

**Needed:** the Owner confirms Stanbic's actual commercial model with the bank.
If it is electronic float, the provider's `float_model` must change — and that
is a schema question, because the CHECK constraints tie `payable_account_id` to
`float_model` and there is **no RPC that changes a float model today**. One
would have to be written, with a guard refusing the change while the provider
has posted history on the other model.

### 14.2 Explicit staff assignment to an account — **partially implemented**

§4.1 asks for "Assigned staff members" on an account and Rule 6 for one agent
across several banks. Operationally Rule 6 **works**: any authorised officer at
a branch may transact on any account at that branch, every transaction records
its recording and verifying officer, and the agent performance report attributes
by person.

What does not exist is an explicit `account → staff` assignment list, so:

- an account cannot be restricted to named officers;
- "which accounts is this officer on" is answered by what they have transacted,
  not by a roster.

**Needed:** a decision on whether assignment should *restrict* posting or only
*document* it. If it restricts, it is a new table, a guard in
`create_agency_transaction()` and a migration — and it changes who can post,
which is a control change the Owner should approve rather than inherit.

### 14.3 Export testing is thinner than the rest — **partially implemented**

The CSV path is covered: every heading row is pinned, money is asserted as
plain digits, formula disarming is asserted, and no column carries a customer
identifier or balance. The PDF path reuses `renderReportPdf`, which has its own
tests, but **no test renders an agency PDF and inspects it**, and no test calls
`/agency/reports/export` to assert its refusals. `guardExport` is shared with
six pre-tested export routes, so the refusal logic is covered — the agency
route's use of it is not.

### 14.4 Daily commission is recorded but not displayed per day — **partially implemented**

Rule 3 is satisfied in the engine: commission is recognised per transaction per
day, and earned is separated from received and from settled throughout. The
commission report shows earned/received/outstanding by provider and by account,
and today's commission per account. It does **not** render a day-by-day table
over a period; `agency_commission_monthly` exists and is not yet on a screen.

### 14.5 Deliberately not done

- **Provider activation.** MTN, Airtel and Stanbic remain provisional and
  inactive. Requirement 11.
- **No commission rate was invented.** `commission_rate_bps` is left as the
  specification's default, and commission may be entered as reported, because
  provider rates and schedules are unconfirmed.
- **No seeded financial data.** Nothing in this branch writes a transaction, a
  balance, a rate or a float figure.

### 14.6 Operational risk at release

- The three migrations include two `create or replace view` statements that
  take a brief `ACCESS EXCLUSIVE` lock on the view. Readers of the Agency
  screens may see a moment's error during the apply. It is sub-second and the
  screens report a failed read rather than rendering a zero.
- `journal_entries_source_valid` is dropped and recreated. PostgreSQL validates
  the new CHECK against every existing row, which on a large `journal_entries`
  is a table scan. It is fast on the current data volume; it is the slowest
  statement in the three migrations.

---

## 15. Production readiness verdict

**Ready for review. Not ready for release, and not authorised for one.**

What is solid: the back end was already mature and is unchanged; the three new
migrations are additive and apply cleanly from zero; the one new financial
operation has 29 tests including the three negatives its business rule demands
and a two-connection race; every gate the repository enforces is green,
including the financial certification and the database security baseline; and
the navigation — the client's actual complaint — is implemented, data-driven and
covered by 23 tests that would fail if a provider code were ever written into
it.

What is not done, and must be before anyone considers a release:

1. **CI has not run yet.** The Playwright suites in particular could not run
   here. Until they pass, the nested rail's browser behaviour is a claim.
2. **Rule 2 is unresolved** (§14.1). Until the Owner confirms Stanbic's float
   model, the banking module runs on a provisional configuration that
   contradicts the stated requirement.
3. **Staff assignment is a decision, not a task** (§14.2).
4. **Owner acceptance testing has not happened.** No one from the business has
   opened these screens.

---

## 16. Safe release instructions

Do **not** merge or deploy without explicit written authorisation. When it is
given:

**Before**

1. Take a verified backup of `qxcwsvmakdilsshvcjuv` and prove the restore path
   on a scratch project — `docs/BACKUP-RESTORE.md`.
2. Confirm CI is green on the PR, Playwright included.
3. Record the current migration head and the current Vercel production
   deployment id, so both have a known rollback target.
4. Resolve §14.1, or accept in writing that the banking module ships on a
   provisional provider configuration.

**Migrations** — apply in order, nothing else interleaved:

```
20261116000100_agency_provider_category_and_line_identity.sql
20261116000200_agency_cash_banking.sql
20261116000300_agency_transaction_history_reporting.sql
```

Apply during a quiet period: two statements briefly lock the agency views and
one revalidates the `journal_entries` source CHECK.

**Checks, immediately after**

```sql
-- the three views carry their new columns
select count(*) from information_schema.columns
 where table_name = 'agency_mobile_money_dashboard' and column_name = 'provider_category';
-- the masking function is not reachable by anon
select proacl from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.proname = 'mask_msisdn';
-- the new table is RLS-protected and SELECT-only for authenticated
select relrowsecurity from pg_class where relname = 'agency_cash_bankings';
-- no source type was lost: 39 expected
select cardinality(regexp_split_to_array(pg_get_constraintdef(oid), ','))
  from pg_constraint where conname = 'journal_entries_source_valid';
```

Then run `node scripts/check-database-security.mjs` and
`npm run certify:financial` against production read-only, and confirm the
financial matrix still reports 0 failures.

**Deploy** the application only after the migrations are applied and checked —
the new screens read columns that do not exist until then.

**Post-deployment**

1. `/api/health` returns the new build's version.
2. Open `/agency`, `/agency/banking`, `/agency/cash-banking`,
   `/agency/transfers`, `/agency/reports` and one `/agency/accounts/{id}` as the
   Owner. Every one should render; none should show a failed read.
3. Confirm the rail shows the configured banks and networks, and that a
   provider with no accounts shows its empty state.
4. Download one CSV and one PDF and confirm each carries its period and filters.
5. Owner acceptance: record one cash banking, have a second officer post it,
   and confirm the branch cash position and the bank account both move by the
   expected amounts, and that the trial balance still foots.

**Rollback**

- *Application only:* promote the previous Vercel deployment. The three
  migrations are additive — appended view columns and a new table — so the
  previous build runs against the new schema unchanged. **This is the preferred
  rollback.**
- *Schema:* only if a defect is in the migrations themselves. There is no down
  migration, by project policy. Reverting means restoring the backup from
  step 1, which loses everything posted since. Do not reach for it without the
  Owner's explicit decision.
- A posted cash banking is reversed through the application
  (`agency:reverse`), never by deleting a row — the table refuses DELETE and
  the journal is immutable.

**Go / no-go: NO-GO** pending items 1–4 of §15.
