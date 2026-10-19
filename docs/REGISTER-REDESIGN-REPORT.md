# Register redesign — delivery report

Branch `claude/friendly-cerf-wg2qht`. Presentation layer only.

Read with [`REGISTER-DESIGN-SPEC.md`](./REGISTER-DESIGN-SPEC.md), the reading
of the reference screenshot this was built against, and
[`TABLE-DESIGN-SYSTEM.md`](./TABLE-DESIGN-SYSTEM.md), the shared table
contract the previous pass established and this one builds on.

---

## 1. The shared standard

| Piece | Where | What it fixes |
|---|---|---|
| `PageHeader` | `components/ui/page-header.tsx` | The gradient banner, replaced by a breadcrumb, a dark title and actions on the right. Same props, so forty screens moved together. |
| `StatusText` / `StageText` | `components/ui/status-text.tsx` | A status is text in one of four restrained tones, not a filled pill. |
| `RowActions` | `components/ui/row-actions.tsx` | The three-dot menu, with real focus management. |
| `SortHeader` | `components/ui/sort-header.tsx` | A sort written into the URL and applied by the database. |
| `RegisterPagination` | `components/ui/register.tsx` | `Showing 1–20 of 35 loans`, rows per page, numbered pages. |
| `lib/domain/duration.ts` | | `1 month` / `2 months`, decided in one place. |
| `lib/domain/pagination.ts` | | Page sizes as a fixed set, and the sentence that describes a page. |
| `TABLE_COLUMN_WIDTHS` | `components/ui/data-table.tsx` | Re-measured so a ten-column register fits a 1440px screen. |

## 2. Module by module

| Module | What changed |
|---|---|
| **Loan Management** | The register rebuilt to the reference: ten columns, all words in full, status and stage as text, sortable headers, row menu, new pagination. The nine stage views are the same component filtered, so they moved with it. |
| **Client Management** | Status text, new pagination with an exact total, breadcrumb header. A truncated name in the phone card now wraps. |
| **Collections & Payments** | Payment register on the new pagination with an exact total; status text throughout. |
| **Debt & Security** | Delinquency states are text. The overdue list keeps honest no-total wording — its rows are derived per row, so a count would be a second pass. |
| **Finance** | Movement and reconciliation statuses are text. A truncated cash-position label now wraps. |
| **Reports** | Column headings were already complete words and the figures already right-aligned and tabular; they keep every column, every total and every export contract. They inherit the new header and the status tones. |
| **Administration** | User statuses are text; roles stay as chips, which is what a role is. Audit log unchanged apart from the shared header. |
| **Dashboard, Portal** | Card layouts; the new header and status tones only. |

## 3. Never breaking a word

| Was | Is |
|---|---|
| `1 mo` | `1 month` |
| `2 mo` | `2 months` |
| truncated staff name in the user card | wraps |
| truncated cash-position label | wraps |

Singular and plural come from `lib/domain/duration.ts`. A test greps the
source and fails if ` mo` reappears after a number.

Report headings were checked and were already written out — `Days past
due`, `Rate (basis points)`, `Total outstanding`. Nothing there needed
shortening and nothing was shortened.

What stays abbreviated, because it is the written form rather than a
shortening: `UGX`, `PAR`, loan and client numbers, and a product code shown
beneath its full product name.

## 4. The row menu

Built from the real permissions (`loans:update_draft`, `loans:submit`,
`loans:approve`, `loans:disburse`, `payments:create`) and real routes.

- **No Delete.** A loan is cancelled or rejected — both states with a reason
  and an audit entry — never removed.
- **No one-click decisions.** Submit, approve and disburse go to the loan's
  page, where the lifecycle panel has the confirmation, the reason field, the
  server-side validation and the audit entry.
- **Nothing invented.** A "View payment history" entry was dropped on
  finding `/payments` takes no loan filter: it would have been a control
  that looks like it filters and does not. The history is on the loan's page.
- Hiding an entry is a courtesy. Every destination re-checks its permission
  and RLS applies underneath, so a hand-typed URL is refused either way.

## 5. Sorting and pagination

Sorting is `ORDER BY` in the database, before the page is cut, from an
allow-list of nine columns the register's view publishes. Sorting the
twenty fetched rows would make "largest principal" mean "largest of the
twenty most recent".

The total is PostgREST's `count=exact`, carried on the **same request** as
the rows — one round trip, not two. Registers that cannot afford one (the
overdue list, which derives its rows) keep wording that claims no total.
Where a count is known it governs: "of 40" and "no next page" cannot both
be true.

## 6. Responsive

Checked at 375, 430, 768, 1024, 1366, 1440 and 1920 — all seven the brief
names. `scripts/table-audit.mjs` drives every record-based screen at each
and measures what a screenshot cannot: a page that scrolls sideways, a cell
taller than the rule its author gave it, a clipped value, a wrapped badge,
a scroller a keyboard cannot reach. The final run reports none of any of
them.

The ten columns come to about 1,180px, which is the content area of a 1440px
screen. 1920 and 1440 show everything with no scroll; 1366 scrolls by about
a column's width, which the brief prefers to dropping a column; below `md`
each row is a record card carrying every field including the total
repayable. **The actions column is pinned to the right edge**, so the menu
is reachable at every width rather than being the first thing to scroll out
of sight.

## 7. Test results

| | |
|---|---|
| TypeScript, ESLint, Prettier | clean |
| Unit + integration | **2238 passed**, 0 failed (+22 new) |
| Production build | clean |
| Playwright | **498 passed**, 0 failed, 27 skipped — including the full WCAG AA sweep |
| Layout sweep | **154 screens** (22 × 7 widths): 0 page overflows, 0 clipped values, 0 wrapped badges, 0 unreachable scrollers, 0 cells past their wrap limit |
| Per-page transfer | unchanged on every route, desktop and mobile |

## 8. Performance

No new dependency; nothing added to `package.json`. No extra round trip —
the count rides on the query that was already being made. Server-side
pagination, filtering and sorting are preserved; no register is fetched
whole into the browser; the page size is an allow-list so an edited URL
cannot ask for fifty thousand rows.

The all-chunks budget moved 545 → 560 KB gzipped, with the case recorded in
`tests/integration/bundle.test.ts`. The 8 KB is new interactive behaviour —
a focus-managed menu, sortable headers, a page-size control, numbered
pagination — not the same screens grown heavier. The largest-chunk
assertion is untouched. Replacing six `lucide-react` chevrons with one
inline SVG was kept for tidiness but saved nothing measurable, and the test
says so.

## 9. Remaining issues, and why

1. **The loan register scrolls by about a column's width at 1366.** Ten
   columns with every word written out come to ~1,180px and a 1366px laptop
   has ~1,070px of content area. The brief prefers a controlled scroll to a
   dropped column, so all ten stay and the actions menu is pinned to the
   right edge. 1440 and 1920 show everything with no scroll.
2. **The date filters render in the browser's locale.** `<input type="date">`
   draws its own placeholder, so a machine set to US English shows
   `mm/dd/yyyy` on the payment register's From and To. The value sent is
   ISO either way. Changing it means replacing the native control with a
   custom date picker, which is a larger change than this pass should make
   unasked.
3. **No visual-regression baseline.** The sweep measures geometry and the
   154 screenshots are for a person to look at; nothing yet fails a build
   on a pixel change.
4. **The sweep must run after the browser tests, or on its own stack.** 154
   page loads leave the harness's rate limiter in a state where the next
   write is refused.

## 10. What did not change

RLS, authentication, role permissions, interest, penalties, repayment
schedules, accounting balances, journal entries, historical transactions,
every existing report calculation, and every CSV and PDF export contract.

Zero, not recorded and not applicable remain three separate statements.
