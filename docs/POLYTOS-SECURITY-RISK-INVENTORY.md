# POLYTOS security risk inventory

**Phase 2, 6 November 2026.** The reviewed register of every privileged database
object the Data API can reach, why each is where it is, and what is still open.

`config/database-security-baseline.json` is the machine-readable half of this
document and `scripts/check-database-security.mjs` enforces it in CI. This file
holds the reasoning; that file holds the facts the gate compares against.

---

## 1. How these conclusions were reached

Phase 1 classified functions by reading their bodies for the name of an
authorization helper. That is the method the Phase 2 brief forbids, and it was
right to: **a helper name in a body proves nothing.** A body can mention
`user_has_permission` in a comment, call it and throw the answer away, check the
wrong capability, or check the right one on a path the interesting input never
takes. A regex says "guarded" to all four.

So Phase 2 measured instead. `scripts/probe-definer-authorization.mjs` calls
every `SECURITY DEFINER` function an `authenticated` session may execute, as a
borrower holding no business capability, with NULL for every argument, inside a
transaction that is always rolled back. A guard at the top of a function fires
before it looks at its arguments, so the SQLSTATE that comes back is evidence
about whether a check actually ran.

Result over the 110 such functions:

| Probe verdict | Count | What it means |
| --- | --- | --- |
| Refused with `42501` | 20 | An authorization refusal ran before the body |
| Refused with an authorization message | 52 | Same, raised as `P0001` with explicit wording |
| Inconclusive — other error first | 11 | Argument validation fired before any check |
| **No refusal** | **27** | Reached the body with no authorization check |

### The probe's limitation, stated plainly

A NULL argument cannot exercise a guard that resolves its row first. Three of
the 27 "no refusal" results are functions whose guard looks up the named record
before deciding, so a NULL identifier returns early and no refusal is raised —
the guard is real and a real identifier reaches it. **A "no refusal" is a prompt
to retest with a real identifier, not a verdict.**

That retest is what found the one confirmed vulnerability below, and it is what
nine functions are still waiting for (§5).

---

## 2. The confirmed vulnerability Phase 2 found and fixed

### Cross-member savings disclosure — `savings_withdrawable_amount`, `savings_pledged_amount`

Migration **`20261106000500`**. Found by retesting a "no refusal" probe result
with a real third party's account on a throwaway database:

| | Value seen |
| --- | --- |
| A member's savings account, one 750,000 deposit | — |
| What the owner (service path) saw | **750000** |
| What an **unrelated borrower** saw | **750000** |

An active identity holding no savings capability, with no relationship to the
member and no branch in common, read that member's true withdrawable balance.
Only the account's UUID was required.

**Why the existing guard missed it.** Both functions already called
`require_business_identity()`, and migration `20261103000100` listed them among
the RPCs it had guarded. That guard is real, but it answers a different
question: it refuses forced-password, inactive, suspended and unlinked sessions.
It says nothing about capability, so every ordinary borrower passes it. The
earlier classification was accurate about what the guard does and wrong about
what it was sufficient for — exactly the failure a body-reading method cannot
see.

**The fix.** Both are now thin wrappers over internal functions that keep the
arithmetic byte for byte (`ALTER FUNCTION ... RENAME TO`, so nothing was
retyped). Both delegate through `require_savings_account_access`, which reuses
`member_savings_position`'s existing answer: the caller's branch must cover the
membership, and the caller must hold `savings:view` or
`member_loans:view_eligibility`, or be the linked borrower reading their own
account. Trusted no-JWT paths keep their bypass.

A plain revoke would have been smaller and was rejected: the
`member_loan_eligibility` view is `security_invoker = true`, so its readers need
EXECUTE in their own right, and revoking would have broken the eligibility
screen for the staff who are meant to use it.

Verified both ways in `tests/db/security-definer-surface.test.ts`: the unrelated
borrower is refused `42501`, and owner, manager and secretary_treasurer each get
**750000** — the figure, not merely access.

---

## 3. The sixteen from the Phase 1 report

Phase 1 recorded sixteen `SECURITY DEFINER` functions executable by
`authenticated` with no authorization check. Treatment classes: **A** guarded ·
**B** converted to `SECURITY INVOKER` · **C** made internal (no exposed-role
grant) · **D** justifiably exempt with evidence.

**Outcome: 2 guarded (A), 7 made internal (C), 7 exempt (D), 0 converted (B).**
The exposed set of these sixteen falls from 16 to 9, and the exception list
from 16 to 7.

| # | Function | Returns | Direct + indirect callers | Externally callable now | Treatment |
| --- | --- | --- | --- | --- | --- |
| 1 | `validate_loan_for_approval(uuid)` | `TABLE(failure_code, detail)` — every rule a loan fails | `approve_loan` only (5 sites, each already behind `loans:approve`); `lib/data/loans.ts:444` | Yes — guarded | **A** |
| 2 | `redeem_membership_consent_code(uuid, text)` | `uuid` — proves a code match | `lib/membership/actions.ts:549` | Yes — guarded | **A** |
| 3 | `benefit_blocked_reason(uuid, text)` | `text` — which benefit rule is undecided | 4 definer functions; no app RPC | **No** | **C** |
| 4 | `benefits_blocked_reason(uuid)` | `text` — same, benefits as a whole | 1 definer function; no app RPC | **No** | **C** |
| 5 | `member_lending_blocked_reason(uuid)` | `text` — same, member lending | 3 definer functions; no app RPC | **No** | **C** |
| 6 | `benefit_expense_account(text)` | `uuid` — the GL account a claim type expenses to | 1 definer function; no app RPC | **No** | **C** |
| 7 | `membership_fee_is_posted(uuid)` | `boolean` — whether a named membership paid | 1 definer function; no app RPC | **No** | **C** |
| 8 | `membership_terms_are_accepted(uuid)` | `boolean` — whether a named membership accepted | 1 definer function; no app RPC | **No** | **C** |
| 9 | `savings_account_governing_policy(uuid, date)` | `uuid` — the policy governing an account | 6 definer functions; no app RPC | **No** | **C** |
| 10 | `active_membership_policy_id()` | `uuid` — the version in force | 1 function **and the `memberships_insert_with_permission` WITH CHECK policy** | Yes | **D** |
| 11 | `membership_policy_allows(uuid, text)` | `boolean` — is this activity open | 17 functions **and the `member_loan_eligibility` view (`security_invoker = true`)** | Yes | **D** |
| 12 | `membership_governing_policy(uuid, date)` | `uuid` — the policy governing a membership | 12 functions **and the `membership_register` view (`security_invoker = true`)** | Yes | **D** |
| 13 | `business_timezone()` | `text` | 8 functions **and the `loan_schedules_timezone_not_blank` CHECK constraint** | Yes | **D** |
| 14 | `business_now()` | `timestamptz` — the business clock | 23 functions; called by the application | Yes | **D** |
| 15 | `consume_rate_limit(text, text, int, int)` | `TABLE(allowed, remaining, retry_after)` | the rate limiter itself; allowlisted in `enforce_password_change` | Yes | **D** |
| 16 | `user_can_see_branch(uuid)` | `boolean` — may *this* caller see that branch | 30 functions; `tests/db/rls-hoisting.test.ts` evaluates it in a session | Yes | **D** |

### Why the seven became internal rather than guarded (C)

Migration **`20261106000400`**. For each of the seven, nothing in `app/`, `lib/`
or `components/` ever issued an RPC, and every caller inside the database is
another `SECURITY DEFINER` function, which executes as the owner and so does not
need the caller to hold EXECUTE.

The right treatment for a function nobody calls is not a guard bolted onto it —
it is to stop exposing it. PostgREST can only reach what the request's role may
execute, so withdrawing the grant removes the route entirely: a smaller surface
than any check, and nothing to keep correct over time. `postgres` and
`service_role` keep EXECUTE throughout.

Each leaked little on its own — configuration and policy metadata rather than a
member's money. Together they were seven capability-free routes into per-member
facts with no reason to exist.

### Why the seven are exempt (D)

Two distinct grounds, both checked rather than assumed:

- **Four are depended on in the caller's own context** — an RLS `WITH CHECK`
  expression (#10), two `security_invoker = true` views (#11, #12) and a `CHECK`
  constraint (#13). Revoking any of them turns a correct silent denial into
  `permission denied for function` on an ordinary insert or register read.
- **Three disclose nothing worth withholding** — the business clock (#14), the
  rate limiter that `enforce_password_change` deliberately allowlists so a
  forced session can still be throttled (#15), and an authorization predicate
  whose entire answer is about the caller (#16). `user_can_see_branch` takes a
  branch id and returns whether *this* session may see it, reading nothing out
  of the branch, so calling it tells a caller only what they already know about
  themselves.

### Class B was not used

No function was converted to `SECURITY INVOKER`. Every one of the sixteen reads
a table that is capability-gated by RLS, so invoker mode would not tighten
them — it would empty them, which is a behaviour change dressed as a security
fix. The same measurement settled `company_identity` (§4).

---

## 4. `company_identity` — a reviewed definer-view exemption (D)

Migration **`20261106000300`** (documentation and a restated grant; no
behaviour change).

Supabase's `security_definer_view` linter reports this at **ERROR** because it
is `security_invoker = off`. That is deliberate. The view exists so every
signed-in user — borrowers included — can read the company's published identity,
because a receipt has to say who issued it and the forced-password recovery
screen has to brand itself before the session holds any capability at all.
`GET /company_identity` is in `enforce_password_change`'s allowlist for that
reason.

`company_settings` requires `settings:view` to read, which no borrower holds. So
the caller's privileges are precisely the wrong privileges here. Measured on a
clean database, as a session with no `settings:view`:

```
security_invoker = on   ->  0 rows
security_invoker = off  ->  1 row
```

Flipping the mode does not tighten the view; it empties it, and takes borrower
receipts and password recovery with it.

**The controls are the projection and the grant.** The view is a fourteen-column
allowlist of published facts; the registration number, tax identification number
and every other `company_settings` column are absent and stay behind
`settings:view`. `anon` holds nothing.

**One latent risk, now an invariant.** The view is a simple single-table SELECT,
so PostgreSQL reports it auto-updatable. With `security_invoker = off`, a write
through it would run as the owner and bypass `company_settings` RLS, skipping
`settings:update` entirely. That is unreachable today only because
`authenticated` holds SELECT and nothing else — so the grant is the whole
control, and it is now asserted both by
`tests/db/security-definer-surface.test.ts` and by the security gate. A stray
`GRANT UPDATE`, or a change in Supabase's default privileges, fails CI instead
of quietly opening a write path into company configuration.

---

## 5. Open items

### R1 — Nine functions awaiting a real-identifier retest (`PENDING-REVIEW`)

Each produced **no authorization refusal** under the borrower probe and takes a
third-party identifier. They are neither confirmed safe nor confirmed leaking;
the method that found the savings disclosure has not yet been pointed at them.

| Function | Identifier it accepts |
| --- | --- |
| `client_has_live_loan(uuid)` | a client |
| `member_benefit_position(uuid, date)` | a membership |
| `benefit_claim_eligibility(uuid)` | a benefit claim |
| `benefit_payment_blocked_reason(uuid)` | a benefit claim |
| `condolence_next_of_kin_status(uuid)` | a benefit claim |
| `death_confirmation_count(uuid)` | a benefit claim |
| `assess_meeting_fines(uuid)` | a meeting — **and it mutates** |
| `meeting_fine_candidates(uuid)` | a meeting |
| `mark_notifications_read(uuid[])` | notification ids — **and it mutates** |

Recommended Phase 3 opening move: retest each exactly as §2 did — build the
record as the owner, read it as an unrelated borrower, compare against the
owner's answer. The two mutating ones first.

`member_savings_position` was in this set and is now resolved: it refuses with
`42501` when given a real membership, so its guard is real and the probe result
was the NULL-argument artefact described in §1.

### R2 — Branch protection is authorized but not applied

The Product Owner authorized applying it. It could not be applied from the
session: the GitHub App token lacks the Administration permission (403 on
reading protection) and the agent proxy forbids writes to the branch-protection
API path (403 on PUT). The branch still reports `protected: false`.

`config/branch-protection.json` and `scripts/apply-branch-protection.mjs` are
ready; one command applies and verifies them. Until then nothing enforces that
the security gate has passed before a release merges.

### R3 — Leaked-password protection remains disabled

Supabase Auth's HaveIBeenPwned check is off. Operator dashboard action; not
reachable from the repository.

### R4 — The gate watches the surface, not every function's semantics

`check-database-security.mjs` detects **change**: a new privileged function, a
widened grant, a lost `security_invoker`, an unpinned `search_path`, a table
without RLS, a reliance on PUBLIC's default EXECUTE. It does not re-prove that
each of the 84 functions classified **A** checks the right capability on every
path. Eighty-four rest on their domain security suites plus the Phase 2 probe;
nine are R1; the gate's job is to make sure the set does not grow unnoticed.

### R5 — `__gate_probe` is still in production

Removed by PR #19, which is unmerged. It cannot be caught by the gate in CI
because it exists only in production, having been created out of band. After the
merge and migration, the advisor's `security_definer_view` count should fall
from 2 to 1 — `company_identity`, the reviewed exemption in §4.

---

## 6. What the gate enforces

`npm run check:security`, as a step inside the required `database (real
PostgreSQL)` CI job. It fails when:

- a `SECURITY DEFINER` function reachable by `anon` or `authenticated` is not in
  the reviewed baseline, or its reachability changed;
- a definer view appears, or its `security_invoker` setting or exposed-role
  grants change;
- any function relies on PUBLIC's default EXECUTE (a null ACL);
- a public table has RLS disabled;
- a function does not pin `search_path`;
- the loan approval rules move back in front of the authorization wrapper, or
  the internal name becomes executable by `authenticated`;
- exposed roles hold anything but `SELECT` on `company_identity`;
- a baseline entry has no classification and reason.

Shrinking the surface is also reported, so the exception list cannot keep
claiming exceptions that no longer exist. Helper-name detection is printed as
advisory and decides nothing — demonstrated by the gate itself flagging the two
newly guarded savings wrappers as "references no authorization helper", because
their guard is a function the regex does not know.

Verified to fail closed: granting `authenticated` EXECUTE on
`savings_withdrawable_amount_internal` makes the gate exit 1 and name the
function; revoking it again returns exit 0.
