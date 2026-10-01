# Database

PostgreSQL via Supabase. Every change is a versioned migration in
`supabase/migrations/`, applied in filename order.

## Tables

Nine tables, all in the `public` schema.

| Table | Purpose |
| --- | --- |
| `profiles` | Application-level person record. Optionally linked to a Supabase Auth account. |
| `roles` | Role vocabulary: `client`, `secretary_treasurer`, `manager`, `owner_admin`. |
| `user_roles` | Which roles each profile holds, who granted them and when. |
| `company_settings` | Singleton. Company identity and branding. |
| `business_settings` | Singleton. Configurable lending rules. |
| `repayment_frequencies` | Supported repayment cadences. |
| `reference_formats` | Prefix and padding for each reference scope. |
| `reference_sequences` | Counter state for reference numbers, per scope per year. |
| `audit_log` | Append-only audit trail. |

### Relationships

```
auth.users ──(0..1)── profiles ──┬── user_roles ──── roles
                                 │
                                 ├── audit_log.actor_profile_id
                                 ├── company_settings.updated_by
                                 └── business_settings.updated_by

reference_formats ──── reference_sequences

repayment_frequencies ──── business_settings.default_repayment_frequency
```

**Every foreign key is `ON DELETE RESTRICT`.** This is a financial system: a
person's record is referenced by audit history and, from Phase 3, by loans and
payments. Deleting it would corrupt the books, so the database refuses. See
ADR-006.

### `profiles` ↔ `auth.users`

`auth_user_id` is **nullable** and unique. Staff register a borrower long
before — possibly instead of — that borrower having portal credentials. A
unique constraint treats `NULL`s as distinct, so any number of unlinked
profiles may coexist. See ADR-007.

No password, hash or token is stored in `public`. Supabase Auth owns
credentials, and a database test asserts no such column exists.

## Column conventions

| Kind | Type | Why |
| --- | --- | --- |
| Money | `bigint`, whole shillings | No float error. Never `money`, `numeric`, `real` or `double precision`. ADR-002. |
| Rates | `integer`, basis points | 15% is `1500`. Exact. ADR-003. |
| Instants | `timestamptz` | Absolute instant. Never bare `timestamp`. ADR-004. |
| Calendar days | `date` | Interpreted in `company_settings.timezone`. |
| Identifiers | `uuid` (`gen_random_uuid()`) | Except `audit_log.id`, a `bigint` identity: ordered and cheap. |
| Storage paths | `text` with a traversal `CHECK` | Never a URL — the buckets are private. |

Tests assert these, both by reading the migration SQL
(`tests/integration/migrations.test.ts`) and by querying the live catalogue
(`tests/db/schema.test.ts`).

## Constraints

The database enforces structure; application validation complements it rather
than replacing it. Notable examples:

- `profiles_phone_e164` — `^\+256[0-9]{9}$`, mirroring `lib/domain/phone.ts`.
- `profiles_email_lowercase` — makes the unique index case-insensitive in effect.
- `profiles_status_valid` — the four statuses from `lib/domain/status.ts`.
- `profiles_archived_at_consistent` — an archived row must say when, and a live
  row must not claim to have been.
- `company_settings_singleton` / `business_settings_singleton` — `CHECK (id = 1)`.
- `business_settings_loan_amount_order` — maximum ≥ minimum.
- `business_settings_term_order` — maximum term ≥ minimum term.
- `business_settings_interest_rate_range` — 0 to 1,000,000 bp, catching a
  decimal-versus-basis-point data-entry slip.
- `company_settings_logo_path_safe` — no absolute paths, no `..`.
- `audit_log_action_format` — a disciplined `lower.dotted` vocabulary.
- `audit_log_*_is_object` — jsonb columns hold objects, not scalars or arrays.

`tests/db/behaviour.test.ts` attempts each violation and asserts it is refused.
A constraint that is never exercised is a comment.

## Row Level Security

**Phase 1 is default-deny.** RLS is enabled on all nine tables; seven have no
policies at all, which denies every row to `anon` and `authenticated`. Table
privileges are revoked independently, so the two controls do not share a
failure mode.

| Table | RLS | Policies | `anon` | `authenticated` |
| --- | --- | --- | --- | --- |
| `roles` | on | `SELECT` to authenticated | — | `SELECT` |
| `repayment_frequencies` | on | `SELECT` to authenticated, active rows only | — | `SELECT` |
| `profiles` | on | none (deny) | — | — |
| `user_roles` | on | none (deny) | — | — |
| `company_settings` | on | none (deny) | — | — |
| `business_settings` | on | none (deny) | — | — |
| `reference_formats` | on | none (deny) | — | — |
| `reference_sequences` | on | none (deny) | — | — |
| `audit_log` | on | none (deny) | — | — |

The two readable tables hold vocabulary — four role keys, three cadences — with
no personal or financial data. See ADR-011.

### Deferred to Phase 2

Intentionally absent, and named in each migration at the point they belong:

- `profiles` — read/update own; staff read clients; owner_admin manages all.
- `user_roles` — read for self and staff; grant/revoke for owner_admin.
- `company_settings` / `business_settings` — read for staff; update for
  owner_admin. Note this includes deciding how the company name reaches an
  anonymous visitor on the sign-in page: most likely a narrow server-side read
  exposing name and logo alone, rather than opening a row that also holds the
  tax and registration numbers.
- `audit_log` — read for owner_admin.
- `storage.objects` — per-bucket policies keyed on the leading path segment.
- `EXECUTE` on `next_reference()` and `record_audit_event()` for the staff roles
  that will create clients, loans and payments.

## Functions

| Function | Security | Purpose |
| --- | --- | --- |
| `set_updated_at()` | invoker | Trigger: stamps `updated_at`. |
| `reject_mutation()` | invoker | Trigger: makes a table append-only. |
| `current_profile_id()` | **definer** | Profile of the authenticated user, or NULL. |
| `current_user_role_keys()` | **definer** | Role keys held, or an empty array. |
| `user_has_role(text)` | **definer** | Holds exactly this role? |
| `user_has_at_least_role(text)` | **definer** | Holds this role or higher? |
| `next_reference(text)` | **definer** | Issues the next reference atomically. |
| `record_audit_event(…)` | **definer** | Sole write path into `audit_log`. |

Every function sets `search_path = ''` and schema-qualifies everything it
touches. Without that, a caller can prepend their own schema and make the
function resolve `profiles` to a table they control — a privilege-escalation
route in any `SECURITY DEFINER` function.

The four session helpers are `SECURITY DEFINER` for a specific reason: a Phase 2
RLS policy on `user_roles` that itself queried `user_roles` would recurse
infinitely. Reading the table outside RLS breaks the cycle. Each is scoped to
the *calling* user via `auth.uid()`, so none can read another person's roles.

`current_profile_id()` resolves only **active** profiles, so a suspended or
archived account has no identity for authorization purposes even while its auth
session remains valid.

### EXECUTE grants

| Function | `anon` | `authenticated` | `service_role` |
| --- | --- | --- | --- |
| `current_profile_id` | — | yes | yes |
| `current_user_role_keys` | — | yes | yes |
| `user_has_role` | — | yes | yes |
| `user_has_at_least_role` | — | yes | yes |
| `next_reference` | — | — | yes |
| `record_audit_event` | — | — | yes |

Revoking from `PUBLIC` alone is **not** sufficient on Supabase — see ADR-011.

## Reference numbers

`CL26001` (client), `LN260001` (loan), `PAY260001` (payment): prefix, two-digit
year in the business timezone, zero-padded sequence.

Issued only by `public.next_reference(scope)`, a single atomic
`INSERT … ON CONFLICT … DO UPDATE … RETURNING`. The row lock on
`(scope, period_year)` serialises concurrent callers. 60 concurrent calls on
separate connections produce 60 distinct, gapless references — asserted by
`tests/db/behaviour.test.ts`. See ADR-005.

Prefix and padding live in `reference_formats`, so they are configurable
without a code change.

## Audit trail

`audit_log` is append-only. `UPDATE`, `DELETE` and `TRUNCATE` are blocked by
statement-level triggers *and* by revoked privileges, including from
`service_role`. The triggers fire even when a statement would match zero rows,
so an attempt fails loudly rather than appearing to succeed.

The actor is derived from the session inside `record_audit_event()` and cannot
be supplied by the caller. `actor_label` snapshots the name at the time, so the
record stays meaningful after a rename. See ADR-009.

Phase 1 emits no events — the actions worth auditing do not exist yet.

## Storage

| Bucket | Public | Size limit | Types |
| --- | --- | --- | --- |
| `client-documents` | no | 10 MiB | JPEG, PNG, WebP, HEIC, PDF |
| `guarantor-documents` | no | 10 MiB | JPEG, PNG, WebP, HEIC, PDF |
| `company-assets` | no | 2 MiB | JPEG, PNG, WebP |

SVG is excluded everywhere: it is executable XML and therefore a stored-XSS
vector. Path convention and the reasoning behind private-by-default are in
ADR-010. No storage policies exist yet, so `storage.objects` denies everything.

## Migrations

```
20261001000100_shared_functions.sql              set_updated_at, reject_mutation
20261001000200_profiles.sql                      profiles
20261001000300_roles_and_assignments.sql         roles, user_roles, session helpers
20261001000400_company_and_business_settings.sql repayment_frequencies, company_settings, business_settings
20261001000500_reference_sequences.sql           reference_formats, reference_sequences, next_reference
20261001000600_audit_log.sql                     audit_log, immutability, record_audit_event
20261001000700_storage_buckets.sql               three private buckets
20261001000800_seed_reference_data.sql           baseline data
```

Rules:

1. Never edit an applied migration. Write a new one.
2. Timestamp-prefix every file; the prefix is what guarantees ordering.
3. Keep them deterministic — no `now()`-dependent branching, no environment
   lookups.
4. Regenerate `types/database.types.ts` in the same change.
5. Verify against a clean database before opening a pull request.

Baseline data is in migration `…0800`, not `supabase/seed.sql`, because it is
required in production: without the `roles` rows nobody can be granted a role,
and without the singleton settings rows there is nothing to read or edit.
`supabase/seed.sql` is for local development data and is deliberately empty.

## Verifying migrations locally

With Docker:

```bash
supabase start
supabase db reset        # applies every migration to a clean database, then seed.sql
```

Without Docker (the project ships a fallback that needs only a local PostgreSQL
installation):

```bash
npm run db:local:setup                        # initdb, start, create, migrate
export DATABASE_URL="$(./scripts/pg-local.sh url)"
npm run test:db
npm run db:local:teardown
```

`scripts/pg-local.sh` creates a throwaway cluster under `.pglocal/`
(git-ignored) and applies `tests/helpers/supabase-shim.sql` first. The shim
recreates just enough of a Supabase project — the `auth` and `storage` schemas,
the three roles, and Supabase's `ALTER DEFAULT PRIVILEGES` grants — for the
migrations to apply unmodified. It is a test harness and is never applied to a
Supabase project.

The shim reproduces Supabase's default grants deliberately: without them the
migrations' `REVOKE` statements would be no-ops and the tests asserting "`anon`
holds no privilege" would pass vacuously.

## Offboarding a person

Because deletion is refused by design:

1. Set `status = 'archived'` and stamp `archived_at`.
2. Revoke their rows in `user_roles`.
3. Only if the auth account must be removed: clear `profiles.auth_user_id`
   first, then delete the `auth.users` row. The profile and all its history
   remain.

## Regenerating types

```bash
npm run db:types                                      # local Supabase stack
npx supabase gen types typescript --project-id <ref> --schema public \
  > types/database.types.ts                           # hosted project
```

Run this after any migration that changes the schema, and commit the result in
the same change. `tests/integration/migrations.test.ts` fails if a table or
function is missing from the types file.
