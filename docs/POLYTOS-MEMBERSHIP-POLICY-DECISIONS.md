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
is a **draft**, it is unapproved and does not take effect until 1 November
2026, so every one of the five activity gates is shut. See §4.

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
| 4 | Must the six qualifying months be **consecutive**? | `qualifying_months_consecutive` | Decides whether a missed month restarts the clock. **Phase 2 built both arms; savings do not open until this is answered.** |
| 5 | May savings be **withdrawn** while a member loan is active? | `savings_withdrawal_with_active_loan` | Three readings are plausible — allowed, blocked, or only the excess above what secures the loan. **Phase 2 built the first two; the third is refused with a message, because the excess needs question 3.** |
| 6 | How is the year-end profit share **calculated**? | `profit_distribution_basis` | Pro-rata on savings, pro-rata weighted by months held, or equal shares. Phase 5 is this formula. |
| 7 | What is the **annual cap** on the medical benefit per member? | `medical_benefit_annual_cap` | 5% of an uncapped bill is an uncapped liability. Phase 4 cannot assess a claim against no ceiling. |
| 8 | How many medical **claims a year** may a member make? | `medical_benefit_claims_per_year` | Same reason. |
| 9 | Is there a **waiting period** between enrolment and a first benefit claim? | `benefit_waiting_period_days` | Zero and "none" are the same answer; "nobody has said" is not. Phase 4 needs the number. |

### What Polytos Phase 2 did with questions 4 and 5

Both of these gate **savings**, and only savings — which is the whole reason
the gates are per-activity (§4). Phase 2 shipped the savings module behind
`is_savings_enabled`, which is a generated column waiting on exactly these
two. So:

- **Nothing about savings is guessed.** With either question open,
  `open_savings_account` refuses and no deposit can be recorded. Enrolment and
  the registration fee carry on, because they wait on neither.
- **Both arms of question 4 are implemented**, in
  `member_savings_qualification`, and neither is a default. While the question
  is open the function refuses to show anybody as qualified and says why —
  rather than picking the lenient reading and being wrong the day a loan is
  refused.
- **Two of the three readings of question 5 are implemented.** `allowed` and
  `blocked` are enforced in `request_savings_withdrawal`. The third,
  `above_pledged`, is **refused with a message naming what has to be
  settled**, because "the excess over what secures the loan" needs a pledged
  amount, which depends on question 3 — the savings-to-loan multiplier. A
  figure invented here would be inventing the member's security.

So answering questions 4 and 5 opens the savings module. Answering 3 as well
is what makes `above_pledged` usable and opens member lending.

### What Polytos Phase 3 did with questions 1, 2 and 3

The same thing, one layer up: every arm implemented, nothing defaulted,
nothing approvable while a question is open.

- **Both arms of question 1 and both of question 2 are implemented**, in
  `member_loan_interest()` — except the one combination that does not describe
  a calculation. "5% once per loan, on a reducing balance" has nothing to
  reduce against: a reducing-balance schedule charges a rate *per period* on
  the balance outstanding in that period, and a rate that is not per-period
  cannot be one of them. That combination **raises** rather than guessing, and
  `tests/unit/member-loan.test.ts` asserts the refusal. Three of four, and the
  fourth refused for a stated reason.
- **The per-month reducing-balance arm delegates to `calculate_loan_breakdown`**,
  the engine the rest of the loan book uses, rather than reimplementing it. A
  second reducing-balance implementation would be a second answer to the same
  question, and the two would diverge on a rounding boundary nobody tested.
- **Question 3 is the whole eligibility formula**, as this document said it
  would be, and it is read from the policy version rather than from anywhere
  else. While it is open, `member_loan_eligibility_of` shows no ceiling and
  `validate_loan_for_approval` refuses the approval with
  `member_policy_not_open`.

### A fourth decision Phase 3 found, which is not one of the nine

The nine above are the client's own list and stay nine. Phase 3 needed one
more answer, and it is recorded outside them on purpose:

> When a monthly collection day does not exist in a later month — a loan
> disbursed on 31 January — does the collection fall on the last day of that
> month, or on the first day of the next?

It lives on `repayment_frequencies.month_anchor`, not on
`membership_policy_versions`, because it is a property of the **cadence** and
not of the membership programme: the answer is the same whoever is borrowing,
and a non-member loan collected calendar-monthly needs the same answer from a
borrower who has no policy version. See ADR-059.

Both conventions are implemented, both are tested, neither is a default. The
`monthly` cadence ships inactive with a NULL anchor.

Its consequence is worth stating plainly because nobody would guess it from
reading questions 1 to 3: **answering 1, 2 and 3 and not the anchor opens
weekly member loans of one and two months, and leaves three-, four- and
five-month loans refused.** The member lending screens say so in those words
rather than claiming nothing can be approved.

### Two of the further questions below now have consequences in code

- **"What counts as a qualifying month?"** Phase 2 implemented *a deposit, or
  several deposits, totalling at least the monthly minimum within the calendar
  month* — in Africa/Kampala, net of reversals attributed back to the month
  they correct. Several deposits accumulating is how a member who cannot find
  UGX 50,000 at once still makes the month, and that reading is the one the
  documents' "minimum monthly savings" most naturally supports. **If the client
  means a cumulative balance reaching six multiples of the minimum instead,
  `member_savings_contributions` and `member_savings_qualification` are where
  it changes.** Flagged here because the module is live under this reading.
- **"What happens to savings when a membership is withdrawn or the member
  dies?"** Phase 2 stops deposits to an ended membership's account and leaves
  the balance where it is — still a liability, still owed. Nothing pays it
  out, nothing offsets it against a loan, and nothing closes the account,
  because each of those is a payment instruction the documents do not give.

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

## 4. The gates: five of them, one per activity

### What was wrong with one switch

The first version of this foundation carried a single stored generated
column, `is_financially_enabled`, true only when a version was active,
approved and every one of the nine questions answered. Polytos Phases 2–5
were to read it before posting anything.

It was the wrong shape, and wrong in the direction that costs money. It held
the **UGX 5,000 registration fee** — a figure the client's own documents
confirm, which waits on no open question at all — hostage to **how December's
surplus is divided**. A counter could not take a fee, and savings could not be
collected, because nobody had settled the year-end profit formula. Those are
different promises, made to different people, at different times, and they
fail independently.

### The five gates

Each activity carries its own stored generated column, and each names only
the decisions that activity actually waits on:

| Gate | Column | Waits on |
| --- | --- | --- |
| Enrolment and registration fees | `is_enrolment_enabled` | **Nothing.** Active and approved is the whole condition |
| Member savings | `is_savings_enabled` | 4 (consecutive months), 5 (withdrawal against a live loan) |
| Member loans | `is_member_lending_enabled` | the savings rules, because the loan is secured against them, plus 1 (basis), 2 (method), 3 (multiplier). Scheduling a loan beyond the weekly boundary additionally needs `repayment_frequencies.month_anchor`, which is not a policy column — see ADR-059 |
| Benefit payments | `is_benefits_enabled` | 7 (annual cap), 8 (claims a year), 9 (waiting period) |
| Year-end profit sharing | `is_profit_sharing_enabled` | 6 (distribution basis) |

Every one of the nine questions holds something up, and nothing is held up by
a question that is not its own. A unit test asserts exactly that: the union of
the five rule sets is the nine, with nothing left over on either side.

`is_financially_enabled` is **kept**, and is now what it should always have
been — the overall completeness indicator, the answer to "is this version
finished", which the configuration screen counts outstanding decisions from.
It is not the gate anything posts behind.

### The gate a posting actually calls

```sql
public.membership_policy_allows(p_version_id uuid, p_activity text) -> boolean
```

Two questions in one answer, and both must be yes:

1. the decisions **that activity** needs have been made — the generated
   column, which no write can forge; and
2. the version is **in force on the business date**: active, approved, and
   `effective_from <= business_date()`.

The second half cannot live in a generated column, because the business date
is not immutable. That is the whole reason the function exists beside the
columns rather than instead of them.

An activity nobody has defined **raises** rather than returning false.
Failing shut is the safe direction, but a typo that silently disables a
module looks exactly like a policy that has not been decided, and the two
need very different responses.

### The properties that made the original generated column right, kept

1. **It cannot be ticked.** There is no write path that makes any of the six
   true while a column it depends on is NULL.
   `tests/db/membership-hardening.test.ts` attempts the write on every one of
   them and asserts the refusal.
2. **It cannot drift from the TypeScript gate.** `isActivityReady()` in
   `lib/domain/membership.ts` computes the same five answers for the
   interface, and a database test reads every in-force version three ways —
   the generated column, `membership_policy_allows()`, and the TypeScript
   function — and asserts all three agree.
3. **It says why.** `activityBlockedReason()` and
   `activityOutstandingDecisions()` turn the same state into a sentence and a
   list, so the configuration screen names the decision holding each activity
   up rather than merely refusing.

Version 1.0 as shipped is `draft`, unapproved, effective 1 November 2026, with
all nine questions open. Every one of the five gates is therefore shut.

---

## 5. What this phase deliberately did **not** decide

- **Whether the 5% member rate becomes a loan product.** It did, in Phase 3:
  `ML`, with `interest_source = 'membership_policy'` so it is priced from the
  borrower's own version rather than from the product, and shipped
  **inactive**. The compatibility problem recorded in
  `docs/POLYTOS-EXPANSION-ARCHITECTURE.md` §7 — the existing scheduling engine
  could not express calendar-monthly collection dates — was solved by a second
  cadence arm, with the first copied character-for-character. See
  `docs/POLYTOS-MEMBER-LOANS.md` §6.
- **Which ledger accounts the new postings use.** Proposed in
  `docs/POLYTOS-EXPANSION-ARCHITECTURE.md` §6; no account is created and no
  journal source type is added in this phase.
- **Any benefit, savings or fee amount beyond the four the documents state.**
- **Any waiting period, cap or frequency.** All nine are NULL.
