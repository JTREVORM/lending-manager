# POLYTOS — final release assessment

**Date** 2026-11-17. An independent review of the combined system: `main` at
`a5fd084`, plus PR #38 (Next.js 16.4.6) and PR #39 (L7), merged together and
certified as one tree.

**Recommendation: GO for the migration and the deployment. NO-GO for
operating with live cash until two items that are not software are closed.**
Stated in full in §9.

---

## 1. The eight confirmations asked for

| | Confirmation | Verdict | Evidence |
| --- | --- | --- | --- |
| 1 | All five financial-control migrations present | **CONFIRMED** | `20261119000100`, `20261120000100`–`400` on `main` |
| 2 | 469-rule certification inventory preserved | **CONFIRMED** | re-derived independently: 469 rule rows, 469 unique, 0 duplicates, per-module sum 469 |
| 3 | No unresolved critical or high-severity software defect | **CONFIRMED** | DEFECT-001 and GAP-001, the only two, both High, both fixed and merged |
| 4 | All financial reconciliation identities pass | **CONFIRMED** | 41 identities: 39 pass, 2 explained, 0 vacuous, 0 fail |
| 5 | All security and E2E gates pass | **CONFIRMED** | four CI gates green on each PR head; combined tree 1,108 browser tests, 0 failed |
| 6 | Existing loan and membership history unchanged | **CONFIRMED, with a caveat that matters** | §3 |
| 7 | Supabase production not modified | **CONFIRMED** | 217 migrations, latest `20261115001600`, zero of the six new ones |
| 8 | Providers and membership policies inactive | **CONFIRMED** | 9 providers all `is_provisional`, 0 active; 2 policy versions, both `draft` |

## 2. The combined tree, measured as one system

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

### Known and accepted

L2, L3, L4, L6 from §J of the certification report, all Low, all unchanged.

## 6. What changed in this review cycle

| PR | Head | What |
| --- | --- | --- |
| #37 | `bcc5f6d` → merged `a5fd084` | L5: six financial browser journeys; cash cutover checklist |
| #38 | `86ee9b5` | Next.js 16.4.1 → 16.4.6 for CVE-2026-119790 |
| #39 | `30e83d1` | L7: `SD001` across all fourteen maker-checker guards |

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

**GO — merge #38 then #39, apply the thirteen outstanding migrations, and
deploy.** The software case is as strong as this engagement can make it: two
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
