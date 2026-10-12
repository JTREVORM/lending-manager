# UI acceptance checklist

What to check by hand before accepting a UI/navigation change, and what is
already checked for you.

Each item says where it is covered automatically. **Covered** means a test
fails if it regresses — check those only when the automated suite cannot run.
**By hand** means nobody can assert it: it is a judgement about whether the
screen reads well.

Run first:

```
npm run typecheck && npm run lint && npm run format:check && npm run test:run && npm run build
tests/e2e/harness/stack.sh up && source <(tests/e2e/harness/stack.sh env) && npm run test:e2e
```

---

## 1. The rail, on a desktop (1440×900)

- [ ] **Dashboard sits alone above the modules, Notifications alone below
      them.** — covered (`navigation.test.tsx`, `navigation.spec.ts`)
- [ ] **The header's notification bell is untouched** — same badge, same five
      most recent unread, same place. — **by hand**
- [ ] **Eight module headers, every one closed, on first load.** Clients, Loan
      Management, Collections, Debt & Security, Finance, Reports, Branch
      Network, Administration. — covered
- [ ] **Pressing a header opens it; pressing it again closes it.** — covered
- [ ] **Opening one module closes the last.** — covered
- [ ] **Navigating to a page opens the module holding it, and only that
      one.** Expenses → Finance; `?view=promises` → Debt & Security;
      `?group=behind` → Reports; `/reports/aging` → Branch Network; a
      suspended-client filter → Clients. — covered
- [ ] **Neither pinned row opens a module.** `/` and `/notifications` leave
      all eight closed. — covered
- [ ] **Exactly one row is marked `aria-current="page"`, and it is the most
      specific match.** `/loans?stage=draft` lights Draft Applications, not
      Loan Register. — covered
- [ ] **No row is clipped or ends in an ellipsis** at the 256px rail width,
      in any module. — covered
- [ ] **The rail still looks like itself**: navy gradient, amber module
      headers with near-black labels, the amber trunk rule down each open
      sub-tree, pale-blue fill on the current row, the brand block and the
      signed-in person at the foot. — **by hand**
- [ ] The rail does not scroll the page sideways and its own band scrolls
      independently of the brand block and footer. — **by hand**

## 2. The rail, on a phone (390×844) and a tablet (768–1023px)

- [ ] **No bottom navigation bar, and no padding reserved for one.** —
      covered
- [ ] **The hamburger in the header opens the drawer**, with every module
      closed. — covered
- [ ] **Modules open and accordion inside the drawer.** — covered
- [ ] **Rows are touch-sized** — a module header and an entry are both at
      least 40px tall below `lg`. — covered
- [ ] **The overlay closes the drawer**, tapping beside it, not through it. —
      covered
- [ ] **The close control inside the drawer closes it.** — covered
- [ ] **Escape closes it.** — covered
- [ ] **Choosing a destination navigates and closes the drawer** — the menu is
      never left sitting over the page just asked for. — covered
- [ ] One thumb can reach a module header and an entry under it without
      zooming. — **by hand**

## 3. Destinations

- [ ] **Every entry in the rail loads**: no 404, no error boundary, nothing
      above 400. — covered (`navigation.spec.ts`)
- [ ] **No href appears twice** across the whole rail. — covered
- [ ] **Every entry's capability matches the route guard's.** — covered
      (`navigation.test.tsx`)
- [ ] **No entry is offered to a role the destination would refuse** — a
      Secretary/Treasurer is not shown New Client or the late-payment charges
      report. — covered
- [ ] **No module header opens onto an empty list** for any role. — covered
- [ ] Each filtered entry lands on a list that is actually filtered — Draft
      Applications shows drafts, not everything. — **by hand** (the filter
      itself is covered by the register's own tests)
- [ ] `docs/NAVIGATION-MAP.md` matches what the rail does, including the
      "asked for, and deliberately not in the rail" table. — **by hand**

## 3b. Phase 4–9 features the rail must not have lost

Every item here is covered by `navigation.test.tsx` and
`navigation.spec.ts`; they are listed because a restructuring that silently
drops a module looks like a tidier menu and is a feature nobody can reach.

- [ ] **Notifications** is reachable, as its own row, at `/notifications`.
- [ ] **Debt & Security** carries all twelve: Overdue Loans, Aging Buckets,
      Risk Monitoring, Follow-Ups, Promise to Pay, Collateral / Security,
      Guarantors, Guarantor Directory, Guarantor Exposure, Arrears Report,
      Penalties, Recovery Notes.
- [ ] **All ten loan workflow stages** are in Loan Management, with Awaiting
      Disbursement distinct from Approved, plus Loans by Product.
- [ ] **All five Debt & Security views** (`''`, `risk`, `follow-ups`,
      `promises`, `security`) have an entry.
- [ ] **All four report groups** have an entry, and no individual report page
      does.
- [ ] **Finance** carries all six money surfaces.
- [ ] **Branch Network** exists, on the four branch views Phase 9 actually
      has.
- [ ] **Phase 14's `prefetch: false`** is still set on every `/recovery`
      entry and on `/loans/by-product`, and `primary-nav.tsx` still passes it
      to the link. — covered
- [ ] Request counts on `/clients`, `/loans`, `/payments` stay inside the
      budget in `performance.spec.ts`. A collapsed rail should *reduce* them:
      a closed module renders no links for Next to prefetch, so a cold load
      prefetches two rows instead of twenty.

## 4. Reports as a module

- [ ] **Reports is a top-level module, not a line inside another**, and the
      word "Insights" appears nowhere. — covered
- [ ] **Its entries are the registry's four groups, not the ten report
      definitions.** — covered
- [ ] **Every group the rail offers holds at least one report the role can
      open.** — covered (`navigation.test.tsx`)
- [ ] **The Centre narrows to one group from `?group=`**, and an unrecognised
      value shows everything rather than nothing. — covered
- [ ] The group chips read as part of the page, and the heading names the
      group when one is chosen. — **by hand**
- [ ] All ten reports still open, filter, print, export to CSV and export to
      PDF. — covered (`reports.spec.ts`, `report-routes.test.ts`,
      `report-export.test.ts`, `pdf-report` tests)
- [ ] `lib/reports/registry.ts` gained only `isReportGroup`; no report
      definition, capability list, field set or file stem changed. — **by
      hand** (`git diff -- lib/reports/`)

## 5. The dashboard, after the copy reduction

- [ ] **Every KPI card holds a title, a figure and at most one supporting
      line.** — covered (`dashboard-ui.test.tsx`)
- [ ] **No definition is printed in a card body.** The sentence is still in
      the card, carrying `sr-only`, behind the info control. — covered
- [ ] **The info control is a real button** with `aria-expanded`,
      `aria-controls` and a name saying what it explains ("What Total
      collected means") — not a `title` attribute. — covered
      (`ui-accessibility.test.tsx`)
- [ ] **Pressing it reveals the definition and pressing it again hides it**,
      and there is only ever one copy of the sentence in the DOM. — covered
- [ ] **Opening a definition does not change the card's height** or move
      anything on the page — the panel is absolutely positioned. — **by
      hand**
- [ ] **On a linked card the control is outside the anchor**, so pressing it
      does not navigate. — covered
- [ ] **The figures are unchanged.** Every number on the dashboard is the one
      passed in; nothing in this pass touched a calculation. — covered
      (`dashboard-ui.test.tsx`, `reporting.test.ts`, the `db` suite)
- [ ] **The four statements that must stay stated, are:**
      - "Neither is profit — this system records no costs." — covered
      - "Expected minus collected is not the same as still due today." —
        covered
      - the status counts "add up to the N disbursed loans" — covered
      - "N loans have a past-due amount, which **overlaps** the statuses
        above" — covered
- [ ] A row of four cards reads at a glance, without scrolling past prose. —
      **by hand**

## 6. Explanatory copy elsewhere

- [ ] **Still present, and shortened, not removed:** the settings
      "changing a setting does not change an existing loan" alert; the
      reconciliation identities on the collection report and the loan
      statement; the "preview only" warnings on a draft schedule and
      breakdown; the "these totals do not reconcile" warning; the approval
      consequences on the loan lifecycle panel; the permanence warning on a
      client remark; "loan principal is never an expense"; "principal
      recovered is not income"; "a reversed payment stays listed and no
      longer counts". — covered (`phase9-screens.test.tsx`, `loan-ui`,
      `payment-ui`, `reports-ui`, `settings-ui`)
- [ ] **Gone:** documentation about how the database allocates a reference
      number, why a branch is read-only at length, how the audit trigger
      works, and the stale "comparing the two is a later phase". — **by
      hand**
- [ ] The collection summary still says principal collected is not revenue. —
      covered (`security-ui.test.tsx`)
- [ ] No page opens with a paragraph that only restates its own title. —
      **by hand**

## 7. Preserved design

- [ ] Polytos branding, the official logo in the rail's brand block and on
      the sign-in screen. — **by hand**
- [ ] Inter, at the same sizes. — **by hand**
- [ ] Navy / amber / light system; `.page-banner` gradient on every screen. —
      **by hand**
- [ ] Card, table and form styling untouched. — **by hand**
- [ ] The role strip, the signed-in person's block and the sign-out control
      are where they were. — **by hand**
- [ ] Rail width (256px) and the `md` drawer→fixed, `lg` touch→compact
      breakpoints unchanged. — **by hand**

## 8. Accessibility

- [ ] **axe finds no WCAG 2.1 A/AA violation on any staff screen.** — covered
      (`accessibility.spec.ts`)
- [ ] **Module headers are buttons that name their panel**, so a screen
      reader hears why the other forty entries are missing. — covered
- [ ] **The current page is marked for a screen reader, not only in colour.**
      — covered
- [ ] **The first Tab stop is the skip link**, and a module header is
      reachable and operable from the keyboard. — covered
- [ ] Nothing in the rail is reachable by Tab while the drawer is closed —
      it is `invisible`, not merely translated away. — covered

## 9. Business behaviour, which this pass must not have changed

- [ ] Loan balances, interest, penalties, payment allocation, ledger
      postings, transfers, expenses, reconciliation, journal balance, PAR,
      aging buckets, collateral valuations, guarantor eligibility and
      exposure, recovery actions and promise verdicts, notification
      generation, product rules, report totals. — covered (`unit` suite + the
      `db` suite; run `npm run test:db` and `npm run audit:money`)
- [ ] Permissions and RLS. — covered (`permissions.test.ts`, `rls-*.test.ts`)
- [ ] No migration was added or changed in this pass. — **by hand**
      (`git diff --stat supabase/`)

## 10. Build

- [ ] `npm run build` succeeds, with no `useSearchParams` prerender bailout.
- [ ] Per-page JS stays under the budgets in `performance.spec.ts` — the
      collapsed rail should *reduce* request counts, because a closed module
      renders no links for Next to prefetch.
