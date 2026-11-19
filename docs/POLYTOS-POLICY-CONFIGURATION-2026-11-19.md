# POLYTOS — Policy decisions implementation ledger (2026-11-19)

Status: **draft changes, not authorization to operate**. All financial, provider and membership activation gates remain enforced.

## Owner's selections captured

1. Medical annual ceiling: UGX 500,000 per member, per enrollment-anniversary benefit year.
2. Annual profit allocation: pro rata to eligible savings balances (`pro_rata_savings`); the distributable profit pool must be independently approved.
3. Member profit payout preference: savings credit or cash/mobile-money payout. **Implementation pending**: member preference, disbursement ledger and audit/consent workflow. No transfers until independently approved.
4. Calendar-monthly repayment rule: `clamp_to_month_end`; monthly cadence stays inactive until product scheduling regression is complete.
5. Medical claims: pay only the remaining annual limit if 5% of the eligible bill exceeds headroom. **Implementation pending**: assess/pay state machine, locking, partial-payment snapshot, tests. Do not activate medical claims until complete.
6. Provider internal float facility exceptions: independently audited Owner approval, only within an actual contractual facility and funded availability. **Implementation pending**. No bypass of negative-funds protection or partner exposure ceilings.
7. Agency per-service approval threshold: independent Manager or Owner verification (maker/checker distinct). **Implementation pending**: enforce `agency_transaction_types.requires_approval_above` in posting/verification paths; no fictitious amounts.
8. Prepare all nine provisional providers but keep inactive pending actual contractual terms and formal readiness.
9. Stanbic: intended `provider_float` model, but **do not change the provisional row** until signed commercial terms and float/funding sources are verified.
10. Commission: report amount typed from original provider confirmation (`commission_source='reported'`), zero explicit. **Implementation pending per provider**; existing reported-source support must be verified for each category before changing provider rows.
11. Daily commission reconciliation. Receipt/settlement occurs only when provider actually pays; do not fabricate daily receipts. Existing daily reporting and independent commission reconciliation are reusable.
12. Commission variance: investigate and hold visibility, independently certify, then correct originating transaction or use Owner-authorized audited adjustments. Never let certification post an adjustment by itself. Existing reconciliation guards already implement much of this.

## What this first migration deliberately implements

- Policy 2.0 draft: `medical_benefit_annual_cap=500000`, `medical_benefit_cap_mode='amount'`, `profit_distribution_basis='pro_rata_savings'`.
- Calendar-month cadence: `month_anchor='clamp_to_month_end'`; leave inactive.
- Fail closed if policy is already approved, active, effective-dated, in use, or conflicting with another recorded decision.
- Preserve all prior transactions, loan schedules, commissions, member records and provider statuses.
- Add regression assertions that no medical or profit-sharing service was activated by entering proposed policy terms.

## Phase 2 — medical benefit partial payment

Implement the following atomically in the database, with tests for two concurrent claims:
- Compute payable as min(eligible 5% amount, max(0, UGX 500,000 less already committed benefit-year claims)).
- Preserve the two-claims-per-benefit-year restriction; never create a third entitlement.
- Reserve cap on assessment/approval with consistent status handling and locks; never let concurrent approvers both consume the same remaining capacity.
- Separate original entitlement, approved partial payable, actual payment, and remaining headroom, with audited officer reason and immutable snapshot.
- No retroactive changes to approved/paid historical claims.

## Phase 3 — profit distribution and payout

Snapshot the authorized year-end profit pool, qualified members, eligible savings balances and rounded pro-rata allocations. Require reconciliation of allocations to the approved pool and an independent approval before posting. Capture a member payout choice, distinguish savings liabilities from external cash disbursements, enforce till funds and reversible postings, and prevent double payment by idempotency key. No automatic profit income or money created.

## Phase 4 — agency controls and commercial readiness

- Preserve existing source models, transaction directions, earned/received/outstanding commission accounting, reversals, statement reporting and independent verifiers.
- Enforce per-transaction `max_single_transaction` and `requires_approval_above` **only after actual amounts have been approved and configured**. Do not interpret NULL limits as unlimited permission to activate a provisional provider.
- Provider float facility limit is a contractual exposure limit, not permission to overdraw cash/float. Owner override only on an *internal* workflow threshold; never override contractual limit, cash sufficiency, or existing payable floors.
- For each of MTN, Airtel, Stanbic, UEDCL, NWSC, DStv, GOtv, Lycamobile and School Fees: obtain signed provider terms, per-service ceiling, approval threshold, actual float/funding model, commission source, settlement statement dates, destination accounts, staff authority and legal readiness. No invented values.
- Stanbic `provider_float` conversion can use the existing audited `set_agency_provider_float_model` only while provisional and with no active position; it must not silently change accounting model for already posted transactions.
- Final provider activation remains a distinct Owner action after contract review and passing regression gates.

## Release gates

1. Validate migration on a fresh PostgreSQL database, rerun `tests/db/policy-benefit-gates.test.ts`, all financial and security DB tests, browser E2E, build and migration-history checks.
2. Confirm 2.0 remains `draft` and inactive; confirm monthly repayment remains inactive; confirm all nine real providers remain provisional and inactive.
3. Implement and certify pending functional requirements above in separate reviewed commits.
4. Management signs new policy version, effective date and provider-specific terms. Only then use existing authorized activation flows.
5. Never merge or deploy past failing CI, migration-history conflicts, authorization gaps or unreconciled financial differences.

**No part of this document grants production deployment or membership/provider activation authority.**
