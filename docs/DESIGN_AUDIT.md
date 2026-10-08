# Design audit — reference project → Lending Manager

Reference inspected: `chetu-original-manager-main` (Vite + TanStack Start +
React 19 + Tailwind **v4** + shadcn/ui "new-york", Supabase). The Lending
Manager is Next.js 16 + React 19 + Tailwind **v4**. Both are on Tailwind v4
with CSS-first `@theme` configuration, so the reference's design tokens
transfer as values rather than as a translation.

This document records what was found before any file was changed. It is the
contract the implementation is held to.

---

## 1. Fonts

| Property | Finding |
|---|---|
| Family | **Inter** (exact; no substitution) |
| Loaded from | Google Fonts, in `src/routes/__root.tsx` → `links: []` |
| URL | `https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800;900&display=swap` |
| Preconnects | `https://fonts.googleapis.com`, `https://fonts.gstatic.com` (crossOrigin anonymous) |
| Weights shipped | 300, 400, 500, 600, 700, 800, 900 |
| Token | `--font-sans: Inter, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif` (`src/styles.css` `@theme inline`) |
| Applied | `body { font-family: 'Inter', system-ui, … }`, plus `font-sans` on the sidebar |
| Smoothing | `-webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale` on `html` |
| Mono (loader only) | `ui-monospace, SFMono-Regular, Menlo, Consolas, monospace` |

No `@font-face`, no self-hosted `.woff2` in the ZIP — the font is a Google
Fonts stylesheet link. Weights **800 and 900 are used** (`font-black` on page
titles, `font-extrabold` on the sidebar version chip), which is why the full
300–900 axis is requested and not a subset.

### Font sizes actually used (not the Tailwind defaults)

The reference leans on explicit bracket sizes for density. Observed set:

`9px, 10px, 11px, 12px, 13px, 14px, 15px, 16px` via `text-[9px]` … `text-[15px]`,
plus `text-xs/sm/base/lg/xl/2xl/7xl`. The two that matter most:

- **Desktop tables**: body `text-[11px]`, header `text-[10px] font-bold uppercase tracking-wide`
- **Desktop forms**: label `12px/500`, field `13px`
- **Mobile forms**: label `16px/400`, field `16px` (deliberate — iOS zoom guard)
- **Mobile data cards**: `text-[13px]`, label segment `font-bold`

---

## 2. Global CSS variables (`src/styles.css`, 931 lines)

### 2a. Radius scale — base `--radius: 0.625rem` (10px)

```
--radius-sm:  calc(var(--radius) - 4px)   =  6px
--radius-md:  calc(var(--radius) - 2px)   =  8px
--radius-lg:  var(--radius)               = 10px
--radius-xl:  calc(var(--radius) + 4px)   = 14px
--radius-2xl: calc(var(--radius) + 8px)   = 18px
--radius-3xl: calc(var(--radius) + 12px)  = 22px
--radius-4xl: calc(var(--radius) + 16px)  = 26px
```

### 2b. shadcn semantic tokens — light (`:root`), all oklch

```
--background        oklch(1 0 0)                  --foreground        oklch(0.129 0.042 264.695)
--card              oklch(1 0 0)                  --card-foreground   oklch(0.129 0.042 264.695)
--popover           oklch(1 0 0)                  --popover-foreground oklch(0.129 0.042 264.695)
--primary           oklch(0.208 0.042 265.755)    --primary-foreground oklch(0.984 0.003 247.858)
--secondary         oklch(0.968 0.007 247.896)    --secondary-foreground oklch(0.208 0.042 265.755)
--muted             oklch(0.968 0.007 247.896)    --muted-foreground  oklch(0.554 0.046 257.417)
--accent            oklch(0.968 0.007 247.896)    --accent-foreground oklch(0.208 0.042 265.755)
--destructive       oklch(0.577 0.245 27.325)     --destructive-foreground oklch(0.984 0.003 247.858)
--border            oklch(0.929 0.013 255.508)    --input             oklch(0.929 0.013 255.508)
--ring              oklch(0.704 0.04 256.788)
--sidebar           oklch(0.984 0.003 247.858)    --sidebar-foreground oklch(0.129 0.042 264.695)
--chart-1..5        oklch(0.646 0.222 41.116) / (0.6 0.118 184.704) / (0.398 0.07 227.392) /
                    (0.828 0.189 84.429) / (0.769 0.188 70.08)
```

Dark mode is a **`.dark` class** variant (`@custom-variant dark (&:is(.dark *))`),
slate-based: `--background oklch(0.129 0.042 264.695)`, `--card oklch(0.208 0.042 265.755)`,
`--border oklch(1 0 0 / 10%)`, `--input oklch(1 0 0 / 15%)`, etc.

### 2c. Chetu brand palette (hex, registered as Tailwind colours)

```
--color-chetu-blue       #1E60D5     --color-chetu-darkblue   #154BB2
--color-chetu-navy       #0F2962     --color-chetu-lightblue  #EFF6FF
--color-chetu-red        #D32F2F     --color-chetu-darkred    #B71C1C
--color-chetu-lightred   #FEF2F2     --color-chetu-gold       #F59E0B
--color-chetu-gray-50    #F8FAFC     --color-chetu-gray-100   #F1F5F9
--color-chetu-gray-200   #E2E8F0     --color-chetu-gray-300   #CBD5E1
--color-chetu-gray-400   #94A3B8     --color-chetu-gray-500   #64748B
--color-chetu-gray-600   #475569     --color-chetu-gray-700   #334155
--color-chetu-gray-800   #1E293B     --color-chetu-gray-900   #0F172A
```

### 2d. The *working* palette (what the screens actually paint with)

The `chetu-*` ramp is declared, but the chrome and page surfaces are built from
a second, deeper navy set used as literal hex in the components:

| Role | Value |
|---|---|
| Primary navy (buttons, headings, icon tiles) | `#0B4394` |
| Navy hover / pressed | `#093672` |
| Sidebar brand header | `#083475` |
| Sidebar role strip + footer | `#06295E` |
| Sidebar gradient | `#0b4394 → #0d478f 45% → #072f6b 100%` (180deg) |
| Page banner gradient | `110deg, #0b4394 0% → #14509e 40% → #3d76bd 72% → #d9a441 118%` |
| Login/brand wash | `135deg, #0b4394 0% → #2c5da6 55% → #f6c256 140%` |
| App shell base | `#f1f5f9` + two radial tints (navy 10% top-right, amber `#E0A53C` 14% bottom-left), `background-attachment: fixed` |
| Active sidebar group | `#F5A623` (amber) on white text |
| Active sidebar top link | `bg-amber-500` on `text-blue-950` |
| Sub-item tree rule | `border-l-2 border-amber-500/40` |
| Sub-item icon | `text-amber-300` (desktop) / `text-white/90` (mobile) |
| Mobile data card | `#eaf1f8` (pale blue) |
| Table header fill | `bg-slate-50`, sticky variant `#f8fafc` |
| Table row hover | `bg-slate-50`; dividers `divide-slate-100` |
| Form section rule | `border-left: 4px solid #fbbf24` |
| Save button | `#fbbf24` → hover `#f59e0b`, pill (`rounded-full`), `#0f172a` text |
| Body canvas / text | `#F8FAFC` / `#0F172A`, `line-height: 1.5` |

Status tones (ring-based pills): emerald-50/700/200, amber-50/800/200,
red-50/700/200, slate-100/600/200, indigo-50/800/200, purple-50/800/200,
blue-50 + `#0B4394` + blue-200.

### 2e. Shadows

```
--shadow-card:       0 2px 10px rgba(0,0,0,0.04), 0 1px 3px rgba(0,0,0,0.02)
--shadow-card-hover: 0 10px 25px -5px rgba(30,96,213,0.1), 0 8px 10px -6px rgba(0,0,0,0.04)
--shadow-modal:      0 25px 50px -12px rgba(15,41,98,0.25)
page-banner:         0 10px 24px -12px rgba(11,67,148,0.55)
feedback-pill:       0 4px 10px rgba(11,67,148,0.3)
```

In practice, cards and panels use Tailwind's **`shadow-xs`**; the sidebar uses
`shadow-2xl`; modals use `shadow-2xl`; the login card `shadow-2xl`.

### 2f. Focus rings

```
input:focus, select:focus, textarea:focus {
  box-shadow: 0 0 0 3px rgba(30,96,213,0.15);
  border-color: #1E60D5 !important;
}
.form-field:focus { border-color: #0b4394; box-shadow: 0 0 0 1px rgba(11,67,148,0.4) }
```

---

## 3. Tailwind configuration

**There is no `tailwind.config.js`.** Tailwind v4, configured entirely in CSS:

```css
@import "tailwindcss" source(none);
@source "../src";
@import "tw-animate-css";
@custom-variant dark (&:is(.dark *));
@theme inline { … }
```

So breakpoints are **Tailwind v4 defaults**, unmodified:

| | |
|---|---|
| `sm` | 40rem / 640px |
| `md` | 48rem / 768px |
| `lg` | 64rem / 1024px |
| `xl` | 80rem / 1280px |
| `2xl` | 96rem / 1536px |

`md` (768px) is the system's real hinge: sidebar slides in/out, header swaps to
an icon bar, tables become stacked cards, forms collapse to one column, controls
grow to 44px.

Custom media queries beyond Tailwind: `max-width: 640px`, `max-width: 380px`,
`max-width: 767px`, `min-width: 640px`, `min-width: 768px`, `(hover: none)`,
`prefers-reduced-motion: reduce`, `print`.

---

## 4. Chrome dimensions

| Element | Spec |
|---|---|
| **Sidebar width** | `w-64` = **16rem / 256px** |
| Sidebar position | `fixed left-0 top-0 bottom-0 z-40`, `min-h-screen`, `shadow-2xl`, `border-r border-blue-900/60` |
| Sidebar mobile | `-translate-x-full` → `translate-x-0`, `md:translate-x-0`, `transition-transform duration-300 ease-in-out` |
| Sidebar brand block | `p-4`, `bg-[#083475]`, `border-b border-blue-800/80`, logo `h-9` on white `p-1 rounded` |
| Sidebar role strip | `px-3.5 py-2`, `bg-[#06295E]` |
| Sidebar nav area | `flex-1 min-h-0 scroll-area scroll-y py-2 px-2.5 space-y-1.5 text-xs` |
| Sidebar group row | `px-3 py-3 md:py-2 rounded-lg text-[15px] md:text-xs font-bold` |
| Sidebar sub-item | `px-2.5 py-2.5 md:py-1.5 rounded-md text-[14px] md:text-[11px]`, tree `ml-4 pl-4 border-l-2` |
| Sidebar footer | `p-2.5`, `bg-[#06295E]`, inner `bg-blue-950/60 border border-blue-800/80 rounded-lg p-2`, avatar `w-7 h-7 ring-2 ring-amber-400` |
| **Header height** | `h-16` = **4rem / 64px** |
| Header position | `fixed top-0 right-0 left-0 md:left-64 z-20` |
| Header surface | `bg-white border-b border-slate-200 shadow-xs`, `px-4 md:px-6` |
| Mobile overlay | `fixed inset-0 bg-slate-900/50 backdrop-blur-xs z-25 md:hidden` |
| **Main region** | `flex-1 min-w-0 w-full ml-0 md:ml-64 pt-16 sm:pt-20 px-3 sm:px-4 md:px-6 lg:px-8 min-h-screen` |
| Page content width | per-page; `mx-auto max-w-5xl` on form pages, full width on tables |
| z-index ladder | sidebar 40, mobile scrim 25, header 20, modal 50, loader overlay 60, sticky th 2 |

---

## 5. Spacing system

Standard Tailwind 4px scale. Observed rhythm:

- Page section gap: `space-y-4` / `space-y-5` / `space-y-6 sm:space-y-6`
- Page bottom padding: `pb-12` / `pb-16` (clears mobile chrome)
- Banner padding: `p-5 sm:p-6` or `p-6`
- Card padding: `p-4` (filters), `px-4 py-3` (list rows), `p-3.5` (toolbars)
- Card grid gap: `gap-3`
- Filter grid: `gap-x-4 gap-y-3`, `grid-cols-1 sm:grid-cols-2 lg:grid-cols-{3,4,5,6}`
- Table cell: `px-2 py-2.5`
- Form field: `0.875rem 1rem` mobile → `0.375rem 0.625rem` desktop
- Touch floor: `min-height: 2.75rem` (44px) below `md`, chips `2.25rem` (36px)

Named helper tokens: `--spacing-touch` equivalent is expressed as the
`@media (max-width: 767px)` block setting `min-height: 2.75rem` on every
`button, [role=button], select, input, textarea`.

---

## 6. Reusable UI components

### 6a. shadcn/ui — 50 files in `src/components/ui/`

accordion, alert, alert-dialog, aspect-ratio, avatar, badge, breadcrumb,
button, calendar, card, carousel, chart, checkbox, collapsible, command,
context-menu, dialog, drawer, dropdown-menu, form, hover-card, input-otp,
input, label, menubar, navigation-menu, pagination, popover, progress,
radio-group, resizable, scroll-area, select, separator, sheet, sidebar,
skeleton, slider, sonner, switch, table, tabs, textarea, toggle,
toggle-group, tooltip.

Stock "new-york" variants, verbatim:

- **Button** — base `inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium cursor-pointer … focus-visible:ring-1 focus-visible:ring-ring … [&_svg]:size-4`.
  Variants `default | destructive | outline | secondary | ghost | link`;
  sizes `default h-9 px-4 py-2`, `sm h-8 px-3 text-xs`, `lg h-10 px-8`, `icon h-9 w-9`.
- **Card** — `rounded-xl border bg-card text-card-foreground shadow`; header `p-6 space-y-1.5`; content `p-6 pt-0`.
- **Input** — `h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-base shadow-sm … md:text-sm`.
- **Label** — `text-sm font-medium leading-none`.
- **Badge** — `rounded-md border px-2.5 py-0.5 text-xs font-semibold`.
- **Table** — wrapper `relative w-full overflow-auto`; `w-full caption-bottom text-sm`; `th h-10 px-2 font-medium text-muted-foreground`; `td p-2`; row `border-b hover:bg-muted/50`.
- **Dialog** — `max-h-[calc(100dvh-2rem)] w-full max-w-lg` centred, `gap-4 p-6 shadow-lg sm:rounded-lg`, `data-[state=*]:animate-*` zoom 95% + fade, overlay `bg-black/80`.

### 6b. The *house* components — what the screens are really built from

| Component | File | Role |
|---|---|---|
| `page-banner` | `styles.css` | Gradient heading block that opens **every** screen |
| `MisPageTitle` | `mis/MisKit.tsx` | `text-lg font-bold md:text-xl`, action slot right |
| `MisFilters` | `mis/MisKit.tsx` | White filter card, responsive 1→2→N col grid, optional wide search row |
| `Field` | `mis/MisKit.tsx` | `label.form-label` + control |
| `MisTable` | `mis/MisKit.tsx` | Desktop `table-auto text-[11px]` + **mobile stacked `#eaf1f8` cards** + pagination (10/25/50/100, "Showing x to y of z entries", Prev/Next) |
| `MisDataCard` | `mis/MisKit.tsx` | The same pale-blue "Label :Value" panel, standalone |
| `MisModal` | `mis/MisKit.tsx` | `fixed inset-0 z-50 bg-slate-900/50 p-3 sm:p-6`, panel `rounded-lg bg-white shadow-2xl`, header `border-b px-4 py-3 text-sm font-bold`, body scrolls |
| `ActionButton` | `mis/MisKit.tsx` | Square icon button, `h-11 w-11 rounded-lg` mobile → `h-6 w-6 rounded` desktop; tones blue/amber/green/navy/red |
| `SearchButton` | `mis/MisKit.tsx` | `h-[52px]` mobile → `h-[34px]` desktop, navy |
| `ScrollArea` / `TableScroll` | `common/ScrollArea.tsx` | The single overflow implementation + paddle arrows |
| `Loader` / `LoaderBlock` / `LoaderOverlay` | `common/Loader.tsx` | The "Loading..." sweep wordmark |
| `RoleBadge` / `StatusBadge` | `staff/StaffUi.tsx` | `rounded`/`rounded-full` `text-[10px] font-bold ring-1` pills |
| `.form-label` `.form-field` `.form-section-title` `.btn-save` | `styles.css` | The shared form language |
| `.chip` / `.chip-row` | `styles.css` | Horizontally scrolling filter chips |
| `.page-header-actions` | `styles.css` | Full-width stacked actions on phones, inline on desktop |

### 6c. Utility classes defined globally

`scroll-area`, `scroll-x`, `scroll-y`, `scroll-both`, `no-scrollbar`,
`custom-scrollbar`, `table-sticky-head`, `table-responsive`,
`table-cell-limit`, `brand-gradient`, `page-banner`, `sidebar-gradient`,
`app-shell`, `value-card`/`value-face`/`value-detail`, `feedback-pill`,
`loader`/`loader-sm`/`loader-on-dark`/`loader-overlay`, `animate-fade-in`,
`modal-mobile`, `modal-body-scroll`, `chart-container`, `break-word`,
`no-print`, `px-responsive`, `w-screen-safe`, `stat-footer`, `grid-cards`,
`chip`/`chip-row`, `page-header-actions`, `nowrap`,
`form-label`/`form-field`/`form-section-title`/`btn-save`.

Scrollbar skin: 10px (12px on `hover: none`), thumb `#cbd5e1` → hover
`#94a3b8` → active `#64748b`, `border-radius: 9999px`, transparent 2px border
with `background-clip: content-box`. Global fallback `::-webkit-scrollbar` 5px.

---

## 7. Icons

**lucide-react** (`^1.34.0`), `iconLibrary: "lucide"` in `components.json`.
Sizes: `w-3 h-3` (desktop sub-nav) · `w-3.5 h-3.5` · `w-4 h-4` (standard) ·
`w-5 h-5` (header/actions) · `w-6 h-6` (mobile header) · `size-4` inside
shadcn buttons. Stroke width is default except the header refresh at
`strokeWidth={2.5}`.

The Lending Manager already uses `lucide-react` (`1.49.0`) — same library,
newer release. No icon change needed.

---

## 8. Responsive behaviour

| Breakpoint | Behaviour |
|---|---|
| `< 768px` | Sidebar off-canvas + scrim; header is a compact icon bar; tables → stacked `#eaf1f8` cards; forms → one column; all controls ≥ 44px; inputs 16px and full width; primary actions full width; filter chips scroll horizontally; modals `calc(100vw - 1.5rem)` |
| `≥ 768px` | Sidebar fixed at 256px; header offset `left-64`; main `ml-64`; tables at `text-[11px]`; forms compact (12px label / 13px field); actions inline |
| `≥ 1024px` | Filter grids go to 3–6 columns; header gains "Live Server" + user block |
| `≥ 1280px` | Header gains the flag |
| `≤ 640px` | `.px-responsive` → 0.75rem |
| `≤ 380px` | `.px-responsive` → 0.5rem |
| Overflow guard | `html, body { overflow-x: hidden; max-width: 100vw }`, `img/svg/video/canvas/iframe { max-width: 100% }`, word-break normal with `overflow-wrap: break-word` |
| Reduced motion | Loader sweep stops, value-card flip disabled |
| Print | `.no-print { display: none !important }`, `body * { overflow: visible !important }` |

---

## 9. Component mapping — reference → Lending Manager

| Reference | Lending Manager target | Action |
|---|---|---|
| `src/styles.css` `@theme` + `:root` + `.dark` | `app/globals.css` | Re-point every token to the reference's values; keep LM's token **names** (`accent`, `surface`, `page`, `text`, `sidebar`, status tones) so ~90 components inherit the look without edits; add the `chetu-*`/navy ramp, `--radius: 0.625rem` scale and the three `--shadow-*` |
| Google Fonts `<link>` in `__root.tsx` | `app/layout.tsx` | Add `next/font/google` Inter, weights 300–900, `display: swap`, as `--font-sans` |
| `.app-shell`, `.sidebar-gradient`, `.page-banner`, `.brand-gradient` | `app/globals.css` `@layer components` | Port verbatim |
| `.form-label` `.form-field` `.form-section-title` `.btn-save` | `app/globals.css` | Port verbatim (incl. the mobile→desktop size switch) |
| `.chip` `.chip-row` `.page-header-actions` `.scroll-area` `.table-sticky-head` `.loader*` `.animate-fade-in` | `app/globals.css` | Port verbatim |
| `Sidebar.tsx` (accordion, 256px, navy gradient, amber active) | `components/layout/primary-nav.tsx` + `app-shell.tsx` | Rebuild sidebar as the reference's gradient rail with brand block, role strip, **accordion groups**, amber active states, tree rule, user footer |
| `Header.tsx` (h-16 white, `md:left-64`) | `components/layout/app-shell.tsx` | Replace the glass header with the reference's white 64px bar: business-day card, Live Server pulse, user block, icon actions |
| `ProtectedLayout.tsx` | `components/layout/app-shell.tsx` | `md:ml-64 pt-16 sm:pt-20 px-3 sm:px-4 md:px-6 lg:px-8` on `.app-shell` |
| `page-banner` heading block | `components/ui/page-header.tsx` | `PageHeader` becomes the gradient banner (eyebrow chip + title + description), used by every page already |
| shadcn `Button` | `components/ui/button.tsx` | Adopt the new-york geometry (`h-9 px-4 rounded-md text-sm font-medium`, `sm h-8`, `lg h-10`) with navy `#0B4394` primary and the reference's variant set |
| shadcn `Card` | `components/ui/card.tsx` | `rounded-lg border border-slate-200 bg-white shadow-xs` (the shape the screens use) |
| `.form-field` / shadcn `Input` | `components/ui/input.tsx`, `label.tsx`, `field.tsx` | Flat bordered field + navy focus ring; label 12px/500 desktop, 16px/400 mobile |
| shadcn `Badge` + `StatusBadge` | `components/ui/badge.tsx` | `ring-1` pill tones at `text-[10px] font-bold uppercase tracking-wide` |
| `MisTable` | `components/ui/data-table.tsx` | Desktop `text-[11px]`, header `bg-slate-50 text-[10px] uppercase`, `px-2 py-2.5`, `divide-slate-100`, `hover:bg-slate-50`, sticky head |
| `MisTable` mobile cards | `components/ui/data-table.tsx` (new `MobileDataCard`) | The `#eaf1f8` "Label :Value" panel, available to the existing per-screen mobile lists |
| `MisFilters` | `components/reports/report-filters.tsx` | White filter card, responsive grid, navy search button |
| `MisModal` | `components/layout/*` modal/dialog usage | Centred white panel, `shadow-2xl`, bordered header, scrolling body |
| `ActionButton` | `app/globals.css` + call sites | Square icon action, 44px mobile → 24px desktop |
| `Loader` sweep | `components/ui/spinner.tsx` | Add the reference's `.loader` wordmark alongside the existing spinner |
| `Login.tsx` | `app/(auth)/layout.tsx`, `components/auth/sign-in-form.tsx` | Brand wash + blur orbs, glass sign-in card, 12px fields, navy submit |
| `EmptyState` (`Inbox`, "No details found!") | `components/ui/states.tsx` | Reference's empty/idle wording and `Inbox` + `text-slate-400` treatment |
| Pagination strip | `components/reports/report-pagination.tsx` | "Show: [n] entries", "Showing x to y of z entries", Prev/Next |
| `chetu-*` brand ramp | `app/globals.css` | Registered as Tailwind colours under a **neutral prefix** (`brand-*`), see §10 |

---

## 10. Deliberate deviations, and why

Each of these is a point where copying the reference exactly would break
something the task says to preserve. Nothing here is a design compromise; all
are either naming or legal/branding.

1. **Dark-mode mechanism.** The reference uses a `.dark` class
   (`@custom-variant dark`). The Lending Manager uses
   `@media (prefers-color-scheme: dark)`, and `tests/unit/colour-contrast.test.ts`
   parses `app/globals.css` by splitting on that exact string to prove WCAG AA
   on every status pair. Switching to a class variant deletes a passing
   accessibility guard. **Kept the media query**, and populated it with the
   reference's `.dark` slate values.

2. **Token names.** Token *values* are the reference's; token *names* stay the
   Lending Manager's (`--color-accent`, `--color-surface`, `--color-page`,
   `--color-text`, `--color-sidebar`, `--color-success` …). `phase9-screens.test.tsx`
   asserts `--color-accent`, `--color-accent-contrast` and `--color-accent-surface`
   exist in both themes and are exported via `@theme inline`; ~117 class
   references depend on them. Renaming to `--primary`/`--muted-foreground`
   would blank out every utility that uses them. The reference's shadcn names
   are added **as aliases**, so both vocabularies resolve.

3. **Brand identity.** `logo.svg`, `favicon.svg`, the "CHETU MICROFINANCE LTD"
   wordmark, the `#D32F2F` red used only for that wordmark, the Uganda flag,
   the "WE WANT / YOUR / FEEDBACK" chips and the five core-value cards are the
   reference company's own marks and copy — not design system. The Lending
   Manager keeps its own company name from
   `company_settings` / `getCompanyBranding()`. The brand *structure* (white
   logo tile + name + system subtitle, version chip) is reproduced; the
   reference's marks are not copied. The `chetu-*` colour ramp is ported by
   value under the neutral name `brand-*`.

4. **Navigation content.** The reference's menu (Groups, Members, Collections,
   Transfers, Business Day …) belongs to its business model. The Lending
   Manager's eleven destinations and their permission gates are unchanged —
   `tests/integration/navigation.test.tsx` asserts menu/route parity. Only the
   *presentation* becomes the reference's: gradient rail, accordion groups,
   amber active state, tree rule. The three existing groups
   (Operations / Insights / Administration) become the accordion's groups.

5. **Business Day.** The reference's header carries an open/close business-day
   workflow with its own tables. The Lending Manager has no such workflow. The
   header keeps the reference's exact business-day *card* shape and renders the
   real date in `Africa/Kampala` — the structure, not invented functionality.
   (This is what `app-shell.tsx` already does.)

**No business logic is touched.** Supabase client and schema, auth, roles and
permissions, loan calculations, payment allocation, penalties, repayment
schedules, routes, API route handlers, report queries and exports are not
modified. The work is confined to `app/globals.css`, `app/layout.tsx`,
`components/ui/*`, `components/layout/*`, the two auth presentation files, and
presentation-only class attributes on screens.

---

## 11. What changed during implementation

The audit above was written before any file was touched. These are the points
where carrying it out taught something the inspection had not, recorded here
so the next person does not have to rediscover them.

1. **Inter is self-hosted, not linked.** The reference links the Google Fonts
   stylesheet. This application fetches that same URL at build time through
   `next/font/google` and serves the resulting `.woff2` files itself — seven
   of them, one per weight. Same family, same weights, same `display: swap`,
   same binaries; no third-party request on load, no render-blocking round
   trip before first paint, and no IP address handed to Google by every member
   of staff on every visit. This is the only place the implementation departs
   from the reference's own mechanism rather than its result.

2. **The page banner's gradient interpolates in oklab.** The reference's
   stops are kept exactly. The declaration is then repeated with `in oklab`,
   because sRGB walks `#3d76bd` to `#d9a441` straight through grey and the
   last third of a wide banner washes out to a muddy tan. There is no way to
   feature-query a gradient's interpolation method, so it is two declarations:
   a browser that does not understand the second drops it and keeps the
   reference's original. Same endpoints, saturated path.

3. **The sidebar brand block wraps rather than truncates.** The reference's
   mark is the single word "CHETU", so `truncate` costs it nothing. A real
   company name is "Kyanja Credit Services", which truncates to "KYANJA CREDIT
   SE…". The brand block is the one place in the product that must never
   abbreviate the business's own name, so it takes two lines and
   `tracking-wide` instead of `tracking-wider`.

4. **The sidebar's open state needed a client island.** The reference holds
   `isSidebarOpen` in `ProtectedLayout` and passes it to both the rail and the
   header. This application's shell is a Server Component — it awaits the
   company's branding and reads the resolved session — so the boolean lives in
   `SidebarToggle`, the smallest component that can hold it. Everything passed
   into it stays on the server. The state is *derived* from the pathname
   rather than reset by an effect, because setting state in an effect body
   schedules a second render of the whole shell on every navigation.

5. **The accordion changed what the navigation tests could claim.** With
   groups collapsed by default, a test that queries for a hidden link passes
   whether the entry is correctly filtered out or merely inside a shut group —
   the weaker claim. `tests/integration/navigation.test.tsx` now opens every
   group before asserting, and three tests were added for the disclosure
   behaviour itself: that the group holding the current page opens, that the
   others stay shut, and that the dashboard is pinned above the accordion
   rather than duplicated inside it.

6. **Two defects were found by rendering the application, not by reading it.**

   - *Pagination lost its touch target.* Restyling the controls to the
     reference's compact chip dropped `min-h-touch`; the accessibility suite
     caught it. They are now 44px on a phone and the reference's 30px chip
     from `md` up. The visible labels are the reference's "Prev" and "Next",
     with "Previous page" and "Next page" as the accessible names — an
     abbreviation is fine to read and poor to hear.
   - *The arrears report had 240px rows.* Its fourteen-column table squeezed
     the prose "Latest note" column to 127px and wrapped it to thirteen lines,
     which set the height of every row. Pre-existing, but table overflow is
     the design system's to own, so `ReportTable` gained the reference's
     relative column-width mechanism (`MisTable`'s "a hint, not a share of
     100") and the note is clamped to two lines with the full text on hover.
     Rows are now 102px.

7. **`TableHead`'s `nowrap` prop is now a no-op.** A header cell never wraps,
   as in the reference. The prop is kept and marked deprecated so the thirty-
   odd `<TableHead nowrap>` call sites keep compiling and still get the
   behaviour they were asking for.

### Verification

- `typecheck`, `lint`, `format:check`: clean.
- 1703 unit and integration tests pass.
- Production build succeeds; Inter resolves to seven self-hosted `.woff2`
  files and the brand tokens survive minification (`--color-accent: #0b4394`,
  both gradients emitted verbatim).
- The application was rendered against the real stack — PostgreSQL with every
  migration applied, PostgREST, and the production build — at 1440×900 and
  390×844. All 26 page loads return 200 with no console errors.
- The Playwright suite, including its axe WCAG 2.1 AA sweep of every staff
  screen, the borrower portal and the sign-in page, passes at both viewports.

---

## 12. One pre-existing test defect, left alone

`tests/e2e/specs/clients.write.spec.ts:91` — *"a duplicate phone number is
refused with a message, not a crash"* — fails intermittently. It is not a
consequence of the redesign, and it is reported rather than fixed because
fixing it properly is a business-logic decision.

**The system does not refuse a duplicate client phone number.** There is no
such check anywhere:

- `createClientSchema` does not look for one;
- `createClientAction` handles `23505` for the National Identification
  Number only, and inserts the phone without a pre-query;
- the database has `clients_phone_idx`, a plain btree index — `CREATE INDEX`,
  not `CREATE UNIQUE INDEX` — and the only phone constraints are the E.164
  format checks and `clients_alternative_phone_differs`.

**The proof.** The spec was run in isolation and reported `10 passed`. The
database immediately afterwards:

```
 +256772106673 | 2 | Kabaale Testimony ahgghd | Nansubuga Second ahgghd
```

Two clients, one phone, created by the two tests — in a run the suite called
green. The test asserts `toHaveURL(/\/clients\/new/)` after submitting, and
that assertion is racing the navigation the successful registration triggers.
When the assertion wins, the test passes while the duplicate is written;
when the navigation wins, the test fails. It has never been testing what its
name says.

**Why it is not fixed here.** There are two honest resolutions and both are
the owner's to choose:

1. *The test is right and the product is wrong* — client phone numbers should
   be unique, which means a unique index, a migration, a pre-check and a
   message. That is new validation on production data that already contains
   duplicates, so it needs a decision about what to do with them.
2. *The product is right and the test is wrong* — two members of a household
   may share a phone, which is ordinary in this market, and the test should
   assert what the system does.

Either way it is a change to what the business considers valid, not to how a
screen is painted, so it sits outside a presentation-only redesign.
