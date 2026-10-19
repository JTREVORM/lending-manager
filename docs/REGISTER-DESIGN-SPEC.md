# Register design specification

Written against the reference screenshot before any code changed, so the
implementation can be held to something rather than to a memory of a picture.

The previous pass fixed the **mechanics** of the tables — nothing wraps,
nothing is clipped, nothing overflows the page. This pass fixes their
**appearance and completeness**: what the reference actually looks like, and
the words it writes out in full.

---

## 1. What the reference changes

Reading the screenshot column by column against what is on the branch today:

| | Reference | On the branch | Verdict |
|---|---|---|---|
| Page header | Flat white. Breadcrumb, dark title, one line of description, actions on the right. | Navy→amber gradient banner, translucent eyebrow chip, actions underneath. | **Replace.** The banner is the single loudest thing on every screen and the reference has none. |
| Status | Plain coloured text — `Active` dark green, `Cancelled` restrained red, `Draft` neutral. | A filled, rounded, uppercase pill. | **Replace.** A status is information; a pill looks like a control. |
| Workflow stage | Plain neutral text. | A second filled pill beside the first. | **Replace.** Two pills per row was the loudest thing in the table. |
| Loan term | `1 month`, `2 months`, `6 months` | `1 mo`, `2 mo` | **Replace.** Named in the brief. |
| Toolbar | One row, four controls, small grey label above each, inside the table panel. | Two controls in a separate card above the table. | **Rebuild.** |
| Actions | A three-dot menu per row. | None. | **Add**, bound to real routes and real permissions. |
| Sorting | Carets on the sortable headers. | None. | **Add**, sorted in the database, not on the page. |
| Pagination | `Showing 1–20 of 35 loans` · `Rows per page [20]` · `‹ 1 2 ›` | `15 loans on this page` · `Previous / Next` | **Replace**, which needs an exact total. |
| Repayable | Not a column. | A column. | **Remove** from the register; it stays on the loan. |

Everything else the reference shows — the neutral header fill, the hairline
row rules, the client number under the client name, the product code under
the product name, right-aligned tabular money — is already what the branch
does.

## 2. Typography and spacing

Measured off the reference and expressed in the tokens already in
`globals.css`.

| Role | Value |
|---|---|
| Page title | 30px / 700, near-black (`--color-text`) |
| Page description | 14px, muted |
| Breadcrumb | 13px, muted; the current page in near-black |
| Column header | 11px / 600, uppercase, 0.04em tracking, muted, on `--color-surface-sunken` |
| Body cell | 13.5px / 400, near-black |
| Secondary line (client number, product code) | 11.5px, muted |
| Money | 13.5px, tabular, right-aligned |
| Row height | 56–60px for a two-line cell, 44px for one line |
| Cell padding | 16px horizontal, 12px vertical |

**No font is made smaller to fit a column.** Where a column set cannot fit,
the table scrolls inside its own panel — the mechanism the previous pass put
in — and the fonts stay where they are.

## 3. Status, as text

A status is a fact about a record, not a button. Rendered as plain text in a
restrained semantic colour, at the same size and weight as the rest of the
row.

| Tone | Used for | Colour |
|---|---|---|
| `positive` | Active, Cleared, Approved, Posted, Settled | dark green |
| `attention` | Awaiting approval, Grace period, Pending | muted amber |
| `critical` | Arrears, Cancelled, Rejected, Reversed, Overdue | restrained red |
| `neutral` | Draft, and anything with no urgency | the body text colour, muted |

Every tone clears AA on white and on the row-hover fill. Colour never carries
the meaning alone: the label always says it in words, which is also what makes
it survive a printout and a colour-blind reader.

Pills are kept for the two places they are genuinely a chip and not a status:
a role in User Administration, and a filter chip.

## 4. Writing values out in full

The rule for the whole application: **a value is written the way a person
would say it.**

| Never | Always |
|---|---|
| `1 mo` | `1 month` |
| `3 mos` | `3 months` |
| `Pending App…` | `Pending approval` |
| `Awaiting Disb…` | `Awaiting disbursement` |
| any CSS ellipsis on a figure, status or identifier | the full value, with the column widened or the table scrolled |

Singular and plural are chosen from the number (`1 month`, `2 months`,
`1 day`, `5 days`), in one place — `lib/domain/duration.ts` — so no screen
decides it again.

What stays abbreviated, because it is the established written form and not a
shortening: `UGX`, `PAR`, loan and client numbers, and a product code shown
*underneath* its full product name.

Long borrower names wrap inside a column wide enough for two lines. Nothing
that identifies a record is ever truncated.

## 5. Row actions

A three-dot button opening a menu of the operations this loan, in this state,
can have done to it by **this** user.

- Built from the capabilities already in `lib/auth`, and routed only to pages
  that already exist. A menu entry the user cannot act on is not rendered.
- Hiding an entry is a courtesy, never the protection: every destination
  re-checks the permission server-side, and every mutation keeps its existing
  validation, confirmation and audit trail.
- **No Delete.** No shortcut past the loan lifecycle. Nothing is invented
  because it would look useful.
- Keyboard: `Enter`/`Space` opens, `Escape` closes and returns focus, arrows
  move, `Tab` leaves. Labelled by the record it acts on, so a screen reader
  hears "Actions for loan LN260034" rather than twenty identical buttons.

## 6. Sorting

Carets on the headers that sort. The sort is a parameter in the URL, read by
the server and applied with `ORDER BY` **before** the page is cut — sorting
twenty fetched rows would reorder the page and lie about the register.

Only columns the database can actually order by get a caret. A column with no
caret is one that does not sort, which is a more honest interface than one
that appears to and does not.

## 7. Pagination

```
Showing 1–20 of 35 loans          Rows per page [20 ▾]   ‹ [1] [2] ›
```

The exact total comes from PostgREST's `count=exact`, which rides on the
**same request** as the rows — one round trip, not two. It is asked for only
where a register genuinely shows a total, and a screen that cannot afford one
keeps the honest current-page wording instead. No screen fetches rows it does
not display in order to count them.

## 8. Responsive

Unchanged from the previous pass, which this does not undo: cards below `md`,
the table above it, secondary columns stepping out at breakpoints **measured
against the content area rather than the viewport** (the rail takes 256px),
horizontal scroll inside the panel, never on the page. Checked at 375, 430,
768, 1024, 1366, 1440 and 1920.

## 9. What must not move

RLS, authentication, role permissions, interest, penalties, repayment
schedules, accounting balances, journal entries, historical transactions and
every existing report calculation. This pass is the surface the numbers are
read on.

The distinction between **zero**, **not recorded** and **not applicable**
stays three separate statements, as the previous pass made it.
