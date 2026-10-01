# Authentication and authorization

## Signing in

**By phone number and password.** Phase 1 made `profiles.phone` the unique
business identifier, because many borrowers have no email address at all.

Supabase Auth authenticates against an email, so something has to bridge the
two. The bridge is a **deterministic derivation**: `+256772123456` becomes
`256772123456@phone.lending.invalid`. See ADR-013 for why this was chosen over
looking the phone number up.

`.invalid` is reserved by RFC 2606 and can never be resolved or routed. These
addresses are identifiers, not mailboxes. `profiles.email` remains contact
information and is never an authentication identity.

Two things follow:

- Sign-in needs **no database read before authenticating**, so there is no
  account-enumeration oracle and no secret key on the login path.
- Supabase can never email anything, so **password recovery is
  administrator-assisted**. That suits a business with no email infrastructure.

## What happens on a successful sign-in

1. Supabase Auth verifies the password and establishes a session.
2. The application resolves the profile — through Row Level Security, so only
   an **active** profile resolves at all.
3. It resolves the role assignments.
4. If any step fails, **the session is destroyed before returning**. Nobody is
   left authenticated but unauthorised.
5. The user is routed to where they belong.

| Condition | Outcome |
| --- | --- |
| Password wrong, or no such number | `Those login details are not correct.` |
| Account suspended, inactive or archived | Session destroyed; told to contact their administrator |
| Profile not linked to a login | Same message — the two are indistinguishable by design |
| No role assigned | Session destroyed; told their account has no role yet |
| Temporary password still in force | Sent to the change-password screen, and nowhere else |
| Staff | Dashboard |
| Borrower | Client portal |

## Account enumeration

Every failed sign-in returns one sentence, whatever went wrong — including a
malformed phone number, which is reported identically rather than as "that is
not a valid number".

Distinguishing them would let anyone with the login page discover which phone
numbers belong to the business's staff and clients. That list is worth having
if you intend to target them, and it reveals by elimination who banks here.

The cost is a less helpful message for somebody who mistyped. For a lender,
that is the right trade.

Administrative screens do show which accounts exist — to administrators, who
are entitled to know.

## Sessions

Supabase Auth issues the session; the application never mints one.

- The **proxy** refreshes the token on every request and applies the
  `Cache-Control` headers Supabase supplies, so no intermediary can cache a
  response carrying a `Set-Cookie` and serve it to somebody else.
- Session validity is established with `getClaims()`, which verifies the
  signature every time. `getSession()` is never trusted server-side: a cookie
  is attacker-controlled input.
- Nothing security-relevant is kept in `localStorage`.
- Signing out posts to a Server Action, never a GET — a link that ends a
  session can be triggered by any page that embeds it as an image.

## Disabling an account takes effect immediately

This is the one behaviour worth understanding in detail, because the obvious
implementation gets it wrong.

A JWT stays cryptographically valid until it expires. A system that checks
"does this token verify?" therefore keeps a disabled user working for up to an
hour. This system does not, because **every policy routes through
`public.current_profile_id()`**, which resolves only profiles whose status is
`active`.

So the moment an administrator suspends an account:

| | Effect |
| --- | --- |
| Existing sessions | The token still verifies, and grants nothing. The user's own profile row becomes invisible to them; every table returns zero rows. |
| Database access | `user_has_permission` returns false for every capability. |
| Direct REST calls | Same — this is enforced at the database, not in the application. |
| Next page load | The route guard finds no active profile and redirects to sign-in with an explanation. |
| Future sign-ins | Refused, and the session is destroyed before returning. |

`tests/db/rls-identity.test.ts` drives this with the same token before and
after, for `suspended`, `inactive` and `archived`.

A deliberate consequence: a suspended user cannot restore themselves, because
their own row is no longer visible to them.

**No `sessions_valid_from` column exists.** It would be an unused security
column pretending to provide protection that `current_profile_id()` already
provides completely.

## Passwords

| | |
| --- | --- |
| Policy | Minimum 10 characters, maximum 72. Supabase's own project policy also applies and is the authority. |
| Why length only | Mandated character classes push people towards `Password1!` and towards writing passwords down — the realistic failure mode for staff sharing a counter. Length is what resists guessing. |
| Storage | Supabase Auth only. No hash, no password and no token is stored in `public`, which a database test asserts. |
| Changing your own | Requires the current password, verified by re-authenticating. Without that, anyone reaching an unlocked browser could take the account over permanently. |
| Reset | An Owner/Administrator sets a temporary password and the account must change it at next sign-in. |
| Delivery | **In person, or on a call the administrator initiated.** There is no email or SMS. The password is shown once and never logged, never stored in plain text, and never placed in audit metadata. |

### The forced password change

When an administrator issues a temporary password, `must_change_password` is
set. While it is set, the route guard sends the user to the change-password
screen and refuses everywhere else — because until it is changed, somebody
other than the account holder knows the password.

The flag cannot be cleared by editing the profile — by anyone, including the
privileged client. The only thing that clears it is
`public.confirm_password_change(auth_user_id)`, and **no session role holds
EXECUTE on it**: not `anon`, not `authenticated`. Only `service_role` can call
it, which exists only behind the server.

That grant is the whole of the defence, and it is deliberate. An earlier design
granted the equivalent function to `authenticated`, which meant a user holding
an administrator-issued temporary password could call it over PostgREST and
clear the requirement while continuing to use the password their administrator
also knew. The interface was never involved, so no amount of care in the
interface could have prevented it.

The database cannot check whether a password actually changed — it has no
visibility into Supabase Auth — so it enforces the strongest thing it can
(*only a trusted server path may clear this at all*) and the ordering is
enforced in `lib/auth/password-change.ts`:

| Step | | Failing here means |
| --- | --- | --- |
| 1 | Validate the new password | Nothing was attempted; Supabase was never called. |
| 2 | Re-authenticate with the current password | The caller does not know it. Nothing changed. |
| 3 | `supabase.auth.updateUser({ password })` | Supabase refused it. The flag is untouched. |
| 4 | `confirm_password_change()` via the privileged client | The password **did** change; the user is told so, and told to contact their administrator. |
| 5 | Record `auth.password_changed` | The change stands. The audit failure is logged, not shown. |

Step 4 is unreachable unless 2 returned true and 3 succeeded. That ordering is
the property under test, and `tests/unit/password-change.test.ts` asserts it
against a recorded call list rather than inferring it from a return value —
including that `confirm` runs exactly once, and never at all when 2 or 3 fail.

`password_set_at` is stamped by the database from its own clock, on insert and
on every transition of the flag. A value supplied by a caller is either
overwritten or rejected, so it cannot be backdated to make a stale password
look fresh.

## Creating the first Owner

```bash
export NEXT_PUBLIC_SUPABASE_URL=...
export NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=...
export SUPABASE_SECRET_KEY=...          # never commit this
npm run bootstrap:owner -- --name "Jane Doe" --phone 0772123456
```

Creating a staff account needs `users:create`, which comes from a role, which
must be granted by somebody who already holds `users:assign_role`. On an empty
database nobody holds anything, so one path has to create authority from
nothing. This is it.

- **Refuses to run twice.** If any active `owner_admin` exists it stops without
  changing anything, so re-running it after a deploy is a no-op.
- **No hard-coded password.** Read from `BOOTSTRAP_OWNER_PASSWORD` or generated
  from a cryptographic source. Printed once, to the operator's terminal.
- **The account must change it immediately.**
- **Needs the secret key**, so it cannot be triggered from a browser.

## Creating staff accounts

Owner/Administrator → Users → Add staff member.

The order is deliberate. The profile and the role are written **as the acting
administrator**, so Row Level Security authorises them and the escalation
guards apply. Only the Supabase Auth user and the link to it use the privileged
client, because provisioning an account for somebody else has no unprivileged
equivalent.

If the authentication step fails, the profile is removed again. That is the one
sanctioned delete in this system: a profile that never acquired a login
represents no person, no history and no money.

## Roles

| Role | Rank | Who |
| --- | --- | --- |
| `client` | 10 | A borrower. Portal only. |
| `secretary_treasurer` | 30 | Front-office staff. |
| `manager` | 50 | Supervises lending operations. |
| `owner_admin` | 70 | Full administration. |

**A profile may hold several roles, and permissions are the union of them all.**
There are no deny rules, so adding a role can only widen access. The rule is
stated once, in `lib/permissions/permissions.ts`, and asserted in
`tests/unit/permissions.test.ts`.

**Rank does not grant permissions.** An Owner outranks a borrower and still
does not hold `portal:view`. Grants are listed by hand, so a new capability is
held by nobody until somebody decides who should have it. Rank is used for
exactly two things: ordering roles in the interface, and the rule that an
administrator may not grant a role outranking their own.

## Capabilities

| Capability | client | secretary | manager | owner |
| --- | :-: | :-: | :-: | :-: |
| `dashboard:view` | | ✓ | ✓ | ✓ |
| `account:view` | ✓ | ✓ | ✓ | ✓ |
| `account:update` | ✓ | ✓ | ✓ | ✓ |
| `portal:view` | ✓ | | | |
| `users:view` | | | ✓ | ✓ |
| `users:create` | | | | ✓ |
| `users:update` | | | | ✓ |
| `users:disable` | | | | ✓ |
| `users:assign_role` | | | | ✓ |
| `users:reset_password` | | | | ✓ |
| `settings:view` | | ✓ | ✓ | ✓ |
| `settings:update` | | | | ✓ |
| `audit:view` | | | | ✓ |

A Manager sees who works here and administers none of them. Concentrating
account administration in one role is the point of having the role.

The matrix exists in two places — `lib/permissions/permissions.ts` and
`public.role_permissions` — because the application needs it to render and Row
Level Security needs it to enforce. `tests/db/permissions.test.ts` asserts they
are identical, so adding a grant in one place without the other fails the
build.

## The three layers

1. **Proxy** — reads the token, redirects an anonymous visitor to sign-in
   before any page code runs. Cheap, and prevents a flash of chrome.
2. **Route guard** — resolves the session from the database per request and
   applies the route's capability. Runs in a Server Component, so a redirect
   happens before any markup is produced.
3. **Row Level Security** — the actual boundary. A caller who ignores the
   application and queries Supabase directly meets only this.

Hiding a menu entry is none of these. The menu and the guard read the same
route map, and `tests/integration/navigation.test.tsx` asserts they agree — the
failure being guarded against is a hidden link whose route stays reachable.

## Row Level Security

| Table | anon | client | secretary | manager | owner |
| --- | --- | --- | --- | --- | --- |
| `profiles` | — | own row | own row | read all | read all, create, update, set status |
| `user_roles` | — | own rows | own rows | read all | read all, grant, revoke |
| `roles` | — | read | read | read | read |
| `permissions` | — | read | read | read | read |
| `role_permissions` | — | read | read | read | read |
| `company_settings` | — | — | read | read | read, update |
| `business_settings` | — | — | read | read | read, update |
| `repayment_frequencies` | — | read active | read active | read active | read active, write |
| `audit_log` | — | — | — | — | read |
| `reference_formats` | — | — | — | — | — |
| `reference_sequences` | — | — | — | — | — |

`anon` holds **no privilege on any table**, revoked independently of RLS so the
two controls do not share a failure mode.

Nobody may write `permissions` or `role_permissions`: a user who could would
grant themselves anything. Nobody may delete a profile or alter an audit record.

### Column-level rules

RLS decides which rows a caller may touch, not which columns. A policy letting
a user fix their own name would equally let them set their own status back to
active after being suspended. `profiles_guard_privileged_columns` closes that:

| Column | Who may change it |
| --- | --- |
| `auth_user_id` | Nobody, through any session path. Re-pointing it would let one profile adopt another person's login. |
| `status` | `users:disable` only. |
| `must_change_password` | Raised by `users:reset_password`. Cleared only by `confirm_password_change()`, which only `service_role` may call — so a browser session cannot clear it by any route. |
| `password_set_at` | The database, from its own clock. Any supplied value is overwritten or rejected. |
| `last_sign_in_at` | `record_sign_in()` only. |

## Preventing privilege escalation

Three rules, enforced by database triggers because each compares the acting
user to the target — something no policy can express.

1. **Nobody edits their own role assignments.** Including an Owner. An
   administrator who could edit their own grants could also remove a constraint
   somebody else placed on them.
2. **Nobody grants a role outranking their own.**
3. **The last active Owner cannot be removed**, by revoking the role or by
   deactivating the account.

Rule 3 breaks under concurrency if written naively: two administrators each
removing one of the last two Owners both see two remaining and both proceed. An
advisory lock serialises the check. `tests/db/concurrency-identity.test.ts`
drives two genuinely committing transactions in parallel and asserts exactly
one succeeds.

`granted_by` is overwritten with the acting profile on insert, so attribution
cannot be forged.

## Audit

Identity changes are recorded by **database triggers**, not by application
code. An action can change data and then fail before auditing it, or simply
forget; a trigger records what actually happened to the row, in the same
transaction. If the change rolls back so does its record, and there is no path
that writes the data and misses the trail — including an administrator using
`psql`.

| Action | Recorded as |
| --- | --- |
| Account created | `user.created` |
| Details changed | `user.updated` |
| Activated / deactivated / suspended | `user.status_changed` |
| Temporary password issued | `user.password_reset` |
| Role granted / revoked | `user.role_granted` / `user.role_revoked` |
| Settings changed | `settings.updated` |
| Signed in / out | `auth.signed_in` / `auth.signed_out` |
| Password changed | `auth.password_changed` |
| Sign-in refused after authenticating | `auth.sign_in_denied` |

Session events are not row changes, so they go through
`public.record_security_event()` — whose action vocabulary is **closed** and
whose actor is derived from the session. An authenticated user can record that
they signed in; they cannot manufacture a `loan.approved` entry, and they
cannot attribute anything to somebody else.

No password, token or secret is placed in audit metadata. The captured columns
are listed explicitly rather than taking the whole row, so a column added later
cannot silently start appearing.

The Phase 1 append-only guarantees are untouched: no `UPDATE`, `DELETE` or
`TRUNCATE` policy, those privileges revoked from every role including
`service_role`, and statement-level triggers that reject the attempt.

## Before production

| | |
| --- | --- |
| **Rate limiting** | Not implemented. Supabase Auth applies its own limits to sign-in, but nothing throttles the user-creation or password-reset actions. Put a rate limiter in front of the application, or add one to the Server Actions, before go-live. |
| **Email** | None, by design. If the business later wants self-service reset, it needs real addresses as auth identities and a mail provider — see ADR-013 for what that changes. |
| **CSP** | Still deferred; see docs/SECURITY.md. |
| **Audit retention** | `ip_address` and `user_agent` are personal data with no retention period set. |
