# POLYTOS — Agency Redesign: Owner Acceptance

**Status:** awaiting Owner acceptance. **Not merged, not deployed.**
**Branch:** `claude/adoring-cerf-w07o5i` · **Pull request:** 34, targeting `main`
**Audience:** the Product Owner, performing acceptance.

---

## 0. What has *not* happened

Stated first because it is the thing most worth being sure of.

| | |
|---|---|
| Production Supabase project `qxcwsvmakdilsshvcjuv` | **untouched.** No migration applied, no row read or written, no setting changed. |
| Live Vercel deployment (`polytos.vercel.app`) | **untouched.** Nothing deployed, no environment variable changed. |
| Pull request 34 | **open, not merged.** No auto-merge, no release. |
| The 223 already-applied migration files | **unmodified.** The work adds files after them; it edits none. |
| Existing customers, staff accounts, roles, passwords, financial records | **unmodified.** The upgrade gate measures this: see §4. |
| Any provider's activation state | **unchanged.** Nothing was activated. Every demonstration provider is marked provisional. |

The preview in §1 runs entirely on your own machine against a throwaway
database. It reaches no hosted project.

---

## 1. The protected preview environment

### 1.1 What it is

A complete, isolated stack assembled from real parts:

| Part | What runs | Isolation |
|---|---|---|
| PostgreSQL | a throwaway cluster on port 5433, database `lending_e2e`, built from zero and every migration applied in order | created and destroyed with the run |
| PostgREST | the real binary, v12.2.3 — the same server Supabase runs | loopback only |
| Auth | a minimal GoTrue-compatible shim | the one substitution, and only because GoTrue ships as a container |
| POLYTOS | the **production build**, not the dev server | port 3000, loopback |

Everything the application's own code touches — Row Level Security, the
SECURITY DEFINER functions, PostgREST's embedding rules, the JWT claims — is
the real thing. The credentials are synthetic, named rather than random so a
failed run can be inspected, and never secret: the database listens on
loopback and the shim signs with a key generated into `.e2e/`.

### 1.2 Standing it up

```bash
npm run e2e:up
```

That migrates, seeds, builds and serves. Then open `http://localhost:3000`.

```bash
npm run e2e:down
```

Tears it down and destroys the database.

### 1.3 Signing in

All demonstration accounts use the password `Screenshot#Demo2026`. The
accounts are synthetic; the phone numbers are in a reserved range and the
e-mail domain is `.invalid`, which cannot resolve.

| Who | Role | Phone |
|---|---|---|
| Nalubega Sarah Kiwanuka | Owner/Admin | `+256772100101` |
| Okello Daniel Omara | Manager | `+256772100102` |
| Namirembe Grace Atim | Secretary/Treasurer | `+256772100103` |
| Wasswa Peter Lubega | Secretary/Treasurer | `+256772100104` |

You will need at least two of them. Every financial operation in the Agency
module is under maker-checker: the officer who records a transaction is
**refused** when they try to post it. That refusal is the control working, not
a fault — sign in as somebody else to post.

Grace is on the counter rosters. Daniel is deliberately **not**, so that the
supervisory route is exercised rather than assumed — see item 6.3.

### 1.4 What the demonstration book contains

A full lending book (clients, loans, repayments, arrears), and for the Agency
module: MTN and Airtel as Mobile Money providers with one agent line each and
float topped up from the company's own cash, a utility biller on the
cash-payable model, posted deposits and withdrawals, a reversal, a commission
exception, a payable settlement, and both reconciliations.

Every figure is synthetic and every provider is provisional.

---

## 2. The acceptance checklist

Work through it in order; later items depend on earlier ones. Each row says
what to do, what you should see, and — where it matters — **what you should
see refused**, because in this module the refusals are most of the control.

### 2.1 Navigation

| # | Do this | Expect |
|---|---|---|
| 1.1 | Sign in as the Owner. Look at the sidebar. | **AGENCY** with three branches: Agent Banking, Mobile Money, Consolidated Agency Reports. No flat list. |
| 1.2 | Expand Mobile Money. | MTN and Airtel, each from the database. Expand one: its agent line. |
| 1.3 | Expand Agent Banking. | Banks & Agent Accounts, with the configured banks under it. A bank with no account shows an empty state rather than vanishing. |
| 1.4 | Sign in as the Secretary/Treasurer. | The branches she may use, and no Owner-only entry (Register a bank, Account authorisations). |

### 2.2 Agent Banking

| # | Do this | Expect |
|---|---|---|
| 2.1 | Agent Banking → Overview. | The banking position: accounts, float, cash banked, pending work. Bank agent accounts only — no MTN or Airtel row. |
| 2.2 | Agent Banking → All banks & accounts. | Every bank agent account, its float, today's business. |
| 2.3 | Open one account. | One account in detail: float, today's deposits and withdrawals, commission, what is pending, what is unreconciled. |
| 2.4 | Note the heading and the back link. | It names Agent Banking, not Mobile Money. |

### 2.3 MTN, Airtel, and individual lines

| # | Do this | Expect |
|---|---|---|
| 3.1 | Mobile Money → Overview. | A row per provider per branch: lines open, float held, commission owed each way, float bought, sold and **moved**, with moved in its own two columns. |
| 3.2 | Mobile Money → MTN. | MTN's lines and its float trades. Repeat for Airtel. |
| 3.3 | Open one line. | The line in detail. Its number is **masked** (`+256 77 *** 4567`); the full number appears nowhere on the screen. |
| 3.4 | MTN → Commission, then Statements. | Commission per line per month, and the statement periods. |
| 3.5 | Edit the address bar to put a **bank's** code where MTN's was. | **Not found.** A bank is not a Mobile Money provider, and the module says so rather than rendering it under the wrong heading. |

### 2.4 Transfers

| # | Do this | Expect |
|---|---|---|
| 4.1 | Agency → Transfers. | The register, and a form scoped to one provider. |
| 4.2 | Record a transfer between two of one provider's own accounts. | Recorded, nothing posted. The screen says nothing has moved. |
| 4.3 | Try to post it as the same officer. | **Refused.** Maker-checker. |
| 4.4 | Post it as a second officer. | Posted. |
| 4.5 | Mobile Money → Overview, and the consolidated float report. | The amount appears in *moved out* and *moved in*, and **not** in bought or sold. Provider-level float held is unchanged — the same money, at a different counter. |
| 4.6 | Try to transfer between **two different providers'** accounts. | Not offered, and refused. Client Rule 8: there is no cross-provider float exchange without a real financial process. |

### 2.5 Cash banking (client Rule 5)

| # | Do this | Expect |
|---|---|---|
| 5.1 | Agency → Cash banking. | A form that says in plain words what this is and what it is **not**: not a customer deposit, not revenue, not a float top-up. |
| 5.2 | Fill in an amount and a bank charge. Read the panel before submitting. | The two movements, in shillings: the till falls by the **whole** amount, the bank account rises by the amount **less** the charge, and the charge is an expense. |
| 5.3 | Record it. | Recorded, pending. Nothing has moved. |
| 5.4 | Try to post it yourself. | **Refused.** |
| 5.5 | Post it as a second officer. | Posted. |
| 5.6 | Check the cash position and the bank account. | Cash at hand down by the full amount; the bank up by the net. No float moved, no commission, no income recognised. |
| 5.7 | Reverse it with a reason, as an officer who may. | The original posting is **kept**; the reversal is a second entry that undoes it. |

### 2.6 Account authorisations (client Rule 6)

| # | Do this | Expect |
|---|---|---|
| 6.1 | As the Owner: Agent Banking → Account authorisations. | Every account with its roster, and a warning naming the accounts with **nobody** authorised. |
| 6.2 | Read the panel at the top. | It says a Manager or Owner may post without appearing on a roster, and why. |
| 6.3 | Sign in as the second Secretary (Peter, on no roster). Try to record against an account. | **Refused.** This is the heart of the Owner's decision 2. |
| 6.4 | As the Owner, authorise Peter on that account. Sign back in as Peter and record. | Accepted. |
| 6.5 | As the Owner, withdraw Peter's authorisation with a reason. | The row is **kept**, marked withdrawn, with who withdrew it and why. |
| 6.6 | As Peter, try to record again. | **Refused.** |
| 6.7 | Authorise one officer on accounts at **two different providers**. Record against both. | Both accepted. One agent, several banks — the other half of Rule 6. |
| 6.8 | As a Manager, try to authorise somebody. | **Refused.** Granting a mandate is the Owner's. |

### 2.7 Commission (client Rule 3)

| # | Do this | Expect |
|---|---|---|
| 7.1 | Consolidated Agency Reports → Commission reports. | Three tables, led by **by day, provider and account**. |
| 7.2 | Read the panel above it. | Earned is not received. And: there is **no outstanding column by day**, because outstanding is a position, not a day's business. |
| 7.3 | Find the day you posted a transaction. | Commission earned that day. |
| 7.4 | Record a commission payout against an account dated a **different** day, and post it. | The earning stays on its day; the receipt appears on the payout's day. The two never merge. |
| 7.5 | Look at the "Settled to the account" column. | Those three words. It counts payouts and recoveries only — a provider paying one sum against a whole branch names no account, and that receipt is in the provider table and the settlement reports instead. The page says so. |
| 7.6 | Compare the standing position in the tables below. | Earned, received, returned, outstanding per provider, and per account. |

### 2.8 Reports and exports

| # | Do this | Expect |
|---|---|---|
| 8.1 | Consolidated Agency Reports → Overview. | The position across every bank and network. |
| 8.2 | Change the scope: All, Agent Banking, Mobile Money. Change the period. | Every section narrows. The scope and period are stated above each. |
| 8.3 | Cash & float reports. | Float by provider and branch **first** — including Agent Banking, labelled as such — then float by account. Four separate totals, with moved-between-our-own-accounts stated as excluded from bought and sold. |
| 8.4 | Transaction, settlement, reconciliation reports and Agent performance. | Each renders under the current filter. |
| 8.5 | Export centre. Download a CSV and a PDF. | The CSV opens in a spreadsheet with money as plain digits. The PDF carries the heading, the period, the filters that produced it, who generated it and when. |
| 8.6 | Download the commission **Daily breakdown** in both formats. | The same rows as the screen. The PDF names the grain, so a printout of one cannot be mistaken for the other. |
| 8.7 | Copy an export link. Sign in as a borrower (portal user) and open it. | **Refused.** A download is a separate request and repeats the page's check. |

### 2.9 The float-model correction (the Owner's decision 1)

| # | Do this | Expect |
|---|---|---|
| 9.1 | Agency → Providers. Read the panel at the foot. | The control, and a clear statement that it corrects configuration and activates nothing. |
| 9.2 | Note which providers it offers. | **Provisional only.** Confirmed providers are listed as unavailable, with the reason. |
| 9.3 | Correct a provisional bank to electronic float, with a reason. | Accepted. Its payable is cleared; a float account can now be opened against it. |
| 9.4 | Register an agent account against it, then look at the consolidated float report. | It appears, labelled Agent Banking. |
| 9.5 | Try to correct a provider that holds float. | **Refused**, telling you to settle the position it holds under the present model first. |
| 9.6 | Try as a Manager. | **Refused.** |

---

## 3. Bank-specific commercial details still requiring confirmation

The Owner's decision 1 asked these to be documented. **Each one blocks
activation of the bank it belongs to.** A provider stays provisional until
they are confirmed and approved, and a provisional provider cannot be posted
against — so this list is the gate, not a wish list.

Nothing here has been guessed, defaulted or seeded. The application has no
value for any of it.

### 3.1 Per bank, before it can go live

| What | Why it blocks | Where it goes |
|---|---|---|
| **Does this bank advance electronic float, or do we hold the customer's cash and owe it onward?** | Decides every journal entry the bank's transactions produce. The two models are mutually exclusive. | `float_model`, via the correction on the Providers screen |
| **If cash-payable: which liability account?** | The customer's money is a debt until it reaches the bank, and the debt must be named. | `payable_account_id` |
| **Float facility limit** | What the bank will advance. Not enforced today; a limit nobody recorded cannot be respected. | not yet modelled — see §3.3 |
| **Commission rate or fee, per transaction type** | Every commission figure is computed from it. There is no default and no fallback. | `commission_rate_bps` or `commission_fixed` per type |
| **Is commission taken at the counter, or paid later?** | Decides whether commission is income at once or a receivable on GL 1310. | `commission_model` |
| **Does the bank state commission per transaction, or must we compute it?** | Decides whether the figure is read from the confirmation or derived from our terms. | `commission_source` |
| **Settlement frequency and day** | Reconciliation periods, and what "outstanding" means in practice. | not yet modelled — see §3.3 |
| **Which of our bank accounts the float is drawn against, and which receives commission** | The cash side of every replenishment and settlement. | `settlement_account_id` per movement |
| **Single-transaction ceiling, per transaction type** | Enforced by the database; a type with no ceiling cannot be posted past draft at all. | `max_single_transaction` |
| **Deposit/withdrawal/bill-payment: which does this bank permit?** | A type that does not exist cannot be recorded. | `agency_transaction_types` |

### 3.2 Specifically outstanding on Stanbic

The Owner's instruction was explicit: **do not blindly update Stanbic.** It
has not been updated. What is needed before it can be:

1. Written confirmation that Stanbic advances electronic float to us as agent
   (the client's verbal confirmation covers banks in general; this record is
   per bank).
2. The float facility's limit and terms.
3. The commission schedule per transaction type.
4. The settlement cycle.
5. The company bank account the float is drawn against.

With (1) alone, the correction on the Providers screen can be applied and the
bank will post correctly. It still cannot be **activated** until (2)–(5) are
recorded and approved.

### 3.3 Two things deliberately not built

Named so they are decisions rather than omissions.

- **Float facility limits are not enforced.** No column holds one and no
  posting path checks one. Building it means deciding what happens at the
  limit — refuse, warn, or require authorisation — which is a commercial
  decision, and a limit that is recorded but unenforced is worse than none: it
  reads as a protection that does not exist.
- **The approval threshold on a transaction type is recorded and not
  enforced.** The Providers screen strikes it through and says so. Whether a
  threshold should gate verification is an open decision.

---

## 4. Evidence as at this document

Every figure below is from a run on this branch. The gates are in CI and were
also run locally.

| Gate | Result |
|---|---|
| Unit and integration | 88 files, 2,759 tests, green |
| Database (real PostgreSQL) | every project green — core 1,967 · agency 66 · engine 78 · security 21 · settlement 78 · money 123 · cash banking 29 · roster 27 · banking float 12 · commission daily 10 · shared till 6 · seeders 82 · clean slate 37 |
| Financial reconciliation certification | 38 identities: 36 pass, 2 explained, 0 fail |
| Membership upgrade gate | 99 existing migrations, a seeded book, then 125 new; **28 of 28 financial figures identical** |
| Policy upgrade gate | 26 financial and identity tables; all records, balances and historical approvals preserved |
| Database security gate | no unreviewed privileged exposure |
| Production build | compiled |
| Typecheck, lint, format | clean |

The upgrade gates are the ones that bear on §0's claim that nothing of yours
changes: they apply the new migrations to a seeded book and compare every
financial figure either side.

---

## 5. If something in §2 does not behave as written

Two kinds of answer, and they are different:

- **A refusal you did not expect** is usually the control working, and the
  message is written to say which one. Items 2.4.3, 2.5.4, 2.6.3, 2.6.6,
  2.6.8, 2.8.7, 2.9.5 and 2.9.6 are all *meant* to be refused.
- **Anything else** — a figure that disagrees with another screen, a blank
  panel, a heading naming the wrong module — is a defect. Note the screen, the
  filter and the figure; the filter is part of the report.

Acceptance is yours to give. Nothing merges or deploys until you do.
