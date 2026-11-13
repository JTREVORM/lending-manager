# POLYTOS Final Completion Program — Phase 1 Recovery Audit

**Date:** 6 November 2026 · **Scope:** repository, migration, security-integration and
deployment blockers · **Mode:** read-only audit; no production mutation performed.

**Supabase project used:** `fszgwemtgyrbhngajpzm` ("lending manager") only.
The unrelated project `nmdyyhkwmsnhfhfivoji` was never touched.

> This report supersedes `POLYTOS-SECURITY-RELEASE-GATES.md` (31 Oct, "NO-GO at PR #18
> `d9c1971`") and the hosted-state sections of the earlier certification reports. Those
> were written before PR #18 merged and before production was redeployed. Several of
> their findings are **no longer current** — see §3 and §7.

---

## 1. Current repository and production state

| Item | Verified value |
| --- | --- |
| Default branch | `claude/intelligent-knuth-2r8mpw` |
| Default branch tip | `64ea09c73058b22ea8c31ccb9adf9efa31115632` |
| Default branch protection | **None.** `protected: false`, rulesets `[]` (checked with an admin-scoped token) |
| Production deployment | `dpl_9NSBbF2yBns8EFFhJo6PS2g8zain` — state `READY`, target `production` |
| Production commit | `64ea09c` — **identical to the default branch tip** |
| Authoritative green CI on that commit | run [41670225882](https://github.com/JTREVORM/lending-manager/actions/runs/41670225882) — all 4 jobs `success` |
| PR #18 | **Merged** 2026-11-03T16:03:27Z |
| PR #19 | **Open, DRAFT**, `mergeable_state: clean`, head `3d09f93` |
| Local migrations (default branch) | 161 |
| Hosted migration rows | 161 (161 distinct versions — no duplicates) |
| Public tables / views / functions | 80 / 49 / 315 |
| RLS coverage | **80 of 80 tables** (`tables_without_rls = 0`), 126 public policies, 15 storage policies |

A second CI run at `64ea09c` ([41810776767](https://github.com/JTREVORM/lending-manager/actions/runs/41810776767))
shows `cancelled`. It is **benign**: it was a `push` run on
`security/production-certification-2026-11-04` at the moment that branch was cut from the
default tip, and the workflow concurrency group cancelled it when later commits landed.
The default-branch run at the same commit is fully green.

### Financial and configuration state (preserved, unmodified)

clients 28 · loans 35 · loan payments 470 · journal entries 597 · memberships 6 ·
savings transactions 26 · profiles 6.

Policy 2.0 is `status = draft`, `effective_from = NULL`, `approved_at = NULL`, with
`is_enrolment_enabled`, `is_savings_enabled`, `is_member_lending_enabled`,
`is_benefits_enabled` and `is_financially_enabled` **all false**. It was **not activated**.
The governing active policy remains `999.0` ("DEMONSTRATION ONLY"). No demo-data deletion
was executed.

---

## 2. PR #19 investigation and resolution

**Reported condition:** branch reference `2261220`, PR head `8859e99`.

**Finding: the mismatch no longer exists, and nothing was corrupted.**

Current state, verified against both the git graph and the GitHub API:

```
8859e99  docs: record restricted ledger balance RPC and required regression coverage
2261220  ci: run safe hosted production GET-only certification on security PR
c7207cb  chore: ignore generated production read-only smoke report
3d09f93  docs: record verified hosted production health and synced security PR   <- branch tip AND PR head
```

- `git merge-base --is-ancestor 8859e99 2261220` → **true**. `8859e99` is a genuine
  ancestor of the current tip.
- The history is linear and every reported SHA is still reachable.

**Root cause:** a point-in-time reporting gap, not a defect. At the moment the earlier
report was taken, commit `2261220` existed on the branch but GitHub's PR head pointer
still read `8859e99` — i.e. the branch was exactly one commit ahead of what the PR had
registered (an unpushed commit, or the brief window before the push webhook updated the
PR head). Two further commits (`c7207cb`, `3d09f93`) were then pushed, and the PR head
advanced with them.

**Why no recovery action is warranted:** the fact that `8859e99` remains an *ancestor* of
the tip is positive proof that no history was rewritten — a force-push would have
orphaned it. The branch and PR are in sync, so there is nothing to repair.

**Resolution: none required.** No force-push, no close/reopen, no fabricated check, and
no merge of an unverified release was performed, and none is needed.

### PR #19 check status at its exact head `3d09f93`

All 11 check runs resolved: **10 `success`, 1 `skipped`** (`Supabase Preview`, correctly
skipped — no preview branch). No failures, no pending.

| Check | Result |
| --- | --- |
| checks, unit/integration, build | success |
| database (real PostgreSQL) | success |
| security release rehearsal (PostgreSQL 17, real Auth) | success |
| browser E2E (production build, fresh seed) | success |
| Production public GET + anonymous-route protection | success |
| Vercel Preview Comments | success |
| Supabase Preview | skipped |

Runs: [41835900763](https://github.com/JTREVORM/lending-manager/actions/runs/41835900763) (CI, pull_request) ·
[41835893010](https://github.com/JTREVORM/lending-manager/actions/runs/41835893010) (CI, push) ·
[41835900769](https://github.com/JTREVORM/lending-manager/actions/runs/41835900769) (production smoke).

### The "missing smoke-test workflow commit"

**Not missing.** `.github/workflows/production-anonymous-smoke.yml` was added by commit
`2261220` and is present on the PR #19 branch. It is absent from the default branch only
because **PR #19 has not been merged**. Its job ran and passed on the PR head.

---

## 3. Migration reconciliation

**Result: exact 1:1 correspondence. No missing, duplicate, orphaned or conflicting entry.**

| Check | Result |
| --- | --- |
| Local migration files (default branch) | 161 |
| Hosted `supabase_migrations.schema_migrations` rows | 161 |
| Distinct hosted versions | 161 (**no duplicates**) |
| Present locally but not applied | **0** |
| Applied but absent from the repository (orphaned) | **0** |
| Duplicate version prefixes among local files | **0** |
| Hosted version ordering | strictly monotonic |
| Fresh-database replay of all 161 migrations | **applied cleanly, in order, no error** |

The previously reported claim that **branch and production differ by exactly one
migration** (commit `03e72c5`) is **no longer current**: `20261103000100_definer_rpc_business_identity`
is now applied in production, and the sets match exactly.

### The "nine historical version discrepancies" are gone

`scripts/rehearse-security-release.mjs` asserts a production history containing nine
non-canonical version rows (`20261010104426_collateral`, `20261011060140_notifications`,
`20261012062453_balance_as_of`, and six others). **All nine were queried directly in
production and none is present.** Production migration history is now fully canonical.

That rehearsal fixture is therefore more pessimistic than reality. It was deliberately
**left unchanged** — it exercises the migration's tolerance of unexpected history rows,
which remains a valid robustness property. It is recorded here as a documentation drift,
not a defect, and must not be "fixed" by weakening the assertion.

### Pending, not applied

PR #19 carries two migrations that are **not** in production:

| Migration | Effect | Production precondition verified |
| --- | --- | --- |
| `20261104000100_remove_unintended_gate_probe` | Drops the stray `public.__gate_probe` view, `RESTRICT`, only if its definition is still exactly `SELECT 1 AS one` | **Yes** — production definition is exactly ` SELECT 1 AS one;`, so the guard will fire rather than refuse |
| `20261104000200_guard_ledger_account_balance_by_role` | Adds a `ledger:view` capability check to `ledger_account_balance` | Confirmed absent in production (see §4) |

Both are guard-railed, additive and non-mutating. **No production migration history was
modified**, and none should be without the explicit approval this program reserves.

---

## 4. Security and deployment findings

### Verified working

| Control | Evidence |
| --- | --- |
| **PostgREST pre-request hook active** | `pgrst.db_pre_request = public.enforce_password_change`, bound to the `authenticator` role cluster-wide (alongside `statement_timeout=8s`, `lock_timeout=8s`) |
| **Forced-password boundary at the data layer** | `enforce_password_change()` present and correct: returns early for anonymous callers, permits only a tight allowlist (`current_session_context`, `polytos_readiness`, `record_sign_in`, `record_security_event`, `consume_rate_limit`, `GET /company_identity`), otherwise raises `42501` when `outcome <> 'ok'` **or** `must_change_password` |
| **Business-identity guard** | `require_business_identity()` present, `SECURITY DEFINER`, `search_path = ''`, raises `42501` on a null profile |
| **RLS enforced** | 80/80 public tables have RLS enabled; 0 without; 126 public + 15 storage policies |
| **No anonymous data access** | Of 129 public tables/views, `anon` can read exactly **one** object; **zero** `SECURITY DEFINER` functions are executable by `anon` (only `enforce_password_change` and `polytos_readiness`, both `SECURITY INVOKER`) |
| **Production deployment controls** | Production env vars scoped to `production` **only** (all 5, all `sensitive`; `SUPABASE_SECRET_KEY` marked `secret`; `securityIssues: []`; `hiddenProductionEnvCount: 0`) — so **preview deployments receive no Supabase credentials**. Vercel SSO protection enabled (`all_except_custom_domains`). `vercel.json` disables Git auto-deploy for the default branch, making production promotion deliberate |
| **Health and readiness endpoints** | `/api/health` returned HTTP 200 with `status: ok`, `dataApi: ok`, `environment: production` and no-store caching; `/login`, `/loans`, `/savings`, `/benefits`, `/finance/ledger`, `/membership/policies/transitions` each returned **307 → `/login`** with CSP and `X-Content-Type-Options: nosniff`. Evidence: CI job [126594598898](https://github.com/JTREVORM/lending-manager/actions/runs/41835900769/job/126594598898), `"passed": true` |

### Open findings

**F1 — `company_identity` is a `SECURITY DEFINER` view.** Supabase advisor **ERROR**.
Deliberately preserved pending a behaviour-compatible design review (stated in PR #19).
Still open.

**F2 — `__gate_probe` is the only anon-reachable object, and `anon` holds write grants on it.**
Supabase advisor **ERROR** (`security_definer_view`). **Assessed as inert, not an active
exposure:** `information_schema.views` reports `is_updatable`, `is_insertable_into`,
`is_trigger_insertable_into`, `is_trigger_updatable` and `is_trigger_deletable` all `NO`,
so every write fails; and its only readable content is the constant `1`. PR #19 removes it.
This is nonetheless the single anonymous surface on the database and is a hygiene defect
worth closing.

**F3 — Authenticated borrower can read any GL account balance.** `ledger_account_balance`
in production guards on business identity but **not** on the `ledger:view` capability.
Confirmed by reading the deployed function body. PR #19 fixes it and adds a
positive-and-negative regression test. **Not yet in production.**

**F4 — Leaked-password protection disabled.** Supabase advisor **WARN**: the
HaveIBeenPwned check is off. Requires an operator dashboard change; not actionable from
the repository.

**F5 — 117 `SECURITY DEFINER` RPCs are executable by `authenticated`, and 16 carry no
authorization guard of any kind.** Each of the 117 relies on its own internal check, so a
single omission is a bypass — which is exactly how F3 arose. Audited all 117: 101 reference
`require_business_identity`, `user_has_permission`, `current_profile_id` or `auth.uid()`;
16 reference none:

`active_membership_policy_id`, `benefit_blocked_reason`, `benefit_expense_account`,
`benefits_blocked_reason`, `business_now`, `business_timezone`, `consume_rate_limit`,
`member_lending_blocked_reason`, `membership_fee_is_posted`, `membership_governing_policy`,
`membership_policy_allows`, `membership_terms_are_accepted`,
`redeem_membership_consent_code`, `savings_account_governing_policy`,
`user_can_see_branch`, `validate_loan_for_approval`.

Fifteen are a **documented, accepted residual** recorded in
`20261103000100_definer_rpc_business_identity.sql`: they return configuration or policy
metadata rather than member money, and several are reached from trigger and constraint
paths where raising would turn a correct silent denial into an error. That reasoning was
reviewed and still holds. Two warrant naming explicitly:

- **`validate_loan_for_approval(uuid)`** — the widest of the sixteen. Any active
  authenticated identity that knows a loan UUID can learn client status, active-loan
  counts, business thresholds (min/max loan amount, term ceilings), membership status,
  savings-qualification progress, the member's maximum eligible loan, and guarantor
  counts and completeness. Mitigations: UUIDs are random and not enumerable, and the
  forced-password hook still applies. The migration's stated reason for deferral — that
  guarding it means restating a two-hundred-line approval body, and a transcription slip
  in a loan-approval rule is worse than the disclosure — is sound. **A
  `REVOKE EXECUTE ... FROM authenticated` would not work**: `lib/data/loans.ts:444` calls
  this RPC with the caller's own JWT via `createSupabaseServerClient()`, so revoking the
  grant would break the loan-approval screen. Closing it safely needs a deliberate,
  tested change (see §9), not a Phase 1 patch.
- **`redeem_membership_consent_code(uuid, text)`** — `VOLATILE` and unguarded, so any
  authenticated identity knowing a challenge UUID can burn its five attempts and deny a
  member's consent flow. Attempt-capped and digest-compared, so code recovery is
  impractical; the realistic impact is nuisance denial.

**F6 — The default branch has no protection.** `protected: false` and zero rulesets,
confirmed with an admin-scoped token, so this is a genuine gap rather than a permissions
artifact. Nothing enforces a review or a green check before a merge into the branch that
production is promoted from. Release integrity currently rests on manual discipline.

---

## 5. Changes implemented

No code, schema, migration, grant, policy, account or financial record was changed.
The audit found no repository, migration or security defect that required repair, and
every remaining item is either authorization-gated or a deliberate prior decision.

Documentation only, on branch `ccr-2f5e3786-jo3efn`:

| Change | Commit |
| --- | --- |
| This Phase 1 recovery audit report | see §6 note |
| Superseded banner on `POLYTOS-SECURITY-RELEASE-GATES.md` | same commit |

---

## 6. Automated test results

All figures below are exact counts from runs executed in this session, against the
**default branch** tree (`64ea09c`) — i.e. the production-equivalent schema.

| Suite | Result |
| --- | --- |
| `npm run typecheck` (`tsc --noEmit`) | **PASS** — clean, no diagnostics |
| `npm run lint` (`eslint .`) | **PASS** — clean |
| `npm run format:check` (`prettier --check .`) | **PASS** — "All matched files use Prettier code style!" |
| `npm run test:run` (unit + integration) | **PASS** — 82 files passed, 1 skipped (83); **2641 tests passed, 6 skipped** (2647); 25.07s |
| `vitest --project db` (real PostgreSQL) | **PASS** — 79 files passed (79); **1816 tests passed, 0 failed, 0 skipped**; 156.90s |
| `vitest --project seed` | **PASS** — 18 passed |
| `vitest --project seed-reuse` | **PASS** — 15 passed |
| `vitest --project seed-member-loans` | **PASS** — 24 passed |
| `vitest --project seed-benefits` | **PASS** — 25 passed |
| `npm run audit:money` | **PASS** — 71 financial files scanned, no hazard; all five engines reach only integer/BigInt money helpers; 2 verified exemptions; scanner verified against a positive control |
| `npm run build` (production build) | **PASS** — exit 0 |
| Migration replay (161 migrations, clean cluster) | **PASS** — all applied in order, no error |

**Local total: 4539 tests passed, 6 skipped, 0 failed.**

Runtime: Node 24 / npm 10.9.9, PostgreSQL **16** (local throwaway cluster via
`scripts/pg-local.sh`). CI uses PostgreSQL 17; exact version parity is **not** claimed for
the local run.

### Suites not run locally, and why

| Suite | Reason | Authoritative evidence |
| --- | --- | --- |
| Browser E2E (Playwright) | The harness needs a downloaded real PostgREST binary | CI `browser E2E` **success** at both `64ea09c` and `3d09f93` |
| Security release rehearsal (PG 17, real Auth) | Needs the real Supabase Auth binary and PostgreSQL 17; Docker is not usable in this container | CI `security release rehearsal` **success** at both commits |
| Production anonymous smoke | **This container's egress policy denied the host** — the proxy returned 403 to `CONNECT lending-manager-ten.vercel.app:443`. This is a sandbox restriction, **not** a production outage, and the locally generated `work/production-readonly-certification.json` showing failures is an artifact of that denial and must be disregarded | CI job [126594598898](https://github.com/JTREVORM/lending-manager/actions/runs/41835900769/job/126594598898), `"passed": true`, all 7 routes |

No test was weakened, skipped or disabled to obtain these results.

---

## 7. Remaining blockers and risks

### Blocking production certification

| # | Blocker | Owner |
| --- | --- | --- |
| B1 | **PR #19 is a draft and unmerged.** Its two security migrations — including the F3 ledger fix — are not in production, although all checks are green at its exact head and `mergeable_state` is `clean`. Marking it ready, approving and merging is a release decision reserved to the Product Owner | Trevor |
| B2 | **Applying PR #19's migrations to production** requires explicit authorization; a verified reconciliation plan is in place (§3) but was deliberately not executed | Trevor |
| B3 | **No branch protection on the default branch** (F6). Production is promoted from an unprotected branch | Operator / Trevor |
| B4 | **Leaked-password protection disabled** (F4) — Supabase dashboard change | Operator |

### Risks carried forward

- **R1 (F5):** 16 unguarded `SECURITY DEFINER` RPCs, `validate_loan_for_approval` widest.
  Confirmed disclosure to any active authenticated identity holding a loan UUID. A naive
  `REVOKE` breaks the approval screen.
- **R2 (F1):** `company_identity` remains a `SECURITY DEFINER` view (advisor ERROR).
- **R3:** The 117-RPC "guard inside each function" pattern has no systemic enforcement.
  Nothing fails CI when a new `SECURITY DEFINER` RPC ships without an authorization check.
- **R4:** Local DB verification ran on PostgreSQL 16 against a CI/production baseline of 17.
- **R5:** `rls_enabled_no_policy` on `membership_consent_challenges`,
  `rate_limit_counters`, `reference_formats`, `reference_sequences` (advisor INFO). These
  are fail-closed by design — RLS on with no policy denies all non-definer access — and
  are reached only through `SECURITY DEFINER` functions. Recorded, not a defect.
- **R6:** The rehearsal fixture's nine-discrepancy assertion no longer mirrors production
  (§3). Harmless, but it will mislead the next reader.

---

## 8. Phase 1 verdict

### PASS — audit and recovery objectives met. Production certification NOT granted.

**Why PASS.** Every blocker Phase 1 was convened to resolve proved to be either already
resolved or not a defect, and each was verified against live systems rather than assumed
from the prior reports:

- PR #19's head/branch mismatch **does not exist**; the history is linear and provably
  un-rewritten (§2).
- The smoke-test workflow commit is **not missing** (§2).
- The 161 production migrations are **exactly consistent** with the repository, with no
  duplicate, orphaned or conflicting entry — and the nine previously reported historical
  discrepancies are **gone** (§3).
- Security integration is **active and correct in production**: pre-request hook bound to
  `authenticator`, forced-password boundary enforced at the data layer, RLS on 80/80
  tables, and zero anonymous `SECURITY DEFINER` reach (§4).
- Deployment controls are **effective**: production-only credential scoping, SSO on
  previews, deliberate promotion, and verified health and route protection (§4).
- Full local verification is **green: 4539 passed, 6 skipped, 0 failed**, plus typecheck,
  lint, format, money audit and production build (§6).

**Why certification is withheld.** Four authorization-gated blockers remain open (B1–B4),
one of them a confirmed authenticated-disclosure fix sitting unmerged in a draft PR, and
one a release-control gap (no branch protection). None can be closed from this session
without production authorization, and none was closed by assumption. Per the program's
restrictions, these are reported rather than declared resolved.

---

## 9. Recommended Phase 2 starting conditions

1. **Mark PR #19 ready, review and merge it** (B1). It is green at its exact head,
   `mergeable_state: clean`, additive, and its `__gate_probe` guard has been verified
   against the live production definition, so it will fire rather than refuse.
2. **Apply its two migrations to production under the §3 reconciliation**, then re-run the
   Supabase security advisor — `security_definer_view` should fall from 2 to 1 (F1 only).
3. **Enable branch protection on `claude/intelligent-knuth-2r8mpw`** (B3): require the
   four CI jobs and a review before merge. This is the single highest-leverage change,
   because it is what makes every later gate enforceable rather than advisory.
4. **Enable leaked-password protection** in the Supabase Auth dashboard (B4).
5. **Close F3's class, not just F3.** Add a CI check that fails when a `SECURITY DEFINER`
   function executable by `authenticated` references no authorization helper, seeded with
   the 16 known names as an explicit, shrinking allowlist (R3). This converts the residual
   from "documented and forgotten" into "documented and counted down".
6. **Close `validate_loan_for_approval` deliberately** (R1). The body-preserving route is
   to `ALTER FUNCTION ... RENAME TO` an internal name, revoke `authenticated` EXECUTE on
   it, and add a thin guarded `validate_loan_for_approval(uuid)` that checks the
   capability and delegates — leaving the two-hundred-line approval logic byte-for-byte
   untouched. This must be decided with care: the guard would also apply to the internal
   `approve_loan` path, so confirm which capability every legitimate caller holds, and
   land it with the approval-path regression tests green.
7. **Resolve `company_identity`** (F1/R2) through the behaviour-compatible design review
   it is already waiting on.
8. **Decide the Policy 2.0 question separately.** It is `draft`, unapproved, all flags
   false, and was untouched here; activation is a business decision and explicitly out of
   scope for this program.
9. **Correct the rehearsal fixture's documentation** (R6) without weakening its assertion.
10. **Phase 2 entry gate:** B1–B4 closed, advisor `security_definer_view` down to one
    known finding, and a green CI run on a protected default branch.

---

*Prepared by Claude Code as Lead Implementation Engineer. Read-only against production;
no migration, deployment, merge, configuration change, account change or financial write
was performed. Awaiting ChatGPT review before Phase 2.*
