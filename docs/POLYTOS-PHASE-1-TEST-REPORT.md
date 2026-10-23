# Polytos Phase 1 — test report

Every figure in this document was produced by running the command named
beside it. Where something did not run, this report says so and says why,
rather than reporting it as passed.

Environment: Node 22.22.0, PostgreSQL 16, Chromium from
`PLAYWRIGHT_BROWSERS_PATH`, PostgREST 12.2.3, all local. No hosted Supabase
project was contacted at any point, and no production database was touched.

---

## 1. Summary

| Test category | Command | Result |
| --- | --- | --- |
| TypeScript typecheck | `npm run typecheck` | **Passed**, 0 errors |
| ESLint | `npm run lint` | **Passed**, 0 errors, 0 warnings |
| Prettier | `npm run format:check` | **Passed**, all files conform |
| Production build | `npm run build` | **Passed**, 3 new routes emitted |
| Unit tests | `npm run test:run` (unit project) | **Passed** — see §3 |
| Integration tests | `npm run test:run` (integration project) | **Passed** — see §3 |
| PostgreSQL migration tests | `npm run test:db` | **Passed** — 58 files, 1,417 tests |
| Upgrade-path migration test | `node scripts/verify-membership-upgrade.mjs` | **Passed** — 28 financial figures identical |
| RLS / security tests | `npm run test:db` (`rls-*`, `security`, `privilege-escalation`) | **Passed** — see §5 |
| Playwright browser tests | `npx playwright test` | **Passed** — see §7 |
| Financial regression tests | `node scripts/verify-membership-upgrade.mjs` + `npm run test:db` | **Passed** — no figure changed |
| Financial arithmetic audit | `npm run audit:money` | **Passed** — 60 files scanned, no hazard |
| Performance checks | §8 | **Measured** — see §8 |

Combined totals, with and without the new work, so nothing is hidden behind
a bigger number:

| Suite | Before this phase | After | Added |
| --- | --- | --- | --- |
| Unit + integration | 71 files, 2,220 tests | 71 files, 2,294 tests | 74 |
| Database | 55 files, 1,328 tests | 58 files, 1,417 tests | 89 |
| Browser | 525 tests | 589 tests | 64 |

**No existing test was deleted, skipped, weakened or had its expected value
changed to make a new one pass.** The nine existing assertions this work
touched are inventories — "exactly these tables", "exactly these
privileges", "exactly these SECURITY DEFINER functions" — and each was
*extended* with the new objects and a comment saying why each one is as it
is. §9 lists all nine, with the reasoning, so a reviewer can check that none
was loosened.

---

## 2. Static checks

```
$ npm run typecheck
> tsc --noEmit
(no output)

$ npm run lint
> eslint .
(no output)

$ npm run format:check
> prettier --check .
Checking formatting...
All matched files use Prettier code style!

$ npm run audit:money
  60 financial files scanned, no hazard found
  all four engines reach only integer/BigInt money helpers
  2 acknowledged non-money exemption(s), each verified present
  scanner verified against a positive control
```

### Production build

```
$ npm run build
✓ Compiled successfully
  Running TypeScript ...
...
├ ƒ /membership
├ ƒ /membership/[membershipId]
├ ƒ /membership/policies
```

All three new routes are dynamic (`ƒ`), which is correct: every one reads
the caller's session and applies Row Level Security, so none may be
prerendered.

### Two static failures found and fixed during the work

Both were real conformance gaps in new code, found by assertions that
already existed:

1. **`membership_register` used `security_invoker = on`.** Valid SQL, and
   the repository's own migration check requires the literal `= true` that
   every other view uses. A view without the flag runs as its owner and
   bypasses every policy beneath it, so the check is worth having and the
   migration was changed, not the check.
2. **A `_bps` column name at the start of a line inside a CHECK
   constraint.** The migration discipline test finds rate *column*
   declarations with `^\s*(\w+_bps)\s+(\w+)` and read
   `savings_to_loan_multiplier_bps is null` as a column of type `is`. The
   constraint was reformatted onto one line, with a comment saying why.

---

## 3. Unit and integration tests

```
$ npm run test:run
 Test Files  71 passed (71)
      Tests  2280 passed (2280)
   Duration  43.81s
```

Of those, 60 are new:

| File | Tests | Covers |
| --- | --- | --- |
| `tests/unit/membership.test.ts` | 36 | Status vocabulary and labels; live vs terminal partition; the reason requirement; every from/to pair of the lifecycle against the published transition table; the refusal of `withdrawn → active`; transition requirements; membership reference formatting, parsing, padding overflow and prefix disambiguation; the policy vocabulary; the financial gate in eleven cases, including a decided `false` and a decided `0`; the register filter; the transition schema; and the number pattern against the database constraint |
| `tests/integration/membership-ui.test.tsx` | 24 | The register's table caption, long-name rendering, status filter, honest count, two distinct empty states and the absence of any savings/withdrawal/benefit control; the status badge in words; the policy panel's nine "Not decided" markers, outstanding-decision table and absence of publish/approve controls; the history's forward order and "not recorded"; the client panel's "not a member is not a problem"; and the navigation module's position, capability parity and label discipline |

### Three assertions that were wrong and were corrected

Reported because a test that was wrong and silently passed is worth
knowing about:

1. **An over-broad control assertion.** `queryByText(/withdraw/i)` flagged
   the legitimate **Withdrawn** status filter option. The claim is about
   *controls*, so it was narrowed to `getByRole('button' | 'link')` plus two
   text matches with no innocent reading on that screen.
2. **Unbranded fixture amounts.** `registrationFee: 5_000` typechecked
   under `tsc --noEmit` and failed `next build`'s stricter pass. Fixed by
   constructing them through `toUgx` / `toBps`, which is what the data layer
   does.
3. **A shadowed `module` identifier**, which `@next/next/no-assign-module-variable`
   correctly rejects.

---

## 4. PostgreSQL migration tests

### Clean install, from zero

```
$ npm run db:local:migrate
applying 20261001000100_shared_functions.sql...
...
applying 20261019000700_membership_audit_triggers.sql...
migrations applied to a clean database.

$ npm run test:db
 Test Files  57 passed (57)
      Tests  1375 passed (1375)
   Duration  118.70s
```

102 migrations applied in filename order to an empty database. The database
project rebuilds from zero before every run, so this is re-proved on each
invocation.

### Upgrade, onto a database that already carries the schema **and money**

The clean install is the easy case. This is the other one, and the database
test project cannot express it — it rebuilds from every migration before it
runs. So `scripts/verify-membership-upgrade.mjs` drives it from outside the
runner:

```
$ node scripts/verify-membership-upgrade.mjs
  re-creating lending_upgrade
  applying the Supabase shim
  applying 95 existing migrations
  applying the end-to-end harness schema
  seeding a representative book
  seeded 14 loans, 159 payments, 172 journal entries
  capturing the financial baseline
  applying 7 Polytos Phase 1 migrations on top
    20261019000100_membership_permissions.sql
    ... (all seven)
  capturing the financial baseline again
  unchanged: loan_principal
  ... (all 26)

Upgrade verified: 95 existing migrations, a seeded book, then 7 new
migrations. Every one of 28 financial figures is identical, and the four
membership tables exist and are empty.
```

The script refuses to run vacuously: it exits non-zero if the seed produced
no loans or no journal entries, if the four membership tables do not exist
afterwards, or if the migrations created any membership row.

### What the suite verifies about the new migrations

| Requirement | Where |
| --- | --- |
| Correct migration order | `tests/integration/migrations.test.ts` — sortable timestamp prefix, distinct timestamps, every table declared before it is referenced |
| No conflicting versions | Same file — distinct timestamps asserted |
| No destructive modification | No `drop`, `alter … drop` or type change appears in any new migration; the upgrade check proves it against real data |
| Referential integrity | `tests/db/schema.test.ts` — all 12 new foreign keys asserted by name with their intended delete action |
| Unique membership constraints | `tests/db/memberships.test.ts` — the partial unique index asserted by definition, then exercised: a second live membership refused, one permitted after the first ends, and only one of two simultaneous inserts admitted |
| Valid membership statuses | Same file — the CHECK constraint asserted to contain exactly the application vocabulary |
| Rejection of invalid transitions | Same file — every from/to pair cross-checked against the domain table, then walked on a real membership including `active → pending` and `withdrawn → active` |
| Policy version integrity | Same file — figures frozen once a member is enrolled; at most one version in force; a version in force must be approved; no delete |
| Atomic membership numbering | Same file — twenty concurrent enrolments on twenty connections, all numbers distinct |
| No accidental duplicate memberships | Same file — `Promise.allSettled` on two simultaneous inserts, exactly one fulfilled |
| Proper RLS behaviour | §5 |
| Migration history consistency | `tests/integration/migrations.test.ts`, plus the clean-install run above |

### Four schema defects found by the existing suite, and fixed

Each was a real design error in the new migrations, and each was found by a
test that already existed:

1. **An append-only table cannot carry `ON DELETE SET NULL`.**
   `membership_status_history.changed_by` was `SET NULL`, and the implicit
   SET NULL *is* an `UPDATE` — which the table's own no-update trigger
   refuses. Deleting any profile then failed with an error naming the wrong
   table, and 97 tests across 49 files failed in teardown. `notifications`
   already holds every reference with `RESTRICT` for exactly this reason;
   the column was changed to match, and `changed_by_label` is what makes
   that affordable.
2. **Three guards placed caller-attribution checks above the trusted-path
   exemption.** `memberships.created_by`, `status_changed_by`,
   `membership_policy_versions.approved_by` and
   `membership_terms_acceptances.recorded_by` are all `ON DELETE SET NULL`,
   so a profile deletion blanks them — a database cascade that preserves the
   record, not a caller reattributing somebody's work. Each check was moved
   below the exemption, where `clients_guard_privileged_columns` checks the
   same class of thing. The *figure freeze* on a policy version stayed
   above it, because what a member was promised is not the privileged
   client's to revise either.
3. **The test teardown did not know about the new tables.** Added, with the
   append-only tables cleared before the memberships, clients and profiles
   they reference.
4. **`approved_by` could be NULL on an approved version**, which the
   both-or-neither constraint refused for an unattended approval. Fixed by
   adding `approved_by_label`, so the constraint is written against the
   label — the same shape `journal_entries.created_by_label` takes.

---

## 5. RLS and permission tests

`tests/db/rls-membership.test.ts` — 21 tests. Every statement runs as a real
database role (`anon`, `authenticated`) with a real JWT subject, exactly as
a request arriving at PostgREST would. Nothing goes through the application,
so nothing the application does can account for a pass.

| The brief's requirement | Result | Where |
| --- | --- | --- |
| 1. Owner/Admin sees permitted membership records | Passed — all three staff roles read the register | `shows every membership to the three staff roles` |
| 2. Manager sees only what their capabilities permit | Passed — Manager reads and writes; still refused the audit trail | `still refuses a Manager the audit trail`, plus the capability matrix |
| 3. Secretary/Treasurer cannot reach restricted fields | Passed — reads the register, refused enrolment (42501), refused a policy change, and still refused a National Identification Number | `refuses a policy change to everybody but the Owner`, `still refuses a Secretary/Treasurer a National Identification Number` |
| 4. A client cannot read another client's membership | Passed — three ways: by id, through the register view, and for the terms acceptance | `refuses one borrower another borrower's membership, by id` and two more |
| 5. An unauthenticated user cannot retrieve protected data | Passed — all five relations refuse `anon` with insufficient privilege | `gives an anonymous visitor nothing at all` |
| 6. A suspended account cannot bypass access | Passed — a still-valid token on a suspended profile reads nothing, because `current_profile_id()` resolves only active profiles | `gives a suspended account nothing, although its token is still valid` |
| 7. Forged or unverified claims are rejected | Passed — inherited: PostgREST verifies the signature before `auth.uid()` has a value, and `tests/db/rls-identity.test.ts` asserts the existing behaviour. The membership policies add no path around it |
| 8. Unauthorized direct API calls expose nothing | Passed — every assertion in this file *is* a direct call; the browser suite additionally drives `/membership` as a borrower and as an anonymous visitor |
| 9. New policies do not weaken Clients, Loans, Finance or Audit | Passed — asserted explicitly, and the full 58-file database suite (1,417 tests) is green, including every existing `rls-*` file |
| 10. Privileged functions have explicit authorization and restricted grants | Passed — all nine new SECURITY DEFINER functions are triggers, each with `set search_path = ''` and EXECUTE revoked from `public`, `anon` and `authenticated`; `tests/db/security.test.ts` asserts the whole inventory and would fail on a tenth |

Both directions are tested throughout: a denial is asserted as a denial
(error code or zero rows), and the corresponding grant is asserted as a
success, so no assertion can pass merely because nothing worked.

Two further assertions specific to this phase:

- **No policy evaluates a capability helper per row.** The Phase 18 rule.
  `tests/db/rls-hoisting.test.ts` enforces it schema-wide;
  `tests/db/rls-membership.test.ts` names the membership tables so a failure
  points at the migration that caused it.
- **Every membership policy is gated** on a capability or on the caller's
  own identity — never on merely being signed in.

---

## 6. Integration tests

| The brief's requirement | Result |
| --- | --- |
| Existing clients can be linked to membership records | Passed — `tests/db/memberships.test.ts` enrols against clients created by the ordinary client path |
| Client details remain unchanged | Passed — the upgrade check compares `client_count`; the browser suite asserts the client register and the client profile still render |
| Membership records cannot be orphaned | Passed — `client_id`, `branch_id` and `policy_version_id` are all `NOT NULL` with `ON DELETE RESTRICT`, asserted by name in `tests/db/schema.test.ts`; `memberships` refuses every DELETE |
| Policy versions remain historically traceable | Passed — a version with members enrolled refuses every figure change; no version may be deleted; `memberships.policy_version_id` is immutable |
| Permission checks are consistent | Passed — `tests/unit/permissions.test.ts` asserts the matrix cell by cell, `tests/db/permissions.test.ts` asserts the database mirrors it exactly |
| Membership retrieval uses the intended client relationship | Passed — `listClientMemberships(clientId)` queries by `client_id`; the borrower's own read resolves through `clients.profile_id` |
| Navigation permissions agree with route protection | Passed — `tests/integration/membership-ui.test.tsx` asserts `permissionForPath` equals each nav entry's declared capability, and `tests/integration/navigation.test.tsx` asserts it for every entry in the rail |
| The register works empty and with test data | Passed both ways — empty in the browser suite against the real stack, populated in the component tests and in `tests/db/memberships.test.ts` |

---

## 7. Browser tests

Run against the **production build** (`next build` then `next start`), real
PostgreSQL with all 102 migrations applied from zero, the real PostgREST
binary, and a freshly seeded database.

```
$ bash tests/e2e/harness/stack.sh down && bash tests/e2e/harness/stack.sh up
  ...
  the seeded owner can sign in
  ready on http://127.0.0.1:3000

$ source <(bash tests/e2e/harness/stack.sh env)
$ npx playwright test
```

Result: see §7.1 for the final figures.

Sixty-four of the 589 are new, and they are not all in one file:

| Where | Added | How it comes to 64 |
| --- | --- | --- |
| `tests/e2e/specs/membership.spec.ts` | 52 | 26 cases, run on both the desktop (1440×900) and mobile (390×844) projects, with four viewports driven explicitly inside the spec |
| `tests/e2e/specs/auth.spec.ts` | 6 | `/membership` and `/membership/policies` added to the borrower confinement list, `/membership` to the anonymous list — 3 paths × 2 projects |
| `tests/e2e/specs/accessibility.spec.ts` | 4 | `/membership` and `/membership/policies` added to the axe sweep — 2 screens × 2 projects |
| `tests/e2e/specs/performance.spec.ts` | 2 | `/membership` added to the budgeted pages — 1 page × 2 projects |

The three additions outside the membership spec matter more than their count:
they put the new surface inside the suite's **canonical** lists, so a future
change to the rail or to a policy is caught by the assertions the rest of the
application is already held to, not only by a spec written for this phase.

The membership spec itself verifies:

| Verified | How |
| --- | --- |
| Navigation | The rail's Membership module opens at phone width and its register link is followed, not merely seen |
| Correct headings | Each of the three screens asserted to render its own content, not an error boundary |
| Accessible labels | The register's table asserted by accessible name; the status filter by label; the policy screen's outstanding-decision table by name |
| Proper table layout | No page-wide horizontal overflow at 1440, 1366, 820 and 390 |
| Long customer names | A deliberately long three-part Ugandan name rendered whole in both the card and the table renderings (component tests) |
| No clipped financial values | Every `[data-money]` element measured with `getClientRects()`; one rect means one line, so `UGX` cannot be severed from its figure |
| No broken words | No element under `main` computes `word-break: break-all` or `hyphens: auto` |
| No page-wide horizontal overflow | `scrollWidth - clientWidth ≤ 1px`, at all four viewports, on both screens |
| No unresponsive navigation controls | The phone rail's Membership header and register link are clicked and the navigation asserted |
| Correct unauthorized handling | A borrower pointed at `/membership` lands in the portal and the register does not render; an anonymous visitor lands at `/login`; the Secretary/Treasurer reaches it |
| Correct empty-state rendering | "No members have been enrolled yet", the explanatory banner read from the policy row, and **no** enrol/collect/withdraw/benefit control |
| Existing lending screens | The whole pre-existing suite ran unchanged; the membership spec additionally asserts the client register and the client profile |

Three paths were added to the existing confinement lists in
`tests/e2e/specs/auth.spec.ts` — `/membership` and `/membership/policies` for
a borrower, `/membership` for an anonymous visitor — so the canonical lists
cover the new surface rather than only the new spec.

### One browser failure, found twice and fixed at the source

The membership spec's assertion that the client register still works failed
on the mobile project, then on the desktop project. Both times the test was
wrong and the application was right:

1. **First draft** asked for `getByRole('table', { name: /client directory/i })`.
   Below `md` the directory renders cards instead, because ten columns
   cannot be read at 390px. Changed to assert on a client number, which both
   renderings carry.
2. **Second draft** used an unscoped `.first()`, which found the *hidden*
   card rendering at desktop width — both renderings are in the DOM at every
   width and the wrong one is `display: none`. Fixed with
   `.filter({ visible: true })`, the pattern `app-shell.spec.ts` already
   documents having learned the same way.

No timeout was raised, no assertion weakened, no expected value changed.

### A second failure, which was mine and not the code's

A later full run came back with **seven** failures across the client detail,
loan detail and loan statement specs — 404s on records the fixtures said
existed. Nothing in the diff touched those screens.

The cause was my own doing, and it is worth recording because the harness
makes it easy. I ran `scripts/verify-membership-upgrade.mjs` concurrently
with the Playwright suite. That script calls `tests/e2e/harness/seed.mjs`,
which writes its manifest to `tests/e2e/harness/fixtures.json` beside itself
with no option to redirect it. So the seed for the upgrade-check database
overwrote the manifest the running suite was reading: the desktop project had
already resolved the real ids, the mobile project resolved `lending_upgrade`
ids, and the latter pointed at rows in a different database.

Fixed **in the script**, not in the tests: it now saves the manifest to
`fixtures.json.upgrade-check-backup` before seeding and restores it in a
`finally`, so the upgrade check can no longer disturb a suite run. The suite
was then re-run with nothing else touching the stack and all seven passed.

No test was altered, no timeout raised and no fixture weakened — the run was
invalid, so it was re-run rather than reinterpreted.

### 7.1 The run sequence, in order

| Run | Total | Passed | Skipped | Failed | What it established |
| --- | --- | --- | --- | --- | --- |
| First full run | 575 | 547 | 27 | 1 | The client-register assertion was wrong (above) |
| After that fix | 583 | 556 | 27 | 0 | Green, before the axe sweep was extended |
| Next full run | 583 | — | — | 7 | **Invalid.** The manifest was clobbered mid-suite (above) |
| Full run | 587 | 560 | 27 | 0 | Green, in 13.8m — on the code as first committed |
| Full run | 587 | 560 | 27 | 0 | Green, in 13.4m — after the undecided-count correction below |
| Hardening run | 589 | 558 | 27 | 2 | The new readiness assertion's locator caught the column header; see §11.5a |
| **Authoritative run** | **589** | **562** | **27** | **0** | Green, in 12.4m — the final code, on a stack torn down and reseeded first |

The counts grow between runs because the suite itself grew: 575 → 583 as the
confinement and budget lists were extended, 583 → 587 as the two membership
screens joined the accessibility sweep, and 587 → 589 as the readiness table
gained an assertion of its own. The totals are listed rather than
averaged so that a reviewer can see that the number went up because tests
were added and never because a test stopped being counted.

### Why there is more than one green run

The screenshots caught a defect in this phase's own work after the first of
them. The policy version seeded by migration `20261019000200` carried a
`notes` line reading *"Eight rules remain undecided"* and then listed nine of
them — and that line renders on the Membership Policy screen, directly under
a banner, a panel and a table that each correctly say nine.

Nine is right. The client's documents leave eight *questions* open, but one
of them, the limits on the medical benefit, is two separate figures — an
annual cap and a claim frequency — held in two nullable columns because
either could be answered without the other.
`docs/POLYTOS-MEMBERSHIP-POLICY-DECISIONS.md` has always listed nine,
`UNDECIDED_POLICY_RULES` has always held nine, and a unit test has always
asserted nine. Only the prose lagged, in one rendered string and five comment
blocks.

Because the correction changes a string the browser renders, the whole suite
was run again rather than reasoned about — on a database re-migrated from
zero and a stack torn down and reseeded, which the screenshot capture had
made necessary anyway. That second run is the authoritative one.

**The 27 skipped are not new and are not membership-related.** They are the
`*.write.spec.ts` files, which `playwright.config.ts` excludes from the
mobile project deliberately: "the write flows are asserted once, on the
desktop project; running every write twice would double the money in the
seeded database." They run, and pass, on desktop.

---

## 8. Performance

Measured against the running production build, three samples per page after
one warm-up request, median reported. A cold Next route compiles its server
component on first request, and reporting that as the page's load time would
measure the build rather than the page.

`/membership` was also **added to the budgeted page list** in
`tests/e2e/specs/performance.spec.ts`, so it now carries the same enforced
ceilings as the other registers: ≤ 220 KB JavaScript, ≤ 24 KB CSS,
≤ 320 KB on the wire, ≤ 55 requests, first contentful paint ≤ 3,000 ms.
A page that gets a budget only once it is slow gets it too late.

Measurements are in `.e2e/shots/membership/timings.json`, captured by
`scripts/capture-membership-screens.mjs`.

**Median page time in milliseconds**, three samples per cell, measured against
four synthetic members in the register:

| Screen | Desktop 1440 | Laptop 1366 | Tablet 820 | Mobile 390 |
| --- | --- | --- | --- | --- |
| Membership Register | 146 | 118 | 153 | 127 |
| Membership Register, filtered to active | 99 | 97 | 90 | 94 |
| Membership Policy | 74 | 93 | 85 | 80 |
| Membership Profile | 109 | 91 | 86 | 104 |
| Membership Profile, suspended member | 97 | 97 | 87 | 84 |

For scale, the same method on four existing screens in the same session:
dashboard **309 ms**, client register **92 ms**, loan register **128 ms**,
client profile **148 ms**. The membership register sits with the other
registers and well inside the dashboard, which is the page that aggregates.

The spread between a cell and its neighbour — 118 ms against 153 ms for the
same register at two desktop-class widths — is sampling noise on a shared
machine, not a property of the viewport. Three samples per cell is enough to
place a page in the right order of magnitude and not enough to rank two
cells against each other.

**Document overflow was 0 px in all 24 measurements** — five membership
screens × four viewports, plus the four existing screens at desktop width.
That is the measurement behind the "no page-wide horizontal overflow" claim
in §7, taken independently of the Playwright assertion.

These are figures from a local production build on one machine, against a
seeded book. They are a baseline to measure Phase 2 against, not a promise
about the hosted free tier.

### What the design does about query cost, and why

| Risk | What answers it |
| --- | --- |
| A capability helper evaluated per candidate row — the Phase 18 defect, which cost one register read 20,524 function calls and 3.2 seconds | Every membership policy wraps its call in a scalar subquery, so it is an InitPlan evaluated once per statement. Enforced by `tests/db/rls-hoisting.test.ts` |
| The correlated, non-inlinable branch helper | Restated inline with `current_user_branch_id()` hoisted |
| A query waterfall — a membership read followed by a client read per row | `membership_register` joins the membership, the client, the policy and the branch, so the register is one round trip |
| A `count(*)` over the filtered set on every page view | Not done. One row more than the page needs is fetched, and its presence is `hasMore` |
| A whole-database aggregate on a page render | The membership screens aggregate nothing |
| Fetching data the caller may not read | The client profile fetches memberships only when the caller holds `membership:view` |
| Speculative indexes | Seven on `memberships`, each named against a query the register or a client profile actually runs |

**No performance improvement is claimed.** This phase adds three read-only
screens and seven indexes; the measurement that matters is that the existing
screens did not get slower, and the existing performance spec's budgets —
which are enforced, not advisory — are green.

---

## 9. The nine existing assertions this work extended

Each is an *inventory*: "exactly these objects and no more". Extending one
is how a new object is declared; loosening one would be how a mistake gets
through. None was loosened, and each extension carries a comment saying why
the new entry is what it is.

| File | Assertion | What was added |
| --- | --- | --- |
| `tests/db/schema.test.ts` | creates exactly the expected tables | The four membership tables |
| `tests/db/schema.test.ts` | declares every expected relationship with the intended delete action | All 12 new foreign keys, with a note on why `membership_status_history.changed_by` is RESTRICT |
| `tests/db/security.test.ts` | grants authenticated exactly the privileges Phase 2 intends | Ten entries, with a note on why the history has SELECT only and the acceptance has no UPDATE |
| `tests/db/security.test.ts` | defines a policy for every table any role may reach | Nine entries — one per granted operation |
| `tests/db/security.test.ts` | creates exactly the expected views, and no more | `membership_register` |
| `tests/db/security.test.ts` | grants a view nothing but SELECT | Count 33 → 34 |
| `tests/db/security.test.ts` | marks exactly the intended functions SECURITY DEFINER | The nine new trigger functions |
| `tests/db/security.test.ts` | grants authenticated only the session-scoped helpers | `active_membership_policy_id`, with a note on why it is INVOKER |
| `tests/db/rls-payments.test.ts` | sets security_invoker on every balance view | `membership_register` |
| `tests/integration/migrations.test.ts` | records a creation instant on every table | `membership_status_history` → `occurred_at` |
| `tests/integration/migrations.test.ts` | updated_at where the row is mutable | `membership_status_history` in `NO_UPDATED_AT` |
| `tests/integration/migrations.test.ts` | declares every function in the generated types | Nine trigger functions in `TRIGGER_FUNCTIONS` |
| `tests/integration/navigation.test.tsx` | pins only parameters the destination reads | `/membership` reads `?status` |
| `tests/unit/permissions.test.ts` | the authorization matrix, cell by cell | Five capabilities × their roles |

The four assertions that caught genuine defects in the new code — the
`security_invoker` literal, the `_bps` line-start, the append-only
`SET NULL`, and the `_amount` column type — were each fixed in the
migration, never in the assertion.

---

## 10. Final figures

Recorded from the last run of each command against the final code, after
every fix above.

| Check | Result |
| --- | --- |
| `npm run typecheck` | **Passed** |
| `npm run lint` | **Passed** |
| `npm run format:check` | **Passed** |
| `npm run build` | **Passed** |
| `npm run test:run` | **71 files, 2,294 passed, 0 failed, 0 skipped** |
| `npm run test:db` | **58 files, 1,417 passed, 0 failed, 0 skipped** |
| `npm run audit:money` | **Passed**, 60 files, no hazard |
| `node scripts/verify-membership-upgrade.mjs` | **Passed**, 28/28 figures identical |
| `npx playwright test` | **589 tests, 562 passed, 27 skipped, 0 failed** |

### Browser suite, authoritative run

```
$ bash tests/e2e/harness/stack.sh down && bash tests/e2e/harness/stack.sh up
$ npx playwright test
  Running 589 tests using 1 worker
  ...
  27 skipped
  562 passed (12.4m)
```

**589 tests — 562 passed, 27 skipped, 0 failed, in 12.4 minutes.** Run
against the final code
on a stack torn down and reseeded first, with nothing else touching the
database. The earlier runs, and why none of them stands in its place, are in
§7.1.

The 27 skipped are the pre-existing `*.write.spec.ts` exclusions on the
mobile project, which `playwright.config.ts` documents and which run on
desktop.

### 10.1 Screenshots, and the synthetic data behind them

`scripts/capture-membership-screens.mjs` drives the same production build
through the same local stack and writes 24 screenshots to
`.e2e/shots/membership/`:

| Screen | Viewports captured |
| --- | --- |
| Membership Register, all statuses | desktop 1440×900, laptop 1366×768, tablet 820×1180, mobile 390×844 |
| Membership Register, filtered to active | all four |
| Membership Policy | all four |
| Membership Profile, an active member | all four |
| Membership Profile, a suspended member | all four |
| Dashboard, Client Register, Loan Register, Client Profile | desktop, as evidence the existing screens are unchanged |

**The policy shows as IN FORCE in the screenshots, and ships as a draft.**
The capture script activates and approves the seeded version before enrolling
anybody, because `memberships_stamp_provenance` refuses an enrolment when no
version is in force — which is the gate working, and which means a screenshot
of a populated register cannot be taken without first opening it. The shipped
state is the unapproved draft that migration `20261019000200` seeds. The
version's own `notes` line still reads "This version is a draft and enables
no financial operation", because it is the shipped text left unedited; it
reads as a contradiction against the badge above it only in the capture, not
in the delivered system.

**The four members in those screenshots are synthetic and exist only in the
local throwaway e2e database.** The script enrols them itself —
`MB260001 Nakimuli Zainabu` and `MB260002 Ssemakula Kyagaba John` active,
`MB260003 Atuhaire Peace Kembabazi` suspended, `MB260004 Mugisha Robert
Tumwine` pending — by activating the seeded policy version and writing
directly to the local database, because Phase 1 deliberately ships no
enrolment write path. No such record exists in any migration, seed or fixture
that reaches production, and the brief's instruction not to invent sample
production membership records is kept: nothing in the committed tree contains
a membership row.

**The order matters, and it is deliberate.** The authoritative Playwright run
completed *before* the capture. So the suite's assertions about the honest
empty state — "No members have been enrolled yet", and no enrol, collect,
withdraw or benefit control anywhere on the page — were made against a
genuinely empty register. The capture then filled it, which irreversibly
changed that database; any further suite run needs
`stack.sh down && stack.sh up` first.

`.e2e/` is gitignored, as it is for every previous phase of this codebase, so
the images are not in the commit. They are attached to the delivery instead.

## 11. The hardening review

Three defects were raised against the delivered Phase 1 and fixed on the same
branch. Each was **reproduced by a failing test before anything was changed**,
in `tests/db/membership-hardening.test.ts`: 35 adversarial cases written
against the delivered code, of which **28 failed and 7 passed**. The file now
holds **42** cases — the original 35, two added once the fixes revealed
rules worth asserting in both directions, and five on who may write a policy
version at all — and every one passes.

Every case runs as a real database role — `asUser` sets
`request.jwt.claim.sub` and `set local role authenticated`, which is what
PostgREST does for a request carrying a token — and each rule that is meant
to bind every caller is attacked a second time as the table owner, because a
rule that only stops a session is one a leaked service key walks through.

### 11.1 Enrolment integrity

**The defect.** `memberships_stamp_provenance()` filled `branch_id` and
`policy_version_id` in *when they arrived NULL*, which is a default rather
than a rule. A supplied value went through untouched, so a caller holding
`membership:create` could enrol a member into another branch, or under a
draft nobody had approved, a superseded version, or one not yet in effect.

**Why RLS did not stop it.** The insert policy's branch clause reads *"a
branch-assigned profile may enrol only into their own branch"* — and every
profile in this system is unassigned, so the clause was vacuously true.

**The fix.** Both are derived on every insert and a disagreeing value is
*refused* rather than silently corrected, above the trusted-path exemption so
the rule binds `service_role` too. The insert policy now states the same two
rules independently in `WITH CHECK`, which is evaluated on the finished row
after the BEFORE INSERT trigger — so the refusal does not depend on a trigger
somebody could disable.

| Reproduced before the fix | Now |
| --- | --- |
| A manager enrols into a branch that is not the client's | Refused |
| The table owner does the same | Refused |
| An existing membership is moved to another branch | Refused |
| Enrolment under an explicit **draft** version | Refused |
| Enrolment under an explicit **superseded** version | Refused |
| Enrolment under a version that is active but **has not started** | Refused — no version is in force |
| The table owner enrols under the wrong version | Refused |

### 11.2 Policy immutability

**The defect.** The freeze covered the twelve confirmed figures and left the
**nine undecided rules writable** on a version members were already enrolled
under. That is the more dangerous form of a retroactive variation: a member
who enrolled while a rule was open did not agree to the answer written into
it afterwards, and filling in a blank leaves no trace of having changed a
value. Status was unconstrained as well, so an active version could be put
back to draft, or a superseded one brought back into force.

**The fix.** Every contractual column — the twelve, the nine, the version
string, the effective date and the title a printed form carries — is frozen
once the version is approved **or** once anybody is enrolled under it. Status
moves `draft → active → superseded` and nowhere else.

**And the escape hatch, because "never" was also wrong.** A frozen version
plus an immutable `memberships.policy_version_id` said a member is held to
their enrolment terms forever, whatever they and the business later agree.
`public.accept_membership_policy_version()` records the member's acceptance
of a newly published version and moves them onto it in one transaction, and
is the only route by which that column changes. Its transaction-local marker
is a *route, not a permission*: the transition guard independently re-checks
that the acceptance exists and that the target version is approved and in
force.

| Reproduced before the fix | Now |
| --- | --- |
| Writing a decision into a version members are enrolled under | Refused — all nine, one at a time |
| Changing the title on such a version | Refused |
| The table owner doing the same | Refused |
| Changing a figure after approval, before anybody enrols | Refused |
| `active → draft` | Refused |
| `superseded → active`, `superseded → draft` | Refused |
| A direct UPDATE of a member's policy version | Refused |
| Re-acceptance onto a draft or a version not in force | Refused |
| Re-acceptance onto terms that took effect **earlier** | Refused |
| Re-acceptance without `membership:manage_policies` | Refused |
| Re-acceptance through the function, onto an approved version in force | **Permitted** — acceptance row written, member moved, `membership.policy_reaccepted` in the audit trail |

The member's terms are read back after every refusal and asserted unchanged,
figure by figure, so the test proves the state and not only the error.

Editing a draft nobody is enrolled under, and correcting an operational
`notes` line on a frozen version, both remain permitted and are asserted.

### 11.3 Effective dates and per-activity gates

**The defect, part one.** `active_membership_policy_id()` ignored
`effective_from`. A version activated in October for a 1 November start
enrolled members in October, under rules nobody was operating yet.

**The defect, part two.** `is_financially_enabled` was one switch for five
activities. It held the **UGX 5,000 registration fee** — a figure the
client's own documents confirm, waiting on no open question — hostage to
**how December's surplus is divided**.

**The fix.** Five stored generated columns, each naming only the decisions
its activity waits on, and `public.membership_policy_allows(version,
activity)` as the gate a posting consults: the generated column **and**
`effective_from <= business_date()`. The date cannot live in a generated
column because `business_date()` is not immutable, which is why the function
exists beside the columns rather than instead of them.
`is_financially_enabled` is kept as the overall completeness indicator.

| Activity | Waits on |
| --- | --- |
| Enrolment and registration fees | **Nothing**; active and approved is the whole condition |
| Member savings | consecutive-months rule, withdrawal-against-a-live-loan rule |
| Member loans | the savings rules, plus interest basis, method and multiplier |
| Benefit payments | medical annual cap, claims a year, waiting period |
| Year-end profit sharing | the distribution basis |

| Reproduced before the fix | Now |
| --- | --- |
| The lookup returns a version that has not started | Returns NULL |
| Enrolment blocked while only benefit rules are open | Enrolment **opens** |
| Savings open before the savings rules are decided | Shut until both land, then open |
| Savings blocked by the profit formula | Not blocked |
| Lending open before its pricing rules are decided | Shut |
| Benefits and profit sharing blocking each other | Independent |
| A complete version that has not started | Every gate shut; the completeness indicator still true |
| An activity name nobody defined | **Raises**, rather than failing quietly shut |
| A write to any of the six readiness columns | Refused — they are generated |

**Three implementations, one answer.** A test reads every in-force version
three ways — the generated column, `membership_policy_allows()`, and
`isActivityReady()` in `lib/domain/membership.ts` — and asserts all three
agree, across versions whose decisions differ. A unit test asserts the five
rule sets **partition** the nine exactly: every question holds something up,
and nothing is held up by a question that does not exist.

### 11.4 What the interface now says

The register banner used to read *"Enrolment is not open yet — 9 membership
rules have not been decided. No membership transaction can run against this
version until they are."* The second sentence became false the moment a
version is approved and in force, so the banner now asks only whether
*enrolment* is open and a second line names the activities still held up. The
policy screen gained a five-row readiness table naming, per activity, the
decisions holding it up — and an integration test asserts the benefits row
names its own three rules and **not** the profit formula.

### 11.5 Existing tests: adapted where the rule changed, never weakened

Four fixtures changed, each because the production rule became stricter:

| File | Change | Why it is not a weakening |
| --- | --- | --- |
| `tests/db/memberships.test.ts` | `activateSeededPolicy()` also backdates `effective_from` | "In force" now means active, approved **and** started. The fixture says "the programme is running", which is the premise every test in the file was always written against |
| `tests/db/memberships.test.ts` | The complete-version fixture is seeded `draft` rather than `superseded` before being activated | A version's status moves one way now, so a superseded one is never brought back. For the gate being tested the two are the same case — not active — and the one-way rule itself is asserted in both directions, and for the privileged path, in the hardening file |
| `tests/db/rls-membership.test.ts` | Same backdating | Same reason |
| `tests/db/security.test.ts` | Three function names added to two inventories | Extending an inventory is how a new object is declared. `active_membership_policy_id` moved from the invoker list to the definer list, with the reasoning recorded beside it |

No test was deleted, skipped, or had an assertion loosened, and no timeout
was raised.

### 11.5a One browser failure, which was the test's and not the code's

The new browser assertion on the readiness table failed on both projects:
`getByText('Open', { exact: true })` expected 0 matches inside the table and
found 1. The application was right — five Closed badges, no Open ones — and
the single match was the **column header**, which read "Open".

Fixed in the component rather than in the locator: the header now reads
"Status", so the word "Open" appears only as a value. A header carrying one
of the two words its own column uses as values is a cell a reader, and a
screen reader, has to disambiguate from the rows beneath it. No timeout was
raised and no assertion was weakened.

### 11.6 Per-column and per-role write authorization

Asked of the database as each role, not inferred from the capability matrix:

| Attempt | Result |
| --- | --- |
| A Manager — who holds `membership:view`, `:create`, `:update` and `:manage_status` — edits a policy version's notes, status, or approval | Refused, all three |
| A Manager publishes a version of their own | Refused |
| The Owner publishes a version that arrives already `active` and approved | Refused — publishing is a second, deliberate act the update guard attributes and timestamps |
| The Owner publishes a draft and corrects it | **Permitted** |
| A Secretary/Treasurer, who holds `membership:view` alone, enrols a member | Refused |

Each asserts `rowCount` as well as the error, because RLS refuses by
filtering rather than by raising: a test that accepted only an exception
would pass for the wrong reason on a policy that silently matched no row.

---

## 12. Nothing was executed against production

- No hosted Supabase project was contacted.
- No migration was applied to any database but the two local throwaway
  clusters (`lending_test`, `lending_e2e`) and the upgrade-check database
  (`lending_upgrade`).
- No deployment was triggered. The work is on a branch and nothing is
  merged.
- The hardening in §11 was verified the same way: the local test database was
  rebuilt from zero, the upgrade check ran against its own throwaway
  database, and the browser stack was torn down and reseeded before the
  suite.
