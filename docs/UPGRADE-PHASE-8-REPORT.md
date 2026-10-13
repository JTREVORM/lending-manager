# Platform upgrade, Phase 8 — the dashboard

Phase 8 of the plan in `PLATFORM-UPGRADE-PLAN.md`, and the plan's own note on
it was the brief: *"Last, not first: every card it shows is a query against a
module built above."*

How the dashboard works is in `REPORTING.md`. This is the evidence that the
figures it now shows are the ones the modules behind them hold.

---

## 1. No migration

Phase 8 adds **no schema change**, for the same reason Phase 7 did not: the
views were built in Phase 5 and this reads them. The live migration registry
is unchanged at `20261015000300`, and the trial balance is untouched — a
dashboard writes nothing, which is a rule Phase 7 set and
`tests/db/reporting-views.test.ts` still enforces by loading every reporting
view fifteen times and asserting the penalty table stays empty.

No new capability either. The three sections sit behind capabilities that
already existed: `reports:view_financial` with `delinquency:view`,
`recovery:view`, and the three approval capabilities taken one at a time.

## 2. What the dashboard did not know

It was written when the system ended at payments. Since then the book gained
aging and portfolio at risk, a recovery file with promises and follow-up
dates, money movements that wait for a decision, and a notification stream.
Every one of them was reachable only by opening the screen it lives on, which
means the page a person opens first told them nothing about any of it — a
collections officer saw today's sheet and not the promises they took last
week; an Owner saw the loan book and not what proportion of it was at risk.

Three sections now read them.

| Section | Reads | Behind |
| --- | --- | --- |
| Portfolio at risk | `portfolio_at_risk` | `reports:view_financial` + `delinquency:view` |
| Promises and follow-ups | `loan_recovery_status` | `recovery:view` |
| Awaiting a decision | `transfer_register`, `expense_register`, `reconciliation_register`, counted | each approval capability, separately |

Each follows the rule the rest of the page already followed: a caller without
the capability never triggers the query, so the figure is absent from the
markup rather than hidden in it. The browser suite asserts that on the
response body, not on the rendered page — a presentation decision becomes a
leak the moment somebody reads the HTML.

## 3. One ratio, not five

Phase 5 computes PAR at 1, 7, 30, 60 and 90 days, and Debt & Security shows
all five. Five ratios on a dashboard is a table, and a reader who has to
compare five numbers to form an impression has not been given one. PAR 30 is
the figure: past the point where a late payment is a slow week rather than a
missed collection, and the one a lender would be asked for. The other four are
one click away and the card says so.

The denominator is on the card, because a percentage on its own invites a
reader to compare it with a figure computed some other way. The definition
rules out the two substitutions that quietly break PAR — using *total*
outstanding, which includes interest not yet earned, and using the arrears
figure, which is a fraction of the exposure rather than the exposure.

An empty book renders a dash, not `0.0%`. A business with no active loans is
not a business in perfect health.

## 4. Two defects, both caught by a test

Both were counts that looked entirely plausible and meant something other than
their label — the same shape as the guarantor-cover defect in Phase 7, and
found the same way: by reconciling against the base tables instead of trusting
the figure.

### A promise paid late does not un-break it

The first version of the card said a later payment "reverses the verdict,
because the verdict is derived rather than recorded". The second half is true
and the first is not. Phase 5's view counts the payments received between the
action date and the **promised** date:

```sql
WHEN (... lp.status = 'posted'
      AND payment_business_date(lp.received_at) >= ra.action_date
      AND payment_business_date(lp.received_at) <= ra.promised_on)
     >= ra.promised_amount THEN 'kept'
WHEN ra.promised_on >= CURRENT_DATE THEN 'pending'
ELSE 'broken'
```

So a borrower who said Monday and paid Thursday settled the loan and still
broke the promise — which is the right rule. The verdict is about whether the
undertaking was met, not about whether the debt was eventually paid; the
loan's own balance already answers the second question, and a promise that
could be retroactively kept would be worth nothing to record.

A card claiming otherwise would have taught staff the wrong thing about their
own figures. `tests/db/dashboard-attention.test.ts` posts the late payment and
asserts the verdict stays `broken`, and posts an early one and asserts it
becomes `kept` with nothing written anywhere;
`tests/integration/dashboard-phase17.test.tsx` asserts the card's wording no
longer claims the reversal.

### "Loans in recovery" was every loan

The recovery card's denominator was the number of rows
`loan_recovery_status` returns. That view's `WHERE` is:

```sql
WHERE l.status = ANY (ARRAY['active', 'grace_period', 'arrears', 'cleared'])
```

— every live or cleared loan, chased or not. On the live book that is **26
rows against 4 loans with an action on file**: the card would have said the
business was chasing twenty-six borrowers when it was chasing four, which is
six times over and in the direction that flatters.

The figure is now loans with `action_count > 0`. The test creates one chased
loan and one untouched one in the same case, so it does not depend on what
other tests left behind, and asserts the view returns both while only one has
an action.

## 5. Live verification

Project `fszgwemtgyrbhngajpzm`. No migration, so nothing was applied; the
registry still reads `20261015000300`. Every figure the three sections show
was read against the live dataset:

| Figure | Live value |
| --- | --- |
| PAR 30 | 275 bps — 2.75% |
| Principal at risk, 30 days | UGX 240,000 |
| Principal outstanding (the denominator) | UGX 8,738,693 |
| Loans in the 90+ bucket | 0 |
| Promises due today | 1 |
| Promises broken | 1 |
| Follow-ups overdue | 1 |
| Loans with something on file | 4, out of 26 rows in the view |
| Transfers / expenses / counts waiting | 0 / 0 / 0 |

2.75% reconciles: 240,000 ÷ 8,738,693 = 2.747%. The 90+ tile renders
"Nothing has gone this far" rather than a zero amount, and the approvals
section renders its one-line "Nothing is waiting" rather than three zero
tiles — a row of empty tiles reads as a section that failed to load.

**Noted for Phase 9.** The live dataset has no transfer, expense or cash count
waiting, so the approvals section never shows a figure. That is honest for the
data as it stands and poor as a demonstration; enriching it is Phase 9's work,
not a reason to fake a count here.

## 6. Verification

| Suite | Result |
| --- | --- |
| `tsc --noEmit` | clean |
| `eslint .` | clean |
| `prettier --check` | clean |
| Unit + integration | **2,100 passed**, 64 files |
| Database (real PostgreSQL) | **1,264 passed**, 47 files |
| `next build` | succeeds |
| Browser (Playwright, desktop + mobile) | **474 passed**, 15 skipped, 24.2m |

New tests: 18 integration (`tests/integration/dashboard-phase17.test.tsx`) on
the three sections' figures, empty states, links and wording; 9 database
(`tests/db/dashboard-attention.test.ts`) reconciling the derived counts
against the base tables; and a browser spec (`tests/e2e/specs/dashboard.spec.ts`)
on what each role is shown and, for the Secretary/Treasurer, what is absent
from the HTML rather than hidden in it.

## 7. Commit

`cbd9bff`, on `claude/epic-mendel-rpimtt`.
