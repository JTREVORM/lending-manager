# POLYTOS V1 — launch configuration checklist

Prepared 12 November 2026. **Nothing here has been executed.** Every item
needs separate authorization, and several need a decision that only the
Product Owner can make.

Scope: the configuration and governance work between a tested release and a
first real client. The code fixes are in two branches and are tracked
separately. `docs/POLYTOS-V1-BACKUP-READINESS.md` covers backups and must be
completed first.

---

## A. Disable demonstration membership enrolment

**Current state, read from production.** Membership policy **999.0**, titled
*"DEMONSTRATION ONLY — not the approved Polytos membership policy"*, is the
only `active` policy. It is marked approved, and carries
`is_enrolment_enabled = true` and `is_savings_enabled = true`. Six memberships
sit on it, with five savings accounts, 26 savings transactions and six
membership fee receipts.

Member lending, benefits, profit sharing and the financial flags are already
`false`, and the database gate functions confirm member lending and benefits
are genuinely blocked on undecided policy decisions. Policies 1.0 and 2.0 are
`draft`, unapproved, with every flag false — leave them alone.

**Why it matters for V1.** V1 sells neither membership nor savings. While
999.0 is active with enrolment on, an Owner can enrol a real member onto
demonstration terms with demonstration fee and savings figures.

**The change.** Turn the module off without deleting anything:

- [ ] **A-1.** Set policy 999.0 `status` to `draft`, and
      `is_enrolment_enabled` and `is_savings_enabled` to `false`.
- [ ] **A-2.** Confirm afterwards that no policy is `active`, and that the
      membership and savings screens refuse new enrolment.
- [ ] **A-3.** Confirm the six existing memberships and their savings records
      are still readable, and that the savings sub-ledger still reconciles to
      GL 2100.

**Not authorized here, and a separate decision:** deleting the six
memberships, the savings accounts or their transactions. A-1 makes the module
unreachable, which is what launch needs. Purging is reversible only from a
backup, so it waits for §C and for the Owner's instruction.

---

## B. Review the three extra login-capable accounts

**Current state, read from production.** Four profiles have an auth user
linked and can sign in:

| Role | Can sign in | Decision needed |
| --- | --- | --- |
| `owner_admin` | yes | Keep — this is the Owner |
| `manager` | yes | Confirm or deactivate |
| `secretary_treasurer` | yes | Confirm or deactivate |
| `secretary_treasurer` | yes | Confirm or deactivate |

Two further profiles are named `DEMO …` and hold `manager` and
`secretary_treasurer` roles, but have **no** `auth_user_id`. They cannot sign
in. They are records used as actor labels by the demonstration data, not an
authentication exposure.

**Why it matters.** You have stated that no staff have been employed. Each
account that can sign in is live credentials against real financial records.

- [ ] **B-1.** Owner confirms, for each of the three non-Owner accounts,
      whether a real person should hold it at launch.
- [ ] **B-2.** For each one that should not: set the profile `status` to
      `inactive` through Users. **Do not delete** — the audit log and the
      `created_by` / `approved_by` columns on real financial records reference
      these profiles, and deleting them would break that attribution.
- [ ] **B-3.** Confirm an inactive profile is refused by the Data API, not
      merely hidden in the UI. `current_profile_id()` resolves only active
      profiles, so this should already hold; verify it rather than assume it.
- [ ] **B-4.** Decide whether the two `DEMO` profiles should also be set
      inactive for tidiness. No security effect either way.

**Not authorized here:** creating, deleting, suspending or resetting the
password of any account, including the Owner's.

---

## C. Classify the existing loan and repayment data

**This is the decision with the longest lead time, and it blocks a clean
launch.**

**Current state.** Production holds 28 clients, 35 loans (17 active, 9
cleared, 3 pending approval, 2 approved, 2 draft, 2 cancelled), 470 payments
and 597 journal entries. Client records are dated **11 September 2025 to 5
September 2026** — before this system was built — so they were entered or
migrated rather than created by it. None carries a `DEMO` name prefix, and no
loan carries a `membership_id`, so this book is entirely separate from the
demonstration data in §A.

The books reconcile exactly: debits = credits = 89,649,530, no individually
unbalanced entry, and all 26 disbursed loans carry a disbursement journal.

**The question only the Owner can answer.** Are these 35 loans and 470
payments:

1. **Real business records** the client is already relying on — in which case
   they must be preserved exactly, and launch proceeds on top of them; or
2. **Acceptance-test or migration-rehearsal data** — in which case production
   should be reset to reference data only before the first real client, as
   `docs/LAUNCH-CHECKLIST.md` requires.

- [ ] **C-1.** Owner classifies the book as (1) or (2).
- [ ] **C-2.** If (1): record that decision, and confirm the figures above are
      the figures the business recognises. The 3 pending-approval, 2 approved
      and 2 draft loans need a disposition — they are mid-workflow.
- [ ] **C-3.** If (2): a reset plan is written and authorized separately. It
      requires a proven backup first, and it is not a code change.
- [ ] **C-4.** Either way, confirm no synthetic client remains that staff
      might mistake for a real borrower.

**Not authorized here:** deleting, resetting or recalculating any of it.

---

## D. Enable production deployment safely

**Current state.** `vercel.json` sets
`git.deploymentEnabled["claude/intelligent-knuth-2r8mpw"] = false`. The
production branch does not auto-deploy. This was deliberate — commit
`12d1e17`, 1 November, to hold the alias during the security release — and the
commit message says so.

Production currently runs `dpl_9NSBbF2yBns8EFFhJo6PS2g8zain` at `64ea09c`,
READY, region `dub1`, with all five environment variables present and scoped
to Production only.

- [ ] **D-1.** Record the current production deployment ID as the rollback
      point.
- [ ] **D-2.** Remove the production-branch entry from
      `git.deploymentEnabled`, keeping the two feature-branch holds. This is a
      one-line change and belongs in the release commit, not before it.
- [ ] **D-3.** Confirm the resulting deployment's source SHA, target
      (`production`) and alias.
- [ ] **D-4.** Confirm `/api/health` on the live alias returns HTTP 200 with
      `status=ok` and `dataApi=ok`, uncached.
- [ ] **D-5.** Confirm `NEXT_PUBLIC_APP_ENV=production` still holds, so CSP
      excludes `unsafe-eval` and HSTS is sent. (Both were verified present at
      `64ea09c`.)
- [ ] **D-6.** Retire or confirm the isolation of older READY preview
      deployments, which may retain earlier build-time environment snapshots.

**Ordering note.** D-2 must not land before the security migrations are
applied, or the first auto-deployment would ship the guarded application
against an unguarded database. Application and schema must move together.

---

## E. Protect the production branch

**Current state.** `claude/intelligent-knuth-2r8mpw` reports
`protected: false`. Anyone with write access can push directly to the branch
that deploys to production.

`config/branch-protection.json` and `scripts/apply-branch-protection.mjs`
exist on PR #20's branch and are **not** included in the V1 security
integration — they are governance, not a security fix, and they need
repository-admin rights that the session token does not have.

- [ ] **E-1.** Owner or an org admin applies branch protection, requiring the
      four CI jobs as status checks.
- [ ] **E-2.** Keep required approvals at **0**. With a single collaborator,
      GitHub forbids self-approval, so requiring 1 would deadlock every merge.
- [ ] **E-3.** Verify the rules are in force by attempting a direct push to
      the protected branch and seeing it refused.

---

## F. Final hosted acceptance testing

Everything below needs the live site and real credentials. None of it can be
settled in CI, and none has been done.

**Security, after the migrations:**

- [ ] **F-1.** Sign in as an ordinary borrower and confirm
      `savings_withdrawable_amount`, `savings_pledged_amount`,
      `validate_loan_for_approval`, `ledger_account_balance` and
      `assess_meeting_fines` all refuse. **This is the test that proves the
      main blocker closed.**
- [ ] **F-2.** Confirm an authorized finance role still gets answers from the
      same functions — the guard must not have broken legitimate access.
- [ ] **F-3.** Re-run `npm run check:security` against production and the
      Supabase security advisor; compare against the pre-migration inventory.

**Authentication and session:**

- [ ] **F-4.** Owner signs in through real hosted Supabase Auth.
- [ ] **F-5.** Forced password change on first login; the temporary password is
      then refused.
- [ ] **F-6.** Session persists across navigation and refreshes past token
      expiry.
- [ ] **F-7.** Sign-out invalidates the session, including the back button.
- [ ] **F-8.** An unauthenticated request to a protected route is refused.

**One real lending cycle, by the Owner, on production, with a disposable test
customer:**

- [ ] **F-9.** Register the customer; capture identity and a guarantor.
- [ ] **F-10.** Create, submit, approve and disburse a loan. Confirm the
      schedule generates on the configured cadence.
- [ ] **F-11.** Take a partial repayment; confirm the receipt and the reduced
      balance.
- [ ] **F-12.** Let one instalment fall overdue; confirm arrears and the
      penalty.
- [ ] **F-13.** Take the final repayment; confirm the loan closes.
- [ ] **F-14.** Print the receipt and check every figure against the loan.
- [ ] **F-15.** Confirm the audit trail shows each step with the Owner as
      actor.
- [ ] **F-16.** Remove the test customer, under its own authorization.

**Owner-only cash movement, after the threshold fix:**

- [ ] **F-17.** Confirm the Settings screen now shows the thresholds blank
      where they are unset, and that saving the screen leaves them blank
      rather than writing zero.
- [ ] **F-18.** Owner sets the thresholds deliberately — blank for sole
      operation, or a real figure once staff exist.
- [ ] **F-19.** With the thresholds blank, complete a transfer and an expense
      larger than the old limits. Both must post immediately.
- [ ] **F-20.** With a threshold set, confirm a movement above it is still
      held and still cannot be self-approved. The control must survive.

**Platform:**

- [ ] **F-21.** PWA installs from the production URL on a real phone.
- [ ] **F-22.** The core screens work at phone width.
- [ ] **F-23.** Security headers verified on the live domain.
- [ ] **F-24.** Logging reaches the operator.

---

## Workflows that genuinely require an independent actor

For completeness, and so no launch restriction is invented where none is
needed. Verified by reading every migration and proven by
`tests/db/sole-owner-operation.test.ts`.

| Workflow | Needs a second person? | Launch position |
| --- | --- | --- |
| Register a customer | No | Owner alone |
| Create, submit, approve, disburse a loan | **No** | Owner alone — no self-approval bar anywhere in the loan lifecycle |
| Record a payment, issue a receipt | No | Owner alone |
| Reverse a payment | No | Owner alone (`payments:reverse`) |
| Close a loan | No | Automatic on final payment |
| Reports, audit trail | No | Owner alone |
| **Transfer above the threshold** | **Yes** — `approve_transfer` refuses the requester | Set the threshold blank for sole operation; restore a figure when staff are hired |
| **Expense above the threshold** | **Yes** — `approve_expense` refuses the recorder | Same |
| Reconciliation difference | No — `approve_reconciliation` has no distinct-actor rule | Usable by a sole Owner. **A known control gap**, not a launch blocker; close it in code when a second person handles cash |

**Proposed launch restriction.** Only one is needed, and it is a
configuration choice rather than a code change: with a single operator, the
two approval thresholds are left blank, which the schema documents as the
intended accommodation for a business of this size. The maker-checker
functions themselves are untouched — the moment a threshold is set and a
second authorized person exists, the control applies exactly as written.

No control is bypassed, disabled or weakened to achieve Owner-only operation.
