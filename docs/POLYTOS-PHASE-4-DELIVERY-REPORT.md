# Polytos Phase 4 — delivery report

Membership benefits, claims management, beneficiaries and monthly meetings.

**Nothing was merged and nothing was deployed.** Seven commits sit on
`claude/eager-hypatia-ub12i1`; no pull request was opened, no Vercel
deployment was triggered, and no Phase 4 migration has been applied to any
hosted Supabase project. The hosted connection named `Primary` was never
contacted; every database operation in this phase ran against a local
throwaway PostgreSQL cluster built by `scripts/pg-local.sh`.

| | |
| --- | --- |
| Branch | `claude/eager-hypatia-ub12i1` |
| Commits | 7 |
| Files changed | 113 (+39,189 / −131) |
| Migrations | 14, numbered `20261022000100`–`20261022001400` |
| New tables | 10 |
| New views | 6 |
| New database functions | 31 |
| New capabilities | 11 |
| New routes | 13 |
| New tests | 324 (140 database, 103 unit, 25 seeder, 44 browser, 12 extended) |

---

## A. Implementation summary

### What was asked for, and what was delivered

| # | Deliverable | Status |
| --- | --- | --- |
| 1 | Member beneficiaries / next of kin | **Delivered.** Two tables (the identity split), a supersession chain, two-hand verification |
| 2 | Medical support claims | **Delivered.** 5% of the bill, three admission readings, the annual cap and claim count both built |
| 3 | Family condolence claims | **Delivered.** UGX 100,000, relationship recorded, eligibility held pending the client |
| 4 | Member bereavement claims | **Delivered.** UGX 200,000 to the verified next of kin, payee frozen at assessment |
| 5 | Supporting documents and verification | **Delivered.** Private bucket, path-as-predicate, magic-byte check, two-hand attestation |
| 6 | Benefit assessment and approvals | **Delivered.** Append-only snapshots, separation of duties by id and by label |
| 7 | Financial benefit disbursements | **Delivered.** One journal entry per payment, three expense accounts, reversal by contra |
| 8 | Monthly membership meetings | **Delivered.** One per branch per month, status derived from the register |
| 9 | Meeting attendance and records | **Delivered.** Four answers, append-only corrections, minutes with amendments, action items |
| 10 | Member notifications | **Delivered.** Eleven categories on the existing stream; no amount, no name, no diagnosis |
| 11 | Benefits reporting and dashboards | **Delivered.** A dashboard, a stage breakdown, a report reconciling against the ledger |
| 12 | Existing demonstration-data integration | **Delivered.** A third seeder mode, local-only, attaching to the six existing demo members |
| 13 | Comprehensive financial and security testing | **Delivered.** 324 tests; see §I |

### The four deliberate deviations

Each is a place where building what was asked for would have meant inventing
a rule the client has not approved.

1. **A claim over the annual cap is held, not part-paid.** The brief says
   "refused or part-paid, per the client's answer" — and the client has not
   given one. Whether a benefit may be paid in part is itself undecided, so
   paying the remainder would be inventing a rule in the member's disfavour.
   Both arms of the cap are built; the third behaviour is refused with
   `medical_cap_exceeded`.

2. **A borrower reads none of their beneficiary record in the portal.** The
   brief expected a member to read their own beneficiaries. The name and
   telephone number are the business's payment instruction and sit behind
   `membership:view_sensitive` in a separate table, because Row Level Security
   cannot withhold a column. A member reads their own *claims* through a view
   whose column list is the disclosure policy.

3. **No screen offers a partial approval, and the schema has no field for
   one.** An approver agrees to the assessed figure or refuses the claim.

4. **No consequence is attached to meeting attendance.** The brief listed
   attendance records; what missing a meeting costs a member is not in the
   client's documents, and a threshold on a screen is a policy.

### Three decisions this phase found

Recorded in `docs/POLYTOS-MEMBERSHIP-POLICY-DECISIONS.md`, each a refusal
naming the decision rather than a default:

1. **Is the medical benefit year the calendar year, or the year from the
   member's own enrolment anniversary?** A member admitted in December and
   again in January has either one year's ceiling or two. Both arms built;
   `medical_benefit_year_basis` is nullable with no default.
2. **Which relatives does the condolence benefit cover?**
   `beneficiary_relationships.condolence_eligible` is NULL on every row.
3. **Does an outstanding member loan reduce a bereavement benefit?** The
   question Phase 3 left for Phase 4, and Phase 4 is leaving for the client.
   Nothing is netted; the claim is held where the member owes anything.

---

## B. Database changes

### Migrations

| Migration | What it adds |
| --- | --- |
| `…000100_benefit_permissions` | 11 capabilities, the role grants, 4 reference formats (`BC`, `BN`, `BP`, `MM`) |
| `…000200_benefit_ledger_accounts` | `5200` heading, `5210`/`5220`/`5230`, two journal source types |
| `…000300_benefit_document_storage` | the private bucket, two path-segment readers, the document vocabulary |
| `…000400_member_beneficiaries` | the relationship vocabulary, the two beneficiary tables, 4 functions |
| `…000500_benefit_claims` | `benefit_claims`, ten statuses, the transition table, the freeze guard |
| `…000600_benefit_claim_documents` | the metadata table, attach/verify/remove, three storage policies |
| `…000700_benefit_assessment` | the year basis and its freeze, the arithmetic, the eligibility function, the snapshot table |
| `…000800_benefit_claim_lifecycle` | 8 lifecycle functions |
| `…000900_benefit_payment` | `benefit_payments`, `post_benefit_payment`, `reverse_benefit_payment` |
| `…001000_membership_meetings` | 4 meeting tables, 9 functions |
| `…001100_benefit_notifications` | 11 categories, 4 notification triggers |
| `…001200_benefit_rls` | revoke-then-grant on 10 tables, every policy |
| `…001300_benefit_audit_triggers` | 6 audit events |
| `…001400_benefit_reporting` | 6 views, 3 reporting functions |

Applied to a clean cluster and to a populated one, in order, repeatedly.
`tests/integration/migrations.test.ts` reads every file and asserts the
project's own SQL discipline: `set search_path = ''` on every function,
`timestamptz` never `timestamp`, no `USING (true)` outside the permitted set,
a `created_at`/`updated_at` pair or an explicit exemption on every table, and
a typed entry in `types/database.types.ts` for every function.

### The ten tables

```
member_beneficiaries            the record: relationship, primary, status, verification
member_beneficiary_identities   the name, both phones, the place, the document  (split)
benefit_claims                  one per claim, facts frozen at submission
benefit_claim_documents         evidence metadata; objects live in the bucket
benefit_assessment_snapshots    the frozen assessment                 (append-only)
benefit_payments                one per payment, one journal entry each
membership_meetings             one per meeting, meeting_date generated in Kampala
meeting_attendance              one per member per meeting
meeting_attendance_corrections  what the register said before          (append-only)
meeting_action_items            what somebody said they would do
```

Three are append-only by trigger. Two more refuse `UPDATE` on specific
columns through their guards. One — `benefit_claim_documents` — carries the
only `DELETE` grant in the phase, narrowed to an unchecked document on an
undecided claim.

### What was extended rather than duplicated

- The `notifications` category CHECK and the audit-event CHECK.
- `membership_policy_versions` gained one nullable column
  (`medical_benefit_year_basis`) and a trigger freezing it.
- `storage.objects` gained three policies for the new bucket.
- Nothing was dropped, relaxed or widened.

---

## C. Benefit eligibility

`benefit_claim_eligibility(claim_id)` returns a **set** of codes with
sentences, the shape `validate_loan_for_approval` established — so an
assessment screen lists every reason at once instead of revealing them one
refusal at a time.

Seventeen codes. Six name a decision nobody has made; eleven are refusals.
The screens keep the two apart, because "your admission was too short" is
something a member can be told and "nobody has decided how we count a day" is
not.

```
                    ┌─ policy_not_open                     (undecided)
                    ├─ membership_not_claimable
                    ├─ membership_suspended_undecided      (undecided)
                    ├─ waiting_period_not_served
  medical ──────────┼─ admission_not_ended
                    ├─ admission_too_short
                    ├─ admission_measure_undecided         (undecided)
                    ├─ medical_year_basis_undecided        (undecided)
                    ├─ medical_claims_exhausted
                    └─ medical_cap_exceeded
  condolence ───────┬─ relationship_eligibility_undecided  (undecided)
                    └─ relationship_not_eligible
  bereavement ──────┬─ beneficiary_missing
                    ├─ beneficiary_not_verified
                    └─ bereavement_loan_offset_undecided   (undecided)
  all ──────────────┬─ evidence_missing
                    └─ claim_not_in_assessable_state
```

`assess_benefit_claim` refuses on that set, under `pg_advisory_xact_lock` on
the membership, and writes the snapshot in the same transaction. Consumption
of the annual cap counts `assessed`, `approved` **and** `paid` claims, so two
approvals cannot share one member's ceiling.

---

## D. The arithmetic and the money path

```sql
-- the whole of the medical benefit, in one place a test can drive directly
(p_bill_amount * p_rate_bps + 5000) / 10000     -- bigint, exactly half-up
```

| Bill | 5% | Why it is here |
| --- | --- | --- |
| 400,000 | 20,000 | the figure the brief itself quotes |
| 123,455 | 6,173 | 6,172.75 rounds up; a float would floor 6172.750000000001 to 6,172 |
| 123,450 | 6,173 | the exact half, up |
| 123,440 | 6,172 | exact |

`lib/domain/benefits.ts` mirrors it through `applyRateBps`, the integer helper
the loan, penalty and member-loan engines already use — not a second
implementation. `scripts/audit-financial-arithmetic.mjs` fails the build on a
float in a money path and reports "all five engines reach only integer/BigInt
money helpers".

### The posting

```
  post_benefit_payment(claim, method, reference, idempotency_key)

  Debit   5210 Member Medical Support      |  5220 Family Condolence
          5230 Member Bereavement          |
  Credit  1000 Cash on hand, or the method's account
```

One journal entry, through `post_journal`. No second ledger, no benefits
payable account: the obligation is recognised by the cap arithmetic and the
expense when the money moves. `benefit_payments.journal_entry_id` is unique,
and the tests assert that no payment shares an entry and none is orphaned.

A reversal posts a contra entry and leaves the original standing. The claim
becomes terminally `reversed`; there is no edge back to `approved`.

---

## E. UI/UX

Thirteen routes, every one server-rendered, guarded three times (the proxy,
the route map, the page) and reading as the caller so that Row Level Security
decides what appears.

| Route | Guard | What it is for |
| --- | --- | --- |
| `/benefits` | `benefits:view` | the position, and where the claims are |
| `/benefits/claims` | `benefits:view` | the register, searched and filtered |
| `/benefits/claims/new` | `benefits:claim` | member, then benefit, then the form |
| `/benefits/claims/[id]` | `benefits:view` | facts, eligibility, evidence, assessment, decisions, payment |
| `/benefits/approvals` | `benefits:approve` | the Owner's queue, opening on `assessed` |
| `/benefits/payments` | `benefits:pay` | the reconciliation register |
| `/benefits/reports` | `benefits:view` | the period, from both sources |
| `/beneficiaries` | `beneficiaries:view` | which members have nobody checked |
| `/beneficiaries/new` | `beneficiaries:manage` | register, or replace |
| `/beneficiaries/[id]` | `beneficiaries:view` | the record, the identity, the chain |
| `/meetings` | `meetings:view` | what is coming, what is outstanding, the list |
| `/meetings/new` | `meetings:manage` | convene one |
| `/meetings/[id]` | `meetings:view` | the arrangement, the register, minutes, actions |

Plus a beneficiaries-and-claims panel on the membership profile, and the
member's own claims in the portal.

Every register renders cards below `md` and a table from `md` up. The browser
suite measures eleven screens at 390×844 and asserts the page does not scroll
sideways — a table at that width either scrolls or crushes a member's name,
and the person recording a claim is often standing at a counter with a
bereaved family in front of them.

### Four things the screens deliberately do not do

- **No beneficiary name in the claim register**, and the hospital and the
  deceased are not searchable. Searching a column implies being able to
  confirm its contents.
- **No amount and no payee on the payment form.**
- **No "mark as held" control** on a meeting: the status comes from the
  register.
- **No colour that reads as a verdict** on an attendance rate.

---

## F. Financial integrity

| Claim | How it is established |
| --- | --- |
| The benefit subledger equals the three expense accounts | asserted after every operation in `benefit-accounting.test.ts` and by the seeder |
| Account `2100 Member Savings` is untouched by a benefit | asserted directly; a benefit is an expense, not a withdrawal |
| No loan figure moves | `verify-membership-upgrade.mjs`: 28 of 28 identical, every collection date, loan by loan |
| The journal balances | asserted in the seeder suite and by the existing journal triggers |
| One journal entry per payment, none shared, none orphaned | asserted structurally |
| A double payment cannot happen | idempotency key minted server-side; capability checked above the replay |
| Two assessments cannot share one cap | advisory lock plus `assessed`-counting consumption |
| A payment cannot be redirected | the payee is read from the frozen snapshot |

The upgrade verifier's output on this branch:

```
95 existing migrations, a seeded loan book, then 46 new migrations.
Every one of 28 financial figures is identical, the 22 membership, savings,
member loan, benefit and meeting tables exist and are empty, and
2100 Member Savings is zero.
```

---

## G. Demonstration data integration

`POLYTOS_SEED_BENEFITS=yes-seed-polytos-benefit-demo npm run seed:demo`

A third mode on the existing seeder, behind a phrase of its own, refused on
any hosted database and mutually exclusive with the member-loan mode. It
creates **no client and no membership**: every scenario attaches to one of the
six demonstration members the savings seeder already created.

| | |
| --- | --- |
| Beneficiaries | 6 records across 5 members: verified, verified, unchecked, replaced (a supersession chain), refused with a reason |
| Claims | 10: three paid, one paid-then-reversed, one refused with a reason, one left a draft, four held on a named undecided rule |
| Meetings | 4: two held with registers, one with a correction and finalised minutes, one cancelled, one upcoming |
| Reconciliation | the payments total equals `5210+5220+5230`, printed every run |
| Idempotency | a fixed point from the second run; three consecutive runs verified, 0 new rows and 0 shillings posted |

Four of the ten claims are *meant* to be held, and each prints the code it is
waiting on. The controls are what this phase delivers, and a demonstration
showing only successful claims would show none of them.

Everything it writes is labelled: `DEMO` on a name, `DEMONSTRATION` on a
claim's provider, its documents, its notes and its minutes, and **TEST ONLY**
in the title of the policy version — which is what a reader sees on the policy
screen, not a notes field nobody opens.

---

## H. Security

### The four-stage split, and why it is a control rather than a label

```
  Secretary/Treasurer   opens the claim, brings the papers, records next of kin
  Manager               checks the papers, assesses the amount, pays
  Owner                 approves — and is refused if they assessed it
```

`approve_benefit_claim` compares both the profile id **and** the actor label,
so the refusal holds for an Owner who holds both capabilities and for an
assessor whose account has since been archived (where the id is NULL and only
the label remains). The same two-hand shape is enforced for document
verification and beneficiary verification.

### What each role can and cannot read

| | Secretary | Manager | Owner | Borrower |
| --- | --- | --- | --- | --- |
| Claim register | ✓ | ✓ | ✓ | — |
| Open a claim | ✓ | ✓ | ✓ | — |
| Assess | — | ✓ | ✓ | — |
| Approve | — | — | ✓ | — |
| Pay | — | ✓ | ✓ | — |
| A beneficiary's name | — | ✓ | ✓ | own |
| An assessment snapshot | — | ✓ | ✓ | — |
| A bereavement payment row | — | ✓ | ✓ | — |
| Their own claims | — | — | — | ✓ (portal view) |
| An assessor's note | — | ✓ | ✓ | **never** |

Every row of that table is asserted from outside the application, as four
different signed-in users, in `tests/db/benefit-security.test.ts` and again
in the browser suite.

### The sensitive-data decisions

- A beneficiary's name lives in its own table, because policies are
  row-level (ADR-063). The duplicate-registration rule moved to a SHA-256
  digest, which enforces it without holding the data it withholds.
- No notification carries an amount, a name, a hospital or a diagnosis.
- No audit event carries one either: the audit trail records references,
  decisions and amounts, and nothing that would make the audit table a second
  copy of the medical file.
- Document filenames are generated and the originals discarded, because a
  photograph of a death certificate often carries the subject's name in its
  filename.
- Signed URLs live 60 seconds. A link to a death certificate pasted into a
  message would otherwise outlive the conversation.

### What was done about the instructions in the brief

| Instruction | How it is honoured |
| --- | --- |
| Never use the connection named `Primary` | never contacted; the seeder's allow-list names one project reference and refuses everything else |
| Do not request production passwords or keys in chat | none requested; no credential appears in any commit |
| Do not apply Phase 4 migrations to hosted Supabase | not applied; every run was against a local cluster |
| The demo seeder must not alter hosted Supabase | refused by kind, asserted by a test that compares the whole state before and after |
| Do not invent caps, frequencies or waiting periods | all three nullable, no defaults, both arms built |
| Do not pay unverified beneficiaries | refused in `benefit_claim_eligibility` and again at assessment |
| Do not let an assessor approve their own claim | refused by id and by label |
| Do not alter loan or savings agreements | 28 of 28 financial figures identical |
| Do not use demo policy values as approved policy | TEST ONLY in the version title; the local-only refusal |
| Do not create a second ledger | one journal entry per payment, through `post_journal` |
| Do not merge or deploy | no pull request, no deployment |
| Do not begin Phase 5 | not begun |

---

## I. Testing

```
typecheck                               clean
lint                                    clean
format                                  clean
unit + integration                      2,558 passed,  6 skipped
database                                1,761 passed
  Phase 4's own database suites            141 passed
demonstration seeder (savings)             18 passed
borrower reuse                             15 passed
member loan demonstration                  24 passed
benefit demonstration                      25 passed
money arithmetic audit                   clean
production build                         clean, 13 new routes
upgrade + financial regression            28 of 28 identical
browser suite                              44 new specs
```

`docs/POLYTOS-PHASE-4-TEST-REPORT.md` has the detail, including the eleven
defects these tests found and what was done about each.

The six skipped tests are `tests/integration/bundle.test.ts`, which measures
`.next/static` and skips when there is no build to measure: CI's `checks` job
runs the suite before `next build`. `npm run verify` builds first, and then
all six pass.

### What was not run in this container, and what CI found

The browser suite needs a real PostgREST binary, and this environment could
not fetch one — the download was refused by the sandbox, twice. The 44 new
specs therefore ran for the first time in CI, **and the first run failed 30 of
832 specs** over three real defects: a PostgREST column that does not exist, a
function passed from a Server Component to a Client Component, and a form
schema that refused two fields the form labels optional. The second run failed
3 of 838 over two more: an attendance row that never collapsed, so a
correction could not be started, and a misread Phase 1 RLS policy that had the
assignee list presenting one name as the whole staff directory.

All five are fixed, each with a test that would now catch it, and all five are
written up in §2.7–2.11 of the test report. They are recorded here rather than
quietly repaired because they are the answer to a fair question about this
delivery: every other tier of verification was green at the moment that build
had three 500s in it.

### Screenshots

Taken in CI for the same reason the suite runs there — this container has no
PostgREST and no Chromium reachable.
`scripts/capture-benefit-screens.mjs` runs in the browser job after the suite
and before teardown, on the same seeded stack, and uploads nineteen screens at
four viewports plus two screens that need a role other than the Owner, with a
timing table beside them. §J has the artifact.

---

## J. GitHub delivery

| | |
| --- | --- |
| Branch | `claude/eager-hypatia-ub12i1` |
| Verified commit | `7aa1d5a` |
| Commits | 15 (this report's own §J fill-in is the fifteenth) |
| Pull request | **none opened** |
| Merge | **none** |
| Deployment | **none** |
| Hosted Supabase | **untouched** — no Phase 4 migration applied, no seeder run against it |

### The commits

```
6d3d4ec  feat(polytos): Phase 4 database — beneficiaries, benefit claims and meetings
2c95e7c  feat(polytos): the Phase 4 application layer
a919599  feat(polytos): the Phase 4 benefit and beneficiary screens
e92ebc9  feat(polytos): the Phase 4 meeting screens and the member's own view
8703da5  feat(polytos): the Phase 4 demonstration seeder
beef9d7  test(polytos): the Phase 4 unit suites and the browser suite
b0d600d  docs(polytos): the Phase 4 modules, eight ADRs and the test report
34a0bec  fix(polytos): two CI failures — a version collision and the bundle budget
908856f  chore(polytos): a capture script for the Phase 4 screens
1fe95d9  test(polytos): scope the absence assertions to the page, not the shell
c966859  fix(polytos): three defects the browser suite found, and a test for the class
46a1725  chore(polytos): capture the Phase 4 screens in CI, where a browser exists
ba609f1  fix(polytos): the register row stayed open, and the assignee list was misread
7aa1d5a  docs(polytos): the five defects CI found, and three ADRs for the rules behind them
```

The last five are the CI round trips. They are left in the history rather than
squashed, because §2.7–2.11 of the test report refers to them and a delivery
that hid its own corrections would be a worse record than one that shows them.

### CI

**Run: https://github.com/JTREVORM/lending-manager/actions/runs/40492198111**
— commit `7aa1d5a`, all three jobs green.

| Job | Result | What it ran |
| --- | --- | --- |
| checks, unit/integration, build | **success** | typecheck, lint, format, 2,558 passed / 6 skipped (78 files), money audit clean over 71 financial files, secret scan, production dependency audit, `next build` |
| database (real PostgreSQL) | **success** | 1,761 passed (74 files), then the four seeders in sequence — 18, 15, 24, 25 — then the upgrade verifier: 95 existing migrations, a seeded book, 46 new migrations, **28 of 28 financial figures identical**, 22 Polytos tables present and empty, `2100 Member Savings` zero |
| browser E2E (production build, fresh seed) | **success** | **838 specs passed in 15.3 minutes** against the production build on a freshly seeded database, desktop and mobile |

The six skipped tests are `tests/integration/bundle.test.ts`, which measures
`.next/static`; the `checks` job runs the suite before `next build`, so there
is nothing to measure yet. The same job's build then runs, and a separate
local run with a build present passes all six.

### Screenshots

**Artifact: `polytos-phase-4-screens`** on the run above — 23 MB, 30-day
retention, 78 PNGs and `timings.json`.

`scripts/capture-benefit-screens.mjs` ran inside the browser job, after the
suite and before teardown, on the same seeded stack and signed in with the
storage states the suite's `auth.setup.ts` wrote. It asserts nothing and
writes no data; it exits non-zero if any screen fails to answer 200, so the
artifact existing is itself a statement that every screen rendered.

```
76 screen/viewport pairs captured        19 screens × desktop 1440, laptop 1366, tablet 820, mobile 390
 2 screens as somebody other than the Owner
     beneficiary-restricted-secretary     a Secretary on a beneficiary record, with the name withheld
     portal-my-claims                     the borrower's own view of their claims
slowest: benefits-dashboard on desktop, 196ms median
no screen overflows its viewport         maximum horizontal overflow across all 76: 0px
```

Two things a reviewer looking at those images should know, so neither reads
as a defect:

- **Relationship labels say "(harness: treated as eligible)".** The
  demonstration policy opens a condolence vocabulary under a TEST ONLY policy
  version, and the label says so on every screen it appears on. That is the
  seeder refusing to let a demonstration value be mistaken for an approved
  one, as §G requires.
- **A document on the beneficiary record says "could not be opened just
  now".** The Docker-free end-to-end harness has PostgreSQL, PostgREST and
  the auth shim but no storage service, so a signed URL cannot be issued. The
  row, its checked state and its policy are all real; only the file behind it
  is not. The screen degrades with a sentence instead of an error, which is
  the intended behaviour and is why it is visible in the screenshot at all.

### What was not done, by instruction

No pull request was opened. Nothing was merged. Nothing was deployed —
Vercel was not invoked and no deployment was triggered. No Phase 4 migration
was applied to the hosted Supabase project, the demonstration seeder refuses
to run against a hosted project, and the connection named `Primary` was never
used. Phase 5 has not been started.

---

## What Phase 5 will need from this

**The snapshot pattern, again.** A profit distribution is the next thing that
has to be explicable years later: what the business saw when it declared, per
member. `benefit_assessment_snapshots` is the shape — append-only, keyed on
the thing it justifies, with the rules restated as CHECK constraints.

**`benefit_claim_portal_view`.** Phase 5 adds "my profit share" to the
portal, and the column-list-as-disclosure-policy pattern is how to do it: put
the columns a member may read in a view, and let a later `select *` be safe.

**The fifth gate.** `is_profit_sharing_enabled` is already a generated column
waiting on question 6 alone. Nothing new is needed.

**The decision Phase 5 has to make.** Does a distribution pay out in cash or
credit to savings? Different ledger postings follow from each, and crediting
savings would make a distribution increase a liability the member can then
withdraw — which is a different financial event from paying one.
