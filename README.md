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
| `npm run test:db` | Database suite, then the three seeder projects — the synthetic seed, borrower reuse, and the member loan demonstration. Needs `DATABASE_URL`. |
| `npm run test:coverage` | Coverage report. |
| `npm run verify` | typecheck → lint → format:check → test:run → build. |
| `npm run check:env` | Validate environment configuration; exits non-zero on failure. |
| `npm run bootstrap:owner` | Create the first Owner/Administrator. Refuses if one exists. |
| `npm run db:types` | Regenerate `types/database.types.ts`. |
| `npm run db:local:setup` / `:migrate` / `:teardown` | Throwaway local cluster. |
| `npm run audit:money` | Scan for floating-point arithmetic on money. |
| `npm run seed:demo` | Polytos demonstration data: six members, their savings, a withdrawal and a reversal. **Refuses unless `POLYTOS_SEED_DEMO` is the exact enabling phrase and the database is on its allow-list.** Idempotent — running it twice posts nothing. Add `POLYTOS_SEED_MEMBER_LOANS` with its own phrase for the Phase 3 member loan scenarios, which are **local-only**: they publish a TEST ONLY policy version answering three decisions the client has not made. |
| `node scripts/verify-membership-upgrade.mjs` | The upgrade path: applies the pre-Polytos migrations, seeds a real book, applies the Polytos migrations on top, and proves every financial figure is identical. |
| `npm run e2e:up` / `e2e:down` / `e2e:env` | The end-to-end stack: PostgreSQL, the real PostgREST, an auth shim, a seeded database and the production build. |
| `npm run test:e2e` | Browser tests against that stack. Needs it up. |

## Verification baseline

Every later phase must keep these passing.

| Gate | Command | Result |
| --- | --- | --- |
| Type check | `npm run typecheck` | clean |
| Lint | `npm run lint` | clean |
| Format | `npm run format:check` | clean |
| Float-free money audit | `npm run audit:money` | 71 files, 5 engines, no hazard |
| Unit and component tests | `npm run test:run` | 2,441 passed |
| Database tests | `npm run test:db` | 1,677 passed (1,620 + 18 + 15 + 24) |
| Upgrade and financial regression | `node scripts/verify-membership-upgrade.mjs` | 28 figures identical |
| Browser tests | `npm run test:e2e` | 698 passed, 32 skipped |
| Production build | `npm run build` | succeeds |
| **Total** | | **4,816 assertions, 0 failed** |

`test:db` is four vitest projects run in sequence, each rebuilding the
database first: the schema suite, then the three seeders — the synthetic
demonstration, borrower reuse, and the Polytos Phase 3 member loans. Each
needs a database the others have not written to, and the reasons are in the
header of `vitest.config.mts`.

The Vitest count by phase: 398 at the end of Phase 1, then 603, 1,087, 1,462,
1,749, 2,003, 2,264, 2,576 and 2,757 through the first nine; then the upgrade
phases and the three Polytos phases, reaching 4,118. Browser assertions are
counted separately because they need a running stack rather than a test
runner. Each phase's own report carries its figures and how they were
produced; this table is the current total, not a history.

Each phase keeps every earlier test passing; where an earlier test changed it
is because the later phase deliberately changed the fact it asserted, and each
one is named in that phase's report.

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
| [docs/DECISIONS.md](docs/DECISIONS.md) | Why things are the way they are (ADR-001 … ADR-058). |
| [docs/AUTHENTICATION.md](docs/AUTHENTICATION.md) | Sign-in, sessions, roles, permissions, user management, RLS. |
| [docs/SECURITY.md](docs/SECURITY.md) | Posture, review results, known gaps. |
| [docs/DELIVERY.md](docs/DELIVERY.md) | The installable application, the service worker and what it may cache, CSP and headers, rate limits, UI conventions, what a page costs, health and version, deployment, Phase 10 handover. |
| [docs/PHASE-9-REPORT.md](docs/PHASE-9-REPORT.md) | Phase 9's completion report: the twelve defects running the application found, the verification results, the deviations and the handover. |
| [docs/PRODUCTION.md](docs/PRODUCTION.md) | Runtime, environment-variable matrix, build/run, HTTPS/domain/session, headers, rate limits, first-owner bootstrap, production data policy, observability. |
| [docs/BACKUP-RESTORE.md](docs/BACKUP-RESTORE.md) | Backup strategy, the proven restore drill, point-in-time recovery, disaster recovery and the migration-rollback caveat. |
| [docs/INCIDENT-RUNBOOK.md](docs/INCIDENT-RUNBOOK.md) | First actions for sign-in, payment, role, availability, deployment and compromise incidents, and the data-correction policy. |
| [docs/LAUNCH-CHECKLIST.md](docs/LAUNCH-CHECKLIST.md) | Launch-day gate, first-day operation, daily operation, and the NO-GO stop conditions. |
| [docs/PHASE-10-REPORT.md](docs/PHASE-10-REPORT.md) | Phase 10 production-readiness audit: test matrix, financial/RLS/security/recoverability evidence, CI, and the GO / CONDITIONAL-GO / NO-GO decision. |
| [docs/PLATFORM-UPGRADE-PLAN.md](docs/PLATFORM-UPGRADE-PLAN.md) | The audit, the gap analysis and the phased plan for the move to the full operations platform, with each phase's status. |
| [docs/REPORTING.md](docs/REPORTING.md) | Dashboards, the ten reports, one declaration per report, filters and the whitelist behind them, the CSV and the branded PDF, the client statement and the portal. |
| [docs/LEDGER.md](docs/LEDGER.md) | Branches, the chart of accounts, double-entry journals, cash position and the trial balance. |
| [docs/LOAN-PRODUCTS.md](docs/LOAN-PRODUCTS.md) | The configurable product catalogue, the guard-rail doctrine between a product and the business's settings, and the terms frozen onto a loan at approval. |
| [docs/UPGRADE-PHASE-1-REPORT.md](docs/UPGRADE-PHASE-1-REPORT.md) | Upgrade Phase 1: branches and the financial ledger, the historical backfill and the reconciliation evidence. |
| [docs/UPGRADE-PHASE-4-REPORT.md](docs/UPGRADE-PHASE-4-REPORT.md) | Upgrade Phase 4: the loan module reorganised — a typed closure, product-specific application data, guarantors captured on the application with a versioned undertaking, and the two defects building the screens found. |
| [docs/DEBT-AND-SECURITY.md](docs/DEBT-AND-SECURITY.md) | Security taken against a loan, releasing a guarantor, the append-only recovery file, promises to pay whose verdict is derived from the payments, aging buckets, PAR, and collections sliceable by branch and product. |
| [docs/UPGRADE-PHASE-5-REPORT.md](docs/UPGRADE-PHASE-5-REPORT.md) | Upgrade Phase 5: collections and Debt & Security — the migrations, the schema, the screens, the test counts, the reconciliation evidence and the commit. |
| [docs/NOTIFICATIONS.md](docs/NOTIFICATIONS.md) | The notification stream: one row per event addressed to a capability, read state per person, what raises each of the fourteen categories, why nothing is raised by the calendar, and the backfill that reconstructs the stream for the events that came before the triggers. |
| [docs/UPGRADE-PHASE-6-REPORT.md](docs/UPGRADE-PHASE-6-REPORT.md) | Upgrade Phase 6: notifications — the migrations, the schema, the screens, the test counts, the live verification and the commit. |
| [docs/UPGRADE-PHASE-7-REPORT.md](docs/UPGRADE-PHASE-7-REPORT.md) | Upgrade Phase 7: the Reports Center — one declaration per report, a PDF writer owned rather than installed, the four Debt & Security reports, and the guarantor-cover defect the parity method caught. |
| [docs/UPGRADE-PHASE-8-REPORT.md](docs/UPGRADE-PHASE-8-REPORT.md) | Upgrade Phase 8: the dashboard reads the modules built after it — portfolio at risk, promises and follow-ups, and what is waiting for a decision — and the two mislabelled counts that reconciling against the base tables caught. |

### Polytos — the membership and savings programme

| | |
| --- | --- |
| [docs/POLYTOS-MEMBERSHIP-REQUIREMENTS.md](docs/POLYTOS-MEMBERSHIP-REQUIREMENTS.md) | What the client's documents say, and what they leave unsaid. |
| [docs/POLYTOS-MEMBERSHIP-POLICY-DECISIONS.md](docs/POLYTOS-MEMBERSHIP-POLICY-DECISIONS.md) | What is settled, the **nine questions that are not**, which activity each one holds up, what Phase 2 did with the two that gate savings and Phase 3 with the three that gate lending — plus the fourth decision Phase 3 found, which is not one of the nine. **Read this before planning any later phase.** |
| [docs/POLYTOS-SIX-PHASE-ROADMAP.md](docs/POLYTOS-SIX-PHASE-ROADMAP.md) | The six phases, what each delivers, and what each is blocked on. |
| [docs/POLYTOS-EXPANSION-ARCHITECTURE.md](docs/POLYTOS-EXPANSION-ARCHITECTURE.md) | How the programme attaches to the existing lending system without forking it. |
| [docs/POLYTOS-MEMBERSHIP-SCHEMA.md](docs/POLYTOS-MEMBERSHIP-SCHEMA.md) | Phase 1: the membership foundation — tables, the effective-dated policy, the five readiness gates, RLS. |
| [docs/POLYTOS-PHASE-1-TEST-REPORT.md](docs/POLYTOS-PHASE-1-TEST-REPORT.md) | Phase 1's verification, figure by figure. |
| [docs/POLYTOS-SAVINGS.md](docs/POLYTOS-SAVINGS.md) | Phase 2: enrolment, verifiable consent, the savings subledger, contributions and qualification, the withdrawal lifecycle, RLS, and what the phase deliberately does not do. |
| [docs/POLYTOS-PHASE-2-TEST-REPORT.md](docs/POLYTOS-PHASE-2-TEST-REPORT.md) | Phase 2's verification, including the two defects only an authorisation test could find. |
| [docs/POLYTOS-MEMBER-LOANS.md](docs/POLYTOS-MEMBER-LOANS.md) | Phase 3: member loans, the eligibility engine, the savings pledge that moves no money, the calendar-month cadence, and the four decisions that keep lending closed. |
| [docs/POLYTOS-PHASE-3-TEST-REPORT.md](docs/POLYTOS-PHASE-3-TEST-REPORT.md) | Phase 3's verification, including the three defects the eligibility tests found in the ceiling. |

Five decisions worth knowing before writing any code here:

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
- **Member savings are a liability, never income.** A deposit increases what
  the business owes. Crediting an income account instead is invisible on every
  screen and overstates the year's surplus by the whole savings book. See
  ADR-051.

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
