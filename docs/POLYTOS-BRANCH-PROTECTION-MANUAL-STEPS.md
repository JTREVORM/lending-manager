# Branch protection — manual steps for the Product Owner

**Status: authorized, NOT applied.** The branch is still unprotected. This is not
a claim that it is enabled; `protected` reads `false` as of 6 November 2026.

## Why this has to be done by hand

Two independent blocks, both outside the repository:

1. The session's GitHub App token has no **Administration** permission, so even
   *reading* the protection settings returns
   `403 Resource not accessible by integration`.
2. The agent proxy refuses writes to that API path outright:
   `403 Write access to this GitHub API path is not permitted through this proxy`.

So no token available to an automated session can set this. It takes a human
with admin rights, once.

---

## Option A — the GitHub UI (recommended, ~2 minutes)

1. Open **https://github.com/JTREVORM/lending-manager/settings/branches**
2. Next to **Branch protection rules**, click **Add branch ruleset** → or, if the
   older UI is shown, **Add rule**.
3. **Branch name pattern**: paste exactly

   ```
   claude/intelligent-knuth-2r8mpw
   ```

4. Tick **Require a pull request before merging**.
   - Set **Required number of approvals before merging** to **0**.
     > This is deliberate and must stay 0 for now. `JTREVORM` is the only
     > collaborator, and GitHub does not let an author approve their own pull
     > request. At 1, **no pull request on this repository could ever be
     > merged.** Raise it to 1 the day a second maintainer exists — that is the
     > only value in this list that then needs to change.
   - Tick **Dismiss stale pull request approvals when new commits are pushed**.
   - Leave **Require review from Code Owners** unticked (there is no CODEOWNERS
     file).
5. Tick **Require status checks to pass before merging**.
   - Tick **Require branches to be up to date before merging**.
   - In the search box add these **four** checks, exactly as spelled:

   ```
   checks, unit/integration, build
   database (real PostgreSQL)
   security release rehearsal (PostgreSQL 17, real Auth)
   browser E2E (production build, fresh seed)
   ```

   > Add **only** these four. Do **not** add `Production public GET +
   > anonymous-route protection` (it is path-filtered and does not run on every
   > pull request), nor `Supabase Preview` or `Vercel Preview Comments` (third
   > party, and they legitimately report `skipped`). A required check that does
   > not always run leaves a pull request pending for ever.
   >
   > If a check name does not appear in the search box, it is because GitHub
   > only offers checks it has seen recently — they are all present on PR #20,
   > so they will be offered. Type the name and pick it from the list rather
   > than inventing a variant; the strings above are copied from the live check
   > runs.

6. Tick **Require conversation resolution before merging**.
7. Leave **Require linear history** unticked — every release so far is a merge
   commit, and the existing history is not linear, so requiring it would reject
   the established release shape for no security gain.
8. Under **Rules applied to everyone including administrators** (older UI:
   **Do not allow bypassing the above settings**), **tick it**.
   > This is the "no admin bypass" requirement. Red CI must stop a release, and
   > an admin bypass is exactly how one gets out at 2am without green checks.
   > It does **not** deadlock anything: because approvals are set to 0, the sole
   > admin can still merge their own pull request once the four checks are
   > green.
9. Under **Allow force pushes** — leave **unticked**.
10. Under **Allow deletions** — leave **unticked**.
11. Click **Create** / **Save changes**.

### What you should NOT set

| Setting | Leave it | Why |
| --- | --- | --- |
| Required approvals | **0** | One collaborator; self-approval is forbidden by GitHub. At 1 nothing merges |
| Restrict who can push | off | An organization-and-team feature; adds nothing over "require a pull request" on a one-collaborator repository |
| Require linear history | off | The release history is merge commits by design |
| Require deployments to succeed | off | Production promotion is deliberate and manual |
| Lock branch | off | That makes the branch read-only, which stops releases entirely |
| Allow fork syncing | off | This is a public repository, so a fork sync is an untrusted write path |

---

## Option B — one command

Needs a token with **admin** on the repository, in `GITHUB_TOKEN`. A fine-grained
personal access token scoped to this repository with
**Administration: Read and write** is enough.

```bash
GITHUB_TOKEN=<admin token> node scripts/apply-branch-protection.mjs --apply
```

The script reads `config/branch-protection.json`, refuses to apply a
configuration that would deadlock releases (it re-counts collaborators and will
not set approvals above 0 while there is only one), applies it, then **reads the
rule back from GitHub** — because a `200` on the write is not proof a setting is
enforced; GitHub can accept a field the plan does not support and drop it.

It prints `Verified in force, read back from GitHub` only when what GitHub
reports back matches the reviewed configuration exactly.

---

## Read-only verification

Anyone can run this; it changes nothing.

```bash
GITHUB_TOKEN=<any token with repo read> node scripts/apply-branch-protection.mjs
```

It prints what GitHub currently enforces, prints the desired configuration, and
exits **0** only if they match — **1** otherwise. No `--apply`, no writes.

Or, without the repository checked out:

```bash
gh api repos/JTREVORM/lending-manager/branches/claude%2Fintelligent-knuth-2r8mpw \
  --jq '{name, protected}'
```

Expected **after** the change:

```json
{ "name": "claude/intelligent-knuth-2r8mpw", "protected": true }
```

It currently returns `"protected": false`. That one field is the quickest check
that anything is in place at all; the script above is the check that the *right*
thing is in place.

For the full detail, with an admin token:

```bash
gh api repos/JTREVORM/lending-manager/branches/claude%2Fintelligent-knuth-2r8mpw/protection \
  --jq '{
    checks: .required_status_checks.contexts,
    strict: .required_status_checks.strict,
    admins_included: .enforce_admins.enabled,
    approvals: .required_pull_request_reviews.required_approving_review_count,
    force_pushes: .allow_force_pushes.enabled,
    deletions: .allow_deletions.enabled,
    conversations: .required_conversation_resolution.enabled
  }'
```

Expected:

```json
{
  "checks": [
    "checks, unit/integration, build",
    "database (real PostgreSQL)",
    "security release rehearsal (PostgreSQL 17, real Auth)",
    "browser E2E (production build, fresh seed)"
  ],
  "strict": true,
  "admins_included": true,
  "approvals": 0,
  "force_pushes": false,
  "deletions": false,
  "conversations": true
}
```

A plain (non-admin) token returns `403` on that last command even once
protection exists — that is the same restriction that blocked the session, not a
sign the rule is missing. Use the `{name, protected}` call, or the script, to
check without admin rights.

---

## One ordering note

Apply this **before** merging PR #19 and PR #20, not after.

`strict` requires a branch to be up to date with its base before merging. Both
pull requests are currently up to date, so protecting the branch first lets each
merge cleanly. Protect it after a merge and the other pull request has to be
refreshed before it can land.
