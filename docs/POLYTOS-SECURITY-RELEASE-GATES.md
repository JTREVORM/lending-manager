# POLYTOS final security release gates

Date: 31 October 2026, Africa/Kampala. Decision: **NO-GO for production execution**.
This package continues PR #18 at `d9c1971e54362ee4851134306b1e78fb385e3372`.
No production authorization has been granted. No production migration, reload,
configuration change, merge, deployment, account change or financial write was
performed. Only the LENDING MANAGER connection was used for hosted reads.

## Executed isolated evidence

Local runtime: PostgreSQL **17.11**, Node **24.22.1**, real PostgREST **12.2.3**
and the official real Supabase Auth **v2.197.0** binary. The Auth download is
pinned in CI and checked against SHA-256
`b5c2991d1df760c9b099c1c2395a94bd1c2f83ed58901934921997179dc9f7ea`.
The production Auth/PostgREST versions and private Auth settings were not
available through the current connectors; exact hosted parity is NOT claimed.

`scripts/rehearse-security-release.mjs` passed **31 assertions** on the
disposable `lending_release_gate` database. It installs only canonical source
migrations before the security migration, then adds the nine historical version
discrepancies as fixture metadata. It does not copy hosted rows or credentials.

- Environment-provided hook visible in an allowlisted configuration dump.
- Actual HTTP request context: path `/rpc/release_context_probe`, method GET.
  The real-Auth gateway HTTP test also sends an external `/rest/v1/rpc/...`
  request and observes the upstream `/rpc/...` path in the request GUC.
  Diagnostic probe functions exist only in disposable databases.
- Existing hook executes before the composed security gate in real HTTP.
- Injected exception AND SIGKILL before commit leave no canonical entry or
  committed migration. Successful application records the canonical version
  once; replay is rejected. Every earlier history row remains unchanged.
- All public table counts and sorted-row fingerprints are unchanged by the
  migration. Public/Storage RLS policy definitions are unchanged.
- Before activation, the financial scalar definer RPC remains callable despite
  the new RLS identity restriction. This explicitly proves why activation is
  mandatory rather than inferred from table denials.
- Role configuration overrides the environment fallback after
  `NOTIFY` reload; forced table and financial RPC requests return HTTP 403.
- Normal Owner table access, forced recovery bootstrap, sign-in stamping,
  closed-vocabulary security audit, rate limiting and readiness remain usable.
- A normal Owner sees a private Storage fixture through Storage RLS; the
  forced account sees zero rows, with no PostgREST hook involved in that query.
- SIGKILL/restart of PostgREST after activation preserves the persisted gate.
  Financial, schedule and policy fingerprints remain unchanged afterward.

`tests/e2e/specs/real-auth.release.spec.ts` passed **11 tests**, including six
role/setup checks, against a real Auth server rather than the shim:

- Real Owner, Manager, Secretary/Treasurer and borrower login.
- A configured **60-second JWT lifetime**, observed from the session rather
  than assumed. Two tabs reload concurrently after expiry; both remain
  authenticated, token expiry advances, both tokens rotate, and Owner
  authorization remains available.
- Owner uses the actual application password-reset Server Action for a
  disposable Manager. The original password is rejected; the issued temporary
  password reaches only recovery. Direct financial API access returns 403.
- The Manager completes current-password verification, Auth password update
  and service-only database confirmation. The temporary password is then
  rejected; normal financial reads resume.
- Logout denies protected pages and the logged-out session's refresh token.
- Inactive and suspended profiles remain denied by the Data API after real
  Auth token refresh.
- Anonymous readiness returns HTTP 200 / JSON true and application health
  returns HTTP 200 with no-store headers.

These are isolated results, not hosted-account certification. Short-lived
access JWTs are not claimed to be immediately revoked by logout. Production
passwords and flags were not changed to obtain evidence.

## Exact-head CI

All existing required CI jobs must run on this PR's new head. A fourth job,
`security release rehearsal (PostgreSQL 17, real Auth)`, provisions PostgreSQL
17, verifies the pinned Auth archive, runs the scoped rehearsal, then executes
the real recovery/session suite. The ordinary shim suite skips this explicitly
opt-in real-Auth spec; those skips are NOT counted as real-Auth passes.

The exact completed run IDs, source SHA and job conclusions are recorded in
PR #18's execution summary/Checks. The earlier green d9c1971 run is historical
evidence and is not substituted for the updated head. No required check was
removed or bypassed.

Intermediate head `988170ceffa982208533fcab02d121a27600aa56` passed the new
PostgreSQL 17/real-Auth job in both runs. Its full database job exposed 41
failures in five existing payment suites: those fixtures expected ten
three-day collections while the real 31 October clock produced nine before
the exclusive 30 November boundary. The suites now explicitly use the existing
owner-only business clock at 1 October 2026. The helper verifies that the clock
is effective and resets it when the isolated pool closes. As disbursement is
stamped from now(), the same suites explicitly re-anchor only fresh disposable
loan fixtures using the existing schedule-suite pattern, before any payment.
That rewrite is transactional, with guards re-enabled before real generation.
No production financial formula, schedule generator, migration or expected
monetary assertion was changed.

## Migration review and scoped executor

The application migration is unchanged. File:
`supabase/migrations/20261030180224_forced_password_authorization_boundary.sql`.
Exact SHA-256:
`25a45d120ba0083bf5b1af1e983e0f0313088ccc359bf257bb13b274cc4c2c5e`.

Its function signatures match the hosted catalog. The profile password flag
is non-null boolean; the existing functions retain their ACLs under
CREATE OR REPLACE. New hook: invoker, void, empty search path, explicit grants.
The service-only confirmation ACL is unchanged. The migration changes function
definitions/grants/comments only; CREATE FUNCTION does not execute the DML in
its body. It contains no top-level financial/account/policy row mutation.

`scripts/lib/scoped-security-migration.mjs` exports a connection-injected
executor; importing it does not connect or execute SQL. It checks the reviewed
file checksum, starts one transaction, applies timeouts and an advisory lock,
refuses an existing version, executes only that file, and inserts
`version=20261030180224`, `name=forced_password_authorization_boundary`, and
`statements=[exact SQL]` in the same transaction. Errors roll back both DDL
and history. The beforeCommit callback exists for interruption testing.

This module is NOT a production launcher. Production connection binding,
project/ref verification and use require separate explicit approval. Do not
bulk-push migrations, repair/delete any of the nine older entries, or reapply
readiness. No standalone production command was executed.

## Effective PostgREST configuration

Hosted read-only observation: PostgreSQL 17.11, security migration absent,
readiness present. No persisted pre-request/pre-config/db-config setting was
found in pg_db_role_setting. The SQL observer's current_setting is NULL.
This does NOT inspect a running worker's environment or cached configuration.

A hosted operator/Supabase support must provide a redacted report containing
ONLY: PostgREST version, effective db-pre-request/db-config/db-pre-config,
the corresponding PGRST environment values, configuration-file values, and
whether an existing pre-config function supplies an override. Never export
JWT secrets, database URLs/passwords, API keys or full environment dumps.

The isolated rehearsal demonstrated a redacted `--dump-config` inspection.
Important observed behavior: PostgREST 12.2.3 binds a socket even for this
command. A second process on the worker's listening port fails. Our diagnostic
uses an isolated ephemeral port and prints only the hook line. A fresh dump
is not proof of an already-running worker's cached state; actual HTTP checks
after reload are required. No dump was attempted on a hosted worker.

Supabase's external URL includes `/rest/v1`. The gateway strips that prefix
before forwarding to PostgREST, as the repository's gateway and actual HTTP
context demonstrate. The migration's allowlist correctly uses `/rpc/...`
and `/company_identity` in the observed upstream context. A documentation
example containing the external prefix is not evidence that the upstream GUC
contains it. Hosted path behavior still needs the approved rollout smoke test;
do not add financial routes to the recovery allowlist to fix a path mismatch.

Supported hosted activation, AFTER approval and confirmation of the existing
effective hook:

If effective db-config is false, or a pre-config function overrides the proposed
setting, STOP. Role SQL alone cannot establish activation in that configuration.
Obtain a separately authorized, hosted-supported configuration change and
rehearsal rather than assuming the environment fallback has been replaced.

```sql
ALTER ROLE authenticator
  SET pgrst.db_pre_request = 'public.enforce_password_change';
NOTIFY pgrst, 'reload schema';
NOTIFY pgrst, 'reload config';
```

If an existing hook is found, use one reviewed invoker wrapper that calls the
existing hook and the new gate, preserves existing behavior and propagates all
errors. The rehearsal proves this pattern. Do not overwrite an existing hook,
use a comma-separated list, catch-and-ignore failures, or assume a catalog
setting proves every worker has reloaded.

## Storage and other surfaces

The hook is a PostgREST boundary, NOT a Storage/Realtime/Auth gateway hook.
Storage object RLS denies the forced principal independently in the executed
database test. A real Storage service upload/download/signing API and previously
issued signed URLs were NOT exercised. Signed URL behavior must not be
presented as account-state revocation evidence.

Hosted read-only catalog observation: no pg_graphql extension/real resolver,
and no public/storage tables in publications. The graphql_public wrapper is
invoker, reports the extension disabled and does not call a resolver. This is
bounded catalog evidence, not an end-to-end GraphQL/Realtime service test.
Recheck before release if those surfaces are enabled.

## Vercel inspection and remaining hold gate

Observed existing project: `prj_1qpwIN5eEEDrsmcJzWJ9Cq5owwal`,
team `team_eFoHugEYsyJpUwYM5SwAmrHp`, Node 24.x, Git repository
JTREVORM/lending-manager. Current production is READY deployment
`dpl_9W4nfLXRQw3canjyjeVmL6AgiYeX`, source
`b7f2aa700e1f9ecc54a9f5f833e440aae293a5be`, region dub1.

The main verified project domain has no branch override. The source disables
Git deployments for the two draft branches, NOT the production branch.
The connector did not expose an effective auto-assignment/auto-promotion
setting. No staged deployment or promotion was created to test it.

Thirty anonymous /api/health GETs across the enumerated aliases and immutable
deployment hosts: one main production host returned 200; 29 redirected to
vercel.com (302). This proves anonymous protection for those observations,
not maintenance enforcement for authenticated Vercel users, bypass credentials,
server actions, or hosts outside the inventory. No bypass token was used or
created. No project routing rules were returned; the firewall-config request
returned 404. Neither result proves a business-containment gate exists.

The documented candidate is a production build with `--skip-domain`, followed
by testing its protected immutable URL and explicit promotion. Do not assume
the existing Git merge path honors that manual flag. Before authorization,
the operator must confirm/rehearse an actual production-branch build/alias
hold and old-artifact containment. Our create-deployment connector does not
expose a skip-domain field. Under the explicit no-deployment restriction,
on-project alias-hold/promotion behavior remains BLOCKED, not PASS.

## Conditional release and rollback

1. Approve the exact new PR head and all required green CI; confirm project,
   runtime configuration, migration checksum and preservation baselines.
2. PR #18 includes PR #17's commits. Merge #18 only with expected-head
   protection after establishing the approved alias hold. Record merge SHA,
   require post-merge CI and one fresh READY production build. Do not create a
   duplicate build if Git already produced the held candidate.
3. Before security changes, activate the separately approved business/server-
   action containment gate across every old alias/immutable host. Keep Auth
   and no-data readiness available. Rehearse both authorized and unauthorized
   gate behavior; anonymous redirects alone are insufficient.
4. In the controlled window, use the approved scoped executor and activate
   the reviewed hook/chain. Confirm actual worker reload with minimal read-only
   HTTP requests, not configuration metadata alone.
5. Approved existing holders privately verify normal bootstrap/read access,
   forced bootstrap and financial table/scalar-RPC 403, without password reset
   or flag edits. Verify readiness 200/true and no-store production health.
6. Promote only the approved merge build, confirm alias/SHA, repeat read-only
   checks and compare consistent preservation snapshots. Reopen only after
   both the new app guard and database gate are proven active and old
   vulnerable artifacts remain contained.
7. After #18 is incorporated, close #17 as superseded if still open. Do not
   reapply/cherry-pick its certification changes.

Pre-commit interruption: rollback leaves no DDL/history. After activation:
retain the new identity restriction, canonical history and hook. The executed
PostgREST crash/restart retained enforcement. Do NOT disable the hook, clear
flags, restore old identity functions, or repair finances to regain availability.

The former application is NOT an approved security rollback: its privileged
server actions can use service-role access that the new client-request hook
does not constrain. Use a separately tested guarded artifact, or keep business
service contained while rolling forward. No such live rollback/alias exercise
was performed; its authorization and operational rehearsal remain outstanding.

## Preservation checkpoints and final blockers

At each production phase, take REPEATABLE READ, READ ONLY snapshots of the
financial/schedule/policy records and account-flag/password-state fingerprints,
retaining no raw secrets. Compare counts and deterministic fingerprints;
classify independent legitimate activity rather than overwriting records.
Authentication audit/sign-in metadata can change during approved manual login;
that is not permission to change passwords, flags or financial records.

No financial posting, real account reset, demo cleanup, loan recalculation,
Policy 2.0 activation or unrelated migration-history repair is authorized.

Remaining NO-GO blockers:

- Effective hosted PostgREST environment/pre-config/cached hook report and
  actual hosted path/reload verification are unavailable without operator access
  and the separately approved activation smoke test.
- Actual Vercel auto-alias hold, authenticated old-artifact containment, staged
  testing and secure reopen/rollback are unexecuted under the no-deploy rule.
- Real Storage service/signed-URL behavior remains unexecuted; only its RLS
  contract has execution evidence. Exact hosted Auth settings/version and
  hosted account/session certification remain distinct from isolated success.
- New-head required CI must complete successfully. Source/test changes do not
  authorize any production operation.
