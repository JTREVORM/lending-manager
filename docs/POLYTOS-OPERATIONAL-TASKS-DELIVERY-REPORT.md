# POLYTOS — operational tasks 1–5: delivery report

**Date:** 2026-11-21
**Branch:** `ccr-78d54174-d7uy2f`
**Scope:** the five remaining operational development tasks

> **Nothing in this work activated a financial provider or altered a
> production balance.** Every one of the nine catalogue providers is still
> provisional and still inactive, and a test asserts it
> (`agency-provider-provisioning.test.ts`, "leaves every catalogue provider
> provisional and inactive"). What was built is the machinery by which the
> Owner can bring a partner live, with the approvals that decision requires.
> Using it is a separate act, and it needs two Owner/Administrator accounts.

---

## 1. What was asked, and what each task turned out to be

| # | Task | What was actually missing |
|---|------|---------------------------|
| 1 | New bank provider registration | No way to register a provider at all. `STANBIC` was the only bank POLYTOS could ever have; adding Equity or Centenary meant a hand-written migration with the commission rate taken on trust |
| 2 | Bank-specific agent account registration | A `cash_payable` partner could not have an agent account **at all** — `ledger_account_id` was `NOT NULL` and `ensure_agency_float_account()` refuses such a provider. And no column held the partner's own account number |
| 3 | Capital funding and opening balances | No document, no function, no screen. One thing had ever credited `3000 Owner Capital`: the Phase 10 backfill, which *derived* an opening balance from the deepest the cash position ever reached. A lender was indistinguishable from an owner |
| 4 | Float funding and reconciliation certification | Nothing missing — this was a measurement task. Reported in §6 |
| 5 | Provider activation and financial limits | `requires_approval_above` was configuration nothing read; no float facility limit existed in any column; and nothing stood between "terms approved" and "live" |

Three of those gaps were documented in the application itself, which is how
they were found rather than guessed:

- `app/(app)/agency/providers/page.tsx`: *"Registering a provider, approving
  its commercial terms or making it live is not a screen in this release: the
  approval workflow for commercial terms has not been decided."*
- The same file, on the threshold: *"marked as not enforced because it is
  not. Decision L … is unresolved, and the posting engine does not read this
  column."*
- `docs/POLYTOS-AGENCY-OWNER-ACCEPTANCE.md` §3.3: *"Float facility limits are
  not enforced. No column holds one and no posting path checks one."*

All three sentences are now false, and all three have been corrected where
they were written.

---

## 2. Task 1 — registering a partner, and approving its terms

`supabase/migrations/20261121000200_agency_provider_registration.sql`

Three functions, in the order the business does the work:

| Function | Capability | What it does |
|---|---|---|
| `register_agency_provider()` | `agency:providers` | Writes one **provisional, inactive** provider. Neither flag is an argument |
| `revise_agency_provider_terms()` | `agency:providers` | Corrects proposed terms, only while unapproved. Locks the row so a revision cannot race an approval |
| `approve_agency_provider_terms()` | `agency:provider_approval` *(new)* | A second person confirms the commission against the signed agreement, which clears `is_provisional` |

### The ledger accounts are not a dropdown

The caller cannot choose them. The category decides:

| Category | Income | Payable (cash-payable only) |
|---|---|---|
| `mobile_money` | 4510 | 2290 |
| `agency_banking` | 4520 | 2220 |
| `utility` | 4530 | 2290 |
| `school_fees` | 4540 | 2210 |
| `tv_subscription` | 4550 | 2290 |
| `airtime_data` | 4560 | 2290 |
| `other` | 4590 | 2290 |

The nine catalogue rows already followed this mapping to the letter, so it
describes the chart rather than imposing on it.

`agency_provider_accounts_guard()` would catch an income account of the wrong
*type*, or one outside the 45 series. It cannot catch 4510 on a bank: Mobile
Money Commission is a postable 4500-series income account, and pointing Equity
Bank's commission at it passes every check in the schema while quietly making
agency banking income and mobile money income inseparable for the rest of
time. A dropdown offering seven valid-looking wrong answers is a defect
waiting for a busy afternoon.

### Why terms approval needs a second person

A commission rate is the one number that decides what every future transaction
earns. `agency_transactions` snapshots `commission_rate_bps_applied` per
posting, so history is safe from a later edit — but the first posting takes the
rate as configured, and if that rate was mistyped **nothing in the system will
ever notice**. The agreement is held outside POLYTOS. The only control is
somebody checking the number against the paper and saying so on the record.

`agency:provider_approval` is granted to `owner_admin` alone, and
`approve_agency_provider_terms()` refuses the profile that registered the
provider with SQLSTATE `SD001`. **Consequence, stated plainly: bringing a
partner's terms into force requires two Owner/Administrator accounts.** A
business running a single administrator login can register providers and will
not be able to approve them.

### The approval trail cannot be forged

Six new columns record it (`registered_by`, `registered_at`,
`terms_reference`, `terms_approved_by`, `terms_approved_at`,
`terms_approval_note`), and `agency_provider_terms_approval_guard()` refuses
the transition out of provisional without a complete trail and with the
approver equal to the registrant. ADR-072 records why this is a trigger on the
transition rather than a `CHECK` on the state.

---

## 3. Task 2 — agent accounts, on either model

`supabase/migrations/20261121000300_agency_bank_agent_accounts.sql`

### The invariant

For an agent account that is **open** (active or suspended):

- the partner advances float (`provider_float`) ⟺ the account owns exactly one
  branch-matched, postable `1320` float account;
- the partner holds the customer's cash (`cash_payable`) ⟺ the account owns
  **no** ledger account, and carries the partner's own `bank_account_number`
  instead.

A **closed** account is exempt: it is history, and the provider's model may
legitimately have changed since. `set_agency_provider_float_model()` is
tightened to refuse a model change while any account is open, so the two sides
cannot drift.

### What was tempting and wrong

Giving a cash-payable partner a `1320` float account to hang its identity on
would put an asset on the balance sheet that does not exist. POLYTOS holds no
electronic float for a school; it holds the parent's cash and owes it onward.
That float account would start at zero, never move, and reconcile to nothing —
an asset line existing only to satisfy a `NOT NULL`.

ADR-073 records why this is one register rather than two tables, and the
measurement behind it: all twelve views that reference the register were
checked, and the float-specific ones exclude a cash-payable account correctly
because they join `ledger_accounts` through `ledger_account_id`.

### What is new, and what is only now reachable

- **New:** `bank_account_number`, unique per provider. Banks identify an
  outlet by account number; `line_msisdn` is a mobile money line's identity
  and is the wrong shape (`^\+256[0-9]{9}$`).
- **Only now reachable:** multiple locations per partner on *either* model.
  The register has been keyed `(provider_id, branch_id, till_name)` since
  Phase 4A, so several accounts per partner was always the design. What was
  missing was the ability to open one at all without float.

Three float-only child tables — replenishments, reconciliations, trades —
gained a trigger refusing an account that owns no float, so widening the
register cannot widen what can be done to a float that is not there.
`ensure_agency_float_account()` is **unchanged** and still refuses a
`cash_payable` provider.

### No existing column became required

`agent_code` and `line_msisdn` stay optional exactly as they were. The only new
requirement — an account number on a cash-payable account — falls on rows that
could not exist before this migration.

---

## 4. Task 3 — capital funding and opening balances

`supabase/migrations/20261121000400_capital_funding.sql`

### Equity is not borrowing, and the difference is the balance sheet

- **Equity.** The owner's own money. Not repayable, no interest, credits the
  3000 series. Net worth rises by the whole amount.
- **Borrowing.** Somebody else's money. Repayable, may carry interest, credits
  a **2300-series** liability. Net worth does not change at all: an asset and a
  liability arrive together.

`2300 Borrowings` and three postable children (`2310` Director and Shareholder
Loans, `2320` Bank and Institutional Loans, `2330` Other Borrowings) were added
because the chart had no liability for money the business itself borrowed.
`2100` is member savings and `2200` is agency payables; neither is a borrowing,
and putting a bank loan in either would make the savings or the agency position
unreadable.

`capital_funding_accounts_guard()` holds a funding to its own kind: equity
credits a postable 3000-series equity account, a borrowing credits a postable
2300-series liability, and the money lands in a branch-matched, postable cash or
bank account. A borrowing cannot credit equity and a contribution cannot credit
a loan account — not by convention, by refusal.

### Recording posts nothing

| Function | Capability | Posts |
|---|---|---|
| `record_capital_funding()` | `capital:record` | Nothing |
| `verify_capital_funding()` | `capital:verify` | **Dr destination / Cr equity or borrowing** |
| `reject_capital_funding()` | `capital:verify` | Nothing; terminal |
| `reverse_capital_funding()` | `capital:reverse` | The contra |

Capital is the largest single entry this business will ever make and the least
self-correcting. A till that is short shows up at the next cash count; a float
that is wrong shows up at the next reconciliation. An equity credit that is
wrong shows up **nowhere** — it sits on the balance sheet looking exactly like
the truth. So one person records what the evidence says, a second checks it
against the evidence, and only then does anything post. Every maker-checker
rule here is a `CHECK` as well as a function-level refusal, so no route —
`service_role` included — can forget it.

### The three dates, and what that costs

| Field | Meaning |
|---|---|
| `funded_on` | What the evidence says. May precede the system's own history — **this is how an opening balance is recorded** |
| `verified_at` | When the second officer checked it |
| `entry_date` | The accounting date of the journal: **always today** |

This is the `bank_value_date` discipline from Decision A, and it has the same
consequence, stated rather than hidden: **a capital funding recorded today
posts today, whatever the slip says.** POLYTOS has no period close and no
backdated posting, by deliberate design. An accountant reconciling to a
prior-year balance sheet reads `funded_on`; the ledger reads `entry_date`.
Neither is guessed, and a test asserts they differ.

### Reversal refuses rather than going negative

`reverse_capital_funding()` needs available funds in the destination account.
Reversing an entry that credited equity and debited the bank takes the money
back out of the bank, and if it has already been lent out there is nothing to
take. Refusing is correct — what is wanted then is a capital *withdrawal*,
which is a different instrument and is **not** invented here.

---

## 5. Task 5 — limits, thresholds, the facility, and going live

`supabase/migrations/20261121000500_agency_provider_activation.sql`

### 5.1 Threshold verification — decision L, closed

Above a service's `requires_approval_above`, verification requires
`agency:verify_high_value` (new, `owner_admin` only). Enforced **twice**:

1. `verify_agency_transaction()` refuses early, naming the figure and the
   authority needed.
2. `agency_high_value_authority_guard()` refuses the transition into `posted`
   whenever the **recorded verifier** does not hold the capability — read from
   `verified_by`, not from the caller. That is the guarantee: it holds for a
   route that stamps a verifier and calls `post_agency_transaction()` directly,
   which is exactly what the test does.

`set_agency_service_threshold()` is the setter. It takes `agency:providers`
rather than `agency:provider_approval` — a threshold is an internal operating
limit on the business's own staff, not a term of the partner's agreement — and
it refuses a threshold at or above the service's own ceiling, which could never
be reached.

The ordinary ceiling (`max_single_transaction`) has been enforced since Phase
4A and is unchanged. The two answer different questions: the ceiling says what
may be transacted **at all**, the threshold says what may be transacted
**without the Owner looking at it**.

### 5.2 The float facility

`float_facility_limit` on `agency_service_providers`, approved by a holder of
`agency:provider_approval` against a named instrument, never by the person who
registered the provider. Scoped per provider rather than per agent account: a
facility is granted by the partner to the business, and the business decides
how to spread it across its outlets. A cash-payable partner has none by
`CHECK` — it advances no float.

`agency_float_facility_guard()` refuses a replenishment or float purchase that
would take the provider's total float above the facility. It fires where float
is *acquired* and not on a sale or a line-to-line transfer, neither of which
raises the total; and on a trade it fires both on insert and on the transition
to `posted`, so a facility that shrank in between is caught.

`set_agency_float_facility()` also refuses a facility **smaller than the float
already held**, which would make the next reconciliation read as a breach that
never happened.

A provider with no approved facility is *not* refused float by this guard.
That would break every existing float account, and it is the wrong place: such
a provider cannot be activated at all, and nothing can be posted against an
inactive provider.

### 5.3 Going live

`activate_agency_provider()` checks seven things, each with its own sentence:

1. the terms are approved;
2. it earns something, or reports what it earns;
3. at least one service is active and states a ceiling;
4. at least one agent account is open;
5. where the partner advances float, a facility is approved;
6. the authorization names the instrument it was given under;
7. the person authorizing is **not** the person who registered it (`SD001`).

`agency_provider_activation_guard()` re-checks the four that can be re-derived
from the row, on the `is_active` transition itself, so going live is not
something an `UPDATE` can do.

`deactivate_agency_provider()` needs only a reason — it is the safe direction —
and **clears the activation trail**. That last part was a defect in the first
version of this work: deactivation left the trail in place, and because the
activation guard reads exactly those columns, a bare
`update … set is_active = true` passed on the authorization that had already
been spent. Found by writing the test that asserts it, fixed, and the test now
asserts the trail is cleared as well as that the bare update is refused.

`agency_provider_readiness` answers each precondition separately, so a screen
lists what is outstanding rather than offering a button that fails.
`ready_to_activate` says the *configuration* is complete; it deliberately does
not say the authorization has been given, which is a person's decision.

---

## 6. Task 4 — float funding and reconciliation, certified

This task asked for measurement, not change, and **no float, reconciliation or
ledger control was modified to make anything pass.**

### 6.1 The baseline

Before any of this work, on a database rebuilt from all 251 migrations:

```
npm run test:db   →   16 projects, 88 + 15 files, 2,582 tests, 0 failures
```

That is the certification the task asks for: float purchase, sale, transfer,
replenishment, reversal, reconciliation, commission settlement and the ledger
invariants all pass against real accounting scenarios, with the journal as the
arbiter. The suites that own those scenarios are `agency-money-float`,
`agency-banking-float`, `agency-settlement`, `agency-commission-daily`,
`agency-transaction-engine` and `ledger-balance-invariant`.

### 6.2 After this work

```
npm run test:db   →   18 projects, 2,648 tests, 0 failures
npm run test:run  →   92 files, 2,811 tests, 0 failures
npm run typecheck →   clean
npm run lint      →   clean
npm run format:check → clean
node scripts/check-database-security.mjs → no unreviewed privileged exposure
```

The 66 new tests are the two suites added by this work. Every pre-existing
float and reconciliation test passes unchanged.

### 6.3 What the new float controls were measured against

Not the column, the ledger:

- a replenishment inside an approved 10,000,000 facility posts, and the float
  account's balance is 8,000,000;
- a second replenishment that would breach it is refused, naming the held
  figure and the limit;
- one that exactly fills the facility is **allowed** — the limit is a ceiling,
  not a margin — and the balance reads 10,000,000 to the shilling;
- the facility cannot then be cut below what is held;
- and a float replenishment, reconciliation or trade against a cash-payable
  agent account is refused by trigger, proved by writing the document row
  directly rather than by calling the function.

### 6.4 Three fixture sites were changed, and why

`agency_provider_terms_approval_guard()` refuses confirming a provider without
an approval trail. Three fixtures confirmed a provisional provider with a bare
`UPDATE`; each now supplies the trail. That is the right outcome: those three
lines *are* taking the approval decision, and the ~25 fixtures that merely
insert an already-confirmed provider are untouched because they are describing
a world rather than deciding anything. ADR-072 records the reasoning.

---

## 7. Three defects found by this work, and fixed

All three were in the new code, found by writing the tests and by reading the
functions the new guards sit beside rather than by reading the new guards:

1. **A spent authorization could be reused.** `deactivate_agency_provider()`
   left `activated_by`, `activated_at` and `activation_reference` in place, and
   the activation guard reads those columns — so a bare
   `update … set is_active = true` after a deactivation passed on last month's
   board minute. Deactivation now clears the trail, and the guard additionally
   refuses an authorization that predates a deactivation.

2. **The facility guard counted a float purchase twice.** The two documents
   that bring float in order their work differently:
   `post_float_replenishment()` inserts its document and *then* posts the
   journal, so at insert the float has not arrived; `verify_agency_float_trade()`
   posts the journal and *then* updates the trade to `posted`, so by the time
   the guard sees that update the float is already in the balance. The guard
   added the amount in both cases, which would have refused a purchase that
   exactly fills an empty facility — a 10,000,000 purchase against a
   10,000,000 facility computing 20,000,000 and refusing a legitimate trade.
   It now counts the posted case from the balance alone. Found by reading
   `verify_agency_float_trade()` to check the ordering rather than assuming it,
   and the test added for it buys the whole facility in one trade, which is the
   only amount that distinguishes the two readings.

3. **A view projected `numeric`.** `agency_provider_readiness.float_held` is a
   `sum(bigint)`, which PostgreSQL types as `numeric` —
   and `tests/db/schema.test.ts` fails the build on a `numeric` column anywhere
   in `public`, including one a view projects. Cast to `bigint`. Shillings are
   integral and nothing here needs a scale.

A third was a near miss worth recording: the three new views were created with
`revoke … from public, anon` and not `authenticated`, so Supabase's default ACL
left `authenticated` holding `INSERT`, `UPDATE`, `DELETE` and `TRUNCATE` on
each. `tests/db/security.test.ts` caught it — *"agency_agent_account_register
grants DELETE to authenticated"* — which is precisely what that exhaustive
privilege list is for.

---

## 8. What was deliberately not built

Named so they are decisions rather than omissions.

- **Amending an approved provider's commission.** Refused, with a sentence
  saying what to do instead. Re-negotiating a live partner's rate is a real
  business event, but it needs the provider taken out of service, the terms
  amended and re-approved, and a decision about transactions already posted
  under the old rate. None of that is a side effect of an `UPDATE`.
- **A capital withdrawal.** `reverse_capital_funding()` undoes a mistake. An
  owner taking capital *out* of the business is a different instrument with its
  own tax and solvency questions, and inventing it inside a reversal would be
  the one thing the maker-checker spine exists to prevent.
- **Backdated capital postings.** The evidence date is recorded and the journal
  is dated today. Posting into a prior period needs a period-close model this
  system does not have, and faking it would make a prior-year balance sheet
  disagree with the ledger that produced it.
- **Bank advances for cash-payable partners.** Unchanged and still refused.
  `docs/POLYTOS-AGENCY-BANK-ADVANCE-MODEL.md` specifies it and says why it is
  not implemented; nothing here weakens that floor.
- **Activating anything.** See the note at the top of this report.

---

## 9. What the Owner has to do before any provider goes live

In order, and none of it is a code change:

1. **Create a second Owner/Administrator account** if there is only one. Terms
   approval, the float facility and going live all refuse the person who
   registered the provider. Without a second account, a provider can be
   registered and cannot be approved.
2. **Register each partner** — Equity, Centenary, and any other — with its
   category, its float model and its proposed commission.
3. **Approve each one's terms** against the signed agreement, from the second
   account, recording the agreement's reference.
4. **Approve each float-advancing partner's facility**, against the facility
   letter.
5. **Open the agent accounts**, one per location, with the bank's own account
   number and agent identifier.
6. **Set a ceiling on every service**, and a threshold on any service where the
   Owner wants to see large amounts personally.
7. **Roster the staff** on each agent account (`agency_account_staff` ships
   empty by design — see `POLYTOS-AGENCY-OWNER-ACCEPTANCE.md` §3A).
8. **Authorize go-live**, from an account that did not register the provider,
   naming the board minute or signed authority.

`/agency/providers` lists what each provider is still missing, in those terms,
so step 8 is never the first anybody hears of an outstanding step.

For capital: record each contribution or borrowing with its evidence, then
verify it from a second Owner account. `/finance/capital` is the screen.

---

## 10. Files

### Migrations (5, additive)

| File | Task |
|---|---|
| `20261121000200_agency_provider_registration.sql` | 1 |
| `20261121000300_agency_bank_agent_accounts.sql` | 2 |
| `20261121000400_capital_funding.sql` | 3 |
| `20261121000500_agency_provider_activation.sql` | 5 |

### New capabilities (6)

`agency:provider_approval`, `agency:verify_high_value`, `capital:view`,
`capital:record`, `capital:verify`, `capital:reverse`.

### New tables, views and functions

One table (`capital_fundings`), three views
(`agency_agent_account_register`, `agency_provider_readiness`,
`capital_funding_register`), four ledger accounts (`2300` and its three
children), and twenty-nine function definitions: **twenty-three new**, four
replaced in place and two dropped and recreated.

Replaced in place — each carrying its previous body across unchanged except
for the stated addition:

| Function | What changed, and nothing else |
|---|---|
| `agency_float_account_guard` | Branches on the provider's float model; every float-path check carried across verbatim |
| `agency_float_account_immutable_identity` | The till-name refusal names the account when there is no ledger code to name; the float case keeps its original sentence word for word |
| `set_agency_provider_float_model` | One check inserted: no model change while an agent account is open |
| `verify_agency_transaction` | One block inserted: the approval threshold. Idempotent return, both revision guards, the maker-checker refusal and both audit writes untouched |

Dropped and recreated — `register_agency_agent_line` and
`update_agency_agent_line`, each gaining `p_bank_account_number`. Dropped
rather than overloaded, because two overloads differing by a trailing default
is how a caller invokes the one it did not mean. Their grants are restated in
the same migration.

### Application

`lib/permissions/permissions.ts`, `lib/domain/{agency,finance,reference}.ts`,
`lib/data/{agency,finance}.ts`, `lib/validation/{agency,finance}.ts`,
`lib/{agency,finance}/actions.ts`, `lib/auth/routing.ts`,
`components/agency/provider-provisioning.tsx`,
`components/finance/capital-register.tsx`,
`components/layout/nav-items.ts`, `config/app.ts`,
`app/(app)/agency/providers/page.tsx`, `app/(app)/finance/capital/page.tsx`,
`types/database.types.ts`.

### Tests

`tests/db/agency-provider-provisioning.test.ts` (38),
`tests/db/capital-funding.test.ts` (28), plus registry updates to
`tests/db/{schema,security,separation-of-duties,rls-payments}.test.ts`,
`tests/unit/permissions.test.ts` and
`tests/integration/migrations.test.ts`.

### Documentation

This report, `docs/DECISIONS.md` (ADR-072, ADR-073), and
`docs/POLYTOS-AGENCY-OWNER-ACCEPTANCE.md` §3.3, amended because the two things
it recorded as deliberately not built have now been built.
