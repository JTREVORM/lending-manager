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
- `is_financially_enabled` is a **generated** column. It cannot be true while
  any of nine undecided rules is outstanding, and no write can make it so.

**Proof.** 2,280 unit and integration tests, 1,375 database tests across 57
files, 587 browser tests across four viewports, and a dedicated upgrade
check that applies the Phase 1 migrations to a seeded book of 14 loans, 159
payments and 172 journal entries and compares 26 financial figures before and
after. See `docs/POLYTOS-PHASE-1-TEST-REPORT.md`.

---

## Phase 2 — Membership registration and savings management

**Blocked on client decisions 4 and 5.** See
`docs/POLYTOS-MEMBERSHIP-POLICY-DECISIONS.md`.

**Delivers.**

| Item | Notes |
| --- | --- |
| `enrol_member()` | The write path Phase 1 left out. Takes a client, writes a pending membership, takes the terms acceptance and the registration-fee receipt in one transaction |
| `transition_membership()` | The lifecycle write path, with the fee receipt and the signed terms as preconditions of activation |
| `membership_fee_receipts` | A document that posts its own journal. Reference scope `MF` |
| `savings_accounts` | One per membership. Reference scope `SA`. No balance column |
| `savings_transactions` | Deposits, withdrawals and reversals. Append-only, each posting its own journal. Reference scope `SV` |
| `member_savings_balances` | A view. The balance is derived, so a reversal changes it the instant it commits |
| `member_savings_qualification` | A view computing qualifying months against the member's own policy version |
| Ledger accounts `2100`, `4340` | Member Savings (liability), Membership Registration Fees (income) |
| Journal source types | `membership_fee`, `savings_deposit`, `savings_withdrawal` |
| Capabilities | `savings:view`, `savings:record`, `savings:reverse`, `membership_fees:record` |
| Screens | Enrol a member; collect savings; the savings register; a member's savings statement; the register's "Collect savings" action, which Phase 1 deliberately does not show |

**Why decision 4 blocks it.** The qualification calculation is the whole
point of savings in this programme, and whether six qualifying months must be
consecutive changes the query, the view and the answer.

**Why decision 5 blocks it.** A withdrawal screen cannot be built without
knowing whether a withdrawal is permitted against a live member loan.
Deposits could ship without it; a half-built savings module that takes money
and cannot give it back is worse than waiting.

**Proof it is done.** Savings reconcile three ways — per member against their
own transactions, across members against the `2100` ledger balance, and per
branch against `journal_entries.branch_id`. A reversal un-does every one of
the three. The trial balance foots after every operation.

---

## Phase 3 — Member loans and the eligibility engine

**Blocked on client decisions 1, 2 and 3**, and on Phase 2's savings
balances.

**Delivers.**

| Item | Notes |
| --- | --- |
| The member loan product | A row in `loan_products`, with the member terms. Not a parallel lending engine |
| `weekly` repayment cadence | A one-row insert: `interval_days = 7` |
| **Calendar-monthly cadence** | The hard part. See `docs/POLYTOS-EXPANSION-ARCHITECTURE.md` §7 |
| `member_loan_eligibility` | A view: qualified, and the ceiling their savings support |
| Eligibility enforcement | In `validate_loan_for_approval()`, so it is refused at approval and not merely hidden in a form |
| Screens | The member loan application; the eligibility panel on the Membership Profile |

**The compatibility problem, restated because it is the main risk in the
whole expansion.** `generate_loan_schedule()` builds collection dates as
`D + k × interval_days`. That expresses weekly perfectly and cannot express
a calendar month at all — 28, 29, 30 and 31 days are not a fixed interval,
and an `interval_days = 30` cadence would drift a loan disbursed on 31
January onto 2 March. The engine needs a second cadence kind, the existing
arm must stay byte-for-byte identical, and a parity test must regenerate
every existing schedule and prove nothing moved before the new arm is
enabled.

**Why the three decisions block it.** Whether 5% is per month or per loan,
flat or reducing, and what multiple of savings a member may borrow, are the
price and the size of the loan. There is nothing to build without them.

**Proof it is done.** Every existing schedule regenerates byte-identically.
A member loan at each permitted term produces the collection dates the
business expects, including across a 31-day month boundary. An unqualified
member is refused at approval, not only in the form.

---

## Phase 4 — Membership benefits and meetings

**Blocked on client decisions 7, 8 and 9**, and on the verification and
approval steps the documents require but do not describe.

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

Phase 1 is complete and unblocks nothing further on its own: **Phase 2
cannot begin until the client answers questions 4 and 5.** That is the single
most useful thing to take from this roadmap.
