# Phase 20 — the dashboard's fan-out, and the zeroes it showed

Phase 19 established why the dashboard's queries were cancelled with
PostgreSQL `57014` and stopped the failures being rendered as business
figures. It deliberately left two things for a decision: **reducing the
concurrency**, and **a retry affordance**. This does both, and measures them.

| | |
| --- | --- |
| Branch | `claude/phase20-dashboard-concurrency`, on top of Phase 19 |
| Production changed | **nothing** — no schema change, no data change, no deployment |
| Verification | 2,196 unit/integration · 1,328 database · 498 browser · three roles with real sessions |

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

Phase 19 removed the clearest case — three separate reads of
`loan_portfolio_report` for the three lifecycle cards, each paying for a scan
of the whole book — but did it with a capped, unordered read that was not
correct past the cap. §4.1 has the correction: the selection now happens in the
database, against stored columns, and costs about 12,100 buffers against the
63,000+ those three ordered reads cost.

What remains is four views that each independently aggregate the whole book:
`dashboard_portfolio_summary`, `dashboard_collection_summary`,
`collections_today` and `portfolio_at_risk`. They overlap — two of them
re-derive today's collections, two re-derive the live book — but collapsing
them means a new combined view, which is a migration and a change to how
financial figures are derived. That is not a "smallest reliable change" and
it is not something to do without approval, so it is left as §6.

## 4.1 The capped read was wrong, and is gone

An independent review caught a correctness bug in the Phase 19 change before
it shipped. `listRecentLoanActivity` read

```ts
.limit(ACTIVITY_SCAN_CAP)   // 2000, with no order by
```

and sorted the rows in JavaScript. **Without `order by`, PostgreSQL returns
whichever rows it finds first**, so the cap took an arbitrary 2,000 of them.
Past the cap the "most recent" lists were ranked within an arbitrary subset: a
loan disbursed today could be absent while one from last year was shown. The
three queries it replaced ordered *server-side* and were correct at any size,
so the optimisation had traded correctness for speed — and the comment I wrote
claiming the capped window was equivalent to what those queries would have
ranked within was simply wrong.

### What it does now

Each card's rows are **selected and ordered by the database**, from a source
where the ordering column is *stored* rather than computed by a view, so the
work is bounded by the limit rather than by the size of the book:

| Card | Source | Column |
| --- | --- | --- |
| Recently paid out | `loans` | `disbursed_at` |
| Recently settled | `loans` | `cleared_at` |
| Recently charged | `loan_penalties` | `effective_date` (indexed) |

Those yield at most `3 × limit` loan ids. One further read of
`loan_portfolio_report`, filtered to exactly those ids, supplies the figures
the cards display — and a `loan_id` filter is the one thing that view can push
down, which is what Phase 18's delinquency rewrite was for. The in-memory step
is now only putting twelve rows the database already chose back into the order
it returned the ids in; it no longer decides *which* rows are recent.

Row Level Security applies to `loans` and `loan_penalties` exactly as it does
to the view, so a caller only ever selects among loans their policies admit — a
borrower cannot learn that a loan they cannot see was disbursed today. The
enrichment read re-applies them, and an id with no row is dropped rather than
filled in.

### Why the charge date moved to `loan_penalties`

The view carries two penalty dates: `penalty_effective_date`, derived as
`final_due_date + grace_period_days_applied + 1` for every loan whether charged
or not, and `penalty_applied_effective_date`, the recorded charge's own date.
The card was ordered on the derived one, which cannot be indexed.

For a loan that actually carries a charge the two are the same date — the
penalty row's `effective_date` is the day after its `grace_end_date`, which is
the same arithmetic. Verified on production: all five recorded penalties agree,
and `effective_date = grace_end_date + 1` in every one. A database test pins
that agreement, so a future divergence fails a test rather than quietly
changing which loans the card lists.

### Cost, on production

| Statement | Buffers | Time |
| --- | --- | --- |
| `loans` by `disbursed_at`, limit 4 | 436 | 12.5 ms |
| `loans` by `cleared_at`, limit 4 | ~436 | ~12 ms |
| `loan_penalties` by `effective_date`, limit 40 | 525 | 4.2 ms |
| `loan_portfolio_report` filtered to 4 ids | 10,682 | 83.3 ms |
| **all three cards** | **≈ 12,100** | **≈ 112 ms** |

Against the three ordered view reads this replaces, which production's
`pg_stat_statements` puts at **20,759–194,125 buffer hits each** — so roughly
63,000 at best and far more at worst. The new shape is cheaper than Phase 19's
single scan as well, and unlike it, correct at any size.

Two honest qualifications. The enrichment read is **about half a full view
scan**, not a trivial one: the `loan_id` filter pushes down, but only partly.
And `loans` has no index on `disbursed_at`/`cleared_at`, so that selection is
a sequential scan with a top-N heapsort — 26 rows on today's book, and cheap,
but it would want an index on a large one. That is a migration, so it is noted
here rather than taken.

### Regression coverage

`tests/db/recent-activity-selection.test.ts` builds a book of **2,100 loans**,
larger than the old cap, with the newest activity deliberately **outside the
window an unordered read returns** — inserted last, so it sits at the end of
the heap. It asserts that an unordered capped read **misses** it (the defect,
reproduced) and that an ordered, limited read **finds** it, reading a bounded
number of rows. It also pins the charge-date equivalence above.

`tests/unit/dashboard-read-failures.test.ts` asserts the reader's query shape
directly: every selection carries a descending `order` and a bounded `limit`,
the ordering columns are the stored ones, and the whole-book view is read at
most once. A refactor that drops an `order` fails there.

A note on what was tried and discarded: a performance assertion inside the
2,100-loan test compared the capped scan against the bounded selection and
measured the capped scan as *cheaper* (84 buffers against 186). That figure is
meaningless — those fixture loans carry no schedules, so `loan_portfolio_report`
barely returns them and there was no book for the capped read to scan. It was
removed rather than tuned into looking right; the production figures above are
the measurement that means something.

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

### 5.2 Test results

| Suite | Result |
| --- | --- |
| `tsc --noEmit`, `eslint`, `prettier --check` | clean |
| Unit + integration | **2,196 passed** |
| Database, migrations applied from zero | **1,328 passed** (5 new, incl. the 2,100-loan selection test) |
| Browser, production build, fresh seed | **498 passed, 27 skipped, 0 failed** |
| Production build | succeeds |

Two environment faults were hit on the way to that figure, both mine and both
worth recording because each produced a misleading red.

The first: the seed rewrites `tests/e2e/harness/fixtures.json` with fresh ids
on every run, and that file was held back from the fix commit while the
database had been reseeded. The specs address clients and loans *by id* from
it, so thirty-two of them failed pointing at rows that no longer existed. The
file and the database have to move together, which is why it is committed.

The second: `scripts/pg-local.sh migrate` drops and recreates the database,
and the auth shim holds one long-lived `pg.Client` that does not reconnect. It
crashed with `ProcessInterrupts`, and the suite then failed all four
`auth.setup.ts` sign-ins with 519 specs never running — **the exact shape of
the CI symptom Phase 19 diagnosed, from an unrelated cause.** Phase 19's
`verify.mjs` catches precisely this, and would have caught it at startup had
the stack been brought up with `stack.sh up` rather than by starting the
services by hand. After a proper restart it reported the shim's TLS valid,
PostgREST reachable and the seeded owner able to sign in, and the suite went
green.

Two harness fragilities that exposes, neither changed here because neither
affects production and the instruction was to prioritise the dashboard:

1. Nothing asserts that the committed manifest matches the seeded database.
   One id existence check in `verify.mjs` would cover it.
2. The shim dies permanently when its connection drops rather than
   reconnecting. Invisible in CI, where nothing reseeds mid-run.

### 5.3 Financial figures unchanged

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
