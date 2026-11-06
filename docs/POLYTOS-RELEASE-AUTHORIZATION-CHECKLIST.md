# POLYTOS production release — authorization checklist

**Prepared 6 November 2026, Phase 2.** Nothing in this document has been
executed. Every step marked **PO** needs Trevor's authorization; every step
marked **OP** needs operator access to a dashboard that no session reaches.

The order matters. Steps 2 and 3 are the way round they are because branch
protection with `strict` status checks requires a branch to be up to date
before merging, so protecting the branch *after* a merge means the next pull
request has to be refreshed, while protecting it first means PR #19 is already
up to date and merges cleanly.

---

## Step 0 — Before anything, confirm the starting state

No authorization needed. Read-only.

| Check | Expected | How |
| --- | --- | --- |
| Default branch tip | `64ea09c` | `git rev-parse origin/claude/intelligent-knuth-2r8mpw` |
| Production deployment commit | `64ea09c` | Vercel: production deployment `dpl_9NSBbF…zain` |
| Hosted migrations | 161 | Supabase migration list |
| Ledger debits = credits | both 89,649,530 | `sum(debit)`, `sum(credit)` on `journal_lines` |
| Policy 2.0 | `draft`, unapproved, every flag false | `membership_policy_versions` |
| Financial records | 35 loans · 470 payments · 597 journal entries · 28 clients | counts |
| `__gate_probe` | still present, still exactly `SELECT 1 AS one` | `pg_get_viewdef` |

If any row differs, stop: something moved since Phase 2 and the plan below was
written against the state above.

---

## Step 1 — Final CI and migration verification

**No authorization needed.** The Phase 2 pull request must be green on its exact
head before anything else is considered.

- [ ] All four required jobs green on the Phase 2 PR head: `checks,
      unit/integration, build` · `database (real PostgreSQL)` ·
      `security release rehearsal (PostgreSQL 17, real Auth)` ·
      `browser E2E (production build, fresh seed)`
- [ ] The **Database security gate** step inside the database job passes. This
      is new in Phase 2 and is the step that refuses unreviewed privileged
      exposure.
- [ ] `security release rehearsal` green — this is the only run of that suite on
      **PostgreSQL 17**. It could not run in the Phase 2 session: PG 17 is not
      installed there and `www.postgresql.org` is blocked by the session's
      network policy, so CI is the authority for it.
- [ ] Migration count on the **PR #20** branch is **169** (161 hosted + the
      eight Phase 2 migrations), replaying cleanly onto an empty cluster.
- [ ] The **combined** post-release set — 161 hosted + PR #19's two + PR #20's
      eight = **171** — replays cleanly in timestamp order. This is the ordering
      production will actually take, and neither PR exercises it alone, because
      each branch holds only its own migrations. Verified in Phase 3 (§Step 4).

---

## Step 2 — Activate branch protection · **PO**

**Authorized by the Product Owner on 6 November 2026. Not applied.** The session
could not apply it: the GitHub App token lacks the Administration permission
(403 reading protection) and the agent proxy forbids writes to the
branch-protection API path (403 on PUT). The branch still reports
`protected: false`.

```
GITHUB_TOKEN=<admin token> node scripts/apply-branch-protection.mjs --apply
```

The script refuses to apply a configuration that would deadlock releases, then
reads the rule back from GitHub — a 200 is not proof a setting is enforced.

- [ ] Applied, and the script reports **"Verified in force, read back from
      GitHub"**
- [ ] `protected` now reads `true`

What it enforces, and why each value (full rationale in
`config/branch-protection.json`):

| Setting | Value | Why |
| --- | --- | --- |
| Required checks | the four CI jobs, `strict` | Only those four run on every PR. The path-filtered production smoke and the third-party Vercel/Supabase checks are deliberately **not** required — a required check that can skip leaves a PR pending forever |
| `enforce_admins` | `true` | Red CI stops a release. An admin bypass is how one gets out without green checks |
| Required approvals | **0** | There is exactly one collaborator, and GitHub forbids approving your own PR. At 1, **no PR could ever merge**. Raise this the day a second maintainer exists — it is the only value that needs to change |
| Force pushes / deletions | forbidden | Production is promoted from this branch, so its history must be append-only |

---

## Step 3 — Approve and merge PR #19 · **PO**

[PR #19](https://github.com/JTREVORM/lending-manager/pull/19) — head `3d09f93`,
`mergeable_state: clean`, **still a draft**.

Revalidated in Phase 2 and unchanged since 4 November: all 11 checks resolved,
10 success and 1 correctly skipped (`Supabase Preview`, no preview branch).

- [ ] Mark ready for review
- [ ] Confirm the two migrations are still the only schema change it carries:
      `20261104000100_remove_unintended_gate_probe` and
      `20261104000200_guard_ledger_account_balance_by_role`
- [ ] Confirm the probe-view guard will **fire rather than refuse** — production
      was re-read in Phase 1 and its definition is still exactly `SELECT 1 AS one`
- [ ] Merge

Then merge the Phase 2 pull request.

---

## Step 4 — Apply migrations to production · **PO**

The reconciliation plan is in
`docs/POLYTOS-PHASE-1-RECOVERY-AUDIT-2026-11-06.md` §3: local and hosted
migration sets matched exactly at 161, with no missing, duplicate, orphaned or
conflicting entry.

**Ten migrations to apply, in order.** Timestamp order is the dependency order,
and PR #19's two sort before PR #20's eight, so applying both PRs' migrations by
version number is correct regardless of which PR merges first.

| Order | Migration | From | What it does |
| --- | --- | --- | --- |
| 1 | `20261104000100_remove_unintended_gate_probe` | PR #19 | Drops the stray `__gate_probe` view, guarded on its definition |
| 2 | `20261104000200_guard_ledger_account_balance_by_role` | PR #19 | Adds a `ledger:view` check to `ledger_account_balance` |
| 3 | `20261106000100_guard_loan_validation_disclosure` | PR #20 | Renames the approval rules behind an internal name; authorized wrapper on `loans:view` |
| 4 | `20261106000200_guard_consent_code_redemption` | PR #20 | Mirrors the issuer's capability pair; a refusal spends no attempt |
| 5 | `20261106000300_record_company_identity_exemption` | PR #20 | Records the reviewed definer-view exemption; restates the SELECT-only grant. No behaviour change |
| 6 | `20261106000400_retire_unused_definer_grants` | PR #20 | Withdraws `authenticated` EXECUTE from seven uncalled functions |
| 7 | `20261106000500_guard_savings_amount_disclosure` | PR #20 | Closes the confirmed cross-member savings disclosure |
| 8 | `20261106000600_restore_governing_policy_grant` | PR #20 | **Restores** `savings_account_governing_policy` to `authenticated` — #6 withdrew it, and two `SECURITY INVOKER` functions need it |
| 9 | `20261106000700_guard_client_live_loan_disclosure` | PR #20 | Closes the confirmed `client_has_live_loan` disclosure |
| 10 | `20261106000800_guard_bulk_meeting_fine_assessment` | PR #20 | Moves `assess_meeting_fines`' capability check to the top |

### Ordering constraints that matter

- **#6 before #8 is mandatory.** #6 withdraws a grant that #8 restores. Applying
  #8 without #6, or in the other order, leaves the grant in the wrong state.
  Applying the set by version number gets this right; cherry-picking does not.
- **#2 must follow nothing in PR #20**, and does not: it only replaces
  `ledger_account_balance`, which no PR #20 migration touches.
- **#1 is guarded and will fire, not refuse.** Production's `__gate_probe` was
  re-read during Phase 1 and its definition is still exactly `SELECT 1 AS one`,
  which is the condition the migration requires before dropping it.
- **No duplicate versions** across all ten, checked against the 161 already
  applied.

All ten are additive: they add or replace functions, withdraw or restore grants,
and drop one verified constant view. None writes a business row, and none alters
a financial calculation. **Use only the `fszgwemtgyrbhngajpzm` ("lending
manager") project.**

- [ ] Take a backup first — see `docs/BACKUP-RESTORE.md`
- [ ] Apply 1–10 in order
- [ ] Hosted migration count is **171**
- [ ] Re-check the preserved counts from Step 0: 35 loans · 470 payments ·
      597 journal entries · 28 clients, all unchanged
- [ ] Ledger debits still equal credits (both **89,649,530** before the release)
- [ ] Policy 2.0 still `draft` with every flag false

Migrations 3 and 7 use `ALTER FUNCTION ... RENAME TO`. If either reports that
the internal name already exists, it has already been applied — it skips rather
than renaming a wrapper into the internal slot.

---

## Step 5 — Verify the deployed security controls

**No authorization needed.** Read-only, against production, after Step 4.

- [ ] `pgrst.db_pre_request = public.enforce_password_change` still bound to the
      `authenticator` role
- [ ] RLS enabled on every public table (expect 80 of 80, 0 without)
- [ ] `__gate_probe` is **gone**; `to_regclass('public.__gate_probe')` is null
- [ ] `anon` can read **no** public object (it was exactly one — the probe view)
- [ ] Zero `SECURITY DEFINER` functions executable by `anon`
- [ ] `ledger_account_balance` body contains the `ledger:view` check
- [ ] `validate_loan_for_approval_internal`, `savings_withdrawable_amount_internal`,
      `savings_pledged_amount_internal` and `require_savings_account_access`
      exist and are **not** executable by `authenticated`
- [ ] Exposed roles hold exactly `SELECT` on `company_identity`
- [ ] The seven functions in migration 6 are no longer executable by
      `authenticated`

---

## Step 6 — Enable leaked-password protection · **OP**

Supabase dashboard → Authentication → the HaveIBeenPwned / breached-password
setting. Not reachable from any session; no API call substitutes for it.

- [ ] Enabled
- [ ] Supabase security advisor no longer reports
      `auth_leaked_password_protection`

---

## Step 7 — Authenticated hosted regression checks · **PO**

Phase 2 certified the role matrix against an **isolated** stack with the real
pinned Supabase Auth binary, not against the hosted project. Hosted
authenticated checks need approved test identities on production, which is a
Product Owner decision and was never taken.

- [ ] Decide whether hosted authenticated testing happens at all, and with which
      identities
- [ ] If yes: Owner/Admin, Manager, Secretary/Treasurer and Client sign-in;
      forced-password accounts; inactive and suspended accounts; session expiry
      and refresh; logout against protected routes; borrower privacy;
      cross-branch isolation; private Storage
- [ ] Negative cases included — a restricted user must receive no unauthorized
      data, not merely a different screen
- [ ] **No real customer credentials in any log or report**

If this step is declined, say so in the release record. It is the one piece of
Phase 1's and Phase 2's coverage that no isolated environment can stand in for.

---

## Step 8 — Re-run the Supabase security advisor

**No authorization needed.**

| Finding | Before | Expected after |
| --- | --- | --- |
| `security_definer_view` (ERROR) | 2 — `company_identity`, `__gate_probe` | **1** — `company_identity` only, the reviewed exemption |
| `auth_leaked_password_protection` (WARN) | 1 | **0** once Step 6 is done |
| `authenticated_security_definer_function_executable` (WARN) | 117 | **110** |
| `rls_enabled_no_policy` (INFO) | 4 | 4 — unchanged and correct; those tables are fail-closed by design |

- [ ] Counts match. Any new ERROR stops the release.

---

## Step 9 — Post-release health and financial integrity

**No authorization needed.**

- [ ] `/api/health` returns 200 with `status: ok`, `dataApi: ok`,
      `environment: production`, no-store caching
- [ ] `/login`, `/loans`, `/savings`, `/benefits`, `/finance/ledger`,
      `/membership/policies/transitions` each return 307 → `/login` anonymously,
      with CSP and `X-Content-Type-Options: nosniff`
- [ ] `node scripts/certify-production-readonly.mjs` reports `passed: true`
      (it is GET-only; run it from CI or any host that can reach production —
      the Phase 2 session's network policy denied that host)
- [ ] Financial counts unchanged from Step 0
- [ ] Trial balance still balances
- [ ] Vercel production deployment `READY` at the merge commit
- [ ] Spot-check one authenticated screen per role in the application

---

## What is still open after all nine steps

| | Item |
| --- | --- |
| R1 | Nine `SECURITY DEFINER` functions take a third-party identifier and produced no refusal under the Phase 2 borrower probe. Neither confirmed safe nor confirmed leaking — see `docs/POLYTOS-SECURITY-RISK-INVENTORY.md` §5. **The method that found the savings disclosure has not been pointed at them.** Phase 3's first task |
| R2 | A second maintainer, so required approvals can go from 0 to 1 |
| R3 | `company_identity` stays an advisor ERROR by design. Removing the finding rather than documenting it needs column-level privileges on `company_settings`, which is a schema change, not a view setting |
| R4 | The gate watches the surface for change; it does not re-prove each of the 84 functions classified **A** on every path |

---

## Standing restrictions

Carried from Phase 1 and Phase 2, and not lifted by anything above:

- Preserve all 35 loans, 470 payments and 597 journal entries, and the financial
  calculations, transactions and audit history behind them.
- Policy 2.0 stays `draft` with its feature flags disabled. Activation is a
  business decision, out of scope for this program.
- Never operate on the unrelated Supabase project (`nmdyyhkwmsnhfhfivoji`).
- No demo-data deletion.
- No weakening of a test or bypassing of a CI gate to obtain a green result.
