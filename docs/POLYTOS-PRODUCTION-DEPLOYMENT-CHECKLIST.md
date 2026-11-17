# POLYTOS — production deployment checklist

**Prepared** 2026-11-17. **Status: NOT STARTED.** No step below has been
performed.

Tailored to the hosted database and application as they actually are today,
which is the point of it: a generic checklist would tell you to verify
balances that do not exist and preserve history that was never written.

---

## 0. What is actually deployed right now

Measured against the hosted Supabase project `qxcwsvmakdilsshvcjuv`
(eu-central-1, PostgreSQL 17.11), read-only, on 2026-11-17.

| | |
| --- | --- |
| Migrations applied | **217** |
| Latest applied | `20261115001600_agency_idempotent_operating_branch` |
| Branches · profiles · company identity | 1 · 1 · 1 |
| Ledger accounts (chart of accounts) | 55 |
| Loan products | 6 |
| Agency service providers | 9 — **all** `is_active = false`, `is_provisional = true` |
| Membership policy versions | 2 — **both** `draft` |
| Audit rows | 9 |
| Clients · loans · memberships | **0 · 0 · 0** |
| Loan payments · journal entries · journal lines | **0 · 0 · 0** |
| Savings accounts · savings transactions | **0 · 0** |
| Benefit claims · agency transactions | **0 · 0** |
| Trial balance, net movement across all 55 accounts | **0** |

### 0.1 The two facts that shape everything below

**There is no financial history in the hosted database.** Not a thin history
— none. Every ledger account is unposted and the trial balance nets to zero.

**There are therefore no opening balances, synthetic or genuine.** The
distinction the Owner asked for cannot be drawn in the data, because neither
kind is present. What exists is a bare installation: a schema, a chart of
accounts, six loan products, nine provisional providers, two draft policies
and one Owner profile.

The populated demonstration book — the one with 17 loans, 162 payments,
8 memberships and a balanced ledger of ~17.7 million shillings — exists
**only in the local and CI seeds**. It has never been in the hosted project
and must not be copied there. Any figure quoted from a test run is synthetic
by construction.

So the opening verified position has to be **established at go-live from a
physical count and a bank confirmation**, not reconciled against anything
already recorded. That is what `POLYTOS-CASH-CUTOVER-CHECKLIST.md` is for,
and it is a precondition of this checklist rather than a step in it.

### 0.2 The deployment gap is twelve migrations, not five

The five financial-control migrations are the ones under discussion, but they
are not the whole delta. `main` carries 229 and production has 217:

| Migration | |
| --- | --- |
| `20261116000100` | agency provider category and line identity |
| `20261116000200` | agency cash banking |
| `20261116000300` | agency transaction history reporting |
| `20261117000100` | agency provider float model correction |
| `20261117000200` | agency account staff |
| `20261117000300` | agency account staff enforcement |
| `20261118000100` | agency commission daily |
| `20261119000100` | **guarantor concentration ceiling** (DEFECT-001) |
| `20261120000100` | **cash availability** (GAP-001) |
| `20261120000200` | **cash in transit** |
| `20261120000300` | **bank deposits** |
| `20261120000400` | **no unfunded payouts** |

With PR #39 merged it is **thirteen**, adding `20261121000100`
(separation-of-duties SQLSTATE).

A plan that speaks only of "the five" understates what a production migration
run applies. The seven agency migrations are additive and inert in practice —
no provider is active, so no agency transaction can post — but they are
schema changes and they will run.

---

## 1. Before anything is applied

- [ ] **1.1** Both pull requests reviewed and explicitly approved by the
      Owner. #38 (Next.js 16.4.6, CVE-2026-119790) and #39 (L7
      separation-of-duties SQLSTATE). Neither has been merged.
- [ ] **1.2** Merge **#38 first**, then #39. Not a preference: #39 is cut
      from `main` and so runs Next.js 16.4.1, whose advisory halts the first
      build attempt. Merging #38 first removes that from #39's CI.
- [ ] **1.3** Four CI gates green on the merge commit on `main` itself, not
      only on each branch head. The merge commit is what gets deployed.
- [ ] **1.4** `POLYTOS-CASH-CUTOVER-CHECKLIST.md` complete and signed off.
      **It is currently NOT STARTED.** Decision A's rule binds on live data
      the moment `20261120000100`–`400` are applied, and the migrations take
      "no restriction recorded" to mean "available" — an assumption about the
      past, not a measurement of it. On a database with no history that
      assumption is harmless; it becomes load-bearing the first time real
      cash is recorded.
- [ ] **1.5** At least **two officers per branch** hold `receipts:confirm`
      and `deposits:verify`. A branch with one cannot clear its own deposits:
      the rule that the verifier may not be the recorder will refuse it,
      correctly, and the branch will be unable to bank cash. With one branch
      and one profile in the hosted database today, this is **not currently
      satisfiable** and must be set up before any cash is handled.
- [ ] **1.6** A verified database backup, restorable, timed immediately
      before the migration run. See `POLYTOS-V1-BACKUP-READINESS.md`.
- [ ] **1.7** A decision recorded on **C2**: approve a membership policy
      version, or accept that the membership programme cannot operate. Both
      versions are drafts, and nothing in membership, savings, member
      lending, benefits or meeting fines can run until one is approved with
      an authorisation reference. Deploying does not change this either way.

## 2. Applying the migrations

- [ ] **2.1** Confirm the applied count is **217** and the latest version is
      `20261115001600` immediately before starting. If it is anything else,
      stop: this checklist was written against that state.
- [ ] **2.2** Apply the twelve (or thirteen) migrations **in version order**.
      All are additive; none modifies an already-applied migration.
- [ ] **2.3** Confirm the applied count afterwards: **229**, or **230** with
      #39.
- [ ] **2.4** Confirm `allow_negative_cash` is read by nothing and its column
      comment begins `INERT`.
- [ ] **2.5** Run the financial reconciliation certification against
      production **read-only** and confirm 41 identities: 39 pass,
      2 explained, 0 vacuous, 0 fail. On an empty book most identities are
      vacuously true; the value of the run is that it does not *fail*, and
      the `--require-complete` flag is what distinguishes the two.
- [ ] **2.6** Confirm the trial balance still nets to zero and journal lines
      are still 0 — i.e. the migration run posted nothing. On this database
      that is the whole integrity check available, and it is a real one: the
      upgrade gates assert the same property against a *seeded* book, and
      both must hold.

## 3. Deploying the application

- [ ] **3.1** Deploy to Vercel from the merge commit, not from a branch.
- [ ] **3.2** Confirm the served build reports Next.js **16.4.6**. If it
      reports 16.4.1 the security update did not ship.
- [ ] **3.3** Confirm the build emitted **no** Next.js security advisory. Its
      presence means the deployed version is still affected by
      CVE-2026-119790.
- [ ] **3.4** Confirm `NEXT_PUBLIC_APP_VERSION` on the Settings page and the
      health endpoint matches the deployed commit.
- [ ] **3.5** Sign in as the Owner and confirm the response headers carry the
      Content-Security-Policy with a per-response nonce.
- [ ] **3.6** Confirm no privileged key is reachable from the browser bundle.

## 4. Verifying the controls on live data

Each of these is a *refusal* and so costs nothing to test: nothing is posted
when they work.

- [ ] **4.1** A guarantor at the configured ceiling cannot be added to a
      further loan reaching active. `guarantor_max_active_loans` is 2.
- [ ] **4.2** A disbursement from a branch holding no cash is refused, naming
      the account and the shortfall — not merely declined.
- [ ] **4.3** A deposit recorded by one officer cannot be cleared by that
      same officer, and the refusal reads **"A different authorized officer
      must complete this action. You cannot approve or verify your own
      work."** — not "Privilege denied on record.", which was the L7 defect.
- [ ] **4.4** A user genuinely lacking a capability still reads "You do not
      have permission to do this." The two refusals must stay distinct;
      conflating them is what L7 fixed.
- [ ] **4.5** No raw SQL text, table name, column name, constraint name or
      row value appears in any refusal shown to staff.
- [ ] **4.6** A document upload succeeds and the stored object is not
      publicly readable.

## 5. Explicitly out of scope

Not because they are hard, but because the Owner has withheld them:

- [ ] **5.1** **No provider activation.** All nine stay
      `is_provisional = true`. Nothing in agency banking can post until one
      is deliberately confirmed, and that is a separate decision with its own
      release order in `POLYTOS-AGENCY-OWNER-ACCEPTANCE.md` §3A.
- [ ] **5.2** **No membership policy approval.** Both versions stay `draft`.
- [ ] **5.3** **No database reset**, and no seeding of the hosted project
      with demonstration data.
- [ ] **5.4** **No production financial transaction** created to "check it
      works". The refusals in §4 are the check.

## 6. Rollback

- [ ] **6.1** The application rolls back by redeploying the previous Vercel
      build. It is independent of the schema: the previous build runs against
      the new schema unchanged, which the upgrade gates assert.
- [ ] **6.2** The schema does **not** roll back. Every migration here is
      additive and none has a down-step. Reverting means restoring the backup
      from §1.6, which loses anything written after it.
- [ ] **6.3** Consequently, decide §1.4 and §1.5 *before* §2, not after. On
      today's empty database a restore costs nothing; once staff have
      recorded a day's cash it costs that day.

---

## What this checklist deliberately does not contain

**Physical cash counts and bank confirmations.** No figure for cash in any
till, and no bank-confirmed balance for any account. There are none to state:
the hosted ledger is unposted, and inventing an opening position would be
worse than leaving it blank. Those figures come from
`POLYTOS-CASH-CUTOVER-CHECKLIST.md`, performed by officers who count the
money and a bank that confirms the balance — neither of which can be derived
from software.

**A go-live date.** §1.4 and §1.5 are not satisfiable today, and both involve
people rather than code.
