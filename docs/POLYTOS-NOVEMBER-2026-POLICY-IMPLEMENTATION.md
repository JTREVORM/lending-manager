# POLYTOS — November 2026 policy decisions and implementation ledger

**Change status:** implementation work in progress, **not a production release**.
**Authority:** Owner's proposed answers in the November 2026 policy questionnaire.
**Critical release hold:** Policy 2.0 remains unapproved and undated; all nine
external agency providers remain provisional and inactive. A code merge is not
business approval.

## 1. Preserve existing loan product rules

Company policy already configured in `business_settings`: UGX 100,000–20M;
1–3 month ordinary term; 15% monthly default; reducing-balance method;
one active loan per borrower; two active guarantees per guarantor; minimum
guarantor age 18; clients may guarantee; one-time 50% late penalty, with a
3-day company default grace.

**Product overrides take precedence only as currently implemented:**

| Product | Monthly interest | Amount | Term | Grace | Min guarantors in product row |
| --- | ---: | --- | --- | --- | ---: |
| Individual | 15% | UGX 100K–20M | 1–3 months | 3 days | 0 |
| Quick | 15% | UGX 100K–2M | 1 month | 3 days | 0 |
| Business | 15% | UGX 300K–20M | 1–3 months | 3 days | 2 |
| Salary | 12% | UGX 200K–20M | 1–3 months | 5 days | 1 |

**Review before change:** Product rows for Quick and Individual specify zero
guarantors, although `business_settings.min_guarantors_required` is one.
Audit effective validators before modifying product rows. Do not alter
contractual snapshots or historical repayment schedules. Salary's five-day
grace is a configured product exception; do not overwrite with three days.

## 2. Membership Policy 2.0 — prepared in migration 20261122000100

The draft carries existing rules: UGX 5K joining fee; qualifying monthly
savings >= UGX 50K for six *non-consecutive* qualifying months; member loans
5% **flat per month**, maximum five months, up to 2x qualifying savings;
no savings withdrawals with an active loan; medical support 5% of verified
admission bill (more than one day) for two claims per enrolment-anniversary
benefit year; UGX 100K family condolence; UGX 200K bereavement; three distinct
death confirmations; no bereavement payment with an outstanding member loan;
UGX 5K meeting absence fine with existing controls.

**New proposed decisions staged without activation:**
- `medical_benefit_cap_mode = 'amount'`
- `medical_benefit_annual_cap = 500000` (UGX per member per benefit year)
- `profit_distribution_basis = 'pro_rata_savings'`
- Keep `benefit_qualification_basis = 'savings_qualifying_months'` and
  `benefit_waiting_period_days = NULL`. These are not contradictory.
- `repayment_frequencies['monthly'].month_anchor = 'clamp_to_month_end'`.
  Leave monthly `is_active = false` until schedule generator/product
  eligibility tests and an explicit operational release.

**Additional application work staged in the next migration (not released):**
1. **Partial medical cap payout (code staged, CI pending)**: on a qualifying claim, pay min(5% of
   eligible bill, unused annual UGX 500K cap). Handle zero availability
   distinctly. Preserve two-claims-per-year and existing admission/evidence/
   independent approval gates. Prevent concurrent assessments from allocating
   more than the annual cap; do not silently change a submitted or already
   assessed claim. Existing financial guards must forbid unfunded payouts.
2. **Year-end profit distribution**: define approved distributable profit pool
   and an audited savings snapshot/cutoff date; calculate the eligible
   member's share pro rata from that snapshot; use explicit rounding and
   residual assignment, idempotent approvals and ledger posting. The
   *percentage/pool source* is not established by choosing a distribution
   formula. A member chooses between savings credit or verified cash/mobile
   money payment. No automatic payouts on year end.
3. **Member monthly collection**: activate monthly cadence only once the
   date engine, product allowed frequencies, and longer member-loan terms
   are certified. The origin-day must be snapshotted; consecutive 31st-day
   months must return to 31 when possible, not drift after February.

## 3. Agency banking — proposed terms

Nine registered external providers: MTN MoMo, Airtel Money, Stanbic Agency
Banking, UEDCL Yaka, NWSC Water, DStv, GOtv, Lycamobile, School Fees.

**Prepared (not live):** For these nine *provisional* records only,
`commission_source = 'reported'`. Cashier enters the actual commission from
the provider confirmation (explicit 0 if none). Existing `commission_model`
(immediate vs deferred) is **not** overwritten: it controls recognition timing,
not commission source. Existing earnings, receipts, outstanding amounts, daily
line reports, settlement/reversal and independent reconciliation are preserved.

**Other agreed implementation requirements:**
- Daily *review/reconciliation*. Settlement is recorded on actual receipt,
  not assumed to have happened because a day ended; provider contractual
  payout timing is controlling.
- Provider statement variances stay visible; investigate, correct a specific
  transaction or make an Owner-authorised, independently verified ledger
  adjustment. Certification itself posts **no** journal entry.
- Amounts above each approved service threshold need independent
  Manager/Owner verification (not an extra Owner-only step).
- An internal float facility exception needs Owner approval, audit and
  verification; **never** waive hard available-cash/float safeguards or
  contractual credit/facility caps. If actual credit/advance functionality
  is requested, implement it as a separately contracted receivable with
  proper counterparty/limit/settlement and financial certification.
- Stanbic's provisional `cash_payable` model is **not** changed here.
  Verify the provider agreement before setting `provider_float` using
  `set_agency_provider_float_model` and confirming the ledger account
  reconciliation and opening float.
- Do not invent rates, limits or bank account details.

**Launch-readiness gap (measured 19 Nov 2026):** All nine providers remain
provisional and inactive; all 13 of their transaction types have NULL
`max_single_transaction` and NULL `requires_approval_above`. An operational
provider commercial-term approval workflow does not yet exist in the
provider settings screen. No provider should be confirmed or activated until
written service agreements, actual transaction ceilings, counterparty float
arrangements, settlement accounts and limits have been approved.

## 4. Release gates / acceptance tests

- [x] Stage draft membership cap and profit basis; no approval/activation
- [x] Record month-end anchor with monthly option inactive
- [x] Stage nine manual/reported commission sources; all providers inactive
- [x] Add database regression coverage for those safeguards
- [ ] Run complete PostgreSQL migration suite and affected CI jobs
- [x] Stage partial medical payout code and cap concurrency regression tests\n- [ ] Certify partial medical payout migration and tests in PostgreSQL CI
- [ ] Implement and test profit distribution and member payout elections
- [ ] Certify monthly schedule generator and product eligibility; then enable
- [ ] Implement and test agency per-type approval thresholds
- [ ] Implement and test audited internal float exception workflow
- [ ] Obtain signed provider-specific terms, service ceilings, settlement and
      float details; verify Stanbic's float model
- [ ] Obtain formal membership policy approval/effective date and controlled
      provider activation authorizations
- [ ] Verify production books, members, loans and payment records unchanged
      before and after a separately authorized release

**Do not merge as a claim of total policy implementation.** This PR is the
initial safe configuration milestone; the remaining financial workflows
require their own code, verification and acceptance.
