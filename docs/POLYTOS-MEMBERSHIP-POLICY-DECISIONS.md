# Polytos membership policy — what is settled and what is not

This document exists so that nobody has to guess. It separates three things
that are easy to blur: what the client's own documents state, what this
system has **proposed** as a configuration value, and what nobody has
decided yet.

Nothing in this document is an approval, a licence condition, or a legal
opinion. The client has provided licensing documentation for the planned
financial activities; this file records the **business rules** that
documentation implies and the ones it leaves open. It does not reproduce,
summarise or interpret the licence itself, and no statement here should be
read as confirming that any activity has been licensed.

---

## 1. Confirmed by the client's documents

These figures are stated in the material the client supplied. They are
`NOT NULL` columns on `public.membership_policy_versions`, carrying exactly
these values in version 1.0.

| Rule | Value | Column |
| --- | --- | --- |
| Registration fee | UGX 5,000 | `registration_fee` |
| Minimum monthly savings | UGX 50,000 | `monthly_savings_minimum` |
| Savings qualification period | 6 months | `savings_qualifying_months` |
| Advertised member interest rate | 5% (500 bps) | `member_loan_interest_rate_bps` |
| Maximum member loan term | 5 months | `member_loan_max_term_months` |
| Weekly collection applies up to | 2 months | `member_loan_weekly_cadence_max_months` |
| Maximum non-member loan term | 3 months | `non_member_loan_max_term_months` |
| Medical support rate | 5% of an eligible hospital bill | `medical_benefit_rate_bps` |
| Medical support admission threshold | Longer than 1 day | `medical_benefit_min_admission_days` |
| Family condolence support | UGX 100,000 | `family_condolence_benefit` |
| Member bereavement support | UGX 200,000, to the registered next of kin | `member_bereavement_benefit` |

The programme also includes, as described activities rather than as numbers:
membership cards, monthly membership meetings, year-end profit sharing,
mobile money services, membership notifications and member financial
statements. Each is a later phase; none has a configuration value yet.

### What "confirmed" does and does not mean here

It means the figure came from the client's document rather than from this
system. It does **not** mean the figure is approved for operation: version 1.0
is a **draft**, it is unapproved, and `is_financially_enabled` is `false`.
See §4.

---

## 2. Proposed configuration values

Two values in version 1.0 are this system's reading of a sentence rather than
a figure the client wrote, and both should be confirmed:

| Proposed | Why it is a reading rather than a quotation |
| --- | --- |
| `medical_benefit_min_admission_days = 1`, meaning the admission must be **strictly longer than** one day | The document says "admission longer than one day". Whether a 36-hour stay qualifies, and whether the count is nights or calendar days, is not stated. |
| `member_loan_weekly_cadence_max_months = 2` | The document says weekly repayment "for loans lasting one or two months" and monthly for longer. Two is the boundary that sentence implies; it is recorded as a value so a different boundary is a policy change rather than a code change. |

---

## 3. Undecided — nine questions that must be answered before Phases 2–5

Every one of these is a **nullable** column whose `NULL` means *the client has
not decided*. None has a default, because a default here would be an invented
policy. `tests/unit/membership.test.ts` asserts that a decided `false` and a
decided `0` both count as decided, so answering a question with "no" or "none"
is a real answer and not an absence.

| # | Question | Column | Why it blocks a phase |
| --- | --- | --- | --- |
| 1 | Is the 5% charged **per month** or **once per loan**? | `interest_basis` | On a five-month loan the difference is five-fold. Phase 3 cannot price a member loan without it. |
| 2 | Is member interest **flat** on the original principal, or on a **reducing balance**? | `interest_method` | The existing engine computes reducing balance monthly. A flat member product needs its own method and its own schedule. |
| 3 | What multiple of savings may a member borrow? | `savings_to_loan_multiplier_bps` | The documents say a loan may exceed total savings "subject to a defined eligibility formula". The formula is the one thing not defined. Phase 3's eligibility engine is entirely this number. |
| 4 | Must the six qualifying months be **consecutive**? | `qualifying_months_consecutive` | Decides whether a missed month restarts the clock. Phase 2 cannot compute qualification without it. |
| 5 | May savings be **withdrawn** while a member loan is active? | `savings_withdrawal_with_active_loan` | Three readings are plausible — allowed, blocked, or only the excess above what secures the loan. Phase 2 cannot offer a withdrawal at all. |
| 6 | How is the year-end profit share **calculated**? | `profit_distribution_basis` | Pro-rata on savings, pro-rata weighted by months held, or equal shares. Phase 5 is this formula. |
| 7 | What is the **annual cap** on the medical benefit per member? | `medical_benefit_annual_cap` | 5% of an uncapped bill is an uncapped liability. Phase 4 cannot assess a claim against no ceiling. |
| 8 | How many medical **claims a year** may a member make? | `medical_benefit_claims_per_year` | Same reason. |
| 9 | Is there a **waiting period** between enrolment and a first benefit claim? | `benefit_waiting_period_days` | Zero and "none" are the same answer; "nobody has said" is not. Phase 4 needs the number. |

### Further questions these raise, which the documents do not reach

Recorded rather than answered, and deliberately **not** given columns in
version 1.0 — a column is a commitment to a shape, and these may not have the
shape guessed for them:

- **What counts as a qualifying month?** A deposit of at least UGX 50,000 in
  the calendar month, or a cumulative balance that reaches six multiples of
  it? (Bears on question 4.)
- **What happens to savings when a membership is withdrawn or the member
  dies?** The balance is a liability of the business; who it is paid to, over
  what period, and whether it offsets an outstanding member loan, is not
  stated.
- **Is the registration fee refundable?** It is income to the business in this
  design, which assumes not.
- **Does suspension stop savings, stop benefits, or both?** The lifecycle has
  the state; the consequences are not specified.
- **Who is an eligible family member** for the condolence benefit, and what
  evidence establishes the relationship?
- **What evidence establishes a hospital admission**, and who verifies it?
  The documents require "evidence verification and approval"; the
  verification steps and the approver are not named.
- **Who may be a registered next of kin**, how many, and how is a change
  recorded? (The bereavement benefit is payable to them, so this is a
  payment instruction.)
- **Is a monthly meeting attendance obligation**, and does missing one affect
  standing?
- **Does the profit share pay out in cash, or credit to savings?** Different
  ledger postings follow from each.

---

## 4. The gate: nothing financial runs on an undecided policy

`public.membership_policy_versions.is_financially_enabled` is a **stored
generated column**:

```sql
is_financially_enabled boolean generated always as (
  status = 'active'
  and approved_at is not null
  and interest_basis is not null
  and ... every other undecided column ...
) stored
```

Three properties follow, and they are the reason it is generated rather than
set:

1. **It cannot be ticked.** There is no write path that makes it true while a
   column is NULL. `tests/db/memberships.test.ts` attempts the write and
   asserts the refusal.
2. **It cannot drift from the TypeScript gate.**
   `isPolicyFinanciallyEnabled()` in `lib/domain/membership.ts` computes the
   same answer for the interface, and a database test asserts the two agree
   on the same row.
3. **It says why.** `policyBlockedReason()` turns the same state into a
   sentence, so the register and the configuration screen explain the hold
   rather than merely enforcing it.

Version 1.0 as shipped is `draft`, unapproved, with all nine questions open.
`is_financially_enabled` is therefore `false`, and Polytos Phases 2–5 must
read it before posting anything.

---

## 5. What this phase deliberately did **not** decide

- **Whether the 5% member rate becomes a loan product.** It will, in Phase 3,
  and the compatibility problem is recorded in
  `docs/POLYTOS-EXPANSION-ARCHITECTURE.md` §7 — the existing scheduling engine
  cannot express calendar-monthly collection dates.
- **Which ledger accounts the new postings use.** Proposed in
  `docs/POLYTOS-EXPANSION-ARCHITECTURE.md` §6; no account is created and no
  journal source type is added in this phase.
- **Any benefit, savings or fee amount beyond the four the documents state.**
- **Any waiting period, cap or frequency.** All nine are NULL.
