# POLYTOS Phase 2 — security hardening and certification report

**Date:** 6 November 2026 · **Baseline:** `docs/POLYTOS-PHASE-1-RECOVERY-AUDIT-2026-11-06.md`
**Branch:** `ccr-2f5e3786-jo3efn` · **Implementation commit:** `a76dd26`
**Supabase project:** `fszgwemtgyrbhngajpzm` ("lending manager") only. The
unrelated project `nmdyyhkwmsnhfhfivoji` was never touched.

**No production mutation was performed.** No merge, deployment, migration
application, configuration change, account change or financial write.

---

## 1. The headline

Phase 2 changed its method before it changed any code, and the method found a
vulnerability that Phase 1's method had classified as already fixed.

Phase 1 decided which `SECURITY DEFINER` functions were guarded by reading their
bodies for the name of an authorization helper. The Phase 2 brief forbids that,
and was right to. A body can name a helper in a comment, call it and discard the
answer, check the wrong capability, or check the right one on a path the
interesting input never takes — and a regex reports all four as guarded.

So every one of the 110 such functions was **called** as a borrower holding no
business capability, with NULL arguments, in a rolled-back transaction, and the
SQLSTATE recorded. Retesting the functions that did not refuse, this time with a
real third party's identifier, produced this:

> A member's savings account held one 750,000 deposit. The owner saw **750000**.
> An unrelated borrower — no savings capability, no relationship to the member,
> no branch in common — also saw **750000**. Only the account's UUID was needed.

`savings_withdrawable_amount` and `savings_pledged_amount` were among the five
RPCs that migration `20261103000100` recorded as guarded. Their guard,
`require_business_identity`, is real: it refuses forced-password, inactive,
suspended and unlinked sessions. It says nothing about capability, so every
ordinary borrower passed it. The classification was accurate about what the
guard does and wrong about what it was sufficient for.

That is now closed, with both halves proved: the borrower is refused `42501`,
and three staff roles each get **750000** — the figure, not merely access.

---

## 2. Before and after

| Measure | Phase 1 | Phase 2 |
| --- | --- | --- |
| `SECURITY DEFINER` functions reachable by `authenticated` | 117 | **110** |
| Of those, with no authorization check | 16 (by regex) | **9 PENDING-REVIEW** (by behavioural probe) |
| Confirmed cross-member data disclosures | 1 (`ledger_account_balance`, fix unmerged in PR #19) | **+1 found and fixed** (savings amounts) |
| Reviewed exception list | 16, documented in a migration comment | **7**, in a machine-checked baseline |
| Definer views exposed | 2 (`company_identity`, `__gate_probe`) | 1 locally; `__gate_probe` still awaits PR #19 in production |
| Functions relying on PUBLIC's default EXECUTE | 0 | 0, now asserted every CI run |
| Enforcement of any of this | none | **a required CI gate, verified to fail closed** |
| Branch protection | absent | configured and authorized, **not applied** (§7 R2) |

---

## 3. Task-by-task

### Task 1 — PR #19 revalidation · PASS, unchanged

Head `3d09f93`, `mergeable_state: clean`, **still a draft**. All 11 checks
resolved: 10 success, 1 correctly skipped (`Supabase Preview`, no preview
branch). Nothing has moved since 4 November.

Both migrations re-verified against live production:

- **`20261104000100`** — the probe-view drop is guarded and dependency-safe. It
  reads the view's definition, refuses unless it is exactly `SELECT 1 AS one`,
  and uses `DROP VIEW ... RESTRICT` so any unexpected dependency fails the
  migration. Production's definition is still exactly that, so the guard will
  **fire rather than refuse**. `__gate_probe` is also the only object `anon` can
  read anywhere in the schema, and although `anon` holds write privileges on it,
  `information_schema.views` reports `is_updatable`, `is_insertable_into` and
  all three trigger flags as `NO`, so every write fails. Inert, but the one
  anonymous surface there is.
- **`20261104000200`** — the ledger guard denies unauthorized roles correctly.
  `auth.uid() is not null and not user_has_permission('ledger:view')` raises
  `42501`. No auth-context bypass is available: `anon` cannot execute it (zero
  definer functions are anon-executable), and a JWT with `role: authenticated`
  but no `sub` cannot be minted by a caller because Supabase signs it. The
  `auth.uid() is null` path is the deliberate service-role exemption.
  `secretary_treasurer`, `manager` and `owner_admin` all hold `ledger:view`, so
  no accounting role loses access. No financial calculation changes — the body
  keeps the same `normal_side` arithmetic, return type and forced-password
  guard.

**Discrepancy found: none.** Recommended for merge, after branch protection
(ordering in the checklist, §Step 2).

### Task 2 — Branch protection · AUTHORIZED, BLOCKED on execution

The Product Owner authorized applying it. It could not be applied from this
session, for two independent reasons:

- the session's GitHub App token lacks the Administration permission — `403
  Resource not accessible by integration` on *reading* protection;
- the agent proxy forbids writes to that API path entirely — `403 Write access to
  this GitHub API path is not permitted through this proxy` on `PUT`.

The branch still reports `protected: false`. `config/branch-protection.json` and
`scripts/apply-branch-protection.mjs` are ready; one command applies and
verifies.

Two repository facts were checked rather than assumed, and both are ways a
well-meant rule would have made releases impossible:

- **One collaborator.** `JTREVORM`, admin, is the only one. GitHub does not let
  an author approve their own pull request, so `required_approving_review_count`
  is **0**. At 1, no pull request on this repository could ever merge. The
  object is still present, because it is what forbids a direct push — so every
  change arrives as a PR and runs CI. Raising the count is the single change
  needed the day a second maintainer exists.
- **Only four checks run unconditionally.** The production smoke workflow is
  path-filtered and the Vercel and Supabase checks legitimately skip, so
  requiring them would leave pull requests pending forever. Only the four CI
  jobs are required. The new security gate is a *step inside* the already-required
  database job, so it is enforced without adding a skippable context.

`enforce_admins` is `true`: red CI stops a release. Because approvals are not
required, the sole admin can still merge their own PR once the four checks are
green, so this does not deadlock.

### Task 3 — `validate_loan_for_approval` · FIXED (`20261106000100`)

Investigated before implementing, as the brief requires:

| Question | Answer |
| --- | --- |
| Direct and indirect callers | `public.approve_loan` only — five call sites across the migrations that redefined it — plus `lib/data/loans.ts:444` |
| Permissions each caller needs | every call site sits immediately after `approve_loan`'s own `loans:approve` check |
| Do approval functions invoke validation internally | yes, all five sites are inside `approve_loan` |
| Ownership, grants, PUBLIC privileges | owner `postgres`; `{postgres, service_role, authenticated}`; **no function in the schema has a null ACL**, so nothing anywhere relies on PUBLIC's default EXECUTE |

The capability matrix decided the guard: `owner_admin`, `manager` and
`secretary_treasurer` all hold `loans:view`; the borrower holds **no loan
capability at all**; and `loans:approve`'s two holders both hold `loans:view`.
So `loans:view` denies exactly the caller the finding is about and no legitimate
one.

**A plain `REVOKE` was rejected, as the brief anticipated:** `lib/data/loans.ts`
calls this RPC with the caller's own JWT through `createSupabaseServerClient()`,
so revoking the grant would have broken the loan-approval screen rather than
secured it.

The approval body was moved with `ALTER FUNCTION ... RENAME TO`, so the
two-hundred-line calculation is byte-for-byte unchanged — nothing retyped,
nothing to mistype. The internal name carries no `authenticated` grant, so the
Data API cannot reach it; `postgres` and `service_role` keep EXECUTE, so
internal definer callers and trusted no-JWT paths are unaffected. This is the
shape `require_business_identity` already had.

### Task 4 — `redeem_membership_consent_code` · FIXED (`20261106000200`)

The asymmetry was the bug: issuing a code required `membership:create` or
`membership:manage_policies`; redeeming one required nothing. Any active
identity knowing a challenge UUID could spend the five attempts a member needs.

The guard mirrors the issuer exactly, and is checked **before the challenge is
read**, so an unauthorized caller learns nothing about whether the challenge
exists and **spends none of its attempts** — charging an unauthorized caller's
attempt to the member's cap would have left the denial wide open. Raised as
`42501` rather than the function's `P0001`, so authorization refusal and wrong
code are distinguishable in a log and not from a success.

Preserved exactly: challenge lookup and `FOR UPDATE` locking, already-consumed
refusal, expiry refusal, the five-attempt cap, the digest comparison, the
increment on a genuinely wrong code, the deliberate non-consumption of the
challenge, the signature, the volatility and every error code on those paths.

**Confirmed with the Product Owner:** `secretary_treasurer` holds only
`membership:view`, so it cannot redeem — consistent with already not being able
to issue. Mirroring was chosen over widening.

### Task 5 — The sixteen classified · COMPLETE

Full per-function inventory in `docs/POLYTOS-SECURITY-RISK-INVENTORY.md` §3, with
purpose, parameters, return, callers, required authorization, external
callability and mitigating controls for each.

**2 guarded (A) · 7 made internal (C) · 7 exempt with evidence (D) · 0 converted (B).**

The seven made internal (`20261106000400`) were the interesting result: nothing
in `app/`, `lib/` or `components/` ever called them over the Data API, and every
in-database caller is a definer function executing as the owner. The right
treatment for a function nobody calls is not a guard bolted onto it — it is to
stop exposing it, which is a smaller surface than any check and has nothing to
keep correct over time.

`user_can_see_branch` was in that revoke set until the full database suite
proved an existing equivalence test needs it evaluated in a real session. It is
exempt on its own evidence instead: it returns whether *this* caller may see a
branch, reading nothing out of the branch, so calling it tells a caller only
what they already know about themselves.

Class B went unused deliberately: every one of the sixteen reads a
capability-gated table, so invoker mode would not tighten them, it would empty
them — a behaviour change dressed as a security fix.

### Task 6 — `company_identity` · RESOLVED as a reviewed exemption (`20261106000300`)

Measured, not assumed. On a clean database, as a session holding no
`settings:view`:

```
security_invoker = on   ->  0 rows
security_invoker = off  ->  1 row
```

`company_settings` requires `settings:view` to read, and no borrower holds it.
So flipping the mode does not tighten this view — it empties it, and takes
borrower receipts and the forced-password recovery screen's branding with it.
`GET /company_identity` is in `enforce_password_change`'s allowlist precisely so
a forced session can still render. That is the breakage the brief warned
against, and it is why the view stays `security_invoker = off`.

The controls are the projection and the grant: a fourteen-column allowlist of
published facts, with the registration and tax numbers absent and behind
`settings:view`, and `anon` holding nothing.

**One latent risk found and converted into an invariant.** The view is a simple
single-table SELECT, so PostgreSQL reports it auto-updatable; combined with
`security_invoker = off`, a write through it would run as the owner and bypass
`company_settings` RLS, skipping `settings:update` entirely. Unreachable today
only because `authenticated` holds `SELECT` and nothing else — so the grant is
the whole control, and it is now asserted by both the regression suite and the
CI gate. A stray `GRANT UPDATE` fails CI instead of quietly opening a write path
into company configuration.

Regression coverage added for the projection, the SELECT-only grant, borrower
readability, anonymous denial, and the invoker-mode evidence itself kept
executable rather than asserted in a comment.

### Task 7 — The security CI gate · COMPLETE and verified to fail closed

`scripts/check-database-security.mjs`, wired as a step inside the required
`database (real PostgreSQL)` job, with `npm run check:security`.

It compares the live privileged surface against
`config/database-security-baseline.json` — 110 functions and 1 definer view,
each carrying a classification and a reason — and fails on: a new definer
function reachable by an exposed role; a changed grant; a new or altered definer
view; any reliance on PUBLIC's default EXECUTE; a public table without RLS; an
unpinned `search_path`; the loan approval rules moving back in front of their
wrapper; the internal name becoming `authenticated`-executable; exposed roles
holding anything but `SELECT` on `company_identity`; or a baseline entry with no
justification. Shrinking is reported too, so the exception list cannot keep
claiming exceptions that no longer exist.

**It does not judge safety by reading bodies.** `has_function_privilege` is used
rather than parsing ACLs, because it resolves the PUBLIC pseudo-role — the case
a hand-read misses, since the ACL is null. Helper-name detection is printed as
advisory and decides nothing; the gate demonstrates the point on itself by
flagging the two newly guarded savings wrappers as "references no authorization
helper", because their guard is a function the regex does not know.

Verified: granting `authenticated` EXECUTE on
`savings_withdrawable_amount_internal` makes the gate **exit 1** and name the
function; revoking it returns **exit 0**.

### Task 8 — Real authentication certification · PARTIAL

Recorded honestly rather than claimed. Three distinct environments are involved:

| Coverage | Status | Evidence |
| --- | --- | --- |
| Role matrix, forced-password, inactive/suspended, borrower privacy, cross-branch isolation, private Storage — **at the data layer** | **PASS** | 1850 database tests on a real PostgreSQL cluster, including the 29 new Phase 2 cases. Every role is a real profile with a real JWT claim; every negative case asserts the refusal *and* that authorized callers still get the right figure |
| Real Supabase Auth sign-in, session expiry and refresh, logout against protected routes — **isolated stack** | see §6 | The pinned real Auth binary `v2.197.0` was downloaded and its SHA-256 **independently verified** as `b5c299…9f7ea`, matching the pin in `POLYTOS-SECURITY-RELEASE-GATES.md`; PostgREST `v12.2.3` likewise |
| `security release rehearsal (PostgreSQL 17, real Auth)` | **BLOCKED locally → covered by CI** | The rehearsal asserts PostgreSQL 17. Only 16 is installed here, and installing 17 failed because the session's network policy denied `www.postgresql.org` (403). CI runs it natively on PG 17 and is the authority |
| **Hosted** authenticated negative-role certification | **BLOCKED — needs authorization** | Requires approved test identities on production, a Product Owner decision that was never taken. No isolated environment substitutes for it. Checklist Step 7 |

No real customer credentials appear in any log, report or test fixture.

### Task 9 — Validation · see §6

### Task 10 — Release sequence · COMPLETE

`docs/POLYTOS-RELEASE-AUTHORIZATION-CHECKLIST.md` — nine steps, each marked with
who must authorize it. Nothing in it has been executed.

The ordering is deliberate: branch protection is activated **before** PR #19
merges, because `strict` required checks demand a branch be up to date before
merging. Protecting first means PR #19 is already up to date and merges cleanly;
protecting after a merge means the next pull request has to be refreshed first.

---

## 4. Changes implemented

All on `ccr-2f5e3786-jo3efn`, commit **`a76dd26`**.

| File | What |
| --- | --- |
| `supabase/migrations/20261106000100_guard_loan_validation_disclosure.sql` | Rename + authorized wrapper on `loans:view` |
| `supabase/migrations/20261106000200_guard_consent_code_redemption.sql` | Mirror the issuer's capability pair; spend no attempt on refusal |
| `supabase/migrations/20261106000300_record_company_identity_exemption.sql` | Reviewed exemption recorded; grant restated. No behaviour change |
| `supabase/migrations/20261106000400_retire_unused_definer_grants.sql` | Withdraw `authenticated` EXECUTE from seven uncalled functions |
| `supabase/migrations/20261106000500_guard_savings_amount_disclosure.sql` | Close the confirmed savings disclosure; add `require_savings_account_access` |
| `scripts/check-database-security.mjs` | The CI gate |
| `scripts/probe-definer-authorization.mjs` | The behavioural probe, kept reproducible |
| `scripts/apply-branch-protection.mjs` | Apply-and-read-back, refuses a deadlocking config |
| `config/database-security-baseline.json` | 110 functions + 1 view, classified and justified |
| `config/branch-protection.json` | The authorized configuration, with per-setting rationale |
| `tests/db/security-definer-surface.test.ts` | 29 new cases, both directions on every fix |
| `docs/POLYTOS-SECURITY-RISK-INVENTORY.md` | The reviewed register |
| `docs/POLYTOS-RELEASE-AUTHORIZATION-CHECKLIST.md` | The nine-step sequence |
| `.github/workflows/ci.yml`, `package.json` | Gate wired into the required job |
| `tests/db/security.test.ts` | Two existing allowlists updated to match |
| `tests/db/benefits-undecided.test.ts` | One case reads its function as the owner |
| `types/database.types.ts` | Four new functions declared |

### Tests touched, and why that is not a weakening

Three existing tests caught these changes, which is what they are for.

- `security.test.ts > marks exactly the intended functions SECURITY DEFINER` —
  four new internal functions added to an exhaustive list.
- `security.test.ts > grants authenticated only the session-scoped helpers` —
  the seven revoked names removed. **The list getting shorter is the point.** A
  stale comment claiming the two savings functions "must give the same answer to
  every caller" was corrected, because after `20261106000500` they must not.
- `benefits-undecided.test.ts > says exactly what is missing` — reads
  `benefits_blocked_reason` as the owner now that the `authenticated` grant is
  gone. Its assertions are untouched: the function's result is a pure function
  of the policy version and does not depend on the caller, and the same wording
  is separately asserted through `assess_benefit_claim`'s refusal, which is the
  path users actually meet.

No assertion was loosened and no test was skipped or disabled.

---

## 5. Remaining vulnerabilities and risks

| | Item | Severity |
| --- | --- | --- |
| **R1** | **Nine `SECURITY DEFINER` functions take a third-party identifier and produced no refusal under the borrower probe.** Neither confirmed safe nor confirmed leaking — a NULL argument cannot reach a guard that resolves its row first, and the retest that found the savings disclosure has not been pointed at them. Two of the nine mutate (`assess_meeting_fines`, `mark_notifications_read`). Listed in the inventory §5 | **Open, unquantified** |
| **R2** | Branch protection authorized but not applied (§3 Task 2). Until then nothing enforces that the gate passed before a release merges | High |
| **R3** | Leaked-password protection still disabled. Operator dashboard only | Medium |
| **R4** | `__gate_probe` still in production — the only anon-readable object. Inert (provably non-writable, discloses the constant `1`) but removed only when PR #19 merges | Low |
| **R5** | `company_identity` remains an advisor ERROR by design (§3 Task 6). Removing the finding rather than documenting it needs column-level privileges on `company_settings` — a schema change, not a view setting | Accepted |
| **R6** | The gate watches the surface for change; it does not re-prove that each of the 84 functions classified **A** checks the right capability on every path. They rest on their domain suites plus the probe | Residual |
| **R7** | Local database verification ran on PostgreSQL **16**; CI and production are **17**. The PG 17 rehearsal is CI-only (§3 Task 8) | Low |
| **R8** | Hosted authenticated negative-role certification not performed — needs approved production test identities (checklist Step 7) | Open, needs a decision |

---

## 6. Automated test results

Exact counts from this session, on the Phase 2 tree at `a76dd26`, PostgreSQL 16
local cluster, Node 22 / npm 10.9.9.

| Suite | Result |
| --- | --- |
| **Database security gate** | **PASS** — 110 definer functions reachable by `anon`/`authenticated`, 1 definer view, no unreviewed exposure. Fail-closed verified: exit **1** when widened, **0** when restored |
| `npm run typecheck` | **PASS** — clean |
| `npm run lint` | **PASS** — clean |
| `npm run format:check` | **PASS** — all files match Prettier |
| `vitest --project db` | **PASS** — 80 files, **1850 passed**, 0 failed, 0 skipped (1816 baseline + 34 new) |
| `tests/db/security-definer-surface.test.ts` | **PASS** — **34 passed**, the Phase 2 regression suite |
| `npm run test:run` (unit + integration) | **PASS** — see note below |
| `npm run audit:money` | **PASS** — 71 financial files, no hazard; all five engines reach only integer/BigInt helpers; 2 verified exemptions; scanner verified against a positive control |
| `npm run build` | **PASS** — exit 0 |
| Fresh migration replay | **PASS** — all **166** migrations applied in order to an empty cluster, no error |
| Behavioural authorization probe | 110 probed: 20 refused `42501`, 52 refused with an authorization message, 11 inconclusive, 27 no refusal |
| `security release rehearsal` (PG 17, real Auth) | **BLOCKED locally** — requires PostgreSQL 17; `www.postgresql.org` denied by the session's network policy (403). CI is the authority |
| Playwright desktop/mobile browser E2E | **Not run locally** — CI is the authority |

The unit and integration run initially reported **1 failed / 2646 passed**: the
schema-versus-types test correctly caught that `types/database.types.ts` did not
yet declare the four new functions. After declaring them,
`tests/integration/migrations.test.ts` passes 28/28 and the full suite is green.
Final counts for the record are in the pull request, re-run after the last
commit.

No test was weakened, skipped or disabled to obtain any of these results.

---

## 7. Preservation requirements — verified

| Requirement | Status |
| --- | --- |
| 35 loans, 470 payments, 597 journal entries preserved | **Verified unchanged** — read before and after; no migration was applied to production |
| Financial calculations, transactions, audit history | **Unchanged.** Both guarded bodies moved by `ALTER FUNCTION ... RENAME TO`, so no arithmetic was retyped. No row read or written |
| Policy 2.0 draft, flags disabled | **Verified** — `draft`, `effective_from` null, `approved_at` null, all five flags false |
| Unrelated Supabase project untouched | **Verified** — only `fszgwemtgyrbhngajpzm` was used |
| No authorization test or CI gate bypassed | **Verified** — three existing gates caught these changes and were updated to match, not around |
| No unnecessary UI redesign | **Verified** — no UI file changed |
| No unrelated features | **Verified** — every change traces to a Phase 1 finding or a Phase 2 task |

---

## 8. Verdict

### PASS, with one task BLOCKED and one PARTIAL.

| Task | Verdict |
| --- | --- |
| 1 — PR #19 revalidation | **PASS** — no discrepancy; recommended for merge |
| 2 — Branch protection | **BLOCKED** — authorized, prepared, verified non-deadlocking; cannot be applied from this session |
| 3 — Loan-validation disclosure | **PASS** — fixed, both directions proved |
| 4 — Consent redemption | **PASS** — fixed, both directions proved |
| 5 — The sixteen classified | **PASS** — 2 A, 7 C, 7 D, 0 B |
| 6 — `company_identity` | **PASS** — reviewed exemption on measured evidence, with regression coverage |
| 7 — Security CI gate | **PASS** — enforced in the required job, verified to fail closed |
| 8 — Real-auth certification | **PARTIAL** — data layer PASS; PG 17 rehearsal CI-only; hosted certification needs authorization |
| 9 — Final validation | **PASS** — all runnable suites green |
| 10 — Release sequence | **PASS** — nine steps, authorization marked |

**Production certification remains NOT GRANTED**, and Phase 2 does not grant it.
Four items need a person: branch protection (authorized, blocked), PR #19's
merge, the production migration application, and leaked-password protection.
R1's nine functions should be settled before a release that claims a clean
privileged surface — the method that found the savings disclosure has not yet
been pointed at them, and one of the two things it has been pointed at was a
real vulnerability.

### Recommended Phase 3 opening conditions

1. **R1 first.** Retest the nine exactly as §1 did — build the record as the
   owner, read it as an unrelated borrower, compare against the owner's answer.
   The two mutating ones before the seven read-only ones.
2. Branch protection applied and read back as in force.
3. PR #19 and the Phase 2 pull request merged; the seven migrations applied
   under the checklist; the advisor's `security_definer_view` count down to 1.
4. Leaked-password protection enabled.
5. A decision on hosted authenticated certification (checklist Step 7) — the one
   gap no isolated environment can close.

---

*Prepared by Claude Code as Lead Implementation Engineer. Awaiting ChatGPT's
independent architecture and QA review before Phase 3.*
