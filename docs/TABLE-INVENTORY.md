# Inventory: every table, list and report

The audit this refinement started from. Each row records what the surface is,
what it renders through now, and what was wrong with it before.

Statuses:

- **migrated** — was a hand-written `<table>`, now on the shared shell.
- **tuned** — was already on a shared component; gained column floors, a
  density or a sticky header.
- **unchanged** — already correct, or not a table. The reason is stated.

---

## Dashboard — `/`

| Surface | Renders through | Status | Note |
|---|---|---|---|
| Executive, portfolio, today cards | `StatCard` grids | unchanged | Card grids, not tables. No column to squeeze. |
| Recent activity (`loan-activity`) | `<ul>` + flex rows | unchanged | Wraps by design, no fixed columns. Verified no overflow at 375px. |
| Recent payments | `<ul>` + flex rows | unchanged | As above. |
| Upcoming collections | `<ul>`, grouped by day | unchanged | As above. |
| Awaiting decision (approval queue) | `<ul>` of linked rows | unchanged | As above. |
| Collection sheet | `<ul>` of linked rows | unchanged | As above. |
| Recovery workload | Card grid | unchanged | As above. |
| Risk headline | Figure block | unchanged | As above. |

The dashboard's lists are flex rows that wrap, not columns that compress, so
the squeeze does not arise. They were checked at every width rather than
assumed.

## Client management

| Surface | Renders through | Status | Was |
|---|---|---|---|
| Client register (`/clients`) | `DataTable` | **migrated** | 6 columns, hand-written, no floors. Name and location both wrapped. Pagination duplicated. |
| Client search results | same component | **migrated** | Same table. |
| Client detail | `<dl>` field lists | unchanged | Not tabular. |
| Guarantors on a client | `client-guarantor-panel` card list | unchanged | Card list. |
| Client remarks | `<ul>` of entries | unchanged | Prose, not columns. |
| Client loan summary | Card list | unchanged | |

## Loan management

| Surface | Renders through | Status | Was |
|---|---|---|---|
| Loan register (`/loans`) | `DataTable` | **migrated** | **The reported screen.** 10 columns, no floors; client, product, date and figures all wrapped. |
| Draft / pending / approved / awaiting disbursement / active / grace / arrears / cleared / rejected | same component | **migrated** | All nine are the loan register under a `stage` filter. One table, one fix. |
| Loans by product | `DataTable` | **migrated** | 7 columns + totals. Cleared-loan total was a blank cell. |
| Loan application / detail | `<dl>` field lists | unchanged | Not tabular. |
| Repayment schedule | `DataTable` compact, sticky | **migrated** | 7 columns; read down 24+ rows with no sticky header. |
| Loan breakdown | `DataTable` compact, sticky | **migrated** | 6 columns + totals; two blank cells in the totals row. |
| Loan collateral / guarantee / documents / recovery panels | Card lists | unchanged | |

## Collections and payments

| Surface | Renders through | Status | Was |
|---|---|---|---|
| Payment register (`/payments`) | `DataTable` | **migrated** | 8 columns, no floors. **Pagination was broken** — `page` was set then deleted in the same call, so Next never advanced. No result count at all. |
| Repayment history on a loan | same component, `showFilters={false}` | **migrated** | Same table. |
| Daily collection summary (`/payments/summary`) | `DataTable` compact | **migrated** | 7 columns × 5 groupings + totals; footer had `colSpan` holes reading as zeros. |
| Payment detail — allocations | `DataTable` | **migrated** | 4 columns. |
| Allocation preview on the payment form | `DataTable` compact | **migrated** | 6 columns. |
| Payment receipt | Print layout | unchanged | Its own document format. |
| Reversal panel | Form | unchanged | |

## Debt and security

| Surface | Renders through | Status | Was |
|---|---|---|---|
| Overdue payments (`/overdue`) | `DataTable` compact | **migrated** | 9 columns, no floors. **Same broken pagination** as the payment register. |
| Aging register / PAR | `DataTable` compact | **migrated** | 10 columns, no floors. |
| Portfolio-at-risk summary | `DataTable` compact | **migrated** | 4 + N threshold columns. |
| Recovery worklist — overdue follow-ups | `DataTable` compact | **migrated** | 7 columns. |
| Recovery worklist — promises to pay | `DataTable` compact | **migrated** | 7 columns. |
| Collateral register — security held | `DataTable` compact | **migrated** | 7 columns; descriptions set the whole table's width. |
| Guarantor exposure register | `DataTable` compact | **migrated** | 12 columns, the widest in the system. |
| Guarantor directory | Card list | unchanged | |
| Delinquency / penalty panels on a loan | Card blocks | unchanged | |

## Finance

| Surface | Renders through | Status | Was |
|---|---|---|---|
| Transfer register | `DataTable` | **tuned** | Already shared; no column floors. |
| Expense register | `DataTable` | **tuned** | As above — a long description decided the amount column's width. |
| Other income register | `DataTable` | **tuned** | As above. |
| Reconciliation register | `DataTable` | **tuned** | As above. |
| General ledger | `DataTable` compact, sticky | **tuned** | 7 columns, no floors, read a long way down with no sticky header. |
| Cash position | Card grid | unchanged | Not tabular. |
| Trial balance | `<dl>` + figure blocks | unchanged | Not tabular. |
| Approval queues | The four registers above | **tuned** | |

## Reports

Every report renders through `FieldTable` → `ReportTable`, whose columns come
from the report's field set — the same array the CSV and the PDF read.

| Surface | Status | Note |
|---|---|---|
| Loan portfolio, arrears, aging, collections, penalties, grace period, clients, recovery, guarantors, collateral | **tuned** | Already had column hints, a focusable scroller, stacked phone cards and a repeated print header. Gained a **floor under the hints**: the smallest asked for ~60px, which at 11px broke `14 Oct 2026` over two lines. |
| Report filters, period and result summary | unchanged | Already stated above each table. |
| Totals | unchanged | Presented as a `StatCard` grid above the table, clearly separated from the rows. **No total or formula was touched.** |
| CSV / PDF / print output | unchanged values | Column sets, headings, order and values are the field set's and are untouched. Only the **print stylesheet** changed — see below. |

## Administration

| Surface | Renders through | Status | Was |
|---|---|---|---|
| User management (`/users`) | `DataTable` | **migrated** | 4 columns, hand-written. |
| Audit log (`/audit`) | `DataTable`, sticky | **tuned** | Already shared, but its **sticky header was a no-op** — sticky needs a bounded scroll box and the wrapper only scrolled sideways. |
| Roles and permissions | Read-only field lists | unchanged | |
| Branch network | Card list | unchanged | |
| Notifications | `<ul>` of entries | unchanged | Prose rows. |
| Loan products | Card grid | unchanged | |
| Settings lists | `<dl>` field lists | unchanged | |

## Borrower portal

| Surface | Status | Note |
|---|---|---|
| Portal loan cards, loan position, payment history | unchanged | Card layouts throughout; no table to squeeze. |

---

## Totals

| | Count |
|---|---:|
| Hand-written tables found | 15 (in 14 files) |
| Hand-written tables remaining | **0** |
| Tables migrated to the shared shell | 15 |
| Shared-component tables tuned | 16 (4 finance registers, ledger, audit log, 10 reports) |
| Non-table surfaces audited and left alone | 24 |

---

## Defects found that were not layout

Found while migrating, and fixed:

1. **The payment register's pagination never advanced.** `apply()` set `page`
   and then deleted it in the same call. Next was a no-op.
2. **The overdue list had the same bug**, from the same copied function.
3. **The audit log's sticky header did nothing.** It set the attribute, but a
   sticky header needs a scroll box to stick inside and the wrapper only
   scrolled horizontally.
4. **Blank cells in three totals rows** — under Cleared on Loans by product,
   and under Opening/Closing on the loan breakdown, and under Receipts/
   Reversed on the collection summary. A blank under a column of bold figures
   reads as a zero.
5. **Wide tables were unreachable by keyboard.** Eight of the hand-written
   tables scrolled horizontally with no `tabIndex` on the scroller — axe's
   `scrollable-region-focusable`.

## The one arithmetic change

Loans by product now sums the **cleared-loan count**, which the reduce had
omitted, leaving a blank in the totals row. It is a count of rows already on
screen, summed exactly as the four counts beside it. No financial figure,
rate, schedule, allocation, penalty, balance or ledger posting was changed
anywhere in this work.
