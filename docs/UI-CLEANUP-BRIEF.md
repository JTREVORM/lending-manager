# UI cleanup brief — the simplified version

The original instruction for this pass ran to eleven numbered sections. This
is the same instruction in one page, kept so the next person changing the rail
or the dashboard knows what the rules were.

---

## Goal

Make the interface cleaner and easier to navigate. **Presentation and
navigation only.**

## Do not change

Business logic, financial calculations, report definitions, ledger postings,
permissions, RLS, notification generation, demo data. No module gets rebuilt
and nothing gets redesigned.

Keep the Polytos branding and logo, Inter, the navy/amber/light system, the
card/table/form styling, the responsive behaviour, and the mobile
hamburger/off-canvas drawer.

## 1. Simplify the dashboard

Each KPI card holds **a title, a figure, and at most one supporting line**:

```
PRINCIPAL DISBURSED
UGX 26,500,000
26 loans
```

No paragraph explaining how a number is calculated inside the card. Put the
definition behind a small info icon / tooltip / popover with accessible help
text — still available, no longer in the way. Apply it everywhere KPI cards
appear: business summary, charged vs collected, liquidity, arrears and risk,
product performance, branch performance. Reduce card height; tidy the vertical
rhythm. **Do not change the underlying calculations.**

## 2. Cut explanatory copy everywhere else

Keep instructions only where somebody needs help finishing a task. Prefer
concise labels, short helper text, tooltips, placeholders and contextual
warnings. Drop long paragraphs above forms, text that restates the page title,
accounting explanations inside every card, and documentation-like prose on
operational screens.

**Keep** anything legally or operationally load-bearing: guarantor terms,
confirmations, warnings, approval consequences, and reconciliation
explanations. Only unnecessary copy goes.

It should read as a professional financial application, not a user manual
pasted into the interface.

## 3. Restructure the sidebar

Replace the broad `Operations` / `Insights` grouping with the business's own
modules. Dashboard and Notifications stand alone; everything else is a
collapsible amber parent:

Dashboard · Clients · Loan Management · Collections · Debt & Security ·
Finance · **Reports** · Notifications · Branch Network · Administration

Dashboard and Notifications are standalone rows; the other eight are
collapsible amber parents.

Two specifics: **Reports is an independent major module**, never buried under
Insights, and it exposes report *categories* — the individual reports stay
inside the Reports Centre. **The guarantor register goes under Debt &
Security**, not under Clients.

## 4. Collapse behaviour

- Every major module starts **closed**.
- Clicking a parent opens it.
- Accordion: opening one closes the last.
- The module holding the current page opens **by itself**.
- The active child keeps the current highlight style.
- The reader must never lose track of where they are.

The same behaviour applies inside the mobile drawer, with touch-friendly
rows.

## 5. Preserve the sidebar's look

Navy background, amber parent headers, light-blue active child, branding,
role and footer area, typography, width, desktop behaviour. This is a
structure change, not a visual redesign.

## 6. Mobile and tablet

Unchanged: no bottom bar, hamburger in the header, off-canvas drawer, overlay
and Escape close it, choosing a destination closes it.

## 7. Route mapping

**Reuse existing routes.** Do not create a page to satisfy a label. Where
several entries are filtered views of one screen, use query parameters, tabs
or route state — Active Clients is the client register filtered, Awaiting
Disbursement is one of Phase 13's ten workflow stages, Promise to Pay is one
of Phase 14's five Debt & Security views, Collections by Staff is one of the
collection summary's five slices. Where a requested label has no screen behind
it, say so rather than pointing at something that cannot answer it.

See `docs/NAVIGATION-MAP.md`, which ends with the three labels that have
nothing behind them in Phase 9 — Trial Balance, Account Activity and
Liquidity Position.

## 8. Tests and gates

Cover: every module renders; modules closed by default; the current module
auto-expands; accordion works; the active child is highlighted; Reports is
independent; Guarantors is under Debt & Security; the mobile drawer still
works; every destination is valid; no duplicate or broken links; dashboard
figures survive the copy reduction; the info controls are accessible; no
layout regression at desktop, tablet or phone.

And — because this pass restructures navigation over four modules built after
the structure was last touched — that none of Phase 4–9 was dropped:
Notifications, all twelve Debt & Security surfaces, all ten loan workflow
stages, all five recovery views, all four report groups with all ten reports
still reachable through the Centre, every Finance surface, and Phase 14's
`prefetch: false` on the destinations that are expensive to render.

Gates: `typecheck`, `lint`, `format:check`, unit and integration tests, the
Playwright suites, and a production build. **Do not call it done with broken
navigation or a UI regression.**

---

## Where the work landed

| Deliverable | File |
| --- | --- |
| Navigation structure | `components/layout/nav-items.ts` |
| Rail rendering and collapse behaviour | `components/layout/primary-nav.tsx` |
| Definition behind an info control | `components/ui/info-hint.tsx`, `components/reports/stat-card.tsx` |
| Report groups in the Centre | `app/(app)/reports/page.tsx`, `isReportGroup` in `lib/reports/registry.ts` |
| Section deep links | `app/(app)/settings/page.tsx`, `app/(app)/finance/page.tsx`, `app/(app)/payments/summary/page.tsx`, `components/ui/section-tabs.tsx` |
| Trial balance | `lib/domain/trial-balance.ts`, `lib/data/finance.ts`, `app/(app)/finance/trial-balance/` |
| Route map, including what was deliberately left out | `docs/NAVIGATION-MAP.md` |
| Acceptance checklist | `docs/UI-ACCEPTANCE-CHECKLIST.md` |
