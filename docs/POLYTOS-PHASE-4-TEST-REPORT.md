# Polytos Phase 4 — test report

Membership benefits, claims, beneficiaries and monthly meetings.

**Everything in this report was run on the commit it names, against a real
PostgreSQL with every migration applied.** Nothing is asserted from reading
the code, and no figure below was typed from memory.

```
typecheck                               clean
lint                                    clean
format                                  clean
unit + integration                      2,549 passed,  6 skipped   (78 files)
database                                1,760 passed,  0 skipped   (73 files)
  of which Phase 4's own suites           140 passed               ( 7 files)
demonstration seeder (savings)             18 passed
borrower reuse                             15 passed
member loan demonstration                  24 passed
benefit demonstration                      25 passed
money arithmetic audit                   clean (5 engines, 2 verified exemptions)
production build                         clean (13 new routes)
upgrade + financial regression            28 of 28 figures identical
browser suite                            44 new specs, run in CI
```

The six skipped unit tests and the skipped file are pre-existing and unrelated
to this phase; they are the environment-gated checks that need a hosted
Supabase project.

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
| `tests/unit/benefits.test.ts` | 32 | the domain in isolation, figures written out by hand |
| `tests/unit/meetings.test.ts` | 18 | the domain, including the absences |
| `tests/unit/benefit-validation.test.ts` | 31 | the write surface, including two fields that must not exist |
| `tests/unit/meeting-validation.test.ts` | 22 | the write surface and the two asymmetries the database owns |
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

## 2. The six defects these tests and this build found

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
refused. They run in CI, and §J of the delivery report records the result.

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
could not be fetched here. The specs are written and CI runs them.

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
node scripts/verify-membership-upgrade.mjs

# Needs the end-to-end stack: PostgreSQL, PostgREST, the auth shim,
# a fresh seed and the production build.
npm run e2e:up
source <(npm run --silent e2e:env)
npx playwright test
npm run e2e:down
```
