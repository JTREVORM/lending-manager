# Reporting

Phase 8: dashboards, reports, the client portal and the Manager remarks
integration. Every figure on every screen in this document is **read** from
somewhere that already decided it. Nothing here calculates money.

That is the single rule the phase is built on, and the reason for it is not
tidiness. A dashboard that worked out its own total would be a second answer
to a question the ledger has already answered, and the first time the two
disagreed, nobody could tell which was wrong — which is worse than having no
dashboard, because a wrong figure that looks authoritative gets acted on. See
ADR-037.

## Contents

- [What each figure means](#what-each-figure-means)
- [The terminology this system will not use](#the-terminology-this-system-will-not-use)
- [Who sees what](#who-sees-what)
- [The dashboards](#the-dashboards)
- [The reports](#the-reports)
- [Filters, paging and date ranges](#filters-paging-and-date-ranges)
- [Exports](#exports)
- [Printing](#printing)
- [The client statement](#the-client-statement)
- [The client portal](#the-client-portal)
- [Manager remarks](#manager-remarks)
- [The reporting views](#the-reporting-views)
- [Row Level Security](#row-level-security)
- [Performance](#performance)
- [Phase 9 handoff](#phase-9-handoff)

## What each figure means

Every metric Phase 8 displays is defined once, in
`METRIC_DEFINITIONS` in `lib/domain/reporting.ts`. The cards render the
definition on screen — a definition nobody can see is a definition nobody
agrees on — and the table below is the same text. A test asserts that every
metric in the code appears here, so the two cannot drift.

| Key | Label | Definition | Source |
| --- | --- | --- | --- |
| `total_clients` | Clients | Every client record, whatever its status. | `clients` |
| `active_clients` | Active clients | Client records whose status is 'active'. | `clients.status` |
| `clients_with_active_loan` | Clients borrowing | Clients with at least one loan currently in the active state. | `loans.status` |
| `loans_active` | Active loans | Loans whose lifecycle status is 'active' — disbursed and not yet settled. A penalised loan is still an active loan. | `loans.status` |
| `loans_cleared` | Cleared loans | Loans whose lifecycle status is 'cleared', which the database permits only when the contract and any penalty are fully paid. | `loans.status` |
| `principal_disbursed` | Principal disbursed | Sum of the principal of every loan actually paid out, settled loans included. Measured by the disbursement timestamp, not the current status. | `loans.principal_amount where disbursed_at is not null` |
| `contractual_interest` | Interest charged | Sum of the contractual interest agreed on every disbursed loan. What was charged, not what has been received. | `loans.total_interest where disbursed_at is not null` |
| `total_collected` | Total collected | Money actually received: the amount of every posted payment, excluding reversals. Never a sum of scheduled amounts. | `loan_balances.total_collected` |
| `principal_collected` | Principal collected | The principal component of posted payment allocations. Derived from the allocations, not apportioned by a ratio. | `loan_balances.principal_paid` |
| `interest_collected` | Interest collected | The interest component of posted payment allocations. Different from interest charged, and never called profit. | `loan_balances.interest_paid` |
| `penalty_collected` | Penalty collected | The penalty component of posted payment allocations. Money received against late-payment charges. | `loan_balances.penalty_paid` |
| `total_outstanding` | Outstanding portfolio | What borrowers owe in total: the uncovered contractual schedule plus unpaid penalties. | `loan_balances.total_outstanding` |
| `contractual_outstanding` | Contract outstanding | The uncovered part of the agreed repayment schedules. Excludes penalties. | `loan_balances.contractual_outstanding` |
| `penalty_assessed` | Penalties charged | Late-payment charges raised against borrowers. A charge, not cash received. | `loan_balances.penalty_assessed` |
| `penalty_outstanding` | Penalties unpaid | The part of raised late-payment charges that remains unpaid. | `loan_balances.penalty_remaining` |
| `arrears_total` | Arrears | Uncovered scheduled collections whose due date has already passed, across every loan. | `loan_delinquency.arrears_amount` |
| `loans_with_arrears` | Loans in arrears | Loans with any past-due uncovered collection. Overlaps the grace and penalty counts, because a penalised loan usually has arrears too. | `loan_delinquency.arrears_amount > 0` |
| `loans_state_grace_period` | In grace period | Loans past their final collection date, still inside the grace period the loan was approved under, and still owing. | `loan_delinquency.delinquency_state = 'grace_period'` |
| `loans_penalised` | Penalised loans | Loans with a late-payment charge recorded against them. | `loan_delinquency.penalty_applied` |
| `loans_penalty_pending` | Penalty pending | Loans past the penalty date whose charge has not been written to the ledger yet. It is raised by the next transaction that touches the loan; reading a report never raises it. | `loan_delinquency.penalty_eligible` |
| `expected_today` | Expected today | Today's scheduled collections less whatever earlier payments had already covered of them — the day's target as it stood this morning. A collection paid ahead is not expected again. | `collections_today.expected_today` |
| `collected_today` | Collected today | Posted payments received today in the business timezone, reversals excluded. Includes money applied to arrears or to future collections. | `dashboard_collection_summary.collected_today` |
| `remaining_today` | Still due today | The uncovered part of today's scheduled collections, right now. Not expected minus collected: a payment today may settle an older collection instead. | `loan_delinquency.due_today_amount` |
| `clients_due_today` | Clients due today | Distinct borrowers with a collection due today that was not already covered before today. | `collections_today` |
| `cash_received` | Cash received | Cash payments posted today. Money received by that method — not cash at hand, which this system does not track. | `payment_register where payment_method = 'cash'` |
| `mtn_received` | MTN received | MTN Mobile Money payments posted today. Not a wallet balance. | `payment_register where payment_method = 'mtn_mobile_money'` |
| `airtel_received` | Airtel received | Airtel Money payments posted today. Not a wallet balance. | `payment_register where payment_method = 'airtel_money'` |
| `reversed_today_amount` | Reversed today | Payments withdrawn today, by the date of the reversal rather than of the payment. Excluded from every collection total. | `payment_register where status = reversed` |

### Three further definitions the screens rely on

**Active loans** are loans whose *lifecycle* status is `active` — disbursed and
not settled. **Cleared loans** are loans whose lifecycle status is `cleared`,
which the database permits only when the contract and any charge are fully
paid, so the state machine is the definition and no report infers it from a
zero balance (§14).

**Overdue** has exactly one definition in this system, Phase 7's. Arrears, days
past due, missed collections and the seven delinquency states all come from
`loan_delinquency`; Phase 8 adds no second rule and
`tests/db/reporting-parity.test.ts` asserts the loan register repeats the
delinquency view column for column (§15).

**Collection rate** is deliberately **not** implemented. §113 offers
`collected_due / scheduled_due` and asks for the period and denominator to be
exact. They are not obvious here: a borrower who pays ahead makes the
numerator exceed the denominator, and a loan disbursed mid-period has no full
denominator at all. A percentage that is wrong in those two ordinary cases
would be quoted anyway, so the figures it would be built from are shown
instead and the ratio is left to Phase 9 or later, with a business definition
behind it.

## The terminology this system will not use

Three words appear nowhere in Phase 8, and their absence is enforced by tests.

**Profit.** Interest collected is interest collected. The system records no
staff costs, no bad debt, no cost of capital and no tax, so a figure labelled
profit would be an accounting claim it cannot support. The executive summary
says so out loud: *"Neither is profit — this system records no costs, so it
cannot tell you what the business earned."*

**Cash at hand.** `cash_received` is cash that came in today. The business also
spends and banks money, and this system records neither, so there is no cash
position to report. The labels say *received* and the definitions say *not cash
at hand*.

**Wallet balance.** Likewise for the mobile money figures: MTN received and
Airtel received are payments, not balances.

And one distinction that is not a word but a column: **assessed is not
collected.** `penalty_assessed` is a charge raised against a borrower;
`penalty_collected` is money in the door. They are separate cards everywhere
they appear, because booking the first as income would recognise money that
may never arrive (§65).

## Who sees what

Three reporting capabilities, split by what the figures reveal rather than by
which screen they appear on. See ADR-038.

| Capability | Secretary/Treasurer | Manager | Owner/Admin | Borrower |
| --- | --- | --- | --- | --- |
| `reports:view_operational` | ✅ | ✅ | ✅ | — |
| `reports:view_financial` | — | ✅ | ✅ | — |
| `reports:view_sensitive` | — | — | ✅ | — |

A report also requires the capability for the data it renders. The listing is a
conjunction, not a disjunction:

| Report | Capabilities required (all of them) |
| --- | --- |
| Collections | `reports:view_operational` + `payments:view` |
| Arrears | `reports:view_operational` + `delinquency:view` |
| Grace period | `reports:view_operational` + `delinquency:view` |
| Clients | `reports:view_operational` + `clients:view` |
| Loan portfolio | `reports:view_financial` + `loans:view` |
| Late-payment charges | `reports:view_financial` + `penalties:view` |

So these three capabilities widen nobody's access to a record they could not
already open one at a time. A borrower holds none of them: their own statement
is not a report, it is their account, reached through `portal:view` and the
ownership clauses in the policies.

There is no `reports:create`, `reports:schedule` or `reports:export`.

## The dashboards

One page, composed from the caller's capabilities. There is no
`OwnerDashboard`/`ManagerDashboard`/`SecretaryDashboard` trio: three
near-identical files would be three places to fix a wrong figure and one place
somebody would forget. Each section declares what it needs, the page renders
the sections the caller holds, and a caller without a capability never triggers
the query behind it — the data is not fetched and then hidden in the markup,
which is the mistake that turns a presentation decision into a leak.

### Owner/Administrator

* **Business summary** — principal disbursed, total collected, outstanding
  portfolio, clients; then charged against collected: principal collected,
  interest charged, interest collected, penalty collected with penalties
  charged beside it.
* **Today** — expected, collected, still due, reversed, and the method split.
* **The loan book** — active and cleared counts, outstanding portfolio split
  into contract and charges, arrears; the seven mutually exclusive delinquency
  statuses; charges raised, unpaid and pending.
* **Due today** — the collection sheet, with a link to the full overdue list.
* **Recent payments**, **the next seven days**, and three activity panels:
  recently paid out, recently settled, recently charged.

### Manager

The loan book, today with the method split, the collection sheet, recent
payments and the next seven days. **No business summary**:
`reports:view_sensitive` is the Owner's, and supervising lending does not
require knowing what the business earns (§44, §42).

### Secretary/Treasurer

Today with the method split, the collection sheet, the next seven days, recent
payments, and the quick actions — record a payment, find a client, register a
client, open the reports. **No portfolio-wide outstanding, no interest
figures.**

### Borrower

Never this page. They hold `portal:view`, not `dashboard:view`, and the route
guard sends them to the portal.

### What a dashboard read does not do

It does not write. A loan past its grace deadline is counted as *penalty
pending* with a projected amount; the charge is written by the next transaction
that touches the loan. Phase 7 made reads side-effect free and
`tests/db/reporting-views.test.ts` loads every reporting view fifteen times
against an eligible loan and asserts the penalty table is still empty (§108).

## The reports

| Report | Route | What it answers |
| --- | --- | --- |
| Collections | `/reports/collections` | What came in over a date range, by day, week and month, by method, with the components collected |
| Loan portfolio | `/reports/loans` | Every loan with its contract, what has been paid, what is outstanding and its two statuses |
| Arrears | `/reports/arrears` | Who is behind, by how much, how late, and the latest note on them |
| Grace period | `/reports/grace` | Who can still settle with no charge, and by when |
| Late-payment charges | `/reports/penalties` | Every charge raised, with its own arithmetic |
| Clients | `/reports/clients` | The directory with each borrower's outstanding and status |
| Statement | `/loans/{id}/statement` | One loan, complete: agreement, plan, payments, balance |

**Active loans** and **cleared loans** are the portfolio report under a status
filter, with the disbursement and clearance dates as columns — the same rows
and the same totals, which is why they are one page rather than three
near-copies (§26, §27).

### Deliberately deferred

* **Charts** (§55, optional). The day, week and month breakdown *tables* answer
  the same questions with guaranteed parity: they are computed from the same
  array as the totals and the row list, so they cannot disagree. A chart would
  add a fourth rendering to keep in step for no information gain.
* **Collection rate and recovery rate** (§113, §114) — see above.
* **As-at historical balances** (§106). Reports are current; date ranges select
  *which rows* appear, never a historical balance, and every page says "as at
  today" rather than implying a snapshot.
* **PDF and Excel export** (§53). CSV is built; the browser's own print view
  covers the printable case.

### Reversed payments

Listed everywhere, counted nowhere. A reversal stays in the table with its
amount struck through and its reason, and every total sums `effective_amount`,
which the database sets to zero once a payment is withdrawn. Hiding the row
would make a reversal look like a payment that never happened; counting it
would make withdrawn money look collected (§107, §131).

Where a gross figure is useful it is labelled as what it is — *"recorded,
including reversed"* — and it appears only when something in the range was
actually reversed.

## Filters, paging and date ranges

Periods are `today`, `this week` (Monday to Sunday), `this month`, `this year`
and a custom range. Defaults follow §50: collections open on **today**; the
portfolio, arrears, grace and charges open on the **current position** with no
date filter at all, because a portfolio question is about now.

"Today" always comes from `business_date()` on the company's configured
timezone — never the browser's clock, never the server's. At 23:30 UTC it is
already tomorrow in Kampala, and a report that disagreed with the ledger about
which day it is would disagree about which payments belong in it.

A reversed custom range is **refused with a sentence**, and the default range
is shown instead, labelled. Swapping the dates would answer a different
question from the one asked; showing nothing would look like a day with no
takings. A range longer than five years is refused the same way, so a mistyped
year cannot ask the database for everything.

Paging is Previous/Next with no total page count: an exact count means a second
aggregate over the whole filtered set on every page view, and knowing there are
47 pages helps nobody. "Is there another page" is answered by fetching one row
more than the page needs.

### Filter security

Every filter is a whitelist, checked before it reaches a query:

* statuses, delinquency states, payment methods, collection statuses and sort
  keys are tested against the vocabulary the screen offers;
* identifiers are shape-checked, so `?clientId=anything` filters on nothing
  rather than producing a database error;
* free-text search is reduced to the characters a name, number or reference
  contains.

That last one matters more than it looks. The search term is concatenated into
PostgREST's filter syntax — `payment_number.ilike.%x%,client_name.ilike.%x%` —
where a comma, a dot or a parenthesis is punctuation rather than data. A term
reaching that unchecked would not be *escaped* into the expression, it would be
*parsed* as part of it. Hence a whitelist rather than an escape, plus the query
builder's parameterisation beneath it, plus Row Level Security beneath that.
`tests/unit/report-filters.test.ts` and `tests/unit/reporting.test.ts` cover
the first two layers; `tests/db/rls-reports.test.ts` covers the third.

An unusable *filter* is dropped and the unfiltered report is shown, which is a
reasonable reading of a hand-edited URL. An unusable *date range* is reported,
because showing a different range from the one asked for would misstate what
the figures cover. Neither ever produces a database error, let alone one shown
to a user (§83).

## Exports

CSV, one route per report, each repeating its page's capability check —
because a download is a separate request to a URL that can be typed, copied or
kept after a role changes. Hiding the link is presentation; the handler is the
control.

The file contains **every matching row**, not the page somebody was on, and the
same filters the screen had. Three properties matter:

**No formula executes.** A cell beginning `=`, `+`, `-`, `@`, tab or carriage
return is a formula to a spreadsheet, and a client name is text somebody typed.
Every text cell is disarmed with a leading apostrophe — the content survives, a
client genuinely called `=Mukasa` still appears as `=Mukasa`, it simply cannot
run. The check looks at the first **non-space** character, because some
spreadsheet versions strip leading whitespace before deciding.

**No number is disarmed.** Money and counts go through a numeric formatter that
emits plain digits. Prefixing a number would corrupt a figure to defend against
an attack numbers cannot carry, and a column of `'50000` cannot be totalled by
the person who asked for the file. The currency lives in the column heading.

**No identification number, in any report.** Not behind a capability, not as a
column somebody can hide. A NIN is read one record at a time by somebody with a
reason to look at that record; a file of them outlives every access control this
application has (§76).

Files are UTF-8 with a byte-order mark and CRLF endings, so a name like
Nakimuli Zaïnabu opens correctly rather than as mojibake. Commas, quotes and
newlines in free text are quoted or flattened so one record stays one row. The
response is `attachment` with `nosniff` and `no-store`.

The cap is 5,000 rows. A filtered set that hits it keeps its rows and **loses
its totals**, with an explanation: a partial total presented as a total is
worse than no total, because it is a figure somebody would circulate (ADR-042).

## Printing

The browser's own print view, against print styles, rather than a server-side
PDF pipeline. Navigation, filter bars, pagination and action buttons carry
`print:hidden`; backgrounds drop to white so a dark-mode viewer does not print
a page of ink; table headers repeat on each page and rows do not split across
one; the stacked mobile rendering is hidden so rows are not duplicated.

Status badges print correctly because every badge in this application states
its meaning in words as well as in colour — a rule from Phase 1 that pays off
here.

## The client statement

`/loans/{id}/statement` for staff, `/portal/loans/{id}` for the borrower. Four
sections, one page, printable:

1. **Borrower** — name, client number and phone **as recorded when the loan was
   written**, with the current name beside it when they differ, and a sentence
   explaining why. See ADR-041.
2. **The loan** — amount borrowed, total interest, total to repay, the date the
   money was given, the loan completion date, the number of payments.
3. **Where the loan stands** — amount paid, outstanding on the loan,
   late-payment charge unpaid, outstanding balance, past unpaid amount, current
   amount due; and the two relationships between them stated in words.
4. **Payment plan** and **payments received**, each payment showing what it was
   applied to, with withdrawn payments struck through and a line explaining why
   they are still listed.

A charge, where one exists, is explained with its own arithmetic: *"It is 50%
of the UGX 400,000 that was still owed when the grace period ended on 4 Oct
2026."* A borrower can check the rule from their own statement without anybody
explaining it.

The statement mutates nothing — three reads, no writes, no penalty
materialisation. The borrower's copy additionally shows no staff attribution
and no links into the staff register; neither copy shows an internal remark, a
guarantor's details or an identification number.

## The client portal

What a borrower sees of their own account:

* **Their record** — client number, phone, occupation, location, registration
  date, photograph.
* **Each current loan** — the Phase 7 position panel (what is due now, itemised
  into past unpaid and due today; what remains; what was missed and how late;
  grace and charge wording) plus, new in Phase 8, **what they agreed**: amount
  borrowed, total interest, total to repay, amount paid so far, next payment
  date, loan completion date, and any late-payment charge.
* **Loans they have finished paying**, as their own section. A settled loan
  among live ones invites a borrower to think they still owe something;
  removing it entirely would look as though the business had forgotten they
  ever paid (§74).
* **A full statement** per loan, printable, with the payment plan and every
  receipt.
* **Payments they have made**, with receipt numbers, withdrawn ones labelled.

The labels are the borrower's: Amount borrowed, Total interest, Amount paid,
Outstanding balance, Current amount due, Past unpaid amount, Late-payment
charge, Loan completion date. A test asserts the portal contains none of
`principal`, `obligation`, `allocation`, `basis point`, `delinquency`,
`coverage`, `ledger` or `security_invoker` (§11).

What a borrower never sees: another borrower's anything, internal remarks,
staff attribution, guarantor details beyond Phase 3's approval, identification
numbers, or audit records. Each is asserted by a regression test rather than
assumed — a note written for internal use appearing in a borrower's own account
would be the worst leak this system could have (§39).

## Manager remarks

Phase 3's `client_remarks` table, reused. There is no second remarks store and
no second write path.

* The **arrears report** shows the latest note per borrower — body, category,
  author and time — for a caller who holds `clients:remarks_view`. Without it
  the column is **omitted entirely** rather than rendered empty, because a
  header with blank cells would imply there were no notes.
* "Add a note" and "All notes" link to `/clients/{id}#remarks`, where the Phase
  3 component lives with its own permission check and its append-only
  guarantees. The report has no form, no textarea and no submit control, which
  a test asserts (§104).
* The **client record** shows the full timeline, unchanged: newest first,
  retractions beneath the remark they withdraw, originals struck through rather
  than hidden.

Permissions are Phase 3's, unweakened: Manager and Owner may add
(`clients:remarks_create`), Secretary/Treasurer may read only
(`clients:remarks_view`), and a borrower sees none (§37, §38).

Phase 3's five categories — general, payment concern, contact, business,
retraction — are reused as they stand. §35 lists example remark *content*
("promise to pay", "guarantor contacted", "client unavailable"), which those
categories carry as text; widening a CHECK constraint on financial history for
a labelling preference is not a trade worth making, so it was not made.

## The reporting views

Five, all `security_invoker`, all SELECT-only, none materialised.

| View | Shape | What it is for |
| --- | --- | --- |
| `payment_register` | One row per payment | Every collection report, the method split, "collected today" on three dashboards |
| `collections_today` | One row per loan due today | The collection sheet, and the day's target |
| `loan_portfolio_report` | One row per loan | The portfolio, active, cleared, arrears and grace reports, and statements |
| `dashboard_portfolio_summary` | One row | The business-wide figures |
| `dashboard_collection_summary` | One row | Today: target, received, method split, components |

They aggregate and join; they do not calculate. `payment_register` splits gross
from effective so a reversal is excluded from every total without each call
site remembering to filter. `collections_today` carries the one genuinely new
quantity in the phase, `expected_today` (ADR-040). The two summaries aggregate
the views above them, so a card and the detail beneath it cannot disagree.

`client_statement_view` was considered and not built: a statement is a header,
a schedule, a payment list and a balance — four shapes one view cannot express
— so it is composed in the data layer from `loan_portfolio_report`,
`loan_installment_coverage`, `payment_register` and `loan_penalty_coverage`.
§46 asks for views only where they add clarity; a fifth that needed unpacking
would not.

## Row Level Security

Every reporting view sets `security_invoker = true`, so each is read under the
caller's own policies and needs no policy of its own. Every privilege is
revoked from `public`, `anon` and `authenticated` before SELECT is granted back
to `authenticated` — Supabase's default privileges make the explicit revoke
necessary, as Phase 6 found out.

No reporting view is materialised and none is `SECURITY DEFINER`. Both would be
owned data with no caller to be read on behalf of, which Row Level Security
cannot apply to at all (ADR-039).

No module in the reporting layer uses the privileged client. A report is
business-wide only because the caller is entitled to every row in it, which is
why the same export route is safe for a Secretary/Treasurer and an Owner: the
code is identical and the files are different lengths. A source-level test
asserts the absence across every report page, export route and data module
(§94, §95).

The attacks tried, and their results, are in the Phase 8 table in
[SECURITY.md](SECURITY.md).

## Performance

Profiled at ten times this business's expected scale — 500 loans, 15,000
collections, 5,000 payments, 11,000 allocations:

| Query | Median |
| --- | --- |
| `dashboard_portfolio_summary` | 61 ms |
| `dashboard_collection_summary` | 104 ms |
| `collections_today`, one page | 5 ms |
| `payment_register`, one month | 67 ms |
| `payment_register`, one loan | 6 ms |
| `loan_portfolio_report`, one page | 24–48 ms |
| `loan_portfolio_report`, one loan | 18 ms |

**No index was added.** Every report either uses an index that already exists
or scans a table small enough that scanning is the correct plan. §101 asks for
existing indexes to be considered first, and they were sufficient.

One measured change was worth making: the collection report filters on
`received_at` rather than on `business_date`. `business_date` is
`payment_business_date(received_at)`, which reads the company timezone and is
therefore STABLE rather than IMMUTABLE — it **cannot be indexed at all**, and
filtering on it costs a function call per row with no selectivity estimate.
Measured: 65 ms against 2 ms. The two filters are exactly equivalent, because a
business date range *is* an instant range in the business timezone.

No N+1 anywhere. Where a view carries no foreign key for PostgREST to embed
through, the labels come from one extra query keyed on the ids already
read — never one query per row. The client report reads the matching clients,
then every loan belonging to them in a single `in (...)`.

If the ledger grows by an order of magnitude the cost will be the allocation
aggregation in `payment_register`, not the date filter, and the remedy is a
covering index on `payment_allocations`. A materialised view remains the last
resort rather than the first, for the reason in ADR-039.

## Phase 9 handoff

Phase 9 is PWA, UX, security hardening and reliability. What Phase 8 leaves it:

1. **A complete application surface.** Every role has its screens: dashboard,
   clients, guarantors, loans, schedules, payments, overdue, reports, audit,
   settings, users, account, portal. There is no missing operational module to
   build around.
2. **A stable financial source.** Phases 4–7 are untouched by Phase 8 — the
   upgrade is fingerprint-identical on loans, schedules, periods, payments,
   allocations, charges, balances, snapshots and the audit trail. Phase 9 can
   harden without a moving target underneath it.
3. **One route map, one navigation definition, one capability matrix.** All
   three read the same table, and a test asserts the menu and the guard agree
   — the defect this project has been told about three times.
4. **Read-only reporting.** Nothing under `/reports` writes. No route handler
   exports POST, PUT, PATCH or DELETE, which a test asserts, so the reporting
   surface adds no attack surface for Phase 9 to review.
5. **Print styles in place**, so a PWA's offline and installed modes inherit a
   page that already prints correctly.
6. **Measured query costs**, above, as the baseline for any Phase 9
   performance work — rather than an opinion about what might be slow.

What Phase 9 should expect to do in this area: service-worker caching that does
**not** cache financial figures (every report is current by design), rate
limiting on the export routes, and a decision about collection rate with a
business definition behind it.
