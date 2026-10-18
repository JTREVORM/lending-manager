# The table design system

Every register, list, worklist, schedule and report in this application is one
of two components. This page says what they guarantee, which knobs exist, and
why each rule is there — so the next person adding a screen does not have to
rediscover it, and so a review can check a table against something written
down.

---

## 1. The defect this exists to prevent

Fourteen screens had each written their own table. Every one of them looked
like this:

```tsx
<Card className="hidden min-w-0 overflow-x-auto md:block">
  <table className="w-full text-left text-sm">
    <th scope="col" className="t-th py-2.5 pr-4 whitespace-nowrap">Client</th>
    …
    <td className="py-3 pr-4">{loan.clientName}</td>
```

Note where `whitespace-nowrap` is and where it is not. The **headings** hold
their width; the **data** does not.

A `<table width: 100%>` under auto layout does not overflow when its columns
want more room than it has. It compresses whichever column compresses most,
and that is always the column holding prose — a borrower's name, a product's
name. So ten columns on a 1366px laptop produced:

- `Nakabugo` / `Ssemakula` / `Nabukeera` stacked over three lines;
- `UGX` on one line and `1,250,000` on the next;
- a status pill folded in half;
- rows 90px tall because one cell in them wrapped six times.

That is the Loan Register's reported problem, and it was present on thirteen
other screens for the same reason.

### The two rules that fix it

1. **A body cell does not wrap unless it says so.** A figure, a date, a
   reference or a badge is read across a row; a reader would rather scroll the
   table than decode a folded number.
2. **Every column carries a minimum width.** A column that cannot reach its
   minimum pushes the table past its container, and the container scrolls.

Together they move the cost of a narrow viewport from *"the data is mangled"*
to *"the table scrolls sideways"*. That is the trade an enterprise register
should make, and it is made once, in the component, rather than asked of
every screen.

---

## 2. Which component

| Use | Component | Why |
|---|---|---|
| A register, worklist, directory or schedule | `components/ui/data-table.tsx` | Columns are written as JSX; each screen keeps its own mobile card layout. |
| A report | `components/reports/report-table.tsx` via `FieldTable` | Columns come from the report's **field set**, which the CSV and the PDF also read, so the three renderings cannot drift. |

Nothing else writes a `<table>`. A test in
`tests/integration/table-system.test.tsx` walks the source and fails if one
appears, because a hand-written table is a table that has not been given
column floors, a focusable scroller or a caption — and all fourteen of the
originals had lost at least one of the three.

---

## 3. The column width scale

`TABLE_COLUMN_WIDTHS`, in `components/ui/data-table.tsx`. Pixels, measured for
the comfortable density against the longest value each kind realistically
holds.

| Token | px | Holds |
|---|---:|---|
| `ref` | 124 | `LN2600142`, a receipt or transfer number. Mono. |
| `name` | 184 | A person's or business's name, clamped to two lines |
| `name-wide` | 224 | A name that is the row's whole subject |
| `product` | 168 | A product name over its code |
| `money` | 124 | `UGX 123,456,789` |
| `money-wide` | 148 | A grand total, which runs longer than any row |
| `date` | 104 | `14 Oct 2026` |
| `datetime` | 144 | `14 Oct 2026, 14:32` |
| `status` | 128 | One badge |
| `status-wide` | 160 | A badge with a long label |
| `count` | 76 | A term in months, a count, days late |
| `rate` | 88 | A percentage |
| `phone` | 136 | `+256 772 110 015` |
| `place` | 168 | A village and a district |
| `prose` | 240 | A note, a reason, a remark. Wraps. |
| `actions` | 104 | A strip of row actions |

**They are minimums, not shares.** The widths of a ten-column register add up
to more than a laptop, on purpose: that is what makes it scroll instead of
squeeze. A column that should take the slack simply has a larger minimum than
one that should not.

A minimum on the `<th>` is enough to set the column's floor — the body cells
repeat it for legibility, not necessity.

---

## 4. Density

Two, and only two. Three had grown by accident: registers at 14px, the shared
shell at 11px, reports at 11px.

| `density` | Body | Padding | For |
|---|---|---|---|
| `comfortable` *(default)* | 13px | `0.75rem × 0.625rem` | A register read all day — six to ten columns |
| `compact` | 11px | `0.5rem` | Twelve to eighteen columns: the aging report, the guarantor register, a schedule |

Headers are 10px bold uppercase in the muted grey at both densities (`.t-th`).

The padding reaches the cells through two CSS variables the `<table>` sets
(`--table-pad-x`, `--table-pad-y`), so a cell never has to be told which
density it lives in, and a cell that genuinely needs its own padding can still
override it.

**Nothing was solved by shrinking a font.** No register's body text got
smaller: the registers were at 14px and are now at 13px with real column
floors, which is a change of one pixel against a change of layout.

---

## 5. Wrapping, clamping and truncation

`TableCell`'s `wrap` prop:

| `wrap` | Behaviour | For |
|---|---|---|
| `nowrap` *(default)* | The column widens; the table scrolls | Figures, dates, references, badges |
| `wrap` | Runs to as many lines as it needs | A remark, a reason, an item description |
| `clamp` | Wraps, then stops at two lines | A name or a product in a dense register |

**A clamped value must stay reachable in full.** Either `title` carries it, or
the row links to a view that holds it — usually both. The rule is absolute for
anything that identifies a record: a loan number, a client number, a receipt
number and every monetary figure are `nowrap` and are never clamped, so they
cannot be silently cut.

`TableLead` is the two-line pair eight registers render — a name over an
identifier. The name clamps; the identifier never wraps, because an identifier
split over two lines stops being one.

---

## 6. Responsive strategy

| Width | What happens |
|---|---|
| **375 / 430** phone | The table is hidden. Each row is a card or a `RecordPanel`, essential fields first, the whole record one tap away. |
| **768** tablet | The table appears. Secondary columns are already out. |
| **1024** tablet landscape | `hideBelow="lg"` columns return. |
| **1366** laptop | `hideBelow="xl"` columns are still out; the widest registers scroll inside their own box. |
| **1920** desktop | Every column, comfortably spaced. |

`hideBelow` drops a secondary column below a breakpoint. It is only ever used
on a column whose value is also on the row's own detail page and in the phone
card, so nothing becomes unreachable — it is a priority order, not a deletion.

Three guarantees hold at every width:

- **Horizontal scrolling stays inside the table.** `body { overflow-x: hidden }`
  means a table that escaped its wrapper would clip rather than scroll, so the
  wrapper is not optional.
- **The page itself never scrolls sideways.** Measured, not assumed — see §9.
- **Headers and values stay aligned**, because they are the same `<table>`.

### Sticky headers

Available, with an honest limitation. An element with `overflow-x: auto`
computes `overflow-y` to `auto` as well, so a header inside a wrapper that
only scrolls sideways is clipped to a box that never scrolls vertically and
sticks to nothing. A bounded height gives it that box, so `stickyHeader` only
takes effect together with `maxHeight`, and the component refuses to claim
otherwise.

Used on the four screens read a long way down: the audit log, the general
ledger, the repayment schedule and the loan breakdown.

---

## 7. Figures, dates, absence and zero

- Money goes through `<Money>`: `whitespace-nowrap` so the code stays attached
  to the figure, `tabular-nums` so a column lines up on the thousands
  separator, and no arithmetic of any kind.
- Dates go through `<DateValue>`: one format (`14 Oct 2026`), a machine-readable
  `<time dateTime>`, and `nowrap`.
- A numeric column is right-aligned **and** tabular, set by `align="numeric"`
  rather than remembered per cell.

Three states that look alike and are not:

| | Rendered | Announced |
|---|---|---|
| A recorded zero | `UGX 0` | the figure |
| Nothing was recorded | `—`, muted (`<NotRecorded>`, `<Money>` for a null) | "Not recorded" |
| A column that deliberately has no total | `—` in the footer (`<NotTotalled>`) | "Not totalled" |

The third exists because a blank cell under a column of bold figures reads as
a zero. An opening or closing balance is a position, not a series, and summing
it would produce a figure with no meaning — so the cell says so instead of
being left empty.

---

## 8. The register shell

`components/ui/register.tsx` — the parts of a register that are not its
columns, which the loan, client and payment registers had each rewritten.

- `RegisterFilters` — search plus up to two selects. Search commits on Enter
  and on blur, never per keystroke: each commit is a server query against a
  live financial table, and ten of them behind one word is the difference
  between a register that answers and one that times out on a free tier.
- `RegisterCount` — *"20 loans on this page · page 2 · more to come"*. It does
  not claim a total it was not given. An exact "of 4,812" is a second
  `count(*)` over the whole filtered set on every page view, which on these
  tables is the expensive query. `total` exists for the callers whose query
  already returns one.
- `RegisterPagination` — Previous and Next. "Is there another page" is
  answered by fetching one row more than the page needs.

All of it writes to the URL, so a filtered view can be reloaded and shared,
the filtering happens in the database (Row Level Security applies to the
filtered query, not to a list trimmed in the browser), and the browser never
holds the whole register.

---

## 9. Printing

Two of the rules above would misbehave on paper, so print undoes them:

- **Every dropped column comes back.** A sheet of A4 is about 794 CSS pixels,
  under every breakpoint, so without this a printed register would silently be
  missing columns — the one place where "scroll to reach it" is not an option
  and the reader cannot tell something is absent. Paper has no space pressure:
  `table-layout: fixed` already divides the sheet between whatever columns
  there are.
- **Nothing clamps.** The hover and the row's link do not exist in a printout,
  so a clamp there would be a silent truncation of the thing that identifies
  the record.

The rest of the print sheet was already in place: a repeated `<thead>` on each
page, `break-inside: avoid` on rows, column hints dropped, and the phone card
rendering hidden so a printout does not carry every row twice.

---

## 10. Accessibility

- The scrolling wrapper is `tabIndex={0}` with `role="region"` and an
  `aria-label`. A box that scrolls and cannot be focused cannot be scrolled
  from a keyboard at all — axe's `scrollable-region-focusable`, a violation
  rather than a nicety. A focusable box with no name announces as "group".
- Every table has a `<caption>`. It **names** the table rather than listing its
  columns: the same string is the region's accessible name, and a sentence
  enumerating eleven headings makes a poor thing to hear announced. The
  headings already say what the columns are.
- The cell that names a row is a `<th scope="row">`.
- A status is never carried by colour alone; the badge states it in words.
- Row actions are 44px on touch and keyboard-reachable everywhere.

---

## 11. Checking it

`tests/integration/table-system.test.tsx` holds the contract as tests.
`scripts/table-audit.mjs` opens every record-based screen at 375, 430, 768,
1024, 1366 and 1920 against a running stack, saves a screenshot of each, and
measures what a screenshot cannot: a page that scrolls sideways, a cell taller
than its wrap limit, a clipped value, a wrapped badge, and a scroller a
keyboard cannot reach.

```
npm run e2e:up
source <(npm run --silent e2e:env)
HARNESS_OWNER_PHONE=+256772100101 node scripts/table-audit.mjs --out .e2e/screens
```
