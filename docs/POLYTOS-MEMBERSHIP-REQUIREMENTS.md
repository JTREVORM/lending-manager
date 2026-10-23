# Polytos membership — requirements catalogue

Every requirement the client's two documents imply, classified. The columns
mean:

- **Status** — `Confirmed` (stated in the client's documents), `Proposed`
  (this system's reading, to be confirmed), `Undecided` (nobody has decided),
  `Described` (named as an activity with no figure attached).
- **Phase** — which of the six Polytos phases delivers it.
- **Validation** — what the system must refuse, and where.
- **Financial treatment** — how money moves, in the vocabulary of the
  existing general ledger. Nothing in this column is implemented in Phase 1;
  see `docs/POLYTOS-EXPANSION-ARCHITECTURE.md` §6.

`docs/POLYTOS-MEMBERSHIP-POLICY-DECISIONS.md` holds the nine undecided
questions in full, with what each one blocks.

---

## 1. Membership

| Requirement | Status | Phase | Validation | Financial treatment |
| --- | --- | --- | --- | --- |
| A client may become a member | Confirmed | 1 (foundation), 2 (enrolment) | One live membership per client, by partial unique index `memberships_one_live_per_client`. A non-member remains a valid client. | None. Membership is a relationship, not a transaction. |
| Registration fee of UGX 5,000 | Confirmed | 2 | Whole shillings; charged once per membership; a receipt is required before activation | **Income.** Debit the cash account the fee arrived in; credit a registration-fee income account. Never part of savings. |
| Minimum monthly savings of UGX 50,000 | Confirmed | 2 | A floor, not a fixed instalment — a member may save more. Refuse a deposit below it only if the client confirms it should be refused; the documents say "minimum", which this system reads as a qualification threshold rather than a rejection rule | **Liability.** Debit cash; credit member savings. A deposit is never income. |
| Savings qualification period of six months | Confirmed | 2 (accrual), 3 (eligibility) | Whether the months must be consecutive is **undecided** (question 4) | None of itself. |
| Membership card | Described | 4 | A card number must be unique if one is issued; no column exists yet | None. |
| Monthly membership meetings | Described | 4 | A meeting has a date, a quorum rule (unspecified) and an attendance record | None, unless a fine or a levy is introduced — not described. |
| Year-end profit sharing | Described | 5 | The formula is **undecided** (question 6) | **Equity → liability → cash.** Declaring a distribution moves retained earnings to a member-distributions liability; paying it debits that liability and credits cash. Never a savings withdrawal. |
| Membership lifecycle: pending, active, suspended, withdrawn, deceased | Confirmed (as a design requirement) | 1 | Transitions enforced by `memberships_guard_transition`; a reason required for suspension and withdrawal; terminal states are terminal | None. |
| Membership status history | Confirmed (as a design requirement) | 1 | Append-only; written only by trigger | None. |
| Members accept the terms they are shown | Confirmed (as a design requirement) | 1 (table), 2 (capture) | Version referenced and denormalised; one acceptance per version per membership; evidence cannot be edited | None. |

---

## 2. Member lending

| Requirement | Status | Phase | Validation | Financial treatment |
| --- | --- | --- | --- | --- |
| Advertised interest rate of 5% | Confirmed | 3 | Within `business_settings` ceilings, like every other product | **Income on receipt**, as the existing engine already does: the interest component of a payment credits Interest Income. Interest charged and not received is not an asset under this model. |
| Whether 5% is per month or per loan | **Undecided** (q.1) | 3 | — | — |
| Whether interest is flat or reducing balance | **Undecided** (q.2) | 3 | A flat method needs its own breakdown function; the existing one is reducing-balance monthly | — |
| Maximum duration of five months | Confirmed | 3 | Product `max_term_months = 5` | — |
| Eligibility after qualifying savings | Confirmed | 3 | Refuse an application from a member who has not qualified; the qualification rule depends on q.4 | — |
| A loan may exceed total savings, by a defined formula | Confirmed that it may; **formula undecided** (q.3) | 3 | The eligibility ceiling is `savings_balance × multiplier` | — |
| Weekly repayment for one- and two-month loans | Confirmed | 3 | Cadence chosen from the term | — |
| Monthly repayment for longer loans | Confirmed | 3 | **Incompatible with the current scheduling engine** — see §7 of the architecture document. `repayment_frequencies.interval_days` cannot express a calendar month. | — |
| A member may hold multiple loans if existing policy permits | Confirmed | 3 | `business_settings.max_active_loans_per_client`, which stays global | — |

---

## 3. Non-member lending

| Requirement | Status | Phase | Validation | Financial treatment |
| --- | --- | --- | --- | --- |
| Loans without the savings requirement | Confirmed | 3 | No membership check on a non-member product | Unchanged from today. |
| Advertised maximum term of three months | Confirmed | 3 | Product `max_term_months = 3` | — |
| All other terms per approved product settings | Confirmed | 3 | The existing product guard rails apply | — |

Non-member lending is what the system does **today**. Phase 3 does not change
it; it adds a member product beside it and records the three-month advertised
maximum as a membership policy statement (`non_member_loan_max_term_months`)
so a future product can be checked against it.

---

## 4. Benefits

| Requirement | Status | Phase | Validation | Financial treatment |
| --- | --- | --- | --- | --- |
| Medical support: 5% of eligible hospital bills | Confirmed | 4 | The bill amount is evidence, entered with a document; 5% is computed, never typed | **Expense.** Debit a member-benefits expense account; credit the cash account the payment left. Never a loan disbursement. |
| After admission longer than one day | Confirmed; the exact reading is **Proposed** | 4 | Admission and discharge dates required; duration computed | — |
| Annual cap on medical support | **Undecided** (q.7) | 4 | A claim above the cap must be refused or part-paid; which, is undecided | — |
| Medical claims per year | **Undecided** (q.8) | 4 | — | — |
| Family condolence support: UGX 100,000 | Confirmed | 4 | A fixed amount, not computed from evidence | **Expense**, as above. |
| Member bereavement support: UGX 200,000 | Confirmed | 4 | Paid to the **registered next of kin**, so a next-of-kin record must exist before a claim can be approved | **Expense**, as above. |
| Evidence verification and approval | Confirmed as a requirement; the steps are **undecided** | 4 | A claim carries documents, an assessor and an approver; the approver must not be the assessor, following the money-movement controls already in the system | — |
| Waiting period before a first claim | **Undecided** (q.9) | 4 | — | — |

---

## 5. Additional activities

| Requirement | Status | Phase | Validation | Financial treatment |
| --- | --- | --- | --- | --- |
| Mobile money services | Described | 5, and partly already present | MTN and Airtel are already payment methods with their own cash accounts and their own charges account (`5070 Mobile Money Charges`). What "mobile money services" adds beyond collection — a float sold to the public, an agency — is not described and is **not assumed**. | If it means agency banking, it is a new business line with its own accounts, not an extension of membership. Flagged for the client. |
| Membership notifications | Described | 4 | The existing notification stream is capability-addressed and append-only; a membership notification is a new category, not a new mechanism | None. |
| Member financial statements | Described | 5 | A statement is a rendering of posted records. It must reconcile to the ledger, not re-derive figures. | None. |

---

## 6. Requirements this catalogue adds, which the documents do not state

Each is a design requirement the brief imposes rather than a business rule the
client wrote, recorded here so the distinction survives:

| Requirement | Why |
| --- | --- |
| Member savings must never be treated as company income | A deposit is money the business owes back. Crediting income would overstate profit and understate the liability — and the year-end distribution is computed from profit. |
| Registration fees must remain separate from savings | One is income, the other a liability. A single account could not produce either figure. |
| Benefit payouts must be recorded separately from loan disbursements | A disbursement creates a receivable; a benefit is an expense. Mixing them would make the loan book wrong. |
| Profit distributions must not be confused with savings withdrawals | A withdrawal reduces a liability the member always had; a distribution creates a new one. |
| Every monetary movement must reconcile to the existing General Ledger | There is one ledger. A membership module with its own balances would be a second set of books. |
| Historical loan terms must remain unchanged | Already guaranteed by `loan_product_snapshots` and `loan_periods`; the membership work must not weaken it, which `scripts/verify-membership-upgrade.mjs` verifies. |
| Member policies must be effective-dated and auditable | A member enrolled in March keeps March's terms. Implemented in Phase 1. |
| Every sensitive record follows the existing authorization model | One capability matrix, one set of RLS conventions. No second identity system and no second permission vocabulary. |
