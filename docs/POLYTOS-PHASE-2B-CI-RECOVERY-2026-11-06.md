# POLYTOS Phase 2B — CI recovery and final security verification

**Date:** 6 November 2026 · **Branch:** `ccr-2f5e3786-jo3efn` · **PR:** [#20](https://github.com/JTREVORM/lending-manager/pull/20)
**Baseline reviewed by ChatGPT:** `bd04beb` · **Supabase project:** `fszgwemtgyrbhngajpzm` only.

**No production change.** No merge, deployment, migration application,
configuration change, account change or financial write.

---

## 1. Root cause of each CI failure

Both failures at `bd04beb` came from the same mistake, made twice: asking which
objects **name** a function, when the question is which objects **run in the
caller's context**.

### 1.1 Database job — `Upgrade and existing-borrower demo integration`

Everything else in that job passed: the fresh cluster applied all 167
migrations, the security gate passed, and all 1850 database tests passed. Only
the upgrade rehearsal failed.

**Not a migration defect — a classification error in the rehearsal's own split.**
`scripts/verify-membership-upgrade.mjs` divides the migration list into "the
released production schema" and "the upgrade applied on top", by filename
prefix. The five Phase 2 migrations are prefixed `20261106`, which was not in
`PHASE_PREFIXES`, so they were treated as **already deployed** and applied
**first** — before the `20261019`–`20261028` migrations that create the tables
they reference.

`20261106000200` declares `public.membership_consent_challenges%rowtype`, and
PL/pgSQL resolves `%ROWTYPE` **when the function is created**, not when it is
first called. So it failed at the `CREATE`, at the `$function$;` terminator on
line 114, with `relation "public.membership_consent_challenges" does not exist`.

**The historical fixture does legitimately predate that table.** The expected
upgrade path is the one the script already documents for `20261103`, in the same
comment:

> *"Applied as 'existing' it runs before them and fails with `type
> "public.savings_accounts" does not exist`."*

`20261106` belongs in that list for exactly the same reason: none of the five is
deployed, so all five are part of the upgrade. `20261106000500` has the same
shape against `savings_accounts` and `memberships`, and `20261106000400` revokes
on functions that `20261020`, `20261022` and `20261028` create.

No migration is skipped, no object fabricated and the rehearsal is not relaxed.
It is a **stronger** test afterwards, because the five now land on a seeded book
between the two financial baselines, so the claim that an authorization guard
moves no money is measured rather than asserted.

### 1.2 Browser job — 31 failures

**A broken privilege chain, not a broken capability check.**

`20261106000400` withdrew the `authenticated` grant from
`savings_account_governing_policy` after confirming that no view, no RLS policy,
no CHECK constraint and no application route named it. All four answers were
correct. All four were the wrong question:

```
lib/data/savings.ts ──rpc──▶ member_savings_qualification        [SECURITY INVOKER]
                                  └──▶ savings_account_governing_policy
                             savings_qualification_under_policy  [SECURITY INVOKER]
                                  └──▶ savings_account_governing_policy
```

A `SECURITY INVOKER` function executes with the privileges of **whoever called
it**. So although the application never names the function, the session calling
`member_savings_qualification` needed EXECUTE on it in its own right, and
without the grant every such call failed with `permission denied for function
savings_account_governing_policy`.

That is the whole failure cluster, and it explains each one the brief listed:
the savings account detail, the withdrawal and reversal screens, the responsive
savings pages, the borrower portal, and the authorization error boundaries that
rendered because the server action threw.

**The new grants did not break legitimate access by being too strict.** The
capability checks added in Phase 2 refused nobody who should have been admitted;
a withdrawn *grant* broke a privilege chain. No borrower was given broader
permissions to fix it, no test was removed and no assertion relaxed.

The other six functions revoked by `20261106000400` stay revoked: every one of
their callers is `SECURITY DEFINER`, and a definer hop ends the privilege chain
because it runs as its owner.

### 1.3 Why converting the two invoker functions was rejected

Making `member_savings_qualification` and `savings_qualification_under_policy`
`SECURITY DEFINER` would also have removed the need for the grant. Both read
member data and are invoker **deliberately**, so Row Level Security on the
tables underneath decides what each caller sees. Converting them would move that
decision out of RLS and into hand-written checks inside two more privileged
functions — strictly more privileged code — in order to avoid granting a
function that returns a policy version's UUID.

---

## 2. Changes made

| Commit | What |
| --- | --- |
| `84be508` | `PHASE_PREFIXES` + `20261106`; migration `20261106000600` restoring the grant; the invoker-chain invariant in the security gate; branch-protection manual steps |
| `b751039` | `tests/db/definer-third-party-access.test.ts`; migrations `20261106000700` and `20261106000800`; `savings_account_governing_policy` back in the `security.test.ts` allowlist |
| `84d3ac9` | Notification fixture corrections; risk inventory R1 rewritten; invoker-chain check recorded in the gate's enforcement list |

### New migrations

| Migration | Purpose |
| --- | --- |
| `20261106000600` | Restores `savings_account_governing_policy` to `authenticated`; reclassified **C → D** with the invoker-chain evidence |
| `20261106000700` | Guards `client_has_live_loan` — **a confirmed disclosure** (§4) |
| `20261106000800` | Makes `assess_meeting_fines` refuse up front. **Not a leak fix** (§4) |

### So the class cannot recur

The gate now walks the `SECURITY INVOKER` call graph **transitively** and fails
when an invoker-reachable caller depends on something the role cannot execute.
Pointed at the broken state it named both real callers and the exact remedy.

Two refinements it needed, both worth recording:

- **References are matched call-shaped.** The first version read the
  pre-request hook's route allowlist — `'/rpc/record_sign_in'` and friends — as
  calls, producing four false findings. Four false positives in CI train people
  to ignore a check.
- **Genuine but unreachable dependencies are reviewed exemptions**, keyed on
  role, caller and target together so widening any one of them is a new finding;
  `--update` carries them forward rather than regenerating them. One is
  recorded: `anon` reaching `current_session_context` through
  `enforce_password_change`, which cannot happen because the hook returns when
  `auth.uid()` is null. Granting it to `anon` would widen the surface to silence
  a finding about a call `anon` cannot make.

This is the one place the gate matches text against a function body, and the
direction is deliberate: PL/pgSQL bodies create no catalog dependencies, so
there is nothing else to read, and over-matching here produces a **failure a
human resolves**, never a pass. Inferring safety from a helper's name stays
advisory and decides nothing.

---

## 3. Proof the historical upgrade works

`node scripts/verify-membership-upgrade.mjs`, locally:

```
Upgrade verified: 97 existing migrations, a seeded book, then 69 new migrations.
Every one of 28 financial figures is identical, the 22 membership, savings,
member loan, benefit and meeting tables exist and are empty, and
2100 Member Savings is zero.

verified: six existing borrowers enrolled, non-members retained, loan book
untouched, full financial fixed point on runs 2 and 3, liability reconciled

{"loans":"17","loan_principal":"9600000","loan_interest":"1290000",
 "scheduled_repayment":"8015000","loan_payments":"161","memberships":"8",
 "acceptances":"7","savings_subledger":"1790000","liability_2100":"1790000",
 "benefit_payments":"1","historical_benefit_payments":"20000",
 "ledger_debits":"17672540","ledger_credits":"17672540"}

Verified 26 existing financial/identity tables; all records, balances and
historical approvals preserved.
```

Ledger debits equal credits. All 28 financial figures identical across the
upgrade. The split moved from 102/64 to **97/69** because the five Phase 2
migrations are now correctly on the upgrade side.

A fresh replay of all **169** migrations onto an empty cluster also succeeds,
and the security gate passes against the result.

---

## 4. Nine-function security review

All nine retested with **real** third-party identifiers, as
`tests/db/definer-third-party-access.test.ts` — now permanent coverage, **22
tests passing**. Method: build a real record as the owner, read it as an
unrelated *linked* borrower (a real client profile with the `client` role, so
each function's own guard is under test and not `require_business_identity`),
and compare against what an authorized caller receives. Cross-branch coverage
comes from each guard's `user_can_see_branch` clause, exercised by the branch
the fixture member is enrolled at.

A null-argument probe was insufficient exactly as the brief said, and now there
is a concrete reason why: most of these resolve the record they were handed
**before** deciding anything, so a NULL identifier returns early and no guard is
ever reached.

### Priority 1 — the two that mutate

| Function | Verdict | Evidence |
| --- | --- | --- |
| `assess_meeting_fines` | **Safe, and tightened** | Refuses an unrelated borrower `42501` via `meeting_fine_candidates`, and writes nothing — fine count and audit count compared before and after. `20261106000800` moves the `fines:assess` check to the top |
| `mark_notifications_read` | **Safe, unchanged** | A borrower marking a staff-audience notification leaves `notification_reads` empty for that pair; staff succeed |

`20261106000800` is **not** a leak fix and is not presented as one. The
`fines:assess` check lived in the loop body, so a `fines:view`-only session
(`secretary_treasurer`) calling it against a meeting with nothing to assess
received a silent `0` rather than a refusal. Nothing was disclosed — `0` is what
an authorized caller sees too — and nothing was written. It is fixed because
authorization that holds only when there is work to do is a property nobody will
remember, and the singular `assess_meeting_fine` checks the capability as its
first act. The capability asked for is the one
`lib/policy-update/actions.ts` and `app/(app)/meetings/[meetingId]/page.tsx`
already require, so no legitimate caller can be turned away.

### The seven read functions

**One real disclosure.**

| | Value seen |
| --- | --- |
| A client with a disbursed, active loan | — |
| What `owner_admin`, `manager`, `secretary_treasurer` saw | **true** |
| What an **unrelated borrower** saw | **true** |

`client_has_live_loan` held only `require_business_identity()` — which refuses
forced-password, inactive, suspended and unlinked sessions and says nothing
about capability — then queried `public.loans` as the definer, bypassing RLS. An
identity with no loan capability, no relationship to that client and no branch
in common learned, correctly, that a named person is carrying a live loan. Only
the client's UUID was needed. **Same root cause as the Phase 2 savings
disclosure, and the second function an earlier body-reading pass had recorded as
guarded.**

`20261106000700` requires `loans:view` or `savings:view`, or the client's own
linked session. Verified against the live matrix: all three staff roles hold
both capabilities, the borrower holds neither. `lib/data/savings.ts` reads this
for the withdrawal screen with the caller's own JWT, so a revoke would have
broken that screen; the guard admits every role that legitimately reaches it.

**Six were already safe, in two different ways** that "produced no refusal" had
flattened into one.

Three refuse by raising `42501` once there is a real identifier to resolve —
the raises the null probe never reached:

| Function | Requires |
| --- | --- |
| `benefit_claim_eligibility` | `benefits:view` + branch, or the claimant's own session |
| `member_benefit_position` | `benefits:view` + branch, or own session |
| `meeting_fine_candidates` | `fines:view` or `fines:assess`, + branch |

Three refuse by **returning a safe value**, which is idiomatic for their return
types and still fail-closed — and not an existence oracle, because an
unauthorized caller cannot tell "filtered out" from "nothing there":

| Function | What an unauthorized caller gets | How |
| --- | --- | --- |
| `death_confirmation_count` | `0`, never the true count | predicate in the `WHERE` clause |
| `condolence_next_of_kin_status` | zero rows | predicate in the `WHERE` clause |
| `benefit_payment_blocked_reason` | `'That claim cannot be read.'` | explicit early return; it returns a reason |

**A correction to my own method.** My first version of this suite asserted that
all three *raise*, and would have reported three safe functions as vulnerable.
The property that matters is not "it raises" but "the unrelated borrower does
not receive what an authorized caller receives". That is what is asserted now.
Three further first-run failures were my fixtures, against three different
column conventions in one schema: `audit_log.entity_id` is text,
`notifications.entity_id` is uuid, and `notifications` has
`category`/`severity`/`entity_type` rather than `kind`, with `category` and
`dedupe_key` both constrained.

**Net: the PENDING-REVIEW set is empty.** Of the twenty-five functions this
programme has now tested behaviourally, two were real disclosures, and both had
been recorded as guarded by a pass that read bodies instead of calling them.

---

## 5. Automated results

See §7 for the authoritative CI run at the final head.

Local, PostgreSQL 16, 169 migrations:

| Suite | Result |
| --- | --- |
| Database security gate | **PASS** — 111 definer functions reachable by `anon`/`authenticated`, 1 definer view, no unreviewed exposure |
| Invoker-chain invariant | **Verified against the real bug**: named both callers and the fix; exit 1 when broken, 0 when restored |
| `vitest --project db` | **1870 passed / 1872** before the final fixture fix; the 2 failures were that fixture |
| `definer-third-party-access.test.ts` | **PASS — 22 of 22** |
| `verify-membership-upgrade.mjs` | **PASS** — 97 + 69 migrations, 28 financial figures identical, ledger balanced |
| Fresh migration replay | **PASS** — all 169 in order on an empty cluster |
| `npm run typecheck` / `lint` / `format:check` | **PASS** |

No test was removed, skipped or disabled, and no assertion was relaxed. Three
existing gates caught these changes and were updated to match rather than
around:

- the exhaustive `SECURITY DEFINER` list, for the new internal functions;
- the `authenticated`-EXECUTE allowlist, for the restored grant — with the
  invoker-chain reason recorded beside it so the next reader does not withdraw
  it again;
- one `benefits-undecided` case, which reads its function as the owner now that
  the grant it used is gone. Its assertions are untouched; the function's result
  is a pure function of the policy version and does not depend on the caller.

---

## 6. Remaining production blockers

| | Blocker | Owner |
| --- | --- | --- |
| **B1** | PR #19 is still a draft; its two security migrations are unapplied | Trevor |
| **B2** | PR #20 is a draft; nine migrations now await authorized application | Trevor |
| **B3** | **Branch protection authorized but not applied.** No token available to a session can set it: the GitHub App lacks Administration permission (403 on read) and the proxy refuses writes to that path (403 on PUT). The branch still reports `protected: false` | Trevor — §8 |
| **B4** | Leaked-password protection still disabled | Operator |
| **B5** | Hosted authenticated negative-role certification not performed; needs approved production test identities | Trevor |

### Risks carried forward

- **R1 — closed.** The PENDING-REVIEW set is empty (§4).
- **R2** `company_identity` remains an advisor ERROR by design. Removing the
  finding rather than documenting it needs column-level privileges on
  `company_settings` — a schema change, not a view setting.
- **R3** The gate watches the privileged surface for *change*; it does not
  re-prove that each function classified **A** checks the right capability on
  every path. Twenty-five are now proved behaviourally; the rest rest on their
  domain suites.
- **R4** Local verification used PostgreSQL **16**; CI and production are **17**.
  The PG 17 rehearsal, and with it local Storage and cross-branch coverage, is
  CI-only.
- **R5** `__gate_probe` is still in production, removed only when PR #19 merges.
- **R6** A second maintainer, so required approvals can rise from 0 to 1.

---

## 7. CI at the final head

To be completed from the run on the final PR #20 head. All four required jobs
must pass:

- `checks, unit/integration, build`
- `database (real PostgreSQL)` — including the security gate step and the
  upgrade rehearsal that failed at `bd04beb`
- `security release rehearsal (PostgreSQL 17, real Auth)`
- `browser E2E (production build, fresh seed)`

---

## 8. Branch protection — manual steps

Full instructions, with the four exact check names, the read-only verification
commands and the reason each setting is what it is:
**`docs/POLYTOS-BRANCH-PROTECTION-MANUAL-STEPS.md`**

In summary, and not a claim that any of it is in place:

- Require a pull request before merging, with **0 required approvals** — there
  is one collaborator and GitHub forbids self-approval, so at 1 **no pull
  request could ever merge**. That is the only value that changes the day a
  second maintainer exists.
- Require the **four** unconditional CI checks, and require branches to be up to
  date. Not the path-filtered production smoke, not the third-party Vercel or
  Supabase checks: a required check that can skip leaves a pull request pending
  for ever.
- **No admin bypass** — "Rules applied to everyone including administrators"
  ticked. This does not deadlock anything, because approvals are 0.
- No force pushes, no deletions, conversation resolution required.
- Apply it **before** merging PR #19 and PR #20, because `strict` requires a
  branch to be up to date and both are up to date now.

Read-only verification, which changes nothing:

```bash
node scripts/apply-branch-protection.mjs          # exits 0 only if in force as configured
gh api repos/JTREVORM/lending-manager/branches/claude%2Fintelligent-knuth-2r8mpw \
  --jq '{name, protected}'                        # currently {"protected": false}
```

---

## 9. Preservation requirements — verified

| Requirement | Status |
| --- | --- |
| 35 loans, 470 payments, 597 journal entries | **Unchanged** — production read before and after; no migration applied there |
| Financial calculations and ledger balances | **Unchanged.** Production re-read at the end of Phase 2B: debits and credits both **89,649,530**, 161 migrations, 117 definer functions reachable by `authenticated` — i.e. exactly as Phase 1 found it, because nothing was applied there. Separately, the upgrade rehearsal reports all 28 financial figures identical across the upgrade with its own fixture ledger balanced at 17,672,540 both sides |
| No privilege escalation introduced | The only grant *added* is `savings_account_governing_policy` back to `authenticated`, restoring a pre-Phase-2 state; everything else narrows access. The gate asserts no function relies on PUBLIC's default EXECUTE |
| All applicable migrations replay | **169** on a fresh cluster, and 97 + 69 through the historical upgrade |
| Existing negative-role tests still enforced | Three gates caught these changes; all three updated to match, none bypassed |
| Policy 2.0 inactive | `draft`, unapproved, all five flags false |
| No demo data deleted | None |
| Only the POLYTOS project used | `fszgwemtgyrbhngajpzm` only |

---

## 10. Phase 2 recommendation

To be completed once §7 is filled in.

---

*Prepared by Claude Code as Lead Implementation Engineer. For ChatGPT's
independent review before Phase 3 or any production release authorization.*
