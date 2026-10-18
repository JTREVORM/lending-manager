# Phase 20 — the dashboard's fan-out, and the zeroes it showed

Phase 19 established why the dashboard's queries were cancelled with
PostgreSQL `57014` and stopped the failures being rendered as business
figures. It deliberately left two things for a decision: **reducing the
concurrency**, and **a retry affordance**. This does both, and measures them.

| | |
| --- | --- |
| Branch | `claude/phase20-dashboard-concurrency`, on top of Phase 19 |
| Production changed | **nothing** — no schema change, no data change, no deployment |
| Verification | 2,193 unit/integration · 1,323 database · browser suite · three roles with real sessions |

---

## 1. What production was actually showing

Two symptoms, both traced to a line of code.

**"Figures unavailable — The portfolio figures could not be read just now."**
is the deployed build's `summaryUnavailable` string in `app/(app)/page.tsx`.
It fires when `getPortfolioSummary()` returns `null`, which is what it does on
a cancelled query. That part was working as designed.

**"Live Book: 0"** is `components/dashboard/risk-headline.tsx`, whose
`StatCard` renders `value={String(slice.loanCount)}`. The slice comes from
`getPortfolioAtRisk()`, and in the deployed build
`lib/data/security.ts:915` answers a failed read with

```ts
return { portfolio: EMPTY_PAR, byBranch: [], byProduct: [] };
```

`EMPTY_PAR` has a zero in every field. So a cancelled query did not merely
hide the risk panel — it drew it, with zeroes.

What the figures actually are in production, read directly:

| The card said | The truth |
| --- | --- |
| Live book: **0** loans | **17** loans |
| Principal: **UGX 0** | **UGX 8,738,693** |
| Arrears: **UGX 0** | **UGX 4,344,299** |

A 4.3-million-shilling arrears position displayed as nil, on the card whose
own caption calls itself "the denominator every ratio above divides by". That
is the single most serious thing in this investigation, and it is the one the
`getPortfolioAtRisk` change fixes.

## 2. Why queries that benchmark under 110 ms get cancelled

This was the question worth answering properly, and the answer is not
"the queries are slow".

Measured on the harness with PostgreSQL pinned to a single core — CPU as the
scarce resource, which is what the Free tier is — running the eleven reads an
Owner's dashboard issues, each worker reusing one connection the way
PostgREST's pool does:

| limit | slowest statement | sum of statement time | wall clock |
| --- | --- | --- | --- |
| **1** | 66 ms | **260 ms** | **260 ms** |
| **2** | 134 ms | 569 ms | 285 ms |
| 3 | 224 ms | 1,012 ms | 346 ms |
| 4 | 352 ms | 1,523 ms | 425 ms |
| 6 | 381 ms | 2,108 ms | 381 ms |
| 11 | 395 ms | 2,543 ms | 395 ms |

Three readings, none of them intuitive:

1. **Serial is the fastest.** Every level of concurrency finishes the page
   *later* than running the reads one at a time. At eleven the page is 52%
   slower than at one. When the database is the constraint, dividing one
   core's attention eleven ways does not create more of it.
2. **The slowest individual statement grows sixfold** — 66 ms to 395 ms,
   very nearly linearly in the limit.
3. **The database's own total work-time grows nearly tenfold** — 260 ms to
   2,543 ms — for exactly the same eleven results. That is contention, billed
   to an instance that is already the bottleneck.

Line 2 is the mechanism. `statement_timeout` judges each statement *on its
own*, and `authenticated` has eight seconds. The dashboard's reads are not
individually slow; they were made slow by being run together, and then
cancelled one at a time.

Production's own `pg_stat_statements` shows the same shape at scale: 1.6–4.9 s
mean per statement, maxima at 7,114 ms and 7,317 ms against the eight-second
budget, and `shared_blks_read = 0` on every one of them — **no disk I/O at
all**, so every millisecond of it is CPU contention.

So the eleven-way fan-out was costing latency, costing correctness, and
buying nothing.

### 2.1 A correction to my own first measurement

The first version of this probe opened a **fresh connection per query**, so
`set role` and `set_config` were being charged to statement time. That
inflated the contention figures (it reported 552 ms at eleven where the
corrected figure is 395 ms) and, more importantly, made the end-to-end page
comparison misleading. The table above is the corrected measurement, with a
warm pool. The direction and the mechanism did not change; the magnitudes did.

### 2.2 What the harness cannot show

The end-to-end page comparison on this harness is undramatic: the Owner's
dashboard goes from 286 ms median before to 254 ms after. That is because a
14-loan book on one modern core is only ~260 ms of database work in total, so
there is little contention to remove. Production has 2.5× the book on a
shared, throttled tier, which is where 260 ms becomes 2.5 s and the eightfold
headroom disappears.

The honest claim is therefore the statement-level one, which is measured on
the same database and matches production's `pg_stat_statements` shape:
**the worst statement drops from 6× its uncontended cost to 2×.** The page
getting slightly faster is a bonus, not the argument.

## 3. The changes

### 3.1 A ceiling on the fan-out

`lib/async/with-limit.ts` — `allWithLimit(tasks, limit)`: `Promise.all` with a
ceiling, preserving order and each task's own result type. The dashboard uses
`DASHBOARD_READ_LIMIT = 2`.

Two, not one, because the Free tier has about two vCPU: two keeps both busy
without oversubscribing either. The measurement puts it within 10% of serial
on wall clock (285 ms against 260 ms) while holding the worst statement to
twice its uncontended cost instead of six times. One would under-use a
provisioned instance; three already triples the worst statement.

The reads are ordered **critical first** — the portfolio and collection
summaries, the figures the page is read for — because with a ceiling the order
decides which reads get the quiet database.

Eight unit tests pin the properties that matter: the ceiling actually holds,
order is preserved (nine results are destructured positionally), tasks start
in order, the tuple types survive, and a non-positive limit throws rather
than hanging for ever.

### 3.2 A retry, not just a notice

`components/ui/retry-button.tsx` calls `router.refresh()`, which re-runs the
route's Server Components on the server. A link to the same route would not
do: the App Router would serve the payload it already has, which is the one
that failed. The button disables itself and says "Reading again…" while the
refresh is in flight, because these failures are timeouts and an inert-looking
button invites a second and third click — each one another set of queries on
the database that is already the constraint.

It appears in the dashboard's unavailable notice and on both of the recovery
screen's.

### 3.3 Deliberately not done: route-level streaming

Phase 18 found and reverted exactly that: `app/(app)/loading.tsx` made twelve
routes answer `200` where they must answer `404`, because streaming commits
the status before a page can call `notFound()`. Nothing here introduces a
route-level boundary, and the browser suite's status assertions still pass.

## 4. Do the expensive views repeat the same whole-book work?

Yes, and only partly fixably from the application.

Phase 19 removed the clearest case: the three lifecycle cards were three
separate reads of `loan_portfolio_report`, each paying for a scan of the whole
book because the ordering columns are computed by the view and PostgREST's
`order(...).limit(4)` cannot be answered from an index. One read now feeds all
three — 5,452 buffer hits to 1,791, and 38.7 ms to 10.0 ms.

What remains is four views that each independently aggregate the whole book:
`dashboard_portfolio_summary`, `dashboard_collection_summary`,
`collections_today` and `portfolio_at_risk`. They overlap — two of them
re-derive today's collections, two re-derive the live book — but collapsing
them means a new combined view, which is a migration and a change to how
financial figures are derived. That is not a "smallest reliable change" and
it is not something to do without approval, so it is left as §6.

## 5. Measured results

Harness, production build, real sessions, Postgres pinned to one core, nine
requests per role, median and worst:

| Role | Before (11-way) | After (limit 2) | HTTP | Failed-read notice |
| --- | --- | --- | --- | --- |
| Owner/Administrator | 286 ms / 521 ms | **254 ms / 521 ms** | 200 | none |
| Manager | 176 ms / 207 ms | **171 ms / 213 ms** | 200 | none |
| Secretary/Treasurer | 138 ms / 148 ms | **120 ms / 123 ms** | 200 | none |

Statement-level, which is what `statement_timeout` judges:

| | Before | After |
| --- | --- | --- |
| Slowest statement | 395 ms (6× uncontended) | **134 ms (2×)** |
| Database work-time for the page | 2,543 ms | **569 ms** |

### 5.1 The failure path, exercised

With a statement budget the heavy views cannot meet but the auth call can
(40 ms), PostgREST's pool recycled so the role setting takes effect:

```
status=200
  notice shown         : True
  sections named       : the portfolio summary, today's collection summary,
                         today's collection sheet, recent loan activity and
                         portfolio at risk
  retry button present : True
  Live book card drawn : False
```

Note that this is a **partial** failure: five sections were cancelled and the
rest rendered their real figures. Each unreadable section is named, none is
drawn, and no zero is invented. At a 2 ms budget even
`current_session_context()` is cancelled and the route redirects to `/login` —
failing closed, which is correct.

### 5.2 Financial figures unchanged

Production, read-only, against the Phase 18 baseline: clients 28, loans 35,
payments 470, allocations 522, penalties 5, journal entries 565, lines 1,603,
debit = credit = 88,499,530, allocations 22,416,867, penalties assessed
860,589, total outstanding 11,156,222, 88 RLS policies, 104 migrations.
**No figure differs.**

## 6. What still needs a decision

The four whole-book aggregates in §4 still cost 2.3–4.9 s each in production.
The ceiling stops them being cancelled and stops the page inventing figures
when they are, but it does not make them cheap. Dashboard wall-clock in
production will be roughly the *sum* of those reads rather than the maximum —
which, on the measured evidence, is what it effectively already was.

Three ways to close it, all yours to choose:

1. **More CPU.** `shared_blks_read = 0` and
   `max_parallel_workers_per_gather = 1` say this is CPU-bound on a shared
   tier. Smallest change, most likely to fix it outright.
2. **Pre-aggregated summaries** — materialised views refreshed on write, so a
   card reads a row instead of re-aggregating the book. A real design change
   with correctness obligations around refresh, and how these figures will
   have to work at scale.
3. **A longer `statement_timeout`.** Explicitly not done here: raising a
   timeout to hide slow queries was ruled out, and it would raise the ceiling
   for every other query too.

Caching these figures is not on the list. They are per-user, policy-filtered
financial aggregates, and a shared cache over them is exactly what must not
exist.

## 7. The wider audit

Every error branch in `lib/data` was classified. **28 return `null`** and
report failure honestly. **52 still return an empty list, an empty page object
or a zero** after a database error — the same defect class as
`getPortfolioAtRisk`, on other screens: `reports.ts` (4), `security.ts` (11),
`payments.ts` (6), `finance.ts` (8), `loan-application.ts` (5), `loans.ts`
(3), and others.

Every loader the dashboard reads is now in the honest set. The other 52 are
enumerated rather than changed, because the instruction was to fix the
dashboard before unrelated issues, and each one needs its screen's empty state
reconsidered rather than a blanket edit.

One is visible *on* the dashboard and deliberately unchanged:
`getNotificationSummary` returns `EMPTY_SUMMARY` on failure, so the shell's
bell shows no badge. The file documents that decision, a missing badge is not
a financial figure, and changing it would put an error state in the shell of
every screen. Flagged for a decision rather than altered.

## 8. Region: `dub1` or `bom1`

Still unresolved, and still not the cause. `vercel.json` and the deployment
metadata say `dub1`; four consecutive requests to `/login`, which genuinely
computes (`x-vercel-cache: MISS`), report compute in `dub1`; every dashboard
warning is logged `region=bom1`. Both readings fit all the evidence, and
settling it needs a request that both originates from this container *and*
emits a log line, which the application does not do on a successful render.

Phase 19 added `process.env.VERCEL_REGION` — which Vercel documents as the
authoritative in-process answer — to every one of these warnings, so the next
deployment settles it from the inside.

It cannot be the cause of `57014`: the eight seconds is consumed inside
PostgreSQL, and `statement_timeout` measures server-side execution. Network
distance between the function and the database adds round-trip time, not
statement execution time.
