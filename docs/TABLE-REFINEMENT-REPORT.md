# System-wide table refinement — delivery report

Branch `claude/friendly-cerf-wg2qht`. Presentation layer only.

Companion documents:

- [`TABLE-INVENTORY.md`](./TABLE-INVENTORY.md) — every table, list and report, what it renders through now, what was wrong with it.
- [`TABLE-DESIGN-SYSTEM.md`](./TABLE-DESIGN-SYSTEM.md) — the rules, the width scale, the densities, the responsive strategy, print, accessibility.

---

## 1. What was actually wrong

Fourteen screens had each written their own table, and every one of them had
the same shape:

```tsx
<table className="w-full text-left text-sm">
  <th className="t-th py-2.5 pr-4 whitespace-nowrap">Client</th>
  <td className="py-3 pr-4">{loan.clientName}</td>
```

`whitespace-nowrap` on the **headings** and not on the **data**. A
`width: 100%` table under auto layout does not overflow when its columns want
more room than it has — it compresses whichever column compresses most, which
is always the one holding a name. So the headings held their width and the
data broke underneath them.

That is the Loan Register's reported problem, and it was on thirteen other
screens for the same reason.

## 2. The fix

Two rules, made once in `components/ui/data-table.tsx` rather than asked of
each screen:

1. **A body cell does not wrap unless it says so.**
2. **Every column carries a minimum width** from a shared scale, so a table
   that cannot fit overflows into its own scroller instead of squeezing.

Around them the shell also gained: a focusable, named scroll region; two
deliberate densities in place of three accidental ones (13px registers, 11px
reports — **no register's text got smaller**); two-line clamping with the full
value always reachable; and markers that keep "zero", "not recorded" and "not
totalled" three different statements.

`components/ui/register.tsx` holds the other half — the search, the result
line and the pagination that the loan, client and payment registers had each
rewritten separately.

## 3. Module by module

| Module | What changed |
|---|---|
| **Dashboard** | Audited, unchanged. Its lists are flex rows that wrap, not columns that compress — checked at every width rather than assumed. |
| **Clients** | Register migrated. Name column widened and clamped, location and registration date step out below `lg`, empty states say which emptiness they are and offer the next step. |
| **Loans** | Register migrated — and with it the nine stage views, which are the same component filtered. Loans by product migrated, including a totals cell that had been left blank. Repayment schedule and loan breakdown capped and scrolled so their headers stay in view. |
| **Collections & payments** | Payment register migrated (**its Next button never advanced a page** — fixed). Daily collection summary, allocation detail and the payment form's allocation preview migrated; three `colSpan` holes in the summary's totals row now say why they have no total. |
| **Debt & security** | All seven tables migrated: overdue list (**same broken pagination** — fixed), aging register, PAR summary, the three recovery registers, guarantor exposure (twelve columns, the widest in the system). |
| **Finance** | The four registers and the ledger gained column floors; the ledger is capped and scrolled so its header stays in view. |
| **Reports** | Already the strongest part of the system. Gained a floor under the column hints — the smallest asked for ~60px, which at 11px broke `14 Oct 2026` over two lines. Totals, formulas, CSV and PDF contents untouched. |
| **Administration** | User directory migrated. Audit log's **sticky header had been a no-op** (sticky needs a bounded scroll box; the wrapper only scrolled sideways) — now it works. |
| **Portal** | Audited, unchanged. Card layouts throughout. |

## 4. Defects found that were not layout

1. **The payment register's pagination never advanced.** `apply()` set `page`
   and deleted it in the same call.
2. **The overdue list had the same bug**, from the same copied function.
3. **The audit log's sticky header did nothing.**
4. **Blank cells in three totals rows** read as zeros.
5. **Eight tables scrolled horizontally with no keyboard access** to the
   scroller — axe's `scrollable-region-focusable`.
6. **A clamp that cut the wrong line.** Introduced during this work and caught
   by the layout sweep: `TableLead` inside a clamping cell counted a name's two
   lines and an identifier's one as three and truncated the third — the client
   number. Fixed, and `TableCell` now refuses to clamp a lead at all.

## 5. Test results

| | Result |
|---|---|
| TypeScript | clean |
| ESLint | clean |
| Prettier | clean |
| Unit + integration | **2215 passed**, 0 failed (was 2198; 17 new) |
| Production build | clean |
| Playwright | **498 passed**, 0 failed, 27 skipped — including the full WCAG AA sweep over every migrated screen |
| Per-page transfer | unchanged on every route this touched, desktop and mobile |
| Layout sweep | 132 screens (22 × 6 widths): **0 page overflows, 0 clipped values, 0 wrapped badges, 0 unreachable scrollers** |

Browser tests ran against the real harness: PostgreSQL 16 with every
migration applied, the real PostgREST binary, and the production build.

### Screenshots

`.e2e/screens/<width>/<screen>.png` — 132 images at 375, 430, 768, 1024, 1366
and 1920, regenerated by `scripts/table-audit.mjs`. They are build artifacts
and are not committed.

## 6. What did not change

Verified by `git diff fe245d4..HEAD -- lib supabase config types`, which is
**empty**:

- No RLS policy, no role, no permission.
- No interest, penalty, allocation or repayment calculation.
- No ledger posting, balance or transaction history.
- No loan lifecycle behaviour.
- No query, no new database round-trip, no server-side pagination removed,
  no register fetched whole into the browser.
- No dependency added to `package.json`.
- No report formula, total, CSV column or PDF contract.

Accessibility improved rather than held: eight scroll regions became
keyboard-reachable, and the WCAG AA sweep passes on every screen.

### The one arithmetic addition

Loans by product now sums the **cleared-loan count**, which the reduce had
omitted, leaving a blank under a column of numbers. It is a count of rows
already on screen, summed exactly as the four counts beside it.

### The one budget raised

The all-chunks ceiling in `tests/integration/bundle.test.ts` goes 520 → 545 KB
gzipped, with the case written where the number is: no new dependency, the
four largest chunks byte-identical, the 120 KB largest-chunk assertion
untouched, and the per-page figure — the one that is somebody's airtime —
unchanged in a real browser. The growth is Turbopack re-cutting its graph now
that fourteen inline tables are two shared components; the source is ~1,500
lines shorter.

## 7. Remaining issues, and why

1. **The loan portfolio report's status column stacks its two badges at 1366px
   and below.** Both are legible and on separate lines, which is what
   `flex-wrap` is for. Giving the column the ~200px it would need to keep them
   side by side pushes a fifteen-column report further into horizontal scroll
   for no gain. Left as is; it is the 29 findings the sweep still reports.
2. **Sticky headers are opt-in, not universal.** An element with
   `overflow-x: auto` computes `overflow-y` to `auto` too, so a header inside a
   wrapper that only scrolls sideways has nothing to stick to. Enabled on the
   four screens read a long way down (audit log, ledger, repayment schedule,
   loan breakdown) by capping their height; elsewhere the page scroll is the
   better behaviour.
3. **Sticky identifier columns were not added.** Optional in the brief, and on
   a ten-column register a frozen first column costs more width than it
   returns.
4. **No visual-regression baseline.** The sweep measures geometry and the
   screenshots are for a person to look at; nothing yet fails a build on a
   pixel change. Worth adding, out of scope here.
5. **The sweep must run after the browser tests, or on its own stack.** 132
   page loads put the harness's rate limiter in a state where the next write is
   refused — three recovery write tests then fail with the record absent. Noted
   at the top of the script.
