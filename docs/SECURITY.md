# Security

## Posture

The database is the security boundary. Application checks — `lib/permissions/`,
a disabled button, a guard in a Server Action — are a usability layer, and a
caller holding a valid token can bypass all of them by talking to the Supabase
REST API directly. Row Level Security is what actually decides who sees what,
so every rule expressed in TypeScript must also exist as a policy.

Phase 1 is **default-deny**: RLS enabled on all nine tables, policies on two
non-sensitive lookup tables only, and zero privileges for `anon` anywhere.

## Review performed before declaring Phase 1 complete

| Check | Result |
| --- | --- |
| Secrets in the repository | None. Only `.env.example`, which holds variable names. |
| Secret key in the client bundle | Scanned `.next/static/` for `sb_secret_`, `SUPABASE_SECRET_KEY`, `DATABASE_URL`. Clean. |
| Secret key in rendered HTML | Clean. |
| `NEXT_PUBLIC_` prefix on a secret | Rejected by `lib/env.public.ts`, and `npm run check:env` scans every public variable for an `sb_secret_` value. |
| Public storage buckets | All three private. |
| Overly broad policies | One `USING (true)`, on `roles` — four role keys and their labels. Asserted by test. |
| RLS enabled everywhere | Asserted against the catalogue. |
| SQL injection | No string-interpolated SQL. Supabase query builder in the app; parameterised queries in tests. |
| Input validation | Zod at the boundary, `CHECK`/`UNIQUE`/`NOT NULL` in the database. Neither relied on alone. |
| Sensitive data in logs | Redaction by key name and value shape, unit-tested. `console` forbidden by ESLint. |
| Hard-coded credentials | None. |
| `search_path` on functions | All eight pin `search_path = ''`. Asserted against the catalogue. |
| `EXECUTE` on privileged functions | Revoked from `PUBLIC`, `anon` and `authenticated`. Asserted per function. |
| Authentication bypasses | No authentication exists yet; nothing claims to protect a route. |
| Security headers | `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy`, `Permissions-Policy`, no `X-Powered-By`. Verified against a running server. |

## Issue found and fixed during review

**Privileged functions were callable by anonymous visitors.**

The migrations revoked `EXECUTE` from `PUBLIC`, which is the usual advice and
is what PostgreSQL's default grant requires. It was not enough. Supabase
*additionally* grants `EXECUTE` to `anon`, `authenticated` and `service_role`
through `ALTER DEFAULT PRIVILEGES`, and an explicit grant is not removed by a
revoke from `PUBLIC`.

The consequence: `next_reference()` and `record_audit_event()` were executable
by `anon`, and the four session helpers were executable by `anon` as well as
`authenticated`. An anonymous caller could have inflated the reference counters
or written rows into the audit trail.

Found by `tests/db/security.test.ts`, which asserts the grant per role rather
than trusting that the revoke worked. Fixed by naming each role explicitly in
the `REVOKE`, then granting back to `authenticated` only where intended. The
test now covers every privileged function, so a future function cannot
reintroduce it.

This is recorded because it is the kind of mistake that reads as correct: the
SQL said `revoke all … from public`, the comment above it said "revoked from
everyone", and only a query against the catalogue showed otherwise.

## Function hardening

Every function sets `search_path = ''` and schema-qualifies everything it
touches, including built-ins (`pg_catalog.now()`). Without that, a caller can
prepend a schema they control to their `search_path` and have a
`SECURITY DEFINER` function resolve `profiles` to their own table.

Note that `COALESCE` and `NULLIF` are SQL constructs, not functions, and cannot
be schema-qualified — an earlier draft tried, and the function failed at
runtime.

The four session helpers are `SECURITY DEFINER` only to escape RLS recursion
(a policy on `user_roles` that queried `user_roles` would not terminate). Each
is scoped to the calling user through `auth.uid()`, so none can read another
person's data.

`current_profile_id()` resolves only **active** profiles. A suspended or
archived account therefore has no identity for authorization purposes even
while its auth session is still technically valid.

## Audit trail integrity

Three independent controls: statement-level triggers rejecting `UPDATE`,
`DELETE` and `TRUNCATE`; those privileges revoked from every role including
`service_role`; and RLS with no policies.

A database superuser can still disable a trigger. No in-database design
prevents that, and claiming otherwise would be dishonest. What this does
prevent is every route available to the application, to a compromised
publishable or secret key, and to a mistaken `DELETE FROM`.

Stronger tamper-evidence — shipping records off-site, or hash-chaining each row
to its predecessor — is a Phase 2+ consideration, and worth taking if the
business needs the trail to stand up to an insider with database access.

## Session handling

`proxy.ts` refreshes the Supabase session on every matched request and applies
the `Cache-Control`, `Expires` and `Pragma` headers that `@supabase/ssr`
supplies alongside refreshed cookies. Without those, a CDN or ISR layer can
cache a response carrying a `Set-Cookie` and serve it to a different visitor,
who would then be signed in as somebody else.

`app/(app)/layout.tsx` is `force-dynamic`, so nothing in the authenticated area
is prerendered or shared-cached.

Session validity is established with `supabase.auth.getClaims()`, which
verifies the JWT signature on every call. `getSession()` does not, and a cookie
is attacker-controlled input, so it is never trusted server-side.

## Personal data

`audit_log` records `ip_address` and `user_agent`, which are personal data.
They are retained for security investigation. **The business should set a
retention period before going live**; Phase 1 sets none, and this is a known
gap rather than an oversight.

Client and guarantor documents — National Identification photographs in
particular — live in private buckets reachable only through short-lived signed
URLs. Phase 2 must define who may mint those URLs before any upload workflow
ships.

Logs mask phone numbers and emails and describe money by order of magnitude
rather than by value.

## Phase 2 verification

| Check | Result |
| --- | --- |
| Anonymous access to any table | Denied at the grant level — `anon` holds no privilege anywhere. |
| Client reading staff records | Returns zero rows. Driven as the `authenticated` role against a real database. |
| Staff promoting themselves | Refused by trigger. Including an Owner — nobody edits their own role assignments. |
| Manager becoming Owner | Refused twice over: the capability check, and independently the rank rule. |
| Deleting audit history | Refused for every role, by trigger and by revoked privilege. |
| Removing the last Owner | Refused, including under two genuinely concurrent committing transactions. |
| Disabling a user actually stopping access | Verified with the same token before and after, for all three inactive statuses. |
| Secrets in the client bundle | Clean: `sb_secret_`, `SUPABASE_SECRET_KEY`, `DATABASE_URL`, `service_role` all absent from `.next/static/`. |
| Direct API calls bypassing the interface | Every escalation test runs as the `authenticated` database role, not through the application. |
| Forging a role assignment | `granted_by` is overwritten with the acting profile. |
| Account enumeration | One message for every sign-in failure, including a malformed number. |
| Open redirect on sign-in | `next` accepts only a plain in-site path; absolute, protocol-relative, `javascript:` and backslash forms are discarded. Verified against the running application. |
| Route protection | Every protected route returns 307 to sign-in for an anonymous request. No protected page returns 200, so there is no content flash. |
| Function `search_path` | All 21 `SECURITY DEFINER` functions pin `search_path = ''`. |
| Functions executable by `anon` | None. |
| Security headers after the auth changes | Unchanged, plus `Cache-Control: private, no-store` on authenticated responses. |

## Issues found and fixed in Phase 2

**Trigger functions were executable by `anon`.** `set_updated_at` and
`reject_mutation` kept PostgreSQL's default grant to `PUBLIC`. Not exploitable
— PostgreSQL refuses to call a function returning `trigger` outside a trigger
context — but revoked anyway in migration `20261002000700`, so that the answer
to "which functions can an anonymous visitor execute?" is an unqualified
"none". An audit that has to reason about why two entries are harmless will
eventually wave through a third that is not.

**`record_sign_in()` was blocked by its own guard.** The column guard refuses
any change to `last_sign_in_at` from a session, and `SECURITY DEFINER` does not
clear `auth.uid()`, so the sanctioned writer would have been refused. Found
while writing the migration; the guard now honours the transaction-local marker
the function sets.

**The `next` parameter was captured and never honoured.** The proxy recorded
where a visitor was heading, and sign-in ignored it. Found during the running
application review. Now honoured, sanitised twice — once when rendering the
form and again in the action, because a hidden field is client-supplied input.

## Phase 3 verification

Client and guarantor management, reviewed before declaring the phase complete.

| Attack | Result |
| --- | --- |
| A borrower reads another client's record | Refused. The policy's identity clause grants exactly one row; naming another id returns nothing. |
| A borrower reads their own National Identification Number | Refused. `client_identities` has no self-clause, deliberately. |
| A borrower edits their own client record | Refused. They hold no client-editing capability, so the UPDATE policy never opens the row. |
| A borrower links themselves to another client | Refused twice: the column guard, and `link_client_profile` being `service_role`-only. |
| A Secretary/Treasurer reads any NIN | Refused. The number is not in a table they can read. |
| A Secretary/Treasurer changes a status, blacklists, or registers a client | Refused, each by name in the error. |
| A Manager blacklists or archives a client | Refused. Both are Owner-only. |
| A Manager calls `link_client_profile` | Refused: `42501`. No session role holds EXECUTE. |
| Anyone deletes a client, guarantor or remark | Refused. No DELETE grant exists for any role. |
| Anyone edits or deletes a remark | Refused by statement-level trigger *and* absent privilege. |
| `service_role` forges or changes a client number | Refused. The rule sits above the trusted-path exemption. |
| `service_role` repoints `profile_id` by plain UPDATE | Refused, same reason. |
| A borrower retrieves a guarantor photograph by guessing a path | Refused. The read policy needs `guarantors:view`. |
| A Secretary/Treasurer opens an identity document | Refused. The `id/` folder needs `clients:view_nin`. |
| An executable renamed to `.jpg` is uploaded | Refused by magic-byte check. |
| An SVG declaring itself a PNG | Refused. |
| A traversal or malformed storage path | Refused by `CHECK` constraint and by policy; the path helpers return NULL, which fails closed. |
| Two parallel registrations collide on a number | 40 parallel registrations gave 40 distinct gapless numbers. |
| Two parallel links to one profile both commit | Exactly one succeeded, under advisory lock. |
| Two clients share a NIN | Exactly one insert succeeded. |
| A NIN reaches the audit trail | It does not. Masked to `***BCD`; the full number appears in no audit row. |
| A hostile name or remark renders as markup | It does not. React escapes; no `dangerouslySetInnerHTML` anywhere. |
| A secret reaches the client bundle | Scanned 30 files for secret keys, service-role JWTs, connection strings and privileged identifiers. Clean, with a positive control to prove the scanner works. |

## Issues found and fixed in Phase 3

| Issue | Root cause | Fix |
| --- | --- | --- |
| `/clients` reachable by URL for any staff role | The route-permission map still required `dashboard:view` from when the page was a Phase 2 placeholder, while the menu entry had been given `clients:view`. The menu hid the entry; the route stayed open. | Route map updated for `/clients` and `/guarantors`. `tests/unit/client-routing.test.ts` now asserts the mapping per role and per route; `tests/integration/navigation.test.tsx` already asserted the two maps agree, which is what caught it. |
| An impossible date of birth was accepted | `Date.parse('1990-02-30')` succeeds — JavaScript rolls the day over to 2 March — so the schema stored a different date than the one submitted. | The parsed date is read back and its components must match the input. Leap-year cases tested both ways. |
| `client_remarks.created_by` made profiles undeletable with a confusing error | `on delete set null` on an append-only table: nulling a column is an UPDATE, which the table refuses. | Changed to `on delete restrict`, which is also the better rule — a remark whose author has been erased is weaker evidence. |
| Both identity tables lacked `created_at` | Oversight. Caught by the Phase 1 convention test that requires a creation timestamp on every table. | Column added to both. |

## Phase 4 verification

The loan engine, reviewed before declaring the phase complete.

| Attack | Result |
| --- | --- |
| A borrower approves their own loan | Refused. `loans:approve` is named in the error. |
| A borrower reads a draft on their own client record | Refused. The policy admits only non-draft loans. |
| A borrower reads another client's loan | Refused. |
| A borrower disburses, cancels or edits their own loan | Refused on all three. |
| A Secretary/Treasurer approves | Refused, by the function and by the transition trigger independently. |
| A Secretary/Treasurer approves by direct `UPDATE` | Refused. `loans_approved_requires_totals` also makes it impossible. |
| A Secretary/Treasurer disburses or cancels | Refused. |
| A Secretary/Treasurer reads any identity snapshot | Refused. The numbers are not in a table they can read. |
| A **Manager** disburses | Refused — the phase's central control. A Manager who could both approve and disburse could originate, approve and pay out a loan alone. |
| A Manager cancels | Refused. Reversing one's own decision is the Owner's. |
| A forged `approved_by`, `approved_at`, `disbursed_by`, `disbursed_at`, `submitted_by` | All refused, not overwritten. |
| A caller-supplied loan number, or changing one once issued | Refused, including as `service_role`. |
| Editing principal, rate, method, term, client, frequency or totals on a live loan | Refused, including as `service_role` — the rules sit above the trusted-path exemption. |
| Editing or deleting a stored breakdown or snapshot | Refused by statement-level trigger **and** absent privilege, including with a `WHERE` clause matching nothing. |
| Inserting a forged breakdown row from a session | Refused: `42501`. Only `approve_loan` writes them. |
| Deleting a loan, as any role | Refused. No DELETE grant exists anywhere in Phase 4. |
| **Two concurrent disbursements for one client** | Exactly one succeeded; the other named the limit. Holds for four simultaneous attempts, and honours a configured limit of two. |
| Two concurrent approvals of one loan | Exactly one succeeded. One set of snapshots, one audit event. |
| A direct `UPDATE` to `status = 'active'` bypassing the function | Refused — the trigger is on the table. |
| 40 parallel loan numbers | 40 unique, correctly formatted. |
| Approving after the client was blacklisted or suspended | Refused. Every rule is re-evaluated at approval. |
| Approving after the guarantor was detached or left incomplete | Refused. |
| Approving after the minimum rose above the loan | Refused. |
| A snapshot changing when the client, guarantor or settings change | It does not. Not one figure moved, while the live records demonstrably did. |
| A NIN reaching the audit trail | It does not. Snapshot events record kind and row count only. |
| A secret reaching the client bundle | 33 files scanned. Clean, with a positive control. |
| A float in the loan arithmetic | None. `npm run audit:money` checks the path mechanically and verifies the engine reaches only integer money helpers. |

## Issues found and fixed in Phase 4

| Issue | Root cause | Fix |
| --- | --- | --- |
| A decimal comma inflated a loan amount a hundredfold | The principal parser stripped every comma as a thousands separator, so `100000,50` became 10,000,050 shillings — accepted silently, on the most important number in the system. | A comma is accepted only in valid thousands positions (`^\d{1,3}(,\d{3})+$`). Four rejection cases and four acceptance cases added. |
| No draft could be saved | `total_expected_repayment >= principal_amount` was asserted unconditionally, but a draft has no computed totals. Two further attempts to phrase it by status each broke a different legitimate transition. | Stated by *state of the figures* rather than by status: either nothing is computed, or what is there is consistent — plus a second rule requiring figures from approval onward. |
| The approval function was blocked by its own immutability guard | "Frozen once the loan leaves draft" conflated what the loan *is* (never changes) with what it *costs* (written once, at approval). | Separated into two rules. The price and the policy snapshot are settable only on the `pending_approval → approved` transition. |
| A migration left an audit record behind | `20261004000100` ended with an `UPDATE` to state the confirmed settings — which `ALTER TABLE ADD COLUMN ... DEFAULT` had already backfilled, so it changed nothing except firing the settings audit trigger. | The redundant `UPDATE` removed. Caught by the Phase 1 guard asserting a freshly seeded database contains no audit record of its own. |

## Known gaps, deferred deliberately

| Gap | Phase |
| --- | --- |
| No Content-Security-Policy | 2. A nonce-based CSP must be wired through the proxy; adding one now would break the auth flows that do not exist yet. |
| ~~No route protection~~ | **Done in Phase 2.** Three layers: proxy, server-side route guard, Row Level Security. |
| ~~No RLS policies~~ | **Done in Phase 2** for every identity, settings and audit table. `reference_formats` and `reference_sequences` remain default-deny deliberately — nothing reads them from a session. |
| No rate limiting on user creation or password reset | Before go-live. Supabase Auth throttles sign-in itself; the administrative actions are not throttled. |
| ~~A user can clear their own forced-password-change flag without changing the password~~ | **Closed.** Migration `20261002000800` drops the function that allowed it and replaces it with one no session role may execute. See [AUTHENTICATION.md](AUTHENTICATION.md#the-forced-password-change). |
| Replaced photographs and documents accumulate | Deliberate, not an oversight. There is no DELETE policy on either bucket, because a bug that deleted the only scan of a client's national ID would be unrecoverable. An operator prunes with the secret key. The cost is storage; the alternative is losing evidence. |
| A guarantor photograph is readable by any staff member holding `guarantors:view`, for any guarantor | Correct for the size of business this serves, where staff handle whichever client is at the counter. If the business later wants per-branch isolation, the policy is the place to add it. |
| No rate limiting on client registration or document upload | Before go-live, alongside the Phase 2 gap. Supabase throttles auth; these actions are not throttled. |
| No automated transition to `cleared` | By design: the edge is declared and nothing performs it, because a loan can only be shown settled once payments can be posted. See ADR-025 on what such an automation would need. |
| `loans:disburse` and `loans:cancel` are Owner-only, which is a bottleneck in a small office | Deliberate (ADR-024's sibling reasoning, documented in LOANS.md): it is the only thing stopping one person originating, approving and paying out a loan alone. If the business accepts that risk it is a one-line change to the matrix, made knowingly. |
| A schedule entered against a mistaken disbursement cannot be corrected in place | Deliberate (ADR-026). The schedule is append-only so that Phase 7 arrears can never rewrite what was agreed. Rescheduling and restructuring belong in an explicit, audited workflow, not an "edit schedule" button. |
| No collections screen listing what is due across all loans today | Not built. The loan detail page shows each loan's schedule, and a collections round needs payment capture to be useful — that is Phase 6's. The data and indexes for it are in place (`loan_installments_due_date_idx`). |
| No audit-record retention policy | Before go-live. |
| No audit hash chain or off-site shipping | 2+, if the threat model includes an insider with database access. |
| No penetration test | Before go-live. |

## Phase 5 verification

The repayment schedule engine, reviewed before declaring the phase complete.

| Attack | Result |
| --- | --- |
| An anonymous visitor reads `loan_installments` or `loan_schedules` | Refused. No grant, and no rows come back from a count either. |
| A borrower reads another borrower's schedule | Refused, including by dropping the `WHERE` clause: the policy returns only their own loan. |
| A signed-in user without `schedules:view` and without a client link reads any schedule | Refused. The policy gates staff on the capability and admits a borrower only on their own loan. |
| A **Secretary/Treasurer** changes a due date or an amount | Refused. They read the schedule all day and can alter nothing in it. |
| A **Manager** rewrites an amount | Refused. |
| An **Owner/Administrator** edits or deletes any schedule row | Refused. Owner authority is about what the business may decide, not about rewriting what it already decided. |
| `service_role` rewrites a due date, an amount, a component or a period link | Refused by statement-level trigger — the leaked-key threat model these triggers exist for. |
| An `UPDATE` whose `WHERE` clause matches nothing | Refused. Statement-level, so the refusal does not depend on the attacker's predicate finding a row. |
| Deleting one installment, a whole schedule, or every schedule | Refused for every role including `service_role`. |
| Any session role inserting an installment | Refused. No INSERT grant and no INSERT policy exist on either table. |
| Any session role calling `generate_loan_schedule` directly | Refused — no `EXECUTE` grant to `anon` or `authenticated` at all, not even to the Owner. The only caller is `disburse_loan`, which runs as the table owner. |
| Generating a schedule twice | One schedule, byte-identical rows, one audit event. Idempotent by primary key and by an explicit early return. |
| **Two, three and four concurrent disbursements of one loan** | Exactly one succeeds. One schedule, one set of installments, one audit event, and no partial rows from the losers. |
| Four parallel direct calls to the generator | All succeed idempotently; still one schedule, the same row IDs, one audit event. |
| Forcing a generation failure mid-transaction | The loan stays `approved`, `disbursed_at` stays NULL, no installment survives, and the `loan.disbursed` audit entry rolls back with it. No misleading success in the trail. |
| An active loan existing without a schedule | None, asserted across the whole table after every concurrency test. |
| A schedule whose installments disagree with the contract | None, asserted across the whole table. The generator also reconciles per contractual month and loan-wide before it commits. |
| A contractual month with no collection | Generation fails and the disbursement rolls back, rather than creating a loan nobody can collect. |
| Changing `interval_days` between approval and disbursement | Refused outright — not merely ignored. A cadence's interval is what it means. See ADR-027. |
| Deleting a repayment frequency, referenced or not | Refused. Previously only a referenced one was protected by the foreign keys. |
| Changing business settings after generation | The stored schedule does not move: not one date, not one amount, and the snapshotted cadence label survives a rename. |
| Changing loan terms or the breakdown a schedule was built from | Refused — Phase 4 immutability re-verified now that a schedule hangs off it. |
| A payment-state column existing to be faked | None. `amount_paid`, `remaining_balance`, `arrears`, `status` and their variants are asserted absent from both tables. |
| A screen claiming an installment is paid, missed, overdue or in arrears | It does not. The words are asserted absent from the rendered output. |
| A NIN reaching a schedule audit event | It does not. The event records count, dates, cadence and total — never the rows. |
| A secret reaching the client bundle | 233 built files scanned. Clean, with a positive control. |
| A float in the schedule arithmetic | None. `npm run audit:money` covers both engines and verifies each reaches only integer money helpers. |

## Issues found and fixed in Phase 5

| Problem | Root cause | Fix |
| --- | --- | --- |
| A repayment frequency's meaning could be changed underneath a live loan | Phase 4 froze `loans.repayment_frequency`, but that is a *key*; the days it meant lived in `repayment_frequencies.interval_days`, which was freely editable. Editing `daily` from 1 to 2 would have silently redefined every loan that named it, with nothing in any loan record showing a change. | `key` and `interval_days` made immutable, and deletion refused outright (migration `20261005000200`); the cadence additionally snapshotted onto `loan_schedules` at generation. `label`, `is_active` and `sort_order` stay editable, so a cadence can still be retired. See ADR-027. |
| A frequency with no loans could be deleted, losing a reference-vocabulary entry | The protection was the foreign keys from `loans` and `business_settings`, which only cover a row something already references. | The statement-level delete guard above covers every row, referenced or not. `tests/db/behaviour.test.ts` was strengthened to assert the referenced case, the unreferenced case and a delete matching nothing. |

## Phase 6 verification

The payment ledger, reviewed before declaring the phase complete.

| Attack | Result |
| --- | --- |
| An anonymous visitor reads `loan_payments`, `payment_allocations` or any balance view | Refused. No grant on the tables, no grant on the views, and no rows come back from a count either. |
| A borrower reads another borrower's payments | Refused, including by dropping the `WHERE` clause: the policy returns only payments on their own loans. |
| A borrower reads another borrower's allocations, coverage or balance | Refused. The allocation policy delegates entirely to the payment, and the views are `security_invoker`, so they are read under the reader's own policies. |
| A signed-in user with neither `payments:view` nor a client link reads any payment | Refused. |
| A **Secretary/Treasurer** posts a payment | Permitted — this is the counter role. |
| A **Secretary/Treasurer** or **Manager** reverses a payment | Refused. `payments:reverse` is the Owner's alone, checked inside `reverse_payment` rather than by hiding a button. |
| A borrower posts a payment against their own loan | Refused. Recording money received is a staff act. |
| A borrower calls `post_payment` or `reverse_payment` directly | Refused. The capability check is in the function, and a borrower holds neither capability. |
| Any role **edits** a posted payment's amount, method, reference, loan, dates or receipt figures | Impossible before it is refused: `authenticated` holds no UPDATE privilege on `loan_payments` at all, so no session can reach the guard. The guard then refuses the same changes for the table owner and `service_role`. |
| Any role edits or deletes an allocation | Refused for every role including `service_role`, by statement-level triggers. Financial history does not cascade away: `payment_allocations.installment_id` is `on delete restrict`. |
| Any role **deletes** a payment | Refused for every role including `service_role`. There is no capability, no grant and no code path; the trigger is the backstop. |
| An **Owner/Administrator** edits a historical payment or an allocation | Refused. Owner authority is about what the business may decide next, not about rewriting what it already recorded. |
| `service_role` reverses a payment | Refused — there is no session, so the database cannot name who withdrew the money, and an unattributable reversal is not a reversal. The same rule ADR-025 applied to approvals. |
| `service_role` sets `status = 'reversed'` by direct UPDATE | Refused. The guard permits only `posted → reversed` **with** a database-stamped actor. |
| Reversing a payment twice | Refused, checked before anything else, so the balance cannot be credited twice. |
| Reversing a reversal | Refused. If the borrower did pay, that is a new payment with its own receipt. |
| A reversal with no reason, or a one-word reason | Refused. The reason is the only record of why a borrower's money was withdrawn; the floor is ten characters. |
| The same Mobile Money transaction reference recorded twice | Refused by a partial unique index over posted payments. |
| A cash payment carrying a transaction reference | Refused. Cash has no network reference, and a field for it would invite the receipt number to be typed in. |
| A Mobile Money payment with no reference | Refused. |
| **A double-tapped submission** (the same idempotency key, concurrently) | One payment, one set of allocations, one receipt. The second call returns the first payment rather than recording the money twice. |
| Two genuinely identical cash payments on one day | Both recorded, with separate receipts. Distinguished from a retry by the server-minted key, not by a heuristic on the amount. |
| **Concurrent payments racing to settle one loan** | Serialised on the loan row. Totals reconcile, no collection is over-covered, outstanding never goes negative, and exactly one clearance event is recorded. |
| A payment larger than the outstanding balance | Refused, with the balance named. No credit balance is created. |
| A payment smaller than the earliest uncovered collection | Refused, with the minimum named. |
| A payment of zero or a negative amount | Refused. |
| A payment against a draft, pending, approved, cancelled or rejected loan | Refused. Only a disbursed loan has collections to cover. |
| A caller supplying `received_at`, `recorded_by`, or the receipt balances | Not possible — the function takes none of them and derives all four itself. A client-controlled clock would decide which collections a payment covers. |
| A caller supplying the allocation | Not possible. The function allocates from figures it re-derives inside the locked transaction; nothing a browser computes is trusted. |
| Marking a loan `cleared` while it still owes money | Refused for every caller including `service_role`: the transition is validated against the derived ledger. See ADR-032. |
| Reopening a loan that owes nothing | Refused by the same check. |
| Setting `cleared_at` or `cleared_by` by hand | Refused. Both are stamped by the database from its own view of the actor. |
| A balance that disagrees with the ledger | None exist to disagree: there is no stored balance. Every figure is derived on read, and the whole table is asserted reconciled after each concurrency and parity run. |
| `outstanding` going negative | Impossible by construction, and asserted across the table after every suite. |
| A view bypassing Row Level Security | None. All three carry `security_invoker`, asserted in `tests/db/schema.test.ts` alongside a check that no view is readable by `anon`. |
| A view granted more than SELECT | None. Every privilege is revoked from `public`, `anon` and `authenticated` explicitly before SELECT is granted to `authenticated` — see the issue below. |
| A screen claiming an installment is paid, missed, overdue or in arrears | It does not. Those words are asserted absent from the rendered output of every payment screen; what is due today is called "due now". |
| A reversal presented as a deletion | It is not. "Delete", "remove" and "void" are asserted absent from the register and the reversal panel, the reversed payment stays listed with its amount struck through, and its receipt stays reachable and marked `REVERSED`. |
| A borrower's portal hiding a reversed receipt they hold | It does not. The row stays, labelled, with a line telling them to ask. |
| Staff attribution or internal notes leaking into the portal | They do not. Asserted absent from the rendered borrower view. |
| A NIN or personal data reaching a payment audit event | It does not. The events record amounts, counts, method and references — never client rows. |
| A secret reaching the client bundle | 37 client files scanned, 0 hits; the same string appears in 5 server files, and a planted probe is detected. |
| A float in the payment arithmetic | None. `npm run audit:money` covers all three engines across 31 financial files and verifies each reaches only integer money helpers. |

## Issues found and fixed in Phase 6

| Problem | Root cause | Fix |
| --- | --- | --- |
| The three new views were granted **ALL** privileges to `anon` and `authenticated` | Supabase's `ALTER DEFAULT PRIVILEGES` grants every privilege on new objects in `public` to both roles. `grant select` on top of that changes nothing. Not exploitable — `security_invoker` meant the base tables' own privileges denied the read — but the protection was coming from the wrong layer, and an `anon` role with `INSERT` on a view over `loan_payments` is not a posture worth keeping. Caught by the exhaustive privilege guard written in Phase 1. | Explicit `revoke all ... from public, anon, authenticated` on each view before granting SELECT to `authenticated`, plus a new `views` describe block asserting SELECT-only, no `anon`, and `security_invoker` on all three. |
| Every money column in the views was `numeric`, not `bigint` | `sum(bigint)` returns `numeric` in PostgreSQL, so the widening was invisible in the SQL. A money figure in an arbitrary-precision decimal type is one implicit cast away from a fractional shilling. Caught by the Phase 4 money-type guard. | Every aggregate and derived figure cast back to `bigint`, and the guard extended to cover view columns as well as table columns. |
| Reversing the **first** of two payments was refused | `reverse_payment` reconciled against the payment's own frozen receipt balance (`outstanding_after + amount`), which is two payments out of date the moment a later payment exists. Exactly the receipt-versus-live-balance confusion ADR-029 exists to prevent, made inside the function that most needed to avoid it. | Capture `public.loan_outstanding()` immediately before the update and assert the live balance rose by the payment's amount. Regression test with two payments added to `tests/db/payment-reversal.test.ts`. |
| A reopened loan would have been recorded in the audit trail as **disbursed again** | Phase 4's `audit_loan_change` mapped every transition into `active` to `loan.disbursed`. Phase 6 introduced `cleared → active`, so a reversal would have written a false record that the business paid money out a second time. | `audit_loan_change` replaced in migration `20261006000800`: a transition into `active` from `cleared` is `loan.reopened`. The separate clearance trigger that had also duplicated `loan.cleared` was dropped. |
| `/payments` was reachable with only `dashboard:view` | The route map carried the same defect Phase 3 found on `/clients`: a new route added to the map with the dashboard's capability rather than its own. The page's own data access would still have refused, but the proxy is where this belongs. | Route map and navigation changed to `payments:view`, with the route-map test extended to cover it. |
| The payment search accepted `2026-13-01` as a date | `paymentSearchSchema` validated dates with a hand-written regex instead of the shared `businessDateSchema`, which calls `isBusinessDate`. A shape check is not a calendar check. | Reuses `businessDateSchema`. The lesson is the one Phase 2 already recorded: there is one date validator, and a second one is a bug waiting. |

## Phase 7 verification

Delinquency, grace and penalties, reviewed before declaring the phase complete.

| Attack | Result |
| --- | --- |
| An anonymous visitor reads `loan_penalties` or any delinquency view | Refused. No grant on the table, every privilege revoked from `anon` on all four views, and a count returns nothing either. |
| A borrower reads another borrower's arrears, penalty or overdue position | Refused, including by dropping the `WHERE` clause. The penalty policy delegates to the loan, and the views are `security_invoker` so they are read under the reader's own policies. |
| A signed-in user with neither `delinquency:view`/`penalties:view` nor a client link reads any penalty | Refused. |
| A borrower reads their **own** arrears and penalty | Permitted, through the same client link that shows them their schedule — and with no capability, which is why `business_date()` had to work for a session role (see the issue below). |
| Any role **creates** a penalty | Refused. There is no capability for it, no grant, and no code path that accepts one. A penalty is the rule applied to the ledger. |
| Any role supplies a **penalty amount** | Not possible. `ensure_penalty_applied` takes a loan id and nothing else; the amount is computed from the loan's snapshotted rate and a basis it reconstructs itself. |
| A **forged** penalty amount written directly as the table owner | Refused by a CHECK constraint: `penalty_amount` must equal `(basis_amount × rate_bps + 5000) / 10000`. Unauthorized is the second line of defence; arithmetically impossible is the first. |
| A penalty whose grace end or effective date does not follow its due date | Refused by CHECK. `grace_end_date = final_due_date + grace_period_days` and `effective_date = grace_end_date + 1` are constraints, not conventions. |
| Any role **edits** a penalty — amount, basis, rate, dates | Refused for every role including `service_role`, by a statement-level trigger. `authenticated` holds no UPDATE privilege at all, so no session even reaches it. |
| Any role **deletes** a penalty | Refused for every role including `service_role`. Financial history does not cascade away either: `payment_allocations.penalty_id` is `on delete restrict`. |
| An **Owner/Administrator** waives or reduces a penalty | Refused. There is no waiver capability in Phase 7 and the spec does not call for one; a waiver would be a new audited transaction that leaves the penalty standing, never an edit. |
| A **second** penalty on the same loan | Refused by a unique index on `(loan_id, penalty_type)`. Not 50% a day, not 50% a month, and no penalty on a penalty. |
| Paying late to shrink the charge | Does not work. The basis is reconstructed as at the **end of the grace period** by `loan_outstanding_as_of`, so a payment made after that date does not reduce it. Verified at UGX 20,000 of difference on the same money paid three days apart. |
| Reversing a payment to shrink the charge | Does not work either. `loan_outstanding_as_of` counts only still-posted payments, so withdrawn money never reduced the basis. |
| **Clearing a loan by paying only its penalty** | Refused. This was a real defect, found and fixed below. |
| Marking a loan `cleared` while a penalty is unpaid | Refused for every caller including `service_role`: the transition is validated against `loan_total_outstanding`. See ADR-032. |
| A loan that briefly looked cleared escaping a charge it had earned | It does not. `reverse_payment` calls `ensure_penalty_applied` after reconciling, so the reversal that reopens the loan also applies the penalty. |
| A penalty recreated, recalculated or duplicated by a reversal | Impossible. The unique index refuses a second row, and `ensure_penalty_applied` returns the existing one unchanged — same amount, same basis. |
| **Two concurrent payments racing to apply the penalty** | One penalty. `ensure_penalty_applied` takes the loan's row lock before it looks, so the second caller sees the first one's row. Totals reconcile and the penalty is never assessed twice. |
| A penalty materialised by a **read** | Never. A SELECT writes nothing in Phase 7; screens show the projected charge from the view, labelled pending, and the transaction that needs the row creates it. |
| Correctness depending on a cron job | It does not. Eligibility is derived continuously and materialisation happens inside `post_payment` **before any balance is read**, so a borrower cannot settle yesterday's figure and escape a charge already due. `apply_eligible_penalties()` is an optimisation. |
| Moving the business date to dodge or trigger a penalty | Not reachable. `app.business_now` is honoured only when `session_user` owns the tables — a direct connection as the schema owner, which PostgREST (`authenticator`, then `set role`) and the privileged server client (`service_role`) are not, and which a browser cannot set. The same threat profile the test fixtures already carry: somebody with the owner connection can rewrite the data outright, and no in-database design changes that. See ADR-034. |
| A browser, a server clock or a UTC date deciding what is overdue | None of them do. Every comparison goes through `business_date()` on the company's configured timezone, verified at 23:30 UTC — already tomorrow in Kampala — and across month ends, year ends and a leap day. |
| A client-supplied `as_of_date` on payment posting | Not possible. `post_payment` takes no date of any kind and derives `received_at` from the business clock, as it did in Phase 6. |
| A penalty misclassified as interest or principal | Refused by CHECK: a penalty allocation carries no principal and no interest, and an installment allocation carries no penalty. `principal_paid + principal_remaining = contractual_principal` still holds exactly. |
| A penalty added to the original schedule or the contractual interest | Never written. `loan_installments` and the loan's snapshotted terms are fingerprint-identical across the Phase 6 → Phase 7 upgrade, with no penalty applied by the migration itself. |
| A retrospective penalty figure on an old receipt | None. Phase 6 receipts are byte-for-byte unchanged after the upgrade; a frozen balance snapshot is never rewritten. |
| An unexplained client credit balance | None. An overpayment beyond `total_outstanding` is still refused with the figure named, penalty included. |
| A stored arrears balance somebody could edit | There is none to edit. The schema is asserted free of any arrears, days-past-due or delinquency-status column, so the only way to change arrears is to pay or to reverse a payment — both audited financial acts. See ADR-033. |
| A delinquency view bypassing Row Level Security | None. All four carry `security_invoker`, asserted in `tests/db/schema.test.ts` alongside a check that no view is readable by `anon`. |
| A view or function granted more than it needs | Every privilege revoked from `public`, `anon` and `authenticated` before SELECT is granted back; `is_table_owner_session()` is revoked from every session role outright. |
| A `SECURITY DEFINER` function with a mutable search path | None. The enumeration test covers the Phase 7 functions, `business_now()` included, and every one sets `search_path = ''` with catalogue calls qualified. |
| Installment counts presented as "days" | They are not. The two measures are separate columns with separate labels, and the UI test asserts an every-3-days loan three collections behind is shown as nine days late, not three. |
| A screen calling a loan in grace "defaulted" | It does not. The grace state is labelled as the business's own allowance still running; "default" and "defaulted" are asserted absent from the rendered delinquency screens. |
| A penalty presented as interest to a borrower | It is not. The portal names it a late-payment charge, separately from the contractual figures, and the words are asserted. |
| Staff attribution or internal notes leaking into the portal's arrears view | They do not. Asserted absent from the rendered borrower view. |
| Personal data reaching a penalty audit event | None. The event records the loan, the dates, the basis, the rate and the amount — never client rows — and its actor is recorded as `system` with a null actor id, because no person decided it. |
| A secret reaching the client bundle | 37 client files scanned, 0 hits; the same string appears in server files only, and a planted probe is detected. |
| A float in the delinquency or penalty arithmetic | None. `npm run audit:money` covers all four engines across 37 financial files and verifies each reaches only integer money helpers. |

## Issues found and fixed in Phase 7

| Problem | Root cause | Fix |
| --- | --- | --- |
| **A borrower could clear a loan by paying its penalty** | `loan_outstanding` summed *every* allocation against the loan, and Phase 7 gave allocations a second possible target. A UGX 50,000 penalty payment therefore reduced the *contractual* balance by 50,000, and a loan owing 50,000 on its contract plus a 50,000 penalty would be marked `cleared` by paying the penalty alone. Exactly the generalisation risk ADR-036 accepted, landing in the one function every balance depends on. | `loan_outstanding` redefined with `and pa.installment_id is not null`, so the contractual figure counts contractual allocations only, with `loan_penalty_outstanding` and `loan_total_outstanding` alongside it and clearance validated against the total. Regression tests in `tests/db/penalty-application.test.ts`. |
| **Every delinquency read failed for every signed-in role** — including a borrower reading their own arrears | `business_now()` gated its test override as `if v_override is not null and public.is_table_owner_session()`. PostgreSQL does not promise to evaluate `AND` left to right or to skip the second operand, so the privilege-gated helper could be called on every invocation — `permission denied` on a function the whole phase depends on. Found by a borrower being unable to read their own figures, which is precisely the reader with no capabilities to fall back on. | Rewritten as a nested `IF` so the helper is unreachable unless an override is actually set, and `business_now()` made `SECURITY DEFINER` so the gate is callable regardless of the caller's privileges (`session_user` is unaffected by `SECURITY DEFINER`, so it still reports the real connection). `business_now` added to the `SECURITY DEFINER` enumeration test. |
| **A reversal could be timestamped before the payment it reversed**, and then refused | Phase 6's `loan_payments_guard_mutation` stamped `reversed_at` from `pg_catalog.now()`, overwriting the business-clock value `reverse_payment` had just set. Under a test or settings clock behind the server's, the reversal landed before `received_at` and the `loan_payments_reversed_after_received` constraint — correctly — refused it. One clock means one clock; a trigger quietly using another is the same class of bug as a second date validator. | The guard restated to stamp `public.business_now()`. |
| A loan was reported as **"a penalty applies"** while the charge would be zero | `penalty_eligible` tested only the dates and the basis, so a business running a 0 bps rate — a business that has decided not to charge — saw `expired_unpaid` while `ensure_penalty_applied` correctly recorded nothing. A derived state that contradicts the function it describes is worse than either answer alone. | Eligibility in both the view and `lib/domain/delinquency.ts` now requires the projected charge to be greater than zero, with the converse asserted as an invariant: eligible implies a charge, and a charge implies eligible. |
| Fixture teardown began failing across the database suites | `payment_allocations.penalty_id` is `on delete restrict` — deliberately, so financial history cannot cascade away — which makes penalties undeletable until the payments that touched them are gone. The existing teardown order deleted penalties too early. | `loan_penalties` added to the cleanup guards and the delete order in the auth, loan and payment fixtures, after payments; the new suites' `beforeAll`/`afterAll` ordered to match. Worth recording because the constraint doing the blocking is one worth keeping. |

## Phase 8 verification

Dashboards, reports, exports and the portal, reviewed before declaring the
phase complete.

| Attack | Result |
| --- | --- |
| An anonymous visitor reads any reporting view | Refused. Every privilege is revoked from `anon` on all five, and a count returns nothing either. |
| An anonymous visitor reads the business-wide totals in one SELECT | Refused. `dashboard_portfolio_summary` is the single most attractive row in the schema, and it is `security_invoker` like everything else. |
| **A borrower reads another borrower's payments, position or statement** | Refused, including by dropping the `WHERE` clause and by naming the row directly. The views are `security_invoker`, so each is read under the borrower's own policies. |
| **A borrower reads the portfolio aggregate** | Permitted, and it aggregates *their own one loan*: one client, one loan, an outstanding figure strictly below the business's. Asserted explicitly rather than assumed — "it is only a total" is how an aggregate view becomes a leak. |
| A borrower opens another borrower's statement by editing the loan id | Refused. The policy on `loans` returns nothing, the page answers `notFound`, and an explicit client check sits above it as a second layer. |
| A signed-in user with no capability and no client link reads a report | Nothing comes back, and the summaries report zero. An empty result is the correct shape: whether the rows exist is not theirs to know either. |
| A **Secretary/Treasurer** opens the loan portfolio or the charges report | Refused. Those need `reports:view_financial`, which the counter role does not hold — §42 asked for that to be an explicit decision. |
| A **Secretary/Treasurer** or **Manager** opens the executive summary | Refused. `reports:view_sensitive` is the Owner's alone; a Manager supervises lending without seeing what the business earns. |
| A **Manager** sees business income figures on the dashboard | They do not. The section's query is never issued for a caller without the capability, so the figures are not fetched and then hidden in the markup. |
| **A report URL typed directly** | Each page performs its own `guardPermission` for every capability it needs, enforced by a source-level test that also asserts the route map never grants a report on `dashboard:view` — the defect this project has now been warned about three times. |
| **An export URL typed directly** | Each handler repeats the page's check through `guardExport`, with the same capability list, asserted file by file. A hidden link protects nothing. |
| An export URL kept after a role changes | Refused on the next request. The check is per request, not per session. |
| An account with a temporary password still in force downloads a report | Refused. Somebody other than the account holder knows that password, so a download leaks as much as a page would. |
| A reporting view used to write | Impossible. No session role holds INSERT, UPDATE or DELETE on a view, so the Owner and `service_role` are refused in the same way a borrower is. |
| A mutation route under `/reports` | None exists. Every export handler exports `GET` only, asserted for all six. |
| A report read that materialises a penalty | Never. Fifteen reads across every reporting view against a loan past its charge date leave `loan_penalties` empty. §108, and the Phase 7 rule it restates. |
| A projected charge presented as a recorded one | It is not. The charges report lists only charges on the ledger; a pending one appears on the dashboard and the arrears report labelled as pending, with its projected amount. |
| **Filter injection through `?sort=`** | Refused. Four sorts, each mapped to a column in a whitelist; `?sort=client_phone`, `?sort=days.desc` and `?sort=days,client_phone` all fall back to the default. The value never becomes a column name. |
| Filter injection through `?status=`, `?state=`, `?method=`, `?clientStatus=` | Refused. Each is tested against the vocabulary the screen offers; anything else filters on nothing. |
| **Filter injection through the search box** | Refused. The term reaches PostgREST's `or(...)` syntax, where a comma or a parenthesis is punctuation rather than data — so it is reduced to the characters a name, number or reference contains. `name.eq.x,or(role.eq.owner)` becomes `name eq x or role eq owner`. |
| A `%` in the search box turning a search into a full scan | Refused. The `ilike` wildcards are stripped, and a term of `%` alone reads as no search. |
| A malformed identifier in a filter | Dropped. `?clientId=' or 1=1 --` filters on nothing rather than producing a database error the page would have to explain. |
| SQL injection anywhere in the reporting layer | No string concatenation into SQL exists: every query goes through the Supabase query builder, which parameterises values, and every filter is whitelisted before it gets there. |
| **A formula in a CSV cell** | Disarmed. `=cmd\|' /C calc'!A0` in a client name, a remark or a reversal reason arrives prefixed with an apostrophe in every report that shows one. The content survives — a client genuinely called `=Mukasa` still appears — it simply cannot run. |
| A formula hidden behind leading whitespace | Disarmed. The first **non-space** character decides, because some spreadsheet versions strip whitespace before working out whether a cell is a formula. Found by a test; see the issues below. |
| A number corrupted by the formula defence | Does not happen. Money and counts go through a numeric formatter that never prefixes: a cell carries no formula, and a column of `'50000` could not be totalled by the person who asked for the file. |
| A comma, quote or newline in free text breaking a CSV row | Quoted or flattened, so one record stays one row. Verified with an embedded comma, an embedded quote and an embedded newline. |
| A non-ASCII name arriving as mojibake | It does not. Every file carries a byte-order mark, so a spreadsheet opens it as UTF-8 — which matters because the document is used to identify a borrower. |
| **A National Identification Number in a report or an export** | None exists to gate. No column in any of the five CSV column sets is one, asserted by a word-boundary scan over every header. §76. |
| A CSV rendered in the browser rather than downloaded | Refused by `content-disposition: attachment` plus `nosniff`, which is what stops a file holding user-supplied text being treated as something else. |
| A cached report shown as current | No. Every export sends `cache-control: no-store`, and the pages are server-rendered on each request. |
| An unbounded export | Capped at 5,000 rows, and a set that hits the cap **keeps its rows and loses its totals**, with an explanation. A partial total presented as a total is a figure somebody would circulate. |
| A mistyped year asking the database for everything | Refused. A range longer than five years is rejected with its reason. |
| **Reversed payments inflating a collection total** | They cannot. Every total sums `effective_amount`, which the database sets to zero on reversal, so a reversal is excluded without each call site remembering to filter. The row stays visible and marked. |
| A gross figure mistaken for takings | It is labelled "recorded, including reversed" and appears only when something in the range was actually reversed. |
| **A penalty counted twice** | It is not. Charges are summed once from `loan_penalty_coverage`; `penalty_assessed + nothing` reconciles to `penalty_paid + penalty_remaining` on every charge, and the contract and penalty sides of every balance reconcile separately. |
| A lifecycle count added to a delinquency count | Not possible to do accidentally: the two families are under separate headings with separate names, the seven delinquency states are asserted to partition the disbursed book exactly, and the overlapping measures say so in their own definitions. §111, §112. |
| **A prepaid collection appearing as due** | It does not. A collection covered before today is absent from `collections_today` entirely, so it appears on no sheet, in no count and in no day target. §130. |
| **A dashboard figure disagreeing with its detail report** | Asserted equal. The summary views aggregate exactly the views beneath them; the collection report derives its cards, breakdowns, table and CSV from one array; and the loan register is asserted to repeat `loan_balances` and `loan_delinquency` column for column. |
| A report inventing a second definition of overdue | None exists. Arrears, lateness, missed collections and the seven states all come from `loan_delinquency`. §15. |
| Total collected computed from scheduled amounts | It is not. Asserted equal to the sum of posted payments, computed directly from `loan_payments` with no view on the expected side. §66. |
| Principal, interest and penalty collected failing to reconcile | They reconcile exactly, and are asserted equal to the allocation components rather than apportioned by a ratio. §70. |
| Contract plus penalty outstanding failing to reconcile | Asserted equal to total outstanding, business-wide and loan by loan. §71. |
| A negative outstanding figure on any report | None. Asserted across the whole table after every parity run. |
| Principal disbursed measured from the current status | It is not: measured from `disbursed_at`, so settled loans are included. Asserted to exceed the active-only figure, so the test would fail if it regressed. §12. |
| **An archived or blacklisted borrower vanishing from financial reporting** | They do not. Blacklisting and archiving a borrower mid-test leaves the portfolio total unchanged and their loan still listed. A status says whether the business will lend again; it says nothing about money already owed. §132, §133. |
| Interest called profit | Never. Asserted absent from every metric label and from the rendered executive summary, which states plainly that the figures are not profit because the system records no costs. |
| A method split called a cash or wallet position | Never. "Cash received", "MTN received", "Airtel received", each with a definition denying the balance reading. |
| An assessed charge booked as income | Not possible: charged and collected are separate cards with separate definitions everywhere they appear. |
| Staff attribution or an internal note in a borrower's statement or portal | Neither appears, for either audience, asserted by regression test. Nor a guarantor's details, nor an identification number. |
| Internal vocabulary in the portal | None. `principal`, `obligation`, `allocation`, `basis point`, `delinquency`, `coverage`, `ledger` and `security_invoker` are all asserted absent from the rendered borrower view. |
| A privileged client in the reporting layer | None. Asserted across every report page, every export route, both data modules and the dashboard, with comments stripped so documentation is not punished for discussing `service_role`. |
| A reporting view bypassing Row Level Security | None. All five carry `security_invoker`, and none is materialised — asserted by `relkind`, so a future materialised view fails the test rather than silently becoming unprotected data. |
| A reporting view granted more than SELECT | None. Every privilege revoked from `public`, `anon` and `authenticated` before SELECT is granted back, asserted grant by grant. |
| A money column widened to `numeric` in a view | None. Every money column across the five views is `bigint`, `integer` or `smallint` — `sum(bigint)` returns `numeric`, so the widening would be invisible in the SQL. |
| A float in the reporting arithmetic | None. `npm run audit:money` now covers 56 files including all nineteen new ones, and found two hazards on its first run over them — see below. |
| An N+1 query behind a report | None. Labels for a page come from one extra query keyed on the ids already read; the client report reads its clients, then all their loans in a single `in (...)`. |
| A secret reaching the client bundle | 37 client files scanned, 0 hits; the same string appears in server files only, and a planted probe is detected. |
| The Phase 8 migration changing a financial record | None. Across a Phase 7 database carrying four loans, three payments, a reversal and a charge, every fingerprint — loans, installments, periods, payments, allocations, charges, balances, snapshots, receipts, audit — is byte-identical after the Phase 8 migrations, and no payment, charge or audit event was added. |

## Issues found and fixed in Phase 8

| Problem | Root cause | Fix |
| --- | --- | --- |
| **A CSV formula could hide behind leading whitespace** | `sanitizeCsvText` tested `text.charAt(0)`, and newline flattening runs first — so a cell of `\r=cmd` became ` =cmd`, whose first character is a space, and the formula check passed it through. Several spreadsheet versions strip leading whitespace *before* deciding whether a cell is a formula, so that cell would have executed. Found by writing the test for the tab and carriage-return cases rather than only for `=`. | The check now inspects the first **non-space** character. Regression tests cover `\t=cmd`, `\r=cmd` and `   =cmd`, and the whole-file assertion walks every data cell of every report to confirm none begins with a bare formula character. |
| **A statement did its own percentage arithmetic** | The penalty explanation rendered `(penaltyRateBps / 100).toFixed(0)}%` — a decimal division and a `toFixed` in a component, which is exactly the class of ad-hoc money arithmetic the audit exists to catch. It happened to be correct for 5,000 bps and would have silently rounded 250 bps to "3%". Caught by extending `npm run audit:money` over the new files. | Uses the shared `formatBps` helper. The rate is stored in basis points precisely so that no screen performs percentage arithmetic of its own. |
| **A second day-counting implementation** | `rangeLength` computed its own `Math.round((end - start) / 86_400_000) + 1` over `Date.UTC` values, duplicating `daysBetween` from Phase 1. Correct today, and the third date implementation in a codebase that has already recorded two defects caused by having two of something. Also flagged by the money audit, which reads `Math.round` as a money hazard. | Built on `daysBetween`; the private `shiftDays` helper likewise replaced by Phase 1's `addBusinessDays`. |
| **The loan status vocabulary was declared twice** | `lib/data/reports.ts` re-declared `LOAN_STATUSES` and `isLoanStatus`, which Phase 4 already defines in `lib/domain/loan.ts`. Identical values, so nothing was broken — and the next change to the lifecycle would have had to find both. | The data layer imports the domain's type; the collection-status vocabulary was moved from the data layer into `lib/domain/reporting.ts` for the same reason, so the layer that validates a URL no longer has to import the data access layer to do it. |
| A one-month collection report cost 65 ms where it could cost 2 | The query filtered on `payment_register.business_date`, which is `payment_business_date(received_at)` — a STABLE function reading the company timezone, so it **cannot be indexed** and costs a call per row with no selectivity estimate for the planner. Measured at ten times this business's expected scale. | Filters on `received_at` between the instants the business-date range corresponds to, using the Phase 1 conversion helpers and an index that already existed. Exactly equivalent, because a business date range *is* an instant range in the business timezone. |
| The audit viewer showed raw identifiers for most of what it held | `AUDIT_ACTION_LABELS` had not been updated since Phase 2, so `loan.disbursed`, `payment.reversed` and twenty-nine other actions recorded since then rendered as their keys. Not a security defect, but an audit trail nobody can read is not performing its function. | All thirty-three actions labelled, generated into the filter vocabulary from the same table so an action cannot appear in one without the other. Date, action, entity and actor filters and paging added at the same time, and the timestamps now render in the configured timezone rather than the build-time constant. |

## Phase 9 verification

Phase 9's subject was everything *around* the money: the installable
application, the browser's own defences, the limits, and whether any of it
actually works when a person opens it. The method was the point. Phases 1-8
were verified by 2,584 passing tests, and shipped three defects that made the
product unusable; Phase 9 was verified by running it.

| Check | Result |
| --- | --- |
| Content-Security-Policy | Per-request nonce plus `strict-dynamic`, `object-src 'none'`, `frame-ancestors 'none'`, `base-uri 'self'`, `form-action 'self'`. No `'unsafe-inline'` in `script-src`. Asserted in the unit suite as a string, and in a browser as enforcement: the real header is read off a live response, served on a document of its own, and its un-nonced inline script does not run. |
| `'unsafe-eval'` | Absent from every built artefact. Present only when `NODE_ENV === 'development'`, which is the dev server and nothing else. |
| Other headers | `X-Content-Type-Options: nosniff`, `Referrer-Policy`, `X-Frame-Options`, `Permissions-Policy`, and `Strict-Transport-Security` in production only. |
| Cache semantics | Every path that is not a build asset is `no-store`, applied on every branch of the proxy including both redirects. Verified from the browser on the dashboard, the client directory, the payment register and a report. |
| Session cookie | `HttpOnly`, `SameSite=Lax`, `Secure` in production, `Path=/`. Verified by reading `document.cookie` in a signed-in browser and finding no session in it. |
| Privileged key | Absent from every JavaScript, HTML and JSON body the browser downloaded across five screens. No Supabase client runtime reaches the browser at all. |
| Rate limiting | Eleven actions, each with its own budget and its own documented failure stance. Sign-in refuses after its budget without naming the limit; an export refuses with `Retry-After` and publishes neither the limit nor the remaining allowance. |
| Rate-limit store | `rate_limit_counters` is RLS-on with no policies and every grant revoked. Unreachable through the API even with a valid key. |
| Service-worker cache | A closed allow-list of static assets. No page, no API response and no document of a signed-in session is ever cached; verified by walking six screens and then reading every cache entry. |
| Shared-machine isolation | Sign in, work, sign out: the caches hold nothing but static assets, and browser storage holds no token-shaped key. The next person's pages are not the previous person's. |
| Role isolation by URL | Each role asked for each route it lacks, by address rather than by clicking. Derived from `role_permissions` rather than assumed - the first draft of that test asserted a stricter policy than the product has, which is the dangerous direction. |
| Borrower confinement | A borrower asking for seven staff routes by address lands on the portal, sign-in or their own account, never the staff shell. |
| Anonymous access | Seven protected routes redirect to sign-in. The sign-in page itself carries no figure from any previous session. |
| Forced password change | An account holding an administrator-issued temporary password is redirected to the password form from every route, and cannot walk around it by typing another address. |
| Dependency audit | `npm audit --omit=dev`: 0 vulnerabilities. See the note below on the development-only chain. |
| Secret scan | The whole staged diff, plus every file the browser downloaded. Clean. |
| WCAG 2.1 AA | 32 screens at two viewports, axe, no violations and no allow-list. |

## Issues found and fixed in Phase 9

| Issue | Why it mattered | Fix |
| --- | --- | --- |
| `'unsafe-eval'` shipped in the policy of every build not labelled `production` | The gate was `NEXT_PUBLIC_APP_ENV`, a deployment *label*. A staging deployment is a `next build` artefact with no dev overlay in it and was being handed `eval` anyway - which is most of what a nonce-based policy exists to prevent. Found by reading the header off a real response in the end-to-end harness, which runs the production build under the label `test`. | Gated on `NODE_ENV === 'development'` instead, which is the dev server and nothing else. Two unit tests: one for the dev/production difference, one asserting that no build artefact gets it whatever it is labelled. |
| The session cookie was readable from `document.cookie` | `@supabase/ssr` omits `HttpOnly` because its *browser* client reads the session out of the cookie. This application has no browser client - every read and write is a Server Component or a Server Action - so that was a privilege nothing used and an injected script on a shared counter machine would. The policy is what stops such a script running; this is what it would have found if one ever did. | `hardenSessionCookie` sets `HttpOnly`, `SameSite`, `Secure` and `Path` on every write, in the proxy and in the server client. `lib/supabase/client.ts` was deleted, because a module sitting there invites the import that would silently break authentication - and removing it also dropped GoTrue, PostgREST's query builder and the Realtime client out of the browser bundle entirely, which is now asserted. |
| The proxy redirected signed-in callers away from every public path | Correct when `/login` was the only public path. The health endpoint is public and must answer whoever asks: a monitor holding a session cookie got a 307 to the dashboard and a page of HTML where it expected JSON. | `isSignedOutOnlyPath`, which is the sign-in page and nothing else. The offline page benefits too: a signed-in person with no network has more use for "the figures are unavailable" than for a dashboard that cannot load. |
| The rate limiter reported "Unknown limiter failure" for every database-side refusal | A `PostgrestError` is a plain object, not an `Error`, so a bare `instanceof Error` check reduced every cause to the same unexplained message. A misconfigured API key presented itself as an unexplained outage on the sign-in form, with nothing in the log to say which. | `describeLimiterFailure` extracts the code, message, details and hint from a PostgREST-shaped error, and names the constructor and keys of anything it still cannot read. Nothing of it is shown to the person. |
| Status badges failed WCAG AA contrast, all four of them in dark mode | Success 4.11:1, info 4.30:1 and warning 3.02:1 against their own badge tints in light mode; 2.74 to 3.13 for all four in dark mode, where the override had redefined the four surfaces and left the four text colours at their light-mode values. Every status badge in the application was dark ink on a dark tint, and none of it looked obviously wrong in a screenshot. 4.5:1 is the floor for 12px text, and these are read on a counter in daylight. | Lightnesses computed rather than chosen, in both modes. `tests/unit/colour-contrast.test.ts` recomputes the ratios from `app/globals.css`, so a token nudged for aesthetic reasons fails a test rather than a review. |
| A nested anchor on the overdue card | `PhoneValue linked` rendered an `<a href="tel:">` inside the card's own `<a>`. The parser closes the outer anchor at the inner one, so the markup the browser built was not the markup React rendered: hydration failed with React #418 and every control below the phone number stopped opening the loan. Not a security defect, but a screen that silently stops working is how a payment gets recorded against the wrong loan. | A stretched link, which keeps both tap targets and is valid HTML. Asserted two ways: no page nests one interactive element inside another, and no page reports a hydration mismatch. |
| A `<table>` wearing `sr-only` dragged the page sideways | `sr-only` hides by shrinking to 1px and clipping with `overflow: hidden`, and `overflow` has no effect on `display: table`. The chart's accessible table laid itself out at full width and, being absolutely positioned, took the document with it: 390px of phone showed 617px of page. | The `sr-only` moved to a block wrapper. Every staff screen is now asserted not to scroll sideways at 390px. |
| A missing record returned `200 OK` | A root `loading.tsx` made Next flush the response shell before the page had read anything, committing the status; `notFound()` then had nothing to set. The body said "not found" and the status said "here it is", which is what a monitor, a cache or a crawler reads. | The boundary removed, and the navigation feedback moved into the links themselves - better feedback than blanking a working screen. Four routes now assert a real 404. |
| A Mobile Money payment could reach the confirmation screen with no reference | `Continue` is a `type="button"`, so the browser's own `required` validation never ran. A cashier could select MTN, leave the reference blank, read the whole allocation, press "Record UGX ..." and only then be told. The reference is what stops the same transfer being recorded twice. | Included in the gate that enables `Continue`, with a test for the whitespace case and for switching back to cash. |
| A reversed payment's figure was not struck through on its own detail page | The register struck it and the borrower's own history struck it; the page a staff member opens *to look at the reversal* showed the amount plainly with a badge beside it. | `struck={isReversed}` at both sites on that page. |
| Every row of every list was prefetched | Next prefetches `<Link>` by default, so opening `/clients` downloaded twenty client pages nobody had asked for - 54 requests for one screen, 40 of them prefetches. On the office line that is invisible; on a phone on mobile data it is twenty pages of somebody's airtime and twenty round trips on the connection where a round trip is the expensive part. | `RowLink`, one primitive with `prefetch={false}` and the reason attached, applied to the eighteen per-row links across twelve components. The navigation keeps prefetching its fixed destinations, where the trade is worth it. |
| Focus was lost whenever a confirmation replaced a step | Every irreversible act is confirmed in two steps and the first step unmounts, so the control that was focused stopped existing and the browser dropped focus to `<body>`. A keyboard user was returned to the top of the document; a screen-reader user was told nothing at all. | `useFocusWhen` moves focus to the panel, which announces what the step is and how much money is about to change hands before offering the button that commits it. |
| `opacity-70` on a settled report row | Opacity dims everything inside the row, including a link with its own colour, and took it below the contrast floor. | `text-text-muted`, which is what the table variant already used: a muted *token* is a colour that was chosen to be readable, and anything with its own colour keeps it. |
| A figure in the portal's prose bypassed the shared money primitive | Two amounts were interpolated into a sentence with `formatUgx`, so the same amount read two ways on one screen. | Through `Money`, like every other figure. The sentence is now asserted with the composite-text matcher, which makes the same claim across element boundaries. |

## Known gaps after Phase 9

| Gap | Why it is acceptable for now |
| --- | --- |
| Five high-severity advisories in development dependencies | All one chain: `eslint-config-next` to `@next/eslint-plugin-next` to `fast-glob` to `micromatch` to `braces`, which is a stack-exhaustion denial of service through deeply nested glob patterns. There is **no patched version**: the advisory range is `<= 3.0.3` and 3.0.3 is the latest published release. npm's only offered fix is downgrading `eslint-config-next` from 16.3.8 to 14.2.35 - a major downgrade of the linter config for a Next 16 project, which would not fix it either. It is development-only, it runs in the linter, and the only glob patterns it ever sees are this repository's own. `npm audit --omit=dev` reports 0. |
| The auth service in the end-to-end harness is a shim, not GoTrue | GoTrue is distributed as a container and this project's sandboxes have no Docker. Everything the application's own code touches is the real thing: PostgreSQL with every migration applied from zero, the real PostgREST binary, Row Level Security, the `SECURITY DEFINER` functions, PostgREST's embedding rules, the JWT claims. The substitution is the service that issues the token, and the claims it issues are the ones a hosted project issues. |
| No Subresource Integrity, because there are no third-party scripts | Nothing is loaded from another origin. `strict-dynamic` plus a per-request nonce is what protects the scripts there are. If a third-party script is ever added, SRI becomes required. |
| The dashboard's time to first byte is about 1.2 s | The slowest thing in the application, and it is the portfolio and collection summary queries. Recorded as a baseline rather than optimised: the reporting figures are not something to change without evidence, and the figure was measured against a local database with no connection pooling. |
| No automated check that the Content-Security-Policy's nonce is attached to every script Next emits | The browser enforcement test proves the policy is enforced, and the no-violation sweep proves the application runs under it. A script Next emitted without a nonce would show up as a console violation in that sweep, which is asserted to be empty - so this is covered indirectly rather than directly. |

## Reporting

Security issues in this system should go to the Owner/Administrator directly,
not through a public issue tracker.
