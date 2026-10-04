# Architecture

## The shape of it

```
app/                      Routes, layouts, error boundaries
  (app)/                  Authenticated staff area (force-dynamic)
components/
  ui/                     Primitives: Button, Input, Label, Field, Card, Badge, Alert, Spinner
  layout/                 Shell, navigation, phase placeholder
config/                   Build-time constants and database-seed defaults
lib/
  domain/                 Money, rates, dates, phone numbers, references, statuses
  permissions/            Role vocabulary and permission checks
  validation/             Zod schemas and the bridge to the error taxonomy
  supabase/               Browser, server, privileged and proxy clients
  data/                   Data access
  utils/                  cn(), server-only guard
  errors.ts               Error taxonomy
  db-errors.ts            SQLSTATE → application error
  logger.ts               Structured logging with mandatory redaction
  env.public.ts           Browser-safe configuration
  env.server.ts           Server-only secrets (`server-only`)
types/                    Generated database types
supabase/
  migrations/             Versioned schema changes
  seed.sql                Local development data (intentionally empty)
tests/
  unit/                   Pure logic
  integration/            Components and static migration analysis
  db/                     Real PostgreSQL
  helpers/                Test harness, including the Supabase shim
scripts/                  check-env, pg-local
docs/                     This directory
proxy.ts                  Session refresh (Next.js 16 renamed middleware to proxy)
```

## The layering rule

Business logic does not live in React components. The reason is concrete
rather than stylistic: Phase 3's reducing-balance interest engine must be
deterministic and testable in isolation, and anything reachable only by
rendering a component is neither.

```
   UI (app/, components/)
        ↓ calls
   Data access (lib/data/)
        ↓ uses
   Domain + validation (lib/domain/, lib/validation/, lib/permissions/)
        ↓ sits on
   Clients + config (lib/supabase/, lib/env.*, config/)
        ↓ reaches
   PostgreSQL (constraints, RLS, functions)
```

Dependencies point downward only. `lib/domain/` imports nothing from `app/`,
`components/` or `lib/supabase/` — it is pure, synchronous and has no I/O,
which is what makes `tests/unit/` fast and exhaustive.

Where Phase 3 will put the engine: `lib/domain/loan.ts` and
`lib/domain/schedule.ts`, built from the primitives already in
`lib/domain/money.ts` (`applyRateBps`, `divideEvenly`) and
`lib/domain/datetime.ts` (`addBusinessDays`, `businessToday`).

## Stack

| | | Why |
| --- | --- | --- |
| Next.js | 16.3 | App Router; Server Components keep data access off the client. |
| React | 19.3 | |
| TypeScript | 6.0 | Strict, plus `noUncheckedIndexedAccess`. Capped below 7 because `typescript-eslint` 8 requires `<6.1`. |
| Tailwind CSS | 4.3 | CSS-first `@theme` tokens; no config file. |
| Supabase | `supabase-js` 2.117, `ssr` 0.12 | PostgreSQL, Auth, Storage, and RLS as the real security boundary. |
| Zod | 4.6 | Schemas shared by forms, Server Actions and domain operations. |
| Vitest | 5.0 | Three projects: unit, integration, db. |
| ESLint | 9.39 | Type-aware. Pinned below 10: `eslint-plugin-react`, bundled inside `eslint-config-next`, uses an API ESLint 10 removed. |

## Configuration

Three layers, deliberately distinct:

1. **`config/app.ts`** — build-time identity and conventions: application name,
   locale, `Africa/Kampala`, route paths. If the Owner/Admin should be able to
   edit it from a screen, it does not belong here.
2. **`config/defaults.ts`** — the values migration `…0800` seeds, and the
   fallback the shell renders before the database is readable. Never used by a
   calculation.
3. **The database** — `company_settings` and `business_settings` are the
   runtime source of truth.

The company name is therefore never a UI constant. `lib/data/company.ts` reads
it and reports whether the answer came from the database or the fallback; the
dashboard displays which. When registration completes, one `UPDATE` renames the
system everywhere.

## Environment variables

`lib/env.public.ts` holds browser-safe values; `lib/env.server.ts` imports
`server-only`, so Next.js fails the build if a Client Component pulls it in.
An ESLint `no-restricted-imports` rule gives the same signal faster.

Validation is **lazy** — an accessor throws a `ConfigurationError` listing every
problem at the moment configuration is first needed, rather than at import.
That lets `next build` succeed in a CI job holding no credentials while a
misconfigured runtime still fails loudly. `npm run check:env` validates eagerly
for deployment pipelines, and exits non-zero.

## Supabase clients

| Module | Key | Use |
| --- | --- | --- |
| `lib/supabase/client.ts` | publishable | Client Components. |
| `lib/supabase/server.ts` | publishable | Server Components, Actions, Route Handlers. |
| `lib/supabase/proxy.ts` | publishable | Session refresh in `proxy.ts`. |
| `lib/supabase/admin.ts` | **secret** | Privileged operations with no user context. Unused in Phase 1. |

The server client uses the *publishable* key deliberately: it reads the user's
session from request cookies and acts as that user, so RLS applies exactly as
it does in the browser. A server context is not a reason to escalate privilege.

A fresh client is created per request. A module-scope client on a serverless
platform would be reused across requests and would serve one user's data to
another.

`admin.ts` bypasses RLS and is not a convenience for when RLS is inconvenient.
If a query fails under RLS, the fix is a correct policy. It takes a mandatory
`reason` argument so the justification is visible in the diff, and three
independent guards keep it off the client: the `server-only` import, the ESLint
rule, and a runtime `assertServerOnly()`.

## Errors

`lib/errors.ts` gives every deliberate failure a class, a stable code, an HTTP
status and two separate messages: a developer-facing one that is logged, and a
`userMessage` that is safe to show staff. `toPublicError()` is the only
sanctioned way to turn an error into something a browser sees; it never
includes the cause, the stack or anything not explicitly marked safe.

`lib/db-errors.ts` maps SQLSTATEs to that taxonomy. A `PostgrestError`'s
`message`, `details` and `hint` routinely contain table names, constraint names
and row values, so they are attached as the `cause` — logged — while the user
gets a sentence written for them.

`isOperational` separates anticipated failures (validation, authorization,
business rules) from bugs and outages, so monitoring can treat them differently.

## Logging

`lib/logger.ts` redacts by key name *and* by value shape, because
`{ note: 'sb_secret_…' }` leaks as badly as `{ secret: … }`. Key matching strips
separators, so `api_key`, `apiKey` and `x-api-key` are one rule. `console` is
forbidden everywhere else by ESLint, so nothing can bypass it.

It is not the audit trail — see ADR-009.

## UI

Mobile-first, because staff work from phones at a counter. Below 768px a fixed
bottom tab bar within thumb reach; at 768px and above a persistent sidebar. No
collapsing drawer: that needs focus trapping, an escape handler and a scroll
lock to be accessible, and none of it earns its keep for five links.

Accessibility is built into the primitives rather than reapplied per screen.
`Field` wires label, hint and error together with generated ids,
`aria-describedby`, `aria-invalid` and `role="alert"`. Buttons are `<button>`,
navigation is `<a>`. Minimum touch target is 44px at every size. Zoom is not
blocked.

Verified across seven viewports from 320px to 1920px: no horizontal overflow,
no target below 44px, no text below 11px, exactly one `<h1>` and one `<main>`
per page, a working skip link and visible focus rings.

## Testing

| Project | Environment | Needs | Covers |
| --- | --- | --- | --- |
| `unit` | node | — | Money, rates, dates, phones, references, roles, permissions, validation, errors, logging, env. |
| `integration` | jsdom | — | Component accessibility, navigation, static migration analysis. |
| `db` | node | `DATABASE_URL` | Schema, constraints, triggers, RLS, grants, concurrency. |

`npm run test:run` runs unit + integration and needs no database, so it is the
CI gate. `npm run test:db` runs the database suite and skips with an
explanation when `DATABASE_URL` is unset — a distinction the Phase 1 report
states explicitly, because "did not run" is not "passed".

## What Phase 1 does not include

No authentication flows, no permission matrix beyond the Phase 1 surfaces, no
client or guarantor registration, no loans, no schedules, no payments, no
arrears, no penalties, no client portal, no reports, no mobile-money
integration, no PWA. Each unbuilt section renders a placeholder naming its
phase and what it will do, rather than an empty table implying a working
screen.

## Phase 3 — clients and guarantors

The client and guarantor module, its permission matrix, Row Level Security,
storage rules, duplicate handling, search and audit behaviour are documented in
[CLIENTS.md](CLIENTS.md).

## Phase 4 — the loan engine

The interest model, the rounding policy, the lifecycle and its state machine,
the snapshot architecture, the one-active-loan rule and the Phase 5 handoff are
documented in [LOANS.md](LOANS.md).

## Phase 5 — the repayment schedule engine

The contract-versus-collection-plan distinction, the date rules (period
windows, first due date, month-end clamping, leap years, the Kampala timezone
anchor), the integer allocation and remainder policy, schedule immutability,
disbursement atomicity and the Phase 6 handoff are documented in the Phase 5
sections of [LOANS.md](LOANS.md).

Two tables are added: `loan_schedules` (one generation record per loan,
carrying the cadence snapshot) and `loan_installments` (the collections
themselves). Both are append-only and carry no payment state — see ADR-026.

## Phase 6 — payments, balances, receipts and reversals

The payment model, the allocation order, the minimum-payment and overpayment
rules, idempotency, balance derivation, clearance, the reversal model, receipt
semantics, permissions, Row Level Security and the Phase 7 handoff are
documented in the Phase 6 sections of [LOANS.md](LOANS.md).

Two tables are added — `loan_payments` and `payment_allocations`, both
append-only — together with three derived views: `loan_installment_coverage`,
`loan_balances` and `payment_collection_totals`. No balance is stored
anywhere; every figure is computed on read from the immutable schedule and the
allocations of posted payments, so a reversal changes every answer at once and
nothing can disagree with the ledger. See ADR-028 through ADR-032.

The allocation rule exists twice, deliberately: `public.post_payment` is
authoritative and writes the ledger, while `lib/domain/payment.ts` drives the
preview a staff member confirms against. `tests/db/payment-parity.test.ts`
reconciles the two across thirty randomly paid-off loans, the same way
`schedule-parity` does for Phase 5.

## Phase 7 — missed payments, arrears, grace and penalties

Arrears, the carry-forward of missed collections, the two lateness measures,
expiry and grace, the penalty rule and its basis, the delinquency states, the
penalty-aware balances and clearance rule, permissions, Row Level Security and
the Phase 8 handoff are documented in the Phase 7 sections of
[LOANS.md](LOANS.md).

**One table is added — `loan_penalties`** — and it is the only mutable-looking
thing in the phase: refused UPDATE and DELETE for every caller, with its amount
re-derived from its basis and rate by a CHECK constraint and one row per loan
per penalty type enforced by a unique index. Everything else about delinquency
is a view: `loan_penalty_coverage`, `loan_obligations`, `loan_delinquency`, and
a restated `loan_balances`. There is no arrears column, no days-past-due
column and no delinquency-status column anywhere, so no role — Owner and
`service_role` included — can edit a borrower into or out of arrears. See
ADR-033.

`payment_allocations` is generalised rather than duplicated: exactly one of
`installment_id` and `penalty_id` is set, enforced with the component CHECKs
that keep a penalty from ever being recorded as principal or interest. Existing
rows satisfy all of it unchanged, which is why no Phase 6 receipt moves.
See ADR-036.

**Time has one source.** `public.business_now()` → `business_date()` is what
every Phase 7 comparison uses; nothing reads `current_date`, the server's
timezone or a UTC date. It honours an override only on a connection owned by
the schema owner, which no application path has, which is what makes grace
boundaries testable without weakening anything. See ADR-034.

The penalty is materialised lazily by `ensure_penalty_applied`, called from
`post_payment` **before any balance is read** and from `reverse_payment` after
it reconciles. `apply_eligible_penalties()` is there for a future scheduled
sweep and is an optimisation, never a dependency: reads never write, and
correctness never waits for cron. See ADR-035.

The delinquency rules exist twice for the same reason the allocation rules do:
`lib/domain/delinquency.ts` drives the screens and
`tests/db/delinquency-parity.test.ts` reconciles it against the database view
across randomly aged loans, the way `payment-parity` and `schedule-parity` do
for Phases 6 and 5.
