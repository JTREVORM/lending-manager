# Production deployment

How this system is configured, deployed and validated for real business use.
It is the companion to `SECURITY.md` (threat model and controls),
`BACKUP-RESTORE.md` (recoverability), `INCIDENT-RUNBOOK.md` (operations) and
`LAUNCH-CHECKLIST.md` (the go-live gate).

Nothing in this file contains a real credential. Values below are names and
shapes only.

## 1. Runtime

- **Node.js ≥ 22** (the engine pinned in `package.json`).
- **Next.js 16** production server (`npm run build` then `npm run start`), or an
  equivalent managed Next.js host. The application is server-rendered; it is
  **not** a static export.
- **PostgreSQL** via Supabase (hosted) or any Postgres that the migrations in
  `supabase/migrations/` apply to from zero. PostgREST is the data API.
- The process is **stateless**. It keeps nothing on local disk between
  requests, so an ephemeral filesystem is fine; uploaded documents live in
  Supabase Storage, not on the app host.

## 2. Environment variables

`npm run check:env` validates these before a deploy and exits non-zero, listing
every problem, if the configuration is unsafe. Run it in the release pipeline
(it is part of CI’s build job via the production build’s own env validation).

| Variable | Scope | Required | Secret | Purpose |
| --- | --- | --- | --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | client+server | yes | no | Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | client+server | yes | no | Publishable (anon) key — safe in the browser |
| `NEXT_PUBLIC_APP_ENV` | client+server | yes | no | `production` in production. Gates `'unsafe-eval'` **off** and HSTS **on** |
| `NEXT_PUBLIC_SITE_URL` | client+server | yes | no | Canonical origin, e.g. `https://app.example.com` |
| `SUPABASE_SECRET_KEY` | **server only** | yes | **yes** | Service key for privileged server calls. **Never** exposed to the browser |
| `DATABASE_URL` | server only | prod: optional* | yes | Direct Postgres URL for migrations/admin tasks |
| `LOG_LEVEL` | server only | no | no | `error` / `warn` / `info` |
| `BOOTSTRAP_OWNER_PASSWORD` | server only | no | yes | One-time: the first Owner’s password. If unset, a crypto-random one is generated and printed once |

\* `DATABASE_URL` is used by migration/admin tooling and the database test suite,
not by the running web app (which talks to PostgREST with the two Supabase keys).

**Rules**
- Only variables prefixed `NEXT_PUBLIC_` reach the browser. `SUPABASE_SECRET_KEY`
  and `DATABASE_URL` must never carry that prefix and are verified absent from
  the built client bundle in CI.
- `NEXT_PUBLIC_APP_ENV` must be exactly `production` in production. Any other
  value keeps the development conveniences (`'unsafe-eval'` in the CSP) enabled.
- Startup fails safely: a missing or malformed required variable stops the
  deploy rather than serving a half-configured application.

## 3. Build & run

```
npm ci
npm run check:env        # fail fast on bad configuration
npm run build            # production build; validates no secret in the bundle
npm run start            # serve
```

`npm run verify` runs typecheck + lint + format + unit/integration + build in
one command, which the release pipeline should gate on alongside the database
and browser suites.

## 4. HTTPS, domain and session

- **All traffic over HTTPS.** Terminate TLS at the platform edge and redirect
  HTTP → HTTPS there.
- **HSTS** is emitted only when `NEXT_PUBLIC_APP_ENV=production`
  (`max-age=63072000; includeSubDomains`). Do not enable it until the domain is
  firmly HTTPS-only, because it is sticky.
- The **session cookie** is `HttpOnly`, `SameSite=Lax`, `Secure` in production,
  `Path=/`. Nothing in the browser reads it.
- Set the Supabase **Auth redirect URLs** and **Site URL** to the production
  origin. `NEXT_PUBLIC_SITE_URL` must match.
- PWA: `start_url` is `/` and the service worker scope is the origin root; both
  follow the deployed origin automatically.

## 5. Security headers (verified live by `tests/e2e/specs/security.spec.ts`)

- **CSP**, per-request nonce + `strict-dynamic`; `default-src 'self'`;
  `object-src/frame-src/media-src/frame-ancestors 'none'`; `base-uri`/`form-action`
  `'self'`; `connect-src`/`img-src` scoped to self + the Supabase origin.
  `'unsafe-eval'` is present **only** under the dev server, never in production.
- `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`,
  `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy`,
  `Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Resource-Policy: same-origin`.
- Pages that carry money set private `Cache-Control` so no shared cache stores them.

## 6. Rate limits (see `lib/security/rate-limit.ts`)

Per-action, keyed by signed-in profile where there is one and by client IP
pre-auth. Backend-failure behaviour is deliberate per action — fail-**closed**
for security-critical paths (sign-in, password change, user create/reset,
reversal, disbursement), fail-**open** for availability-critical,
idempotency-protected paths (payment capture, approvals, reads, exports).

## 7. First Owner

Create the first Owner/Administrator with `npm run bootstrap:owner` (see
`scripts/bootstrap-owner.ts`). It refuses to run twice, hard-codes no password,
prints a crypto-random one once, and sets `must_change_password` so the account
must set a new password on first sign-in. There are no seeded production users
and no default credentials anywhere in the production path.

## 8. Production data policy

- Production receives **migrations only** — schema and the required reference
  data (roles, permissions, repayment frequencies, reference formats). It never
  runs the synthetic seed (`tests/e2e/harness/seed.mjs`), which exists for tests
  and demos only.
- Before the first loan, review company settings (name, timezone, currency,
  minimum/maximum loan, interest rate, grace period, penalty rate, repayment
  frequencies, reference formats). The engines read these at approval time.

## 9. Observability

- Structured application logs at `LOG_LEVEL`; errors, auth failures (without
  secrets or NINs) and financial-mutation failures are logged server-side.
- `/api/health` reports process up, database reachable, and the build id, and
  deliberately nothing else (no host, schema, counts or failure reasons).
- **Recommended before or shortly after launch** (launch condition, not a
  blocker): wire an external error monitor (e.g. Sentry) and uptime/alerting for
  app-down, DB-down, high error rate, backup failure and auth/rate-limit spikes.
  Strong structured logs exist today; external aggregation is not yet configured.
