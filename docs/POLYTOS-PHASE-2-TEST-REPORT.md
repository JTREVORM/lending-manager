# Polytos Phase 2 — test report

Every figure in this document was produced by running the command named beside
it. Where something did not run, this report says so and says why, rather than
reporting it as passed.

Environment: Node 22.22.0, PostgreSQL 16, Chromium from
`PLAYWRIGHT_BROWSERS_PATH`, PostgREST 12.2.3, all local.

**No hosted Supabase project was contacted at any point.** No migration was
applied to a hosted database, no hosted demonstration record was created,
changed or deleted, and the connection named `Primary` was never opened — its
project reference is deliberately recorded nowhere in this repository, and the
demonstration seeder's allow-list refuses every project but one.

---

## 1. Summary

| Test category | Command | Result |
| --- | --- | --- |
| TypeScript typecheck | `npm run typecheck` | **Passed**, 0 errors |
| ESLint | `npm run lint` | **Passed**, 0 errors, 0 warnings |
| Prettier | `npm run format:check` | **Passed**, all files conform |
| Production build | `npm run build` | **Passed**, 8 new routes emitted |
| Unit + integration | `npm run test:run` | **Passed** — 73 files, 2,389 tests |
| Database suite | `vitest run --project db` | **Passed** — 61 files, 1,497 tests |
| Demonstration seeder | `vitest run --project seed` | **Passed** — 18 tests |
| Upgrade path + financial regression | `node scripts/verify-membership-upgrade.mjs` | **Passed** — 28 figures identical |
| Financial arithmetic audit | `npm run audit:money` | **Passed** — 60 files, no hazard |
| Browser tests | `npx playwright test` | **Passed** — see §7 |

### Totals, with and without this phase

Stated both ways so nothing is hidden behind a bigger number.

| Suite | Before Phase 2 | After | Added |
| --- | --- | --- | --- |
| Unit + integration | 71 files, 2,301 tests | 73 files, 2,389 tests | 88 |
| Database | 58 files, 1,417 tests | 61 files, 1,497 tests | 80 |
| Demonstration seeder | — | 1 file, 18 tests | 18 |
| Browser | 589 tests | see §7 | 48 |

**No existing test was deleted, skipped, weakened, or had its expected value
changed to accommodate this phase** — with four exceptions, each of which is a
Phase 1 assertion that Phase 2 made *factually wrong*, rewritten to the new
truth rather than relaxed. They are listed in §9 with the before and after, so
a reviewer can check that judgement rather than take it.

---

## 2. The two defects these tests found

Both were in code that read correctly, typechecked, and would have passed any
test written from the implementer's side. Both needed a test that asked *what
does somebody with a valid token and a copy of curl actually get?*

### 2.1 Three posting functions replayed an idempotency key before checking the capability

`post_savings_deposit`, `post_savings_withdrawal` and `record_membership_fee`
each took the advisory lock, looked for an existing movement, and returned it
— **before** resolving the actor or checking the capability. The early return
hands back a transaction or receipt id, which is a read of somebody else's
movement.

A caller holding no savings capability could replay a key and be handed the id
of the deposit it belonged to.

- **Found by:** `tests/db/rls-savings.test.ts` → *"refuses the replay to a
  caller who holds no deposit capability"*.
- **Fixed by:** moving the actor resolution and the capability check above the
  lock and the lookup in all three functions. See ADR-056.
- **Now asserted:** the refusal arrives whether or not the key already exists.

### 2.2 Three reporting functions were SECURITY DEFINER with no authorisation check

`savings_statement`, `member_savings_qualification` and `savings_summary` were
all written SECURITY DEFINER — by habit, because the other definer functions
in this schema are definer because they *write* something no session may write.
These three write nothing, and a definer function is not filtered by the
policies on the tables it reads.

**Any signed-in caller could read any member's full savings statement and
their whole contribution history by passing an account id.** A member could
read another member's savings; so could a loan officer with no savings
capability at all.

- **Found by:** `tests/db/rls-savings.test.ts` → *"gets nothing from the
  statement function for an account that is not theirs"*.
- **Fixed by:** the two that report **a member** are now SECURITY INVOKER, so
  the policies decide. `savings_summary` stays definer because it reports the
  business, and checks `savings:view_reports` itself. See ADR-057.
- **Now asserted:** `tests/db/security.test.ts` names both invoker functions in
  the SECURITY DEFINER inventory as deliberate absences, with the reason — so
  a later change that makes either definer again fails the build.

A third, smaller correction is worth recording because it is the same class of
mistake: `savings_transactions.recorded_by` was first written
`ON DELETE SET NULL`, and the implicit SET NULL *is* an UPDATE, which the
append-only trigger refuses. It broke teardown across 97 test files at once.
`ON DELETE RESTRICT` plus a label column is the pattern an append-only table
needs, and it is the same lesson `membership_status_history` taught in Phase 1.

---

## 3. Database suite

```
vitest run --project db
  Test Files  61 passed (61)
       Tests  1497 passed (1497)
```

Rebuilt from zero before the run, so every pass also re-proves that all 117
migrations apply in order to an empty database.

### The three new files

| File | Tests | What it attacks |
| --- | --- | --- |
| `tests/db/membership-enrolment.test.ts` | 25 | activation without a posted fee; a reversed fee; a reversed *journal entry* behind a posted fee; consent for the wrong policy version; a forged `verified` flag; a self-witness; a suspended witness; a missing signature object; another member's signature; portal acceptance by staff; the one-time code's single use; `enrol_member`'s all-or-nothing rollback |
| `tests/db/savings.test.ts` | 31 | the liability direction read off the journal lines; append-only under UPDATE and DELETE; several deposits in a month; a month that fell short; a reversal attributed to the month it corrects; six qualifying months; the "as of" snapshot; both arms of the consecutive rule; the whole withdrawal lifecycle; insufficient balance at request *and* at payment; a decision from the requester; double reversal; reversing a spent deposit; statement running balances; subledger-to-ledger reconciliation |
| `tests/db/rls-savings.test.ts` | 24 | `anon`; the four roles; a caller with no savings capability; forged account ids; direct execution of each definer function; replayed idempotency keys; a suspended member; the consent bucket's path predicate; the exhaustive grant list |

### What the savings suite asserts about the money

- A deposit's journal has **exactly two legs** and **neither is an income
  account** — read from `journal_lines`, not from a balance.
- `sum(signed_amount)` over the subledger equals the `2100 Member Savings`
  ledger balance, asserted after each lifecycle test rather than once.
- Every journal entry the suite writes balances, asserted by the deferred
  constraint trigger that would have refused it.
- A combined enrolment payment of UGX 55,000 splits into Cash at Hand
  Dr 55,000 / Member Savings Cr 50,000 / Registration Fees Cr 5,000.

---

## 4. The demonstration seeder

```
vitest run --project seed
  Test Files  1 passed (1)
       Tests  18 passed (18)
```

Its own vitest project, because the policy version it publishes is global
state — only one version may be in force, so every membership suite that
publishes its own would collide with it. A project gets its own `globalSetup`,
which rebuilds the database first.

### The safeguards, each asserted

| Safeguard | Asserted by |
| --- | --- |
| Refuses without the exact enabling phrase | *"refuses without the enabling phrase, and writes nothing"* |
| Refuses `1`, `true`, `yes` and a case variant | *"refuses a truthy value that is not the phrase"* |
| Refuses a Supabase project not on the allow-list | *"refuses a Supabase project that is not on its allow-list"* |
| Refuses a host it cannot identify | *"refuses a host it cannot identify at all"* |
| Refuses a connection string that is not a URL | *"refuses a connection string that is not a URL"* |
| Refuses with no connection string | *"refuses when there is no connection string"* |
| **Every refusal writes nothing at all** | a full snapshot compared before and after each |
| Idempotent against money | *"posts no money and writes no row on the second run"* |
| …and the state is a fixed point | *"is still idempotent on a third run"* |
| Touches no loan | *"touched no loan"* |
| Reconciles to the ledger | *"reconciles: the subledger equals the 2100 ledger balance"* |

Run three times rather than twice: twice could pass by accident on a guard
that happens to catch the exact state the first run leaves. Three times means
the second run's state is a fixed point, which is what idempotent means.

### What it seeds

Six members, each chosen to show one thing:

| | Shape | Shows |
| --- | --- | --- |
| A | six unbroken qualifying months | qualifies under either arm of the consecutive rule |
| B | six qualifying months, gap in the middle, run of three | the whole difference the undecided rule makes |
| C | three months, one met by two deposits | how a member who cannot find UGX 50,000 at once still makes the month |
| D | this month short of the minimum | the member a counter chases |
| E | saved, withdrew, duplicate deposit reversed | the full withdrawal lifecycle and a correction |
| F | fee paid, consent not verified | the ADR-050 preconditions from the outside |

Verified by inspection after seeding: A qualifies with run 6; B has 6
qualifying months and run 3; D has 2 qualifying months because this month fell
short; E's balance is 140,000 (180,000 deposited + 15,000 duplicate − 15,000
reversed − 40,000 withdrawn); F is `pending` with the fee posted and consent
unverified. Subledger and ledger both 1,010,000.

---

## 5. Upgrade path and financial regression

```
node scripts/verify-membership-upgrade.mjs

  applying 95 existing migrations
  seeded 14 loans, 165 payments, 178 journal entries
  capturing the financial baseline
  applying 22 Polytos migrations on top
  ...
  unchanged: account_balances (3 new account(s), all at zero)
  unchanged: trial_balance (3 new account(s), all at zero)

  Upgrade verified: 95 existing migrations, a seeded book, then 22 new
  migrations. Every one of 28 financial figures is identical, the ten
  membership and savings tables exist and are empty, and 2100 Member Savings
  is zero.
```

**This is the financial regression test the brief asks for**, and it is the
strongest evidence in this report: a real book — fourteen loans, a hundred and
sixty-five payments, schedules, penalties, allocations and journals, all
written through the real functions — is built on the *pre-Polytos* schema, a
twenty-eight-figure baseline is taken, both Polytos phases are applied on top
with the data in place, and the baseline is taken again and compared.

Three changes Phase 2 made to this script, each of which strengthens it:

1. **It covers both Polytos phases**, not just Phase 1. The released schema is
   the one before Polytos, so an upgrade applies both — and verifying one of
   them would leave the other's effect unmeasured.
2. **The chart-keyed snapshots are compared per account rather than as a
   list.** Phase 2 adds `2000`, `2100` and `4340`, which lengthens the list
   without moving a shilling; string equality reported that as a changed
   financial figure, which is false. The comparison now asserts that every
   account that existed before has *exactly* the same figures, that any
   account that appeared is at zero on every figure, and that none
   disappeared. Strictly stronger on what matters.
3. **The post-upgrade assertions extended** from four tables to ten, each
   asserted empty, plus `2100` asserted at zero — because a migration that
   created a savings deposit would have moved money, which is the thing the
   script exists to rule out.

---

## 6. Financial arithmetic audit

```
npm run audit:money

  60 financial files scanned, no hazard found
  all four engines reach only integer/BigInt money helpers
  2 acknowledged non-money exemption(s), each verified present
  scanner verified against a positive control
```

Every savings amount is `bigint` whole UGX. `fromDatabaseAmount` refuses a
value that is not an integer and refuses one that cannot be represented
exactly as a JavaScript integer, so a figure that arrived wrong raises rather
than rounds.

---

## 7. Browser tests

See §7.1 for the result. Two new spec files, 48 tests, run at both viewports
where they are reads and at the desktop viewport only where they write — the
mobile project ignores `*.write.spec.ts`, because running every write twice
would double the money in the seeded database and make the balances the read
specs assert against depend on which project ran first.

| File | Tests | What only a browser can say |
| --- | --- | --- |
| `tests/e2e/specs/savings.spec.ts` | 35 | every screen renders without an error boundary; no page scrolls sideways at 390px; every amount keeps its currency on one line; a Secretary is turned away from the withdrawal queue by the *route*, not by a hidden link; a borrower reaches no staff savings screen and is offered no control to move money |
| `tests/e2e/specs/savings.write.spec.ts` | 13 | a deposit survives both form steps; a withdrawal goes Secretary → Manager → paid, in two browser contexts; a rejection asks why and moves nothing; an enrolment takes the fee, records the acceptance and opens the savings account in one submission; the trial balance still balances afterwards |

The write spec exists because of the Phase 9 defect in which **no payment
could be recorded at all**: the form had two steps, step one unmounted when
step two appeared, and the amount left the form before submission. Every unit
test passed. The deposit and enrolment forms are built the same way, with the
same hidden-field carry, so the only way to know they work is to press the
buttons in order.

### 7.1 Result

```
npx playwright test     (fresh stack, one run)
```

See the final line of §10 for the figure. The suite was run against a stack
brought up fresh for the purpose, because these write specs consume the
seeded fixtures they act on — a second run against the same stack fails on
exhausted fixtures, which is a property of the harness and not of the code.

### 7.2 Three fixture changes, and why each is a strengthening

1. **The e2e seeder now seeds memberships and savings**, through the real
   functions, with the withdrawal prepared and decided as two different
   `authenticated` sessions — so the control that refuses a decision from the
   requester is one the fixture data went *through* rather than around.
2. **It skips that block where the Polytos schema is absent**, conditional on
   the catalogue rather than on a flag, because
   `scripts/verify-membership-upgrade.mjs` runs the same seeder against the
   pre-Polytos schema on purpose.
3. **The policy counts come from the database, not from the spec.** The policy
   screen's two counts — how many of the nine questions are open, how many of
   the five activities — are read back out of the generated columns by the
   seeder and published in the fixture manifest. The spec then asserts that
   the *screen agrees with the database*, which is the claim worth making, and
   cannot drift when the harness changes a figure.

---

## 8. What the tests establish about the security model

| Claim | Where it is proved |
| --- | --- |
| `anon` reads no savings table, view or function | `rls-savings.test.ts` |
| A caller with no savings capability reads nothing and can post nothing | `rls-savings.test.ts` |
| A member reads their own savings and no other member's | `rls-savings.test.ts`, by predicate *and* by naming the other id |
| A definer statement function does not leak another member | `rls-savings.test.ts` |
| A suspended member loses access on the next request | `rls-savings.test.ts` |
| A member cannot deposit to their own account | `rls-savings.test.ts` |
| `authenticated` holds SELECT and nothing else on the subledger | an exhaustive grant query, not a spot check |
| The subledger refuses UPDATE and DELETE to the table owner too | `savings.test.ts` |
| A forged consent challenge cannot be inserted | `rls-savings.test.ts` |
| A replayed key does not disclose another caller's movement | `rls-savings.test.ts` |
| The consent bucket has no UPDATE or DELETE policy | asserted against `pg_policies` |
| Activation refuses without a posted fee, above the trusted path | `membership-enrolment.test.ts` |
| Activation refuses without *verified* consent, above the trusted path | `membership-enrolment.test.ts` |
| Every capability call in a policy is hoisted | `rls-hoisting.test.ts`, which fails the build on a bare call |

---

## 9. The four Phase 1 assertions Phase 2 rewrote

Each was true when written and became **factually wrong** when Phase 2 built
the thing it asserted was absent. Each was rewritten to the new truth, not
relaxed. The absences that still hold — a control for a benefit claim, a
meeting or a profit share — are still asserted, in the same tests.

| Test | Asserted in Phase 1 | Asserts now | Why |
| --- | --- | --- | --- |
| `membership-ui.test.tsx` → *"is a module of its own, between Clients and Loan Management"* | Membership abuts `loans` | Membership abuts `clients` and `savings`; `savings` abuts `loans` | Savings is a module of its own, inserted between them |
| `membership-ui.test.tsx` → *"offers no entry for a workflow that does not exist yet"* | no entry matching `enrol\|savings\|collect\|withdraw\|benefit\|meeting\|profit` | no entry matching `benefit\|meeting\|profit`, **plus** two new tests pinning the enrolment entry's `requires` and the queue's capability | enrolment and savings exist; the other three still do not |
| `membership.spec.ts` → *"says no member has been enrolled, and why"* | the register is empty and the banner explains it | the register lists members and the banner is gone; a Secretary is turned away from the enrolment URL | members can be enrolled now |
| `membership.spec.ts` → *"marks every undecided rule as not decided, and counts them"* and *"answers the five activities separately"* | nine undecided, five closed, none open | the counts the **database** reports, read from the generated columns via the fixture manifest | the harness policy answers the two savings rules, so the figures are smaller — and reading them from the database means the spec cannot drift |

Two further test-side corrections, both of which were my own bugs rather than
changed behaviour:

- `tests/db/membership-enrolment.test.ts` uploaded a consent object and never
  removed it. `storage.objects` is global state no fixture teardown clears, so
  the next suite that counted the bucket failed in a full run and passed on its
  own. The suite now cleans up, and `rls-savings.test.ts` scopes its
  assertions to the objects it created rather than to the bucket.
- `tests/integration/migrations.test.ts` required `updated_at` on every table.
  `savings_transactions` is append-only and correctly has none — a column that
  can never advance would imply a movement can be amended — so it joins the
  documented list beside `notifications` and `membership_status_history`.

---

## 10. Deviations, and what is not covered

Stated rather than omitted.

- **No hosted verification.** Nothing in this report was run against the
  hosted Supabase project. The brief forbids applying migrations to it during
  development, and the demonstration seeder's allow-list refuses every project
  but the named one — and was not pointed at it. **A hosted release therefore
  needs its own verification step**, which is a release decision and not this
  phase's to take.
- **`above_pledged` withdrawals are refused, not implemented.** The policy
  value exists and the refusal is tested; the arithmetic cannot be written
  until the savings-to-loan multiplier is decided. This is a deliberate gap,
  not an omission.
- **Benefit claims, profit sharing, member loans, a membership status screen
  and an account closure workflow are absent.** Each waits on a client
  decision or a later phase; §13 of `docs/POLYTOS-SAVINGS.md` lists them.
- **The write specs consume their fixtures.** A second full browser run
  against the same stack fails on exhausted seeded loans. This is pre-existing
  harness behaviour; the run reported here was against a stack brought up
  fresh.
- **No load testing.** The savings register and statement are indexed and
  paged, and the balance aggregate is over a member's tens of rows rather than
  the book's thousands — but no figure in this report measures either under
  load.

---

## 11. Verification commands, in order

```bash
npm run typecheck
npm run lint
npm run format:check
npm run test:run                       # unit + integration

npm run db:local:setup                 # throwaway PostgreSQL
export DATABASE_URL="$(bash scripts/pg-local.sh url)"
npx vitest run --project db            # the database suite
npx vitest run --project seed          # the demonstration seeder

node scripts/verify-membership-upgrade.mjs    # upgrade + financial regression
npm run audit:money

npm run build

tests/e2e/harness/stack.sh up          # a fresh stack
source <(tests/e2e/harness/stack.sh env)
npx playwright test
tests/e2e/harness/stack.sh down
```
