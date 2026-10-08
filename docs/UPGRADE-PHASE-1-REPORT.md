# Platform upgrade, Phase 1 — branches and the financial ledger

The foundation phase of the plan in `PLATFORM-UPGRADE-PLAN.md`, delivered in
two halves: **1a** created the structure, **1b** derived the existing demo
history into it and made the live money functions post.

How the module works is in `LEDGER.md`. This is the evidence that it was
applied, that it balances, and that nothing already working was broken.

---

## 1. Migrations added

| Migration | What it does |
| --- | --- |
| `20261010000100_branches_and_ledger.sql` | `branches`, `ledger_accounts`, `journal_entries`, `journal_lines`; the deferred balance rule; append-only triggers; `ledger_account_balances`, `branch_cash_position`, `trial_balance`; five capabilities; RLS. |
| `20261010000200_ledger_backfill.sql` | Head Office and the chart of accounts; `clients.branch_id` / `loans.branch_id` with their stamping triggers; `bank` added to the payment-method constraint; `post_journal` and the three event posting functions; `backfill_ledger_history()`, and the call that runs it. |
| `20261010000300_ledger_posting.sql` | `disburse_loan`, `post_payment` and `reverse_payment` re-emitted with one `perform public.post_*_journal(...)` each. `post_payment`'s own method whitelist widened to include `bank`. |
| `20261010000400_bank_payment_method.sql` | `dashboard_collection_summary` gains `bank_received`, so the method split sums to its own total. |

Three files rather than one so the structure can be reviewed, and reverted,
without touching a function that handles real money. The fourth closes a gap
the second one opened.

## 2. Live migration result

All four applied to the demo project `fszgwemtgyrbhngajpzm`, taking it from 58
migrations to 62. No errors, no retries, no manual repair.

**Pre-flight, before anything was applied:**

- Live was at `20261009000200`, 28 tables, 12 views, 77 functions, 47
  permissions, 0 disabled triggers, 0 invalid constraints, RLS on every table
  — identical to the branch's pre-Phase-10 state, so the live schema did not
  differ unexpectedly from the branch.
- `pg_get_functiondef` for `disburse_loan`, `post_payment` and
  `reverse_payment` was hashed live and against a scratch database built from
  the first 58 migrations alone. All three matched to the byte, which is what
  made it safe to replace them with text generated from the local copies.
- **No real customer data.** All 28 clients sit inside the synthetic
  `+2567…` / `+2563…` demo phone blocks. Three profiles exist: two synthetic
  staff accounts and the owner's own account. Nothing here is a real
  borrower's record.

**After:** the live schema was compared object-for-object against a local
database built from all 62 migrations — 690 columns, 339 constraints, 119
indexes, 88 triggers, 50 policies, 15 views, RLS on 32 tables, 91 functions.
Counts matched exactly in every category, and so did the digests of columns,
constraints, policies, RLS, triggers and views. Two categories differed and
both were run to ground:

- **Function bodies** differ only in `--` comment lines. Earlier sessions
  applied comment-stripped SQL through the Supabase MCP, as this one did for
  migrations `…100` and `…200`. Normalising comments away, all 91 functions
  and all 119 indexes hash identically on both sides (210 objects,
  `3a9807818bdf5d9016ce431ec5e9476c` on each).
- **Trigram indexes** read `extensions.gin_trgm_ops` locally and
  `gin_trgm_ops` live — where `pg_trgm` is installed, not a schema
  difference.

**No backup or recovery point could be taken.** The environment's network
policy denies `api.supabase.com`, `db.<ref>.supabase.co:5432` and both
poolers, so `supabase link`, `pg_dump` and `supabase db dump` are all
unreachable; the MCP is the only live channel and it exposes no snapshot
operation. This was judged acceptable because the dataset is wholly
synthetic and reproducible from `tests/e2e/harness/seed.mjs`, and because
every statement applied was either additive or a `create or replace` of a
function whose previous text had been hashed first. It would not be
acceptable against real borrower records. To allow a dump in future, add
those hosts under the environment's **Network access** setting.

## 3. Historical journals created, by type

| Source | Entries | Lines |
| --- | --- | --- |
| `opening_balance` | 1 | 2 |
| `loan_disbursement` | 26 | 52 |
| `loan_repayment` | 469 | 1,408 |
| `payment_reversal` | 1 | 3 |
| **Total** | **497** | **1,465** |

26 is every disbursed loan, 469 every payment, 1 every reversed payment. No
event was posted twice, and no event was missed — each is asserted separately
in §10.

## 4. Capital Introduced, and how it was derived

**UGX 21,449,163**, dated **2025-12-11**, entry `JV2600001`: Dr Cash at Hand,
Cr Owner Capital.

Derived, not chosen. Replaying every disbursement and every cash movement in
timestamp order, the running Cash at Hand balance reaches its lowest point at
**−21,449,163**. The opening entry is exactly that deficit, dated the day
before the first disbursement (2025-12-12 09:00 UTC).

The proof that it is the *minimum*: replaying the posted ledger, Cash at Hand's
lowest point is now **0** and it is never negative. One shilling less and the
account would go overdrawn; a rounder, larger figure would have made the
dashboard look better and the number arbitrary.

MTN and Airtel never go negative at any point in the history, and the bank
account has no historical movement, so none of the three carries an opening
entry.

## 5. Closing cash balances

| Account | Balance |
| --- | --- |
| `1010-BR2601` Cash at Hand — Head Office | 1,846,418 |
| `1020-BR2601` MTN Mobile Money — Head Office | 10,974,067 |
| `1030-BR2601` Airtel Money — Head Office | 4,115,545 |
| `1040-BR2601` Cash at Bank — Head Office | 0 |
| **Total liquidity** | **16,936,030** |

## 6. Loans Receivable

**8,978,697.** Debits 26,600,000 (26,500,000 disbursed + 100,000 put back by
the reversal), credits 17,621,303.

## 7. Interest Income

**4,448,123.** Credits 4,478,123, less the 30,000 withdrawn by the reversal's
contra entry.

## 8. Penalty Income

**17,441.** No contra; the reversed payment covered no penalty.

## 9. Trial balance

**Debits 70,196,030 · Credits 70,196,030.** Equal to the shilling.

## 10. Reconciliation

Every check below was run against the live database after the backfill. Each
compares the ledger against the source records that produced it, not against
another ledger figure.

| # | Check | Expected | Actual | |
| --- | --- | --- | --- | --- |
| 1 | Journal entries unbalanced or single-sided | 0 | 0 | ✓ |
| 2 | Trial balance: debits = credits | 70,196,030 | 70,196,030 | ✓ |
| 3 | Loans Receivable = `dashboard_portfolio_summary.principal_outstanding` | 8,978,697 | 8,978,697 | ✓ |
| 4 | Posted payments = posted allocations | 21,986,867 | 21,986,867 | ✓ |
| 5 | Loans Receivable disbursement debits = total disbursed | 26,500,000 | 26,500,000 | ✓ |
| 6 | Interest Income = posted interest allocations | 4,448,123 | 4,448,123 | ✓ |
| 7 | Penalty Income = posted penalty allocations | 17,441 | 17,441 | ✓ |
| 8 | Assets = equity + income | 25,914,727 | 25,914,727 | ✓ |
| 9 | Cash at Hand = capital − disbursements + cash in − cash reversed | 1,846,418 | 1,846,418 | ✓ |
| 10 | MTN = payments in − reversed | 10,974,067 | 10,974,067 | ✓ |
| 11 | Airtel = payments in − reversed | 4,115,545 | 4,115,545 | ✓ |
| 12 | Bank = payments in | 0 | 0 | ✓ |
| 13 | `branch_cash_position` = the four ledger balances | each | each | ✓ |
| 14 | Moments at which Cash at Hand is negative | 0 | 0 | ✓ |
| 15 | Lowest point Cash at Hand reaches | 0 | 0 | ✓ |
| 16 | Clients without a branch | 0 | 0 | ✓ |
| 17 | Loans without a branch | 0 | 0 | ✓ |
| 18 | Disbursed loans without a journal | 0 | 0 | ✓ |
| 19 | Payments without a journal | 0 | 0 | ✓ |
| 20 | Reversed payments without a contra | 0 | 0 | ✓ |
| 21 | Duplicate journals for one source event | 0 | 0 | ✓ |
| 22 | Contra entry mirrors its original, leg for leg | exact | exact | ✓ |
| 23 | Original stamped `reversed_by_entry_id` | 1 of 1 | 1 of 1 | ✓ |
| 24 | `dashboard_collection_summary` method split = `collected_today` | 519,086 | 519,086 | ✓ |

**One line needed investigating and was not a mismatch.** The first run of
check 5 compared *all* of Loans Receivable's debits against total
disbursements and read 26,600,000 against 26,500,000. Decomposing the account
by source showed the extra 100,000 is the reversal's "principal put back" leg,
which must be there — so the check was wrong, not the ledger, and is now
stated against disbursement-sourced debits. Nothing in the data was changed to
make it pass.

**Dashboard figures against their source records.**
`dashboard_portfolio_summary` reports `principal_disbursed` 26,500,000,
`principal_collected` 17,521,303, `interest_collected` 4,448,123,
`penalty_collected` 17,441, `principal_outstanding` 8,978,697 and
`posted_payment_total` 21,986,867. Each agrees with the ledger once the contra
entry is netted — `principal_collected` is the ledger's 17,621,303 of
repayment credits less the 100,000 reversed, and `interest_collected` the
4,478,123 less 30,000. The dashboard counts only posted payments; the ledger
holds the reversal as an event, which is the difference, and it is the one
the accounting model intends.

## 11. Test results

| Suite | Passed | Failed | Skipped |
| --- | --- | --- | --- |
| Unit / integration | 1,716 | 0 | 0 |
| Database (real PostgreSQL, all 62 migrations from an empty database) | 1,088 | 0 | 0 |
| Browser / Playwright (production build, fresh seed, real PostgreSQL + PostgREST + auth shim) | 344 | 0 | 15 |
| **Total** | **3,148** | **0** | **15** |

Phase 1 added **32 database tests** (18 in `ledger.test.ts`, 14 in
`ledger-posting.test.ts`), **3 unit/integration tests** and **1 browser
test**, and extended the existing payment-vocabulary, dashboard-labelling,
reporting-metric and method-split assertions for the fourth method. Also:
typecheck ✓, lint ✓, format ✓, money audit ✓ (58 financial files, no hazard).

The 15 skipped browser tests are the suite's seven existing conditional skips
— viewport-scoped navigation and portal tests that run in one Playwright
project and skip in the other, one CSV test for a report with no rows in the
seeded data, and two security tests that skip without a configured Supabase
URL — each with an in-code reason, counted across both projects. None is new
and none hides a defect.

The harness seed reconciles too: it posts through the same functions and
reports `trial balance: 15265921 both sides`, with the balance asserted inside
the seed so a future change that unbalances the ledger fails the seed rather
than the suite.

The nine areas Phase 1b was required to cover are each tested:

| Required | Where |
| --- | --- |
| Atomic disbursement + journal | `ledger-posting.test.ts` — deactivates the Cash at Hand account, asserts the loan stays `approved` |
| Atomic payment + journal | same, for `post_payment`; the payment row does not exist afterwards |
| Atomic reversal + contra journal | same, for `reverse_payment`; the payment stays `posted` |
| Penalty accounting | asserts charging a penalty posts nothing, and that the penalty reaches income through the repayment that settles it |
| Bank payment method | lands in the bank account; demands a reference; reaches the dashboard split; an unknown method is still refused |
| Backfill idempotency | `backfill_ledger_history()` run twice creates no second journal |
| Branch / account reconciliation | `branch_cash_position` against the ledger, and both against the payment records |
| Trial balance | debits = credits after every scenario |
| No duplicate backfill journals | the unique index refused directly, not merely the function's own guard |

### The `schema.test.ts` flake, fixed rather than masked

One assertion — "the seed writes no `settings.updated` or `user.role_granted`
audit row" — was order-dependent, because `createTestUser` grants a role and
therefore writes exactly such a row. Whether it passed depended on whether
another file's fixtures had run and torn down yet.

The claim was always about the seed, so the measurement now matches it: the
global setup reads `max(id)` from `audit_log` immediately after the rebuild —
the moment before any test has run — and publishes it to the suite through
Vitest's `provide`/`inject`. The assertion counts rows at or below that
boundary. Nothing was weakened: the same rows are still forbidden, over
exactly the era the claim is about. The database suite has since run green
four times in a row.

## 12. Production build

`next build` — compiled successfully, TypeScript check passed, all routes
emitted.

## 13. Commit

See the branch's final commit on `claude/eager-keller-jhxehu`.

---

## Instructions followed, and not exceeded

The brief's prohibitions, each held:

- **No demo loan or payment deleted.** Row counts before and after are
  identical: 28 clients, 33 loans, 469 payments.
- **No historical business event rewritten.** Every journal carries the
  original `disbursed_at` / `received_at` / `reversed_at` as its `posted_at`
  and the business date of that instant as its `entry_date`. No source record
  was edited; the only writes to existing tables were the two new
  `branch_id` columns.
- **No ledger constraint weakened, no RLS disabled, no trigger left
  disabled.** 0 disabled triggers and 0 invalid constraints live, RLS on all
  32 tables, and the `loan_payments` method constraint was widened to admit a
  fourth value rather than dropped.
- **No posted journal edited after creation.** The only update the schema
  permits on an entry is stamping its contra, which the guard trigger
  enforces.
- **No financial activity invented.** The 497 journals correspond one-to-one
  to events already recorded, plus the single derived opening entry. No
  payment, loan, transfer or expense was created to make a figure look
  better — including the Bank account, which closes at zero because no bank
  transfer has ever been recorded.

One thing was added beyond the literal list, and is flagged as such: the brief
asked for Bank "as a supported payment method with validation and tests",
which the database accepted after `…200` but the application did not offer.
Phase 1 therefore also added Bank to the payment form (labelled *Transfer
reference*, from the statement rather than from a network), to the collections
report and its CSV, to the dashboard's method split, and to
`dashboard_collection_summary` — because a method the database accepts and the
dashboard cannot count is a split that does not sum to its own total.
