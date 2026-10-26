# Polytos Phase 3 — delivery report

**Member Loans, Savings Eligibility and the Repayment Engine.**

Branch `claude/beautiful-mccarthy-lth3q2`, built on
`0ecc7657967ceeddc1aa55b3a03fe22732570574` (Polytos Phase 2).

Nothing was merged. Nothing was deployed. No migration was applied to a hosted
Supabase project, and the connection named `Primary` was never opened.

---

## A. Implementation summary

**Member lending is built, tested end to end, and held closed.** Four
decisions the client has not made are still not made, nothing is defaulted,
and the database refuses to approve a loan that depends on an unanswered one.

| # | Feature | State |
| --- | --- | --- |
| 1 | A member loan product (`ML`) that extends the existing lending engine rather than paralleling it | built, ships **inactive** |
| 2 | Database-enforced eligibility in `validate_loan_for_approval`, with ten new failure codes | built, enforced |
| 3 | A savings ceiling computed from the member's own policy version, net of live pledges and pending withdrawals | built |
| 4 | A savings pledge that restricts without spending — no journal entry, no savings transaction, no movement in account `2100` | built |
| 5 | An immutable eligibility snapshot written at approval | built |
| 6 | Four interest combinations: three implemented, the undefined one refused | built |
| 7 | Weekly collection, as an ordinary fixed-day cadence | built, **active** |
| 8 | Calendar-month collection, as a second cadence kind — not `interval_days = 30` | built, ships **inactive** |
| 9 | Both month-anchor conventions, neither a default | built |
| 10 | Member loan screens: two registers, an application with a live repayment preview, an eligibility panel, and a panel on the loan itself | built |
| 11 | Reporting: `member_loan_summary()`, twenty derived figures, no total ceiling | built |
| 12 | An audit trail for assessments and pledges that carries no name, phone or balance | built |
| 13 | A demonstration seeder with six scenarios, four of them refusals | built, local only |
| 14 | The financial regression gate extended to Phase 3 | built |

### What was deliberately not built

- **No `member_loans:approve` capability.** Approval is `loans:approve`,
  because a member loan is a loan.
- **No member-loan detail screen.** A member loan opens at `/loans/{id}`, with
  a panel added.
- **No `per_loan` + `reducing_balance` arithmetic.** It does not describe a
  calculation; the function raises. Implementing something would have been
  inventing a financial rule.
- **No total lending ceiling anywhere.** Summing what the business *could*
  lend would be read as a commitment nobody made.

---

## B. Database changes

Ten migrations, `20261021000100`–`20261021001000`, 4,493 lines. Nothing
destructive: no column dropped, no constraint relaxed, no policy widened, no
financial row touched.

| Migration | What it adds |
| --- | --- |
| `…000100_member_loan_permissions` | Two capabilities and their role grants |
| `…000200_repayment_cadence_kinds` | `cadence_kind`, `month_anchor`, the `weekly` and `monthly` cadences |
| `…000300_calendar_month_scheduling` | `monthly_collection_date`, `generate_loan_schedule` v2 |
| `…000400_member_loan_products` | `requires_membership`, `interest_source`, the `ML` product, the member-term ceiling |
| `…000500_member_loan_savings_pledges` | The pledge table, the capacity lock, the withdrawal bound |
| `…000600_member_loan_eligibility` | `member_loan_interest`, `member_loan_eligibility_of`, the blocked reason |
| `…000700_member_loan_approval` | The snapshot table, ten failure codes, `approve_loan` v2 |
| `…000800_member_loan_rls` | RLS, grants, two views, the capability wrapper |
| `…000900_member_loan_reporting` | `member_loan_summary()`, one index |
| `…001000_member_loan_audit` | Two statement-level audit triggers |

### New tables (2)

| Table | Key | Rules |
| --- | --- | --- |
| `member_loan_eligibility_snapshots` | `loan_id` | Append-only. 32 columns. 13 CHECK constraints restating the eligibility rules |
| `member_loan_savings_pledges` | `loan_id` | Append-only except the release. 6 CHECK constraints |

Both keyed on `loan_id` rather than a surrogate: there is exactly one
assessment a loan was approved on and exactly one pledge securing it, and a
surrogate key would admit a second of either.

### New columns on existing tables (10)

| Table | Columns |
| --- | --- |
| `loans` | `membership_id`, `interest_basis` |
| `loan_products` | `requires_membership`, `interest_source` |
| `loan_product_snapshots` | `requires_membership`, `interest_source` |
| `repayment_frequencies` | `cadence_kind`, `month_anchor` |
| `loan_schedules` | `cadence_kind`, `month_anchor` |

`loans.interest_method` and `loan_products.interest_method` were **widened**
to admit `'flat'`. A widened CHECK removes no existing value, so no existing
row can fail it.

### New views (2), both `security_invoker`

`member_loan_eligibility` — one row per live membership.
`member_loan_register` — one row per member loan, with the membership and the
pledge.

### New functions (12)

| Function | Security | Reachable by |
| --- | --- | --- |
| `monthly_collection_date` | invoker, immutable | anyone; pure |
| `member_loan_interest` | invoker | anyone; pure |
| `member_loan_cadence_for_term` | invoker | anyone; pure |
| `lock_savings_capacity` | definer | privileged callers |
| `savings_pledged_amount` | invoker | per the policies |
| `savings_withdrawable_amount` | invoker | per the policies |
| `member_loan_eligibility_of` | **definer** | **no session** — revoked from `public`, `anon`, `authenticated` |
| `assess_member_loan_eligibility` | definer | checks `member_loans:view_eligibility` |
| `member_lending_blocked_reason` | definer | granted; names an open decision |
| `member_loan_summary` | definer | checks `loans:view` |
| `member_loan_pledges_guard` | definer | trigger |
| `member_loan_release_pledge` | definer | trigger |

Three existing functions were **replaced** rather than duplicated:
`generate_loan_schedule`, `validate_loan_for_approval`, `approve_loan`. A
second approval path beside the existing one would be a second set of rules
over one agreement.

### New indexes (7, besides the two primary keys)

`loans_product_status_idx`, `member_loan_pledges_account_idx` (partial, on
live pledges), `member_loan_pledges_client_idx`,
`member_loan_pledges_membership_idx`, `member_loan_snapshots_client_idx`,
`member_loan_snapshots_membership_idx`, `member_loan_snapshots_savings_idx`.

### Permissions (2)

| Capability | Secretary/Treasurer | Manager | Owner |
| --- | --- | --- | --- |
| `member_loans:view_eligibility` | ✅ | ✅ | ✅ |
| `member_loans:create` | ❌ | ✅ | ✅ |

Mirrored into `role_permissions` and asserted against
`lib/permissions/permissions.ts`.

---

## C. Member loan eligibility

### Qualification

Phase 2's `member_savings_qualification` is **reused**, not reimplemented. It
takes an "as of" date, which is why an assessment made today cannot be changed
by a deposit made tomorrow. Which arm applies — six qualifying months, or six
*consecutive* — is the policy version's own
`qualifying_months_consecutive`, and both arms were already implemented in
Phase 2 with neither a default.

### The ceiling

```
  eligible_savings       the balance member_savings_qualification judged
  − pledged_savings      what live pledges on this account already secure
  − pending_withdrawals  what is requested and not yet decided
  ──────────────────────
  available_savings      floored at zero
  × multiplier_bps / 10000
  ──────────────────────
  max_eligible_loan      integer division: floors, deliberately
```

Three of those four lines were **defects the tests found**, not design. They
are in §F and in `docs/POLYTOS-PHASE-3-TEST-REPORT.md` §2.

The floor is deliberate and matches the pledge, which rounds **up**:

```
  pledged_amount = (loan_principal × 10000 + multiplier_bps − 1) / multiplier_bps
```

Together they guarantee the business never lends a shilling more than the
multiplier supports and never secures a shilling less. The invariant is
asserted inside `approve_loan` as well, so any future path computing the
ceiling wrongly is caught at the moment it would do harm.

### The multiplier is never defaulted

`savings_to_loan_multiplier_bps` is NULL on every policy version in force.
While it is, `member_loan_eligibility_of` returns a NULL ceiling and a
blocking reason naming the decision, the screens show "Not yet decided", and
`validate_loan_for_approval` returns `member_policy_not_open`. There is no
fallback figure anywhere in the codebase; `tests/unit/member-loan.test.ts`
asserts that a NULL multiplier yields `null` rather than something permissive.

### Historical snapshots

`member_loan_eligibility_snapshots` records, at the moment of approval: the
membership and its number, the policy version and its number, the savings
account, the date assessed, the months required and served, the eligible
savings, what was already pledged, what was awaiting payment, the available
savings, the multiplier, the ceiling, the rate, basis, method, maximum term
and required cadence, the amount and term requested, the active-loan count and
outstanding principal, and who captured it.

It is append-only by statement-level trigger, and thirteen CHECK constraints
restate the rules — the ceiling must follow from the available savings, the
available savings from the eligible less the committed, the member must have
qualified under the arm the version chose, the amount must be within the
ceiling, the term within the maximum. **A row that contradicts the policy it
claims to follow cannot exist**, whoever wrote it and however.

---

## D. Loan interest and repayment engine

### The interest options

| Basis | Method | Implementation |
| --- | --- | --- |
| `per_month` | `reducing_balance_monthly` | **delegates** to `calculate_loan_breakdown` |
| `per_month` | `flat` | `principal × rate × months` |
| `per_loan` | `flat` | `principal × rate`, once |
| `per_loan` | `reducing_balance_monthly` | **raises**: undefined |

The fourth is not an omission. A reducing-balance schedule charges a rate *per
period* on the balance outstanding in that period; a rate that is not
per-period has nothing to reduce against. Implementing something would have
meant inventing a financial rule.

The per-month reducing arm **delegates**. There is one reducing-balance engine
in this system and `calculate_loan_breakdown` is it. A second would be a
second answer to the same question, and the two would diverge on a rounding
boundary nobody tested.

Pricing comes from the **borrower's own frozen policy version**, never from
the product: `loan_products.interest_source = 'membership_policy'` is what
says so. `loans_guard_member_terms()` freezes `membership_id` and
`interest_basis` at approval for every caller including `service_role`, so a
later policy version does not reprice a loan already written.

### Monthly scheduling

`repayment_frequencies.cadence_kind` is `'fixed_days'` or `'calendar_month'`.
A calendar cadence carries **no `interval_days` at all** — paired by CHECK, so
it cannot carry a misleading one. `interval_days = 30` was never on the table:
it would drift a loan disbursed on 31 January onto 2 March, which is a
different contract that happens to look similar.

```sql
monthly_collection_date(anchor_date, months, month_anchor)
```

| `month_anchor` | 31 January, collection 1 |
| --- | --- |
| `clamp_to_month_end` | 28 February — PostgreSQL's own month arithmetic |
| `roll_forward_to_next_month` | 1 March |

Both implemented, both tested across every 31-day month boundary of a year,
**neither a default**. The cadence ships inactive with a NULL anchor;
`generate_loan_schedule` raises rather than guessing, and
`validate_loan_for_approval` returns `cadence_anchor_undecided` — a code that
is deliberately *not* member-specific, because an ordinary loan on a
calendar-monthly cadence hits the same wall.

The anchor is recorded on the cadence, not as a tenth policy question. ADR-059
has the reasoning: it is a property of the cadence, the answer is the same
whoever is borrowing, and a borrower with no policy version still needs one.

### Preservation of existing repayment behaviour

`generate_loan_schedule` gained a second arm and **the fixed-day arm was
copied character-for-character**. `generator_version` stays `1` for fixed-day
schedules because those rules did not change; `2` marks the calendar arm only.
(An earlier draft bumped both and the schedule-audit test caught it.)

Proved three ways:

1. `tests/db/schedule-parity.test.ts` regenerates schedules and compares.
2. `scripts/verify-membership-upgrade.mjs` compares the
   `installment_schedule` figure — **every collection date and every
   scheduled amount, loan by loan, in order** — across a populated upgrade.
3. `tests/db/member-loan-demo-seed.test.ts` snapshots eight pre-existing loans
   figure by figure, runs the seeder, and compares.

---

## E. UI/UX

Screenshots were captured by `scripts/capture-member-loan-screens.mjs` driving
the **production build** on the isolated end-to-end stack — real PostgreSQL
with every migration applied, the real PostgREST binary, `next start`. They
are real screens with real data, not mock-ups.

Ten screens × four viewports = **40 PNGs**, written to
`.e2e/shots/member-loans/` with `timings.json` and `timings.md` beside them.

| Screen | File stem | Shows |
| --- | --- | --- |
| Member Loans Dashboard | `member-loans-dashboard` | The book, the pipeline, the collection position, who can borrow, and the register |
| Who Can Borrow | `who-can-borrow` | The eligibility register |
| Member Loan Application | `member-loan-application` | The member, the request, the price |
| Repayment Preview | `repayment-preview` | The contract month by month, with totals |
| Application refused — cadence | `application-refused-cadence` | A three-month term, refused for the undecided anchor |
| Loan Eligibility Panel | `loan-eligibility-panel` | "May borrow", the ceiling and its derivation |
| Loan Eligibility Panel, refused | `loan-eligibility-panel-refused` | "Cannot borrow yet", with the reason |
| Member Loan Details | `member-loan-details` | The frozen assessment, the agreed price, the pledge |
| Member Loan Approval | `member-loan-approval` | An application awaiting a decision |
| Policy decisions | `membership-policy-decisions` | What is settled and what is not |

Each exists at `-desktop` (1440×900), `-laptop` (1366×768), `-tablet`
(820×1180) and `-mobile` (390×844).

### Measured, not eyeballed

| Screen | Desktop median | Mobile median | Horizontal overflow |
| --- | --- | --- | --- |
| Member Loans Dashboard | 231 ms | 190 ms | **0 px** |
| Who Can Borrow | 139 ms | 124 ms | **0 px** |
| Member Loan Application | 103 ms | 84 ms | **0 px** |
| Repayment Preview | 112 ms | 100 ms | **0 px** |
| Application refused — cadence | 124 ms | 94 ms | **0 px** |
| Loan Eligibility Panel | 127 ms | 112 ms | **0 px** |
| Loan Eligibility Panel, refused | 155 ms | 116 ms | **0 px** |
| Member Loan Details | 328 ms | 241 ms | **0 px** |
| Member Loan Approval | 283 ms | 201 ms | **0 px** |
| Policy decisions | 90 ms | 112 ms | **0 px** |

Overflow is asked of the document, not judged from the picture.

### Two interface defects the screenshots found

**The banner over-claimed.** `MemberLendingStatus` led with "Nothing can be
approved" whenever any decision was open. In a programme that has answered the
three policy questions and not the anchor, weekly member loans are approved
and running — so the banner was false, and a banner that says nothing can be
approved while loans are being approved is one people stop reading. Fixed by
splitting `pricingReady` from `isReady`: the three policy questions decide
whether a loan can be **priced**, the anchor whether a longer one can be
**scheduled**, and the banner now says which.

**Nine columns did not fit the counter laptop.** At 1440px the status badge
was clipped at the member loan register's right edge — the column was there
and the word in it was not readable without scrolling the table sideways. The
membership number and the pledge now drop below `2xl`; both are on the loan's
own screen one tap away. Found by photographing the screen at the width it is
used at.

---

## F. Financial integrity

```
node scripts/verify-membership-upgrade.mjs

  re-creating lending_upgrade
  applying 95 existing migrations          ← the released schema
  seeding a representative book
  seeded 14 loans, 165 payments, 178 journal entries
  capturing the financial baseline
  applying 32 Polytos migrations on top    ← Phases 1, 2 and 3
  capturing the financial baseline again
  … 28 figures compared …

  Upgrade verified: every one of 28 financial figures is identical,
  the twelve membership, savings and member loan tables exist and are
  empty, and 2100 Member Savings is zero.
```

**Discrepancies: none.** Exact counts:

| Figure | Before | After | Δ |
| --- | --- | --- | --- |
| `loan_principal`, `loan_interest`, `loan_expected` | — | identical | **0** |
| `loan_count`, `loan_statuses`, `loan_rates` | — | identical | **0** |
| `period_rows`, `period_totals`, `period_breakdown` | — | identical | **0** |
| `installment_rows`, `installment_total` | — | identical | **0** |
| **`installment_schedule`** (every date, loan by loan) | — | **identical** | **0** |
| `payment_rows`, `payment_total` | — | identical | **0** |
| `allocation_rows`, `allocation_totals` | — | identical | **0** |
| `penalty_rows`, `penalty_total`, `outstanding` | — | identical | **0** |
| `journal_entries`, `journal_lines`, `journal_sums`, `journal_by_source` | — | identical | **0** |
| `account_balances`, `trial_balance` | — | identical, 3 new accounts all at zero | **0** |
| `delinquency`, `client_count` | — | identical | **0** |
| `audit_trail` | 536 rows | 537 rows | **+1, configuration only** |

The one added row is `product.created` for the `ML` product, written by the
trigger that has always watched `loan_products`. It is the first audit row any
migration in this repository has ever written, and it is why `audit_count`
became **`audit_trail`**: a count cannot tell that row apart from a migration
inventing a payment. The trail is now compared **row by row** — every existing
row unchanged, and an added row allowed only when it is about configuration
the migration created itself. That is a stronger assertion than the count it
replaces.

### The new Phase 3 transactions, separately

`tests/db/member-loan-demo-seed.test.ts` builds a loan book, snapshots it,
seeds the member loan demonstration on top, and asserts:

- every pre-existing loan identical, figure by figure, loan by loan;
- every collection date where it was;
- no existing loan re-pointed at the member product;
- the savings subledger still equals ledger account `2100`;
- every savings account's balance still equals the sum of its own
  transactions, while the pledge against it is above zero — **a pledge
  restricts without spending**;
- no journal entry and no savings transaction sourced from a pledge;
- every journal entry balanced; the trial balance foots.

---

## G. Demo integration

`scripts/demo-member-loans.ts`, gated behind a second environment phrase
(`POLYTOS_SEED_MEMBER_LOANS=yes-seed-polytos-member-loan-demo`) and **refused
outright on any non-local target** — it publishes a policy version answering
three decisions the client has not made, and those figures must not appear on
a hosted project as though they were the programme's terms.

### How it attaches to the existing population

Every scenario attaches to a member `scripts/seed-demo.ts` has already
created, **by letter**. It creates no client, no membership and no savings
account of its own. Four of the eight situations §16 asks for were already
standing in the Phase 2 savings data — a member three months short, a member
behind this month, a member who saved and withdrew, and every borrower without
a membership — so this adds the four that need a loan.

| Scenario | Attaches to | Demonstrates | Outcome |
| --- | --- | --- | --- |
| A | member A | a qualified member with a running member loan, collected once | **active** |
| B | member B | an application awaiting a decision | draft |
| B2 | member B | refused for asking above what their savings support | `member_amount_above_ceiling` |
| C | member C | refused for want of qualifying months | `member_not_qualified` |
| E | member E | refused on two counts at once | `member_amount_above_ceiling`, `member_not_qualified` |
| D | member D | a suspended member | `member_not_active`, `member_not_qualified` |

Four of the six are refusals, and that is the demonstration. An interface can
be made to *show* a refusal; only a refusal the database actually issued
proves the control exists. Scenario E exists because
`validate_loan_for_approval` returns a **set** of codes rather than the first.

It composes with borrower reuse: run with both phrases, the six scenarios map
onto people who are already in the loan book, and the member loans are written
against clients who already have loan histories — which is what the test above
then proves it did not disturb.

### Idempotency

Three consecutive runs on a fresh local database:

```
loans=6 payments=1 journals=34 pledges=1 snapshots=1 savings=1010000 installments=8
run 2: identical          run 3: identical          IDEMPOTENT
```

Twice could pass on a guard that happens to catch the state the first run
leaves. Three times means the state is a fixed point.

### Reconciliation, every run

- the savings subledger equals ledger account `2100`;
- no savings account secures more than it holds;
- every member loan's schedule collects its contractual total;
- the trial balance foots.

Any of the four failing aborts the seeder with the figures.

---

## H. Security

Attacked from the outside in `tests/db/member-loan-security.test.ts` (25) and
`tests/db/member-loan-approval.test.ts` (27), as `anon`, as each of the four
roles, as a member, as `service_role`, and as the table owner. Every statement
runs as a real database role with a real JWT subject, so the application is
bypassed by construction.

### Authorisation and RLS

| Attack | Result |
| --- | --- |
| `anon` reads either new table, either view or the assessment function | Nothing |
| `member_loan_eligibility_of` called directly by a session | **Refused** — revoked from `public`, `anon`, `authenticated` |
| A caller without `member_loans:view_eligibility` reads eligibility | Nothing — `security_invoker` views, the policies decide |
| A caller without `loans:view` reads a pledge or a snapshot | Nothing |
| INSERT / UPDATE / DELETE on either new table, any role | **Refused** — no grant, RLS with no write policy |
| The same as the **table owner** | **Refused** — statement-level guard triggers |
| A borrower reaching any member-lending screen | Nothing (asserted in a browser) |
| A Secretary opening `/member-loans/new` by URL | **Refused** (asserted in a browser) |

### Approval bypass

| Attack | Result |
| --- | --- |
| A rate supplied by the caller on the draft | Overwritten from the borrower's own frozen policy version |
| Changing `membership_id` or `interest_basis` after approval, as `service_role` | **Refused** by `loans_guard_member_terms` |
| Approving above the ceiling using a stale form value | **Refused** — recomputed inside `approve_loan` under the lock |
| A snapshot claiming a member qualified when they did not | **Refused** by `member_loan_snapshots_qualified` |
| A snapshot above its own stated ceiling | **Refused** by `member_loan_snapshots_within_ceiling` |
| A pledge whose amount does not follow from its inputs | **Refused** by `member_loan_pledges_amount_follows` |
| Approving for a member whose version does not open lending | **Refused**, `member_policy_not_open` |

### Concurrency

`tests/db/member-loan-concurrency.test.ts`, 7 tests, each opening two
connections and running both to the point of decision:

| Race | Result |
| --- | --- |
| Two approvals against one savings balance | One succeeds; the other `member_amount_above_ceiling`. `approve_loan` takes `lock_savings_capacity` **before** it validates |
| A withdrawal against an approval | Serialised by the same lock; the savings cannot both secure a loan and leave |
| A member loan disbursed twice at once | One schedule |
| Any ordering of approval | Exactly one snapshot and one pledge per loan |
| The one-active-loan limit | Held apart as a separate control with its own lock |

### No authorisation hole was found

Unlike Phase 2, the attack tests found no authorisation defect. The three
defects this phase found were all in the eligibility **arithmetic**, and each
would have over-lent rather than over-disclosed. That is a record of what was
attacked and what happened, not a claim that the module is secure because
nothing was found.

### Audit trail

`member_loan.assessed` and `member_loan.pledged`, recorded against the loan.
The JSON keys are asserted, not scanned as text: no `full_name`, no `phone`,
no savings balance, no telephone number in any value. An audit row is read by
people entitled to know an assessment happened, which is not the same as being
entitled to the member's account.

---

## I. Testing

| Suite | Command | Passed | Failed | Skipped |
| --- | --- | --- | --- | --- |
| Unit + integration | `npm run test:run` | **2,441** | 0 | 0 |
| Database (schema) | `vitest run --project db` | **1,620** | 0 | 0 |
| Demonstration seeder | `vitest run --project seed` | **18** | 0 | 0 |
| Borrower reuse | `vitest run --project seed-reuse` | **15** | 0 | 0 |
| Member loan demonstration | `vitest run --project seed-member-loans` | **24** | 0 | 0 |
| Financial regression | `node scripts/verify-membership-upgrade.mjs` | **28 figures identical** | 0 | — |
| Browser | `npx playwright test` | **698** | 0 | 32 |
| Float-free money audit | `npm run audit:money` | **71 files, 5 engines, no hazard** | 0 | — |
| Production build | `npm run build` | **succeeds**, 2 new routes | 0 | — |
| Typecheck / lint / format | `npm run typecheck`, `lint`, `format:check` | clean | 0 | — |

Security tests are counted inside the database suite: 25 in
`member-loan-security.test.ts`, 27 in `member-loan-approval.test.ts`, 7 in
`member-loan-concurrency.test.ts`.

### Phase 3's own additions

| Suite | Before | After | Added |
| --- | --- | --- | --- |
| Unit + integration | 2,389 | 2,441 | **52** |
| Database | 1,497 | 1,620 | **123** |
| Seeder projects | 33 | 57 | **24** |
| Browser (executions) | 659 | 730 | **71** |

The browser row counts **executions**: a spec that runs in both the desktop
and the mobile project contributes twice. Phase 3's 71 are 31 cases in
`member-loans.spec.ts` run in both projects, 5 in `member-loans.write.spec.ts`
on desktop only, and 2 accessibility paths added to a sweep that runs in both.

The 32 skips are the mobile project's deliberate exclusion of the write specs
— an approval takes a pledge and makes that member hold a live loan, so a
second pass would meet `active_loan_exists` and fail for the first pass's
success — plus the five `on a phone` cases that skip in the desktop project.
**No test is skipped because it fails.**

**No existing test was deleted, skipped or weakened.** One assertion was
rewritten because Phase 3 made it ambiguous rather than wrong, and it is named
with its before and after in `docs/POLYTOS-PHASE-3-TEST-REPORT.md` §9.

---

## J. GitHub delivery

| | |
| --- | --- |
| **Repository** | `JTREVORM/lending-manager` |
| **Development branch** | `claude/beautiful-mccarthy-lth3q2` |
| **Based on** | `0ecc7657967ceeddc1aa55b3a03fe22732570574` |
| **Final commit SHA** | `b0bb1c515f010a204ffd98208c3da98e0dcfceb1` |
| **GitHub Actions run** | [40274937992](https://github.com/JTREVORM/lending-manager/actions/runs/40274937992) |
| **CI status** | **all three jobs passed** |

### The CI run on the final SHA

| Job | Conclusion | What it ran |
| --- | --- | --- |
| `checks, unit/integration, build` | ✅ success | typecheck, lint, format, 2,441 unit + integration tests, the money audit, a secret scan over source **and full history**, the production dependency audit, the production build, the client-bundle secret scan, and the bundle-size assertions |
| `database (real PostgreSQL)` | ✅ success | all four vitest projects against a cluster rebuilt from every migration, then the upgrade and financial-regression check |
| `browser E2E (production build, fresh seed)` | ✅ success | the stack brought up from zero — migrate, seed, build, serve — then the whole Playwright suite against it |

Eight commits on the branch, four of them this session:

```
b0bb1c5  docs(polytos): Phase 3 specification, ADR-059, ADR-060 and the delivery report
cd1e8ea  test(polytos): the member loan browser suite, on a partially open programme
2c2789b  test(polytos): the member loan demonstration against an existing loan book
47438b1  fix(polytos): two member-lending defects the browser found
f5e3927  feat(polytos): the member loan demonstration seed and its regression gate
1b14519  feat(polytos): the member lending interface, reporting and audit trail
7a8df0d  feat(polytos): the member-loan domain, the calendar cadence, and 171 tests
0c5d6d6  feat(polytos): Phase 3 database foundation for member loans
```

### Nothing was merged or deployed

- No pull request was opened.
- No branch was merged.
- No Vercel deployment was triggered; `https://lending-manager-ten.vercel.app`
  is untouched.
- No migration was applied to any hosted Supabase project.
- The connection named `Primary` was never opened, and its project reference
  is recorded nowhere in this repository.
- Hosted Supabase access is **not configured** in this environment. Every
  figure in this report was produced against a local throwaway PostgreSQL
  cluster, as the specification permits where hosted access is unavailable.

### Unresolved policy decisions — all four still open

| # | Question | Where it lives | Consequence of leaving it |
| --- | --- | --- | --- |
| 1 | Is the 5% charged **per month** or **once per loan**? | `membership_policy_versions.interest_basis` | No member loan can be priced |
| 2 | Is member interest **flat** or on a **reducing balance**? | `membership_policy_versions.interest_method` | No member loan can be priced |
| 3 | What **multiple of savings** may a member borrow? | `membership_policy_versions.savings_to_loan_multiplier_bps` | No ceiling can be shown and nothing approved |
| 4 | What does a **monthly collection** do in a month with no such day? | `repayment_frequencies.month_anchor` | Three- to five-month loans cannot be scheduled |

Question 4 was **not on the original list**. Phase 3 found it, and it is
recorded on the cadence rather than as a tenth policy question for the reasons
in ADR-059. Its consequence is the one nobody would guess: answering 1, 2 and
3 and not 4 opens weekly member loans of one and two months and leaves longer
ones refused. The interface says so in those words.

Every one of the four is surfaced in the staff interface — the question, the
column it lives in, and what it costs — by `MemberLendingStatus` on
`/member-loans` and on the application form.

### Outstanding defects and risks

| | Severity | What it is |
| --- | --- | --- |
| A new policy version supersedes the old one, and savings accounts are frozen to the version they were opened under | **Plan before opening lending** | Publishing the version that answers questions 1–3 will un-qualify every account opened under the current one until they are handled deliberately. Phase 2 behaviour, documented not changed: `docs/POLYTOS-MEMBER-LOANS.md` §12 |
| No hosted verification | Expected | Forbidden by the brief during development, and hosted access is not configured here. A hosted release needs its own verification step |
| The live path has not run against real member money | Expected | Member lending ships closed. Everything exercised is synthetic, by design |
| A pledge is not visible to the member in the portal | Low | A member would be refused a withdrawal with a reason, but would not have known beforehand. Phase 5 builds the member's own view |
| `per_loan` + `reducing_balance` is unimplemented | By design | It does not describe a calculation. The function raises and the refusal is asserted |

### Phase 4 was not started

`docs/POLYTOS-MEMBER-LOANS.md` §14 records what Phase 4 will need from this
phase and the one question it will have to put to the client — whether a
bereavement benefit payable while a member loan is outstanding is reduced by
what the loan owes. Phase 3 deliberately does not answer it.
