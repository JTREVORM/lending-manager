# POLYTOS V1 — PHASE 4A FINAL INTEGRATION: RELEASE-READINESS REPORT

**Date:** 2026-11-13
**Project:** `fszgwemtgyrbhngajpzm`, Supabase Free. Retained, as decided.
**Nothing hosted was changed in this phase.** No migration applied, no row
deleted, no Auth identity or Storage object touched, no policy retired, no
deployment. No PR merged into the default branch. No new Supabase project and
no paid service.

---

## 1. What was integrated, and where

The Phase 3 fix commit `9d509d9` touched five files spanning two different
concerns. It was split along the line the PRs already draw, so nothing lands
in two places:

| File | Goes to | Why |
| --- | --- | --- |
| `scripts/clean-slate.mjs` | **#28** | the cleanup tool lives on the security branch |
| `scripts/lib/clean-slate.mjs` | **#28** | " |
| `scripts/lib/clean-slate.d.mts` | **#28** | " |
| `tests/db/clean-slate.test.ts` | **#28** | its regression coverage |
| `docs/POLYTOS-V1-LAUNCH-CONFIGURATION.md` | **#30** | the launch checklist lives on the docs branch |

**Verified — the split is exact and non-overlapping.** Each of the five files
exists on exactly one of the three PR branches, checked with `git cat-file`
against all three. After applying, each file was compared by object hash
against its `9d509d9` version: **all five byte-identical.** Nothing was
rewritten in transit and no change appears in two PRs.

**PR #29 was not touched.** Its head is the same commit it carried through
Phase 2 and Phase 3. The Owner-only operation and reconciliation safeguards —
`f9688df` "let the approval thresholds say no second signature" and `6e77efa`
— are preserved exactly.

### Final SHAs

| PR | Branch | Head SHA | State |
| --- | --- | --- | --- |
| **#28** security + cleanup tool | `claude/polytos-v1-security-integration-vtuml7` | `79d8397ccab9bcc10dc14047925f396359759987` | draft, open |
| **#29** Owner operation + reconciliation | `claude/polytos-v1-owner-operation-vtuml7` | `6e77efaabaa7dbc4c51c02c2dadba48c18fc0324` | draft, open, **unchanged** |
| **#30** launch documentation | `claude/polytos-v1-launch-readiness-docs-vtuml7` | `e97f96988a4d61af012cfd2a61961fb6b8cd9bc3` | draft, open |
| — | **combined integration** `claude/polytos-v1-release-integration-vtuml7` | `1397f1ab690653d00d40a6c1604d2cd22eead7c5` | pushed |
| — | base `claude/intelligent-knuth-2r8mpw` | `64ea09c73058b22ea8c31ccb9adf9efa31115632` | unchanged |

All three PRs remain **draft** and target `claude/intelligent-knuth-2r8mpw`,
not the default branch.

### The combined integration branch

Built fresh from base `64ea09c` by merging the three PR heads in order —
#28, #29, #30 — with no conflicts and no hand-edits.

**Verified — it is exactly the three PRs and nothing else:**

- all three heads are ancestors of the tip (`git merge-base --is-ancestor`);
- **172 migration files, zero duplicate version prefixes**;
- all 11 pending migrations come from #28 alone; #29 adds none and #30 adds
  none, so there is no path by which a migration could be duplicated;
- diffed against the Phase 3 verified tree (`0a1b89c`), the only differences
  are the Phase 3 report (which belongs to no PR) and the formatting fix
  below. No feature, schema object or dependency was added.

The Phase 3 and Phase 4A reports are deliberately **not** on the integration
branch: it is kept as a pure combination of the three PRs so that what is
reviewed is exactly what the PRs contain. Both reports live on
`ccr-84745867-cu3p1f`.

### One defect found during integration

`prettier --check` rejected `tests/db/clean-slate.test.ts`. Two assertions
added late in Phase 3 — the ones proving launch item A-1's impossible steps —
were written after the last Prettier run and never reformatted, so the Phase 3
commit as pushed would have failed CI's format gate. It did: run
[43371881291](https://github.com/JTREVORM/lending-manager/actions/runs/43371881291)
on `ccr-84745867-cu3p1f` concluded **failure**.

Fixed in `79d8397`, a formatting-only commit — one assertion rewrapped, the
statement and the expectation identical.

*Correction to the Phase 3 report:* it stated that `prettier --check` was
clean on every file touched. That was true when I ran it, but I edited the
test file twice afterwards and re-checked only the document. The claim was
stale for the commit that was actually pushed. The code was correct; the
formatting was not, and the gate caught it.

---

## 2. Test results

Everything below was **re-run locally against the integration branch
`1397f1a`**, on a disposable PostgreSQL 16 cluster with all 172 migrations
replayed from empty.

| Suite | Result |
| --- | --- |
| Migration replay | **172 applied to a clean database** |
| Database security gate | **pass** — "No unreviewed privileged exposure" |
| Database tests | **1,883 passed** (83 files) |
| Seeder — demo | **18 passed** |
| Seeder — borrower reuse | **15 passed** |
| Seeder — member loans | **24 passed** |
| Seeder — benefits | **25 passed** |
| **Clean-slate** | **33 passed** (25 original + 8 added in Phase 3) |
| Unit and integration | **2,645 passed, 6 skipped** (2,651 total) |
| Money arithmetic audit | **pass** — all five engines reach only integer/BigInt helpers |
| Upgrade + existing-borrower demo | **pass** — 26 tables preserved, ledger 17,685,808 both sides |
| Typecheck / lint / format | **pass** |
| Production build | **pass** |
| **Browser E2E** | **910 passed, 48 skipped** (16.2m) |

**Totals: 5,553 passed, 54 skipped, 5,607 total, zero failures.** The increase
over Phase 3's 5,545 is exactly the 8 clean-slate regression tests added for
the four defects.

**Verified independently by CI on the same commits.** These are not my runs:

| Commit | CI run | Conclusion |
| --- | --- | --- |
| integration `1397f1a` | [43377423492](https://github.com/JTREVORM/lending-manager/actions/runs/43377423492) | **success — 4/4 jobs, every step** |
| #28 `79d8397` | [43377335081](https://github.com/JTREVORM/lending-manager/actions/runs/43377335081) | **success** |
| #30 `e97f969` | [43376238072](https://github.com/JTREVORM/lending-manager/actions/runs/43376238072) | **success** |

The integration run's four jobs are `database (real PostgreSQL)`,
`checks, unit/integration, build`, `security release rehearsal (PostgreSQL 17,
real Auth)` and `browser E2E (production build, fresh seed)`. The PostgreSQL
17 job matters: it closes the fidelity gap between my local PostgreSQL 16 and
the hosted 17.11, including real Auth recovery and JWT renewal.

PR #29 is unchanged since Phase 2 and is covered green inside both the Phase 3
integration run (43285549603) and this one.

### The lending lifecycle

Covered twice, at two levels:

- **Database and RLS**, in the clean-slate suite, on the emptied database as
  the one Owner: register client with identity → add guarantor and the
  relationship → create → submit → approve → disburse → generate schedule →
  partial repayment → receipt → final repayment → **loan closure** → reports
  agreeing with the loan. Plus the refusals: a duplicate repayment does not
  take the money twice, an invalid repayment is rejected, and an unauthorised
  session is refused everything it should be.
- **In a real browser**, in the 910-test Playwright suite against a production
  build, a real PostgREST and a fresh seed — including the security specs
  (CSP with per-request nonce, the session cookie unreadable from JavaScript,
  the privileged key never reaching the browser, a borrower's phone number not
  readable anonymously, rate limits with `Retry-After`).

---

## 3. Clean-slate safety, verified on the integration branch

Each property was exercised against the built tool, not inferred from the
source.

**1. It defaults to a dry run.** `node scripts/clean-slate.mjs --owner <id>`
prints `DRY RUN (nothing was changed)`, reports it `Would empty 61 business
tables`, names the phrase needed to proceed, and exits 0 having changed
nothing.

**2. It refuses the wrong database project.** Three distinct refusals, all
firing *before the connection pool is opened*:

| Situation | Outcome |
| --- | --- |
| hosted-looking URL, `--execute`, no `--expect-project` | *"Refusing to empty a hosted database without confirming which one."* |
| `--expect-project fszgwemtgyrbhngajpzm`, URL names a different project | *"This is the wrong database. Nothing was changed."* |
| `--expect-project` given, URL names no project at all | *"The target identity cannot be confirmed, so it is not assumed."* |

The middle case is the one that matters operationally: the operator names the
project they are authorised for, and the connection string disagrees.

**3. The Owner cannot be removed by accident.** Five refusals, each observed:

| Given | Refusal |
| --- | --- |
| no `--owner` | *"the cleanup must be told which profile to keep"* |
| a profile id that does not exist | *"No profile …: refusing to empty the database."* |
| an inactive profile | *"… is inactive, not active: it could not sign in afterwards."* |
| an active profile without `owner_admin` | *"… does not hold owner_admin (holds: manager)."* |
| an `owner_admin` with no Auth identity | *"… has no auth_user_id … there would be no Auth user to preserve."* |

And on a real execute, the end state verified itself: **0** clients, loans,
payments, journal entries and journal lines; **debits and credits both 0**;
**exactly 1 active profile** holding `owner_admin`; **exactly 1 Auth user, and
it is the Owner's**; reference data intact (4 roles, 106 permissions, 35
ledger accounts, 5 cadences, 6 products); counters reset; no orphaned
references. The residue is reported plainly rather than glossed: the audit
entries and the deactivated profiles that cannot be deleted.

---

## 4. Remaining risks

| # | Risk | Severity | Position |
| --- | --- | --- | --- |
| 1 | **Policy 999.0 is still `active` on hosted.** It is the only active policy, so a real member could be enrolled on demonstration terms. | **High — the launch blocker** | The corrected one-line statement is ready in #30's A-1 and proven by test. Needs authorisation; not run. |
| 2 | **Hosted is 11 migrations behind** (161 of 172). | Medium | All 11 are on #28. None creates a table or touches `reference_formats`, so both cleanup guards still match — verified against the live hosted schema. Apply before the cleanup. |
| 3 | **The cleanup is irreversible.** 35 loans, 470 repayments, 597 journal entries and the rest are recoverable only from the logical dump. | **High by design** | The tool refuses a hosted run without `--i-have-a-dump`. Free `pg_dump`; no paid backup needed. |
| 4 | **Three staff Auth accounts can still sign in** against real financial records. | Medium | The cleanup deletes them. You have stated no staff are employed. |
| 5 | **Reconciliation has no distinct-actor rule** for a sole Owner. | Low for V1 | A known, documented control gap, not a regression. Close it in code when a second person handles cash. |
| 6 | **The PRs are unmerged and CI-green only on their own heads.** | Low | Merging changes the content under test. Re-run CI on the merge result, or merge the integration branch, which is already green as a unit. |
| 7 | **`stack.sh up` did not return in this container.** It blocked in `do_wait` on its `npm exec next start` child; `setsid` did not detach it here as it does on GitHub's runners. | Low — environment, not product | The stack itself was healthy (all three services 200, sign-in verified). I drove `verify.mjs` and Playwright directly and got 910/48. CI's own browser job is green on the same commit, so the product is unaffected. Worth knowing if anyone runs the harness in a similar container. |

No new product risk was introduced in this phase: the only code change since
Phase 3 is a line rewrap.

---

## 5. Proposed hosted execution order

Still **not authorised to run.** Steps 4 onward are destructive or
hosted-mutating.

**Review and merge (no hosted effect)**

1. Review the three PRs. Merge order into `claude/intelligent-knuth-2r8mpw`:
   **#28, then #29, then #30** — the order the integration branch was built
   in, and the order that keeps each CI run meaningful. Alternatively review
   and merge `claude/polytos-v1-release-integration-vtuml7` as one unit; it is
   already green end to end. **Not into the default branch.**
2. Confirm CI is green on whatever the merge produces.

**Prepare**

3. Take the free logical export and keep its checksum:
   `pg_dump "$DATABASE_URL" -Fc -f polytos-preclean-$(date -u +%Y%m%dT%H%M%SZ).dump`
4. Apply the **11 pending migrations** (`supabase db push`), so the security
   guards are in force before any real client data exists. Confirm
   `schema_migrations` reaches `20261112000100` and totals 172.
5. Agree the window. There is no maintenance mode in the application; the
   business has one Owner and no staff, so coordination plus the cleanup's
   single transaction is the control. Optionally point the Vercel production
   alias at a holding deployment for the window (free).

**Execute**

6. Dry run — expect `hosted connection: yes`, the Owner named, "Would empty 61
   business tables", and the hosted figures. **Stop if either guard refuses.**
7. The cleanup:

```sh
POLYTOS_CLEAN_SLATE=yes-empty-this-database \
node scripts/clean-slate.mjs \
  --owner 83944cea-eba0-4cec-989b-e44528b644f6 \
  --expect-project fszgwemtgyrbhngajpzm \
  --i-have-a-dump ./polytos-preclean-<stamp>.dump \
  --execute
```

Auth and Storage are handled inside the same transaction. Storage is a
verified no-op — 0 objects, 6 private buckets, untouched.

8. Retire policy 999.0 — launch item A-1, a separate authorisation:

```sql
update public.membership_policy_versions
   set status = 'superseded'
 where version = '999.0' and status = 'active';
```

**Verify**

9. Run the post-cleanup queries in the Phase 3 report §9.8: books empty and
   balanced, exactly one active profile and one Auth user, all 35 ledger
   accounts at zero, counters reset with `branch` untouched, configuration
   intact, no policy active. Record the audit watermark (`max(id)`, 1,682
   today) in the launch log — it is the line between demonstration history and
   real trading.
10. Register the first real client end to end: expect **CL26001**,
    **LN260001**, **PAY260001**, then settle and confirm closure and that the
    reports agree.

**Stop conditions.** Either guard refusing, the Owner pre-flight refusing,
`VERIFICATION FAILED` from the runner, or a first client not numbered `…001`.
A failure inside the transaction rolls everything back and leaves the database
as it was; diagnose and re-run rather than patching forward. Recovery from a
*completed* run is only from the dump.

---

## Authorisation boundaries observed

Code integrated and pushed to the three draft PR branches and a new
integration branch ✅ · full test suite re-run, database, security, unit,
integration and browser ✅ · cleanup safety verified ✅

Not merged into the default branch ✅ · not deployed to Vercel ✅ · no hosted
migration applied ✅ · no hosted Auth account changed ✅ · no policy retired ✅ ·
no hosted demonstration data deleted ✅ · no new Supabase project ✅ · no paid
subscription required ✅ · no product expansion and no new features ✅
