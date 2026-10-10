# Platform upgrade, Phase 5 — collections and Debt & Security

Phase 5 of the plan in `PLATFORM-UPGRADE-PLAN.md`: the security a loan is
written against, the discretionary release of a guarantor, an append-only
record of the chasing, promises to pay whose verdict is read from the
payments, aging buckets, portfolio at risk, and collections that can finally
be sliced by branch and by product.

How the module works is in `DEBT-AND-SECURITY.md`. This is the evidence that
it was applied, that it holds, and that nothing already working was broken.

---

## 1. Migrations added

| Migration | What it does |
| --- | --- |
| `20261014000100_collateral.sql` | `loan_collateral` — the pledged item, its valuation and its status — with `loan_collateral_guard` freezing the item's identity at disbursement while leaving release and realisation open; `collateral:view` / `collateral:manage`; RLS; `loan_collateral_register`. Re-emits `loan_application_profile` with the two product flags Phase 12 added and nothing ever read: `collateral_required` and `min_guarantors`. |
| `20261014000200_recovery_actions.sql` | `loan_recovery_actions` — calls, visits, messages, notices, notes, promises and corrections — append-only through statement-level triggers, with the author derived from the session and recovery refused on a loan that was never disbursed; `recovery:view` / `recovery:record`; `loan_recovery_register` (with the derived promise verdict) and `loan_recovery_status` (one row per loan). |
| `20261014000300_guarantee_release.sql` | `loan_guarantors.released_at` / `.released_by` / `.release_reason`; `release_loan_guarantor(uuid, text)` gated on a new `guarantors:release` capability and on the product's guarantor floor; the snapshot guard extended so a release cannot be undone, reworded, or written straight to the column; `guarantor_exposure`, the guarantor register. |
| `20261014000400_risk_monitoring.sql` | `loan_aging` — the active book bucketed from `days_past_due` alone; `portfolio_at_risk` — PAR1/7/30/60/90 and the aging buckets over grouping sets, so the whole book and every slice come back in one read; `payment_register` re-emitted with `branch_id`, `branch_name`, `loan_product_id`, `product_code` and `product_name`. |

## 2. Three things the schema refuses, and why

**An item's identity freezes; its status never does.** Before the money moves
a pledged item is part of the application — a description somebody types,
corrects and re-values. From disbursement it is evidence: the thing the
business agreed to lend against. So the type, description, valuation,
valuation date, serial number and ownership document freeze, and a DELETE is
refused outright — an item taken in and no longer wanted is *released*, which
is a status with a date and an actor. What stays open is `held` → `released`
or `realised`, because those are events that happen to a live loan by
definition and a guard that froze them would freeze the only thing security is
for.

**A recovery note is never edited.** `loan_recovery_actions` refuses UPDATE
and DELETE with statement-level triggers, the way `audit_log` and
`client_remarks` do. Statement-level is the point: the refusal does not depend
on an attacker's WHERE clause matching anything, and withholding a grant stops
a session while a leaked service key is not a session. A mistake is corrected
by appending a correction that points at the entry it supersedes, and the
register shows the original struck through with the correction beneath it.

**A release cannot be taken back, or taken at all from a column write.** A
guarantor who has been told they are out stops worrying about the loan.
`release_loan_guarantor` is the only way in: it checks `guarantors:release`,
requires a reason, refuses a draft (remove the guarantor instead) and a
finished loan (the guarantee ended with it), and refuses to leave the loan
below the number of guarantors its product requires — refused rather than
warned about, because the alternative is a live loan the business thinks is
secured.

## 3. A defect the browser suite found

The production build compiled it and the unit, integration and database
suites all passed it: `isRecoveryView` was exported from the tab strip, which
is a `'use client'` module, and called from the `/recovery` server page. A
client module's exports are a boundary, so the call failed at **request** time
— "attempted to call isRecoveryView() from the server" — on every one of the
five views. Nothing but a running server could have caught it.

The vocabulary moved to `lib/domain/debt-views.ts`, a plain module with no
boundary to cross, which is where it belonged anyway: both ends of the URL
need it, the client component to write the parameter and the server page to
read it back.

## 4. Two test defects worth recording

Both were in the test suite rather than the code, and both would have taught
the wrong lesson if worked around instead of fixed.

`migrations.test.ts` flagged `20261014000100` for "uses a float type". Its
regular expression was `\b(real|double\s+precision|…)` — bounded on the left
only — so `\breal` matched `realised_amount`, a column name. The alternation
is now bounded on both sides. Appeasing it by renaming the column would have
been renaming an honest column to satisfy a regex.

The same file demanded `updated_at` on `loan_recovery_actions`. It is
append-only, so an `updated_at` would be a column that can never advance and,
worse, one that implies the note can be reworded after the loan goes bad —
precisely what the table exists to prevent. It joins `audit_log`,
`client_remarks`, `loan_penalties` and the snapshots in the documented
`NO_UPDATED_AT` list.

One genuine message fix: the item guard read "cannot be changed on a active
loan", because the status was interpolated after an article. It now reads
"cannot be changed once the loan is active", which is correct for every
status — and a guard's message is the only explanation the person at the
counter gets.

## 5. Schema changes

New tables: `loan_collateral`, `loan_recovery_actions`.

New views: `loan_collateral_register`, `loan_recovery_register`,
`loan_recovery_status`, `guarantor_exposure`, `loan_aging`,
`portfolio_at_risk`.

New functions: `release_loan_guarantor`, plus two trigger functions
(`loan_collateral_guard`, `loan_recovery_actions_stamp_author`). Re-emitted:
`loan_guarantors_guard_snapshot`, `payment_register`,
`loan_application_profile`.

Columns added: `loan_guarantors.released_at`, `.released_by`,
`.release_reason`.

New capabilities: `collateral:view`, `collateral:manage`, `recovery:view`,
`recovery:record` (the three staff roles); `guarantors:release` (Manager and
Owner only — discharging a liability on money already lent is a decision of
the same weight as approving the loan was, so the Secretary/Treasurer who
attaches guarantors all day does not hold it).

New rate-limit buckets: `recovery.record` (120 in 10 minutes, open — a
collections officer working a list records one every few seconds, and an
append-only table means a mis-click cannot be tidied away, so the limit sits
above a genuinely busy morning rather than at it); `security.collateral` (30 a
minute, open); `security.decision` (20 an hour, closed — releasing and
realising belong with reversal and approval).

Local, after all four: 47 tables, 31 views, 132 functions, 86 policies, 74
permissions, 163 role grants.

## 6. Application layer

| Route | What it is |
| --- | --- |
| `/recovery` | The Debt & Security hub, in five views: aging (with bucket chips that carry counts), risk monitoring (PAR at five thresholds, whole book and by branch and product), follow-ups, promises to pay, security held. |
| `/guarantors/register` | The guarantor register: guarantor, type, phone, borrower, loan, product, guaranteed amount, outstanding exposure, guarantee date, loan status, guarantee status, release date and reason. |
| `/payments/summary` | The Collection Summary: a period cut by method, staff member, branch, product and day, from one read. |
| `/loans/[loanId]` | Two new sections. **Security**: the items with their valuations and statuses, plus the guarantees and what each one is exposed to. **Recovery**: where the loan stands, the chase in order, the live promise, and the form. |
| `/overdue` | Unchanged, deliberately. |

`/overdue` and `/recovery` are two routes with two capabilities because they
answer different questions for different people: the morning worklist is read
standing up and should not have to load a portfolio aggregate to show itself.

Server actions added: `recordCollateralAction`, `updateCollateralAction`,
`removeCollateralAction`, `releaseCollateralAction`,
`realiseCollateralAction`, `releaseGuarantorAction`,
`recordRecoveryActionAction`, `correctRecoveryActionAction`.

Components added: `loan-collateral-panel`, `loan-guarantee-panel`,
`loan-recovery-panel`, `recovery-tabs`, `risk-summary`, `aging-register`,
`recovery-worklist`, `guarantor-exposure-register`,
`collection-summary-view`, `collection-period-form`.

Modules added: `lib/domain/security.ts`, `lib/domain/risk.ts`,
`lib/domain/debt-views.ts`, `lib/validation/security.ts`,
`lib/data/security.ts`, `lib/data/collections.ts`, `lib/recovery/actions.ts`.

`/recovery` was added to the performance budget list, because it is the screen
most likely to drift: it reads a grouping-sets aggregate over the whole active
book.

## 7. What this phase deliberately does not do

- **It does not touch allocation.** Penalty, then interest, then principal,
  decided by `post_payment`. The Collection Summary reports the split; it does
  not compute one.
- **It does not write a journal line.** No table, trigger or function added
  here posts to the ledger. A realisation records a sale; the proceeds reach
  the books as a payment through `post_payment`, like every other shilling,
  and the form says so above the button — because a staff member who believes
  the balance has already moved will not post the receipt.
- **It does not restate arrears.** Aging is a presentation of Phase 7's
  `days_past_due`, bucketed in one `case` so a screen and a report cannot
  disagree. `lib/domain/risk.ts` mirrors that `case` for previews, and a test
  in each suite drives the same ten boundaries.
- **It does not let a promise touch the schedule.** A promise to pay is a
  record of what a borrower said. Whether it was kept is derived from posted
  payments, so a reversal un-keeps one with no second write anywhere.

## 8. Verification

| Suite | Result |
| --- | --- |
| Typecheck | clean |
| Lint | clean |
| Formatting | clean |
| Unit + integration | 56 files, 1,933 tests, all passing |
| Database (real PostgreSQL) | 44 files, 1,221 tests, all passing |
| Production build | succeeds |
| Browser (Playwright, 2 viewports) | see §10 |

New tests this phase: `tests/db/security-and-recovery.test.ts` (37 tests),
`tests/unit/security-validation.test.ts` (36), and
`tests/integration/security-ui.test.tsx` (39). Eleven existing database
inventory assertions were extended with the new tables, views, policies,
privileges and functions — those lists are exhaustive by design, so a new
object fails them until it is declared and explained.

## 9. Live application

All four applied to the demo project `fszgwemtgyrbhngajpzm`.

**The registry needed writing, not renaming.** Phases 1–4 were applied through
the Supabase MCP, which stamped each version with the time of application and
had to be renamed to the repository's version afterwards. This time it recorded
nothing at all: the four migrations applied, and
`supabase_migrations.schema_migrations` still ended at `20261013000600`. Left
alone, a later `db push` would have re-applied all four. The four rows were
inserted with their repository versions, so the live registry now reads
`20261013000100` through `20261014000400` in order.

**Verified after.** The live schema was compared object-for-object against a
local database built from every migration. Identical hashes on 560
constraints, 86 policies, 126 triggers, 74 permissions, 163 role grants, 1,492
columns, 31 views, 660 table grants and 190 of the 192 indexes. All 132
function bodies hash identically once `--` comments *and* whitespace are
normalised — including every object this phase added.

Two differences, neither ours and neither a difference in what the database
does:

- **The two trigram indexes** render as `gin_trgm_ops` live and
  `extensions.gin_trgm_ops` locally, because `pg_trgm` is installed in
  `public` on the hosted project and in `extensions` locally. Same index, same
  behaviour, different `search_path` rendering.
- **`public.__gate_probe`**, a view defined as `SELECT 1 AS one`, left by an
  earlier session. It accounts for the one extra view, its one column and 21
  of the table grants. Inert, unreferenced, and removing an object from a live
  database is still not something a phase does on its own initiative.

One normalisation note worth recording, because the Phase 4 report's claim that
"all 129 function bodies hash identically once `--` comments are normalised
away" was true only by luck. Stripping a comment line leaves an **empty line**
behind, and the earlier phases were applied to live with their comments already
removed — so 21 bodies differed by nothing but blank lines. Collapsing
whitespace as well as stripping comments makes the comparison say what it
means, and all 132 then match exactly.

**Advisors**, checked after: nothing new. `release_loan_guarantor` appears
under `authenticated_security_definer_function_executable` beside
`approve_loan`, `post_payment` and thirty-three others — which is the
project's established pattern and the whole point of the function: it checks
`guarantors:release` before it does anything. Both new tables have RLS with
policies; neither appears under `rls_enabled_no_policy`.

## 10. Demo data

Preserved, and enriched only where Phase 5 needs something to show. Every row
was written through the real tables and functions, as a real signed-in user,
so every actor and label is derived rather than supplied.

**Security — three items, one in each state.** A Bajaj Boxer motorcycle
(2,200,000, logbook, serial) **held** against LN260012. A Butterfly sewing
machine (420,000) against LN260014, **realised** for 300,000 after the promise
of 25 September was not kept. A Hisense television (350,000) against
LN260013, **released** because the principal is fully repaid and only interest
remains — holding a borrower's household goods against interest is not
proportionate.

**The realisation is two events, as the schema insists.** The Manager recorded
the sale; the Secretary/Treasurer then posted the 300,000 as a cash payment
through `post_payment`. The loan moved because of the receipt, not because of
the valuation: outstanding 414,006 → 114,006, allocated 23,996 penalty,
36,000 interest, 240,004 principal — in that order, by the rule Phase 6 set.
The penalty was materialised by the payment, as Phase 7 documents, because the
loan was past its grace deadline.

**Recovery — twelve actions across four loans**, written by the
Secretary/Treasurer with one correction appended by the Manager:

- **LN260014** (34 days past due, the furthest behind): a call that reached
  nobody on 14 September, a field visit on 18 September that found her at the
  Kalerwe stall, the promise taken at that visit, and the note recording the
  sale and the receipt.
- **LN260023** (33 days): an SMS, a call where she refused to pay until a
  business partner returns her stock, and a written notice handed over in
  person with the guarantor copied. The SMS entry carries a **correction** —
  it was the guarantor who replied, not the borrower. The original stands
  exactly as written, marked corrected, with the Manager's correction beneath
  it.
- **LN260022** (11 days): a call and a promise of 50,000 by 8 October.
- **LN260010** (20 days): a visit that found the shop shut, and a promise of
  80,000 by 12 October.

**Three promises, three verdicts, none of them stored:**

| Loan | Promised | By | Paid in the window | Verdict |
| --- | --- | --- | --- | --- |
| LN260014 | 100,000 | 25 Sep | 0 | Not kept |
| LN260022 | 50,000 | 8 Oct | 95,333 | Kept |
| LN260010 | 80,000 | 12 Oct | 0 | Awaiting |

Each read out of the payments table. Reverse the 8 October receipt and
LN260022's promise stops reading as kept, with nothing else to change.

**One follow-up overdue** — the 25 September follow-up on LN260014 — which is
what puts that loan at the top of the worklist.

**One guarantor released.** Lubwama Patrick Ssentongo, on LN260017, by the
Manager: relocated to Mbale and unreachable, the loan 86% repaid and not in
arrears, and a second guarantor remains on it. Recorded with its reason, its
actor and its date, audited as `loan.guarantor_released`, and not reversible.

**Live totals after enrichment:** 17 active loans — 5 current, 5 at 1–7 days,
6 at 8–30, 1 at 31–60, none beyond 60. PAR1 62.59%, PAR7 40.95%, PAR30 2.75%,
PAR60 0.00%, PAR90 0.00%, on 8,738,693 of outstanding principal. 3 collateral
items (1 held, 1 released, 1 realised). 12 recovery actions including 1
correction. 3 promises. 43 guarantees across five statuses: 20 unsigned, 11
discharged, 9 proposed, 2 void, 1 released.

**The books balance.** One payment was posted, deliberately, because a
realisation without its receipt would be an impossible history:

| | Before Phase 5 | After |
| --- | --- | --- |
| Trial balance (both sides) | 70,196,030 | **70,496,030** |
| Cash at Hand | 1,846,418 | 2,146,418 |
| MTN Mobile Money | 10,974,067 | 10,974,067 |
| Airtel Money | 4,115,545 | 4,115,545 |
| Cash at Bank | 0 | 0 |
| Loans Receivable | 8,978,697 | 8,738,693 |
| Interest Income | 4,448,123 | 4,484,123 |
| Penalty Income | 17,441 | 41,437 |

Debits equal credits, difference zero. Journal entries 497 → 498: one entry
for one payment. Principal collection reduced a receivable and was not
recorded as revenue; the interest and the penalty were.
