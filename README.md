# Money Lending Management System

Loan, repayment and client management for a Ugandan money lending business.

> **Phases 1 to 8 complete.** This repository contains the database schema and
> security model; authentication, users, roles and capabilities; client and
> guarantor registration; the loan engine with reducing-balance interest,
> approval and disbursement; immutable repayment schedules; the payment ledger
> with allocations, receipts and reversals; arrears, the grace period and the
> one-time expiry penalty; and dashboards, reports, exports and the client
> portal.
>
> Still to come: PWA and offline support, production security hardening,
> reliability and go-live work (Phase 9 and beyond), and the integrations the
> business has deferred — MTN and Airtel APIs, SMS, WhatsApp and native
> applications.

> **The company name is temporary.** Registration is in progress, so the
> system runs under the working title above. It lives in
> `company_settings.company_name`, not in the code — renaming the business is
> one database update.

## Requirements

- Node.js 22 or newer
- A Supabase project (or the Supabase CLI with Docker, for a local stack)
- PostgreSQL client tools, if you want to verify migrations without Docker

## Setup

```bash
git clone <repository-url>
cd lending-manager
npm install

cp .env.example .env.local
# fill in NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY

npm run check:env     # confirms the configuration is valid
npm run dev           # http://localhost:3000
```

### Environment variables

| Variable | Required | Notes |
| --- | --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | yes | Project URL. Must be `https://`. |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | yes | `sb_publishable_…`. Public by design — all access is governed by Row Level Security. |
| `NEXT_PUBLIC_APP_ENV` | no | `development` \| `test` \| `staging` \| `production`. Defaults to `development`. |
| `NEXT_PUBLIC_SITE_URL` | no | Absolute base URL, for links in emails and receipts. |
| `SUPABASE_SECRET_KEY` | no | `sb_secret_…`. **Bypasses Row Level Security.** Unused in Phase 1. |
| `DATABASE_URL` | no | Direct PostgreSQL connection, for local database tests only. |
| `LOG_LEVEL` | no | `debug` \| `info` \| `warn` \| `error`. |

`.env.local` is git-ignored. **Never commit a real key.** Find both Supabase
keys under *Settings → API Keys* in the dashboard; the publishable key replaces
the legacy `anon` key, and the secret key replaces `service_role`.

Configuration is validated lazily, so `next build` succeeds without
credentials, and the application fails with a clear message the moment it
actually needs them. `npm run check:env` validates eagerly and exits non-zero —
run it in your deployment pipeline.

## Database

Migrations live in `supabase/migrations/` and apply in filename order.

### With Docker

```bash
supabase start
supabase db reset     # clean database, every migration, then seed.sql
npm run db:types      # regenerate types/database.types.ts
```

### Without Docker

A fallback that needs only a local PostgreSQL installation:

```bash
npm run db:local:setup                        # initdb, start, create, migrate
export DATABASE_URL="$(./scripts/pg-local.sh url)"
npm run test:db
npm run db:local:teardown
```

This creates a throwaway cluster under `.pglocal/` (git-ignored) and applies
`tests/helpers/supabase-shim.sql` first, which recreates just enough of a
Supabase project — the `auth` and `storage` schemas, the three roles, and
Supabase's default grants — for the migrations to apply unmodified. It is a
test harness and is never applied to a real project.

### Against a hosted project

```bash
npx supabase link --project-ref <ref>
npx supabase db push
```

Do not push to a production project without an explicit decision to do so.

See **[docs/DATABASE.md](docs/DATABASE.md)** for the schema, constraints, RLS
posture and what is deferred to Phase 2.

## Commands

| Command | Does |
| --- | --- |
| `npm run dev` | Development server. |
| `npm run build` | Production build. |
| `npm run start` | Serve the production build. |
| `npm run typecheck` | `tsc --noEmit`. |
| `npm run lint` | ESLint, type-aware. |
| `npm run format` / `format:check` | Prettier. |
| `npm run test` | Vitest, watch mode. |
| `npm run test:run` | Unit + integration. No database needed. **The CI gate.** |
| `npm run test:db` | Database suite. Needs `DATABASE_URL`. |
| `npm run test:coverage` | Coverage report. |
| `npm run verify` | typecheck → lint → format:check → test:run → build. |
| `npm run check:env` | Validate environment configuration; exits non-zero on failure. |
| `npm run bootstrap:owner` | Create the first Owner/Administrator. Refuses if one exists. |
| `npm run db:types` | Regenerate `types/database.types.ts`. |
| `npm run db:local:setup` / `:migrate` / `:teardown` | Throwaway local cluster. |
| `npm run audit:money` | Scan for floating-point arithmetic on money. |
| `npm run e2e:up` / `e2e:down` / `e2e:env` | The end-to-end stack: PostgreSQL, the real PostgREST, an auth shim, a seeded database and the production build. |
| `npm run test:e2e` | Browser tests against that stack. Needs it up. |

## Verification baseline

Every later phase must keep these passing.

| Gate | Command | Result |
| --- | --- | --- |
| Type check | `npm run typecheck` | clean |
| Lint | `npm run lint` | clean |
| Format | `npm run format:check` | clean |
| Float-free money audit | `npm run audit:money` | 58 files, no hazard |
| Unit and component tests | `npm run test:run` | 1,701 passed |
| Database tests | `npm run test:db` | 1,056 passed |
| Browser tests | `npm run test:e2e` | 339 passed |
| Production build | `npm run build` | succeeds |
| **Total** | | **3,096 assertions, 0 failed** |

The count by phase: 398 at the end of Phase 1, then 603, 1,087, 1,462, 1,749,
2,003, 2,264, 2,576 and 2,757 in Vitest — plus 339 browser assertions from
Phase 9, which are counted separately because they need a running stack rather
than a test runner. Each phase keeps every earlier test passing; where an
earlier test changed it is because the later phase deliberately changed the
fact it asserted, and each one is named in that phase's report.

Phase 9 is the phase to read on this subject. It passed every gate above and
the application was still unusable, because none of these gates opens the
application. The browser tests exist for that reason, and they found twelve
defects on their first run.

`npm run verify` runs the type check, the lint, the format check, `test:run`
and the build in one command. The database suite is separate because it needs a
PostgreSQL to talk to.

Database tests skip with an explanation when `DATABASE_URL` is unset. A skipped
suite is not a passing one — run it before accepting a schema change.

## Project layout

```
app/           Routes, layouts, error boundaries
components/    UI primitives and layout shell
config/        Build-time constants and seed defaults
lib/           Domain logic, validation, permissions, Supabase clients, errors, logging
types/         Generated database types
supabase/      Migrations and seed
tests/         unit | integration | db
scripts/       check-env, pg-local
docs/          Architecture, database, decisions, security
```

## Documentation

| | |
| --- | --- |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Layering, stack, configuration, clients, UI, testing. |
| [docs/DATABASE.md](docs/DATABASE.md) | Schema, relationships, constraints, RLS, functions, migrations. |
| [docs/DECISIONS.md](docs/DECISIONS.md) | Why things are the way they are (ADR-001 … ADR-012). |
| [docs/AUTHENTICATION.md](docs/AUTHENTICATION.md) | Sign-in, sessions, roles, permissions, user management, RLS. |
| [docs/SECURITY.md](docs/SECURITY.md) | Posture, review results, known gaps. |
| [docs/DELIVERY.md](docs/DELIVERY.md) | The installable application, the service worker and what it may cache, CSP and headers, rate limits, UI conventions, what a page costs, health and version, deployment, Phase 10 handover. |
| [docs/PHASE-9-REPORT.md](docs/PHASE-9-REPORT.md) | Phase 9's completion report: the twelve defects running the application found, the verification results, the deviations and the handover. |
| [docs/PRODUCTION.md](docs/PRODUCTION.md) | Runtime, environment-variable matrix, build/run, HTTPS/domain/session, headers, rate limits, first-owner bootstrap, production data policy, observability. |
| [docs/BACKUP-RESTORE.md](docs/BACKUP-RESTORE.md) | Backup strategy, the proven restore drill, point-in-time recovery, disaster recovery and the migration-rollback caveat. |
| [docs/INCIDENT-RUNBOOK.md](docs/INCIDENT-RUNBOOK.md) | First actions for sign-in, payment, role, availability, deployment and compromise incidents, and the data-correction policy. |
| [docs/LAUNCH-CHECKLIST.md](docs/LAUNCH-CHECKLIST.md) | Launch-day gate, first-day operation, daily operation, and the NO-GO stop conditions. |
| [docs/PHASE-10-REPORT.md](docs/PHASE-10-REPORT.md) | Phase 10 production-readiness audit: test matrix, financial/RLS/security/recoverability evidence, CI, and the GO / CONDITIONAL-GO / NO-GO decision. |

Three decisions worth knowing before writing any code here:

- **Money is whole shillings in `bigint`**, never a float. Rates are integer
  basis points: 15% is `1500`. See ADR-002 and ADR-003.
- **Instants are UTC; business days are Africa/Kampala.** Never use the host
  timezone to decide what day it is. See ADR-004.
- **Nothing is deleted.** Identity records are archived; financial records are
  reversed with a compensating entry. See ADR-006.
- **Row Level Security is the boundary.** Application checks decide what
  renders; the database decides what is allowed. Every policy routes through
  `current_profile_id()`, which is why disabling an account takes effect
  immediately. See ADR-015.

## What each phase built

**Built in Phase 9.** The way to run this application and the defences around
it: an end-to-end harness of real parts (PostgreSQL with every migration, the
real PostgREST binary, the production build) driven by a browser at two
viewports; a Content-Security-Policy with a per-request nonce; `HttpOnly`
session cookies and no Supabase client in the browser at all; per-action rate
limits; a service worker that caches static assets and never a figure; one
shared primitive each for money, dates, phone numbers, empty states and
row links; a phone navigation of four destinations and a More sheet; WCAG AA
across every screen in both themes; a health endpoint and a visible build
version. Twelve defects found by running it, each with a regression test — see
[docs/DELIVERY.md](docs/DELIVERY.md) and
[docs/SECURITY.md](docs/SECURITY.md#issues-found-and-fixed-in-phase-9). No
financial rule changed.

**Built in Phase 8.** Role-aware dashboards composed from capabilities;
collection, loan portfolio, arrears, grace-period, charges and client reports
with whitelisted filters, paging and CSV export; printable client statements;
the client portal's agreement figures, settled-loan history and per-loan
statement; the Manager remarks integration on the arrears report; an audit
viewer with filters and paging; and three reporting capabilities split by what
the figures reveal. No table, no new money rule — see
[docs/REPORTING.md](docs/REPORTING.md).

**Built in Phase 7.** Missed-payment carry-forward, derived arrears, two
separate lateness measures, the expiry date and grace period, and the one-time
50% penalty as its own obligation — with the contractual schedule untouched.

**Built in Phase 6.** The payment ledger: posting, interest-first allocation,
digital receipts, idempotency, Owner-only reversals, derived balances and
automatic clearance and reopening.

**Built in Phase 5.** Immutable repayment collection schedules for daily,
every-2-days and every-3-days repayment, generated inside the disbursement
transaction.

**Built in Phase 4.** The loan engine: reducing-balance interest in integer
shillings, draft/submit/approve/disburse/cancel with separated duties,
snapshotted terms and immutable client, guarantor and identity snapshots.

**Built in Phase 3.** Client and guarantor registration, identity documents in
private buckets, append-only staff remarks, client status and blacklisting, and
the portal's client linkage.

**Built in Phase 2.** Sign-in by phone number with a derived authentication
identity; session management and sign-out; three-layer route protection;
capability-based permissions mirrored into the database and enforced by Row
Level Security; user administration (create, search, filter, view, assign and
revoke roles, activate/deactivate, reset password); the self-service account
and change-password screens; a forced password change for administrator-issued
passwords; the client portal shell; a read-only audit viewer; automatic audit
of every identity change; privilege-escalation and last-Owner protections; and
the Owner bootstrap script.

**Built in Phase 1.** Database schema with constraints and RLS; roles and assignments;
company and business settings; concurrency-safe reference numbering; the
append-only audit foundation; private storage buckets; UGX integer money and
basis-point rates; Kampala-aware date handling; Ugandan phone normalisation;
validation schemas; error taxonomy; redacting logger; Supabase client
architecture; environment management; the responsive, accessible application
shell; and the three-project test suite.

**Deferred.** PWA and offline support, production security hardening,
reliability and backup work, go-live rate limiting, MTN and Airtel API
integration, SMS, WhatsApp, and native applications.

## Business rules the architecture is built around

Confirmed by the business and encoded as **configurable data** in
`business_settings`, not as constants:

- Minimum loan UGX 100,000; default monthly interest 15% on the reducing
  principal; terms of 1–3 months.
- Repayment daily, every 2 days, or every 3 days.
- A client may pay the exact installment due or more; a missed amount
  accumulates into the next one due, with no additional interest for missing it.
- Three-day grace period after expiry, then a one-time penalty of 50% of the
  remaining outstanding debt.
- One active loan per client.
- Payment by cash, MTN Mobile Money or Airtel Money.

None of this is implemented yet. It is recorded here, and reflected in the
schema, so that implementing it does not require restructuring.

## Contributing

1. Branch from the default branch.
2. Make the change. A schema change means a new migration — never edit an
   applied one — plus regenerated types in the same commit.
3. `npm run verify`, and `npm run test:db` if you touched the schema.
4. Open a pull request describing what changed and why.
