# POLYTOS forced-password security certification — 3 November 2026

Verdict: **CONDITIONAL PASS with one defect fixed and not yet deployed.**

The boundary that PR #18 set out to build is standing in production for every
path that Row Level Security reaches, and the hosted Data API hook is
confirmed live. One class of path it does not reach was found to be open at
the database level and has been closed on the security branch. That fix is
**not** in production yet, so the release is not finished.

| # | Requirement | Verdict | Strongest evidence |
|---|---|---|---|
| 1 | Production migration and hook configuration | **PASS** | Production, SQL + hosted PostgREST logs |
| 2 | Real Supabase Auth test environment | **PASS** | Isolated, GitHub Actions — real GoTrue v2.197.0 + real PostgREST 12.2.3, green |
| 3 | Restricted accounts denied loans/payments/ledger/reports/RPCs | **PASS (RLS) / FAIL→FIXED (definer RPCs)** | Production SQL + isolated real-Auth HTTP, green |
| 4 | `ledger_account_balance`, `savings_withdrawable_amount`, `assess_meeting_fines` | **FAIL in production → FIXED on branch** | Production SQL |
| 5 | Password-change recovery remains accessible | **PASS** | Production SQL (hook allowlist exercised) + isolated HTTP/browser |
| 6 | Normal accounts retain legitimate permissions | **PASS** | Production hosted HTTP (live Owner/Admin session) |
| 7 | Anonymous access, cross-user isolation, Storage authorization | **PASS** | Anonymous production-verified (§3.6); Storage row-level isolated (§3.4) |
| 8 | Hosted PostgREST behaviour over real HTTP | **PARTIAL / BLOCKED** | Project's own request logs; see §5 |
| 9 | Production vs isolated vs blocked clearly separated | **PASS** | This document |

Nothing in this round reset a password, changed an authorization flag, created
an account, altered a financial record, relaxed a policy, disabled the hook,
merged PR #18 or deployed anything.

---

## 1. Evidence classes

Three kinds of evidence appear below and are never mixed.

**PRODUCTION-VERIFIED.** The hosted project **LENDING MANAGER**
(`fszgwemtgyrbhngajpzm`, PostgreSQL 17.11, eu-west-1). Two sub-kinds:

* *SQL* — statements run through the Supabase management API. Every
  authorization probe ran inside `begin … rollback`, impersonating a real
  account the way PostgREST does (`set local role authenticated`;
  `set local "request.jwt.claims"`). Reads only.
* *Hosted HTTP* — real requests over `https://fszgwemtgyrbhngajpzm.supabase.co`,
  read back from the project's own `edge_logs`, `postgrest_logs` and
  `postgres_logs`. These were made by the account holder's own browser
  session, not by this certification.

**ISOLATED.** The repository's `security release rehearsal (PostgreSQL 17,
real Auth)` CI job: PostgreSQL 17, **real Supabase Auth (GoTrue v2.197.0)**
and the **real PostgREST 12.2.3** binary with the reviewed `db-pre-request`
hook configured, on a disposable database seeded synthetically. Tokens are
issued by GoTrue's own password grant. No hosted project is involved.

**BLOCKED.** Stated with the reason, in §5.

---

## 2. Production verification of the migration and the hook

**PASS — production-verified.**

Migration `20261030180224_forced_password_authorization_boundary` is recorded
in `supabase_migrations.schema_migrations`, alongside `20261030115530`.

The hook is configured on the role PostgREST connects as:

```
authenticator → session_preload_libraries=supautils, safeupdate
                statement_timeout=8s
                lock_timeout=8s
                pgrst.db_pre_request=public.enforce_password_change
```

No other role carries a `pgrst.*` setting, so no pre-existing hook was
displaced — the chaining concern recorded in the release gates does not apply.

**The branch and production differ by exactly one migration.** Production's
`schema_migrations` holds **160** versions; the branch holds **161** files, and
the set difference is the single entry `20261103000100` — the guard from §3.5,
which is not deployed. Nothing else has drifted in either direction.

**Zero drift.** Every function body the migration defines is byte-identical in
production to the file on the branch (MD5 of `pg_proc.prosrc` against the
migration source):

| Function | MD5 | Bytes |
|---|---|---|
| `current_profile_id` | `27b628e6b575e3321edc9dd8188a0f1f` | 142 |
| `current_session_context` | `b58f5fb295b98acec2b144a942ca7b55` | 1277 |
| `record_sign_in` | `5996980b9e3a66c0ea4fa408fe5ac032` | 609 |
| `record_security_event` | `865a0f2c30fc5fd8e58e88b6fb483b6a` | 968 |
| `enforce_password_change` | `88860236af4ac11ff95bd3fa89b5ba36` | 849 |

`enforce_password_change` is `security invoker`, returns `void`, pins
`search_path = ''`, and is executable by `anon`, `authenticated` and
`service_role` — as designed for a pre-request hook.
`confirm_password_change(uuid)` remains executable only by `service_role` and
the owner, so no browser session can clear the flag.

**The hook is live, not merely configured.** This was the weakest claim in the
previous report and it is now settled from the project's own logs. The install
transaction (`postgres_logs`, 2026-11-02T12:22:01Z) ran the `ALTER ROLE
authenticator SET pgrst.db_pre_request` and ended with
`NOTIFY pgrst, 'reload config'`, and `postgrest_logs` records the hosted
server acting on it seconds later:

```
12:22:02.046  Received a schema cache reload message on the "pgrst" channel
12:22:02.068  Received a config reload message on the "pgrst" channel
12:22:02.399  Config reloaded
12:22:05.204  Schema cache loaded 129 Relations, 120 Relationships, 183 RPCs
```

That install transaction also carried its own in-transaction validation, which
had to pass for the migration to commit: with a forced subject's claims,
`current_profile_id()` was null and `enforce_password_change()` raised
`insufficient_privilege`; the allowlisted `/rpc/current_session_context` path
passed; and with a normal active subject both the helper and the hook passed.

---

## 3. The boundary in production

### 3.1 Restricted accounts — Row Level Security paths: PASS

The two forced accounts were **inspected only**. Neither was modified.

| Account | Role | Status | `must_change_password` | Linked | Last sign-in |
|---|---|---|---|---|---|
| Nakato Winnie Birungi | `secretary_treasurer` | active | **true** | yes | never |
| Ssemakula Brian Kato | `manager` | active | **true** | yes | never |

Impersonating **Ssemakula Brian Kato** (forced Manager) in a rolled-back
transaction against real production data:

| Probe | Result |
|---|---|
| `current_profile_id()` | **null** |
| `user_has_permission('loans:view')` | **false** |
| `public.loans` | **0 rows** |
| `public.loan_payments` | **0 rows** |
| `public.journal_lines` | **0 rows** |
| `public.savings_accounts` | **0 rows** |
| `public.clients` | **0 rows** |
| `public.ledger_accounts` | **0 rows** |
| `storage.objects` | 0 rows — but see §3.4: production holds no objects at all, so this row proves nothing on its own |

### 3.2 Normal accounts retain their permissions: PASS

Same method, impersonating **Mwesigwa Trevor** (active `owner_admin`):

| Probe | Result |
|---|---|
| `current_profile_id()` | `83944cea-…644f6` |
| `user_has_permission('loans:view')` | **true** |
| `public.loans` | **35 rows** |
| `public.loan_payments` | **470 rows** |
| `public.journal_lines` | **1667 rows** |
| `public.savings_accounts` | **5 rows** |
| `public.clients` | **28 rows** |
| `public.ledger_accounts` | **35 rows** |
| `storage.objects` | 0 rows — the store is empty for everyone |

This is corroborated over **real hosted HTTP** by the account holder's own
session after the hook went live (`edge_logs`, 2026-11-02T12:28–12:29Z):
`POST /rest/v1/rpc/current_session_context` 200, `GET /rest/v1/loans` 200,
`GET /rest/v1/loan_portfolio_report` 200, `GET /rest/v1/payment_register` 200,
`GET /rest/v1/dashboard_portfolio_summary` 200,
`GET /rest/v1/dashboard_collection_summary` 200,
`GET /rest/v1/branch_cash_position` 200, `GET /rest/v1/collections_today` 200,
`POST /rest/v1/rpc/savings_summary` 200, `GET /rest/v1/clients` 200. The hook
does not interfere with legitimate work.

### 3.3 Recovery stays reachable: PASS

Exercised directly against production, impersonating **Nakato Winnie Birungi**
(forced Secretary/Treasurer) in a rolled-back transaction. The recovery
bootstrap answers:

| Probe | Result |
|---|---|
| `current_session_context().outcome` | `ok` |
| `.must_change_password` | **true** |
| `.role_keys` | `{secretary_treasurer}` |

And the hook itself was called on each path in turn. Any refusal raises and
aborts the transaction, so reaching the end is the proof:

* `POST /rpc/current_session_context` — permitted
* `POST /rpc/record_sign_in` — permitted
* `POST /rpc/record_security_event` — permitted
* `POST /rpc/consume_rate_limit` — permitted
* `GET /rpc/polytos_readiness` — permitted
* `GET /company_identity` — permitted
* `GET /loans` — **refused**, SQLSTATE `42501`, *"Business access requires an
  active account with a completed password change."*

So the allowlist is exactly the recovery surface and nothing else. `confirm_password_change(uuid)` stays
service-role-only, and the profile column guard still refuses any attempt to
clear the flag by editing the row. Supabase Auth (`/auth/v1`) is a separate
service the hook does not intercept, so sign-in, token refresh and sign-out
are unaffected.

### 3.4 Storage authorization: PASS

All six buckets — `benefit-documents`, `client-documents`, `company-assets`,
`guarantor-documents`, `loan-documents`, `membership-consent` — are private.
Every `storage.objects` policy granted to `authenticated` resolves through
`user_has_permission(...)` or `current_profile_id()`, both of which stop
resolving for a restricted account, so the boundary reaches the document store
without a storage-specific change. `company-assets` has no `authenticated`
policy at all.

**The production part of this is structural, not row-level, and deliberately
not claimed as more.** All six buckets currently hold **zero objects**, so the
forced Manager's "0 rows" from `storage.objects` in §3.1 is vacuous — the
active Owner/Admin sees 0 as well. What production establishes is that every
policy's predicate depends on a helper the boundary has already closed.

The row-level claim is established in isolation instead, in
`tests/db/forced-password-authorization.test.ts`: an object is placed in
`client-documents`, a staff account reads it, the flag goes up, the same
account reads **no rows** and cannot insert into `loan-documents`, and a
confirmed password change restores the read. Hosted Supabase Storage is a
separate service the Docker-free harness does not run, so there is no
hosted-endpoint Storage evidence in this round.

### 3.6 Anonymous access: PASS — production-verified

Anonymous is refused at the **grant** level, before Row Level Security is
reached. Impersonating `anon` in production, `select count(*) from public.loans`
raises `42501: permission denied for table loans`.

| Relation | `anon` SELECT | `authenticated` SELECT |
|---|---|---|
| `public.loans` | **no** | yes |
| `public.loan_payments` | **no** | yes |
| `public.journal_lines` | **no** | yes |
| `public.savings_accounts` | **no** | yes |
| `public.clients` | **no** | yes |
| `public.profiles` | **no** | yes |
| `public.audit_log` | **no** | yes |
| `public.ledger_account_balances` | **no** | yes |
| `public.loan_portfolio_report` | **no** | yes |
| `public.company_identity` | **no** | yes |
| `storage.objects` | yes (Supabase default) | yes |

`storage.objects` is the one relation `anon` may select, which is Supabase's
own default grant; it is held by Row Level Security instead, and **every**
storage policy in this schema targets `{authenticated}` only, so no policy
admits an anonymous caller and the read yields nothing.

Anonymous holds EXECUTE on none of the financial RPCs:

| Function | `anon` EXECUTE |
|---|---|
| `ledger_account_balance` | **no** |
| `savings_withdrawable_amount` | **no** |
| `savings_pledged_amount` | **no** |
| `assess_meeting_fines` | **no** |
| `approve_loan` | **no** |
| `confirm_password_change` | **no** |
| `current_session_context` | **no** |
| `polytos_readiness` | yes — by design, the readiness probe |
| `enforce_password_change` | yes — by design, it is the pre-request hook |

Note that `company_identity` is **not** anon-readable either. The recovery
allowlist admits `GET /company_identity` for an *authenticated* forced
session, not for a logged-out visitor; the login shell is server-rendered, so
it does not depend on an anonymous read of it.

### 3.5 DEFECT — the financial definer RPCs had no authorization of their own

**FAIL in production (database level). Fixed on the branch; not yet deployed.**

Row Level Security does not apply inside a `SECURITY DEFINER` function: it
runs as its owner. These functions ask nothing about who is calling, so their
only protection was the pre-request hook. With the **same forced Manager
identity that saw zero rows everywhere above**:

| Call | Result as a forced account |
|---|---|
| `savings_withdrawable_amount(<real account>, current_date)` | **140000** — a real member balance |
| `ledger_account_balance(<real account>)` | `0` — executed, not refused |
| `savings_pledged_amount(<real account>, current_date)` | `0` — executed, not refused |
| `assess_meeting_fines(<absent id>)` | `0` — executed, not refused |

`assess_meeting_fines` is `VOLATILE` and posts fines, so this was a write path
as well as a disclosure path.

Over the hosted Data API these calls are refused, because the hook is live —
which is why this is a hardening and not a live breach. The reason it still
matters is that **the hook is a role setting and no migration installs it**:

* a project rebuilt, restored or cloned from these migrations gets the RLS half
  of the boundary and none of the RPC half, silently;
* `alter role authenticator reset pgrst.db_pre_request` removes the RPC
  boundary with no error and nothing in the schema to notice.

**The fix** —
`supabase/migrations/20261103000100_definer_rpc_business_identity.sql` — adds
`public.require_business_identity()`, which raises `42501` with the same
sentence the hook uses, and calls it as the first statement of
`ledger_account_balance`, `savings_withdrawable_amount`,
`savings_pledged_amount`, `assess_meeting_fines` and `client_has_live_loan`.
Callers with no verified token (`service_role`, migrations, the bootstrap
script, seeds) are exempt, exactly as `profiles_guard_privileged_columns()`
exempts them. No grant is widened, no policy relaxed, and every signature,
default, volatility and result shape is preserved. None of the five is used in
any RLS policy or CHECK constraint, so no policy evaluation can start raising.

Two of them were `language sql` and are now `plpgsql`, because a guard that
raises has to be a statement. The cost is that they no longer inline into a
surrounding query; at 35 loans and 5 savings accounts that is not a trade worth
leaving a disclosure open for.

**Deliberately not guarded**, and recorded as residual rather than changed
quietly: `validate_loan_for_approval` (guarding it means restating a
two-hundred-line loan-approval rule in a migration — a transcription slip
there is worse than the failure-code disclosure it would close), and the
configuration and policy-metadata helpers `business_now`, `business_timezone`,
`active_membership_policy_id`, `membership_policy_allows`,
`membership_governing_policy`, `savings_account_governing_policy`,
`membership_terms_are_accepted`, `membership_fee_is_posted`,
`benefit_expense_account`, `benefit_blocked_reason`, `benefits_blocked_reason`,
`member_lending_blocked_reason` and `redeem_membership_consent_code`. Several
are called from trigger and constraint paths where a raise would turn a
silent, correct denial into an error. All remain covered by the hook.

---

## 4. Isolated verification — real Supabase Auth over real HTTP

**Environment:** the existing `security release rehearsal (PostgreSQL 17, real
Auth)` CI job — PostgreSQL 17, real GoTrue v2.197.0 (checksum-pinned), real
PostgREST 12.2.3 with `db-pre-request = public.enforce_password_change`.

`tests/e2e/specs/real-auth.release.spec.ts` already covered two-tab renewal
past JWT expiry, administrator reset into forced recovery, password change,
logout, refresh invalidation, and inactive/suspended denial after refresh.
This round adds three cases that drive **GoTrue-issued** tokens (asserted to
carry `role: authenticated` and a `sub` GoTrue chose) against the real
PostgREST binary:

1. **The whole protected surface flips to 403/`42501` on a forced flag** — with
   one unexpired real Auth token, across `/loans`, `/loan_payments`,
   `/journal_lines`, `/savings_accounts`, `/clients`, `/audit_log`, the report
   projections `/ledger_account_balances`, `/loan_balances`,
   `/loan_portfolio_report`, `/dashboard_collection_summary`,
   `/income_register`, `/expense_register`, and the RPCs
   `/rpc/ledger_account_balance`, `/rpc/savings_withdrawable_amount`,
   `/rpc/savings_pledged_amount` and `/rpc/assess_meeting_fines`. The same test
   asserts what was permitted beforehand, so a fixture fault cannot masquerade
   as the boundary working; that recovery stays reachable on the same token;
   that self-clearing the flag and calling `confirm_password_change` are both
   403; and that a confirmed change restores exactly what was permitted before.
2. **Cross-user isolation** — a borrower linked to one seeded client sees their
   own loan, strictly fewer loans than the owner-counted total, and no payment
   belonging to another borrower; an unlinked portal account sees none; the
   borrower sees nothing once forced.
3. **Anonymous access** — no business table, report projection or financial RPC
   yields a row to an anonymous caller.

`tests/db/forced-password-authorization.test.ts` adds twelve database-level
cases for the new guard: each of the five guarded RPCs refusing a forced caller
with `42501` while answering an identified one; all five refusing `inactive`
and `suspended` callers; the trusted no-token path still working (so seeds,
triggers and server actions do not break); the guard being a definer that no
client role may call; and the Storage, anonymous and borrower-isolation cases.

Storage is tested at policy level rather than over HTTP, because hosted
Supabase Storage is a separate service the Docker-free harness does not run.

**Local results (PostgreSQL 16, this sandbox, with the new migration
applied from zero):** `npm run test:db` — **1,898 passed, 0 failed** across
all five database projects (1,816 + 18 + 15 + 24 + 25). The forced-password
file alone is 25 passed, of which 12 are new. `npm run typecheck`,
`npm run lint` and `npm run format:check` are clean.

PostgreSQL 16 is this sandbox's only available server; PostgreSQL 17 and the
real-Auth/PostgREST evidence run in CI, which is the authoritative run on the
PR head.

### CI results — all four jobs green, deterministically

**Authoritative run: 41592055460, head `b7b1a4b`, conclusion success.** This is
the run to cite: it is the first all-green run in which every assertion is
deterministic. The earlier green run (41588722855 at `03e72c5`) carried one
non-deterministic pass — see the correction below.

| Job | Result |
|---|---|
| checks, unit/integration, build | **success** — 2,647 unit/integration tests, typecheck, lint, format, money audit, secret scan, production build, bundle assertions |
| database (real PostgreSQL 17.11) | **success** — **1,898 tests** (1,816 + 18 + 15 + 24 + 25), plus the upgrade check's 28 identical financial figures |
| security release rehearsal (PostgreSQL 17, real Auth) | **success** — **34 rehearsal checks**, then **14 of 14 Playwright tests** against real GoTrue v2.197.0 and real PostgREST 12.2.3 |
| browser E2E (production build, fresh seed) | **success** — 910 passed, 48 skipped |

Any commit after `b7b1a4b` on this branch is documentation only. The release
gate's requirement of green CI on the **exact merged head** is §7 step 4, and
belongs to whoever merges, not to this document.

**The rehearsal's 34 checks** ran on PostgreSQL 17.11 against the real
PostgREST binary, and include the three that replaced the old
bypass-reproduction assertion:

* `Before activation, a guarded financial definer RPC refuses on its own`
* `Before activation, an un-guarded definer RPC still answers, so the hook remains mandatory`
* `Before activation, a table route answers with no rows rather than refusing`

alongside, after activation,
`Forced request denied: /loans?select=id&limit=0`,
`… /rpc/savings_pledged_amount?…`,
`… /rpc/membership_governing_policy?…`,
`Normal Owner table reads preserved`,
`Chaining preserves existing hook in real HTTP context`,
`Role config reload overrides environment hook and enforces denial`,
`Storage object RLS permits the normal Owner`,
`Storage object RLS denies the forced account without a PostgREST hook`,
`Readiness works for a forced JWT`, the four recovery-path allowances, and
`Financial records, schedules and policy records unchanged through rehearsal`.

**The 14 real-Auth Playwright tests** all passed, among them the three added
this round, driving GoTrue-issued tokens against real PostgREST:

* `real Auth JWT: the whole protected surface flips to 403 on a forced flag`
* `real Auth JWT: a borrower reads only their own records, and none when forced`
* `real Auth stack: an anonymous caller reaches no business route`

The harness logged `Synthetic fixtures provisioned through real Auth; no
credentials logged.`

### A flaky test of my own, and the correction

The run above was green, but one of its passes was luck, and that is worth
stating rather than leaving in the record as a clean result.

Re-running the identical code on a **documentation-only** commit
(`fdb5bd7`, run 41591197722) failed the new borrower-isolation case:

```
Error: the borrower sees their own loan
  real Auth JWT: a borrower reads only their own records, and none when forced
```

The fault was the test's, not the boundary's. `loans_select_own_or_register`
shows a borrower their own client's loans **only** in the four statuses
`approved`, `active`, `cleared` and `cancelled` — a draft or one awaiting
approval is correctly invisible to them. The test picked the first seeded
client holding *any* loan, and the seed generates fresh ids on every run, so
whether that client's loan happened to be in a visible status was down to
which UUID sorted first.

The fixture now selects a client by what the policy actually exposes, and the
assertion is tightened from "contains my loan" to "is exactly my client's
exposed loans, sorted" — nothing missing and nothing extra, which is the
isolation claim in both directions. The skip condition and the
strictly-fewer-than-total check are keyed to the same set.

No assertion was weakened and nothing was skipped to get green: a test that
depended on seed ordering was made deterministic. A security gate that passes
on a coin toss is worse than one that fails.

Measured on a seeded book, the old fixture query matched **11** candidate
clients and the corrected one matches **10** — the single excluded client held
only a `draft` and a `pending_approval` loan. With `order by c.id limit 1` over
freshly minted UUIDs that is roughly a one-in-eleven failure per run, which is
exactly the observed "passed once, failed next time". Seed status mix:
`active=9, approved=1, cleared=2, draft=1, pending_approval=1`.

The corrected case passes in run 41592055460 (`✓ 13 … 403ms`), with all 14
real-Auth tests green.

### What the first CI run caught

The first run of the guard failed two jobs, and both failures were worth
having. Neither is labelled a pass.

* **`database`** — `verify-membership-upgrade.mjs` splits the migration set
  into an "existing deployed schema" applied first and the Polytos phase
  migrations applied on top, by filename prefix. `20261103000100` matched no
  phase prefix, so it ran before Phase 2 and failed on its own row-type
  declarations: `type "public.savings_accounts" does not exist`. It belongs in
  the upgrade set, because it is not deployed. Moving it there also improves
  what the script measures: the guard now lands on a seeded book between the
  two financial baselines, and **all 28 financial figures are identical**
  across 97 existing migrations plus 64 new ones, with 8 new ledger accounts
  all at zero. An authorization guard moving no money is now measured rather
  than asserted.
* **`security release rehearsal`** — `AssertionError: Before activation, RLS
  identity alone does not gate scalar definer RPC`. That assertion existed to
  *reproduce* the vulnerability, and the guard makes it false. It is replaced
  by three checks that state which parts of the old argument still hold: a
  guarded financial RPC now refuses on its own before the hook is activated;
  an un-guarded one still answers, so **the hook remains mandatory**; and a
  table route still answers 200 with no rows rather than refusing. The
  un-guarded RPC joins the post-activation denial sweep.

One test-design fault was corrected in the same pass: the harness runs GoTrue
with `GOTRUE_JWT_EXP=60`, and the new sweep carried one token through every
phase, so a 401 from a token that merely aged out would have been
indistinguishable from the boundary refusing. Each phase now takes a fresh
password grant, and the same-token claim is made explicitly immediately after
the flag goes up.

---

## 5. BLOCKED, with reasons

* **Authenticated hosted HTTP against production, driven by this
  certification.** Three independent blocks: the sandbox's egress policy
  refuses `CONNECT fszgwemtgyrbhngajpzm.supabase.co:443` (gateway 403), so no
  HTTP request to the project can leave this environment at all — not even an
  anonymous one; the two forced accounts' passwords are not available and
  resetting them was not authorized; and the project exposes no legacy JWT
  secret through SQL, so a token cannot be minted. What stands in its place is
  the project's own request logs (§2, §3.2), which show the hook loaded and
  legitimate traffic unaffected, plus the isolated real-Auth HTTP evidence.
* **A hosted 403/`42501` from a real forced session.** No forced account has
  ever signed in (`last_sign_in_at` is null for both, and no `42501` appears in
  the project's logs), so the denial has not yet been exercised in production.
  §7 gives the exact check to run.
* **Local real-Auth/PostgREST rehearsal in this sandbox.** `apt.postgresql.org`
  and `www.postgresql.org` are refused by the egress policy, and GitHub release
  downloads are scoped to this repository, so PostgreSQL 17, GoTrue and
  PostgREST binaries cannot be fetched here. This is why the real-Auth evidence
  runs in GitHub Actions, where those downloads already work.
* **Previously recorded gates P5-01 … P5-10** (precise identity, cookie
  attributes, private-window routes, natural renewal, hosted borrower and
  cross-branch isolation with approved principals) remain as recorded in
  `POLYTOS-FORCED-PASSWORD-SECURITY.md`. Nothing here closes them.

---

## 6. Observations, not defects

* **`company_settings` 401 for an unauthenticated shell.** At
  2026-11-02T18:40:30Z a `GET /rest/v1/company_settings` returned **401**
  (`permission denied for table company_settings` in `postgres_logs`) where the
  same request returned 200 inside a live session at 12:28. That is correct
  authorization — an expired or absent session has no grant on that table — and
  it is the reason `company_identity` exists as the public branding
  projection. Note that `company_identity` is not anon-readable
  either (§3.6), so the fix for a logged-out branding fetch is to render it on
  the server rather than to switch relations. Not a security finding.
* **`ledger_account_balance` is executable by every active authenticated role**,
  including a borrower, with no capability check. The new guard closes it to
  *restricted* accounts, which is this release's scope; narrowing it to a
  finance capability is a separate product decision and is not changed here.
* **`__gate_probe`** disposition remains open exactly as previously recorded.
* **Supabase's own security advisors** on the production project report four
  findings, none new and none caused by this work: `security_definer_view`
  (ERROR) — the known `company_identity` branding projection;
  `authenticated_security_definer_function_executable` (WARN) — Supabase
  flagging the very class of issue §3.5 closes;
  `auth_leaked_password_protection` (WARN) — **disabled**; and
  `rls_enabled_no_policy` (INFO).
* **Leaked-password protection is worth turning on.** For a system that issues
  administrator-set temporary passwords and then requires the holder to choose
  their own, having GoTrue reject a known-breached choice is a direct
  improvement to the mechanism this release exists to protect. It is an Auth
  setting, not a schema change, and was not altered here.

## 6a. Production integrity after this certification

Re-read after every probe, to show the probes left nothing behind:

| Check | Value |
|---|---|
| Forced accounts | 2 — both still `active`, `must_change_password = true` |
| `password_set_at` on both | `2026-10-08 08:41:16+00` (unchanged) |
| `last_sign_in_at` on both | null (never signed in) |
| Roles per forced account | 1 each (unchanged) |
| `public.loans` | 35 |
| `public.loan_payments` | 470 |
| `public.journal_lines` | 1667 |
| Migration history | 160 rows |

No password was reset, no flag changed, no account created, no financial row
written, no policy or grant altered, and the hook was never disabled. Every
authorization probe ran inside a transaction that was rolled back.

---

## 7. Remaining live-production checks before releasing PR #18

In order. The first is new in this round.

1. **Apply the second migration.** `20261103000100_definer_rpc_business_identity`
   to **LENDING MANAGER (`fszgwemtgyrbhngajpzm`) only**, after review. Until it
   is applied, production and this branch disagree, and the definer RPCs
   continue to depend solely on the hook. Do not reapply `20261030180224` or
   `20261030115530`.
2. **Re-confirm no drift** after that apply, the same way as §2, and re-run the
   §3.5 probe: `savings_withdrawable_amount` under a forced identity must then
   raise `42501` instead of returning a balance.
3. **Exercise the hosted denial once, over HTTP.** This is the one piece of
   evidence that only an account holder can produce. With the holder of one
   forced account present and consenting, sign in and — without clearing any
   flag — confirm `GET /rest/v1/loans` returns **403** with code `42501`, that
   the change-password screen is reachable, and that the change completes and
   restores access. Never clear a flag to make a test pass.
4. **Green CI on the exact PR head**, all three required jobs plus the security
   rehearsal, with no force-merge or bypass.
5. **Deploy application code after the database**, so rolling back code alone
   cannot remove the boundary.
6. **Separate authorization** remains required for anything touching
   `__gate_probe`, existing accounts, passwords, financial records or
   Policy 2.0 activation.

Until step 1 is done, this release is **not** complete.
