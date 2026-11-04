# POLYTOS production security certification — follow-up (2026-11-04)

## Scope and release position

**Assessment status: PARTIAL / not yet a business launch certificate.**
Production code currently points to merge commit `64ea09c`, with all five
GitHub checks passing. The production data was not altered in this review.
The unrelated draft demo-cleanup branch is excluded from this security change.

## Evidence from the connected production project

- 80/80 public base tables have RLS enabled.
- Six private storage buckets; the probe did not open or download any files.
- The `authenticator` role currently has
  `pgrst.db_pre_request=public.enforce_password_change`.
- No public `SECURITY DEFINER` functions are executable by `anon`.
- Security advisor findings: two definer-view ERROR notices, 117 executable
  definer-function WARN notices, four no-policy INFO notices, and one
  disabled leaked-password-protection WARN notice.
- No Vercel error/fatal logs were returned for the 45-minute window
  checked. Absence of logs is not proof of application health.
- **Public hosted HTTP verified 2026-11-04T13:09:48Z (16:09:48 EAT)** by
  GitHub Actions run [41835570464](https://github.com/JTREVORM/lending-manager/actions/runs/41835570464).
  The exact production URL `https://lending-manager-ten.vercel.app/api/health`
  returned HTTP **200** with `status=ok`, `dataApi=ok`,
  `environment=production` and no-store/private caching. `/login`
  returned 200 with CSP and `X-Content-Type-Options: nosniff`; five
  unauthenticated protected routes returned HTTP 307 to `/login`, each with
  private/no-store caching. Seven of seven public smoke checks passed.
  The sanitized run artifact is `polytos-production-public-smoke`.
- **Authenticated hosted role/session coverage remains pending**; a passing
  anonymous/public smoke test is not a signed-in negative-role test.
- PR #19 originally had a stale head reference (`8859e99`) while its branch
  pointed at `2261220`. A narrowly scoped `.gitignore` change ignoring
  only the generated `work/production-readonly-certification.json` (not all
  `work/`, which contains tracked fixtures) triggered PR synchronization.
  Both PR and branch then resolved to `c7207cb`; no forced push, PR merge or
  production deploy was performed.

## Finding dispositions

| Finding | Disposition | Follow-up |
| --- | --- | --- |
| `public.__gate_probe` | **Fix prepared, not deployed.** Extra `SELECT 1 AS one` view, broad role grants, no other dependent objects observed. | The paired migration drops this exact constant-only view, no CASCADE; fresh installs no-op. CI and production rollout still required. |
| `public.company_identity` | **Documented exception, not an assumed breach.** Definer view intentionally projects 14 company branding/contact columns to signed-in users while excluding registration/tax details. | Keep current authorized borrower-facing view until a replacement has equivalent proven RLS/column isolation; review displayed contact/address fields for business-policy compliance. |
| 117 authenticated definer RPCs | **Requires per-function authorization review.** An actual gap was confirmed in `ledger_account_balance(uuid)`: every active role could read arbitrary GL balances despite `ledger:view` being held only by Owner/Manager/Treasurer. A second, reviewed migration and regression test now guard this call; **not deployed**. The other warnings are not 116 proven bugs. | CI must demonstrate both borrower denial and legitimate finance-role access. Review remaining definer RPCs without indiscriminately revoking EXECUTE. |
| Four RLS tables without a policy | **Intended service-only semantics require confirmation.** `membership_consent_challenges`, `rate_limit_counters`, `reference_formats`, `reference_sequences`. | Validate no staff/user direct-access requirement; avoid creating permissive policies solely to clear lint. |
| Leaked-password protection disabled | **Open configuration hardening.** | Enable in Supabase Dashboard → Authentication settings, if supported by the project's plan (Supabase documents Pro+ availability); confirm provider setting and repeat advisor query. |
| Git production branch `claude/intelligent-knuth-2r8mpw` not marked protected | **Open governance hardening.** | Add required CI reviews/checks and branch protection in repository settings; verify rules in force. |
| Preview vs production environment boundary | **Future-build scope corrected on 2026-11-04.** All five shared Vercel variables — including `SUPABASE_SECRET_KEY`, Supabase URL, publishable key, app environment and site URL — were restricted from `['production','preview']` to `['production']` using the Vercel project configuration API. Re-read confirmed every target is now production-only and the existing live production deployment stayed READY. | **Still open:** older READY preview deployments may retain their prior build-time/runtime environment snapshots; inspect or retire them under deployment governance, and provide isolated preview Supabase credentials before expecting previews to work. No secret values were retrieved or changed. |

## Required certification gates

1. Complete isolated Auth/PostgREST tests and the GitHub CI suite for
   the exact security PR commit.
2. Inspect migration diff and staged Supabase Preview; confirm the only
   schema changes are removing the unintended `__gate_probe` view and
   adding the `ledger:view` guard to `ledger_account_balance(uuid)`.
3. Approve migration and promote the corresponding application build only
   through the established release process, checking the effective prod alias.
4. Re-run Supabase security advisor and compare the new inventory.
5. Collect approved *real hosted* sign-in, logout, session expiry, recovery,
   forced-password 403/42501, manager/treasurer authorization, borrower and
   cross-branch isolation, and private-storage authorization evidence.
6. **Hosted production public HTTP smoke: PASS** (run 41835570464, with
   /api/health 200/ok and 5/5 anonymous protected-route redirects).
   Still verify authenticated business functions and any remaining TLS/header
   and signed-session expectations in the final operator checklist.
7. Finish Auth breached-password configuration and repo governance reviews, and certify the isolation of any existing preview deployments.
8. Keep production launch **NO-GO** if a material authorization boundary
   or negative-role test remains unproven, if there is a critical flaw,
   or if backups/restore have not been certified.

## Preservation

Do not clear demo data, remove an Auth account, reset a password, change a
membership policy, deploy or merge this PR solely because these static checks
passed. Full certification requires independent positive and negative hosted
evidence and owner/operator approval.
