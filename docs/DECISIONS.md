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

## ADR-017 — Clearing a forced password change is a server-only operation

**Status:** Accepted — supersedes the Phase 2 design in migration
`20261002000200`.

### Context

Phase 2 shipped `public.complete_password_change()`: a `SECURITY DEFINER`
function taking no arguments, granted to `authenticated`, clearing
`must_change_password` for whoever called it. The reasoning at the time was
that the signature made it safe — it could only ever act on the caller's own
row, so nobody could clear anyone else's flag.

That reasoning was about the wrong threat. The flag does not protect the
account from other users; it protects it from the administrator who issued the
temporary password. While it is set, two people know the password. A user who
wanted to keep it that way — out of convenience, not malice — could call the
function directly over PostgREST, clear the requirement, and carry on using a
password their administrator also knew, indefinitely. The application's own
change-password screen was never involved, so no amount of care in the
application could prevent it.

The hard constraint is that the database cannot verify the premise. Whether a
password actually changed is a fact inside Supabase Auth, in a schema the
application must not reach into. So the condition the function needs to check
is one it cannot check.

### Options considered

1. **Keep the grant, compare `auth.users.updated_at` against
   `password_set_at`.** Rejected. It depends on a GoTrue implementation detail
   that could change in a minor release, and the failure mode is the wrong way
   round: a false negative locks a user permanently on the change-password
   screen with no way out. That is worse than the gap it closes.
2. **Keep the grant, require the current password as an argument.** Rejected
   outright — it would mean a plaintext password crossing into the database, in
   a statement parameter that appears in `pg_stat_activity` and in any query
   log. Exactly what "no passwords in the database" exists to prevent.
3. **Revoke the grant; clear the flag from the server after Supabase confirms
   the change.** Accepted.

### Decision

The function is **dropped**, not merely un-granted — a function nobody may call
is still a function somebody may re-grant by accident, and the name was by then
a liability. Its replacement, `confirm_password_change(p_auth_user_id uuid)`,
is callable only by `service_role`:

```sql
revoke all on function public.confirm_password_change(uuid)
  from public, anon, authenticated;
```

Naming each role matters: Supabase's `ALTER DEFAULT PRIVILEGES` grants to
`anon` and `authenticated` survive a `REVOKE … FROM PUBLIC`, so revoking from
`PUBLIC` alone would have left the function anon-callable. A database test
asserts the grant for each role by name.

Two further rules were **hoisted above the trusted-path exemption** in
`profiles_guard_privileged_columns`, so they bind every caller including
`service_role` and the table owner:

- `must_change_password` cannot go from true to false by an `UPDATE` at all. It
  clears only inside `confirm_password_change`, which announces itself with a
  transaction-local `set_config` marker.
- `password_set_at` is written by the database from its own clock, and a value
  supplied by any caller is overwritten or rejected.

The second is why the privileged client is not simply trusted to do the right
thing. The server holds the secret key; a bug in server code, or that key
leaking, should not be enough to clear the requirement without a password
having changed. The guard means the only way through is the one function, and
the only thing that function does is clear the flag — it cannot be talked into
doing more.

### Consequences

- The ordering constraint moves into application code, where it is testable
  but not structurally enforced. That is mitigated by extracting it into
  `lib/auth/password-change.ts` behind an injected interface, so every
  path — wrong current password, Supabase refusing, confirmation failing — is
  driven directly in tests and "the flag was not cleared" is asserted against
  a recorded call list.
- The change-password screen now requires `SUPABASE_SECRET_KEY` to be
  configured. If it is missing, a user's password changes and the flag does
  not clear; they are told exactly that, rather than being told the change
  failed, which would send them back to a password that no longer works.
- One more operation needs the privileged client. The justification string
  (`'confirm a completed password change'`) is logged, per ADR-005, so every
  privileged use remains accountable.

## ADR-018 — The National Identification Number lives in its own table

**Status:** Accepted (Phase 3).

### Context

The Phase 3 brief lists `nin` among the client fields and separately requires
that only authorized roles can access it, and that it is masked where full
display is unnecessary.

Those two requirements are in tension on PostgreSQL. Row Level Security
decides which *rows* a caller may touch; it has nothing to say about columns.
Column privileges exist, but they are granted to database roles, and every
signed-in user of this application is the same database role, `authenticated` —
the distinction between a Secretary/Treasurer and a Manager is made inside
policies, not by the role the connection assumes.

So a `nin` column on `clients` could only have been protected by not selecting
it in the interface. That is not protection. A caller holding a valid token can
query PostgREST directly, and the Phase 2 rule — hiding controls is not
security — applies with more force here, because a NIN is reusable identity
evidence: someone holding one can impersonate its owner to a third party, which
is not true of a phone number or an occupation.

### Decision

The number and the identity document move to **`client_identities`**, keyed on
`client_id`, with its own policy requiring `clients:view_nin`.
`guarantor_identities` does the same for guarantors.

A Secretary/Treasurer passes `clients:view` and reads the directory all day;
they fail the identity policy, so there is no query, view or export through
which they reach a NIN. The restriction is a row policy, which is the one
mechanism that holds.

The identity document path lives in the same table, because it is a scan of
the same document — protecting one and not the other would be pointless. The
storage policy for the `id/` folder is gated on the same capability.

### Consequences

* The flat field list in the brief is not reproduced literally. The brief
  invited this: "use the cleanest schema rather than mechanically copying this
  list".
* Registration writes two rows, and the second can fail independently. That is
  handled rather than hidden: a client with no NIN recorded yet is a normal
  state, so the failure is reported and the client — who already holds an
  issued number — is kept.
* Reading a client's full record takes two queries. The second is skipped
  entirely for callers without the capability, so the common case is cheaper
  rather than more expensive.
* It makes the audit rule tractable too. `audit_log` is readable by
  `audit:view`, which is broader than `clients:view_nin`, so the triggers
  record a masked number (`***BCD`) rather than the number. Had the NIN been a
  column on `clients`, every `client.updated` row would have carried it.
* A borrower cannot read their own NIN. Deliberate: they already know it, and a
  portal that never displays one cannot leak one.

## ADR-019 — Phone numbers are not unique; NINs are

**Status:** Accepted (Phase 3).

### Context

The brief asks for duplicate detection, and notes that NIN uniqueness may be
enforced if the company requires it while "phone numbers may need careful
treatment if families share numbers".

### Decision

**NIN: a hard unique constraint**, partial so the number stays optional. A NIN
identifies exactly one person, so two client records sharing one is a duplicate
or a transcription error — never a legitimate pair. There is no case where
allowing it serves the business.

**Phone: no constraint.** Families share a handset. A wife borrowing on her own
account using her husband's number is an ordinary Ugandan case, not a
duplicate. A unique constraint here would turn a real client away at the
counter, and the staff member would work around it by inventing a number —
which is worse than the duplicate, because it destroys the ability to contact
her.

Instead the collision is made *visible*: the search box matches phone numbers,
so typing one shows everyone who has it, and whoever is registering can decide.

### Consequences

* Registration can produce two clients with one phone number. That is the
  intended outcome, and the search makes it apparent.
* The NIN constraint is what makes "this individual already stands for two
  other borrowers" visible for guarantors, rather than silently duplicated
  across three records.
* A duplicate NIN surfaces as a specific message — "already recorded against
  another client" — rather than a generic failure, because the recovery is
  different: find the existing record rather than retype the number.

## ADR-020 — Guarantor associations are a table, and Phase 4 must snapshot them

**Status:** Accepted (Phase 3). Carries an obligation for Phase 4.

### Context

A guarantor could have been a set of columns on `clients`, which would have
made registration a single form. The brief asks for the decision to be
documented either way.

### Decision

A separate `guarantors` table with the association in `client_guarantors`,
because in practice the same person guarantees several borrowers — a trader
vouches for two relatives and a neighbour.

Three copies of that person would mean three photographs to keep current,
three NINs to keep unique, and **no way to see that one individual carries
three obligations** — which is precisely the exposure a lender wants visible.
The guarantor directory therefore shows how many clients each person currently
stands for.

`relationship_to_client` lives on the association rather than the guarantor,
because the same person is a brother to one client and a business partner to
another.

Detaching deactivates and stamps attribution; reviving a detached association
is refused outright, so a new one must be made. History stays legible.

### The obligation on Phase 4

A guarantor's details change: they move, they change trade, they change number.
`client_guarantors` records the **current** association, and nothing in Phase 3
is suitable as loan evidence on its own.

When Phase 4 issues a loan it must **snapshot** the details it relied on — the
guarantor's name, NIN, phone and relationship, and the client's own identity
data — into the loan's rows, rather than referencing `guarantors.id` and
reading through at display time. Otherwise a guarantor correcting their phone
number in 2027 silently rewrites what the business will claim it was told in
2026, and the loan file stops being evidence in a dispute.

Phase 3 deliberately provides no snapshot mechanism. There is nothing yet to
snapshot into, and an unused one would rot before it was needed.

## ADR-021 — Documents are never deleted, and replaced files accumulate

**Status:** Accepted (Phase 3).

### Context

Replacing a client's photograph could delete the old object. The brief asks
that a replacement avoid orphaned files "where practical", that the old file
not be deleted before the new upload succeeds, and that sensitive documents not
be freely deletable.

### Decision

No DELETE policy on either document bucket, for any role. A replacement
uploads to a **new random path** and repoints the database only after the
upload succeeds; the previous object stays.

### Consequences

* There is no moment at which the database names a file that does not exist,
  and no moment at which the old file is gone before the new one arrives. The
  two failure modes the brief warns about are both structurally impossible
  rather than merely handled.
* Replaced files accumulate. This is the honest cost, and it is the right way
  round: a bug that deleted the only scan of a client's national ID would be
  unrecoverable, while an extra object costs a fraction of a cent. An operator
  prunes deliberately with the secret key.
* "Remove this photograph" is not offered in the interface. Nothing in the
  business needs it, and the capability would exist only to be misused.

## ADR-022 — The database computes the money; TypeScript computes the preview

**Status:** Accepted (Phase 4).

### Context

The loan arithmetic has to exist in two places for two different reasons that
pull in opposite directions.

A pure, testable domain module is what makes the engine verifiable at all: the
three confirmed business examples can be driven directly, invariants can be
asserted, and a property-based sweep can run four hundred cases in
milliseconds. That argues for TypeScript.

But approval must not accept figures from its caller. `approve_loan` is
callable by anyone holding `loans:approve`, which is the Manager — and an
approver who could supply the breakdown could approve a loan at zero interest.
That argues for SQL.

### Decision

Both, with an explicit hierarchy.

**`public.calculate_loan_breakdown` is authoritative.** It computes what is
stored, from the principal, rate and term alone. The approval function calls
it; nothing can hand it numbers.

**`lib/domain/loan.ts` computes the preview.** It drives the figures staff see
while entering a loan, and it is what the test suite exercises.

The risk — two implementations drifting — is managed by testing them as one
thing. `tests/db/loan-engine-parity.test.ts` runs three hundred generated loans
through both and compares them period by period, field by field. The three
confirmed examples are compared the same way.

### Consequences

* The failure mode this guards against is the worst one available: a borrower
  quoted one figure at the counter and charged another. If the engines diverge,
  a test fails instead.
* The preview is computed in the browser, which is a deliberate exception to
  "never trust browser arithmetic" and is safe only because **nothing computed
  there is ever submitted**. The form posts an amount, a term and a frequency.
* The preview is labelled provisional throughout, because the settings in force
  at approval may differ from today's — see ADR-023.
* A future second interest method must be added to both, and the parity test
  will refuse to pass until it is.

## ADR-023 — Terms are snapshotted at approval, from the settings in force then

**Status:** Accepted (Phase 4).

### Context

A draft is entered on Monday at 15%. On Tuesday the Owner changes the default
rate to 12%. On Wednesday the loan is approved. At which rate?

The specification requires this be decided explicitly rather than left to
accident, and either answer is defensible.

### Options

1. **Lock the rate at draft time.** The borrower is charged what they were
   quoted. But the business then lends at a rate it has already decided to stop
   offering, with no record of having decided to — and every unapproved draft
   becomes a standing commitment to an old price.
2. **Use the settings in force at approval.** Accepted.

### Decision

Commercial terms are snapshotted **at approval**, from the settings read at
approval, after revalidating the loan against them. The draft carries the shape
of the proposed loan — client, amount, term, rhythm — and no price.

The reasoning is that the rate quoted at the counter is not binding; the
approval is. A loan is an agreement made when somebody with authority agrees to
it.

### Consequences

* A reviewer may approve figures that differ from the ones the Secretary saw.
  That is the real cost, and it is mitigated rather than hidden: the approval
  screen re-reads the authoritative figures before asking for confirmation, and
  every preview is labelled as a preview.
* Every eligibility rule is likewise re-evaluated at approval — the minimum, the
  term range, the client's status, the guarantors. A client blacklisted between
  drafting and approval stops the approval.
* Draft-time rate locking remains available as an explicit future feature. What
  it must not be is an accident.
* The policy that *was* in force is recorded on the loan — the rate, the
  method, the grace period, the penalty rate, the minimum applied — so a
  borrower in arrears next year is judged against the terms their loan was
  issued under.

## ADR-024 — The active-loan limit is a trigger with an advisory lock, not a unique index

**Status:** Accepted (Phase 4).

### Context

Only one active loan per client. The obvious enforcement is a partial unique
index:

```sql
create unique index on loans (client_id) where status = 'active';
```

It is concurrency-safe, cheap, and declarative. But
`business_settings.max_active_loans_per_client` already exists and is
configurable.

### The problem with the index

It enforces **exactly one**, and nothing else. The moment anybody raised the
setting to two, the column would say two and the database would allow one — and
whoever made the change would get a unique-constraint violation they could not
explain from reading the settings screen.

The specification is explicit that a configuration setting the database cannot
honour must not be created. An index would turn an honest setting into a lie.

### Decision

A `BEFORE UPDATE` trigger, `loans_enforce_active_limit`, firing whenever a loan
becomes `active`:

1. take `pg_advisory_xact_lock` keyed on `client_id`;
2. count that client's active loans;
3. refuse if the count has reached the configured limit.

The advisory lock is what makes it correct. Without it, two transactions could
each count zero and each proceed — the check-then-insert race the specification
names. The lock is transaction-scoped, so it is held until commit and released
automatically including on rollback, and it is keyed on the client so loans for
different borrowers never contend.

### Consequences

* The setting is honoured at whatever value it holds, and a test proves it
  honours two as well as one.
* It fires on **any** path to `status = 'active'`, including a direct `UPDATE`,
  so bypassing `disburse_loan` gains nothing.
* The limit is also checked at approval, so a reviewer is told why rather than
  approving a loan that could never be disbursed.
* A trigger is more expensive than an index and harder to read than a
  constraint. That is the price of the setting being true.
* Serialisation is per client, so throughput is unaffected in practice: two
  counters disbursing to two different borrowers do not block each other.

## ADR-025 — Every lifecycle transition must name a human

**Status:** Accepted (Phase 4). Discovered while writing the tests.

### Context

Each transition stamps its actor from `public.current_profile_id()`, and the
constraints require that actor to be present: `loans_approved_requires_attribution`
will not accept an approved loan with no approver.

Writing the test fixtures exposed the consequence. As the table owner — in a
migration, through the privileged client, or in a test harness — there is no
session, `current_profile_id()` is NULL, and **every lifecycle transition is
refused.**

The first instinct was that this was an obstacle, and that the constraint
should allow a null actor for trusted-path callers.

### Decision

Keep the constraint strict. There is no such thing as a system-performed
approval.

Approving a loan and releasing money are human acts. A financial record that
cannot name who performed them is not worth keeping — it looks like a record
and answers nothing in the dispute it exists for. So the schema refuses to
create one, and the test fixtures impersonate a real user because the schema
leaves them no choice, which also makes them a more honest reflection of how
the application actually drives the lifecycle.

### Consequences

* A supplied actor is **refused** rather than silently overwritten, so a caller
  that believes it is choosing the actor finds out.
* No migration or scheduled process can approve or disburse a loan. If a later
  phase needs an automated transition — `cleared`, when payments show a loan
  settled — it will need either a service account with a real profile or a
  deliberate exemption argued on its own merits. Phase 4 takes no position
  beyond declining to pre-authorise it.
* The privileged client cannot approve a loan either, which is a feature: a
  leaked secret key cannot manufacture an approval attributed to nobody.

## ADR-026 — The collection schedule is append-only, and carries no payment state

**Status:** accepted (Phase 5)

### Context

Phase 5 turns each contractual month into actual collection dates. The obvious
shape for an installment row is the one every tutorial shows: a due date, an
expected amount, an `amount_paid`, a `remaining_balance` and a `status` moving
through `upcoming → due → paid → missed`.

Two later phases make that shape wrong.

**Phase 6 posts payments.** If `amount_paid` existed now it would hold zero for
every installment in the system — a fact about this phase, written in a column
a reader would take as a fact about a borrower.

**Phase 7 carries arrears forward.** The business rule is that a missed Monday
of UGX 4,000 means Tuesday operationally requires UGX 8,000. The tempting
implementation is to update Monday's row, or Tuesday's, or both. Either
destroys the only record of what was actually agreed to be collected on
Monday — in precisely the dispute the record exists for.

### Decision

**The schedule is append-only, and holds no payment-derived state at all.**

* `loan_installments` and `loan_schedules` refuse UPDATE and DELETE through
  statement-level triggers, binding the table owner and `service_role` as well
  as every session role. No application path exists to amending a schedule.
* There is no `amount_paid`, `remaining_balance`, `arrears` or `status` column.
* The only state shown is **derived from the calendar**: `upcoming`,
  `due_today`, `elapsed`. Nothing more can be said truthfully before payments
  exist.

`elapsed` is deliberately not called `missed` or `overdue`. Both of those
assert that no payment arrived, which is a claim about data this phase does not
have; a borrower who paid on time would be shown as delinquent by a label the
system has no standing to apply. The screen says "Date passed".

### Why the status is derived rather than stored

A stored `status` column in Phase 5 could only ever hold one value —
`scheduled` — which carries no information that "the row exists" does not
already carry. Worse, it would be a mutable column on an immutable table, and
it would invite Phase 6 to UPDATE it, breaching the append-only guarantee that
makes the schedule evidence.

This follows ADR-025's reasoning about statuses nothing can set.

### Consequences

* Phase 6 records payment against installments in **its own** structures. An
  installment row never changes.
* Phase 7 computes arrears as a separate fact about what happened to the plan,
  rather than by rewriting the plan.
* The original schedule remains answerable to the question "what did this
  borrower agree to pay, and when" for the life of the loan.
* A schedule genuinely entered in error cannot be corrected in place. That is
  intended: rescheduling and restructuring are an explicit, audited workflow
  for a later phase, not an "edit schedule" button.

## ADR-027 — A repayment frequency's interval is its identity, not a setting

**Status:** accepted (Phase 5)

### Context

Phase 4 freezes `loans.repayment_frequency` — the borrower's agreed cadence
cannot change after the loan leaves draft. But that column stores a *key*,
`'daily'`, and the days that key means live in
`repayment_frequencies.interval_days`, which was freely editable.

So the agreement was only half frozen. An administrator editing `daily` from 1
to 2 would not be adjusting a setting; they would be silently redefining every
loan that ever named it, and nothing in any loan record would show that
anything had changed.

Two ways to deal with this: snapshot the interval when a schedule is generated
and let the table keep changing underneath, or refuse the change.

### Decision

**Both, because they protect different things.**

1. **`key` and `interval_days` are immutable** (migration `20261005000200`).
   "Daily" means one day. A row claiming to be daily while meaning two is not
   an edited setting, it is a false record. A cadence the business no longer
   offers is retired with `is_active = false` — which Phase 1 already provided
   and documented for exactly this purpose — and a new row is added if a new
   rhythm is wanted. Deletion is refused outright, referenced or not, so the
   vocabulary a historical loan's key is read against is append-only.

2. **The cadence is snapshotted onto `loan_schedules`** at generation: key,
   label and interval. This is what makes an already-generated schedule
   provably independent of the table, and keeps it readable and explicable
   after a cadence is retired or relabelled.

`label`, `is_active` and `sort_order` remain editable. Renaming "Every 2 days"
to "Every second day" changes a presentation string; deactivating hides a
cadence from new loans while existing ones keep working. Neither alters what
any existing agreement means, which is the line being drawn.

### Consequences

* The obvious attack — change the interval between approval and disbursement,
  so the generated schedule contradicts the agreement — is refused at the
  database rather than merely ignored.
* Making the table effectively append-only is a real constraint on
  administrators, which is why the retire-and-add path is tested alongside the
  refusals: a guard that left no way to stop offering a cadence would have
  been a worse answer than the problem.
