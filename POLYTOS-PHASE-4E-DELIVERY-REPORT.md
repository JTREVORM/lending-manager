# POLYTOS Phase 4E — Mobile Money: delivery report

**Branch:** `phase4e/mobile-money-2026-11-09`, created from
`phase4d/agency-banking-interface-2026-11-08` @ `38633d8` ·
**Design accepted at:** `befac86` · **Code head:** `17a4877`, CI green ·
**Status:**
complete at the database, the application and the browser; the remaining
release conditions are commercial and infrastructural, not code (§7, §8).

No pull request has been merged. No production deployment, no hosted
migration, no change to any hosted financial or demonstration record. No
provider activated. Policy 2.0 not published. PRs #19–#26 untouched at their
audited SHAs, #19 still an independent merge. The integrated production
verdict stays **NO-GO**.

---

## 1. What the twelve approved decisions asked for, and what was built

| Decision | Delivered | Where |
| --- | --- | --- |
| **OD-1** Float purchases at face value, premium or discount | `5970 Agency Float Purchase Premium` and `4580 Agency Float Purchase Discount`; the difference is recognised in the purchase journal rather than absorbed into the float | `…000100`, `…001000` |
| **OD-2** Reconciliation never posts a financial change | `certify_agency_commission_reconciliation()` writes **no journal line of any kind**, and a certified variance stays on the exceptions view | `…001200`, `…001300` |
| **OD-3** Transfers between lines, within and across branches | `record_agency_float_trade('transfer', …)`, authority required at both ends, both provider-balance locks taken in branch-id order | `…001000` |
| **OD-4** Normal closure versus emergency suspension | `status` = active \| suspended \| closed; `agency_agent_line_obligations()` and `close_agency_agent_line()`; the transaction guard now lets a suspended line be *emptied* but not filled | `…000200`, `…000600`, `…001100` |
| **OD-5** Deposit fees on top; withdrawal fees deducted **or** collected | `customer_fee_mode`, with the collected case posting two lines on the same cash account so the gross movements are both recorded | `…000500` |
| **OD-6** External sales settle in full, fee optional and manual | A sale posts and settles in one entry; `fee_amount` is a cashier-entered integer with no rate anywhere; a credit sale is structurally impossible | `…000900`, `…001000` |
| **OD-7** Cashiers record, a different Manager or Owner verifies | `agency:float_trade` records; `agency:settlements` verifies, and verification is what posts. Maker ≠ checker is a CHECK; a pending row moves nothing because no journal exists until verification | `…000300`, `…000900`, `…001000` |
| **OD-8** Unique provider reference on a commission payout | Mandatory, with a per-line unique index — unlike Phase 4C's optional reference, whose partial index gave no protection at all when absent | `…000700` |
| **OD-9** The provider's exact statement dates; overlap detection; separate monthly reports | `submit_agency_commission_reconciliation()` with overlap refusal under the provider lock, and `agency_commission_monthly` kept separate | `…001200`, `…001300` |
| **OD-10** Reversal after payout becomes a recovery payable | `2230 Agency Commission Recovery Payable`; the reversal credits the receivable as far as it goes and the rest to 2230; `record_agency_commission_recovery()` clears it by float deduction or commission offset | `…000100`, `…000800` |
| **OD-11** Owner sets a ceiling per provider and service | `set_agency_service_limit()`, audited, refusing NULL and zero | `…000300` |
| **OD-12** Business date mandatory, provider time optional, entry time automatic | `transacted_at` added; `transaction_date` still decides the posting, in Africa/Kampala | `…000500` |

### What already existed and was reused unchanged

The deposit and withdrawal journals, the deferred commission accrual to
`1310`, per-line float accounts and their `1320.*` ledger codes, per-line
float reconciliation, branch cash reconciliation, the idempotency replay
guard, maker-checker on transactions, the revision check, `post_journal()` as
the sole writer, the two deferrable balance triggers, the lock discipline, the
branch-isolation rule and the append-only audit. The gap analysis at `befac86`
set that out; none of it was rebuilt.

---

## 2. Migration sequence

Fourteen migrations, applied in filename order. Every one is re-runnable:
re-applying the whole set to an already-migrated database is part of the
local loop.

| # | File | What it does |
| --- | --- | --- |
| 1 | `20261115000100_agency_money_chart_of_accounts` | `2230`, `4580`, `5970` with their parents |
| 2 | `20261115000200_agency_agent_line_identity` | line label, MSISDN, agent code, dates, notes; `status`; immutability trigger; configuration audit |
| 3 | `20261115000300_agency_money_permissions_and_limits` | `agency:float_trade`; `set_agency_service_limit()` |
| 4 | `20261115000400_agency_reported_commission` | `commission_source`; the two predicated relaxations; `agency_commission_for`/`_reconcile`; the readiness guard; `set_agency_provider_commission_source()` |
| 5 | `20261115000500_agency_customer_fee_mode` | `customer_fee_mode`, `transacted_at`; posting; `create_`/`update_agency_transaction` re-signed |
| 6 | `20261115000600_agency_reported_basis_and_suspension` | the snapshot CHECK's fourth basis; the transaction guard's two inactive states |
| 7 | `20261115000700_agency_commission_payout` | per-line outstanding; payout into float; the destination trigger; two source types |
| 8 | `20261115000800_agency_commission_recovery` | the recovery register and function; the reversal split |
| 9 | `20261115000900_agency_float_trades` | the float-trade register, its constraints and its revision guard |
| 10 | `20261115001000_agency_float_trade_functions` | record, verify, reject, reverse |
| 11 | `20261115001100_agency_agent_line_administration` | register, update, suspend/reinstate, close, obligations |
| 12 | `20261115001200_agency_commission_reconciliation` | the statement-period register, submit and certify |
| 13 | `20261115001300_agency_money_views` | six views, the register extension, three new exception kinds |
| 14 | `20261115001400_agency_money_view_readability` | the per-line commission balances as a view, so the three views built on them are readable by the officer rather than refused (§6) |

`PHASE_PREFIXES` in `scripts/verify-membership-upgrade.mjs` lists `20261115`.
Without it the upgrade verifier would classify this whole phase as released
schema — the exact defect the integrated release audit found for `20261104`.

---

## 3. The accounting, stated

Figures are illustrative UGX. Every entry below is asserted by its exact
lines, in order, in the test suites named in §4.

**Deposit** (unchanged from Phase 4B): Dr cash 100,000 · Cr line float 100,000
· Dr `1310` 700 · Cr `4510` 700.

**Withdrawal, fee deducted** (unchanged): Dr line float 50,000 · Cr cash
49,500 · Cr `4570` 500 · plus the commission pair.

**Withdrawal, fee collected separately** (OD-5): Dr line float 50,000 · Cr cash
50,000 · **Dr cash 500** · Cr `4570` 500 · plus the commission pair. The net is
identical to the deducted form; the gross is not, and a physical count
reconciles against movements.

**Commission payout** (OD-8): Dr line float 45,000 · Cr `1310` 45,000. No
income account is touched — the income was recognised per transaction.

**Reversal after payout** (OD-10): Dr `4510` 1,000 · Cr `1310` min(1,000,
outstanding) · Cr `2230` the remainder. Where nothing was paid out, the `2230`
leg is absent and the entry is what Phase 4C posted.

**Recovery, float deduction** (OD-10): Dr `2230` 1,000 · Cr line float 1,000.
**Recovery, commission offset**: Dr `2230` 1,000 · Cr `1310` 1,000 — no money
moves; two existing balances fall.

**Float purchase at face value** (OD-1): Dr line float 500,000 · Cr cash
500,000. **At a premium**: Dr line float 500,000 · Cr cash 500,500 · Dr `5970`
500. **At a discount**: Dr line float 500,000 · Cr cash 499,500 · Cr `4580`
500.

**Float sale with a fee** (OD-6): Dr cash 202,000 · Cr line float 200,000 ·
Cr `4570` 2,000. Total proceeds are computed; the fee is typed.

**Line-to-line transfer** (OD-3): Dr receiving line 300,000 · Cr sending line
300,000. No cash, no income, consolidated float unchanged — which is why
`agency_mobile_money_consolidated` reports transfers in their own two columns
and excludes them from the purchase and sale totals.

### The invariant the suites assert after every scenario

`1310` and `2230` are each one general-ledger account shared by every provider
and every line, so the per-line figures are **derived** from the ledger through
each entry's source rather than stored beside it. After each scenario the sum
of the per-line figures is checked against the account's own balance. That is
the single assertion that catches a payout posted against the wrong line, a
double recognition, or a reversal that forgot the receivable.

---

## 4. Test results

Against real PostgreSQL throughout, on a database built from the migrations
on each run.

| Suite | Tests | Covers |
| --- | --- | --- |
| `tests/db/agency-money-foundation.test.ts` (new) | 54 | the three accounts; agent-line identity and immutability; suspension and closure; service ceilings; reported commission; fee modes; timestamps; the Owner's five controls |
| `tests/db/agency-money-commission.test.ts` (new) | 37 | payout, partial payout, over-payout, duplicates, per-line attribution, suspension and closure rules; the OD-10 split and both recovery methods; the statement-period reconciliation and its silence; and that each of the seven Phase 4E views can be read by a signed-in officer and reports the same figures the engine refuses on |
| `tests/db/agency-money-float.test.ts` (new) | 32 | a pending trade moving nothing; all four purchase and sale journals; transfers within and across branches; maker-checker; stale revisions; rejection; reversal; suspension rules; and four concurrency races — a sale behind a held line, two sales of the same float where only one may win, two opposing cross-branch transfers that must not deadlock, and a payout behind the line it pays into |

Existing suites, all still passing with every behaviour change above:

| Suite | Tests |
| --- | --- |
| `db` (83 files, including the schema, security, RLS-hoisting and balance-invariant inventories) | 1,950 |
| `agency` (Phase 4A foundation) | 66 |
| `agency-engine` (Phase 4B) | 64 |
| `agency-security` (4B-S closure) | 21 |
| `agency-settlement` (Phase 4C) | 78 |
| `shared-till` (Workstream A) | 6 |
| `seed`, `seed-reuse`, `seed-member-loans`, `seed-benefits` | 18, 15, 24, 25 |
| `unit` + `integration` | 2,690 |

**2,390 database tests across eleven vitest projects**, each on a cluster the
project's own `globalSetup` rebuilds from the migrations, run exactly as CI
runs them (`npm run test:db`). The `agency-money` project is in that script
now; it was not, and §6 records what that cost.

Browser: 10 Mobile Money tests, 27 performance, and the existing agency,
navigation and accessibility suites, against the real harness.

### CI on the final head

**Run `42779918710`, commit `17a4877`, all four mandatory jobs green:**

| Job | Result |
| --- | --- |
| `checks, unit/integration, build` | ✅ |
| `database (real PostgreSQL)` | ✅ |
| `security release rehearsal (PostgreSQL 17, real Auth)` | ✅ |
| `browser E2E (production build, fresh seed)` | ✅ |

The browser job is the one worth naming. It applies every migration from zero
to PostgreSQL, seeds a real book, builds for production and runs the whole
browser suite — this phase's ten Mobile Money tests among them — on a database
nothing has touched. The database job is also the first run in this phase's
history that actually executed the `agency-money` project; the three before it
reported green without it (§6).

The only commit after `17a4877` is this report, which changes no code, no
migration and no test.

Gates: `scripts/check-database-security.mjs` passes on a clean build;
`scripts/audit-financial-arithmetic.mjs` passes; typecheck, lint and format
clean. The browser bundle total moves 670 → 676 KB gzipped, measured both
ways on one machine (104 chunks and 665 KB without the five new routes, 107
and 671 KB with them), no new dependency, largest chunk unmoved at 72 KB, and
the two heaviest new routes added to the per-page budget.

### Existing financial data is provably preserved across the upgrade

`scripts/verify-membership-upgrade.mjs` applies the released schema, seeds a
real book of loans, payments, memberships, savings and benefits, then applies
every unreleased migration — all fourteen of this phase included — and compares
28 financial figures before and after:

> Upgrade verified: 97 existing migrations, a seeded book, then 115 new
> migrations. Every one of 28 financial figures is identical, the 22
> membership, savings, member loan, benefit and meeting tables exist and are
> empty, and 2100 Member Savings is zero.

The three new ledger accounts appear among "28 new account(s), all at zero",
and the only new audit rows are configuration. Nothing this phase adds moves a
shilling of existing money, which is the property that matters when these
migrations are eventually applied to a database that holds real records.

### Three existing tests were rewritten, because an approved decision changed the behaviour they asserted

Not because they were wrong. OD-10 replaced a refusal with an accounting
treatment, and these three asserted the refusal:

- `agency-transaction-engine.test.ts` — "refuses a reversal whose commission
  has already been settled" now asserts the reclassification to `2230` and
  that the receivable does not go negative;
- `agency-settlement.test.ts` — "releases a historical transaction that the
  settlement had blocked" became "reverses a transaction whose commission was
  already settled, and records what is owed back", and ends with the offset
  recovery that closes both figures. Phase 4C's version ended by netting them
  to zero inside `1310` — tidier, and it said less;
- the lock-and-resource matrix gained four rows and its completeness check two
  exclusions.

---

## 5. Where an approved requirement met an existing invariant

The brief asked that these be documented and resolved in the accounting design
before the posting code changed. Three arose, all found by running the engine
rather than by reading it.

**The snapshot basis CHECK.** `agency_transactions_snapshot_basis_agrees` tied
the recorded commission basis to the figures it was derived from, and a
reported commission has neither a rate nor a fixed amount — so every reported
posting was refused. The invariant was complete for three bases; there are now
four, and the fourth asserts its own agreement rather than leaving the columns
unconstrained.

**The transaction guard and a suspended line.** The guard refused every write
against an inactive till, and a reversal is a write. Suspending a compromised
line therefore trapped the float the suspension existed to protect, and the
only route to the money was to un-suspend the compromised line. The two
inactive states are now distinguished: `closed` refuses everything,
`suspended` refuses new business and permits exactly one transition — a posted
transaction becoming reversed. That is the same exemption the readiness guard
already made for a provider switched off after the fact.

**Per-line attribution versus the provider total.** The first version of the
OD-10 split used the per-line receivable alone to decide how much a reversal
could credit back. A Phase 4C settlement into cash names no line, so it clears
receivable the per-line view still counts as outstanding, and the provider
total went to −5,000. Both figures bind, so the lesser of the two decides.

---

## 6. Defects the project's own gates caught

Recorded because the gates are the reason the work is trustworthy, not a
formality.

| Gate | What it caught |
| --- | --- |
| `tests/db/schema.test.ts` — no floating-point or money type | **17 `numeric` columns** in the new views. `sum()` over a `bigint` returns `numeric`, and integer money is ADR-002; every aggregate is now cast back to `bigint` |
| `scripts/check-database-security.mjs` | a grant my own migration had widened to `authenticated` on `agency_commission_outstanding`, which Phase 4C had deliberately revoked; and `agency_commission_recovery_outstanding_by_line` left reachable by `anon` for want of a revoke |
| `tests/db/rls-hoisting.test.ts` | three new policies calling `user_can_see_branch(branch_id)` — correlated *and* SECURITY DEFINER, so two queries against `profiles` **per row**. All three restate the branch rule inline now |
| `tests/db/security.test.ts` — policy roles | the same three policies not scoped `to authenticated` |
| `agency-engine` and `agency-settlement` | the per-line attribution bug above, and three refusal messages my first rewrite of `agency_commission_for` had silently reworded |
| the lock-and-resource matrix | four new posting functions unclassified |
| `tests/integration/migrations.test.ts` | a bare `timestamp` cast in a view, and the generated types out of step with the schema |

### The four the database could not catch, and the browser did

Opening `/agency/money` as a signed-in officer was the first time this phase's
work was looked at through the application. It found four defects in ten
minutes, and not one of them was reachable from a database test, because every
database test runs as the schema owner.

| What was wrong | Why nothing else found it |
| --- | --- |
| Every Mobile Money screen reported "the commission owed to each agent line could not be read". `agency_commission_by_line`, the dashboard and the reconciliation register were built on three SECURITY DEFINER helpers that 000800 and 001200 revoke from `authenticated` — correctly. But these views are `security_invoker = true`, which is the whole point of them, and a function called inside such a view runs as the **caller**, so the revoke was a refusal. Migration 001400 defines the attribution as a view instead, following the precedent Phase 4C set when it met this question with `agency_commission_outstanding` | 123 database tests run as the owner, for whom the grant is irrelevant. `check-database-security.mjs` looks for grants that are too **wide**; this one was too narrow, which is the direction no gate watches |
| The `agency-money` vitest project was declared in `vitest.config.mts` and never added to the `test:db` script CI runs. Its tests ran on a developer's machine and nowhere else — and **three CI runs reported the database job green without executing one of them** | Nothing checks that every declared project is in the script. The comment in `ci.yml` now says what a missing project costs, and the project is eleventh in the sequence |
| Four optional date fields refused an empty input. `businessDateSchema.optional().nullable()` describes a shape no browser sends: an untouched date arrives as `''`, not `null` | `lib/validation/common.ts` already names the idiom `optionalField`, in a comment ending "only the browser suite caught it". It caught it again |
| Every form kept its typed values after a successful submission. Changing the `key` remounts the form and resets the **uncontrolled** fields; the controlled ones are parent state, which the remount does not touch | A unit test calling the action never renders a form twice |

Three database tests now pin the first of those: that an officer can read each
of the seven Phase 4E views, and that the view's per-line figures equal what
the engine's own helpers refuse on — for a line owed commission and a line
owing it back, so neither figure is zero for the wrong reason.

### A finding this phase is not fixing, and why

Writing the cross-branch transfer test meant opening a second branch — the
first time anything in this system has had two — and that exposed a defect in
Phase 4B's branch resolution that one branch could never show.

`create_agency_transaction()` stamps a transaction with the recording
officer's own branch, deliberately: it is never an argument, which is what
stops one branch recording against another's till. But an officer who has no
branch — Head Office, whose `profiles.branch_id` is null, which is both the
Owner and the seeded Secretary — falls through to:

```sql
if v_branch is null then
  select b.id into v_branch from public.branches b
   where b.status = 'active' order by b.branch_code limit 1;
end if;
```

**The alphabetically first active branch.** With one branch that is correct by
accident. With two, a Head Office cashier who names a Head Office till is
refused with "That till belongs to a different branch", because the
transaction was stamped with whichever branch sorts first by code — and which
branch that is depends on a string.

The effect on a real business: as soon as a second branch is opened with a
code sorting before the first, every head-office officer's agency
transactions move to it, and they can post against no other branch's till.
Nothing warns them; the refusal names the till, not the cause.

It is **not fixed here**, for one reason: `create_agency_transaction()` is
shared with Agent Banking, and this workstream was told not to change Agent
Banking posting behaviour. Changing how a null-branch actor's branch is
resolved is exactly that. So it is written down, it is in §8 as a release
condition, and the browser fixture gives its second branch a `Z…` code so
the test exercises cross-branch transfers without provoking an unrelated
defect — the test avoids it rather than papering over it.

What a fix would need to decide, when it is authorised: whether a head-office
officer records against the branch of the till they name, against a branch
they choose explicitly, or not at all. That is a business question about who
may transact where, not a code tidy-up.

And one bug the tests caught that nothing else would have:
`record_agency_float_trade` held the receiving line's branch as `c.branch_id`
inside a `CASE` that would not have chosen it for a purchase or a sale.
PL/pgSQL evaluates every parameter of an `INSERT` before the statement runs,
so the unassigned record raised regardless of the `CASE`, and every
non-transfer trade failed.

---

## 7. The application layer, and what is still not done

### The five screens

| Route | Capability | What it does |
| --- | --- | --- |
| `/agency/money` | `agency:reports` | every provider and branch: float held, commission owed each way, float bought, sold and moved; then every agent line's day. Renders no client component of its own |
| `/agency/money/[providerCode]` | `agency:reports` | one provider: its lines, their float and today's activity, the float-trade form and the register with its verify, refuse and reverse controls |
| `/agency/money/[providerCode]/commission` | `agency:reports`, forms need `agency:settlements` | commission per line, the payout, the recovery, and the calendar-month report |
| `/agency/money/[providerCode]/statements` | `agency:reports`, forms need `agency:reconcile` | the statement-period register, submission and certification |
| `/agency/lines` | `agency:providers` | opening a line, correcting its identifiers, suspending it, closing it, the transaction ceiling and the commission source |

One screen per provider, driven by the provider's own row. MTN and Airtel
differ in their commission source, their fee handling and their ceilings, and
every one of those differences is a column the database already holds; they do
not differ in what the accounting does. Two screens would have been two sets
of figures that could disagree with the ledger — which §4 of the brief asked
us not to build.

Behind them: seven data readers that answer `{ ok: false }` rather than a
figure when a query fails (the Phase 4D-F rule, extended by eight unit tests),
fourteen server actions, sixteen validation schemas, a rate-limit bucket for
float trading, and the `agency:float_trade` capability in the application's
permission matrix.

Three things the screens say out loud, because each is a belief that costs
money when it is wrong:

  * **recording a float trade moves nothing.** Said above the fields, in the
    button, in the success message and in the register's status column. An
    officer who believes the money has moved records it again when the
    balance does not change.
  * **a commission payout arrives as float on the line, not as cash.** An
    officer expecting the drawer to rise will count it as missing.
  * **certifying a statement changes no balance.** Decision OD-2 settled
    that, and a button reading "certify" invites the opposite belief.

Closing an agent line is offered only when `agency_agent_line_obligations()`
— the same function the close refuses on — comes back empty. When that read
fails the button is withheld and the screen says the check could not be made.
It does not say the line is clear.

### The browser coverage

`tests/e2e/specs/agency-money.write.spec.ts`, twelve tests on the real harness:
PostgreSQL with every migration applied from zero, real PostgREST, the
production build. Each test opens its own agent line through the Owner's form
and spends nothing another suite reads as a fixture.

| Test | What it reads back from the database |
| --- | --- |
| a float purchase at a premium | pending: status `pending`, `journal_entry_id` null, the line's ledger balance unmoved, and no decision offered to its own maker. Posted by a Manager: three journal lines, debits equal credits at 205,000, `5970` debited 5,000, the line up exactly 200,000 |
| a suspended agent line | `status = 'suspended'`, `is_active = false`, the reason stored, the float **unchanged**, a purchase into it refused, no row written, and the officer's typed figures still on screen |
| certifying a provider statement | the variance recorded at 7,500, certified by a second officer, the variance still 7,500 afterwards, and `count(*)` over **every journal entry in the books** identical either side of the certification |
| closing an agent line | offered on an empty line, withdrawn once it holds float, with the obligations the screen lists checked against the function's own answer |
| commission paid into an agent line | commission earned through a real counter transaction, then a part payout: exactly two journal lines (1310 credited, the line's float debited), the float up and the receivable down by the same amount, the per-line figure reduced, GL 4510 **unchanged** so no income is recognised twice, a duplicate reference refused with one settlement row still on file, and a payout above the outstanding refused with every balance where the part payment left it |
| a float transfer across two branches | two branches and two lines of one provider: recorded by a cashier and moving nothing; invisible to a Manager at the other branch while their own line is visible; verified by an officer with authority over both, then one journal of two lines, exact source and destination balances, **consolidated float unchanged** with the movement in the transfer columns and in neither the purchase nor the sale total; and a transfer the line cannot cover refused at the point of posting with nothing moved |

`/agency/money/DEMO_AIRTEL` and `/agency/lines` also joined the per-page
performance budget in `performance.spec.ts`, against the same ceilings every
other page is held to.

### What is still not done

| Outstanding | Note |
| --- | --- |
| **The commission recovery has no browser test** | Decision OD-10's clearing side — a float deduction or a commission offset — has 12 database tests with exact journal lines, and the form is covered by the unit and type layers. Driving it through a browser needs a payout **and** a reversal before it, which is the longest fixture in the file; the payout half of that chain is now covered end to end |
| **One unauthorised-branch refusal is asserted at the database, not the browser** | The browser test proves a Manager at the other branch is not shown the trade at all — RLS hides it, so there is no button to press. The function's own refusal when the call is made anyway is `agency-money-float.test.ts`, "refuses a transfer into a branch the officer does not administer", beside "moves float across branches when the officer administers both" |
| **The reported-commission path is configuration, not data** | `commission_source` can be set to `reported` only by the Owner through an audited function. No provider is set to it, because that is a commercial decision (§8) |
| **`requires_approval_above` is still not settable** | Decision L remains open. Unchanged by this phase, and deliberately still read-only |
| **No pull request yet** | None is open for this branch. Every earlier phase ended with a draft PR stacked on the previous one; this one is not opened, because opening it is an integration step and the standing instruction is to stop for independent review first |

---

## 8. Release conditions, unchanged

The integrated release audit's verdict stands, and nothing in this phase
changes it:

- **NO-GO** for real client money.
- The Supabase organisation is on the **free tier**: no managed backups, no
  point-in-time recovery, idle projects pause.
- The production URL is behind **Vercel SSO** with no custom domain.
- **No branch is protected** on GitHub.
- **Lending cash sufficiency** (Decision A) is unresolved: a loan
  disbursement, a savings withdrawal and a benefit payment can still take Cash
  at Hand negative. Untouched by this phase.
- **Provider commercial terms** are unapproved. MTN and Airtel remain
  `is_provisional = true`, `is_active = false`, with `commission_source` left
  at `configured` — setting it to `reported` is the Owner's call through an
  audited function. Nothing can post against either until their terms **and**
  decision OD-11's ceilings are approved.
- The active membership policy on the hosted project is still version
  **999.0, "DEMONSTRATION ONLY"**.
- **Decision L** (approval thresholds) remains open, and
  `requires_approval_above` is deliberately still not settable.
- **Agent Banking** posting behaviour is untouched, pending the client's
  business explanation.
- **A head-office officer's agency transactions are stamped with the
  alphabetically first active branch** when their profile carries no branch.
  Harmless with one branch, wrong with two, and the business has one today.
  This must be decided and fixed before a second branch opens — §6 sets out
  what the decision is. Found by this phase, not introduced by it, and
  deliberately not changed here because the function is shared with Agent
  Banking.

---

## 9. Final acceptance checks

Asked for at the acceptance gate and answered from the live schema of a
database built from the fourteen migrations, not from memory of what was
written.

### The twelve decisions, re-verified

| Decision | Evidence read back from the database |
| --- | --- |
| **OD-1** | `2230=liability/credit, 4580=income/credit, 5970=expense/debit`; 15 shape constraints on `agency_float_trades` |
| **OD-2** | `certify_agency_commission_reconciliation` contains no `post_journal` call anywhere in its body |
| **OD-3** | `verify_agency_float_trade` takes both provider-balance locks through `least()`/`greatest()` on branch id — deterministic whichever direction the transfer runs; `agency_float_trade_transfer_shape` refuses a cross-provider transfer |
| **OD-4** | `agency_float_status_valid`, `agency_float_status_matches_is_active`, `agency_float_inactive_states_reason`, `agency_float_closed_has_date`; `agency_agent_line_obligations()` present; `agency_transaction_guard` distinguishes `suspended` from `closed` |
| **OD-5** | `customer_fee_mode = any(array['deduct_from_payout','collect_separately'])`, and a mode may not be stated without a fee |
| **OD-6** | the sale shape: `fee_amount is not null and >= 0`, a settlement account required, `cash_amount`, `source_kind` and the counter columns all null — a credit sale cannot be expressed |
| **OD-7** | `verified_by is null or verified_by <> created_by`; a pending row must have no journal, no verifier and no reversal; recording needs `agency:float_trade`, verification `agency:settlements` |
| **OD-8** | `agency_commission_payout_reference_unique` on `(float_account_id, provider_statement_ref)`, partial on both being present |
| **OD-9** | `submit_agency_commission_reconciliation` checks for an overlapping period under the provider lock; `agency_commission_monthly` exists as a separate report |
| **OD-10** | `reverse_agency_transaction` references `2230` and splits with `least()`; `method = any(array['float_deduction','commission_offset'])` |
| **OD-11** | `set_agency_service_limit` refuses `null` and `<= 0` — "A service ceiling must be a positive amount" — and needs `agency:providers`; `agency_transaction_live_readiness_guard` reads `max_single_transaction`, so a service without a ceiling cannot go live |
| **OD-12** | `transaction_date date`, `transacted_at timestamptz`, `created_at timestamptz` |

The manually entered commission source is a mechanism and nothing more:
`commission_source = any(array['configured','reported'])`, and every
mobile-money provider is still `configured` —
`AIRTEL_MONEY=configured/active:false`, `MTN_MOMO=configured/active:false`,
with the two demonstration providers active for the harness only. No
commercial term has been set by this phase.

### The database suite does execute `agency-money`

From the database job of run `42779918710`:

```
> vitest run --project db && … && vitest run --project agency-money && …
  ✓ agency-money tests/db/agency-money-foundation.test.ts (54 tests)
  ✓ agency-money tests/db/agency-money-commission.test.ts (37 tests)
  ✓ agency-money tests/db/agency-money-float.test.ts (32 tests)
```

123 tests, in CI, on a cluster built from the migrations. The project is
eleventh in `test:db`; §6 records what its earlier absence cost.

---

## 10. Boundaries honoured

No merge. No production deployment or migration. No hosted financial or
demonstration record read for anything but the audit, and none changed. No
provider activated and no commercial rate invented — the only provider
configuration this phase ships is the *mechanism* for the Owner to state one.
Policy 2.0 not published. No authentication, RLS, financial safeguard or CI
gate weakened: every new grant is narrower than the one it sits beside, every
new policy is `SELECT` only, every write goes through a function that refuses
without its capability before it reads an argument, and five existing gates
were tightened rather than relaxed.
