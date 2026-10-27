# Polytos expansion — the six-phase roadmap

One page per phase: what it delivers, what it is blocked by, what proves it
done. `docs/POLYTOS-EXPANSION-ARCHITECTURE.md` holds the design; this holds
the sequence and the dependencies.

Phase 1 is built. Phases 2–6 are planned, and two of them are **blocked on
client decisions** rather than on engineering.

---

## Phase 1 — Foundation and membership architecture ✅ delivered

**Delivers.** The membership record, effective-dated membership policy
versions, the lifecycle and its append-only history, the record of terms a
member accepted, five capabilities, Row Level Security over all of it, and
read-only screens: a Membership Register, a Membership Profile, a Membership
Policy screen, and a Membership section on the Client Profile.

**Deliberately does not deliver.** Enrolment, savings, fees, benefits,
meetings, profit sharing, or any financial posting. No ledger account is
added and no journal source type is changed.

**Key decisions taken.**

- Membership hangs off `clients`, not `profiles`. One identity table.
- Membership is not a role. Five capabilities, four unchanged roles.
- One live membership per client, by partial unique index — so a client who
  withdraws and rejoins keeps both rows.
- The policy is versioned and frozen once referenced. Changing the programme
  publishes a new version; it cannot vary an existing member's terms.
- Readiness is **five generated columns, one per activity**, not one switch.
  Enrolment and the registration fee wait on none of the nine undecided
  rules; savings waits on two of them; benefits and profit sharing on their
  own. None can be ticked, and `membership_policy_allows()` adds the
  effective date on top.
- The branch and the policy version are **derived on every enrolment**, and a
  supplied value that disagrees is refused — for `service_role` too.
- A policy version's status moves one way, and every contractual column
  freezes on approval. Moving a member onto new terms is a recorded
  re-acceptance, never an UPDATE.

**Proof.** 2,294 unit and integration tests, 1,412 database tests across 58
files, 587 browser tests across four viewports, and a dedicated upgrade
check that applies the Phase 1 migrations to a seeded book of 14 loans, 159
payments and 172 journal entries and compares 28 financial figures — every
collection date among them — before and after. See
`docs/POLYTOS-PHASE-1-TEST-REPORT.md`.

---

## Phase 2 — Membership registration and savings management

**Built. The module is complete and the code is reviewed-but-unreleased.** See
`docs/POLYTOS-SAVINGS.md` for the module, and ADR-051 to ADR-058 in
`docs/DECISIONS.md` for the eight decisions it settled.

**Still waiting on client decisions 4 and 5 to *operate*.** The distinction is
the point of the activity-specific gate (ADR-049): the software is built and
tested, and `is_savings_enabled` — a generated column waiting on exactly those
two answers — is what decides whether a deposit can be taken. So:

- **Enrolment and the registration fee work now.** They wait on none of the
  nine questions.
- **Savings open the moment questions 4 and 5 are answered**, by publishing a
  policy version carrying the answers. No migration, no deploy, no code
  change.
- **Both arms of question 4 are implemented** and neither is a default. While
  it is open, nobody is shown as qualified and the screen says why.
- **Two of the three readings of question 5 are implemented.** The third,
  `above_pledged`, is refused with a message naming what has to be settled,
  because the excess over what secures a loan needs question 3 as well.

What Phase 2 deliberately did **not** build, because the rules are undecided:
benefit claims, the profit share, member loans, a membership status screen, an
account closure workflow. See §13 of `docs/POLYTOS-SAVINGS.md`.

**Delivers.**

| Item | Notes |
| --- | --- |
| `enrol_member()` | The write path Phase 1 left out. Takes a client, writes a pending membership, takes the terms acceptance and the registration-fee receipt in one transaction |
| `transition_membership()` | The lifecycle write path. `pending -> active` is refused unless both preconditions below hold |
| `membership_fee_receipts` | A document that posts its own journal. Reference scope `MF` |
| `savings_accounts` | One per membership. Reference scope `SA`. No balance column |
| `savings_transactions` | Deposits, withdrawals and reversals. Append-only, each posting its own journal. Reference scope `SV` |
| `member_savings_balances` | A view. The balance is derived, so a reversal changes it the instant it commits |
| `member_savings_qualification` | A view computing qualifying months against the member's own policy version |
| Ledger accounts `2100`, `4340` | Member Savings (liability), Membership Registration Fees (income) |
| Journal source types | `membership_fee`, `savings_deposit`, `savings_withdrawal` |
| Capabilities | `savings:view`, `savings:record`, `savings:reverse`, `membership_fees:record` |
| Screens | Enrol a member; collect savings; the savings register; a member's savings statement; the register's "Collect savings" action, which Phase 1 deliberately does not show |

**Two preconditions Phase 2 must enforce in the database, not in a form.**
`memberships_guard_transition()` already refuses a transition that is the
wrong *shape*. Phase 2 must add the two that say the member actually paid and
actually agreed, as `exists (...)` tests in that trigger, above the
trusted-path exemption so they bind `service_role` too:

1. **A registration fee that posted.** A `membership_fee_receipts` row whose
   journal entry exists and has not been reversed. The test is the journal,
   not a status column on the receipt — "successfully posted" means the
   ledger moved.
2. **An acceptance of the member's own terms.** A
   `membership_terms_acceptances` row for this membership *and* the exact
   `policy_version_id` it carries. Accepting version 1.0 does not activate
   somebody enrolled under 1.1.

A membership that reached `active` without both is a person the business is
taking savings from under terms nobody can show they agreed to. Every route
to the table must be refused, not only the one the form takes — which is why
`enrol_member()` is a database function writing the membership, the receipt,
its journal and the acceptance in one transaction, rather than three calls
from a Server Action.

**And consent must be evidence, not a typed name.**
`membership_terms_acceptances.signature_name` is free text that any
capability holder can type on somebody else's behalf. Phase 2 must require,
by CHECK constraint, at least one artefact that did not originate with the
person typing: a signature image at `signature_path`, a witnessed record
whose witness is not `recorded_by`, or a confirmation the member themselves
sent — a portal acknowledgement under their own `clients.profile_id`, or a
one-time code returned from the phone number on the client record. The rule
applies equally to the acceptance taken at enrolment and to a later
re-acceptance through `accept_membership_policy_version()`. See ADR-050.

**Why decision 4 blocks it.** The qualification calculation is the whole
point of savings in this programme, and whether six qualifying months must be
consecutive changes the query, the view and the answer.

**Why decision 5 blocks it.** A withdrawal screen cannot be built without
knowing whether a withdrawal is permitted against a live member loan.
Deposits could ship without it; a half-built savings module that takes money
and cannot give it back is worse than waiting.

**Proof it is done.** No membership reaches `active` without a posted,
unreversed fee journal and an acceptance of its own policy version — asserted
by attempting both omissions as a real authenticated role and as the table
owner. No acceptance row exists carrying only a typed name. Savings reconcile
three ways — per member against their
own transactions, across members against the `2100` ledger balance, and per
branch against `journal_entries.branch_id`. A reversal un-does every one of
the three. The trial balance foots after every operation.

---

## Phase 3 — Member loans and the eligibility engine — **built**

**Shipped**, with member lending held closed. Ten migrations numbered
`20261021000100`–`20261021001000`. Full specification:
`docs/POLYTOS-MEMBER-LOANS.md`.

The three client decisions this phase was blocked on are **still open**, and
the phase was built anyway. That is the change of approach worth recording:
the infrastructure is complete and tested, every screen exists, and the
database refuses to approve a loan that depends on an unanswered question.
Waiting would have meant a phase delivered later and no sooner — the answers
do not arrive faster for the code not existing.

**Delivers.**

| Item | Notes |
| --- | --- |
| The member loan product | `ML` in `loan_products`, with `requires_membership` and `interest_source = 'membership_policy'`. Ships **inactive**. Not a parallel lending engine |
| `weekly` repayment cadence | `cadence_kind = 'fixed_days'`, `interval_days = 7`, active |
| **Calendar-monthly cadence** | `cadence_kind = 'calendar_month'`, `interval_days` NULL, `month_anchor` write-once. Ships **inactive** |
| `monthly_collection_date()` | Both anchor conventions, implemented and tested; neither a default |
| `member_loan_eligibility_of()` | The assessment: 31 columns, `SECURITY DEFINER`, revoked from every role |
| `member_loan_eligibility` | The view, `security_invoker`, behind `member_loans:view_eligibility` |
| `member_loan_savings_pledges` | The savings a live member loan restricts. Append-only, no journal entry |
| `member_loan_eligibility_snapshots` | What the business saw at approval, frozen. Append-only |
| Eligibility enforcement | Ten new failure codes in `validate_loan_for_approval()`, re-evaluated inside `approve_loan` under an advisory lock |
| Screens | `/member-loans` (two registers), `/member-loans/new`, the eligibility panel on the membership record, the member loan panel on the loan |
| `member_loan_summary()` | Twenty figures, all derived. No total ceiling, deliberately |

**The compatibility problem, as it was actually solved.**
`generate_loan_schedule()` built collection dates as `D + k × interval_days`,
which expresses weekly perfectly and cannot express a calendar month at all.
It now has two arms and the fixed-day arm was copied **character-for-character**.
`generator_version` stays `1` for `fixed_days` and is `2` only for
`calendar_month`, because the fixed-day rules did not change.

`interval_days = 30` was never on the table: it would drift a loan disbursed
on 31 January onto 2 March, and it is a different contract that happens to
look similar.

**A fourth decision, which was not on the original list.** A calendar month is
not always well defined — a loan disbursed on 31 January has no 31 February —
so somebody has to say whether that collection falls on the last day of the
month it lands in or the first day of the next. It is recorded as
`repayment_frequencies.month_anchor` rather than as a tenth policy question,
because it is a property of the cadence and not of the membership programme.
See ADR-059.

Its consequence is the one nobody would guess: **answering only decisions 1, 2
and 3 opens weekly member loans of one and two months and leaves three-, four-
and five-month loans refused.** The interface says so rather than claiming
nothing can be approved.

**Proof it is done.** Every existing schedule regenerates byte-identically —
asserted by `tests/db/schedule-parity.test.ts` and by the
`installment_schedule` figure in `scripts/verify-membership-upgrade.mjs`, which
compares every collection date loan by loan across a populated upgrade. A
member loan at each permitted term produces the collection dates the business
expects, including across every 31-day month boundary of a year
(`tests/db/calendar-month-schedule.test.ts`). An unqualified member is refused
at approval by the database, asserted as a real authenticated role and as the
table owner. Two concurrency races — two approvals against one savings
balance, and a withdrawal against an approval — are run with real concurrent
transactions.

**Three defects the new tests found in the eligibility ceiling**, all fixed:
capacity already consumed by a live pledge was ignored, so a member could
borrow twice against the same savings; pending withdrawals were not reserved,
so a member could borrow against money on its way out; and the ceiling rounded
half-up while the pledge rounds up, which disagreed below a 1× multiplier.

**What remains before member lending can open.** Four answers, and two
configuration changes the business makes on a screen:

1. decisions 1, 2 and 3 answered on a new policy version;
2. `repayment_frequencies.month_anchor` chosen, and the `monthly` cadence
   activated;
3. the `ML` product activated.

Note that publishing a new policy version supersedes the current one, and a
savings account is frozen to the version it was opened under — so the accounts
already open need handling deliberately at that point. See
`docs/POLYTOS-MEMBER-LOANS.md` §12.

---

## Phase 4 — Membership benefits and meetings — **built**

**Built, and still blocked on client decisions 7, 8 and 9** — which is the
state the phase was designed to be deliverable in. Every arm of every rule is
implemented, nothing is defaulted, and while any of the three is open
`is_benefits_enabled` is false and no claim can be assessed, approved or
paid. What *is* open is recording a claim, attaching its evidence, checking
that evidence, and registering and verifying next of kin — because a business
that could not write down that somebody came in and asked would keep that
record on paper.

See `docs/POLYTOS-BENEFITS.md` and `docs/POLYTOS-MEETINGS.md` for the modules,
and `docs/POLYTOS-PHASE-4-DELIVERY-REPORT.md` for what was verified.

**Delivers.**

| Item | Notes |
| --- | --- |
| `member_beneficiaries` | Next of kin. The bereavement benefit is payable to them, so this is a payment instruction and the first genuinely sensitive membership data |
| `membership:view_sensitive` | Arrives here, with the table it guards |
| `benefit_claims` | Medical, family condolence, member bereavement. Reference scope `BC` |
| `benefit_claim_documents` | Evidence, in the private documents bucket |
| `post_benefit_payment()` | Debits the benefit expense account, credits cash. Never a disbursement |
| Ledger accounts `5200`–`5230` | The benefits heading and its three children |
| Journal source type | `benefit_payment` |
| `membership_meetings`, `meeting_attendance` | Monthly meetings and who came |
| Membership cards | A card number on the membership, unique where issued |
| Membership notifications | A new category on the existing stream, not a new mechanism |
| Capabilities | `beneficiaries:view`, `beneficiaries:manage`, `benefits:view`, `benefits:claim`, `benefits:assess`, `benefits:approve`, `benefits:pay`, `meetings:view`, `meetings:manage` |

**The control that must not be collapsed.** Assessing a claim and approving
it are separate capabilities, and the posting function must refuse an
approval from the person who assessed it — exactly as `record_transfer` and
`record_expense` already refuse an approval from the person who asked. A
benefit is money leaving the business on the strength of a document somebody
produced.

**The arithmetic.** 5% of a hospital bill is `(bill * 500) / 10000` in
`bigint` with explicit rounding, never `bill * 0.05` in JavaScript.
`scripts/audit-financial-arithmetic.mjs` fails the build on the latter.

**Proof it is done.** A claim cannot be approved by its assessor. A claim
above the annual cap is refused or part-paid, per the client's answer. A
bereavement claim is refused where no next of kin is registered. The
`membership:view_sensitive` matrix is asserted per role, and a borrower
reads their own beneficiaries and nobody else's.

**What was delivered against that, and the four places it differs.**

1. **"Refused or part-paid, per the client's answer"** became *held*. A claim
   that would exceed what is left of the cap is refused with
   `medical_cap_exceeded` and not trimmed, because whether a benefit may be
   paid in part is itself undecided — paying the remainder would be inventing
   a rule in the member's disfavour. Both arms of the cap are implemented; the
   third behaviour nobody asked for is not invented.

2. **"A borrower reads their own beneficiaries"** became *a borrower reads
   none*. A beneficiary record is a payment instruction and the policy on
   `member_beneficiaries` has a member clause, but `member_beneficiary_
   identities` — the names and telephone numbers — is a separate table behind
   `membership:view_sensitive`, because Row Level Security cannot withhold a
   column. A member sees their own claims through
   `benefit_claim_portal_view`, whose column list is the disclosure policy.

3. **Membership cards shipped in Phase 2**, not here: Phase 2 needed a card
   number for the savings counter. This phase left that table alone.

4. **Three decisions were found that the roadmap did not name**: the benefit
   year (calendar or anniversary — the tenth policy question), which relatives
   the condolence benefit covers, and whether an outstanding member loan
   reduces a bereavement benefit. All three are refusals naming the decision,
   and all three are recorded in
   `docs/POLYTOS-MEMBERSHIP-POLICY-DECISIONS.md`.

**And two tightenings to earlier phases**, both in the same direction:
`medical_benefit_year_basis` is now frozen on an approved policy version like
the other nine undecided rules, and three Phase 4 reporting functions had
their capability checks moved inside the `auth.uid() is null` exemption that
`savings_summary` states — the trusted path holds no capability to check, and
could not read its own figures.

---

## Phase 5 — Profit sharing, member portal and financial reporting

**Blocked on client decision 6**, on the retained-earnings question in
`docs/POLYTOS-EXPANSION-ARCHITECTURE.md` §6, and on a full year of savings
history from Phase 2.

**Delivers.**

| Item | Notes |
| --- | --- |
| `profit_distributions` | One per year. Reference scope `PD` |
| `profit_distribution_members` | A member's share, computed from the formula |
| `declare_profit_distribution()` | Moves retained earnings to `2200` Distributions Payable |
| `post_distribution_payment()` | Debits `2200`, credits cash |
| Ledger account `2200` | Member Profit Distributions Payable |
| Journal source type | `profit_distribution` |
| Member portal surfaces | My membership, my savings, my benefit claims, my profit share |
| Member statements | A rendering of posted records, reconciling to the ledger |
| Membership reports | New rows in `lib/reports/registry.ts`, using the existing filter, CSV and letterheaded-PDF pipeline |
| Capabilities | `distributions:view`, `distributions:manage`, `distributions:approve`, `distributions:pay` |

**The rule the design turns on.** A distribution is **not** a savings
withdrawal. Declaring one creates a new liability; withdrawing savings
reduces one the member always had. Two accounts, so the two cannot be netted
by accident, and a member's statement shows them as two different things.

**What the portal must decide, not inherit.** Phase 1 withholds
`membership_status_history` from the member, because a suspension reason is
an internal note written about them. What the portal says about a member's
standing is a wording decision, and it belongs to this phase.

**Proof it is done.** The sum of every member's share equals the declared
distribution. The `2200` balance equals the declared total less the paid
total. A member reads their own figures and nobody else's, asserted as a
real database role. A statement's totals equal the ledger's.

---

## Phase 6 — Security, integration testing and production certification

**Blocked on everything above.** Deliberately plans no migrations: a phase
that writes its own migrations in advance has pre-judged its own review.

**Delivers.**

| Item | Notes |
| --- | --- |
| Full-system security review | Every capability, every policy, every definer function, every grant, re-asserted as one inventory |
| Cross-module integration tests | A member enrolled, saving, borrowing, claiming and sharing profit, in one scenario, with the books footing at every step |
| Financial invariants | Savings reconcile three ways; the loan book is unaffected by membership; the trial balance foots; no orphan document and no document without its journal |
| Performance certification | Against a book an order of magnitude larger than today's, on the free tier's constraints |
| Production runbook | Migration order, the pre-deployment checklist, the rollback position for each phase |
| The deployment itself | Which, until it happens, nothing in this expansion has touched |

**What certification must not be allowed to mean.** A green suite. The
Phase 8 review of this codebase found three defects behind 2,584 passing
tests, every one visible in ten minutes of opening the application. Phase 6
is not done until somebody has enrolled a member, taken their savings,
lent to them, paid them a benefit and shared their profit, in a browser, and
read the resulting trial balance.

---

## The critical path

```
          ┌── decisions 4, 5 ──┐
          │                    ▼
Phase 1 ──┤              Phase 2 (savings) ──┐
          │                    │             │ savings balances
          │                    ▼             ▼
          ├── decisions 1,2,3 ────────► Phase 3 (member loans)
          │                                  │
          ├── decisions 7,8,9 ──────► Phase 4 (benefits) ──┐
          │                                                │
          └── decision 6 ─────────────► Phase 5 ◄──────────┘
             + retained earnings          (profit, portal, reports)
                                               │
                                               ▼
                                          Phase 6 (certification)
```

Phases 1, 2 and 3 are all built, and none of the nine decisions has been
answered. That is not a contradiction: the diagram above shows which answers
each phase's *operation* waits on, not which it needs to be **written**. The
single most useful thing to take from this roadmap is now the shape of what
remains:

- **Savings cannot be *taken* until the client answers questions 4 and 5.**
  The module is written, tested and reviewed; answering those two and
  publishing a policy version carrying the answers is all that opens it.
- **Member lending cannot be *approved* until questions 1, 2 and 3 are
  answered** — the interest basis, the interest method, and the
  savings-to-loan multiplier — **and a fourth decision that was not on the
  original list**: what a calendar-monthly collection does in a month that has
  no such day (`repayment_frequencies.month_anchor`, ADR-059). Answering the
  three policy questions and not the fourth opens weekly member loans of one
  and two months and leaves longer ones refused.

  Phase 3 approves against `member_savings_qualification`, which Phase 2 built
  with an "as of" date for exactly that purpose.
- **Phase 4 (benefits) needs questions 7, 8 and 9**, plus the further
  questions about what evidences an admission and who verifies it.
- **Phase 5 (profit sharing) needs question 6**, and depends on the savings
  liability being a liability — which ADR-051 is about, and which is why
  getting it right in Phase 2 mattered more than any screen in it.

One thing to plan for before any of those answers is published: a savings
account is frozen to the policy version it was opened under, so a new version
supersedes the old one and the accounts already open stop qualifying until
they are handled deliberately. See `docs/POLYTOS-MEMBER-LOANS.md` §12.
