# Polytos business-policy implementation and transition update

Development branch: `feat/polytos-policy-implementation`.
Original Claude HEAD: `0157e74e7e17b1651d49f0aab893211930c200f2`.
Production base: `56b77e97fd776bd29dc10a5411e003a28f84774f`.

The existing seventeen migrations and database types were audited and extended.
The implementation continues Claude's branch. No hosted database was accessed.

## Initial failures and corrections

Run [40644455851](https://github.com/JTREVORM/lending-manager/actions/runs/40644455851)
had 28 database failures, 1,733 passes and a browser seed failure.
Policy fixtures now state cap modes and qualification bases explicitly. The browser
harness uses synthetic version 998.2 rather than colliding with the official draft.
Death-benefit fixtures provide three real membership confirmations and prior
next-of-kin listings. The official ten family relationships remain enabled;
guardian and other remain excluded.

Schema, foreign-key, SECURITY DEFINER, exact grant and role inventories include the
new objects. Anonymous execution of `loan_collection_period_total` is revoked.
Reader helpers respect branch/module/own-member scope. No test grants were widened.
A genuine reference generator regression beyond serial 999 was corrected without
changing existing identifiers. Meeting fines use MFN; MF remains the fee receipt prefix.

## Business decisions preserved

| Rule | Implemented behavior |
| --- | --- |
| 1 | UGX 50,000 qualifying savings in six months; consecutive months not required under the official draft. Historical months retain the minimum applicable then. |
| 2 | Ordinary and member loans in approved/active states block withdrawals under the blocked policy. Payment rechecks after approval. |
| 3 | Member interest 5% per month. |
| 4 | Flat interest for new loans governed by the official draft; existing schedules and pricing remain unchanged. |
| 5 | Savings-to-loan multiplier 2x; existing pledge and eligibility safeguards remain. |
| 6 | Unpaid installment collection periods carry forward once without editing contractual due dates, principal, interest or allocations. |
| 7–8 | Medical benefit 5% of the verified bill, twice per benefit year. A separate annual ceiling remains an explicit unresolved decision. |
| 9 | Benefit qualification uses qualifying savings months under the official draft. Legacy day-based policies remain supported. |
| 10 | Medical benefit year follows enrollment anniversaries. |
| 11 | Family condolence UGX 100,000; the deceased must have a qualifying prior next-of-kin listing. |
| 12 | Death evidence includes three distinct other real group members' confirmations. |
| 13 | Member bereavement UGX 200,000 to the verified recorded recipient. |
| 14 | Bereavement payment is withheld while the deceased member has an outstanding loan; nothing is netted from savings or benefits. |
| 15 | UGX 5,000 absence fines, with advance notice, independent excuse review, independent assessment, receipts and reversals. |

Version 2.0 remains **draft**, **unapproved**, **undated**, and governs nobody.
The unsupported 2026-12-01 date was removed. Recording a date requires the
management capability and an authorization reference; it does not approve or
activate the policy. Medical ceiling mode and Phase 5 profit distribution remain
unapproved. Fixed death benefits have separate gates from medical eligibility.

## Application workflows

- `/membership/policies/transitions`: authorized timing recording, read-only
  preview, qualification impact, independently witnessed acceptance, per-member
  dated assignment, resume and close. Consent does not rewrite enrollment terms.
- Membership details: governing policy, qualifying savings, ceiling, outstanding
  debt, withdrawal restriction and benefit/evidence position.
- Loan details: contractual dates beside collection periods and unpaid amounts;
  authorized carry-forward action.
- Claim intake: optional prior next-of-kin selection. Claim details: real member
  confirmations and evidence frozen at assessment.
- Meeting details: advance notice and separate review; policy-authorized absence
  assessment. Pending notices prevent premature fines.
- `/meetings/fines` and individual fine pages: charges, partial receipts,
  cancellations, contra reversals, retained history and GL reconciliation.
- Audit and notification integration includes deep links, branch restrictions
  and redaction of sensitive evidence from new audit entries.

Server actions validate discriminated requests, enforce exact capabilities and
rate limits, use the signed-in Supabase client and invalidate affected routes.
Money is integer UGX. Receipt keys cannot be reused for a different request.
Fine row locks prevent overcollection. Fine/notice guards freeze copied identity,
branch and assessment evidence, and event timestamps use the business clock.
Client financial locks coordinate loan
approval/reopening with withdrawal and bereavement payment checks.

## Verified checkpoint

[Run 40882089737](https://github.com/JTREVORM/lending-manager/actions/runs/40882089737),
commit `e3f673aed2b4b6890709a99c81d008d3cdc48564`:

- PostgreSQL: **1,781 passed**.
- Savings demo: **18 passed**; borrower reuse: **15 passed**;
  member-loan demo: **24 passed**; benefit demo: **25 passed**.
- Financial upgrade and borrower reuse verifier: passed.
- TypeScript and lint: passed. Browser: 846 passed, four failed. The four
  failures were an outdated evidence label, two ambiguous qualification locators
  and a required-field label locator. The follow-up corrects these assertions
  and applies the formatter's exact changes; no security or financial assertion
  was relaxed.

The final CI run, exact check results and screenshot artifacts are identified in
this delivery's accompanying completion report. This checkpoint is retained as
traceable evidence, not a claim that a failed run passed.

The new upgrade verifier seeds the actual production-base browser data in a fixed
loopback database, applies all seventeen policy migrations and compares exact
original columns in 26 financial/identity/history tables. Comparison hashes and
totals are uploaded as `polytos-policy-financial-reconciliation`.

| Protected figure | Before | After |
| --- | ---: | ---: |
| Loans | 17 | 17 |
| Principal | 9,600,000 | 9,600,000 |
| Interest | 1,290,000 | 1,290,000 |
| Scheduled repayment in existing installments | 8,015,000 | 8,015,000 |
| Historical loan payments | 167 | 167 |
| Memberships / acceptance records | 8 / 7 | 8 / 7 |
| Savings subledger | 1,790,000 | 1,790,000 |
| Liability 2100 | 1,790,000 | 1,790,000 |
| Historical benefit payments | 1 / 20,000 | 1 / 20,000 |
| GL debits / credits | 17,776,274 / 17,776,274 | 17,776,274 / 17,776,274 |

These are synthetic isolated regression figures, not a production data extract.
The verifier also preserves original policy terms/approvals and historical audits.
Legacy immutable snapshots remain unchanged: two new mandatory evidence CHECKs
are NOT VALID for historical rows while enforcing future inserts and updates.

## Build reproducibility

The production-build check exposed a Next.js Google Fonts URL parser failure.
Inter is now packaged as an unmodified local Latin WOFF2 from Fontsource,
with the SIL Open Font License and source blob recorded beside the layout.
The family, 300–900 weights, CSS variable, swap behavior and fallback chain are
preserved. The Latin subset keeps cold-page downloads within the unchanged
performance budgets; the full multilingual file is not shipped. Builds no longer
need a Google Fonts request.

## Verification and release procedure

Use an isolated local PostgreSQL cluster; never Supabase Primary or hosted
credentials. The managed execution environment did not become usable during this
work, so runtime evidence is taken from GitHub Actions, not claimed as local runs.

```sh
npm ci
npm run typecheck
npm run lint
npm run format:check
npm run test:run
npm run audit:money
npm run db:local:setup
DATABASE_URL=postgresql://lending@localhost:5433/lending_test npm run test:db
node scripts/verify-membership-upgrade.mjs
bash tests/e2e/harness/stack.sh up
source <(bash tests/e2e/harness/stack.sh env)
npx playwright test
node scripts/capture-benefit-screens.mjs
bash tests/e2e/harness/stack.sh down
```

CI also runs history secret scanning, production dependency auditing, the
production build, client secret scanning and real built-bundle assertions.
The screenshot artifact includes transition, fine register/receipt, collection,
eligibility and verification screens at desktop, laptop, tablet and mobile widths.

Release remains an authorized operator's separate task after all three CI jobs
pass on the final application commit. Before a release, take and verify a backup,
review unapplied migration inventory and rehearse restore/upgrade against an
isolated copy. Compare verifier hashes/totals and run reconciliation after upgrade.
The NOT VALID historical evidence checks must not be validated by inventing
historical confirmations. Reconcile and investigate actual historical data first.

Application deployment and hosted schema changes require separate authorization.
Do not infer policy approval from a successful deployment. Management must decide
the medical cap mode, authorize timing and approve terms separately; members'
verified acceptances and dated controlled assignments follow. No automatic bulk
activation, retroactive schedule rewrite, financial rollback deletion, production
merge, Vercel deployment or Phase 5 work is included.
