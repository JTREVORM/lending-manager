# Phase 19 — the dashboard's cancelled queries (`57014`)

After the Phase 18 deployment (`dpl_DweXDZRsn8rdQmrqt6abiP7CHFm8`, merge
`5fe88c9`), every section of `/` was failing for a signed-in Owner with
PostgreSQL `57014`, `query_canceled`.

| | |
| --- | --- |
| Branch | `claude/phase19-dashboard-57014`, off `5fe88c9` |
| Production changed | **nothing** — no schema change, no data change, no deployment |
| Verdict | two root causes confirmed, one fixed outright, one reduced and the remainder referred (§6) |

---

## 1. The evidence

Vercel retains runtime logs for one hour on the Hobby plan, so the request ids
in the original report had aged out. The same failure was still live and was
captured directly:

```
19:58:02.972  GET /  warn  region=bom1  runtime=nodejs24.x
  {"level":"warn","message":"Could not read the portfolio summary.","context":{"code":"57014"}}
19:58:02.256  ... "Could not read today's collection summary."     {"code":"57014"}
19:58:02.093  ... "Could not read today's collection sheet."       {"code":"57014"}
19:57:58.521  ... "Could not read recent loan activity."           {"code":"57014","column":"cleared_at"}
19:57:58.467  ... "Could not read recently penalised loans."       {"code":"57014"}
19:57:58.466  ... "Could not read recent loan activity."           {"code":"57014","column":"disbursed_at"}
19:57:46.962  ... "Could not read portfolio at risk."              {"code":"57014"}
19:57:42.284  ... "Could not read the recovery workload."          {"code":"57014"}
```

Four requests showed the identical pattern (`jklzw`, `7vfm9`, `q4khn`,
`trqnq`, `gn6w2`). Note the spread: **eight failures over twenty seconds within
one request**, in clusters, not all at one instant. That shape is the whole
answer to §3.

The Step 3 verification found no errors because every probe it made was
unauthenticated and got a `307` — the dashboard never rendered. These warnings
only exist once somebody signs in.

## 2. Why the queries were cancelled

### 2.1 The mechanism

`statement_timeout` for the role PostgREST runs as:

| Role | `statement_timeout` |
| --- | --- |
| `anon` | 3 s |
| **`authenticated`** | **8 s** |
| `service_role`, `postgres` | none |

`57014` is what Postgres raises when that budget expires. So each dashboard
query was taking more than eight seconds of **server-side execution**.

### 2.2 What they actually cost

From production's own `pg_stat_statements` (these are the live PostgREST
statements, identified by their `WITH pgrst_source` wrapper):

| View | mean | max | buffer hits/call | MB/call |
| --- | --- | --- | --- | --- |
| `loan_portfolio_report` (ordered) | 4,870 ms | 4,903 ms | 194,125 | 1,517 |
| `portfolio_at_risk` | 4,717 ms | 5,676 ms | 66,950 | 523 |
| `loan_portfolio_report` (ordered) | 4,465 ms | 5,076 ms | 174,796 | 1,366 |
| `dashboard_collection_summary` | 3,805 ms | 5,762 ms | 69,182 | 540 |
| `dashboard_portfolio_summary` | 3,480 ms | **7,317 ms** | 85,189 | 666 |
| `loan_delinquency` | 2,669 ms | 6,701 ms | 98,266 | 768 |
| `loan_recovery_status` | 2,459 ms | 5,350 ms | 11,205 | 88 |
| `collections_today` | 2,345 ms | **7,114 ms** | 74,187 | 580 |
| `loan_portfolio_report` ×3 | 1,773–1,947 ms | 5,360–6,713 ms | ~21,000 | ~167 |

Two things to read off this. The maxima already press against the eight-second
ceiling — 7,317 ms and 7,114 ms — so these statements were *at* the limit, and
anything that added load tipped them over. And **`shared_blks_read = 0` on
every one of them**: there is no disk I/O at all. This is pure CPU on a
shared-tier instance (`shared_buffers` 224 MB, `max_parallel_workers_per_gather`
1).

### 2.3 Not the region, and not Phase 18

Both were checked rather than assumed.

**Region is not the cause.** The eight seconds is consumed *inside* Postgres —
`statement_timeout` measures server-side execution, and `pg_stat_statements`
attributes 1.6–4.9 s mean to the statements themselves. Network distance
between the function and the database adds round-trip time, not statement
execution time; it cannot turn a 300 ms statement into an 8 s one. The region
discrepancy is real and worth settling (§5) but it is a separate matter.

**Phase 18 is not the cause.** Its `loan_delinquency` rewrite replaced
materialised CTEs with grouped subqueries and LATERALs. A LATERAL is evaluated
per row, so it was worth checking whether that made the *whole-view scan* —
which is exactly what the dashboard does — worse than the CTE version it
replaced. Both versions were built side by side on the harness and compared:

| | buffer hits | execution (median of 3) |
| --- | --- | --- |
| Pre-Phase-18 (materialised CTEs) | 3,126 | 15.6 ms |
| **Phase 18 (LATERAL pushdown)** | **2,459** | **14.8 ms** |

The new view is cheaper on the whole-view scan as well as on the single-loan
read, and the two produce byte-identical output (0 rows differing in either
direction). Phase 18 did not introduce this.

## 3. One shared timeout, or each query its own?

**Each query is cancelled by its own `statement_timeout`.** There is no shared
deadline and no connection fault. The clustering in the log is simply that
`app/(app)/page.tsx` issues its reads in a single `Promise.all`, so they start
together and expire together.

Reproduced on the harness — same role, same policies, same views, the thirteen
reads an Owner's dashboard issues, in the shapes the data layer asks for them:

| Scenario | Slowest query | Cancelled |
| --- | --- | --- |
| One at a time, no budget | 89 ms | 0 / 13 |
| **All at once** (what the page does), no budget | **301 ms** (3.4×) | 0 / 13 |
| One at a time, 134 ms budget | 100 ms | **0 / 13** |
| **All at once, 134 ms budget** | 135 ms | **4 / 13 → `57014`** |

The budget is set to 1.5× the slowest single query, which is the same
relationship production has; the absolute times differ because the harness has
a smaller book and is not a shared-CPU tier.

The four that cancel are the heavy whole-book aggregates — portfolio summary,
collection summary, collection sheet, portfolio at risk — which is the same set
production cancels. Serial execution under the *identical* budget cancels
nothing. So the fan-out is the trigger: concurrency multiplies each query's
latency, and the per-query cost in §2.2 has no headroom left.

## 4. Did the affected sections show misleading figures?

Yes — six of them, and this is the most serious finding in this report.

Three readers already handled a failed read correctly, returning `null` so the
page could explain itself. Six did not:

| Section | On a cancelled query it rendered | Which reads as |
| --- | --- | --- |
| Today's collection sheet | `{ rows: [], hasMore: false }` | nobody owes anything today |
| Recent payments | `[]` | no payments have been taken |
| Upcoming collections | `[]` | nothing is due this week |
| Recent disbursements / clearances / penalised | `[]` | no loans paid out, settled or charged |
| Approvals awaiting a decision | `0`, `0`, `0` | nothing is waiting for your decision |
| **Portfolio at risk** | `EMPTY_PAR` — every bucket zero | **a book with no arrears in it** |

Each of those is a statement about the business. None was true. The last is the
most dangerous sentence this product can say, and it appeared both on the
dashboard headline and on the dedicated risk screen, whose entire purpose is to
show arrears.

### 4.1 What it does now

Every reader reports failure, and the page names what it could not read and
draws nothing for it. Proven end to end against the harness by forcing the
production condition (a statement budget these queries cannot meet, with
PostgREST's pool recycled so the role setting takes effect):

```
status=200  bytes=59,766   (healthy: 258,802 — the sections are absent, not zeroed)

  "Some figures could not be read"
  This dashboard could not read the portfolio summary, today's collection
  summary, today's collection sheet, recent payments, upcoming collections,
  recent loan activity, portfolio at risk, the recovery workload and approvals
  awaiting a decision. Those sections are left out rather than shown as nil …

  Portfolio-at-risk card present? False
```

The page still renders, still returns 200, and now says which figures are
missing instead of inventing them.

## 5. Execution region: `dub1` or `bom1`?

Unresolved, and deliberately reported as unresolved. Two pieces of solid
evidence disagree:

| Source | Says |
| --- | --- |
| `vercel.json`, and the deployment's own metadata | `regions: ["dub1"]` |
| `x-vercel-id` on a computed page, 4 consecutive requests | `iad1::dub1::…` — ingress `iad1`, compute **`dub1`** |
| Runtime logs for every dashboard warning | `region=bom1`, `runtime=nodejs24.x`, source `function` |

`/login` is not cached (`x-vercel-cache: MISS`), so it genuinely computes, and
it computes in `dub1` every time. The dashboard warnings are emitted by a Node
serverless function on the same deployment and are logged as `bom1`.

Both readings fit all the data: either the log's `region` field reports request
ingress rather than compute (the owner's requests entering via Mumbai), or the
function really is executing in `bom1` and the `dub1` in metadata is declared
but not effective. This session cannot distinguish them, because the log
correlation needs a request that both originates from this container *and*
emits a log line, and the application logs nothing on a successful render.

Vercel documents `process.env.VERCEL_REGION` as the authoritative in-process
answer, so **every one of these warnings now carries `region` from that
variable**. The next deployment settles it from the inside, with no further
investigation needed. It does not affect the diagnosis either way (§2.3).

## 6. The fixes, and what is left

### 6.1 Fixed

1. **No figure derived from a failed query.** The six readers above return
   `null`; the dashboard names the unreadable sections and omits them; the
   recovery screen and the client payments panel do the same. The types were
   widened rather than a flag added, so the compiler found every consumer —
   which is how the client-detail page and the aging register turned up.
2. **Two of the three heaviest scans removed.** The three lifecycle cards were
   three separate reads of `loan_portfolio_report`, each paying for a scan of
   the whole book because the ordering columns are computed by the view and
   PostgREST's `order(...).limit(4)` cannot be answered from an index. They are
   now one read:

   | | statements | buffer hits | execution |
   | --- | --- | --- | --- |
   | Before | 3 | 5,452 | 38.7 ms |
   | **After** | **1** | **1,791** | **10.0 ms** |
   | | | **3.04× less** | **3.85× faster** |

   In production terms that removes two of the 20,759–194,125-buffer scans per
   dashboard load.
3. **The harness fails loudly instead of mysteriously** (§7).

### 6.2 Not fixed, and why it needs a decision

The four whole-book aggregates — `dashboard_portfolio_summary`,
`dashboard_collection_summary`, `collections_today`, `portfolio_at_risk` — still
cost 2.3–4.9 s each in production with maxima at 7.1–7.3 s. **They will still
cancel under concurrency on the current instance.** The dashboard now fails
safely rather than misleadingly, but it still fails.

Closing that needs one of three things, and all three are the owner's call
rather than a code change:

1. **More CPU.** `shared_blks_read = 0` and
   `max_parallel_workers_per_gather = 1` say this is CPU-bound on a shared
   tier. This is the smallest change and the one most likely to fix it outright.
2. **Pre-aggregated summaries** — materialised views refreshed on write, so a
   dashboard card reads a row instead of re-aggregating the book. This is a real
   design change with correctness obligations around refresh, and it is how
   these figures will eventually have to work at scale.
3. **A longer `statement_timeout` for `authenticated`.** Cheapest and worst: it
   converts a broken dashboard into a slow one and raises the ceiling for every
   other query too.

Deliberately not done: caching these figures. They are per-user,
policy-filtered financial aggregates, and a shared cache over them is exactly
what must not exist here.

## 7. The CI browser-E2E sign-in failure

Red on the production branch before Phase 18 and still red: all four
`auth.setup.ts` sign-ins time out on `page.waitForURL`, `519 did not run`,
`2 passed`, **zero spec failures**. It does not reproduce locally — the same
suite signs all four roles in, in 7.8 s.

### 7.1 What it actually is

The first hypothesis from the CI log was wrong and the run proved it. The log
showed the job's cleanup reaping only `postgres`, which suggested the services
were killed with the starting step's process group. They were started with
`nohup … &`, which ignores SIGHUP but does not leave that group, so `setsid`
was a reasonable fix — and is a strict improvement — but it was not the cause.

Adding the check in §7.2 and pushing moved the failure from the browser step
into the step where it belongs, and it named the cause in one line:

```
  auth shim
  seed
  application
  verifying the sign-in path
harness check failed: the shim’s TLS certificate is not acceptable to Node
  ECONNREFUSED: connect ECONNREFUSED 127.0.0.1:8443
error: the stack is serving but cannot sign anybody in.
```

**The auth shim is not listening** — and not because a later step killed it,
but inside the very step that starts it. The reason the stack reported success
anyway is the readiness loop:

```bash
for _ in $(seq 1 30); do
  if curl -skf -o /dev/null "https://127.0.0.1:${SHIM_PORT}/auth/v1/health"; then break; fi
  sleep 1
done
```

It breaks on success and does **nothing** when the attempts are exhausted. So
thirty failed probes fell through to the seed and the application exactly as
though they had succeeded. `/login` rendered, because Next does not need the
shim to render it; sign-in could not work, because it does. The suite then
failed in `auth.setup.ts` with four twenty-second timeouts, and nothing
anywhere said the shim was missing. The same shape applied to the PostgREST
probe.

That is the defect. It is not a Phase 18 regression, it predates this work,
and it is why the symptom was so hard to read: the harness was designed to
tolerate the one failure that makes the suite meaningless.

### 7.2 The changes

1. **`await_service`** replaces both fall-through loops. It fails when the
   attempts are exhausted and prints that service's own log, which is where
   the reason is. Proven both ways: it returns 0 against the live services,
   and against a probe that never succeeds it exits 1 and prints the log tail.
2. **`tests/e2e/harness/verify.mjs`**, at the end of `stack.sh up` and again
   before Playwright. It checks the two things the old probes could not: that
   the shim's certificate satisfies **Node with the harness CA** — the old
   probe is `curl -skf`, and `-k` skips precisely the validation the
   application performs — and that the seeded owner can complete a password
   grant. This is the check that produced the diagnosis above.
3. **`setsid` instead of `nohup`** for all three services. Not the cause, but
   correct: they now genuinely outlive the step that starts them, and
   `stack.sh down` still reaps them (verified).
4. **Certificate generation no longer discards its errors.**

### 7.3 The cause, found

The next run's log carried the shim's own error, which is the whole answer:

```
  auth shim
error: the auth shim did not come up on time.
--- .e2e/shim.log (last 20 lines) ---
Error: Cannot find module 'pg'
Require stack:
- /home/user/lending-manager/package.json
    at file:///home/runner/work/lending-manager/lending-manager/tests/e2e/harness/shim.mjs:26:20
  code: 'MODULE_NOT_FOUND'
```

`tests/e2e/harness/shim.mjs` resolved its one dependency like this:

```js
const require = createRequire('/home/user/lending-manager/package.json');
```

An absolute path to one machine's working directory, committed in **Phase 9**
(`722923d`) and unchanged since. The shim can only start where the checkout
sits at exactly that path. It did on the machines Phases 9–18 were written on
— which is why the browser suite looked green to every one of them — and it
does not on a GitHub Actions runner, where the checkout is under
`/home/runner/work`.

So the full chain, eight phases old:

1. The shim exits immediately with `MODULE_NOT_FOUND`.
2. Next renders `/login` anyway, because it does not need the shim to render
   it; the readiness loop (§7.1) tolerated the missing service.
3. Sign-in does need the shim, so all four `auth.setup.ts` sign-ins time out
   and 519 specs never run.

The fix is `createRequire(import.meta.url)`, which resolves from the file's own
location upwards and therefore finds the repository's `node_modules` wherever
the repository is. Verified by running the shim from a checkout at a different
absolute path with its own `node_modules`: it resolves
`<repo>/node_modules/pg` and starts. The old form cannot be tested that way in
this container, because the hardcoded path exists here — which is precisely
the trap it set. CI was the test, and CI named it.

`tests/e2e/specs/fixtures.ts` already used the cwd-relative form, so the shim
was the only file carrying this; a repository-wide search for hardcoded
developer paths finds nothing else.

## 8. Verification

| Check | Result |
| --- | --- |
| `tsc --noEmit` | clean |
| `eslint .` | clean |
| `prettier --check .` | clean |
| Unit + integration | **2,185 passed** (2,174 before; 11 new) |
| Database (migrations from zero) | **1,323 passed** |
| Production build | succeeds |
| Browser: `dashboard`, `app-shell`, `security` | **120 passed** |
| New tests against the **old** data layer | **7 fail** — they are genuine regression tests |
| Forced-failure dashboard render | notice shown, nine sections named, no zero-risk card |
| CI on this branch (`96a78b9`) | `checks` **success**, `database` **success** |
| CI browser job, `96a78b9` | fails in `Bring up the stack` naming `ECONNREFUSED :8443` — in the right step, per §7.1 |
| CI browser job, `2c4f6cd` | fails naming the shim's own `MODULE_NOT_FOUND` — the cause, per §7.3 |
| CI browser job, `33720b1` | the shim starts: the bring-up passes the point that failed fast in both runs above, and the suite runs for the first time since Phase 9. Final tally was still in flight when this was written — the branch's run is the record. |

`tests/unit/dashboard-read-failures.test.ts` pins the contract the page relies
on: each reader returns `null` on `57014`, and the lifecycle cards read
`loan_portfolio_report` exactly once.

## 9. What was not touched

No production schema change, no production data change, no deployment, no
migration. RLS, the permission matrix, every loan calculation, the penalty
rules, the repayment schedules and the double-entry ledger are all untouched —
this phase changed how a failed read is reported and how many times one view is
read.
