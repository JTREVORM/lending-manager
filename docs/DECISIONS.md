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

## ADR-028 — A reversal is a status, not a deletion and not a contra entry

**Status:** accepted (Phase 6)

### Context

Money gets recorded against the wrong loan, or twice, or for the wrong amount.
The business needs a way to withdraw a payment that was never really made.

There are three shapes for that:

1. **Delete the payment.** Tempting because the balance comes out right with no
   extra concepts. It also destroys the only evidence that a receipt was ever
   issued — in exactly the dispute the record exists for — and it makes the
   register impossible to reconcile against a cash drawer.
2. **Post a negative contra payment.** Standard double-entry practice, and it
   keeps the original row untouched. But every balance query then has to sum
   signed amounts, "the amount of this payment" stops being a single number a
   receipt can print, and the invariant that an allocation's components sum to
   the payment amount becomes ambiguous for every reader of the table.
3. **Mark the payment reversed.**

### Decision

**A payment carries a `status` of `posted` or `reversed`, and a reversal moves
it from the first to the second.** Nothing is deleted and nothing is negated.

* The row survives with its amount, its method, its reference, its receipt
  figures and its staff attribution unchanged. `loan_payments` refuses DELETE
  through a statement-level trigger, as does `payment_allocations`.
* **Every allocation is preserved.** They are the record of where the money
  went, not a cache of where it is now.
* The balance views count only `status = 'posted'`, so a reversal changes every
  derived figure the instant it commits.
* The reversal is stamped with who did it, when, and why — a reason of at least
  ten characters, because this is the only record of why a borrower's payment
  was withdrawn.
* A payment can be reversed once. The guard trigger refuses the second attempt
  before it looks at anything else, so a double reversal cannot credit the
  loan twice.
* A reversal cannot itself be reversed. If the borrower did pay, that is a new
  payment, with its own receipt and its own attribution.

Reversing is `payments:reverse`, which only the Owner holds.

### Why the allocations are not re-allocated

A reversal leaves honest gaps. Reverse the first of two payments and the
second payment's allocations still sit on the later collections it covered,
while the earlier ones are uncovered again. The coverage view shows exactly
that, because it is what happened: the second payment was applied when the
first still stood.

Re-allocating would mean rewriting history to make it tidier, and it would
break the one thing a borrower's receipt is for — proving which collections
*that* payment covered.

### Consequences

* "What does this loan owe" and "what has this loan ever been paid" are
  different questions with different answers, and both are answerable.
* The register lists reversed payments, struck through and labelled. A
  reviewer can see every withdrawal; a register that hid them would conceal
  the one event most worth seeing.
* A reversed receipt stays reachable and is marked `REVERSED`. A borrower
  holding the printed slip can still find the record it refers to.
* Reversing the payment that settled a loan reopens the loan, validated
  against the derived ledger rather than against a session's claim — see
  ADR-032.

## ADR-029 — A receipt's balances are a historical snapshot, never the live balance

**Status:** accepted (Phase 6)

### Context

`loan_payments` stores `outstanding_before` and `outstanding_after`, which
looks like exactly the kind of stale mutable balance column the specification
forbids and ADR-026 argued against for the schedule.

It is not one, and the distinction matters enough to write down because the
first draft of `reverse_payment` got it wrong.

### Decision

**Those two columns are a record of what the receipt said at the counter, and
nothing reads them to answer "what is owed."**

* The live balance is derived, every time, by `loan_balances` and
  `public.loan_outstanding()` from the contract and the allocations of posted
  payments. There is no cached figure that could disagree with the ledger.
* The receipt figures are frozen at posting, by the posting function, from
  figures it derived itself inside the same locked transaction. A `CHECK`
  constraint enforces `outstanding_after = outstanding_before - amount`, so a
  receipt cannot be internally inconsistent.
* They are immutable. The guard trigger refuses any change to either, on a
  reversal as much as otherwise.

Re-deriving them for display from the loan's *current* balance would silently
rewrite history: every later payment would change what an earlier receipt
said, and a borrower holding a printed slip would find the system disagreeing
with it.

### The mistake this prevents

`reverse_payment` has to check that removing a payment moves the balance by
exactly that payment's amount. The obvious reconciliation is against the
receipt — `outstanding_after + amount` — and it is wrong whenever a later
payment exists: reversing the first of two payments compares against a figure
two payments out of date, and the reversal is refused for no reason.

The function now captures `public.loan_outstanding()` immediately before the
update and asserts the live balance moved by the payment's amount.
`tests/db/payment-reversal.test.ts` keeps that honest with a two-payment case.

### Consequences

* A receipt is evidence of a moment. A balance is a fact about now. The schema
  makes it impossible to confuse the two by accident, because the historical
  figures are immutable and the live ones have nowhere to be stored.
* A reversed receipt still shows its original figures, with a line saying they
  are what the receipt said when it was issued.

## ADR-030 — Idempotency is a server-minted key, not a duplicate heuristic

**Status:** accepted (Phase 6)

### Context

A collection officer on a weak connection taps "Record", sees nothing happen,
and taps again. Two UGX 4,000 payments appear. Or the form is resubmitted from
the browser's history, or the action retries after a dropped response.

Two genuinely identical cash payments from the same borrower on the same day
are also completely normal — a morning collection and an afternoon one.

So the system has to tell a retried submission apart from a real second
payment, and no amount of inspecting amount, loan and timestamp can do it: the
two cases look the same.

### Decision

**Every payment carries a `uuid` idempotency key, minted on the server when the
form is rendered, unique across `loan_payments`.**

* `post_payment` takes an advisory lock on the key, then looks for an existing
  payment with it. If one exists, it returns that payment — the money is not
  recorded twice and the caller gets the same receipt.
* The key is NOT NULL and the column is UNIQUE. An optional key would make the
  protection something a caller could forget, which is the same as not having
  it.
* It is minted with `node:crypto`'s `randomUUID` in a server component, never
  in the browser and never supplied by a client, so a caller cannot replay
  someone else's key or craft collisions.
* Two genuine payments are two form renders, so they carry two keys and both
  post. This is the behaviour the business needs.

Mobile Money additionally has a network reference, and
`loan_payments_unique_external_reference` makes `(payment_method,
external_reference)` unique among posted payments: the network's own identifier
cannot be recorded against two payments. Cash has no such identifier, which is
precisely why the idempotency key exists.

### Consequences

* The disabled submit button is a courtesy, not the guarantee. The guarantee is
  in the database.
* `tests/db/payment-concurrency.test.ts` fires the same key at the function
  concurrently and asserts exactly one payment exists afterwards, with one set
  of allocations.
* A retried reversal is a separate question, handled by the double-reversal
  guard in ADR-028 rather than by a key.

## ADR-031 — Within an installment, interest is covered before principal

**Status:** accepted (Phase 6)

### Context

A payment is applied to the oldest unpaid collection first — that part is not
in question; any other order would let a borrower leave the earliest
obligation unpaid indefinitely while covering later ones.

But each collection has a scheduled principal part and a scheduled interest
part, and a payment that covers only some of it has to split. Two candidate
rules:

1. **Pro-rata.** Split the payment in the same ratio as the collection's own
   principal and interest. Feels even-handed.
2. **Interest first.** Cover the collection's interest, then its principal.

### Decision

**Interest first, within each collection.**

The deciding argument is arithmetic rather than policy. Pro-rata needs a
division — `take × interest ÷ expected` — which needs a rounding rule, which
needs a remainder policy, and which has to produce the same answer in
PostgreSQL and in TypeScript on every input or the preview a staff member
confirms will disagree with the ledger.

Interest first needs no division at all:

```
take      = min(remaining_of_collection, unallocated)
interest  = min(remaining_interest_of_collection, take)
principal = take - interest
```

Every component is a `min()` of two integers, so `principal + interest = take`
holds exactly, with nothing to round and no remainder to place. The rule is
expressible identically in SQL (`least`) and in TypeScript (`Math.min`), which
is what `tests/db/payment-parity.test.ts` checks payment by payment across
thirty randomly paid-off loans.

It is also the conventional order in lending, and it is the order that does not
flatter the borrower's principal balance: principal falls only once the
interest it accrued has been covered.

### Consequences

* The allocation of any payment is fully determined by integer arithmetic. No
  float appears anywhere on the path, which `npm run audit:money` enforces
  mechanically.
* `loan_balances` can report principal paid and interest paid exactly, and
  `principal_paid + principal_remaining = contractual_principal` holds as an
  invariant rather than approximately.
* A part-paid collection may have its interest fully covered and its principal
  untouched. That is visible in the coverage view and on the receipt, and it is
  the honest description of what the money was applied to.

## ADR-032 — Clearance is a fact about the ledger, not a flag somebody sets

**Status:** accepted (Phase 6)

### Context

A loan that has been paid off should stop appearing as active. The easy
implementation is a `cleared` status that the posting path sets when it
believes the balance reached zero, and clears again on a reversal.

The failure mode is a status that contradicts the ledger: a loan marked
cleared while it still owes money, or marked active with nothing outstanding.
Both are reachable if the transition trusts whoever performed it — a buggy
code path, a direct UPDATE, a leaked secret key.

### Decision

**`loans_guard_transition` validates both transitions against
`public.loan_outstanding()`, computed at the moment of the transition.**

* `active → cleared` is refused unless the derived outstanding balance is
  exactly zero.
* `cleared → active` is refused unless it is greater than zero.
* Both rules bind **every** caller, including the table owner and
  `service_role`. There is no trusted path that may set the status without the
  ledger agreeing, because a status nothing can verify is not worth having.
* The transition also requires a capability — `payments:create` to clear,
  `payments:reverse` to reopen — and stamps `cleared_at` and `cleared_by` from
  the database's own view of the actor, never from a parameter.

So clearance is not a claim the application makes. It is a claim the database
re-derives and either confirms or refuses.

### Why not a trigger that sets the status itself

Considered, and rejected because it would hide a real decision. Settling a loan
is an outcome of a payment somebody took and is accountable for, and
`post_payment` performs it explicitly, inside the same transaction, after it
has reconciled. A trigger firing on an `UPDATE` to some other table would make
the clearing of a borrower's loan a side effect nobody signed.

### Consequences

* The status can never contradict the balance, which makes `loans.status` safe
  to filter on without re-deriving the ledger.
* A reversal that moves the balance above zero reopens the loan automatically,
  through the same validated path, and `cleared_at` is cleared with it.
* The audit trail distinguishes `loan.reopened` from `loan.disbursed`. Phase 4's
  `audit_loan_change` mapped every transition into `active` to "disbursed",
  which after Phase 6 would have recorded a false claim that the business paid
  money out a second time. Migration `20261006000800` replaces that function.

## ADR-033 — Arrears are derived on every read, and stored nowhere

**Status:** accepted (Phase 7)

### Context

Phase 7 has to answer "what should this borrower have paid by now, and
hasn't". The obvious implementation is a set of columns — `arrears_amount`,
`days_past_due`, `missed_payments`, `delinquency_status` — maintained by a
nightly job.

Three things are wrong with that, and they are not matters of taste.

1. **It is wrong every morning until the job runs**, and silently wrong
   forever if the job stops. A loan is in arrears because the calendar moved,
   not because a process noticed.
2. **It has to be corrected after every payment and every reversal.** Any path
   that misses one leaves a borrower shown as delinquent when they are not, or
   current when they are months behind — and the paths multiply.
3. **It is editable.** A stored arrears figure is a number somebody can set.
   That is the single most attackable thing this phase could introduce.

### Decision

**Nothing in Phase 7's delinquency model is stored. Every figure is computed
when it is read**, from three things that cannot be edited: the immutable
schedule, the allocations of posted payments, and today's date in the business
timezone.

`loan_delinquency` is a `security_invoker` view. There is no delinquency
table, no arrears column, no status column, and
`tests/db/delinquency.test.ts` asserts the absence across the whole schema.

The figures are defined exactly:

* **past-due arrears** — the uncovered amount of every collection due strictly
  before today. The *uncovered* amount, so a collection part-covered by an
  earlier overpayment contributes only what is left of it.
* **due today** — the uncovered amount of collections due today.
* **current amount due** — the two added. This is what turns a missed UGX
  4,000 Monday into UGX 8,000 on Tuesday **with neither scheduled row
  changing**, which is the whole point: ADR-026 made the schedule evidence,
  and evidence that gets rewritten when somebody misses a payment is not
  evidence.
* **missed collections** and **days past due** are *different measures* and
  both are reported. Three missed collections on an every-3-days loan are nine
  days late; calling the count "days" would overstate a borrower's lateness
  threefold, which on a collections list is the difference between a phone
  call and a visit.

### The one exception, and why

The **penalty** is materialised as a row. It is a charge rather than an
observation: the business must be able to show where a figure came from, and
money has to be able to reach it. See ADR-035.

### Consequences

* There is nothing for any role — Owner and `service_role` included — to edit
  a borrower into or out of arrears. The only way to change arrears is to pay,
  or to reverse a payment, both audited financial acts.
* A loan appears on the overdue list the moment midnight passes in Kampala,
  with no job, no trigger and no transition.
* The audit trail records no delinquency events. Arrears are a consequence of
  time, and a trail that grew by a row per loan per day would bury the events
  that matter.
* The cost is a view that recomputes on each read. At this scale — a few
  hundred collections and a few dozen payments per loan, every aggregate
  indexed — that is cheaper than the reconciliation a cache would need.

## ADR-034 — One business clock, and a test override no application path can reach

**Status:** accepted (Phase 7)

### Context

Every Phase 7 rule is a comparison against a date: a due date against today, a
payment's `received_at` against a grace deadline. Two problems follow.

**"Today" is not a universal fact.** At 23:30 UTC on the 9th it is already the
10th in Kampala. A collection due on the 10th is overdue by one system and
current by another, depending on the hour somebody happens to look.

**Time-sensitive rules are untestable without control of the clock.** A loan
disbursed today cannot reach its final collection date, let alone its grace
deadline. Back-dating `loans.disbursed_at` would mean fighting the immutability
guards that make a schedule evidence, and would test a state the application
cannot produce.

### Decision

**One function is the source of now, and everything else derives from it.**

* `public.business_now()` returns the current instant. `business_date()`
  converts it to a business day using `company_settings.timezone`, and
  `payment_business_date()` converts a payment's instant the same way.
* `post_payment` stamps `received_at` from it, `reverse_payment` stamps
  `reversed_at`, the guard trigger stamps the reversal time, and
  `ensure_penalty_applied` stamps `applied_at`.
* Nothing in Phase 7 calls `current_date` or `now()::date`. Those are the
  server's clock in the server's zone, which is a fact about hosting.

**`business_now()` honours `app.business_now`, but only when `session_user`
owns the tables.** That is a direct database connection as the schema owner,
which no application path has: PostgREST reaches PostgreSQL as
`authenticator` and then switches role, the privileged server client connects
as `service_role`, and neither can change `session_user` or set a
configuration parameter from a browser. `set local role authenticated` does
not change `session_user` either, which is what lets the database tests act as
a real application role at a chosen instant.

The threat profile is the one `docs/SECURITY.md` already documents for the
test fixtures' trigger-disabling: somebody who can connect as the table owner
can do anything to the data, and no in-database design changes that. What
matters is that nothing a client, a staff member or a leaked publishable key
can reach moves the business date by one day.

### Two implementation details that are not stylistic

**The gate is a nested `IF`, not `and`.** PostgreSQL does not promise to
evaluate the operands of `AND` in order, or to skip the second when the first
is false. Written as `if v_override is not null and is_table_owner_session()`,
the privilege-gated helper could be called on *every* invocation — which for a
session role is `permission denied` on a function every delinquency read
depends on. That is not hypothetical: it is how the bug was found, by a
borrower being unable to read their own arrears.

**And `business_now()` is `SECURITY DEFINER`**, so the gate is callable
whatever the caller's privileges. `session_user` is unaffected by
`SECURITY DEFINER` — only `current_user` changes — so the gate still reports
the connection's identity, which is what it is for.

### Consequences

* A payment's business date and the business date can never disagree, so the
  penalty basis boundary is unambiguous.
* Grace boundaries, month ends, year ends, leap days and the 23:59-UTC case
  are all testable, and are tested.
* Changing `company_settings.timezone` moves every delinquency comparison
  consistently, which `tests/db/delinquency.test.ts` exercises.

## ADR-035 — The penalty is an obligation, charged on a reconstructed basis

**Status:** accepted (Phase 7)

### Context

The business rule: a loan still unpaid three days after its final collection
date is charged 50% of what it owed when that grace period ran out.

Three questions have to be answered before a line is written. What *is* the
charge? What is it charged on? And when is it written down?

### Decision

**A penalty is a row in `loan_penalties`, not a column on the loan.**

Columns on `loans` would mean `total_expected_repayment` stopped meaning "what
this borrower agreed to repay" and started meaning "what they owe us now,
including a charge added later" — two different questions that a dispute turns
on. The contract is untouched: principal, contractual interest, the monthly
periods and every scheduled collection stay exactly as agreed and generated.

The row carries the complete provenance: the final due date it followed, the
grace period that applied, the balance it was charged on, the rate, the date
it took effect, and the rule that fired. Anybody can reconstruct the
arithmetic from the row alone.

**The basis is reconstructed as at the end of the grace period.**

Nothing guarantees a process looked at the loan that day. If the basis were
read whenever the charge was finally written, a borrower who paid UGX 90,000
of a UGX 100,000 debt on day six would be charged 50% of 10,000 instead of 50%
of 100,000 — and the later they paid, the less they would owe. The incentive
would be exactly backwards.

So `loan_outstanding_as_of(loan, date)` recomputes the contractual balance
counting only still-posted payments whose **business date** is on or before
that date. A payment on the penalty's effective date does not count: the
charge takes effect at the start of that day.

**Reversed payments never count.** A payment made during grace and reversed
afterwards does not reduce the basis — the money was withdrawn, so it never
really paid. This is what stops a loan escaping a charge by looking cleared
for a few days, and it is why `reverse_payment` materialises a penalty on its
way out.

**Once charged, nothing about it changes.** `loan_penalties` refuses UPDATE and
DELETE for every caller including `service_role`, and the amount is re-derived
by a CHECK constraint from the stored basis and rate — so a *forged* penalty
is impossible rather than merely unauthorized. A unique index makes the
one-time rule a property of the database: not 50% a day, not 50% a month, and
never a penalty on a penalty.

### When it is written down, given that there is no scheduled job

Eligibility is **derived continuously**: `loan_delinquency.penalty_eligible` is
true the moment the business date passes the penalty date, with no process
involved. Materialisation happens at the only moments it matters:

* `post_payment` calls `ensure_penalty_applied` **before it reads a balance**,
  so a borrower cannot settle yesterday's figure and escape a charge that was
  already due. This is the critical path, and §38's requirement.
* `reverse_payment` calls it afterwards, so a loan whose exemption rested on
  money that has now been withdrawn does not stay exempt.
* `apply_eligible_penalties()` exists for a future scheduled job. It is an
  optimisation, not a dependency: correctness never waits for cron.

A staff read materialises nothing. A SELECT must not write — it may run in a
read-only transaction, as a borrower, or under a role with no privileges on
`loan_penalties` — so screens show the projected charge from the view,
labelled as pending, and the transaction that needs it to exist creates it.

### Consequences

* `loans.total_expected_repayment` still means the agreement. "What is owed"
  is `loan_total_outstanding`, which is the contract plus unpaid penalties.
* A penalty is never recorded as interest. `payment_allocations` has a third
  component and CHECK constraints that refuse a penalty allocation carrying
  principal or interest, so `principal_paid + principal_remaining =
  contractual_principal` still holds exactly.
* A loan cannot clear while a charge stands: `loans_guard_transition` now
  tests `loan_total_outstanding`, which binds `service_role` too (ADR-032).
* No role can create, edit, delete or waive a charge. A waiver, if the business
  ever wants one, is a new audited transaction that leaves the penalty
  standing — not an edit.

## ADR-036 — Payments reach a penalty through one allocation table, not two

**Status:** accepted (Phase 7)

### Context

Phase 6's `payment_allocations` points at an installment. A penalty is not an
installment, so money had to reach it some other way.

### Decision

**Generalise the target: exactly one of `installment_id` and `penalty_id` is
set, never both and never neither.**

The alternative was a second table, `penalty_payment_allocations`, leaving the
contractual schema untouched. It would have duplicated every piece of
machinery that makes an allocation trustworthy — the append-only triggers, the
per-row component CHECKs, the audit trigger, the policy that delegates
visibility to the payment — and it would have made the most important question
about a payment ("where did this money go?") a union of two tables that could
drift apart. Every balance view, every receipt and every reconciliation would
have to remember both, and the one that forgot would under-report silently.

The cost is a nullable `installment_id`, which is only safe with a strict rule
about what may then be null. So the rule is explicit, as CHECK constraints:

* exactly one target (`payment_allocations_one_target`);
* an installment allocation splits into principal and interest and carries no
  penalty component;
* a penalty allocation is entirely penalty, with no principal and no interest.

Existing rows satisfy all three unchanged — `allocated_penalty` defaults to
zero — so no Phase 6 row is rewritten and no receipt changes. The constraints
are validated against the existing data at migration time rather than added
`NOT VALID`, which is the point at which a surprise would be cheap to find.

### The allocation order needs no special case

A penalty's effective date is the day after the grace period, which is later
than every scheduled collection. So ordinary oldest-first — `order by
effective_date, obligation_rank, sequence_number` over the `loan_obligations`
view — covers the whole contract before it touches the charge, with no penalty
branch anywhere in the allocation logic. That is why the penalty is modelled
with a date at all.

The minimum-payment rule follows for free: stated over obligations rather than
collections, it is the earliest uncovered collection's remainder while any
collection is unpaid, and the penalty's remainder once the contract is settled.

### Consequences

* One answer to "where did this payment go", for a receipt and for a
  reconciliation alike.
* The interest-first rule (ADR-031) gains a third `min()` term and no
  division: `interest`, then `penalty`, then principal as the remainder. At
  most one of the first two is non-zero for any obligation, so the components
  still sum exactly with nothing to round.
* `loan_balances` reports `penalty_assessed`, `penalty_paid` and
  `penalty_remaining` separately from the contractual figures, and
  `total_collected` — contract and penalty together — is what now reconciles
  against the payments themselves.

## ADR-037 — A report reads; it never computes

**Status:** accepted (Phase 8)

### Context

Phase 8 puts figures on screens: dashboards, collection reports, a portfolio
register, arrears lists, statements. Every one of those figures already exists
somewhere — in `loan_balances`, in `loan_delinquency`, in the payment ledger
and its allocations.

The tempting shortcut is for a card to work out its own number. It is one line
of JavaScript to divide interest collected by principal disbursed, or to
subtract collected from expected and call the result outstanding.

### Decision

**No Phase 8 module performs financial arithmetic.** The reporting layer
aggregates and joins figures the database already decided, and nothing else.

Concretely:

* `lib/domain/reporting.ts` handles date ranges, pagination, CSV and the
  written definitions. It adds no money.
* The five reporting views aggregate and join. The only new quantity in the
  whole phase is `expected_today` — a subtraction between two stored
  amounts — and even that is in SQL, beside the data, not in a component.
* `lib/data/reports.ts` sums per-row figures the views produced
  (`effectiveAmount`, `totalOutstanding`). Summing authoritative rows is
  aggregation; re-deriving what a borrower owes would be a second ledger.
* `npm run audit:money` covers all nineteen new financial files, so a
  `toFixed`, a `/ 100` or a float rate in a dashboard fails the build. It
  caught two on the first run — see `docs/SECURITY.md`.

### Why this is stricter than it sounds

A dashboard that computes its own total is not merely redundant. It is a
*second answer* to a question the ledger has already answered, and the first
time the two disagree nobody can tell which is wrong. That is worse than
having no dashboard: a wrong figure that looks authoritative gets acted on.

The engines in `lib/domain/{loan,repayment-schedule,payment,delinquency}.ts`
exist because a screen must be able to preview a calculation before it is
committed, and a parity test reconciles each against the database. A report
previews nothing. It has no reason to calculate and therefore no permission to.

### Consequences

* Every reported figure traces to a named column in a named view, which is
  what `METRIC_DEFINITIONS` records and what the documentation quotes.
* A reported figure cannot drift from the ledger, because there is nothing to
  drift. `tests/db/reporting-parity.test.ts` reconciles each dashboard column
  against SQL written independently of the views, and finds them equal by
  construction rather than by luck.
* The cost is that a figure nobody has defined cannot be shown. That is the
  intended cost: it forces the definition to be written down before the card
  is built.

## ADR-038 — Reporting is split by what the figures reveal

**Status:** accepted (Phase 8)

### Context

A single `reports:view` was the obvious design and is the wrong one. The
person who counts cash over the counter and the person who owns the business
need different screens, and one capability would have handed the portfolio's
interest income to the counter the moment the first financial report shipped
behind it.

### Decision

Three capabilities, split by what the figures tell you rather than by which
screen they appear on:

| Capability | What it opens | Who holds it |
| --- | --- | --- |
| `reports:view_operational` | Today's collection sheet, the collection report, arrears, grace, the client directory | Secretary/Treasurer, Manager, Owner |
| `reports:view_financial` | The loan register, cleared loans, the charges report, portfolio-wide outstanding | Manager, Owner |
| `reports:view_sensitive` | The executive summary: principal disbursed, interest collected, penalty collected | Owner alone |

The operational reports are per-client and per-loan figures the holder already
sees one record at a time, arranged for a day's work. The financial reports
are the book. The sensitive ones are what the business earns.

### Two things these capabilities are not

**They are not a substitute for the underlying ones.** A report is a rendering
of data the holder must already be entitled to, so the arrears report also
requires `delinquency:view`, the collection report also requires
`payments:view`, and the capabilities are tested as a conjunction. Adding
these three therefore widens nobody's access to a row they could not already
open individually.

**They are not the boundary.** Row Level Security decides which rows come
back, which is why the same export route is safe for a Secretary/Treasurer
and an Owner: the code is identical and the files are different lengths.

### Consequences

* `reports:view_sensitive` is the first capability in the system held by the
  Owner alone besides `settings:update`, `audit:view` and `payments:reverse` —
  which is the right company for it.
* A Manager supervises lending without seeing what the business earns. That
  was a decision, not an omission, and §42 asked for it to be one.
* There is no `reports:create`, `reports:schedule` or `reports:export`.
  Export is not separately gated because denying it would deny
  copy-and-paste rather than enforce anything; what export does need is the
  same check *on the server*, which each route handler performs.

## ADR-039 — Every reporting view is `security_invoker`, and none is materialised

**Status:** accepted (Phase 8)

### Context

Phase 7 noted that a larger portfolio might one day benefit from a
materialised view. Phase 8 is the phase that would have built one: five
reporting views, two of them portfolio-wide aggregates recomputed on every
dashboard load.

### Decision

**All five are ordinary `security_invoker` views. None is materialised, and
none is `SECURITY DEFINER`.**

A materialised view is *owned data*. It is populated by whoever refreshes it,
so it has no caller to be read on behalf of, and Row Level Security cannot
apply to it at all. A materialised `dashboard_portfolio_summary` would be a
single row holding every borrower's position, readable by anyone with a grant
on it — which is the most valuable object an attacker could ask for in this
schema.

The same reasoning rules out `SECURITY DEFINER`: a view that ran as its owner
would return the whole book to a borrower.

With `security_invoker`, each view is read under the caller's own policies. A
borrower selecting from `payment_register` sees their own payments; selecting
from `dashboard_portfolio_summary` they get an aggregate over their own one
loan, which `tests/db/rls-reports.test.ts` asserts explicitly rather than
assumes.

### What the measurements say

Profiled at ten times this business's expected scale — 500 loans, 15,000
collections, 5,000 payments — every report query completes well inside a
second:

| Query | Median |
| --- | --- |
| `dashboard_portfolio_summary` | 61 ms |
| `dashboard_collection_summary` | 104 ms |
| `collections_today` (one page) | 5 ms |
| `payment_register` (one month) | 67 ms |
| `loan_portfolio_report` (one page) | 24–48 ms |

So the trade is not even a trade yet. **Correctness before performance**, and
the performance is fine.

### One measured change that was worth making

The collection report filters on `received_at`, not on `business_date`.
`business_date` is `payment_business_date(received_at)`, which reads the
company's timezone — so it is STABLE rather than IMMUTABLE and **cannot be
indexed at all**. Filtering on it costs a function call per row and gives the
planner no estimate: 65 ms that way against 2 ms on `received_at`, using an
index that already existed.

The two filters are exactly equivalent, because a business date range *is* an
instant range in the business timezone, and the conversion uses the Phase 1
helpers rather than a third implementation.

### Consequences

* No new index was added. Every report either uses an existing index or scans
  a table small enough that scanning is the correct plan, and
  `docs/SECURITY.md` records the profiling rather than leaving it to opinion.
* If the ledger grows by an order of magnitude, the cost will be the
  allocation aggregation in `payment_register`, not the date filter. The
  remedy then is a covering index on `payment_allocations`, and a materialised
  view remains the last resort rather than the first.

## ADR-040 — Expected, collected and remaining are three numbers, not a subtraction

**Status:** accepted (Phase 8)

### Context

The collections dashboard has to answer three questions that look like one:

* what were we expecting to collect today?
* what have we collected today?
* what is still owed for today?

Phase 7 already answers the third: `due_today_amount` is the uncovered part of
today's collections, netting off every payment including today's.

### Decision

**All three are reported, and the screen says in words that the first minus
the second is not the third.**

* `expected_today` — today's scheduled collections less whatever *earlier*
  payments had already covered of them. The day's target as it stood this
  morning. This is the one genuinely new quantity in Phase 8.
* `collected_today` — every posted payment received today, whatever it was
  applied to.
* `remaining_today` — Phase 7's `due_today_amount`, live.

They do not form an identity, and they must not be presented as one. Money
taken today may settle arrears from last month or run ahead into next week; it
does not have to land on today's installment. A dashboard implying
`expected − collected = remaining` would be asserting a relationship the ledger
does not have, and the first person to notice they do not add up would stop
trusting all three.

### Why `expected_today` had to be new

Reading `due_today_amount` as the day's target makes the target shrink as the
day goes on, which is the wrong answer to "how are we doing". And reading the
raw installment amount makes a borrower who paid ahead last week appear due
again — the prepayment defect §130 exists to prevent, and the reason a loan
whose collection is already covered is **absent from `collections_today`
entirely** rather than present with a zero.

### Consequences

* `collections_today` is the operational list and `dashboard_collection_summary`
  aggregates exactly it, so the card and the sheet beneath it cannot disagree —
  asserted in `tests/db/reporting-views.test.ts`.
* A sentence under the three cards explains the relationship. That sentence is
  asserted by a UI test, because it is doing real work.

## ADR-041 — A statement carries the borrower as they were when the loan was written

**Status:** accepted (Phase 8)

### Context

A loan statement has a header: the borrower's name, client number and phone. A
borrower who marries and changes their name is an ordinary event, and Phase 3
lets staff correct a client record.

So which name belongs on a statement for a loan agreed in March, printed in
October, for a borrower who changed their name in April?

### Decision

**The name recorded when the loan was written**, from the loan's own immutable
`loan_client_snapshots` row, with the current name shown beside it when the two
differ and a sentence explaining why.

Each payment line likewise carries `client_name_at_payment` — the name on that
receipt — so a statement and the receipts it lists cannot contradict each
other.

A statement is a historical document about an agreement. The borrower who
signed in March did not change because they married in April, and a statement
whose header silently rewrote itself would disagree with the paper the client
is holding. Phase 4 captured the snapshot for exactly this question; §33 asked
for the choice to be made deliberately rather than by whichever column was to
hand.

### Where the current name is used instead

Everywhere the question is "who do I contact": the collection sheet, the
arrears report, the client directory. A collections officer needs the name the
borrower answers to today. The distinction is consistent — historical
documents use the snapshot, working lists use the record — and
`loan_portfolio_report` exposes both so neither screen has to choose wrongly.

### Consequences

* `tests/db/reporting-views.test.ts` renames a borrower and asserts the
  snapshot does not follow.
* The statement is explicitly **not** an as-at document in any other respect:
  the balances are today's, and the header says "as at" with today's date.
  Phase 8 builds no historical balance reporting (§106), and nothing on the
  page implies otherwise.

## ADR-042 — A total always describes exactly the rows shown

**Status:** accepted (Phase 8)

### Context

A report has a table, a set of summary cards, a day-by-day breakdown and a CSV
download. The straightforward implementation runs four queries that happen to
share a filter.

They will eventually disagree. A filter applied in one place and not another,
a pagination bound that leaks into an aggregate, a cached count — and then a
card says UGX 4.1 million while the rows beneath it add to 3.8 million, and
somebody has to work out which is right.

### Decision

**One query per report, summed and sliced in memory.**

`getCollectionReport` reads the whole filtered set once, bounded by the export
cap, then sums it, groups it by day, week and month, and slices the display
page out of it. The cards, the three breakdowns, the table and the CSV are four
renderings of one array. Parity is structural: there is no arrangement of the
code in which they could differ.

The same shape applies to the portfolio, arrears, penalty and client reports.

### The row cap, and saying so

`MAX_EXPORT_ROWS` is 5,000 — several years of this business's collections, and
small enough that the file arrives rather than times out. When a filtered set
hits it, the report **says so and withholds the totals** rather than showing a
partial sum.

That is the important half. A partial total presented as a total is worse than
no total at all: it is a figure somebody would circulate. So the screen shows
the rows it has, an explanation, and no summary.

### What this costs

Reading the whole filtered set to show 25 rows is wasteful in the abstract. In
practice a month of this business's collections is a few hundred rows, the
measured cost is 67 ms at ten times that, and what it buys is that a report
cannot contradict itself. When the ledger outgrows it, the fix is an aggregate
query *and* a test that pins it to the table — not the other way round.

### Consequences

* A CSV contains every matching row, not the page somebody happened to be on.
  A file containing page 3 of a report would be a quiet lie about what was
  downloaded.
* `truncated` is part of the report type, so a caller cannot forget to handle
  it; the UI test asserts the warning appears and the totals do not.

---

## ADR-043 — Membership hangs off `clients`, and is not a role

**Decision.** A membership is a row in `public.memberships` keyed on
`clients.id`. It carries no name, phone number, date of birth or National
Identification Number. Membership adds five capabilities to the existing
matrix and no new role.

**Alternatives.**

| Option | Why not |
| --- | --- |
| A `members` table with its own identity columns | A second identity record for the same person is how a register comes to hold two of somebody with different phone numbers. It would also mean the NIN protection built into `client_identities` had to be built again — and the second copy would be the one that leaked. |
| A `member` role in `public.roles` | Roles answer "what may this person do to the system". Membership answers "what does the business owe this customer". A `member` role would mean a borrower whose savings lapse loses their portal login, and it would give the business two answers to "who is this person". |
| A `is_member` boolean on `clients` | Records nothing about when they joined, under what terms, or why they left — and a membership has a lifecycle with an auditable history, which a boolean cannot hold. |

**Consequences.** A non-member remains a perfectly valid client, which is
what the business asked for. A borrower reads their own membership through
`clients.profile_id`, the one optional, indirect link the system already has
between a login and a customer — so no new identity path exists to be got
wrong. The cost is a join wherever a member's name is needed, which is what
`public.membership_register` exists for.

---

## ADR-044 — The membership policy is effective-dated versions, not a settings row

**Decision.** The programme's rules live in
`public.membership_policy_versions`, one row per version, each with an
`effective_from` date. A membership references the version it was enrolled
under, and a version anybody is enrolled under can never have its figures
changed — publishing a change inserts a new version.

**Alternatives.**

| Option | Why not |
| --- | --- |
| A singleton, like `business_settings` | A member who joined in March must keep March's terms when the business raises the savings minimum in June. A singleton makes that unanswerable: there is one row, and editing it silently rewrites what everybody was promised. |
| A snapshot on each membership, like `loan_product_snapshots` | A loan is an agreement struck once and then run off, so a snapshot at approval is exactly right. A membership is a standing relationship with a monthly obligation, an accruing qualification and an annual distribution, all evaluated against the rules that applied *at the time*. Thirty columns copied onto every membership row would be the same facts stored once per member. |

**Consequences.** This is the shape `guarantor_consent_terms` already takes,
and for the same reason: a guarantor cannot be held to words the business
edited afterwards. The guard freezes every figure once a membership
references the version, and refuses a second approval. Status may still move
— draft to active to superseded — because that is how a version is retired.

---

## ADR-045 — `is_financially_enabled` is generated, so an undecided policy cannot transact

**Decision.** Nine of the programme's rules are undecided. Each is a
**nullable** column whose `NULL` means *the client has not decided*, with no
default. `is_financially_enabled` is a **stored generated column** that is
true only when the version is active, approved, and all nine are decided.

**Reasoning.** The design rests on the claim that nothing financial can run
until the rules are settled. A boolean an administrator ticks cannot carry
that claim — it can be ticked on an incomplete policy, and the day somebody
does, savings are being taken under rules nobody agreed. A generated column
cannot be true while a column is NULL, and no `UPDATE` makes it so.

Giving the nine a default was rejected outright: a default here is an
invented policy, and the one thing worse than an unanswered question is an
answer the client never gave.

**Consequences.** Version 1.0 ships as an unapproved draft with the gate
shut, which is the honest state of the programme. `false` and `0` count as
*decided*, which is why the check is written as `is not null` per column
rather than as a falsy test — "the months need not be consecutive" and "there
is no waiting period" are real answers. `isPolicyFinanciallyEnabled()` in
`lib/domain/membership.ts` computes the same answer for the interface so it
can explain the hold without a second round trip, and a database test asserts
the two agree on the same row.

**Superseded in part by ADR-049.** The generated-column mechanism is
unchanged and was never in doubt. What was wrong was that there was *one* of
them: a single switch covering five activities held the registration fee
hostage to the year-end profit formula. `is_financially_enabled` survives as
the overall completeness indicator; the gate a posting consults is now
per-activity.

---

## ADR-046 — One live membership per client, by partial unique index

**Decision.** `memberships_one_live_per_client` is unique on `client_id`
where `status in ('pending', 'active', 'suspended')`.

**Alternatives.**

| Option | Why not |
| --- | --- |
| A check in the Server Action | Two concurrent enrolments both pass it and both commit. This is the duplicate-invoice bug in another costume. |
| `unique (client_id)` | A client who withdrew in 2026 and rejoins in 2028 is a legitimate second row. A total unique constraint would force either deleting the history or reusing the row — and reusing it would carry the old activation date forward, silently crediting the savings qualification period and the benefit waiting period the member is supposed to start again. |

**Consequences.** Rejoining mints a new membership number, which is correct:
the two relationships are different, and the card says so. Reactivating a
withdrawn membership is deliberately not a transition — `withdrawn → active`
is refused by the lifecycle guard, by the domain module and by the validation
schema.

---

## ADR-047 — The branch and the policy version are derived on every enrolment, not defaulted

**Decision.** `memberships_stamp_provenance()` derives `branch_id` from the
client and `policy_version_id` from the version in force on **every** insert,
and **refuses** a supplied value that disagrees rather than overwriting it.
The rules sit above the trusted-path exemption, so they bind `service_role`
and the table owner. The insert policy states both independently in its
`WITH CHECK`.

**The defect.** The trigger originally filled each in *when it arrived NULL*,
which is a default rather than a rule. A caller holding `membership:create`
and a copy of curl supplies them, and a supplied value went through
untouched — so a member could be enrolled into a branch they have no
relationship with, or under a draft nobody had approved, a superseded
version, or one that does not begin until next year. Each of those is a wrong
answer to "what was this member promised".

**Why RLS did not already stop it.** The insert policy's branch clause reads
*"a branch-assigned profile may enrol only into their own branch"* — and
every profile in this system is unassigned, so the clause was vacuously true.
A policy that is true for everybody is not a boundary, and a boundary that
holds only for a configuration nobody uses is worth saying out loud.

**Why refuse rather than silently correct.** The same choice
`memberships_assign_number` makes about a supplied membership number: silently
correcting a value hides a caller that believes it is choosing one, and the
next thing built on top of that caller inherits the belief.

**Consequences.** A membership always sits at the client's branch, so the
branch rule that decides who may read it cannot be sidestepped by writing a
different value. A client whose branch changes takes their membership with
them; the update guard permits exactly that move and no other. Enrolment is
refused outright when no version is in force, which is the state of the
system as shipped.

---

## ADR-048 — A policy version's status moves one way, and freezes on approval

**Decision.** `draft → active → superseded`, and nothing else. Nothing
returns to draft; nothing returns from superseded. Every contractual
column — the twelve confirmed figures, the **nine undecided rules**, the
version string, the effective date and the title — is frozen once the version
is approved **or** once anybody is enrolled under it.

**What was wrong.** The freeze covered the twelve figures and left the nine
nullable rules writable, on the reasoning that writing into a blank changes
nothing. That reasoning is wrong, and it is the more dangerous form of the
same defect: a member who enrolled while "may savings be withdrawn against a
live loan" was open did not agree to whatever answer the business later
writes there. They agreed to a version in which it was open. Filling it in
afterwards varies their terms retroactively and leaves no trace of having
changed a value.

Status was unconstrained, so an active version could be put back to draft —
asserting it had never governed anybody — or a superseded one brought back
into force, which makes the effective dates lie about which rules applied
when.

**The escape hatch, because "never" was also wrong.** A frozen version plus
an immutable `memberships.policy_version_id` together said a member is held
to their enrolment version forever. The business will publish version 1.1 and
ask existing members to accept it. ADR-049's companion,
`accept_membership_policy_version()`, is the only route: it records the
member's acceptance and moves them in one transaction, and the transition
guard re-checks the acceptance and the target version on its own account, so
the function's marker is a route rather than a permission.

**Consequences.** Changing an approved version means publishing the next one,
which is how a versioned policy is meant to work and leaves the dates telling
the truth. A draft is freely editable until the moment it is approved, which
is where the editing belongs.

---

## ADR-049 — Five readiness gates, one per activity, and an effective date

**Decision.** `membership_policy_versions` carries five stored generated
columns — `is_enrolment_enabled`, `is_savings_enabled`,
`is_member_lending_enabled`, `is_benefits_enabled`,
`is_profit_sharing_enabled` — each naming only the decisions that activity
waits on. `public.membership_policy_allows(version, activity)` is the gate a
posting consults: the generated column **and** `effective_from <=
business_date()`. `is_financially_enabled` is kept as the overall
completeness indicator.

**What was wrong.** One switch for five activities held the **UGX 5,000
registration fee** — a figure the client's own documents confirm, waiting on
no open question — hostage to **how December's surplus is divided**. A
counter could not take a fee, and savings could not be collected, because
nobody had settled the profit formula. Those are different promises, made to
different people, at different times, and they fail independently.

Separately, `active_membership_policy_id()` ignored `effective_from`
entirely, so a version activated in October for a November start enrolled
members in October under rules nobody was operating. It is now DEFINER and
checks the date, because the rule the enrolment trigger enforces and the
answer a screen reads have to be the same rule.

**Why the date is not in a generated column.** `business_date()` is not
immutable, so PostgreSQL will not accept it in a generated expression. That
is the whole reason the function exists beside the columns rather than
instead of them: the columns answer "are the decisions made", the function
adds "and has it started".

**Why an unknown activity raises.** Failing shut is the safe direction, but a
typo that silently disables a module looks exactly like a policy that has not
been decided, and the two need very different responses.

**Consequences.** Polytos Phase 2 can ship enrolment and the registration fee
without waiting on decisions 6 to 9, and savings as soon as decisions 4 and 5
land. A unit test asserts the five rule sets partition the nine exactly —
every question holds something up, and nothing is held up by a question that
does not exist. A database test reads every in-force version three ways (the
generated column, the function, and `isActivityReady()` in TypeScript) and
asserts all three agree.

---

## ADR-050 — Activation and consent are database preconditions, not form validation

**Status.** Decided in Phase 1, **enforced in Polytos Phase 2**, which owns
the tables both halves depend on. Recorded here so the requirement exists
before the code that must satisfy it.

### Decision, part one: `pending → active` has two preconditions

`memberships_guard_transition()` must refuse the transition unless **both**
hold, checked as `exists (...)` tests in the trigger and stated above the
trusted-path exemption so they bind `service_role` too:

1. **A registration fee that actually posted.** A row in
   `membership_fee_receipts` whose journal entry exists and has not been
   reversed. The test is the **journal**, not a status column on the receipt:
   "successfully posted" means the ledger moved, and a receipt that believes
   it posted while the entry was reversed is exactly the discrepancy a
   financial system exists to make impossible.
2. **A recorded acceptance of the member's own terms.** A row in
   `membership_terms_acceptances` for this membership **and** the exact
   `policy_version_id` the membership carries. Not any acceptance: accepting
   version 1.0 does not activate somebody enrolled under 1.1.

**Why not a Server Action.** Both are the preconditions of taking somebody's
savings. A membership that reached `active` without them is a person the
business is collecting money from, under terms nobody can show they agreed
to — and every route that reaches the table must be refused, not merely the
one route the form takes. Neither can be a CHECK constraint, because both are
statements about rows in other tables; the trigger is the only place in the
database that can say them.

**What Phase 2 must also decide, and this ADR does not.** Whether reversing a
registration fee *after* activation suspends the membership or merely flags
it. What it may not do is make the activation retrospectively legitimate: the
activation must never have been possible without the posting.

### Decision, part two: a typed name is not consent

`membership_terms_acceptances.signature_name` is free text. Anybody holding
the capability can type any member's name, and the row that results is
indistinguishable from one the member signed. Phase 1 tolerates this because
nothing writes the table and no screen offers it. The moment Phase 2 builds
the enrolment form and the re-acceptance screen, a typed name alone becomes a
staff member's unilateral power to move somebody onto new terms and produce
the paperwork saying they agreed.

So Phase 2 must require **verifiable evidence that did not originate with the
person typing**, enforced in the database:

- a signature image at `signature_path`, in the private documents bucket; or
- a witnessed record carrying both `witness_name` and `witness_phone`, where
  the witness is **somebody other than `recorded_by`** — a staff member
  witnessing their own entry is the same signature twice; or
- a confirmation the member themselves sent: a portal acknowledgement under
  their own `clients.profile_id`, or a one-time code delivered to the phone
  number on the client record and returned.

A CHECK constraint on `membership_terms_acceptances` must refuse a row
carrying none of them, so no write path can skip it, and the rule applies
equally to the acceptance taken at enrolment and to a later re-acceptance
through `accept_membership_policy_version()`.

`signature_name` stays — the name a person writes is what a printed form
shows. It stops being sufficient on its own.

**Consequences.** Phase 2 cannot ship enrolment as a single INSERT. Enrolling
a member becomes one transaction that writes the membership, the fee receipt
and its journal, and the acceptance with its evidence — which is what
`enrol_member()` is for in the roadmap, and why it is a database function
rather than three calls from a form.

---

## ADR-051 — Member savings are a liability, never income

**Status.** Accepted, Polytos Phase 2.

**Context.** A member pays UGX 50,000 into their savings. Something has to
happen in the ledger, and there are two plausible-looking choices:

```
  Debit  Cash at Hand       50,000
  Credit 4xxx Savings Income 50,000     -- wrong
```

```
  Debit  Cash at Hand            50,000
  Credit 2100 Member Savings      50,000 -- right
```

The first is wrong in a way that is **invisible on every screen**. The
member's balance is there, their statement reads correctly, the savings
register is right, the deposit receipt is right. Nothing a counter or a member
would ever look at reveals it.

What it does is overstate the year's surplus by the entire savings book. And
Phase 5 distributes that surplus: the business would pay a profit share out of
its members' own deposits, discover it when the deposits could not be
returned, and have no way to tell which members' money had already been given
away.

**Decision.** `2100 Member Savings` is a **liability** account with a credit
normal side. A deposit credits it; a withdrawal debits it. A savings deposit
never touches an income account, and `post_savings_deposit` posts exactly two
legs, neither of which is income.

The reasoning is not an accounting preference — it is what the money *is*. A
deposit increases what the business owes. It is not a sale, it is not revenue,
and the business holds it on behalf of somebody who will ask for it back.

Three things enforce it beyond the function:

- `ledger_accounts` gives `2100` `account_type = 'liability'`, so the trial
  balance and the balance sheet classify it without anybody deciding again;
- the first test in `tests/db/savings.test.ts` reads the **journal lines** of a
  deposit rather than the resulting balance, and asserts that no line touches
  an account of type `income`;
- every savings test, and the demonstration seeder, ends by asserting that
  `sum(signed_amount)` over `savings_transactions` equals the `2100` balance.

**Consequences.** The savings dashboard panel is labelled "Owed to members"
rather than "savings held", and the e2e suite asserts that the phrase "savings
held" appears nowhere. A figure beside a cash balance, labelled as though the
business owned it, is how the wrong reading gets made by somebody who never
sees the ledger.

The registration fee **is** income — `4340 Membership Registration Fees` — and
that is the distinction worth keeping straight: the fee buys membership and is
not returned; a deposit is the member's money and is.

---

## ADR-052 — There is no stored savings balance

**Status.** Accepted, Polytos Phase 2.

**Context.** Every savings system wants a `balance` column on the account. It
is one read instead of an aggregate, it is obvious, and it is what somebody
will add the first time a register feels slow.

**Decision.** `savings_accounts` carries no balance. The balance is
`sum(signed_amount)` over `savings_transactions`, exposed by
`member_savings_balances`, and `signed_amount` is a **generated stored column**
derived from `kind` — so the direction of a movement is not a field anybody
sets.

**Why.** A stored balance is a second figure that can disagree with the first,
and the one that disagrees is always the one on screen. Keeping the two in step
means every posting path updating both, every reversal updating both, and every
future path remembering to — and the failure is silent: the member's statement
adds up and their balance does not match it, or the other way round, and
nobody can say which is right.

With no stored balance there is nothing to reconcile. The statement, the
register, the dashboard and the ledger are four renderings of one set of rows.

The performance argument is answered by an index on `(savings_account_id,
value_date)` and by the fact that a member has tens of transactions, not
millions. If that ever stops being true, the answer is a materialised rollup
with the subledger still authoritative — not a mutable column.

**Consequences.** A withdrawal's balance check happens inside the posting
function, under `select ... for update` on the account row, because that is
the only place a balance read is worth anything: any check made outside the
lock is stale by the time the money moves. `post_savings_withdrawal` re-checks
even after approval, which is why a deposit reversed between the decision and
the counter stops the payment rather than taking the account negative.

---

## ADR-053 — A reversal is a row, not a status

**Status.** Accepted, Polytos Phase 2. Extends ADR-016 to savings.

**Context.** A deposit is recorded twice at the counter. One of them has to
stop counting.

**Decision.** A contra transaction is appended — `deposit_reversal` or
`withdrawal_reversal` — carrying the same amount, pointing at the original
through `reverses_transaction_id`, and carrying its own contra journal entry.
The original row is never touched. `savings_transactions` refuses UPDATE and
DELETE by statement-level trigger, and `authenticated` holds no privilege for
either, so the claim is enforced twice.

**Why not a status.** Marking the original `reversed` means the record of what
happened changes after the fact. A statement printed last week would no longer
agree with one printed today, and a member who kept their copy would be holding
a document the system denies. With a contra row both are true: the deposit
happened, and it was corrected, and the statement shows both with the reason
on the correction.

**Consequences.**

- The reversal's idempotency key is **derived** from the transaction it
  reverses (`savings_reversal_key`), not supplied. A retried reversal replays;
  a caller cannot make two.
- A reversal cannot be reversed. Transaction kinds are checked, and a third
  entry saying nothing new is refused.
- Reversing a deposit that has already been withdrawn is refused: the
  liability would go negative, and the business would be recorded as owing a
  member less than nothing. The message says to reverse the withdrawals that
  spent it first.
- `member_savings_contributions` attributes a reversal to the month of the
  deposit it corrects, not the month it was made in. A deposit posted in March
  in error and reversed in July stops counting for March; it does not make
  July negative. Qualification is about what was saved in a month, and a
  correction says the saving did not happen then.

---

## ADR-054 — One savings account per membership, not per client

**Status.** Accepted, Polytos Phase 2.

**Context.** `savings_accounts` could key on `client_id` or on
`membership_id`. A client has at most one live membership (ADR-046), so for
anybody currently a member the two are the same.

They differ for somebody who **left and came back**. ADR-043 already settled
that a rejoining client is enrolled afresh with a new membership number,
because the savings qualification period and the benefit waiting period both
start again.

**Decision.** `savings_accounts.membership_id` is unique. A rejoining client
gets a second membership and therefore a second savings account.

**Why.** Keying on the client would hand a rejoining member the qualification
they did not serve. Their old contribution history would still be in the
account, `member_savings_qualification` would count it, and they would be
eligible for a member loan on the strength of months during which they were
not a member. That is the business's money lent against a qualification nobody
earned.

**Consequences.** The old account holds the old balance, which is still owed
to the member — leaving the programme does not forfeit savings, and nothing in
this phase moves money between the two accounts. If the business decides a
returning member's old savings should transfer, that is a transfer between two
accounts with a journal behind it, which is a decision and a screen, not a
default.

`getSavingsAccountForClient`, which the portal uses, therefore orders by
`opened_on` and takes one row rather than using `maybeSingle` — a rejoined
member has two accounts and the newest is the live one.

---

## ADR-055 — Consent is verified by the database from evidence it can check

**Status.** Accepted, Polytos Phase 2. Implements the requirement ADR-050 left
open.

**Context.** Phase 1 recorded an acceptance as a typed `signature_name` and a
typed `witness_name`. Its own migration header said what that was worth:
anybody with the form can type anybody's name, so the record is
indistinguishable from one the member signed.

ADR-050 made a posted fee and an accepted acceptance into database
preconditions for activation. That closes nothing on its own if "accepted" can
be asserted by whoever is filling in the form.

**Decision.** `membership_terms_acceptances` carries `consent_method` and
`verification_status`. The caller supplies the **method and its evidence**; the
database decides the **verdict**. `membership_terms_acceptances_guard` sets
`verification_status` itself, starting from `unverified` and requiring each
branch to earn `verified`:

| Method | What the database checks |
| --- | --- |
| `member_portal` | the session is the member's own, through `clients.profile_id` |
| `one_time_code` | a live, unspent challenge for *this* membership and *this* policy version, consumed in the same transaction |
| `signature_document` | the object exists in `storage.objects`, under this membership's own path |
| `witnessed_in_branch` | the witness is an active profile, and is not the recorder |
| `legacy_typed_name` | refused for a new acceptance; exists only to label Phase 1's rows honestly |

`verification_status`, `evidence_reference`, `evidence_digest`, `verified_at`,
`verified_by` and `verified_by_label` are all typed `never` on Insert and
Update in `types/database.types.ts`, so a direct write is a type error before
it is a permission error. `evidence_digest` is unique, so the same evidence
cannot be replayed for a second acceptance.

**Why a digest and not the evidence.** A one-time code is stored only as
`sha256`, and `consent_evidence_digest` is revoked from `authenticated` as well
as `anon` — a caller who could compute digests at will could search for the
code that matches a stored one, which is the whole thing storing a digest
prevents. The code is returned to its issuer **once** and exists nowhere
afterwards.

**Consequences.**

- Phase 1's existing rows are backfilled to `legacy_typed_name` /
  `unverified`, not quietly upgraded. The memberships holding one cannot be
  activated until real consent is taken, and the membership record says which
  of the two preconditions is outstanding.
- `accept_membership_policy_version` was **replaced**, not extended: the old
  six-argument signature is dropped, because leaving it would leave a second,
  weaker door into the same room.
- The enrolment screen offers only `witnessed_in_branch`, and that is a
  consequence of the evidence rather than a simplification. A code is bound to
  a membership and a signature is stored under one — and the membership is
  what the enrolment form creates. The other three are offered on the
  membership record, where the membership exists.

---

## ADR-056 — Authorisation sits above the idempotency replay

**Status.** Accepted, Polytos Phase 2. Corrects an ordering defect found by
`tests/db/rls-savings.test.ts`.

**Context.** Every money-moving function here is idempotent on a key
(ADR-030): it takes an advisory lock on the key, looks for an existing
movement, and returns it if one is there. The first draft of
`post_savings_deposit`, `post_savings_withdrawal` and
`record_membership_fee` all did that lookup **before** checking the caller's
capability — which reads naturally, because the replay is a shortcut and a
shortcut belongs at the top.

It is a disclosure. The early return hands back a transaction or receipt id,
which is a read of somebody else's movement. A caller holding no savings
capability could replay a key and be handed the id of the deposit it belongs
to.

**Decision.** In every function that replays on a key, the actor is resolved
and the capability checked **before** the advisory lock and the lookup. The
rule: establish who is asking, then decide whether this is a retry of their
own request.

**Consequences.** A caller who may not post gets the capability refusal
whether or not the key already exists, which is also the better message. The
replay still works for everybody who may post, which is the only case it was
ever for.

The test that found it is worth naming: it replays a key as a caller holding
no `savings:deposit`, and asserts the refusal. It is one of the two defects in
this phase that only an authorisation test written from the attacker's side
could find — the other being ADR-057.

---

## ADR-057 — A reporting function is SECURITY INVOKER unless it reports the business

**Status.** Accepted, Polytos Phase 2. Corrects a disclosure found by
`tests/db/rls-savings.test.ts`.

**Context.** `savings_statement`, `member_savings_qualification` and
`savings_summary` were all written SECURITY DEFINER, by habit: the other
definer functions in this schema are definer because they write something no
session may write.

These three write nothing. And a definer function is **not filtered by the
policies on the tables it reads** — so any signed-in caller could read any
member's full savings statement, and their whole contribution history, by
passing an account id. A member could read another member's savings; so could
a loan officer with no savings capability at all.

**Decision.** The two that report **a member** are SECURITY INVOKER:
`savings_statement` and `member_savings_qualification`. The policies on
`savings_accounts` and `savings_transactions` already answer "may this caller
see this member?" — staff holding `savings:view` within their branch, and the
member whose savings they are — so running as the invoker *is* the
authorisation, stated once.

A second predicate written inside the function would be the same rule stated
twice, and the copy that drifts is the one that leaks.

`savings_summary` stays SECURITY DEFINER, for the opposite reason: its whole
purpose is the figure for the business as a whole, where there is no row for a
policy to filter. Under the invoker's policies a member would receive their own
balance labelled `total_liability` — not a leak, but a lie. So it runs as the
owner and asks for `savings:view_reports` explicitly, which is the one check
in this phase that has to be written out.

**Consequences.** The general rule for this schema, stated so the next
reporting function does not have to rediscover it:

> A function that reports **one member's** data is SECURITY INVOKER and lets
> the policies decide. A function that reports **the business** is SECURITY
> DEFINER and checks a reporting capability itself. A function that **writes**
> is SECURITY DEFINER and checks the capability for the write.

`tests/db/security.test.ts` asserts the SECURITY DEFINER list exhaustively, and
the two invoker functions are named in it as deliberate absences with the
reason — so a later change that makes either definer again fails the build
rather than quietly reopening the hole.

An account the caller may not see and an account that does not exist give the
same answer: `member_savings_qualification` raises 'No such savings account'
for both. A caller who may not read a row has no business learning that it is
there.

---

## ADR-058 — Demonstration data is a script that can refuse, not a seed file

**Status.** Accepted, Polytos Phase 2.

**Context.** `supabase/seed.sql` is the obvious place for demonstration data,
and Phase 1's copy of it sketched exactly that. Phase 2 needs six members with
savings histories, and the obvious implementation is `insert` statements with
`on conflict do nothing`.

**Decision.** Demonstration data lives in `scripts/seed-demo.ts`, and
`supabase/seed.sql` stays empty.

**Why.** Three things the seed file cannot do, each of which is the whole
point:

1. **It has to refuse.** `supabase/seed.sql` is executed by `supabase db
   reset` against whatever database that command is pointed at. A script reads
   the connection string, checks the project reference against an
   **allow-list**, requires `POLYTOS_SEED_DEMO` to be an exact phrase, and
   refuses otherwise. An allow-list rather than a deny-list: a deny-list has to
   anticipate every database that must not be touched, and the one it forgot
   would be the one that mattered.

2. **It has to post through the application's own functions.** A deposit, a
   fee and a withdrawal each write a document and a journal entry in one
   transaction, with a reference number minted by a trigger. Fabricating those
   rows with `insert` would produce money the ledger does not know about —
   exactly the state the schema exists to make impossible — and would
   demonstrate a system that cannot be reached by using the product.

3. **It has to be idempotent against money.** `on conflict do nothing` covers
   a unique key; it does not stop a second run posting a second deposit. The
   script derives a deterministic idempotency key per posting, so the posting
   functions return the movement that already exists. A seeder that doubled
   its deposits would be a seeder that doubled a member's savings, and the
   person who noticed would be the member.

**Consequences.** `tests/db/demo-seed.test.ts` runs the script three times
against a real database and asserts the second and third change nothing —
twice could pass by accident on a guard that happens to catch the state the
first run leaves; three times means the state is a fixed point. It also
asserts that each refusal writes nothing at all, and that no loan is touched.

It runs in a vitest project of its own, because the policy version it
publishes is global state: only one version may be in force, so every
membership suite that publishes its own would collide with it. A project gets
its own `globalSetup`, which rebuilds the database — so the seeder meets the
empty database it is specified against and leaves nothing behind.

The script never runs as part of a migration. Migrations run on deploy; this
runs when somebody types the command and the phrase.

---

## ADR-059 — The monthly collection anchor lives on the cadence, not on the policy

**Status.** Accepted, Polytos Phase 3.

**Context.** The client's Polytos documents describe member loans collected
weekly for short terms and monthly for longer ones. "Monthly" in the documents
means a calendar month, not thirty days: a loan disbursed on the 15th is
collected on the 15th.

A calendar month is not always well defined. A loan disbursed on 31 January
has no 31 February, so somebody has to decide whether that collection falls on
the last day of the month it lands in, or on the first day of the next. The
client has not decided, and the difference is a real date on a real receipt.

The obvious place to record that decision is beside the three other
undecided member-lending questions, as a tenth nullable column on
`membership_policy_versions`.

**Decision.** It is recorded as `repayment_frequencies.month_anchor`, on the
cadence row, and the nine policy questions stay nine.

**Why.**

1. **It is a property of the cadence, not of the membership programme.** The
   question is "what does *this* collection cadence do in a short month", and
   the answer is the same whoever is borrowing. A non-member loan collected
   calendar-monthly needs the same answer, and a policy column could not give
   it one — the borrower has no policy version.

2. **Policy versions are frozen and superseded; a cadence is configuration.**
   A member is held to the version they enrolled under, and
   `membership_policy_versions_guard` refuses to let anybody answer an open
   question on an approved version. That is right for a term the member
   agreed to. It is wrong for a scheduling convention: two members enrolled
   under different versions must not have their collections land on different
   days of the same month, because then the cadence is not one cadence.

3. **The nine are the client's own list.** `docs/POLYTOS-MEMBERSHIP-POLICY-DECISIONS.md`
   records nine questions, numbered, as the client's management committee has
   them. Adding a tenth of our own invention to that list would make the
   document disagree with the thing it is a record of.

**Consequences.** The column is write-once rather than immutable: settable
while NULL, frozen from the moment it is set, enforced by
`repayment_frequencies_guard_identity`. A convention nobody has chosen can be
chosen; one that has been chosen cannot be changed underneath schedules
already generated from it.

The `monthly` cadence ships **inactive** with a NULL anchor, so nothing can be
scheduled against an undecided convention by accident. `generate_loan_schedule`
raises rather than guessing, and `validate_loan_for_approval` returns
`cadence_anchor_undecided` — which is not member-specific, because an ordinary
loan on a calendar-monthly cadence would hit the same wall.

It also means member lending has **four** outstanding decisions rather than
three, and the fourth has a consequence nobody would guess from reading the
other three: answering only the policy questions opens weekly member loans of
one and two months and leaves three-, four- and five-month loans refused.
`MEMBER_LENDING_DECISIONS` therefore lists all four in one place even though
only three of them are policy columns, and `memberLendingReadiness` reports
`pricingReady` separately from `isReady` so the interface can say "weekly
loans work, longer ones do not" instead of "nothing can be approved". A banner
that said the second while weekly loans were being approved every day would be
a banner people stop reading.

---

## ADR-060 — A member loan's term ceiling comes from the membership programme

**Status.** Accepted, Polytos Phase 3.

**Context.** `business_settings.max_loan_term_months` is the lending
business's own maximum, and `loan_products_within_business_rules` refuses a
product whose `max_term_months` exceeds it. The confirmed Polytos figure for
member loans is five months. The business setting is three.

Both numbers are correct. They are answers to different questions: three
months is the longest ordinary loan the business writes, and five months is
what the membership programme's own documents promise its members.

**Decision.** For a product with `requires_membership`, the term ceiling is
`max(member_loan_max_term_months)` across the policy versions in
`draft` or `active` status. The business setting continues to bound every
other product.

**Why.**

1. **The programme is where the promise was made.** A member who was told
   five months is owed five months, and the figure lives on the policy version
   they enrolled under. Reading the ceiling from somewhere else would mean the
   product could not express the thing the programme already promised.

2. **Draft versions count, and that is deliberate.** The ceiling here is a
   **configuration envelope** — the longest term any version the business is
   working on could permit — not an authorisation. It exists so a product can
   be configured before the version that uses it is in force, which is the
   order the work actually happens in. The per-loan ceiling is enforced
   separately and strictly: `validate_loan_for_approval` compares the loan's
   own term against `member_loan_max_term_months` on **the borrower's own
   frozen version**, and returns `member_term_above_maximum` otherwise.

3. **`max` rather than the version in force.** When no version is in force —
   a fresh database carries version 1.0 as an unapproved draft — there is no
   figure at all, and a product that could not be configured until a version
   was approved would make the first deployment impossible.

**Consequences.** The two ceilings are enforced in two places and mean two
different things, so both are stated wherever either is read: the product
screen explains that a member loan's term comes from the programme, and the
application form says the maximum "which the membership programme sets" rather
than attributing it to the business settings.

A reader auditing `business_settings.max_loan_term_months` will find one
product that exceeds it. `loan_products_within_business_rules` carries the
reason in its own comment, and `tests/db/loan-products.test.ts` asserts both
arms — that an ordinary product is held to three months and a member product
is held to five — so the exemption cannot be widened by accident.

---

## ADR-061 — The payee is frozen at assessment and read back at payment

**Status.** Accepted, Polytos Phase 4.

**Context.** A member bereavement benefit of UGX 200,000 is payable to the
member's registered next of kin. Three facts about that sentence make it the
most dangerous payment in the system: the member is dead and cannot confirm
anything, the recipient is a third party the business may never have met, and
the amount is fixed so nobody will query it.

The obvious implementation passes the payee to the posting function, from the
form the payer is looking at. The beneficiary record is right there; reading
it at payment time is one join.

**Decision.** `benefit_assessment_snapshots` copies the beneficiary's id,
number, name, telephone number, relationship and verification moment at
assessment. `post_benefit_payment(claim, method, reference, key)` takes **no
recipient parameter** and reads it from that snapshot — not from the claim,
and not from `member_beneficiaries`. `payBenefitSchema` has no field for one,
and a unit test asserts the absence.

**Why.**

1. **A payee supplied by the payer can be anybody.** The approver signed for a
   person; a payment that re-read the live record, or accepted a name, would
   be made to whatever that record said at the moment the money moved. §11 of
   the Phase 4 brief names this as the fraud to close, and the only way to
   close it is for the authorisation to carry its own copy of what was
   authorised.

2. **Re-reading the live record is not safe even without malice.** A
   beneficiary record legitimately changes: a member remarries, a child comes
   of age, a telephone number moves. Each of those is a new record superseding
   the old one, correctly. A payment authorised against the old record and
   paid against the new one is a wrong payment nobody intended.

3. **It makes the question answerable later.** "Who did we pay, and why them"
   is asked years afterwards, and the snapshot answers it from the row the
   decision was taken on rather than from a reconstruction.

**Consequences.** A beneficiary record cannot be changed while a bereavement
claim on that membership is live — `member_beneficiaries_guard` refuses it —
because the thing the approver is deciding on must not move under the
decision. A superseded record keeps its details **and its verification**, so a
payment made against it stays explicable; there is no "only the active record
is verified" invariant, and an earlier draft of this phase had one until it
made the supersession path impossible.

The snapshot also carries the payee's name, which makes the snapshot table
sensitive: its select policy needs `membership:view_sensitive` for a
bereavement row, so a Secretary/Treasurer who may run the claim register
cannot read the assessment behind a bereavement claim. That is correct — an
assessment snapshot is an officer's working record — and it is why the
benefits payment register also withholds a beneficiary-payee row from a reader
without that capability, rather than showing a name they should not have seen.

---

## ADR-062 — Three readings of "longer than one day", and a refusal rather than a choice

**Status.** Accepted, Polytos Phase 4.

**Context.** The medical benefit requires a hospital admission "longer than
one day". The documents do not say what is being counted, and for a stay of
about a day three readings disagree:

| Monday 22:00 → Tuesday 09:00 | |
| --- | --- |
| nights slept | 1 |
| days on a ward chart | 2 |
| whole days elapsed by the clock | 0 |

Every one of those is what somebody means by "a day" in some context. A ward
chart says two; a lawyer reading "longer than one day" says the clock; the
member says they spent a night in hospital.

**Decision.** All three are computed at submission and stored on the claim.
The assessment requires **every** reading to exceed the threshold, refuses
with `admission_too_short` when none does, and **holds** the claim with
`admission_measure_undecided` when they disagree.

**Why.**

1. **Picking one decides the rule silently, in a direction that has a price.**
   The night count is the most generous of the three on a short stay and the
   least generous on a long one. Choosing it would move money on every
   borderline claim, under a rule the business never approved.

2. **Requiring all three is the only reading that is safe in both
   directions.** A stay that clears every reading qualifies under any
   interpretation the client might choose, so paying it cannot be wrong. A
   stay that clears none fails under all of them, so refusing it cannot be
   wrong. Only the middle needs a decision, and that is exactly the set that
   is held.

3. **It is the shape Phase 3 already used.** Four interest basis/method
   combinations: three implemented, the fourth raising because it does not
   describe a calculation. Implement every arm, refuse the one that is not an
   answer, default nothing.

**Consequences.** The three readings are **stored** rather than recomputed, so
a change in how the code counts can never alter what was assessed — and the
assessment snapshot carries them again, with a CHECK constraint that they
cleared the threshold the snapshot records.

The screens show all three, on the form and on the claim, because the person
entering the claim is the only one who can still go back to the hospital and
ask for exact times. A claim whose readings disagree is far better learned at
the counter than in a week.

It also means the benefit has a fifth undecided rule that nobody listed: not
the cap, the count, the period or the year basis, but *what a day is*. It is
recorded in `docs/POLYTOS-MEMBERSHIP-POLICY-DECISIONS.md` with the other
consequences, and the refusal names it.

---

## ADR-063 — A beneficiary's name lives in its own table, because policies are row-level

**Status.** Accepted, Polytos Phase 4.

**Context.** `member_beneficiaries` records who a member's bereavement benefit
is payable to. Most of that record — the relationship, whether it is the
primary, when it was registered, whether anybody has verified it — is what a
Secretary/Treasurer needs to work the register. The name and the telephone
numbers are different: they are the business's **payment instruction**, and
they identify a third party who has consented to nothing.

The capability that guards sensitive membership detail is
`membership:view_sensitive`, held by a Manager and an Owner. So the
requirement is: one table, two sensitivities.

**Decision.** Two tables. `member_beneficiaries` holds everything a register
needs, and `member_beneficiary_identities` holds the name, both telephone
numbers, the village, the district and the identity document, behind a policy
requiring `membership:view_sensitive` or the member's own identity.

**Why.**

1. **Row Level Security is row-level.** There is no `GRANT SELECT (column)`
   that interacts with a policy, and a policy cannot withhold a column from a
   row it permits. Column privileges exist, but they are granted per role
   rather than per predicate — and the predicate here is "this membership's
   own record, or a caller holding a capability".

2. **The application cannot be the boundary.** A view that omitted the columns
   would be bypassed by anybody reading the table directly over PostgREST,
   which is exactly the audience the policies exist for.

3. **Phase 1 already made this choice once.** `client_identities` holds the
   National Identification Number for the same reason, and a reader who has
   met that pattern will recognise this one. A second mechanism for the same
   problem would be two things to get right.

**Consequences.** `UPDATE` and `DELETE` on the identities table are refused
outright by a trigger: a payment instruction is superseded, never edited. A
change is a new beneficiary record with a new identity row, and the old one
keeps its own.

The duplicate-record rule had to move. "The same person registered twice"
cannot be a unique index on a name the table no longer holds, so
`member_beneficiaries` carries `identity_digest` — a SHA-256 of the
normalised name and telephone number, computed by the registration function —
and the partial unique index is over that. The digest is one-way, so it
enforces the rule without reintroducing the data it was built to withhold.

The data module reflects the split rather than hiding it: `listBeneficiaries`
returns no name at all, and `getBeneficiaryIdentity` is a second read that
returns `null` for a caller without the capability. One component renders "a
verified spouse, registered on 4 October" for a counter and the name for a
supervisor, and neither case is a branch in the data layer.

---

## ADR-064 — A capability check is a statement about a session, so it sits inside the trusted-path exemption

**Status.** Accepted, Polytos Phase 4.

**Context.** Three Phase 4 functions aggregate across members and therefore
have to run as the owner: `medical_benefit_consumed`, `benefit_summary` and
`benefit_expense_by_type`. A `SECURITY DEFINER` function has no policies
applied to it, so each names its capability explicitly — the shape ADR-057
established for a function that reports the business rather than a row.

Each was first written as:

```sql
if not public.user_has_permission('benefits:view') then
  raise exception 'permission denied for benefit summary' using errcode = '42501';
end if;
```

Every test passed, because every test ran as a signed-in user.

**Context that was missed.** `auth.uid()` is NULL for a migration, for
`service_role` and for the test harness — none of which hold a capability to
check. `user_has_permission` therefore returns false for all of them, and the
gate refused the trusted path. A maintenance read of `benefit_claim_
eligibility` could not run at all, and the demonstration seeder's own
reconciliation step hit it.

**Decision.** A capability check in a definer function is written as

```sql
if auth.uid() is not null
   and not public.user_has_permission('benefits:view') then
```

which is what `savings_summary` has done since Phase 2.

**Why.** The distinction is between two kinds of rule, and this project
already states it: **rules binding every caller go above the trusted-path
exemption, and rules about a session go inside it.** "A snapshot cannot
contradict the policy it claims to follow" binds `service_role` too, and sits
above. "Does this person hold `benefits:view`" is meaningless without a
person, and sits inside.

Writing it the other way does not make anything safer. `service_role` can read
every one of those tables directly; a gate that refuses it merely makes the
definer function less useful than the privilege the caller already has.

**Consequences.** Three functions changed, and the Phase 2 precedent is now
cited in each of their comments so the next one is written correctly the first
time. The defect was found by the demonstration seeder rather than by a test,
which is itself worth recording: the seeder runs on the trusted path and the
suites do not, so it exercises a caller nothing else does.

---

## ADR-065 — The tenth undecided rule is frozen like the other nine

**Status.** Accepted, Polytos Phase 4.

**Context.** `membership_policy_versions_guard` freezes every contractual
column the moment a version is approved or anybody is enrolled under it,
including the nine columns holding the client's undecided questions. The
reason it gives is that a member enrolled while a question was open did not
agree to the answer somebody writes into it afterwards.

Phase 4 added a tenth such column, `medical_benefit_year_basis`, and did not
add it to that list.

**Decision.** `membership_policy_year_basis_guard`, a separate `BEFORE UPDATE`
trigger on the same table, refuses a change to that column once the version is
approved or anybody is enrolled under it.

**Why a separate trigger rather than the existing function.** Replacing
`membership_policy_versions_guard` from a Phase 4 migration means copying its
140 lines into that migration, where the copy becomes the definition. The next
person to change the rule changes the Phase 1 file, the two disagree, and
which one wins depends on migration order. The rule this adds **composes**
with the existing one rather than qualifying it, so it is stated once, in the
migration that introduces the column it is about.

**Why it is frozen at all**, when the column is deliberately *not* part of
`is_benefits_enabled`: the two questions are different. The gate asks "does
this version open benefits", and the year basis bears on one benefit rather
than on the activity — so it stays off the gate for the reason ADR-059 kept
the monthly anchor off the lending gate. The freeze asks "may a term the
member is held to be changed underneath them", and the answer does not depend
on how many benefits the term touches. A cap measured over the calendar year
and one measured over the enrolment anniversary give a member admitted in
December either one year's ceiling or two, which is as material as any of the
nine.

**Consequences.** Deciding the benefit year means publishing a new policy
version and re-accepting it, exactly as deciding the cap does. The
demonstration seeder and the browser harness therefore publish their own
versions rather than answering the question on one already in force — which
they had to do anyway, because only one version may be in force and a savings
account is frozen to the version it was opened under.

---

## ADR-066 — A document existing is not a fact established

**Status.** Accepted, Polytos Phase 4.

**Context.** A medical claim needs "evidence verification and approval", in the
client's words. The documents do not say what the evidence is or who checks
it, and the obvious implementation is a documents table with a required-kinds
list: a claim with an admission record and an invoice attached is a claim with
its evidence.

**Decision.** Every attached document arrives `unchecked`.
`assess_benefit_claim` counts only documents whose `verification_status` is
`verified`, and `verify_benefit_document` refuses a check from whoever
attached the document.

**Why.**

1. **Counting uploads measures diligence nobody performed.** A claim can be
   fully documented and entirely unexamined, and that is the state an
   evidence workflow most often degrades into: the required-kinds list becomes
   a checklist somebody satisfies by attaching files. §12 of the Phase 4 brief
   names it, and it is the commonest way this kind of feature becomes
   decorative.

2. **Two hands, as everywhere else in this system.** The person who brings a
   document in is not the person who attests to it, for the same reason the
   person who prepares a withdrawal is not the person who decides it.

3. **The object has to exist.** `attach_benefit_document` refuses a path
   naming a file nobody uploaded, because a metadata row pointing at nothing
   is the purest form of the same failure: the claim looks documented and there
   is nothing to look at. The path is checked against the bucket, and against
   the membership and claim its own path segments name.

**Consequences.** Verification is only possible while the claim is under
verification — a conclusion about evidence on a claim nobody is working on is
not a conclusion — so the application attaches documents while the claim is a
draft and checks them after it is picked up. The two acts are separated by two
states as well as by two people.

Refusing a document requires a reason and accepting one does not. The
asymmetry is deliberate: "I looked at this and it is what it says it is" needs
no essay, while "I am not accepting this" has to reach whoever will have to
produce a replacement, and a refusal with no reason is a dead end for the
member.

The one `DELETE` grant in the phase is a document nobody has checked, on a
claim nobody has decided. A mis-attached file on a draft is something people
need to undo; evidence an officer acted on is part of the record.

---

## ADR-067 — A meeting's status comes from its register

**Status.** Accepted, Polytos Phase 4.

**Context.** A meeting is scheduled, and then it happens. The straightforward
implementation gives somebody a control: a "mark as held" button, or a status
field on the editing form.

**Decision.** There is no such control. `mark_meeting_attendance` moves a
meeting from `scheduled` to `held` when the first member is marked present,
and `cancel_membership_meeting` refuses a meeting that has any attendance at
all — checking the register **before** it checks the status, so the refusal
reads "people attended, so it happened" rather than "it is already held".

**Why.**

1. **Two statements about one afternoon will disagree.** A meeting with a
   register and a `scheduled` status is a contradiction somebody has to
   notice and reconcile, and the reconciliation will not happen: whoever
   marked the register has moved on, and the dashboard counting "meetings
   held" is already wrong.

2. **The register is the evidence.** What makes a meeting a meeting is that
   members came, and the system knows that. Asking a person to assert it
   separately is asking them to restate something the data already says.

3. **It makes cancellation safe.** A cancelled meeting that people attended
   would be a record saying the afternoon did not happen, over the top of
   five rows saying who was there.

**Consequences.** A meeting nobody attended and nobody cancelled stays
`scheduled` for ever. That is accepted, and it is honest: nothing in the
system knows whether it happened, and inventing a "probably held, nobody
marked it" state would be a guess rendered as a fact. The meetings list shows
it, the register is empty, and somebody can mark it late.

`postponed` exists in the status vocabulary and nothing writes it, because the
client's documents describe no deferral-without-a-date process. It is in the
CHECK constraint so that adding one later does not need a migration to widen
a constraint under live rows, and `meetingMayBeMoved` treats it as
unmovable — which is the safe reading until somebody defines it.

---

## ADR-068 — Attendance is recorded and carries no consequence

**Status.** Accepted, Polytos Phase 4.

**Context.** The membership programme meets monthly, and the system records
who came. The question immediately behind that is what missing a meeting
costs a member, and it is a question the client's documents do not touch:
there is no fine, no warning, no effect on savings, no effect on eligibility
for a loan or a benefit.

Every instinct in a system like this pushes towards supplying one. An
attendance rate is a number, and a number on a screen invites a threshold.

**Decision.** Nothing in the module maps an attendance answer onto a
consequence. No cumulative count of absences, no flag, no eligibility input,
no colour that reads as a failure. `apology` and `represented` are rendered as
information rather than as warnings, and the attendance rate is shown as a
figure with no target beside it.

**Why.**

1. **A consequence is a policy, and this one would be a severe policy.**
   "Missing three meetings affects your standing" is the kind of rule that
   ends with a member refused a benefit they were entitled to, and it would
   have been invented by an interface.

2. **A number with a threshold is a decision even when nobody writes the
   threshold down.** Colouring 56% red tells every reader that 56% is bad. The
   figure is useful; the judgement is not ours.

3. **`apology` exists precisely to avoid implying one.** A member who sent
   word is not in the same position as one who did not, and the register can
   say so without saying what either position costs.

**Consequences.** `tests/unit/meetings.test.ts` asserts the absence — that no
label in the module contains the words penalty, fine, suspend, warning or
strike, and that nothing exported maps an answer to a score — so adding a
consequence has to change a test that says there isn't one. The browser suite
asserts the same thing on the rendered page.

"Is there a monthly meeting attendance obligation, and does missing one affect
standing?" is on the open-questions list in
`docs/POLYTOS-MEMBERSHIP-POLICY-DECISIONS.md`. When it is answered, the place
to implement it is a new function reading `meeting_attendance`, not a column
on the attendance row — because the answer will be about a period, not about
one meeting.

---

## ADR-069 — An unanswered form field is the empty string, and the schema says so

**Status.** Accepted, Polytos Phase 4.

**Context.** `formData.get('alternativePhone')` returns `''` when somebody
leaves that box alone. It returns `null` only when the field is absent from
the form altogether. A Zod field written `ugandanPhoneSchema.nullable()
.optional()` therefore describes a shape no browser ever submits, and the
form it validates fails with **"Phone number is required"** against a field
whose own label says *(optional)*.

Phase 4 shipped exactly that, twice on one form — the alternative number and
the identity document — and the thirty-one validation tests over that schema
all passed, because every one of them handed it a parsed object. The browser
suite in CI was the only thing that saw it.

Earlier phases had met the same problem and solved it in place:
`z.union([schema, z.literal('')])` followed by a transform appears inline a
dozen times across `lib/validation/`. It was never named, so Phase 4 wrote
twelve more optional fields without it.

**Decision.** Every optional field whose value can come from a form control is
declared with `optionalField(schema)` from `lib/validation/common.ts`. It
accepts the schema or the empty string, and reads the empty string as `null`.
A field that cannot be blank stays required, with the message a person can act
on.

**Why.**

1. **The schema should describe what crosses the boundary.** The boundary here
   is an HTML form, and an HTML form says "unanswered" with `''`. A schema
   that only accepts `null` is documenting a caller that does not exist.

2. **Normalising in the action instead would hide the rule.** A helper that
   blanked out empty strings before parsing would make every optional field
   work and no schema say which fields are optional — and the next action
   written without it would fail the same way.

3. **It is not a relaxation.** `optionalField(z.enum(...))` still refuses
   `library_card`; `optionalField(businessDateSchema)` still refuses
   `31/12/2026`. Blank is the only new input, and blank is what the form
   sends.

**Consequences.** `tests/unit/benefit-validation.test.ts` and
`tests/unit/meeting-validation.test.ts` each carry a `what a browser actually
sends` block that parses the blank string field by field, and asserts the
rules that must survive it: a document refusal still needs a note, a member
marked present still may not carry a reason for being away, both halves of a
document attachment still may not be empty at once.

The twelve inline unions in earlier phases were left alone. They are correct;
rewriting working validation in a phase about benefits would be a change
nobody asked for and a diff nobody could review against its brief.

---

## ADR-070 — Every column this application asks PostgREST for is checked against the schema

**Status.** Accepted, Polytos Phase 4.

**Context.** `listExpectedMembers` asked `membership_register` for
`membership_id`. That view's key column is `id` — it is a view *of*
memberships — so PostgREST answered 400, the data function threw, and
`/meetings/[meetingId]` returned 500 for every meeting in the system.

What makes it worth an ADR is that no existing check could have caught it:

- **TypeScript cannot.** A PostgREST select list is a string, and the row
  type is asserted after the call. The compiler is being told the answer.
- **The database suites cannot.** They connect to PostgreSQL directly and
  never name a column list the way PostgREST parses one.
- **The unit suites cannot.** They have no database.
- **The integration suites cannot.** They render components against mocked
  data layers, which is the point of them.

So the only check was a browser opening that screen, and the whole class was
unguarded: a renamed column, a view that stops exposing one, a typo in a
forty-column select list. Each is a 500 on one screen, found by whoever opens
it.

**Decision.** `tests/db/postgrest-columns.test.ts` reads every
`.from('x').select('…')` in the ten `lib/` directories that talk to PostgREST
and checks each column against `information_schema.columns`. It runs in the
`db` project, because it needs a real schema; it needs no seed data and no
roles.

**Why these limits.**

1. **Select lists only.** Filter arguments — `.eq('branch_id', …)` — are not
   checked. A query chain is often built across several statements, so a
   parser following one would be guessing, and a test that fails for a reason
   that is not a defect is worse than no test at all.

2. **Embedded resources are flattened out.** `guarantors(full_name, phone)`
   names columns on the joined relation, not on this one. Splitting the list
   on commas first would hand `phone` to the outer table and fail against
   four correct queries, which it did on the first run.

3. **A floor on the count.** The test asserts it found more than 200
   references before checking any of them. A refactor that moved these reads
   somewhere the parser does not look would otherwise leave it green while
   checking nothing.

**Consequences.** The check is cheap — one `information_schema` query and a
regex over 34 files, under a second — and it is the only thing in the suite
that tests the *shape* of a PostgREST request rather than its result. A
migration that renames a column now fails in the database job rather than on
a screen.

It does not replace the browser suite. It would not have caught either of
the other two defects in the same CI run — a function passed to a Client
Component, and a schema that refuses a blank optional field — because neither
is a column.
