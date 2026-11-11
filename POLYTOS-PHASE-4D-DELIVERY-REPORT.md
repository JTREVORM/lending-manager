# POLYTOS — Phase 4D delivery report

**Agency Banking & Digital Payments: the operational interface**

Branch `phase4d/agency-banking-interface-2026-11-08`, stacked on PR #25
(`fix/shared-till-concurrency-2026-11-08`). Draft, unmerged, and not deployed.

---

## 1. What this phase was asked for, and what it is

Fourteen operational screens over the Phase 4A–4C agency engine, mobile-first,
in the existing POLYTOS design system, with every financial action going
through a server action that calls a database function. No journal arithmetic
in React. No authorization by hidden button.

It is built. Fourteen feature items across fourteen routes, every control
either wired to a real authorized server action or visibly explained, and the
whole section asserted in a real browser on both a desktop and a phone profile
against a counter that has been trading.

Three things in it are **not** what the brief assumed, and each is stated in
its own section below rather than buried: the commission-exception workflow
needed a database change before it could work at all (§4), verification needed
a second one before maker-checker was real rather than nominal (§3), and
provider configuration is read-only because no authorized write path for it
exists (§7).

---

## 2. The screen inventory: 14 feature items, 14 routes

The two counts match, and the mapping is not one-to-one. One route is a
dashboard the brief did not list as a feature; one feature — transaction-type
settings — has no route of its own, because it is the second half of the
provider configuration screen and splitting it would put a provider's terms on
one page and its limits on another.

| # | Feature item | Route | Ships JS? |
|---|---|---|---|
| 1 | Record an agency transaction | `/agency/record` | yes |
| 2 | Pending verification queue | `/agency/pending` | no |
| 3 | Transaction history | `/agency/history` | no |
| 4 | One transaction in full, with its lifecycle controls | `/agency/history/[transactionId]` | yes |
| 5 | Float and till balances | `/agency/float` | no |
| 6 | Float replenishment | `/agency/float/replenish` | yes |
| 7 | Commission, and recording a remittance received | `/agency/commission` | yes |
| 8 | Provider remittances, and paying one | `/agency/payables` | yes |
| 9 | Physical cash reconciliation | `/agency/reconciliation/cash` | yes |
| 10 | Electronic float reconciliation | `/agency/reconciliation/float` | yes |
| 11 | Agency financial reports | `/agency/reports` | no |
| 12 | End-of-day exceptions | `/agency/exceptions` | no |
| 13 | Provider configuration | `/agency/providers` | no |
| 14 | Transaction-type settings | `/agency/providers` (same screen) | no |
| — | The section dashboard | `/agency` | no |

**Fourteen feature items. Fourteen routes.** Items 13 and 14 share one route;
`/agency` is the fourteenth route and is not one of the fourteen items.

**Seven of the fourteen routes render no client component of their own** —
the dashboard, the pending queue, the transaction history, the float
balances, the reports, the exceptions list and the provider configuration.
Each reads a view and renders a table, so nothing of theirs crosses into the
browser; the other seven take input, and only those do. That is why the whole
section cost 34 KB gzipped.

> **Corrected in Phase 4D-F.** This report, the pull request and the
> bundle-budget comment all said *nine*, and they said it from memory rather
> than from the import graph. The graph says seven, and it is listed above so
> the next reader can check it rather than trust it. "Ships no JavaScript" was
> also the wrong phrase for any of them: every page carries the application
> shell's own client code.

---

## 3. The safeguard this phase added: verification against stale figures

`verify_agency_transaction(uuid)` took only an identifier, so it could not
tell a considered verification from a stale one. Reproduced before fixing:

1. A manager opens the pending verification queue.
2. An Owner authorises a commission exception on one of those rows, changing
   the figure that will post.
3. The manager presses Verify on the screen they already had.

That posted the Owner's figure without the manager ever having seen it.
Maker-checker in form — two people, two capabilities — but not in fact,
because the second person approved something other than what they read.

**The mechanism** (migration `20261113000200`): a `revision` counter on
`agency_transactions`, incremented by a trigger whenever a field that affects
the money changes, and `submitted_revision`, recorded when the transaction is
handed to a second officer. Verification now takes the revision the verifier
reviewed, and two guards refuse a stale posting:

- a caller that quotes a revision must quote the current one;
- a caller that quotes **nothing** is refused as soon as the figures have
  moved after submission — otherwise the protection would bind only callers
  that opted in, which is a statement about the application rather than about
  the database.

Both sit after the idempotent early return, so a retry of an already-posted
transaction still gets its journal back rather than a complaint about a
revision. Asserted with two real PostgreSQL sessions: a retry quoting
revision 1, and one quoting an absurd 999, both return the original journal.

The interface carries the revision through: the transaction screen shows
*Figures version*, the Verify form posts it, and a screen that could not read
one offers no Verify button at all and says to reload — the honest answer,
rather than falling back to the weaker path.

**What this moved.** Two existing engine tests now reload before verifying,
which is the behaviour the safeguard exists to require. One of them asserts
the refusal first, so the workflow records it rather than routing around it.

**The commission-exception surface, verified as asked.** Exactly one
`verify_agency_transaction` and one `authorise_agency_commission_exception`
exist, so no call is ambiguous; the three-argument authorisation still
authorises a figure the recording officer supplied, unchanged and pinned;
EXECUTE is granted to `authenticated` only, and the two new trigger functions
are revoked from every exposed role. The recorder is still refused, revision
or no revision, and nothing is written to the audit log when they try.

---

## 4. Commission: read-only on the form, the Owner's by exception

The standard recording form has **no commission field**. It shows what the
provider's configured terms produce, read-only, computed with the same half-up
integer arithmetic as the database (`((P × bps) + 5000) / 10000`), and passes
`p_commission_supplied = NULL` so the engine computes the figure it will post.

A different figure is the Owner's decision and is taken on the transaction,
through `authorise_agency_commission_exception`, which requires a reason and
checkable external evidence, pins the authorised amount against later drift,
and writes an audit row carrying the figure before, the figure after and what
the terms would have produced.

That workflow did not work when Batch 2 began: the function refused a NULL
supplied amount, so a transaction recorded by the standard form — which
correctly supplies none — could never have an exception authorised against it.
Migration `20261113000100` adds a fourth, defaulted `p_proposed_amount`, and
the three-argument behaviour is unchanged for a transaction whose recorder did
supply a figure. The capability is checked in the database, not only in the
server action.

---

## 5. Server actions and the functions behind them

Seventeen server actions in `lib/agency/actions.ts`, every one of them
`requirePermission` → `checkActorRateLimit` → `parseSafely(schema)` →
`supabase.rpc()` → `mapDatabaseError` → `revalidatePath`. No action computes a
balance, a commission or a variance.

| Action | Capability | Database function |
|---|---|---|
| `recordAgencyTransactionAction` | `agency:write` | `create_agency_transaction` |
| `submitAgencyTransactionAction` | `agency:write` | `submit_agency_transaction` |
| `verifyAgencyTransactionAction` | `agency:verify` | `verify_agency_transaction(uuid, integer)` |
| `returnAgencyTransactionAction` | `agency:verify` | `return_agency_transaction` |
| `cancelAgencyTransactionAction` | `agency:write` | `cancel_agency_transaction` |
| `reverseAgencyTransactionAction` | `agency:reverse` | `reverse_agency_transaction` |
| `correctAgencyReferenceAction` | `agency:correct` | `update_agency_transaction_reference` |
| `authoriseCommissionExceptionAction` | `agency:commission_exception` | `authorise_agency_commission_exception` |
| `recordCommissionSettlementAction` | `agency:settlements` | `record_commission_settlement` |
| `reverseCommissionSettlementAction` | `agency:reverse` | `reverse_commission_settlement` |
| `postPayableSettlementAction` | `agency:settlements` | `post_agency_payable_settlement` |
| `reversePayableSettlementAction` | `agency:reverse` | `reverse_agency_payable_settlement` |
| `postFloatReplenishmentAction` | `agency:settlements` | `post_float_replenishment` |
| `submitCashCountAction` | `agency:reconcile` | `submit_agency_cash_reconciliation` |
| `approveCashCountAction` | `agency:reconcile` | `approve_agency_cash_reconciliation` |
| `submitFloatStatementAction` | `agency:reconcile` | `submit_agency_float_reconciliation` |
| `approveFloatStatementAction` | `agency:reconcile` | `approve_agency_float_reconciliation` |

Reads go through `lib/data/agency.ts`, which reads eleven `security_invoker`
views and the two configuration tables, and never sums anything itself. The
one exception is explicit: the two headline figures on `/agency/reports` are
integer additions of rows the database already produced, stated as such in the
code.

---

## 6. Role and permission matrix, as the database grants it

| Capability | Secretary/Treasurer | Manager | Owner/Admin |
|---|---|---|---|
| `agency:write` — record, submit, cancel | ✅ | ✅ | ✅ |
| `agency:reports` — read every agency screen | ✅ | ✅ | ✅ |
| `agency:verify` — verify and post | — | ✅ | ✅ |
| `agency:reverse` — reverse a posting or a settlement | — | ✅ | ✅ |
| `agency:correct` — correct a provider reference | — | ✅ | ✅ |
| `agency:settlements` — settle, remit, replenish | — | ✅ | ✅ |
| `agency:reconcile` — record and certify a reading | — | ✅ | ✅ |
| `agency:variance_adjustment` — write a difference off | — | — | ✅ |
| `agency:commission_exception` — authorise a different commission | — | — | ✅ |
| `agency:reverse_cross_day` — reverse a prior-day posting | — | — | ✅ |
| `agency:providers` — read provider configuration | — | — | ✅ |

Enforced three times over: `guardPermission` on the route, `requirePermission`
in the server action, and the database function's own `agency_actor(...)`
check, which refuses with SQLSTATE 42501 whatever the interface did. A
borrower holds no `agency:*` capability at all, so every agency view returns
them nothing.

Hiding is never the control. Where an officer may not act, the screen says
whose the action is — asserted in the browser suite for a Secretary on a
transaction awaiting verification, for a Manager on a variance they may not
write off, and for the officer who recorded a reading and therefore may not
certify it.

---

## 7. Provider configuration is read-only, and why

`/agency/providers` shows every registered provider, its commercial terms, its
readiness, and every transaction type with the single-transaction ceiling the
database enforces. Nothing on it can be changed.

That is not an unfinished screen. The database grants `authenticated` nothing
but SELECT on `agency_service_providers` and `agency_transaction_types`, and
**no function exists that writes either** — every other agency write goes
through a SECURITY DEFINER function with a capability check, and these two
have none, because approving a provider's commercial terms is a decision
nobody has taken. Building a write path would mean inventing that approval
workflow and activating providers, which this phase was explicitly told not to
do. So the screen says so, in one sentence, and offers no control that would
fail.

### `requires_approval_above` is shown struck through and marked not enforced

Decision L is unresolved and the posting engine does not read the column. The
screen shows the configured figure — somebody will ask what it does — renders
it struck through, and carries a warning stating plainly that a transaction
above it posts exactly like one below it, and that the protection which does
hold is the maximum, which the database refuses past. No threshold control is
offered and no threshold is invented anywhere in this phase: no Zod schema
carries one, and `lib/validation/agency.ts` says why in its own header.

---

## 8. What the database gained

Six migrations in this phase's lineage, 197 in the repository:

| Migration | What it does |
|---|---|
| `20261111000100_agency_concurrency_closure` | Phase 4C-S: provider lock before account locks on every posting path, both directions |
| `20261112000100_shared_till_account_locking` | Workstream A (PR #25): `post_journal` locks every cash/float account in its lines |
| `20261113000100_agency_commission_exception_amount` | The Owner's proposed amount, so the exception workflow works against the standard form |
| `20261113000200_agency_verification_revision` | The revision guard described in §3 |
| `20261113000300_agency_operational_registers` | Four `security_invoker` registers the operational screens read |

The four registers exist because the Phase 4C views report what is
*outstanding*; none of them lists the records an officer has to *act on*. Each
is a plain join with nothing computed that the database does not already hold.
The two reconciliation registers additionally carry today's balance beside the
recorded one, read from the same `ledger_account_balances` row the approval
function locks and compares, so a screen never offers an Approve button that
is certain to fail — while the refusal itself stays in the database, because
the screen's reading is always a moment older.

Both registers also carry `variance_means` as a column, exactly as
`agency_variance_report` does. The cash and float tables use **opposite**
conventions — a cash variance is the count less the books, a float variance is
the books less the provider — and the first draft of this interface stated the
float one backwards from memory. The seeded figures caught it; carrying the
database's own sentence means a screen cannot state it backwards again.

---

## 8A. Phase 4D-F — what the independent review sent back

Three operational issues, closed on this branch. Each was reproduced before
it was fixed, and each fix is pinned by a test that fails without it.

### F1 — One key per submission, and a database that checks

**The defect.** The recording form minted one idempotency key per *mounted
page*. That is right for a double tap and wrong for the thing a counter
actually does next: serve the following customer. The second submission
carried the first one's key, `create_agency_transaction` returned the first
transaction — correctly, because that is what an idempotency key means — and
the form reported success. The second customer's money was never recorded.

**The database's half** (`20261114000100`). A reused key now has to describe
the same transaction. The service, the amount, the fee, any supplied
commission, the till, the customer's identifier and the provider's reference
are compared against the row that holds the key; if any differs, the call is
refused with a sentence telling the officer to reload and record it again,
and nothing is written. Deliberately not compared: the customer's name and
the description, which are labels on the same transaction, and the
transaction date when the caller passed none — the default is today and a
retry either side of midnight would otherwise be refused for a difference
nobody expressed.

A genuine retry — same arguments, same key — still returns the first
transaction. Both halves are asserted side by side so a future tightening
cannot quietly turn every retry into a refusal.

**The interface's half.** The key is now `mount nonce + attempt`, and the
attempt advances on a confirmed success and on nothing else. Pending: the
button is disabled, so a double tap cannot submit twice. Failed or never
answered: the key is unchanged, so the retry is the same submission asked
again. Succeeded: a new key, and the customer's fields are cleared.

**A second defect found while fixing the first.** React resets an
uncontrolled form after a form action completes, whatever the action
returned — so a submission that failed, or that the counter's connection
never answered, left the officer staring at a blank form with the customer
still in front of them. Every field an officer types is now controlled, kept
through a failure and cleared deliberately on success.

| Before | After |
|---|---|
| Second customer from one open form → first transaction returned, "Recorded" shown | Two transactions, two keys, both in the register |
| Reused key with different details → earlier transaction returned silently | Refused; nothing written; the earlier transaction untouched |
| Reused key, same details → earlier transaction returned | Unchanged — still returns it |
| Failed submission → every typed field wiped | Every field kept; only a success clears them |

Pinned by: `tests/db/agency-transaction-engine.test.ts` (two new tests),
`tests/integration/agency-ui.test.tsx` (four), and
`tests/e2e/specs/agency.write.spec.ts` in a real browser.

### F2 — A failed read is reported, never rendered as a figure

**The defect.** Every reader in `lib/data/agency.ts` answered a failed query
with `[]`. On a register that reads as "nothing yet"; on a screen that totals
a column it reads as `UGX 0`. The sentences the agency screens were capable
of producing from a query that never ran included *"Nothing outstanding. No
unverified transaction, no reconciliation awaiting a second officer, no empty
float till"* — on the screen an officer closes the day from.

This is the same defect Phase 19 found on the lending dashboard, rebuilt from
scratch in a new module.

**The fix.** Every reader returns an outcome: rows, or a failure that says
what could not be read and whether the database *refused* the caller
(`42501` and PostgREST's own codes) or simply could not answer. Row Level
Security is deliberately **not** a third kind: it refuses by returning no
rows rather than by erroring, so "this officer may not see this branch" and
"this branch has nothing" are indistinguishable at this layer — that
distinction is made before the read, by `guardPermission` on the route.
Detecting it afterwards would mean inventing a signal the database does not
send.

Every one of the fourteen screens handles both arms. Where a read drives the
whole page the screen renders its header and the explanation and nothing
else; where reads are independent, one failure leaves a gap that says so and
the rest of the screen stands. No failed read renders a figure, an empty
register or a reassurance.

| Screen | Before, on a failed read | After |
|---|---|---|
| `/agency` | `UGX 0` outstanding, `UGX 0` held, "Nothing outstanding" | Each headline says "Not available. This read failed. It is not zero." |
| `/agency/commission`, `/agency/payables` | `UGX 0` earned, received, outstanding | Header and an explanation; no figure at all |
| `/agency/float` | "No float till is registered" | Header and an explanation |
| `/agency/exceptions` | "Nothing outstanding… no empty float till" | Header and an explanation |
| `/agency/reports` | Four empty tables and two zeros | A panel per failed section; the sections that read still render |
| `/agency/history/[id]` | The not-found page | An explanation — a timed-out query is not a missing transaction |

Pinned by: `tests/unit/agency-read-failures.test.ts` (19 tests over all
fifteen readers) and three browser tests that revoke the signed-in role's
`SELECT` on a view for the length of one page load — a real refusal from the
real database, not a stubbed client.

**A third defect found here.** Every `P0001` the agency engine raises was
being flattened by `mapDatabaseError` into *"That action is not permitted on
this record."* So a manager whose verification was refused because an Owner
had just changed the commission was told they lacked permission. `P0001` is
only ever raised by an explicit `raise exception` — PostgreSQL never raises
it — so in the agency module those sentences now reach the officer as
written. Everything else still goes through the mapper, so a unique
violation or an RLS denial never reaches a user in the database's words.

### F3 — The counter, driven through a browser, verified in the ledger

`tests/e2e/specs/agency.write.spec.ts`: fifteen tests, desktop project only
— which is what the `.write.spec.ts` suffix means in this repository, so no
financial flow runs twice. Every test builds its own transaction, statement
or settlement through the interface; the harness's seeded fixtures are read
by `agency.spec.ts` and never consumed here.

After every financial action it reads the database directly: the journal
entry and its lines, the transaction's status and revision, the audit rows
and who wrote them.

| # | Proof | How it is verified |
|---|---|---|
| 1 | Two customers from one open form are two transactions | Two rows, two amounts, two idempotency keys |
| 2 | A draft is submitted | Status `awaiting_verification`, no journal |
| 3 | A second officer verifies the current revision | Status `posted`, one journal, debits = credits, commission 240 on 20,000 at 1.20% |
| 4 | A stale screen is refused after an Owner authorises an exception | Revision advanced; verification refused; nothing posted |
| 5 | The reload posts exactly once | One journal entry, commission 2,500, audit carries `commission_exception` |
| 6 | The exception needs evidence | Required field; no exception recorded without it |
| 7 | A settlement is recorded and reversed | Row posted with a journal; outstanding falls; reversal adds a contra entry and restores it |
| 8 | Cash reconciliation, maker-checker | A manager counts, is told they may not certify their own, and an Owner certifies |
| 9 | Unauthorized roles are refused | A Secretary is redirected from four write screens and offered no Verify |
| 10 | Balances and registers update | The commission position moves by the settled amount and back on reversal |

**The three workflows the 4D-F review found missing**, added in the same
suite and the same way:

| Workflow | What is verified |
|---|---|
| **Electronic float reconciliation** | An Owner records a statement 3,000 short of the books on a free date; the register and the database agree on a variance of **+3,000** — the books less the provider, the opposite sign to a cash count, which is why both registers carry the database's own sentence about it. Recording moves no money. A second statement for the same till and day is refused with *"That float till has already been reconciled for …"* and writes nothing. The Owner who recorded it is told they may not certify it and is offered no button. A Manager is offered certification and told the difference is the Owner's to write off, because they hold no `agency:variance_adjustment`. Certifying sets `reconciled`, stamps a different officer, writes **no** journal and leaves `variance_written_off` at zero — so the difference is still outstanding, which is where the end-of-day exceptions screen then shows it. |
| **Payable settlement and reversal** | An Owner remits 1,000 of what is held; the row is `posted` with a balanced journal, the provider's outstanding falls by 1,000 and Cash at Hand falls by 1,000. The same receipt reference again is refused with *"… already records receipt reference …"*; more than is held is refused with *"… may not go into net debit"*; neither refusal writes anything. The reversal takes a reason, sets `reversed`, adds a **contra entry distinct from the original**, keeps both, and restores the outstanding figure and the drawer exactly. A Secretary sees the register, no settlement button, no reversal control, and the sentence saying the capability is a manager's. |
| **Float replenishment** | An Owner moves 50,000 from the drawer into the till; the row carries a journal of **exactly two balanced lines**, the till rises by 50,000 and Cash at Hand falls by 50,000. The same provider reference against the same till is refused with *"A replenishment of that float till already records reference …"*, and neither balance moves. A Secretary is redirected away from the screen. |

**Four things this suite had to learn**, each written into it as a comment
so the next person does not relearn them: waiting on a success alert is a
trap, because the alert from the previous customer is still on screen when
the next submission starts; a lifecycle action replaces the control that
carried its message, so the proof is the state, not the sentence; and a
suite that posts against a till another suite reads as a fixture will break
that suite — this one posts against the Airtel demonstration till precisely
because `agency.spec.ts` reads the MTN one; and `getByLabel` matches a
substring, so a `DataTable`'s own `aria-label` ("Provider payables by
provider and branch") collides with a form's ("Provider and branch") and
every such lookup here is `{ exact: true }`.

---

## 8B. The accessibility findings the Phase 4E report raised against this phase

The Phase 4E delivery report recorded three outstanding contrast findings
against Phase 4D components, to be cleaned up here. They were investigated
first, and the honest answer is that **they do not exist.**

### What the finding said, and what is actually in the code

Phase 4E found a real WCAG AA contrast failure in its own new screens:
`text-muted` resolves to `--color-muted`, which `app/globals.css` defines as
`var(--color-surface-sunken)` — the pale grey a sunken panel is *filled*
with. As a text colour it fails AA, and axe failed `/agency/record` over it.
That was fixed in the Phase 4E files.

The same report then named three Phase 4D components as carrying it:

| Component | What it actually uses |
| --- | --- |
| `components/agency/reconciliation-forms.tsx` | `text-text-muted`, nine times |
| `components/agency/commission-exception-form.tsx` | `text-text-muted`, three times |
| `components/agency/lifecycle-controls.tsx` | `text-text-muted`, once |

Every one is the approved token. A search of the whole branch for the bare
class — `grep -rP "(?<![\w-])text-muted(?![\w-])"` over every file — returns
nothing outside git metadata.

**The finding was an artefact of the search that produced it.** It was counted
with `grep -c "text-muted\b"`, and `\b` matches inside `text-text-muted`,
so the counts 9, 3 and 1 were counts of the *correct* token. Having found a
genuine fault in its own files, Phase 4E inferred the neighbours shared it.
They do not, and nothing has been changed in them.

### Confirming AA in both themes, which was already asserted

- **Light**, as rendered: the axe sweep, now including the transaction detail
  screen, 108 tests, zero violations.
- **Dark**, as defined: `tests/unit/colour-contrast.test.ts` reads
  `--color-text-muted` against `--color-surface` from the light *and* the dark
  palette and holds both to the AA floor — "muted text clears AA on the page
  in both modes" — plus a block that checks muted text on every ground it
  lands on: the application shell, the record panel and the sunken surface.
  17 tests, passing.

There is also no dark theme to sweep in a browser. `app/layout.tsx` declares
`colorScheme: 'light'`, nothing in the application sets `data-theme`, and
`globals.css` says so in as many words: the palette is kept, and kept proven,
for the day a deliberate switch ships. A dark-mode browser sweep would be
testing a state no user can reach.

### What was missing, and is now covered

One real gap sat behind the false finding. `SCREENS` is a list of paths, and
the transaction detail screen's path carries a transaction id — so the
densest screen in the module, four panels of small print and tinted
surfaces, was the one screen the sweep had never looked at. Two of the three
named components render **only** there.

`accessibility.spec.ts` now sweeps it in both states that matter:

| State | What renders |
| --- | --- |
| `awaiting_verification` | every panel at once — the commission-exception authorisation, the reference correction and the lifecycle controls. The fullest the screen gets |
| `posted` | the lifecycle controls in their reversal state: a reason field and a destructive button, markup that appears nowhere else |

The ids come from the seeded book rather than being written into the test.
Four new tests — two states on each of the desktop and mobile profiles — and
zero violations, which is the first time these components have been measured
rather than reasoned about.

---

## 9. Evidence

### Database, on a clean PostgreSQL 16 cluster

| Suite | Result |
|---|---|
| `db` (the main database project) | 1923 passed |
| `agency` | 66 passed |
| `agency-engine` | 62 passed |
| `agency-security` | 21 passed |
| `agency-settlement` | 78 passed |
| `shared-till` | 6 passed |
| seed, seed-reuse, seed-member-loans, seed-benefits | 82 passed |
| **Total** | **2238 passed** |

Security scanner clean, with the new signatures and their reasons in
`config/database-security-baseline.json`. Financial arithmetic audit: 244
financial files, no hazard, positive control verified.

### Application

Unit and integration: 2658 passed. Typecheck, lint, format and the production
build clean.

### Browser, against the production build and a trading counter

`tests/e2e/specs/agency.spec.ts` — 33 tests, run on both the desktop and the
mobile profile, 66 in all. Every one of the fifteen screen states renders with
a 200, no error boundary, its own content and a clean console; the figures are
the database's; the commission field is absent; the approval threshold is
marked unenforced; and four role-based access tests point a Secretary, a
Manager and a borrower straight at URLs they may not open.

Accessibility: `tests/e2e/specs/accessibility.spec.ts` sweeps **six** agency
screens for WCAG 2.1 AA with axe — the two reconciliation screens (a checkbox,
a revealed reason field and a submit button inside a table cell), the
nine-column history register, the struck-through money column on the providers
screen, the recording form, and the transaction detail screen in two states
(§8B). 108 passed, zero violations.

Per-page cost: `/agency`, `/agency/record`, `/agency/pending`,
`/agency/reconciliation/cash` and `/agency/reports` joined the budgeted pages
in `tests/e2e/specs/performance.spec.ts`, against unchanged ceilings. Measured
cold on a 390px phone: 167–178 KB of JavaScript, the same band as `/payments`
at 178 KB.

### Screenshots

`scripts/capture-agency-screens.mjs` photographs fifteen screen states at four
viewports (1440, 1366, 820, 390) plus three states only another role can see,
and writes a timing table: **60 screen/viewport pairs**, uploaded by CI as
`polytos-phase-4d-agency-screens`. Slowest screen 204 ms median.

It measures horizontal overflow at every viewport and exits non-zero on a
screen that pushes the page sideways — which is how a real defect was caught:

> **The settlement registers pushed the page 768 px sideways on a phone.** An
> absolutely positioned descendant resolves against its nearest positioned
> ancestor, and without one that is the document. `.sr-only` is absolute, and
> `Label` renders one for a required field — so the hidden "(required)" span
> belonging to the reversal form inside a wide table cell was placed at its
> static position *inside the scrolled table*, a thousand pixels to the right,
> measured against the document. The table scrolled correctly and the whole
> page scrolled with it.
>
> Fixed in `DataTable` by making the scroll area a containing block, not in
> the two registers: any table that ever holds a required field would hit it
> again. Every one of the 60 pairs now reports zero overflow.

### Continuous integration

All four mandatory jobs pass at **`20e6fcd`**, CI run
[42613096813](https://github.com/JTREVORM/lending-manager/actions/runs/42613096813),
green on the first attempt:

| Job | Result |
|---|---|
| `checks, unit/integration, build` | ✅ — typecheck, lint, format, 2658 tests, money audit, secret scan, dependency audit, production build, bundle assertions |
| `database (real PostgreSQL)` | ✅ — security gate, 2238 database tests, the upgrade verifier, the financial reconciliation certification |
| `browser E2E (production build, fresh seed)` | ✅ — the whole browser suite on a fresh seed, both screenshot captures, both artifacts uploaded |
| `security release rehearsal (PostgreSQL 17, real Auth)` | ✅ |

`Supabase Preview` is skipped, which is the evidence that nothing reached the
hosted project.

Phase 4D's own certification was at `87ec0f6`, CI run
[42511315927](https://github.com/JTREVORM/lending-manager/actions/runs/42511315927).

Things worth stating rather than hiding:

- The rehearsal job could not install PostgreSQL 17 on four runs out of
  five: apt refused the PGDG repository as unsigned, failing to load the
  ASCII-armoured keyring the step had written an hour earlier without
  trouble. A re-run passed once, which is how it was first taken for a
  flake; it is not one. The step now dearmours the key into a binary
  keyring, which is what the PostgreSQL project's own instructions use and
  what every apt version reads the same way. Infrastructure, not this phase,
  and changed only because a gate that fails four times in five is not a
  gate.
- A local full-suite run showed eight write-spec failures that CI does not.
  They are fixture exhaustion: those specs approve a claim, pay it, mark a
  register — each a one-shot seeded fixture — and the local stack had been
  reused across several partial runs. CI seeds fresh, which is why its run is
  the one that counts.

- **The upgrade verifier failed twice on its own bookkeeping.** It splits
  the migrations into the released schema and the unreleased phases by a
  hand-kept list of date prefixes, and a new migration was added without it
  in Phase 4D and again in 4D-F. Both times the symptom appeared three steps
  later with nothing in the message about the list. The list now checks
  itself: a migration dated after the newest unreleased one cannot already be
  in production, and the verifier refuses to run and names the files.
  Verified by injecting a probe migration dated 2999, which makes it exit 1.
- **Two CI jobs download a release binary, and GitHub's release endpoint
  returned 504 for about half an hour.** The PostgREST download was using
  `curl -sSL` without `-f`, which does not fail on an HTTP error: it wrote
  the error page to the file, and the job reported `tar: This does not look
  like a tar archive`. It now fails on the error, retries, and checks the
  archive against a pinned sha256 — so the message names the download. The
  outage itself was waited out; nothing in the repository could fix a 504.

The browser suite on that run covers 1005 tests, `agency.write.spec.ts`'s
fifteen among them. The Phase 4D-F certification before the three added
workflows was `75d4726`, CI run
[42583163817](https://github.com/JTREVORM/lending-manager/actions/runs/42583163817).

The only commit after `20e6fcd` is this report, which changes no code.

### Demonstration data

The harness seed builds a counter that has been trading: three obviously
synthetic providers prefixed `DEMO_`, a funded float, eight posted
transactions, one awaiting verification, one draft, one reversed, one carrying
an Owner-authorised commission exception verified at its new revision, a
commission remittance received, a remittance paid, a certified cash count
2,000 short and a float statement 4,000 adrift awaiting a second officer.

The nine providers Phase 4A registered are **untouched** — still provisional,
still inactive, because nobody has approved their commercial terms. No
registered provider is activated anywhere, and `scripts/seed-demo.ts`, which
can be pointed at a hosted project, seeds none of this.

---

## 10. The bundle budget, raised once with its case

635 → 670 KB gzipped, for the measured 665. The case is written out in
`tests/integration/bundle.test.ts` beside the four raises before it:

- no new dependency; `package.json` untouched and the 120 KB largest-chunk
  ceiling unchanged — the largest chunk *fell*, 72 KB to 71 KB;
- 97 chunks became 104: seven chunks for fourteen screens, because nine of
  them ship nothing;
- just under five kilobytes a chunk, which is what a form costs;
- what a page costs did not move, and five agency routes are now under the
  per-page browser budget — raising a total without that would be raising it
  on trust.

---

## 11. Outstanding decisions and release blockers

### Release blocker — lending cash sufficiency (unresolved, carried forward)

The lending posting paths do not refuse a payment that would take Cash at Hand
negative. Workstream A (PR #25) closed the *concurrency* half of this — every
cash and float account a journal touches is now locked before it is written,
in both directions — but the *policy* half is untouched: nobody has decided
whether a till may go negative, and if not, what happens at the counter when
it would. This is a policy decision, not a UI one, and it stays open.

### Decision L — `requires_approval_above` (unresolved)

Configured, not enforced, and now visibly marked as such on the provider
screen. Whether a threshold should gate verification, at what figure, and
whose approval it needs are all open. Nothing in this phase invents an answer.

### Provider activation (deliberately not done)

Nine registered providers remain provisional and inactive. Activating one
needs their commercial terms approved and a write path that does not exist.

### Policy 2.0 (not activated)

Untouched by this phase.

---

## 12. What this phase did not do

No merge. No production deployment. No provider activation. No Policy 2.0
activation. No demo data deleted. The `Supabase Preview` job is skipped, which
is the evidence that nothing reached the hosted project.
