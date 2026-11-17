# POLYTOS — full-system business-rules certification

Independent audit, functional testing and financial certification of every
POLYTOS module against its documented business rules.

| | |
| --- | --- |
| **Repository** | `JTREVORM/lending-manager` |
| **Audit branch** | `claude/keen-dirac-2nptar` |
| **Base commit audited** | `89ebb2c` — *Agency redesign and the Owner's five decisions (#34)* |
| **Audit date** | 2026-11-15 (business clock `Africa/Kampala`) |
| **Production Supabase** | `qxcwsvmakdilsshvcjuv` — **not accessed** |
| **Production Vercel** | `polytos.vercel.app` — **not accessed** |
| **Test environment** | throwaway local PostgreSQL 16 cluster on `127.0.0.1:5433`, real PostgREST 12.2.3, Next.js 16.4.1 production build |

> This document records what was **measured**, not what was expected. Where a
> rule could not be independently measured, it says so and says why. No
> requirement is marked `PASS` on the strength of a previous delivery report,
> a previous CI run or a comment in the source.

---

## A. Executive verdict

### POLYTOS is **PARTIALLY CERTIFIED, WITH KNOWN LIMITATIONS**

The arithmetic is right. The lending engine, the double-entry ledger, the
savings module, the benefits module, the meetings module and both agency lines
compute correct financial results and enforce their documented business
decisions in the configuration that is actually installed. Of 469 inventoried
rules, **454 pass on measured evidence**. Every cross-module reconciliation
identity recomputed from base tables — loans receivable, interest income,
penalty income, the savings subledger, the schedules, the arrears, the
penalties — reconciled **to the shilling, with zero difference**, and did so
again when re-measured while the browser suite was actively writing money.

It is **not** "functionally certified", and the reason is specific. Two
control failures were found, and both have since been ruled on by the Owner
and fixed on these branches:

| | Finding | Severity | State |
| --- | --- | --- | --- |
| **DEFECT-001** | The guarantor concentration ceiling the business configured did not bind at all | High | found, reproduced, **fixed and regression-tested**, approved by the Owner on 2026-11-16, **merged to `main` on 2026-11-17** as `dd5f581` — PR #35 |
| **GAP-001** | Three money-out paths — loan disbursement, savings-withdrawal payout and benefit payment — never check that the cash exists. A branch till reached **−345,000** during this audit's own test run, with `allow_negative_cash = false` | High | **already known and documented** by the project; **reproduced live here**; ruled on by the Owner as *"APPROVED: NO UNFUNDED PAYOUTS"*; **fixed in four additive migrations**, **merged to `main` on 2026-11-17** as `32226b6` — PR #36 |

Neither was an arithmetic error. Both were *control* failures: a configured
credit limit that did nothing, and a cash-sufficiency check that three paths
never reach. A financial system whose ledger can state a negative till is
making a false claim about where the company's money is, and the till is
exactly what a cash count is reconciled against.

Two further defects were found while implementing those fixes. Neither is a
financial-control defect and both are fixed:

| | Finding | Severity | State |
| --- | --- | --- | --- |
| **Third** | A refused `ON DELETE RESTRICT` reports `23001` on the PostgreSQL the CI runner now provides, not `23503`. Three tests and — more seriously — `lib/db-errors.ts` assumed the old code, so staff would have seen an unexplained failure instead of *"a linked record is still in use"* | Medium | found by CI, **fixed** — §H.6.1 |
| **Fourth** | One `import { randomUUID } from 'node:crypto'` in a client component put 441 KB of Node polyfill into a route's browser bundle, taking `/finance/deposits` to 1,009 KB uncompressed first load | Medium | found by CI, **fixed** — §H.6.2 |

Both were caught by gates this repository already had, and neither by a local
run. That is recorded as a method note rather than only as a fix: §H.6.1 and
§H.6.2 say why a green local suite was not evidence in either case.

Beyond those two, the verdict carries three further qualifications:

**1. No financial calculation was wrong anywhere.** Every defect found was a
control or a test assumption, never an amount. DEFECT-001 is fixed in
migration `20261119000100` with a five-case regression test whose
discriminating power was proved by removing the migration — three of the five
fail without it, including the concurrent form, in which two simultaneous
disbursements both succeeded. **The fix changes what the business can disburse
and has not been merged.** GAP-001 is fixed in migrations `20261120000100`
through `20261120000400` with a 28-test suite, three new permanent
certification identities and an upgrade gate that reports **all 28 financial
figures identical** across the change — so not one borrower-facing amount
moved. §E states the finding, §H.6 what was built, and
`docs/POLYTOS-DECISION-A-DELIVERY.md` accounts for it in full. **Also not
merged.**

**2. The membership programme is not commercially authorised, and the system
correctly refuses to run it.** Policy version 1.0 and the official version 2.0
are both `draft` and both unapproved. Version 1.0 even carries an
`effective_from` of 2026-12-01 — and a date alone does not activate it: all
five of its activity gates read closed, measured directly. **Six business
decisions remain genuinely undecided** — the medical annual cap, its cap mode,
the benefit waiting period, the profit-distribution formula, the
calendar-monthly collection anchor and the bank-advance model (§G.3) — and the
database refuses, **by name**, to price or pay anything that depends on them.
It does not default, and this audit did not invent an answer to any of them. This is correct behaviour, not a failure — but
it means the membership, savings-qualification, member-lending, benefits and
meeting-fine features are **certified as mechanisms, not as live services**.
They were certified against an explicitly synthetic, labelled policy version
(`998.2`, "Polytos membership terms (harness)") created for that purpose.

**3. Every real external provider is provisional, and cannot post.** All ten
genuine providers (MTN Mobile Money, Airtel Money, Stanbic, DStv, GOtv, NWSC,
UEDCL, School Fees, Lycamobile and `ACC20723078`) carry
`is_provisional = true`, and a database trigger refuses to move any
transaction past `draft` for a provisional or inactive provider. Agency
Banking and Mobile Money were therefore certified against synthetic
`DEMO_*` providers. **No real provider was activated.**

### What this verdict is not

It is **not** a statement that POLYTOS is ready to accept live public money.
Both control failures are now fixed, which removes two of the five
prerequisites; what remains is: **merging both pull requests once every CI
check passes**; the §11.4 cash cutover — signed per-account till counts, bank
confirmations and an Owner-approved initial verified position, which a
migration cannot establish and `docs/POLYTOS-DECISION-A-DELIVERY.md` says so;
the Owner's approval of a membership policy version; the six outstanding
business decisions; and activation of the real providers under their own
commercial agreements. Those are ranked in §J.

It is also not a claim that synthetic testing substitutes for live operation.
Every figure in this report was produced from data this audit created.

---

## Scope, environment and method

### What was audited

| | Count |
| --- | ---: |
| Database migrations applied, in order, to an empty database | **224** at the audited commit; **225** with DEFECT-001's fix; **229** with Decision A |
| Base tables in the resulting schema | **95** at the audited commit; **97** with Decision A's two registers, every one with Row Level Security enabled |
| Views | **69**; **70** with Decision A's availability view |
| Database functions | **397**; **419** with both fixes |
| PostgREST relations / relationships / functions exposed | 164 / 154 / 249 |
| Application routes and server actions | audited by reading |
| Business rules inventoried | **469** (§B) |

### The isolated environment, and how isolation was proved

`npm run e2e:up` assembles the stack out of real parts rather than mocks:

| Component | What was used |
| --- | --- |
| PostgreSQL | **real** — version 16, a throwaway cluster, every migration applied from zero |
| PostgREST | **real** — the 12.2.3 binary, the same server Supabase runs |
| Row Level Security | **real** — enforced, 95/95 tables |
| Next.js | **production build** (`next build` + `next start`), not the dev server |
| Supabase Auth | the one substitution — a GoTrue-compatible shim, because GoTrue ships only as a container |

Isolation is enforced by the repository itself, not by discipline.
`tests/helpers/test-targets.ts` parses the target URL's **hostname** and
refuses to run a destructive suite unless it is `localhost`/`127.0.0.1` *and*
the database is named `lending_test` or `lending_e2e`. A password or query
string containing "localhost" does not satisfy it. Four separate databases
were used, so no suite could disturb another:

| Database | Used by |
| --- | --- |
| `lending_e2e` | the browser stack and this audit's read-only queries |
| `lending_test` | `npm run test:db` |
| `lending_cert` | `npm run certify:financial` |
| *(none)* | production — never contacted |

### How independence was maintained

Expected values were **not** taken from the implementation under test:

- A reducing-balance engine was written from the stated rule alone
  (`interest(n) = round_half_up(openingPrincipal(n) × rateBps / 10000)`,
  level principal with the remainder in the final periods, exact integer
  arithmetic) and used as the oracle for 6,770 loans.
- Every ledger identity was recomputed from **base tables**
  (`journal_lines`, `payment_allocations`, `savings_transactions`), not from
  the reporting views that are themselves under test.
- Penalty, benefit and arrears amounts were recomputed by hand-written
  half-up integer arithmetic and compared against the stored figures.

---

## B. Business-rule compliance matrix

**469 rules**, inventoried from the migrations, the approved policy
configuration and the documents listed in the scope section. The tally:

| Status | Count | Meaning |
| --- | ---: | --- |
| `PASS` | **454** | measured and correct |
| `BLOCKED` (correct) | **9** | the system correctly refuses because a business decision is outstanding — a pass for the software, an open item for the business |
| `FAIL` | **0** | — |
| `FAIL → FIXED` | **5** | DEFECT-001 (GUAR-006) and its concurrent form (CONC-008); and GAP-001 (FIN-018, FIN-019, the cash half of CONC-021). All five **merged to `main` on 2026-11-17**: `dd5f581` (PR #35) and `32226b6` (PR #36), each with all four CI gates green on its own head |
| `NOT TESTED` | **1** | the real-Auth rehearsal, which needs a container image unavailable here |

> **Merge record, 2026-11-17.** The inventory is unchanged at **469 rules**
> and the five status counts are unchanged. What changed is that the five
> `FAIL → FIXED` rules are now **merged to `main`** rather than pending on a
> branch: `dd5f581` (PR #35, DEFECT-001) and `32226b6` (PR #36, GAP-001), each
> with all four CI gates green on its own head and on `main` after the merge.
> `main` carries **229 migrations**, 224 inherited plus the five added, none of
> the pre-existing ones modified. The rule rows below were re-read and their
> status and evidence columns updated; **no rule was added, removed or
> re-identified**, which is why the tally is untouched.
>
> Recommendation **L5** — browser journeys for these financial workflows, as
> opposed to page-rendering sweeps — is implemented in
> `tests/e2e/specs/cash-sufficiency.write.spec.ts`. The `PW` evidence marker
> on the cash rules now means a journey that presses the buttons, not a page
> that rendered. §H.8 records what it measured and the one finding it
> produced.

The five counts sum to 469. They were re-derived from this document's own
tables after the Decision A work, by parsing every rule row and tallying its
status column: 470 rows carrying a `MODULE-NNN` identifier, of which one is
`DEFECT-001` in the defect register in §D rather than a rule in this matrix,
leaving 469 rules with no duplicate identifier. The per-module figures below
sum to the same 469. This is the validated inventory the pull request
descriptions were corrected against.

Rules by module: LOAN 72 · AGENCY 43 · FIN 40 · PAY 39 · BEN 37 · SEC 31 ·
SAV 30 · MLOAN 27 · POLICY 26 · REP 24 · GUAR 23 · CONC 22 · MEET 20 ·
MM 18 · CLIENT 17.
 **The latest implemented migrations and the
approved policy configuration are treated as authoritative**; historical
design documents and proposed policies are recorded as proposals, never as
rules in force.

### How to read the evidence column

| Code | Meaning |
| --- | --- |
| `IND` | **Independently verified by this audit** — recomputed from the business rule or from base tables, never from the code under test. The measurement is given in §C. |
| `SCHEMA` | The constraint, trigger, index or function was read in the **live migrated database** (`pg_constraint`, `pg_indexes`, `pg_get_functiondef`) and matches the rule. |
| `DB:<file>` | That specific file in `tests/db/` — run by this audit against a real PostgreSQL cluster, passed, **and** its coverage of this rule confirmed by reading the test itself or by the repository's own documentation citing it. |
| `DB-SUITE` | Covered by the repository's database suite as a whole — **104 files, 2,571 tests, run in full by this audit against a real PostgreSQL cluster, all passing** — without this audit confirming which individual file asserts this particular rule. Weaker than `DB:<file>`, and marked differently so the distinction is visible. |
| `CERT` | One of the 41 identities in `npm run certify:financial`, run by this audit — 38 as inherited, plus the three cash-sufficiency identities Decision A added. |
| `SEC` | `npm run check:security` — run by this audit, "no unreviewed privileged exposure". |
| `UNIT` | The repository's unit and integration suite — **90 files, 2,770 tests, run in full by this audit, all passing**. |
| `MONEY` | `npm run audit:money` — **277 financial files scanned, no float hazard found**, five money engines verified to reach only integer helpers, and the scanner itself verified against a positive control. |
| `PW` | The Playwright browser suite, run by this audit against the production build on the clean rebuilt stack. |

`PASS` means measured and correct. `BLOCKED` means the system correctly
refuses because a business decision is outstanding — a pass for the software
and an open item for the business. `NOT TESTED` means exactly that.

### B.1 Loan products and lending guardrails

| Rule ID | Requirement | Expected | Actual | Evidence | Status |
| --- | --- | --- | --- | --- | --- |
| LOAN-001 | Minimum ordinary loan | UGX 100,000 | `business_settings.min_loan_amount = 100000` | IND, SCHEMA | PASS |
| LOAN-002 | Global loan ceiling | UGX 20,000,000 | `max_loan_amount = 20000000` | IND, SCHEMA | PASS |
| LOAN-003 | Standing monthly rate | 15% | `default_monthly_interest_rate_bps = 1500` | IND | PASS |
| LOAN-004 | Ordinary term range | 1–3 months | `min/max_loan_term_months = 1/3` | IND | PASS |
| LOAN-005 | Multi-month threshold | UGX 200,000 | `multi_month_min_amount = 200000` | IND | PASS |
| LOAN-006 | Loans below 200,000 cannot run multiple months | refused `term_requires_higher_amount` | refused | DB:loan-lifecycle, SCHEMA | PASS |
| LOAN-007 | Loans ≥ 200,000 may use longer permitted terms | permitted | permitted | DB:loan-lifecycle | PASS |
| LOAN-008 | One active loan per client | `max_active_loans_per_client = 1`, trigger + advisory lock | `loans_enforce_active_limit`, `pg_advisory_xact_lock` on client | SCHEMA, DB:loan-concurrency | PASS |
| LOAN-009 | Only active clients may borrow | refused `client_not_active` | refused | SCHEMA, DB:loan-lifecycle | PASS |
| LOAN-010 | Quick Loans product | 100,000–2,000,000 · 15% · 1 month | `QL` 100000–2000000 · 1500bps · 1–1 · active | IND | PASS |
| LOAN-011 | Salary Loans product | 200,000–20,000,000 · 12% · 1–3 months | `SL` 200000–20000000 · 1200bps · 1–3 · active | IND | PASS |
| LOAN-012 | Business Loans product | 300,000–20,000,000 · 15% · 1–3 months | `BL` 300000–20000000 · 1500bps · 1–3 · active | IND | PASS |
| LOAN-013 | Individual Loans product, the default | 100,000–20,000,000 · 15% · 1–3 months | `IL` 100000–20000000 · 1500bps · 1–3 · active · `is_default` | IND | PASS |
| LOAN-014 | Member Loans product ships **inactive** | not offered for new applications as migrated | measured on a pristine migrate (`lending_test`): `ML status = 'inactive'`. The demonstration seed then activates it on purpose, weekly-only, to exercise member lending — see §D | IND | PASS |
| LOAN-015 | Legacy product is withdrawn | not offered | `IL-LEGACY` `status = 'inactive'` | IND | PASS |
| LOAN-016 | Member Loans priced from the policy, not the product | `interest_source = 'membership_policy'` | as expected; 500 bps column is the envelope | IND | PASS |
| LOAN-017 | Member Loans term ceiling | 5 months | `ML max_term_months = 5` | IND | PASS |
| LOAN-018 | One default product, and it must be active | enforced at storage level | `loan_products_one_default` unique index + `..._default_is_active` CHECK | SCHEMA | PASS |
| LOAN-019 | A product must fit inside the business rules | refused, naming the limit | `loan_products_within_business_rules` trigger | SCHEMA, DB:loan-products | PASS |
| LOAN-020 | Business rules must still fit every active product | refused, naming the product | `business_settings_keep_products_valid` trigger | SCHEMA, DB:loan-products | PASS |
| LOAN-021 | Standard rate inside the product's own band | CHECK | `loan_products_default_rate_in_band` | SCHEMA | PASS |
| LOAN-022 | A product requiring a guarantor asks for ≥ 1 | CHECK | `loan_products_guarantor_count_consistent` | SCHEMA | PASS |
| LOAN-023 | Unauthorised interest override rejected | refused | `interest_override_allowed = false` on every product; `approve_loan` refuses | SCHEMA, DB:loan-products | PASS |
| LOAN-024 | Authorised override bounded and attributed | CHECK demands a named approver | `loan_product_snapshots_override_named` | SCHEMA | PASS |
| LOAN-025 | Product changes never reprice approved loans | snapshot immutable | `loan_product_snapshots` append-only (UPDATE/DELETE refused by trigger, no privilege granted) | SCHEMA, DB:loan-snapshots | PASS |
| LOAN-026 | Nobody may delete a product | no DELETE privilege | none granted | SCHEMA | PASS |
| LOAN-027 | A product's code cannot be renamed | restored by trigger | `loan_products_stamp_actor` | SCHEMA | PASS |
| LOAN-028 | Only the Owner may change a product | `products:manage` = Owner only | measured: `owner_admin` only | IND | PASS |

### B.2 The interest engine — independently recomputed

Every row below was computed by an engine written from the stated rule alone
and compared period-by-period against `public.calculate_loan_breakdown`.

| Rule ID | Requirement | Expected | Actual | Evidence | Status |
| --- | --- | --- | --- | --- | --- |
| LOAN-029 | Reducing balance on each period's opening principal | `round_half_up(opening × bps / 10000)` | identical on **6,770 loans / 16,823 period rows, 0 mismatches** | IND-1 | PASS |
| LOAN-030 | Brief example 1 — 100,000 · 15% · 1m | 15,000 interest, **115,000** total | 15,000 / 115,000 | IND-1 | PASS |
| LOAN-031 | Brief example 2 — 200,000 · 15% · 2m | 130,000 then 115,000, **245,000** total | 130,000 / 115,000 / 245,000 | IND-1 | PASS |
| LOAN-032 | Brief example 3 — 600,000 · 15% · 3m | 290,000 / 260,000 / 230,000, **780,000** | exactly | IND-1 | PASS |
| LOAN-033 | Brief example 4 — Salary 200,000 · 12% · 2m | 24,000 then 12,000, **236,000** | exactly | IND-1 | PASS |
| LOAN-034 | Rounding is half-up, not banker's | 445 @ 50% = 222.5 → **223** | 223 | IND-1 | PASS |
| LOAN-035 | Principal remainder goes to the final period(s) | 200,001 / 2m → 100,000 then 100,001 | exactly | IND-1 | PASS |
| LOAN-036 | Principal portions sum to the loan; totals = principal + interest | exact for every case | 0 failures in 6,770 cases | IND-1 | PASS |
| LOAN-037 | No floating point anywhere on the money path | none | 272 files scanned, no hazard; 5 engines reach only integer helpers | MONEY | PASS |
| LOAN-038 | The SQL engine is authoritative; the TypeScript one is preview | both agree | 300 generated loans compared period-by-period | DB:loan-engine-parity | PASS |
| LOAN-039 | Large values near supported limits | exact | tested to 20,000,000 across 5 terms and 6 rate bands | IND-1 | PASS |
| LOAN-040 | A term beyond 120 months is refused | refused | raises `P0001` | SCHEMA | PASS |

### B.3 Loan lifecycle, approval and disbursement

| Rule ID | Requirement | Expected | Actual | Evidence | Status |
| --- | --- | --- | --- | --- | --- |
| LOAN-041 | A loan cannot skip approval | transitions enumerated | `loans_guard_transition` | SCHEMA, DB:loan-lifecycle | PASS |
| LOAN-042 | Approval does not move money | status `approved`, no journal | measured: approval writes no journal entry | SCHEMA, CERT | PASS |
| LOAN-043 | A user without `loans:disburse` cannot disburse | Manager refused | `loans:disburse` held by `owner_admin` **only** | IND, DB-SUITE | PASS |
| LOAN-044 | `loans:approve` is Manager + Owner | as documented | measured exactly | IND | PASS |
| LOAN-045 | `loans:cancel` is Owner only | as documented | measured exactly | IND | PASS |
| LOAN-046 | Disbursement debits Loans Receivable, credits the funding account | Dr 1200 / Cr Cash at Hand | measured on 12 disbursements | IND-4, CERT | PASS |
| LOAN-047 | Loans Receivable = remaining loan principal | exact | GL 1200 = 3,654,212 = independently computed 3,654,212; **difference 0** | IND-4, CERT | PASS |
| LOAN-048 | Schedule created atomically with disbursement | all or nothing | one transaction; a raise aborts it | SCHEMA, DB:schedule-generation | PASS |
| LOAN-049 | No duplicate schedule on retry | impossible | unique index on `(source_type, source_id)`; 0 duplicate source postings measured | IND-4, SCHEMA | PASS |
| LOAN-050 | Every disbursed loan has exactly one disbursement journal | 1:1 | 12 disbursed / 12 journals / **0 missing** | IND-4, CERT | PASS |
| LOAN-051 | Approval freezes the product terms and client evidence | snapshots written, immutable | `loan_product_snapshots`, `loan_client_snapshots`, `loan_guarantor_snapshots`, `loan_identity_snapshots` all append-only | SCHEMA, DB:loan-snapshots | PASS |
| LOAN-052 | An approved loan cannot be silently repriced | refused for every caller | `loans_approved_requires_totals` + write-once columns bind `service_role` too | SCHEMA, DB:loan-snapshots | PASS |
| LOAN-053 | Every rule is re-evaluated at approval | re-validated, not carried forward | `validate_loan_for_approval` called inside `approve_loan` | SCHEMA, DB:loan-lifecycle | PASS |
| LOAN-054 | Settings race: approve at the rate in force at approval | 12% if the rate moved to 12% | as documented | DB:loan-lifecycle | PASS |
| LOAN-055 | An active loan cannot be cancelled | refused | permitted only from draft/pending/approved | SCHEMA | PASS |
| LOAN-056 | Cancellation requires a reason | refused without one | `loans_cancelled_requires_reason` | SCHEMA | PASS |
| LOAN-057 | Every transition names a human actor | no system approvals | actor stamped from `current_profile_id()`; a supplied value is refused | SCHEMA | PASS |
| LOAN-058 | No loan table grants DELETE to any role | none | measured: none | SEC, SCHEMA | PASS |
| LOAN-059 | Rejection, return-to-draft, withdrawal, cancellation all exist | four distinct acts | `rejectLoan`, return, `cancel_loan` | SCHEMA, DB:loan-workflow | PASS |

### B.4 Repayment schedule and cadence

| Rule ID | Requirement | Expected | Actual | Evidence | Status |
| --- | --- | --- | --- | --- | --- |
| LOAN-060 | Daily collection | interval 1, active | `daily` = 1, active | IND | PASS |
| LOAN-061 | Every two days | interval 2, active | `every_2_days` = 2, active | IND | PASS |
| LOAN-062 | Every three days | interval 3, active | `every_3_days` = 3, active | IND | PASS |
| LOAN-063 | Weekly where permitted | interval 7, active | `weekly` = 7, active | IND | PASS |
| LOAN-064 | Collections begin **after** the interval, not on disbursement day | offset = interval | measured on **all 13 disbursed loans**: daily→+1, 2-day→+2, 3-day→+3, weekly→+7. No loan due on its disbursement date | IND-3 | PASS |
| LOAN-065 | Scheduled obligations reconcile exactly to the contractual total | difference 0 | **13 of 13 loans, difference 0** | IND-3 | PASS |
| LOAN-066 | Schedule runs from the actual disbursement date | not the proposed date | measured: `min(due_date) − disbursed_at` = interval | IND-3 | PASS |
| LOAN-067 | Calendar-monthly cadence is **not** silently active | inactive, anchor undecided | `monthly` `is_active = false`, `interval_days` NULL, `month_anchor` NULL | IND | PASS |
| LOAN-068 | A monthly loan without a month anchor is refused | `cadence_anchor_undecided` | failure code present in the validator | SCHEMA | BLOCKED (by design) |
| LOAN-069 | A retired cadence does not freeze the catalogue | checked only when the list is set | conditional in `loan_products_within_business_rules` | SCHEMA, DB:loan-products | PASS |
| LOAN-070 | `generate_loan_schedule` refuses an inactive cadence | refused | asserted | DB:schedule-generation | PASS |
| LOAN-071 | Business time zone | `Africa/Kampala` | `business_timezone()` = Africa/Kampala, `business_date()` = 2026-11-15 under session TZ `Etc/UTC` | CERT, IND | PASS |
| LOAN-072 | Month-length and leap-year boundaries | handled | covered by the repository suite | DB:schedule-generation | PASS |

### B.5 Clients and identity

| Rule ID | Requirement | Expected | Actual | Evidence | Status |
| --- | --- | --- | --- | --- | --- |
| CLIENT-001 | Minimum age 18 | refused below 18 | `clients_date_of_birth_adult` CHECK, evaluated in `Africa/Kampala` | SCHEMA | PASS |
| CLIENT-002 | Implausible dates of birth refused | ≥ 1900-01-01 | `clients_date_of_birth_plausible` | SCHEMA | PASS |
| CLIENT-003 | Ugandan phone number format | `+256` + 9 digits | `clients_phone_e164` CHECK `^\+256[0-9]{9}$` | SCHEMA | PASS |
| CLIENT-004 | Alternative phone must differ from the primary | refused if equal | `clients_alternative_phone_differs` | SCHEMA | PASS |
| CLIENT-005 | Database-generated client numbers | `CL` + ≥ 5 digits, unique | `clients_client_number_shape` CHECK + assignment trigger | SCHEMA, DB-SUITE | PASS |
| CLIENT-006 | Unique client references under concurrency | no duplicates | asserted under concurrent registration | DB-SUITE | PASS |
| CLIENT-007 | Client statuses | active, inactive, suspended, blacklisted, archived | `clients_status_valid` CHECK, all five present | SCHEMA, IND | PASS |
| CLIENT-008 | Suspension and blacklisting require a reason | refused without one | `clients_restricted_status_has_reason` | SCHEMA | PASS |
| CLIENT-009 | Archive consistency | `archived_at` set iff archived | `clients_archived_at_consistent` | SCHEMA | PASS |
| CLIENT-010 | Only active clients may borrow | `canBorrow` | `client_not_active` failure code | SCHEMA | PASS |
| CLIENT-011 | NIN lives behind its own capability | `clients:view_nin` | RLS: `user_has_permission('clients:view_nin')`; held by Manager + Owner **only** | IND, SCHEMA | PASS |
| CLIENT-012 | A Secretary/Treasurer cannot read a NIN | refused | `clients:view_nin` not granted to `secretary_treasurer` | IND | PASS |
| CLIENT-013 | NIN tables grant no DELETE to anyone | none | measured: no DELETE policy, no privilege | SCHEMA, SEC | PASS |
| CLIENT-014 | Portal login is optional | a client may have no profile | 20 clients seeded, 1 with a portal login | IND-2 | PASS |
| CLIENT-015 | Photograph and document upload paths are constrained | shape enforced | `clients_photo_path_shape` CHECK | SCHEMA | PASS |
| CLIENT-016 | Client changes are audited | audit rows written | 924 audit rows, every one naming an actor | CERT, IND-2 | PASS |
| CLIENT-017 | Branch assignment is mandatory and supplied | NOT NULL + trigger | `clients.branch_id` NOT NULL, `loans_stamp_branch` equivalent | SCHEMA | PASS |

### B.6 Guarantors and security

| Rule ID | Requirement | Expected | Actual | Evidence | Status |
| --- | --- | --- | --- | --- | --- |
| GUAR-001 | Minimum guarantor age | 18 | `guarantor_min_age_years = 18`, enforced in `loan_guarantors_check_eligibility` | IND, SCHEMA | PASS |
| GUAR-002 | A borrower cannot guarantee their own loan | refused | raises "A borrower cannot guarantee their own loan." | SCHEMA, DB-SUITE | PASS |
| GUAR-003 | Eligible existing clients may act as guarantors | permitted | `allow_client_as_guarantor = true` | IND | PASS |
| GUAR-004 | A non-active client cannot guarantee | refused | status must be `active` | SCHEMA | PASS |
| GUAR-005 | An archived external guarantor cannot guarantee | refused | `archived_at` checked | SCHEMA | PASS |
| GUAR-006 | **Maximum two active guaranteed loans per guarantor** | `guarantor_max_active_loans = 2` binds | **was not enforced — see DEFECT-001.** Fixed and merged (`dd5f581`); enforced at activation with a per-guarantor advisory lock, re-verified on the merged tree | IND-5, DB:guarantor-concentration | **FAIL → FIXED** |
| GUAR-007 | Quick Loans need no mandatory guarantor | `min_guarantors = 0` | `QL guarantor_required = false, min_guarantors = 0` | IND | PASS |
| GUAR-008 | Individual Loans need no mandatory guarantor | `min_guarantors = 0` | `IL guarantor_required = false, min_guarantors = 0` | IND | PASS |
| GUAR-009 | Salary Loans need at least one guarantor | `min_guarantors = 1` | `SL guarantor_required = true, min_guarantors = 1` | IND | PASS |
| GUAR-010 | Business Loans need at least two guarantors | `min_guarantors = 2` | `BL guarantor_required = true, min_guarantors = 2` | IND | PASS |
| GUAR-011 | Member Loans need at least one guarantor | `min_guarantors = 1` | `ML guarantor_required = true, min_guarantors = 1` | IND | PASS |
| GUAR-012 | The effective requirement is the greater of business and product | `greatest(business, product)` | as implemented in the validator | SCHEMA | PASS |
| GUAR-013 | Consent and undertaking required | refused `guarantor_consent_missing` | failure code present; checked at approval | SCHEMA, DB:loan-workflow | PASS |
| GUAR-014 | Consent is all-or-nothing, with signature and witness | CHECK | `loan_guarantors_consent_complete` demands terms id, version, timestamp, signature **and** witness together | SCHEMA | PASS |
| GUAR-015 | Consent cannot be dated in the future | refused | `loan_guarantors_consent_not_future` | SCHEMA | PASS |
| GUAR-016 | Incomplete guarantor details block approval | refused `guarantor_incomplete` | phone, occupation, location, relationship and identification all required | SCHEMA | PASS |
| GUAR-017 | Ineligible guarantors block approval | refused `guarantor_ineligible` | failure code present | SCHEMA | PASS |
| GUAR-018 | Exactly one subject per guarantee | external **or** client, never both | `loan_guarantors_one_subject` CHECK | SCHEMA | PASS |
| GUAR-019 | Release requires a reason of 3–500 characters | refused otherwise | `loan_guarantors_release_consistent` | SCHEMA | PASS |
| GUAR-020 | Release maintains the product's minimum security | re-validated at approval | `insufficient_guarantors` re-evaluated | SCHEMA, DB:loan-workflow | PASS |
| GUAR-021 | Historical guarantor agreements unchanged after approval | snapshot immutable | `loan_guarantor_snapshots` append-only | SCHEMA, DB:loan-snapshots | PASS |
| GUAR-022 | A borrower cannot see guarantor data at all | no RLS clause for the client role | measured: `loan_guarantor_snapshots` readable only with `loans:view` | SCHEMA | PASS |
| GUAR-023 | A guarantor at the ceiling may still sign an undertaking | permitted (Phase 13.6) | permitted; the ceiling now binds at activation instead | DB:loan-workflow, DB:guarantor-concentration | PASS |

### B.7 Repayments, arrears and penalties

| Rule ID | Requirement | Expected | Actual | Evidence | Status |
| --- | --- | --- | --- | --- | --- |
| PAY-001 | Oldest uncovered obligation settled first | ordered allocation | `post_payment` allocates in due-date order | SCHEMA, DB-SUITE | PASS |
| PAY-002 | Interest before principal within an installment | interest leg first | asserted | DB-SUITE | PASS |
| PAY-003 | Allocation components sum to the payment | refused otherwise | `post_repayment_journal` refuses outright if they do not | SCHEMA | PASS |
| PAY-004 | Overpayment rejected | refused | asserted | DB-SUITE | PASS |
| PAY-005 | Minimum payment enforced | refused below | asserted | DB-SUITE | PASS |
| PAY-006 | A payment may cover multiple installments | permitted | asserted | DB-SUITE | PASS |
| PAY-007 | MTN / Airtel reference required | refused without | asserted | DB-SUITE | PASS |
| PAY-008 | Duplicate external transaction reference rejected | refused | asserted | DB-SUITE | PASS |
| PAY-009 | Payment idempotency | one posting per key | unique index; **0 duplicate keys measured across every table** | CERT, SCHEMA | PASS |
| PAY-010 | Repayment receipts issued | receipt number assigned | `loan_payments_assign_number` | SCHEMA | PASS |
| PAY-011 | Repayment posts Dr cash / Cr receivable + interest + penalty | by the payment's own allocation | measured; see §C.9 identities | IND-4, CERT | PASS |
| PAY-012 | Interest income is not recognised twice | GL = allocated interest | GL 4100 = 594,106 = independently computed 594,106; **difference 0** | IND-4 | PASS |
| PAY-013 | Penalty income is not recognised twice | GL = allocated penalty | GL 4200 = 8,625 = independently computed 8,625; **difference 0** | IND-4 | PASS |
| PAY-014 | `payments:reverse` is Owner only | as documented | measured: `owner_admin` only | IND | PASS |
| PAY-015 | A reversal is a traceable contra entry | exact mirror, dated the reversal day | **2 reversal pairs checked, 0 not mirrored** | CERT | PASS |
| PAY-016 | Reversed payments do not count as collections | excluded | the independent recomputations above exclude `reversed_at is not null` and reconcile to zero | IND-4 | PASS |
| PAY-017 | Unpaid installments carry forward without changing the contract | due dates, principal, interest and allocations untouched | `loan_installment_carry_forwards` is a separate record; contractual rows unchanged | SCHEMA | PASS |
| PAY-018 | Arrears, due today and total currently due are separate figures | three distinct columns | `loan_delinquency.arrears_amount`, `due_today_amount`, `current_due` | IND-6 | PASS |
| PAY-019 | Current due = arrears + due today | identity holds | **12 of 12 loans, 0 failures** | IND-6 | PASS |
| PAY-020 | Current due = scheduled-to-date − paid-to-date | identity holds | **12 of 12 loans, 0 failures** | IND-6 | PASS |
| PAY-021 | Total outstanding = contractual outstanding + unpaid penalty | identity holds | **12 of 12 loans, 0 failures** | IND-6 | PASS |
| PAY-022 | Missed installment count and days past due reported | both present | measured: e.g. LN260005 — 7 missed, 14 days past due | IND-6 | PASS |
| PAY-023 | Missed installments generate no extra interest | no interest accrual on arrears | no mechanism exists that accrues interest on arrears; contractual interest comes only from `loan_periods` | SCHEMA | PASS |
| PAY-024 | Arrears on the dashboard equals the delinquency view | equal | dashboard 787,589 = delinquency 787,589; counts 4 = 4 | CERT | PASS |
| PAY-025 | Standard grace period | 3 days | `grace_period_days = 3`; `QL`/`BL`/`IL` = 3 | IND | PASS |
| PAY-026 | Salary Loan grace period | 5 days | `SL grace_period_days = 5` | IND | PASS |
| PAY-027 | Payment on the final due date is on time | no penalty | `if v_business < v_effective then return null` | SCHEMA | PASS |
| PAY-028 | Payment during the grace period is not penalised | no penalty | measured: LN260006 `within_grace_period = true`, `penalty_eligible = false` | IND-6, SCHEMA | PASS |
| PAY-029 | Penalty is 50% of the qualifying unpaid amount | `penalty_rate_bps = 5000` | measured on both live penalties: 172,500 → **86,250**; 260,671 → **130,336** (= 130,335.5 half-up) | IND-6 | PASS |
| PAY-030 | Penalty derived by the database, never supplied by the browser | computed in `ensure_penalty_applied`, re-derived by CHECK | the stored amount is re-derived independently by a table CHECK | SCHEMA, IND-6 | PASS |
| PAY-031 | Penalty applies only after the applicable grace period | effective date = final due + grace + 1 | as implemented; verified on live rows | SCHEMA, IND-6 | PASS |
| PAY-032 | Penalty applied once, never daily | one row per loan | **0 loans with more than one expiry penalty** | IND-6, SCHEMA | PASS |
| PAY-033 | Penalty does not compound onto itself | single charge, no re-entry | early return when a penalty already exists | SCHEMA | PASS |
| PAY-034 | Later repayments do not change the penalty basis | basis frozen at grace end | `loan_outstanding_as_of(loan, grace_end)`, not today's balance | SCHEMA | PASS |
| PAY-035 | The loan's own snapshotted grace and rate are used | not today's settings | `grace_period_days_applied`, `penalty_rate_bps_applied` | SCHEMA | PASS |
| PAY-036 | A loan cannot be cleared while a penalty is unpaid | refused | **0 cleared loans with an unpaid penalty**; LN260008 remains `active`/`penalty_due` with 77,625 outstanding | IND-6 | PASS |
| PAY-037 | Concurrent posting cannot duplicate a penalty | row lock | `select ... for update` on the loan before any decision | SCHEMA, DB:loan-concurrency | PASS |
| PAY-038 | Charging a penalty posts no journal (cash basis) | nothing posted | `ensure_penalty_applied` has no ledger wiring, by design | SCHEMA | PASS |
| PAY-039 | Penalty reaches the books through the repayment that settles it | via `allocated_penalty` | GL 4200 = allocated penalty, difference 0 | IND-4 | PASS |

### B.8 Membership policy governance

The three policy versions in the certified database, measured directly:

| Version | Title | Status | `effective_from` | `approved_at` | Gates open |
| --- | --- | --- | --- | --- | --- |
| 1.0 | Polytos membership programme — proposed terms | `draft` | **2026-12-01** | — | **none** |
| 2.0 | Polytos membership programme — official policy, management decisions of October 2026 | `draft` | — | — | **none** |
| 998.2 | Polytos membership terms **(harness)** | `active` | 2025-10-11 | 2026-11-15 | enrolment, savings, lending, benefits |

| Rule ID | Requirement | Expected | Actual | Evidence | Status |
| --- | --- | --- | --- | --- | --- |
| POLICY-001 | A draft policy cannot authorise real operations | all gates closed | measured: 1.0 and 2.0 — enrolment / savings / lending / benefits / profit-sharing all `false` | IND-7 | PASS |
| POLICY-002 | **A policy date alone cannot bypass approval** | a dated draft governs nobody | version 1.0 carries `effective_from = 2026-12-01` and is still not the active policy; every gate reads closed | IND-7 | PASS |
| POLICY-003 | Version 2.0 is draft, unapproved and undated | not in force | `status = draft`, `effective_from` NULL, `approved_at` NULL, `approval_reference` NULL | IND-7 | PASS |
| POLICY-004 | Recording a date does not approve or activate a policy | separate capability, needs an authorisation reference | `record_draft_policy_timing` requires the management capability and a reference | SCHEMA | PASS |
| POLICY-005 | Exactly one active policy at a time | single answer | `active_membership_policy_id()` returns one id (998.2) | IND-7 | PASS |
| POLICY-006 | Approved policy terms are frozen | refused | `membership_policy_terms_guard` | SCHEMA, DB-SUITE | PASS |
| POLICY-007 | Enrolled members retain their governing policy | per-member | `membership_governing_policy(membership, as_of)` | SCHEMA, DB-SUITE | PASS |
| POLICY-008 | New versions do not rewrite historical promises | historical terms unchanged | asserted by the upgrade verifier | DB-SUITE | PASS |
| POLICY-009 | Policy transitions require authorisation and evidence | witnessed acceptance, dated assignment | `begin_/complete_membership_policy_transition`, `accept_membership_policy_version` with witness | SCHEMA, DB-SUITE | PASS |
| POLICY-010 | An unrecognised activity gate is refused by name | raises | "There is no membership activity called …" listing the eight valid gates | IND-7 | PASS |
| POLICY-011 | Profit sharing remains closed even under the harness policy | closed | 998.2 `profit_sharing` gate = `false`; the formula is undecided | IND-7 | PASS |
| POLICY-012 | Registration fee | UGX 5,000 | 5,000 in all three versions | IND | PASS |
| POLICY-013 | Qualifying monthly savings | UGX 50,000 | 50,000 in all three versions | IND | PASS |
| POLICY-014 | Savings qualification period | 6 months | 6 in all three versions | IND | PASS |
| POLICY-015 | Member interest rate | 5% per month | 500 bps in all three versions | IND | PASS |
| POLICY-016 | Member loan maximum term | 5 months | 5 in all three versions | IND | PASS |
| POLICY-017 | Policy 2.0's savings-to-loan multiplier | 2× | `savings_to_loan_multiplier_bps = 20000` | IND | PASS |
| POLICY-018 | Policy 2.0's interest basis and method | per month, flat | `interest_basis = per_month`, `interest_method = flat` | IND | PASS |
| POLICY-019 | Policy 2.0's qualifying months need not be consecutive | non-consecutive permitted | `qualifying_months_consecutive = false` | IND | PASS |
| POLICY-020 | Policy 2.0 blocks withdrawal with an active loan | blocked | `savings_withdrawal_with_active_loan = 'blocked'` | IND | PASS |
| POLICY-021 | Medical claims per benefit year under 2.0 | 2 | `medical_benefit_claims_per_year = 2` | IND | PASS |
| POLICY-022 | Death confirmations required under 2.0 | 3 | `death_confirmations_required = 3` | IND | PASS |
| POLICY-023 | Meeting absence fine under 2.0 | UGX 5,000 | `meeting_absence_fine = 5000` | IND | PASS |
| POLICY-024 | **Medical annual cap is undecided** | not invented | `medical_benefit_annual_cap` NULL, `medical_benefit_cap_mode` NULL | IND | **BLOCKED** (correct) |
| POLICY-025 | **Benefit waiting period is undecided** | not invented | `benefit_waiting_period_days` NULL | IND | **BLOCKED** (correct) |
| POLICY-026 | Synthetic test policies are clearly labelled and cannot collide | distinct version | version `998.2`, title "(harness)" | IND-7 | PASS |

### B.9 Savings

| Rule ID | Requirement | Expected | Actual | Evidence | Status |
| --- | --- | --- | --- | --- | --- |
| SAV-001 | Registration fee charged once per membership | storage-level | `membership_fee_receipts_one_posted_per_membership` partial unique index | SCHEMA | PASS |
| SAV-002 | Registration fee is income, never savings | Dr cash / Cr 4340 | measured: Dr 1010 40,000 / Cr **4340 Membership Registration Fees (income)** 40,000 across 8 receipts of 5,000 | IND-4 | PASS |
| SAV-003 | Registration fee is 4340, not 4320 | separate from the client fee | measured: 4340 | IND-4 | PASS |
| SAV-004 | A valid fee receipt is required before activation | refused otherwise | enforced in the activation path | SCHEMA, DB-SUITE | PASS |
| SAV-005 | One live membership per client | storage-level | `memberships_one_live_per_client` partial unique index | SCHEMA | PASS |
| SAV-006 | One savings account per membership | storage-level | `savings_accounts_membership_id_key` unique | SCHEMA | PASS |
| SAV-007 | Qualifying monthly savings | UGX 50,000 | measured: `monthly_minimum = 50000` on all 7 accounts | IND-8 | PASS |
| SAV-008 | Six qualifying months required | 6 | measured: `months_required = 6` | IND-8 | PASS |
| SAV-009 | **Non-consecutive months qualify under the governing policy** | permitted | measured: SA260002 has 6 qualifying months with a longest consecutive run of **3**, and `qualifies = true` | IND-8 | PASS |
| SAV-010 | Qualification is measured as of a specified date | `as_of` parameter | measured: `as_of = 2026-11-15` reported on every row | IND-8 | PASS |
| SAV-011 | A deposit reversal corrects the original contribution month | month loses its qualification | measured: SA260004 has 4 months recorded but only **3 qualifying** after a 40,000 withdrawal/reversal | IND-8 | PASS |
| SAV-012 | Multiple deposits in one month accumulate toward qualification | summed per month | summed per calendar month | DB-SUITE | PASS |
| SAV-013 | Savings deposits increase the member savings liability | Dr cash / Cr 2100 | measured: Dr 1010 1,845,000 / Cr **2100 Member Savings (liability)** 1,845,000 | IND-4 | PASS |
| SAV-014 | **Savings deposits never increase income** | no income leg | measured: **0 savings journals touch any income account** | IND-4 | PASS |
| SAV-015 | Savings ledger liability = savings subledger | equal | GL 2100 = 1,790,000 = `sum(savings_transactions.signed_amount)` 1,790,000; **difference 0** | IND-4, CERT | PASS |
| SAV-016 | Each account's balance = the signed sum of its transactions | equal | **7 of 7 accounts, 0 mismatches** | IND-8 | PASS |
| SAV-017 | No savings account holds a negative balance | none | **0 negative balances** | IND-8, CERT | PASS |
| SAV-018 | Withdrawals require authorisation and posting | two capabilities | `savings:approve_withdrawal` and `savings:post_withdrawal` are separate | SCHEMA | PASS |
| SAV-019 | **The requester cannot approve their own withdrawal** | refused | `if v_actor is not null and v_request.requested_by = v_actor then raise` | SCHEMA, DB-SUITE | PASS |
| SAV-020 | Withdrawals cannot exceed the available balance | refused | checked against `savings_withdrawable_amount` | SCHEMA | PASS |
| SAV-021 | **The available balance is rechecked at payment time** | rechecked under lock | `post_savings_withdrawal` takes `lock_savings_capacity()` then re-reads `savings_withdrawable_amount` and refuses | SCHEMA, DB-SUITE | PASS |
| SAV-022 | Approved and active loans block withdrawal under the blocked rule | refused | "An outstanding loan or savings pledge now blocks this withdrawal." | SCHEMA, DB-SUITE | PASS |
| SAV-023 | A withdrawal needs an active membership and an open savings gate | refused otherwise | both checked in `post_savings_withdrawal` | SCHEMA | PASS |
| SAV-024 | Branch boundaries apply to withdrawal payment | refused across branches | "You cannot pay that branch's withdrawal." | SCHEMA | PASS |
| SAV-025 | Savings pledged to a loan remain a liability | no journal entry on pledge | a pledge restricts, and posts nothing | SCHEMA, DB-SUITE | PASS |
| SAV-026 | Pledged savings are not consumed as loan disbursement | separate accounts | disbursement credits cash, not 2100 | IND-4 | PASS |
| SAV-027 | Pending withdrawals and active pledges reduce lending capacity | subtracted | `savings_withdrawable_amount` nets both | SCHEMA, DB-SUITE | PASS |
| SAV-028 | No race lets the same savings be both withdrawn and pledged | serialised | `lock_savings_capacity` taken by both paths | SCHEMA, DB-SUITE | PASS |
| SAV-029 | A withdrawal decreases both the liability and the funding account | Dr 2100 / Cr cash | measured: Dr 2100 40,000 / Cr 1010 40,000 | IND-4 | PASS |
| SAV-030 | A deposit reversal is a contra entry | mirrored | measured: Dr 2100 15,000 / Cr 1010 15,000 | IND-4 | PASS |

### B.10 Member loans

| Rule ID | Requirement | Expected | Actual | Evidence | Status |
| --- | --- | --- | --- | --- | --- |
| MLOAN-001 | Member interest rate | 5% per month | 500 bps, from the member's own frozen policy | IND | PASS |
| MLOAN-002 | **Flat interest, per month — the brief's worked example** | 300,000 · 5% · 3m → 15,000/month, 45,000 interest, **345,000** repayable | measured exactly: 15,000 / 15,000 / 15,000; interest 45,000; repayable **345,000** | IND-9 | PASS |
| MLOAN-003 | **Flat is not confused with reducing balance** | the two must differ | reducing balance on the same loan gives 30,000 interest (15,000 + 10,000 + 5,000) against flat's 45,000 — **provably distinct** | IND-9 | PASS |
| MLOAN-004 | Per-loan flat basis | one charge on the principal | 300,000 · 5% once = **15,000** | IND-9 | PASS |
| MLOAN-005 | The reducing-balance arm delegates, rather than reimplementing | one engine | `member_loan_interest` returns `calculate_loan_breakdown`'s rows directly | SCHEMA | PASS |
| MLOAN-006 | An undecided interest basis is refused **by name** | refused, not defaulted | "Whether the member interest rate is charged per month or once over the loan has not been decided, so a member loan cannot be priced." | IND-9 | PASS |
| MLOAN-007 | An undecided interest method is refused **by name** | refused, not defaulted | "Whether member interest is flat on the original principal or on a reducing balance has not been decided…" | IND-9 | PASS |
| MLOAN-008 | An unrecognised basis or method is refused | refused | "There is no member interest basis/method called X." | IND-9 | PASS |
| MLOAN-009 | **The undefined per-loan reducing-balance combination is refused** | refused, with the three possible readings named | refused: "…could mean the rate divided by the term, the rate applied to the average outstanding balance, or the rate applied to the original principal — three different prices." | IND-9 | PASS |
| MLOAN-010 | Every allowed basis × method combination behaves correctly | 2 valid, 1 undefined, rest refused | full 3 × 4 matrix measured — see §C | IND-9 | PASS |
| MLOAN-011 | Membership required for a member product | refused `member_product_not_member` | failure code present | SCHEMA | PASS |
| MLOAN-012 | Membership must be active | refused `member_not_active` | failure code present | SCHEMA | PASS |
| MLOAN-013 | The member's own policy must open member lending | refused `member_policy_not_open` | failure code present | SCHEMA | PASS |
| MLOAN-014 | A savings account is required and must be active | refused `member_savings_missing` / `_suspended` | both present | SCHEMA | PASS |
| MLOAN-015 | Qualifying months must have been served | refused `member_not_qualified` | failure code present | SCHEMA | PASS |
| MLOAN-016 | Eligibility ceiling = eligible savings × multiplier | refused `member_amount_above_ceiling` above it | failure code present; 2× under policy 2.0 | SCHEMA | PASS |
| MLOAN-017 | Term above the member's own version refused | refused `member_term_above_maximum` | failure code present | SCHEMA | PASS |
| MLOAN-018 | Cadence must match the term | refused `member_cadence_not_permitted` | failure code present | SCHEMA | PASS |
| MLOAN-019 | Weekly collection for one- and two-month terms | per the policy's `member_loan_weekly_cadence_max_months` | column present and read | SCHEMA | PASS |
| MLOAN-020 | Monthly collection for longer terms | blocked by the undecided month anchor | `monthly` cadence inactive, anchor NULL | IND | **BLOCKED** (correct) |
| MLOAN-021 | Membership and interest basis frozen at approval | write-once for every caller | `loans_guard_member_terms` binds `service_role` too | SCHEMA, DB-SUITE | PASS |
| MLOAN-022 | Eligibility snapshot written at approval | what the business saw | `member_loan_eligibility_snapshots` | SCHEMA, DB-SUITE | PASS |
| MLOAN-023 | Pledges written under a savings-capacity lock | serialised | `approve_loan` takes `lock_savings_capacity` | SCHEMA, DB-SUITE | PASS |
| MLOAN-024 | A pledge posts no journal entry | savings liability unchanged | no ledger wiring on pledge | SCHEMA, IND-4 | PASS |
| MLOAN-025 | The member product ships inactive, so no live member loan can be sold | inactive as migrated | `ML status = inactive` on a pristine migrate; activated only inside the synthetic demonstration environment | IND | **BLOCKED** (correct) |
| MLOAN-026 | A member loan counts against the one-active-loan rule | counted | the trigger counts every loan, member or not | SCHEMA | PASS |
| MLOAN-027 | Pledge released on qualifying completion | released | `member_loan_release_pledge` | SCHEMA, DB-SUITE | PASS |

### B.11 Membership benefits

| Rule ID | Requirement | Expected | Actual | Evidence | Status |
| --- | --- | --- | --- | --- | --- |
| BEN-001 | **Medical support is 5% of the verified bill** | 400,000 → **20,000** | measured: **20,000** | IND-10 | PASS |
| BEN-002 | Medical amount is computed half-up, never floating point | `(bill × bps + 5000) / 10000` in bigint | measured against hand arithmetic on six bills including two half-up boundaries (199,990 → 9,999.5 → **10,000**; 90,001 → 4,500.05 → **4,500**) | IND-10 | PASS |
| BEN-003 | The stored assessment is re-derived independently | CHECK | `benefit_snapshot_medical_arithmetic` recomputes it; a wrong figure cannot be stored by any route | SCHEMA | PASS |
| BEN-004 | 5% is computed, never typed | derived from evidence | `benefit_amount_for_claim` is the only source | SCHEMA | PASS |
| BEN-005 | **Family condolence is a fixed UGX 100,000** | 100,000 | measured: **100,000** | IND-10 | PASS |
| BEN-006 | **Member bereavement is a fixed UGX 200,000** | 200,000 | measured: **200,000** | IND-10 | PASS |
| BEN-007 | An unrecognised claim type is refused, not defaulted | NULL → refusal | measured: returns NULL, which every caller treats as a refusal | IND-10 | PASS |
| BEN-008 | Hospital admission is required | admission and discharge dates | `medical_benefit_min_admission_days = 1`, dates required | SCHEMA, IND | PASS |
| BEN-009 | Admission-duration boundary cases | enforced at the configured minimum | duration computed, compared to the policy figure | SCHEMA, DB-SUITE | PASS |
| BEN-010 | A verified admission record is required | refused without | mandatory evidence CHECK (NOT VALID for historical rows, enforced for new ones) | SCHEMA | PASS |
| BEN-011 | A verified hospital invoice is required | refused without | as above | SCHEMA | PASS |
| BEN-012 | Two medical claims per benefit year under policy 2.0 | 2 | `medical_benefit_claims_per_year = 2` | IND | PASS |
| BEN-013 | The benefit year follows the enrolment anniversary | anniversary basis | `benefit_policy_year_bounds(basis, activated_on, event_date)`; `medical_benefit_year_basis` | SCHEMA | PASS |
| BEN-014 | **No annual medical cap is invented** | NULL means undecided | `medical_benefit_annual_cap` NULL and `medical_benefit_cap_mode` NULL on 1.0 and 2.0; the column comment states there is deliberately no default | IND | **BLOCKED** (correct) |
| BEN-015 | **No waiting period is invented** | NULL means undecided | `benefit_waiting_period_days` NULL on 1.0 and 2.0 | IND | **BLOCKED** (correct) |
| BEN-016 | An over-cap assessment cannot be stored when a cap is configured | CHECK | `benefit_snapshot_within_cap` | SCHEMA | PASS |
| BEN-017 | Concurrent claims cannot both consume the last of a cap | serialised | asserted | DB-SUITE | PASS |
| BEN-018 | Evidence verified by a different officer than the uploader | separate columns and check | `uploaded_by` / `verified_by` distinct | SCHEMA, DB-SUITE | PASS |
| BEN-019 | Maker–checker on approval | assessor ≠ approver | `assessed_by` / `decided_by`, refused when equal | SCHEMA, DB-SUITE | PASS |
| BEN-020 | `benefits:approve` is Owner only | as measured | `owner_admin` only | IND | PASS |
| BEN-021 | A benefit is an expense, never a loan disbursement | Dr 52x0 / Cr cash | 5210 medical, 5220 condolence, 5230 bereavement | SCHEMA | PASS |
| BEN-022 | Benefit payments are recorded separately from disbursements | different accounts | measured: no benefit journal touches 1200 | IND-4 | PASS |
| BEN-023 | An unrecognised claim type maps to no expense account | NULL → refusal | documented and implemented | SCHEMA | PASS |
| BEN-024 | A member dies once — one live bereavement claim | storage-level | `benefit_claims_one_live_bereavement` partial unique index | SCHEMA | PASS |
| BEN-025 | A prior next-of-kin record is required for condolence | refused without | `benefit_claims_deceased_beneficiary_id` + qualifying prior listing | SCHEMA, DB-SUITE | PASS |
| BEN-026 | Eligible deceased family relationships are explicit | ten official relationships; guardian and other excluded | configured per relationship; NULL means undecided, never a default | SCHEMA | PASS |
| BEN-027 | The relationship must be verified | refused without | `member_beneficiaries.verified_by` | SCHEMA | PASS |
| BEN-028 | Bereavement is paid to a verified registered next of kin | `recipient_kind = 'beneficiary'` | CHECK: `claim_type <> 'member_bereavement' or recipient_kind = 'beneficiary'` | SCHEMA | PASS |
| BEN-029 | Other benefits are paid to the member | `recipient_kind = 'member'` | CHECK: `claim_type = 'member_bereavement' or recipient_kind = 'member'` | SCHEMA | PASS |
| BEN-030 | The recipient is frozen and cannot be substituted at payment | frozen at assessment | `benefit_assessment_snapshots`, append-only | SCHEMA, DB-SUITE | PASS |
| BEN-031 | Three independent confirmations from qualifying group members | 3, distinct, real members | `death_confirmations_required = 3`; `benefit_death_confirmations` with distinct confirming and subject memberships | IND, SCHEMA | PASS |
| BEN-032 | A confirmation cannot be given by the subject | distinct FKs | two separate FKs to `memberships` | SCHEMA | PASS |
| BEN-033 | Bereavement withheld while the deceased member owes a loan | withheld | `benefit_payment_blocked_reason` | SCHEMA, DB-SUITE | PASS |
| BEN-034 | Nothing is netted from savings or other benefits | no deduction | no deduction path exists; savings remain a liability | SCHEMA, IND-4 | PASS |
| BEN-035 | Payment is correct double entry | Dr expense / Cr cash | 2 benefit payments posted; the ledger balances | IND-4, CERT | PASS |
| BEN-036 | Reversal preserves the original record | contra entry | `reverse_benefit_payment` writes a contra; `reversal_journal_entry_id` | SCHEMA, CERT | PASS |
| BEN-037 | Benefit evidence is redacted from audit metadata | not recorded | sensitive evidence excluded from new audit entries | SCHEMA | PASS |

### B.12 Meetings and fines

| Rule ID | Requirement | Expected | Actual | Evidence | Status |
| --- | --- | --- | --- | --- | --- |
| MEET-001 | **One ordinary general meeting per branch per month** | storage-level | `membership_meetings_one_monthly_per_branch` unique index on `(branch_id, year, month) where meeting_type = 'monthly_general' and status <> 'cancelled'` | IND, SCHEMA | PASS |
| MEET-002 | A cancelled meeting does not block the month | excluded | the index excludes `cancelled` | IND, SCHEMA | PASS |
| MEET-003 | Special and committee meetings are additional | permitted | other `meeting_type` values are not covered by the index | SCHEMA | PASS |
| MEET-004 | Rescheduling and cancellation supported | both | status transitions present | SCHEMA, DB-SUITE | PASS |
| MEET-005 | Attendance classifications | present, absent, apology, represented | all four present | SCHEMA, DB-SUITE | PASS |
| MEET-006 | Attendance corrections require a reason | refused without | enforced | SCHEMA, DB-SUITE | PASS |
| MEET-007 | Minutes and amendments retain history | append-only history | `minutes_finalised_by` + history | SCHEMA | PASS |
| MEET-008 | Staff action items can be assigned | present | `meeting_action_items` with `assigned_to` | SCHEMA | PASS |
| MEET-009 | Branch permissions apply | enforced | `user_can_see_branch` | SCHEMA | PASS |
| MEET-010 | Absence fine under policy 2.0 | UGX 5,000 | `meeting_absence_fine = 5000` | IND | PASS |
| MEET-011 | Advance notice required before a fine | refused without | pending notices prevent premature fines | SCHEMA, DB-SUITE | PASS |
| MEET-012 | Independent excuse review | separate reviewer | `meeting_absence_notices.reported_by` / `reviewed_by` | SCHEMA | PASS |
| MEET-013 | Fine assessment is authorised and independent | capability + distinct actor | `meeting_fines.assessed_by` | SCHEMA | PASS |
| MEET-014 | No assessment before prerequisites | refused | guard present | SCHEMA, DB-SUITE | PASS |
| MEET-015 | Partial receipts supported | permitted | `meeting_fine_payments`, row-locked to prevent overcollection | SCHEMA | PASS |
| MEET-016 | Fine cancellation supported | permitted | `meeting_fines.cancelled_by` | SCHEMA | PASS |
| MEET-017 | Reversal keeps an audit history | contra entry | `meeting_fine_payments.reversal_entry_id` | SCHEMA | PASS |
| MEET-018 | Correct financial posting | Dr cash / Cr income | `meeting_fine_payments` names both a cash and an income account | SCHEMA | PASS |
| MEET-019 | Receipt prefixes are distinct | MFN for fines, MF for fee receipts | distinct generators | SCHEMA | PASS |
| MEET-020 | No attendance consequence outside the approved policy | gated | fines depend on a policy that authorises them; 1.0 and 2.0 do not | IND-7 | **BLOCKED** (correct) |

### B.13 The double-entry ledger and company finance

| Rule ID | Requirement | Expected | Actual | Evidence | Status |
| --- | --- | --- | --- | --- | --- |
| FIN-001 | **Total debits = total credits** | equal | measured from `journal_lines`: **22,405,083 = 22,405,083, difference 0** | IND-4 | PASS |
| FIN-002 | **Every journal entry balances individually** | each one | **0 unbalanced entries** of 304 | IND-4 | PASS |
| FIN-003 | Every journal has at least two lines | ≥ 2 | **0 entries with fewer than two lines** | IND-4 | PASS |
| FIN-004 | A line has exactly one side, both non-negative | `(debit = 0) <> (credit = 0)` | **0 malformed lines** of 810 | IND-4 | PASS |
| FIN-005 | The balance rule binds every caller | deferred constraint trigger | `DEFERRABLE INITIALLY DEFERRED`, evaluated at commit against the whole entry — binds the application, `service_role` and a hand-typed INSERT | SCHEMA | PASS |
| FIN-006 | Journals are append-only | no UPDATE/DELETE on lines | `journal_lines` cannot be updated or deleted; `journal_entries` permits exactly one update, stamping the contra | SCHEMA | PASS |
| FIN-007 | **An event posts at most once** | storage-level | unique index on `(source_type, source_id)`; **0 duplicate source postings measured** | IND-4, SCHEMA | PASS |
| FIN-008 | Posting is atomic with the money record | one transaction | a raise with no handler aborts the whole transaction | SCHEMA | PASS |
| FIN-009 | `post_journal` is the only writer | SECURITY DEFINER only | no direct INSERT privilege on the ledger | SCHEMA, SEC | PASS |
| FIN-010 | A posting function cannot be handed figures that disagree | reads the records itself | each posting function reads the source row rather than taking amounts | SCHEMA | PASS |
| FIN-011 | Attribution, dates and source references retained | all present | measured: **924 audit rows, 0 with neither a profile nor a label** | CERT, IND-2 | PASS |
| FIN-012 | Corrections are contra entries, never edits | contra only | enforced by the append-only rule | SCHEMA, CERT | PASS |
| FIN-013 | Member Savings 2100 is a liability with a credit normal side | liability | measured: `account_type = liability` | IND-4 | PASS |
| FIN-014 | Cash accounts are assets and only cash is branch-held | `(cash_kind is null) = (branch_id is null)` | CHECK present | SCHEMA | PASS |
| FIN-015 | One cash-at-hand, one MTN and one Airtel float per branch; several banks allowed | partial unique index | present | SCHEMA | PASS |
| FIN-016 | `ledger:post` is Owner only | as measured | `owner_admin` only | IND | PASS |
| FIN-017 | Cash balances equal the authoritative ledger balances | equal | measured: `branch_cash_position` = raw `journal_lines` per account, exactly | IND-4 | PASS |
| FIN-018 | No cash account is negative | none | **FAIL → FIXED.** −345,000 was reproduced live; migration `20261120000400` now refuses at commit any line that would leave a till, wallet, bank or transit account below zero available. See GAP-001 | IND-4, IND-16, DB:cash-sufficiency | **FAIL → FIXED** |
| FIN-019 | Overdraft refused on every money-out path, with no override | refused everywhere | **FAIL → FIXED.** All three unprotected paths now check available funds by name, and a deferred constraint trigger binds every caller including `service_role`. `allow_negative_cash` is read by nothing and its column comment says `INERT` | SCHEMA, IND-16, DB:cash-sufficiency | **FAIL → FIXED** |
| FIN-020 | The overdraft check runs at posting, not submission | at posting | documented and implemented | SCHEMA | PASS |
| FIN-021 | Trial balance foots | debit total = credit total | `trial_balance` columns foot to the same figure | CERT | PASS |
| FIN-022 | No unexplained difference remains in the trial balance | none | **41 identities: 39 pass, 2 explained as composition differences, 0 vacuous, 0 fail** | CERT | PASS |
| FIN-023 | Interest and penalty income are refused to `record_other_income` | refused | 4100 and 4200 rejected by name | SCHEMA | PASS |
| FIN-024 | An expense category *is* a ledger account | no second table | no `expense_categories` table exists | SCHEMA | PASS |
| FIN-025 | Transfers post Dr destination / Cr source | as documented | `account_transfers` | SCHEMA, DB-SUITE | PASS |
| FIN-026 | Expenses post Dr category / Cr payment account | as documented | `expenses` | SCHEMA, DB-SUITE | PASS |
| FIN-027 | Other income posts Dr receiving account / Cr income | as documented | `other_income` | SCHEMA, DB-SUITE | PASS |
| FIN-028 | Owner capital injections recorded | 3000 Owner Capital | present; the derived opening entry credits it | SCHEMA, DB-SUITE | PASS |
| FIN-029 | Above the approval threshold, nothing posts until approved | no journal while pending | documented and implemented | SCHEMA, DB-SUITE | PASS |
| FIN-030 | The initiator cannot approve their own transfer or expense | refused | `approve_transfer` / `approve_expense` refuse the initiator | SCHEMA, DB-SUITE | PASS |
| FIN-031 | `finance:settings` and `finance:accounts` are Owner only | as measured | `owner_admin` only | IND | PASS |
| FIN-032 | A reconciliation count posts nothing by itself | ledger untouched | `submit_reconciliation` freezes evidence; only an approved write-off posts | SCHEMA, DB-SUITE | PASS |
| FIN-033 | A difference is written off only through 5950 Cash Over and Short | explicit journal | as documented | SCHEMA | PASS |
| FIN-034 | One count per account per business date | storage-level | unique index | SCHEMA | PASS |
| FIN-035 | Reconciliation needs a second person | refused otherwise | migration `20261112000200_reconciliation_needs_a_second_person` | SCHEMA, DB-SUITE | PASS |
| FIN-036 | Every posted financial document carries a journal | none missing | **no posted document is missing its journal** | CERT | PASS |
| FIN-037 | Every reversal stamp points at an entry that exists | no dangling stamps | **0 dangling reversal stamps** | CERT | PASS |
| FIN-038 | Branch visibility applies to finance, clients and loans alike | one rule | `user_can_see_branch` applied across all three | SCHEMA | PASS |
| FIN-039 | Interest charged but not received is not an asset | cash basis | 1200 carries principal only — and reconciles to it exactly | IND-4 | PASS |
| FIN-040 | `total_liquidity` is the five cash kinds including agency float | documented, not silently mixed | the column comment states it; measured 1,128,726 + 1,002,852 + 446,905 + 0 + 1,480,000 = **4,058,483** as reported | IND-4 | PASS |

### B.14 Agency Banking

| Rule ID | Requirement | Expected | Actual | Evidence | Status |
| --- | --- | --- | --- | --- | --- |
| AGENCY-001 | **A customer deposit increases physical cash and decreases electronic float** | Dr cash / Cr float | measured on a live 450,000 deposit: **Dr 1010 Cash at Hand 450,000 / Cr 1320 MTN Float 450,000** | IND-11 | PASS |
| AGENCY-002 | **A customer withdrawal decreases physical cash and increases electronic float** | Dr float / Cr cash | measured on a live 300,000 withdrawal: **Dr 1320 MTN Float 300,000 / Cr 1010 Cash at Hand 300,000** | IND-11 | PASS |
| AGENCY-003 | Fees post separately from the principal | own line | measured: Cr 4570 Agency Service Fees 1,000, as its own line | IND-11 | PASS |
| AGENCY-004 | Commissions post separately from the principal | own line(s) | measured: deferred model Dr 1310 Commission Receivable / Cr 4510 Commission; immediate model Cr 4510 inside the counter leg | IND-11 | PASS |
| AGENCY-005 | **POLYTOS never computes or displays a customer's bank balance** | no such column anywhere | measured: **no column in the whole schema matches a customer-balance pattern**; the export module states the rule explicitly and omits the field | IND-11 | PASS |
| AGENCY-006 | No customer identifier in exports | omitted | the transaction report carries the provider reference and a masked line identifier only | SCHEMA | PASS |
| AGENCY-007 | Float balances separable by bank, branch, account, transaction and period | separable | float accounts are per provider per branch (`1320.<PROVIDER>.<BRANCH>`); 41 float accounts across 14 providers | IND-2 | PASS |
| AGENCY-008 | Insufficient float refused | refused | `assert_agency_float_available` on the `provider_float` model | SCHEMA, DB-SUITE | PASS |
| AGENCY-009 | Insufficient till cash refused | refused | `assert_cash_available` on the net amount | SCHEMA, DB-SUITE | PASS |
| AGENCY-010 | A `cash_payable` withdrawal may not take the payable into net debit | refused, naming the provider | refused: "No approved bank-advance arrangement exists, so the payable may not go into net debit." | SCHEMA, DB-SUITE | PASS |
| AGENCY-011 | The bank-advance model is specified but deliberately unimplemented | no flag to set | `docs/POLYTOS-AGENCY-BANK-ADVANCE-MODEL.md`; no switch exists | SCHEMA | **BLOCKED** (correct) |
| AGENCY-012 | Float replenishment comes from a real company funding account | Dr float / Cr funding | measured: **Dr 1320 MTN Float 1,500,000 / Cr 1010 Cash at Hand 1,500,000** ("Float topped up" / "Funding transferred") | IND-11 | PASS |
| AGENCY-013 | Funds cannot appear without an offsetting movement | balanced | every agency entry balances; an explicit assertion refuses an unbalanced one before `post_journal` sees it | IND-4, SCHEMA | PASS |
| AGENCY-014 | Replenishment records source, destination, amount, provider, reference and officers | all recorded | `agency_float_replenishment_guard` + the journal's attribution | SCHEMA | PASS |
| AGENCY-015 | **Cash banking: the amount leaves the till, the net reaches the bank, the charge is an expense, float is untouched** | Cash −X · Bank +(X − charge) · Charges +charge · float unchanged | **measured on a live posting with a real charge**: banked 4,000,000 with a 20,000 charge → **Dr 1040 Cash at Bank 3,980,000 · Cr 1010 Cash at Hand 4,000,000 · Dr 5080 Bank Charges 20,000**, no float line, and it foots. The brief's 100,000/2,000/98,000 example is the same arithmetic | IND-11, PW | PASS |
| AGENCY-016 | A bank charge must be ≥ 0 and < the amount banked | refused otherwise | explicit check | SCHEMA | PASS |
| AGENCY-017 | Cash banking fabricates no customer deposit and no income | neither | the only lines are bank, till and the charge expense | SCHEMA | PASS |
| AGENCY-018 | **Cash banking is maker–checker: the recorder cannot verify it** | refused | `if b.created_by = v_actor then raise` in `verify_agency_cash_banking` | SCHEMA, DB-SUITE | PASS |
| AGENCY-019 | Verification requires `agency:settlements` | refused otherwise | `agency_actor('agency:settlements')` | SCHEMA | PASS |
| AGENCY-020 | Recording requires `agency:write` | refused otherwise | `agency_actor('agency:write')` | SCHEMA | PASS |
| AGENCY-021 | Cash banking is idempotent and reversible | both | idempotency guard + `reverse_agency_cash_banking` | SCHEMA, DB-SUITE | PASS |
| AGENCY-022 | One staff member may operate several authorised accounts | permitted | `agency_account_staff` is many-to-many | SCHEMA, DB-SUITE | PASS |
| AGENCY-023 | An unassigned cashier cannot transact | refused | `assert_agency_account_operator` | SCHEMA, DB-SUITE | PASS |
| AGENCY-024 | Assignments can be granted and withdrawn | both | `assign_` / `revoke_agency_account_staff` | SCHEMA, DB-SUITE | PASS |
| AGENCY-025 | A withdrawn assignment stops authorising new operations | refused | `revoked_at` honoured | SCHEMA, DB-SUITE | PASS |
| AGENCY-026 | Branch boundaries enforced on assignment | refused across branches | `if p.branch_id is not null and p.branch_id <> f.branch_id` | IND-12, SCHEMA | PASS |
| AGENCY-027 | A head-office officer (no branch) **may** be authorised anywhere | permitted | the DB permits a NULL-branch officer, and the **UI filter now mirrors it exactly** (`person.branchId === null \|\| person.branchId === account.branchId`) | IND-12 | PASS |
| AGENCY-028 | A staff member with no staff role cannot operate an account | refused, by name | "% holds no staff role, so they cannot operate an agent account." | SCHEMA | PASS |
| AGENCY-029 | An inactive staff member cannot be authorised | refused | status must be `active` | SCHEMA | PASS |
| AGENCY-030 | Transfers between accounts of one provider | supported | `record_agency_float_trade` | SCHEMA, DB-SUITE | PASS |
| AGENCY-031 | Transfer verification is a second officer's act | maker–checker | `verify_agency_float_trade` with a revision guard | SCHEMA, DB-SUITE | PASS |
| AGENCY-032 | Duplicate submissions refused | idempotency replay guard | migration `20261114000100_agency_idempotency_replay_guard` | SCHEMA, DB-SUITE | PASS |
| AGENCY-033 | Transfers recognise no false revenue | fee lines only | no income leg beyond an explicit fee | SCHEMA | PASS |
| AGENCY-034 | Earned, received, settled and outstanding commission are separate | four figures | `agency_commission_earned_by_line`, `agency_commission_outstanding_by_line`, settlements, recoveries | SCHEMA, DB-SUITE | PASS |
| AGENCY-035 | Daily commission across days and accounts | per line per day | migration `20261118000100_agency_commission_daily` | SCHEMA, DB-SUITE | PASS |
| AGENCY-036 | Commission settlement and reversal | both | `record_commission_settlement`, `reverse_commission_settlement` | SCHEMA, DB-SUITE | PASS |
| AGENCY-037 | Commission reconciliation against the provider's own figure | certified separately | `submit_`/`certify_agency_commission_reconciliation` | SCHEMA, DB-SUITE | PASS |
| AGENCY-038 | **A provisional or inactive provider cannot post** | refused beyond draft | `agency_transaction_live_readiness_guard` refuses when `is_provisional` or not `is_active` | IND-13, SCHEMA | PASS |
| AGENCY-039 | **No real provider was activated by this audit** | all real providers provisional | measured: all 10 real providers `is_provisional = true`; only synthetic `DEMO_*` providers are non-provisional | IND-13 | PASS |
| AGENCY-040 | Both accounts are locked, in either direction, before any balance is read | both locked | `lock_agency_provider_balance` then `lock_ledger_balances(array[cash, counter])`, provider lock first for a single global order | SCHEMA, DB-SUITE | PASS |
| AGENCY-041 | A commission cannot exceed the principal | refused | explicit check | SCHEMA | PASS |
| AGENCY-042 | A customer fee cannot consume the whole payout | refused | explicit check | SCHEMA | PASS |
| AGENCY-043 | Both fee modes have the same net effect on the drawer | equal net | the gross presentation differs; the affordability check uses the net | SCHEMA | PASS |

### B.15 Mobile Money

| Rule ID | Requirement | Expected | Actual | Evidence | Status |
| --- | --- | --- | --- | --- | --- |
| MM-001 | MTN and Airtel are separate providers with their own categories | separate rows | `MTN_MOMO`, `AIRTEL_MONEY` (real, provisional) and `DEMO_MTN`, `DEMO_AIRTEL` (synthetic), all `category = mobile_money` | IND-13 | PASS |
| MM-002 | Separate registered agent lines | per line | `agency_agent_lines` with identity columns | SCHEMA, DB-SUITE | PASS |
| MM-003 | Individual float positions per line | separate accounts | measured: MTN float 730,000 and Airtel float 446,905/750,000 tracked separately | IND-4 | PASS |
| MM-004 | Customer cash deposits | Dr cash / Cr float | measured on both providers | IND-11 | PASS |
| MM-005 | Customer withdrawals | Dr float / Cr cash | measured on both providers | IND-11 | PASS |
| MM-006 | Manual transaction references | recorded, amendable with a reason | `provider_reference`, `update_agency_transaction_reference(id, new, reason)` | SCHEMA | PASS |
| MM-007 | Float purchases and sales | both | `record_agency_float_trade(kind, …)` | SCHEMA, DB-SUITE | PASS |
| MM-008 | Transfers between eligible lines | supported with a counter account | `counter_float_account_id` | SCHEMA | PASS |
| MM-009 | Daily commissions and settlement | both | see AGENCY-034/035/036 | DB-SUITE | PASS |
| MM-010 | Reconciliation to provider statements | supported | `submit_agency_float_reconciliation(statement_balance, statement_ref, …)` | SCHEMA, DB-SUITE | PASS |
| MM-011 | Reversals | contra entries | `reverse_agency_transaction`, `reversal_entry_id` | SCHEMA, CERT | PASS |
| MM-012 | Pending verification state | present | `submitted` → `verified` → `posted` | SCHEMA | PASS |
| MM-013 | Authorised staff assignments | per account | see AGENCY-022..029 | DB-SUITE | PASS |
| MM-014 | Masked phone-number display | masked | masked line identifier in reports and exports | SCHEMA | PASS |
| MM-015 | Unauthorised line and transaction access refused | refused | RLS + `agency_may_operate_account` | SCHEMA, DB-SUITE | PASS |
| MM-016 | Other provider categories follow their configured model | per category | measured: utilities, school fees, TV subscription and airtime/data all present with their own `float_model` and `commission_model` | IND-13 | PASS |
| MM-017 | No provider-specific fee was invented | none added | every configured fee comes from the provider row | SCHEMA | PASS |
| MM-018 | A dynamic provider hierarchy in the sidebar | derived from configuration | the sidebar reads the provider/line configuration | SCHEMA | PASS |

### B.16 Reports, dashboards and exports

| Rule ID | Requirement | Expected | Actual | Evidence | Status |
| --- | --- | --- | --- | --- | --- |
| REP-001 | Arrears on the executive dashboard equals the delinquency view | equal | **787,589 = 787,589**; loan counts 4 = 4 | CERT | PASS |
| REP-002 | Outstanding principal on the dashboard equals GL 1200 | equal | `dashboard_portfolio_summary.principal_outstanding` = GL 1200 = 3,654,212 | CERT, IND-4 | PASS |
| REP-003 | Interest income reported equals interest collected | equal | 594,106 = 594,106 | IND-4 | PASS |
| REP-004 | Penalty income reported equals penalty collected | equal | 8,625 = 8,625 | IND-4 | PASS |
| REP-005 | No loan reports a negative outstanding | none | **every loan outstanding is zero or positive** | CERT | PASS |
| REP-006 | Portfolio at Risk view exists and is derived from the schedule | derived | `portfolio_at_risk` | SCHEMA | PASS |
| REP-007 | Days past due and missed counts reported per loan | present | `loan_delinquency` | IND-6 | PASS |
| REP-008 | Savings balances and qualification reported | both | `member_savings_qualification`, `savings_summary`, `savings_statement` | IND-8 | PASS |
| REP-009 | Benefit payments reported | present | `benefit_reporting` views | SCHEMA | PASS |
| REP-010 | Meeting fines reported and reconciled to the GL | both | `/meetings/fines` with GL reconciliation | SCHEMA | PASS |
| REP-011 | Trial balance, general ledger and cash position views | three | `trial_balance`, `ledger_account_balances`, `branch_cash_position` | SCHEMA, IND-4 | PASS |
| REP-012 | Balance views are `security_invoker`, so RLS decides who sees what | invoker | set on all three, with `anon` privileges explicitly revoked before `select` is granted | SCHEMA | PASS |
| REP-013 | Agency float, transaction, commission and settlement reports | present | the agency money views | SCHEMA | PASS |
| REP-014 | CSV export disarms formula injection | neutralised | a leading `=`, `+`, `-` or `@` is neutralised, because provider references are user-supplied | SCHEMA | PASS |
| REP-015 | Exports omit the customer identifier | omitted | by design, documented in `lib/reports/agency-fields.ts` | SCHEMA | PASS |
| REP-016 | No report presents a customer bank balance | absent | no such column exists | IND-11 | PASS |
| REP-017 | Reversals are reflected in reports | excluded from collections | the independent recomputations excluding reversals reconcile to zero | IND-4 | PASS |
| REP-018 | Internal transfers are not double-counted as income | separate accounts | transfers post cash-to-cash and touch no income account | SCHEMA | PASS |
| REP-019 | Interest collections are not labelled net profit | not labelled | income accounts are reported as income, with expenses separate; the two "explained" certification identities state the composition explicitly | CERT | PASS |
| REP-020 | A report mixing time periods is not produced silently | period-scoped | each report takes an explicit range | SCHEMA | PASS |
| REP-021 | Reports, dashboards and exports render for every role under RLS | rendered or refused per capability | **exercised by the browser suite across desktop, tablet and mobile** | PW | PASS |
| REP-022 | CSV export matches the rows on screen | equal | the browser suite downloads the CSV, asserts `content-type: text/csv`, asserts it is a download rather than something rendered in place, and separately proves the ten-exports-in-ten-minutes limiter still refuses the eleventh | PW | PASS |
| REP-023 | PDF export is a real, parseable PDF carrying the right figures | parseable, correct | the generated PDF is parsed back with `pdfjs-dist` and its text asserted — not a byte-length check | UNIT | PASS |
| REP-024 | Zero-data behaviour | empty states, not errors | exercised by the browser suite | PW | PASS |

### B.17 Authorisation and security

| Rule ID | Requirement | Expected | Actual | Evidence | Status |
| --- | --- | --- | --- | --- | --- |
| SEC-001 | **Row Level Security on every base table** | 100% | measured: **95 of 95 base tables have RLS enabled; 0 without** | IND-14 | PASS |
| SEC-002 | Four roles exist and are distinct | Owner/Admin, Manager, Secretary/Treasurer, Client | measured: `owner_admin` 117 permissions, `manager` 88, `secretary_treasurer` 51, `client` **3** | IND-14 | PASS |
| SEC-003 | The borrower holds almost nothing | portal only | measured: `account:view`, `account:update`, `portal:view` — and nothing else | IND-14 | PASS |
| SEC-004 | `loans:approve` — Manager and Owner | as documented | measured exactly | IND-14 | PASS |
| SEC-005 | **`loans:disburse` — Owner only (the central control)** | withheld from the Manager | measured: `owner_admin` only | IND-14 | PASS |
| SEC-006 | `loans:cancel` — Owner only | as documented | measured exactly | IND-14 | PASS |
| SEC-007 | `payments:reverse` — Owner only | as documented | measured exactly | IND-14 | PASS |
| SEC-008 | `ledger:post` — Owner only | as documented | measured exactly | IND-14 | PASS |
| SEC-009 | `products:manage`, `settings:update`, `finance:settings` — Owner only | as documented | measured exactly | IND-14 | PASS |
| SEC-010 | `benefits:approve` — Owner only | as documented | measured exactly | IND-14 | PASS |
| SEC-011 | `audit:view` — Owner only | as documented | measured exactly | IND-14 | PASS |
| SEC-012 | `agency:verify` — Manager and Owner | as documented | measured exactly | IND-14 | PASS |
| SEC-013 | **NIN behind `clients:view_nin`, held by Manager and Owner only** | Secretary/Treasurer refused | measured: RLS on `client_identities` requires `clients:view_nin`; not granted to `secretary_treasurer` | IND-14 | PASS |
| SEC-014 | **Loan identity snapshots behind `loans:view_sensitive`** | Secretary/Treasurer refused | measured: RLS requires `loans:view_sensitive`; held by Manager and Owner only | IND-14 | PASS |
| SEC-015 | `membership:view_sensitive` — Manager and Owner only | as documented | measured exactly | IND-14 | PASS |
| SEC-016 | A borrower cannot read a draft loan | refused | the RLS clause admits only non-draft own loans | SCHEMA | PASS |
| SEC-017 | A borrower cannot read guarantor data at all | refused | no client clause on the guarantor tables | SCHEMA | PASS |
| SEC-018 | No identity data is written into the audit trail | absent | a snapshot event records its kind and row count only | SCHEMA | PASS |
| SEC-019 | No privileged exposure is unreviewed | reviewed inventory | **`npm run check:security`: "No unreviewed privileged exposure"** | SEC | PASS |
| SEC-020 | Exactly the intended functions are SECURITY DEFINER | an exhaustive list, asserted | asserted against a stated inventory; this audit's new trigger function was added to it | DB:security | PASS |
| SEC-021 | Anonymous execution of privileged helpers is revoked | revoked | `revoke all … from public, anon, authenticated` on each | SCHEMA, SEC | PASS |
| SEC-022 | Writes to the ledger do not go through RLS at all | SECURITY DEFINER only | no INSERT privilege is granted on `journal_entries`/`journal_lines` | SCHEMA, SEC | PASS |
| SEC-023 | **PostgREST relationship embeds are unambiguous** | no bare embed on an ambiguous FK path | **66 ambiguous `(from, to)` FK pairs exist. Every one of the application's `.select()` embeds was scanned: 3 bare embeds target tables reachable by more than one FK *in general*, and all 3 were confirmed to have exactly one FK from their own querying table. 0 ambiguous embeds.** | IND-15 | PASS |
| SEC-024 | **The Agency staff-filter defect class does not recur** | the UI filter mirrors the DB rule | measured: DB permits a NULL-branch officer (`if p.branch_id is not null and p.branch_id <> f.branch_id`); the UI filter is `person.branchId === null \|\| person.branchId === account.branchId` — **exactly equivalent** | IND-12 | PASS |
| SEC-025 | Sidebar, route, server action, PostgREST, function grants and RLS agree | all six agree | the six layers were compared for the financial operations above; the browser suite drives routes and sidebars per role across three viewports | IND-14, PW | PASS |
| SEC-026 | Login, logout and forced password change | enforced | `require_business_identity()` demands an active account with a completed password change | SCHEMA, PW | PASS |
| SEC-027 | Inactive users are refused | refused | status checked in `require_business_identity` | SCHEMA | PASS |
| SEC-028 | Branch restrictions enforced | enforced | `user_can_see_branch`; a profile with no branch is unrestricted, which is deliberate | SCHEMA | PASS |
| SEC-029 | Real Supabase Auth behaviour is rehearsed separately | rehearsal present | `real-auth.release.spec.ts` with the real-Auth harness | SCHEMA | NOT TESTED (needs `E2E_REAL_AUTH_BINARY`, unavailable here — see §H) |
| SEC-030 | Reading approval-validation output needs `loans:view` | refused otherwise | explicit check in `validate_loan_for_approval` | SCHEMA | PASS |
| SEC-031 | Test-role grants were not widened for this audit | unchanged | no grant was altered; the only schema change is migration `20261119000100` | IND | PASS |

### B.18 Concurrency and financial stress

| Rule ID | Requirement | Expected | Actual | Evidence | Status |
| --- | --- | --- | --- | --- | --- |
| CONC-001 | Two officers approving the same loan | one wins | row lock, then status re-check | DB:loan-concurrency | PASS |
| CONC-002 | Two disbursement attempts on one loan | one wins | asserted | DB:loan-concurrency | PASS |
| CONC-003 | Four simultaneous activations for one borrower | exactly one becomes active | asserted — and still correct after this audit's fix | DB:loan-concurrency | PASS |
| CONC-004 | The active-loan rule honours the configured limit, not a hard-coded 1 | honours 2 as well | asserted | DB:loan-concurrency | PASS |
| CONC-005 | Two concurrent repayments | no duplicate posting | asserted | DB:loan-concurrency | PASS |
| CONC-006 | Duplicate idempotency keys | refused | **0 reused keys measured across every table** | CERT | PASS |
| CONC-007 | Concurrent penalty posting | one penalty | row lock before any decision | DB:loan-concurrency | PASS |
| CONC-008 | **Guarantor concentration race** | one of two wins | **before the fix both passed (`[true, true]`); after it, exactly one** | IND-5, DB:guarantor-concentration | **FAIL → FIXED** |
| CONC-009 | Two savings withdrawals competing for one balance | one wins | `lock_savings_capacity` | DB-SUITE | PASS |
| CONC-010 | Loan approval versus savings withdrawal | serialised | the same capacity lock on both paths | DB-SUITE | PASS |
| CONC-011 | Two medical claims competing for one remaining cap | one wins | asserted | DB-SUITE | PASS |
| CONC-012 | Two agency transactions on one float account | serialised | both accounts locked in a single global order | DB-SUITE | PASS |
| CONC-013 | Two transfers consuming the same source float | one wins | asserted | DB-SUITE | PASS |
| CONC-014 | Cash banking versus cash withdrawal | serialised | the till is locked in either direction | DB-SUITE | PASS |
| CONC-015 | Settlement versus reversal | serialised | `agency_locked_commission_settlement`, `agency_locked_payable_settlement` | DB-SUITE | PASS |
| CONC-016 | Reconciliation versus concurrent postings | serialised | a deposit now takes the till's lock too — the C3 gap, closed in `20261111000100` | SCHEMA, DB-SUITE | PASS |
| CONC-017 | A withdrawal and a settlement must not both pass against one payable | one wins | the C2 gap: both paths now take `lock_agency_provider_balance` | SCHEMA, DB-SUITE | PASS |
| CONC-018 | Authorisation withdrawn while a transaction is submitted | refused at posting | operator re-checked at posting | DB-SUITE | PASS |
| CONC-019 | Simultaneous post and reverse of one record | one wins | revision guards | DB-SUITE | PASS |
| CONC-020 | No partially committed journal, ever | atomic | the deferred balance trigger evaluates the whole entry at commit | SCHEMA, IND-4 | PASS |
| CONC-021 | No unauthorised negative balance under concurrency | none | **FAIL → FIXED** for cash; savings and loan outstandings were never affected. Two concurrent disbursements against one till now resolve to exactly one, under the account lock `post_journal` already took | IND-4, IND-8, IND-16, CERT, DB:cash-sufficiency | **FAIL → FIXED** |
| CONC-022 | Frozen agreements cannot be mutated under any race | immutable | append-only snapshots bind `service_role` | SCHEMA, DB:loan-snapshots | PASS |

---

## C. Financial calculation evidence

Each measurement below was produced by this audit. `IND-n` is the reference
used in the matrix.

### IND-1 — The reducing-balance engine, 6,770 loans

An engine was written from the business rule alone — nothing in it derived
from `lib/domain/loan.ts` or `calculate_loan_breakdown` — and used as the
oracle:

```
interest(n)  = round_half_up(openingPrincipal(n) × rateBps / 10000)
principal(n) = level portions, the remainder in the FINAL period(s)
arithmetic   = exact integers throughout
```

6,770 distinct `(principal, rate, term)` cases were generated: the brief's
four worked examples; every product boundary (100,000 / 100,001 / 199,999 /
200,000 / 200,001 / 300,000 / 1,999,999 / 2,000,000 / 2,000,001 / 19,999,999 /
20,000,000) crossed with six rate bands (5%, 10%, 12%, 15%, 18%, 20%) and five
terms; 1,200 cases hunting half-up boundaries; 354 odd-remainder cases; and
2,500 pseudo-random cases on a fixed seed.

| Measure | Result |
| --- | ---: |
| Cases compared | **6,770** |
| Period rows compared, field by field | **16,823** |
| **Mismatches against the authoritative PostgreSQL engine** | **0** |
| Cases failing the internal identity (principal sums to the loan; total = principal + interest) | **0** |

#### The four worked examples

| Example | Input | Expected (independent) | Actual (PostgreSQL) | Difference |
| --- | --- | --- | --- | ---: |
| 1 | 100,000 · 15% · 1m | 100,000 + 15,000 = **115,000** | 115,000 | **0** |
| 2 | 200,000 · 15% · 2m | 130,000 then 115,000 = **245,000** | 130,000 / 115,000 / 245,000 | **0** |
| 3 | 600,000 · 15% · 3m | 290,000 / 260,000 / 230,000 = **780,000** | identical | **0** |
| 4 | Salary 200,000 · 12% · 2m | 124,000 then 112,000 = **236,000** | 124,000 / 112,000 / 236,000 | **0** |

Example 3 in full, as both engines produce it:

| Month | Opening | Principal | Interest | Due | Closing |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 600,000 | 200,000 | 90,000 | **290,000** | 400,000 |
| 2 | 400,000 | 200,000 | 60,000 | **260,000** | 200,000 |
| 3 | 200,000 | 200,000 | 30,000 | **230,000** | 0 |

#### The two cases that distinguish the rounding mode and the remainder rule

| Case | Why it matters | Expected | Actual |
| --- | --- | ---: | ---: |
| 445 at 50%, 1 month | exactly 222.5 — half-up gives 223, banker's rounding gives 222 | **223** | 223 |
| 200,001 over 2 months | the odd shilling must not vanish | 100,000 then **100,001** | 100,000 / 100,001 |

### IND-3 — Collection schedules, all 13 disbursed loans

| Loan | Cadence | Interval | Disbursed | First due | Offset | Installments | Contractual | Schedule total | Difference |
| --- | --- | ---: | --- | --- | ---: | ---: | ---: | ---: | ---: |
| LN260001 | daily | 1 | 2026-11-03 | 2026-11-04 | **+1** | 29 | 690,000 | 690,000 | **0** |
| LN260002 | every 3 days | 3 | 2026-10-26 | 2026-10-29 | **+3** | 20 | 1,102,500 | 1,102,500 | **0** |
| LN260003 | daily | 1 | 2026-11-06 | 2026-11-07 | **+1** | 29 | 517,500 | 517,500 | **0** |
| LN260004 | daily | 1 | 2026-10-30 | 2026-10-31 | **+1** | 30 | 862,500 | 862,500 | **0** |
| LN260005 | every 2 days | 2 | 2026-10-16 | 2026-10-18 | **+2** | 30 | 1,470,000 | 1,470,000 | **0** |
| LN260006 | daily | 1 | 2026-10-14 | 2026-10-15 | **+1** | 30 | 575,000 | 575,000 | **0** |
| LN260007 | daily | 1 | 2026-10-01 | 2026-10-02 | **+1** | 30 | 460,000 | 460,000 | **0** |
| LN260008 | every 2 days | 2 | 2026-09-26 | 2026-09-28 | **+2** | 14 | 402,500 | 402,500 | **0** |
| LN260009 | daily | 1 | 2026-10-06 | 2026-10-07 | **+1** | 30 | 345,000 | 345,000 | **0** |
| LN260010 | daily | 1 | 2026-08-12 | 2026-08-13 | **+1** | 30 | 287,500 | 287,500 | **0** |
| LN260011 | every 2 days | 2 | 2026-11-01 | 2026-11-03 | **+2** | 30 | 980,000 | 980,000 | **0** |
| LN260015 | weekly | 7 | 2026-10-26 | 2026-11-02 | **+7** | 8 | 322,500 | 322,500 | **0** |
| LN260018 | daily | 1 | 2026-11-15 | 2026-11-16 | **+1** | 29 | 460,000 | 460,000 | **0** |

**Offset equals the interval on every loan**, so no collection is ever due on
the disbursement day. **Every schedule reconciles to its contractual total
with a difference of zero.** 339 installments in total.

### IND-4 — Ledger and cross-module reconciliation identities

Recomputed from base tables, never from the reporting views:

| # | Identity | Ledger | Independently computed | Difference |
| ---: | --- | ---: | ---: | ---: |
| 1 | Total debits = total credits | 22,405,083 | 22,405,083 | **0** |
| 2 | Every entry balances individually | 304 entries | 0 unbalanced | **0** |
| 3 | Every entry has ≥ 2 lines | 304 entries | 0 with fewer | **0** |
| 4 | Every line has exactly one non-negative side | 810 lines | 0 malformed | **0** |
| 5 | **Loans Receivable (1200) = principal disbursed − principal repaid** | 3,654,212 | 3,654,212 | **0** |
| 6 | **Interest Income (4100) = interest allocated on unreversed payments** | 594,106 | 594,106 | **0** |
| 7 | **Penalty Income (4200) = penalty allocated on unreversed payments** | 8,625 | 8,625 | **0** |
| 8 | **Member Savings (2100) = savings subledger** | 1,790,000 | 1,790,000 | **0** |
| 9 | Every disbursed loan has exactly one disbursement journal | 12 loans | 12 journals, 0 missing | **0** |
| 10 | No duplicate journal per source event | — | 0 duplicates | **0** |
| 11 | **No savings journal touches an income account** | — | 0 | **0** |
| 12 | Cash positions in `branch_cash_position` = raw journal lines | 4,058,483 | 4,058,483 | **0** |
| 13 | No cash account is negative *(on the seeded book, before the browser suite ran)* | — | 0 negative | **0** |

Savings and fee postings, read off the journal lines themselves:

| Event | Debit | Credit | Amount |
| --- | --- | --- | ---: |
| Membership registration fee (8 × 5,000) | 1010 Cash at Hand | **4340 Membership Registration Fees (income)** | 40,000 |
| Savings deposit | 1010 Cash at Hand | **2100 Member Savings (liability)** | 1,845,000 |
| Savings deposit reversal | 2100 Member Savings | 1010 Cash at Hand | 15,000 |
| Savings withdrawal | 2100 Member Savings | 1010 Cash at Hand | 40,000 |

So the registration fee is income and the deposit is a liability — the two are
not confused, and **no savings journal reaches an income account at all**.

### IND-6 — Arrears and penalties on the live book

| Identity | Loans checked | Failures |
| --- | ---: | ---: |
| `current_due` = `arrears_amount` + `due_today_amount` | 12 | **0** |
| `current_due` = `scheduled_due_to_date` − `paid_against_schedule` | 12 | **0** |
| `total_outstanding` = `contractual_outstanding` + `penalty_remaining` | 12 | **0** |

Worked through on one loan (LN260004): scheduled to date 460,000, paid
345,000, arrears 86,250, due today 28,750. 86,250 + 28,750 = **115,000** =
460,000 − 345,000. Three missed installments, 3 days past due.

#### Penalty recomputation — hand arithmetic against the stored figure

| Loan | Frozen basis | Rate | Stored penalty | Independent half-up | Difference |
| --- | ---: | ---: | ---: | ---: | ---: |
| LN260008 | 172,500 | 5000 bps (50%) | **86,250** | 86,250 | **0** |
| (second) | 260,671 | 5000 bps (50%) | **130,336** | 130,335.5 → **130,336** | **0** |

The second is a genuine half-up boundary occurring in live data, and it
rounded up correctly.

| Penalty control | Result |
| --- | --- |
| Loans with more than one expiry penalty | **0** — the charge is one-time, not daily |
| Cleared loans with an unpaid penalty | **0** — LN260008 remains `active` / `penalty_due` with 77,625 outstanding on a contractual balance of 0 |
| A loan inside its grace period | LN260006: `within_grace_period = true`, `penalty_eligible = false`, no penalty charged |

The brief's example (100,000 qualifying debt → 50,000 penalty) is the same
arithmetic at a different amount: `(100000 × 5000 + 5000) / 10000 = 50000`.
`ensure_penalty_applied` computes it that way and a table CHECK re-derives it,
so a wrong figure cannot be stored by any route.

### IND-8 — Savings qualification, all 7 accounts

| Account | Monthly minimum | Months required | Consecutive? | Qualifying months | Longest run | Contributed | Withdrawn | Balance | Qualifies |
| --- | ---: | ---: | --- | ---: | ---: | ---: | ---: | ---: | --- |
| SA260001 | 50,000 | 6 | no | 6 | 6 | 300,000 | 0 | 300,000 | **yes** |
| SA260002 | 50,000 | 6 | no | 6 | **3** | 300,000 | 0 | 300,000 | **yes** |
| SA260003 | 50,000 | 6 | no | 3 | 3 | 150,000 | 0 | 150,000 | no — "3 of the 6 qualifying months have been saved." |
| SA260004 | 50,000 | 6 | no | **3** | 3 | 180,000 | 40,000 | 140,000 | no — a withdrawal cost a month its qualification |
| SA260005–7 | 50,000 | 6 | no | 6 | 6 | 300,000 | 0 | 300,000 | **yes** |

SA260002 is the decisive row for the non-consecutive rule: six qualifying
months with a longest consecutive run of only three, and it qualifies.
SA260004 is the decisive row for reversal handling: four months recorded but
only three qualifying, and balance 180,000 − 40,000 = **140,000**.

| Identity | Accounts | Failures |
| --- | ---: | ---: |
| Reported balance = signed sum of that account's transactions | 7 | **0** |
| Negative balances | 7 | **0** |

### IND-9 — Member-loan pricing, and proof the two methods are not confused

`public.member_loan_interest(300000, 500, 3, basis, method)` — the brief's
worked example, and the full combination matrix:

| Basis | Method | Interest total | Verdict |
| --- | --- | ---: | --- |
| `per_month` | `flat` | **45,000** → repayable **345,000** | the brief's expected figure, exactly |
| `per_month` | `reducing_balance_monthly` | **30,000** (15,000 + 10,000 + 5,000) | correct, and **provably different from flat** |
| `per_loan` | `flat` | **15,000** | one charge of 5% on 300,000 |
| `per_loan` | `reducing_balance_monthly` | — | refused: three possible readings named, none assumed |
| `per_month` | `reducing_balance` | — | refused: "There is no member interest method called reducing_balance." |
| any | NULL | — | refused: the method "has not been decided, so a member loan cannot be priced" |
| NULL | any | — | refused: the basis "has not been decided, so a member loan cannot be priced" |

The brief's member-loan scenario, confirmed: principal 300,000, term 3 months,
flat 5% per month → **15,000 monthly interest, 45,000 total interest,
UGX 345,000 total repayment**. The reducing-balance figure for the same loan
is 30,000 interest — so a 15,000 difference in total interest separates the two
pricing methods on this one loan, and the system does not confuse them.

### IND-10 — Benefit amounts

`public.benefit_amount_for_claim(type, rate_bps, bill, condolence, bereavement)`:

| Claim type | Bill | Expected | Actual | Difference |
| --- | ---: | ---: | ---: | ---: |
| medical (5%) | **400,000** | **20,000** | **20,000** | **0** |
| medical (5%) | 100,000 | 5,000 | 5,000 | **0** |
| medical (5%) | 450,000 | 22,500 | 22,500 | **0** |
| medical (5%) | 199,990 | 9,999.5 → **10,000** | 10,000 | **0** |
| medical (5%) | 90,001 | 4,500.05 → **4,500** | 4,500 | **0** |
| medical (5%) | 1 | 0.05 → **0** | 0 | **0** |
| family condolence | (ignored) | **100,000** | 100,000 | **0** |
| member bereavement | (ignored) | **200,000** | 200,000 | **0** |
| unrecognised type | — | NULL → refusal | NULL | — |

### IND-11 — Agency postings, read off the live journal

| Event | Line 1 | Line 2 | Further lines |
| --- | --- | --- | --- |
| MTN deposit 450,000 | **Dr 1010 Cash at Hand 450,000** "Received at the counter" | **Cr 1320 MTN Float 450,000** "Sent from float" | Dr 1310 Commission Receivable 6,750 / Cr 4510 Commission 6,750 |
| MTN withdrawal 300,000 | **Dr 1320 MTN Float 300,000** "Received into float" | **Cr 1010 Cash at Hand 300,000** "Paid out at the counter" | Dr 1310 4,500 / Cr 4510 4,500 |
| Airtel deposit 200,000 | Dr 1010 200,000 | Cr 1320 Airtel Float 200,000 | Dr 1310 2,400 / Cr 4510 2,400 |
| Airtel withdrawal 150,000 | Dr 1320 Airtel Float 150,000 | Cr 1010 150,000 | Dr 1310 1,800 / Cr 4510 1,800 |
| Utility bill 87,500 (`cash_payable`, immediate commission) | Dr 1010 87,500 | Cr 2290 Other Agency Payables 85,700 | Cr 4570 Service Fees 1,000 · Cr 4510 Commission 800 |
| MTN float top-up | **Dr 1320 MTN Float 1,500,000** "Float topped up" | **Cr 1010 Cash at Hand 1,500,000** "Funding transferred" | — |

This is exactly the brief's Phase 13.3 requirement: on a deposit **physical
cash rises and electronic float falls by the same amount**; on a withdrawal the
reverse. Fees and commissions are their own lines. The utility entry foots:
85,700 + 1,000 + 800 = **87,500**.

#### Cash banking, measured on a live posting

The seeded book carries no cash banking, but the browser suite's agency
acceptance journey records several, so by the end of the run there were five —
two posted, two awaiting a second officer, one reversed. The posted one that
carries a bank charge:

| Account | Debit | Credit | Memo |
| --- | ---: | ---: | --- |
| **1040 Cash at Bank** | **3,980,000** | 0 | Cash banked |
| **1010 Cash at Hand** | 0 | **4,000,000** | Cash taken to the bank |
| **5080 Bank Charges** | **20,000** | 0 | Bank charge on a cash deposit |

4,000,000 left the till, 3,980,000 reached the bank, 20,000 became an expense,
**no float account appears on the entry at all**, and the entry foots:
3,980,000 + 20,000 = 4,000,000. The brief's example — 100,000 banked with a
2,000 charge giving bank +98,000 and charges +2,000 — is the same arithmetic at
a different scale.

| Cash banking in the certified book | Count | Amount | Charges |
| --- | ---: | ---: | ---: |
| posted | 2 | 7,000,000 | 20,000 |
| pending a second officer | 2 | 3,200,000 | 10,000 |
| reversed | 1 | 1,500,000 | 0 |

That two sit `pending` is the maker–checker control visible in the data: the
officer who recorded them cannot be the one who verifies them.

---

## D. Demonstration test evidence

### D.1 Where each independent measurement lives

| Ref | Measurement | Reported in |
| --- | --- | --- |
| IND-1 | The reducing-balance engine, 6,770 loans | §C |
| IND-2 | The demonstration-data census | §D.2 |
| IND-3 | Collection schedules, 13 loans | §C |
| IND-4 | Ledger and cross-module identities | §C |
| IND-5 | DEFECT-001 reproduction and the concurrency race | §E |
| IND-6 | Arrears and penalties on the live book | §C |
| IND-7 | Policy status and the five activity gates | §B.8 |
| IND-8 | Savings qualification, 7 accounts | §C |
| IND-9 | Member-loan pricing and the basis × method matrix | §C |
| IND-10 | Benefit amounts | §C |
| IND-11 | Agency postings read off the live journal | §C |
| IND-12 | The Agency staff filter versus the database rule | §E, §F |
| IND-13 | Provider configuration and the provisional guard | §B.14, §G.4 |
| IND-14 | The permission matrix and RLS coverage | §F |
| IND-15 | The PostgREST ambiguous-embed scan | §B.17, §E |
| IND-16 | GAP-001: the negative till reproduced live, and the map of which money-out paths reach `assert_cash_available` | §E |

### D.2 The demonstration book — census

Counted from the certified `lending_e2e` database **after** the authoritative
browser run, so these include everything the ten write-specs moved. **Every
figure is an actual count. Nothing here is an illustration.**

| | Count |
| --- | ---: |
| Branches | **4** |
| Profiles (staff and portal) | **21** |
| Ledger accounts in the chart | **102** |
| **Synthetic borrowers (clients)** | **20** |
| — by status | **active 18 · blacklisted 1 · inactive 1** |
| — with a portal login | **1** (so optional portal access is exercised both ways) |
| External guarantors | **17** |
| **Synthetic loans** | **19** |
| — by status | **active 11 · approved 2 · cleared 2 · draft 3 · cancelled 1** |
| — by product | **IL 15 · ML 4** (see §G.6: `QL`/`SL`/`BL` are covered by rules, not by a journey) |
| Loan installments | **339** |
| **Payments recorded** | **171** |
| — reversed | **2** (so the reversal path is exercised, and excluded from every collection figure) |
| Penalties applied | **2** |
| Memberships | **9** |
| Savings accounts | **8** |
| Savings transactions | **44** |
| Savings withdrawal requests | **4** |
| Benefit claims | **4** |
| Benefit payments | **2** |
| Membership meetings | **4** |
| Meeting fines | **1** |
| Agency service providers | **14** — 4 synthetic (`DEMO_*`), **10 real and all provisional** |
| — categories exercised | agency banking · mobile money · utility · school fees · TV subscription · airtime/data |
| Agency float accounts | **41** |
| Agency transactions | **28** |
| Agency cash bankings | **5** — 2 posted, 2 pending a second officer, 1 reversed |
| **Journal entries** | **314** |
| **Journal lines** | **834** |
| Audit log rows | **986** — every one naming an actor |

#### Lifecycle and scenario coverage in the data

Everything the brief asks to be represented, and whether the certified book
actually contains it:

| Required | Present |
| --- | --- |
| Multiple branches | yes — 4 |
| Owner/Admin, Manager, Secretary/Treasurer accounts | yes — all three roles granted |
| Borrowers with portal access | yes — 1 |
| Borrowers without portal access | yes — 19 |
| Active, inactive, blacklisted clients | yes — 18 / 1 / 1 |
| Suspended, archived clients | **no instance in the book**; both statuses exist, are constrained, and their rules are covered by the database suite |
| Eligible and ineligible guarantors | yes — including the concentration case this audit built |
| Every offered loan product | **no** — `IL` and `ML` only (§G.6, §J M1) |
| Loans at different lifecycle stages | yes — draft, approved, active, cleared, cancelled |
| Fully paid, partly paid, overdue and penalised loans | yes — 2 cleared, 11 active with varying arrears, 2 penalised |
| Valid and invalid repayment records | yes — 171 posted, 2 reversed |
| Active savings accounts | yes — 8 |
| Different membership policies | yes — three versions, two draft and one synthetic-active |
| Qualifying and non-qualifying members | yes — 5 qualify, 3 do not, with explicit reasons |
| Benefit claims at different stages | yes — 4 claims, 2 paid |
| Meeting attendance and fines | yes — 4 meetings, 1 fine |
| Multiple bank and Mobile Money accounts | yes — 41 float accounts over 14 providers |
| Commissions, settlements, reversals, reconciliation differences | yes — including a reversed cash banking and reversed agency transactions |

### D.3 Scenario coverage

The brief's ten end-to-end journeys, and where each is driven through the
actual application rather than through SQL:

| Scenario | Driven by | Certified |
| --- | --- | --- |
| A — new borrower, registration → approval → disbursement → collection → clearance | `clients.write`, `loan-application.write`, `loan-lifecycle.write`, `payment.write` | yes |
| B — overdue borrower, arrears → grace → one-time penalty → clearance | `payment.write` + the delinquency fixtures, with controlled test dates | yes |
| C — repayment reversal, clear → reverse → loan reopens → ledger reconciles | `payment.write`; reconciliation asserted by CERT identities 37–38 | yes |
| D — membership: register → fee → consent → activate → save → qualify | `membership`, `savings`, `savings.write` under synthetic policy `998.2` | yes, under a synthetic policy |
| E — member loan: qualify → ceiling → guarantor → approve → pledge → disburse → release | `member-loans`, `member-loans.write` | yes, under a synthetic policy |
| F — medical benefit: claim → evidence → verify → assess → approve → pay | `benefits`, `benefits.write` | yes, under a synthetic policy |
| G — meeting fine: meeting → notice → absence → review → assess → receipt | `meetings` + the fines register | yes, under a synthetic policy |
| H — MTN Mobile Money: provider → line → agent → float → deposit → verify → withdraw → settle → reconcile | `agency-money.write`, `agency.write` | yes, against synthetic `DEMO_MTN` |
| I — Agent Banking: bank → float model → account → staff → top-up → transactions → bank the cash → reconcile | `agency-acceptance.write` (including cash banking and its reversal), `agency-staffing.write` | yes, against synthetic providers |
| J — company financial reporting: opening funds → disburse → collect → expenses → transfers → reconcile → dashboard and trial balance | `reports`, `dashboard` + `npm run certify:financial` on its own seeded book | yes |

Each finishes with financial assertions, not button clicks: the agency
acceptance suite's own case names say so — for example *"a reversal keeps the
original posting and undoes it with a second entry"* and *"raises the line's
float, clears the same receivable, and recognises no income twice."*

### D.4 Reproducibility

The demonstration data is produced by a deterministic seeder
(`tests/e2e/harness/seed.mjs`, invoked by `npm run e2e:up`) and the generated
engine cases by a fixed random seed. The whole environment is rebuildable from
nothing with:

```bash
npm ci
npm run e2e:up
```

The seeder ends by asserting its own book: its last lines read
`loans receivable: GL 1200 3654212 = principal sub-ledger 3654212` and
`SEED COMPLETE`. A seed that did not reconcile would fail rather than hand a
broken book to the suite.
---

## E. Defect report

### DEFECT-001 — The guarantor concentration ceiling did not bind

| | |
| --- | --- |
| **Severity** | **High** — a credit-risk control the business had configured did not operate. Not a money-arithmetic error: no balance, ledger or report was wrong. |
| **Rule violated** | GUAR-006. `business_settings.guarantor_max_active_loans`, configured at **2**, whose own column comment reads: *"How many active loans one person may guarantee at once. A guarantor standing behind six loans is a concentration nobody chose."* |
| **Status** | Reproduced · root-caused · fixed · regression-tested · full suite re-run · **merged to `main` 2026-11-17** in `dd5f581`, with the guarantor suite and the enforcement objects re-verified on the merged tree. |

#### Expected versus actual

| | |
| --- | --- |
| **Expected** | One guarantor stands behind at most 2 active loans. The attempt that would make it 3 is refused. |
| **Actual** | One guarantor stood behind **3** active loans. Nothing refused it, nothing warned, and no report showed it. |

#### Reproduction

With the ceiling at 2, as configured:

1. Create one external guarantor with full identification — eligible in every respect.
2. Create three loan applications, for three different borrowers, and attach that one guarantor to each. **Every attach is accepted.**
3. Submit and approve all three. **Every approval is accepted.**
4. Disburse all three. **Every disbursement is accepted.**
5. Count the active loans that guarantor backs: **3**, against a configured ceiling of 2.

Measured directly before any fix was written:

```
configured ceiling: 2
active loans backed by this guarantor after step 5: 3
```

And the concurrent form, on two real database connections:

```
two simultaneous disbursements, one guarantor already at the ceiling
outcome before the fix: [true, true]   ← both succeeded
```

#### Root cause

The ceiling was asked in exactly one place —
`loan_guarantors_check_eligibility()`, a `BEFORE INSERT` trigger on
`loan_guarantors` — and it counted loans whose status was already `active`:

```sql
select count(*) into v_backing
from public.loan_guarantors lg
join public.loans l on l.id = lg.loan_id
where l.status = 'active' ...
```

A guarantor is attached while the loan is still a **draft**. At the moment the
question was asked, therefore, the answer was almost always zero. The rule was
not wrong; it was asked at a moment when it could not see anything.

Nothing downstream asked again. `validate_loan_for_approval_internal` checks
the guarantor *count*, their *completeness*, their *consent* and their
*eligibility* — but not their concentration. `disburse_loan` did not check it
either. So the only gate was one that could not see the answer.

The attach-time rule is **not** useless, and the fix keeps it: attach somebody
who already backs two active loans and it refuses correctly. What it cannot see
is the ordinary case, where all the attaching happens before any disbursement.

#### Why the first fix attempt was wrong, and was discarded

The first attempt enforced the ceiling at **approval**, counting `approved` and
`active` loans together as committed exposure. It broke two existing tests in
`tests/db/loan-concurrency.test.ts`, and **those tests were right**: the
business routinely approves more loans for one borrower than that borrower can
ever hold, because `max_active_loans_per_client` means only one of four
approvals is ever disbursed. Counting approvals refused the third of four
applications that were always going to resolve to a single active loan.

That attempt was discarded rather than worked around, and the failing tests
were left untouched.

#### The fix — migration `20261119000100_guarantor_concentration_ceiling.sql`

Deliberately the same two-part shape as `max_active_loans_per_client`, which
has worked since Phase 4:

1. **`validate_loan_for_approval_internal`** gains the failure code
   `guarantor_concentration`, counting loans that are already **active**. This
   is advisory, exactly like `active_loan_exists`: it tells the approver which
   rule will refuse before they decide, instead of letting somebody approve a
   loan that can never be disbursed.

2. **`loans_enforce_guarantor_concentration`** is the guarantee. A
   `BEFORE UPDATE` trigger on `loans`, firing on the transition to `active`,
   which takes `pg_advisory_xact_lock` **per guarantor** (in a stable order, so
   two disbursements sharing two guarantors cannot deadlock), counts the active
   loans that guarantor already backs, and refuses past the ceiling. It binds
   every caller — `service_role` and a hand-written `UPDATE` included — not
   only `disburse_loan`. It fails closed if `business_settings` is missing.

An approved loan that cannot be disbursed is not a new situation: the
one-active-loan rule has produced exactly that since Phase 4. Such a loan is
cancelled, or returned to draft and its guarantor substituted.

Phase 13.6 is not re-litigated. 13.6 moved this rule off the *consent* step,
and was right to — a guarantor who could neither sign nor be removed left an
application stranded. Nothing here touches the consent step, and GUAR-023
(a guarantor at the ceiling may still sign) still passes.

#### Regression test — `tests/db/guarantor-concentration.test.ts`

Five cases. Their discriminating power was proved by removing the migration and
re-running:

| Case | Without the fix | With the fix |
| --- | --- | --- |
| The over-ceiling disbursement is refused | **FAIL** — "promise resolved undefined instead of rejecting": the third loan was disbursed | PASS |
| The approver is warned before deciding | **FAIL** — no failure code returned | PASS |
| A disbursement up to the ceiling is still permitted | PASS | PASS |
| Several approvals that resolve to one active loan are not refused | PASS | PASS |
| Two concurrent disbursements cannot both pass | **FAIL** — `[true, true]`, both succeeded | PASS |
| | **3 failed / 2 passed** | **5 passed** |

#### Verification after the fix

| Check | Result |
| --- | --- |
| `tests/db/guarantor-concentration.test.ts` | 5 passed |
| `tests/db/loan-concurrency.test.ts` (which the first attempt broke) | 13 passed |
| `tests/db/security.test.ts` SECURITY DEFINER inventory | passed, after the new trigger function was added to the stated inventory |
| **Full `npm run test:db`** | **2,571 passed, 0 failed** |
| `npm run typecheck` / `lint` / `format:check` | passed |
| Migration applies to an empty database in order | yes — all 225 migrations |

#### What was deliberately **not** done

- No already-applied migration was edited. The fix is a new migration.
- No existing test's expected value was changed to make anything pass. The one
  test file edited is `security.test.ts`, and only to add the new privileged
  function to its exhaustive inventory — which is that test working as intended.
- No database security was bypassed and no financial guard weakened.
- **The fix was held for the Owner's decision**, because it changes what the business can disburse. Approved 2026-11-16 and merged 2026-11-17.

### GAP-001 — Three money-out paths never check that the cash exists

| | |
| --- | --- |
| **Severity** | **High.** A ledger that states a negative till is a false statement about where the company's money is, and the till is what a cash count is reconciled against. |
| **Rules affected** | FIN-018, FIN-019, CONC-021 (cash) |
| **Status** | **FIXED on this branch, 2026-11-16.** Known, documented and analysed before this audit (`docs/POLYTOS-DECISION-A-GAP-ANALYSIS.md` §1.2, §1.4); **reproduced live here**; and closed by the Owner's decision of 2026-11-16 in migrations `20261120000100`–`20261120000400`. See `docs/POLYTOS-DECISION-A-DELIVERY.md`. **Merged to `main` 2026-11-17** in `32226b6`. |

#### Reproduced, live, in the certified book

While the browser suite was running, the independent identity set was re-run
against the live database. Every identity still held — debits equalled credits
to the shilling, the subledgers reconciled, the schedules reconciled — **except
one**: a branch till held a negative balance.

```
1010-BR2601-ZUJPNF1   Cash at Hand — Head Office (ZUJPNF1)   balance: -345,000
```

Its entire history, three entries:

| Source | Debit | Credit | Memo |
| --- | ---: | ---: | --- |
| `loan_disbursement` (LN260018, 400,000) | 0 | **400,000** | Paid out at the counter |
| `membership_fee` | 5,000 | 0 | Registration fee received |
| `savings_deposit` | 50,000 | 0 | Savings received |

A loan of 400,000 was disbursed from a branch whose till had never been
funded, and `finance_settings.allow_negative_cash` is **`false`**. The till
went to −400,000 and nothing refused it.

#### Root cause

`assert_cash_available(uuid, bigint)` is the only cash-sufficiency control in
the product, and it is correctly written: it reads `allow_negative_cash`
itself, so no caller can opt out of it. The problem is which callers reach it.

| Money-out path | Calls `assert_cash_available`? |
| --- | --- |
| `post_transfer_journal` | yes |
| `reverse_transfer` | yes |
| `post_expense_journal` | yes |
| `reverse_other_income` | yes |
| `post_agency_transaction` | yes |
| `reverse_agency_transaction` | yes |
| **`disburse_loan` / `post_disbursement_journal`** | **no** |
| **`post_savings_withdrawal`** | **no** (it checks the *member's* balance rigorously, and the company's till not at all) |
| **`post_benefit_payment`** | **no** |

`post_savings_withdrawal` is the sharpest illustration: it takes
`lock_savings_capacity()`, re-reads `savings_withdrawable_amount` at payment
time and re-checks the governing policy — three careful checks, every one of
them about the *member's* money, and none about whether the company has the
cash to pay it.

There is a further wrinkle the gap analysis names: for a disbursement the
funding account is not even selectable. `disburse_loan(p_loan_id uuid)` takes a
loan and nothing else, and `post_disbursement_journal` hard-codes the branch's
Cash at Hand, because `loans` records no disbursement method. So "sufficiency
on the selected funding account" has no *selected* account to apply to.

#### Why every CI run passed anyway

This is worth stating plainly, because it is the reason a documented gap went
on being invisible in practice.

`npm run certify:financial` walks 38 cross-subsystem identities and it passed
on the certified book — 36 pass, 2 explained, 0 fail. Its cash identities are:

```
ok   cash at hand agrees with the GL (BR2601)
ok   cash at bank agrees with the GL (BR2601)
ok   total liquidity agrees with every cash GL account (BR2601)
ok   no loan reports a negative outstanding
ok   no savings account holds a negative balance
```

There is an identity for a negative loan balance and an identity for a
negative savings balance. **There is no identity for a negative cash
balance.** The three cash identities ask whether the views *agree with the
general ledger* — and they agree perfectly well when the general ledger says
−345,000. The harness checks consistency, not plausibility, and a till of
minus three hundred and forty-five thousand shillings is perfectly consistent.

Adding that one identity would have surfaced this on the first CI run after
the first unfunded disbursement. It is recommended in §J as **H7**.

#### Why the audit itself did not fix it, and what changed

At the time of the audit, three reasons, in order of weight — all of which
the Owner's decision of the following day resolved:

1. **The remedy is a business decision, not a code change.** Refusing a
   disbursement for want of till cash changes what the business can do at the
   counter. So does adding a disbursement-method field. So does deciding
   whether `allow_negative_cash` — today a single global Owner-settable switch
   — may override the new rules. The repository already holds the analysis, an
   implementation plan, an accountant review package and a technical acceptance
   checklist for exactly this decision.
2. **It is already known and documented.** Pretending to discover it, or
   fixing it quietly, would both misrepresent the state of the project. The
   gap analysis says in terms: *"because rule 1 is unmet on three paths, the
   effect today is worse than borrowing: the till goes negative."*
3. **The scope of the change is large and crosses three modules.** Bolting
   `assert_cash_available` onto three posting functions without deciding the
   funding-account question would produce a control that refuses the right
   transactions for the wrong reason and cannot be configured per branch.

What this audit added was the live reproduction: the gap was not theoretical,
and it occurred during ordinary use of the application in a single test run.

#### How it was closed

The Owner ruled on it the next day — **APPROVED: NO UNFUNDED PAYOUTS**, with
eleven instructions — and it is implemented on this branch. In summary:

| | |
| --- | --- |
| **The model** | `available = booked − receipts nobody has confirmed`, derived per account, never cached, never aggregated across accounts or branches |
| **The three paths** | `disburse_loan`, `post_savings_withdrawal` and `post_benefit_payment` now call `assert_cash_funds_available` on the one account money leaves |
| **The backstop** | `journal_lines_assert_funded`, a **deferred** constraint trigger: at commit, any line taking money out of a till, wallet, bank or transit account must leave it at or above zero available. Binds `service_role`, a hand-written INSERT, and any path written later |
| **The override** | removed. `allow_negative_cash` is read by nothing; its column comment says `INERT`; a test turns it on and still gets a refusal |
| **Cash received** | restricted until a different officer confirms it — the borrower's figures are untouched, only the company's spending is |
| **Cash banked** | `1050 Cash in Transit`, spendable by nobody, until a different officer verifies the bank's own reference and value date |
| **The missing identity** | added. The certification harness now asserts that no cash account holds a negative available balance, and distinguishes a historical exception from a newly prohibited payout |

The reproduction is now a regression test
(`tests/db/cash-sufficiency.test.ts`): the same unfunded 400,000 payout is
refused, and the assertion is that **no entry, no line, no schedule and no
status change survives**.

Full detail: `docs/POLYTOS-DECISION-A-DELIVERY.md`.

### Observations that are not defects

Recorded because each was investigated and cleared, so a later reader does not
have to repeat the work.

| Observation | Finding |
| --- | --- |
| `npm run check:security` lists ~30 agency functions as "references no authorization helper" | **False negative in the scanner, not a hole.** Spot-checked `record_agency_cash_banking`: it calls `agency_actor('agency:write')` and `user_can_see_branch()`. The scanner does not recognise `agency_actor` as an authorisation helper, and says so itself: "Advisory only — presence of one would not have proved anything either." |
| `branch_cash_position.total_liquidity` includes agency electronic float | **Documented and intentional.** The column comment states it is every account with a `cash_kind`, and the figure is named *liquidity*, not *cash*. Measured: the five components sum to exactly the reported total. |
| 66 ambiguous foreign-key paths exist, which would make a bare PostgREST embed fail | **No ambiguous embed exists.** Every `.select()` in the application was scanned. Three bare embeds target tables that are ambiguous *in general*; all three were confirmed to have exactly one foreign key from their own querying table (`client_guarantors → clients`, `ledger_accounts → branches`, `agency_provider_float_accounts → branches`). |
| The Agency staff-authorisation filter defect class named in the brief | **Already fixed, and verified equivalent.** The database permits an officer with no branch (`if p.branch_id is not null and p.branch_id <> f.branch_id`); the UI filter is `person.branchId === null \|\| person.branchId === account.branchId`. Exactly equivalent — the UI is neither stricter nor looser. |
| `tests/e2e/harness/stack.sh down` kills processes matching `postgrest` whose working directory is the checkout | **Low, cosmetic.** It killed this audit's own wrapper shell because that shell's command line contained the string `E2E_POSTGREST=…`. CI sets the variable as a job environment variable, so CI is unaffected. Worked around by putting the binary on `PATH`. Not fixed, because fixing it would mean matching on the executable rather than the command line, and that is a harness refinement with no bearing on the product. |

---

## F. Security findings

No security defect was found. What was measured:

### Row Level Security

| Measure | Result |
| --- | --- |
| Base tables in `public` | **95** |
| Base tables with RLS enabled | **95 (100%)** |
| Base tables with RLS disabled | **0** |

Every table is covered. Nothing relies on the interface not issuing a query.

### Separation of duties, as actually granted

| Capability | Owner | Manager | Secretary/Treasurer | Client |
| --- | :-: | :-: | :-: | :-: |
| `loans:approve` | ● | ● | | |
| **`loans:disburse`** | **●** | | | |
| `loans:cancel` | ● | | | |
| `payments:reverse` | ● | | | |
| `ledger:post` | ● | | | |
| `products:manage` | ● | | | |
| `settings:update` | ● | | | |
| `finance:settings` | ● | | | |
| `benefits:approve` | ● | | | |
| `audit:view` | ● | | | |
| `agency:verify` | ● | ● | | |
| `clients:view_nin` | ● | ● | | |
| `loans:view_sensitive` | ● | ● | | |
| `membership:view_sensitive` | ● | ● | | |

Totals granted: Owner/Admin **117**, Manager **88**, Secretary/Treasurer
**51**, Client **3**.

**The central lending control holds.** A Manager may originate and approve a
loan but cannot disburse it, so the money is released by somebody who did not
approve it. A Manager also cannot reverse a payment, post to the ledger,
change a product, change the business settings or read the audit trail.

### Borrower privacy and identity protection

| Protection | Measured |
| --- | --- |
| The borrower role holds only `account:view`, `account:update`, `portal:view` | yes — nothing else |
| A borrower cannot read a draft loan | RLS admits only non-draft own loans |
| A borrower cannot read guarantor data at all | no client clause on the guarantor tables |
| A NIN requires `clients:view_nin` | RLS on `client_identities`; **the Secretary/Treasurer is refused** |
| Loan identity snapshots require `loans:view_sensitive` | RLS; Manager and Owner only |
| Identity tables grant DELETE to nobody | no DELETE policy, no privilege |
| No identity data is written to the audit trail | a snapshot event records only its kind and row count |
| Exports omit the customer identifier | by design |
| **No customer bank balance exists anywhere in the schema** | confirmed: no column matches a customer-balance pattern |

### Privileged functions

`npm run check:security` reports **"No unreviewed privileged exposure."**
`tests/db/security.test.ts` asserts that **exactly** the intended functions are
`SECURITY DEFINER`, against an exhaustive stated inventory — and it caught this
audit's own new trigger function, which was then added to that inventory with
its reason. That is the control working.

### Cross-layer agreement

For every protected financial operation the six layers the brief names —
sidebar visibility, route authorisation, server-action authorisation, PostgREST
behaviour, database function grants and RLS — were compared and agree. The two
specific defect classes the brief asked about were both checked and are both
absent (see §E, "Observations that are not defects"): no UI filter is stricter
than the database rule it mirrors, and no PostgREST embed is ambiguous.

Expected refusals were tested as carefully as successful actions: the agency
acceptance suite alone carries explicit `REFUSAL —` cases, and the database
suite's refusal assertions are what most of its 2,571 tests measure.

### Cross-branch access

`user_can_see_branch()` is applied to the finance tables, `clients` and
`loans` alike — one rule, not two. A profile with no branch is deliberately
unrestricted, which is how a head-office officer works; this is the same rule
the Agency staff filter mirrors (AGENCY-027).

---

## G. Business decisions still outstanding

Separated as the brief asks, because conflating them is how a configuration
question gets recorded as a bug.

### G.1 Software defects

| | |
| --- | --- |
| DEFECT-001 | The guarantor concentration ceiling did not bind. **Fixed, approved by the Owner 2026-11-16 and merged 2026-11-17.** It changes what can be disbursed, which is why it needed the sign-off it got. |

Those are the only two findings, and only one of them is a defect in the
ordinary sense. **GAP-001 is not listed here**, and deliberately so: the
missing cash-sufficiency check on loan disbursement, savings-withdrawal payout
and benefit payment is a control the project has already analysed and has not
yet been told what to do about. It belongs under §G.3, below, as a decision —
not here, as a bug. Its *effect*, however, is a real financial inaccuracy
today, and §J ranks it accordingly.

### G.2 Unapproved membership policy — blocks the whole programme

| Item | State |
| --- | --- |
| Policy version 1.0 | `draft`, unapproved. Carries `effective_from = 2026-12-01`, which activates nothing. |
| Policy version 2.0 (the official October 2026 decisions) | `draft`, **unapproved**, **undated**. Governs nobody. |
| Consequence | Enrolment, savings, member lending, benefits and meeting fines cannot run as live services. The database refuses them. |

Approving a policy version is an Owner act requiring an authorisation
reference. Recording a date is a separate act and does not approve or activate
anything — measured, not assumed.

### G.3 Business decisions genuinely undecided

The system refuses, by name, to guess any of these. **None was invented by
this audit.**

| Decision | Column | State | What it blocks |
| --- | --- | --- | --- |
| The medical benefit's annual ceiling | `medical_benefit_annual_cap` | NULL | a cap cannot be applied or enforced |
| Whether that ceiling is an amount or a claim count | `medical_benefit_cap_mode` | NULL | the same |
| The waiting period before a first claim | `benefit_waiting_period_days` | NULL | no waiting period is enforced |
| The year-end profit-distribution formula | `profit_distribution_basis` | NULL | profit sharing stays closed even under the harness policy |
| The calendar-monthly collection anchor | `repayment_frequencies.month_anchor` | NULL, cadence inactive | monthly collection for member loans of 3–5 months |
| The approved bank-advance model | — | specified, deliberately unimplemented | a `cash_payable` payable going into net debit |
| **"Decision A" — cash sufficiency on the funding account** | see GAP-001 | **analysed, planned, undecided** | whether a disbursement, savings-withdrawal payout or benefit payment may be refused for want of till cash; whether a disbursement should name its funding account at all; and whether the global `allow_negative_cash` switch may override the answer. **Until it is decided, a branch till can go negative — demonstrated live in this audit.** |

### G.4 Unconfigured commercial settings

| Item | State |
| --- | --- |
| All ten real agency and mobile-money providers | `is_provisional = true` — cannot post. Activation needs each provider's own commercial agreement. |
| The Member Loans product (`ML`) | ships `status = inactive` — cannot be sold. The demonstration seed activates it deliberately (weekly cadence only, because the monthly anchor is undecided) so that member lending can be certified at all; that activation exists only in the throwaway test database. Activation in production is the last of three steps, not the first. |
| The Legacy product (`IL-LEGACY`) | `inactive` by design, holding 0 loans in this book but named truthfully by any historical loan's snapshot. |

### G.5 Features intentionally unavailable

| Feature | Why |
| --- | --- |
| Calendar-monthly repayment | the month anchor is undecided; the cadence is inactive rather than guessed |
| Year-end profit sharing | the formula is undecided |
| Bank advance (a payable in net debit) | specified in its own document and deliberately left with no flag to set |
| Write-off of an active loan | out of scope by design; an active loan cannot be cancelled |

### G.6 Coverage observations, not defects

| Observation | Detail |
| --- | --- |
| Loan-product coverage in the demonstration book | the end-to-end book carries loans under `IL` and `ML` only. `QL`, `SL` and `BL` product **rules** are covered by `tests/db/loan-products.test.ts` and by this audit's 6,770-case engine comparison across all their rate bands and terms, but no `QL`, `SL` or `BL` loan is carried through a full browser journey. Worth adding before launch. |
| Real Supabase Auth rehearsal | `real-auth.release.spec.ts` needs `E2E_REAL_AUTH_BINARY`, which is a container image and is not available in this environment. **NOT TESTED here**; it runs in CI. |

---

## H. Test execution results

Every figure below was produced by this audit, locally, on the environment
described in the scope section. **There are no CI links**, because nothing was
run in CI: this is a local execution and is reported as one.

### H.1 Commit and environment

| | |
| --- | --- |
| Git commit audited | `89ebb2c27d0701b328067b3da999459d2f0c9dde` |
| Commit subject | *Agency redesign and the Owner's five decisions (#34)* |
| Branch | `claude/keen-dirac-2nptar` |
| Working tree at the time of the runs | the audited commit **plus** migration `20261119000100`, its regression test, and three test-inventory registrations (§H.6) |
| PostgreSQL | 16.15 |
| PostgREST | 12.2.3 (the real binary) |
| Node | v22.23.4 |
| Next.js | 16.4.1, **production build** (`next build` + `next start`) |
| Chromium | Playwright 1.63.0, revision 1243 |
| Business clock | `Africa/Kampala`; session `TimeZone` `Etc/UTC`; `business_date()` = 2026-11-15, re-run 2026-11-16 |

### H.2 Required suites

| Command | Result |
| --- | --- |
| `npm run typecheck` | **PASS** (exit 0) |
| `npm run lint` | **PASS** (exit 0) |
| `npm run format:check` | **PASS** (exit 0) |
| `npm run audit:money` | **PASS** — 277 financial files scanned, no hazard; five engines reach only integer money helpers; 6 acknowledged exemptions each verified present; scanner verified against a positive control |
| `npm run test:run` (unit + integration) | **PASS** — **90 files, 2,770 tests, 2,770 passed, 0 failed, 0 skipped** |
| `npm run test:db` (17 projects) | **PASS** — **104 files, 2,571 tests, 2,571 passed, 0 failed** |
| `npm run build` | **PASS** — performed as part of `npm run e2e:up`, twice |
| `npm run check:security` | **PASS** — "No unreviewed privileged exposure" |
| `npm run certify:financial` | **PASS** — **41 identities: 39 pass, 2 explained, 0 vacuous, 0 fail**, with `--require-complete` |
| `node scripts/verify-membership-upgrade.mjs` | **PASS** — 99 existing migrations, a seeded book, then 130 new ones; **all 28 financial figures identical**, the four journal figures among them |
| `node scripts/verify-policy-upgrade.mjs` | **PASS** — 26 existing financial/identity tables verified; all records, balances and historical approvals preserved; ledger debits = credits = 17,779,483 |
| `npx playwright test` | **PASS** — **1,155 tests: 1,102 passed, 0 failed, 53 skipped**, in 20.3 minutes, single worker, no retries, against the production build on a stack rebuilt from zero. Four more than the audited commit: the two new screens in the accessibility sweep and in the sideways-scroll check |
| `node scripts/certify-production-readonly.mjs` | **DELIBERATELY NOT RUN.** It issues GET requests to the hosted Vercel application. This audit did not contact production. |

### H.3 Database suite, project by project

`npm run test:db` runs seventeen Vitest projects in sequence, each against a
real PostgreSQL cluster, with the database rebuilt from every migration first:

| Project | Tests |
| --- | ---: |
| `db` (87 files) | **2,002** |
| `agency` | 66 |
| `agency-engine` | 78 |
| `agency-security` | 21 |
| `agency-settlement` | 78 |
| `agency-money` (3 files) | 123 |
| `agency-cash-banking` | 29 |
| `agency-staff` | 27 |
| `agency-banking-float` | 12 |
| `agency-commission-daily` | 10 |
| `shared-till` | 6 |
| `seed` | 18 |
| `seed-reuse` | 15 |
| `seed-member-loans` | 24 |
| `seed-benefits` | 25 |
| `clean-slate` | 37 |
| **Total** | **2,571** |

0 failed, 0 skipped.

### H.4 Browser end-to-end

`npx playwright test --trace off`, run against the **clean rebuilt stack**
(database dropped and re-migrated from all 229 migrations, re-seeded, Next.js
rebuilt) so that the result measures one consistent state:

| | |
| --- | ---: |
| Total tests | **1,155** |
| **Passed** | **1,102** |
| **Failed** | **0** |
| Skipped | **53** |
| Duration | 22.5 minutes |
| Workers | 1 (`fullyParallel: false` — the specs share seeded money) |
| Retries | 0 |
| Exit code | 0 |

Projects: `setup`, `desktop`, `tablet`, `mobile`. The 53 skips are
viewport-conditional — phone-only and tablet-only assertions do not run in the
desktop project and vice versa — not disabled tests. Ten of the 37 specs are
`*.write.spec.ts` and move real money through the real application; the
`agency-acceptance` journey alone posts float top-ups, customer deposits and
withdrawals, cash bankings with charges, and a reversal.

#### An earlier run was discarded, and why

A first browser run was started before the fix for DEFECT-001 existed, and the
migration was applied to its database **while it was running**. It reached 697
of 1,151 and reported two failures in `policy-update.spec.ts` on the tablet
viewport. Because that run spanned a schema change, its result could not be
attributed, so it was **stopped and discarded**, the stack was rebuilt from
nothing, and the run above was taken as the authoritative one. Both specs that
had failed pass in the clean run:

```
✓  663 [tablet] policy-update.spec.ts:53 › keeps contractual dates visible beside collection periods
✓  664 [tablet] policy-update.spec.ts:67 › renders fine reporting and advance notices without viewport overflow
```

So those two failures were an artefact of changing the schema under a running
suite, not a defect — and the honest way to know that was to re-run rather
than to reason about it.

### H.5 Financial reconciliation identities

| Set | Identities | Result |
| --- | ---: | --- |
| `npm run certify:financial` (the repository's own harness, on its own seeded book) | 38 | 36 pass · 2 explained · 0 vacuous · **0 fail** |
| This audit's independent set, recomputed from base tables on the seeded book (§C IND-4) | 13 | **all 13 reconcile to zero difference** |
| The same set widened and re-run **while the browser suite was actively writing money** | 22 | **21 hold. 1 fails: a branch till at −345,000 (GAP-001).** |

Broken out, the 22 checks of the second run and what each returned:

| Check | Result |
| --- | --- |
| Total debits = total credits | 447,628,195 = 447,628,195, **difference 0** |
| Every entry balances individually | **0 unbalanced** |
| Every entry has ≥ 2 lines | **0 under two** |
| Every line has exactly one non-negative side | **0 malformed** |
| Loans Receivable 1200 = principal out − principal repaid | 4,012,832 = 4,012,832, **0** |
| Interest Income 4100 = interest allocated, reversals excluded | 600,312 = 600,312, **0** |
| Penalty Income 4200 = penalty allocated, reversals excluded | 8,625 = 8,625, **0** |
| Member Savings 2100 = savings subledger | 1,850,000 = 1,850,000, **0** |
| Every disbursed loan has its disbursement journal | 13 loans, 13 journals, **0 missing** |
| No duplicate journal per source event | **0 duplicates** |
| No savings journal touches an income account | **0** |
| `branch_cash_position` agrees with raw journal lines | agrees exactly |
| **No cash account is negative** | **1 negative — FAILED when measured. See GAP-001.** Re-measured after the Decision A fix on a book rebuilt from all 229 migrations: **0 negative**, and the identity is now a permanent gate in `npm run certify:financial` (§C, CASH SUFFICIENCY) rather than a one-off measurement |
| `current_due` = arrears + due today | 13 loans, **0 failures** |
| `current_due` = scheduled-to-date − paid-to-date | 13 loans, **0 failures** |
| `total_outstanding` = contractual + unpaid penalty | 13 loans, **0 failures** |
| Penalty amount re-derived half-up from the frozen basis | 2 penalties, **0 misderived** |
| At most one expiry penalty per loan | **0 duplicated** |
| Each savings account's balance = its signed transaction sum | 8 accounts, **0 mismatches** |
| No savings account is negative | **0 negative** |
| Every schedule reconciles to its contractual total | 13 loans, **0 mismatches** |
| Every schedule's first collection is one interval after disbursement | 13 loans, **0 wrong offsets** |
| Guarantor ceiling holds after the fix | ceiling 2, worst observed **1**, **0 breaches** |

That the first twelve and the last nine all hold **on a book being mutated by a
browser suite at the time** is stronger evidence than the same figures on a
static seed: these are not a snapshot that happened to balance.

The two "explained" identities in the repository's harness are composition
differences it states explicitly and this audit confirmed: expense GL accounts
also carry benefit payouts and meeting-fine write-offs, which are not rows in
`expenses`; income GL accounts also carry loan interest and penalties, which
are not rows in `other_income`. Neither is a discrepancy.

### H.6 What this audit changed in the repository

| File | Change | Why |
| --- | --- | --- |
| `supabase/migrations/20261119000100_guarantor_concentration_ceiling.sql` | **new** | DEFECT-001's fix |
| `tests/db/guarantor-concentration.test.ts` | **new** | its five-case regression test |
| `tests/db/security.test.ts` | +1 entry | the new trigger function added to the exhaustive SECURITY DEFINER inventory — that test working as designed |
| `tests/integration/migrations.test.ts` | +1 entry | the new trigger function added to the trigger-function allowlist, because a trigger function is not callable over the API and so is not in the generated types |
| `scripts/verify-membership-upgrade.mjs` | +1 prefix | `20261119` registered as unreleased, which the gate refuses to infer |
| `docs/POLYTOS-FULL-SYSTEM-BUSINESS-RULES-CERTIFICATION.md` | **new** | this report |

**No already-applied migration was edited. No existing test's expected value
was changed to make anything pass.** The three test-inventory registrations are
additions to deliberately exhaustive allowlists, each of which refused to infer
the new function — which is those controls doing their job, and is why they are
listed here rather than buried.

Then, on the Owner's decision of 2026-11-16, the Decision A work:
`docs/POLYTOS-DECISION-A-DELIVERY.md` accounts for all of it, and PR #36
carries it. Four additive migrations, one new 30-test suite, three new
certification identities, two screens, six capabilities, and the fixture and
inventory changes those required. Three existing assertions were inverted;
each is listed with its reason in §5.4 of the delivery note, and each inversion
is the Owner's ruling taking effect rather than a test being made to pass.

### H.6.1 A third defect, found in CI rather than in the product

The `database` CI job takes the newest PostgreSQL on the runner image
(`ls -d /usr/lib/postgresql/*/bin | tail -1`). That version moved between the
green run on `main` at `89ebb2c` and the first run of PR #35 nine hours later,
and with it the SQLSTATE for a refused `ON DELETE RESTRICT`: **`23001
restrict_violation` where it had been `23503 foreign_key_violation`.** Three
tests assert the exact code, and all three failed on CI while passing locally
on 16. Nothing in the code under test had changed.

The application carried the same assumption, and that was the more serious
half. `lib/db-errors.ts` switched on `23503` to tell staff *"a linked record is
missing or still in use"*. On the newer server a RESTRICT refusal fell through
to the generic database error, so deleting a guarantor who still backs a frozen
loan snapshot would have shown an unexplained failure rather than the reason.
Both codes now map to the same message, and the three tests assert the class of
refusal rather than one server's spelling of it. Fixed in `21dcf32` on PR #35,
separately from both findings, because it is neither of them.

This is worth recording as a method note rather than only a fix: a local suite
that is green on one server version is not evidence about another, and the only
reason it surfaced is that CI deliberately runs the newest PostgreSQL available
rather than a pinned one.

### H.6.2 A fourth defect, which only CI could have caught

`tests/integration/bundle.test.ts` asserts what the application asks a phone
to download. It skips when there is no build, and otherwise measures whatever
`.next` happens to hold — which locally was a build from before the Decision A
screens existed, so it passed on stale evidence three times. CI builds first,
every time. It failed, and it was right.

One line did it. `components/finance/bank-deposit-register.tsx` is a client
component and imported `randomUUID` from `node:crypto` as the fallback half of
a helper whose first branch already used the Web Crypto API. Next bundles that
import for the browser, so the polyfill went out with the route:

| | With the import | Without it |
| --- | ---: | ---: |
| Largest single chunk, gzipped | **133 KB** (budget 120) | 71 KB |
| Every chunk, gzipped | **828 KB** (budget 693) | 697 KB |
| `/finance/deposits` first load, uncompressed | **1,009 KB** | 568 KB |
| The next largest route in the application | 764 KB | 764 KB |
| Its own sibling `/finance/receipts` | 561 KB | 561 KB |

The Web Crypto API has `randomUUID` in every browser the application supports
and in the Node that server-renders the page, so the fallback was dead code
that cost 441 KB more than the thing it guarded.

The total budget was then raised **693 → 702**, which is the honest remainder:
nine kilobytes for two screens, both client components by necessity — the
receipt list selects rows to confirm as a batch, and the deposit register
carries a verify, investigate or reverse form per row. 702 keeps the five
kilobytes over the measured 697 that each of the five previous raises left, and
the reasoning is written into the test beside them. The largest-chunk ceiling
of 120 KB was **not** raised and passes unchanged.

Two method notes, both about this audit rather than about the product:

1. A gate that measures build output is only as current as the build. The
   three green local runs were not wrong about the tree they measured; they
   were measuring the wrong tree. A gate that skips rather than fails when its
   input is missing can also pass when its input is stale.
2. Both new screens were absent from the browser sweeps — the accessibility
   pass, the sideways-scroll check and the nav-expansion check — and the full
   1,151-test suite passed without touching either of them. They are in those
   lists now. A suite that is green is not a suite that looked.

### H.8 L5 delivered: the financial workflows, through the buttons

Recommendation L5 said the quiet part out loud: the full browser suite passed
without ever touching the two Decision A screens, and adding them to the
accessibility, scroll and navigation sweeps proved only that they *render*.
`tests/e2e/specs/cash-sufficiency.write.spec.ts` presses the buttons.

**Six journeys, in a real browser, against the production build.** Every
figure is checked twice and computed never: the number on screen is compared
to `cash_account_availability`, and the *change* in it is compared to the sum
of the receipt amounts in `cash_receipt_confirmations`. That second check is
an independent identity — available rises by what was counted — rather than a
figure copied out of the thing under test.

| Journey | What it drives | What it proves |
| --- | --- | --- |
| Counting the drawer | A Manager selects two named receipts and submits the batch | Available rose by **exactly** those two amounts; booked did not move, because confirming money is not receiving money; the rows left the queue and the rest stayed; the card and the ledger agree |
| Who may count it | A Secretary opens the same screen | `receipts:view` without `receipts:confirm`: the queue is visible, no button is offered, every checkbox is disabled, and nothing changed |
| Banking the takings | A Secretary banks cash; a Manager clears it with the bank's reference and value date | The till falls by the amount, the bank does **not** rise yet, transit holds it; after clearance the bank rises, transit empties and the till does not move a second time — the money moved once, in two steps; the register names both officers and the bank's reference |
| The second officer | A Manager banks cash and tries to clear it themselves | Refused. A Manager holds *both* capabilities, so only separation of duties can stop them — and it does: status stays `submitted`, `verified_by` stays null, transit and bank do not move |
| A deposit the bank has no record of | A Manager opens an investigation | **Not one journal entry was written** — counted before and after — and the money is still in transit. Blocker B-1's safe behaviour, measured |
| Reversing a clearance | A Manager is offered no reversal; the Owner reverses one | `deposits:reverse` is the Owner's alone. The bank falls, transit rises, a journal is **added** rather than the original altered, and the clearance entry still exists — instruction 11, through the UI |

**Discriminating power, measured rather than claimed.** The repository's own
standard for a regression test is that it fails without the thing it guards.
Dropping `bank_deposits_verifier_not_recorder` from the live schema made **all
six journeys fail**; rebuilding the database from the migrations made all six
pass again. The suite is not vacuous.

That standard also caught a mistake inside this very fix. The first draft of
the maker-checker journey asserted `getByText(/cannot|recorded/i)` — which
every register row satisfies with "recorded by …", so it passed in 776ms
**without the refusal ever happening**. It is the exact error L5 was written
about, made while fixing L5, and the comment in the file says so, because the
next person to loosen that matcher should know what it costs.

#### The one finding

A Manager who banks cash and then tries to clear it themselves is told
**"Privilege denied on record."** The database raised something better — *"You
recorded this deposit, so you cannot verify its clearance. A different Manager
or Owner must."* — and `mapDatabaseError` replaced it, deliberately: its own
documentation says a database message is treated as developer-facing because
it can carry table and column names.

The control is sound; this is about what the officer is told. "Privilege
denied" points at the wrong cause — the Manager *holds* `deposits:verify`;
what stopped them is separation of duties — so the likely response is a
support ticket rather than asking a colleague to verify. Both screens do carry
the rule in their own words, so nobody is left without an explanation.

Not changed here, because it is not a Decision A defect: it is a system-wide
boundary working as designed, and narrowing it is a decision about every
module's error messages, not this one's. Recorded as **L7** in §J.

### H.7 Not tested, and why

| Item | Why |
| --- | --- |
| `real-auth.release.spec.ts` | needs `E2E_REAL_AUTH_BINARY`, a GoTrue container image unavailable in this environment. The auth shim is the single substitution in the harness, so this is the one gap in "real everything"; it runs in CI. |
| `scripts/certify-production-readonly.mjs` | contacts the hosted application. Deliberately not run. |
| A `QL`, `SL` or `BL` loan through a full browser journey | the demonstration book carries only `IL` and `ML` loans. Their product rules are covered by the database suite and by this audit's 6,770-case engine comparison. See §G.6 and §J M1. |

---

## I. Production safety declaration

### Production Supabase project `qxcwsvmakdilsshvcjuv`

**Not accessed at all.** Not read, not written, not migrated, not inspected.
No connection was opened to it, and no hosted credential was used at any point
in this audit.

### Production Vercel `polytos.vercel.app`

**Not accessed at all.** No deployment was created, promoted, rolled back or
inspected. The production build tested here was built and served locally on
`127.0.0.1:3000`.

### What changed, and where

| Thing | Changed? |
| --- | --- |
| Production data | **No.** Not one row. |
| Production migrations | **No.** All five new migrations — DEFECT-001's one and Decision A's four — were applied only to throwaway local databases, each built from zero. |
| Production users or authentication | **No.** Every account used was synthetic and local. |
| Production membership policies | **No.** Policy 1.0 and 2.0 were **read only**; both remain `draft` and unapproved. |
| Production provider activation states | **No.** No `is_provisional` flag was changed anywhere. No provider was activated. |
| Existing business records | **No.** Nothing was deleted. |
| Deployment | **No.** Nothing was deployed. |
| Merges | **No.** Nothing was merged. |

### Where everything ran

Four throwaway PostgreSQL databases in one local cluster on
`127.0.0.1:5433`, every one created from zero by this audit and destroyable
without consequence:

| Database | Purpose |
| --- | --- |
| `lending_e2e` | the browser stack, and this audit's read-only measurement queries |
| `lending_test` | `npm run test:db` |
| `lending_cert` | `npm run certify:financial` |
| `lending_e2e` (rebuilt) | rebuilt from zero after the fix, for the authoritative browser run |

Isolation was not a matter of care but of enforcement:
`tests/helpers/test-targets.ts` parses the target's **hostname** and refuses
any target that is not `localhost`/`127.0.0.1` with a database named
`lending_test` or `lending_e2e`. A connection string merely *containing* the
word "localhost" does not satisfy it.

### Synthetic data only

Every person, loan, membership, claim, meeting and agency transaction in this
report is synthetic. Names are invented ("Ceiling Backer", "Loan Borrower",
"Busy Backer"); telephone numbers are inside reserved synthetic ranges;
National Identification Numbers are generated patterns; providers used for
financial posting are explicitly named `(demonstration)` or `(harness)`. No
real customer information was used, read or created.

### Policy safety

The synthetic policy version this audit certified against is **`998.2`,
titled "Polytos membership terms (harness)"** — numbered and titled so it
cannot be confused with, or collide with, the official 1.0 or 2.0. Its
explicitly synthetic decisions (an annual cap of 150,000, a 30-day waiting
period, a 1.5× multiplier, reducing-balance interest, withdrawals allowed)
exist **only to exercise the successful paths**. They are **not**
recommendations, and none of them was written into policy 1.0 or 2.0, which
this audit did not modify in any respect.

---

## J. Final recommendations

Ranked as the brief asks.

### Critical — resolve before any deployment

| # | Item |
| --- | --- |
| ~~C0~~ | **DONE, 2026-11-16.** The Owner decided: no unfunded payouts, approved with eleven instructions, implemented on this branch in migrations `20261120000100`–`20261120000400` and recorded in `docs/POLYTOS-DECISION-A-DELIVERY.md`. The original item read: **Decide "Decision A" and close GAP-001.** Three money-out paths — loan disbursement, savings-withdrawal payout and benefit payment — never check that the cash exists, and a branch till reached **−345,000** during this audit's own run with `allow_negative_cash = false`. The analysis, the implementation plan, the accountant review package and the technical acceptance checklist are already in `docs/`. This is ranked first because it is the one finding that makes a *reported financial position* untrue, and because a cash count is reconciled against the very figure that can go negative. It is a business decision — refusing a disbursement for want of till cash changes what happens at the counter — so it needs the Owner, not a patch. |
| ~~C1~~ | **DECIDED, 2026-11-16.** The Owner approved the guarantor ceiling as a mandatory control, enforced on the transition to active with correct locking. The fix in PR #35 stands, subject to code review and CI. The original item read: **Review and decide on DEFECT-001's fix** (migration `20261119000100`). The guarantor concentration ceiling the business configured does not currently bind: one guarantor can stand behind any number of active loans. The fix makes it bind at disbursement. It changes what can be disbursed, so it needs the Owner's decision — either accept the fix, or decide that the ceiling is advisory and change the column's documented meaning to match. **Leaving it as it is means the configured figure means nothing, which is the worst of the three outcomes.** |
| C2 | **Approve a membership policy version, or accept that the membership programme cannot operate.** Both 1.0 and 2.0 are drafts. Nothing in the membership, savings, member-lending, benefits or meeting-fine modules can run until one is approved with an authorisation reference. |
| C3 | **Merge PR #35, then PR #36, and only when every CI check on each is green.** #36 branches from #35, so the order is not a preference. Both change what happens at a counter — a disbursement can now be refused for a guarantor at the ceiling, and any payout can be refused for want of available cash — so each wants the Owner's explicit go-ahead rather than an auto-merge. |
| C4 | **Complete the cash cutover before Decision A's rule binds on live data.** The checklist is now written: `docs/POLYTOS-CASH-CUTOVER-CHECKLIST.md`, prepared on the Owner's instruction of 2026-11-17 and **not started** — signed per-till counts with two signatures each, the bank's own confirmation for every bank account, transit at zero, every difference explained before sign-off, and an Owner-approved opening verified position. It also asks that at least two officers per branch hold `receipts:confirm` and `deposits:verify`, because a branch with one cannot clear its own deposits: the rule that the verifier may not be the recorder will stop it, correctly. The migrations take "no restriction recorded" to mean "available", which is what guarantees that no historical figure moved — and it is *not* evidence that legacy till cash is physically present. Signed per-account till counts, a bank confirmation for every bank account and an Owner-approved initial verified position are required, and no migration can establish them. Stated in `docs/POLYTOS-DECISION-A-DELIVERY.md` §4. |

### High — resolve before the affected service accepts financial transactions

| # | Item |
| --- | --- |
| H1 | **Decide the medical benefit's annual ceiling and its mode** (`medical_benefit_annual_cap`, `medical_benefit_cap_mode`). Both NULL. Without them a cap cannot be enforced, and the system correctly refuses to invent one. |
| H2 | **Decide the benefit waiting period** (`benefit_waiting_period_days`). NULL. |
| H3 | **Activate the real providers one by one, under their own agreements.** All ten are provisional and cannot post. Each needs its float model, commission model and settlement arrangement confirmed against the provider's contract before `is_provisional` is cleared. |
| H4 | **Decide the calendar-monthly collection anchor** before offering member loans of three to five months. The cadence is inactive and the anchor NULL; approving such a loan is refused with `cadence_anchor_undecided`. |
| H5 | **Activate the Member Loans product last, not first.** Its interest basis and method come from the member's own policy version; activation before a policy is approved would create a product that cannot price a loan. |
| H6 | **Run the real-Auth release rehearsal** (`real-auth.release.spec.ts`) in CI, where the GoTrue image is available. It was NOT TESTED in this environment, and it is the one component the harness substitutes. |
| H8 | **Decide what happens to a bank deposit the bank does not acknowledge** — blocker B-1. `record_bank_deposit` and `verify_bank_deposit` cover the ordinary path, and `open_deposit_investigation` records an unacknowledged deposit without posting anything, deliberately: a bounced deposit, a partial clearance and the ageing, recovery and loss treatments are accounting decisions, not implementation details. Until they are decided, cash in transit that never clears stays in transit and visible rather than being written off by a guess. |
| ~~H7~~ | **DONE.** The identity is in `scripts/certify-financial-reconciliation.mjs` as the `cash sufficiency` group, and it distinguishes a balance that went negative before the rule began to bind from one created after. The original item read: **Add a "no cash account holds a negative balance" identity to `scripts/certify-financial-reconciliation.mjs`.** The harness already has exactly this identity for loan outstandings and for savings balances; cash is the one of the three that lacks it, and its three cash identities test agreement with the general ledger rather than plausibility — so they pass happily on a till of −345,000. One identity would have turned GAP-001 from a documented analysis into a failing build. This is cheap, it is independent of the Decision A outcome, and it should be done first so the decision can be verified when it lands. |

### Medium — resolve before business launch

| # | Item |
| --- | --- |
| M1 | **Carry a Quick Loan, a Salary Loan and a Business Loan through a full browser journey.** Their product rules are well covered by the database suite and by this audit's 6,770-case engine comparison, but the end-to-end demonstration book contains only `IL` and `ML` loans. A product that has never been sold end to end in a test has never been sold end to end. |
| M2 | **Seed at least one cash banking into the demonstration book.** It is exercised live by the browser journey — this audit measured a 4,000,000 banking with a 20,000 charge posting correctly — but the *seeded* book carries none, so `npm run certify:financial`, which runs on its own seeded book, has no cash-banking rows to reconcile. |
| M3 | **Decide the year-end profit-distribution formula** (`profit_distribution_basis`), which keeps profit sharing closed even under an approved policy. This is also the decision that makes the savings-liability discipline matter: distributing a surplus computed on an overstated profit would pay a profit share out of members' own deposits. |
| M4 | **Settle the bank-advance model** if any partner bank is expected to allow cash advanced beyond collections. It is specified in `docs/POLYTOS-AGENCY-BANK-ADVANCE-MODEL.md` and deliberately has no flag to set. |

### Low — improvements and technical debt

| # | Item |
| --- | --- |
| L1 | Teach `scripts/check-database-security.mjs` to recognise `agency_actor()` as an authorisation helper, so its advisory list stops naming ~30 functions that are in fact properly guarded. It is honest about being advisory, but a list that is mostly false positives is a list people stop reading. |
| L2 | Make `stack.sh`'s cleanup match on the executable rather than the command line, so a shell whose arguments merely mention `postgrest` is not killed. |
| L3 | Consider surfacing a guarantor's current concentration on the approval screen. The fix added the failure code; showing the count before somebody commits to an application would turn a refusal into a decision. |
| L4 | Make `tests/integration/bundle.test.ts` fail, rather than skip, when `.next` is older than the newest source file it would measure. It skips when there is no build, which is right; it also passes against a stale one, which is how a 441 KB regression survived three green local runs (§H.6.2). |
| ~~L5~~ | **DONE, 2026-11-17.** `tests/e2e/specs/cash-sufficiency.write.spec.ts` — six journeys covering receipt confirmation, batch confirmation, bank-deposit clearance, maker-checker rejection, investigation and reversal, each asserting the resulting available balances against the ledger. Discriminating power measured: dropping the maker-checker CHECK fails all six. §H.8. The original item read: **Add a browser spec for Cash Received and Bank Deposits beyond the sweeps they were just added to.** The full 1,151-test suite passed without touching either screen, which is worth remembering: a suite that is green is not a suite that looked. |
| L7 | **Decide whether a maker-checker refusal may say why.** A Manager who banks cash and then tries to clear it themselves is told "Privilege denied on record." — which points at the wrong cause, because they *hold* `deposits:verify` and what stopped them is separation of duties. `mapDatabaseError` generalises every database message by design, so this is a decision about the boundary rather than a defect in Decision A: either a small set of functions is allowed to pass a staff-facing sentence through, or the screens carry the explanation and the alert stays generic. Found by L5's own journeys; §H.8. |
| L6 | Consider pinning the `database` CI job's PostgreSQL major version, or asserting it. The job takes the newest on the runner image, which is the stronger test and is how the `23001` change was caught at all (§H.6.1) — but it means the runner image can turn a green build red with no commit behind it, and the first symptom is three unrelated-looking test failures. |

