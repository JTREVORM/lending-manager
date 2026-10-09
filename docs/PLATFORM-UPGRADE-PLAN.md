# Lending Manager — platform upgrade

Audit, gap analysis and phased plan for the move from the current
individual-lending application to the full operations platform.

Status: **plan only. No schema or code has been changed by this document.**

---

## 1. What exists today

Measured against the live database (`fszgwemtgyrbhngajpzm`) and the repository
at `45d94cb`.

### Schema

| | Count |
|---|---|
| Migrations applied | 58 |
| Tables | 28 |
| Views | 12 |
| Functions | 77 |
| RLS policies | 46 (RLS on every table) |
| Permissions | 47 |
| Roles | 4 — `client` (10), `secretary_treasurer` (30), `manager` (50), `owner_admin` (70) |
| Role→permission grants | 99 |

**Tables.** `clients`, `client_identities`, `client_remarks`,
`client_guarantors`, `guarantors`, `guarantor_identities`, `loans`,
`loan_periods`, `loan_schedules`, `loan_installments`, `loan_payments`,
`payment_allocations`, `loan_penalties`, `loan_client_snapshots`,
`loan_guarantor_snapshots`, `loan_identity_snapshots`, `profiles`, `roles`,
`permissions`, `role_permissions`, `user_roles`, `audit_log`,
`business_settings`, `company_settings`, `repayment_frequencies`,
`reference_formats`, `reference_sequences`, `rate_limit_counters`.

**Views.** `loan_balances`, `loan_obligations`, `loan_delinquency`,
`loan_installment_coverage`, `loan_penalty_coverage`, `loan_portfolio_report`,
`payment_register`, `payment_collection_totals`, `collections_today`,
`dashboard_portfolio_summary`, `dashboard_collection_summary`,
`company_identity`.

**Domain functions.** `approve_loan`, `disburse_loan`, `cancel_loan`,
`generate_loan_schedule`, `calculate_loan_breakdown`, `post_payment`,
`reverse_payment`, `ensure_penalty_applied`, `apply_eligible_penalties`,
`validate_loan_for_approval`, `loan_total_outstanding`, `business_now`,
`next_reference`, plus 20 audit triggers and the capability helpers.

### Routes

36 pages: dashboard, clients (+new/detail/edit), guarantors (+new/detail/edit),
loans (+new/detail/edit/statement), payments (+new/detail), overdue, reports
(hub + 6 reports), users (+new/detail), audit, settings, account (+password),
login, borrower portal (+loan detail), offline.

### Tests

| Project | Files | Tests |
|---|---|---|
| unit + integration | 51 | 1,708 |
| database (real PostgreSQL) | 38 | 1,056 |
| browser (Playwright, 2 viewports) | 14 | 358 |

### Demo data (live)

28 clients (26 active, 1 inactive, 1 blacklisted) · 14 guarantors · 34
client–guarantor links · 33 loans (17 active, 9 cleared, 2 approved, 3 pending,
2 draft) · 719 installments · 469 payments (468 posted, 1 reversed) · 503
allocations · 5 penalties · 15 remarks · 1,390 audit rows · 3 staff.

Money: principal disbursed **26,500,000**, interest charged **6,082,500**,
penalties charged **860,589**, collected **21,986,867**, outstanding
**11,456,222**. Books reconcile exactly
(billed − collected = outstanding).

---

## 2. Target architecture, mapped

| Target module | Today | Verdict |
|---|---|---|
| Dashboard | 2 summary views, no cash/liquidity, no trends, no branch | **Extend** |
| Branch Network | — | **New** |
| Clients | clients, identities, remarks, guarantors, snapshots, audit | **Extend** (branch, documents) |
| Loan Management | full lifecycle, frozen terms, schedules | **Reorganise + extend** (rejected state, settings-driven terms, overrides) |
| Collections | `post_payment`, `reverse_payment`, register, receipts | **Extend** (Bank method, by staff/branch, allocation preview) |
| Debt & Security | `loan_delinquency`, penalties, overdue page | **Extend** (aging, PAR, collateral, follow-ups, PTP, guarantor register) |
| Transfers | — | **New** |
| Financial Ledger | — | **New — the largest gap** |
| Reports | 7 reports | **Extend** (~110 in the brief) |
| Notifications | — | **New** |
| People & Access | profiles, roles, permissions, audit, sign-in tracking | **Extend** (branch scope, new capabilities) |
| System Settings | `business_settings`, `company_settings`, `reference_formats` | **Extend substantially** |

### The three findings that shape the plan

**1. There is no money ledger at all.** The system knows what every borrower
owes to the shilling, and nothing whatsoever about where the company's money
is. `loan_payments` records that 150,000 arrived by MTN; nothing records that
MTN therefore holds 150,000 more. Cash at Hand, MTN, Airtel and Bank do not
exist as objects. This is the foundation every other new module sits on —
transfers, expenses, reconciliation, liquidity, most of the dashboard and the
whole Financial report family — so it is Phase 1 and nothing else can
overtake it.

**2. Interest is already settings-driven, and more correctly than the brief
assumes.** `approve_loan` reads `business_settings` at approval time and
snapshots the result onto the loan
(`interest_rate_bps`, `interest_method`, `total_interest`,
`grace_period_days_applied`, `penalty_rate_bps_applied`). Changing a setting
cannot alter a historical loan — that invariant already holds and is tested.
What is missing is the *range*: minimum/maximum interest, who may override,
duration options as a list, early-repayment and extra-payment handling.

**3. `payment_method` has no Bank.** A CHECK constraint on `loan_payments`
permits `cash`, `mtn_mobile_money`, `airtel_money` only, and `post_payment`
re-checks it. Adding Bank touches a constraint, a function, the seed, the
reports and the UI — small, but it is schema change, not configuration.

---

## 3. Phases

Each schema phase states its tables, its backfill, and its risks before it is
written. Nothing in a later phase is started before the phase under it is
green.

### Phase 1 — Branches and the financial ledger (foundation)

New tables: `branches`, `financial_accounts`, `journal_entries`,
`journal_lines`, `account_balances` (materialised or view).

Every existing table that belongs to a branch gains `branch_id`.

Backfill: create the branch(es), create the four account types, derive
journal entries for all 26 disbursed loans and 468 posted payments from
existing rows, and post an opening-balance entry so no account goes negative.

Risk: the backfill must reproduce exactly the figures the existing views
already report, or the dashboard will disagree with itself. Mitigated by a
reconciliation test that asserts ledger totals equal
`dashboard_portfolio_summary` to the shilling.

### Phase 2 — Money movement

Transfers, expenses, other income, daily reconciliation. All post through
Phase 1's journal.

### Phase 3 — Settings expansion

Lending rules (interest range, overrides, durations), guarantor rules,
finance settings, reference formats. Loan application reads them.

### Phase 4 — Loan management reorganisation

Rejected/cancelled as a first-class state, the eleven-section loan
navigation, guarantor capture inside the application with consent capture and
snapshotting.

### Phase 5 — Collections and Debt & Security

Bank payment method, allocation preview, aging buckets, PAR, collateral,
follow-ups, promise-to-pay, guarantor register.

### Phase 6 — Notifications

Table, generation triggers, bell, page, categories, deep links.

### Phase 7 — Reports Center

The ~110 reports, the shared filter/sort/paginate/total/drill-down harness,
and the PDF export with letterhead.

### Phase 8 — Dashboard

Last, not first: every card it shows is a query against a module built above.

### Phase 9 — Demo data enrichment and full reconciliation

---

## 4. Decisions required before Phase 1

These change the shape of the foundation, so a wrong assumption means
rebuilding it rather than extending it.

1. **Are financial accounts global or per-branch?** Branch reporting in the
   brief lists "cash at hand, MTN, Airtel, bank balance" per branch, which
   implies per-branch accounts; the Financial Ledger section lists four
   accounts, which implies global.
2. **What opening balance should the demo accounts carry?** The existing demo
   paid out 26.5M and took back 22M with no cash accounts behind it. Without
   an opening balance the backfilled cash accounts go negative on day one.
3. **How many branches should the demo have, and where do the existing 28
   clients and 33 loans sit?**
4. **Does the ledger post inside the existing financial functions, or beside
   them?** Writing journal lines inside `post_payment` and `disburse_loan`
   makes the ledger impossible to skip, but edits two functions that handle
   real money and carry 1,056 database tests.

### How they were answered

The four were put to the owner and answered before a line of Phase 1 was
written. Each answer is now a property of the schema rather than a note here.

1. **Per-branch.** Cash accounts carry a `branch_id`; income and expense
   accounts do not, and are sliced by the branch on the journal entry. The
   reasoning, and why the alternative produces "Interest Income — Nansana" as
   a separate account from "Interest Income", is at the head of migration
   `20261010000100`.
2. **A dated Capital Introduced journal, mathematically derived.** Not a
   round figure chosen to flatter the dashboard: 21,449,163 is the exact
   depth of the deepest point the cash position reaches when every
   disbursement and every cash movement is replayed in timestamp order, so
   Cash at Hand touches zero at its lowest point and never goes below it. The
   derivation is in migration `20261010000200` and re-proved by a test.
3. **One branch, Head Office**, opened the day before the first disbursement.
   All 28 clients and 33 loans belong to it. New clients and loans are
   stamped by a trigger, so nothing that creates them today had to change.
4. **Inside.** `disburse_loan`, `post_payment` and `reverse_payment` each
   post their own journal, so a money mutation that commits without its
   ledger entry is not a reachable state. The three functions were re-emitted
   from `pg_get_functiondef` with one `perform` added to each rather than
   retyped — a transcription slip inside three hundred lines of allocation
   arithmetic being the most expensive kind of mistake available there.

Penalty *charging* posts nothing, which is a consequence of (2)'s accounting
model rather than an omission: income is recognised when collected, so a
penalty reaches the books through the `allocated_penalty` component of the
repayment that settles it. `ensure_penalty_applied` therefore needed no
ledger wiring.

---

## 5. Status

| Phase | State |
| --- | --- |
| 1 — Branches and the financial ledger | **Complete.** Migrations `20261010000100`–`20261010000300`, applied live and reconciled. See `UPGRADE-PHASE-1-REPORT.md`. |
| 2 — Money movement | **Complete.** Migrations `20261011000100`–`20261011000240`, applied live. Transfers, expenses, other income and daily reconciliation, all posting through the Phase 1 ledger. |
| 3 — Settings expansion | Not started |
| 4 — Loan management reorganisation | Not started |
| 5 — Collections and Debt & Security | Bank payment method delivered early, in Phase 1, because the ledger needed the fourth cash account anyway. The rest not started. |
| 6 — Notifications | Not started |
| 7 — Reports Center | Not started |
| 8 — Dashboard | Not started |
| 9 — Demo data enrichment | Not started |

Phase 1 shipped as `financial_accounts` → `ledger_accounts` and without a
separate `account_balances` table: balances are a view over the lines
(`ledger_account_balances`), because a stored balance is a second source of
truth for a figure the lines already determine, and keeping the two in step
is work that buys nothing at this size.
