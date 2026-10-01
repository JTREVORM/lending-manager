# Architecture decision record

Each entry states a decision, the alternatives weighed, and the reasoning. The
point is that a future maintainer — or a future phase — can tell whether a
decision still holds, rather than guessing at intent.

---

## ADR-001 — Roles are a lookup table plus an assignment table

**Decision.** `public.roles` holds the vocabulary; `public.user_roles` records
who holds what, who granted it and when.

**Alternatives.**

| Option | Why not |
| --- | --- |
| A `role` column on `profiles` | One role per person, and no record of who granted it. "Who gave this person the ability to approve loans, and when" is a question a lending business has to be able to answer. |
| A PostgreSQL `enum` | Adding a role needs `ALTER TYPE`, a value can never be removed, and the role carries no label, rank or staff flag. |

**Consequences.** A new role is an `INSERT`. Multiple roles per person are
representable. Referential integrity is a foreign key. The cost is a join to
resolve a person's roles, which is what `public.current_user_role_keys()` and
`public.user_has_at_least_role()` exist for.

Ranks are spaced by 20 (10, 30, 50, 70) so a role can be inserted between two
existing ones without renumbering.

`lib/permissions/roles.ts` mirrors the seeded rows, and
`tests/db/schema.test.ts` asserts the two lists are identical — so a role added
in SQL without updating the application fails the test suite.

---

## ADR-002 — Money is whole shillings in `bigint`, never a float

**Decision.** A monetary value is a whole number of Ugandan shillings:
`bigint` in PostgreSQL, the branded `UgxAmount` type in TypeScript.

**Reasoning.** The business does not transact in fractions of a shilling, so
there is no minor unit to track. `0.1 + 0.2 !== 0.3` in binary floating point,
and interest on a reducing balance is a long chain of multiplications and
subtractions in which that error accumulates into a real discrepancy between
the schedule and the books.

Also rejected: PostgreSQL's `money` type, whose output depends on the server's
`lc_monetary` setting, and `numeric`, which is exact but invites fractional
values that have no meaning here.

**Consequences.** Every operation in `lib/domain/money.ts` is integer-only.
Where a product could exceed `2^53` the intermediate arithmetic is done in
`BigInt` and only the exact integer result is converted back. `MAX_UGX_AMOUNT`
is one quadrillion — far above any plausible loan, far below
`Number.MAX_SAFE_INTEGER`, leaving headroom for sums to stay exact.

`divideEvenly()` exists because integer division leaves a remainder: splitting
a loan into installments must produce parts that sum back to the whole, or the
schedule will not add up to the loan.

Every operation that cannot produce an exact integer takes an explicit rounding
mode. **Phase 3 must confirm with the business which mode applies to interest**
— rounding up favours the lender, down favours the borrower, and that is a
commercial decision, not a technical one. The code defaults to `half-up` and
makes the choice visible at the call site.

---

## ADR-003 — Rates are integer basis points

**Decision.** A rate is a whole number of basis points: 1 bp = 0.01%, so 15% is
`1500` and 50% is `5000`. Stored as `integer`.

**Reasoning.** `0.15` is not exactly representable in binary floating point, so
a decimal rate introduces error before any money is touched. An integer cannot.
Basis points give one hundredth of a percent of resolution — finer than any
rate the business quotes — and store cleanly in an `integer` column with a
`CHECK` range.

**Consequences.** Forms collect a percentage and convert with `percentToBps()`.
`toBps()` rejects `0.15` with a message naming the mistake, because passing a
decimal where basis points are expected would under-charge by a factor of
10,000.

---

## ADR-004 — Instants in UTC, business days in Africa/Kampala

**Decision.** Every instant is `timestamptz` (stored by PostgreSQL as an
absolute instant). Anything that is genuinely a calendar day is `date`,
interpreted in the business timezone. Never bare `timestamp`.

**Reasoning.** Africa/Kampala is UTC+03:00 with no daylight saving, which
removes the usual DST traps and introduces a subtler one: for the first three
hours of every Kampala morning, `new Date().toISOString().slice(0, 10)` returns
*yesterday*. A repayment recorded at 08:00 Kampala would be filed against the
previous day.

Every "what day is it" decision therefore goes through `businessToday()` or
`instantToBusinessDate()`, never through the host's local timezone — servers
run in UTC, staff do not.

**Consequences.** The offset is never hard-coded. `Intl.DateTimeFormat`
resolves it from the IANA database, so a future rule change is picked up by the
platform. The business timezone is configured once, in
`company_settings.timezone`, and `public.next_reference()` reads it from there.

---

## ADR-005 — Reference numbers come from the database

**Decision.** `public.next_reference(scope)` issues `CL26001`, `LN260001`,
`PAY260001` via a single atomic `INSERT … ON CONFLICT … DO UPDATE … RETURNING`
against `public.reference_sequences`.

**Alternatives.**

| Option | Why not |
| --- | --- |
| `SELECT count(*) + 1` | Two concurrent transactions read the same count and produce the same number. This is the classic duplicate-invoice bug, and it fails under exactly the load that matters: two cashiers at once. |
| A timestamp | Collides within a millisecond, is not sequential to a human, and leaks when the business is busy. |
| Client-side random/UUID | The client controls the value, so it can be forged or replayed, and the numbers are not quotable over a counter. |
| A plain PostgreSQL `SEQUENCE` | `nextval` is non-transactional, so a rolled-back transaction burns a number permanently; and it cannot restart per calendar year without a scheduled job. |

**Consequences.** The row lock on `(scope, period_year)` serialises concurrent
callers, so no two can receive the same value. A rolled-back transaction does
release its number, leaving a gap — accepted, because a gap in a reference is
harmless and a duplicate is not. `tests/db/behaviour.test.ts` fires 60
concurrent calls on separate connections and asserts 60 distinct, gapless
references.

The prefix and padding are rows in `public.reference_formats`, so they are
configurable without a code change. A sequence that exceeds its padding grows a
digit rather than truncating, because truncating would reintroduce duplicates.

---

## ADR-006 — Records are archived or reversed, never deleted

**Decision.** Nothing in this system issues a `DELETE` against a business
record. Two mechanisms replace it:

- **Identity records** (profiles, and later clients and guarantors) are
  *archived*: `status` becomes `archived`, `archived_at` is stamped, and the row
  leaves working lists while every historical reference to it stays intact.
- **Financial records** (loans, schedules, payments, penalties — all Phase 3+)
  are *immutable once posted*. A mistake is corrected by writing a compensating
  record that points at the original. A reversed payment leaves two rows.

**Reasoning.** A balance has to be reconstructable and a receipt has to be
trustworthy. Editing or removing a posted record destroys both.

**Consequences.** Every foreign key uses `ON DELETE RESTRICT`, so the database
enforces the policy rather than relying on discipline. A profile referenced by
an audit record cannot be deleted; `tests/db/behaviour.test.ts` asserts this.

Offboarding a staff member is therefore a two-step: archive the profile, then,
if the auth account must go, clear `auth_user_id` first. That is deliberate
friction.

---

## ADR-007 — `profiles.auth_user_id` is nullable

**Decision.** `profiles` has its own `uuid` primary key and a **nullable,
unique** `auth_user_id` referencing `auth.users(id)`.

**Alternatives.** The common Supabase pattern makes `profiles.id` equal to
`auth.users.id`. That forces an auth account into existence for every person
the system knows about.

**Reasoning.** Staff register a borrower at the counter, and that borrower has
no portal credentials at that moment — possibly ever. Creating auth accounts
nobody asked for, with recovery addresses nobody controls, is both wrong and a
security liability.

**Consequences.** A profile is the system's own identity record; an auth
account is an optional capability attached to it. A unique constraint treats
`NULL`s as distinct, so any number of unlinked profiles may coexist — which
`tests/db/behaviour.test.ts` verifies, because a design that permitted only one
would be useless.

No password, hash or token is stored in `public`. Supabase Auth owns
credentials, and a database test asserts no such column exists.

---

## ADR-008 — Lending rules are data, not constants

**Decision.** The minimum loan, interest rate, grace period, penalty rate, term
range and concurrent-loan limit are columns in `public.business_settings`.

**Reasoning.** The brief is explicit that the Owner/Admin must be able to
configure these. A rate embedded in a calculation cannot be changed from a
screen, and the 15% the business quotes today is a commercial decision that may
move.

**Consequences.** No calculation may hard-code these values; the Phase 3 engine
reads them. `config/defaults.ts` holds the same values *only* as seed data and
as a pre-database fallback for the shell, never as calculation input.

`business_settings` is a singleton holding *current* defaults, deliberately not
a history table. Loans snapshot their own terms at origination (Phase 3), so
changing a rate never rewrites a schedule a client already agreed to. The change
history of the settings themselves belongs in `public.audit_log`.

---

## ADR-009 — Application logs and the audit trail are different things

**Decision.** `lib/logger.ts` emits transient, redacted diagnostics.
`public.audit_log` holds durable, queryable, append-only business records.

**Reasoning.** They have different retention, different audiences and different
rules. A log may be shipped to a third-party aggregator; an audit record is
evidence. Conflating them means either logging too much (personal and financial
data in a vendor's index) or auditing too little.

**Consequences.** `lib/logger.ts` redacts by key name *and* by value shape, so
`{ note: 'sb_secret_…' }` is caught as well as `{ secret: … }`. Key matching
strips separators, so `api_key`, `apiKey` and `x-api-key` are one rule. Helpers
exist for the two cases that recur — `maskPhone`, `maskEmail` — plus
`describeAmount`, which reports an order of magnitude instead of a balance,
because exact figures belong in the audit trail and not in diagnostics.

`audit_log` resists tampering three independent ways: statement-level triggers
that reject `UPDATE`/`DELETE`/`TRUNCATE` (firing even when zero rows match, so
an attempt fails loudly), revoked privileges including from `service_role`, and
RLS with no policies. A database superuser can still disable a trigger; no
in-database design prevents that, and claiming otherwise would be dishonest.
What this does prevent is every route the application, a compromised key or a
mistaken `DELETE FROM` can take.

The actor is derived from the session inside
`public.record_audit_event()` and cannot be supplied by the caller, so an action
cannot be attributed to somebody else. `actor_label` is a snapshot of the name
at the time, so a record stays meaningful after a rename.

---

## ADR-010 — All storage buckets are private, including company assets

**Decision.** `client-documents`, `guarantor-documents` and `company-assets`
are all private. Delivery is via short-lived signed URLs created server-side.

**Reasoning.** Client and guarantor documents are self-evidently confidential —
a public bucket holding a National Identification photograph is a breach
waiting for a crawler. The logo is less obvious, but a public bucket is
enumerable by anyone who learns the project URL, and the convenience it buys is
not worth maintaining two security postures to reason about.

SVG is excluded from every bucket's MIME allow-list: an SVG is executable XML,
and serving one from the project's origin is a stored-XSS vector.

**Consequences.** Paths lead with the owner's id —
`client-documents/<profile_id>/<document_type>/<uuid>.<ext>` — which is what
makes a Phase 2 RLS policy expressible as "the first path segment must equal
the caller's profile id". Filenames are fresh UUIDs rather than the uploaded
name, so a client cannot choose a path, collide with another, or smuggle a
traversal sequence.

Guarantor documents are a separate bucket from client documents because the two
have different consent and retention positions: a guarantor agreed to back a
loan, not to become a customer.

---

## ADR-011 — Phase 1 is default-deny, with two documented exceptions

**Decision.** RLS is enabled on all nine tables. Seven have **no policies at
all**. Two — `roles` and `repayment_frequencies` — grant `SELECT` to
`authenticated`.

**Reasoning.** The brief forbids inventing permissive policies to make
development convenient, and Phase 2 is where the permission model is decided.
Writing policies now would mean guessing.

The two exceptions hold vocabulary: four role keys with their labels and
ordering, and three repayment cadences. No personal data, no financial data,
nothing about who holds which role. Phase 2's user-management UI needs to
render these lists, and withholding them would buy no security while requiring
a workaround.

**Consequences.** Table privileges are revoked from `anon` and `authenticated`
independently of RLS, so even if RLS were accidentally disabled the roles still
hold no grant. `anon` has zero privileges on every table.

A subtlety worth recording, because it was found by a test rather than by
reading: **revoking `EXECUTE` from `PUBLIC` is not sufficient on Supabase.**
PostgreSQL grants `EXECUTE` to `PUBLIC` by default, but Supabase *additionally*
grants it explicitly to `anon`, `authenticated` and `service_role` through
`ALTER DEFAULT PRIVILEGES`. An explicit grant survives a revoke from `PUBLIC`,
so each role must be named. The first version of these migrations left
`next_reference()` and `record_audit_event()` callable by anonymous visitors.

---

## ADR-012 — The authenticated area is never prerendered or cached

**Decision.** `app/(app)/layout.tsx` sets `export const dynamic = 'force-dynamic'`.

**Reasoning.** Every page there depends on the viewer's session. A statically
generated or shared-cache response would serve one person's view to another,
which in a lending system means showing a client somebody else's balance.

**Consequences.** The rendering mode is explicit rather than inferred, so
adding a page under `(app)` cannot accidentally opt into prerendering. The
Supabase proxy applies the `Cache-Control` headers that `@supabase/ssr` supplies
alongside refreshed session cookies, which stops an intermediary caching a
response carrying a `Set-Cookie`.

Relatedly, `lib/data/company.ts` calls `unstable_rethrow()` before its own error
handling: Next.js signals control flow by throwing, and swallowing one of those
would break routing or mislabel a route's rendering mode.

---

## ADR-013 — The authentication identity is derived from the phone number

**Decision.** Supabase Auth's email for every account is computed from the
canonical phone number: `+256772123456` → `256772123456@phone.lending.invalid`.
Sign-in is by phone number. `profiles.email` is contact information and is
never an authentication identity.

**Alternatives.**

| Option | Why not |
| --- | --- |
| Look the phone number up and sign in with the account's real email | Needs a read of `profiles` before anyone is authenticated. Exposing that to `anon` is an account-enumeration oracle that also hands out email addresses; doing it with the secret key puts a privileged credential on the hot login path and makes the application unable to sign anyone in without it. |
| Require every account to have a real email | Wrong for the business. Most borrowers do not have one, and inventing addresses for them is the same problem with extra steps. |

**Why `.invalid`.** RFC 2606 reserves it permanently, so these addresses can
never be resolved, can never receive mail, and can never collide with an
address somebody owns. They are identifiers, not mailboxes.

**Consequences.**

- No pre-authentication database read, so no enumeration oracle and no secret
  on the login path.
- Uniqueness is inherited from `profiles.phone`, which is already `UNIQUE`.
- **Supabase can never email a password reset**, so recovery is
  administrator-assisted: an Owner issues a temporary password and the account
  is forced to change it. That suits a business with no email infrastructure,
  and it is why `must_change_password` exists.

**If the business later wants email sign-in**, the route is to make the auth
email the real address for those accounts and accept both identifier forms.
Phone sign-in for those users would then need the lookup this decision avoids,
so it is a trade to make deliberately rather than drift into.

---

## ADR-014 — The permission matrix lives in the database as well as in TypeScript

**Decision.** `public.permissions` and `public.role_permissions` hold the same
matrix as `lib/permissions/permissions.ts`. Policies are written against
`public.user_has_permission(...)`.

**Reasoning.** Row Level Security is the real boundary, so a policy has to be
able to ask "may this user do X" — and the only way to do that inside a policy
is to have the matrix in the database.

Writing policies in terms of role names instead was rejected: it states the
same rule twice in two vocabularies (`owner_admin` in SQL, `users:create` in
TypeScript), which drift the first time somebody changes one and not the other.

**Consequences.** One vocabulary, two representations, kept in step by
`tests/db/permissions.test.ts`, which compares the rows against
`rolePermissionPairs()` and fails on any difference. Adding a grant in one
place without the other breaks the build.

Neither table is writable by any application role. A user who could insert into
`role_permissions` could grant themselves every capability in the system.

---

## ADR-015 — Disabling an account is enforced by `current_profile_id()`, not by a revocation column

**Decision.** Every Row Level Security policy routes through
`public.current_profile_id()`, which resolves only profiles whose status is
`active`. There is no `sessions_valid_from` column and no token blocklist.

**Reasoning.** A JWT stays cryptographically valid until it expires, so a
system that only checks the signature keeps a disabled user working for up to
an hour. That is unacceptable when the reason for disabling them may be that
they are no longer trusted with client money.

Routing every policy through a status-aware function means the check happens on
**every statement**, with no new machinery: the identity lookup and the status
check are the same query. A disabled user's own profile row becomes invisible
to them, so they cannot even restore themselves.

**Why not a `sessions_valid_from` column.** It would duplicate a guarantee that
already holds completely, and the brief is right that an unused security column
is worse than none — it invites the belief that something is protected by a
mechanism nobody exercises.

**Consequences.** `auth.uid()` must never appear directly in a policy; using it
would bypass the status check. `tests/integration/migrations.test.ts` asserts
every policy on sensitive data is gated on `user_has_permission` or
`current_profile_id`, and `tests/db/rls-identity.test.ts` drives the
suspended-user case with the same token before and after.

---

## ADR-016 — Identity changes are audited by database triggers

**Decision.** `profiles`, `user_roles` and the settings singletons write their
own audit records from `AFTER` triggers. Application code does not call an
audit function after doing its work.

**Reasoning.** The obvious design has two failures that matter in a financial
system: an action can change data and then fail before auditing it, and an
action can simply forget. Either way the trail disagrees with the data, and a
trail that might be incomplete cannot answer "who did this".

A trigger records what actually happened to the row, in the same transaction.
If the change rolls back so does its record; if it commits, the record
committed with it. It also means an administrator who bypasses the interface
entirely — direct REST calls, `psql` — is audited identically.

**Consequences.** Session events (sign-in, sign-out, password change) are not
row changes and need their own path: `public.record_security_event()`, whose
action vocabulary is closed and whose actor is derived from the session. An
authenticated user can therefore record only true statements about themselves.

`record_audit_event()` remains revoked from every session role, so no caller
can write an arbitrary audit row.
