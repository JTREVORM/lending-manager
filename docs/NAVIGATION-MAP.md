# Navigation route map

The staff rail's structure, and where every entry in it goes.

Written down because most of the rail is **filtered views of screens that
already read those filters** rather than pages of its own. That is deliberate:
a label does not earn a route. `Awaiting Disbursement` is the loan register at
`?stage=awaiting_disbursement`, which Phase 13 already serves from one query;
`Promise to Pay` is Debt & Security at `?view=promises`, which Phase 14
already reads back server-side so only that register is fetched.

Source of truth: `components/layout/nav-items.ts`.
Asserted by: `tests/integration/navigation.test.tsx`,
`tests/e2e/specs/navigation.spec.ts`.

---

## Rules the rail obeys

1. **One href per entry, and no href twice.** Two rows on one destination
   would both claim to be the open page.
2. **`permission` is the route's own capability**, taken from the same map
   (`lib/auth/routing.ts`) the route guard reads. A parity test asserts they
   agree, on the path — a query string is a filter, not a permission.
3. **`requires` is anything the destination guards on top of that.**
   `/loans/new` guards `loans:create`; `/reports/penalties` guards
   `reports:view_financial` and `penalties:view`. Neither is the protection:
   the pages guard themselves and Row Level Security refuses the rows.
4. **A pinned query parameter must be one the destination reads.** A filter
   the page ignores is an entry that can never light up as the open page.
5. **A module with nothing visible in it is not rendered.**
6. **`prefetch: false` on a destination that is expensive to render.** Phase
   14's rule, and it still holds: prefetching a dynamic route runs the page
   server-side, and Debt & Security reads a grouping-sets aggregate over the
   whole active book.

---

## Dashboard — standalone, pinned above the modules

| Entry | Destination | Capability |
| --- | --- | --- |
| Dashboard | `/` | `dashboard:view` |

## Clients

| Entry | Destination | Reuses | Capability |
| --- | --- | --- | --- |
| Client Register | `/clients` | — | `clients:view` |
| New Client | `/clients/new` | — | `clients:view` + `clients:create` |
| Active Clients | `/clients?status=active` | client register filter | `clients:view` |
| Inactive Clients | `/clients?status=inactive` | client register filter | `clients:view` |
| Suspended Clients | `/clients?status=suspended` | client register filter | `clients:view` |
| Blacklisted Clients | `/clients?status=blacklisted` | client register filter | `clients:view` |
| Client History | `/audit?entity=client` | audit trail entity filter | `audit:view` |

Statuses are `CLIENT_STATUSES` (`lib/domain/client.ts`), parsed by
`clientSearchSchema`.

## Membership

Polytos Phase 1. Immediately after Clients, because a membership is a fact
about a client and that is where a reader looks for it.

| Entry | Destination | Reuses | Capability |
| --- | --- | --- | --- |
| Membership Register | `/membership` | — | `membership:view` |
| Enrol a Member | `/membership/enrol` | — | `membership:view` + requires `membership:create` |
| Active Members | `/membership?status=active` | membership register filter | `membership:view` |
| Pending Applications | `/membership?status=pending` | membership register filter | `membership:view` |
| Suspended Members | `/membership?status=suspended` | membership register filter | `membership:view` |
| Former Members | `/membership?status=withdrawn` | membership register filter | `membership:view` |
| Membership Policy | `/membership/policies` | — | `membership:view` |
| Membership History | `/audit?entity=membership` | audit trail entity filter | `audit:view` |

Statuses are `MEMBERSHIP_STATUSES` (`lib/domain/membership.ts`), parsed by
`membershipSearchSchema`.

**"Enrol a Member" carries two capabilities, and the pair is the point.**
`permission` is what the route prefix map says — the path is under
`/membership`, so `membership:view` — and `requires` is what the page itself
demands. The rail then offers no entry that would refuse the person who clicks
it, while a visible link and a protected route cannot disagree about the
prefix. See `NavItem.requires` in `components/layout/nav-items.ts`.

Phase 1 had **no** enrolment entry, because enrolment did not exist and a rail
entry opening onto a form that could not complete would have been the system
telling a clerk that members could be taken on. Polytos Phase 2 built it, so
the entry is there.

There is still deliberately **no** "Pay benefit", "Record a claim", "Profit
share" or "Meeting" entry. All of those wait on rules the client has not
decided, so an entry for any of them would be the same lie.
`tests/integration/membership-ui.test.tsx` asserts that no entry in this
module carries such a label, and pins the enrolment entry's `requires`.

`/membership/policies` sits under the `membership:view` prefix rather than
behind `membership:manage_policies`: reading the registration fee and the
savings minimum is ordinary counter work, and publishing a version is a write
the page does not offer and the database policy refuses.

## Member Savings

Polytos Phase 2. Immediately after Membership, because a savings account
belongs to a membership and that is where a reader looks for it next.

| Entry | Destination | Reuses | Capability |
| --- | --- | --- | --- |
| Savings Register | `/savings` | — | `savings:view` |
| Active Accounts | `/savings?status=active` | savings register filter | `savings:view` |
| Dormant Accounts | `/savings?status=dormant` | savings register filter | `savings:view` |
| Withdrawal Requests | `/savings/withdrawals` | — | `savings:approve_withdrawal` |
| Savings History | `/audit?entity=savings` | audit trail entity filter | `audit:view` |

Statuses are `SAVINGS_ACCOUNT_STATUSES` (`lib/domain/savings.ts`), parsed by
`savingsSearchSchema`.

**A module of its own rather than entries under Membership.** The savings
register is the screen a Secretary spends the day in, and burying the
most-used screen in the phase two levels down inside another module would make
the common case the slow one.

**`/savings/withdrawals` is listed before `/savings` in the route requirement
table** (`lib/auth/routing.ts`), and the order is load-bearing. Matched the
other way round, the longer path would inherit the shorter one's requirement —
and the queue of decisions would open to a Secretary who holds `savings:view`,
may prepare a withdrawal, and may not decide one.
`tests/integration/membership-ui.test.tsx` asserts both prefixes resolve to the
capability they should.

There is deliberately **no** "Record a deposit" entry. A deposit is always to a
*particular* member's account, so the entry would open a chooser that the
register already is, one tap earlier.

## Member Lending

Polytos Phase 3. Immediately after Member Savings, because a member loan is
assessed against savings and that is where a reader looks for it next.

| Entry | Destination | Reuses | Capability |
| --- | --- | --- | --- |
| Who Can Borrow | `/member-loans?tab=members` | — | `member_loans:view_eligibility` |
| Member Loans | `/member-loans?tab=loans` | the same screen, the other register | `member_loans:view_eligibility` |
| Qualified Members | `/member-loans?tab=members&qualified=qualified` | eligibility register filter | `member_loans:view_eligibility` |
| New Application | `/member-loans/new` | — | `member_loans:create` |

`?tab=` is parsed by the page itself and narrows the heading and the register;
`?qualified=` by `memberEligibilitySearchSchema`.

**Two registers on one route rather than two routes.** "Who can borrow" and
"who has borrowed" are answered from different tables, but they are the same
screen's two views — reached from the rail, as the Phase 21 decision requires,
rather than from a strip of tabs above the register. A strip here would be a
second copy of one navigation and the only one of the two that could fall out
of step with it.

**There is deliberately no member-loan detail route.** A member loan opens at
`/loans/{id}`, like every other loan, with a membership panel added to it. A
second detail screen would be a second set of controls over one agreement.

**`/member-loans/new` is listed before `/member-loans` in the route
requirement table** (`lib/auth/routing.ts`), and the order is load-bearing —
the same arrangement, and the same reason, as `/savings/withdrawals` above.
Matched the other way round, the application form would inherit the section's
floor and open to a Secretary/Treasurer, who may answer "do you qualify yet?"
and may not commit the business to lending. `tests/e2e/specs/member-loans.spec.ts`
points a Secretary straight at the URL.

The Secretary/Treasurer therefore sees the first three entries and not the
fourth, which is the only module in the rail where one role sees part of one.

## Loan Management

Phase 13 reorganised the register around the **workflow**, and its ten stages
are exactly the views this module needs — one query, ten `where` clauses, so
no two entries can disagree about what "in arrears" means.

| Entry | Destination | Capability |
| --- | --- | --- |
| Loan Register | `/loans` | `loans:view` |
| New Loan Application | `/loans/new` | + `loans:create` |
| Draft Applications | `/loans?stage=draft` | `loans:view` |
| Pending Approval | `/loans?stage=pending_approval` | `loans:view` |
| Approved Loans | `/loans?stage=approved` | `loans:view` |
| Awaiting Disbursement | `/loans?stage=awaiting_disbursement` | `loans:view` |
| Active Loans | `/loans?stage=active` | `loans:view` |
| Grace Period | `/loans?stage=grace_period` | `loans:view` |
| Arrears | `/loans?stage=arrears` | `loans:view` |
| Cleared Loans | `/loans?stage=cleared` | `loans:view` |
| Rejected | `/loans?stage=rejected` | `loans:view` |
| Cancelled | `/loans?stage=withdrawn` | `loans:view` |
| Loans by Product | `/loans/by-product` *(no prefetch)* | `loans:view` |
| Loan History | `/audit?entity=loan` | `audit:view` |

Stages are `LOAN_WORKFLOW_STAGES` (`lib/domain/loan.ts`). **Approved and
Awaiting Disbursement are different stages here**, so they are two entries
rather than two labels on one query. **Rejected and Cancelled** are likewise
two stages — a decision that went against the applicant, and an application
they withdrew — so the brief's single "Rejected / Cancelled" became two rows.

## Collections

| Entry | Destination | Reuses | Capability |
| --- | --- | --- | --- |
| Collect Payment | `/payments/new` | — | + `payments:create` |
| Payment History | `/payments` | — | `payments:view` |
| Today's Collections | `/reports/collections?period=today` | collection report period | `reports:view_operational` + `payments:view` |
| Reversals | `/payments?status=reversed` | payment register filter | `payments:view` |
| Collection Summary | `/payments/summary` | — | `payments:view` |
| Collections by Payment Method | `/payments/summary?section=method#by-method` | summary slice | `payments:view` |
| Collections by Staff | `/payments/summary?section=staff#by-staff` | summary slice | `payments:view` |
| Collections by Loan Product | `/payments/summary?section=product#by-product` | summary slice | `payments:view` |

`period=today` resolves in the **business timezone**, which is why that entry
points at the report rather than at a hand-built date range on the register.

The summary reads the register **once and sums it five ways**, so the four
"by …" entries are sections of one page rather than four more queries. Phase
17's note applies: five `group by` queries would be five chances for the
totals not to agree. This pass added a stable id to each slice and a
`?section=` the page reads, so a link can name one.

**The by-branch slice is in Branch Network**, as *Branch Performance* — that
is the module a reader asking a branch question opens.

## Debt & Security

Phase 14's module, whole. `/overdue` is the morning worklist a collections
officer opens standing up; `/recovery` is the hub above it, with its five
views in the URL so the server fetches only the one being read.

| Entry | Destination | Reuses | Capability |
| --- | --- | --- | --- |
| Overdue Loans | `/overdue` | — | `delinquency:view` |
| Aging Buckets | `/recovery` *(no prefetch)* | the hub's default view | `recovery:view` |
| Risk Monitoring | `/recovery?view=risk` *(no prefetch)* | PAR, by branch and product | `recovery:view` |
| Follow-Ups | `/recovery?view=follow-ups` *(no prefetch)* | follow-up worklist | `recovery:view` |
| Promise to Pay | `/recovery?view=promises` *(no prefetch)* | promise register | `recovery:view` |
| Collateral / Security | `/recovery?view=security` *(no prefetch)* | collateral register | `recovery:view` |
| Guarantors | `/guarantors/register` *(no prefetch)* | — | `guarantors:view` |
| Guarantor Directory | `/guarantors` | — | `guarantors:view` |
| Guarantor Exposure | `/reports/guarantors` *(no prefetch)* | — | + `reports:view_financial`, `guarantors:view` |
| Arrears Report | `/reports/arrears` *(no prefetch)* | — | + `delinquency:view` |
| Penalties | `/reports/penalties` *(no prefetch)* | — | + `reports:view_financial`, `penalties:view` |
| Recovery Notes | `/reports/recovery` *(no prefetch)* | the recovery file | + `recovery:view` |

Views are `RECOVERY_VIEWS` (`lib/domain/debt-views.ts`).

**Guarantors belongs here, not under Clients.** A guarantor is security on a
loan; the question asked of that screen is who stands behind what. Both
guarantor surfaces are in this module: `/guarantors/register` is the
undertakings — who stands for whom, for how much, and whether it still binds —
and `/guarantors` is the people records, where a new guarantor is captured.

"Arrears Report", not "Arrears", because Loan Management already carries the
arrears *stage* of the register, and two rows called the same thing is a
screen reader reading one name twice.

## Finance

| Entry | Destination | Capability |
| --- | --- | --- |
| Cash Position | `/finance` | `ledger:view` |
| Transfers | `/finance/transfers` | `transfers:view` |
| Expenses | `/finance/expenses` | `expenses:view` |
| Other Income | `/finance/income` | `income:view` |
| Reconciliation | `/finance/reconciliation` | `reconciliation:view` |
| General Ledger | `/finance/ledger` | `ledger:view` |
| Trial Balance | `/finance/trial-balance` | `ledger:view` |

Each of the four movement types has its own capability, so a role holding
only one reaches only one. The trial balance takes `ledger:view`, the same as
the general ledger it aggregates — which also means it belongs to a
Secretary/Treasurer, because whoever handles the cash reads the ledger.

**Trial Balance** reads `public.trial_balance` and nothing else: the view
groups `journal_lines` by account and returns each account's debit and credit
total. The screen arranges them, places each account's net balance on its
side, and foots both pairs of columns. It has **no date filter and no branch
filter**, because the view has neither dimension and inventing one would mean
a second query over the same journal lines — a second source of truth for
figures that already have one. Both omissions are the ledger's own design:

- **Date.** An as-of statement needs the view to grow a date bound (a
  `trial_balance_as_of(date)` beside the existing
  `ledger_account_balance_as_of`), which is a migration rather than a screen.
- **Branch.** The chart deliberately does not branch income and expense
  accounts — `20261010000100_branches_and_ledger.sql` says a per-branch
  "Interest Income — Nansana" would be "a reporting dimension pretending to be
  an account". Branch is carried by the journal entry, and a trial balance is
  a statement of the whole entity. Per-branch figures are in Branch Network.

Branch visibility and capabilities are the view's, not the page's:
`trial_balance` is `security_invoker = true`, so it runs as the caller and Row
Level Security decides which postings are counted. Two people with different
visibility get two statements, each footing on its own rows, without the page
containing a single branch or role condition.

It is read-only structurally — no form, no action, no mutation path — and the
view itself refuses a write whatever the privilege, because a view over a
`GROUP BY` is not automatically updatable. `/finance/trial-balance/export`
serves CSV and a letterheaded PDF through the reporting pipeline's own
`guardExport`, fields, CSV writer, PDF renderer and letterhead.

## Reports

A module, not a line inside one. Phase 16 declared every report once in
`lib/reports/registry.ts` and grouped them four ways; those **groups** are
this module's entries. The ten report definitions stay in the Centre, which is
where a report is chosen, pointed at a period, filtered and exported from.

| Entry | Destination | Holds | Capability |
| --- | --- | --- | --- |
| Reports Centre | `/reports` | everything the role may open | `reports:view_operational` |
| Collections Reports | `/reports?group=money-in` | Collections | + `payments:view` |
| Arrears & Risk Reports | `/reports?group=behind` | Arrears, Grace period, Late-payment charges, Aging and PAR, Recovery file | + `delinquency:view` |
| Loan & Client Reports | `/reports?group=book` | Loan portfolio, Clients | + `clients:view` |
| Security & Guarantee Reports | `/reports?group=security` | Guarantor exposure, Security held | + `reports:view_financial`, `guarantors:view` |

A test asserts the rail offers exactly `REPORT_GROUPS`, that every group it
offers holds at least one report, and that **no individual report page** is in
the rail — so an entry can never open the Centre onto an empty list, and the
Centre never becomes a menu of its own contents.

## Notifications — standalone, pinned below the modules

| Entry | Destination | Capability |
| --- | --- | --- |
| Notifications | `/notifications` | `notifications:view` |

In no module, because it is *about* every module, and because the header's
bell is how somebody reaches it most of the time. **The bell is unchanged** —
it still holds the five most recent unread, which is what somebody standing
at the counter needs; the row is for the person who wants the history and the
filters.

## Branch Network

A cross-cutting module, and openly so. Phase 9 has **no standalone branch
screen**: a branch is a dimension of the cash position, of the collection
summary, of the aging report and of the portfolio at risk, and it is
configured on the settings page. So this module is four deep links into the
places a branch question is actually answered, rather than four new screens
that would each re-derive somebody else's figures.

| Entry | Destination | What answers the question | Capability |
| --- | --- | --- | --- |
| Branches | `/settings?section=branches#branches-heading` | the branch list: code, location, district, manager, opened | `settings:view` |
| Branch Cash Position | `/finance?section=cash#cash-position-heading` | `branch_cash_position`, per branch, read from the ledger | `ledger:view` |
| Branch Performance | `/payments/summary?section=branch#by-branch` | collections by the branch that owns the loan | `payments:view` |
| Branch Portfolio | `/reports/aging` *(no prefetch)* | the live book bucketed by lateness, with a branch column and a branch filter | + `reports:view_financial`, `delinquency:view` |

`Branch Settings` is this module's `Branches`, which is why Administration no
longer carries a separate row for it: a reader looking for a branch opens
Branch Network. Per-branch **risk** ratios are Debt & Security →
Risk Monitoring, whose risk view breaks PAR down by branch and by product.
Per-branch **staff** is Administration → Users; there is one staff directory,
not one per branch.

## Administration

| Entry | Destination | Reuses | Capability |
| --- | --- | --- | --- |
| Users | `/users` | — | `users:view` |
| Loan Products | `/settings/products` | — | `products:view` |
| Company Settings | `/settings` | settings section | `settings:view` |
| Lending Rules | `/settings?section=lending#rules-heading` | settings section | `settings:view` |
| Guarantor Rules | `/settings?section=guarantors#guarantors-heading` | settings section | `settings:view` |
| Finance Settings | `/settings?section=finance#finance-heading` | settings section | `settings:view` |
| Reference Numbers | `/settings?section=references#references-heading` | settings section | `settings:view` |
| Audit Trail | `/audit` | — | `audit:view` |
| My Account | `/account` | — | `account:view` |

The settings subjects are sections of one page, each carrying its section
twice: as `?section=`, which is what the rail highlights on and what opens the
page's chip row at the right section, and as a fragment, which moves the
browser with no JavaScript at all. `Company Settings` is `/settings` bare,
because that is where the page opens.

Loan Products sits beside Settings rather than inside it: a
Secretary/Treasurer holds `products:view` and no `settings:view`, so an entry
nested under a link they cannot open would be one they could never reach.

---

## Which entry is the open page

Several entries can match one URL — `/loans`, `/loans?stage=active` and
`/loans/{id}` all live under one prefix. `currentNavItem` picks the **most
specific** match: the longest path first, then the most pinned parameters.

| URL | Current entry | Module opened |
| --- | --- | --- |
| `/` | Dashboard | none |
| `/notifications` | Notifications | none |
| `/clients` | Client Register | Clients |
| `/clients/0f8f…` | Client Register | Clients |
| `/clients?status=active` | Active Clients | Clients |
| `/loans?stage=awaiting_disbursement` | Awaiting Disbursement | Loan Management |
| `/loans/by-product` | Loans by Product | Loan Management |
| `/payments/summary` | Collection Summary | Collections |
| `/payments/summary?section=staff` | Collections by Staff | Collections |
| `/payments/summary?section=branch` | Branch Performance | Branch Network |
| `/recovery` | Aging Buckets | Debt & Security |
| `/recovery?view=risk` | Risk Monitoring | Debt & Security |
| `/guarantors/register` | Guarantors | Debt & Security |
| `/guarantors` | Guarantor Directory | Debt & Security |
| `/reports/recovery` | Recovery Notes | Debt & Security |
| `/reports?group=behind` | Arrears & Risk Reports | Reports |
| `/reports/aging` | Branch Portfolio | Branch Network |
| `/finance?section=cash` | Branch Cash Position | Branch Network |
| `/finance/transfers` | Transfers | Finance |
| `/finance/trial-balance` | Trial Balance | Finance |
| `/settings` | Company Settings | Administration |
| `/settings?section=branches` | Branches | Branch Network |
| `/settings/products` | Loan Products | Administration |
| `/audit?entity=client` | Client History | Clients |

A report page with no rail entry of its own — `/reports/loans`,
`/reports/collateral` — falls to `Reports Centre`, because `/reports` is its
parent prefix. The reader is still told they are in Reports.

---

## Asked for, and deliberately not in the rail

A few labels from the brief have no row of their own. Each is listed here
rather than pointed at the nearest page that sounds similar: a rail entry that
opens a screen which cannot answer the question it promises is worse than no
entry, and two labels on one URL break the "exactly one current page" rule
above.

**Trial Balance is no longer among them** — it is built, at
`/finance/trial-balance`, over the view that already existed. Account Activity
and Liquidity Position stay as cross-references by design.

| Asked for | Why it is not there |
| --- | --- |
| **Account Activity** | `/finance/ledger?account=<uuid>` *is* account activity, reached from the account chips on that page. The parameter is a UUID, so a fixed rail entry cannot name one, and an entry pointing at `/finance/ledger` would be General Ledger twice. |
| **Liquidity Position** | Total liquidity is a card inside the cash position section on `/finance` — the same cards as Finance → Cash Position and Branch Network → Branch Cash Position. A third row on that section would be the same figures under a third name. |
| Repayment Schedules | A schedule belongs to a loan and is rendered on the loan's own page (`RepaymentScheduleTable`). There is no cross-loan schedule screen, and `/loans` would duplicate Loan Register. |
| Receipts | A receipt is rendered on a payment's own page (`PaymentReceipt`). A "Receipts" list is the payment register, which is already Payment History. |
| Branch Staff | One staff directory, at `/users`, already Administration → Users. Staff are not scoped per branch in this system. |

Adding any of these means adding the screen behind it first. When that
happens, the entry goes in `nav-items.ts` and a row goes in the table above
it.
