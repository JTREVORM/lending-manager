# Polytos membership benefits — the module

Ten tables, six views, eleven capabilities and thirty-one new database
functions, added by fourteen migrations numbered
`20261022000100`–`20261022001400`. Meetings are documented separately in
`docs/POLYTOS-MEETINGS.md`; they ship in the same migrations because they
share the notification, audit and Row Level Security work.

Nothing existing was altered destructively: no column dropped, no constraint
relaxed, no policy widened, no row of financial history touched. Two existing
objects were extended rather than duplicated — the `notifications` category
and audit-event CHECK constraints — and one Phase 1 rule was tightened: the
tenth undecided policy rule is now frozen on an approved version, like the
other nine.

---

## 1. The one thing to get right

A member dies. Their next of kin is registered in the system, and
UGX 200,000 is payable. There are two plausible-looking implementations:

```
  post_benefit_payment(claim, method, reference, key, recipient_name)   -- wrong
```

```
  post_benefit_payment(claim, method, reference, key)
  -- the recipient is read from benefit_assessment_snapshots            -- right
```

The first is how the money goes to the wrong person. A payee supplied by
whoever is paying can be anybody: a beneficiary record changed after the
approval, a name typed into a form, a row swapped between the approval and the
payment. The approver signed for a person; the payment would be made to a
string.

So: **the payee is frozen at assessment and read back at payment.** The
snapshot carries the beneficiary's id, number, name, telephone number and the
moment they were verified, and `post_benefit_payment` reads the recipient from
that row — not from the claim, and not from `member_beneficiaries`. The
database refuses a change to a beneficiary record while a bereavement claim on
that membership is live, so the thing the approver agreed to cannot move under
the decision.

The same shape appears three more times:

- `approve_benefit_claim` refuses an approval from whoever assessed the claim,
  by profile id **and** by actor label — so it holds for an Owner who holds
  both capabilities, and for an assessor whose account has since been
  archived, where the id is NULL and only the label remains.
- `verify_benefit_document` refuses a check from whoever attached the
  document. Evidence uploaded and attested by one hand is evidence nobody
  checked.
- `verify_member_beneficiary` refuses a verification from whoever recorded the
  beneficiary.

Each of those is a control rather than a convention, because each is enforced
inside the function that writes, where no caller can reach around it.

---

## 2. Entity relationships

```
   membership_policy_versions ◄──────────┐ policy_version_id (frozen on the claim)
          (Phase 1)                      │
              │ policy_version_id        │
              ▼                          │
          memberships ───────────────────┤
          (Phase 1)   membership_id      │
              │                          │
              ├──────────────┐           │
              ▼              ▼           │
   member_beneficiaries   benefit_claims ┘
              │                 │
              │                 ├────────────► benefit_assessment_snapshots
              │                 │                   (append-only)
              │                 │                          │
              │                 │                          │ the frozen payee
              │                 ▼                          ▼
              │          benefit_payments ──────────► journal_entries
              │            (one journal entry)             (Phase 10)
              │                 │
              ├─────────────────┤
              ▼                 ▼
   member_beneficiary_identities    benefit_claim_documents
        (names, phones)                  (metadata; objects in
         behind its own policy            the private bucket)
```

Two splits in that picture are deliberate and worth stating.

**`member_beneficiary_identities` is a separate table** because Row Level
Security is row-level. A beneficiary's name and telephone number need
`membership:view_sensitive` and the rest of the record does not, and there is
no way to withhold a *column* from a policy — so the sensitive columns live in
a row of their own, behind a policy of their own. It is the same shape
`client_identities` took in Phase 1 for the National Identification Number.
`UPDATE` and `DELETE` on that table are refused outright: a payment
instruction is superseded, never edited.

**`benefit_assessment_snapshots` is append-only** for the reason
`member_loan_eligibility_snapshots` is. "Why was this paid" has to be
answerable years later, after the policy version has been superseded, the
beneficiary record changed and the member's savings moved. Recomputing the
answer from today's data would give a different one, which is not an audit
trail — it is a guess with a date on it.

---

## 3. The three benefits, and the one that is arithmetic

| Benefit | Amount | Who is paid | Expense account |
| --- | --- | --- | --- |
| Medical support | 5% of the eligible hospital bill | the member | `5210` |
| Family condolence | UGX 100,000 | the member | `5220` |
| Member bereavement | UGX 200,000 | the registered next of kin | `5230` |

Three accounts rather than one, because "what did the benefits scheme cost"
and "what did each promise cost" are different questions and a single account
could answer only the first. `5200 Membership Benefits` is a heading and is
not postable; it is a sibling of `5000`, not a child, because the benefits
scheme is not a lending expense.

The medical figure is the only one with arithmetic in it, and it is integer
arithmetic:

```sql
(bill_amount * rate_bps + 5000) / 10000     -- bigint, exactly half-up
```

On a UGX 400,000 bill at 500 bps that is exactly 20,000. In JavaScript,
`400000 * 0.05` happens to be exact and `123455 * 0.05` is
`6172.750000000001` — which floors to 6,172 where the rule says 6,173, one
shilling wrong every time, in the business's favour. `scripts/audit-financial
-arithmetic.mjs` fails the build on a float in a money path, and
`lib/domain/benefits.ts` mirrors the SQL through `applyRateBps`.

The two fixed benefits are read from the policy version rather than written
into a function, because a figure in a posting function cannot be
effective-dated and a member enrolled under the old amount keeps it.

---

## 4. "An admission longer than one day" — three readings, no default

The client's documents say the medical benefit needs an admission longer than
one day. They do not say what is being counted, and three readings are
defensible:

| Monday 22:00 → Tuesday 09:00 | reading | value |
| --- | --- | --- |
| nights slept | `admission_nights` | 1 |
| days on a ward chart | `admission_inclusive_days` | 2 |
| whole days by the clock | `admission_elapsed_days` | 0 |

All three are computed at submission and stored on the claim. The assessment
requires **every** reading to exceed the threshold and refuses with
`admission_measure_undecided` when they disagree. So:

- a stay that qualifies on all three is paid, and waits for nothing;
- a stay that qualifies on none is refused, with a reason a member can be
  shown;
- a stay that qualifies on some is **held**, naming the decision.

That is the same discipline Phase 3 applied to the four interest basis/method
combinations: implement every arm, refuse the one that is not a calculation,
default nothing. The alternative — picking the night count because it is the
commonest reading — would silently decide a rule the business has not, in a
direction that costs or saves it money on every borderline claim.

The readings are stored rather than recomputed so a change in how the code
counts can never alter what was assessed.

---

## 5. The lifecycle, and where each refusal lives

```
 draft ──submit──► submitted ──take up──► under_verification
   │                   │                        │
   │                   └──► information_required ◄┘
   │                                │
   │                        assess  ▼
   └──cancel──────────────────► assessed ──approve──► approved ──pay──► paid
                                   │                     │                │
                                   └──reject──► rejected ◄┘          reversed
```

Ten statuses, and the edges are in one place: `benefit_claim_transition_
allowed()` in the database, mirrored by `BENEFIT_CLAIM_TRANSITIONS` in
`lib/domain/benefits.ts` so a screen can offer only the controls that will
work. A database test asserts the two agree edge for edge.

Three edges are worth explaining:

- **`approved` does not reach `cancelled`.** An approved claim the business
  changes its mind about is a *refusal* by somebody with the authority to
  refuse, with a reason on the record — not a withdrawal note.
- **`assessed` reaches `under_verification` and `information_required`.** An
  approver who disagrees with the arithmetic sends the claim back to the stage
  where the assessment is made. That is not a rejection and must not read as
  one.
- **`reversed` is terminal.** There is no edge back to `approved`, so an
  erroneous reversal cannot make a paid claim payable twice.

The facts freeze at submission: `benefit_claims_guard` refuses a change to the
hospital, the bill, the admission times, the deceased or the event date once
the claim has left `draft`. That is what makes an assessment reviewable — the
figure can be recomputed from the facts, and nobody can move the facts under a
decision already taken. A claim recorded wrongly is withdrawn with a reason
and opened again.

**Nothing is validated at submission.** A claim that cannot succeed is
recorded and then refused with a reason, because a business that could not
write down that somebody came in and asked would keep that record on paper,
where nobody can audit it.

---

## 6. Eligibility is a database decision, returned as a set

`benefit_claim_eligibility(claim_id)` returns every reason a claim cannot be
assessed, as codes with sentences — the shape `validate_loan_for_approval`
established. A claimant told "no verified beneficiary" who fixes that and is
then told "outside the waiting period" has been made to come back twice for
information the business had on the first visit.

Seventeen codes. Six of them are the words *nobody has decided*:

| Code | Means |
| --- | --- |
| `policy_not_open` | the version does not open benefits yet |
| `membership_suspended_undecided` | what a suspension costs a member |
| `admission_measure_undecided` | which of the three readings counts |
| `medical_year_basis_undecided` | calendar year, or enrolment anniversary |
| `relationship_eligibility_undecided` | which relatives the condolence benefit covers |
| `bereavement_loan_offset_undecided` | whether an outstanding loan reduces the benefit |

The other eleven are refusals: the membership cannot claim, the waiting period
has not been served, the admission has not ended or was too short, the year's
claims are spent, the cap would be exceeded, the relationship is not eligible,
no beneficiary is registered or verified, required evidence has not been
checked, the claim is not waiting to be assessed.

**Keeping those two lists apart is the interface's whole job here.** "Your
admission was too short" is a refusal a member can be told. "Nobody has
decided which of three ways we count a day" is the business owing itself an
answer, and showing it as a refusal would tell somebody they had been turned
down when they have not.
`UNDECIDED_BENEFIT_ELIGIBILITY_CODES` names the six, and the claim screen
renders them in a separate panel that says so.

### The annual cap, and the tenth decision

The cap and the claim count are measured over a *year*, and the client's nine
questions do not say which year. A member admitted in December and again in
January has either one year's ceiling or two, so
`medical_benefit_year_basis` is a nullable column with both arms implemented
(`calendar_year`, `enrolment_anniversary`) and no default.

It is deliberately **not** part of the generated `is_benefits_enabled`
column, for the reason ADR-059 kept the monthly anchor off the lending gate:
it bears on one benefit rather than on the activity. Condolence and
bereavement claims have no annual cap and do not wait on it; only a medical
assessment does, and it is refused with its own code.

Phase 4 found that this column was not frozen when the other nine undecided
rules are, and fixed it: `membership_policy_year_basis_guard` refuses the
change once the version is approved or anybody is enrolled under it. A member
enrolled while the rule was open did not agree to the answer somebody writes
into it afterwards.

### Concurrency

Two medical claims for one member must not independently consume the same
remaining cap. `assess_benefit_claim` takes `pg_advisory_xact_lock` on the
membership before it reads the year's consumption, so the second assessment
sees the first.

Consumption counts `assessed`, `approved` **and** `paid` — not paid alone. A
cap that counted only completed payments would let two approvals share one
member's ceiling and leave the business committed to twice what it meant to
be. A `reversed` claim releases its capacity, because the money came back.

---

## 7. Evidence, and why a document existing proves nothing

Every attached document arrives `unchecked`. `assess_benefit_claim` counts
only the **verified** ones, against the kinds its claim type requires:

| Claim type | Required, checked |
| --- | --- |
| Medical | the admission record **and** the invoice |
| Family condolence | evidence of the death **and** of the relationship |
| Member bereavement | evidence of the member's death |

Two for medical because the two facts a medical claim rests on — that the
member was admitted for long enough, and what the bill was — are not reliably
carried by one document.

The objects live in a private bucket, `benefit-documents`, under a path that
is a **predicate** rather than a convention:

```
benefits/<membership_id>/<kind>/<claim_id-or-'beneficiary'>/<object>
```

Segment two is read by `storage_path_membership_id` (Phase 2) and segment
three by `storage_path_kind` (Phase 1) — reused, not rewritten, so there is
one answer to "which membership does this object belong to". Segment four is
new, because evidence belongs to a *claim* as well as to a membership and one
claim's documents must not be reachable from another claim on the same member.

Three layers decide whether a file lands:

1. the bucket's own `allowed_mime_types` and 10 MiB limit;
2. the storage policies, which read the path and refuse an object outside a
   membership the caller may see — and refuse an assessment working paper
   filed by somebody who does not assess;
3. `lib/storage/benefit-documents.ts`, which checks the **first bytes** of the
   file against its declared type. An extension is a claim; magic bytes are
   evidence. A `.jpg` beginning `MZ` is a Windows executable.

The filename is generated and the original discarded, which also closes a
leak nobody thinks about: people photograph documents with phones, and
`Nakato_Beatrice_death_certificate.jpg` would put a bereavement into a path
that appears in logs.

`attach_benefit_document` refuses a path naming an object that does not exist.
A metadata row naming a file nobody uploaded is the decorative-evidence
failure in its purest form: the claim would look documented and there would be
nothing to look at.

---

## 8. The payment, and the single ledger

`post_benefit_payment(claim, method, reference, key)`:

```
  Debit  5210 | 5220 | 5230     the benefit amount
  Credit 1000 Cash on hand  (or the method's account)
```

One journal entry, through `post_journal` — the same function every movement
in this system goes through. There is no second ledger and no benefits
payable account: the obligation is recognised by the cap arithmetic, which
counts an assessed claim, and the expense is recognised when the money moves.

The amount is the approved figure, checked again against the snapshot inside
the function. The recipient comes from the snapshot. Neither is a parameter,
and `payBenefitSchema` has no field for either — a unit test asserts that,
because a field there would be the place a substitution happened.

The capability check sits **above** the idempotency replay (ADR-056): a
caller without `benefits:pay` who presents a key that already exists must be
refused rather than handed back somebody else's payment record.

Reversal posts a contra entry and leaves the original standing, because a
ledger is not editable. It takes `savings:reverse` — the Owner's authority
that already covers reversing any posted movement in this programme — rather
than a new capability, because "may reverse a posted movement" is one
authority and splitting it per module would make it five.

---

## 9. Row Level Security

Ten tables, all `revoke`d bare first — `CREATE TABLE` in this database
inherits default privileges that hand `authenticated` everything, `DELETE`
included — and then granted narrowly.

| Table | SELECT | Writes |
| --- | --- | --- |
| `member_beneficiaries` | `beneficiaries:view`, or the member's own | functions only |
| `member_beneficiary_identities` | `membership:view_sensitive`, or the member's own | functions only; UPDATE/DELETE refused |
| `benefit_claims` | `benefits:view`, or the member's own | functions only |
| `benefit_claim_documents` | with the claim | functions; **DELETE** by `benefits:claim` on an unchecked document |
| `benefit_assessment_snapshots` | `benefits:assess`/`approve`, plus `view_sensitive` for bereavement | append-only |
| `benefit_payments` | `benefits:view`, plus `view_sensitive` where the payee is a beneficiary | functions only |

Three of those lines are the interesting ones.

**A bereavement snapshot needs `membership:view_sensitive`** because the row
carries the payee's name. So a Secretary/Treasurer who may run the claim
register cannot read the assessment behind a bereavement claim, which is
correct: an assessment snapshot is an officer's working record.

**A payment to a beneficiary is withheld from a reader without
`view_sensitive`**, because `recipient_name` is on the row. A
Secretary/Treasurer reconciles medical and condolence benefits, and a
bereavement payment is a row they are not entitled to read rather than a name
they should not have seen. The payments screen says so rather than quietly
showing fewer rows.

**The one DELETE in the phase** is a document that nobody has checked, on a
claim nobody has decided. A mis-attached file on a draft is a thing people
need to undo; evidence an officer acted on is part of the record.

A member reads their own claims through `benefit_claim_portal_view`, whose
**column list is the disclosure policy**. `assessment_note` is not in it,
because that is an officer's reasoning about whether the member's documents
looked genuine. The refusal reason *is* in it, because a member is entitled to
be told why.

---

## 10. Capabilities

Eleven, and the split between four of them is the control:

| Capability | Held by | What it is for |
| --- | --- | --- |
| `beneficiaries:view` | Secretary, Manager, Owner | the register of next of kin |
| `beneficiaries:manage` | Secretary, Manager, Owner | recording and replacing one |
| `beneficiaries:verify` | Manager, Owner | checking one against a document |
| `membership:view_sensitive` | Manager, Owner | a beneficiary's name and telephone number |
| `benefits:view` | Secretary, Manager, Owner | the claim register and the reports |
| `benefits:claim` | Secretary, Manager, Owner | opening a claim, bringing its papers |
| `benefits:assess` | Manager, Owner | checking evidence, working out the amount |
| `benefits:approve` | Owner | agreeing to pay, and refusing |
| `benefits:pay` | Manager, Owner | releasing the money |

Four stages, because a benefit is money leaving the business on the strength
of a document somebody produced. And `approve_benefit_claim` refuses the
assessor even when one person holds both capabilities, which is what makes it
a control rather than a label on a permissions page.

There is deliberately **no** `benefits:reverse` (reversal uses
`savings:reverse`), no `benefits:manage_policy` (benefit figures are policy
version columns, under `membership:manage_policies`) and no `meetings:attend`
(marking a register is `meetings:manage`).

---

## 11. Notifications

Eleven categories, and the rule for every one of them is the same: **no
medical detail, no beneficiary name, no amount.** A notification is a nudge
that something needs attention, read on a phone that may be passed around a
household.

So "your claim has been approved" and not "your UGX 20,000 medical claim for
Mulago has been approved". The amount is on the claim screen, behind a
capability, where the person reading it has signed in.

---

## 12. Screens

| Screen | Guard |
| --- | --- |
| `/benefits` dashboard | `benefits:view` |
| `/benefits/claims` register, `/benefits/claims/{id}` | `benefits:view` |
| `/benefits/claims/new` | `benefits:claim` |
| `/benefits/approvals` | `benefits:approve` |
| `/benefits/payments` | `benefits:pay` |
| `/benefits/reports` | `benefits:view` + the reports rate budget |
| `/beneficiaries`, `/beneficiaries/{id}` | `beneficiaries:view` |
| `/beneficiaries/new` | `beneficiaries:manage` |

The approvals and payments routes are guarded by their own capability rather
than by the section's, because each is a different person's queue — and the
routing table lists the longer prefixes first so `/benefits/approvals` is not
caught by `/benefits`.

Four things these screens do that are worth keeping:

- **The dashboard names the exact undecided rule**, from
  `benefits_blocked_reason()` built out of the policy row — so it stops
  appearing the moment the client decides, rather than going stale.
- **The claim register shows no beneficiary name, on any claim,** and does not
  search the hospital or the deceased. Searching a column implies being able
  to confirm its contents, and typing guesses into a box that matched a
  hospital would confirm which members had been admitted where.
- **The payment form carries neither an amount nor a payee.**
- **The benefits report shows the payment records and the General Ledger side
  by side** and says whether they agree. Two independent paths to one number;
  a report reading one source could not tell anybody when they disagreed.

---

## 13. Tests

| Suite | What it is for |
| --- | --- |
| `tests/db/beneficiaries.test.ts` | registration, the supersession chain, two-hand verification, the identity split |
| `tests/db/benefit-claims.test.ts` | the lifecycle, the frozen facts, the three admission readings, every eligibility code |
| `tests/db/benefit-accounting.test.ts` | the arithmetic, the journal, the three expense accounts, reversal |
| `tests/db/benefit-concurrency.test.ts` | two assessments racing for one annual cap |
| `tests/db/benefit-security.test.ts` | every policy, from the outside, as four different people |
| `tests/db/benefits-undecided.test.ts` | what the module does under the policy the client *actually* has |
| `tests/db/benefit-demo-seed.test.ts` | the demonstration seeder, run for real, three times |
| `tests/unit/benefits.test.ts` | the domain in isolation, with the figures written out by hand |
| `tests/unit/benefit-validation.test.ts` | the write surface, including the two fields that must not exist |
| `tests/e2e/specs/benefits.spec.ts` | the screens in a browser, at 390px, as four roles |
| `tests/e2e/specs/benefits.write.spec.ts` | approving and paying by pressing the buttons in order |

`benefits-undecided.test.ts` is the one that matters for delivery: under a
version where the four benefit rules are undecided — which is what version
1.0 looks like today — **nothing can be assessed, approved or paid**, and
every refusal names the decision.

---

## 14. The demonstration seeder

`POLYTOS_SEED_BENEFITS=yes-seed-polytos-benefit-demo npm run seed:demo`, and
only against a local throwaway database.

It is refused on a hosted project, by kind rather than by name, because it
publishes a policy version answering three decisions the client has not made
and writes synthetic claims, synthetic approvals and synthetic payments. None
of that may appear where it would read as the programme's terms or as a
management decision.

It is also mutually exclusive with the member-loan mode: only one policy
version may be in force, and a version answering both sets would put six
unapproved figures in front of a reader with no way to tell which
demonstration each belonged to.

Ten claims, and four of them are *meant* to be held: a ceiling reached with
partial payment undefined, three admission readings that disagree, a cousin
nobody has ruled on, and a suspended member whose standing nobody has
decided. One is refused with a reason. The controls are what this phase
delivers, and a demonstration showing only successful claims would show none
of them.

---

## 15. Open decisions this phase could not make

These are on the list in `docs/POLYTOS-MEMBERSHIP-POLICY-DECISIONS.md`. Every
one of them is a refusal with the decision named, never a default.

1. **The medical annual cap** (question 7). Nullable; a claim that would
   exceed it is held, because whether a benefit may be paid in part is itself
   undecided.
2. **How many claims a year** (question 8). Nullable; the count is not
   enforced until it is set.
3. **The waiting period** (question 9). Nullable; the check does not run while
   it is NULL, which is the client's present position.
4. **The benefit year** — the tenth decision, found by this phase. Calendar
   year or enrolment anniversary. Both arms implemented.
5. **Which relatives the condolence benefit covers.**
   `beneficiary_relationships.condolence_eligible` is NULL on every row.
6. **What a suspension costs a member.** A suspended member's claim is held.
7. **Whether an outstanding member loan reduces a bereavement benefit** — the
   question Phase 3 left for Phase 4, and Phase 4 is leaving for the client.
   Nothing is netted, no pledge released, no savings touched: where the member
   owes nothing the claim proceeds, and where they owe something it is held.
8. **Who verifies a beneficiary, and against what.** Four evidence kinds are
   offered and the business has not said which it requires.
9. **Whether a member may have more than one beneficiary, and who authorises
   a change.** The schema permits several with exactly one primary, and
   `beneficiaries:manage` records a change — which is a capability, not a
   procedure.

---

## 16. What this phase does not do

- **It does not open benefits.** Version 1.0 leaves three of the four gate
  columns NULL, so `is_benefits_enabled` is false and every assessment is
  refused with the rule named.
- **It does not default a single open decision**, and it does not read a
  demonstration value as an approved one: the TEST ONLY versions say so in
  their title, which is what a reader sees on the policy screen.
- **It does not pay an unverified beneficiary.** Ever, by any route.
- **It does not let an assessor approve their own assessment.**
- **It does not alter a loan or a savings agreement.** No figure, no date, no
  balance, no journal entry — `scripts/verify-membership-upgrade.mjs` proves
  it on a populated book, and `tests/db/benefit-accounting.test.ts` asserts
  that account `2100` is untouched by a benefit payment.
- **It does not create a second ledger.** One journal entry per payment,
  through `post_journal`.
- **It does not implement profit sharing.** Phase 5.
