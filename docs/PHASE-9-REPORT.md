# Phase 9 completion report

**PWA, UX, security hardening and reliability.**
Baseline at entry: commit `e970f7f`, 2,584 Vitest tests passing, typecheck,
lint, format and the money audit clean.

---

## A. What this phase was actually about

The specification listed 144 sections across the installable application, the
interface, the browser's own defences and reliability. Underneath all of them
was one problem, and it is worth stating plainly because it shaped every
decision that follows.

Phases 1–8 shipped 2,584 passing tests, a clean typecheck, a clean lint and a
successful build — and three defects that made the product unusable. Every
authenticated page rendered an error boundary. `/users` returned a 500. No
payment could be recorded at all. Each was found within ten minutes of opening
the application in a browser, and none was visible to any gate the project had.

So the first thing Phase 9 built was a way to run the application, and the
second thing it did was run it. Twelve more defects came out of that. The
tests are the deliverable; the harness is what made them possible.

## B. The end-to-end harness

`tests/e2e/harness/` assembles the real thing out of real parts:

| Part | What it is |
| --- | --- |
| PostgreSQL | Real, with every migration applied from zero |
| PostgREST | The real binary — the same server Supabase runs |
| Auth | The one substitution: a minimal GoTrue-compatible shim |
| Next.js | The production build, not the dev server |

The auth service is replaced only because GoTrue ships as a container and this
project's sandboxes have no Docker. Everything the application's own code
touches is genuine: Row Level Security, the `SECURITY DEFINER` functions,
PostgREST's embedding rules, the JWT claims. That distinction earned itself
immediately — the `/users` defect was a PostgREST relationship ambiguity, which
no amount of talking to PostgreSQL directly would have found.

The seed is synthetic throughout: twelve invented borrowers with loans,
payments, arrears, a grace period, a late-payment charge, a draft, a pending
approval, an approved-but-not-disbursed loan, a cleared loan, an inactive
client and a blacklisted one. Phone numbers are in a range reserved for the
harness; identification numbers are generated patterns. No real person's
details appear anywhere in this repository.

Nine spec files, **339 assertions**, run at 1440×900 and 390×844.

## C. The twelve defects running it found

Each has a regression test. Full detail with causes and fixes is in
[SECURITY.md](SECURITY.md#issues-found-and-fixed-in-phase-9).

| # | Defect | Class |
| --- | --- | --- |
| 1 | A nested anchor on the overdue card broke hydration, and every control below the phone number stopped opening the loan | Correctness |
| 2 | `sr-only` on a `<table>` cannot clip, so the chart's accessible table pushed 390px of phone to 617px of document | Layout |
| 3 | `'unsafe-eval'` shipped in the CSP of every build not labelled `production` | Security |
| 4 | The session cookie was readable from `document.cookie` | Security |
| 5 | A missing record returned `200 OK` with a "not found" body | Correctness |
| 6 | A Mobile Money payment could reach the confirmation screen with no transaction reference | Correctness |
| 7 | A reversed payment's figure was not struck through on its own detail page | Money display |
| 8 | Status badges failed WCAG AA contrast — three of four in light mode, all four in dark | Accessibility |
| 9 | `opacity-70` on a settled report row took a link below the contrast floor | Accessibility |
| 10 | The proxy redirected signed-in callers away from every public path, so the health endpoint answered a monitor with HTML | Correctness |
| 11 | Every row of every list was prefetched: `/clients` downloaded twenty client pages nobody asked for | Performance |
| 12 | Focus was lost whenever a confirmation step replaced the step before it | Accessibility |

Two more were diagnostic rather than functional: the rate limiter reported
"Unknown limiter failure" for every database-side refusal (a `PostgrestError`
is not an `Error`), and a figure in the portal's prose bypassed the shared
money primitive.

Defects 1, 2, 5, 11 and 12 are of a kind no unit test can see: the component
renders correctly in isolation and the *assembled page* does not.

## D. The financial rules

Untouched, as required. The reducing-balance calculation, the interest rules,
schedule generation, payment allocation, oldest-first and interest-first
ordering, loan clearance, reversal logic, arrears, grace periods, the penalty
basis, rate and timing, and every reporting KPI definition are exactly as
Phase 8 left them.

No verified defect was found in any of them, so nothing was changed and
nothing needed documenting separately. `npm run audit:money` passes over 58
financial files with no hazard, and the 1,056-assertion database suite — which
is where those rules are proved — passes unchanged.

The only money-adjacent change is presentational: two figures in the portal's
prose now render through `Money` rather than through a template string, so the
same amount no longer reads two ways on one screen.

## E. The installable application

A manifest with a maskable icon and a 512px icon, both verified to exist and
to be images. `display: standalone`. An offline page that is precached and
carries no figure, no name and no balance.

The service worker keeps a **closed allow-list** of static assets and nothing
else. The governing rule, from the specification and honoured literally:

> Never cache live financial data as authoritative.

A cached balance is not a stale balance; it is a wrong balance that looks
right, handed to a cashier who then takes the wrong amount from a borrower
standing in front of them. So: GET only, navigations network-only with the
offline page as fallback, no API response cached, no page cached, and no
financial mutation ever queued for background sync.

Asserted by walking six screens and then reading every cache entry.

## F. The shared counter machine

The specification's §104–106 — a cache must never expose one user's private
data after logout or a user switch — is the requirement that shaped the
sign-out path. Sign-out sends the worker a `clear-caches` message, and the
browser tests assert the outcome: after signing out, the caches hold nothing
but static assets, browser storage holds no token-shaped key, and the next
person's pages are not the previous person's.

## G. Content-Security-Policy and the other headers

A per-request nonce with `strict-dynamic`, built in `lib/security/headers.ts`
and applied by the proxy. Not in `next.config.ts`, because a `headers()` entry
there is static by construction and a policy worth having needs a nonce minted
per response. `object-src 'none'`, `frame-ancestors 'none'`, `base-uri 'self'`,
`form-action 'self'`, and `connect-src` naming the project rather than `https:`.

`'unsafe-inline'` appears for **styles** only, because Next.js emits inline
style attributes for streaming and a nonce cannot attach to a style attribute.
It permits no script execution. It is the one concession and it is documented.

`'unsafe-eval'` is absent from every built artefact. The specification said to
avoid it in production unless unavoidable and documented; the harness found
that it was shipping to every deployment not *labelled* production, because
the gate was the deployment label rather than the dev server. It is now gated
on `NODE_ENV`.

Verification is three-layered, because a policy can be perfect as a string and
absent in effect: the string in the unit suite, enforcement in a browser (the
real header served on a document whose un-nonced inline script is asserted not
to run), and a no-violation sweep across six screens while the application
demonstrably runs.

Full table of headers and cache rules: [DELIVERY.md](DELIVERY.md#4-the-other-response-headers).

## H. Rate limits

Eleven actions, each with its own budget and its own documented stance on
store failure. The specification said not to use one simplistic global limit,
and the reason is concrete: a cashier records a payment every few seconds on a
busy morning, and a sign-in attempt every few seconds is somebody guessing a
password. Sign-in is 8 in 5 minutes and fails **closed**; recording a payment
is 60 a minute and fails **open**, because a database that cannot count is a
database that cannot post a payment either.

The specification also said not to depend solely on a spoofable client header.
The subject is the signed-in profile wherever there is one. Before sign-in
there is no profile, so it is the client address — and the sign-in limiter
additionally counts against the identifier being tried, so forging the header
moves an attacker between buckets without widening the budget on any account.

`consume_rate_limit` is granted to `authenticated` and `service_role` and
deliberately not to `anon`: an anonymous caller who could reach it could
exhaust a chosen account's sign-in budget and lock that person out. The
pre-authentication path therefore counts through the privileged client, which
is its only use anywhere in the application — it reads no data, writes no
record, and the verdict it returns cannot widen anyone's access.

A refusal says `Retry-After` and nothing else. No limit, no remaining
allowance, no number in the message.

`rate_limit_counters` stores a hashed bucket key, so a dump of the table says
that some action was limited and nothing else. RLS on, no policies, every grant
revoked; verified unreachable through the API.

## I. The privileged key

Never in a browser bundle, asserted against everything the browser actually
downloaded across five screens rather than against the source tree. No
`sb_secret`, no `service_role`, no `SUPABASE_SECRET_KEY`, and no global on
`window` matching `/supabase|secret|service/i`.

Stronger than required, and by accident: no Supabase client runtime reaches
the browser at all. Deleting the unused browser client — done to make the
session cookie `HttpOnly` — dropped GoTrue, PostgREST's query builder and the
Realtime client out of the bundle entirely. That is now a test, because if any
of it reappears then something in a Client Component has started talking to
the database directly, which would also break authentication.

## J. The interface

One primitive per concern, applied everywhere, because the specification was
explicit that pages must not be patched individually.

| Concern | Primitive |
| --- | --- |
| Money | `Money` — every figure on every screen, including inside a sentence |
| Dates | `DateValue` — `<time>` with the business timezone applied explicitly |
| Phone numbers | `PhoneValue` |
| Page headers and actions | `PageHeader`, `ActionLink` |
| Empty, loading, error, forbidden | `EmptyState`, `LoadingBlock`, `ErrorState`, `ForbiddenState` |
| Tables | `DataTable`, `ReportTable` |
| Per-row links | `RowLink` |
| Navigation feedback | `LinkPending` |
| Focus on a confirmation | `useFocusWhen` |

**Navigation.** The specification said the mobile bottom nav was not
acceptable, that four to five primary destinations plus a More menu was the
shape, and that shrinking text or scrolling ten items sideways were not
answers. The bar now holds four destinations and a More sheet; the sidebar
shows every destination grouped into Operations / Insights / Administration.
Asserted: exactly four links in the bar, no label clipped or ellipsised,
everything that left the bar reachable from More, no horizontal page scroll on
any of twenty-two screens at 390px.

**Charts.** Two, not dozens; tables remain authoritative. One shape
(`MagnitudeChart`), one hue. The single hue is a correctness decision, not a
stylistic one: this project's own `success` and `warning` separate by ΔE 5.8
under protanopia, below the floor at which colour may carry meaning even with
labels — so a reader with the commonest form of colour blindness could not
tell a grace period from arrears. Identity comes from the row label.

Every chart carries a table of the same rows, visually hidden on screen and
shown in print. No financial arithmetic lives in chart code: the figures
arrive already decided by the query that drew the table beside them, and
parity is asserted by reading the chart's own table and the report's table and
comparing them.

**The payment success page.** Derives the amount, receipt number, balance,
client and loan from the authoritative payment record. Asserted by visiting a
real payment with `?recorded=1&amount=999999999&receipt=FAKE-0001&balance=0`
and confirming neither the figure nor the receipt number appears.

## K. Accessibility

WCAG 2.1 AA, swept with axe across **32 screens at two viewports**: no
violations, and no allow-list. A finding judged not worth fixing would need a
written justification; none arose.

The sweep found that the status-badge system failed the contrast floor — three
of four colours in light mode, all four in dark, where the override had
redefined the four surfaces and left the four text colours at their light-mode
values. Every status badge in the application was dark ink on a dark tint, and
none of it looked obviously wrong in a screenshot: a badge at 4.1:1 is
perfectly legible to whoever chose the colour, on the screen they chose it on.
The new lightnesses are computed, and `tests/unit/colour-contrast.test.ts`
recomputes the ratios from `app/globals.css` so a token nudged for aesthetic
reasons fails a test rather than a review.

Beyond the sweep: a skip link as the first tab stop, `aria-current="page"` on
exactly one visible navigation link, colour never the only channel, and focus
moved to each confirmation panel so a reader hears what the step is and how
much money is about to change hands before being offered the button that
commits it.

## L. What a page costs

Measured in a browser from `transferSize`, because that is what crossed the
network and what somebody's airtime pays for.

| Page | Wire | JavaScript | Requests | First paint |
| --- | --- | --- | --- | --- |
| `/login` | 167 KB | 153 KB | 14 | 124 ms |
| `/` dashboard | 191 KB | 154 KB | 20 | 1388 ms |
| `/clients` | 197 KB | 159 KB | 32 | 188 ms |
| `/payments/new` | 194 KB | 164 KB | 25 | 180 ms |
| `/reports/collections` | 195 KB | 157 KB | 22 | 252 ms |

410 KB gzipped across forty chunks, largest 88 KB; no page loads all forty. No
chart, date or utility library. Budgets asserted with working room in
`tests/e2e/specs/performance.spec.ts` and `tests/integration/bundle.test.ts`.

The one performance defect found: every row of every list was prefetched.
`/clients` made 54 requests for one screen, 40 of them prefetches — twenty
client pages nobody had asked for. Invisible on an office line; on a phone on
mobile data it is twenty pages of somebody's airtime and twenty round trips on
the connection where a round trip is the expensive part. `RowLink` fixes it in
one place with the reason attached.

## M. Reliability

Loading, empty, error and forbidden states are shared primitives. Empty states
say *which* emptiness, because "no payments yet" and "no payments match this
filter" lead to different next steps, and they never imply a figure.

Double submission is handled at three levels, in order of what actually
protects the money: `post_payment` is idempotent on the key the form mints, the
form disables its own submit while pending, and the browser test presses the
button twice as fast as a finger manages and asserts that one payment and one
client result.

There is no toast system, deliberately. A message about money should not
vanish while somebody is reading it; the inline `Alert` uses `role="alert"` for
problems and `role="status"` for confirmations, which is announced on
insertion.

There is also no full-page loading spinner, and removing it fixed a
correctness defect: a root `loading.tsx` made Next flush the response shell
before any page had read anything, committing `200 OK` and leaving
`notFound()` nothing to set. Feedback now lives in the control that was
pressed, which is better feedback than blanking a working screen.

## N. Migrations

Two new, both additive, neither touching a Phase 1–8 migration:

| Migration | Contents |
| --- | --- |
| `20261009000100_company_identity.sql` | A `security_invoker = off` view exposing only the branding columns a borrower may read, because RLS is row-level and this needed to be column-level. Revoked from `anon`. |
| `20261009000200_rate_limits.sql` | `rate_limit_counters` with a hashed key, RLS on with no policies and every grant revoked; `consume_rate_limit`; `purge_expired_rate_limits`. |

The exhaustive database-inventory tests were updated with written
justifications for each new object, rather than loosened.

## O. Verification

| Gate | Command | Result |
| --- | --- | --- |
| Type check | `npm run typecheck` | clean |
| Lint | `npm run lint` | clean |
| Format | `npm run format:check` | clean |
| Money audit | `npm run audit:money` | 58 files, no hazard |
| Unit and integration | `npm run test:run` | **1,701 passed** |
| Database | `npm run test:db` | **1,056 passed** |
| Browser | `npm run test:e2e` | **339 passed** |
| Production build | `npm run build` | succeeds |
| Dependency audit | `npm audit --omit=dev` | 0 vulnerabilities |
| Secret scan | staged diff, and every body the browser downloaded | clean |

**3,096 assertions, 0 failures.** The baseline of 2,584 was preserved and
exceeded: 2,757 in Vitest plus 339 in a browser. Nothing was removed, skipped
or weakened. Eleven browser tests skip by viewport (a phone-only test on a
desktop project and vice versa), which is the mechanism working as intended.

Where an existing test changed, it was made stronger, not weaker:

- Assertions that broke when a figure moved inside `Money` were switched to
  `getByCompositeText`, which asserts the same sentence across element
  boundaries rather than a looser substring.
- The overdue tests were scoped by caption and by the mobile list's own
  selector when the chart added a second `<table>` to the page.
- The `'unsafe-eval'` test was split in two: the dev/production difference,
  and a new assertion that no build artefact gets it whatever it is labelled.
- The three browser-client tests were retargeted at `getPublicEnv`, which is
  where the guard they exercised actually lives, plus two new tests asserting
  that the deleted module stays deleted and that nothing creates a browser
  client.

## P. Deviations from the specification

| Section | Deviation | Why |
| --- | --- | --- |
| §16–17 | Two charts, not the handful implied | Every question this system asks of a picture has the same shape: compare magnitude across a handful of named things. A second chart form would have been a second thing to keep correct for no additional answer. |
| §43 | No toast system | Inline alerts, which do not vanish. A message about money should stay on screen until the person has acted on it. |
| §43 | No full-page loading spinner | Its boundary broke `notFound()` statuses, and marking the pressed control is better feedback than blanking a working screen. |
| §97 | The health endpoint reports four fields, not a richer payload | A health endpoint is the easiest thing on a deployment to probe. The first version used the privileged client to count a row; the ESLint rule restricting that import was right to refuse it, and the publishable-key probe establishes the same fact with no privilege. |

## Q. Known gaps

Tabulated in [SECURITY.md](SECURITY.md#known-gaps-after-phase-9). The
substantive ones:

- **Five high-severity advisories in development dependencies.** One chain,
  `eslint-config-next` → `braces`, with **no patched version published** — the
  advisory range is `<= 3.0.3` and 3.0.3 is the latest release. npm's only
  offered fix downgrades `eslint-config-next` by a major version for a Next 16
  project and would not fix it either. Development-only, runs in the linter,
  and the only glob patterns it ever sees are this repository's own.
  `npm audit --omit=dev` reports 0.
- **The auth service in the harness is a shim.** Every other part is real. The
  first deployment against a hosted project should re-run the browser suite
  pointed at it.
- **No Subresource Integrity**, because nothing is loaded from another origin.
  Required the moment a third-party script is added.
- **The dashboard's ~1.2 s time to first byte**, which is the summary queries.
  Recorded as a baseline rather than optimised: these are reporting figures
  and not something to change without evidence.

## R. What this phase deliberately did not do

No production cutover. No backup or restore drill. No live domain setup. No
launch certification. No Phase 10 work of any kind.

## S. Screenshots

74 screens captured from the running production build — every staff screen at
both viewports in light mode, seven in dark, the borrower's portal at both
widths, and the sign-in and offline pages. All data synthetic.

A literal before/after image comparison is not available: the pre-Phase-9
screenshots were produced in an earlier session and were lost when this
container restarted. The comparison is given instead as measured values, which
is the stronger form for most of these findings:

| Measure | Before | After |
| --- | --- | --- |
| `success` text on its badge tint, light mode | 4.11:1 | 4.67:1 |
| `info` on its tint, light mode | 4.30:1 | 4.68:1 |
| `warning` on its tint, light mode | 3.02:1 | 4.61:1 |
| All four, dark mode | 2.74–3.13:1 | 4.61–4.68:1 |
| `/overdue` document width at 390px | 617 px | 390 px |
| `/clients` requests for one screen | 54 | 32 |
| Missing-record HTTP status | 200 | 404 |
| `'unsafe-eval'` in a staging build's CSP | present | absent |
| Session cookie in `document.cookie` | present | absent |
| Supabase client runtime in the bundle | present | absent |
| WCAG AA violations across 32 screens | 4 classes | 0 |
| Destinations in the phone bottom bar | 11, seven unreadable | 4, plus a More sheet |

## T. Handover to Phase 10

[DELIVERY.md §10](DELIVERY.md#10-handover-to-phase-10) carries the table. The
items that bear on a production launch: backup and restore have never been
exercised; migrations are forward-only with no `down` path; observability is
structured logs with no aggregation, no alerting and nothing watching
`/api/health`; the Settings page is read-only; document storage has no
retention policy or deletion path.

One recommendation, from what this phase learned. The browser suite should run
in CI against the harness, on every change. The three defects that opened this
phase were each present for several phases and invisible to every gate the
project had, and the gates were not weak — they were simply not opening the
application. 339 assertions that do open it cost eight minutes.
