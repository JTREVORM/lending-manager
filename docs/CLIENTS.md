# Clients and guarantors

Phase 3. Everything here is implemented and tested; nothing below describes a
later phase as done.

## Why `clients` is not `profiles`

`profiles` answers *who may sign in, and what may they do*. `clients` answers
*who are we lending to*. They are kept apart because most clients of a Ugandan
lending business will never sign in to anything, a staff member is not a
client, and `profiles` would otherwise have to grow a `blacklisted` status —
which has no meaning for a login.

The link is optional and indirect:

```
clients.profile_id  →  profiles.id  →  auth.users.id
   (nullable)            (nullable)
```

One identity system, reached through one column. A client registered at the
counter has `profile_id = NULL`, which is the normal case.

## The client record

| Column | Notes |
| --- | --- |
| `client_number` | `CL26001`. Minted by the database; immutable. |
| `profile_id` | Optional portal login. Unique, so one login cannot serve two clients. |
| `full_name`, `sex`, `date_of_birth` | Identity, as written on the client's card. At least 18. |
| `phone`, `alternative_phone` | E.164 (`+256` plus nine digits). Not unique — see duplicates, below. |
| `occupation`, `business_type` | What they do. `business_type` optional. |
| `village_area`, `district` | Free text, because the business works from what the client says. |
| `photo_path` | Private storage. Shape constrained by `CHECK`. |
| `status`, `status_reason`, `status_changed_at`, `status_changed_by` | Attribution is stamped by the database, never supplied. |
| `notes` | Free-text note on the record itself. Attributed commentary belongs in remarks. |
| `registered_at`, `created_by`, `created_at`, `updated_at`, `archived_at` | Provenance. `created_by` is derived from the session. |

### The sensitive half

The National Identification Number and the identity document live in
**`client_identities`**, keyed on `client_id`, behind their own policy
requiring `clients:view_nin`.

That is not tidiness. PostgreSQL cannot express *this role may read these
columns of the rows it can see* — column privileges are granted to database
roles, and every signed-in user of this application is the same role,
`authenticated`. A NIN column on `clients` could therefore only have been
protected by not selecting it in the interface, which is not protection,
because a token can query PostgREST directly.

The practical consequence is the one that matters: a Secretary/Treasurer, who
legitimately reads the client directory all day, **cannot read a single NIN by
any route** — not through a list, a search, or an export — because the number
is not in the table they can read.

`guarantor_identities` does the same for guarantors.

## Client numbers

`CL` + two-digit registration year + a three-digit sequence: `CL26001`.

Minted by a BEFORE INSERT trigger calling the Phase 1 generator
`next_reference('client')`, which is an atomic upsert against
`reference_sequences` under a row lock. Two consequences:

* a caller **cannot supply** a number — the trigger raises if one is present,
  rather than silently replacing it, so a caller that believes it is choosing
  the number finds out;
* there is no window in which a client row exists without a number.

Proven under 40-way concurrency in `tests/db/concurrency-clients.test.ts`: 40
parallel registrations produce 40 distinct, gapless numbers.

The number is immutable thereafter, enforced by a rule that binds every caller
including `service_role`. It appears on paper the business has already handed
to the client.

## Status

| Status | Meaning | Reason required |
| --- | --- | --- |
| `active` | Borrowing normally. The only status Phase 4 will permit a new loan from. | — |
| `inactive` | Not currently borrowing, retained on record. The ordinary resting state. No judgement implied. | — |
| `suspended` | Temporarily restricted while something is resolved: a disputed payment, an unreachable phone. | **Yes** |
| `blacklisted` | The business has deliberately decided not to lend to this person again. | **Yes** |
| `archived` | Retained but out of use. This replaces deletion. | — |

A restriction the business has chosen must say why, enforced by
`clients_restricted_status_has_reason`. Without it a client could be
blacklisted by an accidental form submission and nobody could tell whether it
was deliberate.

Changing a status never erases history: the previous value, the reason, the
actor and the time are all in `audit_log`, which is append-only.

## Permissions

The format is `resource:action` with a single colon, as constrained by
`public.permissions`. Where the Phase 3 brief suggested a nested
`clients:remarks:view`, the capability is named `clients:remarks_view`; the
grant is identical.

| Capability | client | secretary_treasurer | manager | owner_admin |
| --- | :-: | :-: | :-: | :-: |
| `clients:view` | | ● | ● | ● |
| `clients:create` | | | ● | ● |
| `clients:update` | | ● | ● | ● |
| `clients:status` | | | ● | ● |
| `clients:blacklist` | | | | ● |
| `clients:archive` | | | | ● |
| `clients:documents` | | | ● | ● |
| `clients:view_nin` | | | ● | ● |
| `clients:link_auth` | | | | ● |
| `clients:remarks_view` | | ● | ● | ● |
| `clients:remarks_create` | | | ● | ● |
| `guarantors:view` | | ● | ● | ● |
| `guarantors:create` | | | ● | ● |
| `guarantors:update` | | | ● | ● |
| `guarantors:documents` | | | ● | ● |
| `guarantors:view_nin` | | | ● | ● |
| `guarantors:link` | | | ● | ● |

Four of these are narrower than a reading of "the Manager runs lending
operations" would suggest, and each is a commercial decision rather than a
technical one:

* **`clients:blacklist` is Owner-only.** Blacklisting is the business
  permanently refusing to lend to someone — the one status that is a standing
  commercial judgement rather than an operational state, and it should carry an
  Owner's name. Lifting one needs the same capability, enforced by inspecting
  the *old* status.
* **`clients:archive` is Owner-only**, for the same reason: it is the nearest
  thing to deletion the system has.
* **`clients:link_auth` is Owner-only.** It decides who can sign in and see a
  client's data — the same class of act as creating a staff account.
* **`clients:remarks_create` is not the Secretary/Treasurer's.** The brief
  asked for this to be a decision rather than an inheritance. A Secretary
  records payments; a remark that will later weigh on a lending decision should
  carry a Manager's name.

**A borrower holds none of these, including `clients:view`.** They read their
own client record through the identity clause in the policy
(`profile_id = current_profile_id()`), which grants exactly one row.
`clients:view` means "read the directory" everywhere else in the system, so
granting it to a borrower would mean exactly that.

## Row Level Security

The boundary. Everything above it — hidden buttons, guarded Server Actions,
route protection — exists to give people a coherent experience and to fail
early. None of it survives a caller who takes their own token and queries
PostgREST directly.

| Table | anon | client | secretary_treasurer | manager | owner_admin |
| --- | --- | --- | --- | --- | --- |
| `clients` | nothing | own row only (read) | directory, ordinary edits | directory, register, edit, status, documents | all, plus blacklist, archive, link |
| `client_identities` | nothing | **nothing** | **nothing** | read and correct | read and correct |
| `guarantors` | nothing | **nothing** | read | read, register, edit | all |
| `guarantor_identities` | nothing | nothing | **nothing** | read and correct | read and correct |
| `client_guarantors` | nothing | nothing | read | read, attach, detach | all |
| `client_remarks` | nothing | **nothing** | read | read and append | read and append |

Two absences are deliberate and worth stating:

* **A borrower cannot read their own NIN.** They already know it, the portal
  gains nothing by reproducing it, and a page that never displays one cannot
  leak one.
* **A borrower cannot read guarantor records, including their own
  guarantors'.** A guarantor's phone number and photograph are that person's
  data, disclosed to the lender rather than to the borrower who named them.

**No table has a DELETE grant.** Not for any role. That is how the
no-hard-delete policy is enforced rather than merely documented: a client is
archived, a guarantor association is detached, and a remark is withdrawn by
appending a retraction.

### Rules that bind every caller

`clients_guard_privileged_columns` states these **before** the trusted-path
exemption, so they hold for `service_role` and the table owner too — the lesson
of the Phase 2 password-change bypass, where a rule placed after the exemption
was a rule the privileged client could skip:

| Column | Who may change it |
| --- | --- |
| `client_number` | Nobody, once issued. |
| `profile_id` | Only `link_client_profile()`, which announces itself with a transaction-local marker. |
| `status_changed_at` / `status_changed_by` | The database, from the session. A supplied value is rejected. |
| `archived_at` | The database, when the status moves to or from `archived`. |
| `created_by` / `created_at` | Nobody. Provenance is history. |

## Linking a portal login

`public.link_client_profile(client_id, profile_id)` — callable **only by
`service_role`**, so a browser session cannot reach it however the request is
crafted. The Owner's `clients:link_auth` authorises the Server Action; the
function itself is behind the server's secret key.

Every invariant is checked inside, under `pg_advisory_xact_lock`, so two
concurrent links cannot both pass their checks and both commit:

* the client has no login yet;
* the profile exists and is **active**;
* the profile is not already linked to another client.

A unique constraint on `clients.profile_id` is the backstop if a future code
path ever bypasses the function.

Attacked from every angle in `tests/db/client-auth-linkage.test.ts`: a borrower
cannot link themselves, repoint their own record, or unlink to escape a
blacklisting; a Manager cannot call the function; and two parallel links to the
same profile or the same client resolve to exactly one winner.

## Duplicate handling

The two identifiers are treated differently, and the difference is the point.

**NIN uniqueness is a hard rule.** A unique index enforces it, partial so that
the number stays optional — a client registered before their card is present
still gets a record. A NIN identifies exactly one person, so two client records
sharing one is a duplicate or a transcription error, never a legitimate pair.

**Phone numbers are not unique.** Families share a handset, and a wife
borrowing on her own account with her husband's number is an ordinary case, not
a duplicate. Enforcing uniqueness here would turn a real client away at the
counter. The search box makes the collision visible instead: typing the number
shows everyone who has it.

The same applies to guarantors, with one addition: NIN uniqueness is what makes
*"this individual already stands for two other borrowers"* visible rather than
silently duplicated across three records.

## Guarantors

A separate table, with the association in **`client_guarantors`** rather than a
column on `clients`. In practice the same person guarantees several borrowers —
a trader vouches for two relatives and a neighbour. Three copies of that person
would mean three photographs to keep current, three NINs to keep unique, and no
way to see that one person carries three obligations, which is precisely the
exposure a lender wants visible.

The cost is a search-then-link step in the registration flow instead of a
single form, and the flow is built that way: the guarantor directory shows how
many clients each person currently stands for.

`relationship_to_client` lives on the association, not on the guarantor,
because the same person is a brother to one client and a business partner to
another.

Detaching sets `active = false` and stamps the attribution; the database
**refuses to revive** a detached association, so a new one must be made. That
keeps the history legible. One *active* association per pair, enforced by a
partial unique index — so a client and a guarantor may have a past.

### A note for Phase 4

A guarantor's details change: they move, they change trade, they change number.
`client_guarantors` records the **current** association, and nothing in Phase 3
is suitable as loan evidence on its own.

When Phase 4 issues a loan it must **snapshot** the guarantor details it relied
on — name, NIN, phone, relationship — into the loan's own rows, rather than
referencing `guarantors.id` and reading through at display time. Otherwise a
guarantor correcting their phone number in 2027 silently rewrites what the
business will claim it was told in 2026, and the loan file stops being
evidence. The same applies to the client's own identity data.

Phase 3 deliberately provides no snapshot mechanism: there is nothing yet to
snapshot into, and an unused one would rot.

## Remarks

Append-only, enforced twice over: a statement-level BEFORE trigger refuses
UPDATE and DELETE, and the privilege is not granted either. Two independent
mechanisms, because append-only is the entire value of the table — a remark
that could be quietly reworded afterwards is worth nothing as evidence of what
was known when.

The author is derived from the session by a trigger, never accepted from the
payload. `created_by_label` denormalises the name so the remark stays readable
after the account is archived.

A mistake is corrected by **withdrawing** the remark, which appends a
retraction naming what it withdraws. The original stays exactly as written; the
interface shows it struck through with the withdrawal beneath. Hiding a
withdrawn remark would make the history look like it never happened.

Categories are closed and short — `general`, `payment_concern`, `contact`,
`business`, `retraction` — because a free-text category becomes thirty
spellings of "late payment" and stops being groupable. `retraction` is not
offered in the compose form.

## Search

| Field | How | Index |
| --- | --- | --- |
| Client number | substring, case-insensitive | `clients_client_number` (unique) |
| Name | substring, case-insensitive | `clients_full_name_trgm_idx` (GIN, pg_trgm) |
| Phone | substring | `clients_phone_idx`, `clients_alternative_phone_idx` |
| NIN | **prefix only**, and only with `clients:view_nin` | `client_identities_nin_unique` |

A trigram index is used for names because a btree cannot serve
`ilike '%nakato%'`, and substring matching on a name is what staff actually
need.

**NIN is matched as a prefix, not a substring, and only for callers who may
read one.** Substring matching on an identity number turns the search box into
an oracle: enter three characters and the result set tells you which clients
hold a number containing them. Searching a column implies being able to confirm
its contents.

Search terms are escaped before reaching PostgREST's filter syntax: `%`, `_`
and `,` are metacharacters there, and an unescaped term lets a caller alter the
shape of the query — not a SQL injection, since values are still parameters,
but a filter injection, and the fix is the same.

The list screen pages twenty at a time, fetching twenty-one rows to learn
whether there is a next page rather than issuing a `count` on every keystroke.
Archived clients are excluded from the default view and shown when selected
explicitly.

## Storage

| Bucket | Contents | Public |
| --- | --- | --- |
| `client-documents` | client photographs and identity documents | **no** |
| `guarantor-documents` | guarantor photographs | **no** |
| `company-assets` | logo and branding | **no** |

Paths are the authorization model, because an object is reached by a path
rather than by a query:

```
clients/<client uuid>/photo/<generated>.jpg
clients/<client uuid>/id/<generated>.pdf
guarantors/<guarantor uuid>/photo/<generated>.jpg
```

Reading an object requires visibility of the client or guarantor whose folder
it sits in — and the `exists` sub-select in the policy is itself subject to RLS
on `public.clients`, so that test is the policy already written there rather
than a second, divergent copy. Guessing a path gains nothing: the guess still
has to name a client the caller may read, and if they may read that client they
could have found the path legitimately.

The `id/` folder is gated on `clients:view_nin` rather than `clients:view`. A
scan of a national ID is the same evidence as the number printed on it.

| Rule | Value |
| --- | --- |
| Size limit | 5 MB in the application, 10 MB at the bucket |
| Photograph types | JPEG, PNG, WebP, HEIC |
| Document types | the above, plus PDF |
| **SVG** | **excluded** |
| Filename | generated server-side: 16 random bytes plus an extension from the validated type |
| Access | signed URLs, 60 seconds |
| Deletion | no DELETE policy for any role |

**SVG is excluded deliberately.** It is a document that can contain script, so
a stored SVG served from this origin would be a cross-site-scripting vector
dressed as a picture. Nobody photographs a client with a vector camera.

**The filename is never the browser's.** An uploaded name can contain `../`, a
null byte, a right-to-left override that disguises `.exe` as `.gpj`, or simply
be four kilobytes long. It also often contains the subject's name, which would
put a client's identity into a path that appears in logs. So it is discarded
entirely and a name generated.

**The type is checked by content, not extension.** An extension is a claim; the
first bytes are evidence. A `.jpg` beginning `MZ` is a Windows executable. Only
the first sixteen bytes are read — enough for every signature, and reading a
whole file to check four bytes would be a way to exhaust the server with a
large upload. A type with no signature on record is refused rather than waved
through.

**Replacement never destroys.** The new file is uploaded first, to a new random
path; the database is repointed only after that succeeds. So a failed upload
leaves the record pointing at the previous file, which still exists — there is
no moment at which the database names a file that is not there. The old object
stays: there is no DELETE policy, because a bug that deleted the only scan of a
client's national ID would be unrecoverable. Replaced files therefore
accumulate, which is a storage cost paid in exchange for not being able to lose
evidence.

## Audit

Triggers, not application calls — a trigger fires in the same transaction as
the change, so the data and the trail cannot disagree, and an audit call in a
Server Action is skipped by anything that reaches the table another way.

| Action | On |
| --- | --- |
| `client.created` | registration |
| `client.updated` | an ordinary edit |
| `client.status_changed` | a status change, with old and new and the reason |
| `client.auth_linked` / `client.auth_unlinked` | portal linkage |
| `client.photo_changed` | a photograph replaced |
| `client.identity_recorded` / `client.identity_updated` | a NIN, **masked** |
| `client.document_changed` | an identity document replaced |
| `client.remark_added` | a remark, by category and length |
| `guarantor.created` / `guarantor.updated` / `guarantor.photo_changed` | |
| `guarantor.identity_recorded` / `guarantor.identity_updated` | **masked** |
| `guarantor.linked` / `guarantor.unlinked` / `guarantor.link_updated` | |

### What is deliberately not recorded

**No National Identification Number appears in any audit row.** `audit_log` is
readable by `audit:view` — a *broader* capability than `clients:view_nin` — so
writing NINs into the trail would quietly undo the separation that
`client_identities` exists to create. An identity change records *that* the
number changed and what it now ends in (`***BCD`), which is enough to
investigate a suspicious correction without the trail becoming a copy of the
numbers.

**No remark body.** It is already in an append-only table that cannot be edited
or deleted, so duplicating it would add a second copy to keep consistent and
would put staff commentary in front of `audit:view` holders who were given that
capability for a different purpose. The category and the length are recorded.

**Storage paths are recorded**, because a path is not content: it is the only
way to tell which file a change replaced, and the object stays behind a private
bucket policy.

## The client portal

A borrower whose login is linked sees their own name, client number, phone,
occupation, location, photograph and status.

Not shown, and each absence is deliberate: no loan balance, repayment history,
expiry date or penalties — those are later phases, and the page says so rather
than rendering a zero a borrower might read as *I owe nothing*. No NIN. No
remarks: those are the notes staff write *about* them.

A signed-in borrower with no linked client record is a normal state — staff
created the login before attaching it — and the page handles it without an
error.

## Test commands

```bash
npm test                 # everything
npm run test:unit        # pure logic, no database
npm run test:integration # components, jsdom
npm run test:db          # against a real PostgreSQL, rebuilt first

npm run typecheck
npm run lint
npm run format:check
npm run build

./scripts/pg-local.sh setup    # throwaway cluster, all migrations applied
./scripts/pg-local.sh migrate  # rebuild it from zero
```

The database suite needs `DATABASE_URL`. `scripts/pg-local.sh url` prints one.
