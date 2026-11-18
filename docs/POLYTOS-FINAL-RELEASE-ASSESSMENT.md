# POLYTOS — final release assessment

**Date** 2026-11-17, **amended 2026-11-18** (§0). An independent review of the
combined system: `main` at `a5fd084`, plus PR #38 (Next.js 16.4.6) and PR #39
(L7), merged together and certified as one tree. The recovery of `main`'s CI on
2026-11-18 is recorded in §0, and `main` is now `2d5b04d`.

**Recommendation: GO for the migration and the deployment, from `2d5b04d`, with
the time-limited security exception in §0.3. NO-GO for operating with live
cash until two items that are not software are closed.** Stated in full in §9.

---

## 0. Amendment of 2026-11-18 — what happened after this was written

This assessment was written on 2026-11-17 and said the combined tree was green.
It was, that day. It was **not** green on `main` the next morning, and a "GO"
stated while a required gate is red would have been wrong. This section records
what happened, so that the rest of the document can be read for what it was.

### 0.1 `main` went red on 2026-11-18

Merging #39 produced `main` at `47330a0`. Its CI run
[44261983281](https://github.com/JTREVORM/lending-manager/actions/runs/44261983281)
failed two of four gates:

| Gate | Result | Cause |
| --- | --- | --- |
| checks, unit/integration, build | **fail** at "Dependency audit" | npm audit: 19 findings (13 high, 6 moderate), none in production. One advisory behind all 13 high: picomatch GHSA-fc5q-39xc-vjpf, which has **no patched release**. A minimatch advisory (moderate) behind the rest. #39 changed neither `package.json` nor the lockfile. |
| browser E2E | **fail**, 2 of 1,108 | two bank-clearance journeys submitted a literal value date of `2026-11-17` for deposits dated by the business date, `2026-11-18` by then. The database refused, correctly: *"The bank's value date cannot precede the deposit."* |

Neither was a defect in L7. The browser failure was a date written into a test;
the audit failure was a new advisory against an unchanged lockfile (the GitHub
review date of 2026-11-17 is consistent with it appearing between the two
runs, though that is an inference). The same test fragility had a second form
in `tests/db/cash-sufficiency.test.ts`, which passed the server's
`current_date`, a day behind the Kampala business date for the last three hours
of every UTC day.

CI's own Playwright artifact could not be downloaded from the authoring
environment, so the diagnosis rests on local reproduction on a stack rebuilt
from zero, with the same two failing locators, the same server log lines
(`verify_bank_deposit` line 48), and the same deposit dates.

### 0.2 What was changed, and what was not

| PR | Merge commit | What |
| --- | --- | --- |
| #45 | `6c333a4` | an expiring, single-advisory audit exception (§0.3) |
| #43 | `e15e116` | tests only: clearance journeys read the deposit's own recorded date; two db tests used the server clock; two db tests added |
| #44 | `a8550a1` | typescript-eslint 8.71.0 → 8.73.0, clearing the minimatch advisory (minimatch 10.2.6 → 11.0.9) |
| #42 | `183fb6c` | the PostgreSQL signing-key download in CI, retried and checked |
| #41 | `2d5b04d` | 75 server-action sites return `userMessage` rather than the developer `message`; one false positive in its own scanner removed by rewording a comment, scanner untouched |

No migration, application behaviour, RLS policy, ledger rule, financial
calculation or maker-checker rule was changed by any of them. No test was
removed, weakened or skipped, and no assertion or timeout was changed: the
three literals became a lookup of the deposit's own date.

### 0.3 The temporary audit exception

`npm audit fix --force` would downgrade vitest 5 → 3.1.4 and the Next.js lint
config 16 → 14 and still not remove the advisory, because no picomatch release
outside `<=4.0.7` exists. The Owner approved an exception for exactly
GHSA-fc5q-39xc-vjpf, **expiring 2026-12-02**. It is implemented as
`scripts/audit-gate.ts` and `security/audit-exceptions.json`: auditing stays
on, the threshold stays at high, a critical advisory can never be excepted, it
never applies to the production tree, it ends itself on the date, and it fails
the gate if a patched release appears or the advisory stops being reported.
The reasoning and the accepted residual risk are in
`docs/POLYTOS-AUDIT-EXCEPTION-PICOMATCH.md`.

**One thing it does not cover, stated here because it is easy to miss:** Next
16.4.6 bundles its own compiled copy of picomatch, which `npm audit` cannot
see. It was measured with the advisory's trigger and is vulnerable in exactly
the way 4.0.7 is (`+(*a)` against `a…ab`: about 11 s at n=28 in both). It is
unreachable with this configuration, because Next feeds it only
`images.remotePatterns`, `images.localPatterns` and `unstable_allowDynamic`,
which are developer-written and which this repository does not set. **Do not
add an `images` pattern containing a repeated extglob until the framework
carries a patched copy.**

### 0.4 The four gates, measured

| Commit | Gate | Result |
| --- | --- | --- |
| `47330a0` (merge of #39) | checks/unit/build · database · security rehearsal · browser E2E | **fail** · pass · pass · **fail** |
| `a8550a1` (after #45, #43, #44) | all four | **pass** (run 44330891838) |
| `183fb6c` (after #42) | all four | **pass** (run 44335846845) |
| **`2d5b04d` (after #41) — `main` now** | all four | **pass** (run 44340371317); browser 1,108 passed, 0 failed, 53 skipped, 23.1 min |

Before merging, the three fixes were also run together on the exact combined
tree on an integration branch in GitHub Actions, all four gates green (run
44325115000), and `a8550a1`'s tree was byte-identical to it.

Local measurements, not CI counts: 2,805 unit and integration tests passed
on #41 merged with `main` at `a8550a1`; `cash-sufficiency.test.ts`
passes 32/32; the six clearance journeys pass 12/12 (six setup steps
included) on a freshly seeded stack on 2026-11-18 and again with the business
date at 2026-11-19. The unit/integration CI job's own test count could not be
read (log download returned HTTP 503), so none is cited from CI.

**What this section does not establish:** the production read-only
certification was still not run; the hosted project was not contacted in this
cycle; and the temporary exception is a decision with a clock on it.

---

## 1. The eight confirmations asked for

| | Confirmation | Verdict | Evidence |
| --- | --- | --- | --- |
| 1 | All five financial-control migrations present | **CONFIRMED** | `20261119000100`, `20261120000100`–`400` on `main` |
| 2 | 469-rule certification inventory preserved | **CONFIRMED** | re-derived independently: 469 rule rows, 469 unique, 0 duplicates, per-module sum 469 |
| 3 | No unresolved critical or high-severity software defect | **CONFIRMED** | DEFECT-001 and GAP-001, the only two, both High, both fixed and merged |
| 4 | All financial reconciliation identities pass | **CONFIRMED** | 41 identities: 39 pass, 2 explained, 0 vacuous, 0 fail |
| 5 | All security and E2E gates pass | **CONFIRMED, after a correction (§0)** | green on each PR head and on the combined tree on 2026-11-17; **red on `main` on 2026-11-18** for two reasons unrelated to L7; green on `main` `2d5b04d` with all four gates, 1,108 browser tests, 0 failed |
| 6 | Existing loan and membership history unchanged | **CONFIRMED, with a caveat that matters** | §3 |
| 7 | Supabase production not modified | **CONFIRMED** | 217 migrations, latest `20261115001600`, zero of the six new ones |
| 8 | Providers and membership policies inactive | **CONFIRMED** | 9 providers all `is_provisional`, 0 active; 2 policy versions, both `draft` |

## 2. The combined tree, measured as one system

*Measured on 2026-11-17, before merge. For the gates on `main` itself see §0.4.*

`main` + #38 + #39 merged — **cleanly, no conflicts**, including the
`a4b037b` commit present in both branches.

| Gate | Result |
| --- | --- |
| `npm ci` | Next.js **16.4.6** |
| `typecheck` / `lint` / `format:check` | **PASS** |
| `audit:money` | 278 financial files, no float hazard |
| `test:run` (unit + integration) | **2,778 passed, 0 failed** |
| `npm run build` | clean, 12.3s, **no security advisory, no halt** |
| `db:local:setup` | **230 migrations** applied to a clean database |
| `check:security` | "No unreviewed privileged exposure." |
| `test:db` (16 projects) | **2,580 passed, 0 failed** |
| `certify:financial` | **41 identities: 39 pass, 2 explained, 0 vacuous, 0 fail** |
| membership upgrade gate | 99 existing migrations, a seeded book, then 131 new — **all 28 financial figures identical** |
| policy upgrade gate | 26 financial/identity tables; **debits = credits = 17,786,420** |
| `npx playwright test --trace off` | **1,108 passed, 0 failed, 53 skipped**, 22.2 min, reseeded stack, Next.js 16.4.6 |

The two upgrade gates are the load-bearing evidence for confirmation 6: they
seed a book, apply the new migrations to it, and compare every financial
figure. Nothing moved.

## 3. Confirmation 6 deserves a caveat, not a tick

"Existing loan and membership history remains unchanged" is **true, and
trivially so: there is no history.**

The hosted database holds 0 clients, 0 loans, 0 memberships, 0 loan payments,
0 journal entries, 0 journal lines, 0 savings accounts, 0 savings
transactions, 0 benefit claims and 0 agency transactions. The trial balance
nets to **zero** across all 55 ledger accounts.

**There are therefore no opening balances, synthetic or genuine.** The
distinction the Owner asked for cannot be drawn in the data because neither
kind is present. The populated demonstration book — 17 loans, 162 payments, a
balanced ledger near 17.7 million shillings — exists only in the local and CI
seeds. Every financial figure in this document and in the certification
report is **synthetic by construction**. None of it is company money, and
none of it is in the hosted project.

What this means practically: the opening verified position must be
**established at go-live from a physical count and a bank confirmation**, not
reconciled against anything already recorded. No migration can do it, and
reading a figure off a test run would be inventing one.

## 4. Where the real assurance comes from, and where it does not

The strongest evidence is **not** that the suites are green. It is that
several of them were red first, for real reasons, and the reasons were found
rather than papered over:

- **CI independently failed `6cb0165`** — L7's first version, which put the
  staff sentence in `userMessage` while the finance handlers render
  `message`. CI's browser gate caught it on its own fresh stack, for the same
  reason the local journey did. The gate is doing real work.
- **`tests/db/separation-of-duties.test.ts` fails 4 of 9 with the L7
  migration removed** — the four that assert `SD001`. The other five assert
  preserved behaviour and pass either way, by design.
- **`agency-money.write.spec.ts`'s `verifyTrade` had 33 matches** for its own
  "success" assertion before anything was verified, so it could not fail.
  Replaced with a row-scoped assertion that does fail on a pending trade.
- **The membership upgrade gate refused L7 outright** until `20261121` was
  registered, which is what makes "fourteen rewritten function bodies moved
  no money" a measurement rather than a claim.

What the evidence does **not** cover, stated so nobody over-reads it:

- **No production read-only certification was run.**
  `scripts/certify-production-readonly.mjs` issues requests to the hosted
  application and was deliberately not run; this review did not contact
  production except through read-only SQL.
- **CI Playwright traces and screenshots could not be retrieved.** The
  artifact download redirects to a blob host the authoring environment
  refuses. Diagnoses rest on code reading, live-page instrumentation and
  local reproduction.
- **Gate results are job conclusions**, not per-test totals read from CI
  logs. Vitest and Playwright both exit non-zero on any failure, so a green
  job means zero failures; the per-suite counts above are from local runs on
  the same trees.
- **The real-Auth rehearsal remains `NOT TESTED`** in the one respect the
  report already records: it needs a container image unavailable here. The
  CI rehearsal job does run and passes.

## 5. Remaining issues

### Open, and the Owner's to decide — not software defects

| | Item |
| --- | --- |
| **C2** | Approve a membership policy version, or accept that the membership programme cannot operate. Both versions are `draft`; membership, savings, member lending, benefits and meeting fines cannot run until one is approved with an authorisation reference. |
| **C4** | Complete the cash cutover. `POLYTOS-CASH-CUTOVER-CHECKLIST.md` is written and **NOT STARTED**. |
| **B-1** | The accounting treatment for a bounced or partially cleared bank deposit. Unresolved deposits stay `under_investigation` and post nothing, which is the safe behaviour and is measured. |

### Found during this work, not fixed, each wanting its own change

| | Item | Why not here |
| --- | --- | --- |
| 1 | **`lib/finance/actions.ts` returns developer `message` text to users** from about a dozen handlers. A foreign-key refusal reads "Foreign key violated on transfer." where the architecture intends "A linked record is missing or still in use." L7's own path is now safe either way. | Changes user-visible text across the finance module; not L7 |
| 2 | **The PostgreSQL signing-key `curl` in `ci.yml` has no `--retry`**, unlike the PostgREST download beside it, which was hardened against exactly this. It cost one false CI failure in this session. | A CI robustness change does not belong in a security PR |
| 3 | **`tests/e2e/harness/fixtures.json` is tracked but generated.** Written by the seed on every stack build, saved and restored by the release rehearsal, described as regenerated in three documents, and read from git by no test. It produced churn in three PRs here and one false failure signature earlier. | Repo hygiene, unrelated to either PR |
| 4 | **At least two officers per branch must hold `receipts:confirm` and `deposits:verify`.** The hosted database has one branch and one profile, so this is not currently satisfiable. A branch with one officer cannot clear its own deposits — correctly. | Operational setup, not code |

**Update 2026-11-18.** Items 1 and 2 are fixed: #41 returns `userMessage` at all
75 sites, with a repository-wide scanner against the habit returning, and #42
hardened the signing-key download. Items 3 and 4 are unchanged. Three things
were found in the recovery and are recorded rather than left implicit:

| | Item |
| --- | --- |
| 5 | **A temporary audit exception expires 2026-12-02** (§0.3). A deployment or release after that date needs either a patched picomatch or a new, written approval; the gate fails by itself otherwise. |
| 6 | **Next's vendored picomatch is vulnerable and invisible to `npm audit`** (§0.3). Unreachable today; no `images` pattern may use a repeated extglob until it is patched. |
| 7 | **Seven receipt tests in `cash-sufficiency.test.ts` fail when the business timezone is forced 14 hours ahead.** Seen only with that artificial shift; not investigated, and not claimed to occur in the real three-hour window. Worth a look before anything relies on the file being time-independent. |

### Known and accepted

L2, L3, L4, L6 from §J of the certification report, all Low, all unchanged.

## 6. What changed in this review cycle

| PR | Head | What |
| --- | --- | --- |
| #37 | `bcc5f6d` → merged `a5fd084` | L5: six financial browser journeys; cash cutover checklist |
| #38 | `86ee9b5` | Next.js 16.4.1 → 16.4.6 for CVE-2026-119790 |
| #39 | `30e83d1` | L7: `SD001` across all fourteen maker-checker guards |
| #45, #43, #44, #42, #41 | see §0.2 | the CI recovery of 2026-11-18 |

## 7. The security update, in proportion

CVE-2026-119790 / GHSA-mfr8-8qww-v76h, moderate, CVSS v4 6.3, CWE-362.
Affects `next >= 16.3.0 <= 16.4.4`; this repository ran 16.4.1.

**This application's exposure was almost certainly nil.** Three
preconditions all fail in first-party code: no `unstable_cache` call
anywhere, no `'use cache'` directive anywhere, and no dynamic segment
directly under `app/`, so no root params exist to leak across.
`next.config.ts` enables neither `cacheComponents` nor `dynamicIO`. The
honest statement is "no reachable path in our code" — a dependency wrapping
`unstable_cache` internally was not audited.

The upgrade is still right: it clears the advisory that **halts the build**,
and keeps the framework patched for code not yet written. It should not be
sold as closing a live hole.

## 8. Production safety during this review

No migration applied to the hosted Supabase project. No deployment to Vercel.
No provider activated. No membership policy approved. No production financial
transaction created. No database reset. Every suite ran against throwaway
loopback databases.

The hosted project was read **only**, and is in the same state as when this
review began: 217 migrations, latest `20261115001600`, zero of the six new
migrations, zero active providers, zero non-draft policies, zero journal
lines.

## 9. GO / NO-GO

**GO — apply the thirteen outstanding migrations and deploy, from `main`
`2d5b04d` (not from a branch).** #38 and #39 are merged, and all four gates
are green on that commit (§0.4). The deployment must happen **before
2026-12-02**, or the audit exception must first be renewed in writing or
retired by a patched picomatch; after that date `main`'s audit gate fails by
design. The software case is as strong as this engagement can make it: two
High-severity control failures found, fixed, merged and regression-tested; a
469-rule inventory preserved exactly; 41 financial identities holding; 2,778
unit and integration tests, 2,580 database tests and 1,108 browser tests
green on the combined tree; every financial figure identical across the
upgrade; and the browser gate demonstrated to catch a real defect rather than
rubber-stamp the change.

**NO-GO for handling live cash** until two items close, neither of which is
code and neither of which deploying changes:

1. **C4, the cash cutover.** Decision A's rule binds on live data the moment
   `20261120000100`–`400` are applied. The migrations take "no restriction
   recorded" to mean "available" — an assumption about the past rather than a
   measurement of it. Harmless on an empty book; load-bearing the first time
   real cash is recorded.
2. **Two officers per branch** holding `receipts:confirm` and
   `deposits:verify`. With one branch and one profile, a branch cannot clear
   its own deposits, and the separation-of-duties rule will refuse it —
   correctly, and confusingly if nobody expects it.

**C2, the membership policy,** is a third decision but not a deployment
blocker: the programme simply cannot operate until a version is approved, and
deploying neither helps nor harms it.

The deployment is low-risk in an unusual and worth-stating way: **the hosted
database has nothing in it to damage.** No history to corrupt, no balances to
restate, no borrower whose position could move. That is the strongest
argument for going now, and it expires the first day staff record real money.

**This is a recommendation for a separate deployment decision. Nothing in it
has been acted on.**
