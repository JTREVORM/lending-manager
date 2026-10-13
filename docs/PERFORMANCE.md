# Performance audit — Phase 18

What was slow, why, what changed, and what is measured rather than claimed.

Every figure here was taken on the end-to-end harness: real PostgreSQL 16
with all migrations applied from zero, the real PostgREST binary, the
production Next.js build, and the harness seed — `npm run e2e:up`. The
before and after runs used the same machine, the same seed shape (14 loans,
13 clients, 302 collections, 159 payments) and the same method, nine requests
per route after three warm-ups, reporting the median.

The hosted database carries 28 clients, 35 loans, 719 collections and 470
payments, so the seeded harness is the same order of magnitude as production.
Where a figure comes from a larger synthetic book it says so.

### On what was measured, and what that covers

The figures are server time for a full page request, replayed with a
signed-in session's cookies over plain HTTP: no browser, no paint. That is
deliberate, because it is where the problem was — the slowest screen spent
3.6 of its 3.7 seconds inside one SQL statement.

It also covers client-side navigation, which is the other thing the brief
asks about. Every route in this application is `force-dynamic`, so moving
between pages is a request to the server for that route's payload; its
latency is the server time measured here plus React reconciliation on an
already-loaded bundle. There is no separate client-side cost to find, and
nothing in this work changed the bundle: `tests/integration/bundle.test.ts`
and `tests/e2e/specs/performance.spec.ts` guard the chunks and the per-page
wire cost, and both still pass unchanged.

Warm figures are reported: three warm-ups, then nine measured requests. Cold
first-request times are in §3.2.

---

## 1. Confirmed root causes

Four in the code, and one operational. Each was measured, not inferred.

### 1.1 Authorization was re-decided for every row examined

Every Phase 2 policy is written against `public.user_has_permission(...)`,
which is right. The call was written bare:

```sql
using (public.user_has_permission('loans:view'))
```

A function call in a policy predicate is evaluated for **every candidate row
PostgreSQL considers**, not once per statement. The function is `STABLE`,
which permits caching within a statement but does not require it, and the
planner does not cache a call it evaluates as a qualifier.

Instrumented by shadowing the function with a counting version, one read of
`loan_workflow_register` — the query behind the loan register, returning
twenty-one rows from a book of **fourteen** loans:

```
user_has_permission invocations: 20,524
```

1,466 calls per row returned. Each one runs a join over `user_roles` and
`role_permissions` and resolves `current_profile_id()` against `profiles`.
The same read touched **245,004 shared buffers** — roughly 1.9 GB of buffer
traffic to return fourteen loans.

Isolating it by reading the same views as the table owner, where no policy
applies:

| view | owner (no RLS) | `authenticated` | ratio |
| --- | --- | --- | --- |
| `loan_workflow_register` | 15.8 ms | 3,210 ms | **203×** |
| `loan_aging` | 22.7 ms | 2,496 ms | **110×** |
| `collections_today` | 22.5 ms | 1,791 ms | **80×** |
| `loan_delinquency` | 24.1 ms | 502 ms | 21× |
| `portfolio_at_risk` | 25.8 ms | 316 ms | 12× |
| `payment_register` | 11.7 ms | 49.3 ms | 4× |

This is why the application felt slow everywhere at once rather than on one
screen: the overhead is per row *examined*, so it scaled with the size of the
book on every page that reads the book.

A second form of the same problem: `user_can_see_branch(branch_id)` takes the
row's own branch, so it is correlated and cannot be hoisted — and it is
`SECURITY DEFINER`, which means PostgreSQL will not inline it either. It
stayed a real function call per row, each one running two `EXISTS` queries
against `profiles`.

### 1.2 `loan_delinquency` recomputed the whole book, once per loan

The view was written with three CTEs — `today`, `bounds` and `cover`. A
non-recursive CTE referenced **more than once** is not inlined by PostgreSQL:
it is materialised, and a materialised CTE is an optimisation barrier.
`today` was referenced four times, which pinned it; `cover` referenced
`today`, which pinned `cover` too.

With `cover` materialised, `loan_id = <this loan>` could not be pushed into
it, so every reader computed the delinquency position of the entire book
whatever it had asked for. Worse, where the planner chose a nested loop over
the view — which is what `loan_workflow_register` does when the register asks
for one page — the whole materialised computation ran **once per loan row**:
302 collections scanned 14 times for a 21-row page. Quadratic in the size of
the book.

### 1.3 The penalty basis was an opaque per-loan function call

The view also called `public.loan_outstanding_as_of(l.id, grace_end)` from a
LATERAL, once per loan. That function is declared `set search_path = ''`, and
**PostgreSQL will not inline a function carrying a SET clause**. So it ran as
an opaque call: its cost never appeared in `EXPLAIN (ANALYZE, BUFFERS)` at
all, and each invocation paid row-level security on `loan_installments` and
`payment_allocations` over again.

Measured directly, on a synthetic book of 1,370 disbursed loans:

```sql
select sum(public.loan_outstanding_as_of(l.id, current_date))
  from public.loans l where l.disbursed_at is not null;
-- 4,467 ms
```

The single largest term in the view, and invisible to the plan.

### 1.4 `loan_installment_coverage` aggregated everything to answer anything

`loan_installment_coverage` is the base of all derived reads —
`loan_balances`, `loan_delinquency` and `loan_obligations` are built from it,
so the register, the collection sheet, the statement, the aging report and
the dashboard all reach it. It was a LEFT JOIN onto a whole-table aggregate
grouped by `installment_id`.

Two properties of that shape defeat a narrow read: the aggregate does not
group by `loan_id`, so a loan filter is not a grouping key; and it is the
nullable side of an outer join, into which PostgreSQL will not push a
qualifier at all.

On 2,014 loans with 40,929 payments, opening **one** loan aggregated every
posted allocation in the database — `GroupAggregate` over 38,096 rows,
514,603 buffer hits, to answer a question about thirty collections:

| read | before |
| --- | --- |
| `loan_delinquency` for one loan | 6,918 ms |
| `loan_workflow_register` for one loan | 7,480 ms |

### 1.5 And one that is operational, not code

A database built by applying the migrations from zero has **no planner
statistics** until autovacuum's analyse worker runs. For flat tables that
costs nothing; for views stacked four deep each wrong row estimate is
multiplied by the one above it. On the fourteen-loan harness, as
`authenticated`:

| read | no statistics | after `analyze` |
| --- | --- | --- |
| `dashboard_portfolio_summary` | 1,981 ms | 80 ms |
| `collections_today` | 1,373 ms | 79 ms |
| `loan_portfolio_report` | 320 ms | 88 ms |

Twenty-five times, on fourteen loans, from statistics alone. The window is
every fresh deployment, every restore, every CI run — and "autoanalyse gets
there eventually" means after somebody has already concluded the system is
slow.

### 1.6 Known concerns from the brief, checked

| concern | finding |
| --- | --- |
| Repeated `getClaims()` in the proxy and the auth context | **Confirmed, and worse than it looks.** `getClaims()` is a local signature check only for a project signing with an *asymmetric* key. This project's tokens are HS256, and for a symmetric algorithm `getClaims()` falls back to `getUser(token)` — an HTTP call to the Auth service. Two per request. |
| Sequential profile and role queries | **Confirmed.** `getClaims()` → `profiles` → `user_roles`, strictly serial because each needs the one before. Three round trips before a page began to render. |
| Heavy dashboard views and concurrent queries | **Partly.** The eleven dashboard queries are already `Promise.all`-ed and already skipped per capability. The weight was in the views themselves (§1.1–1.4), not in the fan-out. |
| Shell-level branding and notification reads | **Confirmed.** `getCompanyBranding()` was called by the shell *and* by nearly every page, unmemoised — two identical `company_settings` selects per render. Same for `getNotificationSummary()` on `/notifications`. |
| Prefetch disabled on sidebar destinations | **Confirmed, and it is still the right call.** Prefetching a dynamic route with no loading boundary makes Next.js render it server-side, so twelve rail entries would mean twelve server renders per page view. The opt-outs stay; what changed is that the destinations they guard are now 20–28× cheaper when somebody actually clicks. See §2.3. |
| Region mismatch | **Confirmed.** See §5. |

---

## 2. What changed

### 2.1 Database

| migration | what it does |
| --- | --- |
| `20261018000100_rls_predicate_hoisting` | Wraps the constant-argument helper calls in 81 policies in scalar subqueries, so PostgreSQL plans them as InitPlans evaluated once per statement. Restates the branch check with the caller's own branch hoisted, via a new `current_user_branch_id()`. |
| `20261018000200_delinquency_pushdown` | Replaces `loan_delinquency`'s three CTEs with a scalar subquery and two grouped subqueries, and computes the penalty basis in the open instead of through the opaque function. |
| `20261018000300_session_context` | Adds `current_session_context()`, which returns the caller's active profile, their role keys and a failure reason in one row. |
| `20261018000400_installment_coverage_pushdown` | Turns `loan_installment_coverage`'s allocation aggregate into a LATERAL correlated on the installment. |

Each migration's own header carries the full reasoning, the measurements and
the equivalence argument.

**Nothing was weakened.** The hoisting changes *when* a predicate is
evaluated, not what it returns: the same function, the same boolean, for the
same caller on the same row. Proved two ways —

- `tests/db/rls-hoisting.test.ts` asserts the hoisted form is present
  everywhere (so a later policy cannot silently reintroduce the per-row
  form), proves the restated branch predicate agrees with
  `user_can_see_branch` over every combination of caller-branch and
  row-branch, and proves a capability denial still denies.
- A visibility matrix — row counts for every RLS-protected table and every
  view, for each of the six seeded accounts plus `anon`, 574 probes — was
  captured before and after the rewrite. **Identical**, including all 100
  denials.
- The rewrite was also round-tripped. Every policy expression was read back
  out of `pg_policies` after the migration, the three transformations were
  mechanically undone, and the result compared against the catalogue's
  rendering of the originals: **176 expressions across all 88 policies,
  zero differences.** The predicates are the same predicates; only the point
  at which PostgreSQL evaluates them moved.

**No figure moved.** `loan_delinquency`'s full output was compared row by row
and column by column before and after (identical at 14 loans and at 1,370),
and `loan_installment_coverage`'s across all 41,072 rows. `loan_outstanding_as_of`
itself is untouched — it is still what `ensure_penalty_applied` charges from —
and `delinquency-parity.test.ts` already asserts every recorded penalty's
basis equals what that function returns.

### 2.2 Application

- **One auth round trip instead of three.** `lib/auth/context.ts` now calls
  `current_session_context()`. The token is still verified twice: the proxy
  calls `getClaims()` on every request (it has to — that call is what
  refreshes an expiring session and writes cookies a Server Component
  cannot), and PostgREST checks the signature and rejects an expired `exp`
  before `auth.uid()` has any value, so a row coming back is itself proof the
  token was well-formed, correctly signed and unexpired. What was removed is
  the *third* verification of the same token in the same request.
  `getSession()` is still never trusted, and no request header is either.
- **Request-scoped memoisation** on `getCompanyBranding`,
  `getPortalBranding`, `getDocumentBranding` and `getNotificationSummary`,
  via React's `cache`. The shell renders the company's name in the sidebar
  and again in the header, and almost every page then reads the same row for
  its own letterhead, timezone or currency — so a single dashboard render
  issued two identical `company_settings` selects, and `/notifications`
  issued two identical summary reads.

  This is not a cache in the sense the brief warns about: React discards it
  when the render finishes, it is never shared between requests or between
  users, and each read still goes through the caller's own Supabase client,
  so Row Level Security decides what comes back exactly as before.
- **The portal stopped reading a table it cannot see.**
  `app/(portal)/portal/page.tsx` read `getCompanyBranding()` for a timezone.
  `company_settings` is behind `settings:view`, which a borrower does not
  hold — so that query was filtered to nothing on every portal load, logged a
  spurious "row 1 is missing" warning, and fell back to
  `config/defaults.ts`, meaning the page used the *configured default*
  timezone while the shell above it showed the real one. It now reads
  `getPortalBranding()`, the `company_identity` view Phase 12 published for
  exactly this audience.
- **The harness seed collects statistics**, and `docs/BACKUP-RESTORE.md` now
  says to `analyze` after a restore (§1.5).

### 2.3 Tried, measured, and reverted

**Route-level loading boundaries and streaming.** The brief asks for these,
and they were implemented: `app/(app)/loading.tsx` and
`app/(portal)/loading.tsx` with a shaped skeleton. They worked — first byte
dropped to 25–105 ms across the application, because the shell and the
sidebar flushed while the page's queries ran.

They were reverted, because they break HTTP status codes. A loading boundary
makes Next.js flush the response shell immediately, which commits the status
before the page has read anything. A page that then calls `notFound()` — a
loan that does not exist, or one the reader may not see — has already sent
`200 OK`. Measured with the boundary in place:

```
status=200  /loans/00000000-0000-0000-0000-000000000000
status=200  /clients/00000000-0000-0000-0000-000000000000
status=200  /users/00000000-0000-0000-0000-000000000000
```

Twelve routes call `notFound()`. This is not a new discovery: the project hit
it before, removed its root `loading.tsx` for exactly this reason, and moved
the feedback into the control that was pressed — see
`components/ui/link-pending.tsx` and the test in `app-shell.spec.ts` that
pins the status codes. That reasoning is better than the change, and it holds
for the second reason it gives too: blanking a working screen is worse
feedback than marking the link somebody tapped.

With the boundary removed the statuses are 404 again, and first byte is
32–207 ms — which is the figure in §3, and which no longer needs streaming to
be acceptable. **Streaming was the right fix for a three-second page. It is
not worth a broken status code for a hundred-millisecond one.**

A scoped version is possible — in-page `<Suspense>` around the data-dependent
part of each index route, which streams without sitting above the dynamic
`[id]` routes — and is the right move if hosted latency (§5) turns out to put
these pages back above half a second. It is about twenty files of
restructuring and it was not justified at the measured numbers.

**Prefetching the sidebar destinations.** The twelve `prefetch: false`
entries in `nav-items.ts` were removed, on the reasoning that a loading
boundary makes Next.js's `"auto"` mode prefetch only as far as that boundary.
That reasoning was sound and is now moot: with no boundary, the nearest one
is the end of the page, so an auto prefetch renders the whole page on the
server. Twelve server renders per page view, and twelve extra requests on a
metered connection, to save about a hundred milliseconds on one navigation —
a bad trade for a user base on mobile data. The opt-outs are restored
unchanged.

What did change is the cost when somebody *does* click: Debt & Security went
from 2,504 ms to 101 ms and the aging report from 2,556 ms to 91 ms, so the
opt-out now costs a person far less than it used to.

### 2.4 Deliberately not done

- **No index was added.** The brief asks for "appropriate database indexing",
  and the appropriate number here turned out to be zero. Supabase's own
  advisor reports `clients_full_name_trgm_idx` has never been used, and it
  cannot be: it indexes `lower(full_name)` while the search asks
  `full_name ILIKE '%term%'`, which is a different expression. But adding one
  the query *could* use does not help either — the search is a four-column
  `OR`, so no single index serves it, and a multicolumn trigram index was
  tested and the planner correctly kept the sequential scan. Client search is
  3.5 ms at 2,013 clients and under a millisecond at production's 28. Fixing
  this properly would mean a generated `search_text` column with one trigram
  index: a schema change with migration cost and no benefit until the book
  passes roughly 50,000 clients. Recorded, not built.
- **No caching of user-specific or financial data.** The only memoisation
  added is React's per-request `cache`, described above.
- **No stored arrears, no materialised view, no nightly job.** Phase 7's rule
  stands: delinquency is derived on read. This work made the derivation cheap;
  it did not materialise it.
- **No interface change at all.** Nothing in `components/` or any page's
  markup was altered except the one branding call in the portal page.
- **Pagination was already right.** Both registers use `range(from, from +
  pageSize)` and read one extra row to learn whether a next page exists,
  rather than a `count: 'exact'` on every keystroke. No change needed.
- **No N+1 query loops exist.** Every loop in `lib/data/` is an in-memory
  transform over rows already fetched; there is no `await` inside one.

## 3. Before and after

Local harness, production build, 14 loans. Median of nine requests after
three warm-ups. Neither run streams, so these are like for like: the figure
is time to first byte, and the full response completes 1–3 ms later.

| Page | Before | After | Improvement |
| --- | --- | --- | --- |
| Dashboard | 1,697 ms | 211 ms | **8.0×** |
| Clients | 60 ms | 38 ms | 1.6× |
| Loans | 3,669 ms | 80 ms | **45.6×** |
| Collections (payments) | 85 ms | 55 ms | 1.5× |
| Finance | 82 ms | 35 ms | 2.3× |
| Reports | 523 ms | 75 ms | **7.0×** |

The rest of the application, same method:

| Page | Before | After | Improvement |
| --- | --- | --- | --- |
| Debt & Security (`/recovery`) | 2,504 ms | 101 ms | **24.8×** |
| Report: aging | 2,556 ms | 91 ms | **28.0×** |
| Dashboard as Secretary/Treasurer | 1,610 ms | 100 ms | **16.1×** |
| Dashboard as Manager | 1,598 ms | 125 ms | **12.8×** |
| Overdue | 645 ms | 77 ms | 8.3× |
| Report: loans | 855 ms | 117 ms | 7.3× |
| Report: arrears | 771 ms | 122 ms | 6.3× |
| Trial balance | 102 ms | 49 ms | 2.1× |
| Portal (borrower) | 228 ms | 113 ms | 2.0× |
| Notifications | 57 ms | 38 ms | 1.5× |
| Users | 52 ms | 34 ms | 1.5× |
| Report: collections | 65 ms | 50 ms | 1.3× |
| Settings | 67 ms | 52 ms | 1.3× |
| Finance ledger | 153 ms | 115 ms | 1.3× |
| Audit | 54 ms | 46 ms | 1.2× |

Three roles were measured, not one. The dashboard composes itself from the
caller's capabilities, so Owner, Manager and Secretary/Treasurer run
different query sets; all three improved by an order of magnitude.

Every page in the application is now under 215 ms, and the median is 75 ms.
The slowest screen in the system was 3.7 seconds and is now 80 ms.

At the query level, as the application issues them:

| view (21 rows) | owner, before | `authenticated`, before | `authenticated`, after | RLS multiplier before → after |
| --- | --- | --- | --- | --- |
| `loan_workflow_register` | 15.8 ms | 3,210 ms | 61 ms | 203× → 2.6× |
| `loan_aging` | 22.7 ms | 2,496 ms | 86 ms | 110× → 2.1× |
| `collections_today` | 22.5 ms | 1,791 ms | 65 ms | 80× → 1.1× |
| `loan_delinquency` | 24.1 ms | 502 ms | 45 ms | 21× → 2.4× |
| `portfolio_at_risk` | 25.8 ms | 316 ms | 76 ms | 12× → 2.2× |
| `payment_register` | 11.7 ms | 49 ms | 17 ms | 4× → 1.8× |

The last column is the point. Row Level Security used to cost up to two
hundred times the query it protected; it now costs roughly double, which is
what an authorization boundary should cost.

### 3.2 Cold

One request per route against a server process that has just started, with
nothing warmed — no module graph, no connection pool, no plan cache:

| Page | Cold | Warm |
| --- | --- | --- |
| Dashboard | 289 ms | 211 ms |
| Report: arrears | 146 ms | 122 ms |
| Finance ledger | 115 ms | 115 ms |
| Portal (borrower) | 117 ms | 113 ms |
| Report: loans | 112 ms | 117 ms |
| Report: aging | 106 ms | 91 ms |
| Overdue | 104 ms | 77 ms |
| Loans | 89 ms | 80 ms |
| Collections (payments) | 78 ms | 55 ms |
| Debt & Security | 75 ms | 101 ms |
| Reports | 73 ms | 75 ms |
| Clients | 68 ms | 38 ms |
| Finance | 45 ms | 35 ms |

Cold costs 20–80 ms over warm and nothing is an outlier — the first request
pays for module loading and the first database connection, and then the
figures settle. Two routes read marginally *faster* cold than warm, which is
measurement noise at this scale rather than a real effect.

The reason this is worth stating: before the fix, the dashboard was 1,697 ms
*warm*, so a cold first impression of the application was worse again. The
cold path is now within 80 ms of the warm one on every screen.

### 3.1 Headroom, on a book sixty times larger

The hosted database holds 35 loans. To find the ceiling rather than describe
today, the harness was loaded with 2,014 loans, 41,072 collections and 40,929
payments — a synthetic read-side fixture, built by direct insert with the
write guards suspended and restored, for planning only.

| read | before | after |
| --- | --- | --- |
| `loan_delinquency`, one loan | 6,918 ms | 63 ms | 
| `loan_workflow_register`, one loan | 7,480 ms | 63 ms |
| `loan_delinquency`, 21 rows | 7,215 ms | 76 ms |
| `loan_workflow_register`, 21 rows | 7,753 ms | 772 ms |

What a person does — open a client, open a loan, take a payment, print a
statement, page a register — is a narrow read, and narrow reads got about a
hundred times cheaper. See §4 for what did not.

---

## 4. Remaining limitations

**Whole-book aggregate reads are still O(the book), and got slightly more
expensive.** Turning the coverage aggregate into a LATERAL is the right trade
for narrow reads but costs a full scan: `select count(*) from
loan_installment_coverage` as `authenticated` went from 614 ms to 976 ms at
2,014 loans. At that volume `collections_today`, `loan_aging` and
`portfolio_at_risk` are several seconds.

This is a ceiling, not a current problem — all three are well under 150 ms at
the volume the business holds, and they are reports and dashboard aggregates
rather than things a person waits on mid-task. It could be removed by giving
the reports their own aggregate-shaped query, and that was deliberately not
done: it would mean two expressions of what "paid against this collection"
means, and the first time they disagreed a borrower would see one number on
the register and another on their statement. If the book approaches that size,
the right move is a scheduled summary table with its own provenance, not a
second definition.

**The cascading per-row RLS chain on child tables remains.**
`payment_allocations`'s policy requires its payment to be visible, whose
policy requires its loan and client to be visible — two levels of correlated
`EXISTS`, re-evaluated per row. It is a 109× multiplier on
`loan_installment_coverage` at 2,014 loans (9 ms owner, 976 ms
`authenticated`). Flattening it would mean asserting that
`payment_allocations.loan_id` always equals its payment's `loan_id` and
rewriting a security predicate on that basis. That is a correctness argument
about a financial table, and it should be made deliberately rather than inside
a performance change.

**Region.** See §5. This is the largest remaining win and it is not in the
code.

**Client search does not use an index** and cannot, as written. §2.4.

**Measured on one machine.** These are local-stack figures: real database,
real PostgREST, production build, no network between tiers. They isolate
query and render cost, which is what was wrong. They do not predict hosted
latency, which §5 is about.

---

## 5. Hosting and region

Verified against the live configuration rather than assumed:

| | configured |
| --- | --- |
| Supabase project `fszgwemtgyrbhngajpzm` ("lending manager") | `eu-west-1` — AWS, Ireland |
| Vercel production deployment `dpl_AhbFhETnLTBpCUFXnSyvsA6ewbu8` | `regions: ["iad1"]` — Washington, D.C. |

About 5,500 km each way, 75–90 ms per round trip, on every database call a
page makes. With three serial auth round trips that was roughly 240 ms before
a page began to render; that part is now one round trip, but every query a
page makes still crosses the Atlantic.

`vercel.json` pins the deployment to **`dub1`** (Dublin), Vercel's region in
the same AWS region as the database, so the hop becomes intra-region.
`docs/PRODUCTION.md` §1.1 carries the reasoning, since JSON cannot hold a
comment.

**This takes effect on the next deployment, not on commit, and deploying is
your call.** Two things to note:

- If the database ever moves, this file must move with it. A deployment
  pinned to `dub1` against a database in `us-east-1` is worse than no pin,
  because it looks deliberate.
- The `bom1` sightings in the runtime logs could not be reproduced from the
  configuration, which reports `iad1` only. In Next.js 16 the proxy always
  runs on the Node.js runtime — it is not an edge function — so it runs in the
  deployment's region like everything else and is covered by the same setting.
  If `bom1` appears again, the log line and its deployment id would be worth
  capturing, as it would mean something about the project's region
  configuration that the API does not report.

Neither region is near Kampala, and that is the right trade: a browser makes
one round trip to the application, while the application makes several to the
database. Co-locating with the database wins; a region closer to East Africa
would only help if the database moved there too.

---

## 6. Test results

| gate | result |
| --- | --- |
| `npm run typecheck` | clean |
| `npm run lint` | clean |
| `npm run format:check` | clean |
| `npm run build` | succeeds |
| `npm run test:run` (unit + integration) | 2,174 passed / 2,174 |
| `npm run test:db` (real PostgreSQL, migrations from zero) | 1,323 passed / 1,323 |
| `npx playwright test` (production build, real stack, 4 accounts, desktop + mobile) | 498 passed / 498, 27 skipped |

The database suite is the one that matters most here: it rebuilds from the
migrations on every run, so it re-proves that all four apply to an empty
database in order, and it includes the delinquency, penalty, payment-posting,
payment-reversal, ledger, trial-balance and parity suites that pin the
financial figures to hard-coded expectations.

Three files were added to it:

- `rls-hoisting.test.ts` — the hoisted form is present everywhere, so a later
  policy cannot silently reintroduce the per-row form; the restated branch
  predicate agrees with `user_can_see_branch` over every combination; a
  capability denial still denies.
- `delinquency-pushdown.test.ts` — the view carries no CTE, a one-loan read
  does not scan every installment in the table, and every figure matches an
  independent recomputation from the schedule and the allocations.
- `session-context.test.ts` — the new authentication round trip. It always
  answers with exactly one row; it reports `ok` with the caller's roles;
  it refuses a suspended account **on its very next request** and returns
  none of that account's details with the refusal; it refuses an archived
  account and a profile with no role; it carries the forced-password-change
  flag; two accounts each get only themselves; and `anon` cannot execute it.

Two existing inventory locks in `security.test.ts` were extended to name the
new functions, which is what those locks are for.

### 6.1 The browser suite, and the one failure that was not one

The browser suite drives the production build against the real stack,
serially, as four accounts across two viewports. The full run is green: 498
passed, 27 skipped, 12.4 minutes.

An earlier run of it reported one failure, and it is worth writing down
because the diagnosis matters more than the result. `loan-application.write.spec.ts`
— "a manager may refuse what a manager may approve" — timed out waiting for
the *Reject this application* button on the seeded pending loan.

It was not a regression. That spec is a **write** test and a rejection is
final: an earlier run of the suite had been interrupted partway through,
after it had already rejected that loan, so the next run opened a loan that
had no reject button to offer. The seeded fixture is shared mutable state and
the specs are serial for exactly that reason.

Confirmed rather than assumed: on a freshly seeded database that loan is
`pending_approval` again, and the full suite passes. Worth remembering when
reading a red write-spec on this harness — re-seed before concluding
anything.

What the suite covers that matters most here: the status codes the reverted
loading boundary was breaking (all four `notFound()` routes answer `404`),
sign-in and session use for all four accounts through the rewritten
authentication path, every route refused to every role that should not reach
it, the per-page wire cost and request-count budgets on both desktop and the
phone viewport, and the security suite — the session cookie unreadable from
JavaScript, the privileged key never reaching the browser, and a borrower's
phone number unreadable anonymously.

---

## 7. How to reproduce any of this

```bash
npm ci
npm run e2e:up                              # database, PostgREST, shim, seed, build, serve
source <(tests/e2e/harness/stack.sh env)
npx playwright test --project=setup         # sign each role in, save storage state

# route timings
node <bench>/bench.mjs                      # see §3; TTFB and total per route

# query timings, as the application sees them
psql "$E2E_DATABASE_URL" \
  -c "set role authenticated" \
  -c "set request.jwt.claims='{\"sub\":\"<owner auth uid>\",\"role\":\"authenticated\"}'" \
  -c "\timing on" \
  -c "select * from public.loan_workflow_register order by created_at desc limit 21"

# the same read with no policy applied, for the RLS delta
psql "$E2E_DATABASE_URL" -c "\timing on" \
  -c "select * from public.loan_workflow_register order by created_at desc limit 21"
```

The per-row invocation count in §1.1 was obtained by replacing
`user_has_permission` with a `plpgsql` version that increments a counter
table, running the read, and restoring the original — on the local harness
only.
