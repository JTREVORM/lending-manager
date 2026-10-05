# Delivery: the installable application, its defences, and its conventions

Phase 9's subject was everything around the money — how the application
reaches a phone, what the browser is allowed to do with it, what it costs to
open, and whether any of it works when a person actually uses it. This
document is the reference for those surfaces. The financial rules are in
[LOANS.md](LOANS.md) and [DATABASE.md](DATABASE.md), and none of them changed.

---

## 1. Why Phase 9 was verified by running the application

Phases 1–8 shipped 2,584 passing tests, a clean typecheck, a clean lint and
three defects that made the product unusable:

- every authenticated page rendered an error boundary;
- `/users` returned a 500;
- no payment could be recorded at all.

None was visible to the test suite, because none was a unit. The first was a
React Server Component boundary violation, the second a PostgREST relationship
ambiguity, the third a multi-step form that unmounted its own inputs. Each was
obvious within ten minutes of opening the application in a browser.

So the phase added a way to do that, and then did it. `tests/e2e/harness/` is
assembled from real parts:

| Part | What it is |
| --- | --- |
| PostgreSQL | Real, with every migration applied from zero |
| PostgREST | The real binary — the same server Supabase runs |
| Auth | The one substitution: a minimal GoTrue-compatible shim, because GoTrue ships as a container and these sandboxes have no Docker |
| Next.js | The production build, not the dev server |

```sh
npm run e2e:up          # database, PostgREST, auth shim, seed, build, serve
source <(npm run --silent e2e:env)
npm run test:e2e        # 339 assertions at 1440×900 and 390×844
npm run e2e:down
```

The seed is synthetic throughout: twelve invented borrowers, phone numbers in
a range reserved for the harness, generated identification numbers. It is not
in `npm test`, because that must stay runnable without a database.

### What running it found

Seven defects, each now with a regression test. They are tabulated in
[SECURITY.md](SECURITY.md#issues-found-and-fixed-in-phase-9). Two are worth
repeating here because of what they say about where to look:

- **A nested anchor** (`<a href="tel:">` inside a card-wide `<a>`) made the
  browser build different markup from the one React rendered. Hydration failed
  and every control below the phone number stopped working. No unit test can
  see this, because jsdom renders the component in isolation with no card
  around it.
- **`sr-only` on a `<table>`** does not clip, because `overflow` has no effect
  on `display: table`. The chart's accessible table laid itself out at full
  width and pushed 390px of phone to 617px of document.

Both are cases where the rendered output was correct and the *assembled page*
was not.

---

## 2. The progressive web app

### What it is for

A field officer's phone, on mobile data, often with no signal at all. The
application installs to the home screen, opens without browser chrome, and
tells the truth when there is no network.

### What the service worker may hold

`public/sw.js` keeps a **closed allow-list** of static assets: the build's own
chunks and stylesheets, the icons, the manifest, the favicon, and the offline
page. Nothing else, ever.

> **Never cache live financial data as authoritative.**
>
> A cached balance is not a stale balance. It is a *wrong* balance that looks
> right, handed to a cashier who then takes the wrong amount from a borrower
> who is standing in front of them. There is no presentation of a cached
> figure that makes this acceptable, so no figure is cached.

Concretely:

- GET only. A mutation is never intercepted and never queued for background
  sync — a payment that posts later, after the cashier has walked away and the
  borrower has gone, is worse than a payment that visibly failed.
- Navigations are network-only, with the precached `/offline` page as the
  fallback. `/offline` carries no figure, no name and no balance.
- No API response is cached. No page is cached.

### The shared counter machine

The machine on the counter is shared: one cashier signs out and the next signs
in. So sign-out sends the service worker a `clear-caches` message and the
end-to-end suite asserts the result — after signing out, the caches hold
nothing but static assets, browser storage holds no token-shaped key, and the
next person's pages are not the previous person's.

### Updating

The install handler does not call `skipWaiting`. A worker that activates
immediately can swap the application out from under a half-filled payment
form; the new version takes over on the next navigation instead.

---

## 3. Content-Security-Policy

Built per request in `lib/security/headers.ts` and applied by the proxy, which
already runs on every request. Deliberately **not** in `next.config.ts`: a
`headers()` entry there is static by construction, and a policy worth having
needs a nonce minted per response.

```
default-src 'self';
script-src 'self' 'nonce-<per-request>' 'strict-dynamic' https:;
style-src 'self' 'unsafe-inline';
img-src 'self' data: blob: <supabase origin>;
font-src 'self' data:;
connect-src 'self' <supabase origin> <supabase origin as wss:>;
frame-src 'none'; object-src 'none'; media-src 'none';
frame-ancestors 'none'; base-uri 'self'; form-action 'self';
worker-src 'self' blob:; manifest-src 'self'
```

| Decision | Reason |
| --- | --- |
| A nonce, not `'unsafe-inline'` | `'unsafe-inline'` permits every inline script, including one an injection put there. That is not a policy, it is a formality. |
| `'strict-dynamic'` | The chunks the bootstrap loads inherit trust, so the policy does not have to enumerate hashed filenames that change every build. It also makes the `https:` host-source ineffective in modern browsers, which is the point: there is no host this application wants to trust for script. |
| `https:` retained anyway | So a very old browser gets *a* policy rather than none. |
| `'unsafe-inline'` for **styles** only | Next.js emits inline style attributes for streaming, and a nonce cannot be attached to a style *attribute*. It permits no script execution. It is the one concession. |
| `connect-src` names the project | Not `https:`. A compromised page with `connect-src https:` can post the client list anywhere; this is the directive that stops exfiltration. |
| `'unsafe-eval'` gated on `NODE_ENV` | The dev overlay and React Refresh compile in the browser and exist only under `next dev`. Gating on the deployment *label* instead shipped `eval` to every staging build — see SECURITY.md. |

### How it is verified

Three ways, because a policy can be perfect as a string and absent in effect:

1. The string, in the unit suite.
2. **Enforcement**, in a browser: the real header is read off a live response,
   a document carrying that exact header is served on the same origin, and its
   un-nonced inline script is asserted not to have run.
3. **No violation**, swept across six screens while the application plainly
   runs — proven by the service worker having registered, which only happens
   from JavaScript the policy allowed.

A probe written as `page.evaluate` proves nothing: Chrome exempts evaluation
arriving over the devtools protocol from CSP, so both an injected `<script>`
and a bare `eval` succeed however strict the policy is. Both were tried.

---

## 4. The other response headers

| Header | Value | Why |
| --- | --- | --- |
| `X-Content-Type-Options` | `nosniff` | A CSV export must not be sniffed as HTML and executed. |
| `Referrer-Policy` | `strict-origin-when-cross-origin` | A loan URL contains a record's identifier; it does not travel to another site. |
| `X-Frame-Options` | `DENY` | Clickjacking, covered twice over with `frame-ancestors 'none'` for browsers that honour the newer directive. |
| `Permissions-Policy` | camera, microphone, geolocation and the rest denied | The application asks for none of them. |
| `Strict-Transport-Security` | production only | Sending it from a development server over plain HTTP pins a browser to HTTPS for a host that does not serve it. |

### Cache semantics

Every path that is not a build asset is `no-store`, applied on **every**
branch of the proxy — the signed-in page, the redirect to sign-in, and the
redirect away from it. A header set only on the happy path is a header that is
missing exactly when something has gone wrong.

Supabase's session refresh sets `Cache-Control` when it writes a cookie, and
those values are preserved. But it only does so on responses that *carry* a
cookie, and a signed-in page needing no refresh would otherwise go out with
whatever Next.js chose — which is how one borrower's balance ends up in a
shared cache and then on somebody else's screen.

---

## 5. Rate limits

Per action, never one global number. A cashier records a payment every few
seconds on a busy morning; a sign-in attempt every few seconds is somebody
guessing a password. One number cannot describe both, and the number that
protects sign-in would stop the business working.

| Action | Budget | On store failure |
| --- | --- | --- |
| `auth.sign-in` | 8 / 5 min | **closed** |
| `auth.password-change` | 5 / 15 min | **closed** |
| `users.create` | 10 / hour | **closed** |
| `users.reset-password` | 10 / hour | **closed** |
| `payments.create` | 60 / min | open |
| `payments.reverse` | 20 / hour | open |
| `loans.approve` | 20 / hour | open |
| `loans.disburse` | 20 / hour | open |
| `reports.export` | 10 / 10 min | open |
| `reports.read` | 120 / min | open |
| `uploads.document` | 20 / 10 min | open |

`closed` refuses the request when the counter cannot be reached, for the paths
where an unlimited attempt is worse than an outage. `open` lets it through: a
database that cannot count is a database that cannot post a payment either, so
refusing there would add a second, confusing failure on top of the real one.

### What is counted, and against whom

The subject is the **signed-in profile** wherever there is one — limiting a
logged-in cashier by IP would throttle the whole office, which shares one
connection. Before sign-in there is no profile, so the subject is the client
address, and that is the one case where a shared office connection is the
right thing to limit, because it is also where an attacker is coming from.

The address comes from forwarded headers, which anyone talking to the origin
directly can forge. It is used *only* for pre-authentication limits, and the
sign-in limiter additionally counts against the identifier being tried — so
forging the header moves an attacker between buckets without widening the
budget on any account.

### Why the pre-auth path uses the privileged key

`consume_rate_limit` is granted to `authenticated` and `service_role` and
deliberately **not** to `anon`. If an anonymous browser could call it, anyone
could exhaust a chosen account's sign-in budget and lock that person out —
turning a defence into a denial of service. So the pre-authentication limiter
counts through the privileged client and does nothing else with it: it reads
no data, writes no record, and the verdict it returns cannot widen anyone's
access. This is the **only** caller of that key, and it is why
`SUPABASE_SECRET_KEY` is required as of Phase 9.

### What a refusal says

`Retry-After`, and nothing else. "Wait a few minutes" tells a person what to
do; the limit and the remaining allowance would tell a script how fast it may
go. There is no `X-RateLimit-Limit` header and no number in the message.

### The store

`rate_limit_counters` holds a **hashed** bucket key, so a dump of the table
says that some action was limited and nothing else — not which phone number
somebody was trying, and not which staff member is near their export quota.
RLS is on with no policies and every grant is revoked: it is unreachable
through the API even with a valid key. `consume_rate_limit` is a single
`INSERT … ON CONFLICT`, so the row lock serialises concurrent attempts without
an explicit transaction.

---

## 6. User-interface conventions

These are the decisions that make the application read as one system. Each is
a shared primitive rather than a per-page choice, because "patch each page
separately" is how a figure ends up formatted two ways on one screen.

| Convention | Primitive | Rule |
| --- | --- | --- |
| Money | `components/ui/money.tsx` | Every figure on every screen, including figures inside a sentence. Tabular digits, non-breaking, grouped. A null amount is an em dash labelled "Not recorded", never `UGX 0` — "no figure" and "zero shillings" are different facts. A reversed figure is struck through with a title, never deleted. |
| Dates | `DateValue` | `<time dateTime>` with the business timezone applied explicitly. Never the browser's timezone: a collection due date is a business fact, not a local one. |
| Phone numbers | `PhoneValue` | International grouping, with an optional `tel:` link whose `href` is the canonical form. Never inside another link. |
| Page headers | `PageHeader`, `ActionLink` | One shape for a title, a description and the page's actions. |
| Empty states | `EmptyState` | Says *which* emptiness: "no payments yet" and "no payments match this filter" lead to different next steps. Offers the next step where there is one. Never implies a figure. |
| Errors | `ErrorState`, `app/error.tsx` | Plain language and a retry. Never a stack trace, a database code or a table name. |
| Row links | `RowLink` | `prefetch={false}`. A link rendered once per row is not a link a person is likely to follow, and prefetching twenty of them spends somebody's airtime on records they will never open. |
| Navigation feedback | `LinkPending` | A spinner in the control that was pressed, in a fixed-size box so nothing reflows. There is no full-page loading spinner: blanking a working screen is worse feedback than marking the thing that was tapped, and the boundary that produced it also broke 404 statuses. |
| Confirmation | two steps, then `useFocusWhen` | Every irreversible act — recording a payment, approving a loan, releasing money, reversing a payment — shows what is about to happen and asks again. The panel takes focus when it appears, so a reader hears what the step is and how much money is involved before being offered the button that commits it. |
| Charts | `MagnitudeChart` | One shape, one hue. Every chart carries a table of the same rows, visually hidden on screen and shown in print. No financial arithmetic in chart code: the figures arrive already decided by the query that drew the table beside them. |

### Navigation

Eleven destinations do not fit across 390px. The previous design tried and
produced labels reading `H…`, `Cli…`, `B…` — a navigation you cannot read is
not navigation.

- **Phone:** four destinations in the bottom bar plus a **More** sheet holding
  the rest. Four cells leaves roughly 78px each, which fits "Payments" at the
  bar's type size. Asserted: the bar holds exactly four links, no label is
  clipped or ellipsised, and everything that left the bar is reachable from
  More.
- **Laptop:** every destination, grouped into Operations / Insights /
  Administration. Eleven flat rows is a list you read; three short blocks is a
  map you scan.

Both are filtered by capability at render time from one definition, so a
hidden entry and a protected route cannot disagree. Hiding an entry is never
the protection — the route guard and Row Level Security are — it is the
courtesy that stops staff clicking into a refusal.

### Colour

Four status colours, each with a tint it is read on. Every pair clears 4.5:1,
in **both** themes, and `tests/unit/colour-contrast.test.ts` recomputes the
ratios from `app/globals.css` so a token nudged for aesthetic reasons fails a
test rather than a review. The badges are 12px, below the large-text
threshold, and they are read on a counter in daylight.

Colour is never the only channel. The current navigation destination is marked
by colour *and* a bar; a status is a colour *and* a word; a chart's identity
comes from the row label, not the hue.

---

## 7. What a page costs

Measured in a browser from `transferSize` — what crossed the network — rather
than from the size on disk, which is roughly three times larger and means
nothing to a bill.

| Page | Wire | JavaScript | CSS | Requests | First paint |
| --- | --- | --- | --- | --- | --- |
| `/login` (no cache at all) | 167 KB | 153 KB | 9 KB | 14 | 124 ms |
| `/` dashboard | 191 KB | 154 KB | 9 KB | 20 | 1388 ms |
| `/clients` | 197 KB | 159 KB | 9 KB | 32 | 188 ms |
| `/payments/new` | 194 KB | 164 KB | 9 KB | 25 | 180 ms |
| `/reports/collections` | 195 KB | 157 KB | 9 KB | 22 | 252 ms |

Measured at 390×844 against a local stack. Budgets are asserted in
`tests/e2e/specs/performance.spec.ts` with working room, not as round numbers.

The bundle is 410 KB gzipped across forty chunks, largest 88 KB. No page loads
all forty. There is no chart library, no date library and no utility library —
a bar is a div with a width, and a date is a string in the business timezone.

**No Supabase client runtime reaches the browser at all**: no GoTrue, no
PostgREST query builder, no Realtime. That is a consequence of deleting the
unused browser client, and it is asserted — if any of it reappears, something
in a Client Component has started talking to the database directly, which
would also break authentication, because it cannot read an `HttpOnly` session.

The dashboard's ~1.2 s time to first byte is the slowest thing in the
application and is the portfolio and collection summary queries. Recorded as a
baseline rather than optimised.

---

## 8. Health and version

`GET /api/health` is public and deliberately uninformative:

```json
{ "status": "ok", "dataApi": "ok", "version": "0.1.0", "environment": "production" }
```

503 when the data API is unreachable, so a monitor can watch the status line
without parsing the body. `no-store`, because a cached health check reports
the deployment's state at some earlier moment — precisely when a monitor is
looking for a change.

It reports no host, no database name, no schema version, no row count, no
query time and no reason for a failure. A health endpoint is the easiest thing
on a deployment to probe, so what it says is said to everybody.

The probe needs no privilege: it asks PostgREST for its own root with the
publishable key, and PostgREST answers there only once it has connected to
PostgreSQL. The first version used the privileged client to count a row; the
ESLint rule restricting that import was right to refuse it.

The same version string appears on the Settings page under "This build", so
"it is still not showing my change" is a question rather than an argument —
and on an installed application, where a stale service worker can serve
yesterday's shell, it is the first thing worth checking.

---

## 9. Deployment

### Environment

`npm run check:env` validates everything below and says plainly what is wrong.
Run it before every deployment.

| Variable | Required | Notes |
| --- | --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | yes | The project URL. |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | yes | `sb_publishable_…`. Carries no privileges; all access is decided by RLS. |
| `SUPABASE_SECRET_KEY` | **yes, as of Phase 9** | `sb_secret_…`. One caller: the pre-authentication rate limiter. Without it, sign-in fails closed. Never a `NEXT_PUBLIC_` variable. |
| `NEXT_PUBLIC_APP_ENV` | recommended | `development` / `test` / `staging` / `production`. Controls HSTS and log verbosity. Does **not** control `'unsafe-eval'` — that is `NODE_ENV`. |
| `NEXT_PUBLIC_SITE_URL` | recommended | For absolute links. |
| `DATABASE_URL` | local tooling only | Migration verification and the database test suite. Never read by the application. |
| `LOG_LEVEL` | optional | `debug` / `info` / `warn` / `error`. |

### Order of operations

1. `npm run verify` — typecheck, lint, format, unit and integration tests, build.
2. `npm run test:db` against a throwaway database — 1,056 assertions about the schema, RLS and the functions.
3. `npm run audit:money` — the financial-arithmetic scanner.
4. `npm run e2e:up && npm run test:e2e` — 339 browser assertions.
5. Apply migrations to the target project in filename order. **Never modify a migration that has been applied.**
6. Deploy the build.
7. `curl https://<host>/api/health` — expect 200 and the version you deployed.
8. Open `/settings` and confirm the same version under "This build".

### What this phase deliberately did not do

No production cutover, no backup or restore drill, no live domain setup, no
launch certification. Those are Phase 10's, and nothing here should be read as
having done them.

---

## 10. Handover to Phase 10

Known gaps are tabulated in
[SECURITY.md](SECURITY.md#known-gaps-after-phase-9). The ones that bear on a
production launch:

| Item | State |
| --- | --- |
| Backup and restore | Never exercised. A backup that has not been restored is a hypothesis. |
| Migration rollback | Forward-only. No `down` migration exists for any phase. |
| Observability | Structured logs only. No aggregation, no alerting, no error tracking, and nothing watching `/api/health`. |
| Settings editing | The Settings page is read-only. Changing a value is a privileged write with cross-field rules the database enforces; the screen for it has not been built. |
| Document storage | Photographs and identification documents upload to a private bucket. No retention policy, no deletion path, no size budget per client. |
| The auth shim | Fine for testing. A hosted deployment uses real GoTrue, and the first deployment against it should re-run the end-to-end suite pointed at that project. |
| Dashboard query cost | ~1.2 s TTFB locally. Worth measuring against a real project under real volume before deciding whether it needs work. |
