# Polytos Phase 4 — test report

Membership benefits, claims, beneficiaries and monthly meetings.

**Everything in this report was run on the commit it names, against a real
PostgreSQL with every migration applied.** Nothing is asserted from reading
the code, and no figure below was typed from memory.

```
typecheck                               clean
lint                                    clean
format                                  clean
unit + integration                      2,558 passed,  6 skipped   (78 files)
database                                1,761 passed,  0 skipped   (74 files)
  of which Phase 4's own suites           141 passed               ( 8 files)
demonstration seeder (savings)             18 passed
borrower reuse                             15 passed
member loan demonstration                  24 passed
benefit demonstration                      25 passed
money arithmetic audit                   clean (5 engines, 2 verified exemptions)
production build                         clean (13 new routes)
upgrade + financial regression            28 of 28 figures identical
browser suite                            44 new specs, run in CI (§J)
```

The six skipped tests are `tests/integration/bundle.test.ts`, which measures
`.next/static` and skips when there is no build to measure. CI's `checks` job
runs the suite before `next build`, so they skip there; running `npm run
verify` locally builds first and all six pass. They are not Phase 4's and they are
not disabled: the bundle ceiling they assert was raised by this phase, with
the case written out in the test itself.

---

## 1. Summary

| Suite | Tests | What it is for |
| --- | --- | --- |
| `tests/db/beneficiaries.test.ts` | 25 | registration, supersession, two-hand verification, the identity split |
| `tests/db/benefit-claims.test.ts` | 43 | the lifecycle, frozen facts, three admission readings, every eligibility code |
| `tests/db/benefit-accounting.test.ts` | 20 | the arithmetic, the journal, the three expense accounts, reversal |
| `tests/db/benefit-concurrency.test.ts` | 4 | two assessments racing for one annual cap |
| `tests/db/benefit-security.test.ts` | 16 | every policy, from outside, as four different people |
| `tests/db/benefits-undecided.test.ts` | 6 | what the module does under the policy the client **actually** has |
| `tests/db/meetings.test.ts` | 26 | the monthly rule, the derived status, corrections, minutes, action items |
| `tests/db/benefit-demo-seed.test.ts` | 25 | the demonstration seeder, run for real, six times |
| `tests/db/postgrest-columns.test.ts` | 1 | every column this application asks PostgREST for, against the real schema |
| `tests/unit/benefits.test.ts` | 32 | the domain in isolation, figures written out by hand |
| `tests/unit/meetings.test.ts` | 18 | the domain, including the absences |
| `tests/unit/benefit-validation.test.ts` | 37 | the write surface, including two fields that must not exist and six blank ones that must be allowed |
| `tests/unit/meeting-validation.test.ts` | 25 | the write surface, the two asymmetries the database owns, and what a browser actually sends |
| `tests/e2e/specs/benefits.spec.ts` | 24 | the screens, as four roles, at 390px |
| `tests/e2e/specs/meetings.spec.ts` | 14 | the meeting screens, same |
| `tests/e2e/specs/benefits.write.spec.ts` | 6 | approving, paying, marking a register by pressing buttons |

Plus the existing suites extended rather than duplicated:
`tests/unit/permissions.test.ts` (140 tests, now covering the eleven new
capabilities and the full role matrix), `tests/db/schema.test.ts`,
`tests/db/security.test.ts`, `tests/db/permissions.test.ts`,
`tests/db/rls-payments.test.ts`, `tests/integration/migrations.test.ts`,
`tests/integration/navigation.test.tsx` and
`tests/integration/membership-ui.test.tsx`.

---

## 2. The eleven defects these tests, this build and CI found

Each of these was found by writing the test or running the seeder, not by
reading the code. Each was fixed in the layer that owned it.

### 2.1 The tenth undecided rule was not frozen

`medical_benefit_year_basis` was added as a nullable policy column and left
out of the freeze that `membership_policy_versions_guard` applies to the other
nine. So the benefit year could be decided on a version members were already
enrolled under — the exact thing the guard's own comment says must not happen.

Fixed by `membership_policy_year_basis_guard`, a trigger of its own rather
than 140 lines of the Phase 1 guard copied into a Phase 4 migration. ADR-065
records why. `tests/db/benefits-undecided.test.ts` asserts both arms: refused
on the version in force, permitted on a draft, refused again once that draft
is approved with nobody enrolled under it.

### 2.2 Three reporting functions refused the trusted path

`medical_benefit_consumed`, `benefit_summary` and `benefit_expense_by_type`
gated on a capability **outside** the `auth.uid() is null` exemption that
`savings_summary` has carried since Phase 2. Every test passed, because every
test ran as a signed-in user. The demonstration seeder found it: it runs on
the trusted path, where `user_has_permission` is false for want of a session,
and a maintenance read of `benefit_claim_eligibility` could not run at all.

Fixed in all three; ADR-064 records the rule. The seeder's own reconciliation
step is now the regression test, and it runs in CI.

### 2.3 Evidence could not be checked in the order the screens offered

`verify_benefit_document` requires the claim to be under verification — a
conclusion about evidence on a claim nobody is working on is not a
conclusion. The first draft of both the demonstration seeder and the claim
screen attached and checked documents while the claim was still a draft, and
the database refused with "That claim is draft."

Fixed in the callers rather than in the function, because the function is
right: documents are attached at the counter with the claim, and checked once
somebody picks it up. The seeder now does exactly that, and the screens'
`BenefitDocumentsPanel` offers the check only in the states that accept it.

### 2.4 A refusal needed the approver's capability, not the assessor's

`reject_benefit_claim` takes `benefits:approve`, because refusing a claim is
the same decision about a member's entitlement that approving one is. The
demonstration seeder refused a short-admission claim as the Manager who
assessed it and was told so.

Fixed in the seeder. Worth recording because the first instinct — "whoever
assesses can refuse" — is wrong in a way that only shows up when somebody
tries it.

### 2.5 The upgrade verifier applied Phase 4 before Phase 1

`scripts/verify-membership-upgrade.mjs` partitions the migrations by prefix,
and `20261022` was not in the list — so the Phase 4 files were treated as part
of the *existing* schema and applied first, where `member_beneficiaries`
references a `memberships` table that does not exist yet.

Fixed by adding the prefix, and the verifier now also asserts that all ten new
tables exist and are **empty** after the upgrade: an upgrade that invented a
benefit payment would have taken money out of the business against a claim
nobody made.

### 2.6 A `held` meeting could not be cancelled, but said the wrong thing

`cancel_membership_meeting` checked the status before the register, so a
meeting people had attended was refused with "it is already held" rather than
"people attended, so it happened". The first is a fact about a column; the
second is a fact about the afternoon, and it is what the person reading the
message needs.

Fixed by moving the attendance check above the status check.
`tests/db/meetings.test.ts` asserts the message.

### The three the browser suite found, and nothing else could have

The first CI run of the browser job failed 30 of 832 specs. All thirty trace
back to three defects, and the reason each one survived every other check is
worth recording — it is the argument for the browser tier existing.

### 2.7 `/meetings/[meetingId]` answered 500 for every meeting

`listExpectedMembers` asked `membership_register` for `membership_id`. That
view's key column is `id`, because it is a view *of* memberships. PostgREST
answers 400 for a column that does not exist, the data function threw, and
nine specs failed on the error boundary rather than on anything they were
testing.

No check in the project could have caught it. A select list is a string and
the row type is asserted after the call, so TypeScript is being told the
answer; the database suites speak SQL directly and never name a column list
the way PostgREST parses one; the unit suites have no database.

Fixed in `lib/data/meetings.ts`, and the **class** closed by
`tests/db/postgrest-columns.test.ts`, which checks every column this
application asks PostgREST for — 400-odd across ten `lib/` directories —
against `information_schema`. ADR-070 records what it checks and what it
deliberately does not.

### 2.8 Two "new" screens answered 500 because a function crossed a boundary

`MemberChooser` is a Client Component and took `hrefFor` — a function — as a
prop from two Server Component pages. A function cannot be serialised across
that boundary, so `/benefits/claims/new` and `/beneficiaries/new` threw at
render. The build is happy either way, which is why typecheck, lint and
`next build` all passed over it.

Fixed by sending the links as strings keyed on the membership id: the server
builds the URLs it means.

### 2.9 The beneficiary form refused two fields it labels optional

`formData.get('x')` is the **empty string** for a control somebody left alone,
not `null`. So `ugandanPhoneSchema.nullable().optional()` describes a shape no
browser submits, and the form failed with "Phone number is required" against
the optional alternative number, and with an enum refusal against the "No
document was shown" option.

Thirty-one validation tests passed over that schema, because every one of them
handed it an already-parsed object. Fixed with `optionalField` in
`lib/validation/common.ts` — the idiom earlier phases had written inline a
dozen times, now named — applied to the twelve Phase 4 fields a form can leave
blank. Both unit suites now parse the blank string field by field, as a form
sends it, and assert the rules that must survive it. ADR-069 records the rule.

### The two the second run found

Those three fixes took the browser job from 30 failures to 3, and the
remaining three specs were two more defects.

### 2.10 A marked attendance row never collapsed

`MemberRow`'s one button reads **Mark** when there is no answer, **Close**
while the editor is open, and **Change** once it is shut. Recording an answer
left the editor open — so the row showed a recorded answer *and* the controls
for giving one, "Change" was never reachable at all, and somebody marking
seven members in turn had a dead form sitting above each next name.

The spec that found it is the one that corrects a register, and it could not
reach the correction. Fixed by closing the row on a successful record, and
only on a successful one: a refusal's message is rendered inside that form.

### 2.11 The assignee list was read as empty when it is the caller's own record

`profiles_select_self_or_directory` is named after what it does — your own
row, or the whole directory if you hold `users:view`. Phase 4 read it as "a
Secretary/Treasurer gets nothing", so `MeetingActionsPanel` carried a sentence
saying the staff list could not be read, and a spec asserted that sentence.

What a Secretary actually gets is one name: their own. So the panel was
presenting a list of one as if it were the staff list, and the explanation it
had for the restricted case was unreachable.

The panel is now **told** whether the caller holds the directory capability
rather than inferring it from the length of the list — a directory of one is a
real possibility in a new branch, and a sentence that was wrong in that case
would be worse than none — and the select carries a hint saying the list is
limited to the records the caller may read. The spec asserts that, and the one
name, instead of the wrong premise.

This one is worth separating from the other four: the code did what it was
written to do, and what was wrong was a reading of a Phase 1 policy. No type,
constraint or unit test can catch a mistaken belief about an RLS predicate.
Only a session as that role, against that policy, can.

**What this says about the suite.** Five defects across five screens, with no
overlap at all: a database request, a React boundary, a form contract, a piece
of component state, and a misread security policy. None was reachable from a
type, a constraint or a parsed object; three of the five were invisible to
every tier below the browser.

Phases 1–8 shipped 2,584 green unit tests over three defects only a real
browser could see. Phase 4 shipped 2,558 green unit tests, 1,761 green
database tests and a clean production build over five more. That is the case
for the browser job being mandatory rather than advisory, and it is the reason
this section is in the report rather than in a commit message.

---

## 3. The claims the database suites establish

### 3.1 The money

- 5% of UGX 400,000 is **exactly** UGX 20,000, computed as
  `(bill * 500 + 5000) / 10000` in `bigint`. 5% of 123,455 is 6,173 — half
  up — where a float would floor 6172.750000000001 to 6,172.
- Every benefit payment writes **one** journal entry through `post_journal`,
  debiting `5210`, `5220` or `5230` and crediting the method's cash account.
  `benefit_payments.journal_entry_id` is unique, and the suite asserts no
  payment shares an entry and none is orphaned.
- The payment subledger equals the sum of the three expense accounts, net of
  reversals, after every operation in the suite.
- Account `2100 Member Savings` is **unchanged** by a benefit payment. A
  benefit is an expense, not a withdrawal.
- A reversal posts a contra entry and leaves the original standing; the claim
  becomes terminally `reversed` and cannot be paid again.

### 3.2 The controls

Each of these is asserted as a refusal, with four different signed-in users:

| Control | Enforced in |
| --- | --- |
| An assessor cannot approve their own assessment | `approve_benefit_claim`, by id **and** by actor label |
| A document's uploader cannot check it | `verify_benefit_document` |
| A beneficiary's recorder cannot verify it | `verify_member_beneficiary` |
| An unverified beneficiary is never paid | `benefit_claim_eligibility` → `assess_benefit_claim` |
| A payee cannot be supplied at payment | `post_benefit_payment` reads the snapshot |
| A beneficiary cannot change while a bereavement claim is live | `member_beneficiaries_guard` |
| A claim's facts cannot change after submission | `benefit_claims_guard` |
| A capability is checked above the idempotency replay | `post_benefit_payment` |

The label comparison is tested with an **archived** assessor: the profile id
becomes NULL and the refusal still holds, which is the case an id-only check
would miss.

### 3.3 The undecided rules

`tests/db/benefits-undecided.test.ts` publishes a policy version shaped like
the client's own — every benefit rule NULL — and asserts that:

- a claim can still be opened, its evidence attached and checked, and a
  beneficiary registered and verified;
- **nothing** can be assessed, approved or paid;
- every refusal names the decision, and the undecided ones are distinguishable
  from the refusals by code;
- the gate is re-asked at payment, which is the last point at which asking can
  prevent anything.

### 3.4 Concurrency

`tests/db/benefit-concurrency.test.ts` runs two assessments for one member
against one annual cap, in two sessions, and asserts exactly one succeeds —
the advisory lock on the membership plus the `assessed`-counting consumption.
It also asserts a double submission, a double approval and a double payment
are each refused or replayed rather than doubled.

---

## 4. The benefit demonstration seeder

`npx vitest run --project seed-benefits` — 25 tests, and the seeder itself is
run **six times** inside them: three for the fixed point and three for the
refusals.

| Assertion | Why it is here |
| --- | --- |
| needs its own phrase, and eight other values do not turn it on | a seeder that writes benefit payments must not be reachable by accident |
| refuses a hosted database, and writes nothing | checked by comparing the whole state before and after |
| refuses to run beside the member-loan demonstration | one policy version may be in force, and a version answering both sets would present six unapproved figures |
| names its phrase in the refusal | the refusal a developer actually meets has to say what to type |
| publishes 997.0 with TEST ONLY **in the title** | the title is what a reader sees on the policy list |
| leaves the client's own four figures unchanged | a seeder that moved the 5% rate would be the worst thing in the file |
| labels every claim, document, beneficiary, meeting and minute | a synthetic approval must never read as a management decision |
| three paid, one reversed, one refused, one draft, four held | the controls are the deliverable |
| holds each of the four on a **named** undecided rule | asserted by calling the eligibility function per claim |
| a snapshot behind every decided claim | append-only, one per decision |
| the bereavement benefit paid to the **frozen** payee | compared against the snapshot's own copy of the name |
| the subledger equals the General Ledger | to the shilling, net of the reversal |
| no second ledger: one journal entry per payment, none shared | the structural claim |
| moves no savings, writes no loan | `2100` equals the savings subledger; `loans` is empty |
| a fixed point from the second run onwards | the whole state, as one comparable row |

---

## 5. Upgrade path and financial regression

`node scripts/verify-membership-upgrade.mjs`

```
95 existing migrations, a seeded loan book, then 46 new migrations.
Every one of 28 financial figures identical.
7 new ledger accounts, all at zero.
22 Polytos tables exist and are empty.
2100 Member Savings is zero.
Six existing borrowers enrolled; the loan book untouched.
A full financial fixed point on runs 2 and 3.
```

The 28 figures include every loan's principal, rate, method, term, cadence,
total interest, total expected repayment, disbursement date, **every
collection date**, every installment amount, every payment, every allocation,
both loan balances, the journal sums on both sides, the trial balance, the
delinquency state and the audit trail — loan by loan, keyed rather than
summed, because a total can stay still while two loans swap figures.

Phase 4 adds a new expense heading, three new postable accounts and a new
journal source type. The claim worth measuring is that it changes nothing,
and this is the measurement.

---

## 6. Financial arithmetic audit

`node scripts/audit-financial-arithmetic.mjs` — clean.

The audit refuses a float in a money path anywhere in `lib/`, and Phase 4
added one path to it: `medicalBenefitAmount` reaches `applyRateBps`, which is
the integer helper the loan, penalty and member-loan engines already use. The
scanner reports "all five engines reach only integer/BigInt money helpers",
and it verifies itself against a positive control on every run.

---

## 7. Browser tests

44 new specs across three files, run by CI's browser job against the
production build on a freshly seeded database.

| Spec | Count | Covers |
| --- | --- | --- |
| `benefits.spec.ts` | 24 | 14 screens render; the dashboard; a claim's three admission readings; a held claim naming its decision; the frozen assessment; the registers; next of kin; who may reach what; 8 screens at 390px |
| `meetings.spec.ts` | 14 | 5 screens; the two dashboard panels; the correction trail; finalised minutes; no "mark as held" control; who may reach what; 3 screens at 390px |
| `benefits.write.spec.ts` | 6 | approve → pay, with the report's total read before and after; a second payment refused; a held claim offering no approval; registering and verifying next of kin across two sessions; marking a register and correcting it; minutes and an action item |

Four of those assertions are about **absences**, which is the only way to test
a decision not to build something:

- no payee field on the payment form;
- no "mark as held" control anywhere;
- no word in the meeting screens meaning penalty, fine, sanction or warning;
- no beneficiary name in the claim register, and none on the record for a
  reader without `membership:view_sensitive`.

The e2e harness was extended to seed them: four claims (one paid, two
assessed, one held), two beneficiaries (one verified, one not), three meetings
(one held with a corrected register and finalised minutes, one upcoming, one
for the write spec to work on). Two assessed claims and three meetings rather
than one of each, because Playwright runs files in parallel and a read spec
asserting "the queue is not empty" must not depend on worker order.

**These were not run in this container.** The browser job needs a real
PostgREST binary, and this environment cannot fetch one — the download was
refused by the sandbox, twice, which is also why the screenshots are taken in
CI rather than here (§J of the delivery report).

They ran in CI, and the first run **failed 30 specs** over three real defects
— §2.7 to §2.9 above. That is recorded rather than quietly fixed, because it
is the only honest answer to "were the browser tests worth writing": every
other tier of this project's verification was green at the same moment, on a
build with three 500s in it. §J records the run that passed.

---

## 8. What the tests establish about the security model

| Claim | Suite |
| --- | --- |
| A Secretary/Treasurer reads the claim register and cannot approve or pay | `rls`, `permissions`, `benefits.spec.ts` |
| A Secretary/Treasurer cannot read a beneficiary's name | `benefit-security.test.ts`, `benefits.spec.ts` |
| A Secretary/Treasurer cannot read an assessment snapshot | `benefit-security.test.ts` |
| A bereavement payment row is withheld without `view_sensitive` | `benefit-security.test.ts` |
| A borrower reads their own claims and nothing else | `benefit-security.test.ts`, `benefits.spec.ts` |
| A borrower reads no assessor's note, ever | the portal view's column list, asserted in both |
| A borrower reaches no staff benefit or meeting screen | `benefits.spec.ts`, `meetings.spec.ts` |
| A member cannot read their own attendance row | `meetings.test.ts` |
| Every new table refuses `anon` entirely | `security.test.ts` |
| Every new function is `revoke`d from `public` and `anon` | `security.test.ts` |
| The SECURITY DEFINER list is exhaustive | `security.test.ts` |

---

## 9. Deviations, and what is not covered

**Not covered: the browser suite in this container.** As §7 says, PostgREST
could not be fetched here — the download was refused by the sandbox on two
attempts. The specs ran in CI, where the first run found three defects
(§2.7–2.9) and the run named in §J of the delivery report passed. The
screenshots are taken in the same job, for the same reason.

**Not covered: a hosted Supabase project.** Deliberately, and by instruction.
No Phase 4 migration has been applied to the hosted project, and the
demonstration seeder refuses one.

**Not covered: a real document upload.** The storage policies and the
content-type check are asserted against rows in `storage.objects` written by
the fixtures, which is what the database itself checks. The browser suite does
not upload a file, because the harness has no storage service behind it — the
upload path's magic-byte check is covered by a unit test instead.

**Partially covered: the waiting period.** The demonstration seeder sets 30
days and back-dates its memberships; the refusal itself
(`waiting_period_not_served`) is asserted in `benefits-undecided.test.ts`
against a member enrolled inside the period. No screen was exercised in that
state.

**A deliberate gap: no test asserts a benefit is paid in part.** Partial
payment is undefined, the database refuses it, and a test asserting a
behaviour nobody has specified would be a test asserting an invention.

---

## 10. Verification commands, in order

```bash
npm run format:check
npx tsc --noEmit
npm run lint
npx vitest run --project unit --project integration
node scripts/audit-financial-arithmetic.mjs
npm run build

# Needs a local PostgreSQL. Rebuilds the database per project.
npm run db:local:setup
export DATABASE_URL=postgresql://lending@localhost:5433/lending_test
npm run test:db          # db, seed, seed-reuse, seed-member-loans, seed-benefits
                         # each project is its own `vitest run`, deliberately:
                         # every seeder rebuilds the database, so one
                         # invocation covering several would race itself
node scripts/verify-membership-upgrade.mjs

# Needs the end-to-end stack: PostgreSQL, PostgREST, the auth shim,
# a fresh seed and the production build.
npm run e2e:up
source <(npm run --silent e2e:env)
npx playwright test
npm run e2e:down
```
